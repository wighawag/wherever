import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {get} from 'sveltore';
import {WhereverClient} from '../src/client.js';
import {makeWSFactory} from './harness.js';

// The RESTORE half of the folder-missing state: the panel that replaces the
// composer clones the repository back into the missing path.
//
// The job is server-owned and keyed by that PATH, so this client is never the
// owner of the operation: it asks, and then paints whatever the server says --
// including a job it did not start (a second device, or its own previous socket
// before the phone dropped off). Frames are addressed by path, so one for a
// folder this client is no longer looking at must be ignored rather than
// repainting the panel of a different session.

const TARGET = '/home/u/dev/github/owner/repo';
const SESSION_FILE = `${TARGET}/session.jsonl`;

function runningJob(overrides: Record<string, unknown> = {}) {
	return {
		id: 7,
		kind: 'clone',
		targetPath: TARGET,
		url: 'git@github.com:owner/repo.git',
		state: 'running',
		progress: {
			phase: 'receiving',
			scope: 'repository',
			percent: 42,
			indeterminate: false,
			text: 'Receiving objects:  42% (42/100)',
			at: 1,
		},
		startedAt: 1,
		...overrides,
	};
}

describe('restore panel state', () => {
	let ws: ReturnType<typeof makeWSFactory>;
	let client: WhereverClient;

	function loadMissingFolderSession(job?: Record<string, unknown>) {
		client.joinSession(SESSION_FILE);
		ws.last().receive({
			type: 'session_created',
			sessionId: 'sid-1',
			sessionFile: SESSION_FILE,
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
			...(job ? {job} : {}),
		});
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

	it('offers a restore for the missing path when nothing is running', () => {
		loadMissingFolderSession();

		const s = get(client.stateStore);
		expect(s.restore).toEqual({
			targetPath: TARGET,
			job: null,
			joined: false,
			rejection: null,
		});
	});

	it('repaints a job the server was ALREADY running for that path', () => {
		// The reconnect / second-device case: the frame carries the running job,
		// so the panel shows live progress instead of offering a second clone.
		loadMissingFolderSession(runningJob());

		const s = get(client.stateStore);
		expect(s.restore?.job?.id).toBe(7);
		expect(s.restore?.job?.state).toBe('running');
		expect(s.restore?.job?.progress?.percent).toBe(42);
	});

	it('sends the target path the server named, and follows the job to completion', () => {
		loadMissingFolderSession();

		client.startRestore('clone', '  git@github.com:owner/repo.git  ');
		const sent = ws.last().lastSentOfType('restore_start');
		expect(sent).toEqual({
			type: 'restore_start',
			targetPath: TARGET,
			action: 'clone',
			url: 'git@github.com:owner/repo.git',
		});

		ws.last().receive({
			type: 'restore_started',
			targetPath: TARGET,
			outcome: 'started',
			job: runningJob(),
		});
		expect(get(client.stateStore).restore?.joined).toBe(false);

		ws.last().receive({
			type: 'restore_progress',
			targetPath: TARGET,
			job: runningJob({
				progress: {
					phase: 'starting',
					scope: 'sub',
					percent: null,
					indeterminate: true,
					text: "Cloning into '/home/u/dev/github/owner/repo/sub'...",
					at: 2,
				},
			}),
		});
		// Honest progress survives the round trip: an indeterminate phase is
		// carried AS indeterminate, and the submodule keeps its own scope.
		const mid = get(client.stateStore).restore?.job?.progress;
		expect(mid?.indeterminate).toBe(true);
		expect(mid?.percent).toBeNull();
		expect(mid?.scope).toBe('sub');

		ws.last().receive({
			type: 'restore_complete',
			targetPath: TARGET,
			job: runningJob({state: 'done', endedAt: 3}),
		});
		expect(get(client.stateStore).restore?.job?.state).toBe('done');
	});

	it('sends the CREATE remedy with the git-init choice, in both states', () => {
		// The second remedy: a folder that was never a clone. Same frame family,
		// same path, no url -- only the checkbox differs, and it must travel as an
		// EXPLICIT boolean either way. Omitting it when off would let the server's
		// own default decide, which is exactly the surprise repository a user who
		// turned `gitInitDefault` off is entitled not to get.
		loadMissingFolderSession();

		client.startRestore('create', undefined, true);
		expect(ws.last().lastSentOfType('restore_start')).toEqual({
			type: 'restore_start',
			targetPath: TARGET,
			action: 'create',
			gitInit: true,
		});

		client.startRestore('create', undefined, false);
		expect(ws.last().lastSentOfType('restore_start')).toEqual({
			type: 'restore_start',
			targetPath: TARGET,
			action: 'create',
			gitInit: false,
		});

		// It drives the ONE state machine: the create job is followed exactly as a
		// clone is, to the same terminal state the panel's ready-and-reload rests on.
		ws.last().receive({
			type: 'restore_started',
			targetPath: TARGET,
			outcome: 'started',
			job: runningJob({kind: 'create', url: undefined, gitInit: false}),
		});
		ws.last().receive({
			type: 'restore_complete',
			targetPath: TARGET,
			job: runningJob({
				kind: 'create',
				url: undefined,
				gitInit: false,
				state: 'done',
				endedAt: 3,
			}),
		});
		const job = get(client.stateStore).restore?.job;
		expect(job?.kind).toBe('create');
		expect(job?.state).toBe('done');
		expect(job?.gitInit).toBe(false);
	});

	it('says when a second tap JOINED a job cloning a DIFFERENT url', () => {
		loadMissingFolderSession(runningJob());

		client.startRestore('clone', 'git@github.com:someone/else.git');
		expect(get(client.stateStore).restore?.requestedUrl).toBe(
			'git@github.com:someone/else.git',
		);

		ws.last().receive({
			type: 'restore_started',
			targetPath: TARGET,
			outcome: 'joined',
			job: runningJob(),
		});

		const s = get(client.stateStore);
		expect(s.restore?.joined).toBe(true);
		// The url in flight, NOT the one this client typed: the panel can only
		// say so honestly because both are kept.
		expect(s.restore?.job?.url).toBe('git@github.com:owner/repo.git');
		expect(s.restore?.requestedUrl).toBe('git@github.com:someone/else.git');
	});

	it('surfaces a refusal without inventing a job', () => {
		loadMissingFolderSession();

		client.startRestore('clone', 'https://github.com/owner/repo.git');
		ws.last().receive({
			type: 'restore_rejected',
			targetPath: TARGET,
			reason: 'invalid-url',
			message: 'Refusing to clone "https://github.com/owner/repo.git": not a recognised SSH repository URL',
		});

		const s = get(client.stateStore);
		expect(s.restore?.job).toBeNull();
		expect(s.restore?.rejection?.reason).toBe('invalid-url');
		// A corrected retry clears the refusal so the panel is not stuck on it.
		client.startRestore('clone', 'git@github.com:owner/repo.git');
		expect(get(client.stateStore).restore?.rejection).toBeNull();
	});

	it('carries a failure with its mapped cause and git raw output', () => {
		loadMissingFolderSession();
		ws.last().receive({
			type: 'restore_complete',
			targetPath: TARGET,
			job: runningJob({
				state: 'failed',
				failure: {
					cause: 'no-key',
					message: 'No SSH key on this machine is accepted by github.com.',
					stderr: 'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.\n',
				},
			}),
		});

		const failure = get(client.stateStore).restore?.job?.failure;
		expect(failure?.cause).toBe('no-key');
		expect(failure?.stderr).toContain('Permission denied (publickey)');

		// Retrying drops the FINISHED job it is retrying, so the panel shows the
		// request in flight rather than the previous failure until the server
		// answers. (A RUNNING job would be kept: that is the one being joined.)
		client.startRestore('clone', 'git@github.com:owner/repo.git');
		expect(get(client.stateStore).restore?.job).toBeNull();
	});

	it('cancels the job for its own folder, and nothing when there is none', () => {
		loadMissingFolderSession(runningJob());
		expect(client.cancelRestore()).toBe(true);
		expect(ws.last().lastSentOfType('restore_cancel')).toEqual({
			type: 'restore_cancel',
			targetPath: TARGET,
		});

		ws.last().receive({
			type: 'restore_complete',
			targetPath: TARGET,
			job: runningJob({state: 'cancelled', endedAt: 4}),
		});
		expect(get(client.stateStore).restore?.job?.state).toBe('cancelled');
	});

	it('ignores restore frames for a folder it is not looking at', () => {
		loadMissingFolderSession(runningJob());

		ws.last().receive({
			type: 'restore_progress',
			targetPath: '/home/u/dev/github/owner/other',
			job: {...runningJob(), id: 99, targetPath: '/home/u/dev/github/owner/other'},
		});

		expect(get(client.stateStore).restore?.job?.id).toBe(7);
	});

	it('reloads the session to go live, and clears the restore with it', () => {
		loadMissingFolderSession();
		ws.last().receive({
			type: 'restore_complete',
			targetPath: TARGET,
			job: runningJob({state: 'done', endedAt: 5}),
		});

		// A live agent is a LOAD-TIME decision, so going live is a re-load of the
		// same session file, not a local unlock.
		expect(client.reloadSession()).toBe(true);
		expect(ws.last().lastSentOfType('session_load')).toMatchObject({
			type: 'session_load',
			sessionFile: SESSION_FILE,
		});
		const s = get(client.stateStore);
		expect(s.restore).toBeNull();
		expect(s.folderMissing).toBeNull();
	});

	it('clears with the session it belonged to', () => {
		loadMissingFolderSession(runningJob());

		client.switchSession('/home/u/dev/other/session.jsonl');
		expect(get(client.stateStore).restore).toBeNull();
	});
});
