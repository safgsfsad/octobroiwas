/**
 * apps/octobrowser/src/main/manager.ts
 *
 * Profile MANAGER (launcher) process of OctoBrowser.su:
 *   - shows the launcher window (profiles, security status, settings, updates, logs, backups);
 *   - is the only writer of profiles.json / settings.json (children request changes);
 *   - starts one browser process per profile and hands it the data key over a private pipe;
 *   - opens / seals encrypted profile vaults, wipes temporary profiles after their process exits;
 *   - launches the Tor profile in the official Tor Browser and sandboxed profiles in Windows Sandbox;
 *   - auto-locks after inactivity or when Windows locks;
 *   - checks for updates (daily first launch / every 3rd launch / manual) and updates filter lists.
 */
import { app, BrowserWindow, dialog, powerMonitor, shell, session } from 'electron';
import { spawn, ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ADDONS, APPS, BootstrapStore, DICTS, DecryptionError, Profile, ProfileKind, ProfileManager, SUITE_VERSION, buildWsbConfig,
  describeIsolation, detectVpnAdapters, generateMnemonic, isValidMnemonic, wipe, fileStamp, SANDBOX_DATA_DIR, isLang, Lang,
  checkConsistency, effectiveSettings, PROFILE_KINDS, privateBrowsingPatch, privateBrowsingStamp, validateBaseDir,
  ProxyStore, ParsedProxy, ProxyType, PROXY_TYPES, ProxyCheckResult, parseProxy, parseProxyList, checkExitIp, needsBridge,
  generateFingerprint, setEngineVersion, engineVersion, FP_OSES, FingerprintOs, FingerprintConfig, fingerprintWarnings, gpuPresets, userAgentFor,
} from '@octo/core';
import { ProxyBridge } from '@octo/shell/proxy-bridge';
import { randomBytes } from 'node:crypto';
import * as net from 'node:net';
import { ApiBackend, ApiError, ApiServer } from './api-server';
import { AdblockService } from '@octo/shell/adblock';
import { CHANNEL_FD, JsonLineChannel, channelStdio } from '@octo/shell/channel';
import type { Duplex } from 'node:stream';
import { AppContext } from '@octo/shell/context';
import { handle, trustWebContents } from '@octo/shell/ipc';
import { UpdateManager } from '@octo/shell/update-manager';
import { runMasterPasswordUnlock } from '@octo/shell/unlock';
import { iconPath, THEME } from '@octo/shell/windows-ui';
import { findTorBrowser, launchDetached, launchWindowsSandbox, windowsSandboxAvailable } from '@octo/shell/winutil';
import { bootstrapFileFor } from '@octo/shell/prepare';

interface Child {
  proc: ChildProcess;
  channel: JsonLineChannel;
  ready: boolean;
  startedAt: number;
  stopping?: boolean;
  killTimer?: NodeJS.Timeout;
}

/** Proxy chosen in the profile editor / sent to the API. */
export type ProxyInput =
  | { mode: 'none' }
  | { mode: 'new'; text: string; type?: ProxyType; changeIpUrl?: string; name?: string; save?: boolean }
  | { mode: 'saved'; savedId: string }
  | { mode: 'keep' };

/** Payload of `mgr:create`: name + kind, optionally a settings patch from the create dialog. */
interface CreateInput {
  name: string;
  kind: ProfileKind;
  patch?: Partial<Omit<Profile, 'id' | 'createdAt' | 'updatedAt' | 'kind'>>;
  proxy?: ProxyInput;
}

export class Manager {
  readonly profiles: ProfileManager;
  readonly proxies: ProxyStore;
  private readonly updates: UpdateManager;
  private readonly adblock: AdblockService;
  private launcher: BrowserWindow | null = null;
  private readonly children = new Map<string, Child>();
  /** Vault keys of OPEN encrypted profiles (wiped when sealed). */
  private readonly vaultKeys = new Map<string, Buffer>();
  private idleTimer: NodeJS.Timeout | null = null;
  private api: ApiServer | null = null;
  private apiError = '';
  /** Remote-debugging ports of profiles started for automation. */
  private readonly debugPorts = new Map<string, number>();
  private locking = false;

  constructor(private readonly ctx: AppContext) {
    this.profiles = new ProfileManager(ctx.layout, ctx.secrets);
    this.proxies = new ProxyStore(ctx.layout, ctx.secrets);
    setEngineVersion(process.versions.chrome);
    this.updates = new UpdateManager(APPS.octobrowser, ctx.layout, ctx.settings, ctx.logger, ctx.lang);
    this.adblock = new AdblockService(ctx.layout.filters, path.join(ctx.prep.distDir, 'assets', 'baseline-filters.txt'), ctx.logger);
  }

  private get t() {
    return this.ctx.t;
  }

  start(): void {
    const names = Object.fromEntries(PROFILE_KINDS.map((k) => [k, this.t(`profile.kind.${k}`)])) as Record<ProfileKind, string>;
    // First run: one ready-to-use antidetect profile (works like a normal browser).
    this.profiles.ensureDefaults({ ...names, antidetect: `${this.t('profile.defaultName')} 1` }, ['antidetect']);
    // Profiles restored by restore-profile.bat whose entry had been deleted.
    const restored = this.profiles.adoptRestoredEntries();
    for (const p of restored.adopted) this.ctx.logger.info('profile.restored-entry-adopted', { profile: p.id });
    for (const id of restored.rejected) this.ctx.logger.warn('profile.restored-entry-rejected', { profile: id });
    // Temporary / delete-on-close profiles are wiped at start too (covers crashes).
    this.profiles.cleanupEphemeral();
    for (const p of this.profiles.list()) {
      if (this.profiles.needsResealing(p.id)) this.ctx.logger.warn('vault.unsealed-after-crash', { profile: p.id });
    }
    this.registerIpc();
    this.updates.onStatus((s) => {
      this.broadcast({ t: 'update-status', status: s });
      this.launcher?.webContents.send('mgr:update-status', s);
    });
    this.updates.onAppLaunch();
    void this.maybeUpdateFilters();
    this.startAutoLock();
    void this.applyApiSettings();

    const direct = this.profileFromArgv(process.argv);
    if (direct) void this.launch(direct, {});
    this.showLauncher();
    app.on('second-instance', (_e, argv) => {
      const id = this.profileFromArgv(argv);
      if (id) void this.launch(id, {});
      else this.showLauncher();
    });
  }

  /** Supports `octobrowser://open?profile=<id|name>` and `--open-profile=<id>`. */
  private profileFromArgv(argv: string[]): string | null {
    for (const a of argv) {
      let v: string | null = null;
      if (a.startsWith('--open-profile=')) v = a.slice('--open-profile='.length);
      else if (a.toLowerCase().startsWith('octobrowser://')) {
        try { v = new URL(a).searchParams.get('profile'); } catch { v = null; }
      }
      if (v) {
        const p = this.profiles.list().find((x) => x.id === v || x.name.toLowerCase() === v!.toLowerCase());
        if (p) return p.id;
      }
    }
    return null;
  }

  // ------------------------------------------------------------ launcher

  showLauncher(tab?: string): void {
    if (this.launcher && !this.launcher.isDestroyed()) {
      if (this.launcher.isMinimized()) this.launcher.restore();
      this.launcher.show();
      this.launcher.focus();
      if (tab) this.launcher.webContents.send('mgr:show-tab', tab);
      return;
    }
    const distDir = this.ctx.prep.distDir;
    this.launcher = new BrowserWindow({
      width: 1180,
      height: 760,
      minWidth: 900,
      minHeight: 600,
      show: false,
      backgroundColor: THEME.octobrowser.bg,
      title: 'OctoBrowser.su',
      icon: iconPath(distDir),
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(distDir, 'preload-launcher.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        spellcheck: false,
      },
    });
    trustWebContents(this.launcher.webContents);
    this.launcher.once('ready-to-show', () => this.launcher?.show());
    void this.launcher.loadFile(path.join(distDir, 'renderer', 'launcher.html'), { query: tab ? { tab } : {} });
    this.launcher.on('closed', () => {
      this.launcher = null;
      if (this.children.size === 0) app.quit();
    });
  }

  private pushProfiles(): void {
    this.launcher?.webContents.send('mgr:profiles', this.profileList());
  }

  private profileList() {
    return this.profiles.list().map((p) => ({
      ...p,
      running: this.children.has(p.id),
      ready: this.children.get(p.id)?.ready ?? false,
      stopping: this.children.get(p.id)?.stopping ?? false,
      startedAt: this.children.get(p.id)?.startedAt ?? 0,
      sealed: this.profiles.isVaultLocked(p.id),
      hasVault: this.profiles.hasVault(p.id),
      needsResealing: this.profiles.needsResealing(p.id),
      issues: checkConsistency(effectiveSettings(p.protection), { extensionsCount: p.addons.length, proxyActive: p.network.mode === 'proxy' }),
      hasProxyCredentials: this.ctx.secrets.has(`proxy:${p.id}`),
      fingerprintWarnings: fingerprintWarnings(p.fingerprint, engineVersion().major),
    }));
  }

  // -------------------------------------------------------------- launch

  isolation(id: string) {
    const p = this.profiles.get(id);
    return describeIsolation(p, {
      downloadsDir: this.ctx.layout.profileDownloadsDir(id),
      windowsSandboxAvailable: windowsSandboxAvailable(),
      vpnDetected: detectVpnAdapters(os.networkInterfaces()).length > 0,
    });
  }

  /**
   * Start a profile. Returns a status the launcher UI reacts to
   * (passphrase needed, Tor Browser missing, Windows Sandbox unavailable...).
   */
  async launch(id: string, opts: { passphrase?: string; forceRestricted?: boolean; debugPort?: number }): Promise<{ status: string; detail?: string }> {
    const p = this.profiles.get(id);
    const running = this.children.get(id);
    if (running) {
      running.channel.send({ t: 'focus' });
      return { status: 'focused' };
    }

    // Tor: only the official Tor Browser (no Tor inside Chromium, no extra add-ons).
    if (p.kind === 'tor' || p.protection.level === 'tor') {
      const tor = findTorBrowser(this.ctx.settings.load().tor.torBrowserPath);
      if (!tor) return { status: 'tor-missing' };
      launchDetached(tor, []);
      this.ctx.logger.info('profile.tor-browser-launched');
      return { status: 'tor-launched' };
    }

    if (p.sandbox.mode === 'windows-sandbox' && !opts.forceRestricted) {
      if (!windowsSandboxAvailable()) return { status: 'wsb-unavailable' };
      this.launchInWindowsSandbox(p);
      return { status: 'wsb-launched' };
    }

    // Encrypted profile: derive + verify key, then decrypt the vault.
    if (p.encrypted && this.profiles.hasVault(id) && !this.vaultKeys.has(id)) {
      if (!opts.passphrase) return { status: 'need-passphrase' };
      try {
        const key = await this.profiles.deriveVaultKey(id, opts.passphrase);
        this.profiles.openVault(id, key);
        this.vaultKeys.set(id, key);
      } catch (err) {
        if (err instanceof DecryptionError) return { status: 'wrong-passphrase' };
        throw err;
      }
    }

    this.spawnProfile(p, opts.debugPort);
    this.profiles.setLastUsed(id);
    this.pushProfiles();
    return { status: 'started' };
  }

  private spawnProfile(p: Profile, debugPort?: number): void {
    const args = app.isPackaged ? [] : [app.getAppPath()];
    args.push(`--profile-process=${p.id}`);
    if (debugPort) {
      // Automation (API): Chrome DevTools Protocol on loopback for Puppeteer / Playwright.
      args.push(`--remote-debugging-port=${debugPort}`, '--remote-debugging-address=127.0.0.1');
      this.debugPorts.set(p.id, debugPort);
    } else this.debugPorts.delete(p.id);
    // Ephemeral session (Windows Sandbox / tests): there is no bootstrap.json, so the
    // child must get the same throw-away data folder and language as the manager.
    const st = this.ctx.prep.state;
    if (this.ctx.prep.ephemeral && st) args.push(`--ephemeral-data-dir=${st.baseDir}`, `--lang-choice=${st.language}`);
    // fd 3 = private duplex channel pipe (see channel.ts). stdout/stderr are discarded
    // in release builds; in development/tests (unpackaged) they go to the manager's
    // console so start-up errors of the profile process are visible.
    const proc = spawn(process.execPath, args, { stdio: channelStdio(!app.isPackaged), windowsHide: false, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } });
    const pipe = proc.stdio[CHANNEL_FD] as Duplex | null;
    if (!pipe) throw new Error('profile channel pipe missing');
    const channel = new JsonLineChannel(pipe, pipe);
    const child: Child = { proc, channel, ready: false, startedAt: Date.now() };
    try {
      const st = p.stats ?? { launches: 0, lastLaunchAt: '', worktimeSec: 0 };
      this.profiles.update(p.id, { stats: { ...st, launches: st.launches + 1, lastLaunchAt: new Date().toISOString() } });
    } catch (err) { this.ctx.logger.warn('profile.stats', err); }
    this.children.set(p.id, child);
    // The data key travels ONLY over the private pipe - never argv/env.
    channel.send({ t: 'init', key: this.ctx.keyring.getKey().toString('base64') });
    channel.onMessage((m) => void this.onChildMessage(p.id, m));
    proc.on('exit', (code) => void this.onChildExit(p.id, code));
    this.ctx.logger.info('profile.spawned', { profile: p.id });
  }

  // ------------------------------------------------------ services (IPC + REST API)

  /** Create a profile (name, kind, settings patch, optional proxy). */
  createProfile(input: CreateInput): Profile {
    if (!PROFILE_KINDS.includes(input.kind)) throw new Error('invalid kind');
    const p = this.profiles.create({
      name: String(input.name ?? '').trim().slice(0, 64) || `${this.t('profile.defaultName')} ${this.profiles.list().length + 1}`,
      kind: input.kind,
      patch: input.patch,
    });
    if (input.proxy && input.proxy.mode !== 'keep' && input.proxy.mode !== 'none') this.setProfileProxy(p.id, input.proxy);
    this.pushProfiles();
    return this.profiles.get(p.id);
  }

  /** Update profile settings (+ optional proxy change). Running profiles get the change live. */
  updateProfile(id: string, patch: Partial<Profile>, proxy?: ProxyInput): Profile {
    const clean = { ...patch } as Partial<Profile> & Record<string, unknown>;
    for (const k of ['id', 'kind', 'createdAt', 'updatedAt', 'stats']) delete clean[k];
    let updated = this.profiles.update(id, clean);
    if (proxy && proxy.mode !== 'keep') updated = this.setProfileProxy(id, proxy);
    this.children.get(id)?.channel.send({ t: 'profile-updated', profile: updated });
    this.pushProfiles();
    return updated;
  }

  removeProfile(id: string): void {
    if (this.children.has(id)) throw new Error(this.t('err.closeProfileFirst'));
    this.profiles.remove(id);
    this.ctx.secrets.delete(`proxy:${id}`);
    this.pushProfiles();
  }

  /** Resolve a proxy input to a parsed proxy (+ saved id). Throws with an i18n message. */
  private resolveProxy(input: ProxyInput): { px: ParsedProxy; name: string; savedId: string } {
    if (input.mode === 'saved') {
      const sp = this.proxies.get(String(input.savedId));
      return { px: this.proxies.resolve(sp.id), name: sp.name, savedId: sp.id };
    }
    if (input.mode !== 'new') throw new Error('invalid proxy mode');
    const type = PROXY_TYPES.includes(input.type as ProxyType) ? (input.type as ProxyType) : 'http';
    const r = parseProxy(String(input.text ?? ''), type);
    if (!r.ok || !r.proxy) throw new Error(this.t(r.error ?? 'proxy.err.format'));
    const px = { ...r.proxy, changeIpUrl: String(input.changeIpUrl ?? '').trim() || r.proxy.changeIpUrl };
    if (px.changeIpUrl && !/^https?:\/\//i.test(px.changeIpUrl)) throw new Error(this.t('proxy.err.changeIpUrl'));
    let savedId = '';
    const name = String(input.name ?? '').trim().slice(0, 64);
    if (input.save) savedId = this.proxies.add(px, name).id;
    return { px, name, savedId };
  }

  /** Point a profile at a proxy (credentials go to the secret store only). */
  setProfileProxy(id: string, input: ProxyInput): Profile {
    const cur = this.profiles.get(id);
    if (input.mode === 'keep') return cur;
    if (input.mode === 'none') {
      this.ctx.secrets.delete(`proxy:${id}`);
      return this.profiles.update(id, { network: { ...cur.network, mode: 'system', proxy: undefined, proxyRules: '', hasProxyCredentials: false }, proxyCheck: undefined });
    }
    const { px, name, savedId } = this.resolveProxy(input);
    if (px.username || px.password) this.ctx.secrets.set(`proxy:${id}`, JSON.stringify({ username: px.username, password: px.password }));
    else this.ctx.secrets.delete(`proxy:${id}`);
    const lastCheck = savedId ? this.proxies.get(savedId).lastCheck : undefined;
    return this.profiles.update(id, {
      network: {
        ...cur.network,
        mode: 'proxy',
        proxy: { type: px.type, host: px.host, port: px.port, changeIpUrl: px.changeIpUrl, name, savedId },
        hasProxyCredentials: !!(px.username || px.password),
      },
      proxyCheck: lastCheck,
    });
  }

  /**
   * Check a proxy from the manager: a throw-away in-memory session routed through
   * a local bridge (handles SOCKS5/SOCKS4/HTTP with credentials uniformly).
   */
  async checkProxy(px: ParsedProxy): Promise<ProxyCheckResult> {
    if (px.type === 'https' && (px.username || px.password)) return { ok: false, at: new Date().toISOString(), error: this.t('proxy.err.httpsAuth') };
    const ses = session.fromPartition(`octo-proxycheck-${Date.now()}-${randomBytes(4).toString('hex')}`);
    const bridge = px.type === 'https' ? null : new ProxyBridge({ type: px.type, host: px.host, port: px.port, username: px.username, password: px.password });
    try {
      const rules = bridge ? (await bridge.start(), bridge.rules) : `https://${px.host}:${px.port}`;
      await ses.setProxy({ mode: 'fixed_servers', proxyRules: rules });
      const r = await checkExitIp((url, init) => ses.fetch(url, { cache: 'no-store', credentials: 'omit', signal: init?.signal } as RequestInit) as never);
      if (!r.ok && bridge?.stats.lastError) r.error = bridge.stats.lastError;
      this.ctx.logger.info('proxy.checked', { ok: r.ok, country: r.countryCode ?? '' });
      return r;
    } finally {
      await bridge?.stop().catch(() => undefined);
      void ses.clearStorageData().catch(() => undefined);
    }
  }

  /** Check the proxy of a profile and store the result (used for "auto" timezone etc.). */
  async checkProfileProxy(id: string): Promise<ProxyCheckResult> {
    const p = this.profiles.get(id);
    const px = p.network.mode === 'proxy' ? p.network.proxy : undefined;
    if (!px) throw new Error(this.t('proxy.err.noProxy'));
    let creds = { username: '', password: '' };
    try { const raw = this.ctx.secrets.get(`proxy:${id}`); if (raw) creds = { ...creds, ...(JSON.parse(raw) as typeof creds) }; } catch { /* none */ }
    const r = await this.checkProxy({ type: px.type, host: px.host, port: px.port, changeIpUrl: px.changeIpUrl, ...creds });
    this.profiles.update(id, { proxyCheck: r });
    if (px.savedId) { try { this.proxies.update(px.savedId, { lastCheck: r }); } catch { /* removed */ } }
    this.pushProfiles();
    return r;
  }

  async checkSavedProxy(id: string): Promise<ProxyCheckResult> {
    const r = await this.checkProxy(this.proxies.resolve(id));
    this.proxies.update(id, { lastCheck: r });
    this.pushProxies();
    return r;
  }

  /** Check a proxy typed in the editor (not stored yet). */
  async checkProxyInput(input: ProxyInput): Promise<ProxyCheckResult> {
    if (input.mode === 'saved') return this.checkSavedProxy(input.savedId);
    if (input.mode !== 'new') throw new Error('invalid proxy mode');
    const { px } = this.resolveProxy({ ...input, save: false });
    return this.checkProxy(px);
  }

  /** Call the "change IP" URL of a rotating proxy. */
  async changeProxyIp(url: string): Promise<{ ok: boolean; status: number }> {
    if (!/^https?:\/\//i.test(url)) throw new Error(this.t('proxy.err.changeIpUrl'));
    const res = await session.defaultSession.fetch(url, { cache: 'no-store', credentials: 'omit' } as RequestInit);
    return { ok: res.ok, status: res.status };
  }

  /** Add saved proxies from pasted text (one per line, any supported format). */
  addProxies(text: string, type: ProxyType = 'http', name = ''): { added: number; errors: Array<{ line: number; error: string }> } {
    const list = parseProxyList(String(text ?? ''), PROXY_TYPES.includes(type) ? type : 'http');
    let added = 0;
    const errors: Array<{ line: number; error: string }> = [];
    list.forEach((r, i) => {
      if (r.ok && r.proxy) { this.proxies.add(r.proxy, list.length === 1 ? name : name ? `${name} ${i + 1}` : ''); added++; }
      else errors.push({ line: r.line ?? i + 1, error: this.t(r.error ?? 'proxy.err.format') });
    });
    this.pushProxies();
    return { added, errors };
  }

  pushProxies(): void {
    this.launcher?.webContents.send('mgr:proxies', this.proxies.list());
  }

  /** New realistic fingerprint (optionally for a given OS). */
  newFingerprint(os?: FingerprintOs): FingerprintConfig {
    const { major, full } = engineVersion();
    return generateFingerprint({ engineMajor: major, engineFullVersion: full, os: os && FP_OSES.includes(os) ? os : undefined });
  }

  /** Profile as returned by the API / launcher list (+ runtime state, no secrets). */
  profileInfo(id: string) {
    const item = this.profileList().find((p) => p.id === id);
    if (!item) throw new Error(`Profile not found: ${id}`);
    return item;
  }

  // ------------------------------------------------------------ REST API

  private apiToken(): string {
    let tok = this.ctx.secrets.get('api:token');
    if (!tok) {
      tok = randomBytes(24).toString('base64url');
      this.ctx.secrets.set('api:token', tok);
    }
    return tok;
  }

  regenerateApiToken(): string {
    this.ctx.secrets.set('api:token', randomBytes(24).toString('base64url'));
    return this.apiToken();
  }

  apiStatus() {
    const s = this.ctx.settings.load().api;
    return { enabled: s.enabled, port: s.port, listening: !!this.api?.listening, token: this.apiToken(), error: this.apiError, baseUrl: `http://127.0.0.1:${s.port}/v1` };
  }

  /** Start / stop / move the API server to match the settings. */
  async applyApiSettings(): Promise<void> {
    const s = this.ctx.settings.load().api;
    if (this.api && (!s.enabled || this.api.port !== s.port)) { await this.api.stop(); this.api = null; }
    this.apiError = '';
    if (s.enabled && !this.api) {
      const srv = new ApiServer(this.apiBackend(), () => this.apiToken(), this.ctx.logger);
      try { await srv.start(s.port); this.api = srv; } catch (err) {
        this.apiError = (err as Error).message;
        this.ctx.logger.warn('api.start-failed', { port: s.port, err: this.apiError });
      }
    }
  }

  private freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => { const port = (srv.address() as net.AddressInfo).port; srv.close(() => resolve(port)); });
    });
  }

  private async wsEndpoint(port: number): Promise<string | undefined> {
    for (let i = 0; i < 40; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (res.ok) return ((await res.json()) as { webSocketDebuggerUrl?: string }).webSocketDebuggerUrl;
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    return undefined;
  }

  /** Adapter used by the REST API (same services as the launcher UI). */
  private apiBackend(): ApiBackend {
    const need = (id: string) => { if (!this.profiles.list().some((p) => p.id === id)) throw new ApiError(404, `profile not found: ${id}`); };
    const pick = (body: Record<string, unknown>) => {
      const { proxy, name, kind, os, ...rest } = body;
      void name; void kind;
      if (typeof os === 'string' && !rest.fingerprint) rest.fingerprint = this.newFingerprint(os as FingerprintOs);
      return { patch: rest as Partial<Profile>, proxy: proxy as ProxyInput | undefined };
    };
    return {
      version: SUITE_VERSION,
      listProfiles: () => this.profileList(),
      getProfile: (id) => { need(id); return this.profileInfo(id); },
      createProfile: (body) => {
        const { patch, proxy } = pick(body);
        const kind = (typeof body.kind === 'string' ? body.kind : 'antidetect') as ProfileKind;
        if (!PROFILE_KINDS.includes(kind)) throw new ApiError(400, `invalid kind (${PROFILE_KINDS.join(', ')})`);
        const p = this.createProfile({ name: String(body.name ?? ''), kind, patch, proxy });
        return this.profileInfo(p.id);
      },
      updateProfile: (id, body) => { need(id); const { patch, proxy } = pick(body); if (typeof body.name === 'string') patch.name = body.name; this.updateProfile(id, patch, proxy); return this.profileInfo(id); },
      removeProfile: (id) => { need(id); this.removeProfile(id); },
      startProfile: async (id, opts) => {
        need(id);
        if (this.children.has(id)) {
          const port = this.debugPorts.get(id);
          return { status: 'running', debugPort: port, wsEndpoint: port ? await this.wsEndpoint(port) : undefined };
        }
        const port = opts.debug ? await this.freePort() : undefined;
        const r = await this.launch(id, { debugPort: port });
        if (r.status !== 'started') return r;
        return { ...r, debugPort: port, wsEndpoint: port ? await this.wsEndpoint(port) : undefined };
      },
      stopProfile: (id, force) => { need(id); return this.stop(id, force); },
      regenerateFingerprint: (id, os) => {
        need(id);
        const cur = this.profiles.get(id).fingerprint;
        const fresh = this.newFingerprint((os as FingerprintOs) || cur.os);
        this.updateProfile(id, { fingerprint: { ...fresh, timezone: cur.timezone, language: cur.language, geolocation: cur.geolocation, webrtc: cur.webrtc } });
        return this.profileInfo(id);
      },
      setProxy: (id, body) => { need(id); const p = this.setProfileProxy(id, body as unknown as ProxyInput); this.children.get(id)?.channel.send({ t: 'profile-updated', profile: p }); this.pushProfiles(); return this.profileInfo(id); },
      checkProfileProxy: async (id) => { need(id); return { ...(await this.checkProfileProxy(id)) }; },
      bulk: async (action, ids, arg) => {
        const out: Record<string, unknown> = {};
        for (const id of ids) {
          try {
            need(id);
            if (action === 'start') out[id] = await this.launch(id, {});
            else if (action === 'stop') out[id] = this.stop(id);
            else if (action === 'remove') { this.removeProfile(id); out[id] = true; }
            else if (action === 'folder') { this.updateProfile(id, { folder: String(arg ?? '') }); out[id] = true; }
            else if (action === 'status') { this.updateProfile(id, { status: String(arg ?? '') } as Partial<Profile>); out[id] = true; }
            else if (action === 'tags') { this.updateProfile(id, { tags: Array.isArray(arg) ? arg.map(String) : [] }); out[id] = true; }
            else throw new ApiError(400, 'unknown action');
          } catch (err) { out[id] = { error: (err as Error).message }; }
        }
        return out;
      },
      listProxies: () => this.proxies.list(),
      addProxies: (text, type, name) => this.addProxies(text, type as ProxyType, name),
      updateProxy: (id, body) => { const r = this.proxies.update(id, { name: typeof body.name === 'string' ? body.name : undefined, changeIpUrl: typeof body.changeIpUrl === 'string' ? body.changeIpUrl : undefined }); this.pushProxies(); return { ...r }; },
      removeProxy: (id) => { this.proxies.get(id); this.proxies.remove(id); this.pushProxies(); },
      checkSavedProxy: async (id) => ({ ...(await this.checkSavedProxy(id)) }),
      parseProxy: (text, type) => {
        const r = parseProxy(text, PROXY_TYPES.includes(type as ProxyType) ? (type as ProxyType) : 'http');
        return r.ok && r.proxy ? { ok: true, format: r.format, proxy: { ...r.proxy, password: r.proxy.password ? '***' : '' } } : { ok: false, error: this.t(r.error ?? 'proxy.err.format') };
      },
      checkProxy: async (text, type) => ({ ...(await this.checkProxyInput({ mode: 'new', text, type: type as ProxyType })) }),
      newFingerprint: (os) => ({ ...this.newFingerprint(os as FingerprintOs) }),
      fingerprintMeta: (os) => {
        const o = (FP_OSES.includes(os as FingerprintOs) ? os : 'windows11') as FingerprintOs;
        return { os: o, gpus: gpuPresets(o), userAgent: userAgentFor(o, engineVersion().major), engine: engineVersion() };
      },
    };
  }

  /**
   * Stop a running profile: ask it to quit (session is saved, no confirmation
   * overlay); if it has not exited after 10 s - or `force` is set - kill it.
   */
  stop(id: string, force = false): boolean {
    const c = this.children.get(id);
    if (!c) return false;
    if (force) {
      this.ctx.logger.warn('profile.killed', { profile: id });
      c.proc.kill();
      return true;
    }
    if (!c.stopping) {
      c.stopping = true;
      c.channel.send({ t: 'quit', reason: 'user' });
      c.killTimer = setTimeout(() => {
        if (this.children.get(id) === c && c.proc.exitCode === null) {
          this.ctx.logger.warn('profile.stop-timeout-killed', { profile: id });
          c.proc.kill();
        }
      }, 10_000);
      this.pushProfiles();
    }
    return true;
  }

  isRunning(id: string): boolean {
    return this.children.has(id);
  }

  private async onChildExit(id: string, code: number | null): Promise<void> {
    const ended = this.children.get(id);
    if (ended?.killTimer) clearTimeout(ended.killTimer);
    this.debugPorts.delete(id);
    this.children.delete(id);
    if (ended) {
      try {
        const cur = this.profiles.get(id);
        const st = cur.stats ?? { launches: 0, lastLaunchAt: '', worktimeSec: 0 };
        this.profiles.update(id, { stats: { ...st, worktimeSec: st.worktimeSec + Math.max(0, Math.round((Date.now() - ended.startedAt) / 1000)) } });
      } catch { /* profile deleted meanwhile */ }
    }
    this.ctx.logger.info('profile.exited', { profile: id, code });
    let p: Profile | undefined;
    try { p = this.profiles.get(id); } catch { /* deleted meanwhile */ }
    if (p) {
      if (p.deleteOnClose || p.kind === 'temporary') this.profiles.cleanupEphemeral(id);
      const key = this.vaultKeys.get(id);
      if (p.encrypted && key) {
        // Chromium may keep file handles for a moment after exit (Windows): retry sealing.
        for (let i = 0; i < 10; i++) {
          try {
            this.profiles.sealVault(id, key);
            this.ctx.logger.info('vault.sealed', { profile: id });
            break;
          } catch (err) {
            if (i === 9) this.ctx.logger.error('vault.seal-failed', err);
            await new Promise((r) => setTimeout(r, 500));
          }
        }
        wipe(key);
        this.vaultKeys.delete(id);
      }
    }
    this.pushProfiles();
    if (this.children.size === 0 && !this.launcher && !this.locking) app.quit();
  }

  private async onChildMessage(id: string, m: { t: string; [k: string]: unknown }): Promise<void> {
    const child = this.children.get(id);
    switch (m.t) {
      case 'ready':
        if (child) child.ready = true;
        child?.channel.send({ t: 'update-status', status: this.updates.getStatus() });
        break;
      case 'open-launcher':
        this.showLauncher();
        break;
      case 'update-profile': {
        if (m.id !== id) return; // a profile may only edit itself
        const patch = m.patch as Partial<Profile>;
        const allowed: Partial<Profile> = {};
        if (patch.audio) allowed.audio = patch.audio;
        if (patch.addons) allowed.addons = patch.addons;
        if (patch.protection && patch.protection.level !== 'tor') allowed.protection = patch.protection;
        const updated = this.profiles.update(id, allowed);
        child?.channel.send({ t: 'profile-updated', profile: updated });
        this.pushProfiles();
        break;
      }
      case 'update-settings': {
        const patch = (m.patch ?? {}) as { verticalTabs?: boolean; autoRefresh?: boolean; offline?: boolean };
        this.ctx.settings.update((s) => {
          if (typeof patch.verticalTabs === 'boolean') s.ui.verticalTabs = patch.verticalTabs;
          if (typeof patch.autoRefresh === 'boolean') s.network.autoRefresh = patch.autoRefresh;
          if (typeof patch.offline === 'boolean') s.offline = patch.offline;
        });
        this.broadcast({ t: 'settings-updated' });
        break;
      }
      case 'proxy-checked': {
        const r = m.result as ProxyCheckResult | undefined;
        if (m.id !== id || !r || typeof r !== 'object') return;
        try { this.profiles.update(id, { proxyCheck: r }); } catch { /* deleted */ }
        this.pushProfiles();
        break;
      }
      case 'check-updates':
        await this.updates.check();
        break;
      case 'launch-detect':
        this.launchDetect();
        break;
      case 'launch-sandbox': {
        const p = this.profiles.get(id);
        if (!windowsSandboxAvailable()) {
          this.showLauncher();
          this.launcher?.webContents.send('mgr:toast', { key: 'wsb.unavailable' });
        } else this.launchInWindowsSandbox(p);
        break;
      }
      default:
        break;
    }
  }

  private broadcast(msg: { t: string; [k: string]: unknown }): void {
    for (const c of this.children.values()) c.channel.send(msg);
  }

  /** Portable copy of the app inside Windows Sandbox: app folder READ-ONLY, data discarded on close. */
  private launchInWindowsSandbox(p: Profile): void {
    const installDir = path.dirname(app.getPath('exe'));
    const exe = path.basename(app.getPath('exe'));
    const safeProfile = { ...p, network: { ...p.network, hasProxyCredentials: false }, encrypted: false };
    const wsb = buildWsbConfig({
      appHostDir: installDir,
      exeName: exe,
      downloadsHostDir: p.sandbox.shareDownloads ? this.ctx.layout.profileDownloadsDir(p.id) : undefined,
      networking: true,
      clipboard: p.sandbox.clipboard !== 'block',
      audioInput: p.sandbox.microphone,
      videoInput: p.sandbox.camera,
      args: [
        `--ephemeral-data-dir=${SANDBOX_DATA_DIR}`,
        `--lang-choice=${this.ctx.lang}`,
        `--sandbox-profile=${Buffer.from(JSON.stringify(safeProfile)).toString('base64')}`,
      ],
    });
    const file = path.join(this.ctx.layout.temp, `sandbox-${p.id}-${fileStamp()}.wsb`);
    fs.writeFileSync(file, wsb, 'utf8');
    launchWindowsSandbox(file);
    this.ctx.logger.info('sandbox.windows-sandbox-launched', { profile: p.id });
    setTimeout(() => fs.rmSync(file, { force: true }), 60_000);
  }

  private launchDetect(): void {
    const exeDir = path.dirname(app.getPath('exe'));
    const candidates = [
      path.join(exeDir, '..', 'OctoDetect', 'OctoDetect.su.exe'),
      path.join(exeDir, 'OctoDetect.su.exe'),
    ];
    const exe = candidates.find((c) => fs.existsSync(c));
    if (exe) launchDetached(exe);
    else this.launcher?.webContents.send('mgr:toast', { key: 'detect.notInstalled' });
  }

  // ------------------------------------------------------------ auto-lock

  private startAutoLock(): void {
    powerMonitor.on('lock-screen', () => void this.lockAll('autolock'));
    this.idleTimer = setInterval(() => {
      const mins = this.ctx.settings.load().security.autoLockMinutes;
      if (mins > 0 && powerMonitor.getSystemIdleTime() >= mins * 60) void this.lockAll('autolock');
    }, 30_000);
  }

  /**
   * Lock: close every encrypted profile. Their vaults are sealed when the
   * process exits and the cached vault keys are wiped, so opening them again
   * asks for the 12-word passphrase.
   *
   * When the data folder is protected with a MASTER PASSWORD the local key is
   * locked as well and the password is asked for again before the app can be
   * used. Cancelling that window quits the application rather than continuing
   * with a locked key.
   */
  async lockAll(reason: 'autolock' | 'manual'): Promise<void> {
    if (this.locking) return;
    const targets = [...this.children.keys()].filter((id) => this.profiles.get(id).encrypted);
    this.locking = true;
    this.ctx.logger.info('lock', { reason, profiles: targets.length });
    await Promise.all(targets.map((id) => new Promise<void>((resolve) => {
      const c = this.children.get(id);
      if (!c) return resolve();
      c.proc.once('exit', () => resolve());
      c.channel.send({ t: 'quit', reason: 'lock' });
      setTimeout(() => { if (!c.proc.killed) c.proc.kill(); resolve(); }, 8000);
    })));
    // The passphrase must be typed again after a lock.
    for (const [id, key] of this.vaultKeys) { wipe(key); this.vaultKeys.delete(id); }
    this.locking = false;
    this.pushProfiles();
    await this.lockLocalKey(reason);
  }

  /**
   * Lock the local key (only meaningful with a master password) and ask for it
   * again. With a DPAPI key there is nothing to lock, so this is a no-op.
   */
  private async lockLocalKey(reason: 'autolock' | 'manual'): Promise<void> {
    const keyring = this.ctx.keyring;
    if (!keyring.requiresPassword()) return;
    keyring.lock();
    this.ctx.logger.info('keyring.locked', { reason });
    const ok = await runMasterPasswordUnlock({
      distDir: this.ctx.prep.distDir,
      appId: 'octobrowser',
      productName: this.ctx.prep.info.productName,
      lang: this.ctx.lang,
      layout: this.ctx.layout,
      keyring,
      logger: this.ctx.logger,
    });
    if (!ok) app.quit();
  }

  // --------------------------------------------------------------- filters

  private async maybeUpdateFilters(force = false): Promise<{ updated: string[]; failed: string[] } | null> {
    const s = this.ctx.settings.load();
    if (s.offline && !force) return null;
    this.adblock.init();
    const last = this.adblock.updatedAt ? Date.parse(this.adblock.updatedAt) : 0;
    if (!force && Date.now() - last < 24 * 3600 * 1000) return null;
    const ses = session.fromPartition('octo-filters'); // in-memory, no cookies, isolated
    const r = await this.adblock.update((url) => ses.fetch(url, { credentials: 'omit', cache: 'no-store' } as RequestInit));
    if (r.updated.length) {
      this.ctx.settings.update((st) => { st.filtersUpdatedAt = this.adblock.updatedAt; });
      this.broadcast({ t: 'filters-updated' });
    }
    return r;
  }

  // ------------------------------------------------------------------- IPC

  private registerIpc(): void {
    const L = this.ctx.logger;
    const ctx = this.ctx;
    handle('mgr:init', L, () => ({
      lang: ctx.lang,
      dicts: DICTS,
      version: SUITE_VERSION,
      dataDir: ctx.layout.root,
      keyringMode: ctx.keyring.mode(),
      keyringRequiresPassword: ctx.keyring.requiresPassword(),
      secretBackend: ctx.secretBackend(),
      credmanAvailable: ctx.credmanAvailable(),
      addons: ADDONS,
      kinds: PROFILE_KINDS,
      windowsSandbox: windowsSandboxAvailable(),
      torBrowser: !!findTorBrowser(ctx.settings.load().tor.torBrowserPath),
      settings: ctx.settings.load(),
      update: this.updates.getStatus(),
      logMode: ctx.logger.getMode(),
      filtersUpdatedAt: this.adblock.updatedAt ?? null,
    }));
    handle('mgr:profiles', L, () => this.profileList());
    handle('mgr:isolation', L, (_e, id: string) => this.isolation(id));
    handle('mgr:launch', L, (_e, id: string, opts: { passphrase?: string; forceRestricted?: boolean }) => this.launch(id, opts ?? {}));
    handle('mgr:create', L, (_e, a: string | CreateInput, kind?: ProfileKind) => {
      const input: CreateInput = typeof a === 'string' ? { name: a, kind: kind as ProfileKind } : a;
      return this.createProfile(input);
    });
    // ---- antidetect: proxies + fingerprints ----
    handle('mgr:set-proxy', L, (_e, id: string, input: ProxyInput) => { const p = this.setProfileProxy(String(id), input); this.children.get(id)?.channel.send({ t: 'profile-updated', profile: p }); this.pushProfiles(); return p; });
    handle('mgr:proxy-check', L, (_e, input: ProxyInput) => this.checkProxyInput(input));
    handle('mgr:proxy-check-profile', L, (_e, id: string) => this.checkProfileProxy(String(id)));
    handle('mgr:proxy-change-ip', L, (_e, url: string) => this.changeProxyIp(String(url)));
    handle('mgr:proxies', L, () => this.proxies.list());
    handle('mgr:proxies-add', L, (_e, text: string, type: ProxyType, name?: string) => this.addProxies(text, type, name ?? ''));
    handle('mgr:proxies-update', L, (_e, id: string, patch: { name?: string; changeIpUrl?: string }) => { const r = this.proxies.update(String(id), { name: patch?.name, changeIpUrl: patch?.changeIpUrl }); this.pushProxies(); return r; });
    handle('mgr:proxies-remove', L, (_e, ids: string[]) => { for (const id of ([] as string[]).concat(ids)) this.proxies.remove(String(id)); this.pushProxies(); return true; });
    handle('mgr:proxies-check', L, (_e, id: string) => this.checkSavedProxy(String(id)));
    handle('mgr:api-status', L, () => this.apiStatus());
    handle('mgr:api-set', L, async (_e, patch: { enabled?: boolean; port?: number }) => {
      ctx.settings.update((s) => {
        if (typeof patch?.enabled === 'boolean') s.api.enabled = patch.enabled;
        if (Number.isInteger(patch?.port) && patch.port! >= 1024 && patch.port! <= 65535) s.api.port = patch.port!;
      });
      await this.applyApiSettings();
      return this.apiStatus();
    });
    handle('mgr:api-token', L, () => { this.regenerateApiToken(); return this.apiStatus(); });
    handle('mgr:fingerprint-new', L, (_e, os?: FingerprintOs) => this.newFingerprint(os));
    handle('mgr:fingerprint-meta', L, (_e, os: FingerprintOs) => ({
      gpus: gpuPresets(FP_OSES.includes(os) ? os : 'windows11'),
      userAgent: userAgentFor(FP_OSES.includes(os) ? os : 'windows11', engineVersion().major),
      engine: engineVersion(),
    }));
    handle('mgr:profile-bulk', L, async (_e, action: 'start' | 'stop' | 'remove' | 'folder' | 'status' | 'tags', ids: string[], arg?: unknown) => {
      const out: Record<string, unknown> = {};
      for (const id of ([] as string[]).concat(ids).map(String)) {
        try {
          if (action === 'start') out[id] = await this.launch(id, {});
          else if (action === 'stop') out[id] = this.stop(id);
          else if (action === 'remove') { this.removeProfile(id); out[id] = true; }
          else if (action === 'folder') out[id] = !!this.updateProfile(id, { folder: String(arg ?? '').slice(0, 48) });
          else if (action === 'status') out[id] = !!this.updateProfile(id, { status: String(arg ?? '').slice(0, 32) } as Partial<Profile>);
          else if (action === 'tags') out[id] = !!this.updateProfile(id, { tags: Array.isArray(arg) ? arg.map(String) : [] });
        } catch (err) { out[id] = { error: (err as Error).message }; }
      }
      this.pushProfiles();
      return out;
    });
    // Private browsing: one throw-away temporary profile, started right away.
    handle('mgr:private-browse', L, () => {
      const p = this.profiles.create({
        name: `${this.t('profile.privateName')} ${privateBrowsingStamp()}`,
        kind: 'temporary',
        patch: privateBrowsingPatch(),
      });
      this.pushProfiles();
      this.ctx.logger.info('profile.private-started', { profile: p.id });
      return this.launch(p.id, {});
    });
    handle('mgr:update', L, async (_e, id: string, patch: Partial<Profile> & { proxyUsername?: string; proxyPassword?: string; clearProxyCredentials?: boolean }) => {
      const { proxyUsername, proxyPassword, clearProxyCredentials, ...rest } = patch ?? {};
      if (clearProxyCredentials) ctx.secrets.delete(`proxy:${id}`);
      if (proxyUsername || proxyPassword) {
        ctx.secrets.set(`proxy:${id}`, JSON.stringify({ username: proxyUsername ?? '', password: proxyPassword ?? '' }));
      }
      const { proxy, ...fields } = rest as typeof rest & { proxy?: ProxyInput };
      const updated = this.updateProfile(id, { ...fields, network: { ...(fields.network ?? this.profiles.get(id).network), hasProxyCredentials: ctx.secrets.has(`proxy:${id}`) } }, proxy);
      return updated;
    });
    handle('mgr:duplicate', L, (_e, id: string, name: string, withData: boolean) => {
      if (withData && this.children.has(id)) throw new Error(this.t('err.closeProfileFirst'));
      const p = this.profiles.duplicate(id, String(name).slice(0, 64), !!withData);
      this.pushProfiles();
      return p;
    });
    handle('mgr:remove', L, (_e, id: string) => { this.removeProfile(String(id)); return true; });
    handle('mgr:reset', L, (_e, id: string) => {
      if (this.children.has(id)) throw new Error(this.t('err.closeProfileFirst'));
      this.profiles.reset(id);
      this.pushProfiles();
      return true;
    });
    handle('mgr:close-profile', L, (_e, id: string, force?: boolean) => this.stop(String(id), force === true));
    handle('mgr:lock-all', L, async () => { await this.lockAll('manual'); return true; });
    handle('mgr:master-password', L, async (_e, action: 'set' | 'remove', current: string, next: string, repeat: string) => {
      const keyring = ctx.keyring;
      if (action === 'set') {
        if (typeof next !== 'string' || next.length < 10) throw new Error(this.t('firstRun.err.weakPassword'));
        if (next !== repeat) throw new Error(this.t('firstRun.err.passwordMismatch'));
        await keyring.setPassword(keyring.requiresPassword() ? String(current ?? '') : null, next);
        L.info('keyring.password-set');
      } else {
        if (!keyring.requiresPassword()) return true;
        await keyring.removePassword(String(current ?? ''));
        L.info('keyring.password-removed');
      }
      this.pushProfiles();
      return true;
    });
    handle('mgr:set-encryption', L, async (_e, id: string, enable: boolean, passphrase?: string) => {
      if (this.children.has(id)) throw new Error(this.t('err.closeProfileFirst'));
      if (enable) {
        // A fresh 12-word passphrase is generated here and returned ONCE, so the
        // launcher can show it. Nothing stores it - losing it means losing the data.
        const { passphrase, key } = await this.profiles.createVault(id);
        this.profiles.sealVault(id, key); // encrypt existing data right away
        wipe(key);
        this.pushProfiles();
        L.info('vault.created', { profile: id });
        return { passphrase };
      } else {
        if (this.profiles.isVaultLocked(id)) {
          if (!isValidMnemonic(passphrase ?? '')) throw new Error(this.t('enc.passphraseRequired'));
          const key = await this.profiles.deriveVaultKey(id, passphrase!).catch(() => { throw new Error(this.t('unlock.wrong')); });
          this.profiles.openVault(id, key);
          wipe(key);
        }
        this.profiles.removeVault(id);
      }
      this.pushProfiles();
      return true;
    });
    handle('mgr:reseal', L, async (_e, id: string, passphrase: string) => {
      const key = await this.profiles.deriveVaultKey(id, passphrase).catch(() => { throw new Error(this.t('unlock.wrong')); });
      this.profiles.sealVault(id, key);
      wipe(key);
      this.pushProfiles();
      return true;
    });
    // A 12-word phrase for an export (or for the user to write down); never stored.
    handle('mgr:new-passphrase', L, () => generateMnemonic());
    handle('mgr:export', L, async (e, id: string, passphrase: string, withData: boolean) => {
      if (!isValidMnemonic(passphrase)) throw new Error(this.t('enc.passphraseRequired'));
      if (withData && this.children.has(id)) throw new Error(this.t('err.closeProfileFirst'));
      const p = this.profiles.get(id);
      const win = BrowserWindow.fromWebContents(e.sender)!;
      const r = await dialog.showSaveDialog(win, {
        defaultPath: path.join(ctx.layout.backups, `${p.name.replace(/[^\p{L}\p{N} _-]/gu, '_')}-${fileStamp()}.obprofile`),
        filters: [{ name: 'OctoBrowser profile (encrypted)', extensions: ['obprofile'] }],
      });
      if (r.canceled || !r.filePath) return false;
      await this.profiles.exportEncrypted(id, passphrase, r.filePath, !!withData);
      L.info('profile.exported', { profile: id, withData: !!withData });
      return true;
    });
    handle('mgr:import', L, async (e, passphrase: string) => {
      const win = BrowserWindow.fromWebContents(e.sender)!;
      const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'OctoBrowser profile', extensions: ['obprofile'] }] });
      if (r.canceled || !r.filePaths[0]) return null;
      try {
        const p = await this.profiles.importEncrypted(r.filePaths[0], String(passphrase ?? ''));
        this.pushProfiles();
        return p;
      } catch (err) {
        if (err instanceof DecryptionError) throw new Error(this.t('unlock.wrong'));
        throw err;
      }
    });
    handle('mgr:settings', L, (_e, patch: Record<string, unknown>) => {
      const updated = ctx.settings.update((s) => deepAssign(s as unknown as Record<string, unknown>, patch));
      if (patch.logs) ctx.logger.setMode(updated.logs.mode);
      this.updates.configureBackground();
      this.broadcast({ t: 'settings-updated' });
      return updated;
    });
    handle('mgr:set-language', L, (_e, lang: Lang) => {
      if (!isLang(lang)) throw new Error('invalid language');
      if (!ctx.prep.ephemeral) ctx.prep.store.setLanguage(lang);
      return true;
    });
    handle('mgr:relaunch', L, () => {
      for (const c of this.children.values()) c.channel.send({ t: 'quit', reason: 'user' });
      setTimeout(() => { app.relaunch(); app.quit(); }, 800);
      return true;
    });
    handle('mgr:open-folder', L, (_e, which: 'data' | 'logs' | 'backups' | 'downloads') => {
      const map = { data: ctx.layout.root, logs: ctx.layout.logs, backups: ctx.layout.backups, downloads: ctx.layout.profiles };
      void shell.openPath(map[which] ?? ctx.layout.root);
      return true;
    });
    handle('mgr:pick-folder', L, async (e) => {
      const win = BrowserWindow.fromWebContents(e.sender);
      const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] });
      return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
    });
    /**
     * Move the whole data folder to another base directory. The data is COPIED
     * first (never moved out from under a running process), the bootstrap file
     * is rewritten only after the copy succeeded, and the app relaunches so
     * Chromium starts from the new location. The old folder is left untouched.
     */
    handle('mgr:move-data', L, async (_e, baseDir: string, copyData: boolean) => {
      const check = validateBaseDir(String(baseDir ?? ''), ctx.prep.installDir);
      if (!check.ok) return { ok: false as const, errorKey: check.errorKey };
      const base = path.resolve(String(baseDir));
      const dataDir = path.join(base, ctx.prep.info.dataSubdir);
      if (path.resolve(dataDir).toLowerCase() === path.resolve(ctx.layout.root).toLowerCase()) {
        return { ok: false as const, errorKey: 'settings.dataDirSame' };
      }
      if (copyData) {
        if (!fs.existsSync(ctx.layout.root)) return { ok: false as const, errorKey: 'settings.dataDirMissing' };
        try {
          fs.cpSync(ctx.layout.root, dataDir, { recursive: true });
        } catch {
          return { ok: false as const, errorKey: 'settings.dataDirCopyFailed' };
        }
      } else {
        try {
          fs.mkdirSync(dataDir, { recursive: true });
        } catch {
          return { ok: false as const, errorKey: 'settings.dataDirCopyFailed' };
        }
      }
      const store = new BootstrapStore(bootstrapFileFor(ctx.prep.info, ctx.prep.portable));
      const cur = store.read();
      store.write({
        schema: 1,
        language: cur?.language ?? ctx.lang,
        baseDir: base,
        dataDir,
        firstRunAt: cur?.firstRunAt ?? new Date().toISOString(),
      });
      L.info('data.moved', { from: ctx.layout.root, to: dataDir, copied: !!copyData });
      return { ok: true as const, dataDir };
    });
    handle('mgr:logs-clear', L, () => L.clear());
    handle('mgr:log-mode', L, (_e, mode: 'standard' | 'diagnostic') => {
      L.setMode(mode === 'diagnostic' ? 'diagnostic' : 'standard');
      ctx.settings.update((s) => { s.logs.mode = L.getMode(); });
      return L.getMode();
    });
    handle('mgr:backups', L, () => ({ settings: ctx.settings.listBackups(), profiles: this.profiles.store.listBackups() }));
    handle('mgr:backup-restore', L, (_e, which: 'settings' | 'profiles', name: string) => {
      if (which === 'settings') ctx.settings.restore(String(name));
      else this.profiles.store.restore(String(name));
      this.pushProfiles();
      return true;
    });
    handle('mgr:update-check', L, () => this.updates.check());
    handle('mgr:update-download', L, () => this.updates.download());
    handle('mgr:update-install', L, async (_e, file: string) => {
      const full = path.join(ctx.layout.updater, 'downloads', path.basename(String(file)));
      if (!fs.existsSync(full)) throw new Error('installer missing');
      for (const c of this.children.values()) c.channel.send({ t: 'quit', reason: 'update' });
      await this.updates.install(full);
      return true;
    });
    handle('mgr:update-postpone', L, () => { this.updates.postpone(24); return true; });
    handle('mgr:update-skip', L, (_e, v: string) => { this.updates.skipVersion(String(v)); return true; });
    handle('mgr:update-rollback', L, (_e, v: string) => this.updates.rollback(String(v)));
    handle('mgr:filters-update', L, () => this.maybeUpdateFilters(true));
    handle('mgr:launch-detect', L, () => { this.launchDetect(); return true; });
    handle('mgr:open-external', L, (_e, which: 'tor' | 'bitwarden' | 'releases' | 'wsb-docs') => {
      const urls = {
        tor: 'https://www.torproject.org/download/',
        bitwarden: 'https://bitwarden.com/download/',
        releases: 'https://github.com/chargehuobey/lvocto/releases',
        'wsb-docs': 'https://learn.microsoft.com/windows/security/application-security/application-isolation/windows-sandbox/',
      };
      if (urls[which]) void shell.openExternal(urls[which]);
      return true;
    });
    handle('mgr:pick-tor', L, async (e) => {
      const win = BrowserWindow.fromWebContents(e.sender)!;
      const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'firefox.exe', extensions: ['exe'] }] });
      if (r.canceled || !r.filePaths[0] || path.basename(r.filePaths[0]).toLowerCase() !== 'firefox.exe') return null;
      ctx.settings.update((s) => { s.tor.torBrowserPath = r.filePaths[0]; });
      return r.filePaths[0];
    });
  }
}

/** Assign only keys that already exist in target (settings are validated afterwards). */
function deepAssign(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (!(k in target) || k === 'schema') continue;
    const cur = target[k];
    if (cur && typeof cur === 'object' && !Array.isArray(cur) && v && typeof v === 'object') deepAssign(cur as Record<string, unknown>, v as Record<string, unknown>);
    else if (typeof cur === typeof v) target[k] = v;
  }
}
