/**
 * apps/octobrowser/src/renderer/browser.ts
 *
 * Trusted browser chrome UI: tab strip (horizontal or vertical), toolbar with
 * address bar and status icons, info bars (permissions, blocked redirects,
 * download confirmations, toasts), find bar, tab search and docked panels
 * (traffic, audio, privacy, add-ons, downloads, bookmarks, history, updates,
 * shortcuts, menu). Page content is rendered by native views positioned over
 * #content - we report that rectangle to the main process.
 */
import { api, bytes, clear } from '@octo/shell/renderer/bridge';
import { applyI18n, h, setDicts, setLang, t, Dicts, getLang } from '@octo/shell/renderer/i18n-client';
import { icon } from '@octo/shell/renderer/icons';
import { commandFor } from '../shared/shortcuts';

// ------------------------------------------------------------------ types

interface TabState {
  id: number; title: string; url: string; favicon?: string; loading: boolean; audible: boolean; muted: boolean;
  volume: number; pinned: boolean; group: string; sleeping: boolean; blocked: number; canBack: boolean; canForward: boolean;
  security: 'https' | 'http' | 'internal' | 'other'; crashed: boolean; zoom: number; redirectBlocked?: string;
}
interface ProfileInfo {
  id: string; name: string; kind: string; color: string; level: 'normal' | 'standard' | 'strict' | 'tor'; encrypted: boolean;
  sandbox: 'none' | 'restricted' | 'windows-sandbox'; network: 'system' | 'direct' | 'proxy'; deleteOnClose: boolean;
  audio: { muted: boolean; volume: number; outputDeviceId: string }; addons: string[];
  theme: 'dark' | 'light';
}
interface UpdateStatus {
  configured: boolean; current: string; latest: string | null; available: boolean; severity?: string;
  changelog?: { en: string; pl: string }; lastCheckAt?: string; error?: string;
}
interface WinState {
  tabs: TabState[]; activeId: number; splitId: number; fullscreen: boolean; closedCount: number;
  profile: ProfileInfo; protection: 'active' | 'attention'; verticalTabs: boolean; showBookmarksBar: boolean; openLinksInBackground: boolean; offline: boolean; update: UpdateStatus | null;
}
interface AddonInfo {
  id: string; name: string; description: { en: string; pl: string }; version: string; license: string;
  permissions: Array<{ en: string; pl: string }>; source: string; kind: string; status: string; integrity: { en: string; pl: string };
}
interface DownloadInfo {
  id: string; fileName: string; savePath: string; url: string; state: string; received: number; total: number; dangerous: boolean; startedAt: string;
}
type Panel = 'traffic' | 'audio' | 'privacy' | 'addons' | 'downloads' | 'bookmarks' | 'history' | 'updates' | 'shortcuts' | 'menu';

// ------------------------------------------------------------------ state

let state: WinState | null = null;
let addons: AddonInfo[] = [];
let shortcuts: Array<[string, string]> = [];
let panel: Panel | null = null;
let panelTimer: number | null = null;
let overlay = false;
let editingAddress = false;
const downloads = new Map<string, DownloadInfo>();

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const tabById = (id: number) => state?.tabs.find((x) => x.id === id);
const activeTab = () => (state ? tabById(state.activeId) : undefined);
const L = (o: { en: string; pl: string }) => o[getLang()] ?? o.en;

// ------------------------------------------------------------------ layout reporting

function reportLayout(): void {
  const r = $('content').getBoundingClientRect();
  void api.invoke('ui:layout', { x: r.left, y: r.top, width: r.width, height: r.height }, overlay).catch(() => undefined);
}
new ResizeObserver(reportLayout).observe($('content'));
window.addEventListener('resize', reportLayout);

function setOverlay(on: boolean): void {
  overlay = on;
  $('overlay').classList.toggle('hidden', !on);
  reportLayout();
}

// ------------------------------------------------------------------ toolbar

function initToolbar(): void {
  $('newTab').append(icon('plus', 16));
  $('back').append(icon('back'));
  $('forward').append(icon('forward'));
  $('reload').append(icon('reload'));
  $('star').append(icon('star', 16));
  $('findPrev').append(icon('back', 14));
  $('findNext').append(icon('forward', 14));
  $('findClose').append(icon('close', 14));
  $('panelClose').append(icon('close', 14));

  $('newTab').onclick = () => void api.invoke('ui:new-tab');
  $('back').onclick = () => void api.invoke('ui:command', 'back');
  $('forward').onclick = () => void api.invoke('ui:command', 'forward');
  $('reload').onclick = () => void api.invoke('ui:command', activeTab()?.loading ? 'stop' : 'reload');
  $('star').onclick = () => void api.invoke('ui:command', 'bookmark');
  $('panelClose').onclick = () => openPanel(null);
  $('profileBadge').onclick = () => openPanel('menu');
  $('profileBadge').onkeydown = (e) => { if (e.key === 'Enter') openPanel('menu'); };

  const addr = $<HTMLInputElement>('address');
  addr.addEventListener('focus', () => { editingAddress = true; addr.select(); });
  addr.addEventListener('blur', () => { editingAddress = false; renderAddress(); });
  addr.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && addr.value.trim()) {
      void api.invoke('ui:navigate', addr.value.trim());
      addr.blur();
    } else if (e.key === 'Escape') {
      addr.blur();
    }
  });

  // status icons (each opens a panel)
  const status = $('status');
  const mk = (id: string, name: string, titleKey: string, onClick: () => void) => {
    const b = h('button', { id, class: 'icon-btn status', title: t(titleKey) });
    b.append(icon(name));
    b.onclick = onClick;
    status.append(b);
    return b;
  };
  mk('stProtection', 'shieldCheck', 'panel.privacy', () => openPanel('privacy'));
  mk('stNetwork', 'network', 'panel.traffic', () => openPanel('traffic'));
  mk('stSandbox', 'box', 'ui.sandbox', () => openPanel('privacy'));
  mk('stEncryption', 'lock', 'ui.encryption', () => openPanel('privacy'));
  mk('stAudio', 'volume', 'panel.audio', () => openPanel('audio'));
  mk('stDownloads', 'download', 'panel.downloads', () => openPanel('downloads'));
  mk('stAddons', 'puzzle', 'panel.addons', () => openPanel('addons'));
  mk('stUpdates', 'refreshCircle', 'panel.updates', () => openPanel('updates'));
  mk('stMenu', 'menu', 'ui.menu', () => openPanel('menu'));
}

function renderAddress(): void {
  const tab = activeTab();
  const addr = $<HTMLInputElement>('address');
  if (!editingAddress) addr.value = tab ? (tab.url.startsWith('octo://newtab') ? '' : tab.url) : '';
  const sec = $('secIcon');
  clear(sec);
  const s = tab?.security ?? 'internal';
  sec.className = `sec ${s}`;
  sec.append(icon(s === 'https' ? 'lock' : s === 'http' ? 'alert' : 'info', 15));
  sec.title = t(`ui.sec.${s}`);
  $<HTMLButtonElement>('back').disabled = !tab?.canBack;
  $<HTMLButtonElement>('forward').disabled = !tab?.canForward;
  const reload = $('reload');
  clear(reload);
  reload.append(icon(tab?.loading ? 'close' : 'reload'));
  const zoom = $('zoom');
  zoom.classList.toggle('hidden', !tab || tab.zoom === 100);
  zoom.textContent = tab ? `${tab.zoom}%` : '';
  zoom.onclick = () => void api.invoke('ui:command', 'zoom-reset');
  const bc = $('blockedCount');
  bc.classList.toggle('hidden', !tab || tab.blocked === 0);
  bc.textContent = tab ? String(tab.blocked) : '';
}

function renderStatus(): void {
  if (!state) return;
  const p = state.profile;
  const badge = $('profileBadge');
  clear(badge);
  badge.style.setProperty('--pc', p.color);
  badge.append(h('span', { class: 'dot' }), h('span', { class: 'name', text: p.name }), h('span', { class: 'lvl', text: t(`level.${p.level}`) }));
  badge.title = `${p.name} - ${t(`profile.kind.${p.kind}`)}`;

  const set = (id: string, cls: string, title: string, iconName?: string) => {
    const el = $(id);
    el.className = `icon-btn status ${cls}`;
    el.title = title;
    if (iconName) { clear(el); el.append(icon(iconName)); }
  };
  set('stProtection', state.protection === 'active' ? 'ok' : 'warn', t(state.protection === 'active' ? 'status.protectionActive' : 'status.attention'), state.protection === 'active' ? 'shieldCheck' : 'shieldAlert');
  set('stNetwork', state.offline ? 'warn' : p.network === 'proxy' ? 'ok' : '', state.offline ? t('status.offline') : t(`net.mode.${p.network}`), state.offline ? 'wifiOff' : 'network');
  set('stSandbox', p.sandbox === 'none' ? 'dim' : 'ok', t(`iso.mode.${p.sandbox}`));
  set('stEncryption', p.encrypted ? 'ok' : 'dim', t(p.encrypted ? 'status.encrypted' : 'status.notEncrypted'), p.encrypted ? 'lock' : 'unlock');
  const audible = state.tabs.some((x) => x.audible && !x.muted);
  set('stAudio', p.audio.muted ? 'warn' : audible ? 'ok' : '', t('panel.audio'), p.audio.muted ? 'mute' : 'volume');
  const active = [...downloads.values()].some((d) => d.state === 'progressing');
  set('stDownloads', active ? 'ok pulse' : '', t('panel.downloads'));
  set('stUpdates', state.update?.available ? 'accent' : '', state.update?.available ? t('upd.available', { v: state.update.latest ?? '' }) : t('panel.updates'));
  document.body.classList.toggle('vertical', state.verticalTabs);
  $('vtabs').classList.toggle('hidden', !state.verticalTabs);
}

// ------------------------------------------------------------------ tabs

function tabElement(tab: TabState, vertical: boolean): HTMLElement {
  const el = h('div', {
    class: `tab${tab.id === state?.activeId ? ' active' : ''}${tab.pinned ? ' pinned' : ''}${tab.sleeping ? ' sleeping' : ''}${tab.id === state?.splitId ? ' split' : ''}`,
    role: 'tab',
    'aria-selected': String(tab.id === state?.activeId),
    title: `${tab.title}\n${tab.url}`,
    draggable: 'true',
  });
  el.dataset.id = String(tab.id);
  const fav = h('span', { class: 'fav' });
  if (tab.loading) fav.append(h('span', { class: 'spinner' }));
  else if (tab.favicon && /^https:|^data:image\//.test(tab.favicon)) fav.append(h('img', { src: tab.favicon, alt: '' }));
  else fav.append(icon(tab.url.startsWith('octo:') ? 'shield' : 'globe', 14));
  el.append(fav);
  if (tab.group) el.append(h('span', { class: 'group', text: tab.group }));
  if (!tab.pinned || vertical) el.append(h('span', { class: 'title', text: tab.title || t('ui.newTab') }));
  if (tab.audible || tab.muted) {
    const a = h('button', { class: 'icon-btn tiny', title: t(tab.muted ? 'ui.unmute' : 'ui.mute') });
    a.append(icon(tab.muted ? 'mute' : 'volume', 13));
    a.onclick = (e) => { e.stopPropagation(); void api.invoke('ui:tab', tab.id, 'mute'); };
    el.append(a);
  }
  if (!tab.pinned) {
    const c = h('button', { class: 'icon-btn tiny close', title: t('ui.closeTab') });
    c.append(icon('close', 12));
    c.onclick = (e) => { e.stopPropagation(); void api.invoke('ui:tab', tab.id, 'close'); };
    el.append(c);
  }
  el.onclick = () => void api.invoke('ui:tab', tab.id, 'activate');
  el.onauxclick = (e) => { if (e.button === 1) void api.invoke('ui:tab', tab.id, 'close'); };
  el.oncontextmenu = (e) => { e.preventDefault(); tabMenu(tab); };
  el.ondragstart = (e) => e.dataTransfer?.setData('text/octo-tab', String(tab.id));
  el.ondragover = (e) => e.preventDefault();
  el.ondrop = (e) => {
    e.preventDefault();
    const from = Number(e.dataTransfer?.getData('text/octo-tab'));
    const to = state?.tabs.findIndex((x) => x.id === tab.id) ?? -1;
    if (from && to >= 0) void api.invoke('ui:tab', from, 'move', to);
  };
  return el;
}

function renderTabs(): void {
  if (!state) return;
  const box = state.verticalTabs ? $('vtabs') : $('tabs');
  const other = state.verticalTabs ? $('tabs') : $('vtabs');
  clear(box);
  clear(other);
  let lastGroup = '';
  for (const tab of state.tabs) {
    if (state.verticalTabs && tab.group && tab.group !== lastGroup) box.append(h('div', { class: 'group-head', text: tab.group }));
    lastGroup = tab.group;
    box.append(tabElement(tab, state.verticalTabs));
  }
  if (state.verticalTabs) {
    const add = h('button', { class: 'btn ghost new-vtab' }, icon('plus', 14), ` ${t('ui.newTab')}`);
    add.onclick = () => void api.invoke('ui:new-tab');
    box.append(add);
  }
  renderBars();
}

/** Tab actions shown in a panel (native menus would overlap page views). */
function tabMenu(tab: TabState): void {
  openPanel('menu', () => {
    const b = $('panelBody');
    b.append(h('h3', { text: tab.title || tab.url }));
    const act = (key: string, action: string, arg?: unknown) => {
      const btn = h('button', { class: 'menu-item', text: t(key) });
      btn.onclick = () => { void api.invoke('ui:tab', tab.id, action, arg); openPanel(null); };
      b.append(btn);
    };
    act(tab.pinned ? 'tab.unpin' : 'tab.pin', 'pin');
    act(tab.muted ? 'ui.unmute' : 'ui.mute', 'mute');
    act('tab.duplicate', 'duplicate');
    act('ctx.reload', 'reload');
    act('tab.sleep', 'sleep');
    act(tab.id === state?.splitId ? 'tab.unsplit' : 'tab.split', 'split');
    const grp = h('div', { class: 'row' });
    const inp = h('input', { type: 'text', value: tab.group, placeholder: t('tab.groupName'), maxlength: '32' });
    const ok = h('button', { class: 'btn small', text: t('tab.setGroup') });
    ok.onclick = () => { void api.invoke('ui:tab', tab.id, 'group', inp.value.trim()); openPanel(null); };
    grp.append(inp, ok);
    b.append(grp);
    const vol = h('label', { class: 'row' }, t('audio.tabVolume'));
    const range = h('input', { type: 'range', min: '0', max: '100', value: String(tab.volume) });
    range.oninput = () => void api.invoke('ui:tab', tab.id, 'volume', Number(range.value));
    vol.append(range);
    b.append(vol);
    act('ui.closeTab', 'close');
  }, t('tab.menu'));
}

// ------------------------------------------------------------------ bars

interface Bar { id: string; kind: 'info' | 'warn' | 'ask'; text: string; actions: Array<{ key: string; primary?: boolean; run: () => void }>; timeout?: number }
const bars = new Map<string, Bar>();

function pushBar(b: Bar): void {
  bars.set(b.id, b);
  if (b.timeout) window.setTimeout(() => { bars.delete(b.id); renderBars(); }, b.timeout);
  renderBars();
}

function renderBars(): void {
  const box = $('bars');
  clear(box);
  const tab = activeTab();
  const all = [...bars.values()];
  if (tab?.redirectBlocked) {
    all.unshift({
      id: `redir-${tab.id}`, kind: 'warn', text: t('bar.redirectBlocked', { url: tab.redirectBlocked.slice(0, 120) }),
      actions: [
        { key: 'bar.allowRedirect', primary: true, run: () => void api.invoke('ui:tab', tab.id, 'allow-redirect') },
        { key: 'common.dismiss', run: () => void api.invoke('ui:tab', tab.id, 'dismiss-redirect') },
      ],
    });
  }
  if (tab?.crashed) {
    all.unshift({ id: 'crash', kind: 'warn', text: t('bar.crashed'), actions: [{ key: 'ctx.reload', primary: true, run: () => void api.invoke('ui:command', 'reload') }] });
  }
  if (state?.offline) all.unshift({ id: 'offline', kind: 'info', text: t('bar.offline'), actions: [{ key: 'bar.goOnline', run: () => void api.invoke('ui:settings-set', { offline: false }) }] });
  for (const b of all) {
    const el = h('div', { class: `bar ${b.kind}` }, icon(b.kind === 'warn' ? 'alert' : b.kind === 'ask' ? 'shield' : 'info', 16), h('span', { class: 'bar-text', text: b.text }));
    for (const a of b.actions) {
      const btn = h('button', { class: `btn small${a.primary ? ' primary' : ''}`, text: t(a.key) });
      btn.onclick = () => { bars.delete(b.id); a.run(); renderBars(); };
      el.append(btn);
    }
    box.append(el);
  }
  requestAnimationFrame(reportLayout);
}

function toast(key: string, params?: Record<string, string | number>): void {
  pushBar({ id: `toast-${key}`, kind: 'info', text: t(key, params), actions: [], timeout: 3500 });
}

// ------------------------------------------------------------------ find & tab search

function openFind(): void {
  $('findbar').classList.remove('hidden');
  const inp = $<HTMLInputElement>('findInput');
  inp.focus();
  inp.select();
  requestAnimationFrame(reportLayout);
}
function closeFind(): void {
  $('findbar').classList.add('hidden');
  void api.invoke('ui:find', '', {});
  $('findCount').textContent = '';
  requestAnimationFrame(reportLayout);
}
function initFind(): void {
  const inp = $<HTMLInputElement>('findInput');
  inp.oninput = () => void api.invoke('ui:find', inp.value, { forward: true, findNext: false });
  inp.onkeydown = (e) => {
    if (e.key === 'Enter') void api.invoke('ui:find', inp.value, { forward: !e.shiftKey, findNext: true });
    if (e.key === 'Escape') closeFind();
  };
  $('findNext').onclick = () => void api.invoke('ui:find', inp.value, { forward: true, findNext: true });
  $('findPrev').onclick = () => void api.invoke('ui:find', inp.value, { forward: false, findNext: true });
  $('findClose').onclick = closeFind;
}

function openTabSearch(): void {
  setOverlay(true);
  const inp = $<HTMLInputElement>('tabSearchInput');
  inp.value = '';
  renderTabSearch('');
  inp.focus();
  inp.oninput = () => renderTabSearch(inp.value);
  inp.onkeydown = (e) => {
    if (e.key === 'Escape') setOverlay(false);
    if (e.key === 'Enter') ($('tabSearchList').firstElementChild as HTMLElement | null)?.click();
  };
  $('overlay').onclick = (e) => { if (e.target === $('overlay')) setOverlay(false); };
}
function renderTabSearch(q: string): void {
  const list = $('tabSearchList');
  clear(list);
  const n = q.toLowerCase();
  for (const tab of state?.tabs ?? []) {
    if (n && !tab.title.toLowerCase().includes(n) && !tab.url.toLowerCase().includes(n)) continue;
    const row = h('button', { class: 'menu-item' }, h('b', { text: tab.title || tab.url }), h('span', { class: 'muted', text: ` ${tab.url}` }));
    row.onclick = () => { void api.invoke('ui:tab', tab.id, 'activate'); setOverlay(false); };
    list.append(row);
  }
}

// ------------------------------------------------------------------ panels

function openPanel(p: Panel | null, custom?: () => void, title?: string): void {
  if (panelTimer) { window.clearInterval(panelTimer); panelTimer = null; }
  if (p === panel && !custom) p = null; // toggle
  panel = p;
  $('panel').classList.toggle('hidden', !p);
  clear($('panelBody'));
  if (p) {
    $('panelTitle').textContent = title ?? t(`panel.${p}`);
    if (custom) custom();
    else void renderPanel(p);
  }
  requestAnimationFrame(reportLayout);
}

function section(titleKey: string, ...children: Array<Node | string | null>): HTMLElement {
  return h('section', { class: 'psec' }, h('h3', { text: t(titleKey) }), ...children);
}
function kv(labelKey: string, value: string | Node, cls = ''): HTMLElement {
  return h('div', { class: `kv ${cls}` }, h('span', { class: 'k', text: t(labelKey) }), typeof value === 'string' ? h('span', { class: 'v', text: value }) : value);
}
function badge(state_: 'ok' | 'warn' | 'bad' | 'unknown' | 'info', key: string): HTMLElement {
  return h('span', { class: `pill ${state_}`, text: t(key) });
}

async function renderPanel(p: Panel): Promise<void> {
  const body = $('panelBody');
  try {
    switch (p) {
      case 'traffic': await renderTraffic(false); panelTimer = window.setInterval(() => void renderTraffic(false), 1000); break;
      case 'audio': renderAudio(body); break;
      case 'privacy': await renderPrivacy(body); break;
      case 'addons': renderAddons(body); break;
      case 'downloads': await renderDownloads(body); break;
      case 'bookmarks': await renderBookmarks(body); break;
      case 'history': await renderHistory(body, ''); break;
      case 'updates': renderUpdates(body); break;
      case 'shortcuts': renderShortcuts(body); break;
      case 'menu': renderMenu(body); break;
    }
  } catch (err) {
    body.append(h('p', { class: 'err', text: String((err as Error).message ?? err) }));
  }
}

interface Traffic {
  publicIp: string | null; publicIpError: string | null; publicIpConsent: boolean; vpn: string[] | null;
  proxy: { active: boolean; value: string; mode: string }; tor: boolean;
  dns: { servers: string[]; doh: boolean; dohTemplate: string | null; leak: string };
  webrtc: { policy: string; status: string }; bytesIn: number; bytesOut: number; requests: number; active: number;
  domains: Array<[string, number]>; blocked: { ads: number; trackers: number; scripts: number };
  httpsUpgrades: number; paramsStripped: number; thirdPartyCookiesBlocked: number; https: string;
  cert: { host: string; subject: string; issuer: string; validFrom: number; validTo: number; fingerprint: string; verified: boolean } | null;
  filtersUpdatedAt: string | null; autoRefresh: boolean;
}
let lastTraffic: { at: number; bytesIn: number; bytesOut: number } | null = null;

async function renderTraffic(force: boolean): Promise<void> {
  if (panel !== 'traffic') return;
  const tr = await api.invoke<Traffic>('ui:traffic', force);
  const body = $('panelBody');
  const now = Date.now();
  const rate = lastTraffic ? { down: (tr.bytesIn - lastTraffic.bytesIn) / ((now - lastTraffic.at) / 1000), up: (tr.bytesOut - lastTraffic.bytesOut) / ((now - lastTraffic.at) / 1000) } : { down: 0, up: 0 };
  lastTraffic = { at: now, bytesIn: tr.bytesIn, bytesOut: tr.bytesOut };
  clear(body);
  const leakPill = (s: string) => badge(s === 'ok' ? 'ok' : s === 'warning' || s === 'limited' ? 'warn' : s === 'leak' || s === 'exposed' ? 'bad' : 'unknown', `leak.${s}`);
  const ipVal = !tr.publicIpConsent ? h('span', { class: 'v muted', text: t('net.ipConsentOff') }) : h('span', { class: 'v mono', text: tr.publicIp ?? (tr.publicIpError ? t('state.unknown') : '...') });
  body.append(
    section('net.connection',
      kv('net.publicIp', ipVal),
      kv('net.vpn', tr.vpn ? tr.vpn.join(', ') : t('iso.vpn.none')),
      kv('net.proxy', tr.proxy.active ? tr.proxy.value : t(`net.mode.${tr.proxy.mode}`)),
      kv('net.tor', t('net.torNotHere')),
      kv('net.https', badge(tr.https === 'https' ? 'ok' : tr.https === 'http' ? 'bad' : 'info', `ui.sec.${tr.https}`)),
    ),
    section('net.leaks',
      kv('net.dns', h('span', { class: 'v' }, leakPill(tr.dns.leak), ` ${tr.dns.doh ? 'DoH' : tr.dns.servers.slice(0, 2).join(', ')}`)),
      kv('net.webrtc', h('span', { class: 'v' }, leakPill(tr.webrtc.status), ` ${t(`webrtc.${tr.webrtc.policy}`)}`)),
    ),
    section('net.traffic',
      kv('net.down', `${bytes(Math.max(0, rate.down))}/s`),
      kv('net.up', `${bytes(Math.max(0, rate.up))}/s`),
      kv('net.total', `↓ ${bytes(tr.bytesIn)} · ↑ ${bytes(tr.bytesOut)}`),
      kv('net.requests', `${tr.requests} (${t('net.active')}: ${tr.active})`),
    ),
    section('net.blocked',
      kv('net.blockedAds', String(tr.blocked.ads)),
      kv('net.blockedTrackers', String(tr.blocked.trackers)),
      kv('net.blockedScripts', String(tr.blocked.scripts)),
      kv('net.httpsUpgrades', String(tr.httpsUpgrades)),
      kv('net.paramsStripped', String(tr.paramsStripped)),
      kv('net.cookiesBlocked', String(tr.thirdPartyCookiesBlocked)),
      kv('net.filtersUpdated', tr.filtersUpdatedAt ? new Date(tr.filtersUpdatedAt).toLocaleString() : t('state.never')),
    ),
  );
  if (tr.cert) {
    body.append(section('net.cert',
      kv('net.certHost', tr.cert.host),
      kv('net.certIssuer', tr.cert.issuer),
      kv('net.certValid', `${new Date(tr.cert.validFrom * 1000).toLocaleDateString()} – ${new Date(tr.cert.validTo * 1000).toLocaleDateString()}`),
      kv('net.certStatus', badge(tr.cert.verified ? 'ok' : 'bad', tr.cert.verified ? 'net.certOk' : 'net.certBad')),
    ));
  }
  const dom = h('div', { class: 'domains' });
  for (const [d, n] of tr.domains) dom.append(h('div', { class: 'kv' }, h('span', { class: 'k mono', text: d }), h('span', { class: 'v', text: String(n) })));
  body.append(section('net.domains', h('p', { class: 'muted small', text: t('net.domainsNote') }), dom));
  const actions = h('div', { class: 'row' });
  const refresh = h('button', { class: 'btn small', text: t('net.refresh') });
  refresh.onclick = () => void renderTraffic(true);
  const auto = h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: tr.autoRefresh }), ` ${t('net.autoRefresh')}`);
  (auto.firstChild as HTMLInputElement).onchange = (e) => void api.invoke('ui:settings-set', { autoRefresh: (e.target as HTMLInputElement).checked });
  const offline = h('button', { class: 'btn small', text: t(state?.offline ? 'bar.goOnline' : 'net.goOffline') });
  offline.onclick = () => void api.invoke('ui:settings-set', { offline: !state?.offline });
  actions.append(refresh, auto, offline);
  body.append(actions);
}

function renderAudio(body: HTMLElement): void {
  if (!state) return;
  const p = state.profile;
  const master = h('input', { type: 'range', min: '0', max: '100', value: String(p.audio.volume) });
  master.oninput = () => void api.invoke('ui:audio', { volume: Number(master.value) });
  const mute = h('button', { class: `btn small${p.audio.muted ? ' primary' : ''}`, text: t(p.audio.muted ? 'ui.unmute' : 'audio.muteProfile') });
  mute.onclick = () => void api.invoke('ui:audio', { muted: !p.audio.muted }).then(() => openPanel('audio', () => renderAudio($('panelBody')), t('panel.audio')));
  body.append(section('audio.profile', h('div', { class: 'row' }, icon('volume'), master, h('span', { text: `${p.audio.volume}%` })), mute));

  const out = h('select', {});
  out.append(h('option', { value: '', text: t('audio.systemDefault') }));
  navigator.mediaDevices?.enumerateDevices().then((devs) => {
    let i = 1;
    for (const d of devs.filter((x) => x.kind === 'audiooutput' && x.deviceId !== 'default')) {
      const o = h('option', { value: d.deviceId, text: d.label || `${t('audio.device')} ${i++}` });
      if (d.deviceId === p.audio.outputDeviceId) o.selected = true;
      out.append(o);
    }
  }).catch(() => undefined);
  out.onchange = () => void api.invoke('ui:audio', { outputDeviceId: out.value });
  body.append(section('audio.output', out, h('p', { class: 'muted small', text: t('audio.outputNote') })));

  const list = h('div', { class: 'mixer' });
  const tabs = state.tabs.filter((x) => x.audible || x.muted || x.volume !== 100);
  if (!tabs.length) list.append(h('p', { class: 'muted', text: t('audio.nothingPlaying') }));
  for (const tab of tabs) {
    const r = h('input', { type: 'range', min: '0', max: '100', value: String(tab.volume) });
    r.oninput = () => void api.invoke('ui:tab', tab.id, 'volume', Number(r.value));
    const m = h('button', { class: 'icon-btn small', title: t(tab.muted ? 'ui.unmute' : 'ui.mute') }, icon(tab.muted ? 'mute' : 'volume', 14));
    m.onclick = () => void api.invoke('ui:tab', tab.id, 'mute');
    const go = h('button', { class: 'linkish', text: tab.title || tab.url });
    go.onclick = () => void api.invoke('ui:tab', tab.id, 'activate');
    list.append(h('div', { class: 'mix-row' }, go, h('div', { class: 'row' }, m, r, h('span', { class: 'small', text: `${tab.volume}%` }))));
  }
  body.append(section('audio.tabs', list), h('p', { class: 'muted small', text: t('audio.noEqualizer') }));
}

interface PrivacyInfo {
  settings: Record<string, unknown> & { level: string };
  issues: Array<{ key: string; severity: 'info' | 'warn' }>;
  profile: ProfileInfo;
  sandbox: { mode: string; clipboard: string; camera: boolean; microphone: boolean; externalDevices: boolean };
}

async function renderPrivacy(body: HTMLElement): Promise<void> {
  const info = await api.invoke<PrivacyInfo>('ui:privacy');
  const s = info.settings;
  const hasWarn = info.issues.some((i) => i.severity === 'warn');
  body.append(h('div', { class: `hero ${hasWarn ? 'warn' : 'ok'}` }, icon(hasWarn ? 'shieldAlert' : 'shieldCheck', 28), h('div', {}, h('b', { text: t(hasWarn ? 'status.attention' : 'status.protectionActive') }), h('div', { class: 'small muted', text: t('status.noGuarantee') }))));

  const lvl = h('div', { class: 'seg' });
  for (const l of ['normal', 'standard', 'strict'] as const) {
    const b = h('button', { class: s.level === l ? 'on' : '', text: t(`level.${l}`), disabled: info.profile.kind === 'tor' });
    b.onclick = () => void api.invoke('ui:set-level', l).then(() => openPanel('privacy', () => void renderPrivacy($('panelBody')), t('panel.privacy'))).catch((e: Error) => toast('err.generic', { message: e.message }));
    lvl.append(b);
  }
  body.append(section('privacy.level', lvl, h('p', { class: 'small muted', text: t(`level.${s.level}.desc`) })));

  const rows: Array<[string, boolean | string]> = [
    ['privacy.blockAds', s.blockAds as boolean], ['privacy.blockTrackers', s.blockTrackers as boolean],
    ['privacy.httpsOnly', s.httpsOnly as boolean], ['privacy.3pCookies', s.blockThirdPartyCookies as boolean],
    ['privacy.stripParams', s.stripTrackingParams as boolean], ['privacy.bounce', s.blockBounceTracking as boolean],
    ['privacy.webrtc', t(`webrtc.${s.webrtc as string}`)], ['privacy.canvas', t(`canvas.${s.canvas as string}`)],
    ['privacy.webgl', t(`webgl.${s.webgl as string}`)], ['privacy.hardware', t(`hardware.${s.hardwareApis as string}`)],
    ['privacy.autoplay', s.blockAutoplay as boolean], ['privacy.popups', s.blockPopups as boolean],
    ['privacy.referrer', s.trimReferrer as boolean], ['privacy.gpc', s.globalPrivacyControl as boolean],
    ['privacy.clearOnExit', s.clearOnExit as boolean], ['privacy.redirects', s.confirmCrossSiteRedirects as boolean],
  ];
  const list = h('div', {});
  for (const [k, v] of rows) list.append(kv(k, typeof v === 'boolean' ? badge(v ? 'ok' : 'info', v ? 'state.on' : 'state.off') : v));
  body.append(section('privacy.active', list, h('p', { class: 'small muted', text: t('privacy.consistentNote') })));

  const sb = info.sandbox;
  body.append(section('privacy.sandbox',
    kv('iso.mode', t(`iso.mode.${sb.mode}`)),
    kv('iso.clipboard', t(`iso.clipboard.${sb.clipboard}`)),
    kv('iso.camera', t(sb.camera ? 'state.askFirst' : 'state.blocked')),
    kv('iso.microphone', t(sb.microphone ? 'state.askFirst' : 'state.blocked')),
    kv('iso.devices', t(sb.externalDevices ? 'state.askFirst' : 'state.blocked')),
  ));
  const relaunch = h('button', { class: 'btn small', text: t('privacy.openInWsb') });
  relaunch.onclick = () => void api.invoke('ui:sandbox-relaunch');
  body.append(relaunch);

  if (info.issues.length) {
    const ul = h('ul', { class: 'issues' });
    for (const i of info.issues) ul.append(h('li', { class: i.severity, text: t(i.key) }));
    body.append(section('privacy.issues', ul));
  }
  const clearBtn = h('button', { class: 'btn small danger', text: t('privacy.clearData') });
  clearBtn.onclick = () => void api.invoke('ui:clear-data').then(() => toast('toast.dataCleared'));
  const detect = h('button', { class: 'btn small', text: t('privacy.runDetect') });
  detect.onclick = () => void api.invoke('ui:open-detect');
  body.append(h('div', { class: 'row' }, clearBtn, detect), h('p', { class: 'note small', text: t('security.malwareNotice') }));
}

function renderAddons(body: HTMLElement): void {
  if (!state) return;
  const enabled = new Set(state.profile.addons);
  const isTor = state.profile.level === 'tor';
  body.append(h('p', { class: 'small muted', text: t('addons.intro') }));
  for (const a of addons) {
    const on = enabled.has(a.id);
    const sw = h('input', { type: 'checkbox', checked: on, disabled: isTor || a.kind === 'external-app' });
    sw.onchange = () => {
      if (sw.checked && !confirmPermissions(a)) { sw.checked = false; return; }
      void api.invoke('ui:addon', a.id, sw.checked);
    };
    const perms = h('ul', { class: 'small' });
    for (const p of a.permissions) perms.append(h('li', { text: L(p) }));
    const details = h('details', {}, h('summary', { text: t('addons.details') }),
      kv('addons.version', a.version), kv('addons.license', a.license), kv('addons.source', a.source),
      kv('addons.status', t(`addons.status.${a.status}`)), h('div', { class: 'small', text: `${t('addons.permissions')}:` }), perms,
      h('div', { class: 'small muted', text: `${t('addons.integrity')}: ${L(a.integrity)}` }));
    body.append(h('div', { class: 'addon' },
      h('div', { class: 'addon-head' }, h('b', { text: a.name }), h('label', { class: 'switch' }, sw, h('span', {}))),
      h('div', { class: 'small', text: L(a.description) }), details));
  }
  if (isTor) body.append(h('p', { class: 'note small', text: t('addons.torNote') }));
}

function confirmPermissions(a: AddonInfo): boolean {
  // A panel-embedded confirmation keeps page content visible; window.confirm is modal and simple.
  return window.confirm(`${a.name}\n\n${t('addons.permissions')}:\n- ${a.permissions.map(L).join('\n- ')}\n\n${t('addons.confirmEnable')}`);
}

async function renderDownloads(body: HTMLElement): Promise<void> {
  const list = await api.invoke<DownloadInfo[]>('ui:downloads');
  for (const d of list) downloads.set(d.id, d);
  if (!list.length) body.append(h('p', { class: 'muted', text: t('dl.empty') }));
  for (const d of list) {
    const pct = d.total > 0 ? Math.round((d.received / d.total) * 100) : 0;
    const row = h('div', { class: 'dl' }, h('b', { text: d.fileName }), h('div', { class: 'small muted', text: `${t(`dl.state.${d.state}`)} · ${bytes(d.received)}${d.total ? ` / ${bytes(d.total)}` : ''}` }));
    if (d.state === 'progressing' || d.state === 'paused') row.append(h('progress', { max: '100', value: String(pct) }));
    const acts = h('div', { class: 'row' });
    const act = (key: string, action: string) => {
      const b = h('button', { class: 'btn small', text: t(key) });
      b.onclick = () => void api.invoke('ui:download-action', d.id, action).then(() => openPanel('downloads', () => void renderDownloads($('panelBody')), t('panel.downloads')));
      acts.append(b);
    };
    if (d.state === 'progressing') { act('dl.pause', 'pause'); act('common.cancel', 'cancel'); }
    if (d.state === 'paused') { act('dl.resume', 'resume'); act('common.cancel', 'cancel'); }
    if (d.state === 'completed') act('dl.show', 'show');
    if (d.dangerous) row.append(h('div', { class: 'small warn', text: t('dl.dangerous') }));
    row.append(acts);
    body.append(row);
  }
  const folder = h('button', { class: 'btn small', text: t('dl.openFolder') });
  folder.onclick = () => void api.invoke('ui:download-action', '', 'open-folder');
  body.append(folder);
}

async function renderBookmarks(body: HTMLElement): Promise<void> {
  const list = await api.invoke<Array<{ id: string; title: string; url: string; folder?: string }>>('ui:bookmarks');
  const hist = h('button', { class: 'btn small', text: t('panel.history') });
  hist.onclick = () => openPanel('history');
  body.append(hist);
  if (!list.length) body.append(h('p', { class: 'muted', text: t('bm.empty') }));
  for (const b of list) {
    const go = h('button', { class: 'linkish', text: b.title || b.url, title: b.url });
    go.onclick = () => openLink(b.url);
    const del = h('button', { class: 'icon-btn tiny', title: t('common.delete') }, icon('trash', 13));
    del.onclick = () => void api.invoke('ui:bookmark-remove', b.id).then(() => openPanel('bookmarks', () => void renderBookmarks($('panelBody')), t('panel.bookmarks')));
    body.append(h('div', { class: 'kv' }, go, del));
  }
}

async function renderHistory(body: HTMLElement, q: string): Promise<void> {
  const list = await api.invoke<Array<{ url: string; title: string; visitedAt: string }>>('ui:history', q);
  const search = h('input', { type: 'text', placeholder: t('hist.search'), value: q });
  let timer = 0;
  search.oninput = () => { window.clearTimeout(timer); timer = window.setTimeout(() => { clear(body); void renderHistory(body, search.value); }, 250); };
  body.append(search);
  if (state && !list.length) body.append(h('p', { class: 'muted', text: t('hist.emptyOrOff') }));
  for (const e of list) {
    const go = h('button', { class: 'linkish', text: e.title || e.url, title: e.url });
    go.onclick = () => openLink(e.url);
    body.append(h('div', { class: 'kv' }, go, h('span', { class: 'small muted', text: new Date(e.visitedAt).toLocaleString() })));
  }
  const clr = h('button', { class: 'btn small danger', text: t('hist.clear') });
  clr.onclick = () => void api.invoke('ui:history-clear').then(() => { clear(body); void renderHistory(body, ''); });
  body.append(clr);
  if (q) requestAnimationFrame(() => { search.focus(); search.setSelectionRange(q.length, q.length); });
}

function renderUpdates(body: HTMLElement): void {
  const u = state?.update;
  if (!u || !u.configured) body.append(h('p', { class: 'note small', text: t('upd.notConfigured') }));
  body.append(kv('upd.current', u?.current ?? '-'), kv('upd.latest', u?.latest ?? t('state.unknown')));
  if (u?.available) {
    body.append(kv('upd.severity', t(`upd.sev.${u.severity ?? 'normal'}`)));
    if (u.changelog) body.append(section('upd.changelog', h('pre', { class: 'changelog', text: L(u.changelog) })));
  }
  if (u?.lastCheckAt) body.append(kv('upd.lastCheck', new Date(u.lastCheckAt).toLocaleString()));
  if (u?.error) body.append(h('p', { class: 'err small', text: u.error }));
  const check = h('button', { class: 'btn small', text: t('upd.checkNow') });
  check.onclick = () => void api.invoke('ui:updates-check').then(() => toast('upd.checking'));
  const manage = h('button', { class: 'btn small primary', text: t('upd.manage') });
  manage.onclick = () => void api.invoke('ui:open-launcher');
  body.append(h('div', { class: 'row' }, check, manage), h('p', { class: 'small muted', text: t('upd.policy') }));
}

function renderShortcuts(body: HTMLElement): void {
  for (const [keys, key] of shortcuts) body.append(h('div', { class: 'kv' }, h('span', { class: 'k', text: t(key) }), h('kbd', { text: keys })));
}

function renderMenu(body: HTMLElement): void {
  const item = (key: string, ic: string, run: () => void) => {
    const b = h('button', { class: 'menu-item' }, icon(ic, 16), ` ${t(key)}`);
    b.onclick = () => { openPanel(null); run(); };
    body.append(b);
  };
  item('ui.newTab', 'plus', () => void api.invoke('ui:new-tab'));
  item('menu.newWindow', 'copy', () => void api.invoke('ui:new-window'));
  item('menu.switchProfile', 'users', () => void api.invoke('ui:open-launcher'));
  item('panel.bookmarks', 'bookmark', () => openPanel('bookmarks'));
  item('panel.history', 'history', () => openPanel('history'));
  item('panel.downloads', 'download', () => openPanel('downloads'));
  item('ui.find', 'search', openFind);
  item('ui.searchTabs', 'search', openTabSearch);
  item('menu.split', 'split', () => void api.invoke('ui:command', 'split'));
  item('menu.pip', 'pip', () => void api.invoke('ui:command', 'pip'));
  item(state?.verticalTabs ? 'menu.horizontalTabs' : 'menu.verticalTabs', 'menu', () => void api.invoke('ui:settings-set', { verticalTabs: !state?.verticalTabs }));
  item(state?.showBookmarksBar ? 'menu.hideBookmarksBar' : 'menu.showBookmarksBar', 'bookmark', () => void api.invoke('ui:settings-set', { showBookmarksBar: !state?.showBookmarksBar }));
  item('menu.zoomIn', 'plus', () => void api.invoke('ui:command', 'zoom-in'));
  item('menu.zoomOut', 'close', () => void api.invoke('ui:command', 'zoom-out'));
  item('menu.print', 'file', () => void api.invoke('ui:command', 'print'));
  item('privacy.runDetect', 'fingerprint', () => void api.invoke('ui:open-detect'));
  item('panel.shortcuts', 'info', () => openPanel('shortcuts'));
  item('menu.settings', 'settings', () => void api.invoke('ui:open-launcher'));
  body.append(h('p', { class: 'small muted', text: `OctoBrowser.su ${state?.update?.current ?? ''}` }));
}

// ------------------------------------------------------------------ events

function handleCommand(cmd: string): void {
  switch (cmd) {
    case 'focus-address': { const a = $<HTMLInputElement>('address'); a.focus(); a.select(); break; }
    case 'find': openFind(); break;
    case 'search-tabs': openTabSearch(); break;
    case 'panel-audio': openPanel('audio'); break;
    case 'panel-traffic': openPanel('traffic'); break;
    case 'panel-privacy': openPanel('privacy'); break;
    case 'panel-downloads': openPanel('downloads'); break;
    case 'panel-bookmarks': openPanel('bookmarks'); break;
    default: break;
  }
}

/** The chrome colour scheme is a per-profile setting, never per launch. */
function applyTheme(theme: 'dark' | 'light' | undefined): void {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
}

/** Minimal "closing" overlay shown instead of cutting the process short. */
function showCloseVeil(info: { tabs: number; restoreSession: boolean }): void {
  const veil = $('closeveil');
  $('cvTitle').textContent = t('close.title');
  $('cvBody').textContent = info.restoreSession
    ? t('close.saving', { n: info.tabs })
    : t('close.nosave', { n: info.tabs });
  $('cvForce').textContent = t('close.force');
  $('cvWarn').textContent = t('close.forceWarn');
  $('cvKeep').textContent = t('close.keepOpen');
  veil.classList.remove('hidden');
  const force = $<HTMLButtonElement>('cvForce');
  force.onclick = () => { force.disabled = true; void api.invoke('ui:close-ok', true); };
  $('cvKeep').onclick = () => veil.classList.add('hidden');
}

/** Open a link from bookmarks / history, in the background when the setting says so. */
function openLink(url: string): void {
  void api.invoke('ui:new-tab', url, state?.openLinksInBackground === true);
}

/** Bookmark bar under the address bar (Settings > Tabs). */
async function renderBookbar(): Promise<void> {
  const bar = $('bookbar');
  if (!state?.showBookmarksBar) { bar.classList.add('hidden'); clear(bar); return; }
  bar.classList.remove('hidden');
  const list = await api.invoke<Array<{ id: string; title: string; url: string }>>('ui:bookmarks');
  clear(bar);
  if (!list.length) {
    bar.append(h('span', { class: 'bb-empty', text: t('bm.empty') }));
    return;
  }
  for (const b of list.slice(0, 24)) {
    const btn = h('button', { class: 'bb', text: b.title || b.url, title: b.url });
    btn.onclick = () => openLink(b.url);
    bar.append(btn);
  }
  bar.append(h('button', { class: 'bb bb-more', text: '\u2026', title: t('panel.bookmarks') }));
  const more = bar.lastElementChild as HTMLButtonElement;
  more.onclick = () => openPanel('bookmarks');
}

function initEvents(): void {
  api.on<WinState>('ui:state', (s) => {
    state = s;
    applyTheme(s.profile.theme as 'dark' | 'light' | undefined);
    renderTabs();
    renderAddress();
    renderStatus();
    void renderBookbar();
    if (panel === 'audio' || panel === 'addons' || panel === 'updates') openPanel(panel, () => void renderPanel(panel!), t(`panel.${panel}`));
  });
  api.on<TabState>('ui:tab', (tab) => {
    if (!state) return;
    const i = state.tabs.findIndex((x) => x.id === tab.id);
    if (i >= 0) state.tabs[i] = tab;
    renderTabs();
    if (tab.id === state.activeId) renderAddress();
    renderStatus();
  });
  api.on<{ active: number; total: number }>('ui:found', (r) => { $('findCount').textContent = r.total ? `${r.active}/${r.total}` : t('find.none'); });
  api.on<{ key: string; params?: Record<string, string> }>('ui:toast', (m) => toast(m.key, m.params));
  api.on<string>('ui:command', handleCommand);
  api.on('ui:focus-address', () => handleCommand('focus-address'));
  api.on<{ tabs: number; restoreSession: boolean }>('ui:close-request', showCloseVeil);
  api.on<{ kind: string; origin: string; reqId: string }>('ui:permission', (q) => {
    pushBar({
      id: q.reqId, kind: 'ask', text: t('perm.ask', { origin: q.origin, what: t(`perm.${q.kind}`) }),
      actions: [
        { key: 'perm.allow', primary: true, run: () => void api.invoke('ui:answer', q.reqId, true) },
        { key: 'perm.deny', run: () => void api.invoke('ui:answer', q.reqId, false) },
      ],
    });
  });
  api.on<{ fileName: string; reqId: string }>('ui:confirm-download', (q) => {
    pushBar({
      id: q.reqId, kind: 'warn', text: t('dl.confirmDangerous', { file: q.fileName }),
      actions: [
        { key: 'dl.keep', run: () => void api.invoke('ui:answer', q.reqId, true) },
        { key: 'common.cancel', primary: true, run: () => void api.invoke('ui:answer', q.reqId, false) },
      ],
    });
  });
  api.on<DownloadInfo>('ui:download', (d) => {
    const prev = downloads.get(d.id);
    downloads.set(d.id, d);
    if (!prev && d.state === 'progressing') toast('dl.started', { file: d.fileName });
    if (prev?.state !== 'completed' && d.state === 'completed') toast('dl.done', { file: d.fileName });
    renderStatus();
    if (panel === 'downloads') openPanel('downloads', () => void renderDownloads($('panelBody')), t('panel.downloads'));
  });

  // Keyboard shortcuts while the chrome UI has focus (tabs forward keys via the main process).
  window.addEventListener('keydown', (e) => {
    const inInput = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
    if (e.key === 'Escape') {
      if (overlay) { setOverlay(false); return; }
      if (!$('findbar').classList.contains('hidden')) { closeFind(); return; }
      if (panel) { openPanel(null); return; }
    }
    const cmd = commandFor({ key: e.key, control: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey });
    if (!cmd) return;
    if (inInput && !e.ctrlKey && !e.altKey && !/^F\d+$/.test(e.key)) return; // typing
    if (inInput && e.ctrlKey && ['c', 'v', 'x', 'a', 'z', 'y'].includes(e.key.toLowerCase()) && !e.shiftKey) return;
    e.preventDefault();
    const local = ['focus-address', 'find', 'search-tabs', 'panel-audio', 'panel-traffic', 'panel-privacy', 'panel-downloads', 'panel-bookmarks'];
    if (local.includes(cmd)) handleCommand(cmd);
    else void api.invoke('ui:command', cmd);
  });
}

// ------------------------------------------------------------------ boot

async function boot(): Promise<void> {
  const init = await api.invoke<{ lang: 'en' | 'pl'; dicts: Dicts; version: string; shortcuts: Array<[string, string]>; addons: AddonInfo[]; theme: 'dark' | 'light' }>('ui:init');
  setDicts(init.dicts);
  setLang(init.lang);
  addons = init.addons;
  shortcuts = init.shortcuts;
  applyTheme(init.theme);
  applyI18n();
  initToolbar();
  initFind();
  initEvents();
  reportLayout();
  await api.invoke('ui:ready');
}

boot().catch((err) => {
  document.body.append(h('pre', { class: 'fatal', text: `OctoBrowser UI error: ${String((err as Error)?.message ?? err)}` }));
});
