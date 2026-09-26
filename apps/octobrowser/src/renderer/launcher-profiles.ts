/**
 * apps/octobrowser/src/renderer/launcher-profiles.ts
 *
 * Profile list: folder column, toolbar (create / quick profile / search),
 * table with START / STOP per row, worktime, proxy + exit IP, row menu and
 * bulk actions for the selected profiles.
 */
import { api, clear } from '@octo/shell/renderer/bridge';
import { h, t } from '@octo/shell/renderer/i18n-client';
import { icon } from '@octo/shell/renderer/icons';
import {
  $, S, Profile, FpOs, Fingerprint, run, toast, errText, modal, closeModal, confirmDialog, popupMenu, MenuItem, osIcon, osLabel,
  fmtDuration, worktime, proxyText, checkLine, field, input, select,
} from './launcher-ui';
import { openEditor } from './launcher-editor';
import { preLaunch, duplicateDialog, exportDialog, importDialog, encryptionDialog, resealDialog, privateBrowsingDialog, torMissing, wsbUnavailable, isolationDialog } from './launcher-dialogs';

// ------------------------------------------------------------------ folders

const FOLDERS_KEY = 'octo.folders';

function storedFolders(): string[] {
  try { return (JSON.parse(localStorage.getItem(FOLDERS_KEY) ?? '[]') as unknown[]).map(String); } catch { return []; }
}

export function allFolders(): string[] {
  const set = new Set(storedFolders());
  for (const p of S.profiles) if (p.folder) set.add(p.folder);
  return [...set].sort((a, b) => a.localeCompare(b));
}

function saveFolders(list: string[]): void {
  localStorage.setItem(FOLDERS_KEY, JSON.stringify([...new Set(list)]));
}

function folderDialog(rename?: string): void {
  modal(t(rename ? 'ui.folderRename' : 'ui.folderNew'), (box) => {
    const name = input(rename ?? '', { maxlength: '48', placeholder: t('ui.folderNamePh') });
    const ok = h('button', { class: 'btn primary', text: t(rename ? 'common.save' : 'common.create') });
    const go = async () => {
      const v = name.value.trim();
      if (!v) { name.focus(); return; }
      const list = storedFolders().filter((f) => f !== rename);
      saveFolders([...list, v]);
      if (rename) {
        const ids = S.profiles.filter((p) => p.folder === rename).map((p) => p.id);
        if (ids.length) await run(api.invoke('mgr:profile-bulk', 'folder', ids, v));
        if (S.folder === rename) S.folder = v;
      }
      closeModal();
      S.render();
    };
    ok.onclick = () => void go();
    name.onkeydown = (e) => { if (e.key === 'Enter') void go(); };
    const cancel = h('button', { class: 'btn', text: t('common.cancel') });
    cancel.onclick = closeModal;
    box.append(field('ui.folderName', name), h('div', { class: 'modal-actions' }, cancel, ok));
  });
}

function folderMenu(anchor: HTMLElement, f: string): void {
  popupMenu(anchor, [
    { icon: 'edit', label: t('ui.folderRename'), fn: () => folderDialog(f) },
    {
      icon: 'trash', label: t('ui.folderDelete'), danger: true, fn: () => confirmDialog(t('ui.folderDeleteConfirm', { name: f }), async () => {
        const ids = S.profiles.filter((p) => p.folder === f).map((p) => p.id);
        if (ids.length) await api.invoke('mgr:profile-bulk', 'folder', ids, '');
        saveFolders(storedFolders().filter((x) => x !== f));
        if (S.folder === f) S.folder = '';
        S.render();
        return true;
      }, 'toast.saved'),
    },
  ]);
}

export function renderFolders(side: HTMLElement): void {
  clear(side);
  const search = input('', { placeholder: t('ui.searchFolder'), 'aria-label': t('ui.searchFolder') });
  const add = h('button', { class: 'icon-btn accent', title: t('ui.folderNew'), 'aria-label': t('ui.folderNew') }, icon('folderPlus', 20));
  add.onclick = () => folderDialog();
  const list = h('div', { class: 'folders', role: 'list' });
  const draw = () => {
    clear(list);
    const q = search.value.trim().toLowerCase();
    const item = (key: string, label: string, count: number, ic: string) => {
      const b = h('button', { class: `folder${S.folder === key ? ' on' : ''}`, role: 'listitem' }, icon(ic, 16), h('span', { class: 'grow ell', text: label }), h('span', { class: 'count', text: String(count) }));
      b.onclick = () => { S.folder = key; S.selected.clear(); S.render(); };
      if (key && key !== '__none') {
        const more = h('span', { class: 'folder-more', title: t('common.more'), role: 'button', tabindex: '0' }, icon('dots', 16));
        more.onclick = (e) => { e.stopPropagation(); folderMenu(more, key); };
        b.append(more);
      }
      list.append(b);
    };
    item('', t('ui.allProfiles'), S.profiles.length, 'users');
    for (const f of allFolders()) if (!q || f.toLowerCase().includes(q)) item(f, f, S.profiles.filter((p) => p.folder === f).length, 'folder');
    const none = S.profiles.filter((p) => !p.folder).length;
    if (allFolders().length && none) item('__none', t('ui.noFolder'), none, 'box');
  };
  search.oninput = draw;
  draw();
  side.append(h('div', { class: 'side2-head' }, search, add), list);
}

// ------------------------------------------------------------------ list

function visibleProfiles(): Profile[] {
  const q = S.search.trim().toLowerCase();
  return S.profiles.filter((p) =>
    (S.folder === '' || (S.folder === '__none' ? !p.folder : p.folder === S.folder)) &&
    (!S.tagFilter || p.tags?.includes(S.tagFilter)) &&
    (!q || p.name.toLowerCase().includes(q) || (p.notes ?? '').toLowerCase().includes(q) || (p.tags ?? []).some((x) => x.toLowerCase().includes(q)) ||
      (p.network.proxy?.host ?? '').includes(q) || (p.proxyCheck?.ip ?? '').includes(q)));
}

/** START: launch directly; dialogs only when something is needed (passphrase, Tor Browser...). */
export async function startProfile(p: Profile): Promise<void> {
  if (p.encrypted && p.sealed) { void preLaunch(p); return; }
  const r = await run(api.invoke<{ status: string }>('mgr:launch', p.id, {}));
  if (!r) return;
  switch (r.status) {
    case 'started': case 'focused': case 'wsb-launched': case 'tor-launched': break;
    case 'need-passphrase': case 'wrong-passphrase': void preLaunch(p); break;
    case 'tor-missing': torMissing(); break;
    case 'wsb-unavailable': wsbUnavailable(p); break;
    default: toast(r.status, 'err');
  }
}

export async function stopProfile(p: Profile, force = false): Promise<void> {
  await run(api.invoke('mgr:close-profile', p.id, force));
}

async function quickProfile(os: FpOs): Promise<void> {
  const fp = await run(api.invoke<Fingerprint>('mgr:fingerprint-new', os));
  if (!fp) return;
  const n = S.profiles.filter((p) => p.kind === 'antidetect').length + 1;
  const p = await run(api.invoke<Profile>('mgr:create', { name: `${t('ui.quickName')} ${n}`, kind: 'antidetect', patch: { fingerprint: fp, folder: S.folder && S.folder !== '__none' ? S.folder : '' } }));
  if (!p) return;
  toast(t('ui.quickCreated', { name: p.name, os: osLabel(os) }), 'ok');
  await startProfile({ ...p, running: false, sealed: false } as Profile);
}

function rowMenu(anchor: HTMLElement, p: Profile): void {
  const items: Array<MenuItem | 'sep'> = [
    p.running ? { icon: 'eye', label: t('profile.focus'), fn: () => void run(api.invoke('mgr:launch', p.id, {})) } : { icon: 'play', label: t('profile.launch'), fn: () => void startProfile(p) },
    { icon: 'edit', label: t('common.edit'), fn: () => openEditor(p) },
    { icon: 'swap', label: t('proxy.check'), disabled: p.network.mode !== 'proxy', fn: () => void checkRowProxy(p) },
    { icon: 'shuffle', label: t('fp.newFingerprint'), disabled: p.kind !== 'antidetect' && !p.fingerprint?.enabled, fn: () => void renewFingerprint(p) },
    { icon: 'shield', label: t('ui.whatCanAccess'), fn: () => void isolationDialog(p) },
    'sep',
    { icon: 'copy', label: t('profile.duplicate'), fn: () => duplicateDialog(p) },
    { icon: 'folder', label: t('ui.moveToFolder'), fn: () => moveDialog([p.id]) },
    { icon: 'export', label: t('profile.export'), fn: () => void exportDialog(p) },
    { icon: p.encrypted ? 'unlock' : 'lock', label: t(p.encrypted ? 'profile.disableEncryption' : 'profile.enableEncryption'), fn: () => encryptionDialog(p) },
  ];
  if (p.needsResealing) items.push({ icon: 'lock', label: t('profile.reseal'), fn: () => resealDialog(p) });
  if (p.running) items.push({ icon: 'stop', label: t('ui.forceStop'), danger: true, fn: () => void stopProfile(p, true) });
  items.push('sep',
    { icon: 'refreshCircle', label: t('profile.reset'), danger: true, fn: () => confirmDialog(t('profile.resetConfirm', { name: p.name }), () => api.invoke('mgr:reset', p.id), 'toast.profileReset') },
    { icon: 'trash', label: t('profile.delete'), danger: true, fn: () => confirmDialog(t('profile.deleteConfirm', { name: p.name }), () => api.invoke('mgr:remove', p.id), 'toast.profileDeleted') });
  popupMenu(anchor, items);
}

async function checkRowProxy(p: Profile): Promise<void> {
  toast(t('proxy.checking'), 'info');
  const r = await run(api.invoke<{ ok: boolean; ip?: string; error?: string }>('mgr:proxy-check-profile', p.id));
  if (r) toast(r.ok ? t('proxy.okIp', { ip: r.ip ?? '' }) : `${t('proxy.failed')}: ${errText(r.error ?? '')}`, r.ok ? 'ok' : 'err');
}

async function renewFingerprint(p: Profile): Promise<void> {
  const fp = await run(api.invoke<Fingerprint>('mgr:fingerprint-new', p.fingerprint?.os));
  if (!fp) return;
  const cur = p.fingerprint;
  // Keep what the user chose for the network side; renew the device.
  const next = cur ? { ...fp, timezone: cur.timezone, language: cur.language, geolocation: cur.geolocation, webrtc: cur.webrtc, ports: cur.ports, doNotTrack: cur.doNotTrack } : fp;
  if ((await run(api.invoke('mgr:update', p.id, { fingerprint: next }))) !== undefined) toast(t(p.running ? 'fp.renewedRestart' : 'fp.renewed'), 'ok');
}

function moveDialog(ids: string[]): void {
  modal(t('ui.moveToFolder'), (box) => {
    const folders = allFolders();
    const dl = h('datalist', { id: 'move-folders' });
    for (const f of folders) dl.append(h('option', { value: f }));
    const cur = ids.length === 1 ? S.profiles.find((p) => p.id === ids[0])?.folder ?? '' : '';
    const name = input(cur, { list: 'move-folders', maxlength: '48', placeholder: t('ui.noFolder') });
    const ok = h('button', { class: 'btn primary', text: t('common.save') });
    ok.onclick = async () => {
      const v = name.value.trim();
      if (v) saveFolders([...storedFolders(), v]);
      if ((await run(api.invoke('mgr:profile-bulk', 'folder', ids, v))) !== undefined) { closeModal(); toast(t('toast.saved'), 'ok'); }
    };
    const cancel = h('button', { class: 'btn', text: t('common.cancel') });
    cancel.onclick = closeModal;
    box.append(field('ui.folderName', name, 'ui.moveHint'), dl, h('div', { class: 'modal-actions' }, cancel, ok));
  });
}

function statusDialog(ids: string[]): void {
  modal(t('ui.setStatus'), (box) => {
    let v = '';
    const sel = select<string>('', STATUSES.map((s) => [s, s ? t(`status.p.${s}`) : t('ui.noStatus')] as [string, string]), (x) => { v = x; });
    const ok = h('button', { class: 'btn primary', text: t('common.save') });
    ok.onclick = async () => { if ((await run(api.invoke('mgr:profile-bulk', 'status', ids, v))) !== undefined) closeModal(); };
    box.append(field('ui.status', sel), h('div', { class: 'modal-actions' }, ok));
  });
}

export const STATUSES = ['', 'new', 'ready', 'inwork', 'paused', 'blocked', 'done'];

function statusChip(s: string): HTMLElement | null {
  if (!s) return null;
  return h('span', { class: `st st-${STATUSES.includes(s) ? s : 'custom'}`, text: STATUSES.includes(s) ? t(`status.p.${s}`) : s });
}

function startButton(p: Profile): HTMLElement {
  if (p.stopping) {
    const b = h('button', { class: 'run-btn busy', disabled: true }, h('span', { class: 'spin' }), h('span', { text: t('ui.stopping') }));
    return b;
  }
  if (p.running && !p.ready) {
    const b = h('button', { class: 'run-btn stop' }, h('span', { class: 'spin' }), h('span', { text: t('ui.starting') }));
    b.title = t('ui.clickToStop');
    b.onclick = () => void stopProfile(p, true);
    return b;
  }
  if (p.running) {
    const b = h('button', { class: 'run-btn stop' }, icon('stop', 13), h('span', { text: t('ui.stop') }));
    b.title = t('ui.stopHint');
    b.onclick = () => void stopProfile(p);
    return b;
  }
  const b = h('button', { class: 'run-btn start' }, icon('play', 13), h('span', { text: t('ui.start') }));
  b.onclick = async () => { (b as HTMLButtonElement).disabled = true; await startProfile(p); (b as HTMLButtonElement).disabled = false; };
  return b;
}

function proxyCell(p: Profile): HTMLElement {
  const cell = h('div', { class: 'proxy-cell' });
  if (p.kind === 'tor') { cell.append(h('span', { class: 'muted', text: 'Tor' })); return cell; }
  if (p.network.mode !== 'proxy') { cell.append(h('span', { class: 'muted', text: p.network.mode === 'direct' ? t('net.mode.direct') : '—' })); return cell; }
  const px = p.network.proxy;
  const c = p.proxyCheck;
  const state = !c ? 'none' : c.ok ? 'ok' : 'bad';
  const line = h('div', { class: 'proxy-line' }, h('span', { class: `swap ${state}` }, icon('swap', 14)),
    h('span', { class: 'ell', text: px ? (px.name ? `${px.name} · ${proxyText(px)}` : proxyText(px)) : (p.network.proxyRules ?? '') }));
  const chk = h('button', { class: 'icon-btn tiny', title: t('proxy.check'), 'aria-label': t('proxy.check') }, icon('refreshCircle', 14));
  chk.onclick = async () => { chk.classList.add('spinning'); await checkRowProxy(p); chk.classList.remove('spinning'); };
  line.append(chk);
  cell.append(line, h('div', { class: 'proxy-sub' }, checkLine(c)));
  return cell;
}

function row(p: Profile): HTMLElement {
  const tr = h('div', { class: `tr${p.running ? ' running' : ''}${S.selected.has(p.id) ? ' sel' : ''}`, role: 'row' });
  const cb = h('input', { type: 'checkbox', 'aria-label': t('ui.select'), checked: S.selected.has(p.id) });
  cb.onchange = () => { if (cb.checked) S.selected.add(p.id); else S.selected.delete(p.id); S.render(); };
  const more = h('button', { class: 'icon-btn', title: t('common.more'), 'aria-label': t('common.more') }, icon('dots', 18));
  more.onclick = (e) => { e.stopPropagation(); rowMenu(more, p); };
  const fp = p.fingerprint;
  const icons = h('div', { class: 'row-icons' },
    fp?.enabled ? osIcon(fp.os, 17) : h('span', { class: 'kind-ic', title: t(`profile.kind.${p.kind}`) }, icon(p.kind === 'tor' ? 'tor' : 'shield', 16)),
    p.encrypted ? h('span', { class: 'mini', title: t(p.sealed ? 'profile.sealed' : 'profile.unsealed') }, icon('lock', 14)) : null);
  if (fp?.enabled) icons.firstElementChild?.setAttribute('title', `${osLabel(fp.os)} · ${t('profile.kind.antidetect')}`);
  const name = h('button', { class: 'name-btn', title: t('common.edit') }, h('b', { class: 'ell', text: p.name }));
  name.onclick = () => openEditor(p);
  const warn = [...(p.fingerprintWarnings ?? []), ...p.issues.filter((i) => i.severity === 'warn').map((i) => i.key)];
  const meta = h('div', { class: 'name-meta' },
    p.kind !== 'antidetect' ? h('span', { class: 'kind', text: t(`profile.kind.${p.kind}`) }) : null,
    statusChip(p.status),
    ...(p.tags ?? []).slice(0, 4).map((x) => h('span', { class: 'tg', text: x })),
    p.needsResealing ? h('span', { class: 'warn-ic', title: t('profile.needsResealing') }, icon('alert', 13)) : null,
    warn.length ? h('span', { class: 'warn-ic', title: warn.map((k) => t(k)).join('\n') }, icon('alert', 13)) : null);
  tr.append(
    h('div', { class: 'td c-check' }, cb),
    h('div', { class: 'td c-icons' }, icons, more),
    h('div', { class: 'td c-name' }, name, meta),
    h('div', { class: 'td c-start' }, startButton(p)),
    h('div', { class: 'td c-time' }, h('span', { class: 'wt', 'data-id': p.id, text: p.stats?.worktimeSec || p.running ? fmtDuration(worktime(p)) : '—' })),
    h('div', { class: 'td c-proxy' }, proxyCell(p)),
  );
  return tr;
}

let ticker: number | undefined;

export function renderProfiles(v: HTMLElement): void {
  const list = visibleProfiles();
  // ---- toolbar
  const title = S.folder === '' ? t('ui.allProfiles') : S.folder === '__none' ? t('ui.noFolder') : S.folder;
  const create = h('button', { class: 'btn primary upper' }, icon('plus', 16), h('span', { text: t('ui.createProfile') }));
  create.onclick = () => openEditor(null);
  const quick = h('button', { class: 'btn outline upper' }, osIcon('windows11', 15), h('span', { text: t('ui.quickProfile') }));
  quick.title = t('ui.quickHint');
  quick.onclick = () => void quickProfile('windows11');
  const quickOs = h('button', { class: 'btn outline caret', title: t('fp.os'), 'aria-label': t('fp.os') }, icon('chevronDown', 16));
  quickOs.onclick = () => popupMenu(quickOs, (['windows11', 'windows10', 'macos', 'linux'] as FpOs[]).map((os) => ({ icon: os === 'macos' ? 'apple' : os === 'linux' ? 'linux' : 'windows', label: osLabel(os), fn: () => void quickProfile(os) })));
  const more = h('button', { class: 'icon-btn', title: t('common.more'), 'aria-label': t('common.more') }, icon('dots', 20));
  more.onclick = () => popupMenu(more, [
    { icon: 'eyeOff', label: t('profile.privateBrowsing'), fn: privateBrowsingDialog },
    { icon: 'import', label: t('profile.import'), fn: importDialog },
    { icon: 'fingerprint', label: t('privacy.runDetect'), fn: () => void run(api.invoke('mgr:launch-detect')) },
  ]);
  const search = input(S.search, { type: 'search', placeholder: t('ui.searchPh'), 'aria-label': t('ui.searchPh'), id: 'profileSearch' });
  search.oninput = () => { S.search = search.value; drawTable(); };
  const searchBox = h('div', { class: 'search' }, icon('search', 16), search);
  v.append(h('div', { class: 'toolbar' },
    h('h1', { class: 'ell', text: title }),
    h('div', { class: 'grow' }),
    create, h('div', { class: 'split' }, quick, quickOs), more, searchBox));

  // ---- bulk bar
  const sel = [...S.selected].filter((id) => S.profiles.some((p) => p.id === id));
  if (sel.length) {
    const bulk = (action: string, arg?: unknown) => run(api.invoke('mgr:profile-bulk', action, sel, arg));
    const b = (ic: string, key: string, fn: () => void, cls = '') => { const x = h('button', { class: `btn small ${cls}` }, icon(ic, 14), h('span', { text: t(key) })); x.onclick = fn; return x; };
    const clearSel = h('button', { class: 'icon-btn', title: t('ui.clearSelection') }, icon('close', 16));
    clearSel.onclick = () => { S.selected.clear(); S.render(); };
    v.append(h('div', { class: 'bulkbar' },
      h('b', { text: t('ui.selected', { n: sel.length }) }),
      b('play', 'ui.start', () => void bulk('start'), 'ok'),
      b('stop', 'ui.stop', () => void bulk('stop')),
      b('folder', 'ui.moveToFolder', () => moveDialog(sel)),
      b('tag', 'ui.setStatus', () => statusDialog(sel)),
      b('trash', 'profile.delete', () => confirmDialog(t('ui.deleteMany', { n: sel.length }), async () => { await bulk('remove'); S.selected.clear(); return true; }, 'toast.profileDeleted'), 'danger'),
      h('div', { class: 'grow' }), clearSel));
  }

  // ---- table
  const table = h('div', { class: 'table', role: 'table' });
  const allCb = h('input', { type: 'checkbox', 'aria-label': t('ui.selectAll') });
  allCb.checked = list.length > 0 && list.every((p) => S.selected.has(p.id));
  allCb.indeterminate = !allCb.checked && list.some((p) => S.selected.has(p.id));
  allCb.onchange = () => { for (const p of list) { if (allCb.checked) S.selected.add(p.id); else S.selected.delete(p.id); } S.render(); };
  const head = h('div', { class: 'tr th', role: 'row' },
    h('div', { class: 'td c-check' }, allCb), h('div', { class: 'td c-icons' }),
    h('div', { class: 'td c-name', text: t('ui.col.name') }), h('div', { class: 'td c-start' }),
    h('div', { class: 'td c-time', text: t('ui.col.worktime') }), h('div', { class: 'td c-proxy', text: t('ui.col.proxy') }));
  const body = h('div', { class: 'tbody' });
  const drawTable = () => {
    clear(body);
    const rows = visibleProfiles();
    if (!rows.length) {
      const c = h('button', { class: 'btn primary upper' }, icon('plus', 16), h('span', { text: t('ui.createProfile') }));
      c.onclick = () => openEditor(null);
      body.append(h('div', { class: 'empty' }, h('div', { class: 'empty-icon' }, icon('users', 44)),
        h('h2', { text: S.profiles.length ? t('ui.noMatch') : t('profiles.empty.title') }),
        h('p', { class: 'muted', text: S.profiles.length ? t('ui.noMatchHint') : t('profiles.empty.text') }), c));
    }
    for (const p of rows) body.append(row(p));
    footCount.textContent = t('ui.countOf', { n: rows.length, total: S.profiles.length, running: S.profiles.filter((p) => p.running).length });
  };
  table.append(head, body);
  v.append(table);

  // ---- footer: tag filter + counts
  const tags = [...new Set(S.profiles.flatMap((p) => p.tags ?? []))].sort();
  const tagBar = h('div', { class: 'tagbar' });
  if (!tags.length) tagBar.append(h('span', { class: 'tg muted', text: t('ui.noTags') }));
  for (const tg of tags) {
    const b = h('button', { class: `tg${S.tagFilter === tg ? ' on' : ''}`, text: tg });
    b.onclick = () => { S.tagFilter = S.tagFilter === tg ? '' : tg; S.render(); };
    tagBar.append(b);
  }
  const footCount = h('span', { class: 'muted' });
  v.append(h('div', { class: 'tfoot' }, tagBar, h('div', { class: 'grow' }), footCount));
  drawTable();

  // Live worktime of running profiles.
  if (ticker) clearInterval(ticker);
  ticker = window.setInterval(() => {
    if (S.view !== 'profiles') { clearInterval(ticker); ticker = undefined; return; }
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('.wt'))) {
      const p = S.profiles.find((x) => x.id === el.dataset.id);
      if (p?.running) el.textContent = fmtDuration(worktime(p));
    }
  }, 1000);
}

/** "/" focuses the search, like in the reference UI. */
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && S.view === 'profiles' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) && $('modal').classList.contains('hidden')) {
    e.preventDefault();
    $('profileSearch')?.focus();
  }
});

