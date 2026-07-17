// The UI's handle on this extension's pty lifecycle — thin wrappers over the
// extension's OWN bus channel (UI ↔ server/index.ts). The wire shapes are the
// server's responders/publishes; output events fan out per ptyId.

import type { Bus } from '../../types';

export interface PtyExit {
  exitCode: number;
  signal?: number;
  error?: string;
}

export interface PtyClient {
  spawn(machine: string, opts: { reservationId?: string | null; cwd?: string; cols: number; rows: number }): Promise<{ ptyId?: string; error?: string }>;
  input(ptyId: string, data: string): Promise<void>;
  resize(ptyId: string, cols: number, rows: number): Promise<void>;
  kill(ptyId: string): Promise<void>;
  onData(ptyId: string, handler: (data: string) => void): () => void;
  onExit(ptyId: string, handler: (e: PtyExit) => void): () => void;
}

export function createPtyClient(bus: Bus): PtyClient {
  return {
    spawn: (machine, opts) => bus.extension.request('pty.spawn', { machine, ...opts }),
    input: (ptyId, data) => bus.extension.request<unknown>('pty.input', { ptyId, data }).then(() => undefined),
    resize: (ptyId, cols, rows) => bus.extension.request<unknown>('pty.resize', { ptyId, cols, rows }).then(() => undefined),
    kill: (ptyId) => bus.extension.request<unknown>('pty.kill', { ptyId }).then(() => undefined),
    onData: (ptyId, handler) => {
      const sub = bus.extension.subscribe('pty.data', (p: any) => { if (p?.ptyId === ptyId) handler(p.data); });
      return () => sub.unsubscribe();
    },
    onExit: (ptyId, handler) => {
      const sub = bus.extension.subscribe('pty.exit', (p: any) => { if (p?.ptyId === ptyId) handler(p); });
      return () => sub.unsubscribe();
    },
  };
}
