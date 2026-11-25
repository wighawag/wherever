<script lang="ts">
	// One icon-only tab of the sidebar (spec `sidebar-compact-layout`, story
	// 14): the icon, an optional badge, and its label as tooltip (hover, via
	// `title`) and accessible name. On touch, a long-press shows the label in a
	// bubble under the tab instead of tapping it: the click that ends the
	// long-press is swallowed, and `-webkit-touch-callout: none` plus a
	// `contextmenu` preventDefault keep the browser's own menu away.
	import type {Snippet} from 'svelte';

	let {
		label,
		title,
		active = false,
		disabled = false,
		onclick,
		icon,
		badge,
	}: {
		/** Short label: the accessible name and what a long-press shows. */
		label: string;
		/** Longer hover text; defaults to the label. */
		title?: string;
		/** The tab's view is the one shown (tapping it goes back). */
		active?: boolean;
		disabled?: boolean;
		onclick: () => void;
		icon: Snippet;
		badge?: Snippet;
	} = $props();

	const LONG_PRESS_MS = 450;
	const SHOW_MS = 1800;
	let showing = $state(false);
	let pressTimer: ReturnType<typeof setTimeout> | undefined;
	let hideTimer: ReturnType<typeof setTimeout> | undefined;
	let swallowClick = false;

	function show() {
		showing = true;
		swallowClick = true;
		clearTimeout(hideTimer);
		hideTimer = setTimeout(() => (showing = false), SHOW_MS);
	}
	function cancelPress() {
		clearTimeout(pressTimer);
		pressTimer = undefined;
	}
	$effect(() => () => {
		clearTimeout(pressTimer);
		clearTimeout(hideTimer);
	});
</script>

<button
	type="button"
	class="relative flex h-9 flex-1 items-center justify-center rounded text-base transition-colors select-none disabled:opacity-50 {active
		? 'bg-brand-surface-3 text-brand-text'
		: 'text-brand-text-muted hover:bg-brand-surface-3/50 hover:text-brand-text'}"
	style="-webkit-touch-callout: none; -webkit-user-select: none;"
	title={title ?? label}
	aria-label={label}
	aria-current={active ? 'page' : undefined}
	{disabled}
	onpointerdown={(e) => {
		swallowClick = false;
		if (e.pointerType === 'mouse') return;
		cancelPress();
		pressTimer = setTimeout(show, LONG_PRESS_MS);
	}}
	onpointerup={cancelPress}
	onpointercancel={cancelPress}
	onpointerleave={cancelPress}
	oncontextmenu={(e) => {
		e.preventDefault();
		cancelPress();
		show();
	}}
	onclick={(e) => {
		if (swallowClick) {
			swallowClick = false;
			e.preventDefault();
			return;
		}
		onclick();
	}}
>
	<span class="relative inline-flex items-center justify-center">
		{@render icon()}
		{#if badge}
			<span class="absolute -top-2 -right-3">{@render badge()}</span>
		{/if}
	</span>
	{#if active}
		<span
			class="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-brand-blue"
			aria-hidden="true"
		></span>
	{/if}
	{#if showing}
		<span
			class="pointer-events-none absolute top-full left-1/2 z-50 mt-1 -translate-x-1/2 rounded bg-brand-surface-3 px-1.5 py-0.5 text-[10px] whitespace-nowrap text-brand-text shadow"
			aria-hidden="true">{label}</span
		>
	{/if}
</button>
