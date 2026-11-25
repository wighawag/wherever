import net from 'node:net';

/**
 * Pick a port for a server this process is about to SPAWN.
 *
 * The obvious implementation -- bind to port 0, read the assigned port, close
 * the socket, then spawn a child that binds it -- has a TOCTOU race: between the
 * close and the child's own bind, the port belongs to nobody, so anything else
 * asking the OS for a port can be handed the SAME one. Under a parallel suite
 * where most files spawn a real server, that happens, and it fails in two
 * different-looking ways that are one bug:
 *
 *  - the loser never binds, and its test reports `server did not become healthy`;
 *  - worse, a test's requests reach ANOTHER test's server, which answers
 *    perfectly well with the wrong ANSWER -- a 401 where a 200 was expected,
 *    because the server that replied was configured with a different token.
 *
 * The second shape is why raising timeouts cannot fix this: nothing is slow, the
 * request simply went somewhere else.
 *
 * So: each test process owns a DISJOINT band of ports and hands out ports only
 * from that band, remembering every port already issued. Within one process the
 * bookkeeping covers the window before a child has bound. The bands sit BELOW
 * the Linux ephemeral range (32768-60999 by default), so the kernel will not
 * hand one of these ports to an unrelated outbound socket either.
 *
 * Owning a band is a cross-PROCESS lock, not arithmetic. An earlier version
 * computed the band from VITEST_POOL_ID, which keeps the workers of ONE vitest
 * run apart but gives two runs on the same machine (two acceptance gates, or a
 * gate and a developer's `pnpm test`) the very same bands: their servers then
 * took each other's ports, and a run failed 6 to 10 real-server tests, a
 * different set each time. Now a process claims a band by keeping the band's
 * first port bound for its whole life (the lock socket); a band whose lock port
 * is taken belongs to someone else, in this run or another, and is skipped. The
 * kernel releases the lock when the process (or worker thread) exits.
 */

const BAND_BASE = 20_000;
const BAND_SIZE = 500;
/**
 * 23 bands: 20000-31499, below the ephemeral range, and clear of the 31500-31899
 * range `unix-socket.test.ts` picks its fixed port from. Room for several runs of
 * 4 workers.
 */
const BAND_COUNT = 23;
const HOST = '127.0.0.1';

// Where to start looking: this worker's slot, so the common case (one run)
// claims its first choice at once. POOL_ID is the concurrent worker slot; WORKER_ID
// is only a fallback for a vitest that does not set it; 1 outside vitest.
const slot = Number(process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? '1') || 1;

interface Band {
  start: number;
  /** Kept open for the life of the process: it IS the claim on the band. */
  lock: net.Server;
}

/** Try to hold `port` open. Resolves the listening server, or null if taken. */
function hold(port: number): Promise<net.Server | null> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(null));
    srv.listen(port, HOST, () => {
      // Never keep the process alive just for the lock.
      srv.unref();
      resolve(srv);
    });
  });
}

// The claim lives on globalThis, not in module state: if a worker ever re-imports
// this module for another test file in the same process or thread, it must reuse
// the band it already holds, not claim (and leak) a new one per file.
const CLAIM = Symbol.for('wherever.test.freePortBand');
type Claimed = typeof globalThis & { [CLAIM]?: Promise<Band> };

/** Claim a band for this process (once), starting at this worker's slot. */
function band(): Promise<Band> {
  const g = globalThis as Claimed;
  g[CLAIM] ??= (async () => {
    for (let i = 0; i < BAND_COUNT; i++) {
      const index = (slot - 1 + i) % BAND_COUNT;
      const start = BAND_BASE + index * BAND_SIZE;
      const lock = await hold(start);
      if (lock) return { start, lock };
    }
    throw new Error(
      `no free port band in ${BAND_BASE}-${BAND_BASE + BAND_COUNT * BAND_SIZE - 1}: ` +
        `all ${BAND_COUNT} are held by other test processes`,
    );
  })();
  // A failed claim (every band held) must not stick: let a later call retry.
  g[CLAIM].catch(() => {
    delete g[CLAIM];
  });
  return g[CLAIM];
}

/** Ports already handed out in THIS process, including ones not yet bound. */
const issued = new Set<number>();
let cursor = 0;

/** Is `port` bindable right now? (A bind test, not a connect probe.) */
async function bindable(port: number): Promise<boolean> {
  const srv = await hold(port);
  if (!srv) return false;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return true;
}

/**
 * A port for a child server to bind. Never returns the same port twice within a
 * process, and never a port another test process (of this run or another) could
 * be using.
 */
export async function freePort(): Promise<number> {
  const { start } = await band();
  // Offset 0 is the lock port itself.
  const usable = BAND_SIZE - 1;
  for (let i = 0; i < usable; i++) {
    const port = start + 1 + ((cursor + i) % usable);
    if (issued.has(port)) continue;
    if (!(await bindable(port))) continue;
    issued.add(port);
    cursor = (cursor + i + 1) % usable;
    return port;
  }
  throw new Error(`no free port in band ${start}-${start + BAND_SIZE - 1} (${issued.size} already issued)`);
}

/**
 * Give a port back after a server has genuinely stopped, so a long file does not
 * exhaust its band. Optional: forgetting to release only costs band space.
 */
export function releasePort(port: number): void {
  issued.delete(port);
}
