/**
 * packages/core/src/settings.ts
 *
 * Application-wide settings (config/settings.json). Contains no secrets.
 * Stored with VersionedStore => automatic backup before every change.
 */
import * as path from 'node:path';
import { VersionedStore } from './config';
import { DataLayout } from './paths';
import { DEFAULT_UPDATE_SETTINGS, UpdateSettings } from './updater';
import type { LogMode } from './logger';

export type DohProvider = 'quad9' | 'cloudflare' | 'mullvad' | 'custom';

/**
 * Search engine used when the address bar gets words instead of a URL.
 * All of them are privacy-respecting and none of them offers network suggestions.
 */
export type SearchEngine = 'duckduckgo' | 'startpage' | 'brave' | 'mojeek';

export const SEARCH_ENGINES: Record<SearchEngine, string> = {
  duckduckgo: 'https://duckduckgo.com/?q=',
  startpage: 'https://www.startpage.com/sp/search?query=',
  brave: 'https://search.brave.com/search?q=',
  mojeek: 'https://www.mojeek.com/search?q=',
};

export function searchEngineQueryUrl(engine: SearchEngine, query: string): string {
  const base = SEARCH_ENGINES[engine] ?? SEARCH_ENGINES.duckduckgo;
  return `${base}${encodeURIComponent(query)}`;
}

export const DOH_TEMPLATES: Record<Exclude<DohProvider, 'custom'>, string> = {
  quad9: 'https://dns.quad9.net/dns-query',
  cloudflare: 'https://cloudflare-dns.com/dns-query',
  mullvad: 'https://dns.mullvad.net/dns-query',
};

export interface AppSettings {
  schema: 1;
  updates: UpdateSettings;
  network: {
    /** Consent for contacting an external service to show the public IP. Default OFF. */
    publicIpLookup: boolean;
    /** Refresh the traffic panel every 60 s. */
    autoRefresh: boolean;
    /** App-wide DNS (Chromium limitation: one resolver config per process). */
    dns: { mode: 'system' | 'doh'; provider: DohProvider; customTemplate: string };
    /** Search engine for words typed into the address bar. */
    searchEngine: SearchEngine;
  };
  security: {
    /** Lock encrypted profiles and the master-password keyring after N minutes idle (0 = never). */
    autoLockMinutes: number;
    /**
     * Where small secrets (proxy credentials) are kept:
     *  'local'    - config/secrets.bin, encrypted with the local key (default);
     *  'credman'  - Windows Credential Manager (per Windows user, not in backups).
     */
    secretStore: 'local' | 'credman';
  };
  logs: { mode: LogMode };
  ui: {
    verticalTabs: boolean;
    /** Put background tabs to sleep after N minutes (0 = never). */
    sleepTabsAfterMin: number;
    showStartupSplash: boolean;
    /** Show a bookmark bar under the address bar. */
    showBookmarksBar: boolean;
    /** Ask before a browser window closes (the session can then be saved). */
    confirmOnQuit: boolean;
    /** Open links from bookmarks / history in a background tab. */
    openLinksInBackground: boolean;
  };
  tor: {
    /** Path to the official Tor Browser firefox.exe (auto-detected when empty). */
    torBrowserPath: string;
  };
  offline: boolean;
  /**
   * Local automation REST API of the profile manager (127.0.0.1 only, Bearer
   * token kept in the encrypted secret store). Off by default.
   */
  api: { enabled: boolean; port: number };
  filtersUpdatedAt?: string;
}

export function defaultSettings(): AppSettings {
  return {
    schema: 1,
    updates: { ...DEFAULT_UPDATE_SETTINGS },
    network: { publicIpLookup: false, autoRefresh: false, dns: { mode: 'system', provider: 'quad9', customTemplate: '' }, searchEngine: 'duckduckgo' },
    security: { autoLockMinutes: 15, secretStore: 'local' },
    logs: { mode: 'standard' },
    ui: { verticalTabs: false, sleepTabsAfterMin: 30, showStartupSplash: true, showBookmarksBar: false, confirmOnQuit: true, openLinksInBackground: false },
    tor: { torBrowserPath: '' },
    offline: false,
    api: { enabled: false, port: 35555 },
  };
}

function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dflt;
}

export function validateSettings(value: unknown): AppSettings {
  const d = defaultSettings();
  const v = (value ?? {}) as Partial<AppSettings>;
  if (v.schema !== 1) throw new Error('Invalid settings schema');
  const dns = { ...d.network.dns, ...(v.network?.dns ?? {}) };
  if (!['system', 'doh'].includes(dns.mode)) dns.mode = 'system';
  if (!['quad9', 'cloudflare', 'mullvad', 'custom'].includes(dns.provider)) dns.provider = 'quad9';
  const engine: SearchEngine = ['duckduckgo', 'startpage', 'brave', 'mojeek'].includes(v.network?.searchEngine as string)
    ? (v.network!.searchEngine as SearchEngine)
    : 'duckduckgo';
  if (dns.customTemplate && !/^https:\/\/[^\s]+$/.test(dns.customTemplate)) dns.customTemplate = '';
  return {
    schema: 1,
    updates: {
      autoCheck: v.updates?.autoCheck ?? d.updates.autoCheck,
      backgroundCheck: v.updates?.backgroundCheck ?? d.updates.backgroundCheck,
      channel: v.updates?.channel === 'beta' ? 'beta' : 'stable',
    },
    network: {
      publicIpLookup: !!(v.network?.publicIpLookup ?? d.network.publicIpLookup),
      autoRefresh: !!(v.network?.autoRefresh ?? d.network.autoRefresh),
      dns,
      searchEngine: engine,
    },
    security: {
      autoLockMinutes: clampInt(v.security?.autoLockMinutes, 0, 24 * 60, d.security.autoLockMinutes),
      secretStore: v.security?.secretStore === 'credman' ? 'credman' : 'local',
    },
    logs: { mode: v.logs?.mode === 'diagnostic' ? 'diagnostic' : 'standard' },
    ui: {
      verticalTabs: !!(v.ui?.verticalTabs ?? d.ui.verticalTabs),
      sleepTabsAfterMin: clampInt(v.ui?.sleepTabsAfterMin, 0, 24 * 60, d.ui.sleepTabsAfterMin),
      showStartupSplash: v.ui?.showStartupSplash ?? d.ui.showStartupSplash,
      showBookmarksBar: typeof v.ui?.showBookmarksBar === 'boolean' ? v.ui.showBookmarksBar : d.ui.showBookmarksBar,
      confirmOnQuit: typeof v.ui?.confirmOnQuit === 'boolean' ? v.ui.confirmOnQuit : d.ui.confirmOnQuit,
      openLinksInBackground: typeof v.ui?.openLinksInBackground === 'boolean' ? v.ui.openLinksInBackground : d.ui.openLinksInBackground,
    },
    tor: { torBrowserPath: typeof v.tor?.torBrowserPath === 'string' ? v.tor.torBrowserPath : '' },
    offline: !!v.offline,
    api: { enabled: v.api?.enabled === true, port: clampInt(v.api?.port, 1024, 65535, d.api.port) },
    filtersUpdatedAt: typeof v.filtersUpdatedAt === 'string' ? v.filtersUpdatedAt : undefined,
  };
}

export function dohTemplate(s: AppSettings): string | null {
  if (s.network.dns.mode !== 'doh') return null;
  if (s.network.dns.provider === 'custom') return s.network.dns.customTemplate || null;
  return DOH_TEMPLATES[s.network.dns.provider];
}

export function createSettingsStore(layout: DataLayout): VersionedStore<AppSettings> {
  return new VersionedStore<AppSettings>(path.join(layout.config, 'settings.json'), {
    backupDir: path.join(layout.backups, 'config'),
    defaults: defaultSettings,
    validate: validateSettings,
    maxBackups: 30,
  });
}
