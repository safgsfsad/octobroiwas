/**
 * packages/shell/src/winutil.ts
 *
 * Windows integration helpers. All external programs are started with
 * execFile/spawn and an argument ARRAY (never a shell string) so paths with
 * spaces, Polish characters or quotes cannot inject commands.
 */
import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const SYSTEM32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');

function run(file: string, args: string[], env?: NodeJS.ProcessEnv, timeoutMs = 15000): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: timeoutMs, env: { ...process.env, ...env }, encoding: 'utf8' }, (err, stdout) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException).code === 'number' ? Number((err as NodeJS.ErrnoException).code) : 1) : 0;
      resolve({ code, stdout: String(stdout ?? '') });
    });
  });
}

/**
 * Is the current process elevated (High integrity level)? The browser must
 * never run as administrator. Uses `whoami /groups` and looks for the
 * "High Mandatory Level" SID S-1-16-12288 (or System S-1-16-16384).
 */
export async function isElevated(): Promise<boolean> {
  if (process.platform !== 'win32') return typeof process.getuid === 'function' && process.getuid() === 0;
  const { stdout } = await run(path.join(SYSTEM32, 'whoami.exe'), ['/groups']);
  return /S-1-16-12288|S-1-16-16384/.test(stdout);
}

/**
 * Restart the (packaged) app WITHOUT administrator rights: Explorer runs as the
 * signed-in user at medium integrity, so `explorer.exe <exe>` starts a normal
 * copy. A marker file stops a loop when Explorer itself is elevated (UAC off /
 * built-in Administrator): the second elevated start within 30 s gives up.
 * @returns true when a normal copy was started and this one should exit.
 */
export function relaunchUnelevated(appId: string, exe: string, packaged: boolean): boolean {
  if (process.platform !== 'win32' || !packaged) return false; // dev: electron.exe needs the app path, Explorer cannot pass it
  const marker = path.join(os.tmpdir(), `octo-deelevate-${appId}.txt`);
  try {
    const last = Number(fs.readFileSync(marker, 'utf8'));
    if (Number.isFinite(last) && Date.now() - last < 30_000) return false;
  } catch { /* no marker yet */ }
  try {
    fs.writeFileSync(marker, String(Date.now()));
    const child = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe'), [exe], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** Windows Sandbox is available when WindowsSandbox.exe exists (feature enabled). */
export function windowsSandboxAvailable(): boolean {
  if (process.platform !== 'win32') return false;
  return fs.existsSync(path.join(SYSTEM32, 'WindowsSandbox.exe'));
}

/** Are we running INSIDE Windows Sandbox? (its fixed account name) */
export function runningInsideWindowsSandbox(): boolean {
  return process.platform === 'win32' && os.userInfo().username === 'WDAGUtilityAccount';
}

/** Open a .wsb file with Windows Sandbox. */
export function launchWindowsSandbox(wsbFile: string): void {
  const exe = path.join(SYSTEM32, 'WindowsSandbox.exe');
  const child = spawn(exe, [wsbFile], { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
}

/** Locate the official Tor Browser (default install locations or configured path). */
export function findTorBrowser(configured?: string): string | null {
  const candidates = [
    configured,
    path.join(os.homedir(), 'Desktop', 'Tor Browser', 'Browser', 'firefox.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Tor Browser', 'Browser', 'firefox.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tor Browser', 'Browser', 'firefox.exe'),
  ].filter((p): p is string => !!p);
  for (const c of candidates) {
    if (c && fs.existsSync(c) && path.basename(c).toLowerCase() === 'firefox.exe') return c;
  }
  return null;
}

export interface AuthenticodeResult {
  status: 'Valid' | 'NotSigned' | 'HashMismatch' | 'NotTrusted' | 'UnknownError' | 'Unavailable' | string;
  signer?: string;
}

/**
 * Verify an Authenticode signature with PowerShell's Get-AuthenticodeSignature.
 * The file path is passed through an environment variable, never interpolated
 * into the command string.
 */
export async function verifyAuthenticode(file: string): Promise<AuthenticodeResult> {
  if (process.platform !== 'win32') return { status: 'Unavailable' };
  const ps = path.join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script =
    "$s = Get-AuthenticodeSignature -LiteralPath $env:OCTO_VERIFY_FILE; " +
    "[pscustomobject]@{ status = [string]$s.Status; signer = if ($s.SignerCertificate) { $s.SignerCertificate.Subject } else { '' } } | ConvertTo-Json -Compress";
  const { stdout } = await run(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { OCTO_VERIFY_FILE: file }, 30000);
  try {
    const obj = JSON.parse(stdout.trim()) as { status: string; signer: string };
    return { status: obj.status, signer: obj.signer || undefined };
  } catch {
    return { status: 'UnknownError' };
  }
}

/** Start a detached external program (Tor Browser, Bitwarden, OctoDetect). */
export function launchDetached(exe: string, args: string[] = []): void {
  const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', () => { /* reported by caller via existence check */ });
  child.unref();
}
