/**
 * packages/core/src/fingerprint.ts
 *
 * Per-profile browser fingerprint (antidetect profiles).
 *
 * Every profile gets ONE consistent, stored fingerprint: operating system,
 * user agent (+ matching User-Agent Client Hints), WebGL vendor/renderer,
 * CPU cores, memory, screen, timezone, languages, geolocation, media devices
 * and the noise modes for Canvas / WebGL / Audio / ClientRects / fonts.
 *
 * Rules that keep a generated fingerprint realistic:
 *   - the Chrome MAJOR version always equals the real engine version
 *     (a different version would contradict the JS/CSS features the page sees);
 *   - the GPU list is filtered by OS (no Apple M2 on Windows, no D3D11 on macOS);
 *   - CPU / memory values are drawn from what real devices of that OS report
 *     (navigator.deviceMemory is capped at 8 by Chrome itself);
 *   - noise is SEEDED per profile: the same profile returns the same Canvas /
 *     WebGL / Audio hash on every visit, different profiles differ.
 *
 * Pure module (no Electron) - fully unit-tested.
 */
import * as crypto from 'node:crypto';

export const FP_OSES = ['windows11', 'windows10', 'macos', 'linux'] as const;
export type FingerprintOs = (typeof FP_OSES)[number];

export type WebRtcMode = 'off' | 'real' | 'disable-udp' | 'altered' | 'manual';
export type NoiseMode = 'off' | 'real' | 'noise';
export type AutoManual = 'auto' | 'manual';
export type RealManual = 'real' | 'manual';

export interface FingerprintConfig {
  /** Master switch. Off = the engine reports its real values (plain Chromium). */
  enabled: boolean;
  os: FingerprintOs;
  userAgent: string;
  /** Full Chrome version reported in UA Client Hints (major == engine major). */
  uaFullVersion: string;
  /** UA-CH platformVersion (e.g. Windows 11 => "15.0.0"). */
  platformVersion: string;
  webrtc: { mode: WebRtcMode; publicIp: string };
  canvas: NoiseMode;
  webgl: NoiseMode;
  webglInfo: { mode: RealManual; vendor: string; renderer: string };
  webgpu: 'off' | 'real';
  clientRects: 'real' | 'noise';
  timezone: { mode: AutoManual | 'real'; value: string };
  language: { mode: AutoManual | 'real'; value: string };
  geolocation: { mode: AutoManual | 'block'; latitude: number; longitude: number; accuracy: number };
  cpu: { mode: RealManual; cores: number };
  memory: { mode: RealManual; gb: number };
  screen: { mode: RealManual; width: number; height: number };
  fonts: 'real' | 'noise';
  audio: 'real' | 'noise';
  mediaDevices: { mode: RealManual; audioInputs: number; audioOutputs: number; videoInputs: number };
  ports: { mode: 'real' | 'protect'; list: string };
  doNotTrack: boolean;
  /** Hex seed for all deterministic noise of this profile. */
  seed: string;
}

// ------------------------------------------------------------------ data --

export interface GpuPreset { vendor: string; renderer: string; weight: number; tier: 'low' | 'mid' | 'high' }

const D3D = (brand: string, name: string, id: string) =>
  `ANGLE (${brand}, ${name} (0x0000${id}) Direct3D11 vs_5_0 ps_5_0, D3D11)`;

const WIN_GPUS: GpuPreset[] = [
  { vendor: 'Google Inc. (Intel)', renderer: D3D('Intel', 'Intel(R) UHD Graphics 620', '5917'), weight: 8, tier: 'low' },
  { vendor: 'Google Inc. (Intel)', renderer: D3D('Intel', 'Intel(R) UHD Graphics 630', '3E92'), weight: 8, tier: 'low' },
  { vendor: 'Google Inc. (Intel)', renderer: D3D('Intel', 'Intel(R) Iris(R) Xe Graphics', '9A49'), weight: 10, tier: 'mid' },
  { vendor: 'Google Inc. (Intel)', renderer: D3D('Intel', 'Intel(R) UHD Graphics 770', '4680'), weight: 4, tier: 'mid' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: D3D('NVIDIA', 'NVIDIA GeForce GTX 1050 Ti', '1C82'), weight: 5, tier: 'low' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: D3D('NVIDIA', 'NVIDIA GeForce GTX 1060 6GB', '1C03'), weight: 6, tier: 'mid' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: D3D('NVIDIA', 'NVIDIA GeForce GTX 1650', '1F82'), weight: 8, tier: 'mid' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: D3D('NVIDIA', 'NVIDIA GeForce GTX 1660 SUPER', '21C4'), weight: 6, tier: 'mid' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: D3D('NVIDIA', 'NVIDIA GeForce RTX 2060', '1F08'), weight: 5, tier: 'high' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: D3D('NVIDIA', 'NVIDIA GeForce RTX 3060', '2504'), weight: 8, tier: 'high' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: D3D('NVIDIA', 'NVIDIA GeForce RTX 3060 Ti', '2489'), weight: 4, tier: 'high' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: D3D('NVIDIA', 'NVIDIA GeForce RTX 3070', '2484'), weight: 4, tier: 'high' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: D3D('NVIDIA', 'NVIDIA GeForce RTX 4060', '2882'), weight: 5, tier: 'high' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: D3D('NVIDIA', 'NVIDIA GeForce RTX 4070', '2786'), weight: 3, tier: 'high' },
  { vendor: 'Google Inc. (AMD)', renderer: D3D('AMD', 'AMD Radeon(TM) Graphics', '1638'), weight: 5, tier: 'low' },
  { vendor: 'Google Inc. (AMD)', renderer: D3D('AMD', 'AMD Radeon RX 580 Series', '67DF'), weight: 4, tier: 'mid' },
  { vendor: 'Google Inc. (AMD)', renderer: D3D('AMD', 'AMD Radeon RX 6600', '73FF'), weight: 3, tier: 'high' },
  { vendor: 'Google Inc. (AMD)', renderer: D3D('AMD', 'AMD Radeon RX 6700 XT', '73DF'), weight: 2, tier: 'high' },
];

const MAC_GPUS: GpuPreset[] = [
  { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)', weight: 10, tier: 'mid' },
  { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)', weight: 5, tier: 'high' },
  { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)', weight: 8, tier: 'mid' },
  { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)', weight: 3, tier: 'high' },
  { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version)', weight: 6, tier: 'mid' },
  { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro, Unspecified Version)', weight: 3, tier: 'high' },
  { vendor: 'Google Inc. (Intel Inc.)', renderer: 'ANGLE (Intel Inc., Intel(R) Iris(TM) Plus Graphics OpenGL Engine, OpenGL 4.1)', weight: 3, tier: 'low' },
];

const LINUX_GPUS: GpuPreset[] = [
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)', weight: 6, tier: 'low' },
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Mesa Intel(R) Xe Graphics (TGL GT2), OpenGL 4.6)', weight: 5, tier: 'mid' },
  { vendor: 'Google Inc. (NVIDIA Corporation)', renderer: 'ANGLE (NVIDIA Corporation, NVIDIA GeForce GTX 1660 SUPER/PCIe/SSE2, OpenGL 4.5.0 NVIDIA 535.183.01)', weight: 4, tier: 'mid' },
  { vendor: 'Google Inc. (NVIDIA Corporation)', renderer: 'ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX 3060/PCIe/SSE2, OpenGL 4.5.0 NVIDIA 550.107.02)', weight: 4, tier: 'high' },
  { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 6600 (radeonsi, navy_flounder, LLVM 15.0.7, DRM 3.54, 6.5.0-35-generic), OpenGL 4.6)', weight: 3, tier: 'high' },
];

export function gpuPresets(os: FingerprintOs): GpuPreset[] {
  return os === 'macos' ? MAC_GPUS : os === 'linux' ? LINUX_GPUS : WIN_GPUS;
}

/** Common screen resolutions per OS (CSS pixels), weighted by real-world share. */
const SCREENS: Record<'win' | 'mac' | 'linux', Array<[number, number, number]>> = {
  win: [[1920, 1080, 30], [1366, 768, 10], [1536, 864, 12], [2560, 1440, 9], [1440, 900, 5], [1600, 900, 5], [1280, 720, 3], [1280, 1024, 2], [1680, 1050, 3], [1920, 1200, 3]],
  mac: [[1440, 900, 12], [1512, 982, 10], [1728, 1117, 6], [1680, 1050, 5], [1470, 956, 8], [2560, 1440, 4], [1920, 1080, 4]],
  linux: [[1920, 1080, 20], [1366, 768, 6], [2560, 1440, 5], [1600, 900, 3], [1920, 1200, 3]],
};

export function screenPresets(os: FingerprintOs): Array<[number, number]> {
  return SCREENS[osFamily(os)].map(([w, h]) => [w, h]);
}

export const CPU_CHOICES = [2, 4, 6, 8, 12, 16, 20, 24] as const;
/** navigator.deviceMemory: Chrome reports at most 8 (bucketed 0.25 ... 8). */
export const MEMORY_CHOICES = [2, 4, 8] as const;

export const DEFAULT_PROTECTED_PORTS = '3389,5900,5800,7070,6568,5938,63333,5901,5902,5903,5950,5931,5939,6039,5944,6040,5279,2112';

/** Country (ISO 3166-1 alpha-2) -> primary UI language tag. Used for "auto" language from the proxy IP. */
export const COUNTRY_LANG: Record<string, string> = {
  PL: 'pl-PL', US: 'en-US', GB: 'en-GB', IE: 'en-IE', CA: 'en-CA', AU: 'en-AU', NZ: 'en-NZ', DE: 'de-DE', AT: 'de-AT', CH: 'de-CH',
  FR: 'fr-FR', BE: 'fr-BE', ES: 'es-ES', MX: 'es-MX', AR: 'es-AR', CO: 'es-CO', CL: 'es-CL', IT: 'it-IT', PT: 'pt-PT', BR: 'pt-BR',
  NL: 'nl-NL', SE: 'sv-SE', NO: 'nb-NO', DK: 'da-DK', FI: 'fi-FI', CZ: 'cs-CZ', SK: 'sk-SK', HU: 'hu-HU', RO: 'ro-RO', BG: 'bg-BG',
  GR: 'el-GR', TR: 'tr-TR', UA: 'uk-UA', RU: 'ru-RU', BY: 'ru-RU', KZ: 'ru-RU', LT: 'lt-LT', LV: 'lv-LV', EE: 'et-EE', HR: 'hr-HR',
  RS: 'sr-RS', SI: 'sl-SI', JP: 'ja-JP', KR: 'ko-KR', CN: 'zh-CN', TW: 'zh-TW', HK: 'zh-HK', IN: 'en-IN', ID: 'id-ID', TH: 'th-TH',
  VN: 'vi-VN', PH: 'en-PH', MY: 'ms-MY', SG: 'en-SG', IL: 'he-IL', SA: 'ar-SA', AE: 'ar-AE', EG: 'ar-EG', ZA: 'en-ZA', NG: 'en-NG',
};

/** Languages offered in the UI (manual language). */
export const LANGUAGE_CHOICES: string[] = [...new Set(['en-US', 'en-GB', ...Object.values(COUNTRY_LANG)])];

/** Accept-Language / navigator.languages for a primary tag, the way Chrome builds it. */
export function languageList(primary: string): string[] {
  const tag = /^[a-z]{2,3}(-[A-Z]{2})?$/.test(primary) ? primary : 'en-US';
  const base = tag.split('-')[0];
  const out = [tag];
  if (base !== tag) out.push(base);
  if (base !== 'en') out.push('en-US', 'en');
  return [...new Set(out)];
}

export function acceptLanguageHeader(primary: string): string {
  return languageList(primary).map((l, i) => (i === 0 ? l : `${l};q=${Math.max(0.1, 1 - i * 0.1).toFixed(1)}`)).join(',');
}

// ------------------------------------------------------------- helpers --

function osFamily(os: FingerprintOs): 'win' | 'mac' | 'linux' {
  return os === 'macos' ? 'mac' : os === 'linux' ? 'linux' : 'win';
}

/** Deterministic PRNG (mulberry32) so a seed reproduces the same fingerprint in tests. */
export function prng(seed: string): () => number {
  let a = parseInt(crypto.createHash('sha256').update(seed).digest('hex').slice(0, 8), 16) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function weighted<T>(rnd: () => number, items: Array<{ item: T; weight: number }>): T {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let r = rnd() * total;
  for (const i of items) {
    r -= i.weight;
    if (r <= 0) return i.item;
  }
  return items[items.length - 1].item;
}

export function userAgentFor(os: FingerprintOs, major: number): string {
  const platform = os === 'macos' ? 'Macintosh; Intel Mac OS X 10_15_7' : os === 'linux' ? 'X11; Linux x86_64' : 'Windows NT 10.0; Win64; x64';
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

/** Parse the Chrome major version out of a UA string (0 if not Chrome-like). */
export function uaMajor(ua: string): number {
  const m = /Chrome\/(\d+)\./.exec(ua);
  return m ? Number(m[1]) : 0;
}

/** OS implied by a user-agent string (for validation of manual user agents). */
export function osFromUserAgent(ua: string): 'win' | 'mac' | 'linux' | 'other' {
  if (/Windows NT/.test(ua)) return 'win';
  if (/Macintosh|Mac OS X/.test(ua)) return 'mac';
  if (/X11; Linux|Linux x86_64/.test(ua) && !/Android/.test(ua)) return 'linux';
  return 'other';
}

function platformVersionFor(os: FingerprintOs, rnd: () => number): string {
  switch (os) {
    case 'windows11': return rnd() < 0.55 ? '15.0.0' : '19.0.0';
    case 'windows10': return '10.0.0';
    case 'macos': return ['13.6.7', '14.6.1', '14.7.0', '15.3.2', '15.5.0'][Math.floor(rnd() * 5)];
    default: return ['6.5.0', '6.8.0', '6.11.0'][Math.floor(rnd() * 3)];
  }
}

/** Chrome's GREASE brand for a major version (same algorithm as Chromium's user_agent_utils). */
export function greaseBrand(major: number): { brand: string; version: string } {
  const chars = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_'];
  const versions = ['8', '99', '24'];
  return { brand: `Not${chars[major % chars.length]}A${chars[(major + 1) % chars.length]}Brand`, version: versions[major % versions.length] };
}

/** navigator.userAgentData.brands in Chrome's order for that major version. */
export function brandList(major: number, fullVersion?: string): Array<{ brand: string; version: string }> {
  const g = greaseBrand(major);
  const v = fullVersion ?? String(major);
  const grease = { brand: g.brand, version: fullVersion ? `${g.version}.0.0.0` : g.version };
  const chromium = { brand: 'Chromium', version: v };
  const chrome = { brand: 'Google Chrome', version: v };
  const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  const order = orders[major % 6];
  const out: Array<{ brand: string; version: string }> = [];
  out[order[0]] = grease;
  out[order[1]] = chromium;
  out[order[2]] = chrome;
  return out;
}

export function secChUa(list: Array<{ brand: string; version: string }>): string {
  return list.map((b) => `"${b.brand}";v="${b.version}"`).join(', ');
}

export function navigatorPlatform(os: FingerprintOs): string {
  return os === 'macos' ? 'MacIntel' : os === 'linux' ? 'Linux x86_64' : 'Win32';
}

/** UA-CH platform name ("Windows" / "macOS" / "Linux"). */
export function chPlatform(os: FingerprintOs): string {
  return os === 'macos' ? 'macOS' : os === 'linux' ? 'Linux' : 'Windows';
}

export function newSeed(): string {
  return crypto.randomBytes(8).toString('hex');
}

function defaultCores(os: FingerprintOs, tier: GpuPreset['tier'], rnd: () => number): number {
  if (os === 'macos') return tier === 'high' ? (rnd() < 0.5 ? 10 : 12) : 8;
  const pool = tier === 'low' ? [4, 4, 8] : tier === 'mid' ? [4, 6, 8, 8, 12] : [8, 12, 12, 16, 16, 20];
  return pool[Math.floor(rnd() * pool.length)];
}

// ------------------------------------------------------------ generate --

export interface GenerateOptions {
  os?: FingerprintOs;
  /** Chrome major version of the engine (process.versions.chrome). */
  engineMajor: number;
  /** Full engine version (e.g. "150.0.7312.58"); used for UA-CH full versions. */
  engineFullVersion?: string;
  seed?: string;
}

/**
 * Generate a complete, internally consistent fingerprint. Deterministic for a
 * given seed + options (unit tests), random otherwise.
 */
export function generateFingerprint(opts: GenerateOptions): FingerprintConfig {
  const seed = opts.seed ?? newSeed();
  const rnd = prng(seed);
  const os: FingerprintOs = opts.os ?? weighted(rnd, [
    { item: 'windows11' as FingerprintOs, weight: 45 }, { item: 'windows10' as FingerprintOs, weight: 35 },
    { item: 'macos' as FingerprintOs, weight: 17 }, { item: 'linux' as FingerprintOs, weight: 3 },
  ]);
  const major = opts.engineMajor > 0 ? opts.engineMajor : 140;
  const full = opts.engineFullVersion && opts.engineFullVersion.startsWith(`${major}.`) ? opts.engineFullVersion : `${major}.0.${6800 + Math.floor(rnd() * 900)}.${Math.floor(rnd() * 200)}`;
  const gpu = weighted(rnd, gpuPresets(os).map((g) => ({ item: g, weight: g.weight })));
  const [sw, sh] = weighted(rnd, SCREENS[osFamily(os)].map(([w, h, wt]) => ({ item: [w, h] as [number, number], weight: wt })));
  const cores = defaultCores(os, gpu.tier, rnd);
  const memory = os === 'macos' || gpu.tier !== 'low' ? 8 : rnd() < 0.5 ? 4 : 8;
  return {
    enabled: true,
    os,
    userAgent: userAgentFor(os, major),
    uaFullVersion: full,
    platformVersion: platformVersionFor(os, rnd),
    webrtc: { mode: 'altered', publicIp: '' },
    canvas: 'noise',
    webgl: 'noise',
    webglInfo: { mode: 'manual', vendor: gpu.vendor, renderer: gpu.renderer },
    webgpu: 'real',
    clientRects: 'noise',
    timezone: { mode: 'auto', value: '' },
    language: { mode: 'auto', value: '' },
    geolocation: { mode: 'auto', latitude: 0, longitude: 0, accuracy: 10 },
    cpu: { mode: 'manual', cores },
    memory: { mode: 'manual', gb: memory },
    screen: { mode: 'manual', width: sw, height: sh },
    fonts: 'noise',
    audio: 'noise',
    mediaDevices: { mode: 'manual', audioInputs: 1, audioOutputs: 1, videoInputs: os === 'macos' || rnd() < 0.5 ? 1 : 0 },
    ports: { mode: 'protect', list: DEFAULT_PROTECTED_PORTS },
    doNotTrack: false,
    seed,
  };
}

/** Fingerprint of a profile that behaves exactly like the engine (antidetect off). */
export function realFingerprint(engineMajor: number): FingerprintConfig {
  const fp = generateFingerprint({ engineMajor, os: 'windows10', seed: 'real' });
  return {
    ...fp,
    enabled: false,
    webrtc: { mode: 'real', publicIp: '' },
    canvas: 'real', webgl: 'real', webglInfo: { mode: 'real', vendor: '', renderer: '' }, clientRects: 'real',
    timezone: { mode: 'real', value: '' }, language: { mode: 'real', value: '' },
    geolocation: { mode: 'auto', latitude: 0, longitude: 0, accuracy: 10 },
    cpu: { mode: 'real', cores: 8 }, memory: { mode: 'real', gb: 8 }, screen: { mode: 'real', width: 1920, height: 1080 },
    fonts: 'real', audio: 'real', mediaDevices: { mode: 'real', audioInputs: 1, audioOutputs: 1, videoInputs: 1 },
    ports: { mode: 'real', list: DEFAULT_PROTECTED_PORTS },
  };
}

// ------------------------------------------------------------ sanitize --

const oneOf = <T extends string>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d);
const num = (v: unknown, min: number, max: number, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : d;
};
const str = (v: unknown, max: number, d = '') => (typeof v === 'string' ? v.replace(/[\r\n\0]/g, '').slice(0, max) : d);

/** Validate a stored/received fingerprint; anything invalid falls back to `base`. */
export function sanitizeFingerprint(input: unknown, base: FingerprintConfig): FingerprintConfig {
  const v = (input && typeof input === 'object' ? input : {}) as Partial<FingerprintConfig>;
  const os = oneOf(v.os, FP_OSES, base.os);
  const ua = str(v.userAgent, 512, base.userAgent).trim() || base.userAgent;
  const tz = str(v.timezone?.value, 64);
  return {
    enabled: typeof v.enabled === 'boolean' ? v.enabled : base.enabled,
    os,
    userAgent: ua,
    uaFullVersion: /^\d+\.\d+\.\d+\.\d+$/.test(str(v.uaFullVersion, 32)) ? str(v.uaFullVersion, 32) : base.uaFullVersion,
    platformVersion: /^\d+\.\d+\.\d+$/.test(str(v.platformVersion, 32)) ? str(v.platformVersion, 32) : base.platformVersion,
    webrtc: {
      mode: oneOf(v.webrtc?.mode, ['off', 'real', 'disable-udp', 'altered', 'manual'] as const, base.webrtc.mode),
      publicIp: /^[0-9a-fA-F.:]{0,45}$/.test(str(v.webrtc?.publicIp, 45)) ? str(v.webrtc?.publicIp, 45) : '',
    },
    canvas: oneOf(v.canvas, ['off', 'real', 'noise'] as const, base.canvas),
    webgl: oneOf(v.webgl, ['off', 'real', 'noise'] as const, base.webgl),
    webglInfo: {
      mode: oneOf(v.webglInfo?.mode, ['real', 'manual'] as const, base.webglInfo.mode),
      vendor: str(v.webglInfo?.vendor, 128, base.webglInfo.vendor),
      renderer: str(v.webglInfo?.renderer, 256, base.webglInfo.renderer),
    },
    webgpu: oneOf(v.webgpu, ['off', 'real'] as const, base.webgpu),
    clientRects: oneOf(v.clientRects, ['real', 'noise'] as const, base.clientRects),
    timezone: {
      mode: oneOf(v.timezone?.mode, ['auto', 'manual', 'real'] as const, base.timezone.mode),
      value: /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$|^UTC$|^$/.test(tz) ? tz : '',
    },
    language: {
      mode: oneOf(v.language?.mode, ['auto', 'manual', 'real'] as const, base.language.mode),
      value: /^[a-z]{2,3}(-[A-Z]{2})?$|^$/.test(str(v.language?.value, 16)) ? str(v.language?.value, 16) : '',
    },
    geolocation: {
      mode: oneOf(v.geolocation?.mode, ['auto', 'manual', 'block'] as const, base.geolocation.mode),
      latitude: num(v.geolocation?.latitude, -90, 90, 0),
      longitude: num(v.geolocation?.longitude, -180, 180, 0),
      accuracy: num(v.geolocation?.accuracy, 1, 100000, 10),
    },
    cpu: { mode: oneOf(v.cpu?.mode, ['real', 'manual'] as const, base.cpu.mode), cores: Math.round(num(v.cpu?.cores, 1, 64, base.cpu.cores)) },
    memory: { mode: oneOf(v.memory?.mode, ['real', 'manual'] as const, base.memory.mode), gb: (MEMORY_CHOICES as readonly number[]).includes(Number(v.memory?.gb)) ? Number(v.memory?.gb) : base.memory.gb },
    screen: {
      mode: oneOf(v.screen?.mode, ['real', 'manual'] as const, base.screen.mode),
      width: Math.round(num(v.screen?.width, 640, 7680, base.screen.width)),
      height: Math.round(num(v.screen?.height, 480, 4320, base.screen.height)),
    },
    fonts: oneOf(v.fonts, ['real', 'noise'] as const, base.fonts),
    audio: oneOf(v.audio, ['real', 'noise'] as const, base.audio),
    mediaDevices: {
      mode: oneOf(v.mediaDevices?.mode, ['real', 'manual'] as const, base.mediaDevices.mode),
      audioInputs: Math.round(num(v.mediaDevices?.audioInputs, 0, 3, 1)),
      audioOutputs: Math.round(num(v.mediaDevices?.audioOutputs, 0, 3, 1)),
      videoInputs: Math.round(num(v.mediaDevices?.videoInputs, 0, 3, 1)),
    },
    ports: {
      mode: oneOf(v.ports?.mode, ['real', 'protect'] as const, base.ports.mode),
      list: /^[\d,\s]*$/.test(str(v.ports?.list, 1024)) ? str(v.ports?.list, 1024).replace(/\s+/g, '') : base.ports.list,
    },
    doNotTrack: typeof v.doNotTrack === 'boolean' ? v.doNotTrack : base.doNotTrack,
    seed: /^[0-9a-f]{4,64}$/.test(str(v.seed, 64)) ? str(v.seed, 64) : base.seed,
  };
}

/** Parse a comma separated port list into numbers (1..65535). */
export function parsePorts(list: string): number[] {
  return [...new Set(list.split(',').map((p) => Number(p.trim())).filter((p) => Number.isInteger(p) && p > 0 && p < 65536))];
}

// ------------------------------------------------------------ resolve --

/** Geo facts about the exit IP (from a proxy check), used for "auto" values. */
export interface GeoInfo {
  ip?: string;
  country?: string;
  countryCode?: string;
  region?: string;
  city?: string;
  timezone?: string;
  latitude?: number;
  longitude?: number;
}

/**
 * Values actually applied when the profile runs. "auto" is resolved from the
 * exit IP (proxy check) and falls back to the machine's real values when no
 * geo information is available.
 */
export interface ResolvedFingerprint {
  enabled: boolean;
  os: FingerprintOs;
  userAgent: string;
  major: number;
  platform: string;
  chPlatform: string;
  platformVersion: string;
  brands: Array<{ brand: string; version: string }>;
  fullVersionList: Array<{ brand: string; version: string }>;
  uaFullVersion: string;
  architecture: string;
  bitness: string;
  timezone: string | null;
  languages: string[] | null;
  acceptLanguage: string | null;
  geolocation: { latitude: number; longitude: number; accuracy: number } | null;
  geoBlocked: boolean;
  webrtcPolicy: 'default' | 'default_public_interface_only' | 'disable_non_proxied_udp';
  webrtcMode: WebRtcMode;
  webrtcIp: string;
  canvas: NoiseMode;
  webgl: NoiseMode;
  webglVendor: string | null;
  webglRenderer: string | null;
  webgpu: 'off' | 'real';
  clientRects: 'real' | 'noise';
  cores: number | null;
  memory: number | null;
  screen: { width: number; height: number; availWidth: number; availHeight: number } | null;
  fonts: 'real' | 'noise';
  audio: 'real' | 'noise';
  mediaDevices: { audioInputs: number; audioOutputs: number; videoInputs: number } | null;
  protectedPorts: number[];
  doNotTrack: boolean;
  seed: string;
}

export function resolveFingerprint(fp: FingerprintConfig, geo: GeoInfo | undefined, fallbackLang: string): ResolvedFingerprint {
  const major = uaMajor(fp.userAgent) || Number(fp.uaFullVersion.split('.')[0]) || 140;
  const full = fp.uaFullVersion.startsWith(`${major}.`) ? fp.uaFullVersion : `${major}.0.0.0`;
  const on = fp.enabled;
  const tz = !on || fp.timezone.mode === 'real' ? null : fp.timezone.mode === 'manual' ? fp.timezone.value || null : geo?.timezone || null;
  let lang: string | null = null;
  if (on && fp.language.mode === 'manual' && fp.language.value) lang = fp.language.value;
  else if (on && fp.language.mode === 'auto') lang = (geo?.countryCode && COUNTRY_LANG[geo.countryCode.toUpperCase()]) || fallbackLang;
  let geoPos: ResolvedFingerprint['geolocation'] = null;
  if (on && fp.geolocation.mode === 'manual') geoPos = { latitude: fp.geolocation.latitude, longitude: fp.geolocation.longitude, accuracy: fp.geolocation.accuracy };
  else if (on && fp.geolocation.mode === 'auto' && typeof geo?.latitude === 'number' && typeof geo?.longitude === 'number') {
    geoPos = { latitude: geo.latitude, longitude: geo.longitude, accuracy: fp.geolocation.accuracy || 10 };
  }
  const webrtcMode: WebRtcMode = on ? fp.webrtc.mode : 'real';
  const webrtcPolicy = webrtcMode === 'real' ? 'default_public_interface_only' : webrtcMode === 'off' ? 'disable_non_proxied_udp' : 'disable_non_proxied_udp';
  const osKey = osFamily(fp.os);
  const screen = on && fp.screen.mode === 'manual'
    ? { width: fp.screen.width, height: fp.screen.height, availWidth: fp.screen.width, availHeight: fp.screen.height - (osKey === 'win' ? 40 : osKey === 'mac' ? 25 : 27) }
    : null;
  const isAppleSilicon = fp.os === 'macos' && /Apple M\d/.test(fp.webglInfo.renderer);
  return {
    enabled: on,
    os: fp.os,
    userAgent: fp.userAgent,
    major,
    platform: navigatorPlatform(fp.os),
    chPlatform: chPlatform(fp.os),
    platformVersion: fp.platformVersion,
    brands: brandList(major),
    fullVersionList: brandList(major, full),
    uaFullVersion: full,
    architecture: isAppleSilicon ? 'arm' : 'x86',
    bitness: '64',
    timezone: tz,
    languages: lang ? languageList(lang) : null,
    acceptLanguage: lang ? acceptLanguageHeader(lang) : null,
    geolocation: geoPos,
    geoBlocked: on && fp.geolocation.mode === 'block',
    webrtcPolicy,
    webrtcMode,
    webrtcIp: webrtcMode === 'manual' ? fp.webrtc.publicIp : webrtcMode === 'altered' ? geo?.ip ?? '' : '',
    canvas: on ? fp.canvas : 'real',
    webgl: on ? fp.webgl : 'real',
    webglVendor: on && fp.webglInfo.mode === 'manual' && fp.webglInfo.vendor ? fp.webglInfo.vendor : null,
    webglRenderer: on && fp.webglInfo.mode === 'manual' && fp.webglInfo.renderer ? fp.webglInfo.renderer : null,
    webgpu: on ? fp.webgpu : 'real',
    clientRects: on ? fp.clientRects : 'real',
    cores: on && fp.cpu.mode === 'manual' ? fp.cpu.cores : null,
    memory: on && fp.memory.mode === 'manual' ? fp.memory.gb : null,
    screen,
    fonts: on ? fp.fonts : 'real',
    audio: on ? fp.audio : 'real',
    mediaDevices: on && fp.mediaDevices.mode === 'manual' ? { audioInputs: fp.mediaDevices.audioInputs, audioOutputs: fp.mediaDevices.audioOutputs, videoInputs: fp.mediaDevices.videoInputs } : null,
    protectedPorts: on && fp.ports.mode === 'protect' ? parsePorts(fp.ports.list) : [],
    doNotTrack: on && fp.doNotTrack,
    seed: fp.seed,
  };
}

/** Problems that would make a fingerprint look inconsistent (shown in the editor). */
export function fingerprintWarnings(fp: FingerprintConfig, engineMajor: number): string[] {
  const out: string[] = [];
  if (!fp.enabled) return out;
  const uaOs = osFromUserAgent(fp.userAgent);
  const fam = osFamily(fp.os);
  if (uaOs !== 'other' && uaOs !== fam) out.push('fp.warn.uaOs');
  if (engineMajor && uaMajor(fp.userAgent) && Math.abs(uaMajor(fp.userAgent) - engineMajor) > 2) out.push('fp.warn.uaVersion');
  if (fp.webglInfo.mode === 'manual') {
    const r = fp.webglInfo.renderer;
    if (fam === 'mac' && /Direct3D/.test(r)) out.push('fp.warn.gpuOs');
    if (fam === 'win' && /Metal|Apple M\d/.test(r)) out.push('fp.warn.gpuOs');
  }
  if (fp.os === 'macos' && fp.cpu.mode === 'manual' && fp.cpu.cores < 8) out.push('fp.warn.macCores');
  return out;
}
