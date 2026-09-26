/**
 * apps/octobrowser/src/renderer/launcher-editor.ts
 *
 * Create / edit profile dialog (one dialog for both):
 *   General  - name, status, tags, folder, profile type, start pages, proxy
 *              (No proxy / New proxy with format auto-detection + check /
 *              Saved proxy)
 *   Advanced - fingerprint: OS, user agent, WebRTC, Canvas, WebGL (+ vendor /
 *              renderer), WebGPU, ClientRects, timezone, language, geolocation,
 *              CPU, memory, screen, fonts, audio, media devices, ports, DNT
 *   Browser  - protection level + individual switches, start page, history,
 *              session, theme, DNS, isolation, add-ons
 *   Notes
 * with a live SUMMARY on the right ("NEW FINGERPRINT" renews the device).
 */
import { api, clear } from '@octo/shell/renderer/bridge';
import { h, t } from '@octo/shell/renderer/i18n-client';
import { icon } from '@octo/shell/renderer/icons';
import { parseProxy } from '@octo/core/proxy';
import {
  S, Profile, Kind, Level, FpOs, Fingerprint, ProxyType, ProxyCheck, SavedProxy, run, toast, errText, modal, closeModal, field, input, select, toggle,
  seg, frow, tagInput, osLabel, proxyText, checkLine, L, copyText,
} from './launcher-ui';
import { allFolders, STATUSES } from './launcher-profiles';

// ------------------------------------------------------------------ draft

type ProxyMode = 'none' | 'new' | 'saved';
interface ProxyDraft { mode: ProxyMode; type: ProxyType; text: string; changeIpUrl: string; name: string; save: boolean; savedId: string; keep: boolean; check?: ProxyCheck }
type Sandbox = Profile['sandbox'];
interface Draft {
  name: string; kind: Kind; status: string; tags: string[]; folder: string; notes: string; startPages: string[];
  homePage: string; theme: 'dark' | 'light'; keepHistory: boolean; restoreSession: boolean; deleteOnClose: boolean;
  protection: { level: Level; overrides: Record<string, unknown> }; dns: Profile['dns']; sandbox: Sandbox; addons: string[];
  fp: Fingerprint | null; proxy: ProxyDraft;
  /** Exported cookies to import (JSON / Netscape), empty = none. */
  cookies: string;
}

const ANTI_ADDONS = ['audio-mixer'];

function kindDefaults(kind: Kind, addons: string[]): Pick<Draft, 'protection' | 'sandbox' | 'keepHistory' | 'restoreSession' | 'deleteOnClose' | 'addons'> {
  const anti = kind === 'antidetect';
  return {
    protection: { level: anti ? 'normal' : kind === 'tor' ? 'tor' : kind === 'private' || kind === 'temporary' ? 'strict' : 'standard', overrides: {} },
    sandbox: {
      mode: kind === 'testing' || kind === 'private' ? 'restricted' : 'none',
      clipboard: kind === 'private' || kind === 'temporary' ? 'write-only' : 'allow',
      camera: anti || kind === 'personal' || kind === 'work', microphone: anti || kind === 'personal' || kind === 'work',
      externalDevices: false, shareDownloads: false,
    },
    keepHistory: anti || kind === 'personal' || kind === 'work',
    restoreSession: anti || kind === 'personal' || kind === 'work',
    deleteOnClose: kind === 'temporary',
    addons: kind === 'tor' ? [] : anti ? ANTI_ADDONS : addons,
  };
}

function newDraft(): Draft {
  const folder = S.folder && S.folder !== '__none' ? S.folder : '';
  return {
    name: '', kind: 'antidetect', status: '', tags: [], folder, notes: '', startPages: [], homePage: '', theme: 'dark',
    dns: { mode: 'inherit', dohTemplate: '' },
    ...kindDefaults('antidetect', S.init.addons.filter((a) => a.kind !== 'external-app').map((a) => a.id)),
    fp: null,
    proxy: { mode: 'none', type: 'http', text: '', changeIpUrl: '', name: '', save: false, savedId: '', keep: false },
    cookies: '',
  };
}

function draftFrom(p: Profile): Draft {
  const px = p.network.proxy;
  let proxy: ProxyDraft = { mode: 'none', type: 'http', text: '', changeIpUrl: '', name: '', save: false, savedId: '', keep: false };
  if (p.network.mode === 'proxy') {
    if (px?.savedId && S.proxies.some((s) => s.id === px.savedId)) proxy = { ...proxy, mode: 'saved', savedId: px.savedId, keep: true, check: p.proxyCheck };
    else if (px) proxy = { ...proxy, mode: 'new', type: px.type, text: proxyText(px), changeIpUrl: px.changeIpUrl, name: px.name, keep: true, check: p.proxyCheck };
    else proxy = { ...proxy, mode: 'new', text: p.network.proxyRules ?? '', keep: true };
  }
  const c = structuredClone(p);
  return {
    name: c.name, kind: c.kind, status: c.status ?? '', tags: c.tags ?? [], folder: c.folder ?? '', notes: c.notes ?? '', startPages: c.startPages ?? [],
    homePage: c.homePage === 'octo://newtab' ? '' : c.homePage, theme: c.theme, keepHistory: c.keepHistory, restoreSession: c.restoreSession, deleteOnClose: c.deleteOnClose,
    protection: { level: c.protection.level, overrides: c.protection.overrides ?? {} }, dns: c.dns, sandbox: c.sandbox, addons: c.addons,
    fp: c.fingerprint?.enabled ? c.fingerprint : c.kind === 'antidetect' ? c.fingerprint : null, proxy, cookies: '',
  };
}

// ------------------------------------------------------------------ fingerprint data

interface GpuPreset { vendor: string; renderer: string }
const metaCache = new Map<FpOs, { gpus: GpuPreset[]; userAgent: string; engine: { major: number; full: string } }>();
async function meta(os: FpOs) {
  if (!metaCache.has(os)) {
    const m = await run(api.invoke<{ gpus: GpuPreset[]; userAgent: string; engine: { major: number; full: string } }>('mgr:fingerprint-meta', os));
    if (m) metaCache.set(os, m);
  }
  return metaCache.get(os);
}

const SCREENS: Record<'desktop' | 'mac', string[]> = {
  desktop: ['1920x1080', '1366x768', '1536x864', '1440x900', '1600x900', '1280x720', '1280x1024', '1680x1050', '1920x1200', '2560x1440', '2560x1080', '3440x1440', '3840x2160'],
  mac: ['1440x900', '1280x800', '1512x982', '1728x1117', '1680x1050', '1920x1080', '2560x1440', '2560x1600'],
};
const CORES = [2, 4, 6, 8, 10, 12, 16, 20, 24, 32];
const MEMORY = [1, 2, 4, 8];
const LANGS = ['en-US,en', 'en-GB,en', 'pl-PL,pl,en-US,en', 'de-DE,de,en-US,en', 'fr-FR,fr,en-US,en', 'es-ES,es,en-US,en', 'it-IT,it,en-US,en', 'uk-UA,uk,en-US,en', 'ru-RU,ru,en-US,en', 'pt-BR,pt,en-US,en', 'nl-NL,nl,en-US,en', 'tr-TR,tr,en-US,en', 'cs-CZ,cs,en-US,en', 'ja-JP,ja,en-US,en'];
function timezones(): string[] {
  try { return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone'); } catch { return ['UTC', 'Europe/Warsaw', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo']; }
}

// ------------------------------------------------------------------ privacy overrides

const PRESET_VALUES: Record<'normal' | 'standard' | 'strict', Record<string, string>> = {
  normal: { webrtc: 'default_public_interface_only', canvas: 'allow', webgl: 'allow', hardwareApis: 'allow' },
  standard: { webrtc: 'default_public_interface_only', canvas: 'allow', webgl: 'allow', hardwareApis: 'allow' },
  strict: { webrtc: 'disable_non_proxied_udp', canvas: 'block-readback', webgl: 'disabled', hardwareApis: 'normalize' },
};
const OVERRIDES: Array<{ key: string; type: 'bool' | 'enum'; values?: string[] }> = [
  { key: 'blockAds', type: 'bool' }, { key: 'blockTrackers', type: 'bool' }, { key: 'httpsOnly', type: 'bool' },
  { key: 'blockThirdPartyCookies', type: 'bool' }, { key: 'stripTrackingParams', type: 'bool' }, { key: 'blockBounceTracking', type: 'bool' },
  { key: 'blockAutoplay', type: 'bool' }, { key: 'clearOnExit', type: 'bool' }, { key: 'warnDangerousDownloads', type: 'bool' }, { key: 'blockPopups', type: 'bool' },
  { key: 'trimReferrer', type: 'bool' }, { key: 'globalPrivacyControl', type: 'bool' },
  { key: 'geolocation', type: 'enum', values: ['ask', 'block'] }, { key: 'notifications', type: 'enum', values: ['ask', 'block'] },
  { key: 'confirmCrossSiteRedirects', type: 'bool' },
];
/** Engine-level switches only matter for profiles without a fingerprint (the fingerprint decides them otherwise). */
const ENGINE_OVERRIDES: Array<{ key: string; type: 'enum'; values: string[] }> = [
  { key: 'webrtc', type: 'enum', values: ['default', 'default_public_interface_only', 'disable_non_proxied_udp'] },
  { key: 'canvas', type: 'enum', values: ['allow', 'block-readback'] }, { key: 'webgl', type: 'enum', values: ['allow', 'disabled'] },
  { key: 'hardwareApis', type: 'enum', values: ['allow', 'normalize'] },
];

// ------------------------------------------------------------------ dialog

type Tab = 'general' | 'advanced' | 'browser' | 'notes' | 'mass';

export function openEditor(p: Profile | null): void {
  const d = p ? draftFrom(p) : newDraft();
  const creating = !p;
  let tab: Tab = 'general';
  let busy = false;
  const mass: MassDraft = { text: '', os: 'windows11', type: 'http', prefix: '' };

  modal(creating ? t('ui.createProfile') : t('profile.editTitle', { name: p!.name }), (box) => {
    const tabs = h('div', { class: 'tabs ed-tabs', role: 'tablist' });
    const main = h('div', { class: 'ed-main' });
    const side = h('aside', { class: 'ed-side' });
    const err = h('div', { class: 'err', role: 'alert' });

    const summary = () => { clear(side); side.append(summaryPanel(d, renewFp, creating)); };
    const draw = () => {
      clear(tabs);
      const TABS: Array<[Tab, string]> = [['general', 'edit.tab.general'], ['advanced', 'ui.tab.advanced'], ['browser', 'ui.tab.browser'], ['notes', 'ui.tab.notes']];
      if (creating) TABS.push(['mass', 'mass.tab']);
      for (const [k, key] of TABS) {
        const b = h('button', { class: k === tab ? 'on' : '', role: 'tab', 'aria-selected': String(k === tab) }, k === 'mass' ? icon('import', 15) : null, h('span', { text: t(key) }));
        b.onclick = () => { tab = k; draw(); };
        tabs.append(b);
      }
      clear(main);
      if (tab === 'general') general(main, d, creating, p, draw, summary);
      if (tab === 'advanced') advanced(main, d, draw, summary);
      if (tab === 'browser') browser(main, d, draw, summary);
      if (tab === 'notes') notes(main, d);
      if (tab === 'mass') massImport(main, mass, d, () => setSaveLabel());
      setSaveLabel();
      main.scrollTop = 0;
      summary();
    };
    const renewFp = async () => {
      const os = d.fp?.os ?? 'windows11';
      const fp = await run(api.invoke<Fingerprint>('mgr:fingerprint-new', os));
      if (!fp) return;
      const cur = d.fp;
      d.fp = cur ? { ...fp, timezone: cur.timezone, language: cur.language, geolocation: cur.geolocation, webrtc: cur.webrtc, ports: cur.ports, doNotTrack: cur.doNotTrack } : fp;
      draw();
      toast(t('fp.generated'), 'ok');
    };

    const cancel = h('button', { class: 'btn', text: t('common.cancel') });
    cancel.onclick = closeModal;
    const save = h('button', { class: 'btn primary upper' }, icon('check', 16), h('span', { text: creating ? t('ui.createProfile') : t('common.save') })) as HTMLButtonElement;
    const saveLabel = save.querySelector('span')!;
    const setSaveLabel = () => {
      const n = tab === 'mass' ? massLines(mass).filter((l) => !l.error).length : 0;
      saveLabel.textContent = tab === 'mass' ? t('mass.createN', { n }) : creating ? t('ui.createProfile') : t('common.save');
      save.disabled = busy || (tab === 'mass' && n === 0);
    };
    save.onclick = async () => {
      if (busy) return;
      err.textContent = '';
      if (tab === 'mass') {
        busy = true;
        const r = await runMassImport(mass, d, (done, total) => { saveLabel.textContent = t('mass.progress', { done, total }); });
        busy = false;
        setSaveLabel();
        if (r.created) { closeModal(); toast(t('mass.done', { n: r.created }), 'ok'); }
        if (r.errors.length) { toast(t('mass.failedN', { n: r.errors.length }), 'err'); if (!r.created) err.textContent = r.errors[0]; }
        return;
      }
      const proxy = proxyInput(d.proxy);
      if (typeof proxy === 'string') { err.textContent = proxy; tab = 'general'; draw(); return; }
      busy = true;
      save.disabled = true;
      const patch: Record<string, unknown> = {
        status: d.status, tags: d.tags, folder: d.folder.trim(), notes: d.notes, startPages: d.startPages,
        homePage: d.homePage.trim() || 'octo://newtab', theme: d.theme, keepHistory: d.keepHistory, restoreSession: d.restoreSession,
        deleteOnClose: d.deleteOnClose, protection: d.protection, dns: d.dns, sandbox: d.sandbox, addons: d.addons,
      };
      if (d.fp) patch.fingerprint = d.fp;
      else if (!creating && p!.fingerprint?.enabled) patch.fingerprint = { ...p!.fingerprint, enabled: false };
      const name = d.name.trim();
      const cookies = d.cookies.trim() || undefined;
      const r = creating
        ? await run(api.invoke<Profile>('mgr:create', { name, kind: d.kind, patch, proxy, cookies }))
        : await run(api.invoke<Profile>('mgr:update', p!.id, { ...patch, name: name || p!.name, proxy, cookies }));
      busy = false;
      save.disabled = false;
      if (!r) return;
      closeModal();
      toast(t(creating ? 'toast.profileCreated' : p!.running ? 'ui.savedRestart' : 'toast.saved'), 'ok');
    };
    const foot = h('div', { class: 'ed-foot' },
      !creating && p!.running ? h('span', { class: 'hint' }, icon('info', 14), ` ${t('edit.runningNote')}`) : h('span', {}),
      h('div', { class: 'grow' }), err, cancel, save);
    box.append(tabs, h('div', { class: 'ed-body' }, main, side), foot);
    draw();
    // New antidetect profile: a fresh realistic fingerprint right away.
    if (creating) void api.invoke<Fingerprint>('mgr:fingerprint-new', 'windows11').then((fp) => { if (!d.fp && d.kind === 'antidetect') { d.fp = fp; draw(); } }).catch(() => undefined);
  }, 'editor');
}

/** Draft proxy -> ProxyInput for the main process, or an error message. */
function proxyInput(px: ProxyDraft): unknown {
  if (px.mode === 'none') return { mode: 'none' };
  if (px.keep) return { mode: 'keep' };
  if (px.mode === 'saved') return px.savedId ? { mode: 'saved', savedId: px.savedId } : t('proxy.err.pickSaved');
  if (!px.text.trim()) return t('proxy.err.empty');
  const r = parseProxy(px.text, px.type);
  if (!r.ok) return t(r.error ?? 'proxy.err.format');
  if (px.changeIpUrl && !/^https?:\/\/\S+$/i.test(px.changeIpUrl.trim())) return t('proxy.err.changeIpUrl');
  return { mode: 'new', text: px.text.trim(), type: px.type, changeIpUrl: px.changeIpUrl.trim(), name: px.name.trim(), save: px.save };
}

function section(title: string, ...children: Array<HTMLElement | null>): HTMLElement {
  return h('section', { class: 'ed-sec' }, h('h3', { text: title }), ...children);
}

// ------------------------------------------------------------------ General

function general(b: HTMLElement, d: Draft, creating: boolean, p: Profile | null, draw: () => void, summary: () => void): void {
  const name = input(d.name, { maxlength: '64', placeholder: creating ? t('ui.namePhAuto') : '' }, (v) => { d.name = v; summary(); });
  const status = select<string>(STATUSES.includes(d.status) ? d.status : '', STATUSES.map((s) => [s, s ? t(`status.p.${s}`) : t('ui.noStatus')] as [string, string]), (v) => { d.status = v; });
  const folders = allFolders();
  const dl = h('datalist', { id: 'ed-folders' });
  for (const f of folders) dl.append(h('option', { value: f }));
  const folder = input(d.folder, { list: 'ed-folders', maxlength: '48', placeholder: t('ui.noFolder') }, (v) => { d.folder = v; });
  const allTags = [...new Set(S.profiles.flatMap((x) => x.tags ?? []))];
  b.append(section(t('ui.sec.main'),
    h('div', { class: 'grid2' }, field('profile.name', name), field('ui.status', status)),
    h('div', { class: 'grid2' }, h('div', { class: 'field' }, h('span', { class: 'lbl', text: t('ui.tags') }), tagInput(d.tags, (v) => { d.tags = v; }, allTags)), field('ui.folder', folder)), dl));

  // Profile type
  const kinds = S.init.kinds.filter((k) => k !== 'custom' && (k !== 'tor' || !S.profiles.some((x) => x.kind === 'tor') || d.kind === 'tor'));
  const grid = h('div', { class: 'kind-grid', role: 'radiogroup' });
  for (const k of kinds) {
    const c = h('button', { type: 'button', class: `kind-card${d.kind === k ? ' on' : ''}`, role: 'radio', 'aria-checked': String(d.kind === k), disabled: !creating && d.kind !== k },
      h('span', { class: 'kc-ic' }, icon(k === 'antidetect' ? 'fingerprint' : k === 'tor' ? 'tor' : k === 'private' ? 'eyeOff' : k === 'temporary' ? 'trash' : k === 'work' ? 'box' : k === 'testing' ? 'activity' : 'user', 18)),
      h('span', { class: 'kc-t' }, h('b', { text: t(`profile.kind.${k}`) }), h('span', { text: t(`profile.kindTag.${k}`) })));
    c.onclick = () => {
      if (!creating || d.kind === k) return;
      d.kind = k;
      Object.assign(d, kindDefaults(k, S.init.addons.filter((a) => a.kind !== 'external-app').map((a) => a.id)));
      if (k === 'antidetect' && !d.fp) void api.invoke<Fingerprint>('mgr:fingerprint-new', 'windows11').then((fp) => { d.fp = fp; draw(); });
      if (k !== 'antidetect') d.fp = null;
      if (k === 'tor') d.proxy = { ...d.proxy, mode: 'none', keep: false };
      draw();
    };
    grid.append(c);
  }
  b.append(section(t('profile.kind'), grid, h('p', { class: 'hint', text: t(`profile.kindDesc.${d.kind}`) }), !creating ? h('p', { class: 'hint', text: t('ui.kindFixed') }) : null));

  // Start pages
  const pages = h('div', { class: 'pages' });
  const drawPages = () => {
    clear(pages);
    d.startPages.forEach((u, i) => {
      const x = h('button', { class: 'icon-btn tiny', title: t('common.remove'), 'aria-label': t('common.remove') }, icon('close', 14));
      x.onclick = () => { d.startPages.splice(i, 1); drawPages(); };
      pages.append(h('div', { class: 'page-row' }, icon('globe', 14), h('span', { class: 'ell grow', text: u }), x));
    });
  };
  const addUrl = input('', { placeholder: 'https://example.com', maxlength: '2048' });
  const addBtn = h('button', { class: 'btn' }, icon('plus', 14), h('span', { text: t('ui.add') }));
  const add = () => {
    let u = addUrl.value.trim();
    if (!u) return;
    if (!/^[a-z]+:\/\//i.test(u)) u = `https://${u}`;
    try { new URL(u); } catch { toast(t('ui.badUrl'), 'err'); return; }
    if (d.startPages.length < 20) d.startPages.push(u);
    addUrl.value = '';
    drawPages();
  };
  addBtn.onclick = add;
  addUrl.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } };
  drawPages();
  b.append(section(t('ui.startPages'), h('div', { class: 'row nowrap' }, addUrl, addBtn), pages, h('p', { class: 'hint', text: t('ui.startPagesHint') })));

  // Proxy
  if (d.kind === 'tor') b.append(section(t('ui.col.proxy'), h('p', { class: 'info', text: t('net.torNotHere') })));
  else b.append(section(t('ui.col.proxy'), proxyEditor(d.proxy, p, summary)));

  // Cookies (Dolphin-like: paste an export or load a file; applied at the next start / immediately when running)
  b.append(section(t('cookies.title'), cookieEditor(d, p)));
}

function cookieEditor(d: Draft, p: Profile | null): HTMLElement {
  const status = h('div', { class: 'ck-status', 'aria-live': 'polite' });
  const ta = h('textarea', { class: 'mono ck-text', rows: '4', spellcheck: 'false', placeholder: t('cookies.ph'), 'aria-label': t('cookies.title') });
  ta.value = d.cookies;
  let timer = 0;
  const check = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(async () => {
      clear(status);
      status.className = 'ck-status';
      if (!d.cookies.trim()) return;
      const r = await api.invoke<{ ok: boolean; count: number; skipped: number; format: string; error?: string }>('mgr:parse-cookies', d.cookies).catch(() => null);
      if (!r) return;
      status.classList.add(r.ok ? 'ok' : 'bad');
      status.append(icon(r.ok ? 'check' : 'alert', 14), h('span', {
        text: r.ok
          ? `${t('cookies.found', { n: r.count, format: r.format === 'json' ? 'JSON' : 'Netscape' })}${r.skipped ? ` · ${t('cookies.skipped', { n: r.skipped })}` : ''} · ${t(p?.running ? 'cookies.whenNow' : 'cookies.whenStart')}`
          : r.error ?? '',
      }));
    }, 250);
  };
  ta.oninput = () => { d.cookies = ta.value; check(); };
  const file = h('input', { type: 'file', accept: '.json,.txt,.cookies,application/json,text/plain', class: 'hidden' }) as HTMLInputElement;
  file.onchange = async () => {
    const f = file.files?.[0];
    if (!f) return;
    if (f.size > 8 * 1024 * 1024) { toast(t('cookies.err.tooBig'), 'err'); return; }
    d.cookies = await f.text();
    ta.value = d.cookies;
    file.value = '';
    check();
  };
  const load = h('button', { type: 'button', class: 'btn small' }, icon('file', 14), h('span', { text: t('cookies.load') }));
  load.onclick = () => file.click();
  const clr = h('button', { type: 'button', class: 'btn small' }, icon('close', 14), h('span', { text: t('cookies.clear') }));
  clr.onclick = () => { d.cookies = ''; ta.value = ''; check(); };
  check();
  return h('div', { class: 'ck-ed' },
    ta,
    h('div', { class: 'row' }, load, clr, file, h('div', { class: 'grow' }), status),
    p?.pendingCookies ? h('p', { class: 'hint' }, icon('clock', 13), ` ${t('cookies.pending')}`) : null,
    h('p', { class: 'hint', text: t('cookies.hint') }));
}

// ------------------------------------------------------------------ Mass import

interface MassDraft { text: string; os: FpOs | 'random'; type: ProxyType; prefix: string }
interface MassLine { n: number; name: string; proxy: string; error?: string }
const MASS_MAX = 500;
const MASS_OSES: FpOs[] = ['windows11', 'windows10', 'macos', 'linux'];

/** One line = one profile: "name;proxy", "name" or just "proxy" (any format the proxy field accepts). */
function massLines(m: MassDraft): MassLine[] {
  const out: MassLine[] = [];
  const lines = m.text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const prefix = m.prefix.trim() || t('profile.defaultName');
  lines.slice(0, MASS_MAX).forEach((line, i) => {
    const sep = line.search(/[;\t]/);
    let name = '';
    let proxy = '';
    if (sep >= 0) { name = line.slice(0, sep).trim(); proxy = line.slice(sep + 1).trim(); }
    else if (parseProxy(line, m.type).ok) proxy = line;
    else name = line;
    const l: MassLine = { n: i + 1, name: (name || `${prefix} ${i + 1}`).slice(0, 64), proxy };
    if (proxy) { const r = parseProxy(proxy, m.type); if (!r.ok) l.error = t(r.error ?? 'proxy.err.format'); }
    out.push(l);
  });
  return out;
}

function massImport(b: HTMLElement, m: MassDraft, d: Draft, changed: () => void): void {
  const preview = h('div', { class: 'mass-prev' });
  const drawPreview = () => {
    clear(preview);
    const lines = massLines(m);
    changed();
    if (!lines.length) { preview.append(h('p', { class: 'hint', text: t('mass.empty') })); return; }
    const bad = lines.filter((l) => l.error).length;
    preview.append(h('div', { class: 'mass-sum' },
      h('span', { class: 'pill ok', text: t('mass.okN', { n: lines.length - bad }) }),
      bad ? h('span', { class: 'pill bad', text: t('mass.badN', { n: bad }) }) : null,
      m.text.split(/\n/).filter((x) => x.trim()).length > MASS_MAX ? h('span', { class: 'pill warn', text: t('mass.limit', { n: MASS_MAX }) }) : null));
    const tbl = h('div', { class: 'mass-rows', role: 'list' });
    for (const l of lines.slice(0, 200)) {
      tbl.append(h('div', { class: `mass-row${l.error ? ' bad' : ''}`, role: 'listitem' },
        h('span', { class: 'mr-n', text: String(l.n) }),
        h('span', { class: 'mr-name', text: l.name }),
        h('span', { class: 'mr-proxy mono', text: l.error ?? (l.proxy ? l.proxy.replace(/(:[^:@/]*)@/, ':•••@') : t('proxy.none')) })));
    }
    preview.append(tbl);
  };
  const ta = h('textarea', { class: 'mono mass-text', rows: '8', spellcheck: 'false', placeholder: 'Sklep 1;http://user:pass@1.2.3.4:8080\nSklep 2;socks5://5.6.7.8:1080\n9.9.9.9:3128:login:haslo', 'aria-label': t('mass.tab') });
  ta.value = m.text;
  ta.oninput = () => { m.text = ta.value; drawPreview(); };
  const file = h('input', { type: 'file', accept: '.txt,.csv,text/plain', class: 'hidden' }) as HTMLInputElement;
  file.onchange = async () => { const f = file.files?.[0]; if (!f) return; m.text = (await f.text()).slice(0, 1_000_000); ta.value = m.text; file.value = ''; drawPreview(); };
  const load = h('button', { type: 'button', class: 'btn small' }, icon('file', 14), h('span', { text: t('mass.load') }));
  load.onclick = () => file.click();
  const prefix = input(m.prefix, { maxlength: '40', placeholder: t('profile.defaultName') }, (v) => { m.prefix = v; drawPreview(); });

  b.append(
    section(t('mass.title'), h('p', { class: 'hint', text: t('mass.intro') }), ta, h('div', { class: 'row' }, load, file)),
    section(t('mass.options'),
      frow(t('fp.os'), seg<FpOs | 'random'>(m.os, [...MASS_OSES.map((o) => [o, osLabel(o), o.startsWith('windows') ? 'windows' : o === 'macos' ? 'apple' : 'linux'] as [FpOs, string, string]), ['random', t('mass.osRandom'), 'shuffle']], (v) => { m.os = v; })),
      frow(t('proxy.type'), seg<ProxyType>(m.type, [['http', 'HTTP'], ['https', 'HTTPS'], ['socks4', 'SOCKS4'], ['socks5', 'SOCKS5']], (v) => { m.type = v; drawPreview(); })),
      frow(t('mass.prefix'), prefix),
      frow(t('ui.tags'), tagInput(d.tags, (v) => { d.tags = v; }, [...new Set(S.profiles.flatMap((x) => x.tags ?? []))])),
      h('p', { class: 'hint', text: t('mass.each') })),
    section(t('mass.preview'), preview));
  drawPreview();
}

async function runMassImport(m: MassDraft, d: Draft, progress: (done: number, total: number) => void): Promise<{ created: number; errors: string[] }> {
  const lines = massLines(m).filter((l) => !l.error);
  const errors: string[] = [];
  let created = 0;
  for (const [i, l] of lines.entries()) {
    progress(i, lines.length);
    try {
      const os = m.os === 'random' ? MASS_OSES[Math.floor(Math.random() * MASS_OSES.length)] : m.os;
      const fingerprint = await api.invoke<Fingerprint>('mgr:fingerprint-new', os);
      await api.invoke<Profile>('mgr:create', {
        name: l.name, kind: 'antidetect',
        patch: { fingerprint, tags: d.tags, folder: d.folder.trim() },
        proxy: l.proxy ? { mode: 'new', text: l.proxy, type: m.type, changeIpUrl: '', name: '', save: false } : { mode: 'none' },
      });
      created++;
    } catch (e) {
      errors.push(`${l.n}: ${errText(e)}`);
    }
  }
  progress(lines.length, lines.length);
  return { created, errors };
}

/** Proxy block styled like the reference: No / New / Saved, type chips, input with check, change-IP URL, name. */
function proxyEditor(px: ProxyDraft, p: Profile | null, summary: () => void): HTMLElement {
  const wrap = h('div', { class: 'proxy-ed' });
  const draw = () => {
    clear(wrap);
    wrap.append(seg<ProxyMode>(px.mode, [['none', t('proxy.none'), 'close'], ['new', t('proxy.new'), 'plus'], ['saved', t('proxy.saved'), 'bookmark']], (v) => {
      px.mode = v;
      px.keep = !!p && v === origMode(p);
      if (!px.keep) px.check = undefined; else px.check = p?.proxyCheck;
      draw();
      summary();
    }, 'big'));
    if (px.mode === 'new') wrap.append(newProxy(px, p, summary));
    if (px.mode === 'saved') wrap.append(savedProxy(px, p, summary, draw));
    if (px.mode === 'none') wrap.append(h('p', { class: 'hint', text: t('proxy.noneHint') }));
  };
  draw();
  return wrap;
}

function origMode(p: Profile): ProxyMode {
  if (p.network.mode !== 'proxy') return 'none';
  return p.network.proxy?.savedId && S.proxies.some((s) => s.id === p.network.proxy!.savedId) ? 'saved' : 'new';
}

function newProxy(px: ProxyDraft, p: Profile | null, summary: () => void): HTMLElement {
  const box = h('div', { class: 'proxy-new' });
  const types = h('div', {});
  const drawTypes = () => {
    clear(types);
    types.append(seg<ProxyType>(px.type, [['http', 'HTTP'], ['https', 'HTTPS'], ['socks4', 'SOCKS4'], ['socks5', 'SOCKS5']], (v) => { px.type = v; px.keep = false; px.check = undefined; detect(); summary(); }));
  };
  drawTypes();
  const status = h('div', { class: 'proxy-status' });
  const result = h('div', { class: 'proxy-result' });
  const inp = input(px.text, { placeholder: t('proxy.inputPh'), maxlength: '1024', spellcheck: 'false', autocomplete: 'off', 'aria-label': t('proxy.input') });
  const checkBtn = h('button', { type: 'button', class: 'in-btn', title: t('proxy.check'), 'aria-label': t('proxy.check') }, icon('swap', 18)) as HTMLButtonElement;
  const info = h('span', { class: 'in-btn info-ic', title: t('proxy.formats') }, icon('info', 18));
  const detect = () => {
    clear(status);
    status.className = 'proxy-status';
    if (px.keep && p) {
      status.append(h('span', { text: p.hasProxyCredentials ? t('proxy.currentWithCreds') : t('proxy.current') }));
      return;
    }
    if (!px.text.trim()) { status.append(h('span', { class: 'muted', text: t('proxy.notChecked') })); return; }
    const r = parseProxy(px.text, px.type);
    if (!r.ok || !r.proxy) {
      status.classList.add('bad');
      status.append(icon('alert', 14), h('span', { text: t(r.error ?? 'proxy.err.format') }));
      return;
    }
    const q = r.proxy;
    status.classList.add('ok');
    status.append(icon('check', 14), h('span', { text: t('proxy.detected', { type: q.type.toUpperCase(), host: `${q.host}:${q.port}`, format: r.format ?? '' }) }),
      q.username ? h('span', { class: 'pill', text: t('proxy.withLogin') }) : '');
  };
  inp.oninput = () => {
    px.text = inp.value;
    px.keep = false;
    px.check = undefined;
    clear(result);
    const r = parseProxy(px.text, px.type);
    // A scheme in the pasted text (socks5://...) selects the type automatically.
    if (r.ok && r.proxy && r.proxy.type !== px.type && /^[a-z0-9]+:\/\//i.test(px.text.trim())) { px.type = r.proxy.type; drawTypes(); }
    if (r.ok && r.proxy?.changeIpUrl && !px.changeIpUrl) { px.changeIpUrl = r.proxy.changeIpUrl; cip.value = px.changeIpUrl; }
    detect();
    summary();
  };
  inp.onpaste = () => setTimeout(() => inp.dispatchEvent(new Event('input')), 0);
  checkBtn.onclick = async () => {
    checkBtn.disabled = true;
    checkBtn.classList.add('spinning');
    clear(result);
    result.append(h('span', { class: 'muted', text: t('proxy.checking') }));
    let r: ProxyCheck | undefined;
    if (px.keep && p) r = await run(api.invoke<ProxyCheck>('mgr:proxy-check-profile', p.id));
    else {
      const input = proxyInput(px);
      if (typeof input === 'string') { clear(result); result.append(h('span', { class: 'chk bad', text: input })); checkBtn.disabled = false; checkBtn.classList.remove('spinning'); return; }
      r = await run(api.invoke<ProxyCheck>('mgr:proxy-check', input));
    }
    checkBtn.disabled = false;
    checkBtn.classList.remove('spinning');
    px.check = r;
    clear(result);
    if (r) result.append(checkCard(r));
    summary();
  };
  inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); checkBtn.click(); } };
  const cip = input(px.changeIpUrl, { placeholder: t('proxy.changeIpUrl'), maxlength: '2000', spellcheck: 'false' }, (v) => { px.changeIpUrl = v; px.keep = false; });
  const cipBtn = h('button', { type: 'button', class: 'in-btn', title: t('proxy.changeIpNow'), 'aria-label': t('proxy.changeIpNow') }, icon('refreshCircle', 18)) as HTMLButtonElement;
  cipBtn.onclick = async () => {
    if (!/^https?:\/\//i.test(px.changeIpUrl)) { toast(t('proxy.err.changeIpUrl'), 'err'); return; }
    cipBtn.disabled = true;
    const r = await run(api.invoke<{ ok: boolean; status: number }>('mgr:proxy-change-ip', px.changeIpUrl));
    cipBtn.disabled = false;
    if (r) toast(r.ok ? t('proxy.ipChanged') : `${t('proxy.ipChangeFailed')} (HTTP ${r.status})`, r.ok ? 'ok' : 'err');
  };
  const name = input(px.name, { placeholder: t('proxy.name'), maxlength: '64' }, (v) => { px.name = v; px.keep = false; summary(); });
  if (px.check) result.append(checkCard(px.check));
  detect();
  box.append(types,
    h('div', { class: 'in-wrap' }, inp, checkBtn, info), status, result,
    h('div', { class: 'in-wrap' }, cip, cipBtn), h('span', { class: 'hint', text: t('ui.optional') }),
    h('div', { class: 'in-wrap' }, name), h('span', { class: 'hint', text: t('ui.optional') }),
    toggle(px.save, 'proxy.saveToList', (v) => { px.save = v; px.keep = false; }),
    h('details', { class: 'formats' }, h('summary', { text: t('proxy.formats') }),
      h('code', { text: 'host:port\nhost:port:user:pass\nuser:pass@host:port\nhost:port@user:pass\nuser:pass:host:port\nsocks5://user:pass@host:port\nhttp://host:port [https://change-ip-url]' })));
  return box;
}

function checkCard(c: ProxyCheck): HTMLElement {
  if (!c.ok) return h('div', { class: 'check-card bad' }, icon('alert', 16), h('span', { text: `${t('proxy.failed')}: ${errText(c.error ?? '')}` }));
  const kv = (k: string, v?: string | number) => (v === undefined || v === '' ? null : h('div', { class: 'kv' }, h('span', { class: 'muted', text: k }), h('b', { text: String(v) })));
  return h('div', { class: 'check-card ok' },
    h('div', { class: 'cc-head' }, icon('check', 16), checkLine(c)),
    h('div', { class: 'cc-grid' }, kv(t('proxy.ip'), c.ip), kv(t('proxy.country'), c.country), kv(t('proxy.city'), [c.city, c.region].filter(Boolean).join(', ')),
      kv(t('fp.timezone'), c.timezone), kv(t('proxy.latency'), c.latencyMs ? `${c.latencyMs} ms` : undefined)),
    h('p', { class: 'hint', text: t('proxy.autoHint') }));
}

function savedProxy(px: ProxyDraft, p: Profile | null, summary: () => void, redraw: () => void): HTMLElement {
  const box = h('div', { class: 'proxy-new' });
  if (!S.proxies.length) {
    box.append(h('p', { class: 'info', text: t('proxy.noSaved') }));
    return box;
  }
  if (!px.savedId) px.savedId = S.proxies[0].id;
  const sel = select<string>(px.savedId, S.proxies.map((s) => [s.id, `${s.name || proxyText(s)}${s.name ? ` — ${proxyText(s)}` : ''}${s.lastCheck?.ok ? ` · ${s.lastCheck.ip}` : ''}`] as [string, string]), (v) => {
    px.savedId = v;
    px.keep = !!p && p.network.proxy?.savedId === v;
    px.check = S.proxies.find((s) => s.id === v)?.lastCheck;
    redraw();
    summary();
  });
  const sp = S.proxies.find((s) => s.id === px.savedId) as SavedProxy;
  if (!px.check) px.check = sp?.lastCheck;
  const chk = h('button', { class: 'btn' }, icon('swap', 15), h('span', { text: t('proxy.check') })) as HTMLButtonElement;
  const res = h('div', {});
  if (px.check) res.append(checkCard(px.check));
  chk.onclick = async () => {
    chk.disabled = true;
    const r = await run(api.invoke<ProxyCheck>('mgr:proxies-check', px.savedId));
    chk.disabled = false;
    if (r) { px.check = r; clear(res); res.append(checkCard(r)); summary(); }
  };
  const copy = h('button', { class: 'btn' }, icon('copy', 15), h('span', { text: t('proxy.copy') }));
  copy.onclick = () => void copyText(proxyText(sp));
  box.append(field('proxy.pickSaved', sel),
    h('div', { class: 'saved-card' },
      h('div', { class: 'kv' }, h('span', { class: 'muted', text: t('proxy.type') }), h('b', { text: sp.type.toUpperCase() })),
      h('div', { class: 'kv' }, h('span', { class: 'muted', text: t('proxy.address') }), h('b', { text: `${sp.host}:${sp.port}` })),
      h('div', { class: 'kv' }, h('span', { class: 'muted', text: t('proxy.login') }), h('b', { text: sp.hasCredentials ? t('state.on') : t('state.off') })),
      sp.changeIpUrl ? h('div', { class: 'kv' }, h('span', { class: 'muted', text: t('proxy.changeIpUrl') }), h('span', { class: 'ell', text: sp.changeIpUrl })) : null,
      h('div', { class: 'row' }, chk, copy)), res);
  return box;
}

// ------------------------------------------------------------------ Advanced (fingerprint)

function advanced(b: HTMLElement, d: Draft, draw: () => void, summary: () => void): void {
  if (d.kind === 'tor') { b.append(h('p', { class: 'info', text: t('edit.torFixed') })); return; }
  if (!d.fp) {
    const on = h('button', { class: 'btn primary' }, icon('fingerprint', 16), h('span', { text: t('fp.enable') }));
    on.onclick = async () => {
      const fp = await run(api.invoke<Fingerprint>('mgr:fingerprint-new', 'windows11'));
      if (fp) { d.fp = fp; draw(); }
    };
    b.append(h('div', { class: 'fp-off' }, icon('fingerprint', 36), h('h3', { text: d.kind === 'antidetect' ? t('fp.loading') : t('fp.offTitle') }), h('p', { class: 'muted', text: t('fp.offText') }), d.kind === 'antidetect' ? null : on));
    return;
  }
  const fp = d.fp;
  const ch = () => summary();
  if (d.kind !== 'antidetect') {
    const off = h('button', { class: 'btn small' }, icon('close', 14), h('span', { text: t('fp.disable') }));
    off.onclick = () => { d.fp = null; draw(); };
    b.append(h('div', { class: 'note row between' }, h('span', { text: t('fp.onForKind') }), off));
  }

  // OS + user agent
  const ua = h('textarea', { class: 'ua', rows: '2', maxlength: '512', spellcheck: 'false', 'aria-label': t('fp.userAgent') });
  ua.value = fp.userAgent;
  ua.oninput = () => { fp.userAgent = ua.value.trim(); ch(); };
  const uaNew = h('button', { type: 'button', class: 'in-btn', title: t('fp.newUa'), 'aria-label': t('fp.newUa') }, icon('refreshCircle', 18));
  uaNew.onclick = async () => {
    const n = await run(api.invoke<Fingerprint>('mgr:fingerprint-new', fp.os));
    if (!n) return;
    fp.userAgent = n.userAgent; fp.uaFullVersion = n.uaFullVersion; fp.platformVersion = n.platformVersion;
    ua.value = fp.userAgent;
    ch();
  };
  const osSeg = seg<FpOs>(fp.os, [['windows11', 'Windows 11', 'windows'], ['windows10', 'Windows 10', 'windows'], ['macos', 'macOS', 'apple'], ['linux', 'Linux', 'linux']], async (os) => {
    // Changing the OS renews everything that depends on it (UA, GPU, screen, CPU...) and keeps the network choices.
    const n = await run(api.invoke<Fingerprint>('mgr:fingerprint-new', os));
    if (!n) return;
    d.fp = { ...n, timezone: fp.timezone, language: fp.language, geolocation: fp.geolocation, webrtc: fp.webrtc, ports: fp.ports, doNotTrack: fp.doNotTrack, canvas: fp.canvas, webgl: fp.webgl, audio: fp.audio, clientRects: fp.clientRects, fonts: fp.fonts, webgpu: fp.webgpu };
    draw();
  }, 'big');
  b.append(section(t('fp.os'), osSeg, h('p', { class: 'hint', text: t('fp.osHint') })),
    section(t('fp.userAgent'), h('div', { class: 'in-wrap' }, ua, uaNew), h('p', { class: 'hint', text: t('fp.uaHint') })));

  // Hardware / network parameters
  const hw = h('div', { class: 'frows' });
  const rtcIp = input(fp.webrtc.publicIp, { placeholder: t('fp.webrtcIpPh'), maxlength: '45' }, (v) => { fp.webrtc.publicIp = v.trim(); ch(); });
  rtcIp.classList.toggle('hidden', fp.webrtc.mode !== 'manual');
  hw.append(frow(t('fp.webrtc'), seg(fp.webrtc.mode, [['off', t('fp.v.off')], ['real', t('fp.v.real')], ['disable-udp', t('fp.v.disableUdp')], ['altered', t('fp.v.altered')], ['manual', t('fp.v.manual')]], (v) => { fp.webrtc.mode = v; rtcIp.classList.toggle('hidden', v !== 'manual'); ch(); }), rtcIp,
    h('p', { class: 'hint', text: t(`fp.webrtc.${fp.webrtc.mode === 'disable-udp' ? 'disableUdp' : fp.webrtc.mode}`) })));
  hw.append(frow(t('fp.canvas'), seg(fp.canvas, [['off', t('fp.v.off')], ['real', t('fp.v.real')], ['noise', t('fp.v.noise')]], (v) => { fp.canvas = v; ch(); })));
  hw.append(frow(t('fp.webgl'), seg(fp.webgl, [['off', t('fp.v.off')], ['real', t('fp.v.real')], ['noise', t('fp.v.noise')]], (v) => { fp.webgl = v; ch(); })));

  // WebGL vendor / renderer with the presets of the OS
  const gpuBox = h('div', { class: 'gpu' });
  const drawGpu = async () => {
    clear(gpuBox);
    if (fp.webglInfo.mode !== 'manual') return;
    const m = await meta(fp.os);
    const gpus = m?.gpus ?? [];
    const vendors = [...new Set(gpus.map((g) => g.vendor))];
    if (fp.webglInfo.vendor && !vendors.includes(fp.webglInfo.vendor)) vendors.unshift(fp.webglInfo.vendor);
    const renderers = gpus.filter((g) => g.vendor === fp.webglInfo.vendor).map((g) => g.renderer);
    if (fp.webglInfo.renderer && !renderers.includes(fp.webglInfo.renderer)) renderers.unshift(fp.webglInfo.renderer);
    const vSel = select<string>(fp.webglInfo.vendor, vendors.map((v) => [v, v] as [string, string]), (v) => {
      fp.webglInfo.vendor = v;
      fp.webglInfo.renderer = gpus.find((g) => g.vendor === v)?.renderer ?? '';
      void drawGpu(); ch();
    });
    const rSel = select<string>(fp.webglInfo.renderer, renderers.map((r) => [r, r] as [string, string]), (v) => { fp.webglInfo.renderer = v; ch(); });
    const rnd = h('button', { type: 'button', class: 'btn', title: t('fp.randomGpu') }, icon('shuffle', 15), h('span', { text: t('fp.randomGpu') }));
    rnd.onclick = () => { const g = gpus[Math.floor(Math.random() * gpus.length)]; if (g) { fp.webglInfo.vendor = g.vendor; fp.webglInfo.renderer = g.renderer; void drawGpu(); ch(); } };
    const custom = h('details', {}, h('summary', { text: t('fp.gpuCustom') }),
      field('fp.gpuVendor', input(fp.webglInfo.vendor, { maxlength: '128' }, (v) => { fp.webglInfo.vendor = v; ch(); })),
      field('fp.gpuRenderer', input(fp.webglInfo.renderer, { maxlength: '256' }, (v) => { fp.webglInfo.renderer = v; ch(); })));
    gpuBox.append(field('fp.gpuVendor', vSel), field('fp.gpuRenderer', rSel), h('div', { class: 'row' }, rnd), custom);
  };
  hw.append(frow(t('fp.webglInfo'), seg(fp.webglInfo.mode, [['real', t('fp.v.real')], ['manual', t('fp.v.manual')]], (v) => { fp.webglInfo.mode = v; void drawGpu(); ch(); }), gpuBox));
  void drawGpu();
  hw.append(frow(t('fp.webgpu'), seg(fp.webgpu, [['off', t('fp.v.off')], ['real', t('fp.v.real')]], (v) => { fp.webgpu = v; ch(); })));
  hw.append(frow(t('fp.clientRects'), seg(fp.clientRects, [['real', t('fp.v.real')], ['noise', t('fp.v.noise')]], (v) => { fp.clientRects = v; ch(); })));

  // Timezone / language / geolocation
  const tzSel = select<string>(fp.timezone.value || 'Europe/Warsaw', timezones().map((z) => [z, z] as [string, string]), (v) => { fp.timezone.value = v; ch(); });
  tzSel.classList.toggle('hidden', fp.timezone.mode !== 'manual');
  hw.append(frow(t('fp.timezone'), seg(fp.timezone.mode, [['auto', t('fp.v.autoIp')], ['manual', t('fp.v.manual')], ['real', t('fp.v.real')]], (v) => { fp.timezone.mode = v; if (v === 'manual' && !fp.timezone.value) fp.timezone.value = tzSel.value; tzSel.classList.toggle('hidden', v !== 'manual'); ch(); }), tzSel));
  const dlL = h('datalist', { id: 'ed-langs' });
  for (const l of LANGS) dlL.append(h('option', { value: l }));
  const langIn = input(fp.language.value || 'en-US,en', { list: 'ed-langs', maxlength: '120', placeholder: 'pl-PL,pl,en-US,en' }, (v) => { fp.language.value = v.trim(); ch(); });
  langIn.classList.toggle('hidden', fp.language.mode !== 'manual');
  hw.append(frow(t('fp.language'), seg(fp.language.mode, [['auto', t('fp.v.autoIp')], ['manual', t('fp.v.manual')], ['real', t('fp.v.real')]], (v) => { fp.language.mode = v; if (v === 'manual' && !fp.language.value) fp.language.value = langIn.value; langIn.classList.toggle('hidden', v !== 'manual'); ch(); }), langIn, dlL));
  const geo = h('div', { class: 'grid3' },
    field('fp.lat', input(String(fp.geolocation.latitude), { inputmode: 'decimal', maxlength: '12' }, (v) => { fp.geolocation.latitude = Number(v) || 0; ch(); })),
    field('fp.lon', input(String(fp.geolocation.longitude), { inputmode: 'decimal', maxlength: '12' }, (v) => { fp.geolocation.longitude = Number(v) || 0; ch(); })),
    field('fp.accuracy', input(String(fp.geolocation.accuracy), { inputmode: 'numeric', maxlength: '6' }, (v) => { fp.geolocation.accuracy = Math.max(1, Number(v) || 100); ch(); })));
  geo.classList.toggle('hidden', fp.geolocation.mode !== 'manual');
  hw.append(frow(t('fp.geolocation'), seg(fp.geolocation.mode, [['auto', t('fp.v.autoIp')], ['manual', t('fp.v.manual')], ['block', t('fp.v.block')]], (v) => { fp.geolocation.mode = v; const c = d.proxy.check; if (v === 'manual' && !fp.geolocation.latitude && !fp.geolocation.longitude && c?.ok && c.latitude !== undefined && c.longitude !== undefined) { fp.geolocation.latitude = c.latitude; fp.geolocation.longitude = c.longitude; draw(); return; } geo.classList.toggle('hidden', v !== 'manual'); ch(); }), geo));

  // Device
  const cores = h('div', { class: 'row nowrap chips-unit' }, seg<string>(String(fp.cpu.cores), (CORES.includes(fp.cpu.cores) ? CORES : [...CORES, fp.cpu.cores].sort((a, b) => a - b)).map((c) => [String(c), String(c)] as [string, string]), (v) => { fp.cpu.cores = Number(v); ch(); }), h('span', { class: 'unit', text: t('fp.cores') }));
  cores.classList.toggle('hidden', fp.cpu.mode !== 'manual');
  hw.append(frow(t('fp.cpu'), seg(fp.cpu.mode, [['real', t('fp.v.real')], ['manual', t('fp.v.manual')]], (v) => { fp.cpu.mode = v; cores.classList.toggle('hidden', v !== 'manual'); ch(); }), cores));
  const mem = h('div', { class: 'row nowrap chips-unit' }, seg<string>(String(fp.memory.gb), (MEMORY.includes(fp.memory.gb) ? MEMORY : [...MEMORY, fp.memory.gb].sort((a, b) => a - b)).map((m) => [String(m), String(m)] as [string, string]), (v) => { fp.memory.gb = Number(v); ch(); }), h('span', { class: 'unit', text: 'GB' }));
  mem.classList.toggle('hidden', fp.memory.mode !== 'manual');
  hw.append(frow(t('fp.memory'), seg(fp.memory.mode, [['real', t('fp.v.real')], ['manual', t('fp.v.manual')]], (v) => { fp.memory.mode = v; mem.classList.toggle('hidden', v !== 'manual'); ch(); }), mem, h('p', { class: 'hint', text: t('fp.memoryHint') })));
  const screens = SCREENS[fp.os === 'macos' ? 'mac' : 'desktop'];
  const curScr = `${fp.screen.width}x${fp.screen.height}`;
  const scr = select<string>(curScr, (screens.includes(curScr) ? screens : [curScr, ...screens]).map((s) => [s, s.replace('x', ' × ')] as [string, string]), (v) => { const [w, hh] = v.split('x').map(Number); fp.screen.width = w; fp.screen.height = hh; ch(); });
  scr.classList.toggle('hidden', fp.screen.mode !== 'manual');
  hw.append(frow(t('fp.screen'), seg(fp.screen.mode, [['real', t('fp.v.real')], ['manual', t('fp.v.manual')]], (v) => { fp.screen.mode = v; scr.classList.toggle('hidden', v !== 'manual'); ch(); }), scr));
  hw.append(frow(t('fp.fonts'), seg(fp.fonts, [['real', t('fp.v.real')], ['noise', t('fp.v.noise')]], (v) => { fp.fonts = v; ch(); })));
  hw.append(frow(t('fp.audio'), seg(fp.audio, [['real', t('fp.v.real')], ['noise', t('fp.v.noise')]], (v) => { fp.audio = v; ch(); })));
  const num = (key: 'audioInputs' | 'audioOutputs' | 'videoInputs', label: string) => field(label, input(String(fp.mediaDevices[key]), { inputmode: 'numeric', maxlength: '1' }, (v) => { fp.mediaDevices[key] = Math.min(9, Math.max(0, Number(v) || 0)); ch(); }));
  const media = h('div', { class: 'grid3' }, num('audioInputs', 'fp.mics'), num('audioOutputs', 'fp.speakers'), num('videoInputs', 'fp.cameras'));
  media.classList.toggle('hidden', fp.mediaDevices.mode !== 'manual');
  hw.append(frow(t('fp.media'), seg(fp.mediaDevices.mode, [['real', t('fp.v.real')], ['manual', t('fp.v.manual')]], (v) => { fp.mediaDevices.mode = v; media.classList.toggle('hidden', v !== 'manual'); ch(); }), media));
  const ports = input(fp.ports.list, { maxlength: '400', placeholder: '3389,5900,5938,6039' }, (v) => { fp.ports.list = v; ch(); });
  ports.classList.toggle('hidden', fp.ports.mode !== 'protect');
  hw.append(frow(t('fp.ports'), seg(fp.ports.mode, [['protect', t('fp.v.protect')], ['real', t('fp.v.real')]], (v) => { fp.ports.mode = v; ports.classList.toggle('hidden', v !== 'protect'); ch(); }), ports, h('p', { class: 'hint', text: t('fp.portsHint') })));
  hw.append(frow(t('fp.dnt'), seg(fp.doNotTrack ? 'on' : 'off', [['off', t('state.off')], ['on', t('state.on')]], (v) => { fp.doNotTrack = v === 'on'; ch(); })));
  b.append(section(t('fp.params'), hw));
}

// ------------------------------------------------------------------ Browser settings

function browser(b: HTMLElement, d: Draft, draw: () => void, summary: () => void): void {
  // Protection level
  if (d.kind === 'tor') b.append(h('p', { class: 'info', text: t('edit.torFixed') }));
  else {
    const levels: Array<[Level, string]> = [['normal', t('level.normal')], ['standard', t('level.standard')], ['strict', t('level.strict')]];
    b.append(section(t('privacy.level'),
      seg<Level>(d.protection.level, levels, (v) => { d.protection = { level: v, overrides: {} }; draw(); }, 'big'),
      h('p', { class: 'hint', text: t(`level.${d.protection.level}.desc`) })));
    const grid = h('div', { class: 'ov-grid' });
    const ov = d.protection.overrides;
    const list = d.fp ? OVERRIDES : [...OVERRIDES, ...ENGINE_OVERRIDES];
    for (const o of list) {
      const cur = ov[o.key];
      const presetVal = o.type === 'enum' ? PRESET_VALUES[d.protection.level === 'strict' ? 'strict' : 'standard'][o.key] : undefined;
      const ctl = o.type === 'bool'
        ? select<string>(cur === undefined ? 'preset' : cur ? 'on' : 'off', [['preset', t('edit.preset')], ['on', t('state.on')], ['off', t('state.off')]], (v) => { if (v === 'preset') delete ov[o.key]; else ov[o.key] = v === 'on'; summary(); })
        : select<string>(cur === undefined ? 'preset' : String(cur), [['preset', `${t('edit.preset')}${presetVal ? ` (${t(`${o.key === 'hardwareApis' ? 'hardware' : o.key}.${presetVal}`)})` : ''}`], ...o.values!.map((x) => [x, t(`${o.key === 'hardwareApis' ? 'hardware' : o.key}.${x}`)] as [string, string])], (v) => { if (v === 'preset') delete ov[o.key]; else ov[o.key] = v; summary(); });
      grid.append(h('span', { text: t(`ov.${o.key}`) }), ctl);
    }
    b.append(section(t('edit.overrides'), h('p', { class: 'hint', text: t('edit.overridesHint') }), grid));
  }

  // Start page, history, session, theme
  const home = input(d.homePage, { maxlength: '2048', placeholder: 'octo://newtab' }, (v) => { d.homePage = v; });
  const theme = seg<'dark' | 'light'>(d.theme, [['dark', t('profile.theme.dark'), 'moon'], ['light', t('profile.theme.light'), 'star']], (v) => { d.theme = v; summary(); });
  b.append(section(t('ui.sec.browser'),
    field('profile.homePage', home, 'profile.homePageHint'),
    h('div', { class: 'field' }, h('span', { class: 'lbl', text: t('profile.theme') }), theme, h('span', { class: 'hint', text: t('profile.themeHint') })),
    h('div', { class: 'toggles' },
      toggle(d.keepHistory, 'profile.keepHistory', (v) => { d.keepHistory = v; summary(); }),
      toggle(d.restoreSession, 'profile.restoreSession', (v) => { d.restoreSession = v; }),
      toggle(d.deleteOnClose || d.kind === 'temporary', 'profile.deleteOnClose', (v) => { d.deleteOnClose = v; summary(); }, d.kind === 'temporary')),
    h('p', { class: 'hint', text: t('profile.historyNote') })));

  // DNS
  if (d.kind !== 'tor') {
    const tpl = input(d.dns.dohTemplate || '', { maxlength: '512', placeholder: 'https://dns.quad9.net/dns-query' }, (v) => { d.dns.dohTemplate = v.trim(); });
    tpl.classList.toggle('hidden', d.dns.mode !== 'doh');
    b.append(section(t('dns.label'), seg(d.dns.mode, [['inherit', t('dns.inherit')], ['system', t('dns.system')], ['doh', t('dns.doh')]], (v) => { d.dns.mode = v; tpl.classList.toggle('hidden', v !== 'doh'); }), tpl, h('p', { class: 'hint', text: t('net.vpnNote') })));
  }

  // Isolation / devices
  const sb = d.sandbox;
  b.append(section(t('edit.tab.sandbox'),
    field('iso.mode', select(sb.mode, [['none', t('iso.mode.none')], ['restricted', t('iso.mode.restricted')], ['windows-sandbox', `${t('iso.mode.windows-sandbox')} (${t('sandbox.testVersion')})`]], (v) => { sb.mode = v; summary(); }), S.init.windowsSandbox ? 'sandbox.hint' : 'sandbox.hintNoWsb'),
    field('iso.clipboard', select(sb.clipboard, [['allow', t('iso.clipboard.allow')], ['write-only', t('iso.clipboard.write-only')], ['block', t('iso.clipboard.block')]], (v) => { sb.clipboard = v; })),
    h('div', { class: 'toggles' },
      toggle(sb.camera, 'sandbox.camera', (v) => { sb.camera = v; }),
      toggle(sb.microphone, 'sandbox.microphone', (v) => { sb.microphone = v; }),
      toggle(sb.externalDevices, 'sandbox.devices', (v) => { sb.externalDevices = v; }),
      toggle(sb.shareDownloads, 'sandbox.shareDownloads', (v) => { sb.shareDownloads = v; })),
    h('p', { class: 'hint', text: t('sandbox.appContainerNote') })));

  // Add-ons
  if (d.kind !== 'tor') {
    const set = new Set(d.addons);
    const list = h('div', { class: 'addons' });
    for (const a of S.init.addons) {
      const tg = toggle(set.has(a.id), 'addons.enabled', (v) => { if (v) set.add(a.id); else set.delete(a.id); d.addons = [...set]; }, a.kind === 'external-app');
      list.append(h('div', { class: 'addon' }, h('div', { class: 'row between' }, h('b', { text: a.name }), tg), h('div', { class: 'small muted', text: L(a.description) })));
    }
    b.append(section(t('edit.tab.addons'), h('p', { class: 'hint', text: t('addons.intro') }), list));
  }
}

function notes(b: HTMLElement, d: Draft): void {
  const ta = h('textarea', { class: 'notes', maxlength: '5000', placeholder: t('ui.notesPh'), 'aria-label': t('ui.tab.notes') });
  ta.value = d.notes;
  ta.oninput = () => { d.notes = ta.value; };
  b.append(section(t('ui.tab.notes'), ta, h('p', { class: 'hint', text: t('ui.notesHint') })));
}

// ------------------------------------------------------------------ summary

function summaryPanel(d: Draft, renew: () => Promise<void>, creating: boolean): HTMLElement {
  const box = h('div', { class: 'sum' });
  const row = (k: string, v: string, cls = '') => box.append(h('div', { class: `sum-kv ${cls}` }, h('span', { class: 'k', text: k }), h('span', { class: 'v', text: v, title: v })));
  const head = h('div', { class: 'sum-head' }, h('b', { text: t('ui.summary') }));
  if (d.fp || d.kind === 'antidetect') {
    const nf = h('button', { class: 'btn outline small upper' }, icon('shuffle', 14), h('span', { text: t('fp.newFingerprint') }));
    nf.onclick = () => void renew();
    head.append(nf);
  }
  box.append(head);
  row(t('profile.name'), d.name.trim() || (creating ? t('ui.namePhAuto') : ''));
  row(t('profile.kind'), t(`profile.kind.${d.kind}`));
  const px = d.proxy;
  const proxyLabel = px.mode === 'none' ? t('proxy.none') : px.mode === 'saved' ? (S.proxies.find((s) => s.id === px.savedId)?.name || proxyText(S.proxies.find((s) => s.id === px.savedId) ?? { type: '', host: '—', port: 0 })) : (() => {
    const r = parseProxy(px.text, px.type);
    return r.ok && r.proxy ? `${r.proxy.type}://${r.proxy.host}:${r.proxy.port}` : px.text ? t('proxy.invalid') : '—';
  })();
  row(t('ui.col.proxy'), proxyLabel);
  if (px.check?.ok) row(t('proxy.ip'), `${px.check.ip ?? ''}${px.check.countryCode ? ` (${px.check.countryCode.toUpperCase()})` : ''}`);
  const fp = d.fp;
  if (fp) {
    const c = px.check?.ok ? px.check : undefined;
    const auto = (mode: string, value: string, fromIp?: string) => (mode === 'auto' ? `${t('fp.v.autoIp')}${fromIp ? ` · ${fromIp}` : ''}` : mode === 'real' ? t('fp.v.real') : value);
    box.append(h('div', { class: 'sum-sep' }));
    row(t('fp.os'), osLabel(fp.os));
    row(t('fp.userAgent'), fp.userAgent, 'ua');
    row(t('fp.webrtc'), t(`fp.v.${fp.webrtc.mode === 'disable-udp' ? 'disableUdp' : fp.webrtc.mode}`) + (fp.webrtc.mode === 'manual' && fp.webrtc.publicIp ? ` · ${fp.webrtc.publicIp}` : ''));
    row(t('fp.canvas'), t(`fp.v.${fp.canvas}`));
    row(t('fp.webgl'), t(`fp.v.${fp.webgl}`));
    row(t('fp.webglInfo'), fp.webglInfo.mode === 'manual' ? fp.webglInfo.renderer.replace(/^ANGLE \(([^,]+), (.+?)( \(0x[0-9A-F]+\))? Direct3D.*$/, '$2').replace(/^ANGLE \(Apple, ANGLE Metal Renderer: (.+?),.*$/, '$1') : t('fp.v.real'));
    row(t('fp.webgpu'), t(`fp.v.${fp.webgpu}`));
    row(t('fp.clientRects'), t(`fp.v.${fp.clientRects}`));
    row(t('fp.timezone'), auto(fp.timezone.mode, fp.timezone.value, c?.timezone));
    row(t('fp.language'), auto(fp.language.mode, fp.language.value));
    row(t('fp.geolocation'), fp.geolocation.mode === 'block' ? t('fp.v.block') : fp.geolocation.mode === 'auto' ? auto('auto', '', c?.city) : `${fp.geolocation.latitude}, ${fp.geolocation.longitude}`);
    row(t('fp.cpu'), fp.cpu.mode === 'manual' ? t('fp.coresN', { n: fp.cpu.cores }) : t('fp.v.real'));
    row(t('fp.memory'), fp.memory.mode === 'manual' ? `${fp.memory.gb} GB` : t('fp.v.real'));
    row(t('fp.screen'), fp.screen.mode === 'manual' ? `${fp.screen.width} × ${fp.screen.height}` : t('fp.v.real'));
    row(t('fp.fonts'), t(`fp.v.${fp.fonts}`));
    row(t('fp.audio'), t(`fp.v.${fp.audio}`));
    row(t('fp.media'), fp.mediaDevices.mode === 'manual' ? `${fp.mediaDevices.audioInputs} / ${fp.mediaDevices.audioOutputs} / ${fp.mediaDevices.videoInputs}` : t('fp.v.real'));
    row(t('fp.ports'), fp.ports.mode === 'protect' ? t('fp.v.protect') : t('fp.v.real'));
    row(t('fp.dnt'), t(fp.doNotTrack ? 'state.on' : 'state.off'));
  } else if (d.kind !== 'tor') {
    box.append(h('div', { class: 'sum-sep' }));
    row(t('ui.fingerprint'), t('fp.offShort'));
  }
  box.append(h('div', { class: 'sum-sep' }));
  row(t('privacy.level'), t(`level.${d.protection.level}`));
  row(t('iso.mode'), t(`iso.mode.${d.sandbox.mode}`));
  row(t('profile.keepHistory'), t(d.keepHistory ? 'state.on' : 'state.off'));
  row(t('profile.deleteOnClose'), t(d.deleteOnClose || d.kind === 'temporary' ? 'state.on' : 'state.off'));
  box.append(h('p', { class: 'hint', text: d.kind === 'antidetect' ? t('fp.summaryHint') : t('profile.stableHint') }));
  return box;
}
