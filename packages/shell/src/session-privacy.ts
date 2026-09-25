/**
 * packages/shell/src/session-privacy.ts
 *
 * Applies a profile's privacy settings to its Electron Session:
 *   - proxy (system / direct / fixed rules),
 *   - HTTPS-Only (upgrade + interstitial fallback),
 *   - ad/tracker blocking, tracking-parameter stripping, bounce unwrapping,
 *   - third-party cookie stripping, Referer trimming, Sec-GPC,
 *   - permission policy (camera, mic, geolocation, notifications, clipboard,
 *     USB/HID/Serial/Bluetooth...),
 *   - downloads into the profile folder with dangerous-file confirmation,
 *   - certificate capture for the security panel,
 *   - traffic counters (bytes, requests, active connections, domains).
 *
 * Electron allows only ONE listener per webRequest event and session, so all
 * logic lives in the handlers below. Nothing about page CONTENT is recorded;
 * domains are kept in memory only and are cleared when the profile closes.
 */
import { Session, WebContents, DownloadItem } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getDomain, getHostname } from 'tldts';
import {
  Logger, Profile, PrivacySettings, effectiveSettings, isDangerousFile, stripTrackingParams, unwrapBounce,
} from '@octo/core';
import type { AdblockService } from './adblock';

export interface CertInfo {
  host: string;
  subject: string;
  issuer: string;
  validFrom: number;
  validTo: number;
  fingerprint: string;
  verified: boolean;
}

export class TrafficCounters {
  bytesIn = 0;
  bytesOut = 0;
  requests = 0;
  readonly active = new Set<number>();
  /** host -> request count (memory only). */
  readonly domains = new Map<string, number>();
  blocked = { ads: 0, trackers: 0, scripts: 0 };
  httpsUpgrades = 0;
  paramsStripped = 0;
  thirdPartyCookiesBlocked = 0;

  reset(): void {
    this.bytesIn = 0;
    this.bytesOut = 0;
    this.requests = 0;
    this.active.clear();
    this.domains.clear();
    this.blocked = { ads: 0, trackers: 0, scripts: 0 };
    this.httpsUpgrades = 0;
    this.paramsStripped = 0;
    this.thirdPartyCookiesBlocked = 0;
  }
}

export type PermissionKind =
  | 'camera' | 'microphone' | 'geolocation' | 'notifications' | 'clipboard-read' | 'display-capture'
  | 'devices' | 'openExternal' | 'pointerLock' | 'storage-access' | 'other';

export interface PrivacyHooks {
  logger: Logger;
  adblock: AdblockService | null;
  /** Ask the user (UI prompt). Must resolve to true only on explicit consent. */
  askPermission(wc: WebContents | null, kind: PermissionKind, origin: string): Promise<boolean>;
  confirmDangerousDownload(wc: WebContents | null, fileName: string): Promise<boolean>;
  onDownloadUpdate?(info: DownloadInfo): void;
  /** HTTPS upgrade of a top-level page failed: show interstitial. */
  onHttpsFailed?(wc: WebContents, originalUrl: string): void;
  /** Called when a request was blocked (for the per-tab counter). */
  onBlocked?(wc: WebContents | null, category: 'ads' | 'trackers'): void;
  /** Offline mode: cancel every network request. */
  isOffline?(): boolean;
}

export interface DownloadInfo {
  id: string;
  profileId: string;
  fileName: string;
  savePath: string;
  url: string;
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted' | 'paused' | 'awaiting-confirmation';
  received: number;
  total: number;
  dangerous: boolean;
  startedAt: string;
}

const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i;

function isThirdParty(requestUrl: string, firstPartyUrl: string | undefined): boolean {
  if (!firstPartyUrl) return false;
  const a = getDomain(requestUrl) ?? getHostname(requestUrl);
  const b = getDomain(firstPartyUrl) ?? getHostname(firstPartyUrl);
  return !!a && !!b && a !== b;
}

function setHeader(headers: Record<string, string | string[]>, name: string, value: string | null): void {
  for (const k of Object.keys(headers)) if (k.toLowerCase() === name.toLowerCase()) delete headers[k];
  if (value !== null) headers[name] = value;
}

function uniquePath(dir: string, name: string): string {
  const safe = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/^\.+/, '_').slice(0, 180) || 'download';
  const ext = path.extname(safe);
  const stem = safe.slice(0, safe.length - ext.length);
  let candidate = path.join(dir, safe);
  for (let i = 1; fs.existsSync(candidate) && i < 1000; i++) candidate = path.join(dir, `${stem} (${i})${ext}`);
  return candidate;
}

export class ProfileSessionController {
  readonly counters = new TrafficCounters();
  readonly certs = new Map<string, CertInfo>();
  readonly downloads = new Map<string, { item: DownloadItem; info: DownloadInfo }>();
  /** Hosts the user allowed over plain HTTP for this run (never persisted). */
  private readonly httpAllowed = new Set<string>();
  /** webContents id -> original http URL that was upgraded for the top frame. */
  private readonly upgradedTop = new Map<number, string>();
  /** In-memory permission decisions for this run: origin|kind -> granted. */
  private readonly grants = new Map<string, boolean>();
  private settings: PrivacySettings;
  private downloadSeq = 0;

  constructor(
    readonly ses: Session,
    private profile: Profile,
    private readonly downloadsDir: string,
    private readonly hooks: PrivacyHooks,
  ) {
    this.settings = effectiveSettings(profile.protection);
  }

  get privacy(): PrivacySettings {
    return this.settings;
  }

  get currentProfile(): Profile {
    return this.profile;
  }

  /** Install all handlers. Call once per session. */
  async install(userAgent: string, acceptLanguages: string): Promise<void> {
    this.ses.setUserAgent(userAgent, acceptLanguages);
    this.ses.setSpellCheckerEnabled(false); // spellchecker would download dictionaries from Google
    await this.applyProxy();
    this.installWebRequest();
    this.installPermissions();
    this.installDownloads();
    this.installCertificateCapture();
  }

  /** Re-apply after the profile was edited. */
  async update(profile: Profile): Promise<void> {
    const proxyChanged = JSON.stringify(profile.network) !== JSON.stringify(this.profile.network);
    this.profile = profile;
    this.settings = effectiveSettings(profile.protection);
    this.grants.clear();
    if (proxyChanged) {
      await this.applyProxy();
      await this.ses.closeAllConnections();
    }
  }

  private async applyProxy(): Promise<void> {
    const n = this.profile.network;
    if (n.mode === 'proxy' && n.proxyRules) {
      await this.ses.setProxy({ mode: 'fixed_servers', proxyRules: n.proxyRules, proxyBypassRules: n.proxyBypass || '<local>' });
    } else if (n.mode === 'direct') {
      await this.ses.setProxy({ mode: 'direct' });
    } else {
      await this.ses.setProxy({ mode: 'system' });
    }
    this.hooks.logger.info('profile.proxy', { profile: this.profile.id, mode: n.mode });
  }

  /** Describe the proxy that would be used for a URL ("DIRECT", "PROXY host:port", "SOCKS5 ..."). */
  async resolveProxy(url = 'https://example.com/'): Promise<string> {
    try {
      return await this.ses.resolveProxy(url);
    } catch {
      return 'UNKNOWN';
    }
  }

  allowHttpFor(host: string): void {
    this.httpAllowed.add(host.toLowerCase());
  }

  // ------------------------------------------------------------ webRequest

  private installWebRequest(): void {
    const wr = this.ses.webRequest;

    wr.onBeforeRequest((details, cb) => {
      const s = this.settings;
      const url = details.url;
      if (!/^(https?|wss?):/i.test(url)) return cb({}); // internal / data / blob / devtools
      if (this.hooks.isOffline?.()) return cb({ cancel: true });
      let host = '';
      try { host = new URL(url).hostname.toLowerCase(); } catch { return cb({ cancel: true }); }

      // 1. HTTPS-Only upgrade
      if (s.httpsOnly && /^(http|ws):/i.test(url) && !LOCAL_HOST.test(host) && !host.endsWith('.onion') && !this.httpAllowed.has(host)) {
        const upgraded = url.replace(/^http:/i, 'https:').replace(/^ws:/i, 'wss:');
        this.counters.httpsUpgrades++;
        if (details.resourceType === 'mainFrame' && details.webContentsId !== undefined) this.upgradedTop.set(details.webContentsId, url);
        return cb({ redirectURL: upgraded });
      }

      // 2. URL cleaning for top-level navigations
      if (details.resourceType === 'mainFrame') {
        if (s.blockBounceTracking) {
          const target = unwrapBounce(url);
          if (target) {
            this.counters.paramsStripped++;
            return cb({ redirectURL: target });
          }
        }
        if (s.stripTrackingParams && this.profile.addons.includes('clearurls')) {
          const clean = stripTrackingParams(url);
          if (clean !== url) {
            this.counters.paramsStripped++;
            return cb({ redirectURL: clean });
          }
        }
      }

      // 3. Ad / tracker blocking
      if (this.hooks.adblock && this.profile.addons.includes('adblock') && (s.blockAds || s.blockTrackers)) {
        const m = this.hooks.adblock.match(details, { ads: s.blockAds, trackers: s.blockTrackers });
        if (m.category) {
          this.counters.blocked[m.category]++;
          if (details.resourceType === 'script') this.counters.blocked.scripts++;
          this.hooks.onBlocked?.(details.webContents ?? null, m.category);
          return cb(m.redirect ? { redirectURL: m.redirect } : { cancel: true });
        }
      }

      // 4. Accounting (memory only)
      this.counters.requests++;
      this.counters.active.add(details.id);
      this.counters.domains.set(host, (this.counters.domains.get(host) ?? 0) + 1);
      if (details.uploadData) {
        for (const part of details.uploadData) this.counters.bytesOut += part.bytes?.length ?? 0;
      }
      cb({});
    });

    wr.onBeforeSendHeaders((details, cb) => {
      const s = this.settings;
      const headers = { ...details.requestHeaders } as Record<string, string>;
      const topUrl = details.webContents?.getURL();
      const third = details.resourceType !== 'mainFrame' && isThirdParty(details.url, topUrl);
      if (s.blockThirdPartyCookies && third && Object.keys(headers).some((k) => k.toLowerCase() === 'cookie')) {
        setHeader(headers, 'Cookie', null);
        this.counters.thirdPartyCookiesBlocked++;
      }
      if (s.trimReferrer) {
        const ref = Object.entries(headers).find(([k]) => k.toLowerCase() === 'referer')?.[1];
        if (ref && isThirdParty(details.url, ref)) {
          try { setHeader(headers, 'Referer', `${new URL(ref).origin}/`); } catch { setHeader(headers, 'Referer', null); }
        }
      }
      if (s.globalPrivacyControl) setHeader(headers, 'Sec-GPC', '1');
      cb({ requestHeaders: headers });
    });

    wr.onHeadersReceived((details, cb) => {
      const s = this.settings;
      const headers = details.responseHeaders ? { ...details.responseHeaders } : undefined;
      if (headers) {
        const len = Object.entries(headers).find(([k]) => k.toLowerCase() === 'content-length')?.[1]?.[0];
        if (len && /^\d+$/.test(len)) this.counters.bytesIn += Number(len);
        const topUrl = details.webContents?.getURL();
        if (s.blockThirdPartyCookies && details.resourceType !== 'mainFrame' && isThirdParty(details.url, topUrl)) {
          for (const k of Object.keys(headers)) {
            if (k.toLowerCase() === 'set-cookie') {
              delete headers[k];
              this.counters.thirdPartyCookiesBlocked++;
            }
          }
        }
      }
      cb({ responseHeaders: headers });
    });

    wr.onCompleted((details) => {
      this.counters.active.delete(details.id);
      if (details.resourceType === 'mainFrame' && details.webContentsId !== undefined) this.upgradedTop.delete(details.webContentsId);
    });

    wr.onErrorOccurred((details) => {
      this.counters.active.delete(details.id);
      if (details.resourceType !== 'mainFrame' || details.webContentsId === undefined) return;
      const original = this.upgradedTop.get(details.webContentsId);
      this.upgradedTop.delete(details.webContentsId);
      if (original && details.webContents && details.error !== 'net::ERR_ABORTED') {
        this.hooks.onHttpsFailed?.(details.webContents, original);
      }
    });
  }

  // ----------------------------------------------------------- permissions

  private mapPermission(permission: string, details: { mediaTypes?: string[] }): PermissionKind[] {
    switch (permission) {
      case 'media': {
        const kinds: PermissionKind[] = [];
        if (details.mediaTypes?.includes('video')) kinds.push('camera');
        if (details.mediaTypes?.includes('audio')) kinds.push('microphone');
        return kinds.length ? kinds : ['camera', 'microphone'];
      }
      case 'geolocation': return ['geolocation'];
      case 'notifications': return ['notifications'];
      case 'clipboard-read': return ['clipboard-read'];
      case 'display-capture': return ['display-capture'];
      case 'openExternal': return ['openExternal'];
      case 'pointerLock': return ['pointerLock'];
      case 'storage-access':
      case 'top-level-storage-access': return ['storage-access'];
      case 'hid': case 'serial': case 'usb': case 'bluetooth': return ['devices'];
      default: return ['other'];
    }
  }

  /** Static policy: 'deny' | 'allow' | 'ask'. */
  private policy(kind: PermissionKind): 'deny' | 'allow' | 'ask' {
    const s = this.settings;
    const sb = this.profile.sandbox;
    switch (kind) {
      case 'camera': return sb.camera ? 'ask' : 'deny';
      case 'microphone': return sb.microphone ? 'ask' : 'deny';
      case 'geolocation': return s.geolocation === 'block' ? 'deny' : 'ask';
      case 'notifications': return s.notifications === 'block' ? 'deny' : 'ask';
      case 'clipboard-read': return sb.clipboard === 'allow' ? 'ask' : 'deny';
      case 'devices': return sb.externalDevices ? 'ask' : 'deny';
      case 'display-capture': return sb.mode === 'restricted' ? 'deny' : 'ask';
      case 'openExternal': return 'ask';
      case 'pointerLock': return 'allow';
      case 'storage-access': return s.blockThirdPartyCookies ? 'deny' : 'ask';
      default: return 'deny';
    }
  }

  private installPermissions(): void {
    this.ses.setPermissionRequestHandler((wc, permission, callback, details) => {
      if (permission === 'fullscreen' || permission === 'speaker-selection' || permission === 'clipboard-sanitized-write') {
        return callback(permission !== 'clipboard-sanitized-write' || this.profile.sandbox.clipboard !== 'block');
      }
      const kinds = this.mapPermission(permission, details as { mediaTypes?: string[] });
      let origin = '';
      try { origin = new URL(details.requestingUrl ?? wc.getURL()).origin; } catch { /* keep empty */ }
      (async () => {
        for (const k of kinds) {
          const pol = this.policy(k);
          if (pol === 'deny') return false;
          if (pol === 'ask') {
            const key = `${origin}|${k}`;
            if (this.grants.has(key)) {
              if (!this.grants.get(key)) return false;
              continue;
            }
            const ok = await this.hooks.askPermission(wc, k, origin);
            this.grants.set(key, ok);
            if (!ok) return false;
          }
        }
        return true;
      })()
        .then((ok) => {
          this.hooks.logger.info('permission', { permission, granted: ok, profile: this.profile.id });
          callback(ok);
        })
        .catch(() => callback(false));
    });

    this.ses.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
      if (permission === 'fullscreen' || permission === 'speaker-selection') return true;
      if (permission === 'clipboard-sanitized-write') return this.profile.sandbox.clipboard !== 'block';
      const kinds = this.mapPermission(permission, { mediaTypes: (details as { mediaType?: string }).mediaType ? [(details as { mediaType?: string }).mediaType!] : undefined });
      return kinds.every((k) => this.policy(k) === 'allow' || this.grants.get(`${requestingOrigin}|${k}`) === true);
    });

    // WebUSB / WebHID / Web Serial / Bluetooth device pickers.
    this.ses.setDevicePermissionHandler(() => this.profile.sandbox.externalDevices);
    const denyPicker = (e: Electron.Event, _d: unknown, cb: (id: string) => void) => {
      if (!this.profile.sandbox.externalDevices) {
        e.preventDefault();
        cb('');
      }
    };
    this.ses.on('select-hid-device', (e, d, cb) => denyPicker(e, d, cb as (id: string) => void));
    this.ses.on('select-serial-port', (e, _ports, _wc, cb) => denyPicker(e, null, cb));
    this.ses.on('select-usb-device', (e, d, cb) => denyPicker(e, d, cb as (id: string) => void));
  }

  // ------------------------------------------------------------- downloads

  private installDownloads(): void {
    this.ses.on('will-download', (_e, item, wc) => {
      fs.mkdirSync(this.downloadsDir, { recursive: true });
      const savePath = uniquePath(this.downloadsDir, item.getFilename());
      item.setSavePath(savePath); // must be synchronous: never show the OS picker pointing elsewhere
      const dangerous = isDangerousFile(savePath);
      const info: DownloadInfo = {
        id: `d${++this.downloadSeq}`,
        profileId: this.profile.id,
        fileName: path.basename(savePath),
        savePath,
        url: item.getURL().replace(/[?#].*$/, ''),
        state: 'progressing',
        received: 0,
        total: item.getTotalBytes(),
        dangerous,
        startedAt: new Date().toISOString(),
      };
      this.downloads.set(info.id, { item, info });
      const emit = () => this.hooks.onDownloadUpdate?.({ ...info });
      item.on('updated', (_ev, state) => {
        info.received = item.getReceivedBytes();
        info.total = item.getTotalBytes();
        info.state = item.isPaused() ? 'paused' : state === 'interrupted' ? 'interrupted' : 'progressing';
        emit();
      });
      item.once('done', (_ev, state) => {
        info.received = item.getReceivedBytes();
        info.state = state;
        this.hooks.logger.info('download.done', { profile: this.profile.id, state, dangerous });
        emit();
      });
      if (dangerous && this.settings.warnDangerousDownloads) {
        item.pause();
        info.state = 'awaiting-confirmation';
        emit();
        this.hooks.confirmDangerousDownload(wc ?? null, info.fileName).then((ok) => {
          if (ok && item.getState() === 'progressing') item.resume();
          else item.cancel();
        }).catch(() => item.cancel());
      } else {
        emit();
      }
    });
  }

  controlDownload(id: string, action: 'pause' | 'resume' | 'cancel'): void {
    const d = this.downloads.get(id);
    if (!d) return;
    if (action === 'pause') d.item.pause();
    else if (action === 'resume' && d.item.canResume()) d.item.resume();
    else if (action === 'cancel') d.item.cancel();
  }

  // ----------------------------------------------------------- certificates

  private installCertificateCapture(): void {
    this.ses.setCertificateVerifyProc((req, cb) => {
      const c = req.certificate;
      this.certs.set(req.hostname, {
        host: req.hostname,
        subject: c.subjectName,
        issuer: c.issuerName,
        validFrom: c.validStart,
        validTo: c.validExpiry,
        fingerprint: c.fingerprint,
        verified: req.errorCode === 0,
      });
      cb(-3); // -3 = use Chromium's own verification result (we never weaken it)
    });
  }

  // ------------------------------------------------------------- lifecycle

  /** Clear cookies, storage and caches (clear-on-exit / manual "Clear data"). */
  async clearData(): Promise<void> {
    await this.ses.clearStorageData();
    await this.ses.clearCache();
    await this.ses.clearAuthCache();
    await this.ses.clearHostResolverCache();
    this.hooks.logger.info('profile.cleared', { profile: this.profile.id });
  }

  /** Called when the last window of the profile closes. */
  async onProfileClosed(): Promise<void> {
    this.counters.reset();
    this.certs.clear();
    this.httpAllowed.clear();
    this.grants.clear();
    if (this.settings.clearOnExit || this.profile.deleteOnClose) await this.clearData();
  }
}
