/**
 * A shipmates delivery as a chat card: what the server's `shipmates` message (and
 * the live `shipmates_delivery` frame) carries, turned into who sent what.
 *
 * `details` (@shipmates/pi `session.ts` `payload()`) gives, per delivered
 * message, its id, the sender's label and its origin, but not its KIND (`tell`,
 * `ask`, `answer`, `spawn`). The kind is only in shipmates' formatted text
 * (@shipmates/pi `format.ts` `formatDelivery`), one header line per message:
 *
 *   --- <id> · from <label> · origin: <origin> · <kind>[ · ...]
 *
 * followed by that message's body, and a closing `---` line before shipmates'
 * trailing instructions. So the header of each id in `details` is found by its
 * id (a body that happens to contain a `--- ` line is never taken for one), the
 * kind is the part after `origin: `, and a body runs to the next header or to
 * the LAST `---` line. A delivery from another shipmates version that does not
 * match still shows its senders and origins, with the whole text as the body.
 */

export interface ShipmatesDeliveryDetails {
	ids: string[];
	from: string[];
	origins: string[];
}

export interface ShipmatesCardItem {
	id: string | null;
	from: string;
	origin: string;
	/** `tell`, `ask`, `answer`, `spawn`, ...; null when the text did not say. */
	kind: string | null;
	body: string;
}

export interface ShipmatesCard {
	items: ShipmatesCardItem[];
	/** The distinct senders, in order. */
	senders: string[];
	/** The distinct origins, in order. */
	origins: string[];
	/** The owner whose `spawn` message is this session's first prompt, else null. */
	spawnFrom: string | null;
}

function headerKind(line: string): string | null {
	const parts = line.slice(4).split(' · ');
	const at = parts.findIndex((p) => p.startsWith('origin: '));
	return at >= 0 && parts[at + 1] ? parts[at + 1] : null;
}

function distinct(xs: string[]): string[] {
	return [...new Set(xs.filter((x) => x))];
}

export function describeShipmatesDelivery(
	content: string,
	details: ShipmatesDeliveryDetails,
): ShipmatesCard {
	const lines = content.split('\n');
	const headers = details.ids.map((id) =>
		id ? lines.findIndex((l) => l.startsWith(`--- ${id} · `)) : -1,
	);
	let close = -1;
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i] === '---') {
			close = i;
			break;
		}
	}
	const found = headers.filter((h) => h >= 0).sort((a, b) => a - b);

	const items: ShipmatesCardItem[] = details.ids.map((id, i) => {
		const h = headers[i];
		const from = details.from[i] ?? '';
		const origin = details.origins[i] ?? '';
		if (h < 0) return {id, from, origin, kind: null, body: ''};
		const next = found.find((x) => x > h);
		const end = next ?? (close > h ? close : lines.length);
		return {
			id,
			from,
			origin,
			kind: headerKind(lines[h]),
			body: lines
				.slice(h + 1, end)
				.join('\n')
				.trim(),
		};
	});

	// Nothing matched (no ids, or a format this card does not know): one item
	// with what `details` says and the text as shipmates wrote it.
	if (!items.some((it) => it.body)) {
		const first = items[0];
		items.splice(0, items.length, {
			id: first?.id ?? null,
			from: distinct(details.from).join(', '),
			origin: first?.origin ?? distinct(details.origins)[0] ?? '',
			kind: first?.kind ?? null,
			body: content.trim(),
		});
	}

	const spawn = items.find((it) => it.kind === 'spawn');
	return {
		items,
		senders: distinct(details.from),
		origins: distinct(details.origins),
		spawnFrom: spawn ? spawn.from || null : null,
	};
}

/** The badge for an origin (shipmates ADR 0003): who stands behind the words. */
export function originBadge(origin: string): {
	label: string;
	tone: 'agent' | 'human' | 'relayed' | 'other';
} {
	if (origin === 'agent') return {label: 'agent', tone: 'agent'};
	if (origin === 'human') return {label: 'human', tone: 'human'};
	if (origin === 'human-relayed')
		return {label: 'human-relayed', tone: 'relayed'};
	return {label: origin || 'unknown origin', tone: 'other'};
}

/** What this needs to know of a listed session (the `/sessions` listing's fields). */
export interface ListedSessionName {
	path: string;
	name?: string;
	firstMessage?: string;
}

/**
 * A sender as a person reads it. shipmates labels a session by its role, else by
 * its transcript path (`labelOf`), which says nothing at a glance: a listed
 * session is named the way the sidebar names it (its name, else its first
 * message), and an unlisted path is "another session". A role stays as is.
 */
export function senderName(
	label: string,
	listed: ReadonlyMap<string, ListedSessionName>,
): string {
	if (!label) return 'unknown sender';
	const s = listed.get(label);
	if (s) {
		const first = (s.firstMessage ?? '').trim();
		return (
			s.name ||
			(first.length > 40 ? `${first.slice(0, 40)}...` : first) ||
			'a session'
		);
	}
	return /^\/.*\.jsonl$/.test(label) ? 'another session' : label;
}
