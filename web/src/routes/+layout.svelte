<script lang="ts">
	import Notifications from '$lib/core/notifications/Notifications.svelte';
	import VersionAndInstallNotfications from '$lib/core/service-worker/VersionAndInstallNotfications.svelte';
	import {afterNavigate} from '$app/navigation';
	import {applyAppearance} from '$lib/theme';
	import {appearanceStore} from '$lib/session-store';
	import {scrubTokenFromUrl} from '$lib/core/token-adoption';
	import '../app.css';
	let {children} = $props();

	// A token handed to the browser in the URL (`#token=...`) is adopted at
	// module scope, which has to happen that early because the stored config is
	// read at module scope too. The SCRUB, however, cannot be finished there: the
	// router's initial navigation commits AFTER the route modules are imported
	// and re-stamps the history entry with the href it captured at boot, putting
	// the token back in the address bar (measured: ~12ms after the scrub). This
	// runs after that commit, and is idempotent, so a URL with no token is a
	// no-op. Without it the secret stays visible in the address bar and in
	// anything the user copies out of it.
	afterNavigate(() => {
		scrubTokenFromUrl();
	});

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
