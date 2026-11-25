<script lang="ts">
	/**
	 * The foreground notifications under the chat top bar (spec
	 * `notifications-compact`, stories 1 to 11): the slim bar ("N questions for
	 * you · View") in the flow, and ONE compact dark toast overlaying the
	 * conversation below it (never the composer, which sits at the bottom of the
	 * column). The rules live in `core/notifications/question-toasts.ts`; this
	 * only renders them and feeds the model the shipmates snapshots and the
	 * page's context.
	 *
	 * A question's chips answer it through `answerShipmatesItem`, as
	 * `ShipmatesInbox.svelte` does. "Open ›" opens the asking session (by hash,
	 * like the inbox), else the Needs you panel. ✕ or a swipe up dismisses.
	 *
	 * Update pushes (anything not a question) show here too, as an INTERIM dark
	 * toast with a blue accent until `update-toasts-and-list` gives them their
	 * own place: tap opens the target (`openNotificationTarget`), ✕ closes.
	 */
	import {onMount} from 'svelte';
	import {shipmatesStore} from '$lib/session-store';
	import {answerShipmatesItem} from '$lib/wherever';
	import {notifications, questionToasts} from '$lib/core/notifications';
	import type {QuestionToast} from '$lib/core/notifications/question-toasts';

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
	let update = $derived($notifications[0]);

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
	function onPointerEnd(e: PointerEvent, t: QuestionToast | null) {
		questionToasts.release('touch');
		if (!swipeStart || swipeStart.id !== e.pointerId) return;
		const dismiss = swipeStart.captured && swipeDy <= -SWIPE_DISMISS_PX;
		swipeStart = null;
		swipeDy = 0;
		if (dismiss) {
			if (t) questionToasts.dismiss(t.id);
			else if (update) notifications.remove(update.id);
		}
	}
	function onPointerEnter(e: PointerEvent) {
		if (e.pointerType === 'mouse') questionToasts.hold('hover');
	}
	function onPointerLeave(e: PointerEvent) {
		if (e.pointerType === 'mouse') questionToasts.release('hover');
	}
</script>

{#if barCount > 0}
	<div class="app-chrome px-3 pt-2">
		<button
			type="button"
			onclick={onOpenNeedsYou}
			class="mx-auto flex w-full max-w-[760px] items-center gap-2 rounded-lg border border-amber-400/50 bg-amber-400/10 px-3 py-1.5 text-left text-sm text-brand-text transition-colors hover:bg-amber-400/20"
			title="Open Needs you"
		>
			<span aria-hidden="true">🙋</span>
			<span class="min-w-0 flex-1 truncate"
				>{barCount} question{barCount === 1 ? '' : 's'} for you</span
			>
			<span class="flex-shrink-0 text-amber-400">View ›</span>
		</button>
	</div>
{/if}

<!-- The toast layer: zero height in the flow, the toast hangs below it over
     the conversation. Pointer events pass through except on the toast. -->
<div class="relative z-10 h-0" aria-live="polite">
	{#if toast || update}
		<div
			class="pointer-events-none absolute inset-x-0 top-0 flex flex-col items-center gap-2 px-3 pt-2"
		>
			{#if toast}
				<div
					role="group"
					aria-label="Question from {toast.item?.from ?? 'a session'}"
					class="pointer-events-auto w-full max-w-[760px] rounded-xl border border-l-4 border-brand-border border-l-amber-400 bg-brand-surface-2 px-3 py-2.5 shadow-lg shadow-black/50 select-none"
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
							{#each toast.item.options as option (option)}
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
			{:else if update}
				<!-- Interim update toast (until update-toasts-and-list). -->
				<div
					class="pointer-events-auto flex w-full max-w-[760px] items-start gap-2 rounded-xl border border-l-4 border-brand-border border-l-brand-blue bg-brand-surface-2 px-3 py-2.5 shadow-lg shadow-black/50 select-none"
					style="touch-action: pan-x; transform: translateY({swipeDy}px);"
					onpointerdown={(e) => {
						swipeStart = {id: e.pointerId, y: e.clientY, captured: false};
					}}
					onpointermove={onPointerMove}
					onpointerup={(e) => onPointerEnd(e, null)}
					onpointercancel={(e) => onPointerEnd(e, null)}
					role="group"
					aria-label="Notification"
				>
					<button
						type="button"
						onclick={() => notifications.onClick(update!.id)}
						class="min-w-0 flex-1 text-left"
						title="Open"
					>
						<div class="truncate text-sm font-semibold text-brand-text">
							{update.data.title}
						</div>
						{#if update.data.options?.body}
							<div class="mt-0.5 line-clamp-2 text-sm text-brand-text">
								{update.data.options.body}
							</div>
						{/if}
					</button>
					<button
						type="button"
						onclick={() => notifications.remove(update!.id)}
						class="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded text-brand-text-muted hover:bg-brand-surface-3 hover:text-brand-text"
						aria-label="Dismiss">✕</button
					>
				</div>
				{#if $notifications.length > 1}
					<span
						class="pointer-events-auto rounded-full border border-brand-border bg-brand-surface-2 px-2.5 py-0.5 text-xs text-brand-text-muted"
						>+{$notifications.length - 1} more</span
					>
				{/if}
			{/if}
		</div>
	{/if}
</div>
