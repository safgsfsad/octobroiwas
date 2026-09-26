/**
 * packages/core/src/addons.ts
 *
 * Catalogue of built-in modules and optional add-ons.
 *
 * Why built-in modules instead of Firefox/Chrome extensions?
 *   The engine is Chromium embedded via Electron (see docs/technology-choice.md).
 *   Electron implements only a subset of the WebExtensions API, so uBlock
 *   Origin, Dark Reader, Sidebery or Multi-Account Containers would run
 *   partially or not at all. Their FUNCTIONS are therefore provided natively
 *   (network filtering with the same public filter lists, URL cleaning,
 *   vertical tabs, per-profile containers). Every module shows a description,
 *   version, license, the permissions it uses, where it comes from, and can be
 *   disabled per profile. Nothing is installed from unknown sites or mirrors.
 */

export interface AddonInfo {
  id: string;
  name: string;
  description: { en: string; pl: string };
  /** Version of the module or upstream component. */
  version: string;
  license: string;
  /** What the module can access (shown before enabling). */
  permissions: Array<{ en: string; pl: string }>;
  /** Upstream / download source. */
  source: string;
  kind: 'builtin' | 'filter-list' | 'external-app';
  status: 'stable' | 'experimental';
  defaultEnabled: boolean;
  /** Can this module be enabled in the Tor profile? Always false: extra modules increase uniqueness. */
  allowedInTor: false;
  /** How integrity is ensured. */
  integrity: { en: string; pl: string };
}

const SIGNED_APP = {
  en: 'Part of the signed application package (verified by the updater: SHA-256 + Ed25519 manifest).',
  pl: 'Część podpisanego pakietu aplikacji (weryfikowana przez aktualizator: SHA-256 + manifest Ed25519).',
};

export const ADDONS: readonly AddonInfo[] = Object.freeze([
  {
    id: 'adblock',
    name: 'Ad & tracker blocker',
    description: {
      en: 'Blocks ads and trackers at network level using the Ghostery adblocker engine and public filter lists (EasyList, EasyPrivacy, uBlock filters).',
      pl: 'Blokuje reklamy i trackery na poziomie sieci przy użyciu silnika Ghostery adblocker i publicznych list filtrów (EasyList, EasyPrivacy, filtry uBlock).',
    },
    version: '2.x',
    license: 'MPL-2.0 (engine); lists: GPL-3.0 / CC BY-SA 3.0',
    permissions: [
      { en: 'Inspect and block network requests of this profile', pl: 'Sprawdzanie i blokowanie żądań sieciowych tego profilu' },
      { en: 'Inject cosmetic CSS to hide ad placeholders', pl: 'Wstrzykiwanie CSS ukrywającego puste miejsca po reklamach' },
    ],
    source: 'https://github.com/ghostery/adblocker ; https://easylist.to ; https://github.com/uBlockOrigin/uAssets',
    kind: 'builtin',
    status: 'stable',
    defaultEnabled: true,
    allowedInTor: false,
    integrity: {
      en: 'Engine: signed app package. Lists: downloaded over HTTPS from the official hosts only, size-limited, parsed before use, SHA-256 recorded; last good copy kept.',
      pl: 'Silnik: podpisany pakiet aplikacji. Listy: pobierane tylko przez HTTPS z oficjalnych hostów, z limitem rozmiaru, parsowane przed użyciem, zapisany SHA-256; zachowana ostatnia poprawna kopia.',
    },
  },
  {
    id: 'clearurls',
    name: 'URL cleaner',
    description: {
      en: 'Removes tracking parameters (utm_*, fbclid, gclid...) and unwraps known redirect wrappers. Inspired by ClearURLs.',
      pl: 'Usuwa parametry śledzące (utm_*, fbclid, gclid...) i rozpakowuje znane przekierowania. Inspirowane ClearURLs.',
    },
    version: '1.0',
    license: 'MPL-2.0 (own implementation)',
    permissions: [{ en: 'Read and rewrite URLs of top-level navigations', pl: 'Odczyt i modyfikacja adresów URL nawigacji' }],
    source: 'built-in (packages/core/src/privacy.ts)',
    kind: 'builtin',
    status: 'stable',
    defaultEnabled: true,
    allowedInTor: false,
    integrity: SIGNED_APP,
  },
  {
    id: 'https-only',
    name: 'HTTPS-Only',
    description: {
      en: 'Upgrades every connection to HTTPS and warns before loading a page over unencrypted HTTP.',
      pl: 'Wymusza HTTPS dla każdego połączenia i ostrzega przed otwarciem strony przez nieszyfrowane HTTP.',
    },
    version: '1.0',
    license: 'MPL-2.0 (own implementation)',
    permissions: [{ en: 'Redirect http:// requests to https://', pl: 'Przekierowywanie żądań http:// na https://' }],
    source: 'built-in',
    kind: 'builtin',
    status: 'stable',
    defaultEnabled: true,
    allowedInTor: false,
    integrity: SIGNED_APP,
  },
  {
    id: 'audio-mixer',
    name: 'Audio mixer',
    description: {
      en: 'Per-tab volume, mute, audible indicator, output device selection for page media.',
      pl: 'Głośność dla każdej karty, wyciszanie, wskaźnik dźwięku, wybór urządzenia wyjściowego dla multimediów strony.',
    },
    version: '1.0',
    license: 'MPL-2.0 (own implementation)',
    permissions: [{ en: 'Adjust volume of <audio>/<video> elements in pages', pl: 'Regulacja głośności elementów <audio>/<video> na stronach' }],
    source: 'built-in',
    kind: 'builtin',
    status: 'stable',
    defaultEnabled: true,
    allowedInTor: false,
    integrity: SIGNED_APP,
  },
  {
    id: 'dark-pages',
    name: 'Dark pages',
    description: {
      en: 'Simple dark mode for web pages (CSS inversion with media correction). For advanced theming Dark Reader is recommended in a Firefox-based browser.',
      pl: 'Prosty tryb ciemny dla stron (inwersja CSS z korektą multimediów). Do zaawansowanego motywu zalecany jest Dark Reader w przeglądarce opartej na Firefoksie.',
    },
    version: '1.0',
    license: 'MPL-2.0 (own implementation)',
    permissions: [{ en: 'Inject CSS into pages', pl: 'Wstrzykiwanie CSS do stron' }],
    source: 'built-in',
    kind: 'builtin',
    status: 'stable',
    defaultEnabled: false,
    allowedInTor: false,
    integrity: SIGNED_APP,
  },
  {
    id: 'privacy-audit',
    name: 'Privacy audit (OctoDetect.su)',
    description: {
      en: 'Opens the current profile\'s exposure report in OctoDetect.su (local only, nothing is uploaded).',
      pl: 'Otwiera raport ujawnianych danych bieżącego profilu w OctoDetect.su (lokalnie, nic nie jest wysyłane).',
    },
    version: '1.0',
    license: 'MPL-2.0',
    permissions: [{ en: 'Start OctoDetect.su', pl: 'Uruchomienie OctoDetect.su' }],
    source: 'built-in',
    kind: 'builtin',
    status: 'stable',
    defaultEnabled: true,
    allowedInTor: false,
    integrity: SIGNED_APP,
  },
  {
    id: 'bitwarden',
    name: 'Bitwarden (desktop app integration)',
    description: {
      en: 'Optional. Opens the official Bitwarden desktop application or web vault. OctoBrowser never stores your passwords itself.',
      pl: 'Opcjonalne. Otwiera oficjalną aplikację Bitwarden lub sejf webowy. OctoBrowser sam nie przechowuje Twoich haseł.',
    },
    version: 'external',
    license: 'GPL-3.0 (Bitwarden clients)',
    permissions: [{ en: 'Launch an external program', pl: 'Uruchomienie zewnętrznego programu' }],
    source: 'https://bitwarden.com/download/',
    kind: 'external-app',
    status: 'stable',
    defaultEnabled: false,
    allowedInTor: false,
    integrity: {
      en: 'Installed and updated by Bitwarden itself (Authenticode-signed by Bitwarden Inc.).',
      pl: 'Instalowany i aktualizowany przez samego Bitwardena (podpis Authenticode Bitwarden Inc.).',
    },
  },
]);

export function findAddon(id: string): AddonInfo | undefined {
  return ADDONS.find((a) => a.id === id);
}

/** Official filter list sources (HTTPS only, no mirrors). */
export interface FilterListSource {
  id: string;
  name: string;
  url: string;
  license: string;
  category: 'ads' | 'trackers' | 'annoyances';
  maxBytes: number;
}

export const FILTER_LISTS: readonly FilterListSource[] = Object.freeze([
  { id: 'easylist', name: 'EasyList', url: 'https://easylist.to/easylist/easylist.txt', license: 'GPL-3.0 / CC BY-SA 3.0', category: 'ads', maxBytes: 8 * 1024 * 1024 },
  { id: 'easyprivacy', name: 'EasyPrivacy', url: 'https://easylist.to/easylist/easyprivacy.txt', license: 'GPL-3.0 / CC BY-SA 3.0', category: 'trackers', maxBytes: 8 * 1024 * 1024 },
  { id: 'ubo-filters', name: 'uBlock filters', url: 'https://ublockorigin.github.io/uAssets/filters/filters.txt', license: 'GPL-3.0', category: 'ads', maxBytes: 8 * 1024 * 1024 },
  { id: 'ubo-privacy', name: 'uBlock filters - Privacy', url: 'https://ublockorigin.github.io/uAssets/filters/privacy.txt', license: 'GPL-3.0', category: 'trackers', maxBytes: 4 * 1024 * 1024 },
]);

/** Validate a downloaded filter list before using it. */
export function looksLikeFilterList(text: string): boolean {
  if (text.length < 100) return false;
  const head = text.slice(0, 4096);
  if (/<html|<!doctype/i.test(head)) return false; // captive portal / error page
  const lines = text.split('\n', 2000);
  const ruleLike = lines.filter((l) => /^(\|\||@@|##|!|\[|[\w.-]+##|\/)/.test(l.trim())).length;
  return ruleLike / Math.max(lines.length, 1) > 0.5;
}
