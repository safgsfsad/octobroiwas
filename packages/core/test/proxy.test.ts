/** packages/core/test/proxy.test.ts - proxy format auto-detection, saved proxies, IP info normalisation. */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import {
  DataLayout, ProxyStore, chromiumRules, countryFlag, formatProxy, formatProxyFull, needsBridge, normalizeIpInfo, parseProxy, parseProxyList,
} from '../src';
import { tmpDir } from './helpers';

const ok = (input: string, def: 'http' | 'socks5' = 'http') => {
  const r = parseProxy(input, def);
  expect(r.ok, `${input} -> ${r.error}`).toBe(true);
  return r.proxy!;
};

describe('parseProxy auto-detection', () => {
  it.each([
    ['1.2.3.4:8080', { type: 'http', host: '1.2.3.4', port: 8080, username: '', password: '' }],
    ['proxy.example.com:3128:user:p@ss:word', { host: 'proxy.example.com', port: 3128, username: 'user', password: 'p@ss:word' }],
    ['user:pass@1.2.3.4:1080', { host: '1.2.3.4', port: 1080, username: 'user', password: 'pass' }],
    ['user:pass:gate.proxy.io:7777', { host: 'gate.proxy.io', port: 7777, username: 'user', password: 'pass' }],
    ['1.2.3.4:1080@user:pass', { host: '1.2.3.4', port: 1080, username: 'user', password: 'pass' }],
    ['socks5://u:p@1.2.3.4:1080', { type: 'socks5', host: '1.2.3.4', port: 1080, username: 'u', password: 'p' }],
    ['socks5h://host.example:1080', { type: 'socks5', host: 'host.example', port: 1080 }],
    ['socks4://1.2.3.4:4145', { type: 'socks4' }],
    ['https://u:p@secure.example:443/', { type: 'https', host: 'secure.example', port: 443 }],
    ['http://xv.qproxy.pro:80:46cdc4f04fe341dfb244e51046bda400-cc-PL-s-968dbc71d42b8a19-ttl-60:fcd205d4384ca206d304dc44159482b2', {
      type: 'http', host: 'xv.qproxy.pro', port: 80, username: '46cdc4f04fe341dfb244e51046bda400-cc-PL-s-968dbc71d42b8a19-ttl-60', password: 'fcd205d4384ca206d304dc44159482b2',
    }],
    ['[2001:db8::1]:1080', { host: '[2001:db8::1]', port: 1080 }],
    ['  Proxy.Example.COM:8000  ', { host: 'proxy.example.com', port: 8000 }],
  ])('%s', (input, expected) => {
    expect(ok(input)).toMatchObject(expected);
  });

  it('keeps the selected default type when there is no scheme', () => {
    expect(ok('1.2.3.4:1080', 'socks5').type).toBe('socks5');
  });

  it('extracts a change-IP URL', () => {
    expect(ok('1.2.3.4:80:u:p [https://rotate.example/change?key=1]').changeIpUrl).toBe('https://rotate.example/change?key=1');
    expect(ok('socks5://1.2.3.4:80 | https://rotate.example/x').changeIpUrl).toBe('https://rotate.example/x');
  });

  it.each([
    ['', 'proxy.err.empty'], ['justtext', 'proxy.err.format'], ['1.2.3.4:99999', 'proxy.err.port'],
    ['ftp://1.2.3.4:21', 'proxy.err.scheme'], ['999.1.1.1:80', 'proxy.err.host'], ['bad_host!:80', 'proxy.err.host'],
  ])('rejects %j', (input, err) => {
    const r = parseProxy(input);
    expect(r.ok).toBe(false);
    expect(r.error).toBe(err);
  });

  it('parses mass-import lists and reports bad lines', () => {
    const list = parseProxyList('# comment\n1.2.3.4:80\n\nnope\nsocks5://a:b@5.6.7.8:1080\n');
    expect(list.map((l) => [l.line, l.ok])).toEqual([[2, true], [4, false], [5, true]]);
  });
});

describe('formatting', () => {
  const p = { type: 'socks5' as const, host: 'h.example', port: 1080, username: 'u', password: 'p w', changeIpUrl: '' };
  it('never includes the password in display strings or Chromium rules', () => {
    expect(formatProxy(p)).toBe('socks5://u@h.example:1080');
    expect(chromiumRules(p)).toBe('socks5://h.example:1080');
    expect(formatProxyFull(p)).toBe('socks5://u:p%20w@h.example:1080');
  });
  it('needs the local bridge only for authenticated SOCKS', () => {
    expect(needsBridge(p)).toBe(true);
    expect(needsBridge({ ...p, username: '', password: '' })).toBe(false);
    expect(needsBridge({ ...p, type: 'http' })).toBe(false);
  });
  it('flags', () => {
    expect(countryFlag('pl')).toBe('🇵🇱');
    expect(countryFlag('')).toBe('');
  });
});

describe('normalizeIpInfo', () => {
  it('understands ipwho.is', () => {
    const r = normalizeIpInfo({ success: true, ip: '109.243.144.229', country: 'Poland', country_code: 'PL', region: 'Mazovia', city: 'Warsaw', latitude: 52.2, longitude: 21.0, timezone: { id: 'Europe/Warsaw' } }, 120);
    expect(r).toMatchObject({ ok: true, ip: '109.243.144.229', countryCode: 'PL', city: 'Warsaw', timezone: 'Europe/Warsaw', latencyMs: 120 });
  });
  it('understands ip-api.com', () => {
    const r = normalizeIpInfo({ status: 'success', query: '1.1.1.1', country: 'Australia', countryCode: 'AU', regionName: 'Queensland', city: 'Brisbane', lat: -27.4, lon: 153, timezone: 'Australia/Brisbane' }, 5);
    expect(r).toMatchObject({ ok: true, ip: '1.1.1.1', countryCode: 'AU', region: 'Queensland', timezone: 'Australia/Brisbane', latitude: -27.4 });
  });
  it('reports failures', () => {
    expect(normalizeIpInfo({ success: false, message: 'reserved range' }, 1)).toMatchObject({ ok: false, error: 'reserved range' });
  });
});

describe('ProxyStore', () => {
  it('stores metadata in JSON and credentials only in the secret store', () => {
    const layout = new DataLayout(path.join(tmpDir(), 'OctoBrowser'));
    layout.ensure();
    const secrets = new Map<string, string>();
    const api = {
      get: (k: string) => secrets.get(k), has: (k: string) => secrets.has(k), set: (k: string, v: string) => { secrets.set(k, v); },
      delete: (k: string) => { secrets.delete(k); }, deletePrefix: () => undefined, backend: () => 'local' as const, ids: () => [...secrets.keys()],
    };
    const store = new ProxyStore(layout, api);
    const saved = store.add(parseProxy('socks5://alice:s3cret@1.2.3.4:1080').proxy!, 'PL');
    expect(saved.hasCredentials).toBe(true);
    const json = require('node:fs').readFileSync(path.join(layout.config, 'proxies.json'), 'utf8');
    expect(json).not.toContain('s3cret');
    expect(store.resolve(saved.id)).toMatchObject({ username: 'alice', password: 's3cret', host: '1.2.3.4' });
    // duplicate endpoint -> same entry
    expect(store.add(parseProxy('socks5://alice:new@1.2.3.4:1080').proxy!).id).toBe(saved.id);
    expect(store.resolve(saved.id).password).toBe('new');
    store.update(saved.id, { name: 'Renamed' });
    expect(store.get(saved.id).name).toBe('Renamed');
    store.remove(saved.id);
    expect(store.list()).toEqual([]);
    expect(secrets.size).toBe(0);
  });
});
