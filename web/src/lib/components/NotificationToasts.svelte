<script lang="ts">
	/**
	 * The foreground notifications under the chat top bar (spec
	 * `notifications-compact`, stories 1 to 11, 14 and 17): the slim bar in the
	 * flow, and ONE compact dark question toast overlaying the conversation
	 * below it (never the composer, which sits at the bottom of the column).
	 * The rules live in `core/notifications/question-toasts.ts` and
	 * `update-toasts.ts`; this only renders them and feeds the question model
	 * the shipmates snapshots and the page's context.
	 *
	 * The slim bar has a questions part ("N questions for you", opens Needs
	 * you) and an updates part ("N updates", opens the updates list, the shared
	 * `Menu`: a sheet on the phone, a popover on desktop, each update with Open
	 * and Dismiss, plus Clear all). With one part it reads "… View ›"; with both,
	 * "2 questions for you · 1 update ›".
	 *
	 * A question's chips answer it through `answerShipmatesItem`, as
	 * `ShipmatesInbox.svelte` does. "Open ›" opens the asking session (by hash,
	 * like the inbox), else the Needs you panel. ✕ or a swipe up dismisses.
	 *
	 * Update toasts (anything not a question) are `UpdateToast.svelte`, above
	 * the composer.
	 */
	import {onMount} from 'svelte';
	import {shipmatesStore} from '$lib/session-store';
	import {answerShipmatesItem} from '$lib/wherever';
	import {questionToasts, updateToasts} from '$lib/core/notifications';
	import {openReader} from '$lib/core/shipmates-reader';
	import type {QuestionToast} from '$lib/core/notifications/question-toasts';
	import {
		splitUpdateTitle,
		updateAge,
	} from '$lib/core/notifications/update-toasts';
	import Menu from './menu/Menu.svelte';
	import MenuItem from './menu/MenuItem.svelte';
	import MenuSeparator from './menu/MenuSeparator.svelte';

	let {
		needsYouOpen,
		openSessionId,
		onOpenNeedsYou,
	}: {
		needsYouOpen: boolean;
		openSessionId: string | null;
		onOpenNeedsYou: () => void;
	} = $props();

	onMount(() => shipmatesStore.subscribe((s) => questionToasts.shipmates(s)));
	$effect(() => {
		questionToasts.setContext({needsYouOpen, openSessionId});
	});

	let barCount = $derived($questionToasts.bar.length);
	let toast = $derived($questionToasts.toast);
	let updates = $derived($updateToasts.list);
	let updateCount = $derived(updates.length);

	// The updates list (the bar's updates part). Closed once it is empty;
	// the ages are read when it opens.
	let updatesOpen = $state(false);
	let listNow = $state(Date.now());
	$effect(() => {
		if (updatesOpen) listNow = Date.now();
	});
	$effect(() => {
		if (updateCount === 0) updatesOpen = false;
	});

	function openUpdate(id: string) {
		updatesOpen = false;
		updateToasts.open(id);
	}

	async function answer(t: QuestionToast, option: string) {
		if (t.sending) return;
		questionToasts.answering(t.id);
		const r = await answerShipmatesItem(t.id, option);
		questionToasts.answered(t.id, r);
	}

	function open(t: QuestionToast) {
		questionToasts.fold(t.id);
		if (t.sessionId) {
			// The page's hashchange handler opens it, as a notification tap does.
			window.location.hash = encodeURIComponent(t.sessionId);
		} else onOpenNeedsYou();
	}

	function answerInNeedsYou(t: QuestionToast) {
		questionToasts.fold(t.id);
		onOpenNeedsYou();
		// Straight to the question, large (ShipmatesReader.svelte).
		openReader(t.id);
	}

	// Swipe up to dismiss. The pointer is captured only once the gesture moves
	// past the slop, so a tap on a chip still clicks the chip.
	const SWIPE_SLOP_PX = 8;
	const SWIPE_DISMISS_PX = 40;
	let swipeStart: {id: number; y: number; captured: boolean} | null = null;
	let swipeDy = $state(0);

	function onPointerDown(e: PointerEvent) {
		questionToasts.hold('touch');
		swipeStart = {id: e.pointerId, y: e.clientY, captured: false};
		swipeDy = 0;
	}
	function onPointerMove(e: PointerEvent) {
		if (!swipeStart || swipeStart.id !== e.pointerId) return;
		const dy = Math.min(0, e.clientY - swipeStart.y);
		if (!swipeStart.captured && dy <= -SWIPE_SLOP_PX) {
			swipeStart.captured = true;
			(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
		}
		if (swipeStart.captured) swipeDy = dy;
	}
	function onPointerEnd(e: PointerEvent, t: QuestionToast) {
		questionToasts.release('touch');
		if (!swipeStart || swipeStart.id !== e.pointerId) return;
		const dismiss = swipeStart.captured && swipeDy <= -SWIPE_DISMISS_PX;
		swipeStart = null;
		swipeDy = 0;
		if (dismiss) questionToasts.dismiss(t.id);
	}
	function onPointerEnter(e: PointerEvent) {
		if (e.pointerType === 'mouse') questionToasts.hold('hover');
	}
	function onPointerLeave(e: PointerEvent) {
		if (e.pointerType === 'mouse') questionToasts.release('hover');
	}
</script>

{#if barCount > 0 || updateCount > 0}
	<div class="app-chrome px-3 pt-2">
		<div
			class="mx-auto flex w-full max-w-(--chat-column) items-center rounded-lg border text-sm text-brand-text {barCount >
			0
				? 'border-amber-400/50 bg-amber-400/10'
				: 'border-brand-blue/50 bg-brand-blue/10'}"
		>
			{#if barCount > 0}
				<button
					type="button"
					onclick={onOpenNeedsYou}
					class="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-3 py-1.5 text-left transition-colors hover:bg-amber-400/10"
					title="Open Needs you"
				>
					<span aria-hidden="true">🙋</span>
					<span class="min-w-0 flex-1 truncate"
						>{barCount} question{barCount === 1 ? '' : 's'} for you</span
					>
					{#if updateCount === 0}
						<span class="flex-shrink-0 text-amber-400">View ›</span>
					{/if}
				</button>
			{/if}
			{#if updateCount > 0}
				{#if barCount > 0}
					<span aria-hidden="true" class="text-brand-text-muted">·</span>
				{/if}
				<Menu
					bind:open={updatesOpen}
					label="Updates"
					width="w-80"
					class={barCount > 0 ? 'flex-shrink-0' : 'min-w-0 flex-1'}
				>
					{#snippet trigger(props)}
						<button
							type="button"
							{...props}
							class="flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left transition-colors hover:bg-brand-blue/10"
							title="Show the updates"
						>
							{#if barCount > 0}
								<span class="text-brand-blue"
									>{updateCount} update{updateCount === 1 ? '' : 's'} ›</span
								>
							{:else}
								<span aria-hidden="true">🔔</span>
								<span class="min-w-0 flex-1 truncate"
									>{updateCount} update{updateCount === 1 ? '' : 's'}</span
								>
								<span class="flex-shrink-0 text-brand-blue">View ›</span>
							{/if}
						</button>
					{/snippet}
					{#snippet header()}
						<div class="font-semibold text-brand-text">
							Updates <span class="font-normal text-brand-text-muted"
								>· {updateCount}</span
							>
						</div>
					{/snippet}
					<div class="max-h-[50vh] overflow-y-auto">
						{#each updates as u (u.id)}
							{@const t = splitUpdateTitle(u.title)}
							<div
								class="border-b border-brand-border/40 px-3 py-2 last:border-b-0"
							>
								<div class="flex items-baseline gap-2">
									<div class="min-w-0 flex-1 truncate">
										{#if t.source}
											<span class="font-semibold">{t.source}</span>
											<span class="text-brand-text-muted">{t.text}</span>
										{:else}
											<span class="font-semibold">{t.text}</span>
										{/if}
									</div>
									<span class="flex-shrink-0 text-brand-text-muted"
										>{updateAge(u.at, listNow)}</span
									>
								</div>
								{#if u.body}
									<div class="mt-0.5 line-clamp-2 text-brand-text-muted">
										{u.body}
									</div>
								{/if}
								<div class="mt-1 flex items-center gap-3">
									{#if u.navigate}
										<button
											type="button"
											data-menu-item
											onclick={() => openUpdate(u.id)}
											class="-mx-1 rounded px-1 py-0.5 text-brand-blue hover:underline focus:underline focus:outline-none"
											>Open ›</button
										>
									{/if}
									<button
										type="button"
										data-menu-item
										onclick={() => updateToasts.dismiss(u.id)}
										class="-mx-1 rounded px-1 py-0.5 text-brand-text-muted hover:text-brand-text hover:underline focus:underline focus:outline-none"
										>Dismiss</button
									>
								</div>
							</div>
						{/each}
					</div>
					<MenuSeparator />
					<MenuItem icon="⊘" onselect={() => updateToasts.clearAll()}
						>Clear all</MenuItem
					>
				</Menu>
			{/if}
		</div>
	</div>
{/if}

<!-- The toast layer: zero height in the flow, the toast hangs below it over
     the conversation. Pointer events pass through except on the toast. -->
<div class="relative z-10 h-0" aria-live="polite">
	{#if toast}
		<div
			class="pointer-events-none absolute inset-x-0 top-0 flex flex-col items-center gap-2 px-3 pt-2"
		>
			<div
				role="group"
				aria-label="Question from {toast.item?.from ?? 'a session'}"
				class="pointer-events-auto w-full max-w-(--chat-column) rounded-xl border border-l-4 border-brand-border border-l-amber-400 bg-brand-surface-2 px-3 py-2.5 shadow-lg shadow-black/50 select-none"
				style="touch-action: pan-x; transform: translateY({swipeDy}px); opacity: {1 +
					swipeDy / 120};"
				onpointerdown={onPointerDown}
				onpointermove={onPointerMove}
				onpointerup={(e) => onPointerEnd(e, toast)}
				onpointercancel={(e) => onPointerEnd(e, toast)}
				onpointerenter={onPointerEnter}
				onpointerleave={onPointerLeave}
			>
				<div class="flex items-center gap-2">
					<span aria-hidden="true" class="text-sm">🙋</span>
					<div class="min-w-0 flex-1 truncate text-sm">
						{#if toast.item}
							<span class="font-semibold text-brand-text"
								>{toast.item.from}</span
							>
							<span class="text-brand-text-muted">asks</span>
						{:else}
							<span class="font-semibold text-brand-text"
								>{toast.fallback?.title}</span
							>
						{/if}
					</div>
					<button
						type="button"
						onclick={() => questionToasts.dismiss(toast!.id)}
						class="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded text-brand-text-muted hover:bg-brand-surface-3 hover:text-brand-text"
						title="Dismiss (it stays in Needs you)"
						aria-label="Dismiss">✕</button
					>
				</div>
				<div class="mt-1 line-clamp-2 text-sm text-brand-text">
					{toast.item ? toast.item.question : toast.fallback?.body}
				</div>
				<div class="mt-2 flex flex-wrap items-center gap-1.5">
					{#if toast.item?.options?.length}
						{#each toast.item.options as option, i (i)}
							<button
								type="button"
								disabled={toast.sending}
								onclick={() => answer(toast!, option)}
								class="max-w-full truncate rounded-full border border-brand-border bg-brand-surface-3 px-3 py-1 text-xs text-brand-text transition-colors hover:border-amber-400/60 disabled:opacity-50"
								>{option}</button
							>
						{/each}
					{:else if toast.item}
						<button
							type="button"
							onclick={() => answerInNeedsYou(toast!)}
							class="rounded-full border border-brand-border bg-brand-surface-3 px-3 py-1 text-xs text-brand-text transition-colors hover:border-amber-400/60"
							>Answer in Needs you</button
						>
					{/if}
					<button
						type="button"
						onclick={() => open(toast!)}
						class="px-1.5 py-1 text-xs text-brand-blue hover:underline"
						title={toast.sessionId
							? 'Open the asking session'
							: 'Open Needs you'}>Open ›</button
					>
					{#if toast.sending}
						<span class="text-xs text-brand-text-muted">Sending…</span>
					{/if}
				</div>
				{#if toast.error}
					<div class="mt-1.5 text-xs text-rose-400">{toast.error}</div>
				{/if}
			</div>
			{#if $questionToasts.more > 0}
				<span
					class="pointer-events-auto rounded-full border border-brand-border bg-brand-surface-2 px-2.5 py-0.5 text-xs text-brand-text-muted"
					>+{$questionToasts.more} more question{$questionToasts.more === 1
						? ''
						: 's'}</span
				>
			{/if}
		</div>
	{/if}
</div>
