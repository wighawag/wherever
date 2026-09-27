import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionPool } from '../src/session-pool.ts';

// A provider that an EXTENSION registers (`pi.registerProvider` while loading),
// named as the default in settings.json, must be what a server session runs on,
// exactly as in the pi CLI.
//
// pi queues those registrations and flushes them either right after loading
// (the CLI's services path) or when the extension runner binds, which for a
// server session is AFTER createAgentSession has already picked the model. So
// the default resolved to nothing: the session showed `unknown:unknown` and
// every prompt failed with "No API key found". Seen with a local model served
// through an extension, where the pi CLI answered and wherever did not.
//
// The extension is a real file in the agent dir's extensions/ folder, loaded the
// way a global extension is. No LLM call is made.

let root: string;
const savedEnv: Record<string, string | undefined> = {};

// Like a real local-model extension, it reads its endpoint from a config file
// each time its factory runs (every session build). So a /reload after the
// config changes re-registers the provider with the new baseUrl, independently
// of pi's module cache for the extension's code.
function extensionSource(configFile: string): string {
  const model = (id: string) => `{
      id: '${id}',
      name: '${id}',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32768,
      maxTokens: 4096,
    }`;
  return `
import fs from 'node:fs';
export default function (pi) {
  const { baseUrl } = JSON.parse(fs.readFileSync(${JSON.stringify(configFile)}, 'utf8'));
  pi.registerProvider('ext-local', {
    name: 'Extension-registered local model',
    baseUrl,
    apiKey: 'none',
    api: 'openai-completions',
    models: [${model('ext-model')}, ${model('ext-other')}],
  });
}
`;
}

let configFile: string;
const setBaseUrl = (baseUrl: string) => fs.writeFileSync(configFile, JSON.stringify({ baseUrl }));

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-ext-provider-'));
  for (const [key, dir] of [
    ['PI_CODING_AGENT_DIR', 'agent'],
    ['WHEREVER_CONFIG_DIR', 'wherever-config'],
  ] as const) {
    savedEnv[key] = process.env[key];
    process.env[key] = path.join(root, dir);
    fs.mkdirSync(process.env[key]!, { recursive: true });
  }
  const agentDir = process.env.PI_CODING_AGENT_DIR!;
  fs.mkdirSync(path.join(agentDir, 'extensions'), { recursive: true });
  configFile = path.join(root, 'ext-local.json');
  setBaseUrl('http://127.0.0.1:9/v1');
  fs.writeFileSync(path.join(agentDir, 'extensions', 'ext-local-provider.js'), extensionSource(configFile));
  fs.writeFileSync(
    path.join(agentDir, 'settings.json'),
    JSON.stringify({ defaultProvider: 'ext-local', defaultModel: 'ext-model' }),
  );
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

function freshCwd(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(root, 'cwd-')));
}

describe('providers registered by extensions', () => {
  it('a new session runs on the default model an extension provides', async () => {
    // No initialize(): the session build alone must be enough.
    const pool = new SessionPool(300_000);
    const { tracked, error } = await pool.createNewSession(freshCwd(), undefined, false, false);
    expect(error).toBeUndefined();
    expect(tracked.agentSession.model?.provider).toBe('ext-local');
    expect(tracked.agentSession.model?.id).toBe('ext-model');
    await pool.disposeAll();
  }, 30_000);

  it('a model picked by name from an extension provider resolves (not just the default)', async () => {
    // No initialize(): the name is looked up before this build registers the
    // provider, so it must be looked up again after (a project-local extension,
    // or startup discovery still running, is exactly this case).
    const pool = new SessionPool(300_000);
    const { tracked, error } = await pool.createNewSession(freshCwd(), 'ext-local:ext-other', false, false);
    expect(error).toBeUndefined();
    expect(tracked.agentSession.model?.provider).toBe('ext-local');
    expect(tracked.agentSession.model?.id).toBe('ext-other');
    await pool.disposeAll();
  }, 30_000);

  it('/reload re-registers the provider and the session takes the new config (a new baseUrl)', async () => {
    const pool = new SessionPool(300_000);
    const { tracked, error } = await pool.createNewSession(freshCwd(), undefined, false, false);
    expect(error).toBeUndefined();
    expect(tracked.agentSession.model?.baseUrl).toBe('http://127.0.0.1:9/v1');

    setBaseUrl('http://127.0.0.1:10/v1');
    try {
      const result = await pool.reloadSession(tracked.sessionFile);
      expect(result).toEqual({ started: true });
      const reloaded = pool.getSession(tracked.sessionFile);
      expect(reloaded?.type).toBe('server');
      expect((reloaded as any).agentSession.model?.baseUrl).toBe('http://127.0.0.1:10/v1');
      expect((reloaded as any).agentSession.model?.id).toBe('ext-model');
    } finally {
      setBaseUrl('http://127.0.0.1:9/v1');
      await pool.disposeAll();
    }
  }, 30_000);

  it('the model list and the default know the extension provider at startup, before any session', async () => {
    const pool = new SessionPool(300_000);
    await pool.initialize();
    const models = pool.getAvailableModels(freshCwd());
    expect(models).toContainEqual(
      expect.objectContaining({ provider: 'ext-local', modelId: 'ext-model', isDefault: true }),
    );
    expect(pool.getDefaultModelFor(freshCwd())).toBe('ext-local:ext-model');
    await pool.disposeAll();
  }, 30_000);
});
