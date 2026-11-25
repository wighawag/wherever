<!--
	The rename prompt (spec `sidebar-compact-layout` story 39), shared by the
	session row ⋯ (SessionRow.svelte) and the chat ⋯ (each mounts its own
	instance). A small modal dialog with one field, prefilled with the current
	name (empty when the session has none). Enter or Save confirms; Escape,
	Cancel, a tap on the backdrop, an empty value or an unchanged name cancel
	(core/rename-prompt.ts). While saving the field and buttons are disabled; a
	refusal (old terminal extension, no message yet, a load in progress...)
	shows its text in place and keeps the prompt open with what was typed.

	It is a native `<dialog>` opened with `showModal()`, so it sits in the top
	layer: neither the phone drawer's transform nor the sidebar's scroll box can
	clip it, wherever the instance is mounted.

	Props:
	- `open` (bindable): shown or not.
	- `currentName`: the session's name now (`undefined` when it has none).
	- `label`: what is renamed, shown under the title (the row's label).
	- `onsave(name)`: does the rename (e.g. `renameSession`); its rejection's
	  message is the error shown. The prompt closes when it resolves.
	- `onclose`: called whenever it closes, however.
-->
<script lang="ts">
	import {tick} from 'svelte';
	import {
		renamePromptAction,
		renamePromptInitial,
	} from '$lib/core/rename-prompt';

	let {
		open = $bindable(false),
		currentName,
		label,
		onsave,
		onclose,
	}: {
		open?: boolean;
		currentName: string | undefined;
		label?: string;
		onsave: (name: string) => Promise<unknown>;
		onclose?: () => void;
	} = $props();

	let dialogEl = $state<HTMLDialogElement | null>(null);
	let inputEl = $state<HTMLInputElement | null>(null);
	let value = $state('');
	let error = $state<string | null>(null);
	let saving = $state(false);
	// A save that answers after the prompt was closed (or reopened) is ignored.
	let attempt = 0;

	const uid = $props.id();

	// The dialog is mounted only while open (one row's prompt at a time, not
	// one per row): each opening starts from the current name.
	$effect(() => {
		const el = dialogEl;
		if (!el || el.open) return;
		value = renamePromptInitial(currentName);
		error = null;
		saving = false;
		el.showModal();
		void tick().then(() => {
			inputEl?.focus();
			inputEl?.select();
		});
	});

	function close() {
		attempt++;
		saving = false;
		if (open) {
			open = false;
			onclose?.();
		}
	}

	async function confirm() {
		if (saving) return;
		const action = renamePromptAction(value, currentName);
		if (action.kind === 'cancel') {
			close();
			return;
		}
		const mine = ++attempt;
		saving = true;
		error = null;
		try {
			await onsave(action.name);
			if (mine === attempt) close();
		} catch (err) {
			if (mine !== attempt) return;
			saving = false;
			error =
				(err instanceof Error && err.message) || 'The session was not renamed.';
			void tick().then(() => inputEl?.focus());
		}
	}
</script>

<!-- Clicks and keys stop here: the dialog is in the top layer but still
     inside the row (or chat) in the DOM, whose handlers must not see them. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
{#if open}
	<dialog
		bind:this={dialogEl}
		aria-labelledby="{uid}-title"
		class="m-auto mt-[15vh] w-[calc(100%-2rem)] max-w-sm rounded-xl border border-brand-border bg-brand-surface-2 p-0 text-brand-text shadow-xl backdrop:bg-black/55"
		oncancel={(e) => {
			e.preventDefault();
			close();
		}}
		onclick={(e) => {
			e.stopPropagation();
			if (e.target === dialogEl) close();
		}}
		onpointerdown={(e) => e.stopPropagation()}
		onkeydown={(e) => e.stopPropagation()}
	>
		<form
			class="p-4"
			onsubmit={(e) => {
				e.preventDefault();
				void confirm();
			}}
		>
			<h2 id="{uid}-title" class="text-sm font-semibold">Rename session</h2>
			{#if label}
				<p class="mt-0.5 truncate text-xs text-brand-text-muted" title={label}>
					{label}
				</p>
			{/if}
			<input
				bind:this={inputEl}
				bind:value
				type="text"
				disabled={saving}
				placeholder="Session name"
				aria-label="New session name"
				aria-invalid={error ? 'true' : undefined}
				aria-describedby={error ? `${uid}-error` : undefined}
				autocomplete="off"
				spellcheck="false"
				oninput={() => (error = null)}
				class="mt-3 w-full rounded-lg border bg-brand-surface-3 px-3 py-2 text-sm text-brand-text outline-none focus:border-brand-blue disabled:opacity-60 {error
					? 'border-rose-400'
					: 'border-brand-border'}"
			/>
			{#if error}
				<p id="{uid}-error" role="alert" class="mt-2 text-xs text-rose-400">
					{error}
				</p>
			{/if}
			<p class="mt-2 text-[11px] text-brand-text-muted">
				An empty name cancels.
			</p>
			<div class="mt-3 flex justify-end gap-2">
				<button
					type="button"
					onclick={close}
					class="rounded-lg px-3 py-1.5 text-sm text-brand-text-muted hover:bg-brand-surface-3 hover:text-brand-text"
					>Cancel</button
				>
				<button
					type="submit"
					disabled={saving}
					class="rounded-lg bg-brand-blue px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-60"
					>{saving ? 'Saving…' : 'Save'}</button
				>
			</div>
		</form>
	</dialog>
{/if}
