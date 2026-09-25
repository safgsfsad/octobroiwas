/**
 * apps/octobrowser/src/preload/page-shim.ts
 *
 * Code executed in the MAIN world of every page and iframe before page scripts
 * run (contextBridge.executeInMainWorld from preload/tab.ts). `pageShim` must be
 * completely SELF-CONTAINED: it is serialised to a string, so it may not use
 * imports, module variables or helpers defined outside its body.
 *
 * Three jobs:
 *   1. antidetect fingerprint (profile.fingerprint): navigator / UA-CH / screen /
 *      WebGL vendor+renderer / canvas + WebGL + audio + client-rects + font noise /
 *      WebRTC candidate rewriting / media devices / WebGPU switch;
 *   2. the Strict preset protections (canvas read-back blocking, normalised
 *      hardware values);
 *   3. per-tab volume + output device of the audio mixer.
 *
 * Undetectability: every replaced function / getter is a Proxy around the
 * ORIGINAL native function, so name, length, the missing `prototype`, receiver
 * brand checks ("Illegal invocation") stay native, and Function.prototype.toString
 * (itself proxied) reports "function x() { [native code] }". Noise is
 * deterministic per profile seed: the same profile always produces the same
 * canvas/audio hash (like a real device), different profiles differ.
 */

export interface PageFingerprint {
  platform: string;
  brands: Array<{ brand: string; version: string }>;
  fullVersionList: Array<{ brand: string; version: string }>;
  uaFullVersion: string;
  chPlatform: string;
  platformVersion: string;
  architecture: string;
  bitness: string;
  languages: string[] | null;
  cores: number | null;
  memory: number | null;
  screen: { width: number; height: number; availWidth: number; availHeight: number } | null;
  webglVendor: string | null;
  webglRenderer: string | null;
  canvas: 'off' | 'real' | 'noise';
  webgl: 'off' | 'real' | 'noise';
  audio: 'real' | 'noise';
  clientRects: 'real' | 'noise';
  fonts: 'real' | 'noise';
  webgpu: 'off' | 'real';
  webrtcMode: 'off' | 'real' | 'disable-udp' | 'altered' | 'manual';
  webrtcIp: string;
  mediaDevices: { audioInputs: number; audioOutputs: number; videoInputs: number } | null;
  doNotTrack: boolean;
  /** 32-bit seed derived from the profile fingerprint seed. */
  seed: number;
}

export interface PageConfig {
  canvas: 'allow' | 'block-readback';
  hw: 'allow' | 'normalize';
  hwValues: { hardwareConcurrency: number; deviceMemory: number };
  volume: number; // 0..1
  sinkId: string;
  fp: PageFingerprint | null;
}

export function pageShim(c: PageConfig, eventName: string): void {
  'use strict';
  const W = window as unknown as Record<string, unknown>;
  const fp = c.fp;
  const R = Reflect;
  const gOPD = Object.getOwnPropertyDescriptor;
  const dP = Object.defineProperty;

  // ------------------------------------------------------------ masking
  const names = new WeakMap<object, string>();
  const nativeToString = Function.prototype.toString;
  const tsProxy = new Proxy(nativeToString, {
    apply(target, self, args) {
      const n = (typeof self === 'function' || typeof self === 'object') && self !== null ? names.get(self) : undefined;
      return n !== undefined ? `function ${n}() { [native code] }` : R.apply(target, self, args);
    },
  });
  names.set(tsProxy, 'toString');
  try { dP(Function.prototype, 'toString', { ...gOPD(Function.prototype, 'toString'), value: tsProxy }); } catch { /* ignore */ }

  type Fn = (...a: never[]) => unknown;
  const hook = <T extends Fn>(orig: T, impl: (target: T, self: unknown, args: unknown[]) => unknown): T => {
    const p = new Proxy(orig, { apply: (t, s, a) => impl(t, s, a as unknown[]) });
    names.set(p, orig.name);
    return p;
  };
  /** Replace a getter; `fn(self, orig)` - call orig() first to keep native brand checks. */
  const getter = (proto: object | undefined, prop: string, fn: (self: unknown, orig: () => unknown) => unknown): void => {
    if (!proto) return;
    const d = gOPD(proto, prop);
    if (!d || !d.get) return;
    try { dP(proto, prop, { ...d, get: hook(d.get as Fn, (t, s, a) => fn(s, () => R.apply(t, s, a))) }); } catch { /* ignore */ }
  };
  /** Replace a method; `fn(self, args, orig)`. */
  const method = (proto: object | undefined, name: string, fn: (self: unknown, args: unknown[], orig: (...a: unknown[]) => unknown) => unknown): void => {
    if (!proto) return;
    const d = gOPD(proto, name);
    if (!d || typeof d.value !== 'function') return;
    try { dP(proto, name, { ...d, value: hook(d.value as Fn, (t, s, a) => fn(s, a, (...x) => R.apply(t, s, x))) }); } catch { /* ignore */ }
  };
  const proto = (name: string): object | undefined => (W[name] as { prototype?: object } | undefined)?.prototype;
  const fixed = (p: object | undefined, prop: string, value: unknown) => getter(p, prop, (_s, orig) => { orig(); return value; });

  // ------------------------------------------------------ deterministic noise
  const seed = fp ? fp.seed >>> 0 : 0;
  /** Stable pseudo-random 32-bit value for (seed, a, b). */
  const hash = (a: number, b = 0): number => {
    let h = (seed ^ Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca77)) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
    h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
    return (h ^ (h >>> 16)) >>> 0;
  };
  /** Flip the lowest bit of a sparse, seed-dependent subset of RGB channels. */
  const noisePixels = (data: Uint8ClampedArray | Uint8Array, w: number): void => {
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) continue; // untouched transparent pixels stay identical
      const px = i >> 2;
      const h = hash(px % w, (px / w) | 0);
      if ((h & 15) !== 0) continue; // ~6 % of pixels
      const ch = (h >>> 4) % 3;
      data[i + ch] ^= 1;
    }
  };

  // ============================================================ FINGERPRINT
  if (fp) {
    const Nav = proto('Navigator');
    // ---- navigator ----
    fixed(Nav, 'platform', fp.platform);
    if (fp.cores) fixed(Nav, 'hardwareConcurrency', fp.cores);
    if (fp.memory) fixed(Nav, 'deviceMemory', fp.memory);
    if (fp.languages && fp.languages.length) {
      const langs = Object.freeze(fp.languages.slice());
      fixed(Nav, 'languages', langs);
      fixed(Nav, 'language', langs[0]);
    }
    if (fp.doNotTrack) fixed(Nav, 'doNotTrack', '1');
    const WNav = proto('WorkerNavigator');
    if (WNav) { // (only present in workers - harmless in windows)
      fixed(WNav, 'platform', fp.platform);
      if (fp.cores) fixed(WNav, 'hardwareConcurrency', fp.cores);
    }

    // ---- User-Agent Client Hints (navigator.userAgentData) ----
    const UAD = proto('NavigatorUAData');
    if (UAD) {
      const freezeList = (l: Array<{ brand: string; version: string }>) => Object.freeze(l.map((b) => Object.freeze({ brand: b.brand, version: b.version })));
      const brands = freezeList(fp.brands);
      fixed(UAD, 'brands', brands);
      fixed(UAD, 'mobile', false);
      fixed(UAD, 'platform', fp.chPlatform);
      method(UAD, 'getHighEntropyValues', (self, args, orig) => {
        const p = orig(...args) as Promise<Record<string, unknown>>; // native validation / rejection
        return p.then((real) => {
          const hints = Array.isArray(args[0]) ? (args[0] as unknown[]).map(String) : [];
          const out: Record<string, unknown> = { brands: brands.map((b) => ({ ...b })), mobile: false, platform: fp.chPlatform };
          const all: Record<string, unknown> = {
            architecture: fp.architecture, bitness: fp.bitness, formFactors: ['Desktop'], fullVersionList: fp.fullVersionList.map((b) => ({ ...b })),
            model: '', platformVersion: fp.platformVersion, uaFullVersion: fp.uaFullVersion, wow64: false,
          };
          for (const h of hints) if (h in all) out[h] = all[h];
          void real; void self;
          const sorted: Record<string, unknown> = {}; // Chrome returns the keys alphabetically
          for (const k of Object.keys(out).sort()) sorted[k] = out[k];
          return sorted;
        });
      });
      method(UAD, 'toJSON', (_self, args, orig) => { orig(...args); return { brands: brands.map((b) => ({ ...b })), mobile: false, platform: fp.chPlatform }; });
    }

    // ---- screen ----
    if (fp.screen) {
      const S = proto('Screen');
      const sc = fp.screen;
      fixed(S, 'width', sc.width);
      fixed(S, 'height', sc.height);
      fixed(S, 'availWidth', sc.availWidth);
      fixed(S, 'availHeight', sc.availHeight);
      fixed(S, 'colorDepth', 24);
      fixed(S, 'pixelDepth', 24);
      const Win = proto('Window') ?? Object.getPrototypeOf(window);
      // outer size can never exceed the screen
      getter(window, 'outerWidth', (_s, orig) => Math.min(Number(orig()), sc.availWidth));
      getter(window, 'outerHeight', (_s, orig) => Math.min(Number(orig()), sc.availHeight));
      void Win;
      getter(window, 'screenX', (_s, orig) => Math.max(0, Math.min(Number(orig()), sc.width - 100)));
      getter(window, 'screenY', (_s, orig) => Math.max(0, Math.min(Number(orig()), sc.height - 100)));
    }

    // ---- WebGL ----
    const glProtos = [proto('WebGLRenderingContext'), proto('WebGL2RenderingContext')].filter(Boolean) as object[];
    if (fp.webgl === 'off') {
      method(proto('HTMLCanvasElement'), 'getContext', (_s, args, orig) => (/^(webgl|webgl2|experimental-webgl)$/.test(String(args[0])) ? null : orig(...args)));
      method(proto('OffscreenCanvas'), 'getContext', (_s, args, orig) => (/^(webgl|webgl2)$/.test(String(args[0])) ? null : orig(...args)));
    } else {
      for (const G of glProtos) {
        if (fp.webglVendor || fp.webglRenderer) {
          method(G, 'getParameter', (_s, args, orig) => {
            const v = orig(...args);
            const p = Number(args[0]);
            if (p === 0x9245 && fp.webglVendor) return fp.webglVendor; // UNMASKED_VENDOR_WEBGL
            if (p === 0x9246 && fp.webglRenderer) return fp.webglRenderer; // UNMASKED_RENDERER_WEBGL
            return v;
          });
        }
        if (fp.webgl === 'noise') {
          method(G, 'readPixels', (self, args, orig) => {
            const r = orig(...args);
            const view = args.find((a) => ArrayBuffer.isView(a)) as ArrayBufferView | undefined;
            if (view) noisePixels(new Uint8Array(view.buffer, view.byteOffset, view.byteLength), Math.max(1, Number(args[2]) || 1));
            void self;
            return r;
          });
        }
      }
    }
    if (fp.webgpu === 'off') {
      getter(Nav, 'gpu', (_s, orig) => { orig(); return undefined; });
    }

    // ---- canvas noise / blocking ----
    if (fp.canvas === 'noise') {
      const C2D = proto('CanvasRenderingContext2D');
      const origGetImageData = C2D && (gOPD(C2D, 'getImageData')?.value as ((...a: number[]) => ImageData) | undefined);
      /** Noised copy of a canvas (always a DOM canvas, so native 2D methods apply). */
      const noisedCopy = (src: HTMLCanvasElement | OffscreenCanvas): HTMLCanvasElement | null => {
        const w = src.width, h = src.height;
        if (!w || !h || w * h > 16_000_000 || !origGetImageData) return null;
        const tmp = document.createElement('canvas');
        tmp.width = w;
        tmp.height = h;
        const ctx = tmp.getContext('2d');
        if (!ctx) return null;
        ctx.drawImage(src as CanvasImageSource, 0, 0);
        const img = origGetImageData.call(ctx, 0, 0, w, h);
        noisePixels(img.data, w);
        ctx.putImageData(img, 0, 0);
        return tmp;
      };
      method(C2D, 'getImageData', (_self, args, orig) => {
        const img = orig(...args) as ImageData;
        const sx = Number(args[0]) | 0, sy = Number(args[1]) | 0;
        const w = img.width;
        const d = img.data;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i + 3] === 0) continue;
          const px = i >> 2;
          const h = hash(sx + (px % w), sy + ((px / w) | 0));
          if ((h & 15) !== 0) continue;
          d[i + ((h >>> 4) % 3)] ^= 1;
        }
        return img;
      });
      const HC = proto('HTMLCanvasElement');
      if (HC) {
        const nativeToDataURL = gOPD(HC, 'toDataURL')?.value as Fn;
        const nativeToBlob = gOPD(HC, 'toBlob')?.value as Fn;
        method(HC, 'toDataURL', (self, args, orig) => {
          orig(); // native receiver check
          const copy = noisedCopy(self as HTMLCanvasElement);
          return copy ? R.apply(nativeToDataURL, copy, args) : orig(...args);
        });
        method(HC, 'toBlob', (self, args, orig) => {
          const copy = noisedCopy(self as HTMLCanvasElement);
          return copy ? R.apply(nativeToBlob, copy, args) : orig(...args);
        });
      }
      method(proto('OffscreenCanvas'), 'convertToBlob', (self, args, orig) => {
        const s = self as OffscreenCanvas;
        const copy = noisedCopy(s);
        if (!copy) return orig(...args);
        const off = new OffscreenCanvas(s.width, s.height);
        off.getContext('2d')?.drawImage(copy, 0, 0);
        return R.apply(orig as Fn, off, args);
      });
    } else if (fp.canvas === 'off') {
      c = { ...c, canvas: 'block-readback' };
    }

    // ---- audio noise ----
    if (fp.audio === 'noise') {
      const done = new WeakSet<object>();
      method(proto('AudioBuffer'), 'getChannelData', (self, args, orig) => {
        const data = orig(...args) as Float32Array;
        if (!done.has(data)) {
          done.add(data);
          for (let i = 0; i < data.length; i += 97) {
            const h = hash(i, Number(args[0]) | 0);
            data[i] += ((h & 0xffff) / 0xffff - 0.5) * 1e-7;
          }
        }
        void self;
        return data;
      });
      method(proto('AnalyserNode'), 'getFloatFrequencyData', (_self, args, orig) => {
        const r = orig(...args);
        const arr = args[0] as Float32Array;
        if (arr && arr.length) for (let i = 0; i < arr.length; i += 7) arr[i] += ((hash(i, 7) & 0xff) / 0xff - 0.5) * 1e-4;
        return r;
      });
    }

    // ---- client rects / fonts noise (sub-pixel, layout-safe) ----
    if (fp.clientRects === 'noise') {
      const shift = ((hash(1, 2) & 0xffff) / 0xffff - 0.5) * 2e-4;
      const DR = W.DOMRect as typeof DOMRect;
      const adjust = (r: DOMRect) => new DR(r.x + shift, r.y + shift, r.width + shift, r.height + shift);
      for (const P of [proto('Element'), proto('Range')]) {
        method(P, 'getBoundingClientRect', (_s, args, orig) => adjust(orig(...args) as DOMRect));
        method(P, 'getClientRects', (_s, args, orig) => {
          const list = orig(...args) as DOMRectList;
          const arr = Array.from(list, adjust);
          return new Proxy(list, {
            get: (t, k) => (typeof k === 'string' && /^\d+$/.test(k) ? arr[Number(k)] : k === 'item' ? (i: number) => arr[i] ?? null : R.get(t, k, t)),
          });
        });
      }
    }
    if (fp.fonts === 'noise') {
      const TM = proto('TextMetrics');
      const f = 1 + ((hash(3, 4) & 0xffff) / 0xffff - 0.5) * 2e-4;
      getter(TM, 'width', (_s, orig) => Number(orig()) * f);
      getter(TM, 'actualBoundingBoxLeft', (_s, orig) => Number(orig()) * f);
      getter(TM, 'actualBoundingBoxRight', (_s, orig) => Number(orig()) * f);
    }

    // ---- WebRTC ----
    if (fp.webrtcMode === 'off') {
      for (const k of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCSessionDescription', 'RTCIceCandidate']) {
        try { dP(window, k, { value: undefined, writable: true, configurable: true, enumerable: false }); } catch { /* ignore */ }
      }
    } else if ((fp.webrtcMode === 'altered' || fp.webrtcMode === 'manual') && fp.webrtcIp) {
      const ip = fp.webrtcIp;
      const ipv4 = /\b(?!0\.0\.0\.0\b)(?!127\.)(?:\d{1,3}\.){3}\d{1,3}\b/g;
      const mdns = /\b[0-9a-f-]{36}\.local\b/gi;
      const rewrite = (s: unknown) => (typeof s === 'string' ? s.replace(ipv4, ip).replace(mdns, ip) : s);
      getter(proto('RTCIceCandidate'), 'candidate', (_s, orig) => rewrite(orig()));
      getter(proto('RTCIceCandidate'), 'address', (_s, orig) => rewrite(orig()));
      getter(proto('RTCSessionDescription'), 'sdp', (_s, orig) => rewrite(orig()));
      method(proto('RTCIceCandidate'), 'toJSON', (_s, args, orig) => {
        const j = orig(...args) as Record<string, unknown>;
        if (j && typeof j.candidate === 'string') j.candidate = rewrite(j.candidate);
        return j;
      });
      method(proto('RTCSessionDescription'), 'toJSON', (_s, args, orig) => {
        const j = orig(...args) as Record<string, unknown>;
        if (j && typeof j.sdp === 'string') j.sdp = rewrite(j.sdp);
        return j;
      });
    }

    // ---- media devices (counts; labels stay empty until permission like Chrome) ----
    if (fp.mediaDevices) {
      const want = fp.mediaDevices;
      const MD = proto('MediaDevices');
      const MDI = W.MediaDeviceInfo as { prototype: object } | undefined;
      const IDI = (W.InputDeviceInfo as { prototype: object } | undefined) ?? MDI;
      method(MD, 'enumerateDevices', (_s, args, orig) => (orig(...args) as Promise<MediaDeviceInfo[]>).then((real) => {
        const out: MediaDeviceInfo[] = [];
        const make = (kind: MediaDeviceKind, i: number): MediaDeviceInfo => {
          const existing = real.filter((d) => d.kind === kind)[i];
          if (existing) return existing;
          const gid = hash(kind.length, i).toString(16).padStart(8, '0').repeat(8);
          const o = { deviceId: '', kind, label: '', groupId: gid, toJSON() { return { deviceId: '', kind, label: '', groupId: gid }; } };
          const p = kind === 'audiooutput' ? MDI : IDI;
          if (p) Object.setPrototypeOf(o, p.prototype);
          return o as unknown as MediaDeviceInfo;
        };
        for (let i = 0; i < want.audioInputs; i++) out.push(make('audioinput', i));
        for (let i = 0; i < want.videoInputs; i++) out.push(make('videoinput', i));
        for (let i = 0; i < want.audioOutputs; i++) out.push(make('audiooutput', i));
        return out;
      }));
    }
  }

  // ======================================================= STRICT PRESET
  if (c.hw === 'normalize') {
    const Nav = proto('Navigator');
    fixed(Nav, 'hardwareConcurrency', c.hwValues.hardwareConcurrency);
    fixed(Nav, 'deviceMemory', c.hwValues.deviceMemory);
    try { delete (Nav as Record<string, unknown>).getBattery; } catch { /* ignore */ }
    method(Nav, 'getGamepads', (_s, _a, orig) => { orig(); return []; });
  }
  if (c.canvas === 'block-readback') {
    const blankLike = (src: { width: number; height: number }) => Object.assign(document.createElement('canvas'), { width: src.width, height: src.height });
    const HC = proto('HTMLCanvasElement') as { toDataURL: Fn; toBlob: Fn } | undefined;
    if (HC) {
      const nd = gOPD(HC, 'toDataURL')?.value as Fn;
      const nb = gOPD(HC, 'toBlob')?.value as Fn;
      method(HC, 'toDataURL', (self, args) => R.apply(nd, blankLike(self as HTMLCanvasElement), args));
      method(HC, 'toBlob', (self, args) => R.apply(nb, blankLike(self as HTMLCanvasElement), args));
    }
    const blankData = (_s: unknown, args: unknown[]) => new ImageData(Math.max(1, Math.abs(Math.floor(Number(args[2])))) || 1, Math.max(1, Math.abs(Math.floor(Number(args[3])))) || 1);
    method(proto('CanvasRenderingContext2D'), 'getImageData', blankData);
    method(proto('OffscreenCanvasRenderingContext2D'), 'getImageData', blankData);
    method(proto('OffscreenCanvas'), 'convertToBlob', (self, args, orig) => {
      const s = self as OffscreenCanvas;
      return R.apply(orig as Fn, new OffscreenCanvas(s.width, s.height), args);
    });
    for (const G of [proto('WebGLRenderingContext'), proto('WebGL2RenderingContext')]) {
      method(G, 'readPixels', (_s, args) => {
        const view = args.find((a) => ArrayBuffer.isView(a)) as ArrayBufferView | undefined;
        if (view) new Uint8Array(view.buffer, view.byteOffset, view.byteLength).fill(0);
        return undefined;
      });
    }
  }

  // ======================================================= AUDIO MIXER
  const HM = proto('HTMLMediaElement');
  const desc = HM && gOPD(HM, 'volume');
  if (!HM || !desc || !desc.get || !desc.set) return;
  const nativeGet = desc.get;
  const nativeSet = desc.set;
  const pageVolume = new WeakMap<object, number>();
  let factor = Math.min(1, Math.max(0, c.volume));
  let sinkId = c.sinkId;
  const apply = (el: HTMLMediaElement) => {
    if (!pageVolume.has(el)) pageVolume.set(el, nativeGet.call(el) as number);
    nativeSet.call(el, (pageVolume.get(el) as number) * factor);
    const withSink = el as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void>; sinkId?: string };
    if (withSink.setSinkId && withSink.sinkId !== sinkId) withSink.setSinkId(sinkId).catch(() => { /* device gone */ });
  };
  {
    dP(HM, 'volume', {
      ...desc,
      get: hook(nativeGet as Fn, (t, self, a) => (pageVolume.has(self as object) ? pageVolume.get(self as object) : R.apply(t, self, a))),
      set: hook(nativeSet as Fn, (t, self, a) => {
        const n = Number(a[0]);
        if (!(n >= 0 && n <= 1)) return R.apply(t, self, a); // native error behaviour
        pageVolume.set(self as object, n);
        return R.apply(t, self, [n * factor]);
      }),
    });
    document.addEventListener('play', (e) => { if (e.target instanceof HTMLMediaElement) apply(e.target); }, true);
  }
  document.addEventListener(eventName, (e) => {
    const d = (e as CustomEvent<{ f: number; s: string }>).detail;
    if (!d) return;
    factor = Math.min(1, Math.max(0, Number(d.f)));
    sinkId = String(d.s ?? '');
    document.querySelectorAll('audio,video').forEach((el) => apply(el as HTMLMediaElement));
  });
}
