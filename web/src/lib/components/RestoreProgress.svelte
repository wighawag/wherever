<script lang="ts">
	// The PROGRESS DISPLAY of a restore job, shared by the two entry points that
	// have one: the RESTORE PANEL (a loaded session whose folder is missing) and
	// the NEW-SESSION clone (creating a session in a folder that has to be cloned
	// first). Both drive the same server-owned, path-keyed job, so both render it
	// the same way -- one display, so honesty is fixed in one place rather than
	// re-invented per entry point.
	//
	// Honest per story 8: the phase, the scope, and either a real percentage or an
	// EXPLICIT indeterminate state. Submodules report under their own scope,
	// counted separately, because git restarts counting for each one and nothing
	// knows how many objects the remaining ones hold. A single unified bar would
	// be a lie, and a lie that looks stuck is worse than a segmented truth that
	// moves.
	import type {RestoreJobInfo} from '@wherever-dev/client';

	let {job}: {job: RestoreJobInfo | null} = $props();

	// A create has exactly one scope (there are no submodules to count), so the
	// scope label and the submodule note would be noise, not honesty.
	let creating = $derived(job?.kind === 'create');

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
</script>

{#if job?.progress}
	{@const p = job.progress}
	<div class="mt-2 flex items-baseline justify-between gap-2 text-xs">
		<span class="min-w-0 flex-1 break-words text-brand-text">
			{phaseLabel(p.phase)}{creating ? '' : ` \u00b7 ${scopeLabel(p.scope)}`}
		</span>
		<span class="flex-shrink-0 font-mono text-brand-text-muted">
			{p.indeterminate ? 'no percentage' : `${p.percent}%`}
		</span>
	</div>
	<div class="mt-1 h-1.5 w-full overflow-hidden rounded bg-brand-surface-3">
		{#if p.indeterminate}
			<!-- Explicitly indeterminate: git reports no percentage for this phase,
			     so we animate rather than invent a number. -->
			<div class="h-full w-1/3 animate-pulse rounded bg-brand-blue/60"></div>
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
		{creating
			? 'Starting...'
			: 'Starting the clone (git has not reported anything measurable yet)...'}
	</div>
{/if}
{#if !creating}
	<div class="mt-1 text-[11px] text-brand-text-muted">
		Each submodule is counted separately and has its own progress above, so
		there is no single overall percentage.
	</div>
{/if}
