/**
 * packages/shell/src/prepare.ts
 *
 * Must run BEFORE app.whenReady(). Decides where Chromium stores its data:
 *
 *   - First run (no bootstrap.json): Chromium uses a throw-away temp folder
 *     while the first-run wizard asks for the language and the data folder.
 *     After the wizard the app relaunches itself.
 *   - Normal run: Chromium's userData/sessionData = <data folder>\engine,
 *     crash dumps = <data folder>\logs\crashes. Nothing is written to
 *     %APPDATA% except bootstrap.json.
 *   - Windows Sandbox session (--ephemeral-data-dir): data lives inside the
 *     disposable sandbox, bootstrap.json is never written.
 */
import { app } from 'electron';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { APPS, AppId, AppInfo, BootstrapState, BootstrapStore, DataLayout, isLang } from '@octo/core';

export interface PreparedApp {
  info: AppInfo;
  store: BootstrapStore;
  state: BootstrapState | null;
  layout: DataLayout | null;
  /** Folder containing the built UI (dist/). */
  distDir: string;
  portable: boolean;
  /** Running as a disposable Windows Sandbox session. */
  ephemeral: boolean;
  firstRunTempDir?: string;
  installDir: string;
}

/** Read "--name=value" from argv. */
export function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

export function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/** Bootstrap file location for an app (portable mode = next to the exe). */
export function bootstrapFileFor(info: AppInfo, portable: boolean): string {
  const exeDir = path.dirname(app.getPath('exe'));
  return portable ? path.join(exeDir, `${info.id}.bootstrap.json`) : path.join(app.getPath('appData'), info.bootstrapDirName, 'bootstrap.json');
}

export interface PrepareOptions {
  /** Use a different Chromium userData folder (per-profile browser processes). */
  engineDirFor?: (layout: DataLayout) => string;
  /** Extra Chromium switches decided per process (e.g. WebRTC policy of the profile). */
  extraSwitches?: (layout: DataLayout) => Array<[string, string?]>;
}

export function prepareApp(appId: AppId, distDir: string, opts: PrepareOptions = {}): PreparedApp {
  const info = APPS[appId];
  app.setName(info.productName);
  if (process.platform === 'win32') app.setAppUserModelId(info.appUserModelId);

  // Force the Chromium sandbox for EVERY renderer (UI and web pages).
  app.enableSandbox();

  // Privacy-related Chromium switches (no background pings/reporting).
  app.commandLine.appendSwitch('no-pings'); // disable <a ping> hyperlink auditing
  app.commandLine.appendSwitch('disable-domain-reliability');
  app.commandLine.appendSwitch('disable-background-networking');
  app.commandLine.appendSwitch('disable-features', 'MediaRouter,DialMediaRouteProvider,OptimizationHints,AutofillServerCommunication,Translate,InterestFeedContentSuggestions');

  const exeDir = path.dirname(app.getPath('exe'));
  const portable = fs.existsSync(path.join(exeDir, 'portable.flag'));
  const store = new BootstrapStore(bootstrapFileFor(info, portable));

  let state: BootstrapState | null;
  const ephemeralDir = argValue('ephemeral-data-dir');
  if (ephemeralDir && path.isAbsolute(ephemeralDir)) {
    const lang = argValue('lang-choice');
    state = {
      schema: 1,
      language: isLang(lang) ? lang : 'en',
      baseDir: ephemeralDir,
      dataDir: path.join(ephemeralDir, info.dataSubdir),
      firstRunAt: new Date().toISOString(),
    };
  } else {
    state = store.read();
  }

  let layout: DataLayout | null = null;
  let firstRunTempDir: string | undefined;
  if (state) {
    layout = new DataLayout(state.dataDir);
    layout.ensure(appId === 'octodetect' ? ['reports'] : ['downloads']);
    const engineDir = opts.engineDirFor ? opts.engineDirFor(layout) : layout.engine;
    fs.mkdirSync(engineDir, { recursive: true });
    app.setPath('userData', engineDir);
    app.setPath('sessionData', engineDir);
    for (const [sw, val] of opts.extraSwitches?.(layout) ?? []) {
      if (val === undefined) app.commandLine.appendSwitch(sw);
      else app.commandLine.appendSwitch(sw, val);
    }
    app.setPath('crashDumps', path.join(layout.logs, 'crashes'));
    // navigator.language / Accept-Language follow the chosen UI language (fixed, never random).
    app.commandLine.appendSwitch('lang', state.language === 'pl' ? 'pl-PL' : 'en-US');
  } else {
    firstRunTempDir = fs.mkdtempSync(path.join(os.tmpdir(), `${info.id}-firstrun-`));
    app.setPath('userData', firstRunTempDir);
    app.setPath('sessionData', firstRunTempDir);
  }

  return {
    info,
    store,
    state,
    layout,
    distDir,
    portable,
    ephemeral: !!ephemeralDir,
    firstRunTempDir,
    installDir: exeDir,
  };
}

/** Accept-Language header matching the UI language. Same for all users of a language. */
export function acceptLanguages(lang: 'en' | 'pl'): string {
  return lang === 'pl' ? 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7' : 'en-US,en;q=0.9';
}

/**
 * Chromium user agent without "Electron/x" and app tokens, so pages see a
 * regular Chrome-on-Windows UA (reduces uniqueness; no device impersonation -
 * the engine IS Chromium, and version/OS are real).
 */
export function cleanUserAgent(ua: string): string {
  return ua
    .replace(/\s?Electron\/[\d.]+/g, '')
    .replace(/\s?(OctoBrowser\.su|OctoDetect\.su|octosuite|octobrowser|octodetect)\/[\w.-]+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
