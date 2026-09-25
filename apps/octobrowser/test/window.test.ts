/**
 * apps/octobrowser/test/window.test.ts
 *
 * Regression tests for the reported crashes in the profile window:
 *   1) "Cannot read properties of undefined (reading 'isDestroyed') at get wc"
 *      - a tab whose WebContents died (page called window.close(), e.g. an
 *        OAuth pop-up) stayed in the tab list and crashed every state push;
 *   2) "Cannot read properties of undefined (reading 'close') at BaseWindow"
 *      - closing the window dereferenced view.webContents of dead tabs.
 * Plus: real pop-ups with window.opener on normal/standard profiles and
 * closing a profile without the confirmation overlay.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => await import('./fake-electron'));

import { defaultProfile, effectiveSettings, Profile } from '@octo/core';
import { tabContents } from '@octo/shell/hardening';
import { BaseWindow, FakeWebContents } from './fake-electron';
import { BrowserWindowController } from '../src/main/window';

const flush = () => new Promise((r) => setImmediate(r));

function makeRt(level: 'normal' | 'standard' | 'strict' = 'normal', confirmOnQuit = true) {
  const profile: Profile = { ...defaultProfile('antidetect', 'P1'), protection: { level } } as Profile;
  return {
    profile,
    distDir: '/dist',
    settings: { load: () => ({ ui: { confirmOnQuit, sleepTabsAfterMin: 0 } }) },
    controller: { privacy: effectiveSettings(profile.protection) },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    onWindowClosed: vi.fn(),
    onWindowFocus: vi.fn(),
    onTabCreated: vi.fn(),
    sharedState: () => ({}),
    normalizeInput: (u: string) => u,
    recordHistory: vi.fn(),
    t: (k: string) => k,
    addBookmark: vi.fn(),
    openLauncher: vi.fn(),
    toggleProfileMute: vi.fn(),
  };
}

type TabLike = { id: number; wc: FakeWebContents | null; view: unknown };
type Ctl = Omit<BrowserWindowController, never> & { tabs: TabLike[] };

function open(rt: ReturnType<typeof makeRt>, urls = ['https://a.example/']): Ctl {
  const w = new BrowserWindowController(rt as never, urls);
  // Expose the private tab list for assertions.
  return new Proxy(w, {
    get: (target, prop) => (prop === 'tabs' ? (target as unknown as { tabs: TabLike[] }).tabs : Reflect.get(target, prop, target)),
  }) as unknown as Ctl;
}

describe('BrowserWindowController crash fixes', () => {
  beforeEach(() => { BaseWindow.all.length = 0; });

  it('page calling window.close() removes the tab instead of crashing (s1)', async () => {
    const rt = makeRt();
    const w = open(rt, ['https://a.example/', 'https://b.example/']);
    expect(w.state().tabs).toHaveLength(2);
    const dead = w.tabs[1].wc!;
    dead.destroy(); // what window.close() in the page does
    expect(() => w.pushState()).not.toThrow(); // state push right after death
    await flush();
    expect(w.state().tabs).toHaveLength(1);
    expect(tabContents.has(dead.id)).toBe(false);
    expect(() => w.newTab('https://c.example/')).not.toThrow();
    expect(w.state().tabs).toHaveLength(2);
  });

  it('closing the window with dead tabs does not throw (s2)', async () => {
    const rt = makeRt('normal', false);
    const w = open(rt, ['https://a.example/', 'https://b.example/']);
    w.tabs[0].wc!.destroy();
    const win = BaseWindow.all[0];
    expect(() => win.close()).not.toThrow();
    await flush();
    expect(rt.onWindowClosed).toHaveBeenCalledTimes(1);
  });

  it('last tab closing itself closes the window cleanly', async () => {
    const rt = makeRt('normal', false);
    const w = open(rt);
    w.tabs[0].wc!.destroy();
    await flush();
    expect(BaseWindow.all[0].destroyed).toBe(true);
    expect(rt.onWindowClosed).toHaveBeenCalledTimes(1);
  });

  it('normal profile: pop-ups keep window.opener (OAuth / payments) and become tabs', () => {
    const rt = makeRt('normal');
    const w = open(rt);
    const opener = w.tabs[0].wc!;
    opener.emit('input-event', {}, { type: 'mouseDown' }); // user clicked "Sign in with..."
    const res = opener.openHandler!({ url: 'https://accounts.example/o/oauth2', disposition: 'new-window' }) as { action: string; createWindow: (o: unknown) => unknown };
    expect(res.action).toBe('allow');
    const child = new FakeWebContents();
    expect(res.createWindow({ webContents: child })).toBe(child);
    expect(tabContents.has(child.id)).toBe(true);
    const st = w.state();
    expect(st.tabs).toHaveLength(2);
    expect(st.activeId).toBe(st.tabs[1].id);
    expect(rt.onTabCreated).toHaveBeenCalledWith(child);
  });

  it('OAuth pop-up closing itself after login returns to the opener tab', async () => {
    const rt = makeRt('normal');
    const w = open(rt);
    const opener = w.tabs[0].wc!;
    opener.emit('input-event', {}, { type: 'mouseDown' });
    const res = opener.openHandler!({ url: 'https://accounts.example/', disposition: 'new-window' }) as { createWindow: (o: unknown) => unknown };
    const child = new FakeWebContents();
    res.createWindow({ webContents: child });
    child.destroy();
    await flush();
    const st = w.state();
    expect(st.tabs).toHaveLength(1);
    expect(st.activeId).toBe(st.tabs[0].id);
  });

  it('pop-ups without a user click are blocked like in Chrome', () => {
    const rt = makeRt('normal');
    const w = open(rt);
    const res = w.tabs[0].wc!.openHandler!({ url: 'https://ads.example/', disposition: 'new-window' }) as { action: string };
    expect(res.action).toBe('deny');
    expect(w.state().tabs).toHaveLength(1);
  });

  it('strict profile: pop-up opens as an unrelated tab (no opener)', () => {
    const rt = makeRt('strict');
    const w = open(rt);
    w.tabs[0].wc!.emit('input-event', {}, { type: 'mouseDown' });
    const res = w.tabs[0].wc!.openHandler!({ url: 'https://x.example/', disposition: 'foreground-tab' }) as { action: string };
    expect(res.action).toBe('deny');
    expect(w.state().tabs).toHaveLength(2);
  });

  it('confirmClose bypasses the confirmation overlay (closing from the launcher)', () => {
    const rt = makeRt('normal', true);
    open(rt);
    const win = BaseWindow.all[0];
    win.close();
    expect(win.destroyed).toBe(false); // overlay shown, close intercepted
    const w = open(rt);
    w.confirmClose(false);
    expect(BaseWindow.all[1].destroyed).toBe(true);
  });

  it('tab actions on dead / sleeping tabs are safe', async () => {
    const rt = makeRt('normal', false);
    const w = open(rt, ['https://a.example/', 'https://b.example/', 'https://c.example/']);
    const [t0, t1, t2] = w.tabs;
    w.tabAction(t1.id, 'sleep');
    expect(w.state().tabs.find((x: { id: number; sleeping: boolean }) => x.id === t1.id)?.sleeping).toBe(true);
    t2.wc!.destroy();
    for (const a of ['reload', 'mute', 'volume', 'duplicate', 'close']) expect(() => w.tabAction(t2.id, a, 50)).not.toThrow();
    w.activate(t1.id); // wakes the sleeping tab
    expect(w.tabs.find((x: TabLike) => x.id === t1.id)?.wc).toBeTruthy();
    expect(() => w.command('reload')).not.toThrow();
    expect(() => w.closeTab(t0.id)).not.toThrow();
    await flush();
  });
});
