/**
 * Copy text for the settings' Copy buttons: the async Clipboard API when the
 * browser offers it (a secure context), else the legacy `execCommand('copy')`
 * on a temporary off-screen textarea (plain-HTTP LAN access has no
 * `navigator.clipboard`). Resolves false when neither works, so the caller can
 * say to copy by hand (the value itself is selectable, `.selectable`).
 *
 * Framework-free with the browser objects injected, so it is unit-tested.
 */
export interface ClipboardDeps {
	clipboard?: {writeText(text: string): Promise<void>} | undefined;
	document?: Document | undefined;
}

function browserDeps(): ClipboardDeps {
	return {
		clipboard:
			typeof navigator !== 'undefined' ? navigator.clipboard : undefined,
		document: typeof document !== 'undefined' ? document : undefined,
	};
}

export async function copyText(
	text: string,
	deps: ClipboardDeps = browserDeps(),
): Promise<boolean> {
	if (deps.clipboard?.writeText) {
		try {
			await deps.clipboard.writeText(text);
			return true;
		} catch {
			// Refused (no permission, not focused): try the legacy path.
		}
	}
	const doc = deps.document;
	if (!doc?.body || typeof doc.execCommand !== 'function') return false;
	const area = doc.createElement('textarea');
	area.value = text;
	area.setAttribute('readonly', '');
	area.style.position = 'fixed';
	area.style.top = '-1000px';
	area.style.opacity = '0';
	doc.body.appendChild(area);
	try {
		area.select();
		return doc.execCommand('copy');
	} catch {
		return false;
	} finally {
		doc.body.removeChild(area);
	}
}
