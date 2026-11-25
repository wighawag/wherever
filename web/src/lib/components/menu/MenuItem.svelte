<!--
	One action of a `Menu` (see its header comment). Closes the menu first and
	then runs `onselect` (so an action that moves the focus, e.g. opening an
	input, keeps it), unless `keepOpen`.

	Props:
	- `onselect`: the action.
	- `children` (snippet): the label.
	- `icon`: a short glyph before the label (⊘, ☆, ✎, 🗑...).
	- `hint`: muted text at the right ("and 1 owned session", "asks again").
	- `destructive`: red (Delete...). Put it last, after a `MenuSeparator`.
	- `checked`: makes it a toggle (`menuitemcheckbox`, a check box drawn
	  before the label); usually with `keepOpen`.
	- `keepOpen`: do not close after the action (toggles, a "asks again" step).
	- `focusOnMount`: take the focus when it appears (a confirm step that
	  replaces the item the user just chose, so the keyboard keeps its place).
	- `disabled`, `title`: as on a button.
-->
<script lang="ts">
	import type {Snippet} from 'svelte';
	import {getMenuContext} from './menu-context';

	let {
		onselect,
		children,
		icon,
		hint,
		destructive = false,
		checked,
		keepOpen = false,
		disabled = false,
		title,
		focusOnMount = false,
	}: {
		onselect: () => void;
		children: Snippet;
		icon?: string;
		hint?: string;
		destructive?: boolean;
		checked?: boolean;
		keepOpen?: boolean;
		disabled?: boolean;
		title?: string;
		focusOnMount?: boolean;
	} = $props();

	let el = $state<HTMLButtonElement | null>(null);
	$effect(() => {
		if (focusOnMount) el?.focus({preventScroll: true});
	});

	const menu = getMenuContext();
	let sheet = $derived(menu?.sheet ?? false);

	function select() {
		if (disabled) return;
		if (!keepOpen) menu?.close();
		onselect();
	}
</script>

<button
	type="button"
	role={checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
	aria-checked={checked}
	data-menu-item
	bind:this={el}
	{disabled}
	{title}
	onclick={select}
	class="flex w-full items-center gap-2 text-left transition-colors hover:bg-brand-surface-3 focus:bg-brand-surface-3 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent {sheet
		? 'px-4 py-3'
		: 'px-3 py-1.5'} {destructive ? 'text-rose-400' : 'text-brand-text'}"
>
	{#if checked !== undefined}
		<span
			class="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border text-[10px] leading-none {checked
				? 'border-brand-blue bg-brand-blue text-white'
				: 'border-brand-border bg-brand-surface-2'}"
			aria-hidden="true">{checked ? '✓' : ''}</span
		>
	{/if}
	{#if icon}
		<span class="w-4 shrink-0 text-center" aria-hidden="true">{icon}</span>
	{/if}
	<span class="min-w-0 flex-1 truncate">{@render children()}</span>
	{#if hint}
		<span
			class="shrink-0 text-[10px] {destructive
				? 'text-rose-400/80'
				: 'text-brand-text-muted'}">{hint}</span
		>
	{/if}
</button>
