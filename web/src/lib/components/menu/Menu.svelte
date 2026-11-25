<!--
	The shared ⋯ menu of the redesign (spec `sidebar-compact-layout`): every ⋯
	(folder header, session row, chat top bar) and the filter row's ☰ use it.

	Below the `md` breakpoint it is a BOTTOM SHEET (dimmed backdrop, a handle,
	the optional header, then the items); at and above it, an anchored POPOVER
	under (or, when there is no room below, above) its trigger. It closes on a
	tap outside it (or on the sheet's backdrop), on Escape and after an action
	(`MenuItem`, unless `keepOpen`). Keyboard: the first item takes the focus on
	open, ArrowDown / ArrowUp (wrapping), Home and End move between items, Tab
	moves as usual, Escape closes and gives the focus back to the trigger.

	Props:
	- `open` (bindable): shown or not. Bind it (`bind:open`, or a function
	  binding when one state drives many menus) or read it from `onclose`.
	- `label`: the accessible name of the menu (`aria-label`).
	- `trigger` (snippet, required): renders the button that opens it. It gets
	  one argument, the props to spread on that button
	  (`<button {...props}>⋯</button>`): its `onclick` toggles the menu, and
	  `aria-haspopup`, `aria-expanded` and `data-menu-trigger` (how the focus
	  finds its way back) come with it. Do not set another `onclick`.
	- `header` (snippet, optional): shown above the items, in both forms (the
	  row menu's session label and "folder · age · messages").
	- `children` (snippet): the items. Use `MenuItem` for actions (and toggles,
	  with `checked`), `MenuSeparator` between groups, and any plain markup for
	  text (a folder's path) or custom controls; give a custom control
	  `data-menu-item` to put it in the arrow-key order.
	- `align`: `'end'` (default, the popover's right edge on the trigger's) or
	  `'start'`.
	- `width`: the popover's width class (default `w-56`); the sheet is always
	  full width.
	- `class`: classes for the wrapper (it is `relative`, the popover's anchor).
	- `onclose`: called whenever it closes, however.

	The sheet is `fixed`, so inside the phone drawer (which is translated, and so
	the containing block of fixed descendants) it spans the drawer, not the
	whole screen, as in the mockups.
-->
<script lang="ts">
	import {tick, type Snippet} from 'svelte';
	import {setMenuContext, type MenuTriggerProps} from './menu-context';
	import {MENU_SHEET_QUERY, menuNavIndex} from '$lib/core/menu-nav';

	let {
		open = $bindable(false),
		label,
		trigger,
		header,
		children,
		align = 'end',
		width = 'w-56',
		class: className = '',
		onclose,
	}: {
		open?: boolean;
		label: string;
		trigger: Snippet<[MenuTriggerProps]>;
		header?: Snippet;
		children: Snippet;
		align?: 'start' | 'end';
		width?: string;
		class?: string;
		onclose?: () => void;
	} = $props();

	let rootEl = $state<HTMLDivElement | null>(null);
	let panelEl = $state<HTMLDivElement | null>(null);

	// Popover at and above `md`, bottom sheet below (follows resizes).
	let wide = $state(
		typeof window !== 'undefined' &&
			!!window.matchMedia?.(MENU_SHEET_QUERY).matches,
	);
	$effect(() => {
		const mq = window.matchMedia?.(MENU_SHEET_QUERY);
		if (!mq) return;
		const update = () => (wide = mq.matches);
		update();
		mq.addEventListener('change', update);
		return () => mq.removeEventListener('change', update);
	});
	let sheet = $derived(!wide);

	// The popover opens upward when there is no room under the trigger.
	let above = $state(false);

	function close(refocus: boolean) {
		if (!open) return;
		open = false;
		onclose?.();
		if (refocus)
			rootEl
				?.querySelector<HTMLElement>('[data-menu-trigger]')
				?.focus({preventScroll: true});
	}

	setMenuContext({
		close: () => close(true),
		get sheet() {
			return sheet;
		},
	});

	function items(): HTMLElement[] {
		if (!panelEl) return [];
		return [
			...panelEl.querySelectorAll<HTMLElement>('[data-menu-item]'),
		].filter((el) => !(el as HTMLButtonElement).disabled);
	}

	$effect(() => {
		if (!open) {
			above = false;
			return;
		}
		void tick().then(() => {
			if (!open || !panelEl) return;
			if (!sheet) {
				const r = panelEl.getBoundingClientRect();
				const triggerTop = rootEl?.getBoundingClientRect().top ?? 0;
				if (r.bottom > window.innerHeight - 8 && triggerTop - r.height > 8)
					above = true;
			}
			if (!panelEl.contains(document.activeElement))
				items()[0]?.focus({preventScroll: true});
		});
	});

	function toggle(e: MouseEvent) {
		e.stopPropagation();
		if (open) close(false);
		else open = true;
	}

	function onPanelKeyDown(e: KeyboardEvent) {
		const list = items();
		const next = menuNavIndex(
			list.indexOf(document.activeElement as HTMLElement),
			list.length,
			e.key,
		);
		if (next === null) return;
		e.preventDefault();
		list[next].focus();
	}

	function onWindowPointerDown(e: PointerEvent) {
		if (open && rootEl && !rootEl.contains(e.target as Node)) close(false);
	}

	function onWindowKeyDown(e: KeyboardEvent) {
		if (open && e.key === 'Escape') {
			e.preventDefault();
			close(true);
		}
	}
</script>

<svelte:window
	onpointerdown={onWindowPointerDown}
	onkeydown={onWindowKeyDown}
/>

<div class="relative {className}" bind:this={rootEl}>
	{@render trigger({
		onclick: toggle,
		'aria-haspopup': 'menu',
		'aria-expanded': open,
		'data-menu-trigger': '',
	})}
	{#if open}
		{#if sheet}
			<div class="fixed inset-0 z-50 flex flex-col justify-end">
				<button
					type="button"
					class="absolute inset-0 cursor-default bg-black/55"
					aria-label="Close menu"
					tabindex="-1"
					onclick={() => close(true)}
				></button>
				<div
					bind:this={panelEl}
					role="menu"
					tabindex="-1"
					aria-label={label}
					onkeydown={onPanelKeyDown}
					class="relative max-h-[85%] overflow-y-auto rounded-t-2xl border-t border-brand-border bg-brand-surface-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] text-sm text-brand-text shadow-2xl"
				>
					<div class="flex justify-center pt-2 pb-1" aria-hidden="true">
						<span class="h-1 w-10 rounded-full bg-brand-text-muted/40"></span>
					</div>
					{#if header}
						<div class="border-b border-brand-border/60 px-4 pt-1 pb-2.5">
							{@render header()}
						</div>
					{/if}
					<div class="py-1">
						{@render children()}
					</div>
				</div>
			</div>
		{:else}
			<div
				bind:this={panelEl}
				role="menu"
				tabindex="-1"
				aria-label={label}
				onkeydown={onPanelKeyDown}
				class="absolute z-40 {align === 'end' ? 'right-0' : 'left-0'} {above
					? 'bottom-full mb-1'
					: 'top-full mt-1'} {width} overflow-hidden rounded-lg border border-brand-border bg-brand-surface-2 text-xs text-brand-text shadow-xl"
			>
				{#if header}
					<div class="border-b border-brand-border/60 px-3 py-2">
						{@render header()}
					</div>
				{/if}
				<div class="py-1">
					{@render children()}
				</div>
			</div>
		{/if}
	{/if}
</div>
