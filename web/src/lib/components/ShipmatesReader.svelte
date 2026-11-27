<!--
	The Needs you reader (core/shipmates-reader.ts): one inbox question shown
	large, so a long question is readable. A modal up to 900px wide on desktop,
	a full-screen sheet on the phone. The question's Markdown is rendered (the
	chat's renderer, sanitized), every option is a full-width button with its
	whole text, and the free answer is a multi-line box.

	Mounted ONCE by the page; any opener sets `readerItemId` (the Needs you
	list, the question toast). It shows the live inbox item: when that item
	leaves the inbox (answered here or anywhere else, withdrawn) the reader
	closes. ‹ › step through the other questions without closing.

	Keys: 1 to 9 pick an option (outside the answer box), Ctrl/Cmd+Enter sends
	the typed answer, Escape closes.

	It is a native `<dialog>` opened with `showModal()`, like RenamePrompt, so
	the phone drawer's transform or the sidebar's scroll box cannot clip it.
-->
<script lang="ts">
	import {tick} from 'svelte';
	import {shipmatesStore} from '$lib/session-store';
	import {answerShipmatesItem} from '$lib/wherever';
	import {renderMarkdown} from '$lib/core/utils/markdown';
	import {
		closeReader,
		openReader,
		optionForKey,
		readerItemId,
		readerPosition,
	} from '$lib/core/shipmates-reader';

	let {onOpenedSession}: {onOpenedSession?: () => void} = $props();

	let dialogEl = $state<HTMLDialogElement | null>(null);
	let bodyEl = $state<HTMLDivElement | null>(null);
	let drafts = $state<Record<string, string>>({});
	let sending = $state<Record<string, boolean>>({});
	let errors = $state<Record<string, string>>({});

	const uid = $props.id();

	let pos = $derived(readerPosition($shipmatesStore.inbox, $readerItemId));
	let item = $derived(pos.item);
	let html = $derived(item ? renderMarkdown(item.question) : '');

	// The open question left the inbox (answered, here or elsewhere, or
	// withdrawn): nothing to show any more.
	$effect(() => {
		if ($readerItemId !== null && !item) closeReader();
	});

	// Shown while a question is open; each opening scrolls to the top and
	// focuses the text (not the answer box, which would raise the phone
	// keyboard over the question).
	$effect(() => {
		const el = dialogEl;
		if (!el || el.open) return;
		el.showModal();
		void tick().then(() => bodyEl?.focus());
	});

	// Stepping to another question starts at its top.
	$effect(() => {
		void $readerItemId;
		if (bodyEl) bodyEl.scrollTop = 0;
	});

	async function answer(text: string) {
		const it = item;
		const trimmed = text.trim();
		if (!it || !trimmed || sending[it.id]) return;
		sending[it.id] = true;
		errors[it.id] = '';
		const r = await answerShipmatesItem(it.id, trimmed);
		sending[it.id] = false;
		if (r.ok) {
			drafts[it.id] = '';
			if ($readerItemId === it.id) closeReader();
		} else errors[it.id] = r.error;
	}

	function openSession() {
		if (!item?.sessionId) return;
		// The page's hashchange handler opens it, as a notification tap does.
		window.location.hash = encodeURIComponent(item.sessionId);
		closeReader();
		onOpenedSession?.();
	}

	function onKeydown(e: KeyboardEvent) {
		// The dialog is in the top layer but still inside the page's DOM, whose
		// key handlers must not see these.
		e.stopPropagation();
		if (!item || e.ctrlKey || e.metaKey || e.altKey) return;
		const target = e.target as HTMLElement | null;
		if (target?.tagName === 'TEXTAREA' || target?.tagName === 'INPUT') return;
		const option = optionForKey(item.options, e.key);
		if (option) {
			e.preventDefault();
			void answer(option);
		}
	}

	function ago(ms: number): string {
		const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
		if (s < 60) return 'just now';
		if (s < 3600) return `${Math.round(s / 60)} min ago`;
		if (s < 86400) return `${Math.round(s / 3600)} h ago`;
		return `${Math.round(s / 86400)} d ago`;
	}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
{#if $readerItemId !== null && item}
	<dialog
		bind:this={dialogEl}
		aria-labelledby="{uid}-title"
		class="m-0 h-dvh max-h-none w-screen max-w-none flex-col border-brand-border bg-brand-surface p-0 text-brand-text shadow-xl backdrop:bg-black/60 open:flex md:m-auto md:h-fit md:max-h-[90dvh] md:w-[calc(100%-4rem)] md:max-w-[900px] md:rounded-xl md:border"
		oncancel={(e) => {
			e.preventDefault();
			closeReader();
		}}
		onclick={(e) => {
			e.stopPropagation();
			if (e.target === dialogEl) closeReader();
		}}
		onpointerdown={(e) => e.stopPropagation()}
		onkeydown={onKeydown}
	>
		<!-- Header: who asks, since when, open the session, step, close. -->
		<div
			class="flex flex-shrink-0 items-center gap-2 border-b border-brand-border px-3 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3 text-sm text-brand-text-muted md:px-5"
		>
			<button
				type="button"
				class="rounded px-1.5 py-0.5 text-lg leading-none hover:text-brand-text md:hidden"
				aria-label="Back"
				onclick={closeReader}>‹</button
			>
			{#if item.blocking}
				<span
					class="flex-shrink-0 rounded bg-amber-500/20 px-1.5 text-xs text-amber-400"
					title="The session is waiting for this answer">waiting</span
				>
			{/if}
			<h2
				id="{uid}-title"
				class="min-w-0 truncate font-semibold text-brand-text"
			>
				{item.from}
			</h2>
			<span class="flex-shrink-0">· {ago(item.createdAt)}</span>
			{#if item.onBehalfOf > 0}
				<span
					class="hidden flex-shrink-0 sm:inline"
					title="This question merges questions from other sessions"
					>(for {item.onBehalfOf})</span
				>
			{/if}
			{#if item.sessionId}
				<button
					type="button"
					class="hidden flex-shrink-0 text-brand-blue hover:underline md:inline"
					onclick={openSession}>Open session ›</button
				>
			{/if}
			<span class="ml-auto flex flex-shrink-0 items-center gap-1">
				{#if pos.total > 1}
					<button
						type="button"
						class="rounded px-1.5 py-0.5 hover:text-brand-text disabled:opacity-30"
						aria-label="Previous question"
						disabled={!pos.prevId}
						onclick={() => pos.prevId && openReader(pos.prevId)}>‹</button
					>
					<span class="text-xs tabular-nums">{pos.index} of {pos.total}</span>
					<button
						type="button"
						class="rounded px-1.5 py-0.5 hover:text-brand-text disabled:opacity-30"
						aria-label="Next question"
						disabled={!pos.nextId}
						onclick={() => pos.nextId && openReader(pos.nextId)}>›</button
					>
				{/if}
				<button
					type="button"
					class="ml-2 hidden rounded px-1.5 py-0.5 text-lg leading-none hover:text-brand-text md:inline"
					aria-label="Close"
					onclick={closeReader}>✕</button
				>
			</span>
		</div>

		<!-- The question, large and rendered. -->
		<div
			bind:this={bodyEl}
			tabindex="-1"
			class="min-h-0 flex-1 overflow-y-auto px-4 py-4 outline-none md:px-6"
		>
			{#if html}
				<!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized via DOMPurify in renderMarkdown -->
				<div class="selectable markdown-body text-base leading-relaxed">
					{@html html}
				</div>
			{:else}
				<div class="selectable text-base leading-relaxed whitespace-pre-wrap">
					{item.question}
				</div>
			{/if}
			{#if item.sessionId}
				<button
					type="button"
					class="mt-3 text-sm text-brand-blue hover:underline md:hidden"
					onclick={openSession}>Open session ›</button
				>
			{/if}
		</div>

		<!-- The options, whole, one per row. -->
		{#if item.options?.length}
			<div
				class="flex max-h-[40dvh] flex-shrink-0 flex-col gap-2 overflow-y-auto px-4 pb-2 md:px-6"
			>
				{#each item.options as option, i (option)}
					<button
						type="button"
						disabled={sending[item.id]}
						onclick={() => answer(option)}
						class="rounded-lg border border-brand-border bg-brand-surface-2 px-3.5 py-2.5 text-left text-[15px] leading-snug text-brand-text transition-colors hover:border-brand-blue disabled:opacity-50"
					>
						{#if i < 9}<span
								class="mr-2 hidden text-brand-text-muted tabular-nums md:inline"
								>{i + 1}</span
							>{/if}{option}
					</button>
				{/each}
			</div>
		{/if}

		<!-- The free answer. -->
		<form
			class="flex flex-shrink-0 flex-col gap-2 border-t border-brand-border px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] md:px-6"
			onsubmit={(e) => {
				e.preventDefault();
				void answer(drafts[item.id] ?? '');
			}}
		>
			<textarea
				bind:value={drafts[item.id]}
				rows="2"
				placeholder={item.options?.length ? 'or type an answer' : 'your answer'}
				onkeydown={(e) => {
					if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
						e.preventDefault();
						void answer(drafts[item.id] ?? '');
					}
				}}
				class="max-h-[30dvh] min-h-[3rem] w-full resize-y rounded-lg border border-brand-border bg-brand-surface-2 px-3 py-2 text-[15px] text-brand-text placeholder-brand-text-muted focus:border-brand-blue focus:outline-none"
			></textarea>
			{#if errors[item.id]}
				<div class="selectable text-xs text-rose-400">{errors[item.id]}</div>
			{/if}
			<div class="flex items-center gap-2">
				<span class="hidden text-xs text-brand-text-muted md:inline">
					{item.options?.length
						? `Keys 1–${Math.min(item.options.length, 9)} pick an option · `
						: ''}Ctrl+Enter sends · Esc closes
				</span>
				<span class="ml-auto"></span>
				<button
					type="button"
					onclick={closeReader}
					class="hidden rounded-md border border-brand-border bg-brand-surface-2 px-3 py-1.5 text-sm text-brand-text hover:bg-brand-surface-3 md:inline"
					>Cancel</button
				>
				<button
					type="submit"
					disabled={sending[item.id] || !(drafts[item.id] ?? '').trim()}
					class="rounded-md bg-brand-blue px-4 py-1.5 text-sm text-white transition-opacity hover:opacity-90 disabled:opacity-40"
					>{sending[item.id] ? '…' : 'Answer'}</button
				>
			</div>
		</form>
	</dialog>
{/if}
