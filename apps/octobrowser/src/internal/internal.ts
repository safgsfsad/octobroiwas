/**
 * apps/octobrowser/src/internal/internal.ts
 *
 * Script of the internal pages (octo://newtab, octo://error, octo://https-only).
 * These pages run as ordinary (untrusted) web contents; they only get the tiny
 * window.octoInternal API exposed by the tab preload on the octo: protocol.
 * All text comes from the app dictionaries; DOM is built without innerHTML.
 */

interface OctoInternal {
  status(): Promise<Status | null>;
  navigate(input: string): Promise<boolean | null>;
  allowHttp(url: string): Promise<boolean | null>;
  sandbox(): Promise<boolean | null>;
  strings(): Promise<{ lang: 'en' | 'pl'; dict: Record<string, string> } | null>;
}
interface Status {
  profile: { name: string; kind: string; color: string; level: string; encrypted: boolean; sandbox: string; network: string; theme: string };
  protection: 'active' | 'attention';
  traffic: {
    publicIp: string | null; consent: boolean; dns: { leak: string; doh: boolean }; webrtc: { status: string; policy: string };
    bytesIn: number; bytesOut: number; blocked: { ads: number; trackers: number; scripts: number }; vpn: string[] | null; proxy: { active: boolean; mode: string };
  } | null;
  update: { available: boolean; latest: string | null; configured: boolean } | null;
  version: string;
}

declare global { interface Window { octoInternal?: OctoInternal } }

let dict: Record<string, string> = {};
const t = (k: string, p?: Record<string, string | number>) => {
  const s = dict[k] ?? k;
  return p ? s.replace(/\{(\w+)\}/g, (m, x: string) => (x in p ? String(p[x]) : m)) : s;
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string, ...kids: Node[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  e.append(...kids);
  return e;
}

function fmtBytes(n: number): string {
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

/**
 * One status card. The tone only picks the shape of the leading dot - the label
 * and the value text carry the meaning, so nothing depends on colour vision.
 */
function tile(label: string, value: string, state: 'ok' | 'warn' | 'bad' | 'muted' = 'muted'): HTMLElement {
  const card = el('div', 'tile', undefined, el('span', 'tl', label, el('span', 'dot')), el('b', '', value));
  card.dataset.tone = state;
  return card;
}

async function newTab(api: OctoInternal, root: HTMLElement): Promise<void> {
  document.title = t('ui.newTab');
  const form = el('form', 'search');
  const input = el('input');
  input.type = 'text';
  input.placeholder = t('newtab.search');
  input.autofocus = true;
  input.spellcheck = false;
  form.append(input);
  form.onsubmit = (e) => { e.preventDefault(); if (input.value.trim()) void api.navigate(input.value.trim()); };
  const logo = el('div', 'logo', undefined, el('span', 'mark'), el('span', '', 'OctoBrowser'), el('span', 'su', '.su'));
  root.append(logo, form, el('p', 'hint', t('newtab.searchNote')));

  const grid = el('section', 'tiles');
  root.append(grid);
  const s = await api.status();
  if (!s) return;
  document.documentElement.dataset.theme = s.profile.theme === 'light' ? 'light' : 'dark';
  document.documentElement.style.setProperty('--pc', s.profile.color);
  root.insertBefore(el('div', 'profile', undefined, el('span', 'dot'), el('span', '', `${s.profile.name} · ${t(`profile.kind.${s.profile.kind}`)} · ${t(`level.${s.profile.level}`)}`)), logo);
  const tr = s.traffic;
  grid.append(tile(t('newtab.protection'), t(s.protection === 'active' ? 'status.protectionActive' : 'status.attention'), s.protection === 'active' ? 'ok' : 'warn'));
  if (tr) {
    grid.append(
      tile(t('net.publicIp'), tr.consent ? (tr.publicIp ?? t('state.unknown')) : t('net.ipConsentOffShort')),
      tile(t('net.dns'), t(`leak.${tr.dns.leak}`), tr.dns.leak === 'ok' ? 'ok' : tr.dns.leak === 'leak' ? 'bad' : 'warn'),
      tile('WebRTC', t(`leak.${tr.webrtc.status}`), tr.webrtc.status === 'ok' ? 'ok' : tr.webrtc.status === 'exposed' ? 'bad' : 'warn'),
      tile(t('net.route'), tr.proxy.active ? t('net.mode.proxy') : tr.vpn ? t('iso.vpn.detected') : t(`net.mode.${tr.proxy.mode}`)),
      tile(t('net.total'), `↓ ${fmtBytes(tr.bytesIn)} · ↑ ${fmtBytes(tr.bytesOut)}`),
      tile(t('net.blocked'), String(tr.blocked.ads + tr.blocked.trackers), 'ok'),
    );
  }
  grid.append(
    tile(t('ui.sandbox'), t(`iso.mode.${s.profile.sandbox}`), s.profile.sandbox === 'none' ? 'muted' : 'ok'),
    tile(t('ui.encryption'), t(s.profile.encrypted ? 'status.encrypted' : 'status.notEncrypted'), s.profile.encrypted ? 'ok' : 'muted'),
    tile(t('panel.updates'), s.update?.available ? t('upd.available', { v: s.update.latest ?? '' }) : s.update?.configured === false ? t('upd.notConfiguredShort') : t('upd.upToDate'), s.update?.available ? 'warn' : 'muted'),
  );
  const sb = el('button', 'btn', t('privacy.openInWsb'));
  sb.onclick = () => void api.sandbox();
  root.append(el('div', 'actions', undefined, sb), el('p', 'hint', t('status.noGuarantee')), el('p', 'ver', `v${s.version}`));
}

function errorPage(api: OctoInternal, root: HTMLElement): void {
  const q = new URLSearchParams(location.search);
  const code = Number(q.get('code') ?? 0);
  const url = q.get('url') ?? '';
  const desc = q.get('desc') ?? '';
  document.title = t('errpage.title');
  let key = 'errpage.generic';
  if ([-105, -137].includes(code)) key = 'errpage.dns';
  else if ([-106, -21].includes(code)) key = 'errpage.offline';
  else if ([-102, -118, -109, -100, -101].includes(code)) key = 'errpage.connection';
  else if (code <= -200 && code > -300) key = 'errpage.cert';
  else if (code === -130 || code === -111 || code === -115) key = 'errpage.proxy';
  else if (code === -20) key = 'errpage.blocked';
  const retry = el('button', 'btn primary', t('errpage.retry'));
  retry.onclick = () => { if (url) void api.navigate(url); };
  root.append(
    el('div', 'big-icon warn', '!'),
    el('h1', '', t('errpage.title')),
    el('p', '', t(key)),
    el('p', 'mono', url),
    el('p', 'hint', `${desc} (${code})`),
    el('div', 'actions', undefined, retry),
  );
  if (key === 'errpage.cert') root.append(el('p', 'note', t('errpage.certNote')));
}

function httpsOnly(api: OctoInternal, root: HTMLElement): void {
  const url = new URLSearchParams(location.search).get('url') ?? '';
  let host = '';
  try { host = new URL(url).hostname; } catch { /* invalid */ }
  document.title = t('https.title');
  const back = el('button', 'btn primary', t('https.back'));
  back.onclick = () => history.back();
  const cont = el('button', 'btn', t('https.continue', { host }));
  cont.onclick = () => void api.allowHttp(url);
  root.append(
    el('div', 'big-icon warn', '!'),
    el('h1', '', t('https.title')),
    el('p', '', t('https.desc', { host })),
    el('p', 'mono', url),
    el('p', 'note', t('https.risk')),
    el('div', 'actions', undefined, back, cont),
    el('p', 'hint', t('https.onceNote')),
  );
}

async function main(): Promise<void> {
  const api = window.octoInternal;
  const root = document.getElementById('root')!;
  if (!api) { root.textContent = 'Internal API unavailable.'; return; }
  const s = await api.strings();
  if (s) { dict = s.dict; document.documentElement.lang = s.lang; }
  switch (document.body.dataset.page) {
    case 'newtab': await newTab(api, root); break;
    case 'error': errorPage(api, root); break;
    case 'https-only': httpsOnly(api, root); break;
    default: root.textContent = 'Unknown page';
  }
}

main().catch((err) => {
  const root = document.getElementById('root');
  if (root) root.textContent = `Error: ${String((err as Error)?.message ?? err)}`;
});

export {};
