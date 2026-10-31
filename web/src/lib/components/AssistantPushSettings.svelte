<script lang="ts">
	// The settings toggle for the assistant's Web Push (server/src/web-push.ts,
	// ADR 0017): subscribes or unsubscribes THIS device. Rendered by the page only
	// while the assistant is active and its Web Push channel runs, so with the
	// assistant off nothing of it shows.
	import {onMount} from 'svelte';
	import {
		isThisDeviceSubscribed,
		pushSupported,
		subscribeThisDevice,
		unsubscribeThisDevice,
		type DevicePushManager,
		type PushServerDeps,
	} from '$lib/core/push-subscription';
	import {fetchConfig, getBaseUrl, getToken} from '$lib/session-store';

	let supported = $state(false);
	let subscribed = $state(false);
	let busy = $state(true);
	let error = $state('');

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
				error = (err as Error).message;
			} finally {
				busy = false;
			}
		})();
	});

	async function toggle() {
		busy = true;
		error = '';
		try {
			const pm = await manager();
			if (subscribed) await unsubscribeThisDevice(pm, deps());
			else await subscribeThisDevice(pm, deps());
			subscribed = await isThisDeviceSubscribed(pm, deps());
			void fetchConfig();
		} catch (err) {
			error =
				typeof Notification !== 'undefined' &&
				Notification.permission === 'denied'
					? 'Notifications are blocked for this site in the browser settings.'
					: (err as Error).message;
		} finally {
			busy = false;
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
			<p class="pl-6 text-[10px] text-rose-400">{error}</p>
		{/if}
	{/if}
</div>
