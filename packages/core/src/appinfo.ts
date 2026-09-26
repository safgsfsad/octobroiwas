/**
 * packages/core/src/appinfo.ts
 *
 * Static identity of both applications in OctoSuite. Both apps are separate
 * programs: separate executables, AppUserModelIDs, data folders, icons and
 * update channels. Nothing here is secret.
 */

export type AppId = 'octobrowser' | 'octodetect';

export interface AppInfo {
  /** Internal id, also used for file names. */
  id: AppId;
  /** Full product name shown to the user. */
  productName: string;
  /** Short logo text. */
  shortName: string;
  /** Windows AppUserModelID (taskbar grouping, notifications). */
  appUserModelId: string;
  /** Sub-folder created inside the user-selected base data folder. */
  dataSubdir: string;
  /** Folder name in %APPDATA% that holds ONLY bootstrap.json (language + data folder path). */
  bootstrapDirName: string;
  /** Name of the sibling application (used to pre-fill the first-run wizard). */
  sibling: AppId;
}

export const APPS: Record<AppId, AppInfo> = {
  octobrowser: {
    id: 'octobrowser',
    productName: 'OctoBrowser.su',
    shortName: 'OB.su',
    appUserModelId: 'su.octo.browser',
    dataSubdir: 'OctoBrowser',
    bootstrapDirName: 'OctoBrowser.su',
    sibling: 'octodetect',
  },
  octodetect: {
    id: 'octodetect',
    productName: 'OctoDetect.su',
    shortName: 'OD.su',
    appUserModelId: 'su.octo.detect',
    dataSubdir: 'OctoDetect',
    bootstrapDirName: 'OctoDetect.su',
    sibling: 'octobrowser',
  },
};

/** Version is injected at build time by tools/build.mjs (esbuild `define`). */
declare const __OCTO_VERSION__: string | undefined;
export const SUITE_VERSION: string =
  typeof __OCTO_VERSION__ !== 'undefined' ? __OCTO_VERSION__ : '0.1.0';

/** Official update source. Updates are NEVER downloaded from mirrors. */
export const OFFICIAL_REPO = 'chargehuobey/lvocto';
export const OFFICIAL_RELEASES_BASE = `https://github.com/${OFFICIAL_REPO}/releases`;
