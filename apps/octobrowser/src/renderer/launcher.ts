/**
 * apps/octobrowser/src/renderer/launcher.ts
 *
 * Launcher / profile manager UI. Layout (dark, like common antidetect
 * browsers): icon rail on the left, folder column (profiles view), toolbar +
 * table. Views: profiles, proxies, security, updates, settings, API, logs,
 * about. Profile list / editor / proxies / dialogs live in launcher-*.ts.
 */
import { api, clear } from '@octo/shell/renderer/bridge';
import { applyI18n, h, setDicts, setLang, t } from '@octo/shell/renderer/i18n-client';
import { icon } from '@octo/shell/renderer/icons';
import { keyProtectionPanel } from '@octo/shell/renderer/keypanel';
import { $, S, L, Init, Profile, SavedProxy, Settings, UpdateStatus, View, run, toast, closeModal, closePopup, confirmDialog, field, select, toggle, input, copyText } from './launcher-ui';
import { renderProfiles, renderFolders } from './launcher-profiles';
import { renderProxies } from './launcher-proxies';

// ------------------------------------------------------------------ layout

const NAV: Array<[View, string]> = [
  ['profiles', 'users'], ['proxies', 'proxy'], ['security', 'shield'], ['updates', 'refreshCircle'], ['api', 'api'], ['settings', 'settings'], ['logs', 'file'], ['about', 'info'],
];

let init: Init;

function renderNav(): void {
  const nav = $('nav');
  clear(nav);
  for (const [v, ic] of NAV) {
    const b = h('button', { class: `rail-item${v === S.view ? ' active' : ''}`, title: t(`launcher.nav.${v}`), 'aria-label': t(`launcher.nav.${v}`), 'aria-current': v === S.view ? 'page' : undefined }, icon(ic, 21), h('span', { class: 'rail-lbl', text: t(`launcher.nav.${v}`) }));
    if (v === 'updates' && init.update.available) b.append(h('span', { class: 'dot-badge' }));
    b.onclick = () => { S.view = v; render(); };
    nav.append(b);
  }
  const foot = $('sideFoot');
  clear(foot);
  const lock = h('button', { class: 'rail-item', title: t('launcher.lockNow'), 'aria-label': t('launcher.lockNow') }, icon('lock', 20), h('span', { class: 'rail-lbl', text: t('ui.lock') }));
  lock.onclick = () => void run(api.invoke('mgr:lock-all'), 'toast.saved');
  const lang = h('button', { class: 'rail-lang', title: t('settings.language'), text: init.lang.toUpperCase() });
  lang.onclick = () => { S.view = 'settings'; render(); };
  foot.append(lock, lang, h('span', { class: 'ver', text: `v${init.version}` }));
}

function renderStatus(): void {
  const s = $('statusbar');
  clear(s);
  const running = S.profiles.filter((p) => p.running).length;
  const attention = S.profiles.some((p) => p.needsResealing) || !init.update.configured;
  const apiCfg = init.settings.api;
  s.append(
    h('span', { class: `sb-item ${attention ? 'warn' : ''}` }, icon(attention ? 'shieldAlert' : 'shieldCheck', 13), h('span', { text: t(attention ? 'status.attention' : 'status.protectionActive') })),
    h('span', { class: 'sb-item' }, icon('users', 13), h('span', { text: t('ui.sb.profiles', { n: S.profiles.length, running }) })),
    h('span', { class: 'sb-item' }, icon('proxy', 13), h('span', { text: t('ui.sb.proxies', { n: S.proxies.length }) })),
    h('span', { class: `sb-item ${apiCfg.enabled ? 'on' : ''}` }, icon('api', 13), h('span', { text: apiCfg.enabled ? `API 127.0.0.1:${apiCfg.port}` : t('ui.sb.apiOff') })),
    h('span', { class: 'grow' }),
    h('span', { class: 'sb-item ell', title: init.dataDir }, icon('folder', 13), h('span', { class: 'ell', text: init.dataDir })),
    h('span', { class: 'sb-item', text: `OctoBrowser ${init.version}` }),
  );
}

function render(): void {
  closePopup();
  renderNav();
  renderStatus();
  const side2 = $('side2');
  side2.classList.toggle('hidden', S.view !== 'profiles');
  if (S.view === 'profiles') renderFolders(side2);
  const v = $('view');
  const scroll = v.scrollTop;
  clear(v);
  v.className = `view-${S.view}`;
  switch (S.view) {
    case 'profiles': renderProfiles(v); break;
    case 'proxies': renderProxies(v); break;
    case 'security': renderSecurity(v); break;
    case 'updates': renderUpdates(v); break;
    case 'settings': renderSettings(v); break;
    case 'api': void renderApi(v); break;
    case 'logs': void renderLogs(v); break;
    case 'about': renderAbout(v); break;
  }
  if (S.view === 'profiles' || S.view === 'proxies') v.scrollTop = scroll;
}
S.render = render;

function pageHead(key: string): HTMLElement {
  return h('div', { class: 'toolbar' }, h('h1', { text: t(key) }));
}

// ------------------------------------------------------------------ API

interface ApiStatus { enabled: boolean; port: number; listening: boolean; token: string; error: string; baseUrl: string }

async function renderApi(v: HTMLElement): Promise<void> {
  v.append(pageHead('launcher.nav.api'));
  const st = await run(api.invoke<ApiStatus>('mgr:api-status'));
  if (!st || S.view !== 'api') return;
  const draw = (s: ApiStatus) => {
    init.settings.api = { enabled: s.enabled, port: s.port };
    clear(panel);
    const port = input(String(s.port), { inputmode: 'numeric', maxlength: '5' });
    const savePort = h('button', { class: 'btn', text: t('common.save') });
    savePort.onclick = async () => { const r = await run(api.invoke<ApiStatus>('mgr:api-set', { port: Number(port.value) }), 'toast.saved'); if (r) draw(r); };
    let shown = false;
    const tok = h('code', { class: 'token', text: '•'.repeat(32) });
    const show = h('button', { class: 'btn small' }, icon('eye', 14), h('span', { text: t('api.show') }));
    show.onclick = () => { shown = !shown; tok.textContent = shown ? s.token : '•'.repeat(32); };
    const copy = h('button', { class: 'btn small' }, icon('copy', 14), h('span', { text: t('api.copy') }));
    copy.onclick = () => void copyText(s.token);
    const regen = h('button', { class: 'btn small danger' }, icon('refreshCircle', 14), h('span', { text: t('api.regenerate') }));
    regen.onclick = () => confirmDialog(t('api.regenerateConfirm'), async () => { const r = await api.invoke<ApiStatus>('mgr:api-token'); draw(r); return r; }, 'toast.saved');
    const state = s.enabled ? (s.listening ? h('span', { class: 'pill ok' }, icon('check', 13), ` ${t('api.listening', { url: s.baseUrl })}`) : h('span', { class: 'pill warn' }, icon('alert', 13), ` ${s.error || t('api.notListening')}`)) : h('span', { class: 'pill', text: t('state.off') });
    panel.append(
      h('h2', {}, icon('api', 17), ` ${t('api.title')}`),
      h('p', { class: 'muted', text: t('api.desc') }),
      toggle(s.enabled, 'api.enable', async (on) => { const r = await run(api.invoke<ApiStatus>('mgr:api-set', { enabled: on })); if (r) draw(r); }),
      h('div', { class: 'row' }, state),
      h('div', { class: 'grid2' },
        h('div', { class: 'field' }, h('span', { class: 'lbl', text: t('api.port') }), h('div', { class: 'row nowrap' }, port, savePort), h('span', { class: 'hint', text: t('api.portHint') })),
        h('div', { class: 'field' }, h('span', { class: 'lbl', text: t('api.baseUrl') }), h('code', { text: s.baseUrl }))),
      h('div', { class: 'field' }, h('span', { class: 'lbl', text: t('api.token') }), h('div', { class: 'row' }, tok, show, copy, regen), h('span', { class: 'hint', text: t('api.tokenHint') })),
      h('p', { class: 'note', text: t('api.securityNote') }),
    );
    const ex = (title: string, code: string) => h('div', { class: 'api-ex' }, h('div', { class: 'row between' }, h('b', { text: title }), (() => { const c = h('button', { class: 'btn small' }, icon('copy', 13), h('span', { text: t('api.copy') })); c.onclick = () => void copyText(code); return c; })()), h('pre', { text: code }));
    const B = s.baseUrl;
    const H = `-H "Authorization: Bearer ${shown ? s.token : '<TOKEN>'}"`;
    clear(examples);
    examples.append(h('h2', {}, icon('file', 17), ` ${t('api.examples')}`),
      ex(t('api.ex.list'), `curl ${H} ${B}/profiles`),
      ex(t('api.ex.create'), `curl -X POST ${H} -H "Content-Type: application/json" \\\n  -d '{"name":"Shop 1","os":"windows11","proxy":{"mode":"new","text":"socks5://user:pass@1.2.3.4:1080"}}' \\\n  ${B}/profiles`),
      ex(t('api.ex.start'), `curl -X POST ${H} -H "Content-Type: application/json" -d '{"debug":true}' ${B}/profiles/<ID>/start\n# -> {"status":"started","debugPort":51234,"wsEndpoint":"ws://127.0.0.1:51234/devtools/browser/..."}`),
      ex(t('api.ex.puppeteer'), `const { wsEndpoint } = await (await fetch('${B}/profiles/<ID>/start', {\n  method: 'POST', headers: { Authorization: 'Bearer <TOKEN>', 'Content-Type': 'application/json' },\n  body: JSON.stringify({ debug: true }) })).json();\nconst browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint });`),
      ex(t('api.ex.stop'), `curl -X POST ${H} ${B}/profiles/<ID>/stop`),
      ex(t('api.ex.proxy'), `curl -X POST ${H} -H "Content-Type: application/json" -d '{"text":"1.2.3.4:8080:user:pass"}' ${B}/proxies/check`));
    const eps = h('div', { class: 'endpoints' });
    for (const [m, path, key] of API_ENDPOINTS) eps.append(h('div', { class: 'ep' }, h('span', { class: `m m-${m.toLowerCase()}`, text: m }), h('code', { text: path }), h('span', { class: 'muted', text: t(key) })));
    clear(ref);
    ref.append(h('h2', {}, icon('menu', 17), ` ${t('api.reference')}`), eps);
  };
  const panel = h('div', { class: 'panel' });
  const examples = h('div', { class: 'panel' });
  const ref = h('div', { class: 'panel' });
  v.append(panel, examples, ref);
  draw(st);
}

const API_ENDPOINTS: Array<[string, string, string]> = [
  ['GET', '/v1/health', 'api.ep.health'],
  ['GET', '/v1/profiles', 'api.ep.list'],
  ['POST', '/v1/profiles', 'api.ep.create'],
  ['GET', '/v1/profiles/:id', 'api.ep.get'],
  ['PATCH', '/v1/profiles/:id', 'api.ep.update'],
  ['DELETE', '/v1/profiles/:id', 'api.ep.delete'],
  ['POST', '/v1/profiles/:id/start', 'api.ep.start'],
  ['POST', '/v1/profiles/:id/stop', 'api.ep.stop'],
  ['POST', '/v1/profiles/:id/fingerprint', 'api.ep.fingerprint'],
  ['PUT', '/v1/profiles/:id/proxy', 'api.ep.setProxy'],
  ['POST', '/v1/profiles/:id/proxy/check', 'api.ep.checkProfileProxy'],
  ['POST', '/v1/profiles/bulk', 'api.ep.bulk'],
  ['GET', '/v1/proxies', 'api.ep.proxies'],
  ['POST', '/v1/proxies', 'api.ep.addProxies'],
  ['PATCH', '/v1/proxies/:id', 'api.ep.updateProxy'],
  ['DELETE', '/v1/proxies/:id', 'api.ep.deleteProxy'],
  ['POST', '/v1/proxies/:id/check', 'api.ep.checkProxy'],
  ['POST', '/v1/proxies/parse', 'api.ep.parse'],
  ['POST', '/v1/proxies/check', 'api.ep.checkRaw'],
  ['POST', '/v1/fingerprints', 'api.ep.newFp'],
  ['GET', '/v1/fingerprints/meta', 'api.ep.fpMeta'],
];

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
        confirm: (text, fn) => confirmDialog(text, fn, 'toast.saved', false),
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
  S.init = init;
  init.settings.api ??= { enabled: false, port: 35555 };
  setDicts(init.dicts);
  setLang(init.lang);
  document.documentElement.lang = init.lang;
  applyI18n();
  S.profiles = await api.invoke<Profile[]>('mgr:profiles');
  S.proxies = (await api.invoke<SavedProxy[]>('mgr:proxies').catch(() => [])) ?? [];
  const q = new URLSearchParams(location.search).get('tab');
  if (q && NAV.some(([x]) => x === q)) S.view = q as View;
  // Re-render lists only when no text field has focus, so typing is never interrupted.
  const soft = () => {
    const a = document.activeElement;
    if ((S.view === 'profiles' || S.view === 'proxies') && !(a instanceof HTMLInputElement && a.type !== 'checkbox' && $('view').contains(a))) render();
    else { renderStatus(); if (S.view === 'profiles') renderFolders($('side2')); }
  };
  api.on<Profile[]>('mgr:profiles', (list) => { S.profiles = list; soft(); });
  api.on<SavedProxy[]>('mgr:proxies', (list) => { S.proxies = list; soft(); });
  api.on<UpdateStatus>('mgr:update-status', (u) => { init.update = u; if (S.view === 'updates') render(); else renderNav(); });
  api.on<{ key: string }>('mgr:toast', (m) => toast(t(m.key)));
  api.on<string>('mgr:show-tab', (tab) => { if (NAV.some(([x]) => x === tab)) { S.view = tab as View; render(); } });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closePopup(); if (!$('modal').classList.contains('hidden')) closeModal(); } });
  $('modal').addEventListener('mousedown', (e) => { if (e.target === $('modal')) closeModal(); });
  render();
}

boot().catch((err) => {
  document.body.append(h('pre', { class: 'fatal', text: `Launcher error: ${String((err as Error)?.message ?? err)}` }));
});
