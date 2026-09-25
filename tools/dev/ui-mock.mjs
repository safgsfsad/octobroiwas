// tools/dev/ui-mock.mjs - mocked `window.octo` bridge + UI scenarios for ui-shots.mjs.

/** Runs in the page before any script (serialised by puppeteer). */
export function mockSource(mock) {
  const state = JSON.parse(JSON.stringify(mock.state ?? {}));
  const listeners = {};
  const calls = [];
  window.__mock = { state, calls, emit: (ch, p) => (listeners[ch] ?? []).forEach((cb) => cb(p)) };
  const fns = {};
  for (const [k, src] of Object.entries(mock.handlers ?? {})) fns[k] = new Function('state', 'args', src);
  window.octo = {
    invoke: async (channel, ...args) => {
      calls.push([channel, args]);
      if (fns[channel]) return fns[channel](state, args);
      if (channel in (mock.values ?? {})) return JSON.parse(JSON.stringify(mock.values[channel]));
      return true;
    },
    on: (ch, cb) => { (listeners[ch] ??= []).push(cb); return () => {}; },
  };
}

export function scenarios(core) {
  const dicts = core.DICTS;
  const settings = core.defaultSettings ? core.defaultSettings() : {};
  const profiles = ['personal', 'work', 'private', 'testing', 'temporary', 'tor'].map((k, i) => ({
    ...core.defaultProfile(k, k[0].toUpperCase() + k.slice(1)),
    running: i === 0, ready: i === 0, sealed: false, hasVault: false, needsResealing: false, issues: [], hasProxyCredentials: false,
  }));
  const init = {
    lang: 'pl', dicts, version: '0.1.0', dataDir: 'C:\\Users\\me\\Documents\\OctoSuite\\OctoBrowser', addons: core.ADDONS, kinds: core.PROFILE_KINDS,
    windowsSandbox: true, torBrowser: false, settings, update: { configured: true, current: '0.1.0', latest: null, available: false, rollbackAvailable: [] },
    logMode: 'standard', filtersUpdatedAt: null, keyringMode: 'os', keyringRequiresPassword: false, secretBackend: 'local', credmanAvailable: true,
  };
  const launcherMock = { state: { profiles }, values: { 'mgr:init': init }, handlers: { 'mgr:profiles': 'return state.profiles;' } };
  return [
    { name: 'launcher-profiles', page: 'launcher.html', mock: launcherMock },
  ];
}
