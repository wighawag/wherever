<script module lang="ts">
	// Which row has "⊘ Close" revealed by a swipe: one at a time across every
	// row (a new reveal snaps the previous one back).
	const swipeReveal = $state<{row: symbol | null}>({row: null});
</script>

<script lang="ts">
	// One sidebar session row: link, state dot (core/state-dot.ts), name / preview,
	// "age · msgs · owns N · ★", "spawned by" hint, presence line, the owned-
	// children chips under it, and ONE ⋯ menu (components/menu: a bottom sheet on
	// phone, a popover on desktop) plus, on a desktop hover, a one-click ⊘ Close
	// (↺ Reopen on a closed row). Rendered by the folder view and the By-owner
	// view. It only renders: text and the menu's items come from pure helpers
	// (core/session-row.ts, core/live-sessions.ts, core/shipmates.ts) and every
	// action is a callback, like LiveStrip.svelte. Rename opens the shared
	// RenamePrompt.svelte, which this row mounts (only while it is open). Owned by the parent: the
	// delete-confirm state (one row at a time), the close cascade (`closeSession`
	// in the store, which every close entry point goes through), and which rows /
	// chips are shown (core/closed-sessions.ts). The row stays a real link
	// (`<a href="#<id>">`), so modifier clicks and long-press stay native.
	// On touch, an open row of the main list swipes left to reveal "⊘ Close"
	// (core/row-swipe.ts decides the gesture; `touch-action: pan-y` keeps the
	// vertical scroll native, and any gesture that is not a row swipe is left
	// to the browser).
	import {copyText} from '$lib/core/clipboard';
	import {sessionListLabel} from '$lib/core/live-sessions';
	import {MENU_SHEET_QUERY} from '$lib/core/menu-nav';
	import {
		closeOwnedHint,
		ownedChipLabel,
		rowHoverAction,
		rowMenuHeaderMeta,
		rowMenuItems,
		rowMetaLine,
		rowNestMarker,
		sessionLinkUrl,
		type RowNestKind,
	} from '$lib/core/session-row';
	import {
		SWIPE_ACTION_WIDTH_PX,
		SWIPE_SETTLE_MS,
		nextSwipeDecision,
		rowCanSwipe,
		swipeOffset,
		swipeRelease,
		type SwipeDecision,
	} from '$lib/core/row-swipe';
	import {presenceLine, type ShipmatesPresence} from '$lib/core/shipmates';
	import {sessionDotState} from '$lib/core/state-dot';
	import type {SessionInfo} from '$lib/session-store';
	import StateDot from './StateDot.svelte';
	import Menu from './menu/Menu.svelte';
	import MenuItem from './menu/MenuItem.svelte';
	import MenuSeparator from './menu/MenuSeparator.svelte';
	import RenamePrompt from './RenamePrompt.svelte';

	let {
		session,
		depth = 0,
		current = false,
		readOnly = false,
		closed = false,
		dimmed = false,
		rowTitle,
		nestKind = 'fork',
		presence,
		ownerHint,
		folderTag,
		folderName,
		ownedChildren = [],
		ownedCount,
		showOwned = true,
		confirmingDelete = false,
		onOpen,
		onStar,
		onToggleClosed,
		onAskDelete,
		onCancelDelete,
		onDelete,
		onRename,
		fetchOwnedCount,
	}: {
		session: SessionInfo;
		/** Nesting depth; > 0 indents the row and shows the "↳" marker. */
		depth?: number;
		/** This is the open session (highlighted). */
		current?: boolean;
		/** Read-only page: no close / reopen and no delete (menu: Star, Copy link, Open in new tab). */
		readOnly?: boolean;
		/** Marked closed: "Closed" badge, dimmed, and the Reopen action. */
		closed?: boolean;
		/** Dimmed as context only (not closed): visual, no other change. */
		dimmed?: boolean;
		/** The row's tooltip (the parent words the closed reason). */
		rowTitle?: string;
		/** What the "↳" marker of a nested row means. */
		nestKind?: RowNestKind;
		/** shipmates presence of this session, if any. */
		presence?: ShipmatesPresence;
		/** Owner's label for "↳ spawned by <ownerHint>"; no hint when empty. */
		ownerHint?: string;
		/** The folder as a small tag (the By-owner view); no tag when empty. */
		folderTag?: string;
		/** The folder's name for the phone sheet's header (else `folderTag`). */
		folderName?: string;
		/** The owned sessions to show as chips (already filtered by the parent). */
		ownedChildren?: SessionInfo[];
		/** "owns N" in the second line; defaults to `ownedChildren.length`. */
		ownedCount?: number;
		/** Show the owned-children chips under the row. */
		showOwned?: boolean;
		/** The menu's Delete… is in its "asks again" state. */
		confirmingDelete?: boolean;
		/** Plain left click on the row or a chip; modifier clicks keep the native link. */
		onOpen: (path: string) => void;
		onStar: (path: string, starred: boolean) => void;
		/** Close (the parent runs the cascade prompt) or reopen. */
		onToggleClosed: (path: string, closed: boolean) => void;
		onAskDelete: (path: string) => void;
		onCancelDelete: () => void;
		onDelete: (path: string) => void;
		/**
		 * Write a new name (`renameSession`); its rejection's message shows in
		 * the prompt. No Rename item without it (and never on the read-only page).
		 */
		onRename?: (path: string, name: string) => Promise<unknown>;
		/**
		 * The owned sessions a close would cascade to (`/sessions/owned`), asked
		 * when the menu opens for Close's "and N owned"; no hint without it.
		 */
		fetchOwnedCount?: (path: string) => Promise<number>;
	} = $props();

	let marker = $derived(rowNestMarker(nestKind));
	let line = $derived(presenceLine(presence));
	let dotState = $derived(sessionDotState(session, presence, closed));
	let label = $derived(sessionListLabel(session));
	let faded = $derived(closed || dimmed ? 'opacity-50' : '');
	let owns = $derived(ownedCount ?? ownedChildren.length);
	let hoverAction = $derived(rowHoverAction({readOnly, closed}));

	function isWide(): boolean {
		return (
			typeof window !== 'undefined' &&
			!!window.matchMedia?.(MENU_SHEET_QUERY).matches
		);
	}
	// Popover (desktop) or sheet (phone): read when the menu opens.
	let desktop = $state(isWide());
	let menuOpen = $state(false);
	let items = $derived(
		rowMenuItems({readOnly, closed, desktop}).filter(
			(item) => item !== 'rename' || !!onRename,
		),
	);
	let renaming = $state(false);

	// Close's "and N owned": asked when the menu opens, no hint until it answers.
	let ownedN = $state<number | undefined>(undefined);
	let ownedAsk = 0;
	$effect(() => {
		if (!menuOpen || readOnly || closed || !fetchOwnedCount) return;
		const ask = ++ownedAsk;
		const path = session.path;
		ownedN = undefined;
		fetchOwnedCount(path).then(
			(n) => {
				if (ask === ownedAsk) ownedN = n;
			},
			() => {},
		);
	});

	function link(): string {
		return sessionLinkUrl(window.location, session.id);
	}

	// Copy link: "Copied" in place, then the menu closes; on failure the link
	// shows in the menu, selectable, to copy by hand.
	let copyState = $state<'idle' | 'copied' | 'failed'>('idle');
	let copyTimer: ReturnType<typeof setTimeout> | undefined;
	async function copyLink() {
		const ok = await copyText(link());
		copyState = ok ? 'copied' : 'failed';
		clearTimeout(copyTimer);
		if (ok)
			copyTimer = setTimeout(() => {
				menuOpen = false;
				onMenuClose();
			}, 900);
	}

	// The touch swipe to close (stories 37 and 38).
	const rowKey = Symbol('session-row');
	let canSwipe = $derived(rowCanSwipe({readOnly, closed}));
	let revealed = $derived(canSwipe && swipeReveal.row === rowKey);
	let dragging = $state(false);
	let dragOffset = $state(0);
	let settling = $state(false);
	let settleTimer: ReturnType<typeof setTimeout> | undefined;
	let swipeEl = $state<HTMLDivElement | undefined>();
	let gesture:
		| {id: number; x: number; y: number; decision: SwipeDecision}
		| undefined;
	// The click that ends a swipe (or the tap that hides a reveal) must not
	// open the row.
	let swallowClick = false;

	let translate = $derived(
		dragging ? dragOffset : revealed ? -SWIPE_ACTION_WIDTH_PX : 0,
	);
	// Transform, clip and opaque background only while a swipe shows: a
	// transform makes the row the containing block of the ⋯ sheet (`fixed`)
	// and a clip would cut its popover.
	let swipeShown = $derived(dragging || revealed || settling);

	function settle() {
		settling = true;
		clearTimeout(settleTimer);
		settleTimer = setTimeout(() => (settling = false), SWIPE_SETTLE_MS);
	}

	function hideReveal() {
		if (swipeReveal.row === rowKey) {
			swipeReveal.row = null;
			settle();
		}
	}

	function onSwipeDown(e: PointerEvent) {
		swallowClick = false;
		gesture = undefined;
		if (e.pointerType !== 'touch' || !e.isPrimary || !canSwipe || menuOpen)
			return;
		if (revealed) {
			// A tap on the revealed row (not its button) only hides the button.
			hideReveal();
			swallowClick = true;
			return;
		}
		if (swipeReveal.row) swipeReveal.row = null;
		gesture = {
			id: e.pointerId,
			x: e.clientX,
			y: e.clientY,
			decision: 'pending',
		};
	}

	function onSwipeMove(e: PointerEvent) {
		if (!gesture || e.pointerId !== gesture.id) return;
		const dx = e.clientX - gesture.x;
		const dy = e.clientY - gesture.y;
		const was = gesture.decision;
		gesture.decision = nextSwipeDecision(was, dx, dy);
		if (gesture.decision === 'pass') {
			gesture = undefined;
			return;
		}
		if (gesture.decision !== 'swipe') return;
		if (was !== 'swipe') {
			dragging = true;
			swallowClick = true;
			try {
				swipeEl?.setPointerCapture(e.pointerId);
			} catch {
				// The pointer may already be gone; the move still applies.
			}
		}
		dragOffset = swipeOffset(dx, swipeEl?.clientWidth ?? 0);
	}

	function onSwipeEnd(e: PointerEvent) {
		if (!gesture || e.pointerId !== gesture.id) return;
		gesture = undefined;
		if (!dragging) return;
		const outcome =
			e.type === 'pointercancel' ? 'snap-back' : swipeRelease(dragOffset);
		dragging = false;
		dragOffset = 0;
		settle();
		if (outcome === 'reveal') {
			swipeReveal.row = rowKey;
			return;
		}
		if (swipeReveal.row === rowKey) swipeReveal.row = null;
		if (outcome === 'close') onToggleClosed(session.path, true);
	}

	function onSwipeClickCapture(e: MouseEvent) {
		if (!swallowClick) return;
		swallowClick = false;
		e.preventDefault();
		e.stopPropagation();
	}

	// While revealed, a touch anywhere outside this row hides the button.
	$effect(() => {
		if (!revealed) return;
		const outside = (e: PointerEvent) => {
			const target = e.target as Node | null;
			if (target && swipeEl?.parentElement?.contains(target)) return;
			hideReveal();
		};
		document.addEventListener('pointerdown', outside, true);
		return () => document.removeEventListener('pointerdown', outside, true);
	});

	// A row that stops being swipeable (closed, or the page went read-only)
	// gives the reveal up.
	$effect(() => {
		if (!canSwipe && swipeReveal.row === rowKey) swipeReveal.row = null;
	});

	$effect(() => () => {
		clearTimeout(settleTimer);
		if (swipeReveal.row === rowKey) swipeReveal.row = null;
	});

	function onMenuClose() {
		clearTimeout(copyTimer);
		copyState = 'idle';
		ownedAsk++;
		ownedN = undefined;
		if (confirmingDelete) onCancelDelete();
	}
</script>

<div
	style={depth > 0 ? `margin-left: ${depth * 0.85}rem` : ''}
	class="relative {swipeShown ? 'overflow-hidden rounded' : ''}"
>
	{#if canSwipe && swipeShown}
		<!-- Behind the row: revealed by a touch swipe left (the mockup's
		     "⊘ Close"). A tap closes, like a release past it. -->
		<button
			type="button"
			onclick={(e) => {
				e.stopPropagation();
				hideReveal();
				onToggleClosed(session.path, true);
			}}
			style="width: {SWIPE_ACTION_WIDTH_PX}px"
			class="absolute inset-y-0 right-0 flex items-center justify-center gap-1 bg-brand-blue/60 text-xs text-white focus:outline-none"
			title="Close: done with it (hidden, not deleted)"
			aria-label="Close session"
			tabindex={revealed ? 0 : -1}>⊘ Close</button
		>
	{/if}
	<div
		bind:this={swipeEl}
		onpointerdown={onSwipeDown}
		onpointermove={onSwipeMove}
		onpointerup={onSwipeEnd}
		onpointercancel={onSwipeEnd}
		onclickcapture={onSwipeClickCapture}
		style="{canSwipe ? 'touch-action: pan-y pinch-zoom;' : ''}{swipeShown
			? `transform: translateX(${translate}px);`
			: ''}{swipeShown && !dragging
			? `transition: transform ${SWIPE_SETTLE_MS}ms ease-out;`
			: ''}"
		class="relative {swipeShown ? 'bg-brand-surface' : ''}"
		role="presentation"
	>
		<div
			class="group flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition-colors hover:bg-brand-surface-3/30 {depth >
			0
				? 'border-l border-brand-border/60 pl-2'
				: ''} {current ? 'bg-brand-surface-3' : ''} {menuOpen && !current
				? 'bg-brand-surface-3/30'
				: ''}"
		>
			<!-- Dimming is on the row's content, not this wrapper: an opacity here
	     would also fade the ⋯ menu's sheet / popover inside it. -->
			{#if depth > 0}
				<span
					class="flex-shrink-0 text-brand-text-muted {faded}"
					title={marker.title}
					aria-label={marker.ariaLabel}>↳</span
				>
			{/if}
			<a
				href="#{encodeURIComponent(session.id)}"
				onclick={(e) => {
					if (
						e.button === 0 &&
						!e.ctrlKey &&
						!e.metaKey &&
						!e.altKey &&
						!e.shiftKey
					) {
						e.preventDefault();
						onOpen(session.path);
					}
				}}
				class="flex min-w-0 flex-1 items-center gap-2 text-left no-underline {faded}"
				title={rowTitle}
			>
				<StateDot dot={dotState} />
				<div class="min-w-0 flex-1">
					<div class="truncate text-xs text-brand-text">
						{#if closed}
							<span
								class="mr-1 rounded border border-brand-border px-1 text-[9px] tracking-wide text-brand-text-muted uppercase"
								>Closed</span
							>
						{/if}
						{label}
					</div>
					<div class="truncate text-xs text-brand-text-muted">
						{rowMetaLine(session, owns)}{#if session.starred}{' · '}<span
								class="text-amber-400"
								title="Starred"
								aria-label="Starred">★</span
							>{/if}
						{#if folderTag}
							<span
								class="ml-1 rounded bg-brand-surface-3/60 px-1 text-[10px] text-brand-text-muted"
								title="Folder: {folderTag}">{folderTag}</span
							>
						{/if}
					</div>
					{#if ownerHint}
						<div
							class="truncate text-[10px] text-brand-text-muted"
							title="Spawned by {session.ownerSessionPath}"
						>
							↳ spawned by {ownerHint}
						</div>
					{/if}
					{#if line}
						<div
							class="truncate text-[10px] {presence?.state ===
							'waiting-for-human'
								? 'text-amber-400'
								: 'text-brand-blue'}"
							title={line}
						>
							{line}
						</div>
					{/if}
				</div>
				{#if session.clientCount > 0}
					<span
						class="rounded bg-brand-surface-3 px-1.5 py-0.5 text-xs text-brand-text"
						>{session.clientCount}</span
					>
				{/if}
			</a>

			<!-- The row's actions. Touch (below md): ⋯ always shown. Desktop: shown
	     on hover / keyboard focus and while its menu is open (out of the
	     layout otherwise, so the title takes the full width), with the
	     one-click ⊘ Close (↺ Reopen on a closed row) beside ⋯. -->
			<div
				class="flex flex-shrink-0 items-center gap-0.5 md:group-focus-within:flex md:group-hover:flex {menuOpen
					? ''
					: 'md:hidden'}"
			>
				{#if hoverAction}
					<!-- Desktop only (hidden below md): touch closes through ⋯. -->
					<button
						type="button"
						onclick={(e) => {
							e.stopPropagation();
							onToggleClosed(session.path, !closed);
						}}
						class="hidden h-6 w-6 items-center justify-center rounded text-xs text-brand-text-muted hover:bg-brand-surface-3 hover:text-brand-text focus:outline-none md:flex"
						title={closed
							? 'Reopen: list it again'
							: 'Close: done with it (hidden, not deleted)'}
						aria-label={closed ? 'Reopen session' : 'Close session'}
					>
						{closed ? '↺' : '⊘'}
					</button>
				{/if}

				<Menu
					label="Session {label}"
					class="flex-shrink-0"
					header={desktop ? undefined : sheetHeader}
					bind:open={menuOpen}
					onclose={onMenuClose}
				>
					{#snippet trigger(props)}
						<button
							{...props}
							onclick={(e) => {
								desktop = isWide();
								props.onclick(e);
							}}
							type="button"
							class="flex h-6 w-6 items-center justify-center rounded text-base leading-none text-brand-text-muted hover:bg-brand-surface-3 hover:text-brand-text focus:outline-none {menuOpen
								? 'bg-brand-surface-3 text-brand-text'
								: ''}"
							title="Session actions"
							aria-label="Session actions for {label}">⋯</button
						>
					{/snippet}
					{#each items as item (item)}
						{#if item === 'close'}
							<MenuItem
								icon="⊘"
								hint={closeOwnedHint(ownedN)}
								title="Close: done with it (hidden, not deleted)"
								onselect={() => onToggleClosed(session.path, true)}
								>Close</MenuItem
							>
						{:else if item === 'reopen'}
							<MenuItem
								icon="↺"
								title="Reopen: list it again"
								onselect={() => onToggleClosed(session.path, false)}
								>Reopen</MenuItem
							>
						{:else if item === 'star'}
							<MenuItem
								icon={session.starred ? '★' : '☆'}
								title={session.starred
									? 'Unstar'
									: 'Star to come back to it later'}
								onselect={() => onStar(session.path, !session.starred)}
								>{session.starred ? 'Unstar' : 'Star'}</MenuItem
							>
						{:else if item === 'rename'}
							<MenuItem
								icon="✎"
								title="Give this session a name"
								onselect={() => (renaming = true)}>Rename</MenuItem
							>
						{:else if item === 'copy-link'}
							<MenuItem
								icon="⧉"
								keepOpen
								hint={copyState === 'copied'
									? '✓'
									: copyState === 'failed'
										? 'copy it by hand'
										: undefined}
								title="Copy the link that opens this session"
								onselect={copyLink}
								>{copyState === 'copied'
									? 'Copied'
									: copyState === 'failed'
										? 'Could not copy'
										: 'Copy link'}</MenuItem
							>
							{#if copyState === 'failed'}
								<div
									class="px-4 py-1 font-mono text-[11px] break-all text-brand-text-muted select-text md:px-3"
								>
									{link()}
								</div>
							{/if}
						{:else if item === 'open-new-tab'}
							<MenuItem
								icon="↗"
								title="Open this session in a new browser tab"
								onselect={() => window.open(link(), '_blank', 'noopener')}
								>Open in new tab</MenuItem
							>
						{:else if item === 'separator'}
							<MenuSeparator />
						{:else if item === 'delete'}
							{#if confirmingDelete}
								<MenuItem
									icon="🗑"
									destructive
									focusOnMount
									title="Delete this session's file"
									onselect={() => onDelete(session.path)}
									>Delete this session?</MenuItem
								>
								<MenuItem icon="✕" keepOpen onselect={onCancelDelete}
									>Cancel</MenuItem
								>
							{:else}
								<MenuItem
									icon="🗑"
									destructive
									keepOpen
									hint="asks again"
									title="Delete session"
									onselect={() => onAskDelete(session.path)}>Delete…</MenuItem
								>
							{/if}
						{/if}
					{/each}
				</Menu>
			</div>
		</div>
	</div>
</div>
{#if onRename}
	<RenamePrompt
		bind:open={renaming}
		currentName={session.name}
		{label}
		onsave={(name) => onRename(session.path, name)}
	/>
{/if}
{#snippet sheetHeader()}
	<div class="truncate text-sm font-semibold text-brand-text">{label}</div>
	<div class="truncate text-xs text-brand-text-muted">
		{rowMenuHeaderMeta(session, folderName ?? folderTag)}
	</div>
{/snippet}
{#if showOwned && ownedChildren.length}
	<!-- shipmates: the sessions this one spawned, wherever they live. -->
	<div
		class="mb-1 ml-6 flex flex-wrap gap-1"
		style={depth > 0 ? `margin-left: ${depth * 0.85 + 1.5}rem` : ''}
	>
		{#each ownedChildren as child (child.path)}
			<a
				href="#{encodeURIComponent(child.id)}"
				onclick={(e) => {
					if (e.button === 0 && !e.ctrlKey && !e.metaKey) {
						e.preventDefault();
						onOpen(child.path);
					}
				}}
				class="max-w-[12rem] truncate rounded bg-brand-surface-3/60 px-1.5 py-0.5 text-[10px] text-brand-text no-underline hover:bg-brand-surface-3 {child.closed
					? 'opacity-50'
					: ''}"
				title="{child.closed
					? 'Closed. '
					: ''}Spawned by this session: {child.path}"
				>↳ {ownedChipLabel(child)}</a
			>
		{/each}
	</div>
{/if}
