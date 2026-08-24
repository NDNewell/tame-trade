// src/config/instanceLock.ts
//
// Stops a second instance trading the same account.
//
// Two instances each open their own feeds and each place orders, and neither
// knows what the other is working. A chase started in one cannot be cancelled
// from the other, because the order id it is chasing lives only in the process
// that started it -- so the visible instance reports 'cannot find order ID'
// while orders keep moving.
//
// The lock records a pid rather than relying on cleanup, so an instance that is
// killed leaves a lock that the next start recognises as stale and takes over.
// Nothing has to run at shutdown for recovery to work.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const LOCK_FILE = path.join(os.homedir(), '.tame', 'tame.lock');

export interface LockHolder {
  pid: number;
  startedAt: string;
}

export type LockResult =
  | { acquired: true }
  | { acquired: false; holder: LockHolder };

/** Whether a process is still alive. Signal 0 checks without delivering. */
function isRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to another user, which still counts.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readHolder(): LockHolder | undefined {
  try {
    const holder = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf-8'));
    const pid = Number(holder?.pid);
    if (!Number.isInteger(pid)) return undefined;
    return { pid, startedAt: String(holder?.startedAt ?? 'unknown') };
  } catch {
    // Missing or unreadable is the ordinary first-run case.
    return undefined;
  }
}

export function acquireInstanceLock(): LockResult {
  const holder = readHolder();

  if (holder && holder.pid !== process.pid && isRunning(holder.pid)) {
    return { acquired: false, holder };
  }

  try {
    fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
    fs.writeFileSync(
      LOCK_FILE,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
      'utf-8'
    );
  } catch {
    // A lock that cannot be written must not stop trading. The protection is
    // worth having, but not at the cost of refusing to run.
  }

  return { acquired: true };
}

/** Only ever removes our own lock, never one another instance holds. */
export function releaseInstanceLock(): void {
  const holder = readHolder();
  if (!holder || holder.pid !== process.pid) return;

  try {
    fs.unlinkSync(LOCK_FILE);
  } catch {
    // A stale lock is recognised by liveness on the next start.
  }
}

export function describeLockHolder(holder: LockHolder): string {
  const started = new Date(holder.startedAt);
  const when = Number.isNaN(started.getTime())
    ? holder.startedAt
    : started.toLocaleString();

  return `Tame is already running (pid ${holder.pid}, started ${when}).`;
}

/**
 * Stops the instance holding the lock and waits for it to actually go.
 *
 * SIGTERM first, then SIGKILL if it hasn't gone: the aim is for it to stop, not
 * to be polite about it. Returns false if it is still alive afterwards, so the
 * caller never takes a lock that another running process still holds.
 */
export async function stopHolder(pid: number, timeoutMs = 4000): Promise<boolean> {
  if (!isRunning(pid)) return true;

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return !isRunning(pid);
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isRunning(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone between the check and the signal.
  }

  await new Promise((resolve) => setTimeout(resolve, 250));
  return !isRunning(pid);
}

export const LOCK_FILE_PATH = LOCK_FILE;
