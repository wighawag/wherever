<script lang="ts">
	// A small "Copy" button for a value shown in the settings (a pairing code, an
	// id, an error): copies `value` (clipboard.ts: the Clipboard API, else the
	// legacy execCommand fallback) and confirms with "Copied" for a moment. When
	// nothing can copy, it says to copy by hand (the value is `.selectable`).
	import {onDestroy} from 'svelte';
	import {copyText} from '$lib/core/clipboard';

	let {value, label = 'Copy'}: {value: string; label?: string} = $props();

	let copyState = $state<'idle' | 'copied' | 'failed'>('idle');
	let timer: ReturnType<typeof setTimeout> | null = null;

	async function copy() {
		copyState = (await copyText(value)) ? 'copied' : 'failed';
		if (timer) clearTimeout(timer);
		timer = setTimeout(
			() => (copyState = 'idle'),
			copyState === 'copied' ? 1500 : 4000,
		);
	}
	onDestroy(() => {
		if (timer) clearTimeout(timer);
	});
</script>

<button
	type="button"
	onclick={copy}
	title={copyState === 'failed'
		? 'Copying is not available here: select the text and copy it by hand'
		: `Copy ${value}`}
	class="flex-shrink-0 rounded border border-brand-border bg-brand-surface-2 px-2 py-0.5 text-[10px] text-brand-text transition-colors hover:bg-brand-surface-3"
>
	{copyState === 'copied'
		? 'Copied'
		: copyState === 'failed'
			? 'Select to copy'
			: label}
</button>
