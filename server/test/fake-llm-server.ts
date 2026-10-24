import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A fake Anthropic-Messages LLM server (ADR 0001).
 *
 * The real `pi` harness (via @earendil-works/pi-ai's anthropic provider) POSTs
 * to `<baseUrl>/v1/messages` and consumes a standard SSE stream. By pointing a
 * `models.json` provider's `baseUrl` at this server (api: "anthropic-messages")
 * and launching the wherever server with PI_CODING_AGENT_DIR set to that
 * isolated agent dir, pi talks to THIS server believing it is a real model.
 *
 * This gives deterministic, free, offline agent turns AND -- crucially -- lets us
 * reproduce transport-level failures the code-level seam never could, e.g. the
 * "pi stops midway" bug: just cut the SSE stream off mid-response.
 */

export type FakeBehavior =
  | { kind: 'reply'; text: string }
  // Stream `text`, flush `cutAfter` characters, then DESTROY the socket
  // mid-stream (no content_block_stop / message_stop). Reproduces a truncated
  // upstream response -- the "pi stops midway" class of bug.
  | { kind: 'cut-midway'; text: string; cutAfter: number }
  // Stream `text` one char every `charDelayMs` ms (default slow), so a test has
  // a wide, deterministic window to submit a second message MID-TURN and observe
  // how the server delivers it (steer vs followUp). Finishes normally.
  | { kind: 'slow-reply'; text: string; charDelayMs?: number }
  // Emit a single tool_use block (stop_reason: tool_use) so the agent actually
  // EXECUTES a tool. Used to reproduce a tool call that is IN FLIGHT (e.g. a
  // `bash` running `sleep`) when a test takes an action mid-execution. The tool
  // name + input are provided by the test; a long-running command gives a wide,
  // deterministic window while the tool_execution_start/end pair straddles it.
  | { kind: 'tool-call'; toolName: string; input: Record<string, unknown>; toolCallId?: string }
  // Emit MULTIPLE tool_use blocks in one assistant message (stop_reason:
  // tool_use), so the agent runs several tools in PARALLEL. Used to reproduce
  // how an abort mid-execution settles each of several concurrent tool calls.
  | { kind: 'tool-calls'; calls: Array<{ toolName: string; input: Record<string, unknown>; toolCallId?: string }> };

export interface FakeLlmServer {
  server: Server;
  url: string;
  /** Set the behavior for the NEXT /v1/messages call. */
  setNext(behavior: FakeBehavior): void;
  /**
   * Every /v1/messages request body seen so far, parsed. This is how a test can
   * assert what actually reached the model, e.g. the `system` prompt for a turn
   * (used by the conversation-mode injection tests).
   */
  requests(): Array<Record<string, any>>;
  close(): Promise<void>;
}

function sse(res: import('node:http').ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export async function startFakeLlmServer(
  initial: FakeBehavior = { kind: 'reply', text: 'ok' },
): Promise<FakeLlmServer> {
  let next: FakeBehavior = initial;
  const requests: Array<Record<string, any>> = [];

  const server = createServer((req, res) => {
    // Match the PATH only: pi >= 1.x's Anthropic client posts to
    // `/v1/messages?beta=true`.
    const pathname = new URL(req.url ?? '/', 'http://fake').pathname;
    if (!pathname.endsWith('/v1/messages') || req.method !== 'POST') {
      res.writeHead(404).end('not found');
      return;
    }
    // Consume the request body. Besides being mandatory, keeping it lets tests
    // assert what pi actually sent upstream (system prompt, messages, tools).
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        requests.push(JSON.parse(body));
      } catch {
        // A non-JSON body is not something any test asserts on; ignore it.
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      const behavior = next;

      // Tool-call behavior: emit one tool_use block and end with stop_reason
      // tool_use, so pi executes the tool. The tool's own runtime (e.g. a
      // `sleep`) provides the in-flight window; no per-char streaming needed.
      if (behavior.kind === 'tool-call') {
        sse(res, 'message_start', {
          type: 'message_start',
          message: {
            id: 'msg_fake_tool',
            type: 'message',
            role: 'assistant',
            model: 'fake',
            content: [],
            stop_reason: null,
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        });
        sse(res, 'content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'tool_use',
            id: behavior.toolCallId ?? 'toolu_fake_1',
            name: behavior.toolName,
            input: {},
          },
        });
        // pi's anthropic provider builds tool arguments from input_json_delta
        // (partial_json), not from content_block.input, so the JSON must be
        // streamed as a delta here.
        sse(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(behavior.input) },
        });
        sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
        sse(res, 'message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use' },
          usage: { output_tokens: 1 },
        });
        sse(res, 'message_stop', { type: 'message_stop' });
        res.end();
        return;
      }

      // Multiple parallel tool_use blocks in one message.
      if (behavior.kind === 'tool-calls') {
        sse(res, 'message_start', {
          type: 'message_start',
          message: {
            id: 'msg_fake_tools',
            type: 'message',
            role: 'assistant',
            model: 'fake',
            content: [],
            stop_reason: null,
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        });
        behavior.calls.forEach((call, i) => {
          sse(res, 'content_block_start', {
            type: 'content_block_start',
            index: i,
            content_block: {
              type: 'tool_use',
              id: call.toolCallId ?? `toolu_fake_${i + 1}`,
              name: call.toolName,
              input: {},
            },
          });
          sse(res, 'content_block_delta', {
            type: 'content_block_delta',
            index: i,
            delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) },
          });
          sse(res, 'content_block_stop', { type: 'content_block_stop', index: i });
        });
        sse(res, 'message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use' },
          usage: { output_tokens: 1 },
        });
        sse(res, 'message_stop', { type: 'message_stop' });
        res.end();
        return;
      }

      const text = behavior.text;
      const charDelayMs = behavior.kind === 'slow-reply' ? (behavior.charDelayMs ?? 40) : 2;

      sse(res, 'message_start', {
        type: 'message_start',
        message: {
          id: 'msg_fake',
          type: 'message',
          role: 'assistant',
          model: 'fake',
          content: [],
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      });
      sse(res, 'content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      });

      const cutAt = behavior.kind === 'cut-midway' ? behavior.cutAfter : text.length;
      let i = 0;
      const tick = setInterval(() => {
        if (i < text.length && i < cutAt) {
          sse(res, 'content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: text[i++] },
          });
          return;
        }
        clearInterval(tick);

        if (behavior.kind === 'cut-midway') {
          // Hang up mid-stream WITHOUT the terminating events. This is what an
          // upstream model dropping the connection looks like to pi.
          res.destroy();
          return;
        }

        sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
        sse(res, 'message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: text.length },
        });
        sse(res, 'message_stop', { type: 'message_stop' });
        res.end();
      }, charDelayMs);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    server,
    url: `http://127.0.0.1:${port}`,
    setNext(behavior) {
      next = behavior;
    },
    requests() {
      return requests;
    },
    close() {
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
