<script lang="ts">
	import {onMount} from 'svelte';
	import {autoSendOnSpeechEnd, setAutoSendOnSpeechEnd} from '$lib/wherever';
	import {unlockTts} from '$lib/core/speak';
	import {
		createAutoStopDetector,
		frameLevel,
		type AutoStopDetector,
	} from '$lib/core/hands-free';

	let {
		text = $bindable(),
		disabled,
		onSend,
		activeEngine = $bindable('browser'),
	}: {
		text: string;
		disabled: boolean;
		onSend?: () => void;
		// The speech engine currently in use, mirrored out to the parent so the
		// hands-free mic-reopen loop can see it (both engines auto-record; the cloud
		// one additionally auto-STOPS, see autoStopDetector below). Bindable so a
		// parent can read it reactively; SpeechButton owns the value (the settings
		// popover sets it), the parent only observes.
		activeEngine?: 'browser' | 'cloud';
	} = $props();

	// Check for Web Speech API support
	const SpeechRecognition =
		typeof window !== 'undefined'
			? (window as any).SpeechRecognition ||
				(window as any).webkitSpeechRecognition
			: null;
	const isBrowserSupported = !!SpeechRecognition;

	// State
	let isRecording = $state(false);
	let isProcessing = $state(false);
	let isHolding = $state(false);
	let showSettings = $state(false);
	let directSend = $state(false);
	let locale = $state('en-US');
	let engine = $state<'browser' | 'cloud'>('browser');
	let speechError = $state<string | null>(null);

	// Keep the bindable `activeEngine` prop in lockstep with the internal engine
	// choice so the parent (the hands-free loop) always sees the live engine.
	$effect(() => {
		activeEngine = engine;
	});

	// Gesture & API Tracking
	let pressTimer = $state<any>(null);
	let recognitionInstance: any = null;

	// Direct WAV / Web Audio PCM Recording State
	let audioContext: AudioContext | null = null;
	let micSource: MediaStreamAudioSourceNode | null = null;
	let scriptProcessor: any = null;
	let audioStream: MediaStream | null = null;
	let pcmChunks: Float32Array[] = [];
	// Set ONLY for a recording the hands-free loop opened on the CLOUD engine.
	// That engine has no endpointing of its own (it records until told to stop), so
	// an auto-opened recording needs an auto-stop: silence after speech ends the
	// turn, and a hard ceiling means a hot mic can never run away. A recording the
	// user opened by TAPPING is left alone -- their next tap is the stop, and
	// taking that away would be the surprising behaviour.
	let autoStopDetector: AutoStopDetector | null = null;

	let baseText = '';
	let textModified = false;

	const locales = [
		{code: 'en-US', label: 'English (US)'},
		{code: 'en-GB', label: 'English (UK)'},
		{code: 'en-IN', label: 'English (India)'},
		{code: 'en-AU', label: 'English (Australia)'},
		{code: 'en-CA', label: 'English (Canada)'},
		{code: 'en-ZA', label: 'English (South Africa)'},
	];

	// directSend IS the conversation-mode `autoSendOnSpeechEnd` knob: it shares the
	// single `wherever-speech-direct-send` home via the autoSendOnSpeechEnd store
	// (see wherever.ts), so a change here or in the settings UI is reflected in the
	// other without a forked second flag.
	const unsubscribeDirectSend = autoSendOnSpeechEnd.subscribe((v) => {
		directSend = v;
	});

	onMount(() => {
		// Load preferences (directSend is loaded via the autoSendOnSpeechEnd store).
		const storedLocale = localStorage.getItem('wherever-speech-locale');
		if (storedLocale !== null) {
			locale = storedLocale;
		}
		const storedEngine = localStorage.getItem('wherever-speech-engine');
		if (storedEngine !== null) {
			engine = storedEngine as 'browser' | 'cloud';
		} else if (!isBrowserSupported) {
			engine = 'cloud'; // Default to cloud if browser doesn't support Web Speech API
		}

		// Cleanup on destroy
		return () => {
			unsubscribeDirectSend();
			if (recognitionInstance) {
				try {
					recognitionInstance.abort();
				} catch (e) {}
			}
			if (scriptProcessor) {
				try {
					scriptProcessor.disconnect();
				} catch {}
			}
			if (micSource) {
				try {
					micSource.disconnect();
				} catch {}
			}
			if (audioStream) {
				try {
					audioStream.getTracks().forEach((track) => track.stop());
				} catch {}
			}
			if (audioContext) {
				try {
					audioContext.close();
				} catch {}
			}
			if (pressTimer) clearTimeout(pressTimer);
		};
	});

	function savePreferences() {
		// directSend persists via its shared store (single canonical home) so the
		// conversation-mode autoSendOnSpeechEnd knob and this toggle stay in sync.
		setAutoSendOnSpeechEnd(directSend);
		localStorage.setItem('wherever-speech-locale', locale);
		localStorage.setItem('wherever-speech-engine', engine);
	}

	function getBaseUrl(): string {
		const config = localStorage.getItem('wherever-config');
		const parsed = config ? JSON.parse(config) : null;
		// host/port are checked before being dereferenced because the stored config
		// is not guaranteed to carry them: a token adopted from a `#token=` link on
		// a browser that never opened Connection Settings writes the token field
		// alone. Fall back to this page's own origin, as the final return does.
		if (parsed && parsed.host && parsed.port) {
			const protocol =
				window.location.protocol === 'https:' ? 'https:' : 'http:';
			const host = parsed.host.startsWith('http')
				? parsed.host.replace(/^wss?:\/\//, '')
				: parsed.host;
			return `${protocol}//${host}:${parsed.port}`;
		}
		return `${window.location.protocol}//${window.location.host}`;
	}

	function getToken(): string {
		try {
			const config = localStorage.getItem('wherever-config');
			if (config) {
				const parsed = JSON.parse(config);
				return parsed.token || '';
			}
		} catch {}
		return '';
	}

	// Synthesize a brief audible beep to indicate recording start
	function playBeep() {
		try {
			const AudioContextClass =
				window.AudioContext || (window as any).webkitAudioContext;
			if (!AudioContextClass) return;
			const ctx = new AudioContextClass();
			const osc = ctx.createOscillator();
			const gain = ctx.createGain();

			osc.type = 'sine';
			osc.frequency.setValueAtTime(400, ctx.currentTime); // 400 Hz tone

			gain.gain.setValueAtTime(0.08, ctx.currentTime);
			gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12); // smooth fade out

			osc.connect(gain);
			gain.connect(ctx.destination);

			osc.start();
			osc.stop(ctx.currentTime + 0.12);
		} catch (e) {
			console.warn('Could not play audio beep feedback:', e);
		}
	}

	// Downsamples audio buffers to target sample rate (e.g. 16kHz)
	function downsampleBuffer(
		buffer: Float32Array,
		inputSampleRate: number,
		outputSampleRate: number,
	): Float32Array {
		if (inputSampleRate === outputSampleRate) {
			return buffer;
		}
		const sampleRateRatio = inputSampleRate / outputSampleRate;
		const newLength = Math.round(buffer.length / sampleRateRatio);
		const result = new Float32Array(newLength);
		let offsetResult = 0;
		let offsetBuffer = 0;
		while (offsetResult < result.length) {
			const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio);
			let accum = 0;
			let count = 0;
			for (
				let i = offsetBuffer;
				i < nextOffsetBuffer && i < buffer.length;
				i++
			) {
				accum += buffer[i];
				count++;
			}
			result[offsetResult] = count > 0 ? accum / count : 0;
			offsetResult++;
			offsetBuffer = nextOffsetBuffer;
		}
		return result;
	}

	// ==========================================
	// NATIVE BROWSER SPEECH RECOGNITION (STREAMING)
	// ==========================================
	function startBrowserRecording() {
		if (!isBrowserSupported) return;
		try {
			recognitionInstance = new SpeechRecognition();
			recognitionInstance.continuous = true;
			recognitionInstance.interimResults = true;
			recognitionInstance.lang = locale;

			recognitionInstance.onstart = () => {
				isRecording = true;
				isProcessing = false;
				playBeep();
			};

			recognitionInstance.onresult = (event: any) => {
				let finalSessionText = '';
				let interimSessionText = '';

				for (let i = event.resultIndex; i < event.results.length; ++i) {
					const result = event.results[i];
					if (result.isFinal) {
						finalSessionText += result[0].transcript;
					} else {
						interimSessionText += result[0].transcript;
					}
				}

				const sessionText = (finalSessionText + interimSessionText).trim();
				if (sessionText) {
					textModified = true;
					text = baseText + (baseText ? ' ' : '') + sessionText;
				}
			};

			recognitionInstance.onerror = (event: any) => {
				console.error('Browser speech recognition error:', event.error);
				if (event.error !== 'no-speech') {
					speechError = `Error: ${event.error}`;
				}
				stopBrowserRecording();
			};

			recognitionInstance.onend = () => {
				isRecording = false;
				if (directSend && textModified && onSend) {
					setTimeout(() => {
						if (text.trim()) {
							onSend();
						}
					}, 50);
				}
			};

			recognitionInstance.start();
			if (navigator.vibrate) {
				navigator.vibrate(40);
			}
		} catch (e: any) {
			console.error('Failed to start browser speech recognition:', e);
			speechError = 'Failed to start browser recording';
			isRecording = false;
		}
	}

	function stopBrowserRecording() {
		if (recognitionInstance) {
			try {
				recognitionInstance.stop();
			} catch (e) {}
		}
		isRecording = false;
	}

	// ==========================================
	// CLOUD SERVER-ASSISTED SPEECH TRANSCRIPTION
	// ==========================================
	async function startCloudRecording() {
		try {
			const stream = await navigator.mediaDevices.getUserMedia({audio: true});
			audioStream = stream;
			pcmChunks = [];

			const AudioContextClass =
				window.AudioContext || (window as any).webkitAudioContext;
			audioContext = new AudioContextClass();

			micSource = audioContext.createMediaStreamSource(stream);

			// ScriptProcessor is widely supported and simpler than module-registered AudioWorklet
			scriptProcessor = audioContext.createScriptProcessor(4096, 1, 1);
			scriptProcessor.onaudioprocess = (event: any) => {
				const inputBuffer = event.inputBuffer.getChannelData(0);
				// Push a snapshot/copy of Float32 audio samples
				pcmChunks.push(new Float32Array(inputBuffer));
				// Hands-free auto-stop, driven by the audio we are already capturing (a
				// wall-clock timer would keep running while a backgrounded tab is
				// throttled and the mic is not actually delivering frames).
				if (!autoStopDetector) return;
				const sampleRate = event.inputBuffer.sampleRate || 44100;
				const frameMs = (inputBuffer.length / sampleRate) * 1000;
				if (
					autoStopDetector.push(frameLevel(inputBuffer), frameMs) !==
					'keep-recording'
				) {
					autoStopDetector = null;
					stopRecording();
				}
			};

			micSource.connect(scriptProcessor);
			scriptProcessor.connect(audioContext.destination);

			isRecording = true;
			isProcessing = false;
			playBeep();

			if (navigator.vibrate) {
				navigator.vibrate(40);
			}
		} catch (err: any) {
			console.error('Failed to start cloud audio recording:', err);
			speechError = err.message || 'Microphone access denied';
			isRecording = false;
			isProcessing = false;
			autoStopDetector = null;
		}
	}

	function stopCloudRecording() {
		if (isRecording) {
			isRecording = false;
			isProcessing = true;

			if (scriptProcessor) {
				try {
					scriptProcessor.disconnect();
				} catch {}
				scriptProcessor.onaudioprocess = null;
			}
			if (micSource) {
				try {
					micSource.disconnect();
				} catch {}
			}
			if (audioStream) {
				try {
					audioStream.getTracks().forEach((track) => track.stop());
				} catch {}
			}

			// Decouple processing asynchronously to prevent UI freezing
			processCloudTranscription();
		}
	}

	async function processCloudTranscription() {
		try {
			if (pcmChunks.length === 0) {
				isProcessing = false;
				return;
			}

			speechError = null;

			// Concatenate Float32 chunks
			let totalLength = 0;
			for (const chunk of pcmChunks) {
				totalLength += chunk.length;
			}

			const flatBuffer = new Float32Array(totalLength);
			let offset = 0;
			for (const chunk of pcmChunks) {
				flatBuffer.set(chunk, offset);
				offset += chunk.length;
			}

			// Downsample to 16kHz (Server transcriber standard)
			const originalSampleRate = audioContext ? audioContext.sampleRate : 48000;
			const targetSampleRate = 16000;
			const downsampledBuffer = downsampleBuffer(
				flatBuffer,
				originalSampleRate,
				targetSampleRate,
			);

			// Encode directly to mono 16-bit PCM WAV buffer
			const wavBuffer = createWav(
				downsampledBuffer,
				1,
				targetSampleRate,
				1,
				16,
			);
			const wavBlob = new Blob([wavBuffer], {type: 'audio/wav'});

			const baseUrl = getBaseUrl();
			const token = getToken();
			const url = `${baseUrl}/session/transcribe${token ? `?token=${encodeURIComponent(token)}` : ''}`;

			const res = await fetch(url, {
				method: 'POST',
				body: wavBlob,
				headers: {
					'Content-Type': 'application/octet-stream',
				},
			});

			const data = await res.json();
			if (!res.ok) {
				throw new Error(data.error || `HTTP ${res.status}`);
			}

			if (data.text && data.text.trim()) {
				textModified = true;
				text = baseText + (baseText ? ' ' : '') + data.text.trim();

				// Auto dispatch if enabled
				if (directSend && onSend) {
					setTimeout(() => {
						if (text.trim()) {
							onSend();
						}
					}, 50);
				}
			}
		} catch (err: any) {
			console.error('Cloud transcription request failed:', err);
			speechError = err.message || 'Cloud API failed';
		} finally {
			isProcessing = false;
			if (audioContext) {
				try {
					audioContext.close();
				} catch {}
				audioContext = null;
			}
		}
	}

	// ==========================================
	// GESTURE & INTERACTION DISPATCHERS
	// ==========================================
	// `autoStop` is set ONLY by the hands-free loop (see
	// startRecordingProgrammatically). A manual tap always clears the detector, so a
	// user-opened recording is never ended for them.
	function startRecording(autoStop = false) {
		if (disabled || isRecording || isProcessing) return;
		speechError = null;
		textModified = false;
		baseText = text;
		autoStopDetector =
			autoStop && engine === 'cloud' ? createAutoStopDetector() : null;

		if (engine === 'cloud') {
			startCloudRecording();
		} else {
			startBrowserRecording();
		}
	}

	// Public: programmatically start recording, for the hands-free mic-reopen loop
	// (BOTH engines: the user's consent lives in the micReopensAfterReply config
	// knob, not in a per-conversation gesture; see core/hands-free.ts). Exposed via
	// bind:this so the settle-edge driver in ChatInput can re-open the mic after a
	// reply settles, exactly as a manual tap would. Guarded by the same
	// disabled/recording checks as a user gesture.
	//
	// The cloud engine additionally gets an auto-STOP for this recording, since it
	// would otherwise record until a tap -- the very tap the hands-free loop exists
	// to remove.
	export function startRecordingProgrammatically() {
		startRecording(true);
	}

	function stopRecording() {
		autoStopDetector = null;
		if (engine === 'cloud') {
			stopCloudRecording();
		} else {
			stopBrowserRecording();
		}
	}

	function handlePointerDown(e: PointerEvent) {
		if (e.button !== 0) return; // Only left click / main touch
		if (disabled) return;

		// Second TTS gesture-unlock point (the first is the Conversation Mode
		// toggle). Tapping the mic is the other unmistakable "I want a spoken
		// exchange" gesture, and it is the one that covers a RETURNING user whose
		// conversation mode was already persisted ON: they never tap the toggle, so
		// without this the gesture-less `say` utterance would still be dropped on
		// mobile. Silent, idempotent and a no-op where speechSynthesis is absent (see
		// core/speak.ts), so it costs nothing when the user only wants dictation.
		// Note the gesture-less startRecordingProgrammatically() path deliberately
		// does NOT unlock -- there is no user activation there to consume.
		unlockTts();

		e.preventDefault();
		if (isRecording) {
			stopRecording();
			return;
		}

		isHolding = false;
		pressTimer = setTimeout(() => {
			isHolding = true;
			startRecording();
		}, 350);
	}

	function handlePointerUp(e: PointerEvent) {
		if (pressTimer) {
			clearTimeout(pressTimer);
			pressTimer = null;
		}

		if (isHolding) {
			isHolding = false;
			stopRecording();
		} else if (!isRecording) {
			startRecording();
		}
	}

	function handlePointerCancel() {
		if (pressTimer) {
			clearTimeout(pressTimer);
			pressTimer = null;
		}
		if (isHolding) {
			isHolding = false;
			stopRecording();
		}
	}

	// ==========================================
	// CLIENT-SIDE WAV ENCODER
	// ==========================================
	function audioBufferToWav(buffer: AudioBuffer): ArrayBuffer {
		const numOfChan = buffer.numberOfChannels;
		const sampleRate = buffer.sampleRate;
		const format = 1; // Raw PCM
		const bitDepth = 16;

		let result;
		if (numOfChan === 2) {
			result = interleave(buffer.getChannelData(0), buffer.getChannelData(1));
		} else {
			result = buffer.getChannelData(0);
		}

		return createWav(result, numOfChan, sampleRate, format, bitDepth);
	}

	function interleave(
		inputL: Float32Array,
		inputR: Float32Array,
	): Float32Array {
		const length = inputL.length + inputR.length;
		const result = new Float32Array(length);
		let index = 0;
		let inputIndex = 0;

		while (index < length) {
			result[index++] = inputL[inputIndex];
			result[index++] = inputR[inputIndex];
			inputIndex++;
		}
		return result;
	}

	function createWav(
		samples: Float32Array,
		numOfChan: number,
		sampleRate: number,
		format: number,
		bitDepth: number,
	): ArrayBuffer {
		const buffer = new ArrayBuffer(44 + samples.length * 2);
		const view = new DataView(buffer);

		/* RIFF identifier */
		writeString(view, 0, 'RIFF');
		/* file length */
		view.setUint32(4, 36 + samples.length * 2, true);
		/* RIFF type */
		writeString(view, 8, 'WAVE');
		/* format chunk identifier */
		writeString(view, 12, 'fmt ');
		/* format chunk length */
		view.setUint32(16, 16, true);
		/* sample format (raw PCM) */
		view.setUint16(20, format, true);
		/* channel count */
		view.setUint16(22, numOfChan, true);
		/* sample rate */
		view.setUint32(24, sampleRate, true);
		/* byte rate (sample rate * block align) */
		view.setUint32(28, sampleRate * numOfChan * (bitDepth / 8), true);
		/* block align (channel count * bytes per sample) */
		view.setUint16(32, numOfChan * (bitDepth / 8), true);
		/* bits per sample */
		view.setUint16(34, bitDepth, true);
		/* data chunk identifier */
		writeString(view, 36, 'data');
		/* data chunk length */
		view.setUint32(40, samples.length * 2, true);

		floatTo16BitPCM(view, 44, samples);

		return buffer;
	}

	function floatTo16BitPCM(
		output: DataView,
		offset: number,
		input: Float32Array,
	) {
		for (let i = 0; i < input.length; i++, offset += 2) {
			let s = Math.max(-1, Math.min(1, input[i]));
			output.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
		}
	}

	function writeString(view: DataView, offset: number, string: string) {
		for (let i = 0; i < string.length; i++) {
			view.setUint8(offset + i, string.charCodeAt(i));
		}
	}
</script>

<div class="relative flex shrink-0 items-center gap-1 select-none">
	<!-- Mic Button -->
	<button
		type="button"
		disabled={(disabled && !isRecording && !isProcessing) || isProcessing}
		onpointerdown={handlePointerDown}
		onpointerup={handlePointerUp}
		onpointercancel={handlePointerCancel}
		class="flex h-[48px] w-[48px] items-center justify-center rounded-lg border transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-40
			{isRecording
			? 'animate-pulse border-red-500 bg-red-600 text-white'
			: isProcessing
				? 'cursor-wait border-amber-500 bg-amber-600 text-white'
				: 'border-gray-600 bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-white'}"
		title={isRecording
			? 'Recording (release/tap to stop)...'
			: isProcessing
				? 'Processing speech...'
				: 'Hold to speak (walkie-talkie) or Tap to toggle recording'}
	>
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
			class="h-5 w-5"
		>
			<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
			<path d="M19 10v2a7 7 0 0 1-14 0v-2" />
			<line x1="12" x2="12" y1="19" y2="22" />
		</svg>
	</button>

	<!-- Settings Cog Button -->
	<button
		type="button"
		onclick={() => (showSettings = !showSettings)}
		disabled={(disabled && !isRecording && !isProcessing) || isProcessing}
		class="flex h-[48px] w-[28px] items-center justify-center rounded-lg border border-gray-600 bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
		title="Speech Settings"
	>
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
			class="h-4 w-4 transition-transform duration-200 {showSettings
				? 'rotate-45 text-white'
				: ''}"
		>
			<circle cx="12" cy="12" r="3" />
			<path
				d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
			/>
		</svg>
	</button>

	<!-- Settings Popover -->
	{#if showSettings}
		<!-- Click Outside Backdrop -->
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="fixed inset-0 z-40"
			onclick={() => (showSettings = false)}
		></div>

		<div
			class="absolute right-0 bottom-14 z-50 w-64 rounded-lg border border-gray-600 bg-gray-800 p-4 text-xs text-white shadow-xl"
		>
			<h4
				class="mb-3 border-b border-gray-700 pb-1.5 font-semibold text-gray-300"
			>
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
						onclick={() => {
							engine = 'browser';
							savePreferences();
						}}
						disabled={!isBrowserSupported}
						class="flex-1 rounded border px-2 py-1.5 text-center font-medium transition-colors disabled:opacity-40
							{engine === 'browser'
							? 'border-blue-500 bg-blue-600 text-white'
							: 'border-gray-600 bg-gray-950 text-gray-400 hover:text-white'}"
					>
						On-Device
					</button>
					<button
						type="button"
						onclick={() => {
							engine = 'cloud';
							savePreferences();
						}}
						class="flex-1 rounded border px-2 py-1.5 text-center font-medium transition-colors
							{engine === 'cloud'
							? 'border-blue-500 bg-blue-600 text-white'
							: 'border-gray-600 bg-gray-950 text-gray-400 hover:text-white'}"
					>
						Cloud AI
					</button>
				</div>
				<p class="mt-1 text-[10px] leading-relaxed text-gray-400">
					{engine === 'browser'
						? 'Uses free built-in browser dictation. Streaming, zero-latency.'
						: 'Uses server-side Z.ai / Groq / OpenAI keys. High accent tolerance.'}
				</p>
			</div>

			<!-- Accent/Locale Selection (Only visible for Browser engine) -->
			{#if engine === 'browser'}
				<div class="mb-3.5">
					<label
						for="speech-locale"
						class="mb-1 block font-medium text-gray-400"
					>
						Accent / Locale
					</label>
					<select
						id="speech-locale"
						bind:value={locale}
						onchange={savePreferences}
						class="w-full rounded border border-gray-600 bg-gray-950 px-2 py-1.5 text-white focus:border-blue-500 focus:outline-none"
					>
						{#each locales as loc}
							<option value={loc.code}>{loc.label}</option>
						{/each}
					</select>
				</div>
			{/if}

			<!-- Direct Send Toggle -->
			<div class="mb-2">
				<label class="flex cursor-pointer items-center gap-2 py-1">
					<input
						type="checkbox"
						bind:checked={directSend}
						onchange={savePreferences}
						class="rounded border-gray-600 bg-gray-950 text-blue-600 focus:ring-0 focus:ring-offset-0"
					/>
					<span class="font-medium text-gray-300"
						>Direct Send (Auto-dispatch)</span
					>
				</label>
				<p class="pl-6 text-[10px] leading-relaxed text-gray-400">
					When enabled, releasing or stopping the microphone immediately sends
					the message.
				</p>
			</div>

			{#if speechError}
				<div
					class="mt-2 rounded border border-red-900/40 bg-red-950/40 p-2 leading-normal text-red-400"
				>
					{speechError}
				</div>
			{/if}
		</div>
	{/if}
</div>
