/**
 * packages/shell/src/firstrun.ts
 *
 * First-run wizard - shown ONLY ONCE per application (until bootstrap.json exists):
 *   1. Language: English / Polski
 *   2. Data folder: where EVERYTHING is saved locally (profiles, settings,
 *      logs, backups, downloads). Default: Documents\OctoSuite.
 *   3. Two options: automatic update checks and public-IP lookup consent.
 * All on ONE screen. The local key is always bound to this Windows account
 * (DPAPI, nothing to type); a master password can be added later in the
 * launcher's Security page. Only when DPAPI is unavailable does the screen ask
 * for a password, because the key could not be stored otherwise.
 * The wizard pre-fills language and folder from the sibling app if it was
 * already configured, but the user always confirms.
 *
 * bootstrap.json is written LAST, so an interrupted wizard simply runs again.
 */
import { app, dialog, BrowserWindow } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  APPS, BootstrapStore, DICTS, DataLayout, Keyring, Lang, Logger, createSettingsStore, guessLang,
  isAcceptablePassword, isLang, suggestBaseDir, validateBaseDir, SUITE_VERSION,
} from '@octo/core';
import { handle } from './ipc';
import { dpapiProtector } from './osprotector';
import { bootstrapFileFor, PreparedApp } from './prepare';
import { createUtilityWindow } from './windows-ui';

export interface FirstRunChoice {
  language: Lang;
  baseDir: string;
  publicIpLookup: boolean;
  autoUpdate: boolean;
  /** 'os' = DPAPI key (default), 'password' = wrap the key with a master password. */
  keyProtection: 'os' | 'password';
  /** Required (>= 10 chars) when keyProtection === 'password'. Never stored. */
  masterPassword?: string;
}

/** Is there already a data folder from an earlier install we should reuse? */
function inspectExisting(dataDir: string): { exists: boolean } {
  const layout = new DataLayout(dataDir);
  const kr = new Keyring(path.join(layout.config, 'keyring.bin'), dpapiProtector);
  return { exists: kr.exists() };
}

export function runFirstRun(prep: PreparedApp, logger: Logger): Promise<boolean> {
  const info = prep.info;
  const sibling = new BootstrapStore(bootstrapFileFor(APPS[info.sibling], prep.portable)).read();

  return new Promise<boolean>((resolve) => {
    let finished = false;
    const win: BrowserWindow = createUtilityWindow(prep.distDir, info.id, 'firstrun.html', { width: 720, height: 600 });

    handle('setup:init', logger, () => ({
      app: info.id,
      productName: info.productName,
      version: SUITE_VERSION,
      langGuess: sibling?.language ?? guessLang(app.getLocale()),
      suggestedBase: sibling?.baseDir ?? suggestBaseDir(app.getPath('documents')),
      siblingConfigured: !!sibling,
      dataSubdir: info.dataSubdir,
      dpapiAvailable: dpapiProtector.available(),
      dicts: DICTS,
    }));

    handle('setup:browse', logger, async (_e, current: string) => {
      const r = await dialog.showOpenDialog(win, {
        title: info.productName,
        defaultPath: typeof current === 'string' && current ? current : app.getPath('documents'),
        properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
      });
      return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
    });

    handle('setup:validate', logger, (_e, baseDir: string) => {
      const check = validateBaseDir(String(baseDir ?? ''), prep.installDir);
      if (!check.ok) return { ...check, existing: null };
      return { ...check, dataDir: path.join(baseDir, info.dataSubdir), existing: inspectExisting(path.join(baseDir, info.dataSubdir)) };
    });

    handle('setup:finish', logger, async (_e, choice: FirstRunChoice) => {
      if (!choice || !isLang(choice.language)) throw new Error('Invalid language');
      const check = validateBaseDir(String(choice.baseDir ?? ''), prep.installDir);
      if (!check.ok) throw new Error(check.errorKey);
      const baseDir = path.resolve(choice.baseDir);
      const dataDir = path.join(baseDir, info.dataSubdir);
      const layout = new DataLayout(dataDir);
      layout.ensure(info.id === 'octodetect' ? ['reports'] : ['downloads']);

      // Local key, in one of two modes:
      //   'os'       - wrapped with Windows DPAPI, opens automatically (default);
      //   'password' - wrapped with the master password typed above (Argon2id).
      // The password is used once here and then dropped: only the wrapped key is
      // written to disk. An existing key from an earlier install is reused; an
      // unreadable one is repaired on the next start (see keyring-recovery.ts).
      const keyring = new Keyring(path.join(layout.config, 'keyring.bin'), dpapiProtector);
      if (!keyring.exists()) {
        if (choice.keyProtection === 'password') {
          if (!isAcceptablePassword(choice.masterPassword ?? '')) throw new Error('firstRun.err.weakPassword');
          await keyring.create({ password: String(choice.masterPassword) });
        } else {
          if (!dpapiProtector.available()) throw new Error('firstRun.err.noDpapi');
          await keyring.create();
        }
        keyring.lock();
        logger.info('keyring.created', { mode: choice.keyProtection === 'password' ? 'password' : 'os' });
      }

      const settings = createSettingsStore(layout);
      settings.update((s) => {
        s.network.publicIpLookup = !!choice.publicIpLookup;
        s.updates.autoCheck = !!choice.autoUpdate;
      });

      // LAST step: bootstrap.json (language + folder). From now on the wizard is never shown again.
      prep.store.write({ schema: 1, language: choice.language, baseDir, dataDir, firstRunAt: new Date().toISOString() });
      logger.info('firstrun.completed', { language: choice.language });
      finished = true;
      setTimeout(() => {
        win.close();
        resolve(true);
      }, 50);
      return true;
    });

    handle('setup:quit', logger, () => {
      win.close();
      return true;
    });

    win.on('closed', () => {
      if (prep.firstRunTempDir) {
        try { fs.rmSync(prep.firstRunTempDir, { recursive: true, force: true }); } catch { /* in use until exit */ }
      }
      if (!finished) resolve(false);
    });
  });
}
