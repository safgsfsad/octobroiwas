/**
 * apps/octobrowser/src/main/main.ts - entry point of OctoBrowser.su.
 *
 * The same executable runs in two roles:
 *   (no flag)                 -> profile MANAGER / launcher (single instance)
 *   --profile-process=<id>    -> browser process of one profile (spawned by the manager)
 */
import { app, protocol } from 'electron';
import { Logger, ProfileManager, effectiveSettings, sanitizeProfile, newProfileId } from '@octo/core';
import { argValue, prepareApp } from '@octo/shell/prepare';
import { hardenApp } from '@octo/shell/hardening';
import { setTrustedRoot } from '@octo/shell/ipc';
import { startApp } from '@octo/shell/context';
import { showSplash } from '@octo/shell/windows-ui';
import { Manager } from './manager';
import { runProfileProcess } from './runtime';
import { runCliVerifyIfRequested } from '@octo/shell/cli-verify';

const distDir = __dirname;
setTrustedRoot(distDir);
const profileId = argValue('profile-process');

if (runCliVerifyIfRequested('octobrowser')) {
  // ------------------------------------------ headless release verification (scripts)
  // Nothing else runs: no window, no single-instance lock, no user data access.
} else if (profileId && /^[a-z0-9-]{3,64}$/.test(profileId)) {
  // ---------------------------------------------------- profile process role
  const prep = prepareApp('octobrowser', distDir, {
    engineDirFor: (layout) => layout.profileEngineDir(profileId),
    extraSwitches: (layout) => {
      try {
        const p = new ProfileManager(layout).get(profileId);
        const s = effectiveSettings(p.protection);
        // Enforce the profile's WebRTC policy process-wide as well (defence in depth).
        return [['force-webrtc-ip-handling-policy', s.webrtc]];
      } catch {
        return [];
      }
    },
  });
  if (!prep.state) {
    app.exit(3); // not configured - must be started by the manager
  } else {
    const layout = prep.layout!;
    app.whenReady().then(() => hardenApp(new Logger(layout.logs, 'octobrowser-profiles'))).catch(() => undefined);
    runProfileProcess(distDir, prep.state.dataDir, prep.state.language, profileId);
  }
} else {
  // ---------------------------------------------------------- manager role
  protocol.registerSchemesAsPrivileged([{ scheme: 'octo', privileges: { standard: true, secure: true } }]);
  const prep = prepareApp('octobrowser', distDir);
  if (!app.requestSingleInstanceLock()) {
    app.exit(0);
  } else {
    app.whenReady().then(async () => {
      const splash = prep.state ? showSplash(distDir, 'octobrowser', app.getVersion()) : null;
      const ctx = await startApp(prep);
      if (!ctx) { splash?.destroy(); app.quit(); return; }
      hardenApp(ctx.logger);
      // Windows Sandbox session: create the profile passed by the host and open it directly.
      const sandboxProfile = argValue('sandbox-profile');
      const manager = new Manager(ctx);
      if (prep.ephemeral && sandboxProfile) {
        try {
          const src = sanitizeProfile({ ...JSON.parse(Buffer.from(sandboxProfile, 'base64').toString('utf8')), id: newProfileId() });
          const created = manager.profiles.create({ name: src.name, kind: src.kind, patch: { ...src, sandbox: { ...src.sandbox, mode: 'restricted' } } });
          process.argv.push(`--open-profile=${created.id}`);
        } catch (err) {
          ctx.logger.error('sandbox.profile-invalid', err);
        }
      }
      manager.start();
      setTimeout(() => splash?.destroy(), 400);
    }).catch((err) => {
      console.error(err);
      app.exit(1);
    });
    app.on('window-all-closed', () => { /* manager decides when to quit (profiles may still run) */ });
  }
}

