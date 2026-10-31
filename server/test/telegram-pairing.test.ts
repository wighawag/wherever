import { describe, it, expect } from 'vitest';
import {
  ALREADY_PAIRED_REPLY,
  CODE_ALPHABET,
  CODE_LENGTH,
  CONFIGURED_USER_REPAIR_ERROR,
  applyPairing,
  codeMatches,
  decideInbound,
  effectivePairing,
  generatePairingCode,
  initialPairingState,
  normalizeUserId,
  parseCommand,
  repair,
  type InboundMessage,
  type PairingState,
} from '../src/telegram-pairing.ts';

/** The pairing state machine (pure): who may reach the assistant on Telegram. */

const msg = (fromId: string, text: string, extra: Partial<InboundMessage> = {}): InboundMessage => ({
  fromId,
  chatId: fromId,
  chatType: 'private',
  text,
  ...extra,
});

const unpaired = (code = 'ABCD2345'): PairingState => ({ configuredUserId: null, stored: null, code });

describe('generatePairingCode', () => {
  it('is CODE_LENGTH symbols of the unambiguous alphabet, and differs between calls', () => {
    const a = generatePairingCode();
    expect(a).toHaveLength(CODE_LENGTH);
    for (const ch of a) expect(CODE_ALPHABET).toContain(ch);
    expect(new Set(Array.from({ length: 20 }, () => generatePairingCode())).size).toBeGreaterThan(1);
  });

  it('rejects biased bytes', () => {
    // 248..255 are above the rejection limit for a 31-symbol alphabet.
    let calls = 0;
    const code = generatePairingCode((n) => {
      calls++;
      return calls === 1 ? new Uint8Array(n).fill(255) : new Uint8Array(n).fill(0);
    });
    expect(code).toBe('A'.repeat(CODE_LENGTH));
  });
});

describe('parseCommand / codeMatches / normalizeUserId', () => {
  it('parses commands, with an optional @bot suffix', () => {
    expect(parseCommand('/pair abc')).toEqual({ command: 'pair', arg: 'abc' });
    expect(parseCommand('/PAIR@MyBot  abc ')).toEqual({ command: 'pair', arg: 'abc' });
    expect(parseCommand('/start')).toEqual({ command: 'start', arg: '' });
    expect(parseCommand('hello /pair x')).toBeNull();
  });

  it('matches the code case-insensitively, and never a null code', () => {
    expect(codeMatches('abcd2345', 'ABCD2345')).toBe(true);
    expect(codeMatches('ABCD2346', 'ABCD2345')).toBe(false);
    expect(codeMatches('ABCD234', 'ABCD2345')).toBe(false);
    expect(codeMatches('', null)).toBe(false);
  });

  it('normalizes a configured user id', () => {
    expect(normalizeUserId(42)).toBe('42');
    expect(normalizeUserId(' 42 ')).toBe('42');
    expect(normalizeUserId('abc')).toBeNull();
    expect(normalizeUserId(undefined)).toBeNull();
    expect(normalizeUserId(-1)).toBeNull();
  });
});

describe('decideInbound while unpaired', () => {
  it('pairs the sender of the CURRENT code, and the code is then spent', () => {
    const d = decideInbound(unpaired(), msg('7', '/pair abcd2345', { name: '@me' }), () => new Date('2026-01-01T00:00:00Z'));
    expect(d).toEqual({
      kind: 'pair',
      user: { userId: '7', chatId: '7', name: '@me', pairedAt: '2026-01-01T00:00:00.000Z' },
      reply: expect.any(String),
    });
    if (d.kind !== 'pair') throw new Error('unreachable');
    const after = applyPairing(unpaired(), d.user);
    expect(after.code).toBeNull();
    expect(effectivePairing(after)).toMatchObject({ kind: 'paired', userId: '7', source: 'pairing' });
    // The spent code no longer pairs anyone else.
    expect(decideInbound(after, msg('8', '/pair ABCD2345')).kind).toBe('ignore');
  });

  it('ignores a wrong code, /start, plain text and a missing code', () => {
    for (const text of ['/pair WRONG123', '/start', 'hello', '/pair']) {
      expect(decideInbound(unpaired(), msg('7', text)).kind).toBe('ignore');
    }
    expect(decideInbound({ ...unpaired(), code: null }, msg('7', '/pair ABCD2345')).kind).toBe('ignore');
  });

  it('ignores the right code sent outside a private chat', () => {
    expect(decideInbound(unpaired(), msg('7', '/pair ABCD2345', { chatId: '-100', chatType: 'group' })).kind).toBe('ignore');
  });
});

describe('decideInbound while paired', () => {
  const paired: PairingState = { configuredUserId: null, stored: { userId: '7', chatId: '7' }, code: null };

  it('forwards the paired user, refuses /start and /pair, ignores everyone else', () => {
    expect(decideInbound(paired, msg('7', 'what is the weather'))).toEqual({ kind: 'forward' });
    expect(decideInbound(paired, msg('7', '/start'))).toEqual({ kind: 'refuse', reply: ALREADY_PAIRED_REPLY });
    expect(decideInbound(paired, msg('7', '/pair ABCD2345'))).toEqual({ kind: 'refuse', reply: ALREADY_PAIRED_REPLY });
    expect(decideInbound(paired, msg('8', 'hi')).kind).toBe('ignore');
    expect(decideInbound(paired, msg('8', '/pair ABCD2345')).kind).toBe('ignore');
  });

  it('the configured user id wins over a stored pairing', () => {
    const s: PairingState = { configuredUserId: '99', stored: { userId: '7', chatId: '7' }, code: null };
    expect(effectivePairing(s)).toEqual({ kind: 'paired', userId: '99', chatId: '99', source: 'config' });
    expect(decideInbound(s, msg('99', 'hi')).kind).toBe('forward');
    expect(decideInbound(s, msg('7', 'hi')).kind).toBe('ignore');
  });
});

describe('initial state and re-pair', () => {
  it('a code exists only while nothing pairs the bot', () => {
    expect(initialPairingState(null, null, () => 'C0DE').code).toBe('C0DE');
    expect(initialPairingState('5', null, () => 'C0DE').code).toBeNull();
    expect(initialPairingState(null, { userId: '7', chatId: '7' }, () => 'C0DE').code).toBeNull();
  });

  it('re-pair forgets the stored pairing and issues the new code', () => {
    const r = repair({ configuredUserId: null, stored: { userId: '7', chatId: '7' }, code: null }, 'NEWCODE2');
    expect(r).toEqual({ ok: true, state: { configuredUserId: null, stored: null, code: 'NEWCODE2' } });
    if (!r.ok) throw new Error('unreachable');
    expect(decideInbound(r.state, msg('7', 'hi')).kind).toBe('ignore');
    expect(decideInbound(r.state, msg('8', '/pair newcode2')).kind).toBe('pair');
  });

  it('re-pair is refused while the user id comes from the config', () => {
    expect(repair({ configuredUserId: '5', stored: null, code: null }, 'X')).toEqual({ ok: false, error: CONFIGURED_USER_REPAIR_ERROR });
  });
});
