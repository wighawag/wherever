import {describe, it, expect} from 'vitest';
import {
	canRepair,
	pairingInstruction,
	requestTelegramRepair,
	telegramSectionVisible,
	type TelegramStatus,
} from './telegram-settings';

// The Telegram settings section: shown only while the assistant is active and
// Telegram is enabled; the pairing code instruction; the re-pair action.

const unpaired: TelegramStatus = {
	enabled: true,
	state: 'unpaired',
	code: 'ABCD2345',
	bot: '@my_bot',
};
const paired = (source: 'config' | 'pairing'): TelegramStatus => ({
	enabled: true,
	state: 'paired',
	user: {id: '7', name: '@me', source},
	bot: '@my_bot',
});

describe('telegramSectionVisible', () => {
	it('is hidden while the assistant is off, or Telegram is not enabled', () => {
		expect(telegramSectionVisible({active: false, telegram: unpaired})).toBe(
			false,
		);
		expect(telegramSectionVisible({active: true})).toBe(false);
		expect(
			telegramSectionVisible({
				active: true,
				telegram: {enabled: false, state: 'disabled'},
			}),
		).toBe(false);
	});

	it('shows while enabled, including an enabled Telegram that could not start', () => {
		expect(telegramSectionVisible({active: true, telegram: unpaired})).toBe(
			true,
		);
		expect(
			telegramSectionVisible({
				active: true,
				telegram: {enabled: true, state: 'disabled', error: 'no token'},
			}),
		).toBe(true);
	});
});

describe('pairingInstruction / canRepair', () => {
	it('tells the user what to send while unpaired', () => {
		expect(pairingInstruction(unpaired)).toBe(
			'Send /pair ABCD2345 to @my_bot on Telegram.',
		);
		expect(pairingInstruction({...unpaired, bot: null})).toBe(
			'Send /pair ABCD2345 to the bot on Telegram.',
		);
		expect(pairingInstruction(paired('pairing'))).toBeNull();
	});

	it('offers re-pair only for a pairing made by code', () => {
		expect(canRepair(paired('pairing'))).toBe(true);
		expect(canRepair(paired('config'))).toBe(false);
		expect(canRepair(unpaired)).toBe(false);
	});
});

describe('requestTelegramRepair', () => {
	it('POSTs the token-gated route and returns the new status', async () => {
		const calls: Array<{url: string; method?: string}> = [];
		const status = await requestTelegramRepair({
			baseUrl: 'https://me.example',
			token: 'sek ret',
			fetch: async (url, init) => {
				calls.push({url, method: init?.method});
				return new Response(
					JSON.stringify({ok: true, telegram: {...unpaired, code: 'NEWCODE2'}}),
					{status: 200},
				);
			},
		});
		expect(calls).toEqual([
			{
				url: 'https://me.example/telegram/repair?token=sek%20ret',
				method: 'POST',
			},
		]);
		expect(status).toMatchObject({state: 'unpaired', code: 'NEWCODE2'});
	});

	it('throws the server error', async () => {
		await expect(
			requestTelegramRepair({
				baseUrl: '',
				token: '',
				fetch: async () =>
					new Response(JSON.stringify({error: 'set in the config'}), {
						status: 409,
					}),
			}),
		).rejects.toThrow('set in the config');
	});
});
