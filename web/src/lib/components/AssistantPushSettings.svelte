<script lang="ts">
	// The settings toggle for the assistant's Web Push (server/src/web-push.ts,
	// ADR 0017): subscribes or unsubscribes THIS device. Rendered by the page only
	// while the assistant is active and its Web Push channel runs, so with the
	// assistant off nothing of it shows.
	import {onMount} from 'svelte';
	import {
		applyPushToggle,
		describePushError,
		isThisDeviceSubscribed,
		pushSupported,
		sendTestNotification,
		type DevicePushManager,
		type PushServerDeps,
	} from '$lib/core/push-subscription';
	import {fetchConfig, getBaseUrl, getToken} from '$lib/session-store';

	// The session this device has open: a test notification opens it (none: the
	// main screen).
	let {currentSessionId = null}: {currentSessionId?: string | null} = $props();

	let supported = $state(false);
	let subscribed = $state(false);
	let busy = $state(true);
	let error = $state('');
	let testing = $state(false);
	let testResult = $state('');
	let testError = $state('');
	let checkbox: HTMLInputElement | undefined = $state();

	const permission = () =>
		typeof Notification !== 'undefined' ? Notification.permission : undefined;

	const deps = (): PushServerDeps => ({
		baseUrl: getBaseUrl(),
		token: getToken(),
		fetch: (url, init) => fetch(url, init),
	});

	async function manager(): Promise<DevicePushManager> {
		const registration = await navigator.serviceWorker.ready;
		return registration.pushManager as unknown as DevicePushManager;
	}

	onMount(() => {
		supported = pushSupported();
		if (!supported) {
			busy = false;
			return;
		}
		void (async () => {
			try {
				subscribed = await isThisDeviceSubscribed(await manager(), deps());
			} catch (err) {
				error = describePushError(err, permission());
			} finally {
				busy = false;
			}
		})();
	});

	async function toggle() {
		busy = true;
		error = '';
		testResult = '';
		testError = '';
		const want = !subscribed;
		try {
			const r = await applyPushToggle(
				await manager(),
				deps(),
				want,
				permission,
			);
			subscribed = r.subscribed;
			error = r.error;
			void fetchConfig();
		} catch (err) {
			// The service worker itself is unavailable: nothing changed.
			error = describePushError(err, permission());
		} finally {
			// `checked={subscribed}` is one-way: the click already flipped the box,
			// and an unchanged `subscribed` would not flip it back. Always show
			// the real state.
			if (checkbox) checkbox.checked = subscribed;
			busy = false;
		}
	}

	async function sendTest() {
		testing = true;
		testResult = '';
		testError = '';
		try {
			testResult = await sendTestNotification(deps(), currentSessionId);
		} catch (err) {
			testError = (err as Error).message;
		} finally {
			testing = false;
		}
	}
</script>

<div class="border-t border-brand-border p-4">
	<h3
		class="mb-3 text-xs font-bold tracking-wider text-brand-text-muted uppercase"
	>
		Assistant notifications
	</h3>
	{#if !supported}
		<p class="text-xs text-brand-text-muted">
			This browser cannot receive push notifications (on iOS, add wherever to
			the home screen first).
		</p>
	{:else}
		<div class="flex items-center gap-2 py-1">
			<input
				id="assistant-push"
				type="checkbox"
				bind:this={checkbox}
				checked={subscribed}
				disabled={busy}
				onchange={toggle}
				class="h-4 w-4 rounded border-brand-border bg-brand-surface-2 text-brand-blue focus:ring-brand-blue focus:ring-offset-0"
			/>
			<label
				for="assistant-push"
				class="cursor-pointer text-xs text-brand-text select-none"
			>
				Push notifications on this device
			</label>
		</div>
		<p class="pl-6 text-[10px] leading-relaxed text-brand-text-muted">
			Only when an agent deliberately notifies you (assistant_notify); tapping
			one opens the session it is about.
		</p>
		{#if error}
			<p
				class="selectable pl-6 text-[10px] leading-relaxed break-words text-rose-400"
			>
				{error}
			</p>
		{/if}
		{#if subscribed}
			<div class="mt-2 pl-6">
				<button
					type="button"
					onclick={sendTest}
					disabled={testing || busy}
					class="rounded border border-brand-border bg-brand-surface-2 px-2 py-1 text-xs text-brand-text transition-colors hover:bg-brand-surface-3 disabled:opacity-50"
					title="Send a notification through the server, as an agent's assistant_notify does"
				>
					{testing ? 'Sending…' : 'Send test notification'}
				</button>
				{#if testResult}
					<p
						class="selectable mt-1 text-[10px] leading-relaxed text-emerald-400"
					>
						{testResult}
					</p>
				{/if}
				{#if testError}
					<p
						class="selectable mt-1 text-[10px] leading-relaxed break-words text-rose-400"
					>
						{testError}
					</p>
				{/if}
			</div>
		{/if}
	{/if}
</div>
