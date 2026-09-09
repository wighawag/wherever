<script lang="ts">
	// The RESTORE PANEL: what a folder-missing session shows in place of the
	// composer. The session's working folder is not on this machine (the
	// transcript synced, the clone did not), so there is nothing to drive and
	// nothing to type into -- but there IS a remedy, and this is it: clone the
	// repository back into that exact path, from the phone, and watch it happen.
	//
	// Three things this panel is deliberately careful about:
	//
	//  - The URL is a SUGGESTION, always editable. The server resolves candidates
	//    on demand (a provider probe, then the folder-path convention); an empty
	//    field is an honest answer and the user pastes their own.
	//  - The job is SERVER-OWNED and keyed by the folder path, so this panel is a
	//    view of it, never its owner. It repaints a clone started by another
	//    device or by this phone's previous, dropped socket, and a second Clone
	//    tap JOINS the running job rather than racing it -- in which case we say
	//    which url is really in flight instead of pretending the edited one won.
	//  - Progress is HONEST: a phase, a scope, and either a real percentage or an
	//    explicit indeterminate state. Submodules are counted separately, under
	//    their own scope, because git restarts counting for each one and nothing
	//    knows how many objects the remaining ones hold. A single unified bar
	//    would be a lie, and a lie that looks stuck is worse than a segmented
	//    truth that moves.
	import {
		folderMissing,
		restoreState,
		startRestore,
		cancelRestore,
		reloadSession,
	} from '$lib/wherever';
	import {
		fetchRemoteCandidates,
		type RemoteCandidate,
	} from '$lib/session-store';

	let missing = $derived($folderMissing);
	let restore = $derived($restoreState);
	let job = $derived(restore?.job ?? null);
	let running = $derived(job?.state === 'running');
	let ready = $derived(job?.state === 'done');
	let failure = $derived(job?.state === 'failed' ? job.failure : undefined);
	let rejection = $derived(restore?.rejection ?? null);
	// A clone of a DIFFERENT url is already running for this folder: our tap
	// joined it, so what lands here is that url, not the one in the field.
	// Our Clone tap is out and the server has not answered yet (neither a job nor
	// a refusal). A tiny window on a fast link, a long one on a phone, and the one
	// where a second tap would fire a pointless duplicate request.
	let awaitingAnswer = $derived(
		!!restore?.requestedUrl && !job && !restore?.rejection,
	);
	let joinedOtherUrl = $derived(
		restore?.joined &&
			job?.url &&
			restore.requestedUrl &&
			job.url !== restore.requestedUrl
			? job.url
			: null,
	);

	let url = $state('');
	let urlTouched = $state(false);
	let candidates = $state<RemoteCandidate[]>([]);
	let loadingCandidates = $state(false);
	let showRawOutput = $state(false);
	// The path the field was last pre-filled for. A plain variable, not $state:
	// it guards the effect below and must not itself re-trigger it.
	let prefilledFor = '';

	// Resolve the pre-fill ON DEMAND, when the panel opens for a folder. The
	// probe shells out to a provider CLI on the server, so this must never be a
	// per-keystroke or per-render call -- it is keyed on the missing path and
	// runs once per folder.
	$effect(() => {
		const cwd = missing?.cwd;
		if (!cwd || cwd === prefilledFor) return;
		prefilledFor = cwd;
		url = '';
		urlTouched = false;
		candidates = [];
		loadingCandidates = true;
		fetchRemoteCandidates(cwd)
			.then((list) => {
				candidates = list;
				// Never overwrite something the user has already typed.
				if (!urlTouched && list.length > 0) url = list[0].url;
			})
			.finally(() => {
				loadingCandidates = false;
			});
	});

	const PHASE_LABELS: Record<string, string> = {
		starting: 'Starting',
		enumerating: 'Enumerating objects',
		counting: 'Counting objects',
		compressing: 'Compressing objects',
		receiving: 'Receiving objects',
		resolving: 'Resolving deltas',
		'checking-out': 'Checking out files',
		filtering: 'Filtering content',
		creating: 'Creating the folder',
		initialising: 'Initialising a git repository',
	};

	function phaseLabel(phase: string): string {
		return PHASE_LABELS[phase] ?? phase;
	}

	// 'repository' is the top-level clone; anything else is a submodule path
	// relative to the target, and is named as such so the separate counting is
	// visible rather than implied.
	function scopeLabel(scope: string): string {
		return scope === 'repository' ? 'the repository' : `submodule ${scope}`;
	}

	function submitClone() {
		if (!url.trim()) return;
		showRawOutput = false;
		startRestore('clone', url);
	}
</script>

{#if missing}
	<div
		class="border-t border-yellow-500/30 bg-yellow-500/10 px-4 py-3 text-sm text-yellow-400"
	>
		<div class="font-medium">
			📁 This session's folder is not on this machine
		</div>
		<div class="mt-1 font-mono text-xs break-all text-yellow-300">
			{missing.cwd}
		</div>

		{#if ready}
			<!-- Restored. Whether a session has a live agent is a LOAD-TIME decision,
			     and the load that found the folder missing built none, so a reload is
			     the honest way to go live -- not a hint, the actual remedy. -->
			<div class="mt-2 text-xs text-brand-text-muted">
				✅ The folder is ready. Reload the session to bring it back live.
			</div>
			<button
				type="button"
				onclick={() => reloadSession()}
				class="mt-2 rounded bg-gradient-to-r from-brand-cyan to-brand-blue px-3.5 py-1.5 text-xs font-semibold text-brand-text transition-all hover:opacity-90"
			>
				Reload session
			</button>
		{:else if running}
			<!-- A job is running for this folder. It may not be ours: a second device,
			     or this phone's own previous socket before the connection dropped. -->
			<div class="mt-2 text-xs text-brand-text-muted">
				Cloning
				<span class="font-mono break-all text-brand-text">{job?.url ?? ''}</span
				>
			</div>
			{#if joinedOtherUrl}
				<div class="mt-1 text-xs text-yellow-300">
					A clone of <span class="font-mono break-all">{joinedOtherUrl}</span> was
					already running for this folder, so your Clone joined it. The URL you typed
					was NOT used; cancel it if you meant a different repository.
				</div>
			{/if}

			{#if job?.progress}
				{@const p = job.progress}
				<div class="mt-2 flex items-baseline justify-between gap-2 text-xs">
					<span class="min-w-0 flex-1 break-words text-brand-text">
						{phaseLabel(p.phase)} &middot; {scopeLabel(p.scope)}
					</span>
					<span class="flex-shrink-0 font-mono text-brand-text-muted">
						{p.indeterminate ? 'no percentage' : `${p.percent}%`}
					</span>
				</div>
				<div
					class="mt-1 h-1.5 w-full overflow-hidden rounded bg-brand-surface-3"
				>
					{#if p.indeterminate}
						<!-- Explicitly indeterminate: git reports no percentage for this
						     phase, so we animate rather than invent a number. -->
						<div
							class="h-full w-1/3 animate-pulse rounded bg-brand-blue/60"
						></div>
					{:else}
						<div
							class="h-full rounded bg-gradient-to-r from-brand-cyan to-brand-blue transition-all"
							style={`width: ${Math.max(0, Math.min(100, p.percent ?? 0))}%`}
						></div>
					{/if}
				</div>
				<div class="mt-1 font-mono text-[11px] break-all text-brand-text-muted">
					{p.text}
				</div>
			{:else}
				<div class="mt-2 text-xs text-brand-text-muted">
					Starting the clone (git has not reported anything measurable yet)...
				</div>
			{/if}
			<div class="mt-1 text-[11px] text-brand-text-muted">
				Each submodule is counted separately and has its own progress above, so
				there is no single overall percentage.
			</div>

			<button
				type="button"
				onclick={() => cancelRestore()}
				class="mt-2 rounded bg-brand-surface-3 px-3.5 py-1.5 text-xs font-semibold text-brand-text transition-colors hover:bg-brand-surface-2"
			>
				Cancel
			</button>
		{:else}
			<!-- Offer to restore. Also the state a cancelled or failed job returns to. -->
			<div class="mt-1 text-xs text-brand-text-muted">
				The conversation is readable, but nothing can be run here until the
				folder is restored. Clone the repository back into that path, then
				reload the session.
			</div>

			{#if job?.state === 'cancelled'}
				<div class="mt-2 text-xs text-brand-text-muted">
					The clone was cancelled and the folder it had created was removed.
				</div>
			{/if}

			{#if failure}
				<div
					class="mt-2 rounded border border-red-500/30 bg-red-500/10 p-2 text-xs text-rose-300"
				>
					<div class="break-words">{failure.message}</div>
					{#if failure.stderr}
						<button
							type="button"
							onclick={() => (showRawOutput = !showRawOutput)}
							class="mt-1 underline opacity-80 hover:opacity-100"
						>
							{showRawOutput ? 'Hide' : 'Show'} git output
						</button>
						{#if showRawOutput}
							<pre
								class="mt-1 max-h-32 overflow-auto rounded bg-brand-surface-3 p-2 font-mono text-[11px] whitespace-pre-wrap text-brand-text-muted">{failure.stderr}</pre>
						{/if}
					{/if}
				</div>
			{/if}

			{#if rejection}
				<div
					class="mt-2 rounded border border-red-500/30 bg-red-500/10 p-2 text-xs break-words text-rose-300"
				>
					{rejection.message}
				</div>
			{/if}

			<label class="mt-2 block text-xs text-brand-text-muted" for="restore-url">
				Repository URL (SSH)
			</label>
			<input
				id="restore-url"
				type="text"
				bind:value={url}
				oninput={() => (urlTouched = true)}
				onkeydown={(e) => {
					if (e.key === 'Enter') submitClone();
				}}
				spellcheck="false"
				autocapitalize="off"
				autocorrect="off"
				placeholder={loadingCandidates
					? 'Looking for the repository...'
					: 'git@github.com:owner/repo.git'}
				class="mt-1 w-full rounded border border-brand-border bg-brand-surface px-2.5 py-1.5 font-mono text-xs text-brand-text placeholder:text-brand-text-muted focus:border-brand-blue focus:outline-none"
			/>
			{#if candidates.length > 1}
				<!-- More than one guess: the probe's and the path convention's. Offer
				     them rather than silently picking, since only the user knows which
				     repository this folder really was. -->
				<div class="mt-1 flex flex-wrap gap-1">
					{#each candidates as candidate (candidate.url)}
						<button
							type="button"
							onclick={() => {
								url = candidate.url;
								urlTouched = true;
							}}
							class="rounded bg-brand-surface-3 px-2 py-1 font-mono text-[11px] break-all text-brand-text-muted hover:text-brand-text"
						>
							{candidate.url}
						</button>
					{/each}
				</div>
			{:else if !loadingCandidates && candidates.length === 0}
				<div class="mt-1 text-[11px] text-brand-text-muted">
					No repository could be worked out for this folder. Paste the SSH URL
					to clone.
				</div>
			{/if}

			<button
				type="button"
				onclick={submitClone}
				disabled={!url.trim() || awaitingAnswer}
				class="mt-2 rounded bg-gradient-to-r from-brand-cyan to-brand-blue px-3.5 py-1.5 text-xs font-semibold text-brand-text transition-all hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
			>
				{awaitingAnswer ? 'Starting...' : 'Clone repository'}
			</button>
		{/if}
	</div>
{/if}
