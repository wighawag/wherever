/**
 * The Telegram settings section's logic (server `telegram-channel.ts`): whether
 * it shows, what it says, and the re-pair action (`POST /telegram/repair`,
 * token-gated). Framework-free with `fetch` injected, so it is unit-tested with
 * fakes.
 */

/** `GET /config` `assistant.telegram` (only while the assistant is active). */
export type TelegramStatus =
	| {enabled: false; state: 'disabled'}
	| {enabled: true; state: 'disabled'; error: string}
	| {enabled: true; state: 'starting'; bot: string | null; error?: string}
	| {
			enabled: true;
			state: 'unpaired';
			code: string | null;
			bot: string | null;
			error?: string;
	  }
	| {
			enabled: true;
			state: 'paired';
			user: {id: string; name?: string; source: 'config' | 'pairing'};
			bot: string | null;
			error?: string;
	  }
	| {enabled: true; state: 'error'; error: string; bot: string | null};

/**
 * The section shows only while the assistant is active and Telegram is enabled
 * in the config (an enabled Telegram that could not start still shows, with its
 * error).
 */
export function telegramSectionVisible(status: {
	active: boolean;
	telegram?: TelegramStatus;
}): boolean {
	return status.active && !!status.telegram?.enabled;
}

/** The pairing instruction while unpaired. */
export function pairingInstruction(status: TelegramStatus): string | null {
	if (status.state !== 'unpaired' || !status.code) return null;
	return `Send /pair ${status.code} to ${status.bot ?? 'the bot'} on Telegram.`;
}

/** Whether the re-pair action is offered (a pairing made by code; never a configured id). */
export function canRepair(status: TelegramStatus): boolean {
	return status.state === 'paired' && status.user.source === 'pairing';
}

export interface TelegramServerDeps {
	baseUrl: string;
	token: string;
	fetch: (url: string, init?: RequestInit) => Promise<Response>;
}

/** Re-pair: the server forgets the pairing and issues a new code; resolves the new status. */
export async function requestTelegramRepair(
	deps: TelegramServerDeps,
): Promise<TelegramStatus> {
	const qs = deps.token ? `?token=${encodeURIComponent(deps.token)}` : '';
	const res = await deps.fetch(`${deps.baseUrl}/telegram/repair${qs}`, {
		method: 'POST',
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
	return data.telegram as TelegramStatus;
}
