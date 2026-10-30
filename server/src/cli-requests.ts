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
 * This module implements ONE op, `assistant_info`; `cli-assistant-tool-twins`
 * registers the tool ops on the same router. An unknown op answers an error (an
 * OLDER server, which has no `cli_request` case at all, answers nothing, and the
 * extension detects it by timeout).
 */

/** The calling bridge session, resolved from its registration. */
export interface CliCaller {
  sessionFile: string;
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
 * `assistant.active`, as everywhere else in the assistant. `timezone` (the user's
 * current timezone) is filled in by `assistant-schedule-tools-server`.
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
}

/** The router with this server's built-in ops. */
export function createCliRequestRouter(deps: CliRequestRouterDeps): CliRequestRouter {
  const router = new CliRequestRouter();
  router.register('assistant_info', () => deps.assistantInfo());
  return router;
}

/** The server-to-extension push sent to every connected CLI bridge when the assistant info changes. */
export function assistantInfoChangedFrame(info: AssistantInfo): {
  type: 'assistant_info_changed';
  assistantFolder: string | null;
  timezone: string | null;
} {
  return { type: 'assistant_info_changed', assistantFolder: info.assistantFolder, timezone: info.timezone ?? null };
}
