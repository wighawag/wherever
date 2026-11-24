<script lang="ts">
	/**
	 * Conversation search: full-text search over EVERY past session, backed by
	 * the memonaut index server-side (`GET /search`).
	 *
	 * Two things this panel must get right:
	 *  - **Forks are not collapsed.** A match in history shared by a fork family
	 *    is carried by several sessions; the server returns all of them, newest
	 *    active first, with a `+N after` count that is the only thing telling
	 *    byte-identical siblings apart. Each is independently clickable, so this
	 *    lands you in the continuation you actually meant, the same way the
	 *    sidebar's fork tree does.
	 *  - **It obeys the dashboard's visibility rules.** Which sessions are
	 *    searchable at all is decided on the server (see
	 *    server/src/conversation-search.ts); this panel simply mirrors the two
	 *    views: the main list, and the read-only page. Closed sessions are left
	 *    out unless "Include closed" is on (remembered on this device, shared by
	 *    both views); included ones render dimmed. The date range (Any time by
	 *    default, also remembered and shared) bounds when the MATCHED MESSAGE
	 *    was said; its window is computed per request, so it moves with the
	 *    clock.
	 */
	import {untrack} from 'svelte';
	import {
		searchConversations,
		type SearchHitResult,
		type SearchResponse,
		type SearchThreadResult,
	} from '$lib/session-store';
	import {
		switchSession,
		activeSessionInfo,
		isLoadingSession,
		isResyncing,
		dismissSessionError,
	} from '$lib/wherever';
	import {
		snippetSegments,
		snippetPlainText,
		hitKindLabel,
		relativeTime,
	} from '$lib/core/search-snippet.js';
	import {
		readIncludeClosed,
		writeIncludeClosed,
	} from '$lib/core/search-request.js';
	import {
		SEARCH_RANGES,
		readSearchRange,
		writeSearchRange,
		rangeToSince,
		type SearchRange,
	} from '$lib/core/search-range.js';

	function settingStorage(): Storage | undefined {
		try {
			return localStorage;
		} catch {
			return undefined;
		}
	}

	let {
		readOnly = false,
		initialQuery = '',
		onOpened,
	}: {
		/** Search the read-only page's folders instead of the main list. */
		readOnly?: boolean;
		initialQuery?: string;
		/** Called after a result is opened (used to close the sidebar on mobile). */
		onOpened?: () => void;
	} = $props();

	// Seeded once from the prop (the panel can be opened with text already typed
	// in the sidebar's filter box); from then on the input owns it.
	let query = $state(untrack(() => initialQuery));
	let result = $state<SearchResponse | null>(null);
	let loading = $state(false);
	let inputEl = $state<HTMLInputElement | null>(null);
	// Threads beyond the first are folded away per hit until asked for, so one
	// heavily forked conversation cannot own the panel.
	let expandedThreads = $state<Record<string, boolean>>({});
	let includeClosed = $state(readIncludeClosed(settingStorage()));
	let range = $state<SearchRange>(readSearchRange(settingStorage()));

	let currentSession = $derived($activeSessionInfo.sessionFile);
	let loadingSession = $derived($isLoadingSession);
	let resyncing = $derived($isResyncing);

	const MIN_QUERY = 2;
	const DEBOUNCE_MS = 250;
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;

	// Focus on open, and run a prefilled query straight away (the panel can be
	// opened from the sidebar's list filter with the text already typed).
	let started = false;
	$effect(() => {
		inputEl?.focus();
		if (started) return;
		started = true;
		if (query.trim().length >= MIN_QUERY) {
			loading = true;
			void run(query);
		}
	});

	function scheduleSearch(next: string) {
		query = next;
		if (debounceTimer) clearTimeout(debounceTimer);
		if (next.trim().length < MIN_QUERY) {
			loading = false;
			result = null;
			return;
		}
		loading = true;
		debounceTimer = setTimeout(() => {
			debounceTimer = null;
			void run(next);
		}, DEBOUNCE_MS);
	}

	async function run(text: string) {
		const response = await searchConversations(
			text.trim(),
			readOnly ? 'readonly' : 'default',
			// The window is computed NOW, at request time, never cached.
			{includeClosed, since: rangeToSince(range, Date.now())},
		);
		// null = superseded by a newer query; keep what is on screen.
		if (response === null) return;
		result = response;
		loading = false;
		expandedThreads = {};
	}

	function submit(e: Event) {
		e.preventDefault();
		if (debounceTimer) clearTimeout(debounceTimer);
		if (query.trim().length < MIN_QUERY) return;
		loading = true;
		void run(query);
	}

	function toggleIncludeClosed() {
		includeClosed = !includeClosed;
		writeIncludeClosed(settingStorage(), includeClosed);
		rerunNow();
	}

	function changeRange(next: string) {
		const picked = SEARCH_RANGES.find((r) => r.value === next)?.value;
		if (!picked || picked === range) return;
		range = picked;
		writeSearchRange(settingStorage(), range);
		rerunNow();
	}

	// A setting changed (Include closed, date range): re-run the current query at
	// once, like a submit. A pending debounce is cleared so it cannot fire
	// afterwards, and the request goes through the store's abort/supersede path
	// like any other, so an in-flight request with the old setting is aborted.
	function rerunNow() {
		if (debounceTimer) {
			clearTimeout(debounceTimer);
			debounceTimer = null;
		}
		if (query.trim().length < MIN_QUERY) return;
		loading = true;
		void run(query);
	}

	function open(thread: SearchThreadResult) {
		if (
			currentSession === thread.sessionPath &&
			!loadingSession &&
			!resyncing
		) {
			onOpened?.();
			return;
		}
		dismissSessionError();
		// The server normalizes `sessionPath` exactly like the /sessions listing,
		// so this is the same call the sidebar makes for the same session.
		switchSession(thread.sessionPath);
		onOpened?.();
	}

	function hitKey(hit: SearchHitResult, i: number): string {
		return `${hit.entryKey}-${i}`;
	}

	function threadLabel(thread: SearchThreadResult): string {
		return thread.name || `${thread.folderName} · ${thread.entryCount} entries`;
	}
</script>

<!-- One clickable session. The SAME row renders the primary thread and each
     sibling fork of a shared-history match: they are the same thing (a session
     carrying this entry), so they must look and behave alike. -->
{#snippet threadRow(thread: SearchThreadResult, extraClass: string)}
	<button
		onclick={() => open(thread)}
		class="flex w-full items-start gap-2 rounded px-1.5 py-1 text-left transition-colors hover:bg-brand-surface-3/40 {extraClass} {thread.closed
			? 'opacity-50'
			: ''}"
		title={thread.closed
			? `Closed · ${thread.sessionPath}`
			: thread.sessionPath}
	>
		<span class="mt-0.5 flex-shrink-0 text-brand-text-muted"
			>{thread.isRoot ? '•' : '↳'}</span
		>
		<span class="min-w-0 flex-1">
			<span class="block truncate text-xs text-brand-text"
				>{threadLabel(thread)}</span
			>
			<span class="block text-[10px] text-brand-text-muted">
				{thread.folderName} · {relativeTime(thread.lastActivity)} · +{thread.after}
				after{#if thread.closed}{' '}· Closed{/if}
			</span>
		</span>
	</button>
{/snippet}

<div class="flex h-full flex-col">
	<div class="border-b border-brand-border/50 p-2">
		<form onsubmit={submit} class="flex gap-1.5">
			<input
				bind:this={inputEl}
				type="search"
				placeholder={readOnly
					? 'Search read-only conversations...'
					: 'Search all conversations...'}
				value={query}
				oninput={(e) => scheduleSearch(e.currentTarget.value)}
				class="min-w-0 flex-1 rounded border border-brand-border bg-brand-surface-2 px-2 py-1.5 text-xs text-brand-text placeholder-brand-text-muted focus:border-brand-blue focus:outline-none"
			/>
			<button
				type="submit"
				class="flex shrink-0 items-center justify-center rounded border border-brand-border bg-brand-surface-2 px-2 py-1.5 text-brand-text-muted transition-colors hover:bg-brand-surface-3 hover:text-brand-text"
				title="Search"
			>
				<span class={loading ? 'animate-pulse' : ''}>🔎</span>
			</button>
		</form>
		<div class="mt-1 px-0.5 text-[10px] text-brand-text-muted">
			Words are ANDed; use "quoted phrases", OR, NOT, or a trailing * for
			prefixes.
		</div>
		<div class="mt-1.5 flex flex-wrap items-center gap-3 px-0.5">
			<label
				class="flex cursor-pointer items-center gap-1.5 text-[10px] text-brand-text-muted select-none hover:text-brand-text"
				title="Search closed sessions too (shown dimmed)"
			>
				<input
					type="checkbox"
					checked={includeClosed}
					onchange={toggleIncludeClosed}
					class="h-3 w-3 rounded border-brand-border bg-brand-surface-2 text-brand-blue focus:ring-brand-blue"
				/>
				Include closed
			</label>
			<label
				class="flex items-center gap-1.5 text-[10px] text-brand-text-muted"
				title="Only matches said within this window"
			>
				<span class="sr-only">Date range</span>
				<select
					value={range}
					onchange={(e) => changeRange(e.currentTarget.value)}
					class="rounded border border-brand-border bg-brand-surface-2 px-1 py-0.5 text-[10px] text-brand-text-muted hover:text-brand-text focus:border-brand-blue focus:outline-none"
				>
					{#each SEARCH_RANGES as option (option.value)}
						<option value={option.value}>{option.label}</option>
					{/each}
				</select>
			</label>
		</div>
	</div>

	<div class="flex-1 overflow-y-auto">
		{#if query.trim().length < MIN_QUERY}
			<div class="p-3 text-xs text-brand-text-muted">
				Type at least {MIN_QUERY} characters to search everything ever said in any
				session.
			</div>
		{:else if loading && !result}
			<div class="p-3 text-xs text-brand-text-muted">Searching…</div>
		{:else if result?.status === 'not-indexed'}
			<div class="space-y-2 p-3 text-xs text-brand-text-muted">
				<div class="font-semibold text-brand-text">
					No conversation index yet
				</div>
				<p>
					Search is backed by the <code class="text-brand-blue">memonaut</code> index,
					which has not been built on this machine. Building it takes about a minute
					and is deliberately never done from here, because it would freeze the server
					while it ran.
				</p>
				<p>Run this on the server, then search again:</p>
				<pre
					class="overflow-x-auto rounded bg-brand-surface-2 p-2 text-brand-text">recall index</pre>
				{#if result.index?.path}
					<div class="break-all opacity-70">
						Expected at {result.index.path}
					</div>
				{/if}
			</div>
		{:else if result?.status === 'unavailable' || result?.status === 'error'}
			<div class="p-3 text-xs text-rose-400">
				{result.message || 'Search is unavailable.'}
			</div>
		{:else if result && result.hits.length === 0}
			<div class="p-3 text-xs text-brand-text-muted">
				No matches for “{result.query}”.
				{#if result.hiddenHits}
					<div class="mt-1 opacity-70">
						{result.hiddenHits} match{result.hiddenHits === 1 ? '' : 'es'} were in
						sessions not shown here.
					</div>
				{/if}
			</div>
		{:else if result}
			<div
				class="flex items-center justify-between border-b border-brand-border/30 px-3 py-1.5 text-[10px] text-brand-text-muted"
			>
				<span>
					{result.hits.length} result{result.hits.length === 1 ? '' : 's'}
					{#if result.hiddenHits}· {result.hiddenHits} hidden{/if}
				</span>
				{#if result.index}
					<span title={result.index.path}>
						{result.index.files.toLocaleString()} sessions indexed
					</span>
				{/if}
			</div>

			{#each result.hits as hit, i (hitKey(hit, i))}
				{@const key = hitKey(hit, i)}
				{@const primary = hit.threads[0]}
				{@const rest = hit.threads.slice(1)}
				<div class="border-b border-brand-border/30 px-3 py-2">
					<div
						class="flex items-center gap-2 text-[10px] tracking-wide text-brand-text-muted uppercase"
					>
						<span class="rounded bg-brand-surface-2 px-1.5 py-0.5"
							>{hitKindLabel(hit.kind, hit.tool)}</span
						>
						<span>{relativeTime(hit.ts)}</span>
						{#if primary?.readOnly}
							<span class="text-amber-400" title="Read-only session">👁️</span>
						{/if}
					</div>

					<p class="mt-1 text-xs leading-relaxed text-brand-text">
						{#each snippetSegments(hit.snippet) as segment}
							{#if segment.match}
								<mark class="rounded bg-brand-blue/30 px-0.5 text-brand-text"
									>{segment.text}</mark
								>
							{:else}{segment.text}{/if}
						{/each}
					</p>

					{#if primary}
						{@render threadRow(primary, 'mt-1.5')}
					{/if}

					{#if rest.length > 0}
						<!-- Shared history: the SAME entry lives in every fork that
						     inherited it, so every one of them is offered. -->
						<button
							onclick={() => (expandedThreads[key] = !expandedThreads[key])}
							class="mt-1 px-1.5 text-[10px] text-brand-blue hover:underline"
						>
							matched in shared history · carried by {hit.threadTotal} sessions
							{expandedThreads[key] ? '▲' : '▼'}
						</button>
						{#if expandedThreads[key]}
							<div class="mt-0.5 border-l border-brand-border/40 pl-2">
								{#each rest as thread (thread.sessionPath)}
									{@render threadRow(thread, '')}
								{/each}
							</div>
						{/if}
					{/if}

					{#if hit.otherHits > 0}
						<div
							class="px-1.5 pt-0.5 text-[10px] text-brand-text-muted"
							title={snippetPlainText(hit.snippet)}
						>
							+{hit.otherHits} more match{hit.otherHits === 1 ? '' : 'es'} in this
							conversation
						</div>
					{/if}
				</div>
			{/each}
		{/if}
	</div>
</div>
