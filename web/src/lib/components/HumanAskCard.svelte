<script lang="ts">
	/**
	 * A `human_ask` tool call as a first-class card in the chat: the question
	 * the agent asked, its options as buttons and an answer field. Answering
	 * here is the same human act as in the Needs you inbox (`shipmates_answer`,
	 * channel `web`), so the waiting tool returns the answer and the item leaves
	 * every inbox. Once answered, the card shows the answer instead.
	 *
	 * Which inbox item the call raised, and what its result says, are pure
	 * (core/human-ask-card.ts).
	 */
	import type {HumanAskArgs, HumanAskCardState} from '$lib/core/human-ask-card';
	import {humanAskCardState} from '$lib/core/human-ask-card';
	import {renderMarkdown} from '$lib/core/utils/markdown';
	import {openReader} from '$lib/core/shipmates-reader';
	import {shipmatesStore} from '$lib/session-store';
	import {
		activeSessionInfo,
		answerShipmatesItem,
		isReadOnly,
	} from '$lib/wherever';

	let {
		args,
		isStreaming,
		isError,
		output,
		interrupted = false,
	}: {
		args: HumanAskArgs;
		isStreaming: boolean;
		isError: boolean;
		output: string;
		/** Ended with no result (e.g. a server restart): its item may still be open in Needs you. */
		interrupted?: boolean;
	} = $props();

	const fromTool = $derived(
		humanAskCardState({
			args,
			isStreaming,
			isError,
			output,
			inbox: $shipmatesStore.inbox,
			sessionId: $activeSessionInfo.sessionId ?? null,
			sessionFile: $activeSessionInfo.sessionFile ?? null,
		}),
	);
	const html = $derived(renderMarkdown(args.question));

	let draft = $state('');
	let sending = $state(false);
	let error = $state('');
	/** The answer sent from this card: shown until the tool's result says so (the item leaves the inbox first). */
	let sent = $state<string | null>(null);

	const card = $derived<HumanAskCardState>(
		fromTool.kind !== 'answered' &&
			sent !== null &&
			(fromTool.kind === 'waiting' || fromTool.kind === 'closed')
			? {kind: 'answered', answer: sent, where: 'on web'}
			: fromTool,
	);

	async function answer(text: string) {
		const trimmed = text.trim();
		if (!trimmed || sending || card.kind !== 'open') return;
		sending = true;
		error = '';
		const r = await answerShipmatesItem(card.item.id, trimmed);
		sending = false;
		if (r.ok) {
			draft = '';
			sent = trimmed;
		} else error = r.error;
	}

	const canAnswer = $derived(card.kind === 'open' && !$isReadOnly);
</script>

<div
	class="flex max-w-full min-w-[240px] flex-col gap-2 rounded-lg border px-3 py-2.5 text-brand-text {card.kind ===
		'open' || card.kind === 'waiting'
		? 'border-amber-400/50 bg-amber-500/10'
		: card.kind === 'error'
			? 'border-rose-400/40 bg-rose-400/10'
			: 'border-brand-border bg-brand-surface-2'}"
	data-human-ask-card={card.kind}
>
	<div
		class="flex items-center gap-1.5 text-[11px] font-semibold tracking-wide uppercase select-none {card.kind ===
			'open' || card.kind === 'waiting'
			? 'text-amber-300'
			: 'text-brand-text-muted'}"
	>
		<span aria-hidden="true" class="text-base leading-none normal-case">🙋</span
		>
		{#if card.kind === 'open' || card.kind === 'waiting'}
			<span
				>{args.blocking ? 'Waiting for your answer' : 'Question for you'}</span
			>
		{:else if card.kind === 'answered'}
			<span>Answered</span>
		{:else if card.kind === 'withdrawn'}
			<span>Withdrawn</span>
		{:else if card.kind === 'error'}
			<span class="text-rose-300">Could not ask</span>
		{:else if interrupted}
			<span title="The call ended without a result">Interrupted</span>
		{:else}
			<span>Question</span>
		{/if}
		{#if card.kind === 'open'}
			<button
				type="button"
				class="ml-auto rounded px-1 text-brand-text-muted normal-case hover:text-brand-text"
				title="Read it large in Needs you"
				onclick={() => card.kind === 'open' && openReader(card.item.id)}
				>⤢</button
			>
		{/if}
	</div>

	{#if html}
		<!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized via DOMPurify in renderMarkdown -->
		<div class="chat-selectable markdown-body text-sm leading-relaxed">
			{@html html}
		</div>
	{:else}
		<div class="chat-selectable text-sm leading-relaxed whitespace-pre-wrap">
			{args.question}
		</div>
	{/if}

	{#if card.kind === 'answered'}
		<div class="flex flex-col gap-0.5 border-t border-brand-border/60 pt-2">
			<span class="text-[11px] text-brand-text-muted"
				>Your answer{card.where ? `, ${card.where}` : ''}:</span
			>
			<span class="chat-selectable text-sm wrap-anywhere whitespace-pre-wrap"
				>{card.answer}</span
			>
		</div>
	{:else if card.kind === 'error'}
		{#if output}
			<span class="text-xs break-words text-brand-text-muted">{output}</span>
		{/if}
	{:else if card.kind === 'open' || card.kind === 'waiting'}
		{#if args.options.length}
			<div class="flex flex-wrap gap-1.5">
				{#each args.options as option, i (i)}
					<button
						type="button"
						disabled={!canAnswer || sending}
						onclick={() => answer(option)}
						class="rounded-md border border-brand-border bg-brand-surface-2 px-2.5 py-1 text-sm text-brand-text transition-colors hover:bg-brand-surface-3 disabled:opacity-50"
						>{option}</button
					>
				{/each}
			</div>
		{/if}
		{#if !$isReadOnly}
			<form
				class="flex gap-1.5"
				onsubmit={(e) => {
					e.preventDefault();
					void answer(draft);
				}}
			>
				<input
					type="text"
					bind:value={draft}
					disabled={!canAnswer}
					placeholder={args.options.length
						? 'or type an answer'
						: 'your answer'}
					class="min-w-0 flex-1 rounded border border-brand-border bg-brand-surface-2 px-2 py-1 text-sm text-brand-text placeholder-brand-text-muted focus:border-brand-blue focus:outline-none disabled:opacity-50"
				/>
				<button
					type="submit"
					disabled={!canAnswer || sending || !draft.trim()}
					class="rounded border border-brand-border bg-brand-surface-2 px-2.5 py-1 text-sm text-brand-text transition-colors hover:bg-brand-surface-3 disabled:opacity-50"
					>{sending ? '…' : 'Answer'}</button
				>
			</form>
		{/if}
		{#if card.kind === 'waiting'}
			<span class="text-[11px] text-brand-text-muted"
				>Not in the inbox yet; you can also reply in the chat.</span
			>
		{/if}
		{#if error}
			<span class="selectable text-[11px] text-rose-400">{error}</span>
		{/if}
	{:else if card.kind === 'closed' && interrupted}
		<span class="text-[11px] text-brand-text-muted"
			>If it is still open, answer it in Needs you.</span
		>
	{:else if (card.kind === 'closed' || card.kind === 'withdrawn') && args.options.length}
		<div class="flex flex-wrap gap-1.5 opacity-60">
			{#each args.options as option, i (i)}
				<span
					class="rounded-md border border-brand-border px-2.5 py-1 text-sm text-brand-text-muted"
					>{option}</span
				>
			{/each}
		</div>
	{/if}
</div>
