import { describe, it, expect } from 'vitest';
import { createCliRequestRouter, CliRequestRouter, assistantInfoChangedFrame } from '../src/cli-requests.ts';

/**
 * The server half of the CLI bridge's request/response path (ADR 0016):
 * `cli_request {id, op, args}` answered by `cli_response {id, ok, result | error}`.
 * The caller is the session the bridge REGISTERED (resolved server-side, never
 * read from the request), an unknown op answers an error, and `assistant_info`
 * reports the active assistant folder or "not configured" (null).
 */

const caller = { sessionFile: '/tmp/s.jsonl' };

describe('CLI request router', () => {
  it('assistant_info returns the active assistant folder', async () => {
    const router = createCliRequestRouter({ assistantInfo: () => ({ assistantFolder: '/home/u/assistant' }) });
    expect(await router.handle({ type: 'cli_request', id: 'r1', op: 'assistant_info' }, caller)).toEqual({
      type: 'cli_response',
      id: 'r1',
      ok: true,
      result: { assistantFolder: '/home/u/assistant' },
    });
  });

  it('assistant_info answers null when the assistant is not active', async () => {
    const router = createCliRequestRouter({ assistantInfo: () => ({ assistantFolder: null }) });
    const res = await router.handle({ type: 'cli_request', id: 'r2', op: 'assistant_info' }, caller);
    expect(res).toEqual({ type: 'cli_response', id: 'r2', ok: true, result: { assistantFolder: null } });
  });

  it('an unknown op answers an error with its id', async () => {
    const router = createCliRequestRouter({ assistantInfo: () => ({ assistantFolder: null }) });
    const res = await router.handle({ type: 'cli_request', id: 'r3', op: 'no_such_op' }, caller);
    expect(res).toMatchObject({ type: 'cli_response', id: 'r3', ok: false });
    expect((res as any).error).toMatch(/unknown.*no_such_op/i);
  });

  it('a request from a connection that never registered a session is refused', async () => {
    const router = createCliRequestRouter({ assistantInfo: () => ({ assistantFolder: '/a' }) });
    const res = await router.handle({ type: 'cli_request', id: 'r4', op: 'assistant_info' }, null);
    expect(res).toMatchObject({ id: 'r4', ok: false });
    expect((res as any).error).toMatch(/cli_register/);
  });

  it('a request without a string id cannot be answered and yields null', async () => {
    const router = createCliRequestRouter({ assistantInfo: () => ({ assistantFolder: '/a' }) });
    expect(await router.handle({ type: 'cli_request', op: 'assistant_info' } as any, caller)).toBeNull();
  });

  it('ops get the server-resolved caller and their args; a throwing op answers its message', async () => {
    const router = new CliRequestRouter();
    const seen: unknown[] = [];
    router.register('echo', (args, who) => {
      seen.push([args, who]);
      return { echoed: args };
    });
    router.register('boom', async () => {
      throw new Error('kaput');
    });
    // A caller field in the args is just data: the caller is the registration.
    const res = await router.handle({ type: 'cli_request', id: 'e', op: 'echo', args: { sessionFile: '/forged' } }, caller);
    expect(res).toEqual({ type: 'cli_response', id: 'e', ok: true, result: { echoed: { sessionFile: '/forged' } } });
    expect(seen).toEqual([[{ sessionFile: '/forged' }, caller]]);
    expect(await router.handle({ type: 'cli_request', id: 'b', op: 'boom' }, caller)).toEqual({
      type: 'cli_response',
      id: 'b',
      ok: false,
      error: 'kaput',
    });
  });

  it('assistant_info_changed carries the folder and timezone', () => {
    expect(assistantInfoChangedFrame({ assistantFolder: '/a', timezone: 'Europe/Paris' })).toEqual({
      type: 'assistant_info_changed',
      assistantFolder: '/a',
      timezone: 'Europe/Paris',
    });
    expect(assistantInfoChangedFrame({ assistantFolder: null })).toEqual({
      type: 'assistant_info_changed',
      assistantFolder: null,
      timezone: null,
    });
  });
});

describe('CLI request router: shipmates host ops (ADR 0024)', () => {
  const caller = { sessionFile: '/s/owner.jsonl', sessionId: 'o', cwd: '/w' };
  const call = (router: CliRequestRouter, op: string, args?: unknown) => router.handle({ type: 'cli_request', id: 'r', op, args }, caller);

  it('shipmates_host_info says whether the bridge should register its host', async () => {
    const off = createCliRequestRouter({ assistantInfo: () => ({ assistantFolder: null }), shipmatesHost: () => null });
    expect(await call(off, 'shipmates_host_info')).toEqual({ type: 'cli_response', id: 'r', ok: true, result: { available: false } });
    const on = createCliRequestRouter({ assistantInfo: () => ({ assistantFolder: null }), shipmatesHost: () => ({}) });
    expect(await call(on, 'shipmates_host_info')).toMatchObject({ ok: true, result: { available: true } });
  });

  it('spawn and stop act only on behalf of the REGISTERED session', async () => {
    const spawned: unknown[] = [];
    const stopped: unknown[] = [];
    const router = createCliRequestRouter({
      assistantInfo: () => ({ assistantFolder: null }),
      shipmatesHost: () => ({
        spawn: async (req) => {
          spawned.push(req);
          return { sessionFile: '/s/child.jsonl' };
        },
        stop: async (file, opts) => {
          stopped.push([file, opts]);
          return 'stopped';
        },
      }),
    });
    const req = { spawnId: 'sp_1', owner: '/s/owner.jsonl', folder: '/w/lane', title: 'lane' };
    expect(await call(router, 'shipmates_spawn', req)).toMatchObject({ ok: true, result: { sessionFile: '/s/child.jsonl' } });
    expect(await call(router, 'shipmates_spawn', { ...req, owner: '/s/someone-else.jsonl' })).toMatchObject({ ok: false, error: expect.stringMatching(/only spawn sessions it owns itself/) });
    expect(spawned).toEqual([req]);

    expect(await call(router, 'shipmates_stop', { sessionFile: '/s/child.jsonl', by: '/s/owner.jsonl' })).toMatchObject({ ok: true, result: { outcome: 'stopped' } });
    expect(await call(router, 'shipmates_stop', { sessionFile: '/s/child.jsonl', by: '/s/other.jsonl' })).toMatchObject({ ok: false });
    expect(stopped).toEqual([['/s/child.jsonl', { by: '/s/owner.jsonl' }]]);
  });

  it('without shipmates: spawn is refused and stop answers not-mine (shipmates then falls back)', async () => {
    const router = createCliRequestRouter({ assistantInfo: () => ({ assistantFolder: null }), shipmatesHost: () => null });
    expect(await call(router, 'shipmates_spawn', { spawnId: 'sp', owner: '/s/owner.jsonl', folder: '/w' })).toMatchObject({ ok: false });
    expect(await call(router, 'shipmates_stop', { sessionFile: '/s/x.jsonl', by: '/s/owner.jsonl' })).toMatchObject({ ok: true, result: { outcome: 'not-mine' } });
  });
});
