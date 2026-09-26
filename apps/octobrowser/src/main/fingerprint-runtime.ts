/**
 * apps/octobrowser/src/main/fingerprint-runtime.ts
 *
 * Applies a resolved antidetect fingerprint to a running profile:
 *   - pageConfigFingerprint(): values for the main-world page shim (preload);
 *   - fingerprintHeaders():     Sec-CH-UA* / DNT / protected ports for webRequest;
 *   - FingerprintEmulator:      Chrome DevTools Protocol overrides per tab
 *     (UA + UA-CH metadata, timezone, locale, geolocation, CPU cores) that the
 *     JS shim cannot do reliably (Intl/Date time zone, workers, OOPIF iframes).
 *     Workers and out-of-process iframes are covered through Target.setAutoAttach.
 *
 * Every CDP failure is logged and ignored: a site must never break because
 * an override could not be applied.
 */
import type { WebContents } from 'electron';
import { createHash } from 'node:crypto';
import { ResolvedFingerprint, secChUa } from '@octo/core';
import type { PageFingerprint } from '../preload/page-shim';
import type { FingerprintHeaders } from '@octo/shell/session-privacy';

interface Log { info(ev: string, data?: unknown): void; warn(ev: string, data?: unknown): void }

/** 32-bit number from the profile's seed string (stable). */
export function seedNumber(seed: string): number {
  return createHash('sha256').update(`octo-fp:${seed}`).digest().readUInt32LE(0);
}

export function pageConfigFingerprint(r: ResolvedFingerprint): PageFingerprint | null {
  if (!r.enabled) return null;
  return {
    platform: r.platform,
    brands: r.brands,
    fullVersionList: r.fullVersionList,
    uaFullVersion: r.uaFullVersion,
    chPlatform: r.chPlatform,
    platformVersion: r.platformVersion,
    architecture: r.architecture,
    bitness: r.bitness,
    languages: r.languages,
    cores: r.cores,
    memory: r.memory,
    screen: r.screen,
    webglVendor: r.webglVendor,
    webglRenderer: r.webglRenderer,
    canvas: r.canvas,
    webgl: r.webgl,
    audio: r.audio,
    clientRects: r.clientRects,
    fonts: r.fonts,
    webgpu: r.webgpu,
    webrtcMode: r.webrtcMode,
    webrtcIp: r.webrtcIp,
    mediaDevices: r.mediaDevices,
    doNotTrack: r.doNotTrack,
    seed: seedNumber(r.seed),
  };
}

const q = (v: string) => `"${v}"`;

export function fingerprintHeaders(r: ResolvedFingerprint): FingerprintHeaders | null {
  if (!r.enabled) return null;
  return {
    clientHints: {
      'sec-ch-ua': secChUa(r.brands),
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': q(r.chPlatform),
      'sec-ch-ua-platform-version': q(r.platformVersion),
      'sec-ch-ua-full-version': q(r.uaFullVersion),
      'sec-ch-ua-full-version-list': secChUa(r.fullVersionList),
      'sec-ch-ua-arch': q(r.architecture),
      'sec-ch-ua-bitness': q(r.bitness),
      'sec-ch-ua-model': '""',
      'sec-ch-ua-wow64': '?0',
      'sec-ch-ua-form-factors': '"Desktop"',
    },
    doNotTrack: r.doNotTrack,
    protectedPorts: r.protectedPorts,
  };
}

/** CDP commands applied to every page / worker / OOPIF target. */
export function emulationCommands(r: ResolvedFingerprint): Array<[string, Record<string, unknown>]> {
  if (!r.enabled) return [];
  const cmds: Array<[string, Record<string, unknown>]> = [[
    'Emulation.setUserAgentOverride',
    {
      userAgent: r.userAgent,
      // Plain list: Chromium adds the q-weights itself.
      ...(r.languages?.length ? { acceptLanguage: r.languages.join(',') } : {}),
      platform: r.platform,
      userAgentMetadata: {
        brands: r.brands,
        fullVersionList: r.fullVersionList,
        fullVersion: r.uaFullVersion,
        platform: r.chPlatform,
        platformVersion: r.platformVersion,
        architecture: r.architecture,
        model: '',
        mobile: false,
        bitness: r.bitness,
        wow64: false,
        formFactors: ['Desktop'],
      },
    },
  ]];
  if (r.timezone) cmds.push(['Emulation.setTimezoneOverride', { timezoneId: r.timezone }]);
  if (r.languages?.length) cmds.push(['Emulation.setLocaleOverride', { locale: r.languages[0] }]);
  if (r.geolocation) cmds.push(['Emulation.setGeolocationOverride', { ...r.geolocation }]);
  if (r.cores) cmds.push(['Emulation.setHardwareConcurrencyOverride', { hardwareConcurrency: r.cores }]);
  return cmds;
}

/**
 * Script evaluated in a dedicated/shared worker while it is still paused
 * (waitForDebuggerOnStart), before any page code: WorkerNavigator values that
 * CDP does not cover. Same Proxy-based masking as the page shim.
 */
export function workerPatchSource(r: ResolvedFingerprint): string {
  const values: Record<string, unknown> = { platform: r.platform };
  if (r.cores) values.hardwareConcurrency = r.cores;
  if (r.memory) values.deviceMemory = r.memory;
  if (r.languages?.length) { values.languages = r.languages; values.language = r.languages[0]; }
  return `(() => {
  const V = ${JSON.stringify(values)};
  const P = typeof WorkerNavigator !== 'undefined' ? WorkerNavigator.prototype : null;
  if (!P) return;
  const names = new WeakMap();
  const nts = Function.prototype.toString;
  const ts = new Proxy(nts, { apply(t, s, a) { const n = s && names.get(s); return n !== undefined ? 'function ' + n + '() { [native code] }' : Reflect.apply(t, s, a); } });
  names.set(ts, 'toString');
  Object.defineProperty(Function.prototype, 'toString', { ...Object.getOwnPropertyDescriptor(Function.prototype, 'toString'), value: ts });
  if (Array.isArray(V.languages)) Object.freeze(V.languages);
  for (const k of Object.keys(V)) {
    const d = Object.getOwnPropertyDescriptor(P, k);
    if (!d || !d.get) continue;
    const g = new Proxy(d.get, { apply(t, s, a) { Reflect.apply(t, s, a); return V[k]; } });
    names.set(g, d.get.name);
    Object.defineProperty(P, k, { ...d, get: g });
  }
})();`;
}

const WORKER_COMMANDS = new Set(['Emulation.setUserAgentOverride', 'Emulation.setTimezoneOverride', 'Emulation.setHardwareConcurrencyOverride']);

const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };

export class FingerprintEmulator {
  private readonly cmds: Array<[string, Record<string, unknown>]>;
  private readonly workerPatch: string;

  constructor(private readonly fp: ResolvedFingerprint, private readonly log: Log) {
    this.cmds = emulationCommands(fp);
    this.workerPatch = workerPatchSource(fp);
  }

  get active(): boolean {
    return this.cmds.length > 0;
  }

  /** Attach to a tab. Safe to call for every tab; no-op when the fingerprint is off. */
  attach(wc: WebContents): void {
    if (!this.active || wc.isDestroyed()) return;
    const dbg = wc.debugger;
    try {
      if (!dbg.isAttached()) dbg.attach('1.3');
    } catch (err) {
      this.log.warn('fingerprint.cdp-attach-failed', { err: String(err) });
      return;
    }
    const send = (method: string, params: Record<string, unknown>, sessionId?: string) =>
      dbg.sendCommand(method, params, sessionId).catch((err: unknown) => {
        this.log.warn('fingerprint.cdp-command-failed', { method, err: String(err) });
      });
    const applyAll = async (sessionId?: string, type = 'page') => {
      const isWorker = type !== 'page' && type !== 'iframe';
      for (const [m, p] of this.cmds) {
        // Workers: locale is inherited, geolocation does not exist there.
        if (isWorker && !WORKER_COMMANDS.has(m)) continue;
        await send(m, p, sessionId);
      }
      if (isWorker && type !== 'service_worker') await send('Runtime.evaluate', { expression: this.workerPatch, silent: true }, sessionId);
    };
    dbg.on('message', (_e, method, params, sessionId) => {
      if (method !== 'Target.attachedToTarget') return;
      const child = (params as { sessionId: string; targetInfo: { type: string }; waitingForDebugger: boolean });
      const type = child.targetInfo?.type ?? '';
      void (async () => {
        try {
          if (type === 'iframe' || type === 'page') await send('Target.setAutoAttach', AUTO_ATTACH, child.sessionId);
          if (['page', 'iframe', 'worker', 'shared_worker', 'service_worker'].includes(type)) await applyAll(child.sessionId, type);
        } finally {
          // Never leave a target paused - that would hang the site.
          if (child.waitingForDebugger) await send('Runtime.runIfWaitingForDebugger', {}, child.sessionId);
        }
      })();
      void sessionId;
    });
    dbg.on('detach', (_e, reason) => this.log.info('fingerprint.cdp-detached', { reason }));
    void (async () => {
      await applyAll();
      await send('Target.setAutoAttach', AUTO_ATTACH);
    })();
  }
}
