import { describe, it, expect } from 'vitest';
import type { InlineExtension } from '@earendil-works/pi-coding-agent';
import {
  assistantSessionParts,
  createAssistantTools,
  notifyOp,
  notifySource,
  resolveNotifyTarget,
  type AssistantNotifyBackend,
  type AssistantSessionHooks,
  type JobOrigin,
} from '../src/assistant-tools.ts';
import { ASSISTANT_NOTIFY_TEXT, ASSISTANT_SCHEDULE_TOOL_TEXTS, ASSISTANT_TOOL_TEXTS } from '../src/assistant-tool-text.ts';
import { NO_CHANNEL_ERROR, type ChannelNotification, type NotifyOutcome } from '../src/assistant-channels.ts';
import { composeServerAgentParts } from '../src/session-pool.ts';

/**
 * `assistant_notify` (assistant-tools.ts): the tap-target precedence as a pure
 * function, the op against a fake backend (dispatcher + job mapping), and its
 * registration ONLY while the assistant is active (`hooks.notify`).
 */

const jobs: Record<string, JobOrigin> = {
  'job-ci': { originSessionId: 'coding-session', originCwd: '/home/u/code/my-app' },
  'job-handwritten': { originCwd: '/home/u/notes' },
};
const jobOrigin = (id: string) => jobs[id] ?? null;

describe('resolveNotifyTarget (tap-target precedence)', () => {
  const base = { callerSessionId: 'caller', callerJobId: null, jobOrigin };

  it('navigateSessionId wins over everything', () => {
    expect(resolveNotifyTarget({ ...base, navigateSessionId: 'explicit', jobId: 'job-ci', callerJobId: 'job-ci' })).toMatchObject({
      sessionId: 'explicit',
      via: 'navigateSessionId',
    });
  });

  it('a given jobId opens the job origin session', () => {
    expect(resolveNotifyTarget({ ...base, jobId: 'job-ci' })).toEqual({
      sessionId: 'coding-session',
      via: 'job',
      jobId: 'job-ci',
      job: jobs['job-ci'],
    });
  });

  it('an isolated job session (the job mapping) opens its job origin session', () => {
    expect(resolveNotifyTarget({ ...base, callerSessionId: 'job-session', callerJobId: 'job-ci' })).toMatchObject({
      sessionId: 'coding-session',
      via: 'job',
      jobId: 'job-ci',
    });
  });

  it('otherwise the calling session, also for an unknown job or one without an origin session', () => {
    expect(resolveNotifyTarget(base)).toMatchObject({ sessionId: 'caller', via: 'caller', jobId: null });
    expect(resolveNotifyTarget({ ...base, jobId: 'removed' })).toMatchObject({ sessionId: 'caller', via: 'caller', job: null });
    expect(resolveNotifyTarget({ ...base, jobId: 'job-handwritten' })).toMatchObject({ sessionId: 'caller', via: 'caller' });
  });

  it('source: the job origin folder, else the calling session folder', () => {
    expect(notifySource('/home/u/assistant/jobs', jobs['job-ci']!)).toBe('my-app');
    expect(notifySource('/home/u/code/other/', null)).toBe('other');
  });
});

function fakeBackend(outcome: NotifyOutcome = { ok: true, deliveries: [{ channel: 'webpush', result: { ok: true, detail: '1 device' } }] }) {
  const sent: ChannelNotification[] = [];
  const backend: AssistantNotifyBackend = {
    notify: async (n) => {
      sent.push(n);
      return outcome;
    },
    jobOrigin,
    jobForSession: (file) => (file === '/s/job-1.jsonl' ? 'job-ci' : null),
  };
  return { backend, sent };
}

describe('notifyOp', () => {
  it('delivers with the source and target of the caller', async () => {
    const { backend, sent } = fakeBackend();
    const r = await notifyOp(backend, { sessionId: 'coding-session', cwd: '/home/u/code/my-app', sessionFile: '/s/c.jsonl' }, { title: ' Deploy ', body: 'done' });
    expect(r.ok).toBe(true);
    expect(sent).toEqual([{ title: 'Deploy', body: 'done', source: 'my-app', navigate: 'coding-session' }]);
    expect((r as { text: string }).text).toContain('webpush (1 device)');
  });

  it('from an isolated job session, opens the job origin and names its folder', async () => {
    const { backend, sent } = fakeBackend();
    await notifyOp(backend, { sessionId: 'job-session', cwd: '/home/u/assistant/jobs', sessionFile: '/s/job-1.jsonl' }, { title: 'CI', body: 'red' });
    expect(sent[0]).toMatchObject({ navigate: 'coding-session', source: 'my-app' });
  });

  it('a missing title is refused without notifying; a channel failure is the error', async () => {
    const { backend, sent } = fakeBackend();
    expect(await notifyOp(backend, { sessionId: 's', cwd: '/x' }, { body: 'b' })).toMatchObject({ ok: false });
    expect(sent).toEqual([]);
    const none = fakeBackend({ ok: false, error: NO_CHANNEL_ERROR, deliveries: [] });
    expect(await notifyOp(none.backend, { sessionId: 's', cwd: '/x' }, { title: 't', body: 'b' })).toEqual({ ok: false, error: NO_CHANNEL_ERROR });
  });
});

type AnyTool = { name: string; execute: (id: string, p: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }> };

describe('registration', () => {
  const caller = () => ({ sessionId: 's', cwd: '/home/u/code', sessionFile: null });

  it('only while active (hooks.notify): absent when configured but refused', () => {
    const refused: AssistantSessionHooks = { folder: '/home/u/assistant', access: () => ({ ok: false, error: 'off' }) };
    expect(assistantSessionParts(refused, '/home/u/code', caller).customTools.map((t) => t.name)).toEqual(
      ASSISTANT_SCHEDULE_TOOL_TEXTS.map((t) => t.name),
    );
    const { backend } = fakeBackend();
    const active: AssistantSessionHooks = { ...refused, notify: () => ({ ok: true, backend }) };
    expect(assistantSessionParts(active, '/home/u/code', caller).customTools.map((t) => t.name)).toEqual(ASSISTANT_TOOL_TEXTS.map((t) => t.name));
    const conversationExtension: InlineExtension = { name: 'conv', factory: () => {} };
    expect(
      composeServerAgentParts({ cwd: '/home/u/code', conversationExtension, extraExtensionFactories: [], assistant: active, caller }).customTools.map(
        (t) => t.name,
      ),
    ).toEqual(['attach_file', 'say', ...ASSISTANT_TOOL_TEXTS.map((t) => t.name)]);
  });

  it('carries the shared text, and answers an isError while the channels are not ready', async () => {
    const hooks: AssistantSessionHooks = {
      folder: '/a',
      access: () => ({ ok: false, error: 'off' }),
      notify: () => ({ ok: false, error: 'the assistant channels are still starting' }),
    };
    const tool = (createAssistantTools(hooks, caller) as unknown as AnyTool[]).find((t) => t.name === 'assistant_notify')! as unknown as AnyTool &
      Record<string, unknown>;
    expect(tool.description).toBe(ASSISTANT_NOTIFY_TEXT.description);
    expect(tool.promptSnippet).toBe(ASSISTANT_NOTIFY_TEXT.promptSnippet);
    expect(tool.promptGuidelines).toEqual(ASSISTANT_NOTIFY_TEXT.promptGuidelines);
    const r = await tool.execute('t', { title: 't', body: 'b' });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toBe('assistant_notify: the assistant channels are still starting');
  });
});
