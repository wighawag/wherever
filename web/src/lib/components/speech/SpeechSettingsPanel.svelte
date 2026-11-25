<script lang="ts">
	// The Speech Settings panel, extracted from SpeechButton so it can be mounted
	// anywhere (today: the popover behind the speech button's ⚙; next: the ⋯
	// session menu's "Voice settings…", task `chat-session-menu`). It holds no
	// state of its own: it reads and writes the shared speech settings store
	// (engine, locale, last error) and the autoSendOnSpeechEnd store (Direct
	// send), so a change here takes effect in the 🎤 button at once.
	//
	// It renders only the panel body; the caller provides the container (popover,
	// sheet section) and its positioning.
	import {
		autoSendOnSpeechEnd,
		setAutoSendOnSpeechEnd,
		speechSettings,
	} from '$lib/wherever';
	import {
		SPEECH_LOCALES,
		hasBrowserSpeechRecognition,
	} from '$lib/core/speech-settings';

	const {engine, locale, error} = speechSettings;
	const isBrowserSupported = hasBrowserSpeechRecognition();
</script>

<div class="text-xs text-white">
	<h4 class="mb-3 border-b border-gray-700 pb-1.5 font-semibold text-gray-300">
		Speech Settings
	</h4>

	<!-- Engine Selection -->
	<div class="mb-3.5">
		<span class="mb-1 block font-medium text-gray-400">
			Speech-to-Text Engine
		</span>
		<div class="flex gap-2">
			<button
				type="button"
				onclick={() => speechSettings.setEngine('browser')}
				disabled={!isBrowserSupported}
				aria-pressed={$engine === 'browser'}
				class="flex-1 rounded border px-2 py-1.5 text-center font-medium transition-colors disabled:opacity-40
					{$engine === 'browser'
					? 'border-blue-500 bg-blue-600 text-white'
					: 'border-gray-600 bg-gray-950 text-gray-400 hover:text-white'}"
			>
				On-Device
			</button>
			<button
				type="button"
				onclick={() => speechSettings.setEngine('cloud')}
				aria-pressed={$engine === 'cloud'}
				class="flex-1 rounded border px-2 py-1.5 text-center font-medium transition-colors
					{$engine === 'cloud'
					? 'border-blue-500 bg-blue-600 text-white'
					: 'border-gray-600 bg-gray-950 text-gray-400 hover:text-white'}"
			>
				Cloud AI
			</button>
		</div>
		<p class="mt-1 text-[10px] leading-relaxed text-gray-400">
			{$engine === 'browser'
				? 'Uses free built-in browser dictation. Streaming, zero-latency.'
				: 'Uses server-side Z.ai / Groq / OpenAI keys. High accent tolerance.'}
		</p>
	</div>

	<!-- Accent/Locale Selection (Only visible for Browser engine) -->
	{#if $engine === 'browser'}
		<div class="mb-3.5">
			<label for="speech-locale" class="mb-1 block font-medium text-gray-400">
				Accent / Locale
			</label>
			<select
				id="speech-locale"
				value={$locale}
				onchange={(e) => speechSettings.setLocale(e.currentTarget.value)}
				class="w-full rounded border border-gray-600 bg-gray-950 px-2 py-1.5 text-white focus:border-blue-500 focus:outline-none"
			>
				{#each SPEECH_LOCALES as loc}
					<option value={loc.code}>{loc.label}</option>
				{/each}
			</select>
		</div>
	{/if}

	<!-- Direct Send Toggle (= the conversation-mode autoSendOnSpeechEnd knob) -->
	<div class="mb-2">
		<label class="flex cursor-pointer items-center gap-2 py-1">
			<input
				type="checkbox"
				checked={$autoSendOnSpeechEnd}
				onchange={(e) => setAutoSendOnSpeechEnd(e.currentTarget.checked)}
				class="rounded border-gray-600 bg-gray-950 text-blue-600 focus:ring-0 focus:ring-offset-0"
			/>
			<span class="font-medium text-gray-300">Direct Send (Auto-dispatch)</span>
		</label>
		<p class="pl-6 text-[10px] leading-relaxed text-gray-400">
			When enabled, releasing or stopping the microphone immediately sends the
			message.
		</p>
	</div>

	{#if $error}
		<div
			class="mt-2 rounded border border-red-900/40 bg-red-950/40 p-2 leading-normal text-red-400"
		>
			{$error}
		</div>
	{/if}
</div>
