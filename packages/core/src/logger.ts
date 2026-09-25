/**
 * packages/core/src/logger.ts
 *
 * Technical log with two modes:
 *   standard   - errors, warnings, profile start/stop, updates, sandbox state,
 *                add-on problems
 *   diagnostic - additionally debug-level technical details, automatically
 *                switches back to standard after `diagnosticUntil`
 *
 * Every message passes through `redact()` BEFORE it touches the disk, so
 * passwords, tokens, keys, cookies, query strings, form data and e-mail
 * addresses never end up in logs. Page contents are never logged at all.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureDir } from './fsutil';

export type LogMode = 'standard' | 'diagnostic';
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const MAX_FILE_BYTES = 2 * 1024 * 1024; // rotate at 2 MB
const MAX_FILES = 5;

const REDACTIONS: Array<[RegExp, string]> = [
  // Bearer / Basic auth headers (before key=value so the token itself is caught)
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g, '$1 [REDACTED]'],
  // JSON Web Tokens anywhere
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, '[JWT]'],
  // key=value / key: value pairs with sensitive names
  [/\b(pass(word)?|pwd|secret|token|api[_-]?key|access[_-]?key|auth|session(id)?|sid|cookie|set-cookie|authorization|private[_-]?key|master)\b\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;&]+)/gi, '$1=[REDACTED]'],
  // proxy / URL credentials: scheme://user:pass@host
  [/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[REDACTED]@'],
  // query strings and fragments of URLs (may contain tokens / personal data)
  [/(https?:\/\/[^\s?#"']+)[?#][^\s"']*/gi, '$1?[REDACTED]'],
  // e-mail addresses
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[EMAIL]'],
  // long hex strings (keys, hashes of secrets)
  [/\b[0-9a-fA-F]{32,}\b/g, '[HEX]'],
  // long base64 / base64url blobs
  [/\b[A-Za-z0-9+/_-]{40,}={0,2}/g, '[BLOB]'],
  // PEM blocks
  [/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, '[PEM]'],
];

/** Remove secrets and personal data from a log line. */
export function redact(input: string): string {
  let s = input;
  for (const [re, rep] of REDACTIONS) s = s.replace(re, rep);
  // Never allow newlines inside one entry (log-injection protection).
  return s.replace(/[\r\n]+/g, ' ');
}

function safeMeta(meta: unknown): string {
  if (meta === undefined) return '';
  if (meta instanceof Error) return ` | ${meta.name}: ${meta.message}`;
  try {
    return ` | ${JSON.stringify(meta, (k, v) => (/(pass|token|secret|key|cookie|auth)/i.test(k) ? '[REDACTED]' : v))}`;
  } catch {
    return ' | [unserialisable]';
  }
}

export class Logger {
  private mode: LogMode = 'standard';
  private diagnosticUntil = 0;
  private readonly file: string;

  constructor(private readonly dir: string, private readonly name = 'app', private readonly echo = false) {
    ensureDir(dir);
    this.file = path.join(dir, `${name}.log`);
  }

  get logFile(): string {
    return this.file;
  }

  /** Enable diagnostic mode for a limited time (default 24 h). */
  setMode(mode: LogMode, durationMs = 24 * 3600 * 1000): void {
    this.mode = mode;
    this.diagnosticUntil = mode === 'diagnostic' ? Date.now() + durationMs : 0;
    this.info('log.mode', { mode });
  }

  getMode(): LogMode {
    if (this.mode === 'diagnostic' && Date.now() > this.diagnosticUntil) this.mode = 'standard';
    return this.mode;
  }

  error(msg: string, meta?: unknown): void { this.write('error', msg, meta); }
  warn(msg: string, meta?: unknown): void { this.write('warn', msg, meta); }
  info(msg: string, meta?: unknown): void { this.write('info', msg, meta); }
  /** Only written in diagnostic mode. */
  debug(msg: string, meta?: unknown): void {
    if (this.getMode() === 'diagnostic') this.write('debug', msg, meta);
  }

  private write(level: LogLevel, msg: string, meta?: unknown): void {
    const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${redact(msg + safeMeta(meta))}\n`;
    if (this.echo) process.stdout.write(line);
    try {
      this.rotateIfNeeded();
      fs.appendFileSync(this.file, line, { encoding: 'utf8', mode: 0o600 });
    } catch {
      /* logging must never crash the app */
    }
  }

  private rotateIfNeeded(): void {
    let size = 0;
    try { size = fs.statSync(this.file).size; } catch { return; }
    if (size < MAX_FILE_BYTES) return;
    for (let i = MAX_FILES - 1; i >= 1; i--) {
      const from = `${this.file}.${i}`;
      const to = `${this.file}.${i + 1}`;
      if (fs.existsSync(from)) fs.renameSync(from, to);
    }
    fs.renameSync(this.file, `${this.file}.1`);
    fs.rmSync(`${this.file}.${MAX_FILES + 1}`, { force: true });
  }

  /** "Usuń logi" / "Delete logs" button. */
  clear(): number {
    let removed = 0;
    for (const f of fs.readdirSync(this.dir)) {
      if (f.endsWith('.log') || /\.log\.\d+$/.test(f)) {
        fs.rmSync(path.join(this.dir, f), { force: true });
        removed++;
      }
    }
    return removed;
  }
}
