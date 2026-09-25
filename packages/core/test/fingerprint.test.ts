/** packages/core/test/fingerprint.test.ts - fingerprint generation, consistency, sanitising, resolving. */
import { describe, expect, it } from 'vitest';
import {
  FP_OSES, brandList, generateFingerprint, greaseBrand, gpuPresets, languageList, acceptLanguageHeader, osFromUserAgent,
  realFingerprint, resolveFingerprint, sanitizeFingerprint, secChUa, uaMajor, fingerprintWarnings, parsePorts,
  defaultProfile, sanitizeProfile, setEngineVersion, engineVersion,
} from '../src';

describe('fingerprint generation', () => {
  it('is deterministic for a seed and random without one', () => {
    const a = generateFingerprint({ engineMajor: 150, seed: 'abc123' });
    const b = generateFingerprint({ engineMajor: 150, seed: 'abc123' });
    expect(a).toEqual(b);
    const seen = new Set(Array.from({ length: 20 }, () => JSON.stringify(generateFingerprint({ engineMajor: 150 }))));
    expect(seen.size).toBe(20);
  });

  it('keeps the Chrome major version equal to the engine version', () => {
    for (let i = 0; i < 50; i++) {
      const fp = generateFingerprint({ engineMajor: 147, engineFullVersion: '147.0.7400.12' });
      expect(uaMajor(fp.userAgent)).toBe(147);
      expect(fp.uaFullVersion).toBe('147.0.7400.12');
    }
  });

  it('produces OS-consistent UA, GPU, cores and memory for every OS', () => {
    for (const os of FP_OSES) {
      for (let i = 0; i < 40; i++) {
        const fp = generateFingerprint({ engineMajor: 150, os });
        expect(fp.os).toBe(os);
        const fam = osFromUserAgent(fp.userAgent);
        expect(fam).toBe(os === 'macos' ? 'mac' : os === 'linux' ? 'linux' : 'win');
        expect(gpuPresets(os).some((g) => g.renderer === fp.webglInfo.renderer && g.vendor === fp.webglInfo.vendor)).toBe(true);
        expect([2, 4, 8]).toContain(fp.memory.gb);
        if (os === 'macos') expect(fp.cpu.cores).toBeGreaterThanOrEqual(8);
        expect(fingerprintWarnings(fp, 150)).toEqual([]);
      }
    }
  });

  it('never puts D3D renderers on macOS or Metal on Windows', () => {
    for (const g of gpuPresets('macos')) expect(g.renderer).not.toMatch(/Direct3D/);
    for (const g of gpuPresets('windows11')) expect(g.renderer).not.toMatch(/Metal|Apple/);
    expect(gpuPresets('windows10')).toBe(gpuPresets('windows11'));
  });

  it('distributes the OS roughly like real desktop traffic', () => {
    const count: Record<string, number> = {};
    for (let i = 0; i < 2000; i++) {
      const os = generateFingerprint({ engineMajor: 150, seed: `s${i}` }).os;
      count[os] = (count[os] ?? 0) + 1;
    }
    expect(count.windows11 + count.windows10).toBeGreaterThan(1400);
    expect(count.macos).toBeGreaterThan(200);
  });
});

describe('client hints', () => {
  it('matches Chromium GREASE brands (verified against real Chrome 120 and 153)', () => {
    expect(greaseBrand(120)).toEqual({ brand: 'Not_A Brand', version: '8' });
    expect(brandList(120)).toEqual([
      { brand: 'Not_A Brand', version: '8' }, { brand: 'Chromium', version: '120' }, { brand: 'Google Chrome', version: '120' },
    ]);
    // Chrome 153: order [2,0,1] => Google Chrome, grease, Chromium
    expect(brandList(153).map((b) => b.brand)).toEqual(['Google Chrome', 'Not_A Brand', 'Chromium']);
    expect(brandList(153, '153.0.8010.0')[1]).toEqual({ brand: 'Not_A Brand', version: '8.0.0.0' });
    expect(secChUa(brandList(120))).toBe('"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"');
  });
});

describe('languages', () => {
  it('builds Chrome-like language lists and Accept-Language', () => {
    expect(languageList('pl-PL')).toEqual(['pl-PL', 'pl', 'en-US', 'en']);
    expect(languageList('en-GB')).toEqual(['en-GB', 'en']);
    expect(acceptLanguageHeader('de-DE')).toBe('de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7');
    expect(languageList('bogus')).toEqual(['en-US', 'en']);
  });
});

describe('sanitize + resolve', () => {
  const base = generateFingerprint({ engineMajor: 150, seed: 'base' });

  it('rejects invalid values and keeps valid ones', () => {
    const s = sanitizeFingerprint({
      os: 'amiga', canvas: 'weird', cpu: { mode: 'manual', cores: 999 }, memory: { mode: 'manual', gb: 16 },
      timezone: { mode: 'manual', value: '../../etc' }, language: { mode: 'manual', value: 'de-DE' },
      ports: { mode: 'protect', list: '1,2;rm -rf' }, webrtc: { mode: 'manual', publicIp: '1.2.3.4' }, seed: 'ZZZ',
      userAgent: 'x\nInjected: 1',
    }, base);
    expect(s.os).toBe(base.os);
    expect(s.canvas).toBe(base.canvas);
    expect(s.cpu.cores).toBe(64);
    expect(s.memory.gb).toBe(base.memory.gb); // 16 is not reportable by Chrome
    expect(s.timezone.value).toBe('');
    expect(s.language.value).toBe('de-DE');
    expect(s.ports.list).toBe(base.ports.list);
    expect(s.webrtc.publicIp).toBe('1.2.3.4');
    expect(s.seed).toBe(base.seed);
    expect(s.userAgent).not.toMatch(/\n/);
  });

  it('resolves auto timezone/language/geo from the proxy exit IP', () => {
    const r = resolveFingerprint(base, { ip: '5.6.7.8', countryCode: 'DE', timezone: 'Europe/Berlin', latitude: 52.5, longitude: 13.4 }, 'en-US');
    expect(r.timezone).toBe('Europe/Berlin');
    expect(r.languages).toEqual(['de-DE', 'de', 'en-US', 'en']);
    expect(r.geolocation).toMatchObject({ latitude: 52.5, longitude: 13.4 });
    expect(r.webrtcIp).toBe('5.6.7.8'); // altered => proxy IP
    expect(r.webrtcPolicy).toBe('disable_non_proxied_udp');
    expect(r.brands.some((b) => b.brand === 'Google Chrome')).toBe(true);
  });

  it('falls back to the app language when no geo information exists', () => {
    const r = resolveFingerprint(base, undefined, 'pl-PL');
    expect(r.timezone).toBeNull();
    expect(r.languages?.[0]).toBe('pl-PL');
    expect(r.geolocation).toBeNull();
  });

  it('reports real values when the fingerprint is disabled', () => {
    const r = resolveFingerprint(realFingerprint(150), { timezone: 'Asia/Tokyo', countryCode: 'JP' }, 'en-US');
    expect(r.enabled).toBe(false);
    expect(r.timezone).toBeNull();
    expect(r.languages).toBeNull();
    expect(r.canvas).toBe('real');
    expect(r.webglRenderer).toBeNull();
    expect(r.cores).toBeNull();
    expect(r.protectedPorts).toEqual([]);
  });

  it('warns about inconsistent manual edits', () => {
    const fp = { ...base, os: 'macos' as const, userAgent: base.userAgent.replace(/\(.*?\)/, '(Windows NT 10.0; Win64; x64)'), webglInfo: { mode: 'manual' as const, vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, X Direct3D11 vs_5_0 ps_5_0, D3D11)' }, cpu: { mode: 'manual' as const, cores: 2 } };
    expect(fingerprintWarnings(fp, 150).sort()).toEqual(['fp.warn.gpuOs', 'fp.warn.macCores', 'fp.warn.uaOs']);
  });

  it('parses port lists', () => {
    expect(parsePorts('3389, 5900,abc,0,70000,5900')).toEqual([3389, 5900]);
  });
});

describe('profiles carry a fingerprint', () => {
  it('antidetect profiles spoof, privacy presets do not', () => {
    setEngineVersion('149.0.7300.5');
    expect(engineVersion().major).toBe(149);
    const a = defaultProfile('antidetect', 'A');
    expect(a.fingerprint.enabled).toBe(true);
    expect(uaMajor(a.fingerprint.userAgent)).toBe(149);
    expect(a.protection.level).toBe('normal');
    expect(defaultProfile('personal', 'P').fingerprint.enabled).toBe(false);
  });

  it('a stored profile without fingerprint gets the same one on every load', () => {
    const raw = { id: 'p-abcdef123456', kind: 'antidetect', name: 'Old' };
    const a = sanitizeProfile(raw);
    const b = sanitizeProfile(raw);
    expect(a.fingerprint).toEqual(b.fingerprint);
    expect(a.fingerprint.enabled).toBe(true);
  });

  it('sanitises tags, notes, start pages and structured proxy', () => {
    const p = sanitizeProfile({
      id: 'p-abcdef123457', kind: 'antidetect', name: 'X', tags: ['a', 'a', ' b ', 5, ''], folder: 'Klienci', notes: 'n',
      startPages: ['https://example.com', 'javascript:alert(1)', 'octo://newtab'],
      network: { mode: 'proxy', proxy: { type: 'socks5', host: 'Proxy.Example.com', port: 1080, changeIpUrl: 'https://x.y/rotate', name: 'PL', savedId: '' } },
    });
    expect(p.tags).toEqual(['a', 'b']);
    expect(p.startPages).toEqual(['https://example.com', 'octo://newtab']);
    expect(p.network.proxy?.host).toBe('proxy.example.com');
    expect(p.network.proxyRules).toBe('socks5://proxy.example.com:1080');
  });
});
