/** packages/core/test/profiles.test.ts - profile CRUD, isolation layout, vault, encrypted export. */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  DataLayout, DecryptionError, ProfileKind, ProfileManager, ProfileData, RESTORED_ENTRY_FILE,
  generateKey, generateMnemonic, isProfileTheme, isValidMnemonic, sanitizeProfile, privateBrowsingPatch, privateBrowsingStamp,
} from '../src';
import { FAST_KDF, tmpDir } from './helpers';

const NAMES: Record<ProfileKind, string> = {
  personal: 'Osobisty', work: 'Praca', private: 'Prywatny', testing: 'Testy', temporary: 'Tymczasowy', tor: 'Tor', custom: 'Własny',
};

function setup() {
  const layout = new DataLayout(path.join(tmpDir(), 'OctoBrowser'));
  layout.ensure();
  const pm = new ProfileManager(layout, undefined, FAST_KDF);
  pm.ensureDefaults(NAMES);
  return { layout, pm };
}

describe('ProfileManager', () => {
  it('creates the default set with separate data folders', () => {
    const { layout, pm } = setup();
    const kinds = pm.list().map((p) => p.kind);
    expect(kinds).toEqual(['personal', 'work', 'private', 'testing', 'temporary', 'tor']);
    const dirs = new Set(pm.list().map((p) => layout.profileEngineDir(p.id)));
    expect(dirs.size).toBe(6);
    for (const d of dirs) expect(fs.existsSync(d)).toBe(true);
  });

  it('applies kind-specific defaults (Tor: no add-ons, Temporary: delete on close)', () => {
    const { pm } = setup();
    const tor = pm.list().find((p) => p.kind === 'tor')!;
    expect(tor.addons).toEqual([]);
    expect(tor.protection.level).toBe('tor');
    expect(pm.list().find((p) => p.kind === 'temporary')!.deleteOnClose).toBe(true);
    // Tor profile can never get add-ons, even via update
    expect(pm.update(tor.id, { addons: ['adblock'] }).addons).toEqual([]);
  });

  it('create / update / duplicate / remove / reset', () => {
    const { layout, pm } = setup();
    const c = pm.create({ name: 'Klient ŻÓŁW', kind: 'custom' });
    pm.update(c.id, { protection: { level: 'strict' }, network: { mode: 'proxy', proxyRules: 'socks5://127.0.0.1:1080' } });
    expect(pm.get(c.id).network.proxyRules).toBe('socks5://127.0.0.1:1080');
    fs.writeFileSync(path.join(layout.profileEngineDir(c.id), 'Cookies'), 'cookie-db');
    const d = pm.duplicate(c.id, 'Kopia', true);
    expect(fs.readFileSync(path.join(layout.profileEngineDir(d.id), 'Cookies'), 'utf8')).toBe('cookie-db');
    pm.reset(d.id);
    expect(fs.existsSync(path.join(layout.profileEngineDir(d.id), 'Cookies'))).toBe(false);
    pm.remove(c.id);
    expect(() => pm.get(c.id)).toThrow();
    expect(fs.existsSync(layout.profileDir(c.id))).toBe(false);
  });

  it('refuses credentials inside proxy rules (they belong to the encrypted secret store)', () => {
    const { pm } = setup();
    const c = pm.create({ name: 'X', kind: 'custom' });
    expect(() => pm.update(c.id, { network: { mode: 'proxy', proxyRules: 'http://user:pass@proxy:8080' } })).toThrow();
  });

  it('cleans temporary profiles', () => {
    const { layout, pm } = setup();
    const tmp = pm.list().find((p) => p.kind === 'temporary')!;
    fs.writeFileSync(path.join(layout.profileEngineDir(tmp.id), 'Local Storage'), 'x');
    expect(pm.cleanupEphemeral()).toContain(tmp.id);
    expect(fs.readdirSync(layout.profileEngineDir(tmp.id))).toEqual([]);
  });

  it('vault: seal encrypts engine data, a wrong 12-word phrase is rejected, open restores data', async () => {
    const { layout, pm } = setup();
    const p = pm.list()[0];
    const { passphrase, key } = await pm.createVault(p.id);
    expect(isValidMnemonic(passphrase)).toBe(true);
    expect(passphrase.split(' ')).toHaveLength(12);
    fs.mkdirSync(path.join(layout.profileEngineDir(p.id), 'Local Storage'), { recursive: true });
    fs.writeFileSync(path.join(layout.profileEngineDir(p.id), 'Local Storage', 'leveldb'), 'PRIVATE-DATA');
    fs.mkdirSync(path.join(layout.profileEngineDir(p.id), 'Cache'), { recursive: true });
    fs.writeFileSync(path.join(layout.profileEngineDir(p.id), 'Cache', 'x'), 'cache');
    pm.sealVault(p.id, key);
    expect(pm.isVaultLocked(p.id)).toBe(true);
    expect(fs.readdirSync(layout.profileEngineDir(p.id))).toEqual([]);
    expect(fs.readFileSync(layout.profileVaultFile(p.id)).toString('latin1')).not.toContain('PRIVATE-DATA');
    await expect(pm.deriveVaultKey(p.id, generateMnemonic())).rejects.toBeInstanceOf(DecryptionError);
    // Sloppy typing (case, extra spaces and line breaks) must still open it.
    const key2 = await pm.deriveVaultKey(p.id, `  ${passphrase.toUpperCase().split(' ').join('\n ')} `);
    pm.openVault(p.id, key2);
    expect(fs.readFileSync(path.join(layout.profileEngineDir(p.id), 'Local Storage', 'leveldb'), 'utf8')).toBe('PRIVATE-DATA');
    expect(fs.existsSync(path.join(layout.profileEngineDir(p.id), 'Cache'))).toBe(false); // caches discarded
  });

  it('export is always encrypted with 12 words; import recovers it as a new profile', async () => {
    const { layout, pm } = setup();
    const p = pm.list()[1];
    fs.writeFileSync(path.join(layout.profileEngineDir(p.id), 'Cookies'), 'COOKIE-SECRET');
    const out = path.join(layout.root, 'export ą.obprofile');
    const phrase = generateMnemonic();
    // Anything that is not a valid 12-word phrase is refused outright.
    await expect(pm.exportEncrypted(p.id, 'weak', out)).rejects.toThrow();
    await expect(pm.exportEncrypted(p.id, 'Eksport hasło 99!', out)).rejects.toThrow();
    await pm.exportEncrypted(p.id, phrase, out);
    expect(fs.readFileSync(out).toString('latin1')).not.toContain('COOKIE-SECRET');
    await expect(pm.importEncrypted(out, generateMnemonic())).rejects.toBeInstanceOf(DecryptionError);
    const imported = await pm.importEncrypted(out, phrase);
    expect(imported.id).not.toBe(p.id);
    expect(fs.readFileSync(path.join(layout.profileEngineDir(imported.id), 'Cookies'), 'utf8')).toBe('COOKIE-SECRET');
  });

  it('profile data (bookmarks/history) is encrypted per profile', () => {
    const { layout, pm } = setup();
    const key = generateKey();
    const [a, b] = pm.list();
    const da = new ProfileData(layout, a.id, () => key);
    const db = new ProfileData(layout, b.id, () => key);
    da.bookmarks.save([{ id: '1', title: 'Bank', url: 'https://bank.example/', createdAt: '' }]);
    expect(db.bookmarks.load()).toEqual([]);
    expect(fs.readFileSync(layout.profileDataFile(a.id, 'bookmarks'), 'utf8')).not.toContain('bank.example');
  });

  it('sanitizeProfile rejects bad ids (path traversal)', () => {
    expect(() => sanitizeProfile({ id: '../x', kind: 'custom', name: 'x' })).toThrow();
  });

  it('every profile has a chrome theme, and only dark grey or white are accepted', () => {
    const { pm } = setup();
    for (const p of pm.list()) expect(['dark', 'light']).toContain(p.theme);
    const p = pm.create({ name: 'Motyw', kind: 'custom', patch: { theme: 'light' } });
    expect(pm.get(p.id).theme).toBe('light');
    // An unknown value falls back to the default instead of breaking the UI.
    const patched = pm.update(p.id, { theme: 'neon' as never });
    expect(patched.theme).toBe('dark');
    expect(isProfileTheme(patched.theme)).toBe(true);
  });
  it('adopts a profile entry restored by restore-profile.bat (entry deleted from the list)', () => {
    const { layout, pm } = setup();
    const p = pm.create({ name: 'Bank – Łódź', kind: 'custom' });
    const entry = JSON.stringify(pm.get(p.id));
    // Simulate: profile deleted, then its data folder restored from an archive by the script.
    pm.remove(p.id);
    fs.mkdirSync(layout.profileEngineDir(p.id), { recursive: true });
    fs.writeFileSync(path.join(layout.profileEngineDir(p.id), 'Cookies'), 'x');
    fs.writeFileSync(path.join(layout.profileDir(p.id), RESTORED_ENTRY_FILE), `\uFEFF${entry}`);
    const r = pm.adoptRestoredEntries();
    expect(r.adopted.map((x) => x.id)).toEqual([p.id]);
    expect(r.rejected).toEqual([]);
    expect(pm.get(p.id).name).toBe('Bank – Łódź');
    expect(pm.get(p.id).encrypted).toBe(false); // no vault on disk
    expect(fs.existsSync(path.join(layout.profileDir(p.id), RESTORED_ENTRY_FILE))).toBe(false);
    // Running again changes nothing.
    expect(pm.adoptRestoredEntries().adopted).toEqual([]);
  });

  it('rejects tampered restore markers and never adopts them', () => {
    const { layout, pm } = setup();
    const before = pm.list().length;
    const bad = [
      ['p-aaaaaa000001', JSON.stringify({ id: 'p-bbbbbb000002', kind: 'custom', name: 'mismatch' })],
      ['p-aaaaaa000003', JSON.stringify({ id: 'p-aaaaaa000003', kind: 'custom', name: 'x', network: { mode: 'proxy', proxyRules: 'http://user:pass@proxy:8080' } })],
      ['p-aaaaaa000004', '{ not json'],
      ['p-aaaaaa000005', JSON.stringify({ id: 'p-aaaaaa000005', kind: 'root', name: 'x' })],
    ];
    for (const [dir, content] of bad) {
      fs.mkdirSync(layout.profileDir(dir), { recursive: true });
      fs.writeFileSync(path.join(layout.profileDir(dir), RESTORED_ENTRY_FILE), content);
    }
    const r = pm.adoptRestoredEntries();
    expect(r.adopted).toEqual([]);
    expect(r.rejected.sort()).toEqual(bad.map(([d]) => d).sort());
    expect(pm.list().length).toBe(before);
    for (const [dir] of bad) expect(fs.existsSync(path.join(layout.profileDir(dir), `${RESTORED_ENTRY_FILE}.rejected`))).toBe(true);
  });

  it('private browsing is a throw-away temporary profile that keeps nothing', () => {
    const { pm } = setup();
    const p = pm.create({ name: `Prywatne ${privateBrowsingStamp(new Date(2026, 8, 25, 14, 3))}`, kind: 'temporary', patch: privateBrowsingPatch() });
    expect(p.kind).toBe('temporary');
    expect(p.name).toBe('Prywatne 2026-09-25 14:03');
    expect(p.deleteOnClose).toBe(true);
    expect(p.keepHistory).toBe(false);
    expect(p.restoreSession).toBe(false);
    expect(p.protection.level).toBe('strict');
    expect(p.protection.overrides?.clearOnExit).toBe(true);
    expect(p.protection.overrides?.blockThirdPartyCookies).toBe(true);
    // Two private sessions differ only by name - never by randomised settings.
    const q = pm.create({ name: 'Prywatne 2026-09-25 15:00', kind: 'temporary', patch: privateBrowsingPatch() });
    expect({ ...q, id: '', name: '', createdAt: '', updatedAt: '' }).toEqual({ ...p, id: '', name: '', createdAt: '', updatedAt: '' });
  });

  it('accepts a settings patch from the create dialog', () => {
    const { pm } = setup();
    const p = pm.create({
      name: 'Z patchiem', kind: 'custom',
      patch: { protection: { level: 'strict', overrides: { canvas: 'block-readback' } }, keepHistory: false, deleteOnClose: true },
    });
    expect(p.name).toBe('Z patchiem');
    expect(p.kind).toBe('custom');
    expect(p.protection).toEqual({ level: 'strict', overrides: { canvas: 'block-readback' } });
    expect(p.keepHistory).toBe(false);
    expect(p.deleteOnClose).toBe(true);
    expect(pm.get(p.id).network.mode).toBe('system'); // untouched defaults survive
  });

  it('does not duplicate a profile whose entry still exists', () => {
    const { layout, pm } = setup();
    const p = pm.list()[0];
    fs.writeFileSync(path.join(layout.profileDir(p.id), RESTORED_ENTRY_FILE), JSON.stringify({ ...p, name: 'Changed' }));
    const r = pm.adoptRestoredEntries();
    expect(r.adopted).toEqual([]);
    expect(pm.get(p.id).name).toBe(p.name); // current settings win
    expect(pm.list().filter((x) => x.id === p.id).length).toBe(1);
  });
});
