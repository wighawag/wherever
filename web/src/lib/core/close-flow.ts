/**
 * Closing a session from the web (spec `closed-sessions`, ADR 0025): the
 * "Also close the N sessions it owns?" question and the "Closed X (and N
 * owned). Undo" banner.
 *
 * N comes from the SERVER (`GET /sessions/owned`), never from the sidebar's
 * `ownedChildren`: that only sees listed sessions, while ownership is
 * transitive and reaches sessions the listing does not show. Every close
 * (single or cascading) answers a batch id, and Undo reopens that batch (the
 * server also restores any star the close removed). "Close all in folder"
 * (`closeFolder`) closes many sessions as one batch without cascading, and its
 * banner reads "Closed N sessions in <folder>." (`closeFolderBannerText`).
 *
 * Pure (the transport and the question are injected), so it is unit-tested
 * here; `session-store.ts` wires it to fetch and the components render it.
 */

/** What a close answers (POST /sessions/close). */
export interface CloseResult {
	batch: string | null;
	sessions: string[];
}

/** The transport: the three server calls a close and its undo need. */
export interface CloseApi {
	/** The sessions a cascade would newly close besides the root (the true N). */
	owned(sessionFile: string): Promise<string[]>;
	close(sessionFile: string, cascade: boolean): Promise<CloseResult>;
	/** Close many sessions as ONE batch, never cascading (`{sessionFiles}`). */
	closeMany(sessionFiles: string[]): Promise<CloseResult>;
	reopenBatch(batch: string): Promise<CloseResult>;
}

/**
 * Ask the user whether to also close the `n` owned sessions. `true` closes the
 * subtree too (the default answer), `false` only the session, `null` cancels.
 */
export type AskCascade = (n: number) => Promise<boolean | null>;

/** The undo banner after a close: one per close request (its batch). */
export interface CloseBanner {
	batch: string;
	/** The session the user closed. */
	root: string;
	/** How many owned sessions the same close took (0 for a single close). */
	owned: number;
	/** Every session the close took, root included (the banner's tooltip). */
	sessions: string[];
	/**
	 * Set for "Close all in folder" (the folder's name): the banner then reads
	 * "Closed N sessions in <folder>." and `root` is just the first session.
	 */
	folder?: string;
}

/** The question, with the server's N. */
export function cascadePromptText(n: number): string {
	return `Also close the ${n} session${n === 1 ? '' : 's'} it owns?`;
}

/** The banner's text (its Undo button follows it). */
export function closeBannerText(label: string, owned: number): string {
	return owned > 0
		? `Closed ${label} (and ${owned} owned).`
		: `Closed ${label}.`;
}

/** The folder variant of the banner's text ("Close all in folder"). */
export function closeFolderBannerText(folder: string, n: number): string {
	return `Closed ${n} session${n === 1 ? '' : 's'} in ${folder}.`;
}

/** The banner's text for any close; `labelOf` names a single close's session. */
export function closeBannerFor(
	banner: CloseBanner,
	labelOf: (sessionFile: string) => string,
): string {
	return banner.folder !== undefined
		? closeFolderBannerText(banner.folder, banner.sessions.length)
		: closeBannerText(labelOf(banner.root), banner.owned);
}

/**
 * What "Close all in folder" closes: the OPEN sessions among the folder's shown
 * rows (the rows "Delete all" acts on, so the text filter and "Only starred"
 * already apply); closed rows (shown by "Show closed") are skipped.
 */
export function folderCloseTargets(
	rows: readonly {path: string; closed?: boolean}[],
): string[] {
	return rows.filter((r) => !r.closed).map((r) => r.path);
}

/**
 * "Close all in folder": close `files` as ONE batch without asking about owned
 * sessions (a folder close never cascades to sessions elsewhere), and answer
 * the folder banner (null when there was nothing to close or it took nothing).
 */
export async function closeFolder(
	files: string[],
	folder: string,
	api: CloseApi,
): Promise<CloseBanner | null> {
	if (files.length === 0) return null;
	const r = await api.closeMany(files);
	if (!r.batch || r.sessions.length === 0) return null;
	return {
		batch: r.batch,
		root: r.sessions[0],
		owned: 0,
		sessions: r.sessions,
		folder,
	};
}

/**
 * Close `sessionFile`: ask about its owned sessions first when the server says
 * it owns any that are still open (a failed lookup counts as none, so a close
 * never depends on shipmates), then close, and answer the banner to show (null
 * when cancelled or when the close took nothing, e.g. it was already closed).
 */
export async function closeWithCascade(
	sessionFile: string,
	api: CloseApi,
	ask: AskCascade,
): Promise<CloseBanner | null> {
	let n = 0;
	try {
		n = (await api.owned(sessionFile)).length;
	} catch {
		n = 0;
	}
	let cascade = false;
	if (n > 0) {
		const answer = await ask(n);
		if (answer === null) return null;
		cascade = answer;
	}
	const r = await api.close(sessionFile, cascade);
	if (!r.batch || r.sessions.length === 0) return null;
	return {
		batch: r.batch,
		root: sessionFile,
		owned: r.sessions.filter((f) => f !== sessionFile).length,
		sessions: r.sessions,
	};
}

/** Undo: reopen the banner's whole batch. */
export function undoClose(
	banner: CloseBanner,
	api: CloseApi,
): Promise<CloseResult> {
	return api.reopenBatch(banner.batch);
}

/**
 * How long the banner stays (ms): story 19's "short" banner, long enough to
 * notice a misclick. A newer close replaces it, Undo or dismiss clears it.
 */
export const CLOSE_BANNER_MS = 30_000;
