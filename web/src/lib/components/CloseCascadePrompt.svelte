<script lang="ts">
	// "Also close the N sessions it owns?" (ADR 0025), asked when the user closes
	// a session that owns open sessions. N is the server's (core/close-flow.ts).
	// Mounted once on the page so it works from the sidebar and the top bar.
	import {closePromptStore, answerClosePrompt} from '$lib/session-store';
	import {cascadePromptText} from '$lib/core/close-flow';

	let yesButton = $state<HTMLButtonElement | null>(null);
	$effect(() => {
		// Default answer: yes.
		if ($closePromptStore) yesButton?.focus();
	});
</script>

<svelte:window
	onkeydown={(e) => {
		if ($closePromptStore && e.key === 'Escape') answerClosePrompt(null);
	}}
/>

{#if $closePromptStore}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-brand-dark/65 p-4"
		role="dialog"
		aria-modal="true"
		aria-labelledby="close-cascade-title"
	>
		<div
			class="w-80 rounded-lg border border-brand-border bg-brand-surface-2 p-5 text-brand-text"
		>
			<h3
				id="close-cascade-title"
				class="mb-2 text-sm font-bold text-brand-text"
			>
				{cascadePromptText($closePromptStore.n)}
			</h3>
			<p class="mb-4 text-xs text-brand-text-muted">
				It spawned them (directly or through its own children). Closing hides
				them from the list; nothing is deleted.
			</p>
			<div class="flex justify-end gap-2">
				<button
					type="button"
					onclick={() => answerClosePrompt(null)}
					class="rounded border border-brand-border bg-brand-surface-2 px-2 py-1 text-xs text-brand-text-muted hover:bg-brand-surface-3 hover:text-brand-text"
					>Cancel</button
				>
				<button
					type="button"
					onclick={() => answerClosePrompt(false)}
					class="rounded border border-brand-border bg-brand-surface-2 px-2 py-1 text-xs text-brand-text hover:bg-brand-surface-3"
					>Only this one</button
				>
				<button
					type="button"
					bind:this={yesButton}
					onclick={() => answerClosePrompt(true)}
					class="rounded border border-brand-blue bg-brand-blue px-2 py-1 text-xs font-medium text-white hover:opacity-90"
					>Close all</button
				>
			</div>
		</div>
	</div>
{/if}
