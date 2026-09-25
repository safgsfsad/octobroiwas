/**
 * apps/octobrowser/src/main/runtime.ts
 *
 * The per-profile browser PROCESS. Started by the profile manager with
 * --profile-process=<id>. Chromium's userData for this process is
 * profiles/<id>/engine, so cookies, cache, localStorage, IndexedDB, service
 * workers, HSTS state etc. are physically separated per profile, and the
 * process can be closed to seal an encrypted profile or wipe a temporary one.
 *
 * The data key arrives from the manager over the private fd-3 pipe; this
 * process never sees the master password.
 */
import { app, dialog, ipcMain, protocol, session, shell, WebContents, net, IpcMainInvokeEvent } from 'electron';
import * as dns from 'node:dns';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ADDONS, AppSettings, Bookmark, DICTS, DataLayout, Lang, Logger, Profile, ProfileData, ProfileManager, SecretStore,
  VersionedStore, checkConsistency, createSettingsStore, detectVpnAdapters, dohTemplate, assessDns, parseTrace, t as translate,
  SUITE_VERSION, searchEngineQueryUrl, wipe, ResolvedFingerprint, resolveFingerprint, setEngineVersion, needsBridge, checkExitIp,
  ProxyCheckResult, GeoInfo,
} from '@octo/core';
import { ProxyBridge } from '@octo/shell/proxy-bridge';
import { FingerprintEmulator, fingerprintHeaders } from './fingerprint-runtime';
import { AdblockService } from '@octo/shell/adblock';
import { JsonLineChannel, Message, openChildChannel } from '@octo/shell/channel';
import { handle } from '@octo/shell/ipc';
import { acceptLanguages, cleanUserAgent } from '@octo/shell/prepare';
import { PermissionKind, ProfileSessionController, DownloadInfo } from '@octo/shell/session-privacy';
import { UpdateStatus } from '@octo/shell/update-manager';
import { BrowserWindowController, Rect } from './window';
import { SHORTCUT_HELP } from '../shared/shortcuts';

type Pending = { resolve: (ok: boolean) => void; timer: NodeJS.Timeout };

export class ProfileRuntime {
  profile: Profile;
  readonly layout: DataLayout;
  readonly logger: Logger;
  readonly settings: VersionedStore<AppSettings>;
  controller!: ProfileSessionController;
  private data!: ProfileData;
  private secrets!: SecretStore;
  private dek: Buffer | null = null;
  private readonly windows = new Map<number, BrowserWindowController>(); // chrome wc id -> window
  private lastFocused: BrowserWindowController | null = null;
  private adblock: AdblockService;
  private updateStatus: UpdateStatus | null = null;
  private downloads = new Map<string, DownloadInfo>();
  private pending = new Map<string, Pending>();
  private seq = 0;
  private publicIp: { ip?: string; at?: number; error?: string } = {};
  private quitting = false;
  /** Fingerprint applied in this run (resolved at start from profile + proxy geo). */
  fp!: ResolvedFingerprint;
  private emulator: FingerprintEmulator | null = null;
  private bridge: ProxyBridge | null = null;

  constructor(
    readonly distDir: string,
    readonly dataDir: string,
    readonly lang: Lang,
    private readonly profileId: string,
    private readonly channel: JsonLineChannel,
  ) {
    this.layout = new DataLayout(dataDir);
    this.logger = new Logger(this.layout.logs, 'octobrowser-profiles');
    this.settings = createSettingsStore(this.layout);
    this.profile = new ProfileManager(this.layout).get(profileId);
    this.adblock = new AdblockService(this.layout.filters, path.join(distDir, 'assets', 'baseline-filters.txt'), this.logger);
  }

  t(key: string, params?: Record<string, string | number>): string {
    return translate(this.lang, key, params);
  }

  // ---------------------------------------------------------------- start

  async start(key: Buffer): Promise<void> {
    this.dek = key;
    const keyHolder = { getKey: () => { if (!this.dek) throw new Error('locked'); return this.dek; } };
    this.data = new ProfileData(this.layout, this.profile.id, keyHolder.getKey);
    this.secrets = new SecretStore(path.join(this.layout.config, 'secrets.bin'), keyHolder);
    const s = this.settings.load();
    if (s.logs.mode === 'diagnostic') this.logger.setMode('diagnostic');

    // DNS for this profile (own process => own resolver config).
    const profDoh = this.profile.dns.mode === 'doh' ? this.profile.dns.dohTemplate : this.profile.dns.mode === 'system' ? null : dohTemplate(s);
    if (profDoh) app.configureHostResolver({ secureDnsMode: 'secure', secureDnsServers: [profDoh] });

    this.adblock.init();
    setEngineVersion(process.versions.chrome);
    const ses = session.defaultSession;
    this.registerInternalProtocol(ses);
    this.controller = new ProfileSessionController(ses, this.profile, this.layout.profileDownloadsDir(this.profile.id), {
      logger: this.logger,
      adblock: this.adblock,
      askPermission: (wc, kind, origin) => this.askPermission(wc, kind, origin),
      confirmDangerousDownload: (wc, name) => this.ask(wc, 'ui:confirm-download', { fileName: name }),
      onDownloadUpdate: (d) => {
        this.downloads.set(d.id, d);
        for (const w of this.windows.values()) w.send('ui:download', d);
      },
      onHttpsFailed: (wc, url) => { void wc.loadURL(`octo://https-only?url=${encodeURIComponent(url)}`); },
      onBlocked: (wc) => { for (const w of this.windows.values()) w.countBlocked(wc); },
      isOffline: () => this.settings.load().offline,
    });
    // Proxy with credentials Chromium cannot use (SOCKS auth) -> local bridge.
    await this.startProxyBridge();
    // Resolve the fingerprint. "Auto" timezone/language/geolocation/WebRTC IP
    // follow the exit IP, so re-check the proxy now if the profile uses them.
    this.fp = resolveFingerprint(this.profile.fingerprint, await this.geoForFingerprint(), this.lang);
    const ua = this.fp.enabled ? this.fp.userAgent : cleanUserAgent(app.userAgentFallback);
    await this.controller.install(ua, this.fp.languages?.length ? this.fp.languages.join(',') : acceptLanguages(this.lang));
    this.controller.setFingerprintHeaders(fingerprintHeaders(this.fp));
    this.emulator = new FingerprintEmulator(this.fp, this.logger);
    this.logger.info('fingerprint.applied', { profile: this.profile.id, enabled: this.fp.enabled, os: this.fp.os, tz: this.fp.timezone ?? 'real', lang: this.fp.languages?.[0] ?? 'real' });

    // Proxy authentication from the encrypted secret store only.
    app.on('login', (e, _wc, _details, authInfo, cb) => {
      if (!authInfo.isProxy) return;
      const raw = this.secrets.get(`proxy:${this.profile.id}`);
      if (!raw) return;
      e.preventDefault();
      try {
        const { username, password } = JSON.parse(raw) as { username: string; password: string };
        cb(username, password);
      } catch {
        cb();
      }
    });

    this.registerIpc();
    this.channel.onMessage((m) => void this.onManagerMessage(m));

    // Restore previous session or open the home page.
    let urls: string[] = [];
    if (this.profile.restoreSession && !this.profile.deleteOnClose) {
      try {
        const saved = this.data.session.load();
        urls = saved?.tabs.map((t) => t.url).slice(0, 50) ?? [];
      } catch (err) {
        this.logger.warn('session.restore-failed', err);
      }
    }
    this.openWindow(urls);
    this.logger.info('profile.started', { profile: this.profile.id, kind: this.profile.kind, level: this.profile.protection.level, sandbox: this.profile.sandbox.mode });
    this.channel.send({ t: 'ready' });

    app.on('before-quit', (e) => {
      if (this.quitting) return;
      e.preventDefault();
      this.quitting = true;
      void this.shutdown().finally(() => app.exit(0));
    });
  }

  /** Close every window without confirmation and exit the profile process. */
  quitProfile(): void {
    setTimeout(() => { this.logger.warn('profile.quit-deadline'); app.exit(0); }, 8000).unref();
    for (const w of [...this.windows.values()]) {
      try { w.confirmClose(false); } catch (err) { this.logger.warn('profile.quit-window', err); }
    }
    setTimeout(() => app.quit(), 300);
  }

  /** Hook for every tab WebContents (fingerprint emulation is attached here). */
  onTabCreated(wc: WebContents): void {
    try { this.emulator?.attach(wc); } catch (err) { this.logger.warn('fingerprint.attach', err); }
  }

  /** Start the local SOCKS5 bridge when the profile proxy needs authentication Chromium lacks. */
  private async startProxyBridge(): Promise<void> {
    const n = this.profile.network;
    const px = n.proxy;
    if (n.mode !== 'proxy' || !px) return;
    let creds = { username: '', password: '' };
    try { const raw = this.secrets.get(`proxy:${this.profile.id}`); if (raw) creds = { ...creds, ...(JSON.parse(raw) as typeof creds) }; } catch { /* none */ }
    const upstream = { type: px.type, host: px.host, port: px.port, ...creds };
    const bridged = needsBridge(upstream);
    if (!bridged && this.bridge) { await this.bridge.stop(); this.bridge = null; await this.controller.setProxyOverride(null); return; }
    if (!bridged) return;
    if (this.bridge) this.bridge.setUpstream(upstream as never);
    else {
      this.bridge = new ProxyBridge(upstream as never);
      await this.bridge.start();
    }
    await this.controller.setProxyOverride(this.bridge.rules);
    this.logger.info('proxy.bridge-started', { profile: this.profile.id, type: px.type });
  }

  /** Exit IP check through THIS profile's (proxied) session. */
  async checkProxy(): Promise<ProxyCheckResult> {
    const ses = session.defaultSession;
    const r = await checkExitIp((url, init) => ses.fetch(url, { cache: 'no-store', credentials: 'omit', signal: init?.signal } as RequestInit) as never);
    this.channel.send({ t: 'proxy-checked', id: this.profile.id, result: r });
    return r;
  }

  /** Geo facts for "auto" fingerprint values: fresh proxy check, else the last stored one. */
  private async geoForFingerprint(): Promise<GeoInfo | undefined> {
    const f = this.profile.fingerprint;
    if (!f.enabled) return undefined;
    const usesAuto = f.timezone.mode === 'auto' || f.language.mode === 'auto' || f.geolocation.mode === 'auto' || f.webrtc.mode === 'altered';
    if (!usesAuto) return undefined;
    if (this.profile.network.mode !== 'proxy') return undefined; // real connection: real values
    const r = await this.checkProxy().catch(() => undefined);
    const g = r?.ok ? r : this.profile.proxyCheck?.ok ? this.profile.proxyCheck : undefined;
    if (!r?.ok) this.logger.warn('fingerprint.proxy-check-failed', { error: r?.error });
    return g;
  }

  private async shutdown(): Promise<void> {
    try {
      await this.controller.onProfileClosed();
      await session.defaultSession.cookies.flushStore();
      session.defaultSession.flushStorageData();
    } catch (err) {
      this.logger.warn('profile.shutdown', err);
    }
    try { await this.bridge?.stop(); } catch { /* ignore */ }
    wipe(this.dek);
    this.dek = null;
    this.logger.info('profile.stopped', { profile: this.profile.id });
  }

  openWindow(urls: string[] = []): BrowserWindowController {
    const w = new BrowserWindowController(this, urls);
    this.windows.set(w.chromeId, w);
    this.lastFocused = w;
    return w;
  }

  onWindowFocus(w: BrowserWindowController): void {
    this.lastFocused = w;
  }

  onWindowClosed(w: BrowserWindowController, tabs: Array<{ url: string; title: string; pinned: boolean; group?: string }>): void {
    this.windows.delete(w.chromeId);
    if (this.lastFocused === w) this.lastFocused = [...this.windows.values()][0] ?? null;
    if (this.windows.size === 0) {
      if (this.profile.restoreSession && !this.profile.deleteOnClose && this.dek) {
        try { this.data.session.save({ savedAt: new Date().toISOString(), tabs, activeIndex: 0 }); } catch (err) { this.logger.warn('session.save-failed', err); }
      }
      app.quit();
    }
  }

  private windowFor(e: IpcMainInvokeEvent): BrowserWindowController {
    const w = this.windows.get(e.sender.id);
    if (!w) throw new Error('unknown window');
    return w;
  }

  private windowOfTab(wc: WebContents | null): BrowserWindowController | null {
    if (!wc) return this.lastFocused;
    for (const w of this.windows.values()) if (w.ownsTabContents(wc.id)) return w;
    return this.lastFocused;
  }

  // --------------------------------------------------------- helpers used by windows

  normalizeInput(input: string): string {
    const s = input.trim();
    if (!s) return this.profile.homePage;
    if (/^(https?|octo):/i.test(s)) return s;
    if (s === 'about:blank') return s;
    if (/^(localhost|(\d{1,3}\.){3}\d{1,3}|\[[0-9a-f:]+\])(:\d+)?(\/.*)?$/i.test(s)) return `http://${s}`;
    if (!/\s/.test(s) && /^[^/?#]+\.[a-z]{2,}(:\d+)?([/?#].*)?$/i.test(s)) return `https://${s}`;
    return searchEngineQueryUrl(this.settings.load().network.searchEngine, s);
  }

  recordHistory(url: string, title: string): void {
    if (!this.profile.keepHistory || this.profile.deleteOnClose || !/^https?:/.test(url) || !this.dek) return;
    try {
      this.data.addHistory({ url, title: title.slice(0, 300), visitedAt: new Date().toISOString() });
    } catch (err) {
      this.logger.warn('history.write-failed', err);
    }
  }

  addBookmark(url: string, title: string): void {
    if (!/^https?:/.test(url)) return;
    this.data.bookmarks.update((list) => {
      if (!list.some((b) => b.url === url)) list.unshift({ id: `${Date.now().toString(36)}${this.seq++}`, title: title || url, url, createdAt: new Date().toISOString() });
    });
  }

  toggleProfileMute(): void {
    this.requestProfileUpdate({ audio: { ...this.profile.audio, muted: !this.profile.audio.muted } });
    this.profile = { ...this.profile, audio: { ...this.profile.audio, muted: !this.profile.audio.muted } };
    for (const w of this.windows.values()) w.applyProfileAudio();
  }

  openLauncher(): void {
    this.channel.send({ t: 'open-launcher' });
  }

  private requestProfileUpdate(patch: Partial<Profile>): void {
    this.channel.send({ t: 'update-profile', id: this.profile.id, patch });
  }

  /** State shared by all windows of this profile (profile badge, status icons). */
  sharedState() {
    const s = this.controller.privacy;
    const set = this.settings.load();
    const issues = checkConsistency(s, { extensionsCount: this.profile.addons.length, proxyActive: this.profile.network.mode === 'proxy' });
    return {
      profile: {
        id: this.profile.id, name: this.profile.name, kind: this.profile.kind, color: this.profile.color,
        level: this.profile.protection.level, encrypted: this.profile.encrypted, sandbox: this.profile.sandbox.mode,
        network: this.profile.network.mode, deleteOnClose: this.profile.deleteOnClose, audio: this.profile.audio, addons: this.profile.addons,
        theme: this.profile.theme,
      },
      protection: issues.some((i) => i.severity === 'warn') ? 'attention' : 'active',
      verticalTabs: set.ui.verticalTabs,
      showBookmarksBar: set.ui.showBookmarksBar,
      confirmOnQuit: set.ui.confirmOnQuit,
      openLinksInBackground: set.ui.openLinksInBackground,
      offline: set.offline,
      update: this.updateStatus,
    };
  }

  private pushAll(): void {
    for (const w of this.windows.values()) w.pushState();
  }

  // ------------------------------------------------------------- prompts

  /** Show a question in the chrome UI of the window owning `wc` and wait for the answer (default: deny after 60 s). */
  private ask(wc: WebContents | null, channel: string, payload: Record<string, unknown>): Promise<boolean> {
    const w = this.windowOfTab(wc);
    if (!w) return Promise.resolve(false);
    const id = `q${++this.seq}`;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve(false); }, 60_000);
      this.pending.set(id, { resolve, timer });
      const tabId = wc ? w.tabByContents(wc.id) : undefined;
      if (tabId !== undefined) w.activate(tabId);
      w.send(channel, { ...payload, reqId: id });
    });
  }

  private askPermission(wc: WebContents | null, kind: PermissionKind, origin: string): Promise<boolean> {
    if (kind === 'geolocation' && this.fp?.geoBlocked) return Promise.resolve(false);
    return this.ask(wc, 'ui:permission', { kind, origin });
  }

  // ------------------------------------------------------------- traffic

  private async lookupPublicIp(force = false): Promise<void> {
    const s = this.settings.load();
    if (!s.network.publicIpLookup || s.offline) { this.publicIp = {}; return; }
    if (!force && this.publicIp.at && Date.now() - this.publicIp.at < 60_000) return;
    try {
      // Goes through THIS profile's session => shows the IP websites see (proxy aware).
      const res = await session.defaultSession.fetch('https://1.1.1.1/cdn-cgi/trace', { credentials: 'omit', cache: 'no-store' } as RequestInit);
      this.publicIp = { ip: parseTrace(await res.text()).ip, at: Date.now() };
    } catch (err) {
      this.publicIp = { error: (err as Error).message, at: Date.now() };
    }
  }

  async trafficSnapshot(w: BrowserWindowController, force: boolean) {
    await this.lookupPublicIp(force);
    const c = this.controller.counters;
    const s = this.controller.privacy;
    const set = this.settings.load();
    const vpn = detectVpnAdapters(os.networkInterfaces());
    const proxy = await this.controller.resolveProxy();
    const proxyActive = proxy !== 'DIRECT' && proxy !== 'UNKNOWN';
    const dohActive = this.profile.dns.mode === 'doh' || (this.profile.dns.mode === 'inherit' && !!dohTemplate(set));
    const servers = dns.getServers();
    const wc = w.activeTabContents();
    let host = '';
    try { host = wc ? new URL(wc.getURL()).hostname : ''; } catch { /* ignore */ }
    const cert = host ? this.controller.certs.get(host) : undefined;
    const domains = [...c.domains.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);
    return {
      at: Date.now(),
      publicIp: this.publicIp.ip ?? null,
      publicIpError: this.publicIp.error ?? null,
      publicIpConsent: set.network.publicIpLookup,
      vpn: vpn.length ? vpn : null,
      proxy: { active: proxyActive, value: proxy, mode: this.profile.network.mode },
      tor: false,
      dns: { servers, doh: dohActive, dohTemplate: this.profile.dns.mode === 'doh' ? this.profile.dns.dohTemplate : dohTemplate(set), leak: assessDns({ dnsServers: servers, vpnDetected: vpn.length > 0, proxyActive, dohActive }) },
      webrtc: { policy: s.webrtc, status: s.webrtc === 'disable_non_proxied_udp' ? 'ok' : s.webrtc === 'default_public_interface_only' ? 'limited' : 'exposed' },
      bytesIn: c.bytesIn,
      bytesOut: c.bytesOut,
      requests: c.requests,
      active: c.active.size,
      domains,
      blocked: { ...c.blocked },
      httpsUpgrades: c.httpsUpgrades,
      paramsStripped: c.paramsStripped,
      thirdPartyCookiesBlocked: c.thirdPartyCookiesBlocked,
      https: wc ? (wc.getURL().startsWith('https:') ? 'https' : wc.getURL().startsWith('http:') ? 'http' : 'internal') : 'internal',
      cert: cert ?? null,
      filtersUpdatedAt: this.adblock.updatedAt ?? null,
      autoRefresh: set.network.autoRefresh,
    };
  }

  // ------------------------------------------------------ internal pages

  private registerInternalProtocol(ses: Electron.Session): void {
    const root = path.join(this.distDir, 'internal');
    ses.protocol.handle('octo', (req) => {
      const u = new URL(req.url);
      const page = u.hostname || 'newtab';
      const map: Record<string, string> = { newtab: 'newtab.html', error: 'error.html', 'https-only': 'https-only.html' };
      let file: string;
      if (map[page] && (u.pathname === '/' || u.pathname === '')) file = map[page];
      else file = path.basename(u.pathname); // assets: newtab.js, internal.css ...
      const full = path.join(root, file);
      if (!full.startsWith(root) || !fs.existsSync(full)) return new Response('Not found', { status: 404 });
      return net.fetch(pathToFileURL(full).toString());
    });
  }

  private isInternalSender(e: IpcMainInvokeEvent): boolean {
    return (e.senderFrame?.url ?? '').startsWith('octo://');
  }

  private registerIpc(): void {
    const L = this.logger;
    // ---- internal octo:// pages (untrusted renderer => strict validation, minimal data) ----
    const internal = (ch: string, fn: (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown) => {
      ipcMain.removeHandler(ch);
      ipcMain.handle(ch, async (e, ...a) => {
        if (!this.isInternalSender(e)) return null;
        try { return await fn(e, ...a); } catch { return null; }
      });
    };
    internal('internal:strings', () => ({ lang: this.lang, dict: DICTS[this.lang] }));
    internal('internal:status', async (e) => {
      const w = this.windowOfTab(e.sender);
      const tr = w ? await this.trafficSnapshot(w, false) : null;
      return {
        profile: this.sharedState().profile,
        protection: this.sharedState().protection,
        traffic: tr && { publicIp: tr.publicIp, consent: tr.publicIpConsent, dns: tr.dns, webrtc: tr.webrtc, bytesIn: tr.bytesIn, bytesOut: tr.bytesOut, blocked: tr.blocked, vpn: tr.vpn, proxy: tr.proxy },
        update: this.updateStatus && { available: this.updateStatus.available, latest: this.updateStatus.latest, configured: this.updateStatus.configured },
        version: SUITE_VERSION,
      };
    });
    internal('internal:navigate', (e, input) => {
      const w = this.windowOfTab(e.sender);
      w?.navigate(String(input));
      return true;
    });
    internal('internal:allow-http', (e, url) => {
      try {
        const u = new URL(String(url));
        if (u.protocol !== 'http:') return false;
        this.controller.allowHttpFor(u.hostname);
        void e.sender.loadURL(u.toString());
        return true;
      } catch { return false; }
    });
    internal('internal:sandbox', () => { this.channel.send({ t: 'launch-sandbox', id: this.profile.id }); return true; });

    // ---- trusted chrome UI ----
    handle('ui:init', L, () => ({ lang: this.lang, dicts: DICTS, version: SUITE_VERSION, shortcuts: SHORTCUT_HELP, addons: ADDONS, theme: this.profile.theme }));
    handle('ui:ready', L, (e) => { this.windowFor(e).pushState(); return true; });
    /** The chrome overlay answered the close request: save & flush, then really close. */
    handle('ui:close-ok', L, (e, force?: boolean) => { this.windowFor(e).confirmClose(force === true); return true; });
    handle('ui:layout', L, (e, rect: Rect, overlay: boolean) => {
      const r = { x: Math.max(0, Math.round(rect.x)), y: Math.max(0, Math.round(rect.y)), width: Math.max(0, Math.round(rect.width)), height: Math.max(0, Math.round(rect.height)) };
      this.windowFor(e).setLayout(r, !!overlay);
      return true;
    });
    handle('ui:navigate', L, (e, input: string) => { this.windowFor(e).navigate(String(input).slice(0, 8192)); return true; });
    handle('ui:new-tab', L, (e, url?: string, background?: boolean) => this.windowFor(e).newTab(typeof url === 'string' && url ? url : this.profile.homePage, { active: background !== true }));
    handle('ui:new-window', L, () => { this.openWindow(); return true; });
    handle('ui:tab', L, (e, id: number, action: string, arg?: unknown) => { this.windowFor(e).tabAction(Number(id), String(action), arg); return true; });
    handle('ui:command', L, (e, cmd: string) => { this.windowFor(e).command(cmd as never); return true; });
    handle('ui:find', L, (e, text: string, opts: { forward?: boolean; findNext?: boolean }) => { this.windowFor(e).find_(String(text ?? ''), opts ?? {}); return true; });
    handle('ui:answer', L, (_e, reqId: string, allow: boolean) => {
      const p = this.pending.get(String(reqId));
      if (p) { clearTimeout(p.timer); this.pending.delete(String(reqId)); p.resolve(allow === true); }
      return true;
    });
    handle('ui:traffic', L, (e, force: boolean) => this.trafficSnapshot(this.windowFor(e), !!force));
    handle('ui:privacy', L, () => ({
      settings: this.controller.privacy,
      issues: checkConsistency(this.controller.privacy, { extensionsCount: this.profile.addons.length, proxyActive: this.profile.network.mode === 'proxy' }),
      profile: this.sharedState().profile,
      sandbox: this.profile.sandbox,
    }));
    handle('ui:set-level', L, async (_e, level: string) => {
      if (this.profile.kind === 'tor' || !['normal', 'standard', 'strict'].includes(level)) throw new Error('invalid level');
      // Apply locally FIRST: the renderer re-opens the panel as soon as this
      // call resolves, so waiting for the manager round-trip would show the
      // previous level's values ("Standard and Strict look the same").
      this.profile = { ...this.profile, protection: { level: level as 'normal' | 'standard' | 'strict' } };
      await this.controller.update(this.profile);
      this.pushAll();
      this.requestProfileUpdate({ protection: { level: level as 'normal' | 'standard' | 'strict' } });
      return true;
    });
    handle('ui:addon', L, (_e, id: string, on: boolean) => {
      if (!ADDONS.some((a) => a.id === id)) throw new Error('unknown add-on');
      const set = new Set(this.profile.addons);
      if (on) set.add(id); else set.delete(id);
      this.requestProfileUpdate({ addons: [...set] });
      return true;
    });
    handle('ui:audio', L, (_e, patch: { muted?: boolean; volume?: number; outputDeviceId?: string }) => {
      const audio = { ...this.profile.audio };
      if (typeof patch.muted === 'boolean') audio.muted = patch.muted;
      if (typeof patch.volume === 'number') audio.volume = Math.max(0, Math.min(100, Math.round(patch.volume)));
      if (typeof patch.outputDeviceId === 'string') audio.outputDeviceId = patch.outputDeviceId.slice(0, 256);
      this.profile = { ...this.profile, audio };
      for (const w of this.windows.values()) w.applyProfileAudio();
      this.requestProfileUpdate({ audio });
      return true;
    });
    handle('ui:downloads', L, () => [...this.downloads.values()].reverse());
    handle('ui:download-action', L, (_e, id: string, action: 'pause' | 'resume' | 'cancel' | 'show' | 'open-folder') => {
      const d = this.downloads.get(id);
      if (action === 'open-folder') { void shell.openPath(this.layout.profileDownloadsDir(this.profile.id)); return true; }
      if (!d) return false;
      if (action === 'show') shell.showItemInFolder(d.savePath);
      else this.controller.controlDownload(id, action);
      return true;
    });
    handle('ui:bookmarks', L, () => this.data.bookmarks.load());
    handle('ui:bookmark-remove', L, (_e, id: string) => { this.data.bookmarks.update((l) => l.filter((b: Bookmark) => b.id !== id)); return true; });
    handle('ui:bookmark-add', L, (_e, url: string, title: string) => { this.addBookmark(String(url), String(title ?? '')); return true; });
    handle('ui:history', L, (_e, q: string) => {
      const needle = String(q ?? '').toLowerCase();
      return this.data.history.load().filter((h) => !needle || h.url.toLowerCase().includes(needle) || h.title.toLowerCase().includes(needle)).slice(0, 200);
    });
    handle('ui:history-clear', L, () => { this.data.history.save([]); return true; });
    handle('ui:clear-data', L, async () => { await this.controller.clearData(); return true; });
    handle('ui:updates-check', L, () => { this.channel.send({ t: 'check-updates' }); return true; });
    handle('ui:open-launcher', L, () => { this.openLauncher(); return true; });
    handle('ui:open-detect', L, () => { this.channel.send({ t: 'launch-detect' }); return true; });
    handle('ui:sandbox-relaunch', L, () => { this.channel.send({ t: 'launch-sandbox', id: this.profile.id }); return true; });
    handle('ui:settings-set', L, (_e, patch: { verticalTabs?: boolean; showBookmarksBar?: boolean; autoRefresh?: boolean; offline?: boolean }) => {
      this.channel.send({ t: 'update-settings', patch });
      return true;
    });
  }

  // ------------------------------------------------------------- manager messages

  private async onManagerMessage(m: Message): Promise<void> {
    switch (m.t) {
      case 'profile-updated': {
        const p = m.profile as Profile;
        if (!p || p.id !== this.profile.id) return;
        const levelChanged = p.protection.level !== this.profile.protection.level;
        const proxyChanged = JSON.stringify(p.network) !== JSON.stringify(this.profile.network);
        this.profile = p;
        await this.controller.update(p);
        if (proxyChanged) await this.startProxyBridge();
        for (const w of this.windows.values()) w.applyProfileAudio();
        this.pushAll();
        if (levelChanged) for (const w of this.windows.values()) w.send('ui:toast', { key: 'toast.levelChangedReload' });
        break;
      }
      case 'settings-updated':
        this.settings.invalidate();
        this.pushAll();
        break;
      case 'update-status':
        this.updateStatus = m.status as UpdateStatus;
        this.pushAll();
        break;
      case 'filters-updated':
        this.adblock.init();
        break;
      case 'focus':
        (this.lastFocused ?? [...this.windows.values()][0])?.focus();
        break;
      case 'open-url':
        if (typeof m.url === 'string') (this.lastFocused ?? this.openWindow()).newTab(m.url);
        break;
      case 'quit':
        // Closed from the launcher (STOP / close button / API): skip the
        // "confirm close" overlay, save the session, flush and exit. A hard
        // deadline guarantees the process really ends even if a page hangs.
        this.quitProfile();
        break;
      default:
        break;
    }
  }
}

/** Entry point for --profile-process=<id>. */
export function runProfileProcess(distDir: string, dataDir: string, lang: Lang, profileId: string): void {
  protocol.registerSchemesAsPrivileged([{ scheme: 'octo', privileges: { standard: true, secure: true } }]);
  let channel: JsonLineChannel;
  try {
    channel = openChildChannel(); // private pipe from the manager (fd 3)
  } catch {
    app.exit(3); // not started by the manager
    return;
  }
  // Exactly one process per profile (Chromium also locks the userData folder).
  if (!app.requestSingleInstanceLock()) {
    app.exit(0);
    return;
  }
  let started = false;
  const timeout = setTimeout(() => { if (!started) app.exit(2); }, 20_000); // no key from the manager => exit
  channel.onMessage((m) => {
    if (m.t !== 'init' || started || typeof m.key !== 'string') return;
    started = true;
    clearTimeout(timeout);
    const key = Buffer.from(m.key, 'base64');
    void app.whenReady().then(async () => {
      const rt = new ProfileRuntime(distDir, dataDir, lang, profileId, channel);
      try {
        await rt.start(key);
      } catch (err) {
        rt.logger.error('profile.start-failed', err);
        dialog.showErrorBox('OctoBrowser.su', translate(lang, 'err.profileStart', { message: (err as Error).message }));
        app.exit(1);
      }
    });
  });
  app.on('window-all-closed', () => app.quit());
  // Never show Electron's modal "Uncaught exception" box in a profile: it blocks
  // the window from closing. Log it and keep the browser running instead.
  process.on('uncaughtException', (err) => {
    try { new Logger(new DataLayout(dataDir).logs, 'octobrowser-profiles').error('profile.uncaught', err); } catch { /* ignore */ }
  });
  process.on('unhandledRejection', (err) => {
    try { new Logger(new DataLayout(dataDir).logs, 'octobrowser-profiles').warn('profile.unhandled-rejection', err); } catch { /* ignore */ }
  });
}
