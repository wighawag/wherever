<script lang="ts">
	// One shipmates delivery in the chat: messages other sessions (or the human,
	// through one) sent into this session. Never a user message, so no fork, no
	// edit, no delivery state; the text the agent read stays one click away.
	import type {ChatMessage} from '@wherever-dev/client';
	import {
		describeShipmatesDelivery,
		originBadge,
		senderName,
	} from '$lib/core/shipmates-delivery';
	import {sessionFolders, readOnlySessionFolders} from '$lib/session-store';

	let {msg}: {msg: ChatMessage} = $props();

	const card = $derived(
		describeShipmatesDelivery(
			msg.content,
			msg.shipmates ?? {ids: [], from: [], origins: []},
		),
	);

	// Senders named the way the sidebar names sessions (shipmates labels a session
	// without a role by its transcript path).
	const listed = $derived(
		new Map(
			[...$sessionFolders.folders, ...$readOnlySessionFolders.folders]
				.flatMap((f) => f.sessions)
				.map((s) => [s.path, s]),
		),
	);
	const name = (label: string) => senderName(label, listed);

	const toneClass = {
		agent: 'bg-brand-surface-3 text-brand-text-muted ring-brand-border',
		human: 'bg-emerald-500/15 text-emerald-300 ring-emerald-400/40',
		relayed: 'bg-amber-500/15 text-amber-300 ring-amber-400/40',
		other: 'bg-brand-surface-3 text-brand-text-muted ring-brand-border',
	} as const;
</script>

<div class="chat-selectable flex flex-col gap-2" data-shipmates-card>
	<div
		class="flex flex-wrap items-center gap-1.5 text-xs font-medium text-brand-text-muted"
	>
		<span aria-hidden="true">📨</span>
		{#if card.spawnFrom}
			<span class="text-brand-text" title={card.spawnFrom}
				>First prompt from {name(card.spawnFrom)}</span
			>
		{:else}
			<span class="text-brand-text">
				{card.items.length > 1
					? `${card.items.length} ${card.notice ? 'notices' : 'messages'}`
					: card.notice
						? 'Notice'
						: 'Message'}
				{#if card.senders.length}from {card.senders.map(name).join(', ')}{/if}
			</span>
		{/if}
	</div>
	{#each card.items as item, i (item.id ?? i)}
		{@const badge = originBadge(item.origin)}
		<div
			class="flex flex-col gap-1 {i > 0
				? 'border-t border-brand-border/60 pt-2'
				: ''}"
		>
			<div class="flex flex-wrap items-center gap-1.5 text-xs">
				{#if card.items.length > 1}
					<span class="font-medium text-brand-text" title={item.from}
						>{name(item.from)}</span
					>
				{/if}
				<span
					class="rounded px-1.5 py-0.5 font-mono text-[10px] ring-1 {toneClass[
						badge.tone
					]}"
					title="shipmates origin: who stands behind these words"
					data-shipmates-origin={item.origin}>{badge.label}</span
				>
				{#if item.kind && item.kind !== 'spawn'}
					<span class="text-brand-text-muted">{item.kind}</span>
				{/if}
			</div>
			<div class="text-sm leading-relaxed wrap-anywhere whitespace-pre-wrap">
				{item.body}
			</div>
		</div>
	{/each}
	<details class="text-xs text-brand-text-muted">
		<summary class="cursor-pointer select-none hover:text-brand-text"
			>As the agent read it</summary
		>
		<pre
			class="mt-1 font-mono text-[11px] wrap-anywhere whitespace-pre-wrap">{msg.content}</pre>
	</details>
</div>
