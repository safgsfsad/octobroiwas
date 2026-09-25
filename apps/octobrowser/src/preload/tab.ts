/**
 * apps/octobrowser/src/preload/tab.ts
 *
 * Preload for WEB PAGES (every tab and, with nodeIntegrationInSubFrames, every
 * iframe). Runs sandboxed and context-isolated. It:
 *   1. installs the Strict-preset fingerprinting protections in the page's
 *      main world BEFORE page scripts run - blocking read-back / reporting
 *      fixed common values, NEVER random values;
 *   2. implements the per-tab volume multiplier and output-device selection
 *      of the audio mixer;
 *   3. exposes a tiny API ONLY to internal octo:// pages (start page, error pages).
 *
 * No globals are added to normal web pages.
 */
import { contextBridge, ipcRenderer } from 'electron';

interface TabConfig {
  canvas: 'allow' | 'block-readback';
  hw: 'allow' | 'normalize';
  hwValues: { hardwareConcurrency: number; deviceMemory: number };
  volume: number; // 0..1
  sinkId: string;
}

function readConfig(): TabConfig {
  const arg = process.argv.find((a) => a.startsWith('--octo-cfg='));
  const fallback: TabConfig = { canvas: 'allow', hw: 'allow', hwValues: { hardwareConcurrency: 4, deviceMemory: 8 }, volume: 1, sinkId: '' };
  if (!arg) return fallback;
  try {
    return { ...fallback, ...(JSON.parse(atob(arg.slice('--octo-cfg='.length))) as Partial<TabConfig>) };
  } catch {
    return fallback;
  }
}

const cfg = readConfig();
const rnd = new Uint8Array(12);
crypto.getRandomValues(rnd);
/** Random, per-page event name for isolated-world -> main-world messages (not guessable by the page). */
const EVENT = `octo-${Array.from(rnd, (b) => b.toString(16).padStart(2, '0')).join('')}`;

/**
 * Executed in the page's MAIN world. Must be self-contained (serialised).
 */
function mainWorldShim(c: TabConfig, eventName: string): void {
  'use strict';
  const defineGetter = (proto: object, prop: string, value: () => unknown) => {
    try {
      Object.defineProperty(proto, prop, { get: value, configurable: true, enumerable: true });
    } catch { /* ignore */ }
  };

  // ---- hardware-revealing APIs: fixed common values (Strict preset) ----
  if (c.hw === 'normalize') {
    defineGetter(Navigator.prototype, 'hardwareConcurrency', () => c.hwValues.hardwareConcurrency);
    if ('deviceMemory' in Navigator.prototype) defineGetter(Navigator.prototype, 'deviceMemory', () => c.hwValues.deviceMemory);
    try { delete (Navigator.prototype as unknown as Record<string, unknown>).getBattery; } catch { /* ignore */ }
    if ('getGamepads' in Navigator.prototype) {
      (Navigator.prototype as unknown as { getGamepads: () => unknown[] }).getGamepads = function getGamepads() { return []; };
    }
  }

  // ---- Canvas / WebGL read-back blocking (always blank => identical for everyone) ----
  if (c.canvas === 'block-readback') {
    const blankLike = (src: { width: number; height: number }) => {
      const b = document.createElement('canvas');
      b.width = src.width;
      b.height = src.height;
      return b;
    };
    const toDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function (this: HTMLCanvasElement, ...a: unknown[]) {
      return toDataURL.apply(blankLike(this), a as []);
    };
    const toBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (this: HTMLCanvasElement, cb: BlobCallback, ...a: unknown[]) {
      return toBlob.call(blankLike(this), cb, ...(a as []));
    };
    CanvasRenderingContext2D.prototype.getImageData = function (_sx: number, _sy: number, sw: number, sh: number) {
      return new ImageData(Math.max(1, Math.abs(Math.floor(sw))), Math.max(1, Math.abs(Math.floor(sh))));
    };
    if (typeof OffscreenCanvasRenderingContext2D !== 'undefined') {
      OffscreenCanvasRenderingContext2D.prototype.getImageData = function (_sx: number, _sy: number, sw: number, sh: number) {
        return new ImageData(Math.max(1, Math.abs(Math.floor(sw))), Math.max(1, Math.abs(Math.floor(sh))));
      };
    }
    if (typeof OffscreenCanvas !== 'undefined') {
      const convert = OffscreenCanvas.prototype.convertToBlob;
      OffscreenCanvas.prototype.convertToBlob = function (this: OffscreenCanvas, opts?: ImageEncodeOptions) {
        return convert.call(new OffscreenCanvas(this.width, this.height), opts);
      };
    }
    for (const Ctx of [typeof WebGLRenderingContext !== 'undefined' ? WebGLRenderingContext : null, typeof WebGL2RenderingContext !== 'undefined' ? WebGL2RenderingContext : null]) {
      if (!Ctx) continue;
      Ctx.prototype.readPixels = function (...args: unknown[]) {
        const view = args.find((a) => ArrayBuffer.isView(a)) as ArrayBufferView | undefined;
        if (view) new Uint8Array(view.buffer, view.byteOffset, view.byteLength).fill(0);
      } as typeof Ctx.prototype.readPixels;
    }
  }

  // ---- audio mixer: per-tab volume multiplier + output device ----
  const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume');
  if (!desc || !desc.get || !desc.set) return;
  const nativeGet = desc.get;
  const nativeSet = desc.set;
  const pageVolume = new WeakMap<HTMLMediaElement, number>();
  let factor = Math.min(1, Math.max(0, c.volume));
  let sinkId = c.sinkId;
  const apply = (el: HTMLMediaElement) => {
    if (!pageVolume.has(el)) pageVolume.set(el, nativeGet.call(el) as number);
    nativeSet.call(el, (pageVolume.get(el) as number) * factor);
    const withSink = el as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void>; sinkId?: string };
    if (withSink.setSinkId && withSink.sinkId !== sinkId) withSink.setSinkId(sinkId).catch(() => { /* device gone */ });
  };
  Object.defineProperty(HTMLMediaElement.prototype, 'volume', {
    configurable: true,
    enumerable: true,
    get(this: HTMLMediaElement) {
      return pageVolume.has(this) ? pageVolume.get(this) : nativeGet.call(this);
    },
    set(this: HTMLMediaElement, v: number) {
      const n = Number(v);
      if (!(n >= 0 && n <= 1)) { nativeSet.call(this, v); return; } // native error behaviour
      pageVolume.set(this, n);
      nativeSet.call(this, n * factor);
    },
  });
  document.addEventListener('play', (e) => { if (e.target instanceof HTMLMediaElement) apply(e.target); }, true);
  document.addEventListener(eventName, (e) => {
    const d = (e as CustomEvent<{ f: number; s: string }>).detail;
    if (!d) return;
    factor = Math.min(1, Math.max(0, Number(d.f)));
    sinkId = String(d.s ?? '');
    document.querySelectorAll('audio,video').forEach((el) => apply(el as HTMLMediaElement));
  });
}

function runInMainWorld(func: (...args: never[]) => unknown, args: unknown[]): void {
  try {
    contextBridge.executeInMainWorld({ func: func as (...a: unknown[]) => unknown, args });
  } catch {
    /* API unavailable - protections for this frame are not active; reported in the privacy panel */
  }
}

runInMainWorld(mainWorldShim as never, [cfg, EVENT]);

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
