/**
 * apps/octobrowser/src/preload/tab.ts
 *
 * Preload for WEB PAGES (every tab and, with nodeIntegrationInSubFrames, every
 * iframe). Runs sandboxed and context-isolated. It:
 *   1. runs page-shim.ts in the page's main world BEFORE page scripts: the
 *      antidetect fingerprint of the profile, or the Strict-preset protections;
 *   2. implements the per-tab volume multiplier and output-device selection
 *      of the audio mixer;
 *   3. exposes a tiny API ONLY to internal octo:// pages (start page, error pages).
 *
 * No globals are added to normal web pages.
 */
import { contextBridge, ipcRenderer } from 'electron';

import { PageConfig, pageShim } from './page-shim';

function readConfig(): PageConfig {
  const arg = process.argv.find((a) => a.startsWith('--octo-cfg='));
  const fallback: PageConfig = { canvas: 'allow', hw: 'allow', hwValues: { hardwareConcurrency: 4, deviceMemory: 8 }, volume: 1, sinkId: '', fp: null };
  if (!arg) return fallback;
  try {
    return { ...fallback, ...(JSON.parse(decodeURIComponent(escape(atob(arg.slice('--octo-cfg='.length))))) as Partial<PageConfig>) };
  } catch {
    return fallback;
  }
}

const cfg = readConfig();
const rnd = new Uint8Array(12);
crypto.getRandomValues(rnd);
/** Random, per-page event name for isolated-world -> main-world messages (not guessable by the page). */
const EVENT = `octo-${Array.from(rnd, (b) => b.toString(16).padStart(2, '0')).join('')}`;

function runInMainWorld(func: (...args: never[]) => unknown, args: unknown[]): void {
  try {
    contextBridge.executeInMainWorld({ func: func as (...a: unknown[]) => unknown, args });
  } catch {
    /* API unavailable - protections for this frame are not active; reported in the privacy panel */
  }
}

runInMainWorld(pageShim as never, [cfg, EVENT]);

// Audio updates pushed by the main process.
ipcRenderer.on('octo:audio', (_e, volume: number, sinkId: string) => {
  runInMainWorld(((name: string, f: number, s: string) => {
    document.dispatchEvent(new CustomEvent(name, { detail: { f, s } }));
  }) as never, [EVENT, volume, sinkId]);
});

// ---- internal pages (octo://newtab, octo://error, octo://https-only) only ----
if (location.protocol === 'octo:') {
  contextBridge.exposeInMainWorld('octoInternal', {
    status: () => ipcRenderer.invoke('internal:status'),
    navigate: (input: string) => ipcRenderer.invoke('internal:navigate', String(input).slice(0, 4096)),
    allowHttp: (url: string) => ipcRenderer.invoke('internal:allow-http', String(url).slice(0, 4096)),
    sandbox: () => ipcRenderer.invoke('internal:sandbox'),
    strings: () => ipcRenderer.invoke('internal:strings'),
  });
}
