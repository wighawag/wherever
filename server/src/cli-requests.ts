/**
 * The server half of the CLI bridge's REQUEST/RESPONSE path (ADR 0016, spec
 * `assistant-session-and-channels`).
 *
 * The `@wherever-dev/pi` extension sends `cli_request {id, op, args}` on its
 * bridge WebSocket and waits for `cli_response {id, ok, result | error}` with the
 * same id. The CALLER is never read from the request: it is the session that
 * connection registered with `cli_register` (index.ts resolves it), so an origin
 * a later op stamps (`assistant_notify`, `assistant_schedule_add`, ...) is
 * server-side truth. A connection that never registered is refused.
 *
 * Ops: `assistant_info`, and the five ops behind the extension's `assistant_*`
 * tool twins (`cli-assistant-tool-twins`): `schedule_add`, `schedule_list`,
 * `schedule_remove`, `set_timezone`, `notify`. Those run the SAME op code as the
 * server's own tools (`assistantCliOps` in assistant-tools.ts) and answer
 * `{ text, details }` (the tool result the twin returns) or an error (the twin's
 * `isError` text). An unknown op answers an error (an OLDER server, which has no
 * `cli_request` case at all, answers nothing, and the extension detects it by
 * timeout).
 */

import { assistantCliOps, type AssistantSessionHooks } from './assistant-tools.js';

/** The calling bridge session, resolved from its registration. */
export interface CliCaller {
  sessionFile: string;
  /** The registered session's id (null when the pool no longer tracks it). */
  sessionId?: string | null;
  /** The registered session's cwd (absent when the pool no longer tracks it). */
  cwd?: string;
}

/** An op implementation. Its return value is the response `result`; a throw answers its message. */
export type CliRequestOp = (args: unknown, caller: CliCaller) => unknown | Promise<unknown>;

export interface CliRequestFrame {
  type: 'cli_request';
  id: string;
  op: string;
  args?: unknown;
}

export type CliResponseFrame =
  | { type: 'cli_response'; id: string; ok: true; result: unknown }
  | { type: 'cli_response'; id: string; ok: false; error: string };

/**
 * What `assistant_info` returns and `assistant_info_changed` pushes.
 * `assistantFolder` is null when the assistant is not ACTIVE on this server
 * (unset, or refused because another server holds the folder lock): the gate is
 * `assistant.active`, as everywhere else in the assistant. `timezone` is the
 * user's current timezone (the scheduler's, see assistant-tools.ts), null when
 * not active; every change of it is pushed as `assistant_info_changed`.
 */
export interface AssistantInfo {
  assistantFolder: string | null;
  timezone?: string | null;
}

export class CliRequestRouter {
  private readonly ops = new Map<string, CliRequestOp>();

  register(op: string, impl: CliRequestOp): void {
    this.ops.set(op, impl);
  }

  /**
   * Answer one request. Null only when the request carries no string id (there
   * is nothing to correlate an answer with). Never throws.
   */
  async handle(msg: Partial<CliRequestFrame>, caller: CliCaller | null): Promise<CliResponseFrame | null> {
    const id = msg?.id;
    if (typeof id !== 'string' || !id) return null;
    const fail = (error: string): CliResponseFrame => ({ type: 'cli_response', id, ok: false, error });
    if (!caller) return fail('cli_request needs a registered CLI bridge session (send cli_register first).');
    const op = typeof msg.op === 'string' ? msg.op : '';
    const impl = this.ops.get(op);
    if (!impl) return fail(`Unknown cli_request op: ${op || '(none)'}`);
    try {
      const result = await impl(msg.args, caller);
      return { type: 'cli_response', id, ok: true, result: result ?? null };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }
}

export interface CliRequestRouterDeps {
  /** The current assistant info (read on every request, so it is never stale). */
  assistantInfo: () => AssistantInfo;
  /**
   * The same hooks the pool gives server sessions (undefined while
   * `assistantFolder` is unset), read on every request. The tool-twin ops answer
   * "not configured" without them, and the lock-state error while not active.
   */
  assistantHooks?: () => AssistantSessionHooks | undefined;
}

/** The router with this server's built-in ops. */
export function createCliRequestRouter(deps: CliRequestRouterDeps): CliRequestRouter {
  const router = new CliRequestRouter();
  router.register('assistant_info', () => deps.assistantInfo());
  for (const op of ASSISTANT_TWIN_OP_NAMES) {
    router.register(op, async (args, caller) => {
      if (!caller.cwd) {
        throw new Error('this CLI session is no longer registered with the wherever server; reconnect and try again');
      }
      const run = assistantCliOps(deps.assistantHooks?.())[op]!;
      const r = await run(args, { sessionId: caller.sessionId ?? null, cwd: caller.cwd, sessionFile: caller.sessionFile });
      if (!r.ok) throw new Error(r.error);
      return { text: r.text, details: r.details };
    });
  }
  return router;
}

/** The ops behind the extension's `assistant_*` tool twins (extension/src/assistant-tool-twins.ts `ASSISTANT_TWIN_OPS`). */
export const ASSISTANT_TWIN_OP_NAMES = ['schedule_add', 'schedule_list', 'schedule_remove', 'set_timezone', 'notify'] as const;

/** The server-to-extension push sent to every connected CLI bridge when the assistant info changes. */
export function assistantInfoChangedFrame(info: AssistantInfo): {
  type: 'assistant_info_changed';
  assistantFolder: string | null;
  timezone: string | null;
} {
  return { type: 'assistant_info_changed', assistantFolder: info.assistantFolder, timezone: info.timezone ?? null };
}
