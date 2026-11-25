<script lang="ts">
	// The Live strip (spec `session-list-live-strip`): the sessions live right now,
	// across folders, pinned above the folder list of the main session list. A
	// view, not a move: the same sessions stay in their folders. Rows come from
	// `liveSessions` (core/live-sessions.ts); opening and naming are the browser's.
	import {
		LIVE_STRIP_CAP,
		LIVE_STRIP_COLLAPSED_KEY,
		liveBadgeText,
		liveRowDetail,
		liveStateCounts,
		liveStripHeader,
		type LiveSessionRow,
		type LiveState,
	} from '$lib/core/live-sessions';
	import {liveCountDots, stateDotLabel} from '$lib/core/state-dot';
	import StateDot from './StateDot.svelte';
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

	let header = $derived(liveStripHeader(rows));
	let countDots = $derived(liveCountDots(liveStateCounts(rows)));

	// The badge colours follow the state-dot legend: amber only for "waiting
	// for you", purple for waiting on a session, blue for running.
	const BADGE_CLASS: Record<LiveState, string> = {
		'waiting-for-human': 'border-amber-400/50 text-amber-400',
		'waiting-for-session': 'border-brand-purple/50 text-brand-purple',
		running: 'border-brand-blue/50 text-brand-blue',
	};
</script>

{#if rows.length}
	<div class="border-b border-brand-border/50 px-2 py-0.5">
		<!-- One ~30px line, expanded or collapsed: LIVE, then the count dots of
		     the states present, so "waiting for you" is never hidden. -->
		<button
			type="button"
			onclick={toggleCollapsed}
			aria-expanded={!collapsed}
			aria-label={header}
			title={header}
			class="flex min-h-[26px] w-full items-center gap-1.5 rounded px-1 text-left text-[10px] font-semibold tracking-wide text-brand-text-muted uppercase hover:text-brand-text"
		>
			<span class="transition-transform {collapsed ? '' : 'rotate-90'}">▶</span>
			<span>Live</span>
			<span
				class="ml-auto flex items-center gap-2 font-normal tracking-normal normal-case"
			>
				{#each countDots as dot (dot.state)}
					<span class="inline-flex items-center gap-1">
						<StateDot
							dot={dot.state}
							label="{dot.count} {stateDotLabel(dot.state)}"
						/>{dot.count}
					</span>
				{/each}
			</span>
		</button>
		{#if !collapsed}
			<div class="mt-0.5 pb-0.5">
				{#each visible as row (row.session.path)}
					{@const status = presence.get(row.session.path)?.status}
					{@const owner = row.session.ownerSessionPath
						? labelOf(row.session.ownerSessionPath)
						: undefined}
					{@const detail = liveRowDetail(row, status, owner)}
					{@const isCurrent = currentSession === row.session.path}
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
						title="{row.label}: {detail}"
						class="flex min-w-0 items-center gap-2 rounded px-1.5 py-1 text-brand-text no-underline transition-colors {row.state ===
						'waiting-for-human'
							? isCurrent
								? 'bg-amber-400/20 hover:bg-amber-400/25'
								: 'bg-amber-400/10 hover:bg-amber-400/15'
							: isCurrent
								? 'bg-brand-surface-3'
								: 'hover:bg-brand-surface-3/30'}"
					>
						<StateDot dot={row.state} />
						<span class="flex min-w-0 flex-1 flex-col leading-tight">
							<span class="truncate text-[11px]">{row.label}</span>
							<span class="truncate text-[10px] text-brand-text-muted"
								>{detail}</span
							>
						</span>
						<span
							class="shrink-0 rounded border px-1 text-[10px] {BADGE_CLASS[
								row.state
							]}">{liveBadgeText(row.state)}</span
						>
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
