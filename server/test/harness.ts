import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { startFakeLlmServer, type FakeLlmServer, type FakeBehavior } from './fake-llm-server.js';
import { freePort } from './free-port.js';

// The deterministic test substrate (ADR 0001): boot the REAL wherever server
// against a FAKE LLM in full isolation, on an ephemeral port. Parallel-safe (each
// harness picks its own free port + throwaway dirs), so N runs never collide.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(__dirname, '..');
const serverEntry =
  process.env.WHEREVER_SERVER_ENTRY ?? path.resolve(serverDir, 'src/index.ts');

// Run tsx DIRECTLY rather than via `pnpm exec tsx`. The pnpm indirection put two
// extra processes between us and the server (pnpm -> tsx/cli.mjs -> node), and
// pnpm does not forward SIGTERM to its grandchildren: killing it left the real
// server running, reparented to init. Calling the binary directly means the pid
// we hold IS the process we need to kill.
const tsxBin = process.env.WHEREVER_TSX_BIN ?? path.resolve(serverDir, 'node_modules/.bin/tsx');

// Every live harness server, so a crashing/interrupted test run cannot leak one.
// cleanup() is the normal path; these hooks are the backstop for the abnormal one
// (an uncaught throw in a test file, or the runner killing the worker), where
// cleanup() never runs and the server would otherwise outlive the whole suite.
const liveServers = new Set<number>();
let exitHooksInstalled = false;

function killGroup(pid: number, sig: NodeJS.Signals): void {
  // Negative pid targets the whole process group (the child is detached, so it
  // leads its own group and pgid === pid). Falls back to the bare pid if the
  // group is already gone.
  try {
    process.kill(-pid, sig);
  } catch {
    try {
      process.kill(pid, sig);
    } catch {}
  }
}

function installExitHooks(): void {
  if (exitHooksInstalled) return;
  exitHooksInstalled = true;
  const reap = () => {
    for (const pid of liveServers) killGroup(pid, 'SIGKILL');
    liveServers.clear();
  };
  process.on('exit', reap);
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      reap();
      process.kill(process.pid, sig);
    });
  }
}

export interface HarnessOptions {
  initial?: FakeBehavior;
  /** Server idle-eviction timeout in ms (PI_IDLE_TIMEOUT). Default: server default. */
  idleTimeoutMs?: number;
  /** Extra env for the server process. */
  env?: Record<string, string>;
}

export interface Harness {
  port: number;
  fake: FakeLlmServer;
  /** The isolated workspace cwd sessions are created in. */
  workspace: string;
  /** The isolated PI_CODING_AGENT_DIR (sessions land under here). */
  agentDir: string;
  setNext(b: FakeBehavior): void;
  /** Open a WS client and wait for the socket to open. `clientKey` is the stable
   *  per-viewer identity the server uses to retire a superseded connection. */
  connect(clientKey?: string): Promise<TestClient>;
  cleanup(): Promise<void>;
}

/**
 * Boot the REAL wherever server against a FAKE LLM, in full isolation:
 *  - a throwaway PI_CODING_AGENT_DIR with a models.json whose only provider
 *    points at the fake LLM server (api: anthropic-messages);
 *  - a throwaway workspace cwd;
 *  - HTTP (no SSL), ephemeral port, no token.
 * pi runs createAgentSession for real and talks to the fake over real HTTP.
 */
export async function startHarness(opts?: HarnessOptions): Promise<Harness> {
  const fake = await startFakeLlmServer(opts?.initial);

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-gate-'));
  const agentDir = path.join(tmpRoot, 'agent');
  const workspace = path.join(tmpRoot, 'workspace');
  // Where the server reads config.json. A test that supplies its own HOME is
  // already isolating the config the normal way (~/.wherever under that HOME),
  // so honour it; otherwise point at a throwaway dir of our own.
  const whereverConfigDir = opts?.env?.HOME
    ? path.join(opts.env.HOME, '.wherever')
    : path.join(tmpRoot, 'wherever-config');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(whereverConfigDir, { recursive: true });

  // Register the fake as the ONLY provider, and make it the default model.
  fs.writeFileSync(
    path.join(agentDir, 'models.json'),
    JSON.stringify(
      {
        providers: {
          fake: {
            baseUrl: fake.url,
            api: 'anthropic-messages',
            apiKey: 'test-key',
            models: [{ id: 'fake-model' }],
          },
        },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(path.join(agentDir, 'auth.json'), JSON.stringify({}));
  fs.writeFileSync(
    path.join(agentDir, 'settings.json'),
    JSON.stringify({ defaultProvider: 'fake', defaultModel: 'fake-model' }, null, 2),
  );

  const port = await freePort();

  const child: ChildProcess = spawn(
    tsxBin,
    // `start` is required: bare invocation prints usage and exits (the server is
    // reached only via the explicit `start` verb, see dispatch() in index.ts).
    [serverEntry, 'start', '--port', String(port), '--host', '127.0.0.1', '--no-ssl'],
    {
      cwd: serverDir,
      // Own process group, so cleanup() can signal the server AND anything it
      // spawned in one shot, instead of leaving strays behind.
      detached: true,
      env: {
        ...process.env,
        // Isolation: the harness runs the server with NO token/SSL (see the doc
        // comment above). But when these tests are run inside a wherever-managed
        // shell, the ambient environment carries PI_REMOTE_* (a token, host,
        // port, SSL paths) which the server reads at startup (index.ts parseArgs).
        // An inherited PI_REMOTE_TOKEN would make the server enforce auth and
        // reject the token-less TestClient WS upgrade with 401. Neutralize every
        // PI_REMOTE_* here so the harness's intent holds regardless of ambient env.
        PI_REMOTE_TOKEN: '',
        PI_REMOTE_HOST: '',
        PI_REMOTE_PORT: '',
        PI_REMOTE_SSL_KEY: '',
        PI_REMOTE_SSL_CERT: '',
        PI_REMOTE_HTTP: '',
        PI_REMOTE_HTTP_LOCALHOST_FALLBACK: '',
        PI_CODING_AGENT_DIR: agentDir,
        // Isolate the wherever config too. Otherwise the harness server reads the
        // developer's real ~/.wherever/config.json, whose `sessions.ignore` may
        // well cover /tmp/** -- which is exactly where the harness puts its
        // workspace, silently hiding the test's own sessions from /sessions.
        WHEREVER_CONFIG_DIR: whereverConfigDir,
        PI_REMOTE_NO_SSL: 'true',
        ...(opts?.idleTimeoutMs != null ? { PI_IDLE_TIMEOUT: String(opts.idleTimeoutMs) } : {}),
        ...(opts?.env ?? {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout?.on('data', (d) => process.env.GATE_DEBUG && process.stdout.write(`[srv] ${d}`));
  child.stderr?.on('data', (d) => process.env.GATE_DEBUG && process.stderr.write(`[srv!] ${d}`));

  installExitHooks();
  if (child.pid != null) liveServers.add(child.pid);
  let exited = false;
  child.once('exit', () => {
    exited = true;
    if (child.pid != null) liveServers.delete(child.pid);
  });

  /** Stop the server for real: signal its process group, escalate, and WAIT for
   *  the exit. Returning before the process is gone is what let servers pile up
   *  faster than they were reaped. */
  const stopServer = async (): Promise<void> => {
    if (exited || child.pid == null) return;
    const pid = child.pid;
    const waitExit = (ms: number) =>
      new Promise<boolean>((resolve) => {
        if (exited) return resolve(true);
        const timer = setTimeout(() => resolve(exited), ms);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve(true);
        });
      });
    killGroup(pid, 'SIGTERM');
    if (await waitExit(5_000)) return;
    // Wedged (e.g. thrashing under memory pressure): stop asking politely.
    killGroup(pid, 'SIGKILL');
    await waitExit(2_000);
  };

  // Wait for /health.
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) break;
    } catch {}
    if (Date.now() > deadline) throw new Error('server did not become healthy');
    await new Promise((r) => setTimeout(r, 150));
  }

  const clients: TestClient[] = [];

  return {
    port,
    fake,
    workspace,
    agentDir,
    setNext: (b) => fake.setNext(b),
    async connect(clientKey?: string) {
      const c = await TestClient.open(port, workspace, clientKey);
      clients.push(c);
      return c;
    },
    async cleanup() {
      for (const c of clients) c.close();
      await stopServer();
      await fake.close();
      try {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      } catch {}
    },
  };
}

type ServerMsg = { type: string; [k: string]: unknown };

/** A minimal WS client that records every server message for assertions. */
export class TestClient {
  private ws: WebSocket;
  readonly messages: ServerMsg[] = [];
  readonly workspace: string;
  private waiters: Array<{ pred: (m: ServerMsg) => boolean; resolve: (m: ServerMsg) => void }> = [];

  private constructor(ws: WebSocket, workspace: string) {
    this.ws = ws;
    this.workspace = workspace;
    ws.on('message', (data) => {
      const m = JSON.parse(data.toString()) as ServerMsg;
      this.messages.push(m);
      this.waiters = this.waiters.filter((w) => {
        if (w.pred(m)) {
          w.resolve(m);
          return false;
        }
        return true;
      });
    });
  }

  static open(port: number, workspace: string, clientKey?: string): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const query = clientKey ? `?clientKey=${encodeURIComponent(clientKey)}` : '';
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${query}`);
      const c = new TestClient(ws, workspace);
      ws.on('open', () => resolve(c));
      ws.on('error', reject);
    });
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  /** Resolve when a server message matching `pred` arrives (or already arrived). */
  waitFor(pred: (m: ServerMsg) => boolean, timeoutMs = 20_000): Promise<ServerMsg> {
    const existing = this.messages.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `timeout waiting for message; saw: ${this.messages.map((m) => m.type).join(', ')}`,
            ),
          ),
        timeoutMs,
      );
      this.waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }

  waitForType(type: string, timeoutMs?: number): Promise<ServerMsg> {
    return this.waitFor((m) => m.type === type, timeoutMs);
  }

  /** Concatenated assistant streaming text seen so far. */
  streamedText(): string {
    return this.messages
      .filter((m) => m.type === 'message_update')
      .map((m) => m.delta as string)
      .join('');
  }

  close(): void {
    try {
      this.ws.close();
    } catch {}
  }

  /** Resolves when the SERVER (or anything else) closes this socket. */
  closedPromise(timeoutMs = 10_000): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('socket was not closed')), timeoutMs);
      this.ws.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
