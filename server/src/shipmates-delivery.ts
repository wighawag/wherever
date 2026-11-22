/**
 * shipmates' deliveries, as the chat shows them.
 *
 * @shipmates/pi delivers messages into a session as pi custom messages with
 * `customType: 'shipmates'` (@shipmates/pi `session.ts` `payload()`): `content` is
 * shipmates' formatted text (`format.ts` `formatDelivery`, what the model reads)
 * and `details` is `{ids, from, origins}`, one entry per delivered message. pi
 * persists them as `custom_message` entries (a `message` entry with
 * `role: 'custom'`, which @shipmates/pi's reconcile also accepts, is read too)
 * and emits them live as a `message_end` (a wake through
 * `sendMessage(..., {triggerTurn: true})`, or what `before_agent_start`
 * returned) or an `entry_appended` (what `agent_before_settle` / `turn_end`
 * returned). Both readers map them here, so history and live frames agree.
 *
 * They are never user messages: no routing entry (ADR 0014), no Telegram, no
 * fork point, no human input. A client sees them only when it asked
 * (`shipmates=1` on the socket URL), because an older client maps an unknown
 * history role into a bubble of raw text.
 */
import type { HistoryMessage, ShipmatesDeliveryInfo } from './session-types.js';

/** @shipmates/pi's `CUSTOM_TYPE` (its `shared.ts`). */
export const SHIPMATES_CUSTOM_TYPE = 'shipmates';

/** Socket URL parameter a client sets to receive shipmates cards. */
export const SHIPMATES_CARDS_PARAM = 'shipmates';

export function wantsShipmatesCards(params: URLSearchParams): boolean {
  return params.get(SHIPMATES_CARDS_PARAM) === '1';
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c: any) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c: any) => c.text)
    .join('\n');
}

/**
 * A pi custom message (or `custom_message` entry) as a shipmates delivery, or
 * null when it is not one. `details` is read defensively: a transcript written
 * by another @shipmates/pi version may lack a field, and the card then shows what
 * the text says.
 */
export function shipmatesDeliveryOf(
  m: { customType?: unknown; content?: unknown; details?: unknown } | null | undefined,
): { content: string; shipmates: ShipmatesDeliveryInfo } | null {
  if (!m || m.customType !== SHIPMATES_CUSTOM_TYPE) return null;
  const content = textOf(m.content);
  if (!content) return null;
  const d = (m.details && typeof m.details === 'object' ? m.details : {}) as Record<string, unknown>;
  return { content, shipmates: { ids: strings(d.ids), from: strings(d.from), origins: strings(d.origins) } };
}

/** History for a client that did not ask for shipmates cards: without them. */
export function stripShipmatesCards(messages: HistoryMessage[]): HistoryMessage[] {
  return messages.some((m) => m.role === 'shipmates') ? messages.filter((m) => m.role !== 'shipmates') : messages;
}
