<script lang="ts">
	import {
		messages,
		isStreaming,
		abort,
		activeSessionInfo,
		createSession,
		piState,
		updateConfig,
		loadMoreHistory,
		hasMoreHistory,
		isLoadingMoreHistory,
		isLoadingSession,
		isResyncing,
		sessionError,
		resendMessage,
		discardMessage,
		cancelSteer,
		pendingSteering,
		beepEnabled,
		beepSessionOverride,
		setBeepSessionOverride,
		conversationMode,
		conversationModeSessionOverride,
		setConversationModeBundle,
		speakReplies,
		collapseLongReplies,
		getConversationKnobs,
		isReadOnly,
		downloadFileUrl,
		forkSession,
	} from '$lib/wherever';
	import {mediaKind} from '$lib/core/media-kind';
	import {
		armTtsGestureUnlock,
		speakUtterance,
		unlockTts,
	} from '$lib/core/speak';
	import {
		shouldSpeakFallback,
		spokenFallbackText,
	} from '$lib/core/speak-fallback';
	import {shouldCollapseReply, isLongReply} from '$lib/core/collapse-reply';
	import {isKnobActive} from '$lib/core/conversation-mode';
	import {
		availableModels,
		gitInitDefaultStore,
		checkPath,
		autocompletePath,
		checkRemoteRepo,
	} from '$lib/session-store';
	import {onMount} from 'svelte';
	import {url} from '$lib/core/utils/web/path';
	import {
		renderAssistant,
		renderUser,
		formatTokens,
		formatTime,
		parseUserMessage,
		parseToolMessage,
		toolDuration,
		isFirstClassTool,
		isAssociatedWithForceCommand,
		shouldAutoExpand,
		isScrolledToBottom,
		lastAssistantReply,
		speechLocale,
		filterMessages,
	} from './chat-message-helpers';

	// "11.3% / 1.0M". Percent omitted ("–") right after compaction when tokens are
	// momentarily unknown.
	let contextLabel = $derived.by(() => {
		const u = $piState.contextUsage;
		if (!u || !u.contextWindow) return null;
		const window = formatTokens(u.contextWindow);
		if (u.percent == null) return `– / ${window}`;
		return `${u.percent.toFixed(1)}% / ${window}`;
	});

	let newFolderCwd = $state('');
	let completions = $state<string[]>([]);
	let inputFocused = $state(false);
	let inputEl = $state<HTMLInputElement | null>(null);
	let containerEl = $state<HTMLDivElement | null>(null);
	let lastCheckedPath = '';
	let newFolderModel = $state('');
	let newFolderGitInit = $state(false);
	let userManualGitInit = $state<boolean | null>(null);
	let createRemoteRepo = $state(true);
	let repoVisibility = $state<'private' | 'public'>('private');
	let showGitInitConfirmModal = $state(false);
	// Clone-existing-remote flow. When creating a session in a non-existing folder
	// that matches a remote rule, we probe (at submit time) whether the remote
	// repo already exists. If it does, we ask the user whether to CLONE it (SSH)
	// instead of creating a fresh empty remote.
	let showCloneConfirmModal = $state(false);
	let checkingRemote = $state(false);
	let cloneRemoteInfo = $state<{provider?: string; sshUrl?: string} | null>(
		null,
	);

	function submitCreateSession(cloneRemote: boolean) {
		createSession(
			newFolderCwd.trim(),
			newFolderModel || undefined,
			cloneRemote ? false : newFolderGitInit,
			cloneRemote
				? false
				: pathStatus.matchingRule
					? createRemoteRepo
					: undefined,
			cloneRemote
				? undefined
				: pathStatus.matchingRule
					? repoVisibility
					: undefined,
			cloneRemote || undefined,
		);
	}

	let appState = $derived($piState);
	let modelsData = $derived($availableModels);
	let defaultGitInit = $derived($gitInitDefaultStore);

	// Sync git init default
	$effect(() => {
		if (userManualGitInit === null) {
			newFolderGitInit = defaultGitInit;
		}
	});

	let pathStatus = $state<{
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

	let isRemoteRepoCreation = $derived(
		pathStatus.exists !== true && pathStatus.matchingRule && createRemoteRepo,
	);

	let pathCheckTimeout: ReturnType<typeof setTimeout> | null = null;

	async function triggerCheck(pathValue: string, immediate = false) {
		if (pathCheckTimeout) clearTimeout(pathCheckTimeout);

		if (pathValue === lastCheckedPath && !immediate) return;
		lastCheckedPath = pathValue;

		if (!pathValue.trim()) {
			pathStatus = {
				exists: null,
				isGit: false,
				resolvedPath: '',
				matchingRule: null,
			};
			const fetchEmpty = async () => {
				const list = await autocompletePath('');
				completions = list || [];
			};
			if (immediate) {
				await fetchEmpty();
			} else {
				pathCheckTimeout = setTimeout(fetchEmpty, 300);
			}
			return;
		}

		const fetchFn = async () => {
			const [res, list] = await Promise.all([
				checkPath(pathValue),
				autocompletePath(pathValue),
			]);
			completions = list || [];
			if (res) {
				pathStatus = {
					exists: res.exists,
					isGit: res.isGit,
					resolvedPath: res.resolvedPath,
					matchingRule: (res as any).matchingRule || null,
				};
				if (!res.exists) {
					newFolderGitInit =
						userManualGitInit !== null ? userManualGitInit : defaultGitInit;
					createRemoteRepo = true; // reset to true for non-existing folders
					if ((res as any).matchingRule) {
						repoVisibility = (res as any).matchingRule.visibility as
							| 'private'
							| 'public';
					}
				}
			} else {
				pathStatus = {
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
			pathCheckTimeout = setTimeout(fetchFn, 300);
		}
	}

	$effect(() => {
		const pathValue = newFolderCwd;
		triggerCheck(pathValue, false);
	});

	// Select default model if any
	$effect(() => {
		if (modelsData.models.length > 0 && !newFolderModel) {
			const defaultModel = modelsData.models.find((m) => m.isDefault);
			if (defaultModel) {
				newFolderModel = `${defaultModel.provider}:${defaultModel.modelId}`;
			} else {
				newFolderModel = `${modelsData.models[0].provider}:${modelsData.models[0].modelId}`;
			}
		}
	});

	async function handleFormCreateSession() {
		if (!newFolderCwd.trim()) return;
		if (pathStatus.exists === true) {
			newFolderGitInit = false; // toggled off by default in modal
			createRemoteRepo = false; // toggled off by default in modal
			if (pathStatus.matchingRule) {
				repoVisibility = pathStatus.matchingRule.visibility as
					| 'private'
					| 'public';
			}
			showGitInitConfirmModal = true;
			return;
		}

		// Non-existing folder. If it matches a remote rule AND the user still
		// wants a remote, probe (at submit time) whether that remote repo already
		// exists. If so, offer to CLONE it instead of failing on create.
		if (pathStatus.matchingRule && createRemoteRepo) {
			checkingRemote = true;
			try {
				const probe = await checkRemoteRepo(newFolderCwd.trim());
				if (probe && probe.matched && probe.exists) {
					cloneRemoteInfo = {
						provider: probe.provider,
						sshUrl: probe.sshUrl,
					};
					showCloneConfirmModal = true;
					return;
				}
			} finally {
				checkingRemote = false;
			}
		}

		submitCreateSession(false);
	}

	let messageList = $state<HTMLDivElement>();
	let {onMessageSent}: {onMessageSent: () => void} = $props();

	let sessionInfo = $derived($activeSessionInfo);
	let loadingSession = $derived($isLoadingSession);
	let resyncing = $derived($isResyncing);
	let readOnly = $derived($isReadOnly);

	// Fork-at-user-message (pi's `/fork`, position 'before'). Clicking the fork
	// icon on a user message asks the server to branch the session BEFORE that
	// message; the response switches us to the new session and pre-fills the
	// composer with the forked-at text to edit and resend.
	function handleFork(entryId: string | undefined) {
		if (!entryId) return;
		const sessionId = sessionInfo.sessionId;
		if (!sessionId) return;
		forkSession(sessionId, entryId);
	}

	// Per-session beep control is tri-state: undefined = follow the global
	// default, true/false = an explicit choice that sticks to this session.
	// Cycling order: Default -> On -> Off -> Default. Showing "Default" (rather
	// than a plain on/off) is what signals the choice has NOT been set for this
	// session, so it tracks the default live.
	let beepOverride = $derived($beepSessionOverride);
	let beepOn = $derived($beepEnabled);
	// The Conversation Mode master toggle: one click flips the configured bundle
	// of knobs ON at once (and back OFF). The knobs it gates are edited
	// individually in Connection Settings.
	let conversationOn = $derived($conversationMode);
	// Whether THIS conversation is just following the global default (no explicit
	// choice of its own). Surfaced in the toggle's tooltip so the per-conversation
	// scope is legible: the same bar toggle in another conversation is independent.
	let conversationFollowsDefault = $derived(
		$conversationModeSessionOverride === undefined,
	);
	// This click handler is ALSO the TTS gesture-unlock point. Mobile Chrome / iOS
	// Safari / installed PWAs only allow the FIRST speechSynthesis.speak() from
	// inside a user gesture, and the `say` reply is spoken from a gesture-less
	// WebSocket-driven $effect below -- so without priming here, mobile silently
	// drops every spoken reply. Turning conversation mode ON is exactly the user
	// opting into spoken replies, so it is the natural gesture to prime from. The
	// priming is silent, idempotent and a no-op where speechSynthesis is absent
	// (see core/speak.ts), so this is safe on the OFF direction too -- we prime
	// unconditionally rather than only when turning on, since a user who toggles
	// off and on again would otherwise depend on which tap primed.
	function toggleConversationMode() {
		unlockTts();
		setConversationModeBundle(!conversationOn);
	}

	// Whether the `collapseLongReplies` knob is currently ACTIVE. Being a gated
	// conversation knob, it is active only when the master conversationMode is ALSO
	// on (see isKnobActive), so with conversation mode off (or the knob off) long
	// replies render exactly as today -- no collapse. Reactive on both stores so the
	// transcript re-evaluates the instant either flips. This drives a DISPLAY-only
	// collapse: the full written reply is never removed/truncated and always stays
	// expandable (see core/collapse-reply.ts + the assistant branch below).
	let collapseActive = $derived(
		isKnobActive('collapseLongReplies', {
			conversationMode: $conversationMode,
			autoSendOnSpeechEnd: false,
			speakReplies: false,
			collapseLongReplies: $collapseLongReplies,
			micReopensAfterReply: false,
		}),
	);

	// TTS for the `say` tool. When the `speakReplies` knob is ACTIVE (which, being
	// a gated conversation knob, requires the master conversationMode on too — see
	// isKnobActive), a completed `say` tool call speaks its short text aloud via
	// the browser SpeechSynthesis API, using the configured speech locale for the
	// utterance lang. Feature-detected to a graceful no-op when the browser has no
	// speechSynthesis (see core/speak.ts). This is ADDITIVE: the full written
	// reply always stays in the transcript, and the spoken text comes ONLY from
	// the agent's explicit `say` call (never a client-side summary).
	//
	// Each say message is spoken AT MOST ONCE: its id is recorded on first speak
	// so re-renders/reactivity never re-fire the utterance. We wait until the tool
	// message has finished streaming so the text is final. With speakReplies off,
	// no utterance fires.
	const spokenSayIds = new Set<string>();
	// Whether a `say` reply has been spoken for the turn currently in flight. The
	// spoken-reply FALLBACK below only speaks a turn the agent left unspoken, so
	// the agent's own `say` line always wins.
	let spokeThisTurn = false;

	$effect(() => {
		// Subscribe reactively to the message list and the knob store so this re-runs
		// when a new say message settles or the knob flips.
		const list = $messages;
		void $speakReplies;
		for (const msg of list) {
			if (msg.role !== 'tool' || msg.toolName !== 'say') continue;
			if (msg.isStreaming) continue; // wait for the final text
			if (spokenSayIds.has(msg.id)) continue;
			// Mark first so a failed/again render never double-speaks.
			spokenSayIds.add(msg.id);
			if (msg.isError) continue;
			if (!isKnobActive('speakReplies', getConversationKnobs())) continue;
			const parsed = parseToolMessage(msg);
			if (!parsed.sayText) continue;
			spokeThisTurn = true;
			speakUtterance(parsed.sayText, speechLocale());
		}
	});

	// Prime browser TTS from the user's FIRST gesture whenever spoken replies are
	// active. The explicit unlock points (the Conversation Mode toggle, the mic
	// button, settings-save) all assume the user TOUCHES one of them in this page
	// load; a returning user whose conversation mode is already persisted ON does
	// not, so on mobile every reply was dropped by the user-activation gate while
	// desktop spoke fine. See core/speak.ts armTtsGestureUnlock.
	$effect(() => {
		void $conversationMode;
		void $speakReplies;
		if (!isKnobActive('speakReplies', getConversationKnobs())) return;
		armTtsGestureUnlock();
	});

	// The spoken-reply FALLBACK. `say` is a REQUEST to the model, and compliance is
	// a model property: smaller models skip it for entire turns (measured ~50% on a
	// local 35B, and almost never right after a tool result), which left conversation
	// mode silent exactly when the user was listening. So when a turn SETTLES with
	// spoken replies active and nothing was spoken, speak a short plain lead-in of
	// the written reply instead. Additive and display-only-adjacent: the written
	// reply in the transcript is never modified, and a turn the agent DID speak is
	// never re-spoken. Keyed off the same isStreaming true->false settle edge the
	// waiting-for-human beep and the hands-free mic-reopen use.
	let prevStreamingForSpeech = false;
	const fallbackSpokenIds = new Set<string>();

	$effect(() => {
		const list = $messages;
		const streamingNow = $isStreaming;
		void $speakReplies;

		if (streamingNow && !prevStreamingForSpeech) {
			// A new turn began: it has not spoken yet.
			spokeThisTurn = false;
		} else if (!streamingNow && prevStreamingForSpeech) {
			const reply = lastAssistantReply(list);
			if (reply && !fallbackSpokenIds.has(reply.id)) {
				fallbackSpokenIds.add(reply.id);
				if (
					shouldSpeakFallback({
						active: isKnobActive('speakReplies', getConversationKnobs()),
						spokeThisTurn,
						reply: reply.text,
					})
				) {
					speakUtterance(spokenFallbackText(reply.text), speechLocale());
				}
			}
			spokeThisTurn = false;
		}
		prevStreamingForSpeech = streamingNow;
	});
	function cycleBeep() {
		if (beepOverride === undefined) setBeepSessionOverride(true);
		else if (beepOverride === true) setBeepSessionOverride(false);
		else setBeepSessionOverride(undefined);
	}

	// True when we hold a cached session (its file + messages) that is merely
	// reconnecting/resyncing, not loading fresh. In this state the conversation
	// must stay on screen (with the parent's "Reconnecting..." banner over the
	// composer) instead of being replaced by the big "Not connected" panel or the
	// new-session / search empty-state. This is the core of "block only where it
	// matters (this session)": a dropped socket blocks sending, not reading.
	let hasCachedSession = $derived(!!sessionInfo.sessionFile);
	// A load ended in an error with nothing active: a URL hash still naming that
	// session must not keep the "Loading session..." spinner up (mirrors
	// isSessionPendingOpen's loadFailed in +page.svelte).
	let loadFailed = $derived(
		!!$sessionError && !loadingSession && !resyncing && !hasCachedSession,
	);

	let shouldAutoScroll = $state(true);
	let forceScroll = $state(false);

	let expandedMessages = $state<Record<string, boolean>>({});

	function toggleMessage(id: string, currentVal: boolean) {
		expandedMessages[id] = !currentVal;
	}

	// Per-assistant-message "show raw source" toggle: when true, the message is
	// shown as its verbatim markdown text (a <pre>) instead of the rendered HTML.
	// Keyed by message id so each message toggles independently and the choice
	// survives re-renders.
	let rawMessages = $state<Record<string, boolean>>({});

	function toggleRaw(id: string) {
		rawMessages[id] = !rawMessages[id];
	}

	// Per-message "copied!" confirmation. Set to the message id briefly after a
	// successful copy so the button can flash feedback, then cleared.
	let copiedMessageId = $state<string | null>(null);
	let copiedTimeout: ReturnType<typeof setTimeout> | null = null;

	async function copyMessage(id: string, content: string) {
		try {
			if (navigator.clipboard?.writeText) {
				await navigator.clipboard.writeText(content);
			} else {
				// Fallback for insecure contexts / older browsers.
				const ta = document.createElement('textarea');
				ta.value = content;
				ta.style.position = 'fixed';
				ta.style.opacity = '0';
				document.body.appendChild(ta);
				ta.select();
				document.execCommand('copy');
				document.body.removeChild(ta);
			}
			copiedMessageId = id;
			if (copiedTimeout) clearTimeout(copiedTimeout);
			copiedTimeout = setTimeout(() => {
				copiedMessageId = null;
				copiedTimeout = null;
			}, 1500);
		} catch (e) {
			console.error('Failed to copy message', e);
		}
	}

	function handleScroll() {
		if (messageList) {
			shouldAutoScroll = isScrolledToBottom(messageList);
		}
	}

	function scrollToBottom() {
		if (messageList) {
			messageList.scrollTop = messageList.scrollHeight;
		}
	}

	function scrollToBottomIfShould() {
		if (shouldAutoScroll || forceScroll) {
			scrollToBottom();
			forceScroll = false;
		}
	}

	onMount(scrollToBottom);

	$effect(() => {
		if (messageList) {
			messageList.addEventListener('scroll', handleScroll);
			return () => {
				if (messageList) {
					messageList.removeEventListener('scroll', handleScroll);
				}
			};
		}
	});

	let lastSessionFile = $state<string | null>(null);
	let wasLoadingSession = $state(false);

	// Scroll the freshly-loaded session to the bottom. The session history
	// arrives as a separate WS message after the session itself, and the
	// rendered messages (markdown, code blocks) keep growing for a few frames
	// after they mount, so a single synchronous scroll lands too early. Retry
	// across a couple of frames to settle on the true bottom.
	function scrollToBottomSettled() {
		forceScroll = true;
		scrollToBottom();
		requestAnimationFrame(() => {
			scrollToBottom();
			requestAnimationFrame(scrollToBottom);
		});
		setTimeout(scrollToBottom, 60);
		setTimeout(scrollToBottom, 150);
	}

	$effect(() => {
		// Force scroll to bottom when the active session changes...
		const sFile = sessionInfo.sessionFile;
		if (sFile !== lastSessionFile) {
			lastSessionFile = sFile;
			forceScroll = true;
		}

		// ...and again once its history finishes loading, since the messages only
		// render after loadingSession flips back to false.
		const isLoading = loadingSession;
		if (wasLoadingSession && !isLoading) {
			scrollToBottomSettled();
		}
		wasLoadingSession = isLoading;
	});

	let msgList = $derived.by(() =>
		filterMessages(
			$messages,
			{
				hideThinking: $piState.hideThinking,
				hideTools: $piState.hideTools,
			},
			streaming,
		),
	);
	let streaming = $derived($isStreaming);

	// A live "now" that ticks ~every 100ms ONLY while a tool call is running, so
	// the "Elapsed N.Ns" duration counts up in real time (mirrors the pi CLI's
	// bash tool). The interval is torn down as soon as no tool is streaming, so an
	// idle session does no per-frame work. A finished tool freezes its duration
	// from startedAt..endedAt and does not depend on this ticker.
	let now = $state(Date.now());
	let anyToolRunning = $derived(
		msgList.some((m) => m.role === 'tool' && m.isStreaming),
	);
	$effect(() => {
		if (!anyToolRunning) return;
		now = Date.now();
		const id = setInterval(() => (now = Date.now()), 100);
		return () => clearInterval(id);
	});

	$effect.pre(() => {
		// React to msgList length and content changes of the last message in msgList
		const lastMsg = msgList[msgList.length - 1];
		const triggerValue = lastMsg
			? `${msgList.length}-${lastMsg.content.length}`
			: '0';

		if (messageList) {
			shouldAutoScroll = isScrolledToBottom(messageList);
		}
	});

	$effect(() => {
		// React to msgList length and content changes of the last message in msgList
		const lastMsg = msgList[msgList.length - 1];
		const triggerValue = lastMsg
			? `${msgList.length}-${lastMsg.content.length}`
			: '0';

		scrollToBottomIfShould();
	});

	export function forceScrollToBottom() {
		forceScroll = true;
		setTimeout(scrollToBottom, 0);
	}

	let moreHistory = $derived($hasMoreHistory);
	let loadingMore = $derived($isLoadingMoreHistory);

	// Scroll anchoring: when older messages are prepended, keep the viewport
	// anchored on the message that was previously first, and reveal the newly
	// loaded messages as a gap above it.
	//
	// We record the id of the first message before the load. After the older
	// window is prepended, we scroll so that anchor message sits just below the
	// top of the viewport, leaving REVEAL_GAP_PX of the newly loaded messages
	// visible above it as a hint that more history was inserted. If the anchor
	// element can't be found (e.g. it was filtered out), we fall back to
	// preserving the distance from the bottom so the content at least doesn't
	// jump.
	const REVEAL_GAP_PX = 64;
	let pendingAnchorId = $state<string | null>(null);
	let pendingAnchorFromBottom = $state<number | null>(null);

	function handleLoadMore() {
		if (!messageList || loadingMore || !moreHistory) return;
		// Anchor on the first currently-rendered message so we can bring it back
		// to (near) the top after the older window is prepended.
		pendingAnchorId = msgList[0]?.id ?? null;
		// Fallback anchor: distance from the bottom, in case the id can't be found.
		pendingAnchorFromBottom = messageList.scrollHeight - messageList.scrollTop;
		loadMoreHistory();
	}

	$effect(() => {
		// When messages change and we have a pending anchor (older history was
		// just prepended), restore the scroll position.
		const _len = $messages.length;
		if (
			(pendingAnchorId !== null || pendingAnchorFromBottom !== null) &&
			messageList
		) {
			const anchorId = pendingAnchorId;
			const anchorFromBottom = pendingAnchorFromBottom;
			pendingAnchorId = null;
			pendingAnchorFromBottom = null;
			// Defer until after DOM paints the prepended nodes.
			requestAnimationFrame(() => {
				if (!messageList) return;
				const anchorEl = anchorId
					? messageList.querySelector<HTMLElement>(
							`[data-msg-id="${CSS.escape(anchorId)}"]`,
						)
					: null;
				if (anchorEl) {
					// Position the previously-first message just below the top, leaving
					// a gap that reveals the newly loaded messages above it. Using
					// rects (instead of offsetTop) keeps this correct regardless of the
					// element's offset parent.
					const delta =
						anchorEl.getBoundingClientRect().top -
						messageList.getBoundingClientRect().top;
					messageList.scrollTop = Math.max(
						0,
						messageList.scrollTop + delta - REVEAL_GAP_PX,
					);
				} else if (anchorFromBottom !== null) {
					messageList.scrollTop = messageList.scrollHeight - anchorFromBottom;
				}
			});
		}
	});
</script>

<div class="flex flex-1 flex-col overflow-hidden bg-brand-dark">
	{#if appState.connecting && !hasCachedSession}
		<div
			class="flex flex-1 flex-col items-center justify-center bg-brand-dark p-6 text-brand-text-muted"
		>
			<div class="text-center">
				<div
					class="mb-4 inline-block h-8 w-8 animate-spin rounded-full border-4 border-brand-blue border-t-transparent"
				></div>
				<p class="text-base font-medium text-brand-text">
					Connecting to Wherever Server...
				</p>
				<p class="mt-1 text-xs text-brand-text-muted">
					Establishing secure connection to your agent
				</p>
			</div>
		</div>
	{:else if !appState.connected && !hasCachedSession}
		<div
			class="flex flex-1 flex-col items-center justify-center bg-brand-dark p-6 text-brand-text-muted"
		>
			<div
				class="w-full max-w-md rounded-lg border border-red-500/30 bg-red-500/10 p-6 text-center text-brand-text"
			>
				<div class="mb-3 text-4xl">⚠️</div>
				<h3 class="text-lg font-bold text-rose-400">Not Connected to Server</h3>
				<p class="mt-2 text-sm text-brand-text-muted">
					We couldn't connect to the Wherever Server. Please verify the server
					is running and check your connection settings in the sidebar.
				</p>
				{#if appState.error}
					<p
						class="mt-3 max-h-24 overflow-y-auto rounded bg-brand-surface-3 p-2 font-mono text-xs text-rose-300/80"
					>
						{appState.error}
					</p>
				{/if}
				<button
					onclick={() => {
						import('$lib/wherever').then((m) => m.connect());
					}}
					class="mt-5 rounded bg-brand-surface-2 px-4 py-2 text-sm font-semibold text-brand-text transition-colors hover:bg-brand-surface-3"
				>
					Retry Connection
				</button>
			</div>
		</div>
	{:else if !hasCachedSession && (loadingSession || (!loadFailed && typeof window !== 'undefined' && window.location.hash))}
		<!-- Genuine fresh load of a session we do NOT yet hold. A resync of a
		     cached session does NOT reach here (it keeps hasCachedSession true and
		     falls through to the messages view with the parent's reconnect banner),
		     so returning to the app never flashes this full-screen spinner over an
		     already-loaded conversation. -->
		<div
			class="flex flex-1 flex-col items-center justify-center bg-brand-dark p-6 text-brand-text-muted"
		>
			<div class="text-center">
				<div
					class="mb-4 inline-block h-8 w-8 animate-spin rounded-full border-4 border-brand-blue border-t-transparent"
				></div>
				<p class="text-base font-medium text-brand-text">Loading session...</p>
				<p class="mt-1 text-xs text-brand-text-muted">
					Retrieving workspace session history
				</p>
			</div>
		</div>
	{:else if !sessionInfo.sessionFile}
		<div class="flex flex-1 items-center justify-center p-6">
			<div
				class="w-full max-w-md rounded-lg border border-brand-border bg-brand-surface/40 p-6 text-brand-text"
			>
				<div class="mb-5 text-center">
					<div class="mb-3 flex justify-center">
						<img src={url('/logo.svg')} alt="Wherever" class="h-16 w-16" />
					</div>
					<h2 class="mb-1 text-2xl font-bold">
						<span class="gradient-text">Wherever</span>
					</h2>
					<h3 class="text-sm font-semibold text-brand-text">
						Create a New Session
					</h3>
					<p class="mt-1 text-xs text-brand-text-muted">
						Start a coding session in any folder on your machine, or use the
						sidebar to open an existing session.
					</p>
				</div>

				<form
					onsubmit={(e) => {
						e.preventDefault();
						handleFormCreateSession();
					}}
					class="space-y-4"
				>
					<div>
						<label
							class="mb-1 block text-xs font-bold tracking-wider text-brand-text-muted uppercase"
							for="main-folder-path">Folder Path</label
						>
						<div class="relative" bind:this={containerEl}>
							<input
								bind:this={inputEl}
								id="main-folder-path"
								type="text"
								autocomplete="off"
								spellcheck="false"
								placeholder="e.g. ~/projects/my-new-app"
								bind:value={newFolderCwd}
								onfocus={() => {
									inputFocused = true;
									triggerCheck(newFolderCwd, true);
								}}
								onblur={(e) => {
									if (
										containerEl &&
										containerEl.contains(e.relatedTarget as Node)
									) {
										return;
									}
									inputFocused = false;
								}}
								onkeydown={(e) => {
									if (e.key === 'Escape') {
										inputFocused = false;
									}
								}}
								class="w-full rounded border px-3 py-2 text-sm text-brand-text placeholder-brand-text-muted transition-all duration-200 focus:outline-none {isRemoteRepoCreation
									? 'border-emerald-500/80 bg-emerald-500/10 focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400/30'
									: 'border-brand-border bg-brand-surface-3 focus:border-brand-blue'}"
							/>
							{#if inputFocused && completions.length > 0}
								<div
									class="absolute right-0 left-0 z-50 mt-1 max-h-48 overflow-y-auto rounded border border-brand-border bg-brand-surface-2 py-1 shadow-xl"
								>
									{#each completions as completion}
										<button
											type="button"
											onclick={() => {
												newFolderCwd = completion;
												triggerCheck(completion, true);
												inputEl?.focus();
											}}
											class="block w-full px-3 py-1.5 text-left text-sm text-brand-text transition-colors hover:bg-brand-surface-3 hover:text-brand-text"
										>
											{completion}
										</button>
									{/each}
								</div>
							{/if}
						</div>
						{#if pathStatus.exists === true}
							<span class="mt-1.5 block text-xs font-medium text-yellow-400">
								📁 Folder already exists. Joining will create a session in it.
								{#if pathStatus.isGit}
									<span class="ml-1 font-medium text-emerald-400"
										>(Git repo detected)</span
									>
								{/if}
							</span>
						{:else}
							<span class="mt-1 block text-[10px] text-brand-text-muted"
								>Relative paths are created inside your home folder.</span
							>
						{/if}
					</div>

					<div>
						<label
							class="mb-1 block text-xs font-bold tracking-wider text-brand-text-muted uppercase"
							for="main-model-select">Model</label
						>
						{#if modelsData.models.length > 0}
							<select
								id="main-model-select"
								bind:value={newFolderModel}
								class="w-full rounded border border-brand-border bg-brand-surface-3 px-3 py-2 text-sm text-brand-text focus:border-brand-blue focus:outline-none"
							>
								{#each modelsData.models as model}
									<option value={`${model.provider}:${model.modelId}`}>
										{model.label}{model.isDefault ? ' (default)' : ''}
									</option>
								{/each}
							</select>
						{:else}
							<input
								id="main-model-select"
								type="text"
								bind:value={newFolderModel}
								placeholder="provider:model"
								class="w-full rounded border border-brand-border bg-brand-surface-3 px-3 py-2 text-sm text-brand-text placeholder-brand-text-muted focus:border-brand-blue focus:outline-none"
							/>
						{/if}
					</div>

					{#if pathStatus.exists !== true && pathStatus.matchingRule}
						<div class="space-y-1.5 pt-1">
							<div class="flex items-center gap-2">
								<input
									id="main-create-remote"
									type="checkbox"
									bind:checked={createRemoteRepo}
									class="h-4 w-4 rounded border-brand-border bg-brand-surface-3 text-brand-blue focus:ring-brand-blue focus:ring-offset-brand-surface"
								/>
								<label
									for="main-create-remote"
									class="cursor-pointer text-sm text-brand-text select-none"
								>
									Create remote {pathStatus.matchingRule.provider} repository
								</label>
							</div>

							{#if createRemoteRepo}
								<div
									class="flex items-center gap-4 pl-6 text-xs text-brand-text-muted"
								>
									<span>Visibility:</span>
									<label
										class="flex cursor-pointer items-center gap-1.5 transition-colors select-none hover:text-brand-text"
									>
										<input
											type="radio"
											name="main-visibility"
											value="private"
											bind:group={repoVisibility}
											class="border-brand-border bg-brand-surface-3 text-brand-blue focus:ring-brand-blue"
										/>
										Private
									</label>
									<label
										class="flex cursor-pointer items-center gap-1.5 transition-colors select-none hover:text-brand-text"
									>
										<input
											type="radio"
											name="main-visibility"
											value="public"
											bind:group={repoVisibility}
											class="border-brand-border bg-brand-surface-3 text-brand-blue focus:ring-brand-blue"
										/>
										Public
									</label>
								</div>
							{/if}
						</div>
					{/if}

					{#if pathStatus.exists !== true && (!pathStatus.matchingRule || !createRemoteRepo)}
						<div class="flex items-center gap-2 pt-1">
							<input
								id="main-git-init"
								type="checkbox"
								bind:checked={newFolderGitInit}
								onchange={(e) => {
									userManualGitInit = e.currentTarget.checked;
								}}
								class="h-4 w-4 rounded border-brand-border bg-brand-surface-3 text-brand-blue focus:ring-brand-blue focus:ring-offset-brand-surface"
							/>
							<label
								for="main-git-init"
								class="cursor-pointer text-sm text-brand-text select-none"
							>
								Initialize Git repository
							</label>
						</div>
					{/if}

					<button
						type="submit"
						disabled={!newFolderCwd.trim() || checkingRemote}
						class="w-full rounded bg-gradient-to-r from-brand-cyan to-brand-blue py-2.5 text-sm font-semibold text-brand-text transition-all hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
					>
						{checkingRemote ? 'Checking remote...' : 'Create & Start Session'}
					</button>
				</form>
			</div>
		</div>
	{:else if msgList.length === 0 && (loadingSession || resyncing)}
		<!-- The session is known (session_created landed, so sessionFile is set)
		     but its history has not arrived yet: the server sends session_created
		     and message_history as two frames, and on a slow link the (large)
		     history frame can trail by seconds. Without this branch that gap fell
		     through to the "New Session Started" empty-state below, which lies
		     about an existing conversation. -->
		<div
			class="flex flex-1 flex-col items-center justify-center bg-brand-dark p-6 text-brand-text-muted"
		>
			<div class="text-center">
				<div
					class="mb-4 inline-block h-8 w-8 animate-spin rounded-full border-4 border-brand-blue border-t-transparent"
				></div>
				<p class="text-base font-medium text-brand-text">
					Loading conversation...
				</p>
				<p class="mt-1 text-xs text-brand-text-muted">
					Retrieving workspace session history
				</p>
			</div>
		</div>
	{:else if msgList.length === 0}
		<div class="flex flex-1 items-center justify-center text-brand-text-muted">
			<div class="text-center">
				<div class="mb-4 text-4xl">💬</div>
				<p class="mb-2 text-lg font-medium text-brand-text">
					New Session Started
				</p>
				<p class="text-sm">Type a message below to start building</p>
			</div>
		</div>
	{:else}
		<div
			bind:this={messageList}
			class="flex-1 space-y-4 overflow-y-auto overscroll-y-contain p-4"
		>
			{#if moreHistory}
				<div class="flex justify-center pb-2">
					<button
						onclick={handleLoadMore}
						disabled={loadingMore}
						class="rounded border border-brand-border bg-brand-surface-2 px-3 py-1.5 text-xs text-brand-text-muted transition-colors hover:bg-brand-surface-3 hover:text-brand-text disabled:cursor-not-allowed disabled:opacity-50"
					>
						{#if loadingMore}
							Loading older messages...
						{:else}
							Load older messages
						{/if}
					</button>
				</div>
			{/if}
			{#each msgList as msg (msg.id)}
				<div
					data-msg-id={msg.id}
					class="flex {msg.role === 'user' ? 'justify-end' : 'justify-start'}"
				>
					<div
						class="max-w-[85%] rounded-lg px-4 py-3 {msg.role === 'user'
							? msg.delivery === 'sending'
								? 'bg-brand-blue/40 text-brand-text ring-1 ring-brand-blue/50'
								: msg.delivery === 'failed'
									? 'bg-brand-blue/30 text-brand-text ring-1 ring-amber-400/50'
									: 'bg-brand-blue/80 text-brand-text'
							: msg.role === 'thinking'
								? 'border-l-2 border-brand-border bg-brand-surface/30 text-sm text-brand-text-muted'
								: msg.role === 'tool' && isFirstClassTool(msg.toolName)
									? 'bg-transparent p-0 text-brand-text'
									: msg.role === 'tool'
										? $piState.hideTools && !isAssociatedWithForceCommand(msg)
											? 'border-l-2 border-brand-border bg-brand-surface/30 text-sm text-brand-text-muted'
											: `border-l-2 bg-brand-surface-2 font-mono text-sm text-brand-text ${
													msg.isStreaming
														? 'border-amber-400'
														: msg.isError
															? 'border-rose-400'
															: msg.interrupted
																? 'border-brand-border'
																: 'border-emerald-400'
												}`
										: msg.role === 'assistant'
											? 'border-l-2 border-brand-purple bg-brand-purple/10 text-brand-text'
											: msg.content === '' && msg.isStreaming
												? 'bg-brand-surface-3 text-brand-text-muted italic'
												: 'bg-brand-surface-2 text-brand-text'}"
					>
						{#if msg.role === 'thinking'}
							{#if msg.content === 'FALLBACK_THINKING_LOADER'}
								<div
									class="flex items-center gap-2 font-sans text-sm text-brand-text-muted italic select-none"
								>
									<svg
										class="h-4 w-4 animate-spin text-brand-cyan"
										xmlns="http://www.w3.org/2000/svg"
										fill="none"
										viewBox="0 0 24 24"
									>
										<circle
											class="opacity-25"
											cx="12"
											cy="12"
											r="10"
											stroke="currentColor"
											stroke-width="4"
										></circle>
										<path
											class="opacity-75"
											fill="currentColor"
											d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
										></path>
									</svg>
									<span>Agent is thinking...</span>
								</div>
							{:else if msg.content === 'FALLBACK_LOADER'}
								<div
									class="flex items-center gap-2 font-sans text-sm text-brand-text-muted italic select-none"
								>
									<svg
										class="h-4 w-4 animate-spin text-brand-cyan"
										xmlns="http://www.w3.org/2000/svg"
										fill="none"
										viewBox="0 0 24 24"
									>
										<circle
											class="opacity-25"
											cx="12"
											cy="12"
											r="10"
											stroke="currentColor"
											stroke-width="4"
										></circle>
										<path
											class="opacity-75"
											fill="currentColor"
											d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
										></path>
									</svg>
									<span>Agent working...</span>
								</div>
							{:else if $piState.hideThinking}
								<div
									class="flex items-center gap-2 font-sans text-sm text-brand-text-muted italic select-none"
								>
									<svg
										class="h-4 w-4 animate-spin text-brand-cyan"
										xmlns="http://www.w3.org/2000/svg"
										fill="none"
										viewBox="0 0 24 24"
									>
										<circle
											class="opacity-25"
											cx="12"
											cy="12"
											r="10"
											stroke="currentColor"
											stroke-width="4"
										></circle>
										<path
											class="opacity-75"
											fill="currentColor"
											d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
										></path>
									</svg>
									<span>Agent is thinking...</span>
								</div>
							{:else}
								<div class="flex flex-col gap-1">
									{#if msg.isStreaming}
										<div
											class="mb-1 flex items-center gap-1.5 text-[10px] font-bold tracking-wider text-brand-cyan uppercase select-none"
										>
											<span
												class="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-brand-cyan"
											></span>
											<span>Thinking</span>
										</div>
									{/if}
									<div class="font-mono text-sm whitespace-pre-wrap">
										{msg.content}
									</div>
								</div>
							{/if}
						{:else if msg.role === 'tool'}
							{#if $piState.hideTools && !isFirstClassTool(msg.toolName) && !isAssociatedWithForceCommand(msg)}
								<div
									class="flex items-center gap-2 font-sans text-sm text-brand-text-muted italic select-none"
								>
									<svg
										class="h-4 w-4 animate-spin text-amber-500"
										xmlns="http://www.w3.org/2000/svg"
										fill="none"
										viewBox="0 0 24 24"
									>
										<circle
											class="opacity-25"
											cx="12"
											cy="12"
											r="10"
											stroke="currentColor"
											stroke-width="4"
										></circle>
										<path
											class="opacity-75"
											fill="currentColor"
											d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
										></path>
									</svg>
									<span
										>Running tool: <span
											class="rounded bg-brand-surface-3 px-1 py-0.5 font-mono text-xs font-semibold"
											>{msg.toolName || 'agent'}</span
										>...</span
									>
									{#if toolDuration(msg, now)}
										<span
											class="font-mono text-xs text-brand-text-muted tabular-nums"
											>{toolDuration(msg, now)}</span
										>
									{/if}
								</div>
							{:else}
								{@const parsed = parseToolMessage(msg)}
								{@const isExpanded =
									expandedMessages[msg.id] !== undefined
										? expandedMessages[msg.id]
										: shouldAutoExpand(msg, msgList)}
								{@const dlPath = parsed.downloadPath}
								{@const dlUrl = dlPath ? downloadFileUrl(dlPath) : null}
								{@const dlKind = dlPath ? mediaKind(dlPath) : null}
								{@const isAttachTool = parsed.toolName === 'attach_file'}
								{@const isSayTool = parsed.toolName === 'say'}
								{#if isAttachTool}
									<!-- attach_file rendered as a first-class ATTACHMENT, not a
									     generic tool card: the agent explicitly offered this file
									     for the (remote) user to download. Three states: streaming
									     (attaching...), error (could not attach), success (download
									     link). A failed attach shows the tool's error text so the
									     agent/user can see WHY (e.g. file not found). -->
									{@const fileName = dlPath
										? dlPath.split('/').pop() || dlPath
										: ''}
									<div class="flex max-w-full min-w-[240px] flex-col">
										{#if msg.isStreaming}
											<div
												class="flex items-center gap-3 rounded-lg border border-brand-border bg-brand-surface-2 px-3 py-2.5 text-brand-text-muted"
											>
												<span class="animate-pulse text-2xl leading-none"
													>📎</span
												>
												<span class="truncate text-sm">Attaching file…</span>
											</div>
										{:else if parsed.isError}
											<div
												class="flex items-start gap-3 rounded-lg border border-rose-400/40 bg-rose-400/10 px-3 py-2.5 text-brand-text"
											>
												<span class="text-2xl leading-none">📎</span>
												<span class="flex min-w-0 flex-1 flex-col gap-0.5">
													<span class="text-sm font-semibold text-rose-300"
														>Could not attach file</span
													>
													{#if parsed.toolOutput}
														<span
															class="text-xs break-words text-brand-text-muted"
															>{parsed.toolOutput}</span
														>
													{/if}
												</span>
											</div>
										{:else if dlUrl}
											<a
												href={dlUrl}
												download={fileName}
												class="flex items-center gap-3 rounded-lg border border-brand-cyan/40 bg-brand-cyan/10 px-3 py-2.5 text-brand-text no-underline transition-colors hover:bg-brand-cyan/20"
												title={`Download ${dlPath}`}
											>
												<span class="text-2xl leading-none">📎</span>
												<span class="flex min-w-0 flex-1 flex-col">
													<span class="truncate text-sm font-semibold"
														>{fileName}</span
													>
													<span
														class="truncate text-xs text-brand-text-muted"
														title={dlPath}>{dlPath}</span
													>
												</span>
												<span
													class="flex shrink-0 items-center gap-1 rounded-md bg-brand-cyan/20 px-2.5 py-1 text-xs font-medium text-brand-cyan"
													>⬇️ Download</span
												>
											</a>
										{:else}
											<div
												class="flex items-center gap-3 rounded-lg border border-brand-border bg-brand-surface-2 px-3 py-2.5 text-brand-text-muted"
											>
												<span class="text-2xl leading-none">📎</span>
												<span class="flex min-w-0 flex-1 flex-col">
													<span class="truncate text-sm font-semibold"
														>{fileName}</span
													>
													<span class="truncate text-xs"
														>No active session to download from</span
													>
												</span>
											</div>
										{/if}

										<!-- Inline image preview for an attached image, sourced from the
										     SAME token-gated download URL as the chip above (NOT from
										     embedded bytes). Additive: the download chip stays; this is a
										     tap-to-open, lazy-loaded preview so the image is viewable
										     without leaving the chat. -->
										{#if !msg.isStreaming && !parsed.isError && dlUrl && dlKind === 'image'}
											<a
												href={dlUrl}
												target="_blank"
												rel="noopener noreferrer"
												class="mt-2 block"
												title={`Open ${dlPath}`}
											>
												<img
													src={dlUrl}
													alt={dlPath}
													loading="lazy"
													class="max-h-96 max-w-full rounded border border-brand-border/40 bg-brand-dark/60 object-contain"
												/>
											</a>
										{/if}

										<!-- Inline AUDIO player for an attached audio file, sourced
										     from the SAME token-gated download URL as the chip above (NOT
										     from embedded bytes). Additive: the download chip stays; this
										     lets the user listen without leaving the chat. `preload`
										     metadata only, and an unsupported format degrades to the chip
										     (the browser renders the empty player; the chip above always
										     remains for save/share). -->
										{#if !msg.isStreaming && !parsed.isError && dlUrl && dlKind === 'audio'}
											<audio
												controls
												preload="metadata"
												src={dlUrl}
												title={dlPath}
												class="mt-2 block w-full max-w-full"
											></audio>
										{/if}

										<!-- Inline VIDEO player for an attached video file, sourced
										     from the SAME token-gated download URL as the chip above (NOT
										     from embedded bytes). Additive: the download chip stays; this
										     lets the user watch (and SEEK — the server honours HTTP Range)
										     without leaving the chat. `playsinline` keeps iOS from going
										     fullscreen; `preload` metadata only; an unsupported format
										     degrades to the chip (empty player, chip always remains). -->
										{#if !msg.isStreaming && !parsed.isError && dlUrl && dlKind === 'video'}
											<video
												controls
												playsinline
												preload="metadata"
												src={dlUrl}
												title={dlPath}
												class="mt-2 block max-h-96 w-full max-w-full rounded border border-brand-border/40 bg-brand-dark/60"
											></video>
										{/if}
									</div>
								{:else if isSayTool}
									<!-- say rendered as a first-class "spoken:" card, not a generic
									     tool card: the agent EXPLICITLY offered this SHORT spoken-form
									     reply (the 🔊 pill) so the user can visually compare it against
									     the FULL written reply, which always remains present in the
									     transcript above/below. The card is ADDITIVE: it never replaces
									     or hides the full reply. TTS (when speakReplies is active) fires
									     off the SAME text via the $effect below, not from here. -->
									<div class="flex max-w-full min-w-[240px] flex-col">
										{#if parsed.isError}
											<div
												class="flex items-start gap-3 rounded-lg border border-rose-400/40 bg-rose-400/10 px-3 py-2.5 text-brand-text"
											>
												<span class="text-2xl leading-none">🔇</span>
												<span class="flex min-w-0 flex-1 flex-col gap-0.5">
													<span class="text-sm font-semibold text-rose-300"
														>Could not speak</span
													>
													{#if parsed.toolOutput}
														<span
															class="text-xs break-words text-brand-text-muted"
															>{parsed.toolOutput}</span
														>
													{/if}
												</span>
											</div>
										{:else if parsed.sayText}
											<div
												class="flex items-start gap-3 rounded-lg border border-brand-cyan/40 bg-brand-cyan/10 px-3 py-2.5 text-brand-text"
											>
												<span class="text-2xl leading-none">🔊</span>
												<span class="flex min-w-0 flex-1 flex-col gap-1">
													<span
														class="text-[11px] font-semibold tracking-wide text-brand-cyan uppercase select-none"
														>spoken:</span
													>
													<span class="text-sm break-words text-brand-text"
														>{parsed.sayText}</span
													>
												</span>
											</div>
										{/if}
									</div>
								{:else}
									<div
										class="flex max-w-full min-w-[280px] flex-col sm:min-w-[400px] md:min-w-[550px]"
									>
										<!-- Header of tool execution. The collapse toggle (button) and an
									     optional download link (anchor) are SIBLINGS in a flex row so
									     the anchor is never nested inside the button. -->
										<div class="flex w-full items-center gap-1">
											<button
												onclick={() => toggleMessage(msg.id, isExpanded)}
												class="flex min-w-0 flex-1 items-center justify-between gap-3 rounded p-1 text-left transition-colors hover:bg-brand-surface-3/30 focus:outline-none"
											>
												<div
													class="flex flex-1 items-center gap-2 overflow-hidden"
												>
													<!-- Status icon -->
													{#if msg.isStreaming}
														<!-- Running -->
														<span
															class="inline-block animate-spin font-bold text-amber-400"
															>⚡</span
														>
													{:else if parsed.isError}
														<!-- Error -->
														<span class="font-bold text-rose-400" title="Failed"
															>❌</span
														>
													{:else if parsed.interrupted}
														<!-- Interrupted: no result (e.g. a CLI took over and the
												     running tool was killed). Outcome unknown: neither
												     success nor failure. -->
														<span
															class="font-bold text-brand-text-muted"
															title="Interrupted, no result (the running tool was stopped, e.g. by a CLI takeover)"
															>⊘</span
														>
													{:else}
														<!-- Success -->
														<span
															class="font-bold text-emerald-400"
															title="Succeeded">✅</span
														>
													{/if}

													<span
														class="font-mono text-sm font-bold text-brand-text"
													>
														{parsed.toolName}
													</span>

													{#if parsed.smartTitleArgs}
														<span
															class="max-w-[180px] truncate font-mono text-xs text-brand-text-muted sm:max-w-[300px] md:max-w-[450px]"
															title={parsed.smartTitleArgs}
														>
															{parsed.smartTitleArgs}
														</span>
													{/if}

													{#if toolDuration(msg, now)}
														<span
															class="shrink-0 font-mono text-xs tabular-nums {msg.isStreaming
																? 'text-amber-400'
																: 'text-brand-text-muted'}"
															title={msg.isStreaming
																? 'Elapsed time'
																: 'Time taken'}
														>
															{msg.isStreaming ? 'Elapsed' : 'Took'}
															{toolDuration(msg, now)}
														</span>
													{/if}
												</div>

												<div
													class="flex shrink-0 items-center gap-1 font-sans text-xs font-medium whitespace-nowrap text-brand-text-muted select-none hover:text-brand-text"
												>
													{#if isExpanded}
														Collapse <span class="text-[10px]">▲</span>
													{:else}
														Expand <span class="text-[10px]">▼</span>
													{/if}
												</div>
											</button>

											{#if dlPath}
												{#if dlUrl}
													<a
														href={dlUrl}
														download={dlPath.split('/').pop() || ''}
														class="flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-xs text-brand-cyan transition-colors hover:bg-brand-cyan/15"
														title={`Download ${dlPath}`}
														aria-label={`Download ${dlPath}`}
													>
														<span class="text-sm">⬇️</span>
													</a>
												{:else}
													<span
														class="shrink-0 px-1.5 py-1 text-xs text-brand-text-muted opacity-40"
														title="No active session to download from">⬇️</span
													>
												{/if}
											{/if}
										</div>

										<!-- Inline image preview from the DOWNLOAD URL (not embedded
									     bytes), for a file-oriented tool (now only `read`) whose path
									     is an image. Rendered OUTSIDE the collapsible section so it
									     survives collapse, and tap-to-open + lazy-loaded. De-duped
									     against the model-facing `msg.images` path below: when the
									     tool result already embeds image blocks we render ONLY those,
									     so a `read`-on-image shows exactly one preview. -->
										{#if !(msg.images && msg.images.length > 0) && dlUrl && dlKind === 'image'}
											<a
												href={dlUrl}
												target="_blank"
												rel="noopener noreferrer"
												class="mt-2 block"
												title={`Open ${dlPath}`}
											>
												<img
													src={dlUrl}
													alt={dlPath}
													loading="lazy"
													class="max-h-96 max-w-full rounded border border-brand-border/40 bg-brand-dark/60 object-contain"
												/>
											</a>
										{/if}

										<!-- Inline AUDIO player from the DOWNLOAD URL (not embedded
									     bytes), for a file-oriented tool (now only `read`) whose path
									     is audio. Rendered OUTSIDE the collapsible section so it
									     survives collapse; `preload` metadata only. The download chip
									     stays, so an unsupported format degrades gracefully to it. -->
										{#if dlUrl && dlKind === 'audio'}
											<audio
												controls
												preload="metadata"
												src={dlUrl}
												title={dlPath}
												class="mt-2 block w-full max-w-full"
											></audio>
										{/if}

										<!-- Inline VIDEO player from the DOWNLOAD URL (not embedded
									     bytes), for a file-oriented tool (now only `read`) whose path
									     is video. Rendered OUTSIDE the collapsible section so it
									     survives collapse; `playsinline` keeps iOS inline; `preload`
									     metadata only. The server honours HTTP Range so seeking works.
									     The download chip stays, so an unsupported format degrades to
									     it. -->
										{#if dlUrl && dlKind === 'video'}
											<video
												controls
												playsinline
												preload="metadata"
												src={dlUrl}
												title={dlPath}
												class="mt-2 block max-h-96 w-full max-w-full rounded border border-brand-border/40 bg-brand-dark/60"
											></video>
										{/if}

										<!-- Tool image attachments (e.g. read on an image file) that
									     ALSO produced model-facing image blocks (base64). Rendered
									     OUTSIDE the collapsible section so images stay visible even
									     when the tool details are collapsed; the args/output below
									     remain collapsible. -->
										{#if msg.images && msg.images.length > 0}
											<div class="mt-2 flex flex-col gap-1">
												<div class="flex flex-wrap gap-2">
													{#each msg.images as img}
														<a
															href={`data:${img.mimeType};base64,${img.data}`}
															target="_blank"
															rel="noopener noreferrer"
															class="block"
														>
															<img
																src={`data:${img.mimeType};base64,${img.data}`}
																alt="Tool output"
																class="max-h-96 max-w-full rounded border border-brand-border/40 bg-brand-dark/60 object-contain"
															/>
														</a>
													{/each}
												</div>
											</div>
										{/if}

										<!-- Tool Output (collapsible) -->
										{#if isExpanded}
											<div
												class="mt-2 flex flex-col gap-3 overflow-hidden border-t border-brand-border/40 pt-2"
											>
												<!-- Full Arguments section -->
												{#if parsed.fullArgs && parsed.fullArgs !== '{}'}
													<div class="flex flex-col gap-1">
														<span
															class="font-sans text-[10px] font-bold tracking-wider text-brand-text-muted uppercase"
															>Arguments</span
														>
														<pre
															class="max-h-40 overflow-x-auto rounded border border-brand-border/30 bg-brand-dark/60 p-1.5 font-mono text-[11px] whitespace-pre-wrap text-amber-400">{parsed.fullArgs}</pre>
													</div>
												{/if}

												<!-- Tool Output section -->
												<div class="flex flex-col gap-1">
													<span
														class="font-sans text-[10px] font-bold tracking-wider text-brand-text-muted uppercase"
														>Output</span
													>
													{#if parsed.toolOutput}
														<pre
															class="max-h-96 overflow-x-auto rounded border border-brand-border/40 bg-brand-dark/60 p-2 font-mono text-xs whitespace-pre-wrap text-brand-text">{parsed.toolOutput}</pre>
													{:else if msg.isStreaming}
														<div
															class="animate-pulse p-1 text-xs text-brand-text-muted italic"
														>
															Running and waiting for output...
														</div>
													{:else if parsed.interrupted}
														<div
															class="p-1 text-xs text-brand-text-muted italic"
														>
															Interrupted before a result was returned (the
															running tool was stopped, e.g. by a CLI takeover).
															Its outcome is unknown.
														</div>
													{:else}
														<div
															class="p-1 text-xs text-brand-text-muted italic"
														>
															No output returned
														</div>
													{/if}
												</div>
											</div>
										{/if}
									</div>
								{/if}
							{/if}
						{:else if msg.role === 'assistant' && msg.content !== ''}
							{#if msg.isStreaming}
								<!-- While streaming, render plain text. Re-parsing markdown on
								     every token would rebuild the DOM and collapse any active
								     selection; the finalized branch renders once and stays stable.
								     `wrap-anywhere` mirrors `.markdown-body`'s overflow-wrap so an
								     unbreakable token (a long file path, a URL) wraps instead of
								     overflowing the bubble: without it the tail of such a line was
								     pushed off-screen on a narrow viewport and read as "words are
								     missing", until the message finalized and re-rendered wrapped. -->
								<pre
									class="chat-selectable font-sans text-sm leading-relaxed wrap-anywhere whitespace-pre-wrap">{msg.content}<span
										class="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-brand-cyan align-text-bottom"
									></span></pre>
							{:else}
								<!-- Conversation mode's collapseLongReplies knob: when ACTIVE
								     (which requires the master conversationMode on too), a LONG
								     written reply is DE-EMPHASISED so the short spoken summary is
								     the focus and the transcript stays glanceable. Display-only:
								     the full reply is NEVER removed/truncated -- it is clamped
								     behind a fade and stays fully expandable via "Show full reply"
								     (reusing the same expandedMessages idiom as the tool cards).
								     Expanding is the reader's escape hatch: an opened reply renders
								     in full and is never re-collapsed. With the knob inactive,
								     replies render exactly as today. -->
								{@const replyExpanded = expandedMessages[msg.id] === true}
								{@const replyCollapsed = shouldCollapseReply({
									active: collapseActive,
									expanded: replyExpanded,
									content: msg.content,
								})}
								{@const showRaw = rawMessages[msg.id] === true}
								<div class="group flex flex-col">
									{#if showRaw}
										<!-- Raw view: the verbatim markdown source, unrendered. -->
										<pre
											class="chat-selectable overflow-x-auto rounded border border-brand-border/40 bg-brand-dark/60 p-2 font-mono text-xs whitespace-pre-wrap text-brand-text {replyCollapsed
												? 'relative max-h-40 overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)] opacity-80'
												: ''}">{msg.content}</pre>
									{:else}
										<!-- eslint-disable-next-line svelte/no-at-html-tags -- output sanitized via DOMPurify in renderMarkdown -->
										<div
											class="chat-selectable markdown-body text-sm leading-relaxed {replyCollapsed
												? 'relative max-h-40 overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)] opacity-80'
												: ''}"
										>
											{@html renderAssistant(msg.id, msg.content)}
										</div>
									{/if}
									<!-- Per-message actions: copy the raw markdown, and toggle
									     between the rendered view and the raw source. Kept subtle
									     (muted, revealed on hover) so they don't clutter the
									     transcript. -->
									<div
										class="mt-1 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100"
									>
										<button
											type="button"
											onclick={() => copyMessage(msg.id, msg.content)}
											class="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium text-brand-text-muted transition-colors select-none hover:bg-brand-surface-3/30 hover:text-brand-text"
											title="Copy this message to the clipboard"
										>
											{#if copiedMessageId === msg.id}
												<svg
													xmlns="http://www.w3.org/2000/svg"
													viewBox="0 0 24 24"
													fill="none"
													stroke="currentColor"
													stroke-width="2"
													stroke-linecap="round"
													stroke-linejoin="round"
													class="text-brand-green h-3.5 w-3.5"
													><path d="M20 6 9 17l-5-5" /></svg
												>
												Copied
											{:else}
												<svg
													xmlns="http://www.w3.org/2000/svg"
													viewBox="0 0 24 24"
													fill="none"
													stroke="currentColor"
													stroke-width="2"
													stroke-linecap="round"
													stroke-linejoin="round"
													class="h-3.5 w-3.5"
													><rect
														width="14"
														height="14"
														x="8"
														y="8"
														rx="2"
														ry="2"
													/><path
														d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"
													/></svg
												>
												Copy
											{/if}
										</button>
										<button
											type="button"
											onclick={() => toggleRaw(msg.id)}
											class="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium text-brand-text-muted transition-colors select-none hover:bg-brand-surface-3/30 hover:text-brand-text"
											title={showRaw
												? 'Show the rendered markdown'
												: 'Show the raw markdown source'}
										>
											{#if showRaw}
												<svg
													xmlns="http://www.w3.org/2000/svg"
													viewBox="0 0 24 24"
													fill="none"
													stroke="currentColor"
													stroke-width="2"
													stroke-linecap="round"
													stroke-linejoin="round"
													class="h-3.5 w-3.5"
													><path
														d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"
													/><circle cx="12" cy="12" r="3" /></svg
												>
												Rendered
											{:else}
												<svg
													xmlns="http://www.w3.org/2000/svg"
													viewBox="0 0 24 24"
													fill="none"
													stroke="currentColor"
													stroke-width="2"
													stroke-linecap="round"
													stroke-linejoin="round"
													class="h-3.5 w-3.5"
													><path d="m18 16 4-4-4-4" /><path
														d="m6 8-4 4 4 4"
													/><path d="m14.5 4-5 16" /></svg
												>
												Raw
											{/if}
										</button>
									</div>
									{#if replyCollapsed}
										<button
											type="button"
											onclick={() => toggleMessage(msg.id, replyExpanded)}
											class="mt-1 flex w-fit items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium text-brand-text-muted transition-colors select-none hover:bg-brand-surface-3/30 hover:text-brand-text"
											title="Show the full written reply (collapsed while conversation mode focuses the spoken summary)"
										>
											Show full reply <span class="text-[10px]">▼</span>
										</button>
									{:else if collapseActive && replyExpanded && isLongReply(msg.content)}
										<button
											type="button"
											onclick={() => toggleMessage(msg.id, replyExpanded)}
											class="mt-1 flex w-fit items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium text-brand-text-muted transition-colors select-none hover:bg-brand-surface-3/30 hover:text-brand-text"
											title="Collapse this long reply again"
										>
											Collapse <span class="text-[10px]">▲</span>
										</button>
									{/if}
								</div>
							{/if}
						{:else}
							{@const parsedUserMsg = parseUserMessage(msg.content)}
							{#if parsedUserMsg.skill}
								<!-- A `/skill:<name> <args>` invocation. The message is stored/
								     echoed EXPANDED (the full skill body). Display the compact
								     invocation instead: a skill chip with the skill name, plus the
								     trailing args the user typed after the skill name (if any). -->
								<div class="chat-selectable flex flex-col gap-1.5">
									<span
										class="inline-flex w-fit items-center gap-1.5 rounded bg-brand-blue/25 px-2 py-0.5 font-mono text-xs font-medium text-brand-text ring-1 ring-brand-blue/40"
										title="Skill invocation (expanded for the agent)"
									>
										<svg
											xmlns="http://www.w3.org/2000/svg"
											viewBox="0 0 24 24"
											fill="none"
											stroke="currentColor"
											stroke-width="2"
											stroke-linecap="round"
											stroke-linejoin="round"
											class="h-3.5 w-3.5"
											><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" /></svg
										>
										<span>skill:{parsedUserMsg.skill.skillName}</span>
									</span>
									{#if parsedUserMsg.skill.args}
										<div
											class="text-sm leading-relaxed wrap-anywhere whitespace-pre-wrap"
										>
											{parsedUserMsg.skill.args}
										</div>
									{/if}
								</div>
							{:else}
								<!-- User + thinking bubbles are plain text too: same wrap-anywhere
								     guard so a long path/URL cannot push the rest of the line out of
								     the bubble. -->
								<div
									class="chat-selectable text-sm leading-relaxed wrap-anywhere whitespace-pre-wrap"
								>
									{#if parsedUserMsg.cleanContent}
										{@const userHtml = renderUser(parsedUserMsg.cleanContent)}
										{#if userHtml}
											<!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized via DOMPurify in linkifyText -->
											<span>{@html userHtml}</span>
										{:else}
											{parsedUserMsg.cleanContent}
										{/if}
									{:else if parsedUserMsg.attachments.length > 0}
										<span class="text-brand-text-muted italic"
											>Shared file{parsedUserMsg.attachments.length > 1
												? 's'
												: ''} with agent:</span
										>
									{:else}
										{msg.content || (msg.isStreaming ? 'Thinking...' : '')}
									{/if}
									{#if msg.isStreaming && streaming}
										<span
											class="ml-1 inline-block h-4 w-1.5 animate-pulse bg-brand-cyan"
										></span>
									{/if}
								</div>
							{/if}
							{#if parsedUserMsg.attachments.length > 0}
								<div
									class="mt-2 flex flex-col gap-1 border-t border-brand-blue/20 pt-2"
								>
									{#each parsedUserMsg.attachments as filePath}
										<div
											class="flex items-center gap-1.5 rounded bg-brand-blue/20 px-2 py-1 font-mono text-xs text-brand-text select-all"
										>
											<span>📎</span>
											<span class="truncate" title={filePath}>{filePath}</span>
										</div>
									{/each}
								</div>
							{/if}
						{/if}
						{#if msg.role !== 'thinking' && msg.role !== 'tool'}
							<div
								class="mt-1 flex items-center gap-1.5 text-xs opacity-50 {msg.role ===
								'user'
									? 'justify-end text-brand-text-muted'
									: msg.role === 'assistant'
										? 'text-brand-purple'
										: 'text-brand-text-muted'}"
							>
								{#if msg.role === 'user' && msg.delivery === 'sending'}
									<span
										class="inline-block h-3 w-3 animate-spin rounded-full border border-brand-text-muted border-t-transparent"
										title="Sending, awaiting confirmation"
										aria-label="Sending"
									></span>
									<span title="Sending, awaiting confirmation">Sending</span>
									<span>·</span>
								{/if}
								{formatTime(msg.timestamp)}
							</div>
							{#if msg.role === 'user' && msg.entryId && sessionInfo.sessionId && !readOnly && msg.delivery === undefined && !$pendingSteering.includes(msg.content)}
								<!-- Fork-from-here lives OUTSIDE the opacity-50 footer above, so it is
								     fully opaque and its hover state is clearly visible (a parent
								     opacity would otherwise cap the child's hover:opacity-100). -->
								<div class="mt-1 flex justify-end">
									<button
										type="button"
										onclick={() => handleFork(msg.entryId)}
										class="inline-flex items-center gap-1 rounded border border-brand-border/60 bg-brand-surface-3/60 px-2 py-0.5 text-xs font-medium text-brand-text-muted transition-colors hover:border-brand-blue hover:bg-brand-blue/15 hover:text-brand-blue"
										title="Fork the conversation from this message (edit and resend)"
										aria-label="Fork from this message"
									>
										<svg
											xmlns="http://www.w3.org/2000/svg"
											viewBox="0 0 24 24"
											fill="none"
											stroke="currentColor"
											stroke-width="2"
											stroke-linecap="round"
											stroke-linejoin="round"
											class="h-3.5 w-3.5"
											><circle cx="6" cy="6" r="2.2" /><circle
												cx="6"
												cy="18"
												r="2.2"
											/><circle cx="18" cy="8" r="2.2" /><path
												d="M6 8.2v7.6"
											/><path d="M18 10.2c0 3-3 3.8-6 3.8" /></svg
										>
										Fork
									</button>
								</div>
							{/if}
							{#if msg.role === 'user' && $pendingSteering.includes(msg.content)}
								<!-- This user message is a mid-stream steer that is still QUEUED on
								     the server (pi injects it at the next step boundary). Show a
								     passive per-message badge so the user can SEE which messages are
								     still pending. The cancel ACTION lives at the session level (next
								     to Abort), because pi's clearQueue() drops the WHOLE steer queue
								     at once -- a per-message Cancel would misleadingly imply it only
								     cancels this one. Only server-type sessions report a steer queue,
								     so this never appears for CLI-bridge sessions. -->
								<div
									class="mt-1.5 flex items-center justify-end gap-1 text-xs font-medium text-brand-text-muted"
								>
									<span
										class="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400"
									></span>
									Queued (not yet sent to the agent)
								</div>
							{/if}
							{#if msg.role === 'user' && msg.delivery === 'failed'}
								<!-- Delivery could NOT be confirmed (a half-open socket may have
								     swallowed the frame). Never silently drop it: offer retry /
								     discard so the user's text is recoverable. -->
								<div
									class="mt-1.5 flex flex-wrap items-center justify-end gap-2 text-xs"
								>
									<span class="font-medium text-amber-400"
										>⚠️ Not delivered</span
									>
									<button
										type="button"
										onclick={() => resendMessage(msg.id)}
										class="rounded bg-brand-blue/80 px-2 py-0.5 font-medium text-brand-text transition-colors hover:bg-brand-blue"
									>
										Retry
									</button>
									<button
										type="button"
										onclick={() => discardMessage(msg.id)}
										class="rounded bg-brand-surface-3 px-2 py-0.5 font-medium text-brand-text-muted transition-colors hover:text-brand-text"
									>
										Discard
									</button>
								</div>
							{/if}
						{/if}
					</div>
				</div>
			{/each}
		</div>
	{/if}

	<div
		class="app-chrome flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-brand-border p-2"
	>
		<div class="flex flex-wrap items-center gap-x-4 gap-y-2">
			<label
				class="flex cursor-pointer items-center gap-1.5 text-xs text-brand-text-muted select-none hover:text-brand-text"
			>
				<input
					type="checkbox"
					checked={$piState.hideThinking}
					onchange={(e) =>
						updateConfig({
							hideThinking: (e.currentTarget as HTMLInputElement).checked,
						})}
					class="h-3.5 w-3.5 rounded border-brand-border bg-brand-surface-3 text-brand-blue focus:ring-brand-blue"
				/>
				Hide Thinking
			</label>

			<!-- Per-session waiting-for-human beep, tri-state. Cycles
			     Default -> On -> Off -> Default. "Default" means this session has no
			     explicit choice and follows the global default live; On/Off stick to
			     this session regardless of later default changes. Only for a live,
			     drivable session. -->
			{#if sessionInfo.sessionFile && !$isReadOnly}
				<button
					type="button"
					onclick={cycleBeep}
					class="flex items-center gap-1.5 rounded px-1.5 py-0.5 text-xs select-none hover:text-brand-text {beepOverride ===
					undefined
						? 'text-brand-text-muted'
						: 'text-brand-blue'}"
					title={beepOverride === undefined
						? `Beep when the agent is waiting: following the default (${beepOn ? 'on' : 'off'}). Click to set On for this session.`
						: beepOverride === true
							? 'Beep when the agent is waiting: ON for this session. Click to set Off.'
							: 'Beep when the agent is waiting: OFF for this session. Click to follow the default.'}
					aria-label="Cycle waiting-for-human beep for this session"
				>
					<span>{beepOn ? '🔔' : '🔕'}</span>
					<span>
						{beepOverride === undefined
							? `Beep: Default (${beepOn ? 'on' : 'off'})`
							: beepOverride
								? 'Beep: On'
								: 'Beep: Off'}
					</span>
				</button>
			{/if}

			<!-- Conversation Mode master toggle: flips the configured knob bundle on
			     at once (speak replies, collapse long replies, hands-free mic re-open)
			     FOR THIS CONVERSATION ONLY -- other conversations keep their own state,
			     and untouched ones follow the default. With no conversation open there is
			     nothing to scope to, so it edits that default instead. Individual knobs
			     (and the default) are edited in Connection Settings. -->
			<button
				type="button"
				onclick={toggleConversationMode}
				class="flex items-center gap-1.5 rounded px-1.5 py-0.5 text-xs select-none hover:text-brand-text {conversationOn
					? 'text-brand-blue'
					: 'text-brand-text-muted'}"
				title={`Conversation Mode for THIS conversation: ${
					conversationOn ? 'ON' : 'OFF'
				}${
					conversationFollowsDefault
						? ' (following your default)'
						: ' (set for this conversation)'
				}. ${
					conversationOn
						? 'Click to turn it off here (the configured knobs go dormant); other conversations are unaffected.'
						: 'Click to flip your configured bundle of speech/voice knobs on here; other conversations are unaffected.'
				} The default for conversations you have not toggled is in Connection Settings.`}
				aria-label="Toggle conversation mode"
			>
				<span>{conversationOn ? '🗣️' : '💬'}</span>
				<span>{conversationOn ? 'Conversation: On' : 'Conversation: Off'}</span>
			</button>

			<!-- Context-window usage, e.g. "11.3% / 1.0M" -->
			{#if contextLabel}
				<div
					class="flex items-center gap-1 text-xs text-brand-text-muted"
					title={$piState.contextUsage?.tokens != null
						? `${$piState.contextUsage.tokens.toLocaleString()} context tokens of ${$piState.contextUsage.contextWindow.toLocaleString()}`
						: 'Context window size'}
				>
					<span class="flex-shrink-0">🧠</span>
					<span class="whitespace-nowrap tabular-nums">{contextLabel}</span>
				</div>
			{/if}
		</div>
		<div class="flex items-center gap-2">
			<!-- Cancel ALL queued steers without aborting the running turn. pi's
			     clearQueue() is all-or-nothing, so this is a single session-level
			     action (not per-message). Shown only when something is queued. -->
			{#if $pendingSteering.length > 0}
				<button
					onclick={cancelSteer}
					class="rounded border border-amber-400/50 bg-brand-surface-3 px-3 py-1.5 text-xs text-brand-text-muted transition-colors hover:bg-rose-500/80 hover:text-brand-text"
					title="Cancel the queued steer message{$pendingSteering.length > 1
						? 's'
						: ''} (does not abort the current turn)"
				>
					Cancel queued{$pendingSteering.length > 1
						? ` (${$pendingSteering.length})`
						: ''}
				</button>
			{/if}
			<button
				onclick={abort}
				disabled={!streaming}
				class="rounded bg-rose-500 px-3 py-1.5 text-xs text-brand-text transition-colors hover:bg-rose-600 disabled:cursor-not-allowed disabled:opacity-50"
				title="Abort"
			>
				Abort
			</button>
		</div>
	</div>

	<!-- Custom Confirm Modal for Existing Folders -->
	{#if showGitInitConfirmModal}
		<div
			class="fixed inset-0 z-50 flex items-center justify-center bg-brand-dark/65 p-4"
			role="dialog"
			aria-modal="true"
		>
			<div
				class="w-full max-w-sm rounded-lg border border-brand-border bg-brand-surface-2 p-6 text-brand-text"
			>
				<h3 class="mb-2 text-base font-bold text-brand-text">
					Folder Already Exists
				</h3>
				<p class="mb-4 text-sm text-brand-text-muted">
					The folder <span class="font-mono text-xs text-brand-text"
						>{newFolderCwd}</span
					> already exists. Do you want to initialize a Git repository in it?
				</p>

				<div class="mb-6 flex flex-col gap-3.5">
					<div class="flex items-center gap-2">
						<input
							id="modal-git-init"
							type="checkbox"
							bind:checked={newFolderGitInit}
							disabled={pathStatus.isGit}
							class="h-4 w-4 rounded border-brand-border bg-brand-surface-3 text-brand-blue focus:ring-brand-blue disabled:opacity-50"
						/>
						<label
							for="modal-git-init"
							class="cursor-pointer text-sm text-brand-text select-none disabled:opacity-50"
						>
							Initialize Git repository
							{#if pathStatus.isGit}
								<span class="ml-1 text-xs text-brand-text-muted"
									>(already a Git repository)</span
								>
							{:else}
								<span class="ml-1 text-xs font-medium text-yellow-500"
									>(folder not empty)</span
								>
							{/if}
						</label>
					</div>

					{#if pathStatus.matchingRule}
						<div class="space-y-1.5">
							<div class="flex items-center gap-2">
								<input
									id="modal-create-remote"
									type="checkbox"
									bind:checked={createRemoteRepo}
									class="h-4 w-4 rounded border-brand-border bg-brand-surface-3 text-brand-blue focus:ring-brand-blue"
								/>
								<label
									for="modal-create-remote"
									class="cursor-pointer text-sm text-brand-text select-none"
								>
									Create remote {pathStatus.matchingRule.provider} repository
								</label>
							</div>

							{#if createRemoteRepo}
								<div
									class="flex items-center gap-4 pl-6 text-xs text-brand-text-muted"
								>
									<span>Visibility:</span>
									<label
										class="flex cursor-pointer items-center gap-1.5 transition-colors select-none hover:text-brand-text"
									>
										<input
											type="radio"
											name="modal-visibility"
											value="private"
											bind:group={repoVisibility}
											class="border-brand-border bg-brand-surface-3 text-brand-blue focus:ring-brand-blue"
										/>
										Private
									</label>
									<label
										class="flex cursor-pointer items-center gap-1.5 transition-colors select-none hover:text-brand-text"
									>
										<input
											type="radio"
											name="modal-visibility"
											value="public"
											bind:group={repoVisibility}
											class="border-brand-border bg-brand-surface-3 text-brand-blue focus:ring-brand-blue"
										/>
										Public
									</label>
								</div>
							{/if}
						</div>
					{/if}
				</div>

				<div class="flex justify-end gap-2.5">
					<button
						type="button"
						onclick={() => (showGitInitConfirmModal = false)}
						class="rounded bg-brand-surface-3 px-3.5 py-1.5 text-xs font-semibold text-brand-text transition-colors hover:bg-brand-surface-2"
					>
						Cancel
					</button>
					<button
						type="button"
						onclick={() => {
							showGitInitConfirmModal = false;
							createSession(
								newFolderCwd.trim(),
								newFolderModel || undefined,
								newFolderGitInit,
								pathStatus.matchingRule ? createRemoteRepo : undefined,
								pathStatus.matchingRule ? repoVisibility : undefined,
							);
						}}
						class="rounded bg-gradient-to-r from-brand-cyan to-brand-blue px-3.5 py-1.5 text-xs font-semibold text-brand-text transition-all hover:opacity-90"
					>
						Confirm & Create
					</button>
				</div>
			</div>
		</div>
	{/if}

	<!-- Clone Existing Remote Repository -->
	{#if showCloneConfirmModal}
		<div
			class="fixed inset-0 z-50 flex items-center justify-center bg-brand-dark/65 p-4"
			role="dialog"
			aria-modal="true"
		>
			<div
				class="w-full max-w-sm rounded-lg border border-brand-border bg-brand-surface-2 p-6 text-brand-text"
			>
				<h3 class="mb-2 text-base font-bold text-brand-text">
					Remote Repository Already Exists
				</h3>
				<p class="mb-3 text-sm text-brand-text-muted">
					A {cloneRemoteInfo?.provider ?? 'remote'} repository matching
					<span class="font-mono text-xs text-brand-text">{newFolderCwd}</span>
					already exists. Do you want to clone it instead of creating a new one?
				</p>
				{#if cloneRemoteInfo?.sshUrl}
					<p
						class="mb-4 rounded bg-brand-surface-3 px-2.5 py-1.5 font-mono text-xs break-all text-brand-text-muted"
					>
						{cloneRemoteInfo.sshUrl}
					</p>
				{/if}

				<div class="flex justify-end gap-2.5">
					<button
						type="button"
						onclick={() => {
							showCloneConfirmModal = false;
							cloneRemoteInfo = null;
							submitCreateSession(false);
						}}
						class="rounded bg-brand-surface-3 px-3.5 py-1.5 text-xs font-semibold text-brand-text transition-colors hover:bg-brand-surface-2"
					>
						Create New Instead
					</button>
					<button
						type="button"
						onclick={() => {
							showCloneConfirmModal = false;
							cloneRemoteInfo = null;
							submitCreateSession(true);
						}}
						class="rounded bg-gradient-to-r from-brand-cyan to-brand-blue px-3.5 py-1.5 text-xs font-semibold text-brand-text transition-all hover:opacity-90"
					>
						Clone Repository
					</button>
				</div>
			</div>
		</div>
	{/if}
</div>
