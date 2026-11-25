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
		abort,
		cancelSteer,
		pendingSteering,
	} from '$lib/wherever';
	import {isStreaming, isReadOnly, activeSessionInfo} from '$lib/wherever';
	import {getConversationKnobs, enterToSend} from '$lib/wherever';
	import {getBaseUrl, getToken} from '$lib/session-store';
	import {decideComposeSend} from '$lib/core/compose-send';
	import {contextRing, sendButtonState} from '$lib/core/composer-controls';
	import {formatTokens} from './chat-message-helpers';
	import {buildAttachmentMessage} from '$lib/core/attachments';
	import {
		attachmentBlocksSend,
		canRetryUpload,
		chipView,
		isUploadInFlight,
		preStartUpload,
		uploadErrorFrom,
		type ChipUpload,
	} from '$lib/core/upload-chip';
	import type {UploadProgress} from '@wherever-dev/client';
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
		sendDisabled = false,
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
		// Blocks EDITING (textarea, attach, mic): no session, read-only, ...
		disabled: boolean;
		// Blocks only SENDING (the Send/Steer button, Enter-to-send, dictation
		// auto-send) while the box stays editable: a reconnect/resync, or a
		// still-building agent. Losing the socket must never stop the user from
		// reading, typing or attaching; it only stops the message going out.
		sendDisabled?: boolean;
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
	// The pill's ＋ menu (Attach file, Save as draft, Drafts). "Enter sends" is
	// the shared `enterToSend` store (core/enter-to-send.ts), toggled from the
	// chat ⋯ menu's "On this device" section.
	let plusMenuOpen = $state(false);
	// A fine pointer with hover (a desktop): only there does the placeholder say
	// what Enter does (a phone keyboard has no Shift+Enter to speak of).
	let finePointer = $state(false);

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
	let nextAttachmentId = 0;
	// In-flight uploads by attachment id, so removing a chip cancels its upload
	// (a parked upload would otherwise still go out on reconnect and leave an
	// orphan file in the upload dir).
	const uploadControllers = new Map<number, AbortController>();
	// Chat mode: an attachment carries its upload state (`upload`, fed only by
	// uploadFile's onProgress; see core/upload-chip.ts) and, once done, the saved
	// `path`. Search mode: a local File waiting for a session to upload it to
	// (`file` set). The two must stay apart: `file` is the search-mode marker
	// (the leave-search-mode effect drops attachments that have it, search submit
	// collects it), so a chat upload keeps the File it may retry from under
	// `retryFile` instead.
	let attachments = $state<
		{
			// Stable identity: an upload resolves long after it starts (it may wait
			// out a reconnect), and the user can remove other chips meanwhile, so
			// results are matched by id, never by array index.
			id: number;
			name: string;
			path?: string;
			upload?: ChipUpload;
			// The picked File, kept so Retry needs no re-pick. Dropped once done,
			// and on a `not_readable` failure (the OS invalidated it).
			retryFile?: File;
			// /health diagnostics link shown with a failure.
			url?: string;
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
	//
	// Chat mode deliberately does NOT gate editing on `connected`: a dropped
	// socket (app switch, file picker, network blip) keeps the cached
	// conversation on screen, and the composer must stay usable too (type, attach;
	// attachments wait for the connection). Only sending is blocked, below.
	let effectivelyDisabled = $derived(
		searchMode
			? disabled || !connected || !searchConfigured
			: disabled || readOnly || !sessionInfo.sessionId,
	);
	// Editing allowed but sending is not (reconnecting / resyncing / agent still
	// building). Superset of effectivelyDisabled.
	let sendBlocked = $derived(
		effectivelyDisabled || sendDisabled || (!searchMode && !connected),
	);

	let isAnyUploading = $derived(attachments.some(attachmentBlocksSend));
	let canSend = $derived(
		!sendBlocked &&
			!isAnyUploading &&
			(text.trim().length > 0 || attachments.length > 0),
	);

	// The pill's right end: ➤ send / ➤ steer / Search; ■ Stop sits in the row
	// above the pill, away from 🎤. See core/composer-controls.ts for the rule
	// (Stop follows only `streaming`, like the old strip's Abort).
	let buttons = $derived(
		sendButtonState({
			searchMode,
			streaming,
			hasContent: text.trim().length > 0 || attachments.length > 0,
			canSend,
		}),
	);

	// Context ring above the pill (chat mode only: the search composer has no
	// session). Replaces the settings strip's "🧠 11.3% / 1.0M" label.
	let ring = $derived(
		searchMode ? null : contextRing(appState.contextUsage, formatTokens),
	);
	const RING_R = 6;
	const RING_C = 2 * Math.PI * RING_R;

	let queuedSteers = $derived(searchMode ? 0 : $pendingSteering.length);

	let placeholderText = $derived.by(() => {
		if (searchMode) return placeholder ?? 'Search the web...';
		if (!connected) {
			return appState.connecting
				? 'Reconnecting... you can keep typing'
				: 'Disconnected - you can type, sending resumes once reconnected';
		}
		if (readOnly) return 'Read-only mode';
		if (!sessionInfo.sessionId) return 'Select a session first...';
		// On a phone the pill is narrow: keep the running hint short enough for
		// one line, so the empty pill stays one line tall.
		if (!finePointer) return streaming ? 'Steer the agent...' : 'Message...';
		const base = streaming ? 'Message (steers the agent)...' : 'Message...';
		return $enterToSend
			? `${base} (Enter to send, Shift+Enter for a new line)`
			: `${base} (Shift+Enter to send, Enter for a new line)`;
	});

	function closePlusMenu() {
		plusMenuOpen = false;
	}

	function pickFile() {
		plusMenuOpen = false;
		// Mark the picker active before it opens so the page-hidden suspend timer
		// doesn't tear down the session while the user takes a photo / browses
		// files. Still inside the tap gesture, so the native picker may open.
		beginFilePicker();
		fileInput?.click();
	}

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
		drafts = readCachedDrafts();
		finePointer =
			typeof window !== 'undefined' &&
			!!window.matchMedia?.('(hover: hover) and (pointer: fine)').matches;
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
		if (sendBlocked) return;
		void whenTtsIdle().then(() => {
			// Re-check: the user may have started streaming again, or the composer may
			// have been disabled, while TTS was finishing.
			if ($isStreaming || sendBlocked) return;
			speechButton?.startRecordingProgrammatically();
		});
	});

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
				...files.map((f) => ({
					id: nextAttachmentId++,
					name: f.name,
					file: f,
				})),
			];
			return;
		}

		// No early "No active session" / "not connected" failure: the session id
		// survives a socket drop (the cached session is kept), and uploadFile waits
		// for the connection to come back. A slow pick (camera, file browser)
		// commonly costs the socket on mobile; that must not cost the upload.
		const sessionId = sessionInfo.sessionId;
		const entries = files.map((f) => ({file: f, id: nextAttachmentId++}));
		// Later files of a multi-pick wait for earlier ones (one upload at a time),
		// so they start in the local pre-start state.
		attachments = [
			...attachments,
			...entries.map(({file, id}) => ({
				id,
				name: file.name,
				upload: preStartUpload(file.size),
				retryFile: file,
			})),
		];

		for (const {file, id} of entries) {
			await runUpload(id, file, sessionId);
		}
	}

	function updateAttachment(
		id: number,
		update: (a: (typeof attachments)[number]) => (typeof attachments)[number],
	) {
		attachments = attachments.map((a) => (a.id === id ? update(a) : a));
	}

	function dropAttachment(id: number) {
		attachments = attachments.filter((a) => a.id !== id);
	}

	function diagnosticsUrl(): string {
		try {
			const baseUrl = getBaseUrl();
			const token = getToken();
			return `${baseUrl}/health${token ? `?token=${encodeURIComponent(token)}` : ''}`;
		} catch {
			return '';
		}
	}

	// Upload one attachment's File and drive its chip from onProgress. Each
	// attempt owns its AbortController; callbacks and results from an attempt that
	// is no longer the current one for this id (removed, or superseded by a
	// Retry) are ignored.
	async function runUpload(
		id: number,
		file: File,
		sessionId: string | null | undefined,
	) {
		// Removed by the user while earlier files were uploading: skip it.
		if (!attachments.some((a) => a.id === id)) return;
		const controller = new AbortController();
		uploadControllers.set(id, controller);
		const isCurrent = () => uploadControllers.get(id) === controller;
		const onProgress = (p: UploadProgress) => {
			if (!isCurrent()) return;
			if (p.state === 'aborted') {
				dropAttachment(id);
				return;
			}
			updateAttachment(id, (a) => ({
				...a,
				upload: {...p},
				...(p.state === 'failed' && !canRetryUpload(p.error)
					? {retryFile: undefined}
					: {}),
			}));
		};
		try {
			if (!sessionId) {
				throw new Error('No active session');
			}
			const res = await uploadFile(sessionId, file, {
				signal: controller.signal,
				onProgress,
			});
			if (!isCurrent()) return;
			updateAttachment(id, (a) => ({
				id,
				name: a.name,
				path: res.savedPath,
				upload: {state: 'done', acked: file.size, size: file.size},
			}));
		} catch (err) {
			if (!isCurrent()) return;
			if (controller.signal.aborted) {
				dropAttachment(id);
				return;
			}
			console.error('File upload error details:', err);
			const error = uploadErrorFrom(err);
			updateAttachment(id, (a) => ({
				id,
				name: a.name,
				upload: {
					state: 'failed',
					acked: a.upload?.acked ?? 0,
					size: file.size,
					error,
				},
				retryFile: canRetryUpload(error) ? file : undefined,
				url: diagnosticsUrl(),
			}));
		} finally {
			if (isCurrent()) uploadControllers.delete(id);
		}
	}

	// Cancel an in-flight upload. The aborted upload reports `aborted`, which
	// removes its chip; a pre-start chip has no upload yet, so it goes directly.
	function cancelUpload(id: number) {
		const controller = uploadControllers.get(id);
		if (controller) controller.abort();
		else dropAttachment(id);
	}

	// Restart a failed upload from the File picked originally (no re-pick),
	// into the session that is current NOW, not the one at pick time.
	function retryUpload(id: number) {
		const attachment = attachments.find((a) => a.id === id);
		const file = attachment?.retryFile;
		if (!file || uploadControllers.has(id)) return;
		updateAttachment(id, (a) => ({
			id,
			name: a.name,
			upload: preStartUpload(file.size),
			retryFile: file,
		}));
		void runUpload(id, file, sessionInfo.sessionId);
	}

	function removeAttachment(id: number) {
		uploadControllers.get(id)?.abort();
		dropAttachment(id);
	}

	function handleSend() {
		// Every send path (button, Enter, dictation auto-send) funnels through
		// here, so this is the one gate for "editable but not sendable". The text
		// and attachments stay in the box for when the connection is back.
		if (sendBlocked || isAnyUploading) return;
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
		if (plusMenuOpen && e.key === 'Escape') {
			e.preventDefault();
			closePlusMenu();
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
			if ($enterToSend) {
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

<!-- The composer's content is aligned to the chat message column (about
     760px, centered; see ChatMessageList): the side padding grows so the
     content is never wider than 760px (`--chat-column`; the whole area with
     Wide chat), while the top border stays full width. -->
<div
	class="relative border-t border-brand-border px-[max(1rem,calc((100%-var(--chat-column))/2))] pt-2 pb-3"
>
	{#if draftsOpen}
		<!-- Saved drafts. Floats ABOVE the composer (like the skill menu) so opening
		     it never resizes the textarea or pushes the transcript around. Loading a
		     draft over a non-empty box routes through the warning below first. -->
		<div
			id="drafts-panel"
			role="dialog"
			aria-label="Saved drafts"
			class="absolute right-[max(1rem,calc((100%-var(--chat-column))/2))] bottom-full left-[max(1rem,calc((100%-var(--chat-column))/2))] z-30 mb-2 overflow-hidden rounded-lg border border-brand-border bg-brand-surface-2 shadow-lg"
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
	{#if attachments.length > 0}
		<div class="mb-3 flex flex-wrap gap-2">
			{#each attachments as attachment (attachment.id)}
				<!-- Chip state comes ONLY from uploadFile's onProgress, mapped by
				     core/upload-chip.ts (chipView); a search-held file has no upload. -->
				{@const view = attachment.upload ? chipView(attachment.upload) : null}
				{@const inFlight = attachment.upload
					? isUploadInFlight(attachment.upload.state)
					: false}
				<div
					class="flex items-center gap-2 rounded border bg-brand-surface-2 px-2.5 py-1.5 text-xs {inFlight
						? 'border-brand-blue'
						: 'border-brand-border'}"
				>
					<span
						class="max-w-[150px] truncate font-medium text-brand-text"
						title={attachment.name}
					>
						{attachment.name}
					</span>
					{#if attachment.file}
						<!-- Search mode: held locally, uploaded when the search creates
						     its session. -->
						<span
							class="text-brand-text-muted"
							title="Will be uploaded with the search">📎</span
						>
					{:else if view?.kind === 'pending' || view?.kind === 'indeterminate'}
						<span
							class="inline-block h-3 w-3 animate-spin rounded-full border-2 border-brand-blue border-t-transparent"
						></span>
					{:else if view?.kind === 'waiting'}
						<!-- Queued or paused: the upload continues on its own once the
						     socket is back and the session has rejoined (no re-attach). -->
						<span
							class="inline-block h-3 w-3 animate-spin rounded-full border-2 border-brand-text-muted border-t-transparent"
						></span>
						<span
							class="text-[10px] text-brand-text-muted"
							title="The upload continues once reconnected"
							>Paused, waiting for connection</span
						>
					{:else if view?.kind === 'progress' || view?.kind === 'finishing'}
						<span
							class="h-1.5 w-16 overflow-hidden rounded-full bg-brand-surface-3"
							role="progressbar"
							aria-valuemin={0}
							aria-valuemax={100}
							aria-valuenow={view.percent}
						>
							<span
								class="block h-full rounded-full bg-brand-blue transition-[width]"
								style="width: {view.percent}%"
							></span>
						</span>
						<span class="text-[10px] text-brand-text-muted tabular-nums"
							>{view.percent}%</span
						>
						{#if view.kind === 'finishing'}
							<span
								class="inline-block h-3 w-3 animate-spin rounded-full border-2 border-brand-blue border-t-transparent"
								title="Finishing"
							></span>
						{/if}
					{:else if view?.kind === 'failed'}
						<span
							class="flex items-center gap-1 text-[10px] font-medium text-rose-400"
							title={view.message}
						>
							<span class="max-w-[120px] truncate">⚠️ {view.message}</span>
							{#if view.pickAgain}
								<span class="shrink-0 text-brand-text-muted"
									>Pick the file again</span
								>
							{:else if attachment.url}
								<a
									href={attachment.url}
									target="_blank"
									class="ml-1 shrink-0 font-semibold text-brand-blue underline hover:opacity-80"
								>
									[Test Link]
								</a>
							{/if}
						</span>
						{#if view.retry && attachment.retryFile}
							<button
								type="button"
								onclick={() => retryUpload(attachment.id)}
								class="rounded bg-brand-surface-3 px-1.5 py-0.5 text-[10px] font-medium text-brand-text hover:bg-brand-surface-3/70"
							>
								Retry
							</button>
						{/if}
					{:else}
						<span class="text-emerald-400">✓</span>
					{/if}
					{#if inFlight}
						<button
							type="button"
							onclick={() => cancelUpload(attachment.id)}
							class="rounded bg-brand-surface-3 px-1.5 py-0.5 text-[10px] font-medium text-brand-text-muted hover:text-brand-text"
						>
							Cancel
						</button>
					{/if}
					<button
						type="button"
						onclick={() => removeAttachment(attachment.id)}
						class="ml-1 font-bold text-brand-text-muted hover:text-brand-text"
						title="Remove"
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
	<!-- Above the pill: the context ring (always, in every composer state: it is
	     outside the pill, so neither the keyboard nor the pill growing to its cap
	     can push it away), ■ Stop while the agent runs (here, not in the pill, so
	     it is never mistaken for the mic's stop-recording), "Cancel queued (N)"
	     while steers wait, a transient "Draft saved", and "Drafts (N)" when there
	     are any. -->
	{#if ring || buttons.stop || queuedSteers > 0 || drafts.length > 0 || draftSavedFlash}
		<div
			class="mb-1.5 flex min-h-6 items-center justify-between gap-3 px-1 text-[11px] text-brand-text-muted select-none"
		>
			<div class="flex min-w-0 items-center gap-1.5">
				{#if ring}
					<span
						class="flex items-center gap-1.5 whitespace-nowrap tabular-nums"
						title={ring.title}
						data-testid="context-ring"
					>
						<svg viewBox="0 0 16 16" class="h-3.5 w-3.5 shrink-0 -rotate-90">
							<circle
								cx="8"
								cy="8"
								r={RING_R}
								fill="none"
								stroke="currentColor"
								stroke-width="2.5"
								class="opacity-25"
							/>
							<circle
								cx="8"
								cy="8"
								r={RING_R}
								fill="none"
								stroke-width="2.5"
								stroke-linecap="round"
								stroke-dasharray={RING_C}
								stroke-dashoffset={RING_C * (1 - ring.fraction)}
								class={ring.tone === 'high'
									? 'stroke-rose-400'
									: ring.tone === 'warn'
										? 'stroke-amber-400'
										: 'stroke-brand-blue'}
							/>
						</svg>
						<span>{ring.label}</span>
					</span>
				{/if}
			</div>
			<div class="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
				{#if draftSavedFlash}
					<span class="text-emerald-400">✓ Draft saved</span>
				{/if}
				{#if buttons.stop}
					<button
						type="button"
						onclick={abort}
						class="flex items-center gap-1.5 rounded-md bg-rose-500 px-2.5 py-0.5 text-xs font-medium text-brand-text transition-colors hover:bg-rose-600"
						title="Stop the agent"
						aria-label="Stop the agent"
					>
						<span class="block h-2.5 w-2.5 rounded-[2px] bg-current"></span>
						Stop
					</button>
				{/if}
				<!-- Cancel ALL queued steers without aborting the running turn. pi's
				     clearQueue() is all-or-nothing, so this is a single session-level
				     action (not per-message). -->
				{#if queuedSteers > 0}
					<button
						type="button"
						onclick={cancelSteer}
						class="rounded border border-amber-400/50 px-2 py-0.5 text-amber-300 transition-colors hover:bg-rose-500/80 hover:text-brand-text"
						title="Cancel the queued steer message{queuedSteers > 1
							? 's'
							: ''} (does not abort the current turn)"
					>
						Cancel queued ({queuedSteers})
					</button>
				{/if}
				{#if drafts.length > 0}
					<button
						type="button"
						onclick={toggleDrafts}
						aria-expanded={draftsOpen}
						aria-controls="drafts-panel"
						class="hover:text-brand-text"
						title="Open saved drafts">Drafts ({drafts.length})</button
					>
				{/if}
			</div>
		</div>
	{/if}
	<!-- The pill: ＋, the text, 🎤, and the send button (➤ send / ➤ steer / Search).
	     The textarea grows with its content up to about 40% of the viewport
	     height, then scrolls. -->
	<form
		onsubmit={(e) => {
			e.preventDefault();
			handleSend();
		}}
		class="relative flex items-end gap-1 rounded-3xl border border-brand-border bg-brand-surface-2 py-1 pr-1 pl-1 transition-colors focus-within:border-brand-blue"
	>
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
		<div class="relative shrink-0">
			<button
				type="button"
				onclick={() => (plusMenuOpen = !plusMenuOpen)}
				aria-haspopup="menu"
				aria-expanded={plusMenuOpen}
				aria-label="More: attach file, drafts"
				title="Attach file, save as draft, drafts"
				class="flex h-9 w-9 items-center justify-center rounded-full text-xl leading-none text-brand-text-muted transition-colors hover:bg-brand-surface-3 hover:text-brand-text"
			>
				＋
			</button>
			{#if plusMenuOpen}
				<!-- Click-outside backdrop for the ＋ menu. -->
				<button
					type="button"
					class="fixed inset-0 z-30 cursor-default"
					aria-label="Close menu"
					tabindex="-1"
					onclick={closePlusMenu}
				></button>
				<div
					role="menu"
					class="absolute bottom-full left-0 z-40 mb-2 w-60 overflow-hidden rounded-lg border border-brand-border bg-brand-surface-2 py-1 text-sm shadow-lg"
				>
					{#if showAttach}
						<button
							type="button"
							role="menuitem"
							onclick={pickFile}
							disabled={effectivelyDisabled}
							class="flex w-full items-center gap-2 px-3 py-2 text-left text-brand-text hover:bg-brand-surface-3 disabled:cursor-not-allowed disabled:opacity-50"
							title="Attach file (image or document)"
						>
							<span>📎</span><span>Attach file</span>
						</button>
					{/if}
					<!-- Drafts are available in EVERY composer mode, including the
					     no-session home page: a draft carries no session dependency, and
					     the home page is exactly where you want to pull up something
					     written yesterday and fire it into a new session. Saving needs
					     the server (it is the store), so it is disabled while
					     disconnected. -->
					<button
						type="button"
						role="menuitem"
						onclick={() => {
							closePlusMenu();
							void saveCurrentAsDraft();
						}}
						disabled={text.trim().length === 0 || !connected}
						title={connected
							? 'Save this message as a draft instead of sending it'
							: 'Drafts are stored on the server, which is not reachable right now'}
						class="flex w-full items-center gap-2 px-3 py-2 text-left text-brand-text hover:bg-brand-surface-3 disabled:cursor-not-allowed disabled:opacity-50"
					>
						<span>💾</span><span>Save as draft</span>
					</button>
					<button
						type="button"
						role="menuitem"
						onclick={() => {
							closePlusMenu();
							toggleDrafts();
						}}
						aria-controls="drafts-panel"
						class="flex w-full items-center gap-2 px-3 py-2 text-left text-brand-text hover:bg-brand-surface-3"
						title="Open saved drafts"
					>
						<span>🗂</span><span
							>Drafts{drafts.length > 0 ? ` (${drafts.length})` : ''}</span
						>
					</button>
				</div>
			{/if}
			{#if showAttach}
				<input
					bind:this={fileInput}
					type="file"
					multiple
					onchange={handleFileChange}
					class="hidden"
				/>
			{/if}
		</div>
		<textarea
			bind:this={textarea}
			bind:value={text}
			onkeydown={handleKeydown}
			disabled={effectivelyDisabled}
			rows={1}
			placeholder={placeholderText}
			aria-label={searchMode ? 'Search query' : 'Message'}
			class="max-h-[40vh] min-h-9 min-w-0 flex-1 resize-none overflow-y-auto border-0 bg-transparent px-1 py-1.5 leading-relaxed text-brand-text placeholder-brand-text-muted focus:ring-0 focus:outline-none disabled:opacity-50"
		></textarea>
		<SpeechButton
			bind:this={speechButton}
			bind:text
			bind:activeEngine={speechEngine}
			disabled={effectivelyDisabled}
			onSend={handleSend}
			compact
		/>
		{#if buttons.primary === 'search'}
			<button
				type="submit"
				disabled={buttons.primaryDisabled}
				class="flex h-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-r from-brand-cyan to-brand-blue px-4 text-xs font-medium text-brand-text transition-all hover:opacity-90 disabled:cursor-not-allowed disabled:from-brand-surface-3 disabled:to-brand-surface-3 disabled:opacity-50"
			>
				{submitLabel ?? 'Search'}
			</button>
		{:else}
			<button
				type="submit"
				disabled={buttons.primaryDisabled}
				title={buttons.primary === 'steer'
					? 'Steer the agent now (injected at the next step, before the next model call)'
					: 'Send'}
				aria-label={buttons.primary === 'steer' ? 'Steer' : 'Send'}
				class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-blue text-brand-text transition-all hover:opacity-90 disabled:cursor-not-allowed disabled:bg-brand-surface-3 disabled:opacity-50"
			>
				<svg
					viewBox="0 0 24 24"
					class="h-4 w-4"
					fill="currentColor"
					aria-hidden="true"
					><path
						d="M3.4 20.4 21 12 3.4 3.6 3.39 10.13 15 12 3.39 13.87z"
					/></svg
				>
			</button>
		{/if}
	</form>
</div>
