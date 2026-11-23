<script lang="ts">
	import '../app.css';
	import {url} from '$lib/core/utils/web/path';

	const githubPath =
		'M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z';

	const surfaces = [
		'Web dashboard',
		'Installable PWA',
		'Terminal',
		'Telegram',
		'Push notifications',
	];

	const assistantPoints = [
		{
			title: 'A folder for memory, a session you can reset',
			description:
				'The assistant lives in a folder of your choosing. It writes what it learns there, so you can reset the conversation at any time without it forgetting who you are.',
		},
		{
			title: 'Schedules that follow you',
			description:
				'Agents can add recurring (cron) or one-shot jobs: a morning briefing, a check in thirty minutes. Times follow your current timezone, so a reminder moves with you when you travel.',
		},
		{
			title: 'Long work in the background',
			description:
				'Slow tasks run as isolated jobs in their own fresh session, in parallel, while your conversation stays free.',
		},
		{
			title: 'It reaches you, and only you',
			description:
				'Push notifications on every subscribed device, and a private Telegram bot paired with a one-time code. Chat, send photos and documents, get files back, stop or reset it with a word.',
		},
		{
			title: 'Every session can hand off to it',
			description:
				'Any session, in the browser or in a terminal, can schedule work for the assistant or notify you through it.',
		},
	];

	const shipmatesPoints = [
		{
			title: 'Presence',
			description:
				'Each live session shows its role, its state (running, waiting for you, waiting on another session) and a one-line status, right in the sidebar.',
		},
		{
			title: 'Messages with provenance',
			description:
				'Sessions tell and ask each other things. Every delivery appears in the chat as a card that says who sent it and whether the words came from an agent or from you.',
		},
		{
			title: 'One "Needs you" inbox',
			description:
				'Questions any session raises land in a single inbox, with a count on the tab title and on the installed app icon. Answer from the dashboard, or tap a button on Telegram.',
		},
		{
			title: 'Sessions that spawn sessions',
			description:
				'An agent can start helper sessions. They show up under their owner in the sidebar, and deleting an owner takes its subtree with it, with a seven day undo.',
		},
	];

	const features = [
		{
			title: 'All Your Sessions, Anywhere',
			description:
				'Every session across your project folders in one sidebar: start new ones, resume or fork old ones, and see at a glance which ones an agent is working in.',
			icon: 'folder',
		},
		{
			title: 'Session Mirroring & Handover',
			description:
				'Terminal and browser stay in sync in real time. Close the terminal and the server keeps the session going headless; open it again and control comes back with nothing lost.',
			icon: 'mirror',
		},
		{
			title: 'Made for Flaky Links',
			description:
				'Reopen the app and the conversation is there at once from an on-device cache. Chunked, compressed frames and resumable uploads keep working on a weak mobile signal.',
			icon: 'signal',
		},
		{
			title: 'Conversation Mode',
			description:
				'Dictate hands-free with the browser or a cloud speech engine, have replies spoken back, and let the mic reopen after each answer. Set per conversation.',
			icon: 'voice',
		},
		{
			title: 'Files Both Ways',
			description:
				'Drop screenshots and documents into a message with real upload progress, and download whatever the agent attaches for you, from any device.',
			icon: 'upload',
		},
		{
			title: 'Shell from the Browser',
			description:
				'Prefix a message with ! to run a command directly, with streamed output. A !sudo command asks for the password once and never stores it.',
			icon: 'terminal',
		},
		{
			title: 'Search Everything',
			description:
				'Full-text search across every conversation you ever had, in every project, and jump straight to the moment something was said. Powered by the memonaut index.',
			icon: 'search',
		},
		{
			title: 'Drafts & Stars',
			description:
				'Save a message instead of sending it and pick it up later on another device. Star the sessions you need to come back to.',
			icon: 'star',
		},
		{
			title: 'Git, Remotes & Restore',
			description:
				'New folders get a git repo and, by your rules, a GitHub or Codeberg remote. On a fresh machine, a missing folder can be cloned back from the dashboard.',
			icon: 'git',
		},
		{
			title: 'Your Agent Stack',
			description:
				'Built on pi: bring your extensions, skills, models and MCP servers, and run sessions on the bundled runtime or on the one you already have installed.',
			icon: 'puzzle',
		},
		{
			title: 'Watch Agent Fleets',
			description:
				'Mark the folders of autonomous runners read-only: you can follow every session they run without risking a stray message into one.',
			icon: 'eye',
		},
		{
			title: 'Deploy Your Way',
			description:
				'A background service on Linux or macOS, a declarative NixOS setup, a token kept out of argv, trusted HTTPS over Tailscale, a single link that logs a phone in, and a distinct look for each machine.',
			icon: 'shield',
		},
	];

	const installSteps = [
		{
			title: 'Install the Server',
			description: 'Install the wherever-dev server package globally.',
			code: 'npm install -g wherever-dev',
		},
		{
			title: 'Run it as a Service',
			description:
				'Install a background service (systemd on Linux, launchd on macOS) that starts on boot and wires in the terminal bridge, so a terminal session, if you use one, is mirrored automatically. Or just run it in the foreground with wherever start.',
			code: 'wherever install',
		},
		{
			title: 'Open the Dashboard',
			description:
				'Open it in your browser. To reach it from your phone, bind it to your tailnet with a token and open a single link: the token is picked up and removed from the address bar.',
			code: 'open https://localhost:31415\n# from your phone: https://<host>:31415/#token=<your-token>',
		},
		{
			title: 'Turn on the Assistant (optional)',
			description:
				'Point wherever at a folder in ~/.wherever/config.json and restart. Enable Telegram there too (give it the bot token through WHEREVER_TELEGRAM_TOKEN) to talk to it from anywhere, then pair from the dashboard settings.',
			code: '{\n  "assistantFolder": "~/assistant",\n  "assistantTelegram": {"enabled": true}\n}',
		},
		{
			title: 'Add Shipmates (optional)',
			description:
				'Install the shipmates extension, and wherever lights up presence, the inbox and session spawning on its own.',
			code: 'pi install npm:@shipmates/pi',
		},
	];

	function scrollTo(id: string) {
		document.getElementById(id)?.scrollIntoView({behavior: 'smooth'});
	}

	function getFeatureIcon(icon: string) {
		const icons: {[key: string]: string} = {
			folder:
				'M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z',
			mirror: 'M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4',
			voice:
				'M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z',
			search: 'M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z',
			signal:
				'M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.141 0M1.394 9.393c5.857-5.857 15.355-5.857 21.213 0',
			terminal:
				'M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z',
			upload: 'M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12',
			git: 'M6 3v12m0 0a3 3 0 103 3m-3-3a3 3 0 013 3m0 0h3a6 6 0 006-6V9m0 0a3 3 0 100-6 3 3 0 000 6z',
			star: 'M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z',
			puzzle:
				'M11 4a2 2 0 114 0v1a1 1 0 001 1h3a1 1 0 011 1v3a1 1 0 01-1 1h-1a2 2 0 100 4h1a1 1 0 011 1v3a1 1 0 01-1 1h-3a1 1 0 01-1-1v-1a2 2 0 10-4 0v1a1 1 0 01-1 1H7a1 1 0 01-1-1v-3a1 1 0 00-1-1H4a2 2 0 110-4h1a1 1 0 001-1V7a1 1 0 011-1h3a1 1 0 001-1V4z',
			eye: 'M15 12a3 3 0 11-6 0 3 3 0 016 0z M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z',
			palette:
				'M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01',
			shield:
				'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z',
		};
		return icons[icon] || icons.mirror;
	}
</script>

<svelte:head>
	<title>wherever: your coding agents, your assistant, from any device</title>
</svelte:head>

<!-- Navigation -->
<nav
	class="fixed top-0 right-0 left-0 z-50 border-b border-brand-border bg-brand-dark/80 backdrop-blur-md"
>
	<div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
		<div class="flex h-16 items-center justify-between">
			<div class="flex items-center gap-3">
				<img src={url('/logo.svg')} alt="wherever logo" class="h-8 w-8" />
				<span class="gradient-text text-lg font-bold">wherever</span>
			</div>
			<div class="hidden items-center gap-8 md:flex">
				<button
					on:click={() => scrollTo('features')}
					class="text-brand-text-muted transition-colors hover:text-brand-text"
					>Features</button
				>
				<button
					on:click={() => scrollTo('assistant')}
					class="text-brand-text-muted transition-colors hover:text-brand-text"
					>Assistant</button
				>
				<button
					on:click={() => scrollTo('shipmates')}
					class="text-brand-text-muted transition-colors hover:text-brand-text"
					>Shipmates</button
				>
				<button
					on:click={() => scrollTo('install')}
					class="text-brand-text-muted transition-colors hover:text-brand-text"
					>Install</button
				>
				<a
					href="https://github.com/wighawag/wherever"
					target="_blank"
					rel="noopener noreferrer"
					class="flex items-center gap-2 rounded-lg border border-brand-border bg-brand-surface-2 px-4 py-2 transition-colors hover:bg-brand-surface-3"
				>
					<svg class="h-5 w-5" fill="currentColor" viewBox="0 0 24 24"
						><path d={githubPath} /></svg
					>
					GitHub
				</a>
			</div>
		</div>
	</div>
</nav>

<!-- Hero Section -->
<section class="relative flex overflow-hidden pt-32 pb-20 sm:pt-40 sm:pb-28">
	<div
		class="absolute top-1/4 left-1/4 h-96 w-96 rounded-full bg-brand-cyan/10 blur-3xl"
	></div>
	<div
		class="absolute right-1/4 bottom-1/4 h-96 w-96 rounded-full bg-brand-purple/10 blur-3xl"
	></div>
	<div class="relative z-10 mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
		<div class="text-center">
			<div class="mb-8 flex justify-center">
				<img
					src={url('/logo.svg')}
					alt="wherever"
					class="h-24 w-24 sm:h-32 sm:w-32"
				/>
			</div>
			<h1 class="mb-6 text-4xl font-bold sm:text-5xl md:text-7xl">
				<span class="gradient-text">Create & maintain apps</span><br />
				<span class="text-brand-text">from wherever</span>
			</h1>
			<p
				class="mx-auto mb-8 max-w-2xl text-lg text-brand-text-muted sm:text-xl"
			>
				A self-hosted workspace for AI coding agents. Run it on the machine
				where your code lives and reach every session from your phone, tablet or
				laptop. Add a personal assistant and sessions that work together when
				you want more.
			</p>
			<div class="mb-10 flex flex-wrap justify-center gap-2">
				{#each surfaces as surface}
					<span
						class="rounded-full border border-brand-border bg-brand-surface px-3 py-1 text-sm text-brand-text-muted"
						>{surface}</span
					>
				{/each}
			</div>
			<div class="flex flex-col justify-center gap-4 sm:flex-row">
				<button
					on:click={() => scrollTo('install')}
					class="rounded-xl bg-gradient-to-r from-brand-cyan via-brand-blue to-brand-purple px-8 py-4 text-lg font-semibold text-white shadow-lg shadow-brand-blue/25 transition-opacity hover:opacity-90"
					>Get Started</button
				>
				<a
					href="https://github.com/wighawag/wherever"
					target="_blank"
					rel="noopener noreferrer"
					class="flex items-center justify-center gap-2 rounded-xl border border-brand-border bg-brand-surface-2 px-8 py-4 text-lg font-semibold text-brand-text transition-colors hover:bg-brand-surface-3"
				>
					<svg class="h-5 w-5" fill="currentColor" viewBox="0 0 24 24"
						><path d={githubPath} /></svg
					>
					View on GitHub
				</a>
			</div>
		</div>
	</div>
</section>

<!-- Features Section -->
<section id="features" class="scroll-mt-16 py-24 sm:py-32">
	<div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
		<div class="mb-16 text-center">
			<h2 class="mb-4 text-3xl font-bold sm:text-4xl">
				<span class="gradient-text">Every session, from any device</span>
			</h2>
			<p class="mx-auto max-w-2xl text-lg text-brand-text-muted">
				Start, follow and steer all your agent sessions remotely, across all
				your projects, from a dashboard built for the phone as much as the
				desktop.
			</p>
		</div>
		<div class="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-4">
			{#each features as feature}
				<div
					class="group rounded-2xl border border-brand-border bg-brand-surface p-6 transition-all duration-300 hover:border-brand-blue/50 hover:shadow-lg hover:shadow-brand-blue/5"
				>
					<div
						class="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-brand-cyan/20 to-brand-purple/20 transition-transform group-hover:scale-110"
					>
						<svg
							class="h-6 w-6 text-brand-cyan"
							fill="none"
							stroke="currentColor"
							viewBox="0 0 24 24"
							><path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width="1.5"
								d={getFeatureIcon(feature.icon)}
							/></svg
						>
					</div>
					<h3 class="mb-2 text-lg font-semibold text-brand-text">
						{feature.title}
					</h3>
					<p class="text-sm leading-relaxed text-brand-text-muted">
						{feature.description}
					</p>
				</div>
			{/each}
		</div>
	</div>
</section>

<!-- Assistant Section -->
<section id="assistant" class="scroll-mt-16 py-24 sm:py-32">
	<div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
		<div class="grid grid-cols-1 items-center gap-12 lg:grid-cols-2">
			<div>
				<p
					class="mb-3 text-sm font-semibold tracking-widest text-brand-cyan uppercase"
				>
					The assistant · optional
				</p>
				<h2 class="mb-4 text-3xl font-bold sm:text-4xl">
					<span class="gradient-text">An agent that stays on</span>
				</h2>
				<p class="mb-8 text-lg text-brand-text-muted">
					Turn it on and, beside your project sessions, wherever runs one
					long-lived assistant with a real shell, real memory and a schedule. It
					works while you are away and tells you when something matters.
				</p>
				<div class="space-y-5">
					{#each assistantPoints as point}
						<div class="flex gap-4">
							<div
								class="mt-1 h-2.5 w-2.5 flex-shrink-0 rounded-full bg-gradient-to-br from-brand-cyan to-brand-purple"
							></div>
							<div>
								<h3 class="font-semibold text-brand-text">{point.title}</h3>
								<p class="text-sm leading-relaxed text-brand-text-muted">
									{point.description}
								</p>
							</div>
						</div>
					{/each}
				</div>
			</div>
			<!-- Mock chat -->
			<div
				class="gradient-border rounded-3xl bg-brand-surface p-6 shadow-2xl shadow-brand-blue/10"
				aria-hidden="true"
			>
				<div
					class="mb-5 flex items-center gap-3 border-b border-brand-border pb-4"
				>
					<div
						class="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-brand-cyan/30 to-brand-purple/30 text-lg"
					>
						🤖
					</div>
					<div>
						<p class="font-semibold text-brand-text">Assistant</p>
						<p class="text-xs text-brand-text-muted">
							on Telegram · Europe/Paris
						</p>
					</div>
				</div>
				<div class="space-y-3 text-sm">
					<div
						class="ml-auto max-w-[80%] rounded-2xl rounded-br-sm bg-brand-blue/80 px-4 py-2 text-white"
					>
						Every weekday at 8, check CI on my repos and tell me only if
						something is red.
					</div>
					<div
						class="max-w-[85%] rounded-2xl rounded-bl-sm bg-brand-surface-3 px-4 py-2 text-brand-text"
					>
						Done: a weekday 08:00 job, following your timezone. You will hear
						from me only on a failure.
					</div>
					<div
						class="max-w-[85%] rounded-2xl border border-brand-cyan/40 bg-brand-cyan/10 px-4 py-3 text-brand-text"
					>
						<p class="mb-1 font-semibold">🔔 assistant: CI is red</p>
						<p class="text-brand-text-muted">
							main of wherever failed on the server test suite. Tap to open the
							session.
						</p>
					</div>
					<div
						class="ml-auto max-w-[80%] rounded-2xl rounded-br-sm bg-brand-blue/80 px-4 py-2 text-white"
					>
						📎 screenshot.png · what is this error?
					</div>
				</div>
			</div>
		</div>
	</div>
</section>

<!-- Shipmates Section -->
<section id="shipmates" class="scroll-mt-16 py-24 sm:py-32">
	<div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
		<div class="grid grid-cols-1 items-center gap-12 lg:grid-cols-2">
			<!-- Mock inbox -->
			<div
				class="gradient-border order-2 rounded-3xl bg-brand-surface p-6 shadow-2xl shadow-brand-purple/10 lg:order-1"
				aria-hidden="true"
			>
				<div class="mb-5 flex items-center justify-between">
					<p class="font-semibold text-brand-text">🙋 Needs you</p>
					<span
						class="rounded-full bg-amber-500/20 px-2.5 py-0.5 text-xs font-semibold text-amber-400"
						>2</span
					>
				</div>
				<div class="space-y-3 text-sm">
					<div
						class="rounded-2xl border border-amber-500/30 bg-brand-surface-2 p-4"
					>
						<p class="mb-1 text-xs text-amber-400">
							Blocks release/publish until you answer
						</p>
						<p class="mb-3 text-brand-text">
							All checks are green. Publish 0.28.0 to npm?
						</p>
						<div class="flex gap-2">
							<span
								class="rounded-lg bg-brand-blue/80 px-3 py-1 text-xs font-semibold text-white"
								>yes</span
							>
							<span
								class="rounded-lg border border-brand-border px-3 py-1 text-xs text-brand-text-muted"
								>no</span
							>
						</div>
					</div>
					<div
						class="rounded-2xl border border-brand-border bg-brand-surface-2 p-4"
					>
						<p class="mb-1 text-xs text-brand-text-muted">
							docs/site · answer when you can
						</p>
						<p class="text-brand-text">
							Keep the old feature names on the landing page, or rename them?
						</p>
					</div>
				</div>
				<div class="mt-5 space-y-2 border-t border-brand-border pt-4 text-xs">
					<p class="text-brand-text-muted">
						<span class="text-brand-text">orchestrator</span> · running · fanning
						out three lanes
					</p>
					<p class="pl-4 text-brand-text-muted">
						↳ <span class="text-brand-text">lane/server</span> · waiting on orchestrator
					</p>
					<p class="pl-4 text-brand-text-muted">
						↳ <span class="text-brand-text">lane/web</span> · running · fixing the
						sidebar badge
					</p>
				</div>
			</div>
			<div class="order-1 lg:order-2">
				<p
					class="mb-3 text-sm font-semibold tracking-widest text-brand-purple uppercase"
				>
					Shipmates · optional
				</p>
				<h2 class="mb-4 text-3xl font-bold sm:text-4xl">
					<span class="gradient-text">Sessions that work together</span>
				</h2>
				<p class="mb-8 text-lg text-brand-text-muted">
					With <a
						href="https://github.com/wighawag/shipmates"
						target="_blank"
						rel="noopener noreferrer"
						class="text-brand-cyan hover:underline">shipmates</a
					>, your sessions know about each other. wherever is its host: it puts
					the whole crew in front of you and brings you their questions, so you
					stop being the copy-paste relay between terminals.
				</p>
				<div class="space-y-5">
					{#each shipmatesPoints as point}
						<div class="flex gap-4">
							<div
								class="mt-1 h-2.5 w-2.5 flex-shrink-0 rounded-full bg-gradient-to-br from-brand-purple to-brand-cyan"
							></div>
							<div>
								<h3 class="font-semibold text-brand-text">{point.title}</h3>
								<p class="text-sm leading-relaxed text-brand-text-muted">
									{point.description}
								</p>
							</div>
						</div>
					{/each}
				</div>
			</div>
		</div>
	</div>
</section>

<!-- Install Guide Section -->
<section id="install" class="scroll-mt-16 py-24 sm:py-32">
	<div class="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">
		<div class="mb-16 text-center">
			<h2 class="mb-4 text-3xl font-bold sm:text-4xl">
				<span class="gradient-text">Get started in minutes</span>
			</h2>
			<p class="mx-auto max-w-xl text-lg text-brand-text-muted">
				Three steps to drive your agents from any device, and two more when you
				want the assistant and shipmates.
			</p>
		</div>
		<div class="space-y-6">
			{#each installSteps as step, i}
				<div
					class="overflow-hidden rounded-2xl border border-brand-border bg-brand-surface"
				>
					<div class="p-6 sm:p-8">
						<div class="flex items-start gap-4">
							<div
								class="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand-cyan/20 to-brand-purple/20 text-sm font-bold text-brand-cyan"
							>
								{i + 1}
							</div>
							<div class="min-w-0 flex-1">
								<h3 class="mb-2 text-lg font-semibold text-brand-text">
									{step.title}
								</h3>
								<p class="mb-4 text-brand-text-muted">{step.description}</p>
								{#if step.code}
									<pre
										class="overflow-x-auto rounded-xl border border-brand-border bg-brand-dark p-4 font-mono text-sm text-brand-cyan">{step.code}</pre>
								{/if}
							</div>
						</div>
					</div>
				</div>
			{/each}
		</div>
		<p class="mt-8 text-center text-sm text-brand-text-muted">
			Nothing else is needed: the server runs the agent sessions itself. If you
			also work in a pi terminal, add the bridge (<code class="text-brand-cyan"
				>pi install npm:@wherever-dev/pi</code
			>) to mirror those sessions to the dashboard.
		</p>
		<div class="mt-12 text-center">
			<a
				href="https://github.com/wighawag/wherever"
				target="_blank"
				rel="noopener noreferrer"
				class="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-brand-cyan via-brand-blue to-brand-purple px-8 py-4 font-semibold text-white shadow-lg shadow-brand-blue/25 transition-opacity hover:opacity-90"
			>
				<svg class="h-5 w-5" fill="currentColor" viewBox="0 0 24 24"
					><path d={githubPath} /></svg
				>
				Read the full docs on GitHub
			</a>
		</div>
	</div>
</section>

<!-- Footer -->
<footer class="border-t border-brand-border py-12">
	<div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
		<div class="flex flex-col items-center justify-between gap-6 md:flex-row">
			<div class="flex items-center gap-3">
				<img src={url('/logo.svg')} alt="wherever logo" class="h-6 w-6" />
				<span class="text-sm text-brand-text-muted">
					Copyright &copy; 2026 Ronan Sandford. Released under the
					<a
						href="https://www.gnu.org/licenses/agpl-3.0.html"
						target="_blank"
						rel="noopener noreferrer"
						class="text-brand-cyan hover:underline">AGPL-3.0 License</a
					>.
				</span>
			</div>
			<div class="flex items-center gap-6">
				<a
					href="https://github.com/wighawag/shipmates"
					target="_blank"
					rel="noopener noreferrer"
					class="text-brand-text-muted transition-colors hover:text-brand-text"
					>shipmates</a
				>
				<a
					href="https://pi.dev"
					target="_blank"
					rel="noopener noreferrer"
					class="text-brand-text-muted transition-colors hover:text-brand-text"
					>pi</a
				>
				<a
					href="https://github.com/wighawag/wherever"
					target="_blank"
					rel="noopener noreferrer"
					class="flex items-center gap-2 text-brand-text-muted transition-colors hover:text-brand-text"
				>
					<svg class="h-5 w-5" fill="currentColor" viewBox="0 0 24 24"
						><path d={githubPath} /></svg
					>
					GitHub
				</a>
			</div>
		</div>
	</div>
</footer>
