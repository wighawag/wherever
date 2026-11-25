// Pure helpers for `RenamePrompt.svelte`, the rename prompt shared by the
// session row ⋯ and the chat ⋯ (spec `sidebar-compact-layout` story 39). The
// server stays the authority on the name rule (`validateRenameInput` in
// `server/src/session-rename.ts`): these only decide whether the prompt
// sends anything at all.

/** The field's starting value: the current name, empty when there is none. */
export function renamePromptInitial(current: string | undefined): string {
	return current ?? '';
}

/**
 * A name as the server stores it: every run of whitespace (newlines
 * included) collapsed to one space, then trimmed.
 */
export function normalizeSessionName(raw: string): string {
	return raw.replace(/\s+/g, ' ').trim();
}

/** What confirming the prompt does. */
export type RenamePromptAction =
	| {kind: 'cancel'}
	| {kind: 'save'; name: string};

/**
 * Confirming the prompt with `value`: an empty (or blank) value cancels, as
 * does a name unchanged from `current` (nothing to write); anything else
 * saves the cleaned name.
 */
export function renamePromptAction(
	value: string,
	current: string | undefined,
): RenamePromptAction {
	const name = normalizeSessionName(value);
	if (!name || name === normalizeSessionName(current ?? ''))
		return {kind: 'cancel'};
	return {kind: 'save', name};
}
