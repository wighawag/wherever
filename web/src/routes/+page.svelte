<script lang="ts">
	import Head from '$lib/Head.svelte';
	import ConnectionSettings from '$lib/components/ConnectionSettings.svelte';
	import ChatMessageList from '$lib/components/ChatMessageList.svelte';
	import ChatInput from '$lib/components/ChatInput.svelte';
	import SessionBrowser from '$lib/components/SessionBrowser.svelte';
	import ConversationSearch from '$lib/components/ConversationSearch.svelte';
	import SudoPasswordDialog from '$lib/components/SudoPasswordDialog.svelte';
	import {
		piState,
		isConnected,
		isInterrupted,
		sessionError,
		sessionNotice,
		folderConflict,
		folderMissing,
		continueFolderConflict,
		isReadOnly,
		activeSessionInfo,
		connect,
		disconnect,
		suspend,
		resume,
		leaveSession,
		dismissSessionError,
		dismissNotice,
		changeModel,
		joinSession,
		switchSession,
		isCreatingSession,
		isResyncing,
		isLoadingSession,
		isAgentPending,
		hasSuspendedSession,
		isFilePickerActive,
		endFilePicker,
		runSearch,
		hasActiveSession,
	} from '$lib/wherever';
	import {
		fetchSessions,
		fetchReadOnlySessions,
		availableModels,
		searchFolderStore,
		searchDefaultModelStore,
	} from '$lib/session-store';
	import {onMount} from 'svelte';
	import {version} from '$app/environment';
	import {url} from '$lib/core/utils/web/path';
	import {isSearchActive} from '$lib/core/view-mode';

	let sidebarOpen = $state(false);
	// Which session list the sidebar shows: the main dashboard, the separate
	// read-only page (sessions.readOnly folders) reached via the sidebar link, or
	// conversation search (full-text over every past session, GET /search).
	// The read-only page hides the create form, delete controls, and the composer.
	let sessionView = $state<'main' | 'readonly' | 'search'>('main');
	// Search mirrors the two list views rather than spanning them: it is opened
	// from one of them and searches exactly that view's sessions, so the visibility
	// rule a user already understands from the list also holds for search.
	let searchReadOnly = $state(false);
	let searchInitialQuery = $state('');

	function openSearch(fromReadOnly: boolean, initial = '') {
		searchReadOnly = fromReadOnly;
		searchInitialQuery = initial;
		sessionView = 'search';
	}
	let showSettings = $state(false);
	let autoConnect = $state(true);
	let interruptedTimeout: ReturnType<typeof setTimeout> | null = null;
	let chatList: {forceScrollToBottom: () => void};

	onMount(() => {
		if (autoConnect) {
			setTimeout(() => connect(), 200);
		}

		const handleHashChange = () => {
			if (connected) {
				const hashId = window.location.hash
					? decodeURIComponent(window.location.hash.slice(1))
					: '';
				if (hashId && hashId !== currentSessionId) {
					// Atomic switch (no leave -> setTimeout -> join gap that could strand
					// the loading spinner). switchSession leaves the current session first
					// when there is one and loads the target either way.
					switchSession(hashId);
				} else if (!hashId && currentSessionId) {
					leaveSession();
				}
			}
		};

		window.addEventListener('hashchange', handleHashChange);

		// --- Background/resume handling (esp. Firefox Android screen-lock) ---
		// While the page is backgrounded we close the WebSocket. An open WS makes
		// the page ineligible for the browser's back/forward cache, which on
		// mobile pushes the browser toward a full, slow reload on resume. Closing
		// it improves bfcache eligibility (instant restore) and, when a real
		// reload does happen, the active session is restored from the URL hash.
		// The disconnect is delayed so quick tab switches don't churn the
		// connection; reconnect is immediate on return.
		let hiddenTimer: ReturnType<typeof setTimeout> | null = null;
		const HIDE_DISCONNECT_DELAY = 8000;

		const handleVisibility = () => {
			if (document.visibilityState === 'hidden') {
				// A native file picker / camera backgrounds the page. Don't schedule a
				// suspend in that window, or a slow file selection (e.g. taking a
				// photo) would tear down the session and make the upload fail with
				// "No active session" on return.
				if (isFilePickerActive()) return;
				if (hiddenTimer) clearTimeout(hiddenTimer);
				hiddenTimer = setTimeout(() => {
					hiddenTimer = null;
					if (document.visibilityState === 'hidden' && connected) {
						// Suspend (not disconnect): keep the cached session/messages so
						// returning resyncs in place instead of reloading from scratch.
						suspend();
					}
				}, HIDE_DISCONNECT_DELAY);
			} else {
				// Back in the foreground: the picker (if any) is closed. Clear the
				// guard so a cancelled picker doesn't leave suspend disabled. The
				// upload's own session check already ran synchronously on the file
				// change, so the session is no longer needed to be pinned here.
				endFilePicker();
				if (hiddenTimer) {
					clearTimeout(hiddenTimer);
					hiddenTimer = null;
				}
				if (!connected) {
					// Prefer the preserve-cache resume() path whenever we still hold an
					// active session -- from an explicit suspend OR an unsolicited drop that
					// happened while hidden (before the 8s suspend). resume() rejoins in
					// place and keeps the conversation visible; a plain connect() would wipe
					// the session and re-show the search / new-session empty-state. Only a
					// truly empty client (no session at all) falls back to connect(), where
					// the hash auto-join drives the load.
					if (hasActiveSession()) {
						resume();
					} else {
						connect();
					}
				}
			}
		};

		const handlePageShow = (e: PageTransitionEvent) => {
			// On bfcache restore (e.persisted) or any return to a visible page,
			// resume the suspended connection, rejoining the cached session in place.
			if (hiddenTimer) {
				clearTimeout(hiddenTimer);
				hiddenTimer = null;
			}
			if (document.visibilityState !== 'hidden' && !connected) {
				if (hasActiveSession()) {
					resume();
				} else {
					connect();
				}
			}
		};

		document.addEventListener('visibilitychange', handleVisibility);
		window.addEventListener('pageshow', handlePageShow);

		return () => {
			window.removeEventListener('hashchange', handleHashChange);
			document.removeEventListener('visibilitychange', handleVisibility);
			window.removeEventListener('pageshow', handlePageShow);
			if (hiddenTimer) clearTimeout(hiddenTimer);
		};
	});

	function handleConnected() {
		connect();
	}

	function handleDisconnect() {
		leaveSession();
		disconnect();
	}

	function handleReconnect() {
		disconnect();
		setTimeout(() => connect(), 100);
	}

	function handleRefresh() {
		fetchSessions();
	}

	function handleShowMainScreen() {
		if (typeof window !== 'undefined') {
			window.location.hash = '';
		}
		leaveSession();
		sidebarOpen = false;
	}

	let connected = $derived($isConnected);
	let resyncing = $derived($isResyncing);
	let agentPending = $derived($isAgentPending);
	let loadingSession = $derived($isLoadingSession);
	let interrupted = $derived($isInterrupted);
	let sError = $derived($sessionError);
	let notice = $derived($sessionNotice);
	let fConflict = $derived($folderConflict);
	let fMissing = $derived($folderMissing);
	let readOnly = $derived($isReadOnly);
	let sessionInfo = $derived($activeSessionInfo);
	let appState = $derived($piState);
	let models = $derived($availableModels.models);

	let wasSessionActive = $state(false);
	let currentSessionId = $derived(sessionInfo.sessionId);

	// Update hash when sessionId changes, only if connected to prevent clearing on reload
	$effect(() => {
		if (typeof window !== 'undefined' && connected) {
			if (currentSessionId) {
				window.location.hash = encodeURIComponent(currentSessionId);
				wasSessionActive = true;
			} else if (wasSessionActive) {
				wasSessionActive = false;
				if (window.location.hash) {
					window.location.hash = '';
				}
			}
		}
	});

	// Auto-join session from hash when connected.
	//
	// Self-healing by design: it re-evaluates whenever we are connected with a hash
	// but no session is active for it. An earlier guard latched per join and was
	// reset on disconnect, but rapid connect/disconnect churn (e.g. a reconnect
	// racing a resume) could flip `connected` within a single effect flush so the
	// reset was never observed, leaving the guard latched and the session never
	// loaded, which hung the "Loading session..." spinner forever. Gating purely on
	// the live state (active session id + loading/resync flags) instead avoids that.
	let hashJoinTimer: ReturnType<typeof setTimeout> | null = null;
	$effect(() => {
		if (!connected || typeof window === 'undefined' || !window.location.hash) {
			return;
		}
		const hashId = decodeURIComponent(window.location.hash.slice(1));
		if (!hashId) return;
		// Already on (or already loading) the hash session: nothing to do. This also
		// covers the resume path, where the client rejoins the cached session in
		// place via session_load in onOpen, so re-joining here would double-load.
		if (currentSessionId === hashId || loadingSession || resyncing) return;
		if (hashJoinTimer) return; // a join is already pending
		hashJoinTimer = setTimeout(() => {
			hashJoinTimer = null;
			if (currentSessionId === hashId || loadingSession || resyncing) return;
			joinSession(hashId);
		}, 300);
	});

	// Reset transient flags on disconnect.
	$effect(() => {
		if (!connected) {
			wasSessionActive = false;
		}
	});

	// Close sidebar on mobile when a session is joined OR as soon as a load is in
	// flight. Previously it only closed once `currentSessionId` was set, so if the
	// load stalled (the "Loading session..." spinner hanging) the sidebar stayed
	// open over it. Closing on the loading/resync flag too means the tap always
	// dismisses the sidebar, and the user sees the spinner (or its eventual error)
	// rather than a stuck open sidebar.
	$effect(() => {
		if (currentSessionId || loadingSession || resyncing) {
			sidebarOpen = false;
		}
	});

	let isCreating = $derived($isCreatingSession);
	let searchFolder = $derived($searchFolderStore);

	// The bottom composer is always mounted but mode-switched: it acts as the
	// search composer when connected, a search folder is configured, and no
	// session is active. Keeping it mounted (not conditionally rendered) means it
	// exists at tap time so we can focus it synchronously inside a user gesture.
	let chatInput: {focusInput: () => void} | undefined = $state();
	// The composer's search mode must mirror the message area's empty-state so the
	// two never disagree (the bug: a "Loading session..." spinner with an enabled
	// search box). isSearchActive treats a session that is loading/resyncing, or a
	// hash pointing at a session we are about to open, as NOT the search state even
	// though sessionFile is briefly still null.
	let searchActive = $derived(
		isSearchActive({
			connected,
			searchConfigured: !!searchFolder,
			hasSession: !!sessionInfo.sessionFile,
			loading: loadingSession,
			resyncing,
			hasSessionHash: typeof window !== 'undefined' && !!window.location.hash,
		}),
	);

	// Search-mode model picker. Options mirror the sidebar new-session list; the
	// selection is seeded from the search folder's server-resolved default (which
	// honors folder-local harness/pi config), falling back to the models list's
	// isDefault entry, then the first model.
	let searchModels = $derived(
		models.map((m) => ({
			value: `${m.provider}:${m.modelId}`,
			label: `${m.label}${m.isDefault ? ' (default)' : ''}`,
		})),
	);
	let searchDefaultModel = $derived($searchDefaultModelStore);
	let searchModel = $state('');
	// Seed (or re-seed) the selection once options are available and nothing valid
	// is chosen yet. Runs when the model list or folder default changes.
	$effect(() => {
		if (searchModels.length === 0) return;
		const valid = searchModels.some((m) => m.value === searchModel);
		if (valid) return;
		const folderDefault = searchModels.find(
			(m) => m.value === searchDefaultModel,
		);
		const listDefault = models.find((m) => m.isDefault);
		searchModel = folderDefault
			? folderDefault.value
			: listDefault
				? `${listDefault.provider}:${listDefault.modelId}`
				: searchModels[0].value;
	});

	// On page load with no session, focus the search composer so it is ready to
	// type. (One-shot; not inside the tap path, so no mobile-keyboard concern.)
	let hasFocusedSearch = $state(false);
	$effect(() => {
		if (searchActive && !hasFocusedSearch && chatInput) {
			hasFocusedSearch = true;
			chatInput.focusInput();
		}
	});

	// Top-bar magnifier (active-session case): leave the session and focus the
	// search composer SYNCHRONOUSLY inside this gesture so the mobile virtual
	// keyboard rises (focusing later from a reactive effect would not, esp. iOS).
	function startSearch() {
		// Clear the hash synchronously so the chat area drops straight to the
		// search empty-state instead of flashing the "Loading session..." spinner
		// (ChatMessageList reads window.location.hash, which is not reactive).
		if (typeof window !== 'undefined' && window.location.hash) {
			window.location.hash = '';
		}
		leaveSession();
		chatInput?.focusInput();
	}
</script>

<Head title="Wherever" description="Create & maintain apps from wherever" />

{#if isCreating}
	<div
		class="fixed inset-0 z-[100] flex items-center justify-center bg-brand-dark/60 backdrop-blur-sm"
	>
		<div class="flex flex-col items-center gap-4">
			<div
				class="h-12 w-12 animate-spin rounded-full border-4 border-brand-blue border-t-transparent"
			></div>
			<span class="text-lg font-bold text-brand-text">Creating session...</span>
		</div>
	</div>
{/if}

<div
	class="fixed inset-0 flex overflow-hidden overscroll-none bg-brand-dark text-brand-text"
>
	<!-- Sidebar -->
	<div
		class="app-chrome {sidebarOpen
			? 'translate-x-0'
			: '-translate-x-full'} fixed z-20 flex h-full w-72 flex-col border-r border-brand-border bg-brand-surface transition-transform duration-200 md:relative md:translate-x-0"
	>
		<div class="border-b border-brand-border bg-brand-surface-2/20 p-4">
			<div class="flex items-center justify-between">
				{#if showSettings}
					<span class="text-lg font-bold text-brand-text"
						>Connection Settings</span
					>
					<button
						onclick={() => (showSettings = false)}
						class="rounded px-2 py-1 text-xs font-semibold text-brand-blue transition-colors hover:bg-brand-surface-2 hover:text-brand-blue"
					>
						◀ Back
					</button>
				{:else}
					<button
						onclick={handleShowMainScreen}
						class="flex items-center gap-2 text-left"
						title="Show Main Screen / New Session"
					>
						<img src={url('/logo.svg')} alt="Wherever" class="h-6 w-6" />
						<span class="gradient-text text-lg font-bold">Wherever</span>
					</button>
					<div class="flex items-center gap-2">
						<button
							onclick={() => (showSettings = true)}
							class="flex items-center gap-1 rounded border border-brand-border px-1.5 py-1 text-xs text-brand-text-muted transition-colors hover:bg-brand-surface-2 hover:text-brand-text"
							title="Connection Settings"
						>
							⚙️ Config
						</button>
						<button
							onclick={() => (sidebarOpen = false)}
							class="text-brand-text-muted hover:text-brand-text md:hidden"
						>
							X
						</button>
					</div>
				{/if}
			</div>
		</div>

		{#if showSettings}
			<div class="flex-1 overflow-y-auto">
				<ConnectionSettings
					host={appState.connected ? 'localhost' : 'localhost'}
					port={31415}
					token=""
					onConnected={handleConnected}
				/>

				<div class="mt-2 border-t border-brand-border p-4">
					<h3
						class="mb-3 text-xs font-bold tracking-wider text-brand-text-muted uppercase"
					>
						Server Control
					</h3>
					<div class="space-y-2">
						<button
							onclick={handleRefresh}
							class="flex w-full items-center justify-between rounded border border-brand-border bg-brand-surface-2 px-3 py-2 text-left text-sm text-brand-text transition-colors hover:bg-brand-surface-3 hover:text-brand-text"
						>
							<span>Refresh Session List</span>
							<span>🔄</span>
						</button>
						<button
							onclick={handleReconnect}
							class="flex w-full items-center justify-between rounded border border-brand-border bg-brand-surface-2 px-3 py-2 text-left text-sm text-brand-text transition-colors hover:bg-brand-surface-3 hover:text-brand-text"
						>
							<span>Reconnect WebSocket</span>
							<span>🔌</span>
						</button>
						<button
							onclick={handleDisconnect}
							class="flex w-full items-center justify-between rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-left text-sm text-rose-400 transition-colors hover:bg-red-500/20 hover:text-rose-300"
						>
							<span>Disconnect Server</span>
							<span>🛑</span>
						</button>
					</div>
				</div>
			</div>
		{:else}
			<!-- Connection status -->
			<div class="border-b border-brand-border p-4">
				<div class="flex items-center gap-2">
					<div
						class="h-2.5 w-2.5 rounded-full {connected
							? 'bg-emerald-500'
							: 'bg-rose-500'}"
					></div>
					<span
						class="text-sm {connected ? 'text-emerald-400' : 'text-rose-400'}"
					>
						{connected ? 'Connected' : 'Disconnected'}
					</span>
					<span
						class="ml-auto font-mono text-xs text-brand-text-muted"
						title={appState.serverVersion
							? `App build ${version} · server ${appState.serverVersion}`
							: `App build ${version}`}
					>
						v{version}{#if appState.serverVersion}<span
								class="text-brand-text-muted/70"
							>
								&nbsp;/ srv {appState.serverVersion}</span
							>{/if}
					</span>
				</div>
				{#if sessionInfo.sessionFile}
					<div class="mt-2 space-y-1">
						{#if sessionInfo.cwd}
							<div
								class="truncate text-xs text-brand-text-muted"
								title={sessionInfo.cwd}
							>
								📁 {sessionInfo.cwd.split('/').pop() || sessionInfo.cwd}
							</div>
						{/if}
						{#if sessionInfo.model}
							<div
								class="truncate text-xs text-brand-text-muted"
								title={sessionInfo.model}
							>
								🤖 {sessionInfo.model}
							</div>
						{/if}
						<div class="pt-1.5">
							<button
								onclick={handleShowMainScreen}
								class="w-full rounded border border-brand-border bg-brand-surface-2 px-2 py-1 text-center text-xs text-brand-text transition-colors hover:bg-brand-surface-3 hover:text-brand-text"
								title="Show Main Screen (Clear URL Hash)"
							>
								Close Session
							</button>
						</div>
					</div>
				{/if}
				{#if appState.error && !connected}
					<div class="mt-2 text-xs text-rose-400">
						{appState.error}
					</div>
				{/if}
			</div>

			<!-- Sidebar navigation: switch between the main list and the read-only page -->
			<div class="border-b border-brand-border/50 px-2 py-1.5">
				{#if sessionView === 'main'}
					<button
						onclick={() => openSearch(false)}
						class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-brand-text-muted transition-colors hover:bg-brand-surface-3/50 hover:text-brand-text"
						title="Search everything ever said in any session"
					>
						<span>🔎</span>
						<span>Search conversations</span>
						<span class="ml-auto">→</span>
					</button>
					<button
						onclick={() => {
							sessionView = 'readonly';
							fetchReadOnlySessions();
						}}
						class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-brand-text-muted transition-colors hover:bg-brand-surface-3/50 hover:text-brand-text"
						title="View read-only sessions (e.g. autonomous agent fleets)"
					>
						<span>👁️</span>
						<span>Read-only sessions</span>
						<span class="ml-auto">→</span>
					</button>
				{:else if sessionView === 'search'}
					<button
						onclick={() => (sessionView = searchReadOnly ? 'readonly' : 'main')}
						class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs font-semibold text-brand-blue transition-colors hover:bg-brand-surface-3/50"
						title="Back to the session list"
					>
						<span>←</span>
						<span
							>Back to {searchReadOnly
								? 'read-only sessions'
								: 'sessions'}</span
						>
					</button>
				{:else}
					<button
						onclick={() => (sessionView = 'main')}
						class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs font-semibold text-brand-blue transition-colors hover:bg-brand-surface-3/50"
						title="Back to your sessions"
					>
						<span>←</span>
						<span>Back to sessions</span>
					</button>
					<button
						onclick={() => openSearch(true)}
						class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-brand-text-muted transition-colors hover:bg-brand-surface-3/50 hover:text-brand-text"
						title="Search the read-only conversations"
					>
						<span>🔎</span>
						<span>Search these conversations</span>
						<span class="ml-auto">→</span>
					</button>
				{/if}
			</div>

			<!-- Session Browser -->
			<div class="flex-1 overflow-hidden">
				{#if sessionView === 'search'}
					<!-- onOpened closes the mobile sidebar even when the tapped result is
					     the session already open: that path starts no load, so the
					     loading/resync effect below would never fire for it. -->
					<ConversationSearch
						readOnly={searchReadOnly}
						initialQuery={searchInitialQuery}
						onOpened={() => (sidebarOpen = false)}
					/>
				{:else if sessionView === 'readonly'}
					<SessionBrowser readOnly onSearchAll={(q) => openSearch(true, q)} />
				{:else}
					<SessionBrowser onSearchAll={(q) => openSearch(false, q)} />
				{/if}
			</div>
		{/if}
	</div>

	<!-- Main content -->
	<div class="flex min-w-0 flex-1 flex-col">
		<!-- Top bar -->
		<div
			class="app-chrome flex items-center gap-3 border-b border-brand-border bg-brand-surface p-3"
		>
			<button
				onclick={() => (sidebarOpen = !sidebarOpen)}
				class="p-1 text-brand-text-muted hover:text-brand-text md:hidden"
			>
				=
			</button>

			<!-- Compact search affordance (active-session case): drop to the search
			     empty-state. Hidden in the empty-state itself, where the bottom
			     composer already IS the search input. -->
			{#if connected && searchFolder && sessionInfo.sessionFile}
				<button
					type="button"
					onclick={startSearch}
					class="flex flex-shrink-0 items-center justify-center rounded border border-brand-border bg-brand-surface-2 px-2.5 py-1.5 text-sm text-brand-text-muted transition-colors hover:bg-brand-surface-3 hover:text-brand-text"
					title="Search the web"
					aria-label="Search the web"
				>
					🔍
				</button>
			{/if}

			<!-- Status indicator -->
			{#if !connected || !sessionInfo.sessionFile}
				<div class="flex min-w-0 items-center gap-2">
					{#if connected && searchActive}
						<span class="text-sm text-brand-text-muted"
							>Search the web below, or pick a session from the sidebar</span
						>
					{:else if connected}
						<span class="text-sm text-brand-text-muted"
							>Select a session from sidebar</span
						>
					{:else}
						<span class="text-sm text-brand-text-muted">Not connected</span>
					{/if}
				</div>
			{/if}

			<!-- Folder and model info -->
			{#if sessionInfo.sessionFile}
				<div class="flex min-w-0 flex-1 items-center gap-3">
					<!-- Folder -->
					{#if sessionInfo.cwd}
						<div
							class="flex min-w-0 items-center gap-1.5 text-xs text-brand-text-muted"
						>
							<span class="flex-shrink-0">📁</span>
							<span class="truncate" title={sessionInfo.cwd}
								>{sessionInfo.cwd.split('/').pop() || sessionInfo.cwd}</span
							>
						</div>
					{/if}

					<!-- Model selector -->
					{#if sessionInfo.model}
						<div class="flex min-w-0 items-center gap-1.5 text-xs">
							<span
								class="relative flex flex-shrink-0 items-center justify-center text-sm"
							>
								<span>🤖</span>
								<span
									class="absolute -right-0.5 -bottom-0.5 h-2 w-2 rounded-full border border-brand-surface {appState.isStreaming
										? 'animate-pulse bg-orange-500'
										: 'bg-emerald-500'}"
									title={appState.isStreaming ? 'Agent working...' : 'Ready'}
								></span>
							</span>
							{#if models.length > 0 && !readOnly}
								<select
									value={sessionInfo.model}
									oninput={(e) => changeModel(e.currentTarget.value)}
									class="max-w-48 truncate rounded border border-brand-border bg-brand-surface-2 px-1.5 py-0.5 text-brand-text focus:border-brand-blue focus:outline-none"
								>
									{#each models as model}
										<option value={`${model.provider}:${model.modelId}`}>
											{model.label}
										</option>
									{/each}
								</select>
							{:else}
								<span
									class="truncate text-brand-text-muted"
									title={sessionInfo.model}>{sessionInfo.model}</span
								>
							{/if}
						</div>
					{/if}
				</div>
			{/if}

			{#if readOnly}
				<span
					class="flex-shrink-0 rounded bg-yellow-500/20 px-2 py-1 text-xs text-yellow-400"
					>Read-only</span
				>
			{/if}
		</div>

		<!-- Interruption notification -->
		{#if interrupted}
			<div
				class="border border-red-500/30 bg-red-500/10 px-4 py-2 text-center text-sm text-rose-400"
			>
				Your session was interrupted — another client took over.
			</div>
		{/if}

		<!-- Session notice (non-fatal). e.g. a CLI took over this session while it
		     was mid-turn here, discarding the in-flight tool call or streaming
		     reply. The session stays attached; the user just needs to know why the
		     running turn stopped. Dismissible. -->
		{#if notice}
			<div
				class="flex items-start justify-between gap-2 border px-4 py-2 text-sm {notice.level ===
				'warning'
					? 'border-yellow-500/30 bg-yellow-500/10 text-yellow-400'
					: 'border-blue-500/30 bg-blue-500/10 text-blue-400'}"
			>
				<span class="min-w-0 flex-1 break-words whitespace-pre-wrap"
					>{notice.message}</span
				>
				<button
					onclick={() => dismissNotice()}
					aria-label="Dismiss notice"
					class="flex-shrink-0 opacity-80 hover:opacity-100">X</button
				>
			</div>
		{/if}

		<!-- Folder-conflict warning banner. Shown while ANOTHER active session
		     exists in this session's folder. Before the user continues, the
		     composer is read-only and the banner offers "Continue anyway" (which
		     enables sending WITHOUT aborting the other session). After continuing,
		     the button is gone but the banner stays as a passive warning until the
		     other session leaves the folder (folderConflict cleared by the server). -->
		{#if fConflict?.active}
			<div
				class="flex items-center justify-between gap-3 border border-yellow-500/30 bg-yellow-500/10 px-4 py-2 text-sm text-yellow-400"
			>
				<span class="min-w-0 flex-1 break-words">
					⚠️ Another client is active in this folder.
					{#if fConflict.continued}
						You are both working in it &mdash; changes may conflict.
					{:else}
						You are observing (read-only) to avoid clashing.
					{/if}
				</span>
				{#if !fConflict.continued}
					<button
						onclick={() => continueFolderConflict()}
						class="flex-shrink-0 rounded-md border border-yellow-500/40 bg-yellow-500/20 px-3 py-1 text-xs font-medium text-yellow-300 transition-colors hover:bg-yellow-500/30"
						>Continue anyway</button
					>
				{/if}
			</div>
		{/if}

		<!-- Session error notification. The message can be long, so it scrolls
		     within a bounded, wrapping area while the close button stays pinned and
		     never gets pushed off-screen. -->
		{#if sError}
			<div
				class="flex items-start justify-between gap-2 border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-rose-400"
			>
				<span
					class="max-h-24 min-w-0 flex-1 overflow-y-auto break-words whitespace-pre-wrap"
					>{sError}</span
				>
				<button
					onclick={() => dismissSessionError()}
					aria-label="Dismiss error"
					class="flex-shrink-0 text-rose-300 hover:text-rose-200">X</button
				>
			</div>
		{/if}

		<!-- Read-only banner. Suppressed only while the DISMISSIBLE folder-conflict
		     banner is up: that one already explains why this session is read-only and
		     carries the "Continue anyway" escape, so showing both reads as a dead end.
		     Once continued, the conflict banner has no button left, so a read-only
		     that SURVIVED the continue (a hard sessions.readOnly folder, which the
		     server refuses to lift) must still explain itself here. -->
		{#if readOnly && !interrupted && !fMissing && !(fConflict?.active && !fConflict.continued)}
			<div
				class="border border-yellow-500/30 bg-yellow-500/10 px-4 py-2 text-center text-sm text-yellow-400"
			>
				Read-only: this session cannot be driven from here
			</div>
		{/if}

		<!-- Chat area -->
		<ChatMessageList bind:this={chatList} onMessageSent={() => {}} />

		<!-- Input: one composer, mode-switched. Search mode when connected, a
		     search folder is configured, and no session is active; chat mode
		     otherwise. Always mounted so it can be focused inside a tap gesture.
		     EXCEPTION: a read-only session (e.g. a sessions.readOnly fleet folder)
		     hides the composer entirely -- it is an observe-only view. -->
		{#if fMissing}
			<!-- MISSING FOLDER: this session's working folder does not exist on this
			     machine (the transcript synced, the clone did not). The conversation
			     above is fully readable, but the server built no agent and refuses
			     every send, so the composer is replaced by an explanation NAMING the
			     absolute path. There is deliberately no dismiss: unlike the folder
			     conflict this is not a warning, it is the absence of the folder.
			     Restore actions land in a later change; until then the honest lock is
			     the whole point. -->
			<div
				class="border-t border-yellow-500/30 bg-yellow-500/10 px-4 py-3 text-sm text-yellow-400"
			>
				<div class="font-medium">
					📁 This session's folder is not on this machine
				</div>
				<div class="mt-1 font-mono text-xs break-all text-yellow-300">
					{fMissing.cwd}
				</div>
				<div class="mt-1 text-xs text-brand-text-muted">
					The conversation is readable, but nothing can be run here until the
					folder is restored. Restore it (e.g. clone the repository back to that
					path), then reload this session.
				</div>
			</div>
		{:else if readOnly && sessionInfo.sessionFile}
			<div
				class="border-t border-brand-border bg-brand-surface px-4 py-3 text-center text-xs text-brand-text-muted"
			>
				👁️ Read-only session, observing only, no input.
			</div>
		{:else}
			<!-- Suspended/reconnecting: show a thin status banner ABOVE the composer
			     instead of replacing it. Keeping ChatInput mounted preserves the
			     textarea (and any in-progress draft) in the live DOM so a resync can
			     never destroy what the user was typing; the composer is merely
			     disabled until the socket is back and the session has resynced. -->
			{#if sessionInfo.sessionFile && (resyncing || !connected)}
				<div
					class="flex items-center justify-center gap-2 border-t border-brand-border bg-brand-surface px-4 py-2 text-center text-sm text-brand-text-muted"
				>
					<span
						class="h-3.5 w-3.5 animate-spin rounded-full border-2 border-brand-blue border-t-transparent"
					></span>
					<span>Reconnecting and syncing session...</span>
				</div>
			{:else if sessionInfo.sessionFile && agentPending}
				<!-- Fast-first load: the conversation is already readable above, but the
				     live agent is still building (cold session). Block only the
				     composer, with a distinct hint, so reading/scrolling stay instant. -->
				<div
					class="flex items-center justify-center gap-2 border-t border-brand-border bg-brand-surface px-4 py-2 text-center text-sm text-brand-text-muted"
				>
					<span
						class="h-3.5 w-3.5 animate-spin rounded-full border-2 border-brand-blue border-t-transparent"
					></span>
					<span>Preparing the session agent...</span>
				</div>
			{/if}
			<ChatInput
				bind:this={chatInput}
				searchMode={searchActive}
				searchConfigured={!!searchFolder}
				{searchModels}
				bind:searchModel
				onSubmit={(q, files) => runSearch(q, searchModel, files)}
				placeholder="Search the web..."
				submitLabel="Search"
				disabled={searchActive
					? !connected
					: !connected ||
						readOnly ||
						!sessionInfo.sessionFile ||
						resyncing ||
						agentPending}
				onSend={() => chatList?.forceScrollToBottom()}
			/>
		{/if}
	</div>

	<!-- Sudo password prompt for `!sudo ...` commands -->
	<SudoPasswordDialog />

	<!-- Overlay for mobile sidebar -->
	{#if sidebarOpen}
		<button
			type="button"
			class="fixed inset-0 z-10 bg-brand-dark/50 md:hidden"
			onclick={() => (sidebarOpen = false)}
			aria-label="Close sidebar"
		></button>
	{/if}
</div>
