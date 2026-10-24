// Minimal fake WebSocket for driving WhereverClient.handleMessage deterministically
// in unit tests. It records outbound frames and lets a test push inbound frames
// (server -> client) synchronously. No real network. Mirrors the tiny slice of
// the WHATWG WebSocket API that the client uses (readyState, addEventListener for
// open/message/close/error, send, close).

export type WSListener = (event: any) => void;

/** A decoded `upload.v1` chunk frame (see docs/USAGE.md). */
export interface BinaryChunk {
	kind: number;
	version: number;
	uploadId: string;
	offset: number;
	payload: Uint8Array;
}

// [u8 kind][u8 version][u8 idLen][uploadId ascii][u64 offset BE][payload]
export function decodeChunkFrame(bytes: Uint8Array): BinaryChunk {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const idLen = bytes[2];
	const uploadId = String.fromCharCode(...bytes.subarray(3, 3 + idLen));
	const at = 3 + idLen;
	const offset = view.getUint32(at) * 2 ** 32 + view.getUint32(at + 4);
	return {
		kind: bytes[0],
		version: bytes[1],
		uploadId,
		offset,
		payload: bytes.slice(at + 8),
	};
}

export class FakeWebSocket {
	// WHATWG readyState constants.
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;

	url: string;
	readyState = FakeWebSocket.CONNECTING;
	sent: any[] = [];
	// Binary frames (upload.v1 chunks), decoded, in send order. Kept apart from
	// `sent` because they are not JSON.
	binary: BinaryChunk[] = [];
	private listeners: Record<string, Set<WSListener>> = {
		open: new Set(),
		message: new Set(),
		close: new Set(),
		error: new Set(),
	};

	constructor(url: string) {
		this.url = url;
	}

	addEventListener(type: string, cb: WSListener) {
		this.listeners[type]?.add(cb);
	}

	removeEventListener(type: string, cb: WSListener) {
		this.listeners[type]?.delete(cb);
	}

	removeAllListeners() {
		for (const key of Object.keys(this.listeners)) {
			this.listeners[key].clear();
		}
	}

	send(data: string | ArrayBufferView | ArrayBuffer) {
		if (typeof data === 'string') {
			this.sent.push(JSON.parse(data));
			return;
		}
		const bytes =
			data instanceof ArrayBuffer
				? new Uint8Array(data)
				: new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
		this.binary.push(decodeChunkFrame(bytes));
	}

	close() {
		if (this.readyState === FakeWebSocket.CLOSED) return;
		this.readyState = FakeWebSocket.CLOSED;
		this.emit('close', {});
	}

	// terminate() is used by the liveness watchdog's forcible teardown path.
	terminate() {
		this.close();
	}

	// --- test-only helpers -------------------------------------------------

	/** Simulate the socket opening (server accepted the connection). */
	open() {
		this.readyState = FakeWebSocket.OPEN;
		this.emit('open', {});
	}

	/** Push a server -> client frame. */
	receive(msg: any) {
		this.emit('message', {data: JSON.stringify(msg)});
	}

	/** Last outbound frame of a given type, or undefined. */
	lastSentOfType(type: string) {
		return [...this.sent].reverse().find((m) => m.type === type);
	}

	private emit(type: string, event: any) {
		for (const cb of this.listeners[type] ?? []) cb(event);
	}
}

// A WebSocket constructor that records every instance it creates, so a test can
// grab the live socket the client just opened and drive it. Assigned to
// config.WebSocketCtor.
export function makeWSFactory() {
	const instances: FakeWebSocket[] = [];
	const ctor = function (url: string) {
		const ws = new FakeWebSocket(url);
		instances.push(ws);
		return ws;
	} as unknown as {new (url: string): FakeWebSocket};
	return {
		ctor,
		instances,
		last: () => instances[instances.length - 1],
	};
}
