import { describe, it, expect } from 'vitest';
import {
  ASSISTANT_TOOL_TWIN_TEXTS,
  ASSISTANT_TWIN_OPS,
  ASSISTANT_TWIN_PARAMETERS,
  timezoneLine as cliTimezoneLine,
} from '../../extension/src/assistant-tool-twins.ts';
import { ASSISTANT_TOOL_TEXTS, timezoneLine } from '../src/assistant-tool-text.ts';
import {
  ASSISTANT_NOT_CONFIGURED_ERROR,
  createAssistantTools,
  type AssistantNotifyBackend,
  type AssistantScheduleBackend,
  type AssistantSessionHooks,
} from '../src/assistant-tools.ts';
import { ASSISTANT_TWIN_OP_NAMES, createCliRequestRouter, type CliCaller } from '../src/cli-requests.ts';

/**
 * The CLI-bridge twins of the five `assistant_*` tools (ADR 0016):
 *  - DRIFT: the extension's copies of the tool text (name, label, description,
 *    promptSnippet, promptGuidelines), of the parameter schemas and of the
 *    timezone line are identical to the server's (the extension is a separate
 *    published package and cannot import them), like `say-tool.test.ts`;
 *  - the server's `cli_request` ops behind them run the server tools' op code
 *    with the caller resolved from the registration: not configured, not active
 *    (lock), and active, each answered as the twin needs it.
 * The real-server round trip is in assistant-tool-twins-server.test.ts.
 */

const strip = (v: unknown) => JSON.parse(JSON.stringify(v));

describe('assistant tool twins: drift guard', () => {
  it('the extension twins carry the server tools text, in the same order', () => {
    expect(ASSISTANT_TOOL_TWIN_TEXTS.map((t) => strip(t))).toEqual(ASSISTANT_TOOL_TEXTS.map((t) => strip(t)));
  });

  it('the twins parameter schemas match the server tools', () => {
    const backend = {} as AssistantScheduleBackend;
    const hooks: AssistantSessionHooks = {
      folder: '/a',
      access: () => ({ ok: true, backend }),
      notify: () => ({ ok: true, backend: {} as AssistantNotifyBackend }),
    };
    const server = createAssistantTools(hooks, () => ({ sessionId: 's', cwd: '/w' })) as unknown as Array<{
      name: string;
      parameters: unknown;
    }>;
    expect(server.map((t) => t.name)).toEqual(ASSISTANT_TOOL_TEXTS.map((t) => t.name));
    for (const t of server) {
      expect(strip(ASSISTANT_TWIN_PARAMETERS[t.name as keyof typeof ASSISTANT_TWIN_PARAMETERS]), t.name).toEqual(strip(t.parameters));
    }
  });

  it('the twins call exactly the ops the server registers, and the timezone line matches', () => {
    expect(Object.keys(ASSISTANT_TWIN_OPS)).toEqual(ASSISTANT_TOOL_TEXTS.map((t) => t.name));
    expect([...Object.values(ASSISTANT_TWIN_OPS)].sort()).toEqual([...ASSISTANT_TWIN_OP_NAMES].sort());
    expect(cliTimezoneLine('Asia/Tokyo')).toBe(timezoneLine('Asia/Tokyo'));
  });
});

describe('assistant tool twin ops (cli_request)', () => {
  const caller: CliCaller = { sessionFile: '/s/cli.jsonl', sessionId: 'cli-1', cwd: '/home/u/code' };

  /** A fake scheduler backend that records what it is asked. */
  function fakeBackend() {
    const added: unknown[] = [];
    let tz = 'UTC';
    const backend: AssistantScheduleBackend = {
      addJob: async (input) => {
        added.push(input);
        return { ...input, id: 'job-1' } as any;
      },
      removeJob: async (id) => id === 'job-1',
      list: () => ({ timezone: tz, fileError: null, jobs: [], invalid: [] }) as any,
      getUserTimezone: () => tz,
      setUserTimezone: (next) => {
        const changed = next !== tz;
        tz = next;
        return changed;
      },
    };
    return { backend, added, tz: () => tz };
  }

  const req = (op: string, args?: unknown) => ({ type: 'cli_request' as const, id: `r-${op}`, op, args });

  it('with the assistant not configured, every op answers "not configured"', async () => {
    const router = createCliRequestRouter({ assistantInfo: () => ({ assistantFolder: null }), assistantHooks: () => undefined });
    for (const op of ASSISTANT_TWIN_OP_NAMES) {
      const res = await router.handle(req(op, {}), caller);
      expect(res, op).toEqual({ type: 'cli_response', id: `r-${op}`, ok: false, error: ASSISTANT_NOT_CONFIGURED_ERROR });
    }
  });

  it('configured but not active (lock): every op answers the lock-state error, notify included', async () => {
    const hooks: AssistantSessionHooks = { folder: '/a', access: () => ({ ok: false, error: 'LOCK: held by another server' }) };
    const router = createCliRequestRouter({ assistantInfo: () => ({ assistantFolder: null }), assistantHooks: () => hooks });
    for (const op of ASSISTANT_TWIN_OP_NAMES) {
      const res = await router.handle(req(op, {}), caller);
      expect(res, op).toMatchObject({ ok: false, error: 'LOCK: held by another server' });
    }
  });

  it('active: ops run the server op code with the registered caller as origin, never the args', async () => {
    const f = fakeBackend();
    const notified: unknown[] = [];
    const hooks: AssistantSessionHooks = {
      folder: '/a',
      access: () => ({ ok: true, backend: f.backend }),
      notify: () => ({
        ok: true,
        backend: {
          notify: async (n) => {
            notified.push(n);
            return { ok: true, deliveries: [{ channel: 'webpush', result: { ok: true, detail: '1 device' } }] } as any;
          },
          jobOrigin: () => null,
          jobForSession: () => null,
        },
      }),
    };
    const router = createCliRequestRouter({ assistantInfo: () => ({ assistantFolder: '/a' }), assistantHooks: () => hooks });

    const add = await router.handle(
      req('schedule_add', { name: 'ci', prompt: 'check CI', mode: 'isolated', at: 'now', originSessionId: 'forged' }),
      caller,
    );
    expect(add).toMatchObject({ ok: true, result: { text: expect.stringContaining('Scheduled "ci" (id job-1)') } });
    expect(f.added).toEqual([
      expect.objectContaining({ name: 'ci', mode: 'isolated', at: 'now', enabled: true, originSessionId: 'cli-1', originCwd: '/home/u/code' }),
    ]);

    expect(await router.handle(req('schedule_list'), caller)).toMatchObject({ ok: true, result: { text: expect.stringContaining('Jobs (0)') } });
    expect(await router.handle(req('schedule_remove', { id: 'job-1' }), caller)).toMatchObject({ ok: true, result: { text: 'Removed job job-1.' } });
    expect(await router.handle(req('schedule_remove', { id: 'nope' }), caller)).toMatchObject({ ok: false, error: expect.stringContaining('no job') });
    expect(await router.handle(req('set_timezone', { timezone: 'Europe/Paris' }), caller)).toMatchObject({
      ok: true,
      result: { details: { timezone: 'Europe/Paris', changed: true } },
    });
    expect(f.tz()).toBe('Europe/Paris');
    expect(await router.handle(req('set_timezone', { timezone: 'Mars/Olympus' }), caller)).toMatchObject({ ok: false });

    const n = await router.handle(req('notify', { title: 'Deploy finished', body: 'all green' }), caller);
    expect(n).toMatchObject({ ok: true, result: { text: expect.stringContaining('opens session cli-1') } });
    expect(notified).toEqual([{ title: 'Deploy finished', body: 'all green', source: 'code', navigate: 'cli-1' }]);
  });

  it('a caller the pool no longer tracks (no cwd) is refused rather than stamped with a blank origin', async () => {
    const f = fakeBackend();
    const hooks: AssistantSessionHooks = { folder: '/a', access: () => ({ ok: true, backend: f.backend }) };
    const router = createCliRequestRouter({ assistantInfo: () => ({ assistantFolder: '/a' }), assistantHooks: () => hooks });
    const res = await router.handle(req('schedule_add', { name: 'x', prompt: 'y', mode: 'inline', at: 'now' }), { sessionFile: '/s/x.jsonl' });
    expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/no longer registered/) });
    expect(f.added).toEqual([]);
  });
});
