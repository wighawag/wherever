<script lang="ts">
	import {
		connect,
		disconnect,
		clearConversationCache,
		getConfig,
		setConfig,
		isConnected,
	} from '$lib/wherever';
	import {playInvitingBeep} from '$lib/core/beep';
	import {unlockTts} from '$lib/core/speak';
	import {onMount} from 'svelte';

	let {
		host,
		port,
		token,
		onConnected,
	}: {
		host: string;
		port: number;
		token: string;
		onConnected: () => void;
	} = $props();

	let localHost = $state('');
	let localPort = $state(0);
	let localToken = $state('');
	let localHideThinking = $state(false);
	let localBeepDefault = $state(false);
	let localBeepSoundUrl = $state('');
	let localConversationMode = $state(false);
	let localSpeakReplies = $state(false);
	let localCollapseLongReplies = $state(false);
	let localMicReopensAfterReply = $state(false);
	let saving = $state(false);
	let connected = $derived($isConnected);

	onMount(() => {
		const config = getConfig();
		localHost = config.host;
		localPort = config.port;
		localToken = config.token || '';
		localHideThinking = !!config.hideThinking;
		localBeepDefault = !!config.beepDefault;
		localBeepSoundUrl = config.beepSoundUrl || '';
		localConversationMode = !!config.conversationMode;
		localSpeakReplies = !!config.speakReplies;
		localCollapseLongReplies = !!config.collapseLongReplies;
		localMicReopensAfterReply = !!config.micReopensAfterReply;
	});

	function handleTestBeep() {
		playInvitingBeep(localBeepSoundUrl.trim() || undefined);
	}

	function handleConfigChange() {
		setConfig({
			host: localHost,
			port: localPort,
			token: localToken,
			hideThinking: localHideThinking,
			// Tool calls are always shown (the toggle was removed); force it off so a
			// previously-stored `true` is cleared.
			hideTools: false,
			beepDefault: localBeepDefault,
			beepSoundUrl: localBeepSoundUrl.trim(),
			conversationMode: localConversationMode,
			speakReplies: localSpeakReplies,
			collapseLongReplies: localCollapseLongReplies,
			micReopensAfterReply: localMicReopensAfterReply,
		});
		// Enabling spoken replies HERE is a real user gesture (a checkbox onchange),
		// so it is a valid moment to prime browser TTS. Without this, a mobile user
		// who turns conversation mode + speak-replies on from settings and then only
		// types (never tapping the master toggle or the mic) would have their FIRST
		// `say` reply silently dropped by mobile Chrome / iOS / PWA user-activation
		// gating. unlockTts() is idempotent (a no-op once primed) and only primes
		// when spoken replies are actually intended.
		if (localConversationMode && localSpeakReplies) {
			unlockTts();
		}
	}

	function handleConnect() {
		setConfig({
			host: localHost,
			port: localPort,
			token: localToken,
			hideThinking: localHideThinking,
			hideTools: false,
			beepDefault: localBeepDefault,
			beepSoundUrl: localBeepSoundUrl.trim(),
			conversationMode: localConversationMode,
			speakReplies: localSpeakReplies,
			collapseLongReplies: localCollapseLongReplies,
			micReopensAfterReply: localMicReopensAfterReply,
		});
		// No wipe here: connect() keeps only the (possibly edited) server's cached
		// conversations, so a same-server Connect wipes nothing (ADR 0013).
		disconnect();
		setTimeout(() => connect(), 100);
	}

	// "Disconnect" wipes the on-device conversation cache (ADR 0013). Only here and
	// in the page's "Disconnect Server", never in the shared disconnect().
	function handleDisconnect() {
		disconnect();
		clearConversationCache();
	}

	function handleReload() {
		window.location.reload();
	}
</script>

<div class="border-b border-brand-border p-4">
	<div class="space-y-3">
		<div>
			<label for="pi-host" class="mb-1 block text-xs text-brand-text-muted"
				>Host</label
			>
			<input
				id="pi-host"
				type="text"
				bind:value={localHost}
				placeholder="localhost"
				class="w-full rounded border border-brand-border bg-brand-surface-2 px-3 py-2 text-sm text-brand-text placeholder-brand-text-muted focus:border-brand-blue focus:outline-none"
			/>
		</div>

		<div>
			<label for="pi-port" class="mb-1 block text-xs text-brand-text-muted"
				>Port</label
			>
			<input
				id="pi-port"
				type="number"
				bind:value={localPort}
				class="w-full rounded border border-brand-border bg-brand-surface-2 px-3 py-2 text-sm text-brand-text placeholder-brand-text-muted focus:border-brand-blue focus:outline-none"
			/>
		</div>

		<div>
			<label for="pi-token" class="mb-1 block text-xs text-brand-text-muted"
				>Token (optional)</label
			>
			<input
				id="pi-token"
				type="password"
				bind:value={localToken}
				placeholder="Authentication token"
				class="w-full rounded border border-brand-border bg-brand-surface-2 px-3 py-2 text-sm text-brand-text placeholder-brand-text-muted focus:border-brand-blue focus:outline-none"
			/>
		</div>

		<div class="flex items-center gap-2 py-1">
			<input
				id="pi-hide-thinking"
				type="checkbox"
				bind:checked={localHideThinking}
				onchange={handleConfigChange}
				class="h-4 w-4 rounded border-brand-border bg-brand-surface-2 text-brand-blue focus:ring-brand-blue focus:ring-offset-0"
			/>
			<label
				for="pi-hide-thinking"
				class="cursor-pointer text-xs text-brand-text select-none"
			>
				Hide thinking steps
			</label>
		</div>

		<div class="flex items-center gap-2 py-1">
			<input
				id="pi-beep-default"
				type="checkbox"
				bind:checked={localBeepDefault}
				onchange={handleConfigChange}
				class="h-4 w-4 rounded border-brand-border bg-brand-surface-2 text-brand-blue focus:ring-brand-blue focus:ring-offset-0"
			/>
			<label
				for="pi-beep-default"
				class="cursor-pointer text-xs text-brand-text select-none"
			>
				Beep when the agent is waiting (default for new sessions)
			</label>
		</div>

		<div>
			<label
				for="pi-beep-sound"
				class="mb-1 block text-xs text-brand-text-muted"
				>Beep sound URL (optional, blank = built-in chime)</label
			>
			<div class="flex gap-2">
				<input
					id="pi-beep-sound"
					type="text"
					bind:value={localBeepSoundUrl}
					onchange={handleConfigChange}
					placeholder="/sounds/complete.mp3 or https://..."
					class="w-full rounded border border-brand-border bg-brand-surface-2 px-3 py-2 text-sm text-brand-text placeholder-brand-text-muted focus:border-brand-blue focus:outline-none"
				/>
				<button
					type="button"
					onclick={handleTestBeep}
					title="Play the beep to test it"
					class="flex-shrink-0 rounded border border-brand-border bg-brand-surface-2 px-3 py-2 text-sm text-brand-text transition-colors hover:bg-brand-surface-3"
				>
					Test
				</button>
			</div>
		</div>

		<div class="space-y-2 border-t border-brand-border pt-3">
			<div class="flex items-center gap-2 py-1">
				<input
					id="pi-conversation-mode"
					type="checkbox"
					bind:checked={localConversationMode}
					onchange={handleConfigChange}
					class="h-4 w-4 rounded border-brand-border bg-brand-surface-2 text-brand-blue focus:ring-brand-blue focus:ring-offset-0"
				/>
				<label
					for="pi-conversation-mode"
					class="cursor-pointer text-xs font-medium text-brand-text select-none"
				>
					Conversation Mode by default (spoken back-and-forth)
				</label>
			</div>
			<p class="pl-6 text-[10px] leading-relaxed text-brand-text-muted">
				The DEFAULT for conversations you have not toggled: Conversation Mode is
				per conversation, and the 💬/🗣️ toggle above the composer sets it for
				the conversation you are in, leaving the others alone. Changing this
				default moves every conversation still following it. It flips the knobs
				below on at once; when off, they are dormant and the default
				typing-first experience is unchanged. Auto-send on speech end (Direct
				Send, in Speech Settings) keeps its own effect regardless.
			</p>

			<div class="flex items-center gap-2 py-1 pl-6">
				<input
					id="pi-speak-replies"
					type="checkbox"
					bind:checked={localSpeakReplies}
					onchange={handleConfigChange}
					class="h-4 w-4 rounded border-brand-border bg-brand-surface-2 text-brand-blue focus:ring-brand-blue focus:ring-offset-0"
				/>
				<label
					for="pi-speak-replies"
					class="cursor-pointer text-xs text-brand-text select-none"
				>
					Speak replies aloud (browser TTS)
				</label>
			</div>

			<div class="flex items-center gap-2 py-1 pl-6">
				<input
					id="pi-collapse-long-replies"
					type="checkbox"
					bind:checked={localCollapseLongReplies}
					onchange={handleConfigChange}
					class="h-4 w-4 rounded border-brand-border bg-brand-surface-2 text-brand-blue focus:ring-brand-blue focus:ring-offset-0"
				/>
				<label
					for="pi-collapse-long-replies"
					class="cursor-pointer text-xs text-brand-text select-none"
				>
					Collapse long written replies
				</label>
			</div>

			<div class="flex items-center gap-2 py-1 pl-6">
				<input
					id="pi-mic-reopen"
					type="checkbox"
					bind:checked={localMicReopensAfterReply}
					onchange={handleConfigChange}
					class="h-4 w-4 rounded border-brand-border bg-brand-surface-2 text-brand-blue focus:ring-brand-blue focus:ring-offset-0"
				/>
				<label
					for="pi-mic-reopen"
					class="cursor-pointer text-xs text-brand-text select-none"
				>
					Re-open mic after the agent speaks (hands-free)
				</label>
			</div>
			<p class="pl-6 text-[10px] leading-relaxed text-brand-text-muted">
				Applies to both speech engines. On the Cloud AI engine, which records
				until told to stop, an auto-opened mic stops itself on silence (and
				always within a minute), so a re-opened mic can never run away.
			</p>
		</div>

		<div class="flex gap-2">
			{#if connected}
				<button
					onclick={handleDisconnect}
					class="flex-1 rounded bg-rose-500 px-4 py-2 text-sm text-white transition-colors hover:bg-rose-600"
				>
					Disconnect
				</button>
			{:else}
				<button
					onclick={handleConnect}
					disabled={saving}
					class="flex-1 rounded bg-gradient-to-r from-brand-cyan to-brand-blue px-4 py-2 text-sm text-white transition-all hover:opacity-90 disabled:cursor-not-allowed disabled:from-brand-surface-3 disabled:to-brand-surface-3"
				>
					{saving ? 'Connecting...' : 'Connect'}
				</button>
			{/if}
		</div>

		<button
			onclick={handleReload}
			title="Reload the page"
			class="flex w-full items-center justify-center gap-2 rounded border border-brand-border bg-brand-surface-2 px-4 py-2 text-sm text-brand-text transition-colors hover:bg-brand-surface-3"
		>
			<svg
				xmlns="http://www.w3.org/2000/svg"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
				class="h-4 w-4"
				aria-hidden="true"
			>
				<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
				<path d="M21 3v5h-5" />
				<path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
				<path d="M8 16H3v5" />
			</svg>
			Reload
		</button>
	</div>
</div>
