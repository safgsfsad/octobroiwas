/**
 * apps/octobrowser/src/main/window.ts
 *
 * One browser window of a profile: a BaseWindow containing
 *   - the chrome UI (WebContentsView, local file, trusted preload), and
 *   - one WebContentsView per tab (web content, sandboxed, untrusted preload).
 * The chrome UI reports the free content rectangle; tabs are positioned
 * into it (two tabs side by side in split view). Panels are docked, so they
 * never overlap web content.
 */
import { BaseWindow, Menu, WebContentsView, WebContents, clipboard, shell } from 'electron';
import * as path from 'node:path';
import { NORMALIZED_HARDWARE } from '@octo/core';
import { trustWebContents } from '@octo/shell/ipc';
import { tabContents } from '@octo/shell/hardening';
import { iconPath, THEME } from '@octo/shell/windows-ui';
import { commandFor, Command } from '../shared/shortcuts';
import type { ProfileRuntime } from './runtime';

export interface Rect { x: number; y: number; width: number; height: number }

export interface TabState {
  id: number;
  title: string;
  url: string;
  favicon: string;
  loading: boolean;
  audible: boolean;
  muted: boolean;
  volume: number;
  pinned: boolean;
  group: string;
  sleeping: boolean;
  blocked: number;
  canBack: boolean;
  canForward: boolean;
  security: 'https' | 'http' | 'internal' | 'other';
  crashed: boolean;
  zoom: number;
  redirectBlocked?: string;
}

const DARK_CSS = `html{filter:invert(.9) hue-rotate(180deg)!important;background:#fff!important}
img,video,picture,canvas,iframe,svg image,[style*="background-image"]{filter:invert(1) hue-rotate(180deg)!important}`;

let nextTabId = 1;

class Tab {
  readonly id = nextTabId++;
  view: WebContentsView | null = null;
  title = '';
  url: string;
  favicon = '';
  loading = false;
  audible = false;
  muted = false;
  volume: number;
  pinned = false;
  group = '';
  blocked = 0;
  crashed = false;
  lastActive = Date.now();
  lastUserInput = 0;
  redirectBlocked?: string;
  darkCssKey?: string;

  constructor(url: string, volume: number) {
    this.url = url;
    this.volume = volume;
  }

  /**
   * Live WebContents of the tab or null. NOTE: once a WebContents is destroyed
   * (page called window.close(), renderer torn down, window closing) Electron
   * returns `undefined` from view.webContents - never dereference it directly.
   */
  get wc(): WebContents | null {
    const wc = this.view?.webContents as WebContents | undefined;
    return wc && !wc.isDestroyed() ? wc : null;
  }

  get sleeping(): boolean {
    return this.view === null;
  }
}

export class BrowserWindowController {
  readonly win: BaseWindow;
  readonly chrome: WebContentsView;
  /** Chrome WebContents id, captured at creation (view.webContents is undefined after destruction). */
  readonly chromeId: number;
  private tabs: Tab[] = [];
  private activeId = 0;
  private splitId = 0;
  private content: Rect = { x: 0, y: 0, width: 0, height: 0 };
  private overlay = false;
  private fullscreenHtml = false;
  /** Set once the user confirmed closing (the close event is intercepted first). */
  private closeConfirmed = false;
  private closedStack: Array<{ url: string; title: string }> = [];
  private sleepTimer: NodeJS.Timeout;

  constructor(private readonly rt: ProfileRuntime, initialUrls: string[]) {
    const p = rt.profile;
    this.win = new BaseWindow({
      width: 1280,
      height: 820,
      minWidth: 720,
      minHeight: 480,
      show: false,
      backgroundColor: THEME.octobrowser.bg,
      title: `${p.name} — OctoBrowser.su`,
      icon: iconPath(rt.distDir),
      autoHideMenuBar: true,
    });
    this.chrome = new WebContentsView({
      webPreferences: {
        preload: path.join(rt.distDir, 'preload-chrome.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        spellcheck: false,
        partition: 'octo-ui', // in-memory UI session, separate from the profile's web session
      },
    });
    this.chromeId = this.chrome.webContents.id;
    this.chrome.setBackgroundColor(THEME.octobrowser.bg);
    trustWebContents(this.chrome.webContents);
    this.win.contentView.addChildView(this.chrome);
    void this.chrome.webContents.loadFile(path.join(rt.distDir, 'renderer', 'browser.html'));
    this.chrome.webContents.once('did-finish-load', () => {
      this.win.show();
      this.pushState();
    });
    this.chrome.webContents.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown') return;
      const cmd = commandFor({ key: input.key, control: input.control, shift: input.shift, alt: input.alt, meta: input.meta });
      if (cmd && cmd !== 'focus-address' && cmd !== 'find') {
        e.preventDefault();
        this.command(cmd);
      }
    });

    // Closing is intercepted: the chrome shows a minimal "closing" overlay first,
    // so the session, cookies and storage can be flushed instead of being cut.
    this.win.on('close', (e) => {
      if (this.closeConfirmed) return;
      if (!rt.settings.load().ui.confirmOnQuit) return; // setting off: close straight away
      if (!this.chromeWc) return; // UI gone: nothing can confirm - close now
      e.preventDefault();
      this.chromeWc.send('ui:close-request', { tabs: this.tabs.length, restoreSession: rt.profile.restoreSession && !rt.profile.deleteOnClose });
    });
    this.win.on('resize', () => this.layoutViews());
    this.win.on('enter-full-screen', () => this.pushState());
    this.win.on('leave-full-screen', () => { this.fullscreenHtml = false; this.pushState(); this.layoutViews(); });
    this.win.on('focus', () => rt.onWindowFocus(this));
    this.win.on('closed', () => {
      clearInterval(this.sleepTimer);
      try { rt.onWindowClosed(this, this.snapshotTabs()); } catch (err) { rt.logger.warn('window.closed-handler', { err: String(err) }); }
      const tabs = this.tabs;
      this.tabs = [];
      for (const t of tabs) this.destroyView(t);
    });

    for (const u of initialUrls.length ? initialUrls : [rt.profile.homePage]) this.newTab(u, { active: true });
    this.layoutViews();
    this.sleepTimer = setInterval(() => this.sleepIdleTabs(), 60_000);
  }

  // ------------------------------------------------------------ tab basics

  /** Chrome UI WebContents, or null once destroyed (window closing). */
  private get chromeWc(): WebContents | null {
    const wc = this.chrome.webContents as WebContents | undefined;
    return wc && !wc.isDestroyed() ? wc : null;
  }

  /** Detach and close a tab's view safely (idempotent, never throws). */
  private destroyView(t: Tab): void {
    const view = t.view;
    if (!view) return;
    const wc = t.wc;
    t.view = null; // first: the 'destroyed' listener must see this as intentional
    try { if (!this.win.isDestroyed()) this.win.contentView.removeChildView(view); } catch { /* already detached */ }
    try { wc?.close(); } catch { /* already gone */ }
  }

  /** A tab's WebContents died on its own (window.close() from the page, etc.). */
  private onTabContentsDestroyed(t: Tab, view: WebContentsView): void {
    if (t.view !== view) return; // intentional close/sleep - already handled
    t.view = null;
    if (this.win.isDestroyed()) return;
    try { this.win.contentView.removeChildView(view); } catch { /* ignore */ }
    if (this.tabs.includes(t)) this.closeTab(t.id);
  }

  private get active(): Tab | undefined {
    return this.tabs.find((t) => t.id === this.activeId);
  }

  private find(id: number): Tab | undefined {
    return this.tabs.find((t) => t.id === id);
  }

  /** WebContents ids of all live tabs (used to route internal-page IPC). */
  ownsTabContents(wcId: number): boolean {
    return this.tabs.some((t) => t.wc?.id === wcId);
  }

  tabByContents(wcId: number): number | undefined {
    return this.tabs.find((t) => t.wc?.id === wcId)?.id;
  }

  private tabConfigArg(t: Tab): string {
    const s = this.rt.controller.privacy;
    const cfg = {
      canvas: s.canvas,
      hw: s.hardwareApis,
      hwValues: { hardwareConcurrency: NORMALIZED_HARDWARE.hardwareConcurrency, deviceMemory: NORMALIZED_HARDWARE.deviceMemory },
      volume: t.volume / 100,
      sinkId: this.rt.profile.audio.outputDeviceId,
    };
    return `--octo-cfg=${Buffer.from(JSON.stringify(cfg)).toString('base64')}`;
  }

  private createView(t: Tab, adopt?: WebContents): void {
    const s = this.rt.controller.privacy;
    const view = adopt ? new WebContentsView({ webContents: adopt } as Electron.WebContentsViewConstructorOptions) : new WebContentsView({
      webPreferences: {
        preload: path.join(this.rt.distDir, 'preload-tab.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: true, // run the privacy preload in iframes too
        webviewTag: false,
        webgl: s.webgl === 'allow',
        plugins: true, // built-in PDF viewer
        spellcheck: false,
        safeDialogs: true,
        autoplayPolicy: s.blockAutoplay ? 'document-user-activation-required' : 'no-user-gesture-required',
        additionalArguments: [this.tabConfigArg(t)],
      },
    });
    view.setBackgroundColor('#ffffff');
    t.view = view;
    const wc = view.webContents;
    const wcId = wc.id;
    tabContents.add(wcId);
    wc.once('destroyed', () => {
      tabContents.delete(wcId);
      // Deferred: Electron is still inside the destroy sequence here.
      setImmediate(() => this.onTabContentsDestroyed(t, view));
    });
    this.rt.onTabCreated?.(wc);
    wc.setWebRTCIPHandlingPolicy(s.webrtc);
    wc.setAudioMuted(t.muted || this.rt.profile.audio.muted);
    this.wireTab(t, wc);
    this.win.contentView.addChildView(view);
  }

  private wireTab(t: Tab, wc: WebContents): void {
    const update = () => this.pushTab(t);
    wc.on('did-start-loading', () => { t.loading = true; update(); });
    wc.on('did-stop-loading', () => { t.loading = false; update(); });
    wc.on('page-title-updated', (_e, title) => { t.title = title; update(); });
    wc.on('page-favicon-updated', (_e, favs) => { t.favicon = favs.find((f) => /^(https:|data:image\/)/.test(f)) ?? ''; update(); });
    wc.on('did-navigate', (_e, url) => {
      t.url = url;
      t.crashed = false;
      t.redirectBlocked = undefined;
      update();
      this.rt.recordHistory(url, t.title);
    });
    wc.on('did-navigate-in-page', (_e, url, isMain) => { if (isMain) { t.url = url; update(); } });
    wc.on('audio-state-changed', (e) => { t.audible = e.audible; update(); });
    wc.on('input-event', (_e, input) => {
      if (input.type === 'mouseDown' || input.type === 'keyDown' || input.type === 'gestureTap') t.lastUserInput = Date.now();
    });
    wc.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown') return;
      t.lastUserInput = Date.now();
      const cmd = commandFor({ key: input.key, control: input.control, shift: input.shift, alt: input.alt, meta: input.meta });
      if (cmd) {
        e.preventDefault();
        this.command(cmd);
      }
    });
    wc.on('dom-ready', () => {
      if (this.rt.profile.addons.includes('dark-pages') && /^https?:/.test(wc.getURL())) {
        void wc.insertCSS(DARK_CSS, { cssOrigin: 'user' }).then((key) => { t.darkCssKey = key; });
      }
      this.sendAudio(t);
    });
    // Block automatic cross-site top-level redirects without user interaction (Strict).
    wc.on('will-navigate', (e) => {
      if (!this.rt.controller.privacy.confirmCrossSiteRedirects) return;
      const from = wc.getURL();
      const to = e.url;
      if (!/^https?:/.test(from) || !/^https?:/.test(to)) return;
      if (Date.now() - t.lastUserInput < 1500) return;
      const site = (u: string) => { try { return new URL(u).hostname.split('.').slice(-2).join('.'); } catch { return u; } };
      if (site(from) !== site(to)) {
        e.preventDefault();
        t.redirectBlocked = to;
        update();
        this.rt.logger.info('redirect.blocked', { profile: this.rt.profile.id });
      }
    });
    wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
      if (!isMain || code === -3 /* ABORTED */) return;
      void wc.loadURL(`octo://error?code=${code}&desc=${encodeURIComponent(desc)}&url=${encodeURIComponent(url)}`);
    });
    wc.on('render-process-gone', () => { t.crashed = true; update(); });
    wc.on('enter-html-full-screen', () => { this.fullscreenHtml = true; this.win.setFullScreen(true); this.pushState(); this.layoutViews(); });
    wc.on('leave-html-full-screen', () => { this.fullscreenHtml = false; this.win.setFullScreen(false); this.pushState(); this.layoutViews(); });
    wc.on('found-in-page', (_e, r) => this.send('ui:found', { active: r.activeMatchOrdinal, total: r.matches }));
    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (!/^(https?|octo):/.test(url)) return { action: 'deny' };
      // Pop-ups become tabs (no opener relationship => less cross-window tracking).
      if (disposition === 'new-window' && this.rt.controller.privacy.blockPopups && Date.now() - t.lastUserInput > 1500) {
        this.rt.logger.info('popup.blocked', { profile: this.rt.profile.id });
        this.send('ui:toast', { key: 'toast.popupBlocked' });
        return { action: 'deny' };
      }
      // Normal / standard profiles: real pop-ups with window.opener, exactly like a
      // regular browser (OAuth "Sign in with Google", 3-D Secure payments, SSO...).
      // Strict / Tor profiles: the pop-up opens as an unrelated tab (no opener).
      const level = this.rt.profile.protection?.level;
      const keepOpener = (level === 'normal' || level === 'standard') && disposition !== 'background-tab' && /^https?:/.test(url);
      if (keepOpener) {
        return {
          action: 'allow',
          createWindow: (options: Electron.BrowserWindowConstructorOptions & { webContents?: WebContents }) => {
            const child = options.webContents;
            if (!child) throw new Error('no child webContents');
            tabContents.add(child.id); // before its first navigation is checked by hardening
            return this.adoptTab(child, url, t.id);
          },
        };
      }
      this.newTab(url, { active: disposition !== 'background-tab', after: t.id });
      return { action: 'deny' };
    });
    wc.on('context-menu', (_e, params) => this.contextMenu(t, params));
  }

  newTab(url: string, opts: { active?: boolean; after?: number; pinned?: boolean; group?: string; sleeping?: boolean; title?: string } = {}): number {
    const t = new Tab(url, this.rt.profile.audio.volume);
    t.pinned = !!opts.pinned;
    t.group = opts.group ?? '';
    t.title = opts.title ?? '';
    const idx = opts.after ? this.tabs.findIndex((x) => x.id === opts.after) + 1 : this.tabs.length;
    this.tabs.splice(idx > 0 ? idx : this.tabs.length, 0, t);
    if (!opts.sleeping) {
      this.createView(t);
      void t.wc?.loadURL(this.rt.normalizeInput(url)).catch(() => undefined);
    }
    if (opts.active !== false) this.activate(t.id);
    else { this.layoutViews(); this.pushState(); }
    return t.id;
  }

  /** Adopt a WebContents created by the page (window.open with opener) as a new active tab. */
  private adoptTab(child: WebContents, url: string, after: number): WebContents {
    const t = new Tab(url, this.rt.profile.audio.volume);
    const idx = this.tabs.findIndex((x) => x.id === after) + 1;
    this.tabs.splice(idx > 0 ? idx : this.tabs.length, 0, t);
    this.createView(t, child);
    this.activate(t.id);
    return child;
  }

  activate(id: number): void {
    const t = this.find(id);
    if (!t) return;
    this.activeId = id;
    t.lastActive = Date.now();
    if (t.sleeping) {
      this.createView(t);
      void t.wc?.loadURL(t.url).catch(() => undefined);
    }
    this.layoutViews();
    this.pushState();
    if (!this.overlay) t.wc?.focus();
  }

  closeTab(id: number): void {
    const i = this.tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    const [t] = this.tabs.splice(i, 1);
    if (/^https?:/.test(t.url)) this.closedStack.push({ url: t.url, title: t.title });
    if (this.closedStack.length > 25) this.closedStack.shift();
    this.destroyView(t);
    if (this.splitId === id) this.splitId = 0;
    if (this.tabs.length === 0) {
      if (!this.win.isDestroyed()) this.win.close();
      return;
    }
    if (this.activeId === id) this.activate(this.tabs[Math.min(i, this.tabs.length - 1)].id);
    else { this.layoutViews(); this.pushState(); }
  }

  private sleepIdleTabs(): void {
    const minutes = this.rt.settings.load().ui.sleepTabsAfterMin;
    if (!minutes) return;
    const limit = Date.now() - minutes * 60_000;
    for (const t of this.tabs) {
      if (t.sleeping || t.id === this.activeId || t.id === this.splitId || t.pinned || t.audible) continue;
      if (t.lastActive < limit) {
        this.destroyView(t);
        this.pushTab(t);
      }
    }
  }

  // ---------------------------------------------------------------- layout

  setLayout(rect: Rect, overlay: boolean): void {
    this.content = rect;
    this.overlay = overlay;
    this.layoutViews();
  }

  private layoutViews(): void {
    if (this.win.isDestroyed()) return;
    const b = this.win.getContentBounds();
    this.chrome.setBounds({ x: 0, y: 0, width: b.width, height: b.height });
    const area: Rect = this.fullscreenHtml ? { x: 0, y: 0, width: b.width, height: b.height } : this.content;
    const hidden = { x: 0, y: 0, width: 0, height: 0 };
    for (const t of this.tabs) {
      if (!t.view) continue;
      let r = hidden;
      if (!this.overlay || this.fullscreenHtml) {
        if (t.id === this.activeId) r = this.splitId && !this.fullscreenHtml ? { ...area, width: Math.floor(area.width / 2) - 2 } : area;
        else if (t.id === this.splitId && !this.fullscreenHtml) {
          const half = Math.floor(area.width / 2);
          r = { x: area.x + half + 2, y: area.y, width: area.width - half - 2, height: area.height };
        }
      }
      t.view.setBounds(r);
      t.view.setVisible(r.width > 0);
    }
  }

  // ----------------------------------------------------------------- state

  private tabState(t: Tab): TabState {
    const wc = t.wc;
    const url = t.url;
    return {
      id: t.id,
      title: t.title || url,
      url,
      favicon: t.favicon,
      loading: t.loading,
      audible: t.audible,
      muted: t.muted,
      volume: t.volume,
      pinned: t.pinned,
      group: t.group,
      sleeping: t.sleeping,
      blocked: t.blocked,
      canBack: !!wc?.navigationHistory.canGoBack(),
      canForward: !!wc?.navigationHistory.canGoForward(),
      security: url.startsWith('https:') ? 'https' : url.startsWith('http:') ? 'http' : url.startsWith('octo:') ? 'internal' : 'other',
      crashed: t.crashed,
      zoom: wc ? Math.round(wc.getZoomFactor() * 100) : 100,
      redirectBlocked: t.redirectBlocked,
    };
  }

  state() {
    const ordered = [...this.tabs.filter((t) => t.pinned), ...this.tabs.filter((t) => !t.pinned)];
    return {
      tabs: ordered.map((t) => this.tabState(t)),
      activeId: this.activeId,
      splitId: this.splitId,
      fullscreen: this.fullscreenHtml,
      closedCount: this.closedStack.length,
    };
  }

  pushState(): void {
    this.chromeWc?.send('ui:state', { ...this.state(), ...this.rt.sharedState() });
  }

  private pushTab(t: Tab): void {
    this.chromeWc?.send('ui:tab', this.tabState(t));
  }

  send(channel: string, payload: unknown): void {
    this.chromeWc?.send(channel, payload);
  }

  countBlocked(wc: WebContents | null): void {
    if (!wc) return;
    const t = this.tabs.find((x) => x.wc?.id === wc.id);
    if (t) {
      t.blocked++;
      if (t.id === this.activeId && t.blocked % 5 === 1) this.pushTab(t);
    }
  }

  /** The chrome asked to close: let the runtime flush and save, then really close. */
  confirmClose(force: boolean): void {
    this.closeConfirmed = true;
    if (force) this.rt.logger.info('window.force-closed', { tabs: this.tabs.length });
    this.win.close();
  }

  snapshotTabs(): Array<{ url: string; title: string; pinned: boolean; group?: string }> {
    return this.tabs.filter((t) => /^(https?|octo):/.test(t.url)).map((t) => ({ url: t.url, title: t.title, pinned: t.pinned, group: t.group || undefined }));
  }

  activeTabContents(): WebContents | null {
    return this.active?.wc ?? null;
  }

  // -------------------------------------------------------------- actions

  navigate(input: string): void {
    const t = this.active;
    if (!t) return;
    const url = this.rt.normalizeInput(input);
    if (t.sleeping) this.createView(t);
    const wc = t.wc;
    if (!wc) return;
    void wc.loadURL(url);
    wc.focus();
  }

  tabAction(id: number, action: string, arg?: unknown): void {
    const t = this.find(id);
    if (!t) return;
    const wc = t.wc;
    switch (action) {
      case 'activate': this.activate(id); break;
      case 'close': this.closeTab(id); break;
      case 'pin': t.pinned = !t.pinned; this.pushState(); break;
      case 'mute':
        t.muted = !t.muted;
        wc?.setAudioMuted(t.muted || this.rt.profile.audio.muted);
        this.pushTab(t);
        break;
      case 'volume':
        t.volume = Math.max(0, Math.min(100, Math.round(Number(arg) || 0)));
        this.sendAudio(t);
        this.pushTab(t);
        break;
      case 'group': t.group = String(arg ?? '').slice(0, 32); this.pushState(); break;
      case 'duplicate': this.newTab(t.url, { after: t.id }); break;
      case 'reload': wc?.reload(); break;
      case 'sleep':
        if (id !== this.activeId && t.view) {
          this.destroyView(t);
          this.pushState();
        }
        break;
      case 'split': this.splitId = this.splitId === id || id === this.activeId ? 0 : id; if (this.find(this.splitId)?.sleeping) this.activate(this.activeId); this.layoutViews(); this.pushState(); break;
      case 'allow-redirect':
        if (t.redirectBlocked && wc) { const to = t.redirectBlocked; t.redirectBlocked = undefined; t.lastUserInput = Date.now(); void wc.loadURL(to); }
        break;
      case 'dismiss-redirect': t.redirectBlocked = undefined; this.pushTab(t); break;
      case 'move': {
        const to = Math.max(0, Math.min(this.tabs.length - 1, Number(arg)));
        const from = this.tabs.indexOf(t);
        this.tabs.splice(from, 1);
        this.tabs.splice(to, 0, t);
        this.pushState();
        break;
      }
      default: break;
    }
  }

  private sendAudio(t: Tab): void {
    t.wc?.send('octo:audio', t.volume / 100, this.rt.profile.audio.outputDeviceId);
  }

  /** Re-apply profile-level audio (mute all / output device). */
  applyProfileAudio(): void {
    for (const t of this.tabs) {
      t.wc?.setAudioMuted(t.muted || this.rt.profile.audio.muted);
      this.sendAudio(t);
    }
    this.pushState();
  }

  command(cmd: Command): void {
    const t = this.active;
    const wc = t?.wc;
    if (cmd.startsWith('tab-')) {
      const n = Number(cmd.slice(4));
      const list = this.state().tabs;
      const target = n === 9 ? list[list.length - 1] : list[n - 1];
      if (target) this.activate(target.id);
      return;
    }
    switch (cmd) {
      case 'new-tab': this.newTab(this.rt.profile.homePage); this.send('ui:focus-address', null); break;
      case 'close-tab': if (t) this.closeTab(t.id); break;
      case 'reopen-tab': { const c = this.closedStack.pop(); if (c) this.newTab(c.url); break; }
      case 'next-tab': case 'prev-tab': {
        const list = this.state().tabs;
        const i = list.findIndex((x) => x.id === this.activeId);
        const next = list[(i + (cmd === 'next-tab' ? 1 : -1) + list.length) % list.length];
        if (next) this.activate(next.id);
        break;
      }
      case 'reload': wc?.reload(); break;
      case 'stop': wc?.stop(); break;
      case 'hard-reload': wc?.reloadIgnoringCache(); break;
      case 'back': if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); break;
      case 'forward': if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); break;
      case 'fullscreen': this.win.setFullScreen(!this.win.isFullScreen()); break;
      case 'mute-tab': if (t) this.tabAction(t.id, 'mute'); break;
      case 'mute-profile': this.rt.toggleProfileMute(); break;
      case 'volume-up': case 'volume-down': if (t) this.tabAction(t.id, 'volume', t.volume + (cmd === 'volume-up' ? 10 : -10)); break;
      case 'split': if (t) { const other = this.tabs.find((x) => x.id !== t.id && !x.sleeping) ?? this.tabs.find((x) => x.id !== t.id); if (other) this.tabAction(other.id, 'split'); } break;
      case 'pip':
        void wc?.executeJavaScript(`(() => { const v = [...document.querySelectorAll('video')].sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0]; if (!v) return false; if (document.pictureInPictureElement) { document.exitPictureInPicture(); } else { v.requestPictureInPicture(); } return true; })()`, true).catch(() => undefined);
        break;
      case 'zoom-in': if (wc) { wc.setZoomFactor(Math.min(3, wc.getZoomFactor() + 0.1)); this.pushTab(t!); } break;
      case 'zoom-out': if (wc) { wc.setZoomFactor(Math.max(0.3, wc.getZoomFactor() - 0.1)); this.pushTab(t!); } break;
      case 'zoom-reset': if (wc) { wc.setZoomFactor(1); this.pushTab(t!); } break;
      case 'devtools': wc?.toggleDevTools(); break;
      case 'print': wc?.print(); break;
      case 'bookmark': if (t) this.rt.addBookmark(t.url, t.title); this.send('ui:toast', { key: 'toast.bookmarked' }); break;
      case 'switch-profile': this.rt.openLauncher(); break;
      default: this.send('ui:command', cmd); // panels, find, focus-address, search-tabs: handled by the UI
    }
  }

  find_(text: string, opts: { forward?: boolean; findNext?: boolean } = {}): void {
    const wc = this.active?.wc;
    if (!wc) return;
    if (!text) wc.stopFindInPage('clearSelection');
    else wc.findInPage(text, { forward: opts.forward ?? true, findNext: opts.findNext ?? false });
  }

  private contextMenu(t: Tab, p: Electron.ContextMenuParams): void {
    const T = (k: string) => this.rt.t(k);
    const wc = t.wc;
    if (!wc) return;
    const items: Electron.MenuItemConstructorOptions[] = [];
    if (p.linkURL && /^https?:/.test(p.linkURL)) {
      items.push({ label: T('ctx.openLinkNewTab'), click: () => this.newTab(p.linkURL, { active: false, after: t.id }) });
      items.push({ label: T('ctx.copyLink'), click: () => clipboard.writeText(p.linkURL) });
      items.push({ type: 'separator' });
    }
    if (p.hasImageContents && /^https?:/.test(p.srcURL)) {
      items.push({ label: T('ctx.openImageNewTab'), click: () => this.newTab(p.srcURL, { active: false, after: t.id }) });
      items.push({ label: T('ctx.saveImage'), click: () => wc.downloadURL(p.srcURL) });
      items.push({ type: 'separator' });
    }
    if (p.selectionText) {
      items.push({ label: T('ctx.copy'), role: 'copy' });
      items.push({ label: T('ctx.searchSelection'), click: () => this.newTab(p.selectionText.slice(0, 200), { after: t.id }) });
    }
    if (p.isEditable) {
      items.push({ label: T('ctx.cut'), role: 'cut' }, { label: T('ctx.paste'), role: 'paste', enabled: this.rt.profile.sandbox.clipboard === 'allow' });
    }
    if (items.length) items.push({ type: 'separator' });
    items.push(
      { label: T('ctx.back'), enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
      { label: T('ctx.forward'), enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
      { label: T('ctx.reload'), click: () => wc.reload() },
      { label: T('ctx.pip'), click: () => this.command('pip') },
      { type: 'separator' },
      { label: T('ctx.inspect'), click: () => wc.inspectElement(p.x, p.y) },
    );
    if (/^https?:/.test(t.url)) items.push({ label: T('ctx.openExternal'), click: () => void shell.openExternal(t.url) });
    Menu.buildFromTemplate(items).popup();
  }

  focus(): void {
    if (this.win.isMinimized()) this.win.restore();
    this.win.focus();
  }

  close(): void {
    if (!this.win.isDestroyed()) this.win.close();
  }
}
