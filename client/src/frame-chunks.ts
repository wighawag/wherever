/**
 * Client half of frame chunking (`frames=chunk.v1`); the server half and the
 * rationale are in `server/src/frame-chunks.ts` (kept in sync by hand).
 *
 * The client asks for chunks with `frames=chunk.v1` on the socket URL. A large
 * server frame then arrives as several text frames, each
 * `\u0001<id> <seq> <count>\n<data>`; concatenating the data in order gives back
 * the original JSON. Every chunk is an inbound frame, which is what keeps the
 * liveness watchdog from condemning a socket that is busy delivering a
 * multi-MB history over a slow link.
 */

export const FRAME_CHUNK_PARAM = 'frames';
export const FRAME_CHUNK_VERSION = 'chunk.v1';
const MARK = 1; // U+0001: never the first character of a JSON document

export type ChunkResult =
	| {kind: 'frame'; text: string}
	| {kind: 'partial'; received: number; count: number}
	| {kind: 'invalid'};

/**
 * Reassembles chunked frames for ONE socket (make a new one per socket: a
 * message whose chunks were cut short by a drop is never completed on another).
 * Chunks of one message are sent back to back, so only one message is ever in
 * progress; a new id simply replaces an unfinished one.
 */
export class FrameReassembler {
	private id: string | null = null;
	private count = 0;
	private parts: string[] = [];

	/** True when `text` is a chunk rather than an ordinary frame. */
	static isChunk(text: string): boolean {
		return text.charCodeAt(0) === MARK;
	}

	/** Feed one text frame. A non-chunk frame is passed straight through. */
	push(text: string): ChunkResult {
		if (!FrameReassembler.isChunk(text)) return {kind: 'frame', text};
		const nl = text.indexOf('\n');
		if (nl < 0) return {kind: 'invalid'};
		const [id, seqRaw, countRaw] = text.slice(1, nl).split(' ');
		const seq = Number(seqRaw);
		const count = Number(countRaw);
		if (!id || !Number.isInteger(seq) || !Number.isInteger(count) || count < 1 || seq < 0 || seq >= count) {
			return {kind: 'invalid'};
		}
		if (seq === 0 || id !== this.id) {
			if (seq !== 0) {
				// The start of this message was never seen: drop it.
				this.reset();
				return {kind: 'invalid'};
			}
			this.id = id;
			this.count = count;
			this.parts = [];
		}
		if (seq !== this.parts.length || count !== this.count) {
			this.reset();
			return {kind: 'invalid'};
		}
		this.parts.push(text.slice(nl + 1));
		if (this.parts.length < this.count) {
			return {kind: 'partial', received: this.parts.length, count: this.count};
		}
		const full = this.parts.join('');
		this.reset();
		return {kind: 'frame', text: full};
	}

	reset() {
		this.id = null;
		this.count = 0;
		this.parts = [];
	}
}
