<script lang="ts">
	// One state dot of the session-list legend (core/state-dot.ts): the folder
	// and By-owner rows, the By-owner group summaries and (later) the Live strip.
	// Hover shows its label (title); the label is also its accessible name. On
	// touch a long-press on the DOT shows the label instead of the browser's
	// link menu (the dot usually sits inside a row link): `-webkit-touch-callout:
	// none` stops iOS's callout, a `contextmenu` preventDefault stops Android's,
	// and a long-press timer shows the label where no contextmenu fires. The
	// click that may end a long-press is swallowed so it does not open the row.
	// A long-press anywhere else on the row stays native.
	import {stateDotLabel, type DotState} from '$lib/core/state-dot';

	let {
		dot,
		label,
		class: extraClass = '',
	}: {
		dot: DotState;
		/** Override the label (e.g. "1 waiting for you" on a count dot). */
		label?: string;
		class?: string;
	} = $props();

	let text = $derived(label ?? stateDotLabel(dot));

	// Amber (with a halo) is reserved for "waiting for you"; running is blue
	// and pulses; closed is a hollow ring (the row itself is dimmed).
	const CLASS: Record<DotState, string> = {
		'waiting-for-human': 'bg-amber-400 ring-[3px] ring-amber-400/30',
		'waiting-for-session': 'bg-brand-purple',
		running: 'animate-pulse bg-brand-blue ring-[3px] ring-brand-blue/25',
		idle: 'bg-emerald-500',
		'not-loaded': 'bg-brand-text-muted/40',
		closed: 'border-[1.5px] border-brand-text-muted/70 bg-transparent',
	};

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

<!-- The handlers only turn a long-press into the label (and swallow the click
     that ends it); the dot is not a control, so no keyboard twin is needed:
     its label is already the accessible name. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<span
	class="relative -m-1 inline-flex flex-shrink-0 items-center justify-center p-1 select-none"
	style="-webkit-touch-callout: none; -webkit-user-select: none;"
	role="img"
	aria-label={text}
	title={text}
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
		if (!swallowClick) return;
		swallowClick = false;
		e.preventDefault();
		e.stopPropagation();
	}}
>
	<span class="block h-2 w-2 rounded-full {CLASS[dot]} {extraClass}"></span>
	{#if showing}
		<span
			class="pointer-events-none absolute top-1/2 left-full z-50 ml-1 -translate-y-1/2 rounded bg-brand-surface-3 px-1.5 py-0.5 text-[10px] whitespace-nowrap text-brand-text shadow"
			aria-hidden="true">{text}</span
		>
	{/if}
</span>
