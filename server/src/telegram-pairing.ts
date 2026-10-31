import crypto from 'node:crypto';

/**
 * Telegram PAIRING, as a pure state machine (spec `assistant-session-and-channels`
 * story 14): only ONE Telegram user may reach the assistant, and whoever finds
 * the bot handle first must not be able to claim it. So, unlike
 * `badlogic/pi-telegram` (which pairs the first `/start`), pairing needs a
 * one-time CODE that only the web UI shows:
 *
 * - UNPAIRED: the server holds a one-time code (in memory, shown in the web
 *   settings). `/pair <code>` with the CURRENT code pairs its sender; the code is
 *   then spent. Everything else, from anyone, including a wrong code and
 *   `/start`, is IGNORED (never answered: an answer would tell a stranger the
 *   bot is live and give a wrong-code oracle).
 * - PAIRED: the effective user is `assistantTelegram.userId` from the config when
 *   set (it WINS over a stored pairing, and no code exists), else the stored
 *   pairing (state dir). Messages from any other user are ignored. From the
 *   paired user, `/start` and `/pair` are REFUSED with a short answer (re-pairing
 *   is an explicit web action); anything else is forwarded to the assistant.
 * - RE-PAIR (web): forget the stored pairing and issue a new code. Refused while
 *   the user id comes from the config (edit the config instead).
 *
 * Only private chats count: a message in a group or channel is ignored, even
 * from the paired user (group chats are out of the spec's scope).
 *
 * The I/O (storing the pairing, sending answers) is the poller's
 * (telegram-channel.ts); this module only decides.
 */

/** A paired Telegram user. In a private chat the chat id equals the user id; both are kept. */
export interface PairedUser {
  userId: string;
  chatId: string;
  /** A display name (`@username`, else the first name), for the web. */
  name?: string;
  pairedAt?: string;
}

export interface PairingState {
  /** `assistantTelegram.userId` from the config, normalized to a string; wins over `stored`. */
  configuredUserId: string | null;
  /** The pairing stored in the state dir. */
  stored: PairedUser | null;
  /** The current one-time code while unpaired (null once spent or while paired). */
  code: string | null;
}

/** An inbound Telegram message, reduced to what pairing needs. */
export interface InboundMessage {
  fromId: string;
  chatId: string;
  chatType: string;
  text: string;
  name?: string;
}

export type InboundDecision =
  /** Drop it, answer nothing. */
  | { kind: 'ignore'; why: string }
  /** The sender just paired with the current code: store `user`, answer `reply`. */
  | { kind: 'pair'; user: PairedUser; reply: string }
  /** The paired user sent a refused command: answer `reply`. */
  | { kind: 'refuse'; reply: string }
  /** The paired user's message: hand it to the assistant. */
  | { kind: 'forward' };

export type EffectivePairing =
  | { kind: 'paired'; userId: string; chatId: string; name?: string; source: 'config' | 'pairing' }
  | { kind: 'unpaired'; code: string | null };

export const ALREADY_PAIRED_REPLY =
  'This bot is already paired. To pair another account, use "Re-pair" in the wherever settings.';
export const PAIRED_REPLY = 'Paired with wherever. Messages you send here now reach your assistant.';
export const CONFIGURED_USER_REPAIR_ERROR =
  'the Telegram user is set in the config (assistantTelegram.userId); change it there instead of re-pairing';

/**
 * The code alphabet: upper-case letters and digits without the look-alikes
 * (0/O, 1/I/L), so it is easy to type on a phone. 8 characters of 31 symbols is
 * ~40 bits, far beyond what a stranger can guess at Telegram's message rate.
 */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 8;

/** A fresh one-time code (`randomBytes` injectable for tests). */
export function generatePairingCode(randomBytes: (n: number) => Uint8Array = crypto.randomBytes): string {
  let out = '';
  // Rejection sampling keeps every symbol equally likely.
  const limit = 256 - (256 % CODE_ALPHABET.length);
  while (out.length < CODE_LENGTH) {
    for (const b of randomBytes(CODE_LENGTH * 2)) {
      if (b >= limit) continue;
      out += CODE_ALPHABET[b % CODE_ALPHABET.length];
      if (out.length === CODE_LENGTH) break;
    }
  }
  return out;
}

/** Normalize a configured user id (number or numeric string); null when unset or invalid. */
export function normalizeUserId(v: unknown): string | null {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v > 0) return String(v);
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return v.trim();
  return null;
}

/** Who is paired, and from where; or the code while unpaired. */
export function effectivePairing(state: PairingState): EffectivePairing {
  if (state.configuredUserId) {
    return { kind: 'paired', userId: state.configuredUserId, chatId: state.configuredUserId, source: 'config' };
  }
  if (state.stored) {
    return { kind: 'paired', userId: state.stored.userId, chatId: state.stored.chatId, name: state.stored.name, source: 'pairing' };
  }
  return { kind: 'unpaired', code: state.code };
}

/** `/cmd@Bot arg ...` -> `{command: 'cmd', arg: 'arg ...'}`; null for non-commands. */
export function parseCommand(text: string): { command: string; arg: string } | null {
  const m = /^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  return { command: m[1]!.toLowerCase(), arg: (m[2] ?? '').trim() };
}

/** Constant-time, case-insensitive code comparison. */
export function codeMatches(given: string, code: string | null): boolean {
  if (!code) return false;
  const a = Buffer.from(given.trim().toUpperCase(), 'utf8');
  const b = Buffer.from(code.toUpperCase(), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Decide what to do with one inbound message. */
export function decideInbound(state: PairingState, msg: InboundMessage, now: () => Date = () => new Date()): InboundDecision {
  if (msg.chatType !== 'private') return { kind: 'ignore', why: `not a private chat (${msg.chatType})` };
  const cmd = parseCommand(msg.text);
  const eff = effectivePairing(state);

  if (eff.kind === 'paired') {
    if (msg.fromId !== eff.userId) return { kind: 'ignore', why: 'not the paired user' };
    if (cmd && (cmd.command === 'start' || cmd.command === 'pair')) return { kind: 'refuse', reply: ALREADY_PAIRED_REPLY };
    return { kind: 'forward' };
  }

  if (cmd?.command === 'pair' && codeMatches(cmd.arg, eff.code)) {
    return {
      kind: 'pair',
      user: { userId: msg.fromId, chatId: msg.chatId, ...(msg.name ? { name: msg.name } : {}), pairedAt: now().toISOString() },
      reply: PAIRED_REPLY,
    };
  }
  return { kind: 'ignore', why: cmd?.command === 'pair' ? 'wrong pairing code' : 'not paired' };
}

/** The state after a successful pairing: stored, code spent. */
export function applyPairing(state: PairingState, user: PairedUser): PairingState {
  return { ...state, stored: user, code: null };
}

/** The web's re-pair: forget the stored pairing and issue `newCode`. Refused with a configured user id. */
export function repair(state: PairingState, newCode: string): { ok: true; state: PairingState } | { ok: false; error: string } {
  if (state.configuredUserId) return { ok: false, error: CONFIGURED_USER_REPAIR_ERROR };
  return { ok: true, state: { ...state, stored: null, code: newCode } };
}

/** The initial state: a code exists only while nothing pairs the bot. */
export function initialPairingState(configuredUserId: string | null, stored: PairedUser | null, newCode: () => string): PairingState {
  return { configuredUserId, stored, code: configuredUserId || stored ? null : newCode() };
}
