<script lang="ts">
	// The assistant's Telegram settings (server/src/telegram-channel.ts): the
	// channel state, the one-time pairing code while unpaired, the paired user,
	// and the re-pair action. Rendered by the page only while the assistant is
	// active and `assistantTelegram.enabled` is set (telegramSectionVisible), so
	// with the assistant or Telegram off nothing of it shows.
	import {onDestroy} from 'svelte';
	import {
		canRepair,
		pairingInstruction,
		requestTelegramRepair,
		type TelegramStatus,
	} from '$lib/core/telegram-settings';
	import {fetchConfig, getBaseUrl, getToken} from '$lib/session-store';
	import CopyButton from './CopyButton.svelte';

	let {status}: {status: TelegramStatus} = $props();

	let busy = $state(false);
	let error = $state('');

	// While waiting for the user to pair (or for the channel to start), refresh
	// the status so the section flips to "paired" once `/pair` arrives.
	let timer: ReturnType<typeof setInterval> | null = null;
	$effect(() => {
		const waiting = status.state === 'unpaired' || status.state === 'starting';
		if (waiting && !timer) {
			timer = setInterval(() => void fetchConfig(), 3000);
		} else if (!waiting && timer) {
			clearInterval(timer);
			timer = null;
		}
	});
	onDestroy(() => {
		if (timer) clearInterval(timer);
	});

	async function repair() {
		if (
			!confirm(
				'Unpair the current Telegram account? A new pairing code will be issued.',
			)
		)
			return;
		busy = true;
		error = '';
		try {
			await requestTelegramRepair({
				baseUrl: getBaseUrl(),
				token: getToken(),
				fetch: (url, init) => fetch(url, init),
			});
			await fetchConfig();
		} catch (err) {
			error = (err as Error).message;
		} finally {
			busy = false;
		}
	}
</script>

<div class="border-t border-brand-border p-4">
	<h3
		class="mb-3 text-xs font-bold tracking-wider text-brand-text-muted uppercase"
	>
		Assistant on Telegram
	</h3>
	{#if status.state === 'disabled' || status.state === 'error'}
		<p class="selectable text-xs text-rose-400">
			Telegram is disabled{'error' in status && status.error
				? `: ${status.error}`
				: ''}.
		</p>
	{:else if status.state === 'starting'}
		<p class="text-xs text-brand-text-muted">Connecting to Telegram…</p>
	{:else if status.state === 'unpaired'}
		<p class="text-xs text-brand-text">Not paired yet.</p>
		{#if status.code}
			<p class="selectable mt-2 text-xs text-brand-text-muted">
				{pairingInstruction(status)}
			</p>
			<div class="mt-1 flex items-center gap-2">
				<!-- `.selectable-all`, not Tailwind's `select-all`: the chrome's
				     unlayered user-select: none beats any layered utility. -->
				<span
					class="selectable-all font-mono text-base tracking-widest text-brand-text"
					>{status.code}</span
				>
				<CopyButton value={status.code} />
				<CopyButton value={`/pair ${status.code}`} label="Copy /pair" />
			</div>
			<p class="mt-1 text-[10px] leading-relaxed text-brand-text-muted">
				The code works once; anyone else writing to the bot is ignored.
			</p>
		{/if}
	{:else if status.state === 'paired'}
		<p class="selectable text-xs text-brand-text">
			Paired with {status.user.name ?? `user ${status.user.id}`}{status.bot
				? ` via ${status.bot}`
				: ''}.
		</p>
		{#if status.user.source === 'config'}
			<p class="mt-1 text-[10px] leading-relaxed text-brand-text-muted">
				Set in the config (assistantTelegram.userId).
			</p>
		{/if}
		{#if canRepair(status)}
			<button
				onclick={repair}
				disabled={busy}
				class="mt-2 rounded border border-brand-border bg-brand-surface-2 px-2 py-1 text-xs text-brand-text transition-colors hover:bg-brand-surface-3 disabled:opacity-50"
			>
				Re-pair
			</button>
		{/if}
	{/if}
	{#if status.state !== 'disabled' && status.state !== 'error' && status.error}
		<p class="selectable mt-1 text-[10px] text-amber-400">{status.error}</p>
	{/if}
	{#if error}
		<p class="selectable mt-1 text-[10px] text-rose-400">{error}</p>
	{/if}
</div>
