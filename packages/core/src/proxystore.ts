/**
 * packages/core/src/proxystore.ts
 *
 * Saved proxies (Proxies page, "Saved proxy" in the profile editor, local API).
 * Metadata lives in config/proxies.json (VersionedStore, backup before every
 * change); usernames/passwords live ONLY in the encrypted SecretStore under
 * "sproxy:<id>".
 */
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { VersionedStore } from './config';
import { DataLayout } from './paths';
import { PROXY_TYPES, ParsedProxy, ProxyCheckResult, ProxyType, SavedProxy, isValidHost } from './proxy';
import type { SecretStoreApi } from './secretstore';

interface ProxiesDoc { schema: 1; proxies: SavedProxy[] }

function sanitize(v: unknown): SavedProxy | null {
  const p = v as Partial<SavedProxy>;
  if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !/^[a-z0-9-]{3,64}$/.test(p.id)) return null;
  if (!PROXY_TYPES.includes(p.type as ProxyType) || typeof p.host !== 'string' || !isValidHost(p.host)) return null;
  const port = Number(p.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return {
    id: p.id,
    name: typeof p.name === 'string' ? p.name.slice(0, 64) : '',
    type: p.type as ProxyType,
    host: p.host,
    port,
    hasCredentials: !!p.hasCredentials,
    changeIpUrl: typeof p.changeIpUrl === 'string' && /^https?:\/\/\S+$/.test(p.changeIpUrl) ? p.changeIpUrl.slice(0, 2000) : '',
    createdAt: typeof p.createdAt === 'string' ? p.createdAt : new Date().toISOString(),
    lastCheck: p.lastCheck && typeof p.lastCheck === 'object' ? p.lastCheck : undefined,
  };
}

function validate(v: unknown): ProxiesDoc {
  const d = v as Partial<ProxiesDoc>;
  if (!d || d.schema !== 1 || !Array.isArray(d.proxies)) throw new Error('Invalid proxies document');
  return { schema: 1, proxies: d.proxies.map(sanitize).filter((x): x is SavedProxy => !!x) };
}

export class ProxyStore {
  readonly store: VersionedStore<ProxiesDoc>;

  constructor(layout: DataLayout, private readonly secrets?: SecretStoreApi) {
    this.store = new VersionedStore<ProxiesDoc>(path.join(layout.config, 'proxies.json'), {
      backupDir: path.join(layout.backups, 'config'),
      defaults: () => ({ schema: 1, proxies: [] }),
      validate,
      maxBackups: 10,
    });
  }

  list(): SavedProxy[] {
    return this.store.load().proxies;
  }

  get(id: string): SavedProxy {
    const p = this.list().find((x) => x.id === id);
    if (!p) throw new Error(`Proxy not found: ${id}`);
    return p;
  }

  /** Full proxy incl. credentials (for applying to a profile / checking). */
  resolve(id: string): ParsedProxy {
    const p = this.get(id);
    const creds = this.credentials(id);
    return { type: p.type, host: p.host, port: p.port, username: creds.username, password: creds.password, changeIpUrl: p.changeIpUrl };
  }

  credentials(id: string): { username: string; password: string } {
    try {
      const raw = this.secrets?.get(`sproxy:${id}`);
      if (raw) return JSON.parse(raw) as { username: string; password: string };
    } catch { /* damaged entry */ }
    return { username: '', password: '' };
  }

  add(p: ParsedProxy, name = ''): SavedProxy {
    // Same endpoint + user already saved -> return it instead of a duplicate.
    const dup = this.list().find((x) => x.type === p.type && x.host === p.host && x.port === p.port && this.credentials(x.id).username === p.username);
    if (dup) {
      if (p.password) this.secrets?.set(`sproxy:${dup.id}`, JSON.stringify({ username: p.username, password: p.password }));
      return dup;
    }
    const item: SavedProxy = {
      id: `x-${crypto.randomBytes(6).toString('hex')}`,
      name: name.slice(0, 64),
      type: p.type,
      host: p.host,
      port: p.port,
      hasCredentials: !!(p.username || p.password),
      changeIpUrl: p.changeIpUrl,
      createdAt: new Date().toISOString(),
    };
    if (item.hasCredentials) this.secrets?.set(`sproxy:${item.id}`, JSON.stringify({ username: p.username, password: p.password }));
    this.store.update((d) => { d.proxies.push(item); });
    return item;
  }

  update(id: string, patch: { name?: string; changeIpUrl?: string; lastCheck?: ProxyCheckResult }): SavedProxy {
    let out: SavedProxy | undefined;
    this.store.update((d) => {
      const i = d.proxies.findIndex((x) => x.id === id);
      if (i < 0) throw new Error(`Proxy not found: ${id}`);
      const merged = sanitize({ ...d.proxies[i], ...patch });
      if (!merged) throw new Error('Invalid proxy');
      d.proxies[i] = merged;
      out = merged;
    });
    return out!;
  }

  remove(id: string): void {
    this.store.update((d) => { d.proxies = d.proxies.filter((x) => x.id !== id); });
    this.secrets?.delete(`sproxy:${id}`);
  }
}
