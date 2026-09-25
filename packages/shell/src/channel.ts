/**
 * packages/shell/src/channel.ts
 *
 * Private parent<->child channel between the OctoBrowser profile manager and
 * each per-profile browser process: newline-delimited JSON over an inherited,
 * duplex pipe on file descriptor 3 of the child (CHANNEL_FD). Only the two
 * processes hold the pipe handles; nothing is exposed on the network, on the
 * file system, on the command line or in the environment. Used e.g. to hand
 * the child the data key.
 *
 * Why not stdin/stdout: in Electron's main process on Windows process.stdin
 * is replaced by a dummy stream that only returns EOF (electron/electron
 * #21705), so the child would never receive anything. An extra inherited pipe
 * works the same way on Windows and Linux (Node's own IPC uses the mechanism).
 */
import * as net from 'node:net';
import type { Readable, Writable } from 'node:stream';

/** File descriptor of the manager<->profile pipe in the child process. */
export const CHANNEL_FD = 3;

/** stdio configuration for spawn(): fd 3 is the private duplex channel pipe. */
export function channelStdio(devOutput: boolean): ['ignore', 'inherit' | 'ignore', 'inherit' | 'ignore', 'pipe'] {
  const out = devOutput ? 'inherit' : 'ignore';
  return ['ignore', out, out, 'pipe'];
}

/** Child side: open the channel inherited from the manager. Throws if there is none. */
export function openChildChannel(): JsonLineChannel {
  const sock = new net.Socket({ fd: CHANNEL_FD, readable: true, writable: true });
  return new JsonLineChannel(sock, sock);
}

export type Message = { t: string; [k: string]: unknown };

const MAX_LINE = 4 * 1024 * 1024;

export class JsonLineChannel {
  private buf = '';
  private handlers: Array<(m: Message) => void> = [];

  private closeHandlers: Array<() => void> = [];
  private closed = false;

  constructor(private readonly input: Readable, private readonly output: Writable) {
    // A vanished peer (EPIPE/ECONNRESET) must never crash the process.
    input.on('error', () => this.markClosed());
    if (output !== (input as unknown)) output.on('error', () => this.markClosed());
    input.on('end', () => this.markClosed());
    input.on('close', () => this.markClosed());
    input.setEncoding('utf8');
    input.on('data', (chunk: string) => {
      this.buf += chunk;
      if (this.buf.length > MAX_LINE) {
        this.buf = ''; // protocol violation: drop
        return;
      }
      let i: number;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as Message;
          if (msg && typeof msg.t === 'string') for (const h of this.handlers) h(msg);
        } catch {
          /* ignore malformed lines */
        }
      }
    });
  }

  onMessage(fn: (m: Message) => void): void {
    this.handlers.push(fn);
  }

  /** Called once when the peer closed the pipe or it failed. */
  onClose(fn: () => void): void {
    if (this.closed) fn();
    else this.closeHandlers.push(fn);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    for (const h of this.closeHandlers.splice(0)) {
      try { h(); } catch { /* handler errors must not escape */ }
    }
  }

  send(m: Message): void {
    if (this.closed) return;
    try {
      this.output.write(`${JSON.stringify(m)}\n`);
    } catch {
      /* peer gone */
    }
  }
}
