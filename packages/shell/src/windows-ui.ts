/**
 * packages/shell/src/windows-ui.ts
 *
 * Small helper windows shared by both apps: splash screen and the first-run
 * wizard. Both are sandboxed, context-isolated and load local files only.
 */
import { app, BrowserWindow, nativeTheme } from 'electron';
import * as path from 'node:path';
import { trustWebContents } from './ipc';
import type { AppId } from '@octo/core';

export const THEME = {
  octobrowser: { bg: '#0b1020', accent: '#7c5cff' },
  octodetect: { bg: '#07161a', accent: '#14b8a6' },
} as const;

export function iconPath(distDir: string): string {
  return path.join(distDir, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon-256.png');
}

export function createUtilityWindow(distDir: string, appId: AppId, page: string, opts: { width: number; height: number; frame?: boolean; resizable?: boolean; query?: Record<string, string> }): BrowserWindow {
  nativeTheme.themeSource = 'dark';
  const win = new BrowserWindow({
    width: opts.width,
    height: opts.height,
    frame: opts.frame ?? true,
    resizable: opts.resizable ?? false,
    show: false,
    backgroundColor: THEME[appId].bg,
    icon: iconPath(distDir),
    autoHideMenuBar: true,
    title: appId === 'octobrowser' ? 'OctoBrowser.su' : 'OctoDetect.su',
    webPreferences: {
      preload: path.join(distDir, 'preload-setup.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  trustWebContents(win.webContents);
  win.once('ready-to-show', () => win.show());
  void win.loadFile(path.join(distDir, 'shared', page), { query: { app: appId, ...(opts.query ?? {}) } });
  return win;
}

/** Frameless splash screen shown while the app initialises. */
export function showSplash(distDir: string, appId: AppId, version: string): BrowserWindow {
  return createUtilityWindow(distDir, appId, 'splash.html', { width: 420, height: 280, frame: false, query: { v: version } });
}
