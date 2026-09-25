/**
 * packages/core/src/profiles.ts
 *
 * Profile system. Every profile has:
 *   profiles/<id>/engine/        own Chromium partition: cookies, cache,
 *                                localStorage, IndexedDB, service workers
 *   profiles/<id>/downloads/     own download folder
 *   profiles/<id>/bookmarks.enc  bookmarks  (AES-256-GCM, keyring DEK)
 *   profiles/<id>/history.enc    history    (only if enabled for the profile)
 *   profiles/<id>/session.enc    saved tabs/session
 *   profiles/<id>/engine.vault   only for encrypted profiles while locked
 *
 * Profile METADATA (name, kind, privacy level, proxy rules without passwords,
 * sandbox options...) lives in config/profiles.json via VersionedStore, which
 * backs up before each change. Proxy credentials go to SecretStore - never JSON.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { DataLayout } from './paths';
import { VersionedStore } from './config';
import { copyDir, ensureDir, secureDeleteDir, atomicWriteFile } from './fsutil';
import { ProtectionConfig, ProtectionLevel } from './privacy';
import { packDir, unpackTo, isCachePath } from './archive';
import {
  KdfParams, DEFAULT_KDF, decryptWithKey, decryptWithPassword, deriveKey, encryptWithKey, encryptWithPassword,
  wipe,
} from './crypto';
import { generateMnemonic, isValidMnemonic, normalizeMnemonic } from './mnemonic';
import type { SecretStoreApi } from './secretstore';
import { FingerprintConfig, generateFingerprint, realFingerprint, sanitizeFingerprint } from './fingerprint';
import { PROXY_TYPES, ProxyCheckResult, ProxyType, chromiumRules, isValidHost } from './proxy';

/**
 * antidetect = default profile type: behaves like a normal Chrome for every
 * site, with its own consistent fingerprint (OS, UA, WebGL, hardware ...).
 * The other kinds are privacy presets (see privacy.ts).
 */
export const PROFILE_KINDS = ['antidetect', 'personal', 'work', 'private', 'testing', 'temporary', 'tor', 'custom'] as const;
export type ProfileKind = (typeof PROFILE_KINDS)[number];

export interface NetworkConfig {
  /** system = use Windows proxy settings, direct = no proxy, proxy = rules below. */
  mode: 'system' | 'direct' | 'proxy';
  /** Chromium proxy rules, e.g. "socks5://127.0.0.1:1080" or "http=proxy:8080;https=proxy:8080". No credentials here. */
  proxyRules?: string;
  proxyBypass?: string;
  /** true when a username/password is stored in SecretStore under "proxy:<id>". */
  hasProxyCredentials?: boolean;
  /**
   * Structured proxy (set by the proxy editor). When present, proxyRules is
   * derived from it; credentials are in SecretStore ("proxy:<id>").
   */
  proxy?: ProfileProxy;
}

export interface ProfileProxy {
  type: ProxyType;
  host: string;
  port: number;
  changeIpUrl: string;
  /** Display name of the proxy (optional). */
  name: string;
  /** Id of the saved proxy it came from ('' = entered in this profile). */
  savedId: string;
}

/** Usage statistics shown in the profile list. */
export interface ProfileStats {
  launches: number;
  lastLaunchAt: string;
  /** Total seconds the profile was open. */
  worktimeSec: number;
}

/** Engine version used for new fingerprints; set by the app from process.versions.chrome. */
let engineFullVersion = '140.0.0.0';
export function setEngineVersion(full: string): void {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(full)) engineFullVersion = full;
}
export function engineVersion(): { full: string; major: number } {
  return { full: engineFullVersion, major: Number(engineFullVersion.split('.')[0]) };
}

/** Fingerprint for a new profile of this kind (only antidetect profiles spoof). */
export function fingerprintFor(kind: ProfileKind, seed?: string): FingerprintConfig {
  const { full, major } = engineVersion();
  return kind === 'antidetect' ? generateFingerprint({ engineMajor: major, engineFullVersion: full, seed }) : realFingerprint(major);
}

/**
 * Per-profile DNS. Each profile runs in its own browser process, so it can use
 * its own resolver configuration. 'inherit' = app-wide setting.
 */
export interface DnsConfig {
  mode: 'inherit' | 'system' | 'doh';
  /** DoH endpoint (https://...). Only used when mode = 'doh'. */
  dohTemplate: string;
}

export interface SandboxConfig {
  /** none = normal Chromium renderer sandbox only; restricted = extra permission lockdown; windows-sandbox = run in Windows Sandbox VM. */
  mode: 'none' | 'restricted' | 'windows-sandbox';
  clipboard: 'allow' | 'write-only' | 'block';
  camera: boolean;
  microphone: boolean;
  /** WebUSB / WebHID / Web Serial / Web Bluetooth. */
  externalDevices: boolean;
  /** Share the user's Downloads folder into Windows Sandbox (read-write). Default false: sandbox-only folder. */
  shareDownloads: boolean;
}

export interface AudioConfig {
  muted: boolean;
  /** 0..100 default volume for new tabs of this profile. */
  volume: number;
  /** Preferred output device id (HTMLMediaElement.setSinkId), '' = system default. */
  outputDeviceId: string;
}

export interface Profile {
  id: string;
  name: string;
  kind: ProfileKind;
  /** Accent colour for the profile badge (#rrggbb). */
  color: string;
  createdAt: string;
  updatedAt: string;
  protection: ProtectionConfig;
  network: NetworkConfig;
  dns: DnsConfig;
  sandbox: SandboxConfig;
  audio: AudioConfig;
  /** Enabled built-in modules / add-ons (ids from addons.ts). */
  addons: string[];
  /** Encrypt engine data at rest with a profile password (vault). */
  encrypted: boolean;
  /** Delete all engine data when the last window of this profile closes. */
  deleteOnClose: boolean;
  /** Store browsing history for this profile. */
  keepHistory: boolean;
  /** Restore previous session on open. */
  restoreSession: boolean;
  /** Home / start page. */
  homePage: string;
  /** Window chrome colour scheme of this profile: dark grey or white. */
  theme: ProfileTheme;
  /** Browser fingerprint (antidetect). */
  fingerprint: FingerprintConfig;
  /** Organisation (profile list). */
  tags: string[];
  folder: string;
  status: string;
  notes: string;
  /** Pages opened on every start (in addition to a restored session). */
  startPages: string[];
  /** Last proxy check (exit IP, country, timezone) - drives "auto" timezone/language/geo. */
  proxyCheck?: ProxyCheckResult;
  stats: ProfileStats;
}

/** Chrome colour scheme of a profile window (no effect on rendered pages). */
export type ProfileTheme = 'dark' | 'light';

const THEMES: ProfileTheme[] = ['dark', 'light'];

export function isProfileTheme(value: unknown): value is ProfileTheme {
  return typeof value === 'string' && (THEMES as string[]).includes(value);
}

/**
 * Settings of a private-browsing session: a temporary profile that keeps
 * nothing and is deleted when its last window closes. It is the "temporary"
 * kind with the privacy-relevant switches spelled out, so the promise made in
 * the UI (no history, no cookies kept, no data left behind) is explicit and
 * testable. Nothing here is randomised - every private session gets the same
 * settings; only the name carries the start time.
 */
export function privateBrowsingPatch(): Partial<Omit<Profile, 'id' | 'createdAt' | 'updatedAt' | 'kind'>> {
  return {
    deleteOnClose: true,
    keepHistory: false,
    restoreSession: false,
    protection: { level: 'strict', overrides: { clearOnExit: true, blockThirdPartyCookies: true, stripTrackingParams: true } },
  };
}

/** Local "YYYY-MM-DD HH:MM" stamp for the private-browsing profile name. */
export function privateBrowsingStamp(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

export interface ProfilesDoc {
  schema: 1;
  profiles: Profile[];
  lastUsedId?: string;
}

const COLORS: Record<ProfileKind, string> = {
  antidetect: '#2196f3',
  personal: '#7c5cff',
  work: '#3b82f6',
  private: '#a855f7',
  testing: '#f59e0b',
  temporary: '#64748b',
  tor: '#7e4798',
  custom: '#22c55e',
};

export const DEFAULT_ADDONS = ['adblock', 'clearurls', 'https-only', 'audio-mixer'];

/** Build a profile with sensible defaults for its kind. */
export function defaultProfile(kind: ProfileKind, name: string, id = newProfileId(), seed?: string): Profile {
  const now = new Date().toISOString();
  const level: ProtectionLevel = kind === 'antidetect' ? 'normal' : kind === 'tor' ? 'tor' : kind === 'private' || kind === 'temporary' ? 'strict' : 'standard';
  const anti = kind === 'antidetect';
  return {
    id,
    name,
    kind,
    color: COLORS[kind],
    createdAt: now,
    updatedAt: now,
    protection: { level },
    network: { mode: 'system' },
    dns: { mode: 'inherit', dohTemplate: '' },
    sandbox: {
      mode: kind === 'testing' || kind === 'private' ? 'restricted' : 'none',
      clipboard: kind === 'private' || kind === 'temporary' ? 'write-only' : 'allow',
      camera: anti || kind === 'personal' || kind === 'work',
      microphone: anti || kind === 'personal' || kind === 'work',
      externalDevices: false,
      shareDownloads: false,
    },
    audio: { muted: false, volume: 100, outputDeviceId: '' },
    addons: kind === 'tor' ? [] : anti ? ['audio-mixer'] : [...DEFAULT_ADDONS],
    encrypted: false,
    deleteOnClose: kind === 'temporary',
    keepHistory: anti || kind === 'personal' || kind === 'work',
    restoreSession: anti || kind === 'personal' || kind === 'work',
    homePage: 'octo://newtab',
    theme: 'dark',
    fingerprint: fingerprintFor(kind, seed),
    tags: [],
    folder: '',
    status: '',
    notes: '',
    startPages: [],
    stats: { launches: 0, lastLaunchAt: '', worktimeSec: 0 },
  };
}

function sanitizeProxy(v: unknown): ProfileProxy | undefined {
  const p = v as Partial<ProfileProxy> | undefined;
  if (!p || typeof p !== 'object') return undefined;
  if (!PROXY_TYPES.includes(p.type as ProxyType) || typeof p.host !== 'string' || !isValidHost(p.host)) return undefined;
  const port = Number(p.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  const cip = typeof p.changeIpUrl === 'string' && /^https?:\/\/\S{3,2000}$/.test(p.changeIpUrl) ? p.changeIpUrl : '';
  return {
    type: p.type as ProxyType, host: p.host.toLowerCase(), port, changeIpUrl: cip,
    name: typeof p.name === 'string' ? p.name.slice(0, 64) : '',
    savedId: typeof p.savedId === 'string' && /^[a-z0-9-]{0,64}$/.test(p.savedId) ? p.savedId : '',
  };
}

function sanitizeCheck(v: unknown): ProxyCheckResult | undefined {
  const c = v as Partial<ProxyCheckResult> | undefined;
  if (!c || typeof c !== 'object' || typeof c.at !== 'string') return undefined;
  const s = (x: unknown, n: number) => (typeof x === 'string' ? x.slice(0, n) : undefined);
  const f = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);
  return {
    ok: !!c.ok, at: c.at.slice(0, 40), ip: s(c.ip, 45), country: s(c.country, 64), countryCode: s(c.countryCode, 2), region: s(c.region, 64),
    city: s(c.city, 64), timezone: s(c.timezone, 64), latitude: f(c.latitude), longitude: f(c.longitude), latencyMs: f(c.latencyMs), error: s(c.error, 200),
  };
}

const START_PAGE = /^(https?:\/\/|octo:\/\/)\S{1,2040}$/i;

export function newProfileId(): string {
  return `p-${crypto.randomBytes(6).toString('hex')}`;
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** Validate and sanitise one profile (defensive: files may be edited or damaged). */
export function sanitizeProfile(input: unknown): Profile {
  const p = input as Partial<Profile>;
  if (!p || typeof p !== 'object') throw new Error('Profile must be an object');
  if (typeof p.id !== 'string' || !/^[a-z0-9-]{3,64}$/.test(p.id)) throw new Error('Invalid profile id');
  if (!PROFILE_KINDS.includes(p.kind as ProfileKind)) throw new Error('Invalid profile kind');
  // Deterministic base (seeded by the id): a profile without a stored fingerprint
  // gets the same generated one on every load instead of a new one each time.
  const base = defaultProfile(p.kind as ProfileKind, 'x', p.id, crypto.createHash('sha256').update(p.id).digest('hex').slice(0, 16));
  const name = typeof p.name === 'string' ? p.name.trim().slice(0, 64) : '';
  if (!name) throw new Error('Profile name required');
  const level = p.protection?.level;
  const out: Profile = {
    ...base,
    ...p,
    id: p.id,
    name,
    color: typeof p.color === 'string' && HEX_COLOR.test(p.color) ? p.color : base.color,
    protection: {
      level: level === 'normal' || level === 'standard' || level === 'strict' || level === 'tor' ? level : base.protection.level,
      overrides: p.kind === 'tor' ? undefined : p.protection?.overrides,
    },
    network: { ...base.network, ...(p.network ?? {}) },
    dns: { ...base.dns, ...(p.dns ?? {}) },
    sandbox: { ...base.sandbox, ...(p.sandbox ?? {}) },
    audio: { ...base.audio, ...(p.audio ?? {}) },
    addons: Array.isArray(p.addons) ? p.addons.filter((a) => typeof a === 'string').slice(0, 32) : base.addons,
    theme: isProfileTheme(p.theme) ? p.theme : base.theme,
    fingerprint: sanitizeFingerprint(p.fingerprint, base.fingerprint),
    tags: Array.isArray(p.tags) ? [...new Set(p.tags.filter((x) => typeof x === 'string').map((x) => x.trim().slice(0, 32)).filter(Boolean))].slice(0, 20) : [],
    folder: typeof p.folder === 'string' ? p.folder.trim().slice(0, 48) : '',
    status: typeof p.status === 'string' ? p.status.trim().slice(0, 32) : '',
    notes: typeof p.notes === 'string' ? p.notes.slice(0, 4000) : '',
    startPages: Array.isArray(p.startPages) ? p.startPages.filter((u) => typeof u === 'string' && START_PAGE.test(u.trim())).map((u) => u.trim()).slice(0, 10) : [],
    proxyCheck: sanitizeCheck(p.proxyCheck),
    stats: {
      launches: Math.max(0, Math.round(Number(p.stats?.launches) || 0)),
      lastLaunchAt: typeof p.stats?.lastLaunchAt === 'string' ? p.stats.lastLaunchAt.slice(0, 40) : '',
      worktimeSec: Math.max(0, Math.round(Number(p.stats?.worktimeSec) || 0)),
    },
  };
  out.network.proxy = sanitizeProxy(p.network?.proxy);
  if (out.network.proxy) {
    out.network.proxyRules = chromiumRules(out.network.proxy);
    if (out.network.mode !== 'proxy') out.network.proxy = undefined;
  }
  out.audio.volume = Math.max(0, Math.min(100, Math.round(Number(out.audio.volume) || 0)));
  if (!['system', 'direct', 'proxy'].includes(out.network.mode)) out.network.mode = 'system';
  if (!['inherit', 'system', 'doh'].includes(out.dns.mode)) out.dns.mode = 'inherit';
  if (!isProfileTheme(out.theme)) out.theme = base.theme;
  if (out.dns.dohTemplate && !/^https:\/\/[^\s]+$/.test(out.dns.dohTemplate)) out.dns.dohTemplate = '';
  if (out.dns.mode === 'doh' && !out.dns.dohTemplate) out.dns.mode = 'inherit';
  if (out.network.proxyRules && /[a-z]+:\/\/[^/\s]*:[^/\s]*@/i.test(out.network.proxyRules)) {
    // Credentials embedded in proxy rules are refused - they belong in SecretStore.
    throw new Error('Proxy rules must not contain credentials');
  }
  if (out.kind === 'tor') {
    out.addons = []; // Tor profile: no extra add-ons (they increase uniqueness)
    out.protection = { level: 'tor' };
  }
  return out;
}

function validateDoc(value: unknown): ProfilesDoc {
  const v = value as Partial<ProfilesDoc>;
  if (!v || v.schema !== 1 || !Array.isArray(v.profiles)) throw new Error('Invalid profiles document');
  const seen = new Set<string>();
  const profiles = v.profiles.map(sanitizeProfile).filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)));
  return { schema: 1, profiles, lastUsedId: typeof v.lastUsedId === 'string' ? v.lastUsedId : undefined };
}

export interface ProfileInput {
  name: string;
  kind: ProfileKind;
  patch?: Partial<Omit<Profile, 'id' | 'createdAt' | 'updatedAt' | 'kind'>>;
}

const EXPORT_CONTEXT = 'octosuite-profile-export-v1';
const VAULT_CONTEXT = 'octosuite-profile-vault-v1';

/** Marker file left by scripts\\restore-profile.bat when the profile entry is missing. */
export const RESTORED_ENTRY_FILE = 'restored-entry.json';

export class ProfileManager {
  readonly store: VersionedStore<ProfilesDoc>;

  constructor(
    private readonly layout: DataLayout,
    private readonly secrets?: SecretStoreApi,
    private readonly kdf: KdfParams = DEFAULT_KDF,
  ) {
    this.store = new VersionedStore<ProfilesDoc>(path.join(layout.config, 'profiles.json'), {
      backupDir: path.join(layout.backups, 'config'),
      defaults: () => ({ schema: 1, profiles: [] }),
      validate: validateDoc,
      maxBackups: 30,
    });
  }

  /** Create the default profile set on first run (Personal, Work, Private, Testing, Temporary, Tor). */
  ensureDefaults(names: Record<ProfileKind, string>, kinds: ProfileKind[] = ['personal', 'work', 'private', 'testing', 'temporary', 'tor']): void {
    const doc = this.store.load();
    if (doc.profiles.length > 0) return;
    const profiles = kinds.map((k) => defaultProfile(k, names[k]));
    this.store.save({ schema: 1, profiles, lastUsedId: profiles[0].id });
    for (const p of profiles) this.ensureDirs(p.id);
  }

  private ensureDirs(id: string): void {
    ensureDir(this.layout.profileEngineDir(id));
    ensureDir(this.layout.profileDownloadsDir(id));
  }

  list(): Profile[] {
    return this.store.load().profiles;
  }

  get(id: string): Profile {
    const p = this.list().find((x) => x.id === id);
    if (!p) throw new Error(`Profile not found: ${id}`);
    return p;
  }

  lastUsed(): Profile | undefined {
    const doc = this.store.load();
    return doc.profiles.find((p) => p.id === doc.lastUsedId) ?? doc.profiles[0];
  }

  setLastUsed(id: string): void {
    this.get(id);
    this.store.update((d) => { d.lastUsedId = id; });
  }

  create(input: ProfileInput): Profile {
    const base = defaultProfile(input.kind, input.name);
    const p = sanitizeProfile({ ...base, ...(input.patch ?? {}), id: base.id, kind: input.kind, name: input.name });
    this.store.update((d) => { d.profiles.push(p); });
    this.ensureDirs(p.id);
    return p;
  }

  update(id: string, patch: Partial<Omit<Profile, 'id' | 'createdAt' | 'kind'>>): Profile {
    let updated: Profile | undefined;
    this.store.update((d) => {
      const i = d.profiles.findIndex((p) => p.id === id);
      if (i < 0) throw new Error(`Profile not found: ${id}`);
      const cur = d.profiles[i];
      updated = sanitizeProfile({
        ...cur,
        ...patch,
        id: cur.id,
        kind: cur.kind,
        createdAt: cur.createdAt,
        updatedAt: new Date().toISOString(),
        network: { ...cur.network, ...(patch.network ?? {}) },
        dns: { ...cur.dns, ...(patch.dns ?? {}) },
        sandbox: { ...cur.sandbox, ...(patch.sandbox ?? {}) },
        audio: { ...cur.audio, ...(patch.audio ?? {}) },
        protection: patch.protection ?? cur.protection,
        fingerprint: patch.fingerprint ?? cur.fingerprint,
        stats: { ...cur.stats, ...(patch.stats ?? {}) },
      });
      d.profiles[i] = updated;
    });
    return updated!;
  }

  /** Duplicate settings (and optionally cookies/storage) into a new profile. */
  duplicate(id: string, newName: string, includeData = false): Profile {
    const src = this.get(id);
    if (includeData && src.encrypted && fs.existsSync(this.layout.profileVaultFile(id))) {
      throw new Error('Unlock the encrypted profile before duplicating its data');
    }
    const copy = this.create({
      name: newName,
      kind: src.kind,
      patch: {
        ...structuredClone(src), name: newName, network: { ...src.network, hasProxyCredentials: false },
        // A copy must not share the fingerprint (that would link both profiles): new seed, same OS.
        fingerprint: src.fingerprint.enabled
          ? { ...generateFingerprint({ engineMajor: engineVersion().major, engineFullVersion: engineVersion().full, os: src.fingerprint.os }), timezone: src.fingerprint.timezone, language: src.fingerprint.language, geolocation: src.fingerprint.geolocation, webrtc: src.fingerprint.webrtc }
          : src.fingerprint,
        stats: { launches: 0, lastLaunchAt: '', worktimeSec: 0 },
      },
    });
    if (includeData) {
      copyDir(this.layout.profileEngineDir(id), this.layout.profileEngineDir(copy.id), isCachePath);
    }
    return copy;
  }

  /** Delete profile, its files (best-effort secure delete) and its secrets. */
  remove(id: string): void {
    this.get(id);
    this.store.update((d) => {
      d.profiles = d.profiles.filter((p) => p.id !== id);
      if (d.lastUsedId === id) d.lastUsedId = d.profiles[0]?.id;
    });
    secureDeleteDir(this.layout.profileDir(id));
    this.secrets?.deletePrefix(`proxy:${id}`);
  }

  /** Wipe cookies, cache, storage, history, session - keep settings and bookmarks (and vault password). */
  reset(id: string, opts: { keepBookmarks?: boolean } = { keepBookmarks: true }): void {
    this.get(id);
    secureDeleteDir(this.layout.profileEngineDir(id));
    fs.rmSync(this.layout.profileVaultFile(id), { force: true });
    for (const f of ['history', 'session'] as const) fs.rmSync(this.layout.profileDataFile(id, f), { force: true });
    if (!opts.keepBookmarks) fs.rmSync(this.layout.profileDataFile(id, 'bookmarks'), { force: true });
    this.ensureDirs(id);
  }

  /** Wipe engine data of temporary / delete-on-close profiles (called at start and on close). */
  /**
   * Re-add profile entries restored by scripts\restore-profile.bat.
   *
   * The script never edits profiles.json itself (the app is the only writer).
   * When it restores the data folder of a profile whose entry no longer exists,
   * it leaves the archived entry (no secrets - proxy passwords live in
   * secrets.bin) in profiles/<id>/restored-entry.json. Here that entry is
   * validated with the same sanitiser as profiles.json and added back.
   * Invalid or conflicting files are renamed to *.rejected and never trusted.
   *
   * @returns the adopted profiles (and ids whose entry was rejected)
   */
  adoptRestoredEntries(): { adopted: Profile[]; rejected: string[] } {
    const adopted: Profile[] = [];
    const rejected: string[] = [];
    let dirs: string[];
    try {
      dirs = fs.readdirSync(this.layout.profiles, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return { adopted, rejected }; // no profiles folder yet
    }
    const known = new Set(this.list().map((p) => p.id));
    for (const dir of dirs) {
      if (!/^[a-z0-9-]{3,64}$/.test(dir)) continue;
      const file = path.join(this.layout.profiles, dir, RESTORED_ENTRY_FILE);
      if (!fs.existsSync(file)) continue;
      try {
        const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
        if (raw.length > 256 * 1024) throw new Error('entry too large');
        const entry = sanitizeProfile(JSON.parse(raw));
        if (entry.id !== dir) throw new Error('entry id does not match its folder');
        if (!known.has(entry.id)) {
          // Keep the encryption flag consistent with what is actually on disk.
          const fixed: Profile = { ...entry, encrypted: fs.existsSync(this.vaultMetaFile(entry.id)), updatedAt: new Date().toISOString() };
          this.store.update((d) => { d.profiles.push(fixed); });
          known.add(fixed.id);
          this.ensureDirs(fixed.id);
          adopted.push(fixed);
        }
        fs.rmSync(file, { force: true }); // entry exists now (or already existed)
      } catch {
        rejected.push(dir);
        try { fs.renameSync(file, `${file}.rejected`); } catch { /* leave it; it is ignored next time only if renamed */ }
      }
    }
    return { adopted, rejected };
  }

  cleanupEphemeral(id?: string): string[] {
    const cleaned: string[] = [];
    for (const p of this.list()) {
      if (id && p.id !== id) continue;
      if (p.deleteOnClose || p.kind === 'temporary') {
        secureDeleteDir(this.layout.profileEngineDir(p.id));
        fs.rmSync(this.layout.profileDataFile(p.id, 'history'), { force: true });
        fs.rmSync(this.layout.profileDataFile(p.id, 'session'), { force: true });
        this.ensureDirs(p.id);
        cleaned.push(p.id);
      }
    }
    return cleaned;
  }

  // ---------------------------------------------------------------- vault --
  //
  // Encrypted profiles ("vault"): while the profile is CLOSED its engine data
  // (cookies, localStorage, IndexedDB... - caches are discarded) exists only as
  // profiles/<id>/engine.vault, encrypted with AES-256-GCM under a key derived
  // with Argon2id from the profile's 12-word passphrase (BIP-39, 128 bits of
  // entropy - see mnemonic.ts). vault.json holds only the salt, KDF parameters
  // and an encrypted check value (to reject a wrong phrase before touching
  // data); the phrase itself is never stored anywhere. While the profile is
  // OPEN the derived key is kept in memory (Buffer, wiped on seal) so auto-lock
  // can re-seal without asking for the phrase again.
  //
  // The same phrase is the recovery code: with the 12 words and a copy of
  // profiles/<id> (or an export) the profile can be opened on another computer.

  private vaultMetaFile(id: string): string {
    return path.join(this.layout.profileDir(id), 'vault.json');
  }

  hasVault(id: string): boolean {
    return fs.existsSync(this.vaultMetaFile(id));
  }

  /** true = sealed (engine data is only in encrypted form on disk). */
  isVaultLocked(id: string): boolean {
    return fs.existsSync(this.layout.profileVaultFile(id));
  }

  /**
   * Enable encryption for a profile with an existing 12-word passphrase.
   * Returns the derived key (caller holds & wipes it).
   */
  async initVault(id: string, passphrase: string): Promise<Buffer> {
    this.get(id);
    const phrase = normalizeMnemonic(passphrase);
    if (!isValidMnemonic(phrase)) throw new Error('A valid 12-word passphrase is required');
    const salt = crypto.randomBytes(16);
    const key = await deriveKey(phrase, salt, this.kdf);
    const check = encryptWithKey(key, Buffer.from('octo-vault-check', 'utf8'), `${VAULT_CONTEXT}:check:${id}`);
    atomicWriteFile(this.vaultMetaFile(id), JSON.stringify({
      schema: 1, salt: salt.toString('base64'), kdf: this.kdf, check: check.toString('base64'),
    }));
    this.update(id, { encrypted: true });
    return key;
  }

  /**
   * Turn on encryption with a freshly generated passphrase. The phrase is
   * returned ONCE - it is the only way to open the profile later, and nothing
   * in OctoSuite keeps a copy of it.
   */
  async createVault(id: string): Promise<{ passphrase: string; key: Buffer }> {
    const passphrase = generateMnemonic();
    const key = await this.initVault(id, passphrase);
    return { passphrase, key };
  }

  /** Derive the vault key from the 12-word phrase and verify it. Throws DecryptionError on a wrong phrase. */
  async deriveVaultKey(id: string, passphrase: string): Promise<Buffer> {
    const meta = JSON.parse(fs.readFileSync(this.vaultMetaFile(id), 'utf8')) as { schema: 1; salt: string; kdf: KdfParams; check: string };
    const key = await deriveKey(normalizeMnemonic(passphrase), Buffer.from(meta.salt, 'base64'), meta.kdf);
    try {
      decryptWithKey(key, Buffer.from(meta.check, 'base64'), `${VAULT_CONTEXT}:check:${id}`);
    } catch (err) {
      wipe(key);
      throw err;
    }
    return key;
  }

  /** Decrypt the sealed engine data (if sealed). The key must come from deriveVaultKey/initVault. */
  openVault(id: string, key: Buffer): void {
    const vault = this.layout.profileVaultFile(id);
    if (!fs.existsSync(vault)) return; // not sealed (new vault or recovered after crash)
    const plain = decryptWithKey(key, fs.readFileSync(vault), `${VAULT_CONTEXT}:${id}`);
    try {
      const engine = this.layout.profileEngineDir(id);
      secureDeleteDir(engine);
      unpackTo(plain, engine);
    } finally {
      wipe(plain);
    }
    fs.rmSync(vault, { force: true });
  }

  /**
   * Seal: pack engine data (without caches), encrypt, then securely delete the
   * plain folder. All windows of the profile MUST be closed first.
   */
  sealVault(id: string, key: Buffer): void {
    if (!this.hasVault(id)) throw new Error('Profile has no vault');
    const engine = this.layout.profileEngineDir(id);
    const plain = packDir(engine);
    try {
      atomicWriteFile(this.layout.profileVaultFile(id), encryptWithKey(key, plain, `${VAULT_CONTEXT}:${id}`));
    } finally {
      wipe(plain);
    }
    secureDeleteDir(engine);
    ensureDir(engine);
  }

  /** Encrypted profile whose engine data is currently in plain form (e.g. after a crash). */
  needsResealing(id: string): boolean {
    const p = this.get(id);
    if (!p.encrypted || !this.hasVault(id) || this.isVaultLocked(id)) return false;
    const engine = this.layout.profileEngineDir(id);
    return fs.existsSync(engine) && fs.readdirSync(engine).length > 0;
  }

  /** Disable encryption: requires the vault to be open (plain data present). */
  removeVault(id: string): void {
    if (this.isVaultLocked(id)) throw new Error('Unlock the profile first');
    fs.rmSync(this.vaultMetaFile(id), { force: true });
    this.update(id, { encrypted: false });
  }

  // --------------------------------------------------------- export/import --

  /**
   * Export a profile. Exports are ALWAYS encrypted with the same kind of
   * 12-word passphrase used by profile vaults; there is no plain-text export.
   * Secrets (proxy credentials) are never exported.
   */
  async exportEncrypted(id: string, passphrase: string, outFile: string, includeData = true): Promise<void> {
    if (!isValidMnemonic(passphrase)) throw new Error('A valid 12-word passphrase is required');
    const p = this.get(id);
    if (includeData && this.isVaultLocked(id)) throw new Error('Unlock the profile before exporting its data');
    const staging = path.join(this.layout.temp, `export-${crypto.randomBytes(6).toString('hex')}`);
    ensureDir(staging);
    try {
      const meta = { ...p, network: { ...p.network, hasProxyCredentials: false } };
      fs.writeFileSync(path.join(staging, 'profile.json'), JSON.stringify({ format: 'octobrowser-profile', version: 1, profile: meta }));
      if (includeData) copyDir(this.layout.profileEngineDir(id), path.join(staging, 'engine'), isCachePath);
      const plain = packDir(staging, () => false);
      try {
        const blob = await encryptWithPassword(normalizeMnemonic(passphrase), plain, { kdf: this.kdf, context: EXPORT_CONTEXT });
        atomicWriteFile(outFile, blob);
      } finally {
        wipe(plain);
      }
    } finally {
      secureDeleteDir(staging);
    }
  }

  /**
   * Import an encrypted export as a NEW profile (new id, never overwrites).
   * This is also the "recover my profile on another computer" path: the export
   * plus its 12 words are everything that is needed.
   */
  async importEncrypted(file: string, passphrase: string): Promise<Profile> {
    const plain = await decryptWithPassword(normalizeMnemonic(passphrase), fs.readFileSync(file), EXPORT_CONTEXT);
    const staging = path.join(this.layout.temp, `import-${crypto.randomBytes(6).toString('hex')}`);
    try {
      unpackTo(plain, staging);
      const doc = JSON.parse(fs.readFileSync(path.join(staging, 'profile.json'), 'utf8')) as { format: string; version: number; profile: Profile };
      if (doc.format !== 'octobrowser-profile' || doc.version !== 1) throw new Error('Not an OctoBrowser profile export');
      const src = sanitizeProfile(doc.profile);
      const created = this.create({ name: `${src.name}`, kind: src.kind, patch: { ...src, encrypted: false } });
      const engineSrc = path.join(staging, 'engine');
      if (fs.existsSync(engineSrc)) copyDir(engineSrc, this.layout.profileEngineDir(created.id));
      return created;
    } finally {
      wipe(plain);
      secureDeleteDir(staging);
    }
  }
}

// ------------------------------------------------------ per-profile data --

export interface Bookmark { id: string; title: string; url: string; folder?: string; createdAt: string }
export interface HistoryEntry { url: string; title: string; visitedAt: string }
export interface SavedTab { url: string; title: string; pinned: boolean; group?: string }
export interface SavedSession { savedAt: string; tabs: SavedTab[]; activeIndex: number }

/**
 * Encrypted per-profile data (bookmarks, history, session). Uses the keyring
 * DEK, so the files are unreadable without the local key (see keyring.ts).
 */
export class ProfileData {
  readonly bookmarks: VersionedStore<Bookmark[]>;
  readonly history: VersionedStore<HistoryEntry[]>;
  readonly session: VersionedStore<SavedSession | null>;

  constructor(layout: DataLayout, id: string, keyProvider: () => Buffer) {
    const backupDir = path.join(layout.profileDir(id), 'backups');
    const mk = <T>(name: 'bookmarks' | 'history' | 'session', defaults: () => T, max: number, backupOnSave: boolean) =>
      new VersionedStore<T>(layout.profileDataFile(id, name), {
        backupDir, defaults, keyProvider, context: `octosuite-${name}:${id}`, maxBackups: max, backupOnSave,
      });
    this.bookmarks = mk<Bookmark[]>('bookmarks', () => [], 10, true);
    this.history = mk<HistoryEntry[]>('history', () => [], 2, false);
    this.session = mk<SavedSession | null>('session', () => null, 3, false);
  }

  addHistory(entry: HistoryEntry, max = 5000): void {
    this.history.update((h) => {
      h.unshift(entry);
      if (h.length > max) h.length = max;
    });
  }
}
