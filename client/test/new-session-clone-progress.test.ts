import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {get} from 'sveltore';
import {WhereverClient} from '../src/client.js';
import {makeWSFactory} from './harness.js';

// The CLIENT half of "create a session in a folder that has to be cloned
// first". The server runs that clone as an ordinary path-keyed restore job, so
// the frames here are the panel's frames -- what differs is the ENDING, and the
// watchdog.
//
// The watchdog is the whole point: `createSession` arms a 25s timer so a lost
// reply can never strand the blocking "Creating session..." overlay, and a
// clone of any real repository outruns it. So a create that becomes a WATCHED
// job must disarm it (a job reporting progress is not something to time out),
// then re-arm it for the last, ordinary step the server performs by itself once
// the clone is done. There is no Reload here, unlike the restore panel: the
// session does not exist until the clone lands.

const TARGET = '/home/u/dev/github/owner/repo';

function cloneJob(overrides: Record<string, unknown> = {}) {
	return {
		id: 3,
		kind: 'clone',
		targetPath: TARGET,
		url: 'git@github.com:owner/repo.git',
		state: 'running',
		progress: {
			phase: 'receiving',
			scope: 'repository',
			percent: 12,
			indeterminate: false,
			text: 'Receiving objects:  12% (12/100)',
			at: 1,
		},
		startedAt: 1,
		...overrides,
	};
}

describe('new-session clone progress', () => {
	let ws: ReturnType<typeof makeWSFactory>;
	let client: WhereverClient;

	/** What the dashboard's "Clone Repository" answer sends. */
	function createWithClone() {
		client.createSession(TARGET, undefined, false, false, undefined, true);
	}

	beforeEach(() => {
		vi.useFakeTimers();
		ws = makeWSFactory();
		client = new WhereverClient({
			host: 'localhost',
			port: 1234,
			secure: false,
			WebSocketCtor: ws.ctor,
		});
		client.connect();
		ws.last().open();
	});

	afterEach(() => {
		client.disconnect(true);
		vi.useRealTimers();
	});

	it('adopts the clone job as the create, dropping the blocking overlay', () => {
		createWithClone();
		expect(get(client.stateStore).creatingSession).toBe(true);

		ws.last().receive({
			type: 'restore_started',
			targetPath: TARGET,
			outcome: 'started',
			job: cloneJob(),
		});

		const s = get(client.stateStore);
		// The overlay gives way to the same progress display the panel renders...
		expect(s.creatingSession).toBe(false);
		expect(s.restore).toEqual({
			targetPath: TARGET,
			job: cloneJob(),
			joined: false,
			rejection: null,
			// ...marked as a create's first step, because it ends differently:
			// the server continues into creation instead of offering a Reload.
			forSessionCreate: true,
		});
	});

	it('does not time out a clone that outruns the 25s create watchdog', () => {
		createWithClone();
		ws.last().receive({
			type: 'restore_started',
			targetPath: TARGET,
			outcome: 'started',
			job: cloneJob(),
		});

		// A large repository: minutes of real progress, and the watchdog would
		// have fired four times over. This is exactly what the old synchronous
		// clone could not survive.
		for (const percent of [30, 60, 90]) {
			vi.advanceTimersByTime(60_000);
			ws.last().receive({
				type: 'restore_progress',
				targetPath: TARGET,
				job: cloneJob({progress: {...cloneJob().progress, percent}}),
			});
		}

		const s = get(client.stateStore);
		expect(s.sessionError).toBeFalsy();
		expect(s.creatingSession).toBe(false);
		expect(s.restore?.job?.progress?.percent).toBe(90);
	});

	it('hands the screen back to the create when the clone is done', () => {
		createWithClone();
		ws.last().receive({
			type: 'restore_started',
			targetPath: TARGET,
			outcome: 'started',
			job: cloneJob(),
		});
		ws.last().receive({
			type: 'restore_complete',
			targetPath: TARGET,
			job: cloneJob({state: 'done'}),
		});

		// No Reload offer, no lingering panel: the server is already creating the
		// session, so the ordinary overlay (and its watchdog) covers that step.
		let s = get(client.stateStore);
		expect(s.restore).toBeNull();
		expect(s.creatingSession).toBe(true);
		expect(s.sessionError).toBeFalsy();

		ws.last().receive({
			type: 'session_created',
			sessionId: 'sid-1',
			sessionFile: `${TARGET}/session.jsonl`,
			cwd: TARGET,
			model: 'fake:model',
			isStreaming: false,
		});

		s = get(client.stateStore);
		expect(s.creatingSession).toBe(false);
		expect(s.activeSessionFile).toBe(`${TARGET}/session.jsonl`);

		// The re-armed watchdog was disarmed again by the reply.
		vi.advanceTimersByTime(30_000);
		expect(get(client.stateStore).sessionError).toBeFalsy();
	});

	it('re-arms the watchdog for the creation step the server still owes', () => {
		createWithClone();
		ws.last().receive({
			type: 'restore_started',
			targetPath: TARGET,
			outcome: 'started',
			job: cloneJob(),
		});
		ws.last().receive({
			type: 'restore_complete',
			targetPath: TARGET,
			job: cloneJob({state: 'done'}),
		});

		// The clone landed but the create reply never comes: the safety net the
		// clone suspended is back, so the overlay still cannot hang forever.
		vi.advanceTimersByTime(30_000);
		const s = get(client.stateStore);
		expect(s.creatingSession).toBe(false);
		expect(s.sessionError).toBeTruthy();
	});

	it('ends the create when the clone fails, letting session_error speak', () => {
		createWithClone();
		ws.last().receive({
			type: 'restore_started',
			targetPath: TARGET,
			outcome: 'started',
			job: cloneJob(),
		});
		ws.last().receive({
			type: 'restore_complete',
			targetPath: TARGET,
			job: cloneJob({
				state: 'failed',
				failure: {
					cause: 'not-found',
					message: 'Repository not found.',
					stderr: 'fatal: repository not found',
				},
			}),
		});

		// The panel would stay on screen in its failed state; a create has no
		// panel to stay in, so the mapped cause arrives on the create's own
		// channel and the restore state goes away with the create.
		let s = get(client.stateStore);
		expect(s.restore).toBeNull();
		expect(s.creatingSession).toBe(false);

		ws.last().receive({
			type: 'session_error',
			error: 'Repository not found.',
		});
		s = get(client.stateStore);
		expect(s.sessionError).toBe('Repository not found.');

		// And no watchdog is left armed to speak over it.
		vi.advanceTimersByTime(30_000);
		expect(get(client.stateStore).sessionError).toBe('Repository not found.');
	});

	it('leaves the restore PANEL path alone: no create, no adoption', () => {
		// A loaded session whose folder is missing: same frame, but there IS a
		// session, the panel owns the outcome, and the ending is a Reload.
		const sessionFile = `${TARGET}/session.jsonl`;
		client.joinSession(sessionFile);
		ws.last().receive({
			type: 'session_created',
			sessionId: 'sid-1',
			sessionFile,
			cwd: TARGET,
			model: 'fake:model',
			readOnly: true,
			folderMissing: true,
			pending: true,
		});
		ws.last().receive({
			type: 'folder_missing',
			sessionId: 'sid-1',
			cwd: TARGET,
		});
		ws.last().receive({
			type: 'restore_started',
			targetPath: TARGET,
			outcome: 'started',
			job: cloneJob(),
		});

		let s = get(client.stateStore);
		expect(s.restore?.forSessionCreate).toBeUndefined();
		expect(s.restore?.job?.id).toBe(3);

		// Completion keeps the panel, which offers the Reload; it does not hand
		// back to a create that never existed.
		ws.last().receive({
			type: 'restore_complete',
			targetPath: TARGET,
			job: cloneJob({state: 'done'}),
		});
		s = get(client.stateStore);
		expect(s.restore?.job?.state).toBe('done');
		expect(s.creatingSession).toBe(false);
	});
});
