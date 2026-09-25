/**
 * apps/octobrowser/src/renderer/launcher-proxies.ts
 *
 * Proxies page: saved proxies (credentials stay in the secret store), mass
 * add with per-line format detection, check (exit IP / country / latency),
 * rename / change-IP URL, delete, "used by N profiles".
 */
import { api, clear } from '@octo/shell/renderer/bridge';
import { h, t } from '@octo/shell/renderer/i18n-client';
import { icon } from '@octo/shell/renderer/icons';
import { parseProxyList } from '@octo/core/proxy';
import { S, SavedProxy, ProxyType, ProxyCheck, run, toast, modal, closeModal, confirmDialog, field, input, seg, checkLine, proxyText, popupMenu, copyText } from './launcher-ui';

function usedBy(id: string): number {
  return S.profiles.filter((p) => p.network.proxy?.savedId === id).length;
}

async function checkMany(ids: string[]): Promise<void> {
  let ok = 0;
  let bad = 0;
  // A few at a time: fast, without opening dozens of connections at once.
  const queue = [...ids];
  const worker = async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      document.querySelector(`[data-pid="${id}"]`)?.classList.add('checking');
      const r = await api.invoke<ProxyCheck>('mgr:proxies-check', id).catch(() => undefined);
      if (r?.ok) ok++; else bad++;
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  toast(t('proxy.checkedMany', { ok, bad }), bad ? 'err' : 'ok');
}

function addDialog(): void {
  let type: ProxyType = 'http';
  modal(t('proxy.addTitle'), (box) => {
    const ta = h('textarea', { class: 'mass', rows: '9', spellcheck: 'false', placeholder: t('proxy.massPh') });
    const name = input('', { maxlength: '48', placeholder: t('proxy.namePrefix') });
    const preview = h('div', { class: 'mass-preview' });
    const ok = h('button', { class: 'btn primary upper' }, icon('plus', 15), h('span', { text: t('proxy.addN', { n: 0 }) })) as HTMLButtonElement;
    const refresh = () => {
      clear(preview);
      const list = parseProxyList(ta.value, type);
      const good = list.filter((r) => r.ok).length;
      for (const r of list.slice(0, 200)) {
        preview.append(h('div', { class: `mp ${r.ok ? 'ok' : 'bad'}` },
          icon(r.ok ? 'check' : 'alert', 13),
          h('span', { class: 'ln', text: String(r.line) }),
          h('span', { class: 'ell grow', text: r.ok && r.proxy ? `${r.proxy.type}://${r.proxy.host}:${r.proxy.port}${r.proxy.username ? ` · ${t('proxy.withLogin')}` : ''}` : r.raw }),
          h('span', { class: 'muted small', text: r.ok ? r.format ?? '' : t(r.error ?? 'proxy.err.format') })));
      }
      if (!list.length) preview.append(h('p', { class: 'hint', text: t('proxy.massHint') }));
      (ok.lastChild as HTMLElement).textContent = t('proxy.addN', { n: good });
      ok.disabled = good === 0;
    };
    ta.oninput = refresh;
    ok.onclick = async () => {
      ok.disabled = true;
      const r = await run(api.invoke<{ added: number; errors: Array<{ line: number; error: string }> }>('mgr:proxies-add', ta.value, type, name.value.trim()));
      ok.disabled = false;
      if (!r) return;
      closeModal();
      toast(t('proxy.added', { n: r.added }) + (r.errors.length ? ` · ${t('proxy.skipped', { n: r.errors.length })}` : ''), r.errors.length ? 'info' : 'ok');
    };
    const cancel = h('button', { class: 'btn', text: t('common.cancel') });
    cancel.onclick = closeModal;
    box.append(
      h('div', { class: 'field' }, h('span', { class: 'lbl', text: t('proxy.defaultType') }),
        seg<ProxyType>(type, [['http', 'HTTP'], ['https', 'HTTPS'], ['socks4', 'SOCKS4'], ['socks5', 'SOCKS5']], (v) => { type = v; refresh(); }),
        h('span', { class: 'hint', text: t('proxy.defaultTypeHint') })),
      field('proxy.list', ta),
      preview,
      field('proxy.name', name, 'proxy.namePrefixHint'),
      h('div', { class: 'modal-actions' }, cancel, ok));
    refresh();
  }, 'wide');
}

function editDialog(sp: SavedProxy): void {
  modal(t('proxy.editTitle'), (box) => {
    const name = input(sp.name, { maxlength: '64' });
    const cip = input(sp.changeIpUrl, { maxlength: '2000', placeholder: 'https://...' });
    const ok = h('button', { class: 'btn primary', text: t('common.save') });
    ok.onclick = async () => {
      if ((await run(api.invoke('mgr:proxies-update', sp.id, { name: name.value.trim(), changeIpUrl: cip.value.trim() }), 'toast.saved')) !== undefined) closeModal();
    };
    box.append(h('p', { class: 'muted', text: `${proxyText(sp)}${sp.hasCredentials ? ` · ${t('proxy.withLogin')}` : ''}` }),
      field('proxy.name', name), field('proxy.changeIpUrl', cip, 'ui.optional'), h('div', { class: 'modal-actions' }, ok));
  });
}

export function renderProxies(v: HTMLElement): void {
  const add = h('button', { class: 'btn primary upper' }, icon('plus', 16), h('span', { text: t('proxy.addProxies') }));
  add.onclick = addDialog;
  const sel = [...S.proxySelected].filter((id) => S.proxies.some((p) => p.id === id));
  const checkSel = h('button', { class: 'btn outline upper', disabled: !S.proxies.length }, icon('swap', 15), h('span', { text: sel.length ? t('proxy.checkSelected', { n: sel.length }) : t('proxy.checkAll') }));
  checkSel.onclick = async () => { (checkSel as HTMLButtonElement).disabled = true; await checkMany(sel.length ? sel : S.proxies.map((p) => p.id)); };
  const del = h('button', { class: 'btn danger', disabled: !sel.length }, icon('trash', 15), h('span', { text: t('profile.delete') }));
  del.onclick = () => confirmDialog(t('proxy.deleteMany', { n: sel.length }), async () => { await api.invoke('mgr:proxies-remove', sel); S.proxySelected.clear(); return true; }, 'toast.saved');
  v.append(h('div', { class: 'toolbar' }, h('h1', { text: t('launcher.nav.proxies') }), h('div', { class: 'grow' }), del, checkSel, add));

  if (!S.proxies.length) {
    const c = h('button', { class: 'btn primary upper' }, icon('plus', 16), h('span', { text: t('proxy.addProxies') }));
    c.onclick = addDialog;
    v.append(h('div', { class: 'empty' }, h('div', { class: 'empty-icon' }, icon('proxy', 44)), h('h2', { text: t('proxy.emptyTitle') }), h('p', { class: 'muted', text: t('proxy.emptyText') }), c));
    return;
  }
  const table = h('div', { class: 'table ptable', role: 'table' });
  const allCb = h('input', { type: 'checkbox', 'aria-label': t('ui.selectAll') });
  allCb.checked = S.proxies.every((p) => S.proxySelected.has(p.id));
  allCb.onchange = () => { for (const p of S.proxies) { if (allCb.checked) S.proxySelected.add(p.id); else S.proxySelected.delete(p.id); } S.render(); };
  table.append(h('div', { class: 'tr th', role: 'row' },
    h('div', { class: 'td c-check' }, allCb), h('div', { class: 'td c-pname', text: t('proxy.name') }), h('div', { class: 'td c-ptype', text: t('proxy.type') }),
    h('div', { class: 'td c-paddr', text: t('proxy.address') }), h('div', { class: 'td c-pchk', text: t('proxy.status') }), h('div', { class: 'td c-pused', text: t('proxy.usedBy') }), h('div', { class: 'td c-pact' })));
  const body = h('div', { class: 'tbody' });
  for (const sp of S.proxies) {
    const cb = h('input', { type: 'checkbox', 'aria-label': t('ui.select'), checked: S.proxySelected.has(sp.id) });
    cb.onchange = () => { if (cb.checked) S.proxySelected.add(sp.id); else S.proxySelected.delete(sp.id); S.render(); };
    const chk = h('button', { class: 'icon-btn', title: t('proxy.check'), 'aria-label': t('proxy.check') }, icon('swap', 17));
    chk.onclick = async () => { chk.classList.add('spinning'); await run(api.invoke('mgr:proxies-check', sp.id)); chk.classList.remove('spinning'); };
    const more = h('button', { class: 'icon-btn', title: t('common.more'), 'aria-label': t('common.more') }, icon('dots', 17));
    more.onclick = () => popupMenu(more, [
      { icon: 'edit', label: t('common.edit'), fn: () => editDialog(sp) },
      { icon: 'copy', label: t('proxy.copy'), fn: () => void copyText(proxyText(sp)) },
      ...(sp.changeIpUrl ? [{ icon: 'refreshCircle', label: t('proxy.changeIpNow'), fn: async () => { const r = await run(api.invoke<{ ok: boolean; status: number }>('mgr:proxy-change-ip', sp.changeIpUrl)); if (r) toast(r.ok ? t('proxy.ipChanged') : `${t('proxy.ipChangeFailed')} (HTTP ${r.status})`, r.ok ? 'ok' : 'err'); } }] : []),
      'sep',
      { icon: 'trash', label: t('profile.delete'), danger: true, fn: () => confirmDialog(t('proxy.deleteOne', { name: sp.name || proxyText(sp) }), () => api.invoke('mgr:proxies-remove', [sp.id]), 'toast.saved') },
    ]);
    const n = usedBy(sp.id);
    body.append(h('div', { class: `tr${S.proxySelected.has(sp.id) ? ' sel' : ''}`, role: 'row', 'data-pid': sp.id },
      h('div', { class: 'td c-check' }, cb),
      h('div', { class: 'td c-pname' }, h('b', { class: 'ell', text: sp.name || '—' })),
      h('div', { class: 'td c-ptype' }, h('span', { class: 'ptype', text: sp.type.toUpperCase() })),
      h('div', { class: 'td c-paddr' }, h('span', { class: 'ell mono', text: `${sp.host}:${sp.port}` }), sp.hasCredentials ? h('span', { class: 'mini', title: t('proxy.withLogin') }, icon('key', 13)) : null),
      h('div', { class: 'td c-pchk' }, checkLine(sp.lastCheck)),
      h('div', { class: 'td c-pused' }, h('span', { class: n ? '' : 'muted', text: String(n) })),
      h('div', { class: 'td c-pact' }, chk, more)));
  }
  table.append(body);
  v.append(table, h('div', { class: 'tfoot' }, h('span', { class: 'muted', text: t('proxy.count', { n: S.proxies.length }) }), h('div', { class: 'grow' }), h('span', { class: 'hint', text: t('proxy.secretsNote') })));
}
