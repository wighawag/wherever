import type { ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent';
import { WEB_ORIGIN, type ReplyOrigin } from './reply-routing.js';

/**
 * Marking human input for kenning (kenning's D22 and ADR 0003, wherever ADR 0023).
 *
 * kenning records a user message as the HUMAN's words (which only then may be
 * relayed as `human-relayed` to satisfy another session's safety gate) when the
 * host emits `kenning:human-input` `{text, channel}` on that session's
 * `pi.events` bus right before sending the text. The bus belongs to one
 * session's resource loader, and no tool can reach it, so the model cannot
 * produce a mark.
 *
 * wherever marks exactly the sends a human typed: a web send (routing origin
 * `none`, ADR 0014) and a Telegram send (`telegram`, `telegram:<sub>`). Never a
 * scheduled job (`schedule:<jobId>`), never anything else. A new pool caller
 * that is not a human MUST pass its own origin, since an omitted origin means a
 * web send.
 */

/**
 * The event kenning-pi listens for: kenning's `HUMAN_INPUT_EVENT` (its
 * `host.ts`), copied so that loading the session pool does not load kenning
 * (and `node:sqlite`) for a user who does not use it. kenning-human-input.test.ts
 * pins it against kenning's constant.
 */
export const HUMAN_INPUT_EVENT = 'kenning:human-input';

export type HumanInputChannel = 'web' | 'telegram';

/** The kenning channel of a routing origin, or null when the send is not a human's. */
export function humanInputChannel(origin: ReplyOrigin | null | undefined): HumanInputChannel | null {
  if (origin === WEB_ORIGIN) return 'web';
  if (origin === 'telegram' || (typeof origin === 'string' && origin.startsWith('telegram:'))) return 'telegram';
  return null;
}

/** The slice of a pi AgentSession `willReachInputEvent` reads. */
export interface InputEventProbe {
  readonly isCompacting: boolean;
  readonly extensionRunner?: { getCommand(name: string): unknown } | undefined;
}

/**
 * Whether pi's `prompt()` will emit the `input` event for this text, which is
 * what consumes a mark. A mark it never consumes stays in kenning-pi's queue
 * and could later match the identical text from a scheduled job, so wherever
 * does not mark a send pi will not pass to `input`: one an extension command
 * handles (`/name ...` with `expandPromptTemplates`, before `input`), or one
 * made while compacting (refused before `input`; auto-compaction is counted
 * too, the safe side). A residue remains: another extension's `input` handler
 * that returns `handled` before kenning-pi's (ADR 0023).
 */
export function willReachInputEvent(session: InputEventProbe, text: string): boolean {
  if (session.isCompacting) return false;
  if (text.startsWith('/')) {
    const space = text.indexOf(' ');
    const name = space === -1 ? text.slice(1) : text.slice(1, space);
    if (session.extensionRunner?.getCommand(name)) return false;
  }
  return true;
}

/** One server session's way onto its own `pi.events` bus. */
export interface HumanInputMarker {
  /** The inline extension that captures the session's bus (one per agent build). */
  inlineExtension: InlineExtension;
  /** Emit the mark. A no-op until the extension was loaded. */
  mark(text: string, channel: HumanInputChannel): void;
}

/**
 * Built per server agent (buildServerAgent), like the conversation-mode signal,
 * so a mark can never reach another session's bus. The extension registers
 * nothing the model sees: it only keeps a reference to `pi.events`.
 */
export function createHumanInputMarker(): HumanInputMarker {
  let events: ExtensionAPI['events'] | null = null;
  return {
    inlineExtension: {
      name: 'wherever-human-input',
      factory: (pi: ExtensionAPI) => {
        events = pi.events;
      },
    },
    mark(text, channel) {
      events?.emit(HUMAN_INPUT_EVENT, { text, channel });
    },
  };
}
