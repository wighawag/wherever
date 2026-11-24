<script lang="ts">
	// One sidebar session row: link, working dot, name / preview, "spawned by"
	// hint, presence line, star / close / delete, and the owned-children chips
	// under it. Rendered by the folder view, and meant for the By-owner view
	// (spec `session-list-by-owner-view`). It only renders: text comes from pure
	// helpers (core/session-row.ts, core/live-sessions.ts, core/shipmates.ts) and
	// every action is a callback, like LiveStrip.svelte. Owned by the parent: the
	// delete-confirm state (one row at a time), the close cascade (`closeSession`
	// in the store), and which rows / chips are shown (core/closed-sessions.ts).
	import {sessionListLabel} from '$lib/core/live-sessions';
	import {
		ownedChipLabel,
		relativeTime,
		rowNestMarker,
		type RowNestKind,
	} from '$lib/core/session-row';
	import {presenceLine, type ShipmatesPresence} from '$lib/core/shipmates';
	import type {SessionInfo} from '$lib/session-store';

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
		ownedChildren = [],
		showOwned = true,
		confirmingDelete = false,
		onOpen,
		onStar,
		onToggleClosed,
		onAskDelete,
		onCancelDelete,
		onDelete,
	}: {
		session: SessionInfo;
		/** Nesting depth; > 0 indents the row and shows the "↳" marker. */
		depth?: number;
		/** This is the open session (highlighted). */
		current?: boolean;
		/** Read-only page: no close / reopen and no delete. */
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
		/** The owned sessions to show as chips (already filtered by the parent). */
		ownedChildren?: SessionInfo[];
		/** Show the owned-children chips under the row. */
		showOwned?: boolean;
		/** The delete button is in its confirm state. */
		confirmingDelete?: boolean;
		/** Plain left click on the row or a chip; modifier clicks keep the native link. */
		onOpen: (path: string) => void;
		onStar: (path: string, starred: boolean) => void;
		/** Close (the parent runs the cascade prompt) or reopen. */
		onToggleClosed: (path: string, closed: boolean) => void;
		onAskDelete: (path: string) => void;
		onCancelDelete: () => void;
		onDelete: (path: string) => void;
	} = $props();

	let marker = $derived(rowNestMarker(nestKind));
	let line = $derived(presenceLine(presence));
</script>

<div
	style={depth > 0 ? `margin-left: ${depth * 0.85}rem` : ''}
	class="group flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition-colors hover:bg-brand-surface-3/30 {depth >
	0
		? 'border-l border-brand-border/60 pl-2'
		: ''} {current ? 'bg-brand-surface-3' : ''} {closed || dimmed
		? 'opacity-50'
		: ''}"
	title={rowTitle}
>
	{#if depth > 0}
		<span
			class="flex-shrink-0 text-brand-text-muted"
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
		class="flex min-w-0 flex-1 items-center gap-2 text-left no-underline"
	>
		{#if session.isWorking}
			<span
				class="h-2 w-2 flex-shrink-0 animate-pulse rounded-full bg-amber-400"
				role="img"
				title="Agent is working"
				aria-label="Agent is working"
			></span>
		{:else if session.isActive}
			<span class="h-2 w-2 flex-shrink-0 rounded-full bg-emerald-500"></span>
		{:else}
			<span class="h-2 w-2 flex-shrink-0 rounded-full bg-brand-surface-3"
			></span>
		{/if}
		<div class="min-w-0 flex-1">
			<div class="truncate text-xs text-brand-text">
				{#if closed}
					<span
						class="mr-1 rounded border border-brand-border px-1 text-[9px] tracking-wide text-brand-text-muted uppercase"
						>Closed</span
					>
				{/if}
				{sessionListLabel(session)}
			</div>
			<div class="text-xs text-brand-text-muted">
				{relativeTime(session.modified)} · {session.messageCount}
				msgs
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
					class="truncate text-[10px] {presence?.state === 'waiting-for-human'
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

	<!-- Star toggle: always visible once starred, on hover otherwise
	     (always on touch screens, which have no hover). -->
	<button
		onclick={(e) => {
			e.stopPropagation();
			onStar(session.path, !session.starred);
		}}
		class="flex-shrink-0 p-1 text-sm focus:outline-none {session.starred
			? 'text-amber-400 hover:text-brand-text-muted'
			: 'text-brand-text-muted transition-opacity hover:text-amber-400 md:opacity-0 md:group-hover:opacity-100'}"
		title={session.starred ? 'Unstar' : 'Star to come back to it later'}
		aria-label={session.starred ? 'Unstar session' : 'Star session'}
	>
		{session.starred ? '★' : '☆'}
	</button>

	<!-- Close / Reopen (main list only, like delete). Always shown on a
	     closed row (its Reopen action), on hover otherwise. -->
	{#if !readOnly}
		<button
			onclick={(e) => {
				e.stopPropagation();
				onToggleClosed(session.path, !closed);
			}}
			class="flex-shrink-0 p-1 text-xs focus:outline-none {closed
				? 'text-brand-text hover:text-brand-blue'
				: 'text-brand-text-muted transition-opacity hover:text-brand-text md:opacity-0 md:group-hover:opacity-100'}"
			title={closed
				? 'Reopen: list it again'
				: 'Close: done with it (hidden, not deleted)'}
			aria-label={closed ? 'Reopen session' : 'Close session'}
		>
			{closed ? '↺' : '⊘'}
		</button>
	{/if}

	<!-- Delete button with confirm state (hidden in read-only mode) -->
	{#if !readOnly}
		<div class="flex-shrink-0">
			{#if confirmingDelete}
				<div
					class="flex items-center gap-1 rounded border border-red-500/30 bg-brand-surface-2/80 px-1 py-0.5"
				>
					<button
						onclick={(e) => {
							e.stopPropagation();
							onDelete(session.path);
						}}
						class="px-1.5 text-xs font-bold text-rose-400 hover:text-rose-300 focus:outline-none"
						title="Confirm Delete"
					>
						❓
					</button>
					<button
						onclick={(e) => {
							e.stopPropagation();
							onCancelDelete();
						}}
						class="px-1.5 text-[10px] text-brand-text-muted hover:text-brand-text focus:outline-none"
						title="Cancel"
					>
						✕
					</button>
				</div>
			{:else}
				<button
					onclick={(e) => {
						e.stopPropagation();
						onAskDelete(session.path);
					}}
					class="p-1 text-xs text-brand-text-muted transition-opacity hover:text-rose-400 focus:outline-none md:opacity-0 md:group-hover:opacity-100"
					title="Delete session"
				>
					✕
				</button>
			{/if}
		</div>
	{/if}
</div>
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
