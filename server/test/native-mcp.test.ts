import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionPool } from '../src/session-pool.ts';

// pi >= 0.99 ships MCP (plus codemode and tool search) as BUILT-IN extensions,
// which the pi CLI loads by itself but the SDK does not. A server-created
// session must get them too, so the MCP servers in the user's `mcp.json` reach
// a web session exactly as they reach a terminal pi (issue #69), and must honor
// the same opt-out (`-builtin:mcp` in the `extensions` setting).
//
// In-process, against a throwaway PI_CODING_AGENT_DIR whose `mcp.json` names a
// tiny stdio MCP server (test/fixtures/stdio-mcp-server.mjs). No LLM call.

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stdio-mcp-server.mjs');
const TOOL = 'mcp__fixture__echo';

let root: string;
let agentDir: string;
let pidFile: string;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-native-mcp-'));
  for (const [key, dir] of [
    ['PI_CODING_AGENT_DIR', 'agent'],
    ['WHEREVER_CONFIG_DIR', 'wherever-config'],
  ] as const) {
    savedEnv[key] = process.env[key];
    process.env[key] = path.join(root, dir);
    fs.mkdirSync(process.env[key]!, { recursive: true });
  }
  agentDir = process.env.PI_CODING_AGENT_DIR!;
  pidFile = path.join(root, 'mcp-server.pid');
  fs.writeFileSync(
    path.join(agentDir, 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        // `direct` so the tool is declared like a built-in one once connected.
        fixture: { command: process.execPath, args: [fixture, pidFile], exposure: 'direct' },
      },
    }),
  );
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  fs.rmSync(path.join(agentDir, 'settings.json'), { force: true });
  fs.rmSync(pidFile, { force: true });
});

function freshCwd(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(root, 'cwd-')));
}

async function until(cond: () => boolean, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  return cond();
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('native (built-in) MCP in server-created sessions', () => {
  it('connects the servers in mcp.json and exposes their tools, then stops them when the session goes', async () => {
    const pool = new SessionPool(300_000);
    const { tracked, error } = await pool.createNewSession(freshCwd(), undefined, false, false);
    expect(error).toBeUndefined();
    const session = tracked.agentSession;

    // Servers connect in the background after session_start.
    expect(await until(() => session.getAllTools().some((t) => t.name === TOOL))).toBe(true);
    expect(session.getActiveToolNames()).toContain(TOOL);

    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    expect(alive(pid)).toBe(true);

    // session_shutdown (emitted by the pool before dispose) closes the server.
    await pool.destroySession(tracked.sessionFile, 'manual');
    expect(await until(() => !alive(pid))).toBe(true);
    await pool.disposeAll();
  }, 30_000);

  it('honors `-builtin:mcp` in the extensions setting, like the pi CLI', async () => {
    fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ extensions: ['-builtin:mcp'] }));
    const pool = new SessionPool(300_000);
    const { tracked, error } = await pool.createNewSession(freshCwd(), undefined, false, false);
    expect(error).toBeUndefined();

    // Give a (wrongly) loaded MCP extension the time it would need to connect.
    await new Promise((r) => setTimeout(r, 1_500));
    expect(tracked.agentSession.getAllTools().some((t) => t.name.startsWith('mcp__'))).toBe(false);
    expect(fs.existsSync(pidFile)).toBe(false);
    await pool.disposeAll();
  }, 30_000);
});
