/**
 * apps/octobrowser/src/renderer/launcher-ui.ts
 *
 * Shared state, types and small UI building blocks of the launcher
 * (modal, toasts, segmented buttons, popup menus, tag input...).
 */
import { clear } from '@octo/shell/renderer/bridge';
import { h, t, getLang, Dicts } from '@octo/shell/renderer/i18n-client';
import { icon } from '@octo/shell/renderer/icons';

// ------------------------------------------------------------------ types

export type Kind = 'antidetect' | 'personal' | 'work' | 'private' | 'testing' | 'temporary' | 'tor' | 'custom';
export type Level = 'normal' | 'standard' | 'strict' | 'tor';
export type FpOs = 'windows11' | 'windows10' | 'macos' | 'linux';
export type ProxyType = 'http' | 'https' | 'socks4' | 'socks5';

export interface Fingerprint {
  enabled: boolean; os: FpOs; userAgent: string; uaFullVersion: string; platformVersion: string;
  webrtc: { mode: 'off' | 'real' | 'disable-udp' | 'altered' | 'manual'; publicIp: string };
  canvas: 'off' | 'real' | 'noise'; webgl: 'off' | 'real' | 'noise';
  webglInfo: { mode: 'real' | 'manual'; vendor: string; renderer: string };
  webgpu: 'off' | 'real'; clientRects: 'real' | 'noise';
  timezone: { mode: 'auto' | 'manual' | 'real'; value: string };
  language: { mode: 'auto' | 'manual' | 'real'; value: string };
  geolocation: { mode: 'auto' | 'manual' | 'block'; latitude: number; longitude: number; accuracy: number };
  cpu: { mode: 'real' | 'manual'; cores: number }; memory: { mode: 'real' | 'manual'; gb: number };
  screen: { mode: 'real' | 'manual'; width: number; height: number };
  fonts: 'real' | 'noise'; audio: 'real' | 'noise';
  mediaDevices: { mode: 'real' | 'manual'; audioInputs: number; audioOutputs: number; videoInputs: number };
  ports: { mode: 'real' | 'protect'; list: string }; doNotTrack: boolean; seed: string;
}
export interface ProxyCheck { ok: boolean; at: string; ip?: string; country?: string; countryCode?: string; region?: string; city?: string; timezone?: string; latitude?: number; longitude?: number; latencyMs?: number; error?: string }
export interface ProfileProxy { type: ProxyType; host: string; port: number; changeIpUrl: string; name: string; savedId: string }
export interface Profile {
  id: string; name: string; kind: Kind; color: string; createdAt: string; updatedAt: string;
  protection: { level: Level; overrides?: Record<string, unknown> };
  network: { mode: 'system' | 'direct' | 'proxy'; proxyRules?: string; proxyBypass?: string; hasProxyCredentials?: boolean; proxy?: ProfileProxy };
  dns: { mode: 'inherit' | 'system' | 'doh'; dohTemplate: string };
  sandbox: { mode: 'none' | 'restricted' | 'windows-sandbox'; clipboard: 'allow' | 'write-only' | 'block'; camera: boolean; microphone: boolean; externalDevices: boolean; shareDownloads: boolean };
  audio: { muted: boolean; volume: number; outputDeviceId: string };
  addons: string[]; encrypted: boolean; deleteOnClose: boolean; keepHistory: boolean; restoreSession: boolean; homePage: string;
  theme: 'dark' | 'light'; fingerprint: Fingerprint; tags: string[]; folder: string; status: string; notes: string; startPages: string[];
  proxyCheck?: ProxyCheck; stats: { launches: number; lastLaunchAt: string; worktimeSec: number };
  // runtime info from the manager
  running: boolean; ready: boolean; stopping: boolean; startedAt: number; sealed: boolean; hasVault: boolean; needsResealing: boolean;
  issues: Array<{ key: string; severity: string }>; hasProxyCredentials: boolean; fingerprintWarnings: string[];
}
export interface SavedProxy { id: string; name: string; type: ProxyType; host: string; port: number; hasCredentials: boolean; changeIpUrl: string; createdAt: string; lastCheck?: ProxyCheck }
export interface AddonInfo { id: string; name: string; description: { en: string; pl: string }; version: string; license: string; permissions: Array<{ en: string; pl: string }>; source: string; kind: string; status: string; integrity: { en: string; pl: string } }
export interface UpdateStatus {
  configured: boolean; current: string; latest: string | null; available: boolean; severity?: string; changelog?: { en: string; pl: string };
  components?: string[]; requiresRestart?: boolean; lastCheckAt?: string; lastResult?: string; error?: string;
  downloading?: { done: number; total: number }; readyToInstall?: string; rollbackAvailable: string[];
}
export interface Settings {
  updates: { autoCheck: boolean; backgroundCheck: boolean; channel: 'stable' | 'beta' };
  network: { publicIpLookup: boolean; autoRefresh: boolean; searchEngine: string; dns: { mode: 'system' | 'doh'; provider: string; customTemplate: string } };
  security: { autoLockMinutes: number; secretStore: 'local' | 'credman' }; logs: { mode: 'standard' | 'diagnostic' };
  ui: { verticalTabs: boolean; sleepTabsAfterMin: number; showStartupSplash: boolean; showBookmarksBar: boolean; confirmOnQuit: boolean; openLinksInBackground: boolean };
  tor: { torBrowserPath: string }; offline: boolean; api: { enabled: boolean; port: number };
}
export interface Init {
  lang: 'en' | 'pl'; dicts: Dicts; version: string; dataDir: string; addons: AddonInfo[]; kinds: Kind[];
  windowsSandbox: boolean; torBrowser: boolean; settings: Settings; update: UpdateStatus; logMode: 'standard' | 'diagnostic'; filtersUpdatedAt: string | null;
  keyringMode: 'os' | 'password' | null; keyringRequiresPassword: boolean; secretBackend: 'local' | 'credman'; credmanAvailable: boolean;
}
export type View = 'profiles' | 'proxies' | 'security' | 'updates' | 'settings' | 'api' | 'logs' | 'about';

/** Mutable launcher state shared by all views. */
export const S = {
  init: undefined as unknown as Init,
  profiles: [] as Profile[],
  proxies: [] as SavedProxy[],
  view: 'profiles' as View,
  folder: '' as string,
  search: '',
  tagFilter: '',
  selected: new Set<string>(),
  proxySelected: new Set<string>(),
  render: () => {},
};

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
export const L = (o: { en: string; pl: string }) => o[getLang()] ?? o.en;
export const tv = (v: string) => (v.startsWith('t:') ? t(v.slice(2)) : v);

// ------------------------------------------------------------------ toasts / errors

export function toast(text: string, kind: 'ok' | 'err' | 'info' = 'info'): void {
  const el = h('div', { class: `toast ${kind}`, role: kind === 'err' ? 'alert' : 'status' }, icon(kind === 'ok' ? 'check' : kind === 'err' ? 'alert' : 'info', 16), h('span', { text }));
  $('toasts').append(el);
  setTimeout(() => el.remove(), kind === 'err' ? 7000 : 4500);
}

/** Error messages from the main process may be i18n keys (proxy.err.*). */
export function errText(err: unknown): string {
  const m = String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  return /^[a-z]+(\.[a-zA-Z0-9]+)+$/.test(m) ? t(m) : m;
}

export async function run<T>(p: Promise<T>, okKey?: string): Promise<T | undefined> {
  try {
    const r = await p;
    if (okKey) toast(t(okKey), 'ok');
    return r;
  } catch (err) {
    toast(errText(err), 'err');
    return undefined;
  }
}

// ------------------------------------------------------------------ modal

let modalOnClose: (() => void) | null = null;

export function closeModal(): void {
  $('modal').classList.add('hidden');
  clear($('modalBox'));
  const f = modalOnClose;
  modalOnClose = null;
  f?.();
}

export function modal(title: string, build: (box: HTMLElement) => void, size: '' | 'wide' | 'xwide' | 'editor' = '', onClose?: () => void): void {
  closePopup();
  const box = $('modalBox');
  clear(box);
  modalOnClose = onClose ?? null;
  box.className = `modal-box${size ? ` ${size}` : ''}`;
  const close = h('button', { class: 'icon-btn', title: t('common.close'), 'aria-label': t('common.close') }, icon('close', 18));
  close.onclick = closeModal;
  box.append(h('div', { class: 'modal-head' }, h('h2', { text: title }), close));
  build(box);
  $('modal').classList.remove('hidden');
  (box.querySelector('input:not([type=checkbox]),select,textarea,button.primary') as HTMLElement | null)?.focus();
}

export function confirmDialog(text: string, fn: () => Promise<unknown>, okKey: string, danger = true): void {
  modal(t('common.confirm'), (box) => {
    const ok = h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, text: t('common.confirm') });
    ok.onclick = async () => { if ((await run(fn(), okKey)) !== undefined) closeModal(); };
    const cancel = h('button', { class: 'btn', text: t('common.cancel') });
    cancel.onclick = closeModal;
    box.append(h('p', { text }), h('div', { class: 'modal-actions' }, cancel, ok));
  });
}

// ------------------------------------------------------------------ popup menu

let popupEl: HTMLElement | null = null;

export function closePopup(): void {
  popupEl?.remove();
  popupEl = null;
}

export interface MenuItem { icon: string; label: string; fn: () => void; danger?: boolean; disabled?: boolean }

/** Small dropdown menu anchored to a button; stays inside the window. */
export function popupMenu(anchor: HTMLElement, items: Array<MenuItem | 'sep'>): void {
  closePopup();
  const m = h('div', { class: 'popup', role: 'menu' });
  for (const it of items) {
    if (it === 'sep') { m.append(h('div', { class: 'popup-sep' })); continue; }
    const b = h('button', { class: `popup-item${it.danger ? ' danger' : ''}`, role: 'menuitem', disabled: !!it.disabled }, icon(it.icon, 16), h('span', { text: it.label }));
    b.onclick = (e) => { e.stopPropagation(); closePopup(); it.fn(); };
    m.append(b);
  }
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  const mw = m.offsetWidth;
  const mh = m.offsetHeight;
  let left = r.left;
  let top = r.bottom + 4;
  if (left + mw > innerWidth - 8) left = Math.max(8, r.right - mw);
  if (top + mh > innerHeight - 8) top = Math.max(8, r.top - mh - 4);
  m.style.left = `${left}px`;
  m.style.top = `${top}px`;
  popupEl = m;
  (m.querySelector('button:not(:disabled)') as HTMLElement | null)?.focus();
}

document.addEventListener('mousedown', (e) => { if (popupEl && !popupEl.contains(e.target as Node)) closePopup(); });
window.addEventListener('resize', closePopup);
document.addEventListener('scroll', closePopup, true);

// ------------------------------------------------------------------ form controls

export function field(labelKey: string, control: HTMLElement, hintKey?: string, hintRaw?: string): HTMLElement {
  return h('label', { class: 'field' }, h('span', { class: 'lbl', text: t(labelKey) }), control, hintKey || hintRaw ? h('span', { class: 'hint', text: hintRaw ?? t(hintKey!) }) : null);
}

export function select<T extends string>(value: T, options: Array<[T, string]>, onChange?: (v: T) => void): HTMLSelectElement {
  const s = h('select', {});
  for (const [v, label] of options) {
    const o = h('option', { value: v, text: label });
    if (v === value) o.selected = true;
    s.append(o);
  }
  if (onChange) s.onchange = () => onChange(s.value as T);
  return s;
}

export function input(value: string, attrs: Record<string, string> = {}, onInput?: (v: string) => void): HTMLInputElement {
  const el = h('input', { type: 'text', ...attrs });
  el.value = value;
  if (onInput) el.oninput = () => onInput(el.value);
  return el;
}

export function toggle(checked: boolean, labelKey: string, onChange?: (v: boolean) => void, disabled = false): HTMLElement {
  const inp = h('input', { type: 'checkbox', checked, disabled });
  // The state is written out as text as well, so it never depends on the switch colour alone.
  const state = h('span', { class: 'sw-state', text: t(checked ? 'state.on' : 'state.off') });
  if (onChange) inp.onchange = () => { onChange(inp.checked); state.textContent = t(inp.checked ? 'state.on' : 'state.off'); };
  return h('label', { class: 'toggle' }, inp, h('span', { class: 'sw' }), h('span', { text: t(labelKey) }), state);
}

/** Segmented button group (like the "Off / Real / Noise" chips of the reference UI). */
export function seg<T extends string>(value: T, options: Array<[T, string] | [T, string, string]>, onChange: (v: T) => void, cls = ''): HTMLElement {
  const g = h('div', { class: `seg ${cls}`, role: 'radiogroup' });
  for (const o of options) {
    const [v, label, ic] = o as [T, string, string?];
    const b = h('button', { type: 'button', class: v === value ? 'on' : '', role: 'radio', 'aria-checked': String(v === value) }, ic ? icon(ic, 15) : null, h('span', { text: label }));
    b.onclick = () => {
      g.querySelectorAll('button').forEach((x) => { x.classList.remove('on'); x.setAttribute('aria-checked', 'false'); });
      b.classList.add('on');
      b.setAttribute('aria-checked', 'true');
      onChange(v);
    };
    g.append(b);
  }
  return g;
}

/** Row of the advanced fingerprint editor: label on the left, controls on the right. */
export function frow(label: string, ...controls: Array<HTMLElement | null>): HTMLElement {
  return h('div', { class: 'frow' }, h('div', { class: 'frow-l', text: label }), h('div', { class: 'frow-r' }, ...controls));
}

/** Tag input: type + Enter/comma adds a chip; click x removes it. */
export function tagInput(tags: string[], onChange: (tags: string[]) => void, suggestions: string[] = []): HTMLElement {
  const wrap = h('div', { class: 'tag-input' });
  const list = [...tags];
  const dl = `tags-${Math.random().toString(36).slice(2)}`;
  const inp = h('input', { type: 'text', placeholder: t('ui.tagsPh'), list: dl, maxlength: '32' });
  const data = h('datalist', { id: dl });
  for (const s of suggestions) data.append(h('option', { value: s }));
  const draw = () => {
    wrap.querySelectorAll('.tag').forEach((x) => x.remove());
    for (const tg of list) {
      const x = h('button', { type: 'button', class: 'tag-x', 'aria-label': t('common.remove') }, icon('close', 12));
      x.onclick = () => { list.splice(list.indexOf(tg), 1); onChange([...list]); draw(); };
      wrap.insertBefore(h('span', { class: 'tag' }, h('span', { text: tg }), x), inp);
    }
  };
  const add = () => {
    for (const part of inp.value.split(',')) {
      const v = part.trim();
      if (v && !list.includes(v) && list.length < 20) list.push(v);
    }
    inp.value = '';
    onChange([...list]);
    draw();
  };
  inp.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); }
    if (e.key === 'Backspace' && !inp.value && list.length) { list.pop(); onChange([...list]); draw(); }
  };
  inp.onblur = () => { if (inp.value.trim()) add(); };
  wrap.append(inp, data);
  wrap.onclick = (e) => { if (e.target === wrap) inp.focus(); };
  draw();
  return wrap;
}

// ------------------------------------------------------------------ formatting

export function osIcon(os: FpOs | undefined, size = 16): SVGSVGElement {
  return icon(os === 'macos' ? 'apple' : os === 'linux' ? 'linux' : 'windows', size, `os-ic os-${os ?? 'windows11'}`);
}

export function osLabel(os: FpOs): string {
  return t(`fp.os.${os}`);
}

/** Emoji flag from an ISO country code (renders as letters where the font has no flags). */
export function flag(code?: string): string {
  if (!code || !/^[a-z]{2}$/i.test(code)) return '';
  return String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

export function fmtDuration(sec: number): string {
  sec = Math.max(0, Math.floor(sec));
  const d = Math.floor(sec / 86400);
  const hh = String(Math.floor((sec % 86400) / 3600)).padStart(2, '0');
  const mm = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
  const ss = String(sec % 60).padStart(2, '0');
  return `${d ? `${d}d ` : ''}${hh}:${mm}:${ss}`;
}

export function worktime(p: Profile): number {
  const base = p.stats?.worktimeSec ?? 0;
  return p.running && p.startedAt ? base + (Date.now() - p.startedAt) / 1000 : base;
}

export function proxyText(px: { type: string; host: string; port: number }): string {
  return `${px.type}://${px.host}:${px.port}`;
}

export function checkLine(c: ProxyCheck | undefined): HTMLElement {
  if (!c) return h('span', { class: 'chk none', text: t('proxy.notChecked') });
  if (!c.ok) return h('span', { class: 'chk bad', title: c.error ?? '' }, icon('alert', 13), h('span', { text: `${t('proxy.failed')}${c.error ? `: ${errText(c.error)}` : ''}` }));
  const where = [c.city, c.countryCode?.toUpperCase()].filter(Boolean).join(', ');
  return h('span', { class: 'chk ok', title: [c.country, c.region, c.city, c.timezone].filter(Boolean).join(' · ') },
    c.countryCode ? h('span', { class: 'cc', text: c.countryCode.toUpperCase() }) : null, h('span', { text: `${c.ip ?? ''}${where ? ` · ${where}` : ''}${c.latencyMs ? ` · ${c.latencyMs} ms` : ''}` }));
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', {});
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(t('ui.copied'), 'ok');
}
