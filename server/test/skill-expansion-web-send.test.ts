import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { startHarness, type Harness } from './harness.js';

// End-to-end: a web `message` starting with `/skill:<name>` is EXPANDED before it
// reaches the model (the skill body inlined as a <skill> block, the trailing text
// kept after it), exactly like the pi CLI. The pool sends `/`-prefixed text
// through prompt() with expandPromptTemplates (session-pool.ts sendUserMessage);
// this guards that the reply-routing change (every send through prompt() with a
// preflightResult) kept it, and that plain text is still sent verbatim.

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

function lastUserText(body: Record<string, any> | undefined): string {
  const msgs = (body?.messages ?? []) as Array<{ role: string; content: unknown }>;
  const last = [...msgs].reverse().find((m) => m.role === 'user');
  const c = last?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p: any) => (p?.type === 'text' ? p.text : '')).join('');
  return '';
}

describe('/skill: on a web send', () => {
  it('expands the skill for the model; plain text is sent verbatim', async () => {
    h = await startHarness({ initial: { kind: 'reply', text: 'done' } });
    const skillDir = path.join(h.agentDir, 'skills', 'routing-probe');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: routing-probe\ndescription: A probe skill for the expansion test.\n---\n\nPROBE-SKILL-BODY-7731\n',
    );

    const c = await h.connect();
    await c.waitForType('connected');
    c.send({ type: 'session_new', cwd: c.workspace });
    const created = await c.waitForType('session_created');
    const sessionId = created.sessionId as string;

    c.send({ type: 'message', message: '/skill:routing-probe and then this', sessionId });
    await c.waitForType('agent_end', 30_000);
    const expanded = lastUserText(h.fake.requests().at(-1));
    expect(expanded).toContain('<skill name="routing-probe"');
    expect(expanded).toContain('PROBE-SKILL-BODY-7731');
    expect(expanded).toContain('and then this');

    c.messages.length = 0;
    c.send({ type: 'message', message: 'plain /skill:routing-probe not at the start', sessionId });
    await c.waitForType('agent_end', 30_000);
    expect(lastUserText(h.fake.requests().at(-1))).toBe('plain /skill:routing-probe not at the start');
  }, 60_000);
});
