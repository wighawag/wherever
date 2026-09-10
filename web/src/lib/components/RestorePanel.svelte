<script lang="ts">
	// The RESTORE PANEL: what a folder-missing session shows in place of the
	// composer. The session's working folder is not on this machine (the
	// transcript synced, the clone did not), so there is nothing to drive and
	// nothing to type into -- but there IS a remedy, and this is it: put the
	// folder back at that exact path, from the phone, and watch it happen.
	//
	// TWO remedies, ONE state machine. Cloning the repository back is the common
	// case and the primary action. Creating the folder is the RARE one (a scratch
	// directory, a folder whose contents only ever lived on the old machine): it
	// is deliberately kept visually secondary, behind a disclosure, because a tap
	// that lands on it by accident produces an EMPTY folder that then looks
	// restored -- the one outcome worse than the missing folder itself, since the
	// non-empty guard will refuse the clone that should have happened. Both drive
	// the same server job, the same frames and the same running / ready / failed
	// states below; only the request differs.
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
	//  - Progress is HONEST, and it is the SHARED display (`RestoreProgress`): the
	//    new-session clone drives the same job and renders the very same thing, so
	//    a phase, a scope and a real-or-explicitly-indeterminate percentage are
	//    decided once rather than per entry point.
	import RestoreProgress from './RestoreProgress.svelte';
	import {
		folderMissing,
		restoreState,
		startRestore,
		cancelRestore,
		reloadSession,
	} from '$lib/wherever';
	import {
		fetchConfig,
		fetchRemoteCandidates,
		gitInitDefaultStore,
		type RemoteCandidate,
	} from '$lib/session-store';

	let missing = $derived($folderMissing);
	let restore = $derived($restoreState);
	let job = $derived(restore?.job ?? null);
	let running = $derived(job?.state === 'running');
	let ready = $derived(job?.state === 'done');
	let failure = $derived(job?.state === 'failed' ? job.failure : undefined);
	let rejection = $derived(restore?.rejection ?? null);
	// A create request is out and unanswered. The clone side reads this off the
	// client's `requestedUrl`, which a create has none of, so it is tracked here.
	// It never needs clearing: the `!job && !rejection` conjunction below is what
	// actually opens and closes the window.
	let createRequested = $state(false);
	// Our Clone or Create tap is out and the server has not answered yet (neither
	// a job nor a refusal). A tiny window on a fast link, a long one on a phone,
	// and the one where a second tap would fire a pointless duplicate request.
	let awaitingAnswer = $derived(
		(!!restore?.requestedUrl || createRequested) && !job && !restore?.rejection,
	);
	// A clone of a DIFFERENT url is already running for this folder: our tap
	// joined it, so what lands here is that url, not the one in the field.
	let joinedOtherUrl = $derived(
		restore?.joined &&
			job?.url &&
			restore.requestedUrl &&
			job.url !== restore.requestedUrl
			? job.url
			: null,
	);
	// Which remedy the running/finished job is: the two share every state below,
	// so the wording (and the submodule note, which is meaningless for a mkdir)
	// reads it rather than assuming a clone.
	let creating = $derived(job?.kind === 'create');

	let url = $state('');
	let urlTouched = $state(false);
	let candidates = $state<RemoteCandidate[]>([]);
	let loadingCandidates = $state(false);
	let showRawOutput = $state(false);
	// The second remedy, closed by default (see the header note on why it is
	// secondary).
	let showCreate = $state(false);
	let gitInit = $state(false);
	// null until the user touches the checkbox; while it is null the configured
	// default owns the value, exactly as the new-session dialog does it.
	let gitInitChoice = $state<boolean | null>(null);
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
		showCreate = false;
		gitInitChoice = null;
		createRequested = false;
		// Refresh the server's configured git-init default with the panel, so the
		// checkbox below reflects the CONFIG rather than whatever the store last
		// happened to hold (the session browser is what normally fetches it, and
		// the panel must not depend on that having happened). /config is a plain
		// read behind the same token gate as the candidates call beside it.
		fetchConfig();
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

	// The git-init default is the CONFIGURED one (`gitInitDefault`, the same value
	// that decides whether a NEW session's folder is initialised), never a second
	// restore-only default: a user who turned it off must not get a surprise
	// repository here either. The user's own tick, once made, wins for this panel.
	$effect(() => {
		const configured = $gitInitDefaultStore;
		gitInit = gitInitChoice === null ? configured : gitInitChoice;
	});

	function submitClone() {
		if (!url.trim()) return;
		showRawOutput = false;
		createRequested = false;
		startRestore('clone', url);
	}

	function submitCreate() {
		showRawOutput = false;
		createRequested = true;
		// The checkbox travels EXPLICITLY, in both states, so the answer is the
		// one on screen rather than a default re-decided further down.
		startRestore('create', undefined, gitInit);
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
			{#if creating}
				<div class="mt-2 text-xs text-brand-text-muted">
					Creating the folder{job?.gitInit
						? ' and initialising a git repository in it'
						: ''}
				</div>
			{:else}
				<div class="mt-2 text-xs text-brand-text-muted">
					Cloning
					<span class="font-mono break-all text-brand-text"
						>{job?.url ?? ''}</span
					>
				</div>
			{/if}
			{#if joinedOtherUrl}
				<div class="mt-1 text-xs text-yellow-300">
					A clone of <span class="font-mono break-all">{joinedOtherUrl}</span> was
					already running for this folder, so your Clone joined it. The URL you typed
					was NOT used; cancel it if you meant a different repository.
				</div>
			{/if}

			<RestoreProgress {job} />

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
					The {creating ? 'folder creation' : 'clone'} was cancelled and the folder
					it had created was removed.
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

			<!-- The SECOND remedy: the folder was never a clone. Rare, so it is a
			     disclosure rather than a button sitting beside Clone -- an accidental
			     tap here makes an EMPTY folder that then looks restored, and the
			     non-empty guard would refuse the clone that should have happened. -->
			<div class="mt-3 border-t border-yellow-500/20 pt-2">
				{#if !showCreate}
					<button
						type="button"
						onclick={() => (showCreate = true)}
						class="text-[11px] text-brand-text-muted underline opacity-80 hover:opacity-100"
					>
						This folder was never a clone? Create it instead
					</button>
				{:else}
					<div class="text-[11px] text-brand-text-muted">
						Makes the folder and any missing parents. Nothing is downloaded, so
						whatever the folder used to hold is not coming back with it.
					</div>
					<div class="mt-1.5 flex items-center gap-2">
						<input
							id="restore-git-init"
							type="checkbox"
							checked={gitInit}
							onchange={(e) => (gitInitChoice = e.currentTarget.checked)}
							class="h-3.5 w-3.5 rounded border-brand-border bg-brand-surface-3 text-brand-blue focus:ring-brand-blue"
						/>
						<label
							for="restore-git-init"
							class="cursor-pointer text-xs text-brand-text-muted select-none"
						>
							Initialise a git repository
						</label>
					</div>
					<button
						type="button"
						onclick={submitCreate}
						disabled={awaitingAnswer}
						class="mt-2 rounded border border-brand-border bg-brand-surface-3 px-3 py-1 text-[11px] font-medium text-brand-text-muted transition-colors hover:bg-brand-surface-2 hover:text-brand-text disabled:cursor-not-allowed disabled:opacity-40"
					>
						{awaitingAnswer ? 'Creating...' : 'Create folder'}
					</button>
				{/if}
			</div>
		{/if}
	</div>
{/if}
