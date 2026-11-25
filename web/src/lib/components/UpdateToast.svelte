<script lang="ts">
	/**
	 * The foreground update toast (spec `notifications-compact`, stories 12, 13
	 * and 16): an update push (anything not a question) shows as the dark toast
	 * with a blue accent, ABOVE the composer pill. `+page.svelte` mounts it right
	 * above the bottom of the main column, so with no composer (a read-only
	 * session, the restore panel) it sits above whatever ends the column. It
	 * overlays the conversation, never the composer.
	 *
	 * The title ("<source>" bold, the rest muted) and two lines of body. Tapping
	 * it opens its target (`openNotificationTarget`); ✕ dismisses it. After 6 s
	 * (paused while touched or hovered) it folds into the slim bar's updates
	 * part. The rules live in `core/notifications/update-toasts.ts`.
	 */
	import {updateToasts} from '$lib/core/notifications';
	import {splitUpdateTitle} from '$lib/core/notifications/update-toasts';

	let toast = $derived($updateToasts.toast);
	let more = $derived($updateToasts.more);
	let title = $derived(toast ? splitUpdateTitle(toast.title) : null);

	function onPointerEnter(e: PointerEvent) {
		if (e.pointerType === 'mouse') updateToasts.hold('hover');
	}
	function onPointerLeave(e: PointerEvent) {
		if (e.pointerType === 'mouse') updateToasts.release('hover');
	}
</script>

<!-- Zero height in the flow: the toast hangs ABOVE this point, over the
     conversation. Pointer events pass through except on the toast. -->
<div class="relative z-10 h-0" aria-live="polite">
	{#if toast && title}
		<div
			class="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-center gap-2 px-3 pb-2"
		>
			{#if more > 0}
				<span
					class="pointer-events-auto rounded-full border border-brand-border bg-brand-surface-2 px-2.5 py-0.5 text-xs text-brand-text-muted"
					>+{more} more update{more === 1 ? '' : 's'}</span
				>
			{/if}
			<div
				role="group"
				aria-label="Update"
				class="pointer-events-auto flex w-full max-w-[760px] items-start gap-2 rounded-xl border border-l-4 border-brand-border border-l-brand-blue bg-brand-surface-2 px-3 py-2.5 shadow-lg shadow-black/50 select-none"
				onpointerdown={() => updateToasts.hold('touch')}
				onpointerup={() => updateToasts.release('touch')}
				onpointercancel={() => updateToasts.release('touch')}
				onpointerenter={onPointerEnter}
				onpointerleave={onPointerLeave}
			>
				<button
					type="button"
					onclick={() => updateToasts.open(toast!.id)}
					class="min-w-0 flex-1 text-left"
					title={toast.navigate ? 'Open' : undefined}
				>
					<div class="flex min-w-0 items-center gap-2 text-sm">
						<span aria-hidden="true">🔔</span>
						<span class="min-w-0 truncate">
							{#if title.source}
								<span class="font-semibold text-brand-text">{title.source}</span
								>
								<span class="text-brand-text-muted">{title.text}</span>
							{:else}
								<span class="font-semibold text-brand-text">{title.text}</span>
							{/if}
						</span>
					</div>
					{#if toast.body}
						<div class="mt-0.5 line-clamp-2 text-sm text-brand-text">
							{toast.body}
						</div>
					{/if}
				</button>
				<button
					type="button"
					onclick={() => updateToasts.dismiss(toast!.id)}
					class="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded text-brand-text-muted hover:bg-brand-surface-3 hover:text-brand-text"
					title="Dismiss"
					aria-label="Dismiss">✕</button
				>
			</div>
		</div>
	{/if}
</div>
