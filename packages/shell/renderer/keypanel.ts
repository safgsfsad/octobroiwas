/**
 * packages/shell/renderer/keypanel.ts
 *
 * Shared "Key protection" panel used by OctoBrowser.su (launcher) and
 * OctoDetect.su (settings). It shows
 *   - how the local key is protected right now (Windows DPAPI or master password),
 *   - the form to set / change / remove the master password,
 *   - where small secrets are stored (encrypted file vs Windows Credential Manager),
 *   - the honest limitation notice.
 *
 * The panel never shows, logs or returns any key material: it only sends the
 * typed passwords to the main process, which drops them after wrapping the key.
 */
import { h, t } from './i18n-client';
import { icon } from './icons';

export interface KeyPanelState {
  /** Current keyring mode ('os' = DPAPI, 'password' = master password). */
  keyringMode: 'os' | 'password' | null;
  /** true when the app asks for the master password on start. */
  requiresPassword: boolean;
  /** Backend actually used for secrets right now. */
  secretBackend: 'local' | 'credman';
  /** false on systems without Credential Manager (or non-Windows). */
  credmanAvailable: boolean;
}

export interface KeyPanelActions {
  /** Set (or replace) the master password. */
  setMasterPassword(current: string, next: string, repeat: string): Promise<unknown>;
  /** Remove the master password (key goes back to DPAPI). */
  removeMasterPassword(current: string): Promise<unknown>;
  /** Persist a settings patch, e.g. { security: { secretStore: 'credman' } }. */
  saveSettings(patch: Record<string, unknown>): Promise<unknown>;
  /** Ask for confirmation before a destructive action (optional). */
  confirm?(text: string, fn: () => Promise<unknown>): void;
}

/** Human-readable name of the current key protection. */
export function keyProtectionLabel(state: KeyPanelState): string {
  if (state.requiresPassword) return t('keyring.mode.password');
  return t('keyring.mode.os');
}

/**
 * The panel. `notify` is called after every successful action so the caller can
 * refresh its own copy of the state (the main process is the source of truth).
 */
export function keyProtectionPanel(state: KeyPanelState, actions: KeyPanelActions, notify: () => void): HTMLElement {
  const panel = h('section', { class: 'panel' },
    h('h2', {}, icon('key', 16), ` ${t('sec.keyring')}`),
    h('div', { class: 'kv' },
      h('span', { text: t('keyring.current') }),
      h('b', { text: keyProtectionLabel(state) })),
    h('p', { class: 'hint', text: t('keyring.localDesc') }));

  // ---------------------------------------------------------- master password
  const current = h('input', { type: 'password', autocomplete: 'current-password', spellcheck: 'false' });
  const next = h('input', { type: 'password', autocomplete: 'new-password', spellcheck: 'false' });
  const repeat = h('input', { type: 'password', autocomplete: 'new-password', spellcheck: 'false' });
  const err = h('div', { class: 'err' });

  const setBtn = h('button', { class: 'btn', text: t('keyring.change') });
  setBtn.onclick = async () => {
    err.textContent = '';
    try {
      await actions.setMasterPassword(state.requiresPassword ? current.value : '', next.value, repeat.value);
      current.value = ''; next.value = ''; repeat.value = '';
      notify();
    } catch (e) {
      err.textContent = String((e as Error).message ?? e);
    }
  };

  const removeBtn = h('button', { class: 'btn', text: t('keyring.remove') });
  removeBtn.onclick = () => {
    err.textContent = '';
    const doIt = async () => {
      try {
        await actions.removeMasterPassword(current.value);
        current.value = '';
        notify();
      } catch (e) {
        err.textContent = String((e as Error).message ?? e);
      }
    };
    if (actions.confirm) actions.confirm(t('keyring.removeConfirm'), () => doIt());
    else void doIt();
  };

  const pwRow = (labelKey: string, input: HTMLElement) =>
    h('label', { class: 'field' }, h('span', { class: 'lbl', text: t(labelKey) }), input);

  const masterRows: Array<Node | null> = [
    h('h3', { text: t('sec.masterPassword') }),
    // The current password is only needed when one is already set.
    state.requiresPassword ? pwRow('keyring.currentPassword', current) : null,
    pwRow('keyring.newPassword', next),
    pwRow('keyring.repeatPassword', repeat),
    h('div', { class: 'row' }, setBtn, state.requiresPassword ? removeBtn : null),
    err,
    h('p', { class: 'hint', text: t('firstRun.security.masterHint') }),
  ];
  panel.append(...masterRows.filter((x): x is Node => x !== null));

  // ------------------------------------------------------------ secret store
  const store = h('select', {});
  for (const [value, labelKey] of [['local', 'sec.secretStore.local'], ['credman', 'sec.secretStore.credman']] as const) {
    const o = h('option', { value, text: t(labelKey) });
    if (value === state.secretBackend) o.selected = true;
    if (value === 'credman' && !state.credmanAvailable) o.disabled = true;
    store.append(o);
  }
  store.onchange = () => {
    void actions.saveSettings({ security: { secretStore: store.value } }).then(() => notify()).catch(() => undefined);
  };

  const secretRows: Array<Node | null> = [
    h('h3', { text: t('sec.secretStore') }),
    h('label', { class: 'field' }, h('span', { class: 'lbl', text: t('sec.secretStore') }), store),
    h('p', { class: 'hint', text: t('sec.secretStoreHint') }),
    !state.credmanAvailable ? h('p', { class: 'note', text: t('sec.credmanUnavailable') }) : null,
    h('p', { class: 'hint', text: t('sec.encryptionDesc') }),
    h('p', { class: 'note', text: t('security.malwareNotice') }),
  ];
  panel.append(...secretRows.filter((x): x is Node => x !== null));

  return panel;
}
