import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readSessionHeader,
  readSessionListingInfo,
  readTranscriptWindow,
} from '../src/session-transcript.js';

// The readers under test exist for ONE reason: a real sessions directory is
// gigabytes (measured: 3,831 files / 2.0 GB, single transcripts up to 62 MB) and
// the server used to materialize whole transcripts -- for the /sessions listing
// (peak ~1.0 GB RSS at startup) and for every history read. These tests pin the
// two properties that keep that from coming back:
//   1. the streamed results are IDENTICAL to what whole-file parsing produced;
//   2. memory stays bounded by the WINDOW, not by the file.

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-transcript-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

interface WriteOpts {
  cwd?: string;
  id?: string;
  parentSession?: string;
  name?: string;
}

function writeTranscript(lines: unknown[], opts: WriteOpts = {}): string {
  const file = path.join(dir, `${opts.id || 'sess'}.jsonl`);
  const header = {
    type: 'session',
    version: 3,
    id: opts.id || 'sess',
    timestamp: '2026-01-01T00:00:00.000Z',
    cwd: opts.cwd || '/tmp/proj',
    ...(opts.parentSession ? { parentSession: opts.parentSession } : {}),
  };
  const body = lines.map((l) => JSON.stringify(l)).join('\n');
  fs.writeFileSync(file, JSON.stringify(header) + '\n' + body + '\n');
  return file;
}

function userMsg(text: string, ts = '2026-01-01T00:01:00.000Z', id?: string) {
  return {
    type: 'message',
    ...(id ? { id } : {}),
    timestamp: ts,
    message: { role: 'user', content: [{ type: 'text', text }] },
  };
}

function assistantMsg(text: string, ts = '2026-01-01T00:02:00.000Z') {
  return {
    type: 'message',
    timestamp: ts,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  };
}

function toolResultMsg(text: string, ts = '2026-01-01T00:03:00.000Z') {
  return {
    type: 'message',
    timestamp: ts,
    message: { role: 'toolResult', toolName: 'read', toolCallId: 'tc1', content: [{ type: 'text', text }] },
  };
}

describe('readSessionHeader', () => {
  it('reads id/cwd/parentSession without reading the body', async () => {
    const file = writeTranscript([userMsg('hi'), toolResultMsg('x'.repeat(50_000))], {
      cwd: '/tmp/proj-a',
      parentSession: '/tmp/parent.jsonl',
    });
    const header = await readSessionHeader(file);
    expect(header).toEqual({
      id: 'sess',
      cwd: '/tmp/proj-a',
      timestamp: '2026-01-01T00:00:00.000Z',
      parentSession: '/tmp/parent.jsonl',
    });
  });

  it('returns null for a non-session file and a missing file', async () => {
    const bogus = path.join(dir, 'bogus.jsonl');
    fs.writeFileSync(bogus, '{"type":"message"}\n');
    expect(await readSessionHeader(bogus)).toBeNull();
    expect(await readSessionHeader(path.join(dir, 'nope.jsonl'))).toBeNull();
  });
});

describe('readSessionListingInfo', () => {
  it('counts every message but takes modified only from messages with text', async () => {
    const file = writeTranscript([
      userMsg('first question', '2026-01-01T00:01:00.000Z'),
      assistantMsg('an answer', '2026-01-01T00:02:00.000Z'),
      // A tool result is counted, but must NOT move `modified`: the old
      // whole-file parser skipped non-user/assistant roles for the timestamp,
      // and the sidebar's ordering depends on that.
      toolResultMsg('tool output', '2026-06-01T00:00:00.000Z'),
      { type: 'session_info', name: 'my session' },
    ]);
    const info = await readSessionListingInfo(file, new Date('2020-01-01T00:00:00.000Z'));
    expect(info).not.toBeNull();
    expect(info!.messageCount).toBe(3);
    expect(info!.firstMessage).toBe('first question');
    expect(info!.name).toBe('my session');
    expect(info!.modified.toISOString()).toBe('2026-01-01T00:02:00.000Z');
    expect(info!.created.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('falls back to the file mtime when no message carries text', async () => {
    const mtime = new Date('2021-05-05T00:00:00.000Z');
    const file = writeTranscript([toolResultMsg('only a tool result')]);
    const info = await readSessionListingInfo(file, mtime);
    expect(info!.modified.toISOString()).toBe(mtime.toISOString());
    expect(info!.firstMessage).toBe('(no messages)');
  });

  it('collapses whitespace and caps the preview', async () => {
    const file = writeTranscript([userMsg('a\n\n   b   ' + 'x'.repeat(400))]);
    const info = await readSessionListingInfo(file, new Date());
    expect(info!.firstMessage.length).toBe(161);
    expect(info!.firstMessage.startsWith('a b x')).toBe(true);
    expect(info!.firstMessage.endsWith('\u2026')).toBe(true);
  });

  it('skips malformed lines and rejects a file with no session header', async () => {
    const file = path.join(dir, 'broken.jsonl');
    fs.writeFileSync(
      file,
      JSON.stringify({ type: 'session', id: 'b', cwd: '/tmp/b', timestamp: '2026-01-01T00:00:00.000Z' }) +
        '\nnot json at all\n' +
        JSON.stringify(userMsg('still counted')) +
        '\n',
    );
    const info = await readSessionListingInfo(file, new Date());
    expect(info!.messageCount).toBe(1);
    expect(info!.firstMessage).toBe('still counted');

    const headerless = path.join(dir, 'headerless.jsonl');
    fs.writeFileSync(headerless, JSON.stringify(userMsg('orphan')) + '\n');
    expect(await readSessionListingInfo(headerless, new Date())).toBeNull();
  });

  it('stays bounded on a large transcript (never materializes the file)', async () => {
    // ~40 MB of tool results: the shape that used to cost hundreds of MB of
    // retained parsed objects per file during the listing scan.
    const lines: unknown[] = [userMsg('start')];
    for (let i = 0; i < 40; i++) lines.push(toolResultMsg('y'.repeat(1_000_000)));
    const file = writeTranscript(lines);

    global.gc?.();
    const before = process.memoryUsage().heapUsed;
    const info = await readSessionListingInfo(file, new Date());
    global.gc?.();
    const after = process.memoryUsage().heapUsed;

    expect(info!.messageCount).toBe(41);
    expect(info!.firstMessage).toBe('start');
    // Nothing from the body is retained: the listing keeps a preview and a few
    // numbers. Generous bound, but a whole-file parse would blow far past it.
    expect(after - before).toBeLessThan(8 * 1024 * 1024);
    // Explicit generous timeout: this case writes and reads tens of MB, so under
    // a loaded full-suite run it can exceed vitest's default 5s. What it asserts
    // is MEMORY, not elapsed time, so the limit is not part of the property and
    // raising it weakens nothing -- it only stops the guard going red for a
    // reason unrelated to what it guards.
  }, 60_000);

  it('does not depend on the probe recognising a line: an unusual key order still counts', async () => {
    // The fast path keys off pi writing `type` first. A transcript written with
    // a different key order (another pi version, a hand-written file) must not
    // silently lose entries: an unclassifiable head falls back to a real parse.
    const file = path.join(dir, 'oddorder.jsonl');
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: 'session', id: 'odd', cwd: '/tmp/odd', timestamp: '2026-01-01T00:00:00.000Z' }),
        JSON.stringify({ id: 'm1', timestamp: '2026-01-01T00:05:00.000Z', type: 'message', message: { role: 'user', content: 'keys out of order' } }),
        JSON.stringify({ id: 'm2', type: 'message', timestamp: '2026-01-01T00:06:00.000Z', message: { role: 'toolResult', toolName: 'read', content: 'x' } }),
        JSON.stringify({ name: 'odd name', type: 'session_info' }),
      ].join('\n') + '\n',
    );
    const info = await readSessionListingInfo(file, new Date());
    expect(info!.messageCount).toBe(2);
    expect(info!.firstMessage).toBe('keys out of order');
    expect(info!.name).toBe('odd name');
    expect(info!.modified.toISOString()).toBe('2026-01-01T00:05:00.000Z');

    const w = await readTranscriptWindow(file, 60);
    expect(w.totalCount).toBe(2);
    expect(w.messages.map((m) => m.role)).toEqual(['user', 'tool_result']);
  });

  it('counts a truncated trailing message entry', async () => {
    // A session killed mid-write leaves a half-line. The old whole-file parser
    // dropped it (JSON.parse threw); the streaming reader counts it from its
    // head, which is the one deliberate difference in the listing record.
    const file = path.join(dir, 'truncated.jsonl');
    fs.writeFileSync(
      file,
      JSON.stringify({ type: 'session', id: 't', cwd: '/tmp/t', timestamp: '2026-01-01T00:00:00.000Z' }) +
        '\n' +
        JSON.stringify(userMsg('complete one')) +
        '\n' +
        '{"type":"message","id":"x","timestamp":"2026-01-01T00:09:00.000Z","message":{"role":"toolRe',
    );
    const info = await readSessionListingInfo(file, new Date());
    expect(info!.messageCount).toBe(2);
    expect(info!.firstMessage).toBe('complete one');
  });
});

describe('readTranscriptWindow', () => {
  function manyMessages(n: number): unknown[] {
    const out: unknown[] = [];
    for (let i = 0; i < n; i++) out.push(userMsg(`m${i}`, '2026-01-01T00:01:00.000Z', `e${i}`));
    return out;
  }

  it('returns the tail window with total and offset', async () => {
    const file = writeTranscript(manyMessages(100));
    const w = await readTranscriptWindow(file, 10);
    expect(w.totalCount).toBe(100);
    expect(w.offset).toBe(90);
    expect(w.messages).toHaveLength(10);
    expect(w.messages[0].content).toBe('m90');
    expect(w.messages[9].content).toBe('m99');
    expect(w.messages[0].entryId).toBe('e90');
  });

  it('returns an older page for a beforeOffset', async () => {
    const file = writeTranscript(manyMessages(100));
    const w = await readTranscriptWindow(file, 10, 90);
    expect(w.totalCount).toBe(100);
    expect(w.offset).toBe(80);
    expect(w.messages.map((m) => m.content)).toEqual([
      'm80', 'm81', 'm82', 'm83', 'm84', 'm85', 'm86', 'm87', 'm88', 'm89',
    ]);
  });

  it('clamps a beforeOffset past the end and a window at the start', async () => {
    const file = writeTranscript(manyMessages(5));
    const past = await readTranscriptWindow(file, 10, 999);
    expect(past.offset).toBe(0);
    expect(past.messages).toHaveLength(5);

    const head = await readTranscriptWindow(file, 10, 3);
    expect(head.offset).toBe(0);
    expect(head.messages.map((m) => m.content)).toEqual(['m0', 'm1', 'm2']);
  });

  it('handles limit 0 and an empty transcript', async () => {
    const file = writeTranscript(manyMessages(5));
    const none = await readTranscriptWindow(file, 0);
    expect(none.messages).toEqual([]);
    // limit 0 still reports the true total (matching the old slice-based math),
    // so a client asking for "no messages, just the count" gets one.
    expect(none.totalCount).toBe(5);

    const empty = writeTranscript([]);
    const w = await readTranscriptWindow(empty, 10);
    expect(w.totalCount).toBe(0);
    expect(w.messages).toEqual([]);
    expect(w.header?.id).toBe('sess');
  });

  it('expands one assistant entry into thinking/text/toolCall messages', async () => {
    const file = writeTranscript([
      {
        type: 'message',
        timestamp: '2026-01-01T00:02:00.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'hmm' },
            { type: 'text', text: 'here you go' },
            { type: 'toolCall', id: 'tc1', name: 'read', arguments: { path: 'a.txt' } },
          ],
        },
      },
      toolResultMsg('file contents'),
    ]);
    const w = await readTranscriptWindow(file, 60);
    expect(w.messages.map((m) => m.role)).toEqual([
      'thinking', 'assistant', 'tool_call', 'tool_result',
    ]);
    expect(w.messages[2].toolName).toBe('read');
    expect(w.messages[2].content).toBe('{"path":"a.txt"}');
    expect(w.messages[3].toolCallId).toBe('tc1');
  });

  it('reports the last model_change and the header in the same pass', async () => {
    const file = writeTranscript([
      { type: 'model_change', timestamp: '2026-01-01T00:00:01.000Z', provider: 'p1', modelId: 'm1' },
      userMsg('hi'),
      { type: 'model_change', timestamp: '2026-01-01T00:00:02.000Z', provider: 'p2', modelId: 'm2' },
    ]);
    const w = await readTranscriptWindow(file, 60);
    expect(w.model).toBe('p2:m2');
    expect(w.header?.cwd).toBe('/tmp/proj');
  });

  it('costs the same for a deep "load older" page as for the tail', async () => {
    // Regression: the second pass had a lower bound but no UPPER bound, so a
    // page near the START of a big transcript materialized every message from
    // there to EOF and then sliced. That is the `history_page` path, i.e. a user
    // scrolling back through a long session recreating, in miniature, the exact
    // problem this module exists to remove. Measured before the fix on this
    // shape: 87 MB transient for the deep page vs 16 MB for the tail.
    const lines: unknown[] = [];
    for (let i = 0; i < 30; i++) lines.push(toolResultMsg('z'.repeat(1_000_000)));
    const file = writeTranscript(lines);

    const measure = async (beforeOffset?: number) => {
      global.gc?.();
      const start = process.memoryUsage().heapUsed;
      const w = await readTranscriptWindow(file, 3, beforeOffset);
      const peak = process.memoryUsage().heapUsed - start;
      return { w, peak };
    };

    const tail = await measure();
    const deep = await measure(3); // the OLDEST page: 27 MB of file lies after it

    expect(tail.w.messages).toHaveLength(3);
    expect(deep.w.messages).toHaveLength(3);
    expect(deep.w.offset).toBe(0);
    // The deep page must not cost meaningfully more than the tail: its cost is
    // set by the WINDOW, not by how much file happens to follow it.
    expect(deep.peak).toBeLessThan(tail.peak + 10 * 1024 * 1024);
    // See the note on the bounded-transcript case above: a memory assertion, so
    // the wall-clock limit is not part of what is being guarded.
  }, 60_000);

  it('reports the last model_change even when the window stops early', async () => {
    // The window pass stops as soon as the window is full, so header/model/total
    // must come from the counting pass (which always reads the whole file) --
    // otherwise asking for the FIRST page of a session would report whatever
    // model was in use at that point rather than the current one.
    const file = writeTranscript([
      { type: 'model_change', timestamp: '2026-01-01T00:00:01.000Z', provider: 'old', modelId: 'm1' },
      userMsg('one'),
      userMsg('two'),
      userMsg('three'),
      { type: 'model_change', timestamp: '2026-01-01T00:09:00.000Z', provider: 'new', modelId: 'm2' },
    ]);
    const firstPage = await readTranscriptWindow(file, 1, 1);
    expect(firstPage.messages.map((m) => m.content)).toEqual(['one']);
    expect(firstPage.totalCount).toBe(3);
    expect(firstPage.model).toBe('new:m2');
    expect(firstPage.header?.id).toBe('sess');
  });

  it('keeps only the window in memory for a large transcript', async () => {
    // 30 x 1 MB tool results: reading the last 5 messages must not retain the
    // other 25 MB (the old path built a HistoryMessage for EVERY entry first).
    const lines: unknown[] = [];
    for (let i = 0; i < 30; i++) lines.push(toolResultMsg('z'.repeat(1_000_000)));
    const file = writeTranscript(lines);

    global.gc?.();
    const before = process.memoryUsage().heapUsed;
    const w = await readTranscriptWindow(file, 5);
    global.gc?.();
    const after = process.memoryUsage().heapUsed;

    expect(w.totalCount).toBe(30);
    expect(w.messages).toHaveLength(5);
    // 5 retained MB-sized results + transients, nowhere near the whole file.
    expect(after - before).toBeLessThan(20 * 1024 * 1024);
    // Third of the heavy cases: same reasoning as the two above.
  }, 60_000);
});
