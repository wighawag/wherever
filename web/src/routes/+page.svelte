<script lang="ts">
	import Head from '$lib/Head.svelte';
	import ConnectionSettings from '$lib/components/ConnectionSettings.svelte';
	import AssistantPushSettings from '$lib/components/AssistantPushSettings.svelte';
	import AssistantTelegramSettings from '$lib/components/AssistantTelegramSettings.svelte';
	import {telegramSectionVisible} from '$lib/core/telegram-settings';
	import ChatMessageList from '$lib/components/ChatMessageList.svelte';
	import ChatInput from '$lib/components/ChatInput.svelte';
	import SessionBrowser from '$lib/components/SessionBrowser.svelte';
	import CloseCascadePrompt from '$lib/components/CloseCascadePrompt.svelte';
	import ConversationSearch from '$lib/components/ConversationSearch.svelte';
	import ShipmatesInbox from '$lib/components/ShipmatesInbox.svelte';
	import SidebarTab from '$lib/components/SidebarTab.svelte';
	import StateDot from '$lib/components/StateDot.svelte';
	import ChatSessionMenu from '$lib/components/ChatSessionMenu.svelte';
	import NotificationToasts from '$lib/components/NotificationToasts.svelte';
	import UpdateToast from '$lib/components/UpdateToast.svelte';
	import {
		activeTab,
		assistantButtonDot,
		openSessionDot,
		tapTab,
		type SidebarTab as SidebarTabName,
	} from '$lib/core/sidebar-nav';
	import {
		readSidebarCollapsed,
		writeSidebarCollapsed,
	} from '$lib/core/sidebar-rail';
	import {anyoneWaitsForYou, stateDotLabel} from '$lib/core/state-dot';
	import {
		folderName,
		openSessionTitle,
		waitsForYouText,
	} from '$lib/core/chat-top-bar';
	import {
		inboxBadge,
		inboxCount,
		presenceByFile,
		syncAppBadge,
		titleWithInboxCount,
	} from '$lib/core/shipmates';
	import SudoPasswordDialog from '$lib/components/SudoPasswordDialog.svelte';
	import RestorePanel from '$lib/components/RestorePanel.svelte';
	import RestoreProgress from '$lib/components/RestoreProgress.svelte';
	import {
		piState,
		restoreState,
		cancelRestore,
		isConnected,
		isInterrupted,
		sessionError,
		sessionNotice,
		folderConflict,
		folderMissing,
		assistantRetired,
		continueFolderConflict,
		isReadOnly,
		activeSessionInfo,
		connect,
		disconnect,
		suspend,
		resume,
		noteVisible,
		leaveSession,
		dismissSessionError,
		dismissNotice,
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
		readBootConversation,
		hydrateFromCache,
		flushConversationCache,
		clearConversationCache,
		openAssistant,
		abort,
	} from '$lib/wherever';
	import {
		fetchSessions,
		fetchReadOnlySessions,
		availableModels,
		searchFolderStore,
		searchDefaultModelStore,
		appearanceStore,
		sessionFolders,
		readOnlySessionFolders,
		setSessionStarred,
		assistantStatusStore,
		isAssistantSession,
		shipmatesStore,
		openNewSessionForm,
	} from '$lib/session-store';
	import {onMount} from 'svelte';
	import {version} from '$app/environment';
	import {url} from '$lib/core/utils/web/path';
	import {
		decideHashJoin,
		isSearchActive,
		webSearchShortcutShown,
	} from '$lib/core/view-mode';
	import {decideReturn, runBoot} from '$lib/core/instant-resume';

	let sidebarOpen = $state(false);
	// Which session list the sidebar shows: the main dashboard, the separate
	// read-only page (sessions.readOnly folders) reached via the sidebar link, or
	// conversation search (full-text over every past session, GET /search).
	// The read-only page hides the create form, delete controls, and the composer.
	// Or shipmates' attention inbox ('inbox', wherever ADR 0023), shown only while
	// the server has shipmates.
	let sessionView = $state<'main' | 'readonly' | 'search' | 'inbox'>('main');
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

	// The icon tabs (core/sidebar-nav.ts): the active tab is the view shown, and
	// tapping it goes back (to the read-only page for a search opened there).
	let currentTab = $derived(activeTab({view: sessionView, searchReadOnly}));
	function onTab(tab: SidebarTabName) {
		const next = tapTab({view: sessionView, searchReadOnly}, tab);
		if (next.view === 'search') openSearch(next.searchReadOnly);
		else {
			searchReadOnly = next.searchReadOnly;
			sessionView = next.view;
		}
		if (next.fetchReadOnly) fetchReadOnlySessions();
	}

	// The desktop rail (core/sidebar-rail.ts): « collapses the sidebar to a thin
	// rail from `md` up, » expands it; remembered on this device. Read on mount,
	// not at init: the page is prerendered, and a class that differs at
	// hydration is not patched. The phone drawer ignores it (`md:` classes).
	let sidebarCollapsed = $state(false);
	function setSidebarCollapsed(collapsed: boolean) {
		sidebarCollapsed = collapsed;
		writeSidebarCollapsed(
			typeof localStorage !== 'undefined' ? localStorage : undefined,
			collapsed,
		);
	}
	// A rail tab expands the sidebar, then opens its view. A tab whose view is
	// already shown only expands (tapping it would otherwise go back to the
	// list, hiding the view the user just asked to see).
	function onRailTab(tab: SidebarTabName) {
		setSidebarCollapsed(false);
		showSettings = false;
		if (currentTab !== tab) onTab(tab);
	}
	// The rail's +: expand, show the main list, open its new-session form (a
	// store flag the main-list SessionBrowser consumes once it is mounted).
	function onRailNewSession() {
		setSidebarCollapsed(false);
		showSettings = false;
		searchReadOnly = false;
		sessionView = 'main';
		openNewSessionForm();
	}

	// The `md` breakpoint (48rem), where the drawer becomes the side column (or
	// its rail). Tracked so "Needs you is open" can tell which applies.
	let isDesktop = $state(false);
	onMount(() => {
		const mq = window.matchMedia?.('(min-width: 48rem)');
		if (!mq) return;
		isDesktop = mq.matches;
		const onChange = () => (isDesktop = mq.matches);
		mq.addEventListener('change', onChange);
		return () => mq.removeEventListener('change', onChange);
	});
	// The Needs you panel is ON SCREEN: its view AND a visible sidebar (phone:
	// the drawer open; desktop: not collapsed to the rail). `sessionView` alone
	// stays 'inbox' after the drawer closes. The question toasts are suppressed
	// while it is (spec notifications-compact, story 10).
	let needsYouOpen = $derived(
		sessionView === 'inbox' && (isDesktop ? !sidebarCollapsed : sidebarOpen),
	);
	// Show the Needs you panel from a toast or the slim bar: the view, plus
	// opening the drawer (phone) or expanding the rail (desktop).
	function openNeedsYou() {
		showSettings = false;
		searchReadOnly = false;
		sessionView = 'inbox';
		if (isDesktop) setSidebarCollapsed(false);
		else sidebarOpen = true;
	}

	// The current-session line's ▾: app and server versions and Leave session.
	let currentLineOpen = $state(false);
	let showSettings = $state(false);
	let autoConnect = $state(true);
	let interruptedTimeout: ReturnType<typeof setTimeout> | null = null;
	let chatList: {forceScrollToBottom: () => void};

	// True until boot has ISSUED its own connect() (not until the socket opens,
	// or an offline cache miss would hold the handlers off forever). While set,
	// pageshow / visibilitychange do not connect: on a fresh load pageshow always
	// fires, and its plain connect() would reset a hydration in progress.
	let booting = true;

	onMount(() => {
		sidebarCollapsed = readSidebarCollapsed();
		if (autoConnect) {
			// Instant resume (docs/adr/0013): when the hash names a session, start
			// reading its cached copy now (capped at ~300 ms), alongside the existing
			// 200 ms boot delay. A hit is painted and connected with the store
			// preserved, so the conversation shows before the socket opens; a miss
			// boots exactly as before.
			const cached = readBootConversation(readHashId());
			setTimeout(() => {
				void runBoot({
					cached,
					hydrate: hydrateFromCache,
					connect: (opts) => {
						booting = false;
						connect(opts);
					},
				});
			}, 200);
		} else {
			booting = false;
		}

		const handleHashChange = () => {
			// A new hash is a new intent: forget any failed auto-join attempt.
			hashJoinAttempt = null;
			if (connected) {
				const hashId = window.location.hash
					? decodeURIComponent(window.location.hash.slice(1))
					: '';
				if (hashId && hashId !== currentSessionId) {
					// Record it as this hash's attempt, so a failed load is not re-joined
					// by the auto-join effect (a second failure per Back press).
					hashJoinAttempt = hashId;
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
				// The OS may kill a hidden PWA without another event: save the
				// conversation now so a reload can paint it at once.
				flushConversationCache();
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
				// On EVERY return, probe a socket that is still open: timers fire
				// before the frames queued during the freeze, so the silence clock
				// alone would tear a healthy socket down (docs/adr/0011).
				noteVisible();
				// Prefer the preserve-cache resume() path whenever we still hold an
				// active session -- from an explicit suspend OR an unsolicited drop that
				// happened while hidden (before the 8s suspend). resume() rejoins in
				// place and keeps the conversation visible; a plain connect() would wipe
				// the session and re-show the search / new-session empty-state. Only a
				// truly empty client (no session at all) falls back to connect(), where
				// the hash auto-join drives the load. Nothing while booting (see
				// `booting`): boot issues its own connect.
				const action = decideReturn({
					booting,
					connected,
					hasActiveSession: hasActiveSession(),
				});
				if (action === 'resume') resume();
				else if (action === 'connect') connect();
			}
		};

		const handlePageShow = (e: PageTransitionEvent) => {
			// On bfcache restore (e.persisted) or any return to a visible page,
			// resume the suspended connection, rejoining the cached session in place.
			if (hiddenTimer) {
				clearTimeout(hiddenTimer);
				hiddenTimer = null;
			}
			if (document.visibilityState === 'hidden') return;
			// Probe a still-open socket on every visible pageshow too (see
			// handleVisibility). Not on a hidden one: noteVisible() takes the fast
			// paths meant for a user who is looking at the page.
			noteVisible();
			const action = decideReturn({
				booting,
				connected,
				hasActiveSession: hasActiveSession(),
			});
			if (action === 'resume') resume();
			else if (action === 'connect') connect();
		};

		// Last chance to save the conversation before the page goes away.
		const handlePageHide = () => flushConversationCache();

		document.addEventListener('visibilitychange', handleVisibility);
		window.addEventListener('pageshow', handlePageShow);
		window.addEventListener('pagehide', handlePageHide);

		return () => {
			window.removeEventListener('hashchange', handleHashChange);
			document.removeEventListener('visibilitychange', handleVisibility);
			window.removeEventListener('pageshow', handlePageShow);
			window.removeEventListener('pagehide', handlePageHide);
			if (hiddenTimer) clearTimeout(hiddenTimer);
		};
	});

	function handleConnected() {
		connect();
	}

	// "Disconnect Server" wipes the on-device cache (ADR 0013). Only here and in
	// ConnectionSettings' Disconnect, never in the shared disconnect(), which
	// Reconnect below also calls.
	function handleDisconnect() {
		leaveSession();
		disconnect();
		clearConversationCache();
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
	let retired = $derived($assistantRetired);
	let readOnly = $derived($isReadOnly);
	let sessionInfo = $derived($activeSessionInfo);
	let appState = $derived($piState);
	let models = $derived($availableModels.models);

	let wasSessionActive = $state(false);
	let currentSessionId = $derived(sessionInfo.sessionId);

	// The open session's listing entry (name, starred, closed; all server-side),
	// from the main or the read-only list. The ⋯ session menu reads it too.
	let currentListed = $derived.by(() => {
		const file = sessionInfo.sessionFile;
		if (!file) return undefined;
		for (const store of [$sessionFolders, $readOnlySessionFolders]) {
			for (const folder of store.folders) {
				const hit = folder.sessions.find((s) => s.path === file);
				if (hit) return hit;
			}
		}
		return undefined;
	});
	let currentStarred = $derived(!!currentListed?.starred);
	// The open session's dot on the sidebar's current-session line.
	let currentDot = $derived(
		openSessionDot({
			listed: currentListed,
			streaming: appState.isStreaming,
			presence: sessionInfo.sessionFile
				? presenceByFile($shipmatesStore.presence).get(sessionInfo.sessionFile)
				: undefined,
		}),
	);
	let versionsTitle = $derived(
		appState.serverVersion
			? `App build ${version} · server ${appState.serverVersion}${appState.piVersion ? ` · pi ${appState.piVersion}` : ''}`
			: `App build ${version}`,
	);

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
	//
	// But it must not retry a load that already FAILED: an untagged session_error
	// (e.g. the hash names a deleted session) clears loadingSession, which
	// re-runs this effect with currentSessionId still null, so it used to re-join
	// every ~300 ms forever with a flickering error and a permanent spinner.
	// `hashJoinAttempt` remembers the id we last issued a join for; it is reset
	// on success, on disconnect (a load cut by a dropped socket must be retried
	// after reconnecting) and on a hash change. decideHashJoin is unit-tested.
	let hashJoinTimer: ReturnType<typeof setTimeout> | null = null;
	let hashJoinAttempt: string | null = null;
	function readHashId(): string {
		if (typeof window === 'undefined' || !window.location.hash) return '';
		return decodeURIComponent(window.location.hash.slice(1));
	}
	$effect(() => {
		if (!connected) {
			hashJoinAttempt = null;
			return;
		}
		const hashId = readHashId();
		if (hashId && currentSessionId === hashId) hashJoinAttempt = null;
		const decision = decideHashJoin({
			connected,
			hashId,
			currentSessionId,
			loading: loadingSession,
			resyncing,
			creating: $isCreatingSession,
			attemptedHashId: hashJoinAttempt,
		});
		if (decision === 'failed') {
			// Stop here. The error banner explains why; drop the hash so the URL
			// no longer names a session that cannot be opened, and the message area
			// falls back to the home state instead of a spinner.
			// replaceState, NOT `location.hash = ''`: that pushed a history entry and
			// fired hashchange, so Back returned to the dead hash, which failed
			// again and pushed again, trapping the Back button. replaceState fires
			// no hashchange; the non-reactive hash read is covered by loadFailed.
			hashJoinAttempt = null;
			if (window.location.hash) {
				history.replaceState(
					history.state,
					'',
					window.location.pathname + window.location.search,
				);
			}
			return;
		}
		if (decision !== 'join') return;
		if (hashJoinTimer) return; // a join is already pending
		hashJoinTimer = setTimeout(() => {
			hashJoinTimer = null;
			const id = readHashId();
			if (
				decideHashJoin({
					connected,
					hashId: id,
					currentSessionId,
					loading: loadingSession,
					resyncing,
					creating: $isCreatingSession,
					attemptedHashId: hashJoinAttempt,
				}) !== 'join'
			) {
				return;
			}
			hashJoinAttempt = id;
			joinSession(id);
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
	// The CLONE half of a new session in a folder that has to be cloned first: the
	// server runs it as a restore job and reports it, so the create shows real
	// progress instead of a blind overlay a 25s watchdog gives up on. It ends by
	// itself -- the server continues into creating the session once the clone is
	// done -- so there is no Reload here, unlike the restore panel.
	let createRestore = $derived(
		$restoreState?.forSessionCreate ? $restoreState : null,
	);
	let searchFolder = $derived($searchFolderStore);
	// The Assistant entry point shows only while the assistant is ACTIVE on this
	// server (configured and holding its folder lock); Reset only on the current
	// assistant session itself.
	let assistantActive = $derived($assistantStatusStore.active);
	// shipmates' inbox badge: how many questions wait for the human, and whether
	// a session is blocked on one. Null when empty or when the server has no shipmates.
	let shipmatesBadge = $derived(
		$shipmatesStore.available ? inboxBadge($shipmatesStore.inbox) : null,
	);
	// The same count in the tab title and on the installed app's icon, so a
	// question is visible from another tab or the home screen. Needs no
	// assistant: it comes from `shipmates_update` alone.
	let shipmatesCount = $derived(inboxCount($shipmatesStore));
	$effect(() => {
		syncAppBadge(
			typeof navigator === 'undefined' ? undefined : navigator,
			shipmatesCount,
		);
	});
	$effect(() => {
		// The server lost shipmates (or a reconnect to one without it): leave the panel.
		if (sessionView === 'inbox' && !$shipmatesStore.available)
			sessionView = 'main';
	});
	// The rail's amber dot: an open inbox item, or a listed session (main or
	// read-only list) waiting for the human (core/state-dot.ts).
	let waitsForYou = $derived(
		anyoneWaitsForYou(
			$shipmatesStore,
			[...$sessionFolders.folders, ...$readOnlySessionFolders.folders].flatMap(
				(f) => f.sessions,
			),
		),
	);
	let waitsForYouTitle = $derived(waitsForYouText(waitsForYou));
	// The top bar's title: the open session's listing label, else its folder.
	let currentTitle = $derived(
		openSessionTitle({listed: currentListed, cwd: sessionInfo.cwd}),
	);
	let viewingAssistant = $derived(
		isAssistantSession($assistantStatusStore, sessionInfo.sessionFile),
	);
	// The ✦ button's dot: the assistant session's live state, null when quiet.
	let assistantDot = $derived.by(() => {
		const file = $assistantStatusStore.currentSessionFile;
		if (!file) return null;
		const listed = [
			...$sessionFolders.folders,
			...$readOnlySessionFolders.folders,
		]
			.flatMap((f) => f.sessions)
			.find((s) => s.path === file);
		return assistantButtonDot(
			listed,
			presenceByFile($shipmatesStore.presence).get(file),
		);
	});
	let assistantTitle = $derived(
		($assistantStatusStore.timezone
			? `Assistant: open the current assistant session (your timezone: ${$assistantStatusStore.timezone})`
			: 'Assistant: open the current assistant session') +
			(assistantDot ? ` · ${stateDotLabel(assistantDot)}` : ''),
	);

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
	// `window.location.hash` is not reactive: bumped where this page clears the
	// hash itself (startSearch), so the two checks below re-read it at once even
	// when nothing else changes (a hash whose auto-join has not fired yet).
	let hashVersion = $state(0);
	// One set of inputs for both checks, so the composer's search mode and the
	// top bar's 🔍 can never disagree.
	let viewInputs = $derived.by(() => {
		void hashVersion;
		return {
			connected,
			searchConfigured: !!searchFolder,
			hasSession: !!sessionInfo.sessionFile,
			loading: loadingSession,
			resyncing,
			hasSessionHash: typeof window !== 'undefined' && !!window.location.hash,
			loadFailed:
				!!sError && !loadingSession && !resyncing && !sessionInfo.sessionFile,
		};
	});
	let searchActive = $derived(isSearchActive(viewInputs));

	// The top bar's 🔍: also while a session is still loading (see the helper).
	let showWebSearchShortcut = $derived(webSearchShortcutShown(viewInputs));

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
	// Visual identity of the connected instance: theming is applied at fetch
	// time (session-store), here it only feeds the title and the sidebar badge.
	let appearanceLabel = $derived($appearanceStore.label);
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

	// 🔍 "Search the web" (top bar): leave the session (or a load in flight) and focus the
	// search composer SYNCHRONOUSLY inside this gesture so the mobile virtual
	// keyboard rises (focusing later from a reactive effect would not, esp. iOS).
	function startSearch() {
		// Clear the hash synchronously so the chat area drops straight to the
		// search empty-state instead of flashing the "Loading session..." spinner
		// (ChatMessageList reads window.location.hash, which is not reactive).
		if (typeof window !== 'undefined' && window.location.hash) {
			window.location.hash = '';
		}
		hashVersion++;
		leaveSession();
		chatInput?.focusInput();
	}
</script>

<Head
	title={titleWithInboxCount(
		appearanceLabel ? `Wherever · ${appearanceLabel}` : 'Wherever',
		shipmatesCount,
	)}
	description="Create & maintain apps from wherever"
/>

{#if createRestore}
	<div
		class="fixed inset-0 z-[100] flex items-center justify-center bg-brand-dark/60 p-4 backdrop-blur-sm"
	>
		<div
			class="w-full max-w-sm rounded-lg border border-brand-border bg-brand-surface-2 p-5 text-brand-text"
		>
			<div class="text-base font-bold">Cloning the repository...</div>
			<div class="mt-1 text-xs text-brand-text-muted">
				The session is created as soon as the clone finishes, so there is
				nothing to wait for afterwards. It keeps running on the server if this
				page goes away.
			</div>
			{#if createRestore.job?.url}
				<div class="mt-2 font-mono text-xs break-all text-brand-text-muted">
					{createRestore.job.url}
				</div>
			{/if}
			<RestoreProgress job={createRestore.job} />
			<button
				type="button"
				onclick={() => cancelRestore()}
				class="mt-3 rounded bg-brand-surface-3 px-3.5 py-1.5 text-xs font-semibold text-brand-text transition-colors hover:bg-brand-surface-2"
			>
				Cancel
			</button>
		</div>
	</div>
{:else if isCreating}
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

<!-- The Assistant's four-point sparkle in the brand gradient (the header button
     and the desktop rail; each needs its own gradient id). -->
{#snippet sparkleIcon(gradientId: string)}
	<svg viewBox="0 0 24 24" class="h-5 w-5" aria-hidden="true">
		<defs>
			<linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
				<stop offset="0" style="stop-color: var(--color-brand-cyan)" />
				<stop offset="0.5" style="stop-color: var(--color-brand-blue)" />
				<stop offset="1" style="stop-color: var(--color-brand-purple)" />
			</linearGradient>
		</defs>
		<path
			d="M12 1.5 C13 8 16 11 22.5 12 C16 13 13 16 12 22.5 C11 16 8 13 1.5 12 C8 11 11 8 12 1.5 Z"
			fill="url(#{gradientId})"
		/>
	</svg>
{/snippet}

<!-- The ✦ Assistant button: an ACTION (it opens the assistant session in the
     main area), so it sits with the header's buttons and above the rail's
     tabs, never among the view tabs. A small dot shows the assistant's live
     state (running, waiting on a session, waiting for you). -->
{#snippet assistantButton(gradientId: string, onopen: () => void)}
	<button
		type="button"
		onclick={onopen}
		disabled={!connected}
		class="relative flex h-8 w-8 items-center justify-center rounded border transition-colors disabled:cursor-not-allowed disabled:opacity-40 {viewingAssistant
			? 'border-brand-blue/60 bg-brand-blue/15'
			: 'border-brand-border hover:bg-brand-surface-2'}"
		title={assistantTitle}
		aria-label={assistantTitle}
		aria-current={viewingAssistant ? 'true' : undefined}
	>
		{@render sparkleIcon(gradientId)}
		{#if assistantDot}
			<span class="absolute -top-1 -right-1 flex" aria-hidden="true">
				<StateDot dot={assistantDot} />
			</span>
		{/if}
	</button>
{/snippet}

<div
	class="fixed inset-0 flex overflow-hidden overscroll-none bg-brand-dark text-brand-text"
>
	<!-- Sidebar (on desktop, collapsed to a thin rail by «) -->
	<div
		class="app-chrome {sidebarOpen
			? 'translate-x-0'
			: '-translate-x-full'} fixed z-20 flex h-full w-[86vw] flex-col border-r border-brand-border bg-brand-surface transition-transform duration-200 md:relative md:translate-x-0 {sidebarCollapsed
			? 'md:w-12'
			: 'md:w-72'}"
	>
		{#if sidebarCollapsed}
			<!-- The desktop rail: », the amber dot when anything waits for you, the
			     ✦ Assistant action (opens the assistant, does not expand) above a
			     divider, the view tab icons, + new session. A view tab or + expands
			     the sidebar first.
			     Hidden on the phone, where the drawer shows the full sidebar. -->
			<nav
				class="hidden h-full flex-col items-center gap-1 py-2 md:flex"
				aria-label="Collapsed sidebar"
			>
				<button
					type="button"
					onclick={() => setSidebarCollapsed(false)}
					class="flex h-8 w-8 items-center justify-center rounded border border-brand-border text-sm text-brand-text-muted transition-colors hover:bg-brand-surface-2 hover:text-brand-text"
					title="Expand sidebar"
					aria-label="Expand sidebar"
				>
					»
				</button>
				{#if waitsForYou.waiting}
					<span
						class="my-1 h-2.5 w-2.5 rounded-full bg-amber-400 ring-4 ring-amber-400/25"
						role="img"
						title="Waiting for you: {waitsForYouTitle}"
						aria-label="Waiting for you: {waitsForYouTitle}"
					></span>
				{/if}
				{#if assistantActive}
					<!-- An action, not a tab: apart from the tabs below the divider. -->
					<div class="mt-1">
						{@render assistantButton('assistant-sparkle-rail', () =>
							openAssistant(),
						)}
					</div>
					<div class="my-1 h-px w-6 bg-brand-border" aria-hidden="true"></div>
				{/if}
				{#if $shipmatesStore.available}
					<div class="flex h-9 w-10">
						<SidebarTab
							label="Needs you"
							title={shipmatesBadge
								? `Needs you: ${shipmatesBadge.count} question${shipmatesBadge.count === 1 ? '' : 's'} your sessions asked you`
								: 'Needs you: questions your sessions asked you (shipmates)'}
							active={currentTab === 'inbox'}
							onclick={() => onRailTab('inbox')}
						>
							{#snippet icon()}<span aria-hidden="true">🙋</span>{/snippet}
							{#snippet badge()}
								{#if shipmatesBadge}
									<span
										class="rounded-full px-1.5 text-[10px] leading-4 font-semibold {shipmatesBadge.blocking
											? 'bg-amber-500 text-black'
											: 'bg-brand-surface-3 text-brand-text'}"
										>{shipmatesBadge.count}</span
									>
								{/if}
							{/snippet}
						</SidebarTab>
					</div>
				{/if}
				<div class="flex h-9 w-10">
					<SidebarTab
						label="Search conversations"
						title="Search conversations: everything ever said in any session"
						active={currentTab === 'search'}
						onclick={() => onRailTab('search')}
					>
						{#snippet icon()}<span aria-hidden="true">🕘</span>{/snippet}
					</SidebarTab>
				</div>
				<div class="flex h-9 w-10">
					<SidebarTab
						label="Read-only sessions"
						title="Read-only sessions (e.g. autonomous agent fleets)"
						active={currentTab === 'readonly'}
						onclick={() => onRailTab('readonly')}
					>
						{#snippet icon()}<span aria-hidden="true">👁️</span>{/snippet}
					</SidebarTab>
				</div>
				<button
					type="button"
					onclick={onRailNewSession}
					class="mt-1 flex h-8 w-8 items-center justify-center rounded bg-brand-blue text-lg leading-none font-semibold text-white transition-colors hover:bg-brand-blue/80"
					title="New session"
					aria-label="New session"
				>
					+
				</button>
			</nav>
		{/if}
		<!-- The full sidebar: hidden from `md` up while collapsed to the rail, but
		     always shown in the phone drawer. -->
		<div
			class="flex min-h-0 flex-1 flex-col {sidebarCollapsed ? 'md:hidden' : ''}"
		>
			<div
				class="border-b border-brand-border bg-brand-surface-2/20 {showSettings
					? 'p-4'
					: 'px-3 py-2'}"
			>
				<div class="flex items-center justify-between gap-2">
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
						<!-- Header: the logo only (no "Wherever" text), keeping its click
					     back to the main screen / new session. -->
						<div class="flex min-w-0 items-center gap-2">
							<button
								onclick={handleShowMainScreen}
								class="flex flex-shrink-0 items-center rounded p-0.5"
								title="Show Main Screen / New Session"
								aria-label="Wherever: show main screen / new session"
							>
								<img src={url('/logo.svg')} alt="Wherever" class="h-6 w-6" />
							</button>
							{#if appearanceLabel}
								<!-- Instance badge: shows WHICH machine's server you are talking to,
							     tinted by the instance accent (brand-blue). -->
								<span
									class="max-w-32 truncate rounded-full border border-brand-border bg-brand-blue/15 px-2 py-0.5 text-[10px] font-semibold text-brand-blue"
									title={appearanceLabel}>{appearanceLabel}</span
								>
							{/if}
						</div>
						<div class="flex flex-shrink-0 items-center gap-1.5">
							{#if assistantActive}
								{@render assistantButton('assistant-sparkle', () => {
									openAssistant();
									sidebarOpen = false;
								})}
							{/if}
							<button
								onclick={() => (showSettings = true)}
								class="flex h-8 w-8 items-center justify-center rounded border border-brand-border text-sm text-brand-text-muted transition-colors hover:bg-brand-surface-2 hover:text-brand-text"
								title="Connection Settings"
								aria-label="Connection Settings"
							>
								⚙
							</button>
							<button
								onclick={() => setSidebarCollapsed(true)}
								class="hidden h-8 w-8 items-center justify-center rounded border border-brand-border text-sm text-brand-text-muted transition-colors hover:bg-brand-surface-2 hover:text-brand-text md:flex"
								title="Collapse sidebar"
								aria-label="Collapse sidebar"
							>
								«
							</button>
							<button
								onclick={() => (sidebarOpen = false)}
								class="flex h-8 w-8 items-center justify-center rounded border border-brand-border text-sm text-brand-text-muted transition-colors hover:bg-brand-surface-2 hover:text-brand-text md:hidden"
								title="Close sidebar"
								aria-label="Close sidebar"
							>
								✕
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

					{#if $assistantStatusStore.active && $assistantStatusStore.webPush?.enabled}
						<AssistantPushSettings
							currentSessionId={currentSessionId ?? null}
						/>
					{/if}

					{#if $assistantStatusStore.telegram && telegramSectionVisible($assistantStatusStore)}
						<AssistantTelegramSettings
							status={$assistantStatusStore.telegram}
						/>
					{/if}

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
				<!-- Current session on ONE line: its state dot, folder and model (or the
			     connection state with no session open). The ▾ expands the versions
			     and Leave session. A dead connection and its error show without
			     expanding anything. -->
				<div class="border-b border-brand-border px-3 py-1.5">
					<button
						type="button"
						onclick={() => (currentLineOpen = !currentLineOpen)}
						class="flex w-full min-w-0 items-center gap-2 rounded py-1 text-left text-sm"
						aria-expanded={currentLineOpen}
						title={currentLineOpen
							? 'Hide details'
							: 'Show versions and actions'}
					>
						{#if !connected}
							<span
								class="h-2 w-2 flex-shrink-0 rounded-full bg-rose-500"
								aria-hidden="true"
							></span>
							<span class="flex-shrink-0 text-rose-400">Disconnected</span>
							{#if sessionInfo.sessionFile && sessionInfo.cwd}
								<span class="truncate text-xs text-brand-text-muted"
									>· {sessionInfo.cwd.split('/').pop() || sessionInfo.cwd}</span
								>
							{/if}
						{:else if sessionInfo.sessionFile}
							<StateDot dot={currentDot} />
							<span
								class="min-w-0 flex-shrink truncate text-brand-text"
								title={sessionInfo.cwd ?? undefined}
								>{sessionInfo.cwd
									? sessionInfo.cwd.split('/').pop() || sessionInfo.cwd
									: 'Session'}</span
							>
							{#if sessionInfo.model}
								<span
									class="min-w-0 flex-1 truncate text-xs text-brand-text-muted"
									title={sessionInfo.model}>· {sessionInfo.model}</span
								>
							{/if}
						{:else}
							<span
								class="h-2 w-2 flex-shrink-0 rounded-full bg-emerald-500"
								aria-hidden="true"
							></span>
							<span class="text-emerald-400">Connected</span>
						{/if}
						<span
							class="ml-auto flex-shrink-0 text-xs text-brand-text-muted transition-transform {currentLineOpen
								? 'rotate-180'
								: ''}"
							aria-hidden="true">▾</span
						>
					</button>
					{#if appState.error && !connected}
						<div class="selectable mt-1 text-xs text-rose-400">
							{appState.error}
						</div>
					{/if}
					{#if currentLineOpen}
						<div class="mt-1 space-y-1.5 pb-1">
							<div
								class="selectable font-mono text-xs text-brand-text-muted"
								title={versionsTitle}
							>
								v{version}{#if appState.serverVersion}<span
										class="text-brand-text-muted/70"
									>
										&nbsp;/ srv {appState.serverVersion}</span
									>{/if}
							</div>
							{#if sessionInfo.sessionFile}
								<button
									onclick={handleShowMainScreen}
									class="w-full rounded border border-brand-border bg-brand-surface-2 px-2 py-1 text-center text-xs text-brand-text transition-colors hover:bg-brand-surface-3 hover:text-brand-text"
									title="Leave this chat and show the main screen (the session keeps running)"
								>
									Leave session
								</button>
							{/if}
						</div>
					{/if}
				</div>

				<!-- Sidebar navigation: icon-only tabs. Inbox, search and read-only are
			     views (the active one is marked, tapping it goes back). The
			     Assistant is an action, so it is a header button, not a tab. -->
				<nav
					class="flex items-center gap-1 border-b border-brand-border/50 px-2 py-1"
					aria-label="Sidebar navigation"
				>
					{#if $shipmatesStore.available}
						<SidebarTab
							label="Needs you"
							title={shipmatesBadge
								? `Needs you: ${shipmatesBadge.count} question${shipmatesBadge.count === 1 ? '' : 's'} your sessions asked you`
								: 'Needs you: questions your sessions asked you (shipmates)'}
							active={currentTab === 'inbox'}
							onclick={() => onTab('inbox')}
						>
							{#snippet icon()}<span aria-hidden="true">🙋</span>{/snippet}
							{#snippet badge()}
								{#if shipmatesBadge}
									<span
										class="rounded-full px-1.5 text-[10px] leading-4 font-semibold {shipmatesBadge.blocking
											? 'bg-amber-500 text-black'
											: 'bg-brand-surface-3 text-brand-text'}"
										>{shipmatesBadge.count}</span
									>
								{/if}
							{/snippet}
						</SidebarTab>
					{/if}
					<SidebarTab
						label="Search conversations"
						title="Search conversations: everything ever said in any session"
						active={currentTab === 'search'}
						onclick={() => onTab('search')}
					>
						{#snippet icon()}<span aria-hidden="true">🕘</span>{/snippet}
					</SidebarTab>
					<SidebarTab
						label="Read-only sessions"
						title="Read-only sessions (e.g. autonomous agent fleets)"
						active={currentTab === 'readonly'}
						onclick={() => onTab('readonly')}
					>
						{#snippet icon()}<span aria-hidden="true">👁️</span>{/snippet}
					</SidebarTab>
				</nav>

				<!-- Session Browser -->
				<div class="flex min-h-0 flex-1 flex-col overflow-hidden">
					{#if sessionView === 'inbox'}
						<ShipmatesInbox onOpened={() => (sidebarOpen = false)} />
					{:else if sessionView === 'search'}
						<!-- onOpened closes the mobile sidebar even when the tapped result is
					     the session already open: that path starts no load, so the
					     loading/resync effect below would never fire for it. -->
						<ConversationSearch
							readOnly={searchReadOnly}
							initialQuery={searchInitialQuery}
							onOpened={() => (sidebarOpen = false)}
						/>
					{:else if sessionView === 'readonly'}
						<!-- The read-only search: the search tab searches your own sessions,
					     this link the read-only conversations (tapping the active search
					     tab then returns here). -->
						<button
							type="button"
							onclick={() => openSearch(true)}
							class="mx-2 mt-1.5 flex flex-shrink-0 items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-brand-blue transition-colors hover:bg-brand-surface-3/50"
							title="Search the read-only conversations"
						>
							<span aria-hidden="true">🕘</span>
							<span>Search these conversations</span>
							<span class="ml-auto" aria-hidden="true">→</span>
						</button>
						<div class="min-h-0 flex-1">
							<SessionBrowser
								readOnly
								onSearchAll={(q) => openSearch(true, q)}
							/>
						</div>
					{:else}
						<SessionBrowser onSearchAll={(q) => openSearch(false, q)} />
					{/if}
				</div>
			{/if}
		</div>
	</div>

	<!-- Main content -->
	<div class="flex min-w-0 flex-1 flex-col">
		<!-- Top bar (spec chat-compact-layout, stories 1 to 4, 6 and 7): ☰ (phone)
		     with an amber dot whenever anything waits for you, then the open
		     session's title (listing label, else folder) with its state dot,
		     folder · model, "read-only" and the connection state under it. With
		     no session open, today's status text. Then 🔍 Search the web (also
		     while a session loads), ☆ (desktop only) and ⋯,
		     the session menu (chat-session-menu), which holds every other
		     action and the per-chat / per-device settings. -->
		<div
			class="app-chrome flex items-center gap-2 border-b border-brand-border bg-brand-surface px-3 py-2 md:gap-3"
		>
			<button
				onclick={() => (sidebarOpen = !sidebarOpen)}
				class="relative flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg border border-brand-border text-lg text-brand-text-muted hover:text-brand-text md:hidden"
				title={waitsForYou.waiting
					? `Sessions. Waiting for you: ${waitsForYouTitle}`
					: 'Sessions'}
				aria-label={waitsForYou.waiting
					? `Open sessions. Waiting for you: ${waitsForYouTitle}`
					: 'Open sessions'}
			>
				☰
				{#if waitsForYou.waiting}
					<!-- Something waits for the human: an inbox question or a session
					     whose presence is waiting-for-human (core/state-dot.ts). -->
					<span
						class="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full bg-amber-400 ring-2 ring-brand-surface"
						aria-hidden="true"
					></span>
				{/if}
			</button>

			{#if sessionInfo.sessionFile}
				<div class="flex min-w-0 flex-1 flex-col">
					<div
						class="truncate text-sm leading-5 font-semibold text-brand-text"
						title={currentTitle}
					>
						{currentTitle}
					</div>
					<div
						class="flex min-w-0 items-center gap-1.5 text-xs leading-4 text-brand-text-muted"
					>
						<StateDot dot={currentDot} />
						<span
							class="min-w-0 truncate"
							title={[sessionInfo.cwd, sessionInfo.model]
								.filter(Boolean)
								.join(' · ')}
							>{[folderName(sessionInfo.cwd), sessionInfo.model]
								.filter(Boolean)
								.join(' · ')}</span
						>
						{#if readOnly}
							<span class="flex-shrink-0 text-yellow-400">· read-only</span>
						{/if}
						{#if !connected}
							<span class="flex-shrink-0 text-rose-400">· disconnected</span>
						{:else}
							<span class="hidden flex-shrink-0 text-emerald-400 md:inline"
								>· connected</span
							>
						{/if}
					</div>
				</div>
			{:else}
				<!-- Status indicator (no session open) -->
				<div class="flex min-w-0 flex-1 items-center gap-2">
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

			<!-- 🔍 Search the web: leave the session for the web-search screen.
			     Shown with a session open AND while one is still loading, so it
			     never waits for the transcript (webSearchShortcutShown). -->
			{#if showWebSearchShortcut}
				<button
					type="button"
					onclick={startSearch}
					class="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg border border-brand-border bg-brand-surface-2 text-base text-brand-text-muted transition-colors hover:bg-brand-surface-3 hover:text-brand-text"
					title="Search the web (leaves this session)"
					aria-label="Search the web"
				>
					🔍
				</button>
			{/if}
			<!-- Star the open session: "come back to this". The natural moment is
			     right after this session hands a prompt to a new one, which will take
			     the top of the list. The star also shows on the session's sidebar row.
			     Desktop only: on the phone Star / Unstar is in ⋯. -->
			{#if sessionInfo.sessionFile}
				<button
					type="button"
					onclick={() =>
						setSessionStarred(sessionInfo.sessionFile!, !currentStarred).catch(
							() => {},
						)}
					class="hidden h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg border text-base transition-colors md:flex {currentStarred
						? 'border-amber-400/50 bg-amber-400/10 text-amber-400 hover:bg-amber-400/20'
						: 'border-brand-border bg-brand-surface-2 text-brand-text-muted hover:bg-brand-surface-3 hover:text-amber-400'}"
					title={currentStarred
						? 'Starred. Click to unstar.'
						: 'Star this session to come back to it later'}
					aria-label={currentStarred ? 'Unstar session' : 'Star session'}
					aria-pressed={currentStarred}
				>
					{currentStarred ? '★' : '☆'}
				</button>
			{/if}

			<!-- ⋯ the session menu (ChatSessionMenu.svelte): model, star, rename,
			     copy link, close, reset the assistant, "This chat"
			     and "On this device" settings, context and versions. With no
			     session open, only "On this device". -->
			<ChatSessionMenu
				listed={currentListed}
				title={currentTitle}
				viewingAssistant={connected && viewingAssistant}
			/>
		</div>

		<!-- The slim bar of hidden questions, and the compact question toast
		     over the conversation (spec notifications-compact). -->
		<NotificationToasts
			{needsYouOpen}
			openSessionId={currentSessionId ?? null}
			onOpenNeedsYou={openNeedsYou}
		/>

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

		<!-- RETIRED assistant session (ADR 0020): this session lives in the
		     assistant folder but is no longer the current one (the assistant was
		     reset). Hard read-only, no "Continue anyway": writing here would fork
		     the assistant's conversation into a session nobody points at, so the
		     way forward is the current session. -->
		{#if retired}
			<div
				class="flex items-center justify-between gap-3 border border-yellow-500/30 bg-yellow-500/10 px-4 py-2 text-sm text-yellow-400"
			>
				<span class="min-w-0 flex-1 break-words">
					The assistant was reset: this is an earlier assistant session,
					read-only history.
				</span>
				{#if connected}
					<button
						onclick={() => openAssistant()}
						class="flex-shrink-0 rounded-md border border-yellow-500/40 bg-yellow-500/20 px-3 py-1 text-xs font-medium text-yellow-300 transition-colors hover:bg-yellow-500/30"
						>Open current session</button
					>
				{/if}
			</div>
		{/if}

		<!-- Read-only banner. Suppressed only while the DISMISSIBLE folder-conflict
		     banner is up: that one already explains why this session is read-only and
		     carries the "Continue anyway" escape, so showing both reads as a dead end.
		     Once continued, the conflict banner has no button left, so a read-only
		     that SURVIVED the continue (a hard sessions.readOnly folder, which the
		     server refuses to lift) must still explain itself here. -->
		{#if readOnly && !interrupted && !fMissing && !retired && !(fConflict?.active && !fConflict.continued)}
			<div
				class="border border-yellow-500/30 bg-yellow-500/10 px-4 py-2 text-center text-sm text-yellow-400"
			>
				Read-only: this session cannot be driven from here
			</div>
		{/if}

		<!-- Chat area -->
		<ChatMessageList bind:this={chatList} onMessageSent={() => {}} />

		<!-- The update toast (spec notifications-compact, story 12): it hangs
		     above this point, over the conversation and just above the composer
		     (or whatever ends the column when there is none). -->
		<UpdateToast />

		<!-- Input: one composer, mode-switched. Search mode when connected, a
		     search folder is configured, and no session is active; chat mode
		     otherwise. Always mounted so it can be focused inside a tap gesture.
		     EXCEPTION: a read-only session (e.g. a sessions.readOnly fleet folder)
		     hides the composer entirely -- it is an observe-only view. -->
		{#if fMissing}
			<!-- MISSING FOLDER: this session's working folder is not usable on this
			     machine -- it does not exist (the transcript synced, the clone did
			     not), or a restore is still materialising it. The conversation above
			     is fully readable, but the server built no agent and refuses every
			     send, so the composer is replaced by the RESTORE PANEL: the missing
			     path, an editable pre-filled URL, and the clone with live progress,
			     ending in a reload that brings the session back live. There is
			     deliberately no dismiss: unlike the folder conflict this is not a
			     warning, it is the absence of the folder. -->
			<RestorePanel />
		{:else if readOnly && sessionInfo.sessionFile}
			<!-- No composer on a read-only session, so its ■ Stop lives here while
			     the agent runs (the server accepts abort from a read-only client). -->
			<div
				class="flex items-center justify-center gap-3 border-t border-brand-border bg-brand-surface px-4 py-3 text-center text-xs text-brand-text-muted"
			>
				<span>👁️ Read-only session, observing only, no input.</span>
				{#if appState.isStreaming}
					<button
						type="button"
						onclick={abort}
						class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-rose-500 text-brand-text transition-colors hover:bg-rose-600"
						title="Stop the agent"
						aria-label="Stop"
					>
						<span class="block h-3 w-3 rounded-[2px] bg-current"></span>
					</button>
				{/if}
			</div>
		{:else}
			<!-- Suspended/reconnecting: show a thin status banner ABOVE the composer
			     instead of replacing it. Keeping ChatInput mounted preserves the
			     textarea (and any in-progress draft) in the live DOM so a resync can
			     never destroy what the user was typing. The composer stays EDITABLE
			     (type, attach; uploads wait for the socket): only SENDING is blocked
			     (sendDisabled) until the socket is back and the session has resynced. -->
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
					: readOnly || !sessionInfo.sessionFile}
				sendDisabled={!searchActive &&
					(!connected || resyncing || agentPending)}
				onSend={() => chatList?.forceScrollToBottom()}
			/>
		{/if}
	</div>

	<!-- Sudo password prompt for `!sudo ...` commands -->
	<SudoPasswordDialog />

	<!-- "Also close the N sessions it owns?" (sidebar and top-bar close) -->
	<CloseCascadePrompt />

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
