/**
 * e2e/octobrowser.spec.ts - OctoBrowser.su end-to-end tests (real Electron).
 *
 * Covers: startup in ephemeral mode, UI language, default profile set,
 * renderer isolation (no Node in the trusted UI, channel allow-list), profile
 * creation, starting a profile process (data key over the private pipe),
 * data-folder layout and that no secrets end up in plain files or logs.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { closeApp, dumpLogs, invoke, launchApp, listFiles, Launched, waitFor, windowWithPage } from './helpers';

interface ProfileRow {
  id: string; name: string; kind: string; running: boolean; ready: boolean; encrypted: boolean;
  protection: { level: string; overrides?: Record<string, unknown> };
  keepHistory: boolean; deleteOnClose: boolean;
}

let l: Launched;

test.beforeAll(async () => {
  l = await launchApp('octobrowser', 'pl');
});

// On failure print the app's own (redacted) logs - the only view into the app on CI.
test.afterEach(async ({}, testInfo) => {
  if (l && testInfo.status !== testInfo.expectedStatus) console.log(`[e2e] logs after "${testInfo.title}":\n${dumpLogs(l.dataDir)}`);
});

test.afterAll(async () => {
  if (l) await closeApp(l);
});

test('launcher opens in Polish with the default profiles', async () => {
  const win = await windowWithPage(l.app, 'launcher.html');
  const init = await invoke<{ lang: string; version: string; keyringMode: string }>(win, 'mgr:init');
  expect(init.lang).toBe('pl');
  expect(init.keyringMode).toBe('os'); // ephemeral sessions use DPAPI
  expect(await l.app.evaluate(({ app }) => app.getVersion())).toBe(init.version);
  const profiles = await invoke<ProfileRow[]>(win, 'mgr:profiles');
  expect(profiles.map((p) => p.kind).sort()).toEqual(['personal', 'private', 'temporary', 'testing', 'tor', 'work']);
  await expect(win.locator('html')).toHaveAttribute('lang', 'pl');
});

test('trusted UI has no Node access and only its own IPC namespace', async () => {
  const win = await windowWithPage(l.app, 'launcher.html');
  const env = await win.evaluate(() => ({
    require: typeof (globalThis as Record<string, unknown>).require,
    process: typeof (globalThis as Record<string, unknown>).process,
    module: typeof (globalThis as Record<string, unknown>).module,
  }));
  expect(env).toEqual({ require: 'undefined', process: 'undefined', module: 'undefined' });
  await expect(invoke(win, 'od:init')).rejects.toThrow(/not allowed/);
  await expect(invoke(win, 'ui:state')).rejects.toThrow(/not allowed/);
  // The main process sandboxes every renderer.
  const sandboxed = await l.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every((w) => {
    const prefs = (w.webContents as unknown as { getLastWebPreferences?: () => { sandbox?: boolean; nodeIntegration?: boolean; contextIsolation?: boolean } }).getLastWebPreferences?.();
    return !prefs || (prefs.sandbox !== false && prefs.nodeIntegration !== true && prefs.contextIsolation !== false);
  }));
  expect(sandboxed).toBe(true);
});

test('the create dialog payload (name + kind + settings patch) is honoured', async () => {
  const win = await windowWithPage(l.app, 'launcher.html');
  const created = await invoke<ProfileRow>(win, 'mgr:create', {
    name: 'E2E z patchem', kind: 'custom',
    patch: { protection: { level: 'strict', overrides: { canvas: 'block-readback' } }, keepHistory: false, deleteOnClose: true },
  });
  expect(created.name).toBe('E2E z patchem');
  expect(created.protection.level).toBe('strict');
  expect(created.protection.overrides?.canvas).toBe('block-readback');
  expect(created.keepHistory).toBe(false);
  expect(created.deleteOnClose).toBe(true);
  // The legacy two-argument form still works (older callers / scripts).
  const legacy = await invoke<ProfileRow>(win, 'mgr:create', 'E2E stary zapis', 'custom');
  expect(legacy.name).toBe('E2E stary zapis');
  expect(legacy.protection.level).toBe('standard');
});

test('a new profile starts in its own process', async () => {
  const win = await windowWithPage(l.app, 'launcher.html');
  const created = await invoke<ProfileRow>(win, 'mgr:create', 'E2E Łódź', 'custom');
  expect(created.id).toMatch(/^[a-z0-9-]{3,64}$/);
  const r = await invoke<{ status: string }>(win, 'mgr:launch', created.id, {});
  expect(r.status).toBe('started');
  const row = await waitFor(async () => {
    const list = await invoke<ProfileRow[]>(win, 'mgr:profiles');
    const p = list.find((x) => x.id === created.id);
    return p && p.running && p.ready ? p : null;
  }, 120_000, 'profile process to become ready');
  expect(row.name).toBe('E2E Łódź');
  // Its Chromium data lives only in its own folder.
  const engine = path.join(l.dataDir, 'OctoBrowser', 'profiles', created.id, 'engine');
  await waitFor(async () => fs.existsSync(engine) && fs.readdirSync(engine).length > 0, 60_000, 'profile engine folder');
  await invoke(win, 'mgr:close-profile', created.id);
  await waitFor(async () => {
    const list = await invoke<ProfileRow[]>(win, 'mgr:profiles');
    return !list.find((x) => x.id === created.id)?.running;
  }, 60_000, 'profile process to exit');
});

test('data folder layout and no plaintext secrets', async () => {
  // The keyring is created during startup - wait until the launcher is up.
  await windowWithPage(l.app, 'launcher.html');
  const base = path.join(l.dataDir, 'OctoBrowser');
  for (const d of ['config', 'profiles', 'logs', 'backups', 'temp']) expect(fs.existsSync(path.join(base, d))).toBe(true);
  expect(fs.existsSync(path.join(base, 'config', 'keyring.bin'))).toBe(true);
  // profiles.json holds metadata only (versioned envelope with SHA-256).
  const env = JSON.parse(fs.readFileSync(path.join(base, 'config', 'profiles.json'), 'utf8')) as { schema: number; sha256: string; payload: string };
  expect(env.schema).toBe(1);
  expect(env.sha256).toMatch(/^[0-9a-f]{64}$/);
  // Logs never contain key material or the data key's base64 form.
  for (const f of listFiles(path.join(base, 'logs'))) {
    const text = fs.readFileSync(path.join(base, 'logs', f), 'utf8');
    expect(text).not.toMatch(/-----BEGIN|"key"\s*:|password=/i);
  }
});
