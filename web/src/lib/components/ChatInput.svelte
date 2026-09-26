<script lang="ts">
	import {onDestroy, onMount, untrack} from 'svelte';
	import {
		sendMessage,
		piState,
		isConnected,
		createSession,
		clearMessages,
		leaveSession,
		uploadFile,
		beginFilePicker,
		endFilePicker,
		composerPrefill,
		reloadResources,
	} from '$lib/wherever';
	import {isStreaming, isReadOnly, activeSessionInfo} from '$lib/wherever';
	import {getConversationKnobs} from '$lib/wherever';
	import {getBaseUrl, getToken} from '$lib/session-store';
	import {decideComposeSend} from '$lib/core/compose-send';
	import {buildAttachmentMessage} from '$lib/core/attachments';
	import {isKnobActive} from '$lib/core/conversation-mode';
	import {decideMicReopen} from '$lib/core/hands-free';
	import {whenTtsIdle} from '$lib/core/speak';
	import {
		DRAFTS_CACHE_KEY,
		LEGACY_DRAFTS_KEY,
		applyDraft,
		decideDraftLoad,
		draftOriginLabel,
		draftPreview,
		draftToConsumeOnSend,
		parseDrafts,
		serializeDrafts,
		type Draft,
		type DraftLoadMode,
	} from '$lib/core/drafts';
	import {fetchDrafts, saveDraftRemote, deleteDraftRemote} from '$lib/wherever';
	import SpeechButton from './speech/SpeechButton.svelte';

	let {
		disabled,
		onSend,
		onSubmit,
		placeholder,
		submitLabel,
		showAttach = true,
		searchMode = false,
		searchConfigured = false,
		searchModels = [],
		searchModel = $bindable(''),
	}: {
		disabled: boolean;
		onSend?: () => void;
		// When provided (search mode), submit routes here instead of sendMessage.
		// Files are handed over UNUPLOADED: search has no session yet, so the
		// search flow uploads them once it has created one.
		onSubmit?: (text: string, files?: File[]) => void;
		placeholder?: string;
		submitLabel?: string;
		showAttach?: boolean;
		searchMode?: boolean;
		// Whether a search folder is configured (gates enablement in search mode).
		searchConfigured?: boolean;
		// Model list + bound selection for the search-mode model picker. Values are
		// "provider:modelId"; empty label list hides the picker.
		searchModels?: {value: string; label: string}[];
		searchModel?: string;
	} = $props();

	let text = $state('');
	let enterToSend = $state(true);
	let isCollapsed = $state(false);

	// Hands-free mic-reopen loop (`micReopensAfterReply` knob). The SpeechButton
	// child owns the engine + the programmatic recording start; ChatInput owns the
	// composer focus and already subscribes to the isStreaming settle edge, so the
	// settle-edge driver lives here. These bindings surface the child's engine and
	// its instance (for startRecordingProgrammatically) to the driver below.
	let speechEngine = $state<'browser' | 'cloud'>('browser');
	let speechButton = $state<{startRecordingProgrammatically: () => void}>();

	// --- Slash-command (skill) autocomplete ---------------------------------
	// Mirrors the pi CLI: when the message STARTS with a `/` token (no space yet),
	// offer the session's `/skill:<name>` commands. Selecting one only INSERTS
	// `/skill:<name> ` (trailing space) so the user can keep typing an argument;
	// it never submits. Expansion happens server-side at send time. `/skill:` is
	// start-anchored, so a `/` mid-message is ignored, exactly like the CLI.
	let skillMenuOpen = $state(false);
	let skillMenuIndex = $state(0);

	let fileInput = $state<HTMLInputElement>();
	// An attachment is either already uploaded (`path` set, chat mode) or still a
	// local File waiting for a session to upload it to (`file` set, search mode).
	let attachments = $state<
		{
			name: string;
			path?: string;
			error?: string;
			uploading: boolean;
			file?: File;
		}[]
	>([]);

	let streaming = $derived($isStreaming);
	let readOnly = $derived($isReadOnly);
	let sessionInfo = $derived($activeSessionInfo);
	let connected = $derived($isConnected);
	let appState = $derived($piState);

	// The `/` token currently being typed at the START of the message, or null
	// when the message doesn't begin a slash command (no leading `/`, or a space
	// has already been typed so the command name is committed). Only the leading
	// token triggers the menu, matching the CLI's start-of-line anchoring.
	let slashPrefix = $derived.by(() => {
		if (searchMode) return null;
		const m = text.match(/^\/([^\s]*)$/);
		return m ? m[1] : null;
	});

	// Skill commands the composer can offer, fuzzily filtered by the typed token.
	// `s.name` is the full invocation without the slash (e.g. "skill:setup"), so
	// typing "/setu" surfaces "skill:setup" via substring match on the name.
	let skillMatches = $derived.by(() => {
		if (slashPrefix === null) return [];
		const all = appState.skills ?? [];
		if (all.length === 0) return [];
		const q = slashPrefix.toLowerCase();
		const matches = q
			? all.filter((s) => s.name.toLowerCase().includes(q))
			: all.slice();
		// Rank exact-prefix hits ("skill:setup" for "skill:set") above loose
		// substring hits so the most likely completion is highlighted first.
		return matches.sort((a, b) => {
			const ap = a.name.toLowerCase().startsWith(q) ? 0 : 1;
			const bp = b.name.toLowerCase().startsWith(q) ? 0 : 1;
			return ap - bp || a.name.localeCompare(b.name);
		});
	});

	// Open the menu whenever there are matches for the current slash token, and
	// keep the highlighted index in range as the list shrinks/grows. Closes when
	// the token is committed (space typed) or there are no matches.
	$effect(() => {
		const count = skillMatches.length;
		if (count === 0) {
			if (untrack(() => skillMenuOpen)) skillMenuOpen = false;
			return;
		}
		if (!untrack(() => skillMenuOpen)) skillMenuOpen = true;
		if (untrack(() => skillMenuIndex) >= count) skillMenuIndex = 0;
	});

	// Insert `/skill:<name> ` (trailing space), keeping focus and placing the
	// cursor after the space so the user can immediately type an argument. Never
	// submits: this only rewrites the composer, exactly like the pi CLI.
	function applySkill(name: string) {
		text = `/${name} `;
		skillMenuOpen = false;
		skillMenuIndex = 0;
		queueMicrotask(() => {
			if (!textarea) return;
			textarea.focus();
			const end = text.length;
			textarea.setSelectionRange(end, end);
		});
	}

	// In search mode the composer must work with no active session: it requires
	// only a live connection and a configured search folder. In chat mode it
	// stays gated on an active session as before.
	// Note: streaming does NOT disable the composer. A mid-stream submit steers
	// the agent immediately (pi's default), so the box stays live while the agent
	// works and the primary button reads "Steer".
	let effectivelyDisabled = $derived(
		searchMode
			? disabled || !connected || !searchConfigured
			: disabled || !connected || readOnly || !sessionInfo.sessionId,
	);

	let isAnyUploading = $derived(attachments.some((a) => a.uploading));
	let canSend = $derived(
		!effectivelyDisabled &&
			!isAnyUploading &&
			(text.trim().length > 0 || attachments.length > 0),
	);

	let textarea = $state<HTMLTextAreaElement>();

	// Persist the in-progress draft so it is never lost when this composer is
	// unmounted out from under the user (e.g. the parent swaps it for the
	// "Reconnecting and syncing session..." status line during a resync, or on a
	// transient disconnect). The draft is keyed per session so switching sessions
	// does not bleed text between them; search mode (no session) uses a shared
	// 'search' key. Cleared on a successful send.
	// A draft belongs to the active session when one is open, otherwise to the
	// (no-session) search composer. Keying on sessionId-or-search this way means:
	// a session keeps its own draft, and the search query is preserved under one
	// shared key so switching into a session and back to search (by closing the
	// session or hitting the search button) restores what was typed. This holds
	// whether or not a search folder is configured (no session == search mode).
	const DRAFT_PREFIX = 'wherever-draft:';
	let draftKey = $derived(DRAFT_PREFIX + (sessionInfo.sessionId ?? 'search'));
	// Tracks which key we have already hydrated so the restore effect fires only
	// when the key actually changes (mount, session switch, search<->chat), not on
	// every keystroke. The persist effect below removes the key whenever the
	// textarea goes empty, so a successful send (which clears `text`) also clears
	// the saved draft.
	let hydratedKey = $state<string | null>(null);

	onMount(() => {
		const stored = localStorage.getItem('wherever-enter-to-send');
		if (stored !== null) {
			enterToSend = stored === 'true';
		}
		drafts = readCachedDrafts();
	});

	// --- Saved drafts (save instead of send) --------------------------------
	// A draft is an EXPLICIT, durable message the user chose to keep rather than
	// send, distinct from the per-session auto-draft above (invisible crash
	// protection for the one text in the box).
	//
	// The STORE IS THE SERVER (`/drafts` -> <config dir>/drafts.json): a draft
	// saved on a phone has to be there on the laptop, and must survive the browser
	// losing its storage. The server is the only writer and answers every mutation
	// with the whole list, which is adopted verbatim; localStorage holds a MIRROR
	// used only to render the panel while disconnected. Drafts are global, not per
	// session (a prompt written in one repo is often what you want to send in
	// another), so the origin session/cwd is display metadata only.
	let drafts = $state<Draft[]>([]);
	let draftsOpen = $state(false);
	// A draft the user asked to load while the box already held unsent text. It is
	// held here (not loaded) until they pick Replace / Append / Cancel, so loading
	// a draft can never silently destroy what they were typing.
	let pendingDraft = $state<Draft | null>(null);
	// The draft currently sitting in the composer. Loading does NOT delete a draft
	// (one mistap would destroy it with no undo); SENDING it does, via
	// draftToConsumeOnSend. Cleared whenever the link cannot hold any more.
	let draftSource = $state<{id: string; text: string} | null>(null);
	let draftSavedFlash = $state(false);
	let draftError = $state<string | null>(null);
	let draftsLoading = $state(false);
	// Monotonic stamp for drafts responses. Several requests (an open-panel
	// refresh, a save, a delete) can be in flight at once and they do NOT complete
	// in order: without this, a slow GET landing after a fast DELETE would
	// resurrect the deleted draft in the list AND in the offline mirror.
	let draftsRequestSeq = 0;
	let draftsAdoptedSeq = 0;
	let draftFlashTimer: ReturnType<typeof setTimeout> | undefined;

	function readCachedDrafts(): Draft[] {
		if (typeof localStorage === 'undefined') return [];
		try {
			return parseDrafts(localStorage.getItem(DRAFTS_CACHE_KEY));
		} catch {
			return [];
		}
	}

	// Adopt a server list and mirror it locally, unless a NEWER response has already
	// been adopted (see draftsRequestSeq). A failed mirror write is NOT an error the
	// user needs to see: the drafts are safe on the server, the cache is only an
	// offline convenience.
	function adoptDrafts(next: Draft[], seq: number) {
		if (seq < draftsAdoptedSeq) return;
		draftsAdoptedSeq = seq;
		drafts = next;
		if (typeof localStorage === 'undefined') return;
		try {
			localStorage.setItem(DRAFTS_CACHE_KEY, serializeDrafts(next));
		} catch {}
	}

	// One-shot migration from the first, browser-only version of this feature, so
	// a draft written against a pre-server build is not orphaned. The legacy key is
	// removed once its contents are on the server; the cache key is a different key
	// precisely so a mirrored list can never be re-uploaded after a delete.
	async function migrateLegacyDrafts(): Promise<boolean> {
		if (typeof localStorage === 'undefined') return false;
		let legacy: Draft[] = [];
		try {
			legacy = parseDrafts(localStorage.getItem(LEGACY_DRAFTS_KEY));
		} catch {}
		if (legacy.length === 0) {
			try {
				localStorage.removeItem(LEGACY_DRAFTS_KEY);
			} catch {}
			return false;
		}
		try {
			// Oldest first, so the server's newest-first order comes out right.
			for (const d of [...legacy].reverse()) {
				await saveDraftRemote({
					text: d.text,
					sessionId: d.sessionId,
					cwd: d.cwd,
				});
			}
			localStorage.removeItem(LEGACY_DRAFTS_KEY);
			return true;
		} catch {
			// Leave the legacy key in place and try again on the next connection.
			return false;
		}
	}

	async function refreshDrafts() {
		if (!connected) return;
		const seq = ++draftsRequestSeq;
		draftsLoading = true;
		try {
			await migrateLegacyDrafts();
			adoptDrafts(await fetchDrafts(), seq);
			draftError = null;
		} catch (err) {
			// Keep whatever list is on screen (possibly the offline mirror): an
			// unreadable store must never be flattened into "you have no drafts".
			draftError = (err as Error)?.message || 'Could not load drafts';
		} finally {
			draftsLoading = false;
		}
	}

	// Pull the server list once the socket is up (and again after a reconnect), so
	// a draft saved from another device is already there when the panel is opened.
	let draftsFetchedWhileConnected = false;
	$effect(() => {
		if (!connected) {
			draftsFetchedWhileConnected = false;
			return;
		}
		if (draftsFetchedWhileConnected) return;
		draftsFetchedWhileConnected = true;
		void refreshDrafts();
	});

	// Save what is in the box and CLEAR it, exactly like a send would: "save
	// instead of sending" means the composer is done with that message. The text is
	// only cleared once the SERVER has it -- a failed save leaves the message in the
	// box with the error, never silently swallowed. Attachments are deliberately
	// left alone: an uploaded file lives on the server under a path and a draft is
	// text only, so dropping the chips would lose them for a message the user still
	// intends to send.
	async function saveCurrentAsDraft() {
		const trimmed = text.trim();
		if (trimmed.length === 0) return;
		// Snapshot what is being saved AND which composer it belongs to. The box is
		// cleared only if BOTH still hold when the server answers: over a slow link
		// the user can keep typing (clearing would delete everything typed since) or
		// switch session (clearing would wipe THAT session's draft instead, from the
		// box and from its auto-draft entry). Never clear text we did not save.
		const keyAtRequest = draftKey;
		const seq = ++draftsRequestSeq;
		try {
			const next = await saveDraftRemote({
				text: trimmed,
				sessionId: sessionInfo.sessionId ?? undefined,
				cwd: sessionInfo.cwd ?? undefined,
			});
			adoptDrafts(next, seq);
			draftError = null;
			if (draftKey === keyAtRequest && text.trim() === trimmed) {
				text = '';
				draftSource = null;
			}
			draftSavedFlash = true;
			clearTimeout(draftFlashTimer);
			draftFlashTimer = setTimeout(() => (draftSavedFlash = false), 1800);
		} catch (err) {
			draftError = (err as Error)?.message || 'Could not save the draft';
			draftsOpen = true;
		}
	}

	function requestLoadDraft(draft: Draft) {
		if (decideDraftLoad(text) === 'confirm') {
			pendingDraft = draft;
			return;
		}
		loadDraft(draft, 'replace');
	}

	function loadDraft(draft: Draft, mode: DraftLoadMode) {
		// Make sure the current key counts as hydrated so the auto-draft effect
		// persists the loaded text instead of skipping it (same reason the fork
		// prefill does this).
		hydratedKey = draftKey;
		text = applyDraft(text, draft.text, mode);
		draftSource = {id: draft.id, text: draft.text};
		pendingDraft = null;
		draftsOpen = false;
		if (isCollapsed) isCollapsed = false;
		queueMicrotask(() => {
			if (!textarea) return;
			textarea.focus();
			const end = text.length;
			textarea.setSelectionRange(end, end);
		});
	}

	// Called after a message actually went out: a draft that has been SENT is not a
	// draft any more. Best-effort -- the message is already delivered, so a failed
	// delete must not look like a failed send; the stale draft simply survives.
	function consumeDraftOnSend(sentText: string) {
		const id = draftToConsumeOnSend(draftSource, sentText);
		draftSource = null;
		if (!id) return;
		const seq = ++draftsRequestSeq;
		void deleteDraftRemote(id)
			.then((next) => adoptDrafts(next, seq))
			.catch(() => {});
	}

	async function deleteDraft(id: string) {
		const seq = ++draftsRequestSeq;
		try {
			adoptDrafts(await deleteDraftRemote(id), seq);
			draftError = null;
		} catch (err) {
			draftError = (err as Error)?.message || 'Could not delete the draft';
		}
		if (pendingDraft?.id === id) pendingDraft = null;
		if (draftSource?.id === id) draftSource = null;
	}

	function toggleDrafts() {
		if (!draftsOpen) void refreshDrafts();
		draftsOpen = !draftsOpen;
		pendingDraft = null;
	}

	function closeDrafts() {
		draftsOpen = false;
		pendingDraft = null;
	}

	onDestroy(() => clearTimeout(draftFlashTimer));

	// Swap the textarea to the active draft key's saved draft whenever the key
	// changes (initial mount, session switch, search<->chat). This is an
	// unconditional swap: the previous session's draft must NOT linger in the box
	// after switching, but going back to a session restores its own saved draft.
	// The hydratedKey guard makes this fire ONLY on a real key change (not on
	// every keystroke), so it never clobbers text the user is actively typing
	// within the current session. The text read is untracked accordingly.
	$effect(() => {
		const key = draftKey;
		if (key === hydratedKey) return;
		untrack(() => {
			let saved: string | null = null;
			if (typeof localStorage !== 'undefined') {
				try {
					saved = localStorage.getItem(key);
				} catch {}
			}
			text = saved ?? '';
			hydratedKey = key;
			// The box now holds a different session's text, so it is no longer the
			// draft that was loaded: sending it must not delete that draft.
			draftSource = null;
		});
	});

	// Fork prefill: when the fork-at-user-message flow sets composerPrefill (a
	// bumped {text, bump}), drop that text into the box for the user to edit and
	// send, mirroring pi's `/fork`. Keyed on `bump` so re-applying the same text
	// works; guarded so bump:0 (the initial empty value) is ignored. Runs after a
	// session switch, so it deliberately wins over the (empty) hydrated draft.
	let appliedPrefillBump = $state(0);
	$effect(() => {
		const {text: prefillText, bump} = $composerPrefill;
		if (bump === 0 || bump === appliedPrefillBump) return;
		appliedPrefillBump = bump;
		untrack(() => {
			// Ensure the current key is treated as hydrated so the persist effect
			// saves this prefilled draft rather than being skipped/overwritten.
			hydratedKey = draftKey;
			text = prefillText;
			if (isCollapsed) isCollapsed = false;
			queueMicrotask(() => textarea?.focus());
		});
	});

	// Persist the draft on every text change. Removing the key when empty keeps
	// storage clean (and means a successful send, which clears text, clears it).
	// Only persists once the current key has been hydrated, so the restore above
	// is never overwritten by a stale empty value mid-switch.
	$effect(() => {
		const value = text;
		const key = draftKey;
		if (key !== hydratedKey || typeof localStorage === 'undefined') return;
		try {
			if (value.trim().length > 0) {
				localStorage.setItem(key, value);
			} else {
				localStorage.removeItem(key);
			}
		} catch {}
	});

	// Files picked in search mode are held locally until the search creates its
	// session. If the composer leaves search mode first (the user opens a session
	// instead of searching), those files have no destination, so drop them rather
	// than let a stale chip ride along into a chat message.
	$effect(() => {
		if (searchMode) return;
		untrack(() => {
			if (attachments.some((a) => a.file)) {
				attachments = attachments.filter((a) => !a.file);
			}
		});
	});

	// Exposed so a parent can focus the textarea SYNCHRONOUSLY inside a user
	// gesture (required to raise the mobile virtual keyboard, esp. iOS Safari).
	export function focusInput() {
		if (isCollapsed) isCollapsed = false;
		textarea?.focus();
	}

	// --- Hands-free mic-reopen driver --------------------------------------
	// Mirror the waiting-for-human beep: watch the streaming flag and act on the
	// isStreaming true->false edge (the moment the agent settles and is waiting for
	// the human). When the `micReopensAfterReply` knob is active we wait for any
	// in-flight `say` TTS to finish (whenTtsIdle) so the spoken reply is not
	// captured as mic input, then re-open the mic. BOTH engines auto-record: the
	// user's consent lives in the config knob they turned on, not in a
	// per-conversation gesture, and the cloud engine's missing stop condition is
	// solved by its auto-stop detector rather than by refusing to start (see
	// core/hands-free.ts). When the knob is inactive (conversation mode off for this
	// conversation, or the knob off) nothing happens.
	let prevStreamingForReopen = false;
	$effect(() => {
		const nowStreaming = $isStreaming;
		const settled = prevStreamingForReopen && !nowStreaming;
		prevStreamingForReopen = nowStreaming;
		if (!settled) return;
		// Snapshot the decision at the settle edge (engine + knob state now). The
		// TTS wait is async, so guard against acting after the composer is torn down.
		const action = decideMicReopen({
			active: isKnobActive('micReopensAfterReply', getConversationKnobs()),
			engine: speechEngine,
		});
		if (action === 'none') return;
		if (effectivelyDisabled) return;
		void whenTtsIdle().then(() => {
			// Re-check: the user may have started streaming again, or the composer may
			// have been disabled, while TTS was finishing.
			if ($isStreaming || effectivelyDisabled) return;
			speechButton?.startRecordingProgrammatically();
		});
	});

	function toggleEnterToSend() {
		enterToSend = !enterToSend;
		localStorage.setItem('wherever-enter-to-send', String(enterToSend));
	}

	$effect(() => {
		if (textarea) {
			// Trigger reactive updates when text changes
			text;
			textarea.style.height = 'auto';
			textarea.style.height = `${textarea.scrollHeight}px`;
		}
	});

	// Automatically focus/refocus the textarea whenever it becomes active/enabled
	$effect(() => {
		if (!effectivelyDisabled && textarea) {
			textarea.focus();
		}
	});

	async function handleFileChange(e: Event) {
		// The native picker is closed now that we have a change event; allow the
		// background suspend timer to resume its normal behaviour.
		endFilePicker();
		const target = e.target as HTMLInputElement;
		if (!target.files) return;
		const files = Array.from(target.files);
		target.value = '';

		// Search mode has no session to upload into yet (the session is created by
		// the search itself), so just hold the files; runSearch uploads them once
		// the session exists.
		if (searchMode) {
			attachments = [
				...attachments,
				...files.map((f) => ({name: f.name, uploading: false, file: f})),
			];
			return;
		}

		const startIdx = attachments.length;
		attachments = [
			...attachments,
			...files.map((f) => ({name: f.name, uploading: true})),
		];

		for (let i = 0; i < files.length; i++) {
			const file = files[i];
			const idx = startIdx + i;
			try {
				if (!sessionInfo.sessionId) {
					throw new Error('No active session');
				}
				const res = await uploadFile(sessionInfo.sessionId, file);
				attachments = attachments.map((a, currentIdx) =>
					currentIdx === idx
						? {name: file.name, path: res.savedPath, uploading: false}
						: a,
				);
			} catch (err) {
				const errMsg = (err as Error).message || 'Failed to upload';
				console.error('File upload error details:', err);

				// Build a diagnostics target URL (/health)
				let targetUrl = '';
				try {
					const baseUrl = getBaseUrl();
					const token = getToken();
					targetUrl = `${baseUrl}/health${token ? `?token=${encodeURIComponent(token)}` : ''}`;
				} catch (e) {}

				attachments = attachments.map((a, currentIdx) =>
					currentIdx === idx
						? ({
								name: file.name,
								error: errMsg,
								url: targetUrl,
								uploading: false,
							} as any)
						: a,
				);
			}
		}
	}

	function removeAttachment(index: number) {
		attachments = attachments.filter((_, idx) => idx !== index);
	}

	function handleSend() {
		const trimmed = text.trim();

		// Search mode: route to the injected handler with the (not yet uploaded)
		// files, skipping slash commands and the streaming/queue machinery entirely.
		// Files alone are a valid search: the query can be "what is this?" implied.
		if (searchMode) {
			const files = attachments
				.map((a) => a.file)
				.filter((f): f is File => !!f);
			if ((!trimmed && files.length === 0) || effectivelyDisabled) return;
			onSubmit?.(trimmed, files);
			consumeDraftOnSend(trimmed);
			text = '';
			attachments = [];
			onSend?.();
			return;
		}

		if (!trimmed && attachments.length === 0) return;

		const uploadedPaths = attachments
			.map((a) => a.path)
			.filter((p): p is string => !!p);
		const messageToSend = buildAttachmentMessage(trimmed, uploadedPaths);

		// Handle local slash commands to match terminal behavior
		if (trimmed.startsWith('/') && attachments.length === 0) {
			const lower = trimmed.toLowerCase();
			// Each of these CLEARS the box without sending, so the loaded draft is no
			// longer in the composer: drop the link, or a later unrelated send could
			// be credited to (and delete) that draft.
			if (lower === '/new' || lower === '/reset') {
				if (sessionInfo.cwd) {
					createSession(sessionInfo.cwd, sessionInfo.model || undefined);
					text = '';
					draftSource = null;
					return;
				}
			} else if (lower === '/clear') {
				clearMessages();
				text = '';
				draftSource = null;
				return;
			} else if (lower === '/leave' || lower === '/exit') {
				leaveSession();
				text = '';
				draftSource = null;
				return;
			} else if (lower === '/reload') {
				// pi's `/reload` is a TUI command, not something the agent can act on,
				// so it must never reach the model as chat text. The SERVER rebuilds the
				// agent and answers with session_reloading/session_ready, or a notice
				// when it refuses (agent busy, terminal-driven session, read-only).
				// Without a session or a connection, or while the agent is still being
				// built (a cold load or a reload in progress: the server may not have
				// attached us yet), fall through to the normal send path, whose
				// blocked-send feedback already explains why and keeps the text.
				if (sessionInfo.sessionId && connected && !appState.agentPending) {
					reloadResources();
					text = '';
					draftSource = null;
					return;
				}
			}
		}

		// pi's default: an explicit submit sends NOW. When the agent is streaming,
		// the server turns this mid-stream `message` into a STEER (injected at the
		// next tool/step boundary, before the next LLM call) rather than parking it
		// in a local queue that waits for the whole turn to resolve. The decision
		// helper is a pure, unit-tested function so this behaviour is gated in tests.
		const decision = decideComposeSend({
			streaming,
			connected,
			agentPending: appState.agentPending,
			readOnly,
			hasSession: !!sessionInfo.sessionId,
		});
		if (decision.action !== 'send') {
			// A genuine block (no session / read-only / disconnected / agent still
			// building). Keep the user's text intact; the composer's disabled/status
			// affordances already explain the state, and sendMessage() would surface a
			// recoverable error anyway. Never silently swallow the message.
			if (
				decision.reason === 'disconnected' ||
				decision.reason === 'agent-pending'
			) {
				// Route through sendMessage so it sets the clear, recoverable session
				// error ("Not connected..." / "Preparing the session agent..."). It
				// returns false and leaves the text so the user can retry.
				sendMessage(messageToSend);
			}
			return;
		}

		// Only clear the composer if the message actually went out. On a dropped
		// send (socket died in the race) sendMessage() returns false and surfaces an
		// error; keep the text so the user can retry once reconnected instead of
		// silently losing what they typed.
		const sent = sendMessage(messageToSend);
		if (sent) {
			consumeDraftOnSend(trimmed);
			text = '';
			attachments = [];
			onSend?.();
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		// Escape closes the drafts panel first (it floats over the composer), the
		// same affordance the skill menu below has.
		if (draftsOpen && e.key === 'Escape') {
			e.preventDefault();
			closeDrafts();
			return;
		}
		// Skill autocomplete owns the navigation keys while the menu is open. The
		// first Enter/Tab ACCEPTS the highlighted command (inserting `/skill:<name> `)
		// and is swallowed, so a second Enter is needed to actually send, matching the
		// pi CLI's accept-then-send behaviour and giving the user room to type args.
		if (skillMenuOpen && skillMatches.length > 0) {
			if (e.key === 'ArrowDown') {
				e.preventDefault();
				skillMenuIndex = (skillMenuIndex + 1) % skillMatches.length;
				return;
			}
			if (e.key === 'ArrowUp') {
				e.preventDefault();
				skillMenuIndex =
					(skillMenuIndex - 1 + skillMatches.length) % skillMatches.length;
				return;
			}
			if (e.key === 'Enter' || e.key === 'Tab') {
				e.preventDefault();
				const chosen = skillMatches[skillMenuIndex] ?? skillMatches[0];
				if (chosen) applySkill(chosen.name);
				return;
			}
			if (e.key === 'Escape') {
				e.preventDefault();
				skillMenuOpen = false;
				return;
			}
		}
		if (e.key === 'Enter') {
			if (enterToSend) {
				// Default mode: Enter to send, Shift+Enter for newline
				if (!e.shiftKey) {
					e.preventDefault();
					handleSend();
				}
			} else {
				// Enter for newline, Shift+Enter to send
				if (e.shiftKey) {
					e.preventDefault();
					handleSend();
				}
			}
		}
	}
</script>

<div class="relative border-t border-brand-border p-4">
	{#if draftsOpen}
		<!-- Saved drafts. Floats ABOVE the composer (like the skill menu) so opening
		     it never resizes the textarea or pushes the transcript around. Loading a
		     draft over a non-empty box routes through the warning below first. -->
		<div
			id="drafts-panel"
			role="dialog"
			aria-label="Saved drafts"
			class="absolute right-4 bottom-full left-4 z-30 mb-2 overflow-hidden rounded-lg border border-brand-border bg-brand-surface-2 shadow-lg"
		>
			<div
				class="flex items-center justify-between border-b border-brand-border px-3 py-2"
			>
				<span class="text-xs font-medium text-brand-text">
					Saved drafts ({drafts.length})
					{#if draftsLoading}
						<span class="ml-1 text-brand-text-muted">syncing…</span>
					{:else if !connected}
						<span
							class="ml-1 text-brand-text-muted"
							title="Showing the last list this device saw. Saving and deleting need the server."
							>offline copy</span
						>
					{/if}
				</span>
				<button
					type="button"
					onclick={closeDrafts}
					class="text-xs text-brand-text-muted hover:text-brand-text"
					aria-label="Close drafts">Close ×</button
				>
			</div>

			{#if pendingDraft}
				<!-- The warning the feature exists for: the box holds unsent text, so a
				     load is offered as Replace (destructive, explicit) or Append (keeps
				     both), never silently applied. -->
				<div
					class="border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300"
				>
					<div class="mb-2">
						⚠️ The message box is not empty. Loading this draft would replace
						what you typed.
					</div>
					<div class="flex flex-wrap gap-2">
						<button
							type="button"
							onclick={() => pendingDraft && loadDraft(pendingDraft, 'replace')}
							class="rounded bg-amber-500/20 px-2 py-1 font-medium text-amber-200 hover:bg-amber-500/30"
							>Replace</button
						>
						<button
							type="button"
							onclick={() => pendingDraft && loadDraft(pendingDraft, 'append')}
							class="rounded bg-brand-surface-3 px-2 py-1 font-medium text-brand-text hover:opacity-90"
							>Append below</button
						>
						<button
							type="button"
							onclick={() => (pendingDraft = null)}
							class="rounded px-2 py-1 text-brand-text-muted hover:text-brand-text"
							>Cancel</button
						>
					</div>
				</div>
			{/if}

			{#if drafts.length === 0}
				<p class="px-3 py-4 text-center text-xs text-brand-text-muted">
					No saved drafts yet. Type a message and press “Save draft” to keep it
					on the server for later, from any device.
				</p>
			{:else}
				<ul class="max-h-64 overflow-y-auto">
					{#each drafts as d (d.id)}
						<li
							class="flex items-start gap-2 border-b border-brand-border/50 px-3 py-2 last:border-b-0 {pendingDraft?.id ===
							d.id
								? 'bg-brand-surface-3/60'
								: ''}"
						>
							<!-- Loading needs a live box to load INTO. With no session and no
							     search folder the composer is disabled, and dropping text into
							     it would silently go nowhere, so the row says so instead. -->
							<button
								type="button"
								onclick={() => requestLoadDraft(d)}
								disabled={effectivelyDisabled}
								class="min-w-0 flex-1 text-left disabled:cursor-not-allowed disabled:opacity-50"
								title={effectivelyDisabled
									? 'Open a session first to load this draft'
									: d.text}
							>
								<span class="line-clamp-2 text-xs text-brand-text"
									>{draftPreview(d.text)}</span
								>
								<span class="mt-0.5 block text-[10px] text-brand-text-muted"
									>{new Date(d.updatedAt).toLocaleString()}{draftOriginLabel(d)
										? ` · ${draftOriginLabel(d)}`
										: ''}</span
								>
							</button>
							<button
								type="button"
								onclick={() => deleteDraft(d.id)}
								class="shrink-0 rounded px-1.5 py-0.5 text-xs text-brand-text-muted hover:bg-rose-500/10 hover:text-rose-400"
								title="Delete this draft"
								aria-label="Delete draft">🗑</button
							>
						</li>
					{/each}
				</ul>
			{/if}

			{#if draftError}
				<p class="border-t border-brand-border px-3 py-2 text-xs text-rose-400">
					⚠️ {draftError}
				</p>
			{/if}
		</div>
	{/if}
	{#if !connected || appState.connecting || appState.error}
		<div
			class="mb-2.5 flex items-center gap-1.5 text-xs font-medium text-brand-text-muted select-none"
		>
			{#if appState.connecting}
				<span
					class="inline-block h-1.5 w-1.5 animate-ping rounded-full bg-amber-400"
				></span>
				<span>Connecting to remote server...</span>
			{:else if appState.error}
				<span class="text-rose-400">⚠️</span>
				<span class="text-rose-400/80">{appState.error}</span>
			{:else if !connected}
				<span class="inline-block h-1.5 w-1.5 rounded-full bg-brand-surface-3"
				></span>
				<span>Disconnected from remote server</span>
			{/if}
		</div>
	{/if}
	{#if isCollapsed}
		<div class="flex items-center">
			<button
				type="button"
				onclick={() => {
					isCollapsed = false;
					setTimeout(() => textarea?.focus(), 50);
				}}
				class="flex w-full items-center justify-between rounded-lg border border-brand-border bg-brand-surface-2 px-4 py-2.5 text-sm text-brand-text-muted transition-all hover:bg-brand-surface-3 hover:text-brand-text"
			>
				<span class="flex items-center gap-2">
					<span>{searchMode ? '🔍' : '💬'}</span>
					<span>
						{#if searchMode}
							{placeholder ?? 'Search the web...'}
						{:else if streaming}
							Agent is working, tap to Steer...
						{:else if readOnly}
							Read-only mode
						{:else if !sessionInfo.sessionId}
							Select a session first...
						{:else}
							Tap to type a message...
						{/if}
					</span>
				</span>
				<span
					class="rounded bg-brand-surface-3 px-2 py-1 text-xs font-medium text-brand-text transition-colors hover:bg-brand-surface-2"
					>Expand ▲</span
				>
			</button>
		</div>
	{:else}
		{#if attachments.length > 0}
			<div class="mb-3 flex flex-wrap gap-2">
				{#each attachments as attachment, index}
					<div
						class="flex items-center gap-2 rounded border border-brand-border bg-brand-surface-2 px-2.5 py-1.5 text-xs"
					>
						<span
							class="max-w-[150px] truncate font-medium text-brand-text"
							title={attachment.name}
						>
							{attachment.name}
						</span>
						{#if attachment.uploading}
							<span
								class="inline-block h-3 w-3 animate-spin rounded-full border-2 border-brand-blue border-t-transparent"
							></span>
						{:else if attachment.file}
							<!-- Search mode: held locally, uploaded when the search creates
							     its session. -->
							<span
								class="text-brand-text-muted"
								title="Will be uploaded with the search">📎</span
							>
						{:else if attachment.error}
							<span
								class="flex items-center gap-1 text-[10px] font-medium text-rose-400"
								title={attachment.error}
							>
								<span class="max-w-[120px] truncate">⚠️ {attachment.error}</span
								>
								{#if (attachment as any).url}
									<a
										href={(attachment as any).url}
										target="_blank"
										class="ml-1 shrink-0 font-semibold text-brand-blue underline hover:opacity-80"
									>
										[Test Link]
									</a>
								{/if}
							</span>
						{:else}
							<span class="text-emerald-400">✓</span>
						{/if}
						<button
							type="button"
							onclick={() => removeAttachment(index)}
							class="ml-1 font-bold text-brand-text-muted hover:text-brand-text"
						>
							×
						</button>
					</div>
				{/each}
			</div>
		{/if}
		{#if searchMode && searchModels.length > 0}
			<!-- Model picker for search mode. Lets the user override the search
			     folder's default model before pressing Search. -->
			<div class="mb-2 flex items-center gap-2">
				<label
					for="search-model"
					class="text-xs font-medium text-brand-text-muted">Model</label
				>
				<select
					id="search-model"
					bind:value={searchModel}
					disabled={effectivelyDisabled}
					class="min-w-0 flex-1 rounded-lg border border-brand-border bg-brand-surface-2 px-2 py-1.5 text-xs text-brand-text focus:border-brand-blue focus:outline-none disabled:opacity-50"
				>
					{#each searchModels as m}
						<option value={m.value}>{m.label}</option>
					{/each}
				</select>
			</div>
		{/if}
		<form
			onsubmit={(e) => {
				e.preventDefault();
				handleSend();
			}}
			class="flex items-stretch gap-3"
		>
			<div class="relative min-w-0 flex-1">
				{#if skillMenuOpen && skillMatches.length > 0}
					<!-- Skill-command autocomplete. Floats above the composer. Selecting an
					     item only inserts `/skill:<name> ` (see applySkill); it never sends. -->
					<ul
						class="absolute bottom-full left-0 z-20 mb-1 max-h-56 w-full overflow-y-auto rounded-lg border border-brand-border bg-brand-surface-2 py-1 shadow-lg"
						role="listbox"
					>
						{#each skillMatches as skill, i (skill.name)}
							<li>
								<button
									type="button"
									role="option"
									aria-selected={i === skillMenuIndex}
									onmousedown={(e) => {
										// mousedown (not click) so the textarea doesn't blur first and
										// tear the menu down before the selection lands.
										e.preventDefault();
										applySkill(skill.name);
									}}
									onmouseenter={() => (skillMenuIndex = i)}
									class="flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left text-sm {i ===
									skillMenuIndex
										? 'bg-brand-surface-3 text-brand-text'
										: 'text-brand-text-muted hover:bg-brand-surface-3/60'}"
								>
									<span class="font-mono text-brand-text">/{skill.name}</span>
									{#if skill.description}
										<span class="line-clamp-1 text-[11px] text-brand-text-muted"
											>{skill.description}</span
										>
									{/if}
								</button>
							</li>
						{/each}
					</ul>
				{/if}
				<textarea
					bind:this={textarea}
					bind:value={text}
					onkeydown={handleKeydown}
					disabled={effectivelyDisabled}
					rows={1}
					placeholder={searchMode
						? (placeholder ?? 'Search the web...')
						: !connected
							? appState.connecting
								? 'Reconnecting to remote server...'
								: 'Disconnected - cannot send'
							: streaming
								? 'Agent is working, Steer to interrupt...'
								: readOnly
									? 'Read-only mode'
									: !sessionInfo.sessionId
										? 'Select a session first...'
										: 'Type a message...'}
					class="h-full max-h-48 min-h-[120px] w-full resize-none overflow-y-auto rounded-lg border border-brand-border bg-brand-surface-2 px-4 py-3 leading-relaxed text-brand-text placeholder-brand-text-muted focus:border-brand-blue focus:outline-none disabled:opacity-50"
				></textarea>
			</div>

			<div class="flex w-[80px] shrink-0 flex-col justify-end gap-2">
				{#if showAttach}
					<button
						type="button"
						onclick={() => {
							// Mark the picker active before it opens so the page-hidden
							// suspend timer doesn't tear down the session while the user
							// takes a photo / browses files.
							beginFilePicker();
							fileInput?.click();
						}}
						disabled={effectivelyDisabled}
						class="flex h-[40px] w-full items-center justify-center rounded-lg border border-brand-border bg-brand-surface-2 text-brand-text-muted transition-colors hover:bg-brand-surface-3 hover:text-brand-text disabled:cursor-not-allowed disabled:opacity-50"
						title="Attach file (image or document)"
					>
						📎
					</button>
					<input
						bind:this={fileInput}
						type="file"
						multiple
						onchange={handleFileChange}
						class="hidden"
					/>
				{/if}
				<div class="flex w-full justify-center">
					<SpeechButton
						bind:this={speechButton}
						bind:text
						bind:activeEngine={speechEngine}
						disabled={effectivelyDisabled}
						onSend={handleSend}
					/>
				</div>
				<button
					type="submit"
					disabled={!canSend}
					title={!searchMode && streaming
						? 'Steer the agent now (injected at the next step, before the next model call)'
						: undefined}
					class="flex h-[40px] w-full items-center justify-center rounded-lg bg-gradient-to-r from-brand-cyan to-brand-blue text-xs font-medium text-brand-text transition-all hover:opacity-90 disabled:cursor-not-allowed disabled:bg-brand-surface-3 disabled:from-brand-surface-3 disabled:to-brand-surface-3 disabled:opacity-50"
				>
					{#if searchMode}
						{submitLabel ?? 'Search'}
					{:else if streaming}
						Steer
					{:else}
						Send
					{/if}
				</button>
			</div>
		</form>

		<div
			class="mt-2 flex flex-wrap items-center justify-between gap-y-1.5 px-1 text-[11px] text-brand-text-muted select-none"
		>
			<label
				class="flex cursor-pointer items-center gap-1.5 hover:text-brand-text"
			>
				<input
					type="checkbox"
					checked={enterToSend}
					onchange={toggleEnterToSend}
					class="rounded border-brand-border bg-brand-surface-2 text-brand-blue focus:ring-0 focus:ring-offset-0"
				/>
				<span>Press Enter to send</span>
			</label>
			<div class="flex items-center gap-3">
				<!-- Drafts are available in EVERY composer mode, including the no-session
				     home page: a draft carries no session dependency, and the home page is
				     exactly where you want to pull up something written yesterday and fire
				     it into a new session. Saving needs the server (it is the store), so
				     the button is disabled while disconnected. -->
				<button
					type="button"
					onclick={saveCurrentAsDraft}
					disabled={text.trim().length === 0 || !connected}
					title={connected
						? 'Save this message as a draft instead of sending it'
						: 'Drafts are stored on the server, which is not reachable right now'}
					class="rounded bg-brand-surface-3/50 px-2 py-0.5 text-xs text-brand-text-muted transition-colors hover:bg-brand-surface-3 hover:text-brand-text disabled:cursor-not-allowed disabled:opacity-40"
				>
					{draftSavedFlash ? '✓ Saved' : '💾 Save draft'}
				</button>
				<button
					type="button"
					onclick={toggleDrafts}
					title="Open saved drafts"
					aria-expanded={draftsOpen}
					aria-controls="drafts-panel"
					class="rounded bg-brand-surface-3/50 px-2 py-0.5 text-xs text-brand-text-muted transition-colors hover:bg-brand-surface-3 hover:text-brand-text"
				>
					🗂 Drafts{drafts.length > 0 ? ` (${drafts.length})` : ''}
				</button>
				<button
					type="button"
					onclick={() => (isCollapsed = true)}
					class="rounded bg-brand-surface-3/50 px-2 py-0.5 text-xs text-brand-text-muted transition-colors hover:bg-brand-surface-3 hover:text-brand-text"
				>
					Collapse ▽
				</button>
				{#if !enterToSend}
					<span class="hidden font-mono opacity-60 sm:inline">
						Shift+Enter to send
					</span>
				{/if}
			</div>
		</div>
	{/if}
</div>
