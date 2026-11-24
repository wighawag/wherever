<script lang="ts">
	// The Live strip (spec `session-list-live-strip`): the sessions live right now,
	// across folders, pinned above the folder list of the main session list. A
	// view, not a move: the same sessions stay in their folders. Rows come from
	// `liveSessions` (core/live-sessions.ts); opening and naming are the browser's.
	import {
		LIVE_STRIP_CAP,
		LIVE_STRIP_COLLAPSED_KEY,
		liveStripHeader,
		type LiveSessionRow,
		type LiveState,
	} from '$lib/core/live-sessions';
	import type {ShipmatesPresence} from '$lib/core/shipmates';
	import type {SessionInfo} from '$lib/session-store';

	let {
		rows,
		presence,
		currentSession,
		onOpen,
		labelOf,
	}: {
		rows: LiveSessionRow<SessionInfo>[];
		presence: Map<string, ShipmatesPresence>;
		currentSession: string | null | undefined;
		onOpen: (path: string) => void;
		labelOf: (path: string) => string;
	} = $props();

	function readCollapsed(): boolean {
		try {
			return localStorage.getItem(LIVE_STRIP_COLLAPSED_KEY) === '1';
		} catch {
			return false;
		}
	}
	let collapsed = $state(readCollapsed());
	function toggleCollapsed() {
		collapsed = !collapsed;
		try {
			if (collapsed) localStorage.setItem(LIVE_STRIP_COLLAPSED_KEY, '1');
			else localStorage.removeItem(LIVE_STRIP_COLLAPSED_KEY);
		} catch {
			// No storage (private mode): the state just is not remembered.
		}
	}

	let showAll = $state(false);
	let visible = $derived(showAll ? rows : rows.slice(0, LIVE_STRIP_CAP));
	let hidden = $derived(rows.length - visible.length);

	// "Waiting for you" is amber TEXT like the presence line; running is not
	// amber (the working dot already is), so the two never read as one thing.
	const BADGE_CLASS: Record<LiveState, string> = {
		'waiting-for-human': 'border-amber-400/50 text-amber-400',
		'waiting-for-session': 'border-brand-purple/50 text-brand-purple',
		running: 'border-brand-blue/50 text-brand-blue',
	};
</script>

{#if rows.length}
	<div class="border-b border-brand-border/50 px-2 py-1">
		<button
			type="button"
			onclick={toggleCollapsed}
			aria-expanded={!collapsed}
			class="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[10px] font-semibold tracking-wide text-brand-text-muted uppercase hover:text-brand-text"
		>
			<span class="transition-transform {collapsed ? '' : 'rotate-90'}">▶</span>
			<span class="truncate">{liveStripHeader(rows)}</span>
		</button>
		{#if !collapsed}
			<div class="mt-0.5">
				{#each visible as row (row.session.path)}
					{@const status = presence.get(row.session.path)?.status}
					<a
						href="#{encodeURIComponent(row.session.id)}"
						onclick={(e) => {
							if (
								e.button === 0 &&
								!e.ctrlKey &&
								!e.metaKey &&
								!e.altKey &&
								!e.shiftKey
							) {
								e.preventDefault();
								onOpen(row.session.path);
							}
						}}
						title="{row.label} ({row.folderName}){status ? `: ${status}` : ''}"
						class="flex min-w-0 items-center gap-1.5 rounded px-1.5 py-1 text-[11px] whitespace-nowrap text-brand-text no-underline transition-colors hover:bg-brand-surface-3/30 {currentSession ===
						row.session.path
							? 'bg-brand-surface-3'
							: ''}"
					>
						<span class="max-w-[45%] shrink-0 truncate">{row.label}</span>
						<span
							class="max-w-[30%] shrink-0 truncate rounded bg-brand-surface-3/60 px-1 text-[10px] text-brand-text-muted"
							>{row.folderName}</span
						>
						<span
							class="max-w-[40%] shrink-0 truncate rounded border px-1 text-[10px] {BADGE_CLASS[
								row.state
							]}">{row.stateText}</span
						>
						{#if status}
							<span class="min-w-0 truncate text-[10px] text-brand-text-muted"
								>{status}</span
							>
						{/if}
						{#if row.session.ownerSessionPath}
							<span
								class="min-w-0 truncate text-[10px] text-brand-text-muted"
								title="Spawned by {row.session.ownerSessionPath}"
								>↳ {labelOf(row.session.ownerSessionPath)}</span
							>
						{/if}
					</a>
				{/each}
				{#if hidden > 0}
					<button
						type="button"
						onclick={() => (showAll = true)}
						class="w-full rounded px-1.5 py-0.5 text-left text-[10px] text-brand-blue hover:underline"
						>+{hidden} more</button
					>
				{/if}
			</div>
		{/if}
	</div>
{/if}
