<!--
	The chat top bar's ⋯ session menu (spec `chat-compact-layout` stories 5, 6,
	8 to 11, 13, 14; task `chat-session-menu`). Built on the shared `Menu`
	primitive: a bottom sheet on the phone, a popover on desktop. Which items
	show, and in which section, is decided by `chatMenuSections()` in
	`core/chat-session-menu.ts` (unit-tested); this component renders them and
	wires each one to the action the top bar or the old settings strip used:

	- Model: the current model; opens the model list in place (`changeModel`).
	  Text only on a read-only session or without a model list.
	- Star / Unstar (`setSessionStarred`), Rename (the shared `RenamePrompt`,
	  `renameSession`, its refusals shown in place), Copy link (the row menu's
	  `sessionLinkUrl` + `copyText`), Open in new tab (desktop), Close / Reopen
	  (the existing close flow: `closeSession`, `setSessionClosed`), Search the
	  web (`onStartSearch`, today's 🔍), Reset the assistant (`resetAssistant`).
	- "This chat": Beep when done (tri-state, `setBeepSessionOverride`) and
	  Conversation mode (`setConversationModeBundle`, per conversation). Its
	  handler calls `unlockTts()` first: it is a TTS gesture-unlock point, as the
	  old strip toggle was, or mobile drops every spoken reply.
	- "On this device": Hide thinking (`updateConfig`), Enter sends (the shared
	  `enterToSend` store), Voice settings… (the `SpeechSettingsPanel`, shown in
	  place under the item).
	- Text: the context usage and the versions.

	With no session open only "On this device" shows; the Conversation mode
	DEFAULT is then edited in Connection Settings.

	Props:
	- `listed`: the open session's listing entry (name, starred, closed), if
	  listed.
	- `title`: the top bar's title of the open session (the rename prompt's
	  label).
	- `searchWeb`: web search is configured and reachable (Search the web).
	- `viewingAssistant`: the open session is the assistant's (Reset).
	- `onStartSearch`: leave the session for the web-search screen, focusing the
	  composer inside the tap (the page's `startSearch`).
-->
<script lang="ts">
	import Menu from './menu/Menu.svelte';
	import MenuItem from './menu/MenuItem.svelte';
	import MenuSeparator from './menu/MenuSeparator.svelte';
	import RenamePrompt from './RenamePrompt.svelte';
	import SpeechSettingsPanel from './speech/SpeechSettingsPanel.svelte';
	import {version} from '$app/environment';
	import {MENU_SHEET_QUERY} from '$lib/core/menu-nav';
	import {copyText} from '$lib/core/clipboard';
	import {sessionLinkUrl} from '$lib/core/session-row';
	import {unlockTts} from '$lib/core/speak';
	import {
		beepMenuLabel,
		chatMenuSections,
		contextMenuText,
		modelMenuLabel,
		nextBeepOverride,
		versionsText,
	} from '$lib/core/chat-session-menu';
	import {formatTokens} from './chat-message-helpers';
	import {
		activeSessionInfo,
		beepEnabled,
		beepSessionOverride,
		changeModel,
		conversationMode,
		conversationModeSessionOverride,
		enterToSend,
		isReadOnly,
		piState,
		resetAssistant,
		setBeepSessionOverride,
		setConversationModeBundle,
		updateConfig,
	} from '$lib/wherever';
	import {
		availableModels,
		closeSession,
		renameSession,
		setSessionClosed,
		setSessionStarred,
	} from '$lib/session-store';

	let {
		listed,
		title,
		searchWeb,
		viewingAssistant,
		onStartSearch,
	}: {
		listed: {name?: string; starred?: boolean; closed?: boolean} | undefined;
		title: string;
		searchWeb: boolean;
		viewingAssistant: boolean;
		onStartSearch: () => void;
	} = $props();

	function isWide(): boolean {
		return (
			typeof window !== 'undefined' &&
			!!window.matchMedia?.(MENU_SHEET_QUERY).matches
		);
	}

	let open = $state(false);
	// Popover (desktop) or sheet (phone): read when the menu opens.
	let desktop = $state(isWide());
	let modelsOpen = $state(false);
	let voiceOpen = $state(false);
	let renaming = $state(false);

	let sessionInfo = $derived($activeSessionInfo);
	let file = $derived(sessionInfo.sessionFile);
	let readOnly = $derived($isReadOnly);
	let starred = $derived(!!listed?.starred);
	let closed = $derived(!!listed?.closed);
	let models = $derived($availableModels.models);
	let modelPickable = $derived(models.length > 0 && !readOnly);
	let contextText = $derived(
		contextMenuText($piState.contextUsage, formatTokens),
	);
	let contextTitle = $derived(
		$piState.contextUsage?.tokens != null
			? `${$piState.contextUsage.tokens.toLocaleString()} context tokens of ${$piState.contextUsage.contextWindow.toLocaleString()}`
			: 'Context window size',
	);
	let versions = $derived(
		versionsText({
			app: version,
			server: $piState.serverVersion,
			pi: $piState.piVersion,
		}),
	);

	let sections = $derived(
		chatMenuSections({
			hasSession: !!file,
			readOnly,
			closed,
			desktop,
			hasModel: !!sessionInfo.model,
			searchWeb,
			viewingAssistant,
			hasContext: !!contextText,
		}),
	);

	// Beep, tri-state as the old strip: Default (follows the default live) ->
	// On -> Off -> Default. beepEnabled is the effective state.
	let beepOverride = $derived($beepSessionOverride);
	let beepOn = $derived($beepEnabled);

	// Conversation mode, per conversation (following the default unless set).
	let conversationOn = $derived($conversationMode);
	let conversationFollowsDefault = $derived(
		$conversationModeSessionOverride === undefined,
	);
	// ALSO the TTS gesture-unlock point: mobile browsers allow the first
	// speechSynthesis.speak() only inside a user gesture, and spoken replies come
	// from a gesture-less WebSocket effect, so this tap primes it (silent,
	// idempotent; see core/speak.ts). Unconditional, as the strip toggle was.
	function toggleConversationMode() {
		unlockTts();
		setConversationModeBundle(!conversationOn);
	}

	function link(): string {
		return sessionLinkUrl(window.location, sessionInfo.sessionId ?? '');
	}

	// Copy link: "Copied" in place, then the menu closes; on failure the link
	// shows in the menu, selectable, to copy by hand (as the row menu).
	let copyState = $state<'idle' | 'copied' | 'failed'>('idle');
	let copyTimer: ReturnType<typeof setTimeout> | undefined;
	async function copyLink() {
		const ok = await copyText(link());
		copyState = ok ? 'copied' : 'failed';
		clearTimeout(copyTimer);
		if (ok)
			copyTimer = setTimeout(() => {
				open = false;
				onClose();
			}, 900);
	}

	function onClose() {
		clearTimeout(copyTimer);
		copyState = 'idle';
		modelsOpen = false;
		voiceOpen = false;
	}

	const sectionTitleClass =
		'px-4 pt-2 pb-1 text-[10px] font-semibold tracking-wide text-brand-text-muted uppercase md:px-3';
	const textLineClass =
		'px-4 py-2 text-xs text-brand-text-muted tabular-nums md:px-3';
</script>

<Menu
	label="Session menu"
	class="flex-shrink-0"
	width="w-72"
	bind:open
	onclose={onClose}
>
	{#snippet trigger(props)}
		<button
			{...props}
			onclick={(e) => {
				desktop = isWide();
				props.onclick(e);
			}}
			type="button"
			class="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg border text-lg leading-none transition-colors {open
				? 'border-brand-blue bg-brand-surface-3 text-brand-text'
				: 'border-brand-border text-brand-text-muted hover:text-brand-text'}"
			title={file ? 'Session menu' : 'Settings on this device'}
			aria-label={file ? 'Session menu' : 'Settings on this device'}>⋯</button
		>
	{/snippet}
	{#each sections as section, i (section.id)}
		{#if i > 0}
			<MenuSeparator />
		{/if}
		{#if section.title}
			<div class={sectionTitleClass}>{section.title}</div>
		{/if}
		{#if section.id === 'details'}
			<!-- Text only: "Context 33.1% of 1.0M · v0.29.0 / srv 0.29.0". -->
			<div class={textLineClass}>
				{#if section.items.includes('context')}
					<span title={contextTitle}>{contextText}</span>{' · '}
				{/if}
				<span
					title="App build {version}{$piState.serverVersion
						? ` · server ${$piState.serverVersion}`
						: ''}{$piState.piVersion ? ` · pi ${$piState.piVersion}` : ''}"
					>{versions}</span
				>
			</div>
		{:else}
			{#each section.items as item (item)}
				{#if item === 'model'}
					{#if modelPickable}
						<MenuItem
							icon="🤖"
							keepOpen
							hint="{modelMenuLabel(
								sessionInfo.model ?? '',
								models,
							)} {modelsOpen ? '▾' : '›'}"
							title="Change the model"
							onselect={() => (modelsOpen = !modelsOpen)}>Model</MenuItem
						>
						{#if modelsOpen}
							<div class="max-h-60 overflow-y-auto pl-4">
								{#each models as model (`${model.provider}:${model.modelId}`)}
									{@const value = `${model.provider}:${model.modelId}`}
									<MenuItem
										icon={value === sessionInfo.model ? '✓' : ' '}
										title={value}
										onselect={() => {
											if (value !== sessionInfo.model) changeModel(value);
										}}>{model.label}</MenuItem
									>
								{/each}
							</div>
						{/if}
					{:else}
						<div
							class="flex items-center gap-2 px-4 py-2 text-brand-text-muted md:px-3"
						>
							<span class="w-4 shrink-0 text-center" aria-hidden="true">🤖</span
							>
							<span class="flex-1">Model</span>
							<span class="truncate text-xs" title={sessionInfo.model}
								>{modelMenuLabel(sessionInfo.model ?? '', models)}</span
							>
						</div>
					{/if}
				{:else if item === 'star'}
					<MenuItem
						icon={starred ? '★' : '☆'}
						title={starred ? 'Unstar' : 'Star to come back to it later'}
						onselect={() => {
							if (file) setSessionStarred(file, !starred).catch(() => {});
						}}>{starred ? 'Unstar' : 'Star'}</MenuItem
					>
				{:else if item === 'rename'}
					<MenuItem
						icon="✎"
						title="Give this session a name"
						onselect={() => (renaming = true)}>Rename</MenuItem
					>
				{:else if item === 'copy-link'}
					<MenuItem
						icon="⧉"
						keepOpen
						hint={copyState === 'copied'
							? '✓'
							: copyState === 'failed'
								? 'copy it by hand'
								: undefined}
						title="Copy the link that opens this session"
						onselect={copyLink}
						>{copyState === 'copied'
							? 'Copied'
							: copyState === 'failed'
								? 'Could not copy'
								: 'Copy link'}</MenuItem
					>
					{#if copyState === 'failed'}
						<div
							class="px-4 py-1 font-mono text-[11px] break-all text-brand-text-muted select-text md:px-3"
						>
							{link()}
						</div>
					{/if}
				{:else if item === 'open-new-tab'}
					<MenuItem
						icon="↗"
						title="Open this session in a new browser tab"
						onselect={() => window.open(link(), '_blank', 'noopener')}
						>Open in new tab</MenuItem
					>
				{:else if item === 'close'}
					<MenuItem
						icon="⊘"
						title="Close this session: done with it (hidden from the list, not deleted)"
						onselect={() => {
							// Asks about owned sessions and shows the sidebar's Undo banner.
							if (file) void closeSession(file);
						}}>Close session</MenuItem
					>
				{:else if item === 'reopen'}
					<MenuItem
						icon="↺"
						title="Reopen: list it again"
						onselect={() => {
							if (file) setSessionClosed(file, false).catch(() => {});
						}}>Reopen session</MenuItem
					>
				{:else if item === 'search-web'}
					<MenuItem
						icon="🔍"
						title="Leave this session and search the web"
						onselect={onStartSearch}>Search the web</MenuItem
					>
				{:else if item === 'reset-assistant'}
					<MenuItem
						icon="↺"
						title="Reset the assistant: start a fresh session (its memory lives in its folder)"
						onselect={resetAssistant}>Reset the assistant</MenuItem
					>
				{:else if item === 'beep'}
					<MenuItem
						icon={beepOn ? '🔔' : '🔕'}
						keepOpen
						hint={beepMenuLabel(beepOverride, beepOn)}
						title={beepOverride === undefined
							? `Beep when the agent is waiting: following the default (${beepOn ? 'on' : 'off'}). Click to set On for this session.`
							: beepOverride === true
								? 'Beep when the agent is waiting: ON for this session. Click to set Off.'
								: 'Beep when the agent is waiting: OFF for this session. Click to follow the default.'}
						onselect={() =>
							setBeepSessionOverride(nextBeepOverride(beepOverride))}
						>Beep when done</MenuItem
					>
				{:else if item === 'conversation'}
					<MenuItem
						checked={conversationOn}
						keepOpen
						hint={conversationFollowsDefault ? 'default' : 'set here'}
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
						onselect={toggleConversationMode}>Conversation mode</MenuItem
					>
				{:else if item === 'hide-thinking'}
					<MenuItem
						checked={$piState.hideThinking}
						keepOpen
						title="Hide the model's thinking blocks (this device)"
						onselect={() =>
							updateConfig({hideThinking: !$piState.hideThinking})}
						>Hide thinking</MenuItem
					>
				{:else if item === 'enter-sends'}
					<MenuItem
						checked={$enterToSend}
						keepOpen
						title={$enterToSend
							? 'Enter sends, Shift+Enter adds a new line'
							: 'Shift+Enter sends, Enter adds a new line'}
						onselect={() => enterToSend.toggle()}>Enter sends</MenuItem
					>
				{:else if item === 'voice-settings'}
					<MenuItem
						icon="🎤"
						keepOpen
						hint={voiceOpen ? '▾' : '›'}
						title="Speech-to-text engine, accent and direct send"
						onselect={() => (voiceOpen = !voiceOpen)}>Voice settings…</MenuItem
					>
					{#if voiceOpen}
						<div
							class="mx-3 my-1 rounded-lg border border-gray-600 bg-gray-800 p-3"
						>
							<SpeechSettingsPanel />
						</div>
					{/if}
				{/if}
			{/each}
		{/if}
	{/each}
</Menu>

{#if file}
	<RenamePrompt
		bind:open={renaming}
		currentName={listed?.name}
		label={title}
		onsave={(name) => renameSession(file!, name)}
	/>
{/if}
