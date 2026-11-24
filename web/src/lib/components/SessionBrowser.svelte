<script lang="ts">
	import {
		sessionFolders,
		readOnlySessionFolders,
		availableModels,
		fetchSessions,
		fetchReadOnlySessions,
		fetchModels,
		fetchConfig,
		gitInitDefaultStore,
		checkPath,
		autocompletePath,
		setCurrentSession,
		setSessionStarred,
		setSessionClosed,
		closeSession,
		closeBannerStore,
		undoLastClose,
		dismissCloseBanner,
		shipmatesStore,
		type ModelInfo,
		type FolderWithSessions,
	} from '$lib/session-store';
	import {ownedChildren, presenceByFile} from '$lib/core/shipmates';
	import {undoShipmatesDelete} from '$lib/wherever';
	import {closeBannerText} from '$lib/core/close-flow';
	// The Live strip's rows (unit-tested in core). Closed-agnostic on purpose.
	import {liveSessions} from '$lib/core/live-sessions';
	import LiveStrip from './LiveStrip.svelte';
	import SessionRow from './SessionRow.svelte';
	// The folder list: text filter, fork tree, closed sessions hidden unless
	// "Show closed" (unit-tested in core).
	import {
		SHOW_CLOSED_KEY,
		folderListView,
		isSessionShown,
		shownSessions,
		type FolderListEntry,
	} from '$lib/core/closed-sessions';
	// The "By owner" layout: one tree per orchestration across folders, and the
	// toggle's state (unit-tested in core).
	import {
		OWNER_GROUPS_COLLAPSED_KEY,
		SESSION_LIST_VIEW_KEY,
		ownerGroupExpanded,
		ownerGroupRows,
		ownerGroupSummaryText,
		ownerRowHint,
		ownerTree,
		parseCollapsedGroups,
		parseSessionListView,
		serializeCollapsedGroups,
		toggleCollapsedGroup,
		sessionListViewState,
		type SessionListView,
	} from '$lib/core/owner-tree';
	import type {SessionInfo} from '$lib/session-store';
	// shipmates presence (role, state, status line) by session file, the listing's `path`.
	let presence = $derived(presenceByFile($shipmatesStore.presence));

	// When true, this browser shows the read-only sessions page: it sources from
	// the read-only folder list, hides the create form, and hides all delete
	// controls. Opening a session here is forced read-only by the server.
	// `onSearchAll` hands the typed filter text over to conversation search (which
	// searches message CONTENT server-side, not just the names/previews in this
	// list); the filter box itself is unchanged.
	let {
		readOnly = false,
		onSearchAll,
	}: {readOnly?: boolean; onSearchAll?: (query: string) => void} = $props();
	import {
		joinSession,
		switchSession,
		createSession,
		leaveSession,
		activeSessionInfo,
		isConnected,
		isLoadingSession,
		isResyncing,
		sessionError,
		dismissSessionError,
		deleteSession,
	} from '$lib/wherever';

	let folders = $derived(
		readOnly ? $readOnlySessionFolders.folders : $sessionFolders.folders,
	);
	let loading = $derived(
		readOnly ? $readOnlySessionFolders.loading : $sessionFolders.loading,
	);

	function refresh() {
		if (readOnly) {
			fetchReadOnlySessions();
		} else {
			fetchSessions();
		}
	}
	let currentSession = $derived($activeSessionInfo.sessionFile);
	let connected = $derived($isConnected);
	let loadingSession = $derived($isLoadingSession);
	let resyncing = $derived($isResyncing);
	let models = $derived($availableModels.models);

	let expanded = $state<Record<string, boolean>>({});
	let searchExpanded = $state<Record<string, boolean>>({});
	let confirmingDelete = $state<string | null>(null);
	let confirmingDeleteFolder = $state<string | null>(null);
	let searchQuery = $state('');
	let filteredFolders = $state<
		FolderListEntry<FolderWithSessions, SessionInfo>[]
	>([]);
	// "Show closed" (main list only, remembered on this device). The read-only
	// page has no close control, so it lists closed sessions (dimmed) always.
	function readShowClosed(): boolean {
		try {
			return localStorage.getItem(SHOW_CLOSED_KEY) === '1';
		} catch {
			return false;
		}
	}
	let showClosedSetting = $state(readShowClosed());
	let showClosed = $derived(readOnly || showClosedSetting);
	function toggleShowClosed() {
		showClosedSetting = !showClosedSetting;
		try {
			if (showClosedSetting) localStorage.setItem(SHOW_CLOSED_KEY, '1');
			else localStorage.removeItem(SHOW_CLOSED_KEY);
		} catch {
			// No storage (private mode): the setting just is not remembered.
		}
	}
	// shipmates ownership (`session_spawn`): every listed session by path, and the
	// sessions each owner spawned (they may be in other folders, e.g. a worktree).
	let allListed = $derived(folders.flatMap((f) => f.sessions));
	let byPath = $derived(new Map(allListed.map((s) => [s.path, s])));
	let owned = $derived(ownedChildren(allListed));
	// "By folder / By owner" (main list only, remembered on this device). The
	// toggle is hidden, and the list shows "By folder", while "By owner" would
	// mean nothing; the saved choice is kept for when it does again.
	function readSavedView(): SessionListView {
		try {
			return parseSessionListView(localStorage.getItem(SESSION_LIST_VIEW_KEY));
		} catch {
			return 'folder';
		}
	}
	let savedView = $state<SessionListView>(readSavedView());
	let viewState = $derived(
		readOnly
			? {showToggle: false, view: 'folder' as SessionListView}
			: sessionListViewState(savedView, {
					shipmatesAvailable: $shipmatesStore.available,
					sessions: allListed,
				}),
	);
	function setView(view: SessionListView) {
		savedView = view;
		try {
			localStorage.setItem(SESSION_LIST_VIEW_KEY, view);
		} catch {
			// No storage (private mode): the choice just is not remembered.
		}
	}
	// "By owner" with the sidebar filter (matches plus their ancestors as dimmed
	// context) and each group's live-state summary.
	let ownerGroups = $derived(
		viewState.view === 'owner'
			? ownerTree(folders, {
					isVisible: (s) => isSessionShown(s, showClosed),
					filter: searchQuery,
					presence,
				})
			: [],
	);
	// Collapsed By-owner groups (by root path, remembered on this device). A
	// group holding a filter match shows expanded while filtering; that never
	// writes this set.
	function readCollapsedGroups(): Set<string> {
		try {
			return parseCollapsedGroups(
				localStorage.getItem(OWNER_GROUPS_COLLAPSED_KEY),
			);
		} catch {
			return new Set();
		}
	}
	let collapsedGroups = $state<Set<string>>(readCollapsedGroups());
	function toggleGroup(rootPath: string) {
		collapsedGroups = toggleCollapsedGroup(collapsedGroups, rootPath);
		try {
			localStorage.setItem(
				OWNER_GROUPS_COLLAPSED_KEY,
				serializeCollapsedGroups(collapsedGroups, new Set(byPath.keys())),
			);
		} catch {
			// No storage (private mode): the state just is not remembered.
		}
	}
	let undoing = $state<Record<string, boolean>>({});
	// Labels of every session this sidebar has listed, kept after a cascaded
	// delete hides them, so the undo banner can still name what it took.
	const seenLabels = new Map<string, string>();
	$effect(() => {
		for (const s of allListed) {
			const label = s.name || truncate(s.firstMessage);
			if (label) seenLabels.set(s.path, label);
		}
	});
	function sessionLabel(path: string): string {
		const s = byPath.get(path);
		return (
			s?.name ||
			truncate(s?.firstMessage ?? '') ||
			seenLabels.get(path) ||
			'a session'
		);
	}

	// Auto-fetch sessions on connect and periodically
	$effect(() => {
		if (connected) {
			refresh();
			if (!readOnly) {
				fetchModels();
				fetchConfig();
			}
		}
	});

	// The Live strip (main list only): live sessions across folders, same filter.
	let liveRows = $derived(
		readOnly ? [] : liveSessions(folders, presence, searchQuery),
	);

	$effect(() => {
		const q = searchQuery;
		filteredFolders = folderListView(folders, q, showClosed);
		if (!q) searchExpanded = {};
	});

	function toggleStar(sessionPath: string, starred: boolean) {
		// Optimistic in the store; a refusal is rolled back there and logged.
		setSessionStarred(sessionPath, starred).catch(() => {});
	}

	function toggleClosed(sessionPath: string, closed: boolean) {
		// A close asks about owned sessions (N from the server) and shows the undo
		// banner; a reopen is direct. Optimistic in the store, rolled back there.
		if (closed) void closeSession(sessionPath);
		else setSessionClosed(sessionPath, false).catch(() => {});
	}
	let undoingClose = $state(false);

	function isFolderExpanded(folderPath: string): boolean {
		if (searchQuery) {
			if (searchExpanded[folderPath] !== undefined) {
				return searchExpanded[folderPath];
			}
			return true;
		} else {
			return !!expanded[folderPath];
		}
	}

	function toggleFolder(path: string) {
		if (searchQuery) {
			searchExpanded[path] = !isFolderExpanded(path);
		} else {
			expanded[path] = !isFolderExpanded(path);
		}
	}

	async function handleDeleteSession(sessionPath: string) {
		try {
			if (currentSession === sessionPath) {
				if (typeof window !== 'undefined') {
					window.location.hash = '';
				}
				leaveSession();
			}
			await deleteSession(sessionPath);
			if (confirmingDelete === sessionPath) {
				confirmingDelete = null;
			}
			fetchSessions();
		} catch (err) {
			console.error('Failed to delete session:', err);
		}
	}

	// Deletes the sessions the folder SHOWS (its rows), never closed sessions
	// hidden by "Show closed" being off.
	async function handleDeleteAllFolderSessions(
		folder: FolderListEntry<FolderWithSessions, SessionInfo>,
	) {
		try {
			const sessionPaths = folder.rows.map((r) => r.session.path);
			if (currentSession && sessionPaths.includes(currentSession)) {
				if (typeof window !== 'undefined') {
					window.location.hash = '';
				}
				leaveSession();
			}
			await Promise.all(sessionPaths.map((p) => deleteSession(p)));
			if (confirmingDeleteFolder === folder.path) {
				confirmingDeleteFolder = null;
			}
			fetchSessions();
		} catch (err) {
			console.error('Failed to delete all sessions of folder:', err);
		}
	}

	function handleSessionClick(sessionPath: string) {
		// Tapping the already-active session (and not currently loading) is a no-op.
		if (currentSession === sessionPath && !loadingSession && !resyncing) return;
		dismissSessionError();
		// One atomic switch: leave the current session (if any) and load the target.
		// switchSession supersedes any in-flight load and rearms the load watchdog, so
		// a stuck/hung load never blocks tapping a different session, and the latest
		// tap always wins (no fragile leave -> setTimeout -> join gap).
		switchSession(sessionPath);
	}

	// Collapsible Sidebar form state
	let createFormOpen = $state(false);
	let sidebarCwd = $state('');
	let sidebarCompletions = $state<string[]>([]);
	let sidebarInputFocused = $state(false);
	let sidebarInputEl = $state<HTMLInputElement | null>(null);
	let sidebarContainerEl = $state<HTMLDivElement | null>(null);
	let lastCheckedSidebarPath = '';
	let sidebarModel = $state('');
	let sidebarGitInit = $state(false);
	let userManualSidebarGitInit = $state<boolean | null>(null);
	let sidebarCreateRemote = $state(true);
	let sidebarRepoVisibility = $state<'private' | 'public'>('private');
	let showSidebarGitConfirmModal = $state(false);

	let defaultGitInit = $derived($gitInitDefaultStore);

	// Sync git init default
	$effect(() => {
		if (userManualSidebarGitInit === null) {
			sidebarGitInit = defaultGitInit;
		}
	});

	let sidebarPathStatus = $state<{
		exists: boolean | null;
		isGit: boolean;
		resolvedPath: string;
		matchingRule: {provider: string; visibility: string} | null;
	}>({
		exists: null,
		isGit: false,
		resolvedPath: '',
		matchingRule: null,
	});

	let isSidebarRemoteRepoCreation = $derived(
		sidebarPathStatus.exists !== true &&
			sidebarPathStatus.matchingRule &&
			sidebarCreateRemote,
	);

	let sidebarPathCheckTimeout: ReturnType<typeof setTimeout> | null = null;

	async function triggerSidebarCheck(pathValue: string, immediate = false) {
		if (sidebarPathCheckTimeout) clearTimeout(sidebarPathCheckTimeout);

		if (pathValue === lastCheckedSidebarPath && !immediate) return;
		lastCheckedSidebarPath = pathValue;

		if (!pathValue.trim()) {
			sidebarPathStatus = {
				exists: null,
				isGit: false,
				resolvedPath: '',
				matchingRule: null,
			};
			const fetchEmpty = async () => {
				const list = await autocompletePath('');
				sidebarCompletions = list || [];
			};
			if (immediate) {
				await fetchEmpty();
			} else {
				sidebarPathCheckTimeout = setTimeout(fetchEmpty, 300);
			}
			return;
		}

		const fetchFn = async () => {
			const [res, list] = await Promise.all([
				checkPath(pathValue),
				autocompletePath(pathValue),
			]);
			sidebarCompletions = list || [];
			if (res) {
				sidebarPathStatus = {
					exists: res.exists,
					isGit: res.isGit,
					resolvedPath: res.resolvedPath,
					matchingRule: (res as any).matchingRule || null,
				};
				if (!res.exists) {
					sidebarGitInit =
						userManualSidebarGitInit !== null
							? userManualSidebarGitInit
							: defaultGitInit;
					sidebarCreateRemote = true; // reset to true for non-existing folders
					if ((res as any).matchingRule) {
						sidebarRepoVisibility = (res as any).matchingRule.visibility as
							| 'private'
							| 'public';
					}
				}
			} else {
				sidebarPathStatus = {
					exists: null,
					isGit: false,
					resolvedPath: '',
					matchingRule: null,
				};
			}
		};

		if (immediate) {
			await fetchFn();
		} else {
			sidebarPathCheckTimeout = setTimeout(fetchFn, 300);
		}
	}

	$effect(() => {
		const pathValue = sidebarCwd;
		triggerSidebarCheck(pathValue, false);
	});

	// Select default model if any
	$effect(() => {
		if (models.length > 0 && !sidebarModel) {
			const defaultModel = models.find((m: ModelInfo) => m.isDefault);
			if (defaultModel) {
				sidebarModel = `${defaultModel.provider}:${defaultModel.modelId}`;
			} else {
				sidebarModel = `${models[0].provider}:${models[0].modelId}`;
			}
		}
	});

	function handleSidebarCreateSession() {
		if (!sidebarCwd.trim()) return;
		if (sidebarPathStatus.exists === true) {
			sidebarGitInit = false; // toggled off by default in modal
			sidebarCreateRemote = false; // toggled off by default in modal
			if (sidebarPathStatus.matchingRule) {
				sidebarRepoVisibility = sidebarPathStatus.matchingRule.visibility as
					| 'private'
					| 'public';
			}
			showSidebarGitConfirmModal = true;
		} else {
			dismissSessionError();
			const cwd = sidebarCwd.trim();
			const model = sidebarModel || undefined;
			const gitInit = sidebarGitInit;
			const createRemote = sidebarPathStatus.matchingRule
				? sidebarCreateRemote
				: undefined;
			const repoVisibility = sidebarPathStatus.matchingRule
				? sidebarRepoVisibility
				: undefined;

			// Reset state
			sidebarCwd = '';
			createFormOpen = false;

			if (currentSession) {
				leaveSession();
				setTimeout(() => {
					createSession(cwd, model, gitInit, createRemote, repoVisibility);
				}, 100);
			} else {
				createSession(cwd, model, gitInit, createRemote, repoVisibility);
			}
		}
	}

	function handleSidebarConfirmModalSubmit() {
		showSidebarGitConfirmModal = false;
		dismissSessionError();
		const cwd = sidebarCwd.trim();
		const model = sidebarModel || undefined;
		const gitInit = sidebarGitInit;
		const createRemote = sidebarPathStatus.matchingRule
			? sidebarCreateRemote
			: undefined;
		const repoVisibility = sidebarPathStatus.matchingRule
			? sidebarRepoVisibility
			: undefined;

		// Reset state
		sidebarCwd = '';
		createFormOpen = false;

		if (currentSession) {
			leaveSession();
			setTimeout(() => {
				createSession(cwd, model, gitInit, createRemote, repoVisibility);
			}, 100);
		} else {
			createSession(cwd, model, gitInit, createRemote, repoVisibility);
		}
	}

	// New session picker state
	let newSessionPicker = $state<{
		open: boolean;
		folderPath: string;
		selected: string;
	}>({
		open: false,
		folderPath: '',
		selected: '',
	});

	function openNewSessionPicker(folderPath: string) {
		const defaultModel = models.find((m: ModelInfo) => m.isDefault);
		newSessionPicker = {
			open: true,
			folderPath,
			selected: defaultModel
				? `${defaultModel.provider}:${defaultModel.modelId}`
				: '',
		};
	}

	function closeNewSessionPicker() {
		newSessionPicker.open = false;
	}

	function handleCreateSession() {
		if (!newSessionPicker.open) return;
		dismissSessionError();
		const folderPath = newSessionPicker.folderPath;
		const model = newSessionPicker.selected || undefined;
		closeNewSessionPicker();
		if (currentSession) {
			leaveSession();
			setTimeout(() => {
				createSession(folderPath, model);
			}, 100);
		} else {
			createSession(folderPath, model);
		}
	}

	function truncate(text: string, max: number = 40): string {
		return text.length > max ? text.slice(0, max) + '...' : text;
	}
</script>

<div class="flex h-full flex-col">
	{#if !readOnly && $closeBannerStore}
		<!-- The latest close (single or cascading), undoable as one batch (ADR 0025). -->
		{@const c = $closeBannerStore}
		<div class="border-b border-brand-border/50 p-2">
			<div class="flex items-center gap-2 text-[10px] text-brand-text-muted">
				<span class="min-w-0 flex-1 truncate" title={c.sessions.join('\n')}
					>{closeBannerText(sessionLabel(c.root), c.owned)}</span
				>
				<button
					type="button"
					disabled={undoingClose}
					onclick={async () => {
						undoingClose = true;
						await undoLastClose();
						undoingClose = false;
					}}
					class="rounded border border-brand-border bg-brand-surface-2 px-1.5 py-0.5 text-brand-text hover:bg-brand-surface-3 disabled:opacity-50"
					title="Reopen everything this close took, and restore any star it removed"
					>Undo</button
				>
				<button
					type="button"
					onclick={dismissCloseBanner}
					class="px-1 text-brand-text-muted hover:text-brand-text"
					title="Dismiss"
					aria-label="Dismiss">✕</button
				>
			</div>
		</div>
	{/if}
	{#if !readOnly && $shipmatesStore.archives.length}
		<!-- shipmates (D24): a delete that took the sessions a session owns, undoable for 7 days. -->
		<div class="space-y-1 border-b border-brand-border/50 p-2">
			{#each $shipmatesStore.archives as a (a.batch)}
				<div class="flex items-center gap-2 text-[10px] text-brand-text-muted">
					<span class="min-w-0 flex-1 truncate" title={a.sessions.join('\n')}
						>Deleted {sessionLabel(a.root)}{a.sessions.length > 1
							? ` and ${a.sessions.length - 1} owned session${a.sessions.length === 2 ? '' : 's'}`
							: ''}</span
					>
					<button
						type="button"
						disabled={undoing[a.batch]}
						onclick={async () => {
							undoing[a.batch] = true;
							await undoShipmatesDelete(a.batch);
							undoing[a.batch] = false;
						}}
						class="rounded border border-brand-border bg-brand-surface-2 px-1.5 py-0.5 text-brand-text hover:bg-brand-surface-3 disabled:opacity-50"
						title="Bring them back (possible until {new Date(
							a.undoUntil,
						).toLocaleDateString()})">Undo</button
					>
				</div>
			{/each}
		</div>
	{/if}
	<div class="border-b border-brand-border/50 p-2">
		<div class="flex gap-1.5">
			<input
				type="text"
				placeholder="Filter sessions..."
				value={searchQuery}
				oninput={(e) => (searchQuery = e.currentTarget.value)}
				class="min-w-0 flex-1 rounded border border-brand-border bg-brand-surface-2 px-2 py-1.5 text-xs text-brand-text placeholder-brand-text-muted focus:border-brand-blue focus:outline-none"
			/>
			<button
				type="button"
				onclick={() => refresh()}
				class="flex shrink-0 items-center justify-center rounded border border-brand-border bg-brand-surface-2 px-1.5 py-1.5 text-brand-text-muted transition-colors hover:bg-brand-surface-3 hover:text-brand-text"
				title="Refresh session list"
			>
				<span class={loading ? 'animate-spin' : ''}>↻</span>
			</button>
		</div>
		{#if !readOnly}
			<div class="mt-1.5 flex items-center justify-between gap-2">
				<label
					class="flex cursor-pointer items-center gap-1.5 px-1 text-[10px] text-brand-text-muted select-none hover:text-brand-text"
					title="List closed sessions too (dimmed), so you can reopen them"
				>
					<input
						type="checkbox"
						checked={showClosedSetting}
						onchange={toggleShowClosed}
						class="h-3 w-3 rounded border-brand-border bg-brand-surface-2 text-brand-blue focus:ring-brand-blue"
					/>
					Show closed
				</label>
				{#if viewState.showToggle}
					<div
						class="flex overflow-hidden rounded border border-brand-border text-[10px]"
						role="group"
						aria-label="Group sessions"
					>
						{#each [['folder', 'By folder'], ['owner', 'By owner']] as [view, label] (view)}
							<button
								type="button"
								onclick={() => setView(view as SessionListView)}
								aria-pressed={viewState.view === view}
								class="px-1.5 py-0.5 {viewState.view === view
									? 'bg-brand-surface-3 text-brand-text'
									: 'bg-brand-surface-2 text-brand-text-muted hover:text-brand-text'}"
								title={view === 'owner'
									? 'One tree per orchestration: spawned sessions under their owner, across folders'
									: 'Sessions grouped by folder'}>{label}</button
							>
						{/each}
					</div>
				{/if}
			</div>
		{/if}
		{#if onSearchAll && searchQuery.trim().length >= 2}
			<!-- The box above only filters this list (names + first-message previews).
			     This is the way over to full-text search across every message. -->
			<button
				type="button"
				onclick={() => onSearchAll?.(searchQuery.trim())}
				class="mt-1.5 w-full truncate rounded px-1 py-0.5 text-left text-[10px] text-brand-blue hover:underline"
			>
				🔎 Search all conversations for “{searchQuery.trim()}”
			</button>
		{/if}
	</div>

	{#if !readOnly}
		<LiveStrip
			rows={liveRows}
			{presence}
			{currentSession}
			onOpen={handleSessionClick}
			labelOf={sessionLabel}
		/>
	{/if}

	<div class="flex-1 overflow-y-auto">
		<!-- Collapsible Create New Session Section (hidden in read-only mode) -->
		{#if !readOnly}
			<div class="border-b border-brand-border/50 bg-brand-surface/10">
				<button
					onclick={() => (createFormOpen = !createFormOpen)}
					class="flex w-full items-center justify-between px-3 py-2 text-left text-xs font-semibold text-brand-blue transition-colors hover:bg-brand-surface-3/30"
				>
					<span
						>{createFormOpen
							? '▼ Close Create Session'
							: '✚ Create New Session'}</span
					>
				</button>

				{#if createFormOpen}
					<form
						onsubmit={(e) => {
							e.preventDefault();
							handleSidebarCreateSession();
						}}
						class="space-y-2.5 border-t border-brand-border/30 bg-brand-surface/30 p-3"
					>
						<div>
							<label
								class="mb-1 block text-[10px] font-bold tracking-wider text-brand-text-muted uppercase"
								for="sidebar-folder">Folder Path</label
							>
							<div class="relative" bind:this={sidebarContainerEl}>
								<input
									bind:this={sidebarInputEl}
									id="sidebar-folder"
									type="text"
									autocomplete="off"
									spellcheck="false"
									placeholder="e.g. ~/projects/my-new-app"
									bind:value={sidebarCwd}
									onfocus={() => {
										sidebarInputFocused = true;
										triggerSidebarCheck(sidebarCwd, true);
									}}
									onblur={(e) => {
										if (
											sidebarContainerEl &&
											sidebarContainerEl.contains(e.relatedTarget as Node)
										) {
											return;
										}
										sidebarInputFocused = false;
									}}
									onkeydown={(e) => {
										if (e.key === 'Escape') {
											sidebarInputFocused = false;
										}
									}}
									class="w-full rounded border px-2 py-1 text-xs text-brand-text placeholder-brand-text-muted transition-all duration-200 focus:outline-none {isSidebarRemoteRepoCreation
										? 'border-emerald-500/80 bg-emerald-500/10 focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400/30'
										: 'border-brand-border bg-brand-dark/60 focus:border-brand-blue'}"
								/>
								{#if sidebarInputFocused && sidebarCompletions.length > 0}
									<div
										class="absolute right-0 left-0 z-50 mt-1 max-h-40 overflow-y-auto rounded border border-brand-border bg-brand-surface-2 py-1 shadow-xl"
									>
										{#each sidebarCompletions as completion}
											<button
												type="button"
												onclick={() => {
													sidebarCwd = completion;
													triggerSidebarCheck(completion, true);
													sidebarInputEl?.focus();
												}}
												class="block w-full px-2.5 py-1 text-left text-xs text-brand-text transition-colors hover:bg-brand-surface-3 hover:text-brand-text"
											>
												{completion}
											</button>
										{/each}
									</div>
								{/if}
							</div>
							{#if sidebarPathStatus.exists === true}
								<span
									class="mt-1 block text-[10px] font-medium text-yellow-400"
								>
									📁 Folder already exists.
									{#if sidebarPathStatus.isGit}
										<span class="ml-1 font-semibold text-emerald-400"
											>(Git repo)</span
										>
									{/if}
								</span>
							{/if}
						</div>

						<div>
							<label
								class="mb-1 block text-[10px] font-bold tracking-wider text-brand-text-muted uppercase"
								for="sidebar-model">Model</label
							>
							{#if models.length > 0}
								<select
									id="sidebar-model"
									bind:value={sidebarModel}
									class="w-full rounded border border-brand-border bg-brand-dark/60 px-2 py-1 text-xs text-brand-text focus:border-brand-blue focus:outline-none"
								>
									{#each models as model}
										<option value={`${model.provider}:${model.modelId}`}>
											{model.label}{model.isDefault ? ' (default)' : ''}
										</option>
									{/each}
								</select>
							{:else}
								<input
									id="sidebar-model"
									type="text"
									bind:value={sidebarModel}
									placeholder="provider:model"
									class="w-full rounded border border-brand-border bg-brand-dark/60 px-2 py-1 text-xs text-brand-text placeholder-brand-text-muted focus:border-brand-blue focus:outline-none"
								/>
							{/if}
						</div>

						{#if sidebarPathStatus.exists !== true && sidebarPathStatus.matchingRule}
							<div class="space-y-1 py-0.5">
								<div class="flex items-center gap-1.5">
									<input
										id="sidebar-create-remote"
										type="checkbox"
										bind:checked={sidebarCreateRemote}
										class="h-3.5 w-3.5 rounded border-brand-border bg-brand-surface-2 text-brand-blue focus:ring-brand-blue focus:ring-offset-brand-surface"
									/>
									<label
										for="sidebar-create-remote"
										class="cursor-pointer text-xs text-brand-text select-none"
									>
										Create remote {sidebarPathStatus.matchingRule.provider} repository
									</label>
								</div>

								{#if sidebarCreateRemote}
									<div
										class="flex items-center gap-3 pl-5 text-[10px] text-brand-text-muted"
									>
										<span>Visibility:</span>
										<label
											class="flex cursor-pointer items-center gap-1 transition-colors select-none hover:text-brand-text"
										>
											<input
												type="radio"
												name="sidebar-visibility"
												value="private"
												bind:group={sidebarRepoVisibility}
												class="border-brand-border bg-brand-surface-2 text-brand-blue focus:ring-brand-blue"
											/>
											Private
										</label>
										<label
											class="flex cursor-pointer items-center gap-1 transition-colors select-none hover:text-brand-text"
										>
											<input
												type="radio"
												name="sidebar-visibility"
												value="public"
												bind:group={sidebarRepoVisibility}
												class="border-brand-border bg-brand-surface-2 text-brand-blue focus:ring-brand-blue"
											/>
											Public
										</label>
									</div>
								{/if}
							</div>
						{/if}

						{#if sidebarPathStatus.exists !== true && (!sidebarPathStatus.matchingRule || !sidebarCreateRemote)}
							<div class="flex items-center gap-1.5 py-0.5">
								<input
									id="sidebar-git-init"
									type="checkbox"
									bind:checked={sidebarGitInit}
									onchange={(e) => {
										userManualSidebarGitInit = e.currentTarget.checked;
									}}
									class="h-3.5 w-3.5 rounded border-brand-border bg-brand-surface-2 text-brand-blue focus:ring-brand-blue focus:ring-offset-brand-surface"
								/>
								<label
									for="sidebar-git-init"
									class="cursor-pointer text-xs text-brand-text select-none"
								>
									Initialize Git repository
								</label>
							</div>
						{/if}

						<button
							type="submit"
							disabled={!sidebarCwd.trim()}
							class="w-full rounded bg-gradient-to-r from-brand-cyan to-brand-blue py-1.5 text-xs font-semibold text-brand-text transition-all hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
						>
							Create Session
						</button>
					</form>
				{/if}
			</div>
		{/if}

		{#if viewState.view === 'owner'}
			{#if ownerGroups.length === 0}
				<div class="p-4 text-center text-sm text-brand-text-muted">
					{loading
						? 'Loading sessions...'
						: searchQuery
							? 'No sessions match your filter'
							: 'No sessions found'}
				</div>
			{/if}
			{#each ownerGroups as group (group.root.session.path)}
				{@const rootPath = group.root.session.path}
				{@const groupRows = ownerGroupRows(group)}
				{@const collapsible = group.root.children.length > 0}
				{@const groupExpanded = ownerGroupExpanded(
					group,
					collapsedGroups,
					rootPath,
				)}
				<div
					class="border-b border-brand-border/50 py-1.5 pr-3 {group.hasWaitingForHuman
						? 'border-l-2 border-l-amber-400/70 pl-2.5'
						: 'pl-3'}"
				>
					{#each groupRows as { node, depth } (node.session.path)}
						{#if depth === 0 || groupExpanded}
							<div class="flex items-center">
								{#if depth === 0 && collapsible}
									<button
										type="button"
										onclick={() => toggleGroup(rootPath)}
										disabled={group.hasMatch}
										class="flex-shrink-0 px-0.5 text-[10px] text-brand-text-muted transition-transform hover:text-brand-text disabled:cursor-default disabled:opacity-60 {groupExpanded
											? 'rotate-90'
											: ''}"
										title={group.hasMatch
											? 'Shown expanded while the filter matches in it'
											: groupExpanded
												? 'Collapse group'
												: 'Expand group'}
										aria-label={groupExpanded
											? 'Collapse group'
											: 'Expand group'}
										aria-expanded={groupExpanded}
									>
										▶
									</button>
								{/if}
								<div class="min-w-0 flex-1">
									<SessionRow
										session={node.session}
										{depth}
										current={currentSession === node.session.path}
										{readOnly}
										closed={node.closed}
										dimmed={!node.matched && !node.closed}
										rowTitle={node.closed
											? showClosed
												? 'Closed'
												: 'Closed (shown because a session under it is open)'
											: !node.matched
												? 'Shown because a session under it matches the filter'
												: undefined}
										nestKind={node.edge ?? 'fork'}
										presence={presence.get(node.session.path)}
										ownerHint={ownerRowHint(node, sessionLabel)}
										folderTag={node.folderName}
										showOwned={false}
										confirmingDelete={confirmingDelete === node.session.path}
										onOpen={handleSessionClick}
										onStar={toggleStar}
										onToggleClosed={toggleClosed}
										onAskDelete={(path) => (confirmingDelete = path)}
										onCancelDelete={() => (confirmingDelete = null)}
										onDelete={handleDeleteSession}
									/>
								</div>
							</div>
						{/if}
					{/each}
					{#if collapsible && !groupExpanded}
						<button
							type="button"
							onclick={() => toggleGroup(rootPath)}
							class="ml-4 block truncate text-left text-[10px] {group.hasWaitingForHuman
								? 'text-amber-400'
								: 'text-brand-text-muted'} hover:underline"
							title="Expand group"
						>
							{ownerGroupSummaryText(group.summary)}
						</button>
					{/if}
				</div>
			{/each}
		{:else if loading && filteredFolders.length === 0}
			<div class="p-4 text-center text-brand-text-muted">
				<div
					class="inline-block h-4 w-4 animate-spin rounded-full border-2 border-brand-text-muted border-t-transparent"
				></div>
				<span class="ml-2 text-sm">Loading sessions...</span>
			</div>
		{:else if filteredFolders.length === 0}
			<div class="p-4 text-center text-sm text-brand-text-muted">
				{searchQuery ? 'No sessions match your filter' : 'No sessions found'}
			</div>
		{:else}
			{#each filteredFolders as folder (folder.path)}
				<div class="border-b border-brand-border/50">
					<button
						onclick={() => toggleFolder(folder.path)}
						class="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-brand-surface-3/50"
					>
						<span
							class="text-xs text-brand-text-muted transition-transform {isFolderExpanded(
								folder.path,
							)
								? 'rotate-90'
								: ''}"
						>
							▶
						</span>
						<div class="min-w-0 flex-1">
							<div class="flex items-center gap-1.5">
								<div class="truncate text-sm font-medium text-brand-text">
									{folder.name}
								</div>
								<!-- The folder is not on this machine (a synced transcript whose
								     clone never travelled). Its own marker, deliberately NOT the
								     read-only treatment: read-only is a CONFIGURED policy and
								     lives as a whole separate page, while this is a fact about
								     the disk and is curable by a restore. Both can be true of one
								     folder, so they must never look like one thing. -->
								{#if folder.missing}
									<span
										class="flex-shrink-0 rounded border border-brand-purple/50 bg-brand-purple/15 px-1.5 py-px text-[10px] font-semibold tracking-wide text-brand-purple uppercase"
										title="This folder does not exist on this machine. Open a session in it to clone or create it."
										>Missing</span
									>
								{/if}
							</div>
							<div class="truncate text-[10px] text-brand-text-muted">
								{folder.path}
							</div>
						</div>
						<span class="text-xs text-brand-text-muted"
							>{folder.shownCount}</span
						>
					</button>

					{#if isFolderExpanded(folder.path)}
						<div class="px-3 pb-2">
							{#if !readOnly}
								<div class="mb-1.5 flex items-center justify-between">
									<button
										onclick={() => openNewSessionPicker(folder.path)}
										class="rounded px-2 py-1 text-left text-xs text-brand-blue transition-colors hover:bg-brand-surface-3/50 hover:opacity-90"
									>
										+ New Session Here
									</button>
									<div class="flex-shrink-0">
										{#if confirmingDeleteFolder === folder.path}
											<div
												class="flex items-center gap-1 rounded border border-red-500/30 bg-brand-surface-2/80 px-1 py-0.5"
											>
												<button
													onclick={(e) => {
														e.stopPropagation();
														handleDeleteAllFolderSessions(folder);
													}}
													class="px-1.5 text-xs font-bold text-rose-400 hover:text-rose-300 focus:outline-none"
													title="Confirm Delete All"
												>
													Delete All?
												</button>
												<button
													onclick={(e) => {
														e.stopPropagation();
														confirmingDeleteFolder = null;
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
													confirmingDeleteFolder = folder.path;
												}}
												class="rounded px-2 py-1 text-xs text-brand-text-muted transition-colors hover:bg-brand-surface-3/50 hover:text-rose-400 focus:outline-none"
												title="Delete all sessions in this folder"
											>
												Delete All
											</button>
										{/if}
									</div>
								</div>
							{/if}

							{#each folder.rows as { session, depth } (session.path)}
								<SessionRow
									{session}
									{depth}
									current={currentSession === session.path}
									{readOnly}
									closed={!!session.closed}
									rowTitle={session.closed
										? showClosed
											? 'Closed'
											: 'Closed (shown because a fork of it is open)'
										: undefined}
									presence={presence.get(session.path)}
									ownerHint={session.ownerSessionPath
										? sessionLabel(session.ownerSessionPath)
										: undefined}
									ownedChildren={shownSessions(
										owned.get(session.path) ?? [],
										showClosed,
									)}
									confirmingDelete={confirmingDelete === session.path}
									onOpen={handleSessionClick}
									onStar={toggleStar}
									onToggleClosed={toggleClosed}
									onAskDelete={(path) => (confirmingDelete = path)}
									onCancelDelete={() => (confirmingDelete = null)}
									onDelete={handleDeleteSession}
								/>
							{/each}
						</div>
					{/if}
				</div>
			{/each}
		{/if}
	</div>
</div>

<!-- New Session Picker Dialog -->
{#if newSessionPicker.open}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-brand-dark/60"
		role="presentation"
		onclick={closeNewSessionPicker}
	>
		<div
			class="w-80 rounded-lg border border-brand-border bg-brand-surface-2 p-6"
			role="dialog"
			tabindex="-1"
			onclick={(e) => e.stopPropagation()}
		>
			<h3 class="mb-4 text-sm font-bold text-brand-text">New Session</h3>
			<div class="mb-4">
				<span class="mb-1 block text-xs text-brand-text-muted">Folder</span>
				<div
					class="truncate rounded bg-brand-surface-3 px-2 py-1.5 text-xs text-brand-text"
				>
					{newSessionPicker.folderPath}
				</div>
			</div>
			<div class="mb-4">
				<label
					class="mb-1 block text-xs text-brand-text-muted"
					for="model-select">Model</label
				>
				{#if models.length > 0}
					<select
						id="model-select"
						bind:value={newSessionPicker.selected}
						class="w-full rounded border border-brand-border bg-brand-surface-3 px-2 py-1.5 text-xs text-brand-text"
					>
						{#each models as model}
							<option value={`${model.provider}:${model.modelId}`}>
								{model.label}{model.isDefault ? ' (default)' : ''}
							</option>
						{/each}
					</select>
				{:else}
					<input
						id="model-select"
						type="text"
						bind:value={newSessionPicker.selected}
						placeholder="provider:model"
						class="w-full rounded border border-brand-border bg-brand-surface-3 px-2 py-1.5 text-xs text-brand-text placeholder-brand-text-muted"
					/>
				{/if}
			</div>
			<div class="flex justify-end gap-2">
				<button
					onclick={closeNewSessionPicker}
					class="rounded bg-brand-surface-3 px-3 py-1.5 text-xs text-brand-text transition-colors hover:bg-brand-surface-2"
				>
					Cancel
				</button>
				<button
					onclick={handleCreateSession}
					class="rounded bg-gradient-to-r from-brand-cyan to-brand-blue px-3 py-1.5 text-xs font-semibold text-brand-text transition-all hover:opacity-90"
				>
					Create
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- Session Error -->
{#if $sessionError}
	<div
		class="absolute right-0 bottom-0 left-0 flex items-center justify-between border-t border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-rose-400"
	>
		<span class="truncate">{$sessionError}</span>
		<button
			onclick={() => dismissSessionError()}
			class="ml-2 flex-shrink-0 text-rose-300 hover:text-rose-200">✕</button
		>
	</div>
{/if}

<!-- Sidebar Git Init Confirm Dialog -->
{#if showSidebarGitConfirmModal}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-brand-dark/65 p-4"
		role="dialog"
		aria-modal="true"
	>
		<div
			class="w-80 rounded-lg border border-brand-border bg-brand-surface-2 p-5 text-brand-text"
		>
			<h3 class="mb-2 text-sm font-bold text-brand-text">
				Folder Already Exists
			</h3>
			<p class="mb-3 text-xs text-brand-text-muted">
				The folder <span
					class="selectable font-mono text-[11px] break-all text-brand-text"
					>{sidebarCwd}</span
				> already exists. Do you want to initialize a Git repository in it?
			</p>

			<div class="mb-4 flex flex-col gap-3">
				<div class="flex items-center gap-1.5">
					<input
						id="sidebar-modal-git-init"
						type="checkbox"
						bind:checked={sidebarGitInit}
						disabled={sidebarPathStatus.isGit}
						class="h-3.5 w-3.5 rounded border-brand-border bg-brand-surface-3 text-brand-blue focus:ring-brand-blue disabled:opacity-50"
					/>
					<label
						for="sidebar-modal-git-init"
						class="cursor-pointer text-xs text-brand-text select-none disabled:opacity-50"
					>
						Initialize Git repository
						{#if sidebarPathStatus.isGit}
							<span class="ml-1 text-[10px] text-brand-text-muted"
								>(already a Git repo)</span
							>
						{:else}
							<span class="ml-1 text-[10px] font-medium text-yellow-500"
								>(folder not empty)</span
							>
						{/if}
					</label>
				</div>

				{#if sidebarPathStatus.matchingRule}
					<div class="space-y-1">
						<div class="flex items-center gap-1.5">
							<input
								id="sidebar-modal-create-remote"
								type="checkbox"
								bind:checked={sidebarCreateRemote}
								class="h-3.5 w-3.5 rounded border-brand-border bg-brand-surface-3 text-brand-blue focus:ring-brand-blue"
							/>
							<label
								for="sidebar-modal-create-remote"
								class="cursor-pointer text-xs text-brand-text select-none"
							>
								Create remote {sidebarPathStatus.matchingRule.provider} repository
							</label>
						</div>

						{#if sidebarCreateRemote}
							<div
								class="flex items-center gap-3 pl-5 text-[10px] text-brand-text-muted"
							>
								<span>Visibility:</span>
								<label
									class="flex cursor-pointer items-center gap-1 transition-colors select-none hover:text-brand-text"
								>
									<input
										type="radio"
										name="sidebar-modal-visibility"
										value="private"
										bind:group={sidebarRepoVisibility}
										class="border-brand-border bg-brand-surface-3 text-brand-blue focus:ring-brand-blue"
									/>
									Private
								</label>
								<label
									class="flex cursor-pointer items-center gap-1 transition-colors select-none hover:text-brand-text"
								>
									<input
										type="radio"
										name="sidebar-modal-visibility"
										value="public"
										bind:group={sidebarRepoVisibility}
										class="border-brand-border bg-brand-surface-3 text-brand-blue focus:ring-brand-blue"
									/>
									Public
								</label>
							</div>
						{/if}
					</div>
				{/if}
			</div>

			<div class="flex justify-end gap-2">
				<button
					type="button"
					onclick={() => (showSidebarGitConfirmModal = false)}
					class="rounded bg-brand-surface-3 px-3 py-1.5 text-xs text-brand-text transition-colors hover:bg-brand-surface-2"
				>
					Cancel
				</button>
				<button
					type="button"
					onclick={handleSidebarConfirmModalSubmit}
					class="rounded bg-gradient-to-r from-brand-cyan to-brand-blue px-3 py-1.5 text-xs font-semibold text-brand-text transition-all hover:opacity-90"
				>
					Confirm & Create
				</button>
			</div>
		</div>
	</div>
{/if}
