<script lang="ts">
	/**
	 * kenning's attention inbox (wherever ADR 0023): the questions sessions
	 * raised for the human (`human_ask`), blocking ones first. Answering here is
	 * a HUMAN act: the server records it as the human's answer (channel `web`)
	 * and delivers it to the asking session, which may be waiting on it.
	 *
	 * The inbox is live (`kenning_update` frames): an item answered elsewhere
	 * (a terminal, Telegram, another device) disappears here on its own.
	 */
	import {kenningStore} from '$lib/session-store';
	import {answerKenningItem} from '$lib/wherever';
	import type {KenningInboxItem} from '$lib/core/kenning';

	let {onOpened}: {onOpened?: () => void} = $props();

	let drafts = $state<Record<string, string>>({});
	let sending = $state<Record<string, boolean>>({});
	let errors = $state<Record<string, string>>({});

	async function answer(item: KenningInboxItem, text: string) {
		const trimmed = text.trim();
		if (!trimmed || sending[item.id]) return;
		sending[item.id] = true;
		errors[item.id] = '';
		const r = await answerKenningItem(item.id, trimmed);
		sending[item.id] = false;
		if (r.ok) drafts[item.id] = '';
		else errors[item.id] = r.error;
	}

	function openAsker(item: KenningInboxItem) {
		if (!item.sessionId) return;
		// The page's hashchange handler opens it, as a notification tap does.
		window.location.hash = encodeURIComponent(item.sessionId);
		onOpened?.();
	}

	function ago(ms: number): string {
		const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
		if (s < 60) return 'just now';
		if (s < 3600) return `${Math.round(s / 60)} min ago`;
		if (s < 86400) return `${Math.round(s / 3600)} h ago`;
		return `${Math.round(s / 86400)} d ago`;
	}
</script>

<div class="flex h-full flex-col overflow-y-auto">
	{#if $kenningStore.inbox.length === 0}
		<div class="p-3 text-xs text-brand-text-muted">
			Nothing needs you right now. Questions sessions raise with
			<code class="text-brand-blue">human_ask</code> show up here.
		</div>
	{:else}
		{#each $kenningStore.inbox as item (item.id)}
			<div class="border-b border-brand-border/30 px-3 py-2">
				<div
					class="flex items-center gap-1.5 text-[10px] text-brand-text-muted"
				>
					{#if item.blocking}
						<span
							class="rounded bg-amber-500/20 px-1 text-amber-400"
							title="The session is waiting for this answer">waiting</span
						>
					{/if}
					<button
						type="button"
						class="truncate hover:text-brand-text disabled:cursor-default disabled:hover:text-brand-text-muted"
						disabled={!item.sessionId}
						title={item.sessionId
							? 'Open the asking session'
							: item.sessionFile}
						onclick={() => openAsker(item)}>{item.from} →</button
					>
					{#if item.onBehalfOf > 0}
						<span title="This question merges questions from other sessions"
							>(for {item.onBehalfOf})</span
						>
					{/if}
					<span class="ml-auto flex-shrink-0">{ago(item.createdAt)}</span>
				</div>
				<div
					class="selectable mt-1 text-xs whitespace-pre-wrap text-brand-text"
				>
					{item.question}
				</div>
				{#if item.options?.length}
					<div class="mt-1.5 flex flex-wrap gap-1">
						{#each item.options as option (option)}
							<button
								type="button"
								disabled={sending[item.id]}
								onclick={() => answer(item, option)}
								class="rounded border border-brand-border bg-brand-surface-2 px-2 py-0.5 text-xs text-brand-text transition-colors hover:bg-brand-surface-3 disabled:opacity-50"
								>{option}</button
							>
						{/each}
					</div>
				{/if}
				<form
					class="mt-1.5 flex gap-1.5"
					onsubmit={(e) => {
						e.preventDefault();
						void answer(item, drafts[item.id] ?? '');
					}}
				>
					<input
						type="text"
						bind:value={drafts[item.id]}
						placeholder={item.options?.length
							? 'or type an answer'
							: 'your answer'}
						class="min-w-0 flex-1 rounded border border-brand-border bg-brand-surface-2 px-2 py-1 text-xs text-brand-text placeholder-brand-text-muted focus:border-brand-blue focus:outline-none"
					/>
					<button
						type="submit"
						disabled={sending[item.id] || !(drafts[item.id] ?? '').trim()}
						class="rounded border border-brand-border bg-brand-surface-2 px-2 py-1 text-xs text-brand-text transition-colors hover:bg-brand-surface-3 disabled:opacity-50"
						>{sending[item.id] ? '…' : 'Answer'}</button
					>
				</form>
				{#if errors[item.id]}
					<div class="selectable mt-1 text-[10px] text-rose-400">
						{errors[item.id]}
					</div>
				{/if}
			</div>
		{/each}
	{/if}
</div>
