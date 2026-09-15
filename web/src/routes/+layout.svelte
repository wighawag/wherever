<script lang="ts">
	import Notifications from '$lib/core/notifications/Notifications.svelte';
	import VersionAndInstallNotfications from '$lib/core/service-worker/VersionAndInstallNotfications.svelte';
	import {applyAppearance} from '$lib/theme';
	import {appearanceStore} from '$lib/session-store';
	import '../app.css';
	let {children} = $props();

	// Appearance is painted here rather than where /config is fetched: it targets
	// the document element and the rules it drives live in the app.css this layout
	// owns, so this is the one component whose scope matches the effect's. Driving
	// it off the store (not off the fetch) also means any future writer re-themes
	// too, and connecting to another instance cannot leave a stale palette behind.
	$effect(() => {
		applyAppearance($appearanceStore);
	});
</script>

{@render children()}

<Notifications />

<VersionAndInstallNotfications src="" alt="" />
