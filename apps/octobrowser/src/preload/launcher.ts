/**
 * apps/octobrowser/src/preload/launcher.ts
 *
 * Preload of the TRUSTED launcher window (profile manager). Exposes the
 * "mgr:" channel namespace only; the main process re-validates the sender.
 */
import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const EVENTS = new Set(['mgr:profiles', 'mgr:update-status', 'mgr:toast', 'mgr:show-tab']);

contextBridge.exposeInMainWorld('octo', {
  invoke: async (channel: string, ...args: unknown[]) => {
    if (!channel.startsWith('mgr:')) throw new Error('channel not allowed');
    const r = (await ipcRenderer.invoke(channel, ...args)) as Result<unknown>;
    if (!r.ok) throw new Error(r.error);
    return r.value;
  },
  on: (channel: string, cb: (payload: unknown) => void) => {
    if (!EVENTS.has(channel)) throw new Error('event not allowed');
    const listener = (_e: IpcRendererEvent, payload: unknown) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
