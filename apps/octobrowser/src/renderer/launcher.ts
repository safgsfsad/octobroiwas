/**
 * apps/octobrowser/src/renderer/launcher.ts
 *
 * Launcher / profile manager UI: profile cards and editor, pre-launch
 * isolation summary, 12-word profile encryption, import/export, security,
 * updates, settings, logs and backups, about + network connections.
 */
import { api, clear } from '@octo/shell/renderer/bridge';
import { applyI18n, h, setDicts, setLang, t, Dicts, getLang } from '@octo/shell/renderer/i18n-client';
import { icon } from '@octo/shell/renderer/icons';
import { phraseDisplay, phraseEntry } from '@octo/shell/renderer/phrase';
import { keyProtectionPanel } from '@octo/shell/renderer/keypanel';

// ------------------------------------------------------------------ types

type Kind = 'personal' | 'work' | 'private' | 'testing' | 'temporary' | 'tor' | 'custom';
interface Profile {
  id: string; name: string; kind: Kind; color: string; createdAt: string; updatedAt: string;
  protection: { level: 'standard' | 'strict' | 'tor'; overrides?: Record<string, unknown> };
  network: { mode: 'system' | 'direct' | 'proxy'; proxyRules?: string; proxyBypass?: string; hasProxyCredentials?: boolean };
  dns: { mode: 'inherit' | 'system' | 'doh'; dohTemplate: string };
  sandbox: { mode: 'none' | 'restricted' | 'windows-sandbox'; clipboard: 'allow' | 'write-only' | 'block'; camera: boolean; microphone: boolean; externalDevices: boolean; shareDownloads: boolean };
  audio: { muted: boolean; volume: number; outputDeviceId: string };
  addons: string[]; encrypted: boolean; deleteOnClose: boolean; keepHistory: boolean; restoreSession: boolean; homePage: string;
  theme: 'dark' | 'light';
  // runtime info from the manager
  running: boolean; sealed: boolean; hasVault: boolean; needsResealing: boolean; issues: Array<{ key: string; severity: string }>; hasProxyCredentials: boolean;
}
interface AddonInfo { id: string; name: string; description: { en: string; pl: string }; version: string; license: string; permissions: Array<{ en: string; pl: string }>; source: string; kind: string; status: string; integrity: { en: string; pl: string } }
interface UpdateStatus {
  configured: boolean; current: string; latest: string | null; available: boolean; severity?: string; changelog?: { en: string; pl: string };
  components?: string[]; requiresRestart?: boolean; lastCheckAt?: string; lastResult?: string; error?: string;
  downloading?: { done: number; total: number }; readyToInstall?: string; rollbackAvailable: string[];
}
interface Settings {
  updates: { autoCheck: boolean; backgroundCheck: boolean; channel: 'stable' | 'beta' };
  network: { publicIpLookup: boolean; autoRefresh: boolean; searchEngine: string; dns: { mode: 'system' | 'doh'; provider: string; customTemplate: string } };
  security: { autoLockMinutes: number; secretStore: 'local' | 'credman' }; logs: { mode: 'standard' | 'diagnostic' };
  ui: { verticalTabs: boolean; sleepTabsAfterMin: number; showStartupSplash: boolean; showBookmarksBar: boolean; confirmOnQuit: boolean; openLinksInBackground: boolean }; tor: { torBrowserPath: string }; offline: boolean;
}
interface Init {
  lang: 'en' | 'pl'; dicts: Dicts; version: string; dataDir: string; addons: AddonInfo[]; kinds: Kind[];
  windowsSandbox: boolean; torBrowser: boolean; settings: Settings; update: UpdateStatus; logMode: 'standard' | 'diagnostic'; filtersUpdatedAt: string | null;
  keyringMode: 'os' | 'password' | null; keyringRequiresPassword: boolean; secretBackend: 'local' | 'credman'; credmanAvailable: boolean;
}
interface IsoItem { labelKey: string; value: string; state: 'allowed' | 'blocked' | 'limited' | 'info' }
type View = 'profiles' | 'security' | 'updates' | 'settings' | 'logs' | 'about';

let init: Init;
let profiles: Profile[] = [];
let view: View = 'profiles';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const L = (o: { en: string; pl: string }) => o[getLang()] ?? o.en;
const tv = (v: string) => (v.startsWith('t:') ? t(v.slice(2)) : v);

// ------------------------------------------------------------------ helpers

function toast(text: string, kind: 'ok' | 'err' | 'info' = 'info'): void {
  const el = h('div', { class: `toast ${kind}`, text });
  $('toasts').append(el);
  setTimeout(() => el.remove(), 4500);
}

async function run<T>(p: Promise<T>, okKey?: string): Promise<T | undefined> {
  try {
    const r = await p;
    if (okKey) toast(t(okKey), 'ok');
    return r;
  } catch (err) {
    toast(String((err as Error).message ?? err), 'err');
    return undefined;
  }
}

function closeModal(): void {
  $('modal').classList.add('hidden');
  clear($('modalBox'));
}

function modal(title: string, build: (box: HTMLElement) => void, wide = false): void {
  const box = $('modalBox');
  clear(box);
  box.className = `modal-box${wide ? ' wide' : ''}`;
  const close = h('button', { class: 'icon-btn', title: t('common.close') }, icon('close', 16));
  close.onclick = closeModal;
  box.append(h('div', { class: 'modal-head' }, h('h2', { text: title }), close));
  build(box);
  $('modal').classList.remove('hidden');
  (box.querySelector('input,select,button.primary') as HTMLElement | null)?.focus();
}

function field(labelKey: string, control: HTMLElement, hintKey?: string): HTMLElement {
  return h('label', { class: 'field' }, h('span', { class: 'lbl', text: t(labelKey) }), control, hintKey ? h('span', { class: 'hint', text: t(hintKey) }) : null);
}

function select<T extends string>(value: T, options: Array<[T, string]>, onChange?: (v: T) => void): HTMLSelectElement {
  const s = h('select', {});
  for (const [v, label] of options) {
    const o = h('option', { value: v, text: label });
    if (v === value) o.selected = true;
    s.append(o);
  }
  if (onChange) s.onchange = () => onChange(s.value as T);
  return s;
}

function toggle(checked: boolean, labelKey: string, onChange?: (v: boolean) => void, disabled = false): HTMLElement {
  const inp = h('input', { type: 'checkbox', checked, disabled });
  // The state is written out as text as well, so it never depends on the switch shape alone.
  const state = h('span', { class: 'sw-state', text: t(checked ? 'state.on' : 'state.off') });
  if (onChange) inp.onchange = () => { onChange(inp.checked); state.textContent = t(inp.checked ? 'state.on' : 'state.off'); };
  return h('label', { class: 'toggle' }, inp, h('span', { class: 'sw' }), h('span', { text: t(labelKey) }), state);
}

// ------------------------------------------------------------------ layout

const NAV: Array<[View, string]> = [
  ['profiles', 'users'], ['security', 'shield'], ['updates', 'refreshCircle'], ['settings', 'settings'], ['logs', 'file'], ['about', 'info'],
];

function renderNav(): void {
  const nav = $('nav');
  clear(nav);
  for (const [v, ic] of NAV) {
    const b = h('button', { class: `nav-item${v === view ? ' active' : ''}` }, icon(ic, 18), h('span', { text: t(`launcher.nav.${v}`) }));
    if (v === 'updates' && init.update.available) b.append(h('span', { class: 'dot-badge' }));
    b.onclick = () => { view = v; render(); };
    nav.append(b);
  }
  $('sideFoot').textContent = `v${init.version}`;
}

function renderTop(): void {
  const s = $('secStatus');
  clear(s);
  const attention = profiles.some((p) => p.needsResealing) || !init.update.configured;
  s.append(
    h('span', { class: `pill ${attention ? 'warn' : 'ok'}` }, icon(attention ? 'shieldAlert' : 'shieldCheck', 14), ` ${t(attention ? 'status.attention' : 'status.protectionActive')}`),
    h('span', { class: 'pill' }, icon('lock', 14), ` ${t('keyring.local')}`),
    h('span', { class: 'pill' }, icon('folder', 14), ` ${init.dataDir}`),
  );
  const lock = $('lockAll');
  clear(lock);
  lock.append(icon('lock', 15), ` ${t('launcher.lockNow')}`);
  lock.onclick = () => void run(api.invoke('mgr:lock-all'));
}

function render(): void {
  renderNav();
  renderTop();
  const v = $('view');
  clear(v);
  switch (view) {
    case 'profiles': renderProfiles(v); break;
    case 'security': renderSecurity(v); break;
    case 'updates': renderUpdates(v); break;
    case 'settings': renderSettings(v); break;
    case 'logs': void renderLogs(v); break;
    case 'about': renderAbout(v); break;
  }
}

// ------------------------------------------------------------------ profiles

function renderProfiles(v: HTMLElement): void {
  const head = h('div', { class: 'view-head' }, h('h1', { text: t('launcher.nav.profiles') }));
  const add = h('button', { class: 'btn primary' }, icon('plus', 15), ` ${t('profile.new')}`);
  add.onclick = newProfileDialog;
  const imp = h('button', { class: 'btn' }, icon('import', 15), ` ${t('profile.import')}`);
  imp.onclick = importDialog;
  const detect = h('button', { class: 'btn' }, icon('fingerprint', 15), ` ${t('privacy.runDetect')}`);
  detect.onclick = () => void run(api.invoke('mgr:launch-detect'));
  const priv = h('button', { class: 'btn' }, icon('eyeOff', 15), ` ${t('profile.privateBrowsing')}`);
  priv.title = t('profile.privateBrowsingHint');
  priv.onclick = privateBrowsingDialog;
  head.append(h('div', { class: 'row' }, detect, priv, imp, add));
  v.append(head);

  // No profiles yet: a centred starting point instead of an empty grid.
  if (!profiles.length) {
    const create = h('button', { class: 'btn primary' }, icon('plus', 16), ` ${t('profile.new')}`);
    create.onclick = newProfileDialog;
    const quick = h('button', { class: 'btn' }, icon('eyeOff', 16), ` ${t('profile.privateBrowsing')}`);
    quick.onclick = privateBrowsingDialog;
    v.append(h('div', { class: 'empty' },
      h('div', { class: 'empty-icon' }, icon('shield', 46)),
      h('h2', { text: t('profiles.empty.title') }),
      h('p', { class: 'muted', text: t('profiles.empty.text') }),
      h('div', { class: 'row' }, quick, create),
    ));
    return;
  }

  const grid = h('div', { class: 'cards' });
  for (const p of profiles) grid.append(profileCard(p));
  v.append(grid);
}

function profileCard(p: Profile): HTMLElement {
  const card = h('article', { class: `card${p.running ? ' running' : ''}` });
  card.style.setProperty('--pc', p.color);
  const icons = h('div', { class: 'card-icons' });
  const ic = (name: string, titleKey: string, cls = '') => icons.append(h('span', { class: `ci ${cls}`, title: t(titleKey) }, icon(name, 15)));
  ic('shield', `level.${p.protection.level}`, p.protection.level === 'standard' ? '' : 'on');
  if (p.encrypted) ic('lock', p.sealed ? 'profile.sealed' : 'profile.unsealed', 'on');
  if (p.sandbox.mode !== 'none') ic('box', `iso.mode.${p.sandbox.mode}`, 'on');
  if (p.network.mode === 'proxy') ic('network', 'net.mode.proxy', 'on');
  if (p.kind === 'tor') ic('tor', 'profile.kind.tor', 'on');
  if (p.deleteOnClose || p.kind === 'temporary') ic('trash', 'profile.deleteOnClose');

  const launch = h('button', { class: 'btn primary' }, icon(p.running ? 'eye' : 'play', 15), ` ${t(p.running ? 'profile.focus' : 'profile.launch')}`);
  launch.onclick = () => preLaunch(p);
  const edit = h('button', { class: 'btn' }, icon('edit', 15));
  edit.title = t('common.edit');
  edit.onclick = () => editProfile(p);
  const more = h('button', { class: 'btn' }, icon('menu', 15));
  more.title = t('common.more');
  more.onclick = () => profileActions(p);

  card.append(
    h('div', { class: 'card-top' }, h('span', { class: 'avatar', text: p.name.slice(0, 1).toUpperCase() }), h('div', { class: 'grow' }, h('b', { text: p.name }), h('div', { class: 'muted small', text: t(`profile.kindTag.${p.kind}`) })), p.running ? h('span', { class: 'live', text: t('profile.running') }) : null),
    h('div', { class: 'chips' }, h('span', { class: 'chip', text: t(`level.${p.protection.level}`) }), h('span', { class: 'chip', text: t(`net.mode.${p.network.mode}`) })),
    icons,
  );
  if (p.needsResealing) card.append(h('div', { class: 'warn-line small', text: t('profile.needsResealing') }));
  const warn = p.issues.filter((i) => i.severity === 'warn');
  if (warn.length) card.append(h('div', { class: 'warn-line small', text: t(warn[0].key) }));
  card.append(h('div', { class: 'card-actions' }, launch, edit, more));
  return card;
}

// ------------------------------------------------------ create profile

/**
 * Values of the two built-in presets, mirrored from packages/core/src/privacy.ts.
 * The renderer bundle runs in the browser and cannot import the Node-only core
 * package, so the live summary reads them from here - keep them in sync.
 */
const PRESET_VALUES: Record<'standard' | 'strict', Record<string, string>> = {
  standard: { webrtc: 'default_public_interface_only', canvas: 'allow', webgl: 'allow', hardwareApis: 'allow' },
  strict: { webrtc: 'disable_non_proxied_udp', canvas: 'block-readback', webgl: 'disabled', hardwareApis: 'normalize' },
};

/** Draft of the create dialog. Defaults mirror `defaultProfile(kind)` in core. */
interface NpDraft {
  name: string;
  kind: Kind;
  homePage: string;
  level: 'standard' | 'strict' | 'tor';
  overrides: Record<string, boolean | string>;
  netMode: 'system' | 'direct' | 'proxy';
  proxyRules: string;
  proxyBypass: string;
  proxyUser: string;
  proxyPass: string;
  dnsMode: 'inherit' | 'system' | 'doh';
  sandboxMode: 'none' | 'restricted' | 'windows-sandbox';
  theme: 'dark' | 'light';
  clipboard: 'allow' | 'write-only' | 'block';
  camera: boolean;
  microphone: boolean;
  externalDevices: boolean;
  keepHistory: boolean;
  restoreSession: boolean;
  deleteOnClose: boolean;
}

function npDraft(kind: Kind): NpDraft {
  return {
    name: '',
    kind,
    homePage: '',
    level: kind === 'tor' ? 'tor' : kind === 'private' || kind === 'temporary' ? 'strict' : 'standard',
    overrides: {},
    netMode: 'system',
    proxyRules: '', proxyBypass: '', proxyUser: '', proxyPass: '',
    dnsMode: 'inherit',
    sandboxMode: kind === 'testing' || kind === 'private' ? 'restricted' : 'none',
    theme: 'dark',
    clipboard: kind === 'private' || kind === 'temporary' ? 'write-only' : 'allow',
    camera: kind === 'personal' || kind === 'work',
    microphone: kind === 'personal' || kind === 'work',
    externalDevices: false,
    keepHistory: kind === 'personal' || kind === 'work',
    restoreSession: kind === 'personal' || kind === 'work',
    deleteOnClose: kind === 'temporary',
  };
}

/** Effective value of a privacy setting: the user's override wins over the preset. */
function npEffective(d: NpDraft, key: string): string {
  const ov = d.overrides[key];
  if (ov !== undefined) return typeof ov === 'boolean' ? (ov ? 'on' : 'off') : String(ov);
  return PRESET_VALUES[d.level === 'strict' ? 'strict' : 'standard'][key] ?? '-';
}

/** The part of the draft that becomes the profile (sent to `mgr:create`). */
function npPatch(d: NpDraft): Record<string, unknown> {
  return {
    name: d.name.trim(),
    homePage: d.homePage || 'octo://newtab',
    protection: { level: d.level, overrides: d.overrides },
    network: { mode: d.netMode, proxyRules: d.proxyRules || undefined, proxyBypass: d.proxyBypass || undefined },
    dns: { mode: d.dnsMode, dohTemplate: '' },
    sandbox: {
      mode: d.sandboxMode, clipboard: d.clipboard, camera: d.camera, microphone: d.microphone,
      externalDevices: d.externalDevices,
    },
    keepHistory: d.keepHistory,
    restoreSession: d.restoreSession,
    deleteOnClose: d.deleteOnClose,
    theme: d.theme,
  };
}

/** Live summary on the right of the dialog - what the profile will really do. */
function npSummary(d: NpDraft): HTMLElement {
  const row = (k: string, v: string) => h('div', { class: 'np-kv' }, h('span', { class: 'k', text: k }), h('span', { class: 'v', text: v }));
  const onOff = (v: boolean) => t(v ? 'state.on' : 'state.off');
  return h('div', { class: 'np-summary' },
    h('div', { class: 'np-summary-head' }, icon('fingerprint', 16), h('b', { text: t('profile.summary') })),
    h('div', { class: 'np-badge' }, icon('check', 13), h('span', { text: t('profile.stable') })),
    row(t('profile.name'), d.name.trim() || t('profile.namePh')),
    row(t('profile.kind'), t(`profile.kindTag.${d.kind}`)),
    row(t('privacy.level'), t(`level.${d.level}`)),
    row(t('net.modeLabel'), t(`net.mode.${d.netMode}`)),
    row(t('profile.theme'), t(`profile.theme.${d.theme}`)),
    row(t('ov.webrtc'), t(`webrtc.${npEffective(d, 'webrtc')}`)),
    row(t('ov.canvas'), t(`canvas.${npEffective(d, 'canvas')}`)),
    row(t('ov.webgl'), t(`webgl.${npEffective(d, 'webgl')}`)),
    row(t('ov.hardwareApis'), t(`hardware.${npEffective(d, 'hardwareApis')}`)),
    row(t('iso.mode'), t(`iso.mode.${d.sandboxMode}`)),
    row(t('profile.keepHistory'), onOff(d.keepHistory)),
    row(t('ov.clearOnExit'), onOff(npEffective(d, 'clearOnExit') === 'on')),
    row(t('profile.deleteOnClose'), onOff(d.deleteOnClose)),
    h('p', { class: 'hint', text: t('profile.stableHint') }),
  );
}

/** One "preset / on / off" (or enum) row of the protection tab. */
function npOverrideRow(d: NpDraft, o: { key: string; type: 'bool' | 'enum'; values?: string[] }, redraw: () => void): HTMLElement {
  const ov = d.overrides;
  const cur = ov[o.key];
  const label = t(`ov.${o.key}`);
  let ctl: HTMLSelectElement;
  if (o.type === 'bool') {
    ctl = select<string>(cur === undefined ? 'preset' : cur ? 'on' : 'off', [['preset', t('edit.preset')], ['on', t('state.on')], ['off', t('state.off')]], (v) => {
      if (v === 'preset') delete ov[o.key]; else ov[o.key] = v === 'on';
      redraw();
    });
  } else {
    ctl = select<string>(cur === undefined ? 'preset' : String(cur), [['preset', t('edit.preset')], ...o.values!.map((x) => [x, t(`${o.key === 'hardwareApis' ? 'hardware' : o.key}.${x}`)] as [string, string])], (v) => {
      if (v === 'preset') delete ov[o.key]; else ov[o.key] = v;
      redraw();
    });
  }
  return h('div', { class: 'ov-row' }, h('span', { text: label }), ctl);
}

const NP_OVERRIDES: Array<{ key: string; type: 'bool' | 'enum'; values?: string[] }> = [
  { key: 'blockAds', type: 'bool' }, { key: 'blockTrackers', type: 'bool' }, { key: 'httpsOnly', type: 'bool' },
  { key: 'blockThirdPartyCookies', type: 'bool' }, { key: 'stripTrackingParams', type: 'bool' },
  { key: 'webrtc', type: 'enum', values: ['default', 'default_public_interface_only', 'disable_non_proxied_udp'] },
  { key: 'canvas', type: 'enum', values: ['allow', 'block-readback'] },
  { key: 'webgl', type: 'enum', values: ['allow', 'disabled'] },
  { key: 'hardwareApis', type: 'enum', values: ['allow', 'normalize'] },
  { key: 'clearOnExit', type: 'bool' }, { key: 'blockPopups', type: 'bool' }, { key: 'blockAutoplay', type: 'bool' },
];

function npGeneral(b: HTMLElement, d: NpDraft, kinds: Kind[], all: () => void, summary: () => void): void {
  const name = h('input', { type: 'text', maxlength: '64', placeholder: t('profile.namePh') });
  name.value = d.name;
  name.oninput = () => { d.name = name.value; summary(); };
  const kind = select<Kind>(d.kind, kinds.map((k) => [k, t(`profile.kind.${k}`)] as [Kind, string]), (v) => {
    const keep = d.name;
    Object.assign(d, npDraft(v), { name: keep });
    all();
  });
  const desc = h('p', { class: 'hint', text: t(`profile.kindDesc.${d.kind}`) });
  const home = h('input', { type: 'text', maxlength: '2048', placeholder: 'octo://newtab' });
  home.value = d.homePage ?? '';
  home.oninput = () => { d.homePage = home.value.trim(); summary(); };
  const theme = select<'dark' | 'light'>(d.theme, [['dark', t('profile.theme.dark')], ['light', t('profile.theme.light')]], (v) => {
    d.theme = v;
    summary();
  });
  b.append(
    field('profile.name', name), field('profile.kind', kind), desc,
    field('profile.homePage', home, 'profile.homePageHint'),
    field('profile.theme', theme, 'profile.themeHint'),
    toggle(d.keepHistory, 'profile.keepHistory', (v) => { d.keepHistory = v; summary(); }),
    toggle(d.restoreSession, 'profile.restoreSession', (v) => { d.restoreSession = v; summary(); }),
    h('p', { class: 'hint', text: t('profile.historyNote') }),
  );
}

function npProtection(b: HTMLElement, d: NpDraft, summary: () => void): void {
  if (d.kind === 'tor') {
    b.append(h('p', { class: 'info', text: t('edit.torFixed') }));
    return;
  }
  const lvl = select<'standard' | 'strict'>(d.level === 'strict' ? 'strict' : 'standard', [['standard', t('level.standard')], ['strict', t('level.strict')]], (v) => {
    d.level = v;
    d.overrides = {};
    summary();
  });
  b.append(field('privacy.level', lvl), h('p', { class: 'hint', text: t(`level.${d.level}.desc`) }));
  const grid = h('div', { class: 'ov-grid' });
  for (const o of NP_OVERRIDES) grid.append(npOverrideRow(d, o, summary));
  b.append(h('h3', { text: t('edit.overrides') }), h('p', { class: 'hint', text: t('edit.overridesHint') }), grid);
  b.append(h('p', { class: 'hint', text: t('privacy.consistentNote') }));
}

function npNetwork(b: HTMLElement, d: NpDraft, summary: () => void): void {
  if (d.kind === 'tor') {
    b.append(h('p', { class: 'info', text: t('net.torNotHere') }));
    return;
  }
  const mode = select(d.netMode, [['system', t('net.mode.system')], ['direct', t('net.mode.direct')], ['proxy', t('net.mode.proxy')]], (v) => {
    d.netMode = v;
    summary();
  });
  b.append(field('net.modeLabel', mode));
  if (d.netMode === 'proxy') {
    const rules = h('input', { type: 'text', maxlength: '512', placeholder: 'socks5://127.0.0.1:9050' });
    rules.value = d.proxyRules;
    rules.oninput = () => { d.proxyRules = rules.value.trim(); summary(); };
    const bypass = h('input', { type: 'text', maxlength: '512', placeholder: '<local>' });
    bypass.value = d.proxyBypass;
    bypass.oninput = () => { d.proxyBypass = bypass.value.trim(); };
    const user = h('input', { type: 'text', maxlength: '256', autocomplete: 'off' });
    user.value = d.proxyUser;
    user.oninput = () => { d.proxyUser = user.value; };
    const pass = h('input', { type: 'password', maxlength: '256', autocomplete: 'new-password' });
    pass.oninput = () => { d.proxyPass = pass.value; };
    b.append(
      field('net.proxyRules', rules, 'net.proxyRulesHint'), field('net.proxyBypass', bypass),
      field('net.proxyUser', user), field('net.proxyPass', pass, 'net.credsHint'),
    );
  }
  const dns = select(d.dnsMode, [['inherit', t('dns.inherit')], ['system', t('dns.system')], ['doh', t('dns.doh')]], (v) => { d.dnsMode = v; summary(); });
  b.append(field('dns.label', dns));
  if (d.dnsMode === 'doh') {
    const tpl = h('input', { type: 'text', maxlength: '512', placeholder: 'https://dns.quad9.net/dns-query' });
    b.append(field('dns.template', tpl, 'dns.templateHint'));
  }
  b.append(h('p', { class: 'hint', text: t('net.vpnNote') }));
}

function npIsolation(b: HTMLElement, d: NpDraft, summary: () => void): void {
  const mode = select(d.sandboxMode, [['none', t('iso.mode.none')], ['restricted', t('iso.mode.restricted')], ['windows-sandbox', `${t('iso.mode.windows-sandbox')} (${t('sandbox.testVersion')})`]], (v) => {
    d.sandboxMode = v;
    summary();
  });
  const clip = select(d.clipboard, [['allow', t('iso.clipboard.allow')], ['write-only', t('iso.clipboard.write-only')], ['block', t('iso.clipboard.block')]], (v) => {
    d.clipboard = v;
    summary();
  });
  b.append(
    field('iso.mode', mode, init.windowsSandbox ? 'sandbox.hint' : 'sandbox.hintNoWsb'),
    field('iso.clipboard', clip),
    toggle(d.camera, 'sandbox.camera', (v) => { d.camera = v; summary(); }),
    toggle(d.microphone, 'sandbox.microphone', (v) => { d.microphone = v; summary(); }),
    toggle(d.externalDevices, 'sandbox.devices', (v) => { d.externalDevices = v; summary(); }),
    h('p', { class: 'hint', text: t('sandbox.appContainerNote') }),
  );
}

/**
 * Create dialog: tabs on the left, a live summary of what the profile will
 * really do on the right. Values are descriptive and stable - the dialog never
 * offers to spoof hardware, randomise a fingerprint or hide the browser.
 */
function newProfileDialog(): void {
  const kinds = init.kinds.filter((k) => k !== 'tor' || !profiles.some((p) => p.kind === 'tor'));
  const d = npDraft('custom');
  let tab: 'general' | 'protection' | 'network' | 'isolation' = 'general';
  modal(t('profile.new'), (box) => {
    const tabs = h('div', { class: 'tabs' });
    const left = h('div', { class: 'np-left' });
    const right = h('div', { class: 'np-right' });
    const summary = () => { clear(right); right.append(npSummary(d)); };
    const all = () => { draw(); summary(); };
    const draw = () => {
      clear(tabs);
      const TABS: Array<['general' | 'protection' | 'network' | 'isolation', string]> = [
        ['general', 'edit.tab.general'], ['protection', 'edit.tab.privacy'], ['network', 'edit.tab.network'], ['isolation', 'edit.tab.sandbox'],
      ];
      for (const [k, key] of TABS) {
        const b = h('button', { class: k === tab ? 'on' : '', text: t(key) });
        b.onclick = () => { tab = k; draw(); };
        tabs.append(b);
      }
      clear(left);
      if (tab === 'general') npGeneral(left, d, kinds, all, summary);
      if (tab === 'protection') npProtection(left, d, summary);
      if (tab === 'network') npNetwork(left, d, summary);
      if (tab === 'isolation') npIsolation(left, d, summary);
    };
    const cancel = h('button', { class: 'btn', text: t('common.cancel') });
    cancel.onclick = closeModal;
    const create = h('button', { class: 'btn primary' }, icon('check', 15), ` ${t('common.create')}`);
    create.onclick = async () => {
      const p = await run(api.invoke<Profile>('mgr:create', { name: d.name.trim() || t(`profile.kindTag.${d.kind}`), kind: d.kind, patch: npPatch(d) }));
      if (!p) return;
      if (d.proxyUser || d.proxyPass) await run(api.invoke('mgr:update', p.id, { proxyUsername: d.proxyUser, proxyPassword: d.proxyPass }));
      closeModal();
      toast(t('toast.profileCreated'), 'ok');
    };
    box.append(
      h('p', { class: 'np-banner' }, icon('shieldCheck', 15), h('span', { text: t('profile.newBanner') })),
      tabs, h('div', { class: 'np-body' }, left, right),
      h('div', { class: 'np-actions' }, h('span', { class: 'grow' }), cancel, create),
    );
    draw();
    summary();
  }, true);
  $('modalBox').classList.add('xwide');
}

/** Private browsing: one throw-away temporary profile, started right away. */
function privateBrowsingDialog(): void {
  modal(t('profile.privateTitle'), (box) => {
    const cancel = h('button', { class: 'btn', text: t('common.cancel') });
    cancel.onclick = closeModal;
    const start = h('button', { class: 'btn primary' }, icon('eyeOff', 15), ` ${t('profile.privateStart')}`);
    start.onclick = async () => {
      const r = await run(api.invoke<{ status: string }>('mgr:private-browse'));
      if (!r) return;
      closeModal();
      toast(t('profile.privateToast'), 'ok');
    };
    box.append(
      h('p', { text: t('profile.privateBody') }),
      h('p', { class: 'note small', text: t('profile.privateNote') }),
      h('div', { class: 'modal-actions' }, cancel, start),
    );
  });
}

function profileActions(p: Profile): void {
  modal(p.name, (box) => {
    const act = (ic: string, key: string, fn: () => void, danger = false) => {
      const b = h('button', { class: `menu-item${danger ? ' danger' : ''}` }, icon(ic, 16), ` ${t(key)}`);
      b.onclick = fn;
      box.append(b);
    };
    if (p.running) act('stop', 'profile.close', () => void run(api.invoke('mgr:close-profile', p.id)).then(closeModal));
    act('copy', 'profile.duplicate', () => duplicateDialog(p));
    act('export', 'profile.export', () => void exportDialog(p));
    act(p.encrypted ? 'unlock' : 'lock', p.encrypted ? 'profile.disableEncryption' : 'profile.enableEncryption', () => encryptionDialog(p));
    if (p.needsResealing) act('lock', 'profile.reseal', () => resealDialog(p));
    act('refreshCircle', 'profile.reset', () => confirmDialog(t('profile.resetConfirm', { name: p.name }), () => api.invoke('mgr:reset', p.id), 'toast.profileReset'), true);
    act('trash', 'profile.delete', () => confirmDialog(t('profile.deleteConfirm', { name: p.name }), () => api.invoke('mgr:remove', p.id), 'toast.profileDeleted'), true);
  });
}

function confirmDialog(text: string, fn: () => Promise<unknown>, okKey: string): void {
  modal(t('common.confirm'), (box) => {
    const ok = h('button', { class: 'btn danger', text: t('common.confirm') });
    ok.onclick = async () => { if ((await run(fn(), okKey)) !== undefined) closeModal(); };
    const cancel = h('button', { class: 'btn', text: t('common.cancel') });
    cancel.onclick = closeModal;
    box.append(h('p', { text }), h('div', { class: 'modal-actions' }, cancel, ok));
  });
}

function duplicateDialog(p: Profile): void {
  modal(t('profile.duplicate'), (box) => {
    const name = h('input', { type: 'text', maxlength: '64', value: `${p.name} (2)` });
    const data = toggle(false, 'profile.duplicateWithData');
    const ok = h('button', { class: 'btn primary', text: t('profile.duplicate') });
    ok.onclick = async () => {
      const withData = (data.querySelector('input') as HTMLInputElement).checked;
      if ((await run(api.invoke('mgr:duplicate', p.id, name.value.trim(), withData), 'toast.profileCreated')) !== undefined) closeModal();
    };
    box.append(field('profile.name', name), data, h('p', { class: 'hint', text: t('profile.duplicateHint') }), h('div', { class: 'modal-actions' }, ok));
  });
}

async function exportDialog(p: Profile): Promise<void> {
  // The file gets its own fresh phrase; the user has to confirm they wrote it down.
  const phrase = await run(api.invoke<string>('mgr:new-passphrase'));
  if (!phrase) return;
  modal(t('profile.export'), (box) => {
    const data = toggle(true, 'export.withData');
    const err = h('div', { class: 'err' });
    const ok = h('button', { class: 'btn primary', text: t('profile.export') }) as HTMLButtonElement;
    ok.disabled = true;
    const shown = phraseDisplay(phrase, (confirmed) => { ok.disabled = !confirmed; });
    ok.onclick = async () => {
      const withData = (data.querySelector('input') as HTMLInputElement).checked;
      ok.disabled = true;
      const r = await run(api.invoke<boolean>('mgr:export', p.id, phrase, withData));
      ok.disabled = false;
      if (r) { toast(t('toast.exported'), 'ok'); closeModal(); }
    };
    box.append(h('p', { class: 'info', text: t('export.info') }), shown.el, data, err, h('div', { class: 'modal-actions' }, ok));
  });
}

function importDialog(): void {
  modal(t('profile.import'), (box) => {
    const ok = h('button', { class: 'btn primary', text: t('import.choose') }) as HTMLButtonElement;
    const entry = phraseEntry((complete) => { ok.disabled = !complete; });
    ok.disabled = true;
    ok.onclick = async () => {
      const r = await run(api.invoke<Profile | null>('mgr:import', entry.value()));
      if (r) { toast(t('toast.imported', { name: r.name }), 'ok'); closeModal(); }
    };
    box.append(h('p', { class: 'hint', text: t('import.info') }), entry.el, h('div', { class: 'modal-actions' }, ok));
    entry.focus();
  });
}

function encryptionDialog(p: Profile): void {
  modal(t(p.encrypted ? 'profile.disableEncryption' : 'profile.enableEncryption'), (box) => {
    const err = h('div', { class: 'err' });
    const ok = h('button', { class: 'btn primary', text: t('common.save') }) as HTMLButtonElement;
    box.append(
      h('p', { class: 'info', text: t(p.encrypted ? 'enc.disableInfo' : 'enc.enableInfo') }),
      h('p', { class: 'note', text: t('security.malwareNotice') }),
    );

    if (p.encrypted) {
      // Turning encryption OFF: the existing 12 words are needed once.
      const entry = phraseEntry((complete) => { ok.disabled = !complete; });
      ok.disabled = true;
      box.append(entry.el);
      ok.onclick = async () => {
        ok.disabled = true;
        ok.textContent = t('enc.working');
        const r = await run(api.invoke('mgr:set-encryption', p.id, false, entry.value()), 'toast.saved');
        ok.textContent = t('common.save');
        if (r !== undefined) closeModal();
        else { ok.disabled = false; entry.setError(t('unlock.wrong')); }
      };
    } else {
      // Turning encryption ON: the phrase is generated by the main process and
      // shown here once, before the profile is sealed.
      box.append(h('p', { class: 'hint', text: t('enc.noRecovery') }));
      ok.onclick = async () => {
        ok.disabled = true;
        ok.textContent = t('enc.working');
        const r = await run(api.invoke<{ passphrase: string }>('mgr:set-encryption', p.id, true));
        ok.textContent = t('common.save');
        if (!r) { ok.disabled = false; return; }
        closeModal();
        showPassphrase(r.passphrase);
      };
    }
    box.append(err, h('div', { class: 'modal-actions' }, ok));
  });
}

/** The one and only time a profile passphrase is displayed. */
function showPassphrase(passphrase: string): void {
  modal(t('phrase.title'), (box) => {
    const done = h('button', { class: 'btn primary', text: t('common.close') }) as HTMLButtonElement;
    done.disabled = true;
    const shown = phraseDisplay(passphrase, (confirmed) => { done.disabled = !confirmed; });
    done.onclick = () => { closeModal(); toast(t('toast.saved'), 'ok'); };
    box.append(shown.el, h('div', { class: 'modal-actions' }, done));
  });
}

function resealDialog(p: Profile): void {
  modal(t('profile.reseal'), (box) => {
    const ok = h('button', { class: 'btn primary', text: t('profile.reseal') }) as HTMLButtonElement;
    const entry = phraseEntry((complete) => { ok.disabled = !complete; });
    ok.disabled = true;
    ok.onclick = async () => {
      const r = await run(api.invoke('mgr:reseal', p.id, entry.value()), 'toast.saved');
      if (r !== undefined) closeModal();
      else entry.setError(t('unlock.wrong'));
    };
    box.append(h('p', { class: 'hint', text: t('profile.needsResealing') }), entry.el, h('div', { class: 'modal-actions' }, ok));
    entry.focus();
  });
}

/** Pre-launch summary: what the profile can access (spec §6), then launch. */
async function preLaunch(p: Profile): Promise<void> {
  if (p.running) { await run(api.invoke('mgr:launch', p.id, {})); return; }
  const items = (await run(api.invoke<IsoItem[]>('mgr:isolation', p.id))) ?? [];
  modal(t('launch.title', { name: p.name }), (box) => {
    const list = h('div', { class: 'iso' });
    for (const it of items) {
      list.append(h('div', { class: `iso-row ${it.state}` }, h('span', { class: 'k', text: t(it.labelKey) }), h('span', { class: 'v', text: tv(it.value) })));
    }
    box.append(h('p', { class: 'hint', text: t('launch.summary') }), list);
    let entry: ReturnType<typeof phraseEntry> | null = null;
    if (p.encrypted && p.sealed) {
      entry = phraseEntry();
      box.append(h('p', { class: 'hint', text: t('launch.passphraseNeeded') }), entry.el);
    }
    const err = h('div', { class: 'err' });
    const ok = h('button', { class: 'btn primary' }, icon('play', 15), ` ${t('profile.launch')}`);
    const go = async (forceRestricted = false) => {
      ok.disabled = true;
      const r = await run(api.invoke<{ status: string }>('mgr:launch', p.id, { passphrase: entry?.value(), forceRestricted }));
      ok.disabled = false;
      if (!r) return;
      switch (r.status) {
        case 'started': case 'focused': case 'wsb-launched': case 'tor-launched': closeModal(); toast(t(`launch.status.${r.status}`), 'ok'); break;
        case 'need-passphrase': err.textContent = t('launch.passphraseNeeded'); entry?.focus(); break;
        case 'wrong-passphrase': err.textContent = t('unlock.wrong'); entry?.setError(t('unlock.wrong')); entry?.focus(); break;
        case 'tor-missing': torMissing(); break;
        case 'wsb-unavailable': wsbUnavailable(p); break;
        default: err.textContent = r.status;
      }
    };
    ok.onclick = () => void go();
    box.append(err, h('div', { class: 'modal-actions' }, ok));
  }, true);
}

function torMissing(): void {
  modal(t('tor.missingTitle'), (box) => {
    const dl = h('button', { class: 'btn primary', text: t('tor.download') });
    dl.onclick = () => void api.invoke('mgr:open-external', 'tor');
    const pick = h('button', { class: 'btn', text: t('tor.pick') });
    pick.onclick = async () => { const r = await run(api.invoke<string | null>('mgr:pick-tor')); if (r) { toast(t('toast.saved'), 'ok'); closeModal(); } };
    box.append(h('p', { text: t('tor.missing') }), h('p', { class: 'hint', text: t('tor.why') }), h('div', { class: 'modal-actions' }, pick, dl));
  });
}

function wsbUnavailable(p: Profile): void {
  modal(t('wsb.unavailableTitle'), (box) => {
    const docs = h('button', { class: 'btn', text: t('wsb.howToEnable') });
    docs.onclick = () => void api.invoke('mgr:open-external', 'wsb-docs');
    const fallback = h('button', { class: 'btn primary', text: t('wsb.useRestricted') });
    fallback.onclick = async () => {
      const r = await run(api.invoke<{ status: string }>('mgr:launch', p.id, { forceRestricted: true }));
      if (r?.status === 'need-passphrase') { closeModal(); void preLaunch({ ...p, sandbox: { ...p.sandbox, mode: 'restricted' } }); return; }
      if (r) closeModal();
    };
    box.append(h('p', { text: t('wsb.unavailable') }), h('p', { class: 'hint', text: t('wsb.fallbackInfo') }), h('div', { class: 'modal-actions' }, docs, fallback));
  });
}

// ------------------------------------------------------------------ profile editor

function editProfile(p: Profile): void {
  const draft: Profile = JSON.parse(JSON.stringify(p));
  const secrets = { proxyUsername: '', proxyPassword: '', clearProxyCredentials: false };
  let tab = 'general';
  modal(t('profile.editTitle', { name: p.name }), (box) => {
    const tabs = h('div', { class: 'tabs' });
    const body = h('div', { class: 'tab-body' });
    const TABS = ['general', 'privacy', 'network', 'sandbox', 'addons'];
    const draw = () => {
      clear(tabs);
      for (const k of TABS) {
        const b = h('button', { class: k === tab ? 'on' : '', text: t(`edit.tab.${k}`) });
        b.onclick = () => { tab = k; draw(); };
        tabs.append(b);
      }
      clear(body);
      if (tab === 'general') editGeneral(body, draft);
      if (tab === 'privacy') editPrivacy(body, draft);
      if (tab === 'network') editNetwork(body, draft, secrets);
      if (tab === 'sandbox') editSandbox(body, draft);
      if (tab === 'addons') editAddons(body, draft);
    };
    draw();
    const save = h('button', { class: 'btn primary', text: t('common.save') });
    save.onclick = async () => {
      const patch = {
        name: draft.name, color: draft.color, homePage: draft.homePage, keepHistory: draft.keepHistory, restoreSession: draft.restoreSession,
        deleteOnClose: draft.deleteOnClose, protection: draft.protection, network: draft.network, dns: draft.dns, sandbox: draft.sandbox,
        addons: draft.addons, ...secrets,
      };
      if ((await run(api.invoke('mgr:update', p.id, patch), 'toast.saved')) !== undefined) closeModal();
    };
    const note = p.running ? h('p', { class: 'hint', text: t('edit.runningNote') }) : null;
    box.append(tabs, body, note ?? '', h('div', { class: 'modal-actions' }, save));
  }, true);
}

function editGeneral(b: HTMLElement, d: Profile): void {
  const name = h('input', { type: 'text', value: d.name, maxlength: '64' });
  name.oninput = () => { d.name = name.value; };
  const color = h('input', { type: 'color', value: d.color });
  color.oninput = () => { d.color = color.value; };
  const home = h('input', { type: 'text', value: d.homePage, maxlength: '2048' });
  home.oninput = () => { d.homePage = home.value.trim() || 'octo://newtab'; };
  const theme = select<'dark' | 'light'>(d.theme === 'light' ? 'light' : 'dark', [['dark', t('profile.theme.dark')], ['light', t('profile.theme.light')]], (v) => { d.theme = v; });
  b.append(
    field('profile.name', name), field('profile.color', color), field('profile.homePage', home, 'profile.homePageHint'),
    field('profile.theme', theme, 'profile.themeHint'),
    toggle(d.keepHistory, 'profile.keepHistory', (v) => { d.keepHistory = v; }),
    toggle(d.restoreSession, 'profile.restoreSession', (v) => { d.restoreSession = v; }),
    toggle(d.deleteOnClose || d.kind === 'temporary', 'profile.deleteOnClose', (v) => { d.deleteOnClose = v; }, d.kind === 'temporary'),
    h('p', { class: 'hint', text: t('profile.historyNote') }),
  );
}

const OVERRIDES: Array<{ key: string; type: 'bool' | 'enum'; values?: string[] }> = [
  { key: 'blockAds', type: 'bool' }, { key: 'blockTrackers', type: 'bool' }, { key: 'httpsOnly', type: 'bool' },
  { key: 'blockThirdPartyCookies', type: 'bool' }, { key: 'stripTrackingParams', type: 'bool' }, { key: 'blockBounceTracking', type: 'bool' },
  { key: 'webrtc', type: 'enum', values: ['default', 'default_public_interface_only', 'disable_non_proxied_udp'] },
  { key: 'canvas', type: 'enum', values: ['allow', 'block-readback'] }, { key: 'webgl', type: 'enum', values: ['allow', 'disabled'] },
  { key: 'hardwareApis', type: 'enum', values: ['allow', 'normalize'] }, { key: 'blockAutoplay', type: 'bool' },
  { key: 'clearOnExit', type: 'bool' }, { key: 'warnDangerousDownloads', type: 'bool' }, { key: 'blockPopups', type: 'bool' },
  { key: 'trimReferrer', type: 'bool' }, { key: 'globalPrivacyControl', type: 'bool' },
  { key: 'geolocation', type: 'enum', values: ['ask', 'block'] }, { key: 'notifications', type: 'enum', values: ['ask', 'block'] },
  { key: 'confirmCrossSiteRedirects', type: 'bool' },
];

function editPrivacy(b: HTMLElement, d: Profile): void {
  if (d.kind === 'tor') {
    b.append(h('p', { class: 'info', text: t('edit.torFixed') }));
    return;
  }
  const lvl = select<'standard' | 'strict'>(d.protection.level === 'strict' ? 'strict' : 'standard', [['standard', t('level.standard')], ['strict', t('level.strict')]], (v) => {
    d.protection = { level: v, overrides: {} };
    clear(b);
    editPrivacy(b, d);
  });
  b.append(field('privacy.level', lvl), h('p', { class: 'hint', text: t(`level.${d.protection.level}.desc`) }), h('h3', { text: t('edit.overrides') }), h('p', { class: 'hint', text: t('edit.overridesHint') }));
  const grid = h('div', { class: 'ov-grid' });
  const ov = (d.protection.overrides ??= {});
  for (const o of OVERRIDES) {
    const cur = ov[o.key];
    const label = t(`ov.${o.key}`);
    let ctl: HTMLElement;
    if (o.type === 'bool') {
      ctl = select<string>(cur === undefined ? 'preset' : cur ? 'on' : 'off', [['preset', t('edit.preset')], ['on', t('state.on')], ['off', t('state.off')]], (v) => {
        if (v === 'preset') delete ov[o.key]; else ov[o.key] = v === 'on';
      });
    } else {
      ctl = select<string>(cur === undefined ? 'preset' : String(cur), [['preset', t('edit.preset')], ...o.values!.map((x) => [x, t(`${o.key === 'hardwareApis' ? 'hardware' : o.key}.${x}`)] as [string, string])], (v) => {
        if (v === 'preset') delete ov[o.key]; else ov[o.key] = v;
      });
    }
    grid.append(h('span', { text: label }), ctl);
  }
  b.append(grid, h('p', { class: 'hint', text: t('privacy.consistentNote') }));
}

function editNetwork(b: HTMLElement, d: Profile, secrets: { proxyUsername: string; proxyPassword: string; clearProxyCredentials: boolean }): void {
  const mode = select(d.network.mode, [['system', t('net.mode.system')], ['direct', t('net.mode.direct')], ['proxy', t('net.mode.proxy')]], (v) => { d.network.mode = v; clear(b); editNetwork(b, d, secrets); });
  b.append(field('net.modeLabel', mode));
  if (d.network.mode === 'proxy') {
    const rules = h('input', { type: 'text', value: d.network.proxyRules ?? '', placeholder: 'socks5://127.0.0.1:9050', maxlength: '512' });
    rules.oninput = () => { d.network.proxyRules = rules.value.trim(); };
    const bypass = h('input', { type: 'text', value: d.network.proxyBypass ?? '', placeholder: '<local>', maxlength: '512' });
    bypass.oninput = () => { d.network.proxyBypass = bypass.value.trim(); };
    const user = h('input', { type: 'text', placeholder: d.hasProxyCredentials ? t('net.credsStored') : '', maxlength: '256', autocomplete: 'off' });
    user.oninput = () => { secrets.proxyUsername = user.value; };
    const pass = h('input', { type: 'password', maxlength: '256', autocomplete: 'new-password' });
    pass.oninput = () => { secrets.proxyPassword = pass.value; };
    b.append(field('net.proxyRules', rules, 'net.proxyRulesHint'), field('net.proxyBypass', bypass), field('net.proxyUser', user), field('net.proxyPass', pass, 'net.credsHint'));
    if (d.hasProxyCredentials) b.append(toggle(false, 'net.clearCreds', (v) => { secrets.clearProxyCredentials = v; }));
  }
  const dns = select(d.dns.mode, [['inherit', t('dns.inherit')], ['system', t('dns.system')], ['doh', t('dns.doh')]], (v) => { d.dns.mode = v; clear(b); editNetwork(b, d, secrets); });
  b.append(field('dns.label', dns));
  if (d.dns.mode === 'doh') {
    const tpl = h('input', { type: 'text', value: d.dns.dohTemplate || 'https://dns.quad9.net/dns-query', maxlength: '512' });
    d.dns.dohTemplate = tpl.value;
    tpl.oninput = () => { d.dns.dohTemplate = tpl.value.trim(); };
    b.append(field('dns.template', tpl, 'dns.templateHint'));
  }
  b.append(h('p', { class: 'hint', text: t('net.vpnNote') }));
}

function editSandbox(b: HTMLElement, d: Profile): void {
  const mode = select(d.sandbox.mode, [['none', t('iso.mode.none')], ['restricted', t('iso.mode.restricted')], ['windows-sandbox', `${t('iso.mode.windows-sandbox')} (${t('sandbox.testVersion')})`]], (v) => { d.sandbox.mode = v; });
  const clip = select(d.sandbox.clipboard, [['allow', t('iso.clipboard.allow')], ['write-only', t('iso.clipboard.write-only')], ['block', t('iso.clipboard.block')]], (v) => { d.sandbox.clipboard = v; });
  b.append(
    field('iso.mode', mode, init.windowsSandbox ? 'sandbox.hint' : 'sandbox.hintNoWsb'),
    field('iso.clipboard', clip),
    toggle(d.sandbox.camera, 'sandbox.camera', (v) => { d.sandbox.camera = v; }),
    toggle(d.sandbox.microphone, 'sandbox.microphone', (v) => { d.sandbox.microphone = v; }),
    toggle(d.sandbox.externalDevices, 'sandbox.devices', (v) => { d.sandbox.externalDevices = v; }),
    toggle(d.sandbox.shareDownloads, 'sandbox.shareDownloads', (v) => { d.sandbox.shareDownloads = v; }),
    h('p', { class: 'hint', text: t('sandbox.appContainerNote') }),
  );
}

function editAddons(b: HTMLElement, d: Profile): void {
  if (d.kind === 'tor') { b.append(h('p', { class: 'info', text: t('addons.torNote') })); return; }
  b.append(h('p', { class: 'hint', text: t('addons.intro') }));
  const set = new Set(d.addons);
  for (const a of init.addons) {
    const perms = h('ul', { class: 'small' });
    for (const p of a.permissions) perms.append(h('li', { text: L(p) }));
    const tg = toggle(set.has(a.id), 'addons.enabled', (v) => { if (v) set.add(a.id); else set.delete(a.id); d.addons = [...set]; }, a.kind === 'external-app');
    b.append(h('div', { class: 'addon' },
      h('div', { class: 'row between' }, h('b', { text: a.name }), tg),
      h('div', { class: 'small', text: L(a.description) }),
      h('details', {}, h('summary', { text: t('addons.details') }),
        h('div', { class: 'small' }, `${t('addons.version')}: ${a.version} · ${t('addons.license')}: ${a.license} · ${t(`addons.status.${a.status}`)}`),
        h('div', { class: 'small muted' }, `${t('addons.source')}: ${a.source}`),
        h('div', { class: 'small' }, `${t('addons.permissions')}:`), perms,
        h('div', { class: 'small muted' }, `${t('addons.integrity')}: ${L(a.integrity)}`))));
  }
}

// ------------------------------------------------------------------ security

function renderSecurity(v: HTMLElement): void {
  v.append(h('div', { class: 'view-head' }, h('h1', { text: t('launcher.nav.security') })));
  const s = init.settings;
  const mins = select(String(s.security.autoLockMinutes), [['0', t('sec.never')], ['5', '5 min'], ['10', '10 min'], ['15', '15 min'], ['30', '30 min'], ['60', '60 min']], (val) => void saveSettings({ security: { autoLockMinutes: Number(val) } }));
  const lockNow = h('button', { class: 'btn', text: t('sec.lockNow') });
  lockNow.onclick = () => void run(api.invoke('mgr:lock-all')).then(() => render());
  v.append(
    keyProtectionPanel(
      {
        keyringMode: init.keyringMode,
        requiresPassword: init.keyringRequiresPassword,
        secretBackend: init.secretBackend,
        credmanAvailable: init.credmanAvailable,
      },
      {
        setMasterPassword: (current, next, repeat) => api.invoke('mgr:master-password', 'set', current, next, repeat),
        removeMasterPassword: (current) => api.invoke('mgr:master-password', 'remove', current),
        saveSettings: (patch) => saveSettings(patch),
        confirm: (text, fn) => confirmDialog(text, fn, 'toast.saved'),
      },
      () => { void refreshInit(); },
    ),
    h('div', { class: 'panel' }, h('h2', {}, icon('lock', 16), ` ${t('sec.autolock')}`), field('sec.autolockAfter', mins, 'sec.autolockHint'), lockNow),
    h('div', { class: 'panel' },
      h('h2', {}, icon('shield', 16), ` ${t('sec.encryption')}`),
      h('p', { text: t('sec.encryptionDesc') }),
      h('p', { class: 'hint', text: t('enc.noRecovery') })),
  );
}

/** Re-read mgr:init so the security panel shows the current key protection state. */
async function refreshInit(): Promise<void> {
  const next = await api.invoke<Init>('mgr:init');
  if (!next) return;
  init.keyringMode = next.keyringMode;
  init.keyringRequiresPassword = next.keyringRequiresPassword;
  init.secretBackend = next.secretBackend;
  init.credmanAvailable = next.credmanAvailable;
  init.settings = next.settings;
  render();
}

async function saveSettings(patch: Record<string, unknown>): Promise<void> {
  const r = await run(api.invoke<Settings>('mgr:settings', patch), 'toast.saved');
  if (r) init.settings = r;
}

// ------------------------------------------------------------------ updates

function renderUpdates(v: HTMLElement): void {
  const u = init.update;
  v.append(h('div', { class: 'view-head' }, h('h1', { text: t('launcher.nav.updates') })));
  const p = h('div', { class: 'panel' });
  if (!u.configured) p.append(h('p', { class: 'note', text: t('upd.notConfigured') }));
  p.append(
    h('div', { class: 'kv' }, h('span', { text: t('upd.current') }), h('b', { text: u.current })),
    h('div', { class: 'kv' }, h('span', { text: t('upd.latest') }), h('b', { text: u.latest ?? t('state.unknown') })),
    h('div', { class: 'kv' }, h('span', { text: t('upd.lastCheck') }), h('span', { text: u.lastCheckAt ? new Date(u.lastCheckAt).toLocaleString() : t('state.never') })),
  );
  if (u.error) p.append(h('p', { class: 'err', text: u.error }));
  const row = h('div', { class: 'row' });
  const check = h('button', { class: 'btn', text: t('upd.checkNow') });
  check.onclick = async () => { check.disabled = true; await run(api.invoke('mgr:update-check')); check.disabled = false; };
  row.append(check);
  if (u.available) {
    p.append(h('div', { class: 'kv' }, h('span', { text: t('upd.severity') }), h('span', { class: `pill ${u.severity === 'critical' || u.severity === 'security' ? 'bad' : 'warn'}`, text: t(`upd.sev.${u.severity ?? 'normal'}`) })));
    if (u.components?.length) p.append(h('div', { class: 'kv' }, h('span', { text: t('upd.components') }), h('span', { text: u.components.join(', ') })));
    if (u.changelog) p.append(h('h3', { text: t('upd.changelog') }), h('pre', { class: 'changelog', text: L(u.changelog) }));
    if (u.downloading) p.append(h('progress', { max: String(u.downloading.total || 1), value: String(u.downloading.done) }));
    if (u.readyToInstall) {
      const inst = h('button', { class: 'btn primary', text: t('upd.install') });
      inst.onclick = () => confirmDialog(t('upd.installConfirm'), () => api.invoke('mgr:update-install', u.readyToInstall), 'upd.installing');
      row.append(inst);
    } else if (!u.downloading) {
      const dl = h('button', { class: 'btn primary', text: t('upd.download') });
      dl.onclick = () => void run(api.invoke('mgr:update-download'));
      row.append(dl);
    }
    const later = h('button', { class: 'btn', text: t('upd.postpone') });
    later.onclick = () => void run(api.invoke('mgr:update-postpone'), 'toast.saved');
    const skip = h('button', { class: 'btn', text: t('upd.skip') });
    skip.onclick = () => void run(api.invoke('mgr:update-skip', u.latest), 'toast.saved');
    row.append(later, skip);
  }
  p.append(row);
  v.append(p);

  const s = init.settings;
  v.append(h('div', { class: 'panel' }, h('h2', { text: t('upd.settings') }),
    toggle(s.updates.autoCheck, 'upd.autoCheck', (val) => void saveSettings({ updates: { autoCheck: val } })),
    h('p', { class: 'hint', text: t('upd.policy') }),
    toggle(s.updates.backgroundCheck, 'upd.background', (val) => void saveSettings({ updates: { backgroundCheck: val } })),
    field('upd.channel', select(s.updates.channel, [['stable', t('upd.stable')], ['beta', t('upd.beta')]], (val) => void saveSettings({ updates: { channel: val } }))),
  ));

  if (u.rollbackAvailable.length) {
    const rb = h('div', { class: 'panel' }, h('h2', { text: t('upd.rollback') }), h('p', { class: 'hint', text: t('upd.rollbackHint') }));
    for (const ver of u.rollbackAvailable) {
      const b = h('button', { class: 'btn', text: `${t('upd.rollbackTo')} ${ver}` });
      b.onclick = () => confirmDialog(t('upd.rollbackConfirm', { v: ver }), () => api.invoke('mgr:update-rollback', ver), 'upd.installing');
      rb.append(b);
    }
    v.append(rb);
  }

  const f = h('div', { class: 'panel' }, h('h2', { text: t('filters.title') }),
    h('p', { text: `${t('net.filtersUpdated')}: ${init.filtersUpdatedAt ? new Date(init.filtersUpdatedAt).toLocaleString() : t('state.never')}` }),
    h('p', { class: 'hint', text: t('filters.hint') }));
  const fu = h('button', { class: 'btn', text: t('filters.updateNow') });
  fu.onclick = async () => {
    const r = await run(api.invoke<{ updated: string[]; failed: string[] } | null>('mgr:filters-update'));
    if (r) toast(t('filters.result', { ok: r.updated.length, failed: r.failed.length }), r.failed.length ? 'err' : 'ok');
  };
  f.append(fu);
  v.append(f);
}

// ------------------------------------------------------------------ settings

function renderSettings(v: HTMLElement): void {
  const s = init.settings;
  v.append(h('div', { class: 'view-head' }, h('h1', { text: t('launcher.nav.settings') })));
  const lang = select(init.lang, [['en', 'English'], ['pl', 'Polski']], async (val) => {
    if ((await run(api.invoke('mgr:set-language', val))) !== undefined) {
      confirmDialog(t('settings.langRestart'), () => api.invoke('mgr:relaunch'), 'toast.saved');
    }
  });
  const openData = h('button', { class: 'btn' }, icon('folder', 15), ` ${t('settings.openData')}`);
  openData.onclick = () => void api.invoke('mgr:open-folder', 'data');
  const moveData = h('button', { class: 'btn' }, icon('folder', 15), ` ${t('settings.dataDirChange')}`);
  moveData.onclick = async () => {
    const picked = await run(api.invoke<string | null>('mgr:pick-folder'));
    if (!picked) return;
    const r = await run(api.invoke<{ ok: true; dataDir: string } | { ok: false; errorKey: string }>('mgr:move-data', picked, true));
    if (!r) return;
    if (!r.ok) { toast(t(r.errorKey), 'err'); return; }
    confirmDialog(t('settings.dataDirMoved', { path: r.dataDir }), () => api.invoke('mgr:relaunch'), 'toast.saved');
  };
  v.append(h('div', { class: 'panel' }, h('h2', { text: t('settings.general') }),
    field('settings.language', lang),
    h('div', { class: 'field' }, h('span', { class: 'lbl', text: t('settings.dataDir') }), h('code', { text: init.dataDir }), openData, moveData,
      h('span', { class: 'hint', text: t('settings.dataDirHint') }),
      h('span', { class: 'hint', text: t('settings.dataDirHint2') })),
    toggle(s.ui.showStartupSplash, 'settings.splash', (val) => void saveSettings({ ui: { showStartupSplash: val } })),
  ));

  const dnsMode = select(s.network.dns.mode, [['system', t('dns.system')], ['doh', t('dns.doh')]], (val) => void saveSettings({ network: { dns: { mode: val } } }));
  const dnsProv = select(s.network.dns.provider, [['quad9', 'Quad9'], ['cloudflare', 'Cloudflare'], ['mullvad', 'Mullvad'], ['custom', t('dns.custom')]], (val) => void saveSettings({ network: { dns: { provider: val } } }));
  const custom = h('input', { type: 'text', value: s.network.dns.customTemplate, placeholder: 'https://.../dns-query', maxlength: '512' });
  custom.onchange = () => void saveSettings({ network: { dns: { customTemplate: custom.value.trim() } } });
  v.append(h('div', { class: 'panel' }, h('h2', { text: t('settings.network') }),
    field('dns.appWide', dnsMode), field('dns.provider', dnsProv), field('dns.template', custom),
    toggle(s.network.publicIpLookup, 'settings.ipLookup', (val) => void saveSettings({ network: { publicIpLookup: val } })),
    h('p', { class: 'hint', text: t('firstRun.ipLookupDesc') }),
    toggle(s.network.autoRefresh, 'net.autoRefresh', (val) => void saveSettings({ network: { autoRefresh: val } })),
    toggle(s.offline, 'settings.offline', (val) => void saveSettings({ offline: val })),
    field('search.engine', select(s.network.searchEngine, [['duckduckgo', 'DuckDuckGo'], ['startpage', 'Startpage'], ['brave', 'Brave Search'], ['mojeek', 'Mojeek']], (val) => void saveSettings({ network: { searchEngine: val } })), 'search.engineHint'),
  ));

  const sleep = select(String(s.ui.sleepTabsAfterMin), [['0', t('sec.never')], ['15', '15 min'], ['30', '30 min'], ['60', '60 min'], ['120', '120 min']], (val) => void saveSettings({ ui: { sleepTabsAfterMin: Number(val) } }));
  v.append(h('div', { class: 'panel' }, h('h2', { text: t('settings.tabs') }),
    toggle(s.ui.verticalTabs, 'menu.verticalTabs', (val) => void saveSettings({ ui: { verticalTabs: val } })),
    field('settings.sleepTabs', sleep, 'settings.sleepTabsHint'),
    toggle(s.ui.showBookmarksBar, 'menu.showBookmarksBar', (val) => void saveSettings({ ui: { showBookmarksBar: val } })),
    toggle(s.ui.confirmOnQuit, 'settings.confirmOnQuit', (val) => void saveSettings({ ui: { confirmOnQuit: val } }), false),
    toggle(s.ui.openLinksInBackground, 'settings.openLinksInBackground', (val) => void saveSettings({ ui: { openLinksInBackground: val } })),
  ));

  const torPick = h('button', { class: 'btn', text: t('tor.pick') });
  torPick.onclick = async () => { const r = await run(api.invoke<string | null>('mgr:pick-tor')); if (r) { init.settings.tor.torBrowserPath = r; render(); } };
  const torDl = h('button', { class: 'btn', text: t('tor.download') });
  torDl.onclick = () => void api.invoke('mgr:open-external', 'tor');
  v.append(h('div', { class: 'panel' }, h('h2', { text: 'Tor Browser' }),
    h('p', { text: s.tor.torBrowserPath || (init.torBrowser ? t('tor.autoDetected') : t('tor.notFound')) }),
    h('p', { class: 'hint', text: t('tor.why') }), h('div', { class: 'row' }, torPick, torDl)));
}

// ------------------------------------------------------------------ logs & backups

async function renderLogs(v: HTMLElement): Promise<void> {
  v.append(h('div', { class: 'view-head' }, h('h1', { text: t('launcher.nav.logs') })));
  const mode = select(init.logMode, [['standard', t('logs.standard')], ['diagnostic', t('logs.diagnostic')]], async (val) => {
    const r = await run(api.invoke<'standard' | 'diagnostic'>('mgr:log-mode', val), 'toast.saved');
    if (r) init.logMode = r;
  });
  const del = h('button', { class: 'btn danger' }, icon('trash', 15), ` ${t('logs.delete')}`);
  del.onclick = async () => { const n = await run(api.invoke<number>('mgr:logs-clear')); if (n !== undefined) toast(t('logs.deleted', { n }), 'ok'); };
  const open = h('button', { class: 'btn' }, icon('folder', 15), ` ${t('logs.open')}`);
  open.onclick = () => void api.invoke('mgr:open-folder', 'logs');
  v.append(h('div', { class: 'panel' }, h('h2', { text: t('logs.title') }), field('logs.mode', mode, 'logs.modeHint'), h('p', { class: 'hint', text: t('logs.noSecrets') }), h('div', { class: 'row' }, open, del)));

  const b = await run(api.invoke<{ settings: string[]; profiles: string[] }>('mgr:backups'));
  const panel = h('div', { class: 'panel' }, h('h2', { text: t('backups.title') }), h('p', { class: 'hint', text: t('backups.hint') }));
  for (const which of ['profiles', 'settings'] as const) {
    panel.append(h('h3', { text: t(`backups.${which}`) }));
    const list = b?.[which] ?? [];
    if (!list.length) panel.append(h('p', { class: 'muted', text: t('backups.none') }));
    for (const name of list.slice(0, 15)) {
      const r = h('button', { class: 'btn small', text: t('backups.restore') });
      r.onclick = () => confirmDialog(t('backups.restoreConfirm', { name }), () => api.invoke('mgr:backup-restore', which, name), 'toast.restored');
      panel.append(h('div', { class: 'kv' }, h('code', { text: name }), r));
    }
  }
  const openB = h('button', { class: 'btn' }, icon('folder', 15), ` ${t('backups.open')}`);
  openB.onclick = () => void api.invoke('mgr:open-folder', 'backups');
  panel.append(openB);
  v.append(panel);
}

// ------------------------------------------------------------------ about

function renderAbout(v: HTMLElement): void {
  v.append(h('div', { class: 'view-head' }, h('h1', { text: t('launcher.nav.about') })));
  const conns = h('ul', {});
  for (const k of ['conn.updates', 'conn.filters', 'conn.ip', 'conn.doh', 'conn.search', 'conn.pages']) conns.append(h('li', { text: t(k) }));
  v.append(
    h('div', { class: 'panel' }, h('h2', { text: `OctoBrowser.su ${init.version}` }), h('p', { text: t('about.desc') }), h('p', { class: 'hint', text: t('status.noGuarantee') })),
    h('div', { class: 'panel' }, h('h2', { text: t('about.connections') }), h('p', { class: 'hint', text: t('about.telemetryOff') }), conns),
    h('div', { class: 'panel' }, h('h2', { text: t('about.licenses') }), h('p', { text: t('about.licensesDesc') })),
  );
}

// ------------------------------------------------------------------ boot

async function boot(): Promise<void> {
  init = await api.invoke<Init>('mgr:init');
  setDicts(init.dicts);
  setLang(init.lang);
  applyI18n();
  profiles = await api.invoke<Profile[]>('mgr:profiles');
  const q = new URLSearchParams(location.search).get('tab');
  if (q && NAV.some(([x]) => x === q)) view = q as View;
  api.on<Profile[]>('mgr:profiles', (list) => { profiles = list; if (view === 'profiles') render(); else renderTop(); });
  api.on<UpdateStatus>('mgr:update-status', (u) => { init.update = u; if (view === 'updates') render(); else renderNav(); });
  api.on<{ key: string }>('mgr:toast', (m) => toast(t(m.key)));
  api.on<string>('mgr:show-tab', (tab) => { if (NAV.some(([x]) => x === tab)) { view = tab as View; render(); } });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
  $('modal').addEventListener('mousedown', (e) => { if (e.target === $('modal')) closeModal(); });
  render();
}

boot().catch((err) => {
  document.body.append(h('pre', { class: 'fatal', text: `Launcher error: ${String((err as Error)?.message ?? err)}` }));
});
