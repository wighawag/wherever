/**
 * How fast, and at what cost, @shipmates/pi's OWN delivery works inside wherever's
 * server sessions (the measurement behind "no ShipmatesHost.deliver yet", see
 * CONTEXT.md "wherever as a shipmates host").
 *
 * @shipmates/pi runs one `PRAGMA data_version` poller per PROCESS (its shared.ts),
 * every 1 s by default, shared by every session in it, and wakes an idle
 * session with `sendMessage(..., {triggerTurn: true})`. wherever runs all its
 * server sessions in one process, so this measures, with N idle server sessions
 * (REAL pi on the fake LLM, @shipmates/pi as an inline extension) in one pool:
 *
 *  - latency: a message sent from another shipmates connection (another process'
 *    view of the same database) at a random moment, until the receiving
 *    session's `agent_start`;
 *  - cost: the process' CPU over an idle window, with and without @shipmates/pi.
 *
 * Usage (from server/): `timeout 300 npx tsx test/bench/shipmates-delivery.ts [sessions] [messages]`
 * Everything is in temp dirs; nothing outside them is read or written.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const N = Number(process.argv[2]) || 10;
const MESSAGES = Number(process.argv[3]) || 30;
const IDLE_MS = 10_000;

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-shipmates-bench-')));
for (const [key, dir] of [
  ['HOME', 'home'],
  ['PI_CODING_AGENT_DIR', 'agent'],
  ['WHEREVER_CONFIG_DIR', 'config'],
  ['WHEREVER_STATE_DIR', 'state'],
  ['SHIPMATES_STATE_DIR', 'shipmates'],
] as const) {
  process.env[key] = path.join(root, dir);
  fs.mkdirSync(process.env[key]!, { recursive: true });
}
delete process.env.SHIPMATES_POLL_MS; // the default 1 s poll is what is measured

const { startFakeLlmServer } = await import('../fake-llm-server.ts');
const fake = await startFakeLlmServer({ kind: 'reply', text: 'ok' });
fs.writeFileSync(
  path.join(process.env.PI_CODING_AGENT_DIR!, 'models.json'),
  JSON.stringify({ providers: { fake: { baseUrl: fake.url, api: 'anthropic-messages', apiKey: 'k', models: [{ id: 'fake-model' }] } } }),
);
fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR!, 'settings.json'), JSON.stringify({ defaultProvider: 'fake', defaultModel: 'fake-model' }));

const { SessionPool } = await import('../../src/session-pool.ts');
const shipmatesPi = (await import('@shipmates/pi')).default;
const { openShipmates } = await import('shipmates');

async function pool(withShipmates: boolean) {
  const p = new SessionPool(3_600_000, withShipmates ? { extraExtensionFactories: [{ name: '@shipmates/pi', factory: shipmatesPi as any }] } : {});
  const files: string[] = [];
  for (let i = 0; i < N; i++) {
    const cwd = fs.mkdtempSync(path.join(root, 'cwd-'));
    const { tracked, error } = await p.createNewSession(cwd, undefined, false, true);
    if (error) throw new Error(error);
    // pi writes the transcript only once the conversation starts: give each one turn.
    await p.sendUserMessage(tracked.sessionFile, 'hello');
    files.push(tracked.sessionFile);
  }
  return { p, files };
}

async function idleCpu(): Promise<number> {
  const start = process.cpuUsage();
  await new Promise((r) => setTimeout(r, IDLE_MS));
  const d = process.cpuUsage(start);
  return (d.user + d.system) / 1000; // ms
}

const pct = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))];

// Baseline: the same sessions without @shipmates/pi. Measured twice, around the
// @shipmates/pi window, so start-up warm-up cannot pass for shipmates' cost.
async function baseline(label: string) {
  const { p } = await pool(false);
  await new Promise((r) => setTimeout(r, 8000)); // settle after the build (pi and the pool have start-up timers)
  const ms = await idleCpu();
  console.log(`idle CPU, ${N} server sessions WITHOUT @shipmates/pi (${label}): ${ms.toFixed(1)} ms over ${IDLE_MS / 1000} s`);
  await p.disposeAll();
}
await baseline('before');

const { p, files } = await pool(true);
await new Promise((r) => setTimeout(r, 8000));
const ms = await idleCpu();
console.log(`idle CPU, ${N} server sessions WITH @shipmates/pi:           ${ms.toFixed(1)} ms over ${IDLE_MS / 1000} s`);

const sender = openShipmates();
const latencies: number[] = [];
for (let i = 0; i < MESSAGES; i++) {
  const target = files[i % files.length];
  await new Promise((r) => setTimeout(r, 200 + Math.random() * 1000)); // a random phase against the poll
  const t0 = performance.now();
  const started = new Promise<number>((resolve) => {
    const off = p.subscribeEvents((file, event) => {
      if (file === target && event.type === 'agent_start') {
        off();
        resolve(performance.now() - t0);
      }
    });
  });
  sender.send({ from: null, fromLabel: 'bench', to: target, text: `ping ${i}` });
  latencies.push(await Promise.race([started, new Promise<number>((r) => setTimeout(() => r(Infinity), 10_000))]));
  await new Promise((r) => setTimeout(r, 300)); // let the woken turn settle
}
const delivered = latencies.filter(Number.isFinite);
if (!delivered.length) console.log(`send -> woken agent_start: 0/${MESSAGES} delivered (no idle session was woken)`);
else console.log(
  `send -> woken agent_start, ${delivered.length}/${MESSAGES} delivered: ` +
    `min ${pct(delivered, 0).toFixed(0)} ms, median ${pct(delivered, 0.5).toFixed(0)} ms, p90 ${pct(delivered, 0.9).toFixed(0)} ms, max ${Math.max(...delivered).toFixed(0)} ms`,
);
const pending = files.reduce((n, f) => n + sender.pendingFor(f).length, 0);
console.log(`messages still pending after the run: ${pending}`);

sender.close();
await p.disposeAll();
await baseline('after');
await fake.close();
fs.rmSync(root, { recursive: true, force: true });
process.exit(0);
