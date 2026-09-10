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
 * So: give each vitest worker a DISJOINT band of ports and hand out ports only
 * from that band, remembering every port already issued in this worker. Two
 * workers can then never collide by construction, and within one worker the
 * bookkeeping covers the window before a child has bound. The band sits BELOW
 * the Linux ephemeral range (32768-60999 by default), so the kernel will not
 * hand one of these ports to an unrelated outbound socket either.
 */

const BAND_BASE = 20_000;
const BAND_SIZE = 1_000;

// 1-based under vitest; 1 when a file is run outside a worker (e.g. directly).
const workerId = Number(process.env.VITEST_WORKER_ID ?? '1') || 1;
const bandStart = BAND_BASE + ((workerId - 1) % 12) * BAND_SIZE;

/** Ports already handed out in THIS worker, including ones not yet bound. */
const issued = new Set<number>();
let cursor = 0;

/** Is `port` bindable right now? (A bind test, not a connect probe.) */
function bindable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => {
      srv.close(() => resolve(true));
    });
  });
}

/**
 * A port for a child server to bind. Never returns the same port twice within a
 * worker, and never a port another worker could be using.
 */
export async function freePort(): Promise<number> {
  for (let i = 0; i < BAND_SIZE; i++) {
    const port = bandStart + ((cursor + i) % BAND_SIZE);
    if (issued.has(port)) continue;
    if (!(await bindable(port))) continue;
    issued.add(port);
    cursor = (cursor + i + 1) % BAND_SIZE;
    return port;
  }
  throw new Error(
    `no free port in worker ${workerId}'s band ${bandStart}-${bandStart + BAND_SIZE - 1} ` +
      `(${issued.size} already issued)`,
  );
}

/**
 * Give a port back after a server has genuinely stopped, so a long file does not
 * exhaust its band. Optional: forgetting to release only costs band space.
 */
export function releasePort(port: number): void {
  issued.delete(port);
}
