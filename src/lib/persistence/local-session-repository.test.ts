import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CaptureRun, TranscriptSegment, TranslationThread } from '../session/types';
import type { StoredAutoSummary } from '../sidecar/auto-summary';
import type { StoredCleanTranscriptBlock } from '../sidecar/clean-transcript';
import { VoxBraidLocalDatabase } from './local-session-database';
import { LocalSessionRepository } from './local-session-repository';

const START = '2026-09-01T00:00:00.000Z';
const CHECKPOINT = '2026-09-01T00:00:10.000Z';

function createAutoSummary(overrides: Partial<StoredAutoSummary> = {}): StoredAutoSummary {
	return {
		threadId: 'thread-1',
		revision: 1,
		text: 'A complete current summary.',
		capturedAt: '2026-09-01T00:00:09.000Z',
		sourceCharacters: 120,
		translationCharacters: 48,
		model: 'gpt-5.6-luna',
		usageStatus: 'recorded',
		usage: {
			inputTokens: 100,
			cachedInputTokens: 0,
			outputTokens: 20,
			reasoningTokens: 0,
			totalTokens: 120
		},
		updatedAt: CHECKPOINT,
		...overrides
	};
}

function createCleanBlock(
	overrides: Partial<StoredCleanTranscriptBlock> = {}
): StoredCleanTranscriptBlock {
	return {
		id: 'clean-block-1',
		threadId: 'thread-1',
		runId: 'run-1',
		sequence: 1,
		runSequence: 1,
		targetLanguage: 'zh',
		sourceStart: 0,
		sourceEnd: 20,
		translationStart: 0,
		translationEnd: 10,
		sourceElapsedEndMs: 4_000,
		translationElapsedEndMs: 4_000,
		status: 'completed',
		text: '整理后的课堂内容。',
		capturedAt: '2026-09-01T00:00:09.000Z',
		model: 'gpt-5.6-terra',
		taskVersion: 5,
		usageStatus: 'unavailable',
		usage: null,
		error: null,
		updatedAt: CHECKPOINT,
		...overrides
	};
}

function createThread(id = 'thread-1'): TranslationThread {
	return {
		id,
		ownerId: null,
		title: null,
		defaultTargetLanguage: 'zh',
		status: 'active',
		createdAt: START,
		updatedAt: START
	};
}

function createRun(id = 'run-1', sequence = 1, overrides: Partial<CaptureRun> = {}): CaptureRun {
	return {
		id,
		threadId: 'thread-1',
		sequence,
		status: 'live',
		targetLanguage: 'zh',
		createdAt: '2026-09-01T00:00:01.000Z',
		mediaStartedAt: '2026-09-01T00:00:02.000Z',
		endedAt: null,
		lastActivityAt: '2026-09-01T00:00:06.000Z',
		hiddenAt: null,
		audioDurationMs: 4_000,
		endTimeEstimated: false,
		endReason: null,
		recoveredFromRunId: null,
		clientPlatform: 'test',
		lastError: null,
		sourceStream: {
			text: 'Hello from the complete source stream.',
			lastElapsedMs: 4_000,
			updatedAt: '2026-09-01T00:00:06.000Z'
		},
		translationStream: {
			text: '来自完整事实流的你好。',
			lastElapsedMs: 4_000,
			updatedAt: '2026-09-01T00:00:06.000Z'
		},
		currentSegmentRevision: null,
		...overrides
	};
}

function createSegment(
	id: string,
	revision: number,
	sequence: number,
	overrides: Partial<TranscriptSegment> = {}
): TranscriptSegment {
	return {
		id,
		runId: 'run-1',
		revision,
		sequence,
		sourceText: `source ${sequence}`,
		translatedText: `译文 ${sequence}`,
		alignment: 'approximate',
		createdAt: '2026-09-01T00:00:07.000Z',
		updatedAt: '2026-09-01T00:00:08.000Z',
		...overrides
	};
}

let database: VoxBraidLocalDatabase;
let repository: LocalSessionRepository;

beforeEach(() => {
	database = new VoxBraidLocalDatabase(`voxbraid-test-${crypto.randomUUID()}`);
	repository = new LocalSessionRepository(database);
});

afterEach(async () => {
	await database.delete();
});

describe('LocalSessionRepository', () => {
	it('upgrades an existing version 1 database without losing transcript records', async () => {
		const name = `voxbraid-upgrade-test-${crypto.randomUUID()}`;
		const legacy = new Dexie(name);
		legacy.version(1).stores({
			threads: '&id,status,updatedAt',
			runs: '&id,threadId,status,&[threadId+sequence],[threadId+status]',
			segments: '&id,runId,[runId+revision],&[runId+revision+sequence]'
		});
		const thread = createThread();
		await legacy.open();
		await legacy.table('threads').put({ ...thread, checkpointedAt: CHECKPOINT });
		legacy.close();

		const upgraded = new VoxBraidLocalDatabase(name);
		try {
			await upgraded.open();
			expect(await upgraded.threads.get(thread.id)).toMatchObject(thread);
			expect(await upgraded.autoSummaries.toArray()).toEqual([]);
			expect(await upgraded.cleanTranscriptBlocks.toArray()).toEqual([]);
		} finally {
			await upgraded.delete();
		}
	});

	it('upgrades a version 2 summary database while preserving its existing cleanup', async () => {
		const name = `voxbraid-v2-upgrade-test-${crypto.randomUUID()}`;
		const legacy = new Dexie(name);
		legacy.version(1).stores({
			threads: '&id,status,updatedAt',
			runs: '&id,threadId,status,&[threadId+sequence],[threadId+status]',
			segments: '&id,runId,[runId+revision],&[runId+revision+sequence]'
		});
		legacy.version(2).stores({ autoSummaries: '&threadId,updatedAt' });
		await legacy.open();
		await legacy.table('threads').put({ ...createThread(), checkpointedAt: CHECKPOINT });
		await legacy.table('autoSummaries').put(createAutoSummary());
		legacy.close();

		const upgraded = new VoxBraidLocalDatabase(name);
		try {
			await upgraded.open();
			expect(await upgraded.autoSummaries.get('thread-1')).toEqual(createAutoSummary());
			expect(await upgraded.cleanTranscriptBlocks.toArray()).toEqual([]);
		} finally {
			await upgraded.delete();
		}
	});

	it('saves the thread and full run checkpoint in one domain-shaped load', async () => {
		const thread = createThread();
		const run = createRun();

		await repository.saveCheckpoint({ thread, run, checkpointedAt: CHECKPOINT });

		await expect(repository.loadThread(thread.id)).resolves.toEqual({
			thread,
			runs: [run],
			segments: []
		});
		const loaded = await repository.loadThread(thread.id);
		if (!loaded) throw new Error('Expected the stored thread.');
		loaded.runs[0].sourceStream.text = 'mutated after reading';
		expect((await repository.loadThread(thread.id))?.runs[0].sourceStream.text).toBe(
			run.sourceStream.text
		);
		expect(await database.runs.get(run.id)).toMatchObject({
			checkpointedAt: CHECKPOINT,
			sourceStream: { text: run.sourceStream.text },
			translationStream: { text: run.translationStream.text }
		});
		await repository.saveCheckpoint({
			thread: {
				...createThread('thread-2'),
				updatedAt: '2026-09-01T00:00:20.000Z'
			},
			run: createRun('run-2', 1, { threadId: 'thread-2' }),
			checkpointedAt: '2026-09-01T00:00:20.000Z'
		});
		expect((await repository.listThreads()).map((item) => item.id)).toEqual([
			'thread-2',
			'thread-1'
		]);
	});

	it('rolls back the thread update when a run sequence constraint fails', async () => {
		const thread = createThread();
		await repository.saveCheckpoint({ thread, run: createRun(), checkpointedAt: CHECKPOINT });

		await expect(
			repository.saveCheckpoint({
				thread: { ...thread, title: 'must roll back' },
				run: createRun('run-2', 1),
				checkpointedAt: '2026-09-01T00:00:11.000Z'
			})
		).rejects.toMatchObject({ name: 'ConstraintError' });

		const stored = await repository.loadThread(thread.id);
		expect(stored?.thread.title).toBeNull();
		expect(stored?.runs.map((run) => run.id)).toEqual(['run-1']);
	});

	it('stores the latest replaceable automatic summary separately from transcript facts', async () => {
		const thread = createThread();
		await repository.saveCheckpoint({ thread, run: createRun(), checkpointedAt: CHECKPOINT });
		const first = createAutoSummary();
		await repository.saveAutoSummary(first);
		await expect(repository.loadAutoSummary(thread.id)).resolves.toEqual(first);

		const replacement = createAutoSummary({
			revision: 2,
			text: 'A newly regenerated complete summary.',
			sourceCharacters: 240
		});
		await repository.saveAutoSummary(replacement);
		await expect(repository.loadAutoSummary(thread.id)).resolves.toEqual(replacement);
		await expect(repository.loadThread(thread.id)).resolves.toMatchObject({
			thread,
			runs: [{ sourceStream: { text: createRun().sourceStream.text } }]
		});
	});

	it('rejects an automatic summary for a missing thread', async () => {
		await expect(
			repository.saveAutoSummary(createAutoSummary({ threadId: 'missing-thread' }))
		).rejects.toThrow('Thread not found');
	});

	it('stores ordered clean transcript blocks and allows an explicit retry replacement', async () => {
		const thread = createThread();
		await repository.saveCheckpoint({ thread, run: createRun(), checkpointedAt: CHECKPOINT });
		const failed = createCleanBlock({
			status: 'failed',
			text: '',
			error: 'upstream-failed：temporary failure'
		});
		await repository.saveCleanTranscriptBlock(failed);
		await expect(repository.loadCleanTranscriptBlocks(thread.id)).resolves.toEqual([failed]);

		const completed = createCleanBlock({ status: 'completed', error: null });
		await repository.saveCleanTranscriptBlock(completed);
		await expect(repository.loadCleanTranscriptBlocks(thread.id)).resolves.toEqual([completed]);
	});

	it('clears only cleanup projections before rebuilding a complete transcript', async () => {
		const thread = createThread();
		const run = createRun();
		await repository.saveCheckpoint({ thread, run, checkpointedAt: CHECKPOINT });
		await repository.saveAutoSummary(createAutoSummary());
		await repository.saveCleanTranscriptBlock(createCleanBlock());

		await repository.clearCleanTranscript(thread.id);

		await expect(repository.loadAutoSummary(thread.id)).resolves.toBeNull();
		await expect(repository.loadCleanTranscriptBlocks(thread.id)).resolves.toEqual([]);
		await expect(repository.loadThread(thread.id)).resolves.toMatchObject({
			thread,
			runs: [{ id: run.id, sourceStream: run.sourceStream }]
		});
	});

	it('rejects a clean transcript block without its persisted run', async () => {
		await database.threads.put({ ...createThread(), checkpointedAt: CHECKPOINT });
		await expect(repository.saveCleanTranscriptBlock(createCleanBlock())).rejects.toThrow(
			'Run not found'
		);
	});

	it('atomically switches revisions while preserving older projections', async () => {
		const thread = createThread();
		await repository.saveCheckpoint({
			thread,
			run: createRun(),
			checkpointedAt: CHECKPOINT
		});

		const revision1 = createRun('run-1', 1, { currentSegmentRevision: 1 });
		await repository.replaceSegmentRevision({
			run: revision1,
			segments: [createSegment('segment-1', 1, 1), createSegment('segment-2', 1, 2)],
			checkpointedAt: '2026-09-01T00:00:12.000Z'
		});
		const revision2 = { ...revision1, currentSegmentRevision: 2 };
		await repository.replaceSegmentRevision({
			run: revision2,
			segments: [createSegment('segment-3', 2, 1)],
			checkpointedAt: '2026-09-01T00:00:13.000Z'
		});

		const stored = await repository.loadThread(thread.id);
		expect(stored?.runs[0].currentSegmentRevision).toBe(2);
		expect(stored?.segments.map((segment) => [segment.revision, segment.sequence])).toEqual([
			[1, 1],
			[1, 2],
			[2, 1]
		]);

		await expect(
			repository.replaceSegmentRevision({
				run: { ...revision2, currentSegmentRevision: 3 },
				segments: [createSegment('segment-4', 3, 1), createSegment('segment-5', 3, 1)],
				checkpointedAt: '2026-09-01T00:00:14.000Z'
			})
		).rejects.toMatchObject({ name: 'BulkError' });
		const afterFailure = await repository.loadThread(thread.id);
		expect(afterFailure?.runs[0].currentSegmentRevision).toBe(2);
		expect(afterFailure?.segments.some((segment) => segment.revision === 3)).toBe(false);
	});

	it('repairs abandoned runs without changing completed history', async () => {
		const thread = createThread();
		const live = createRun('run-1', 1, {
			audioDurationMs: 0,
			sourceStream: { text: 'hello', lastElapsedMs: null, updatedAt: null },
			translationStream: { text: '', lastElapsedMs: null, updatedAt: null }
		});
		const starting = createRun('run-2', 2, {
			status: 'starting',
			mediaStartedAt: null,
			lastActivityAt: null,
			audioDurationMs: 0,
			currentSegmentRevision: null
		});
		const completed = createRun('run-3', 3, {
			status: 'completed',
			endedAt: '2026-09-01T00:00:09.000Z',
			endReason: 'user-paused'
		});
		for (const run of [live, starting, completed]) {
			await repository.saveCheckpoint({ thread, run, checkpointedAt: CHECKPOINT });
		}
		await database.segments.put(
			createSegment('segment-starting', 1, 1, {
				runId: starting.id,
				updatedAt: '2026-09-01T00:00:05.000Z'
			})
		);

		const repaired = await repository.repairAbandonedRuns(thread.id, '2026-09-01T00:01:00.000Z');

		expect(repaired).toMatchObject([
			{
				id: live.id,
				status: 'interrupted',
				endedAt: live.lastActivityAt,
				audioDurationMs: 4_000,
				endReason: 'page-terminated',
				endTimeEstimated: true
			},
			{
				id: starting.id,
				status: 'interrupted',
				endedAt: '2026-09-01T00:00:05.000Z',
				endReason: 'page-terminated'
			}
		]);
		const stored = await repository.loadThread(thread.id);
		expect(stored?.thread.updatedAt).toBe('2026-09-01T00:01:00.000Z');
		expect(stored?.runs.find((run) => run.id === completed.id)).toEqual(completed);
	});

	it('exports and imports one complete thread without local record metadata', async () => {
		const thread = createThread();
		const run = createRun('run-1', 1, { currentSegmentRevision: 1 });
		await repository.saveCheckpoint({ thread, run, checkpointedAt: CHECKPOINT });
		await repository.replaceSegmentRevision({
			run,
			segments: [createSegment('segment-1', 1, 1)],
			checkpointedAt: CHECKPOINT
		});
		const exported = await repository.exportThread(thread.id, '2026-09-01T00:02:00.000Z');

		const importedDatabase = new VoxBraidLocalDatabase(
			`voxbraid-import-test-${crypto.randomUUID()}`
		);
		const importedRepository = new LocalSessionRepository(importedDatabase);
		try {
			await expect(
				importedRepository.importThread(exported, '2026-09-01T00:03:00.000Z')
			).resolves.toBe(thread.id);
			await expect(importedRepository.loadThread(thread.id)).resolves.toEqual({
				thread,
				runs: [run],
				segments: [createSegment('segment-1', 1, 1)]
			});
			expect(exported).not.toContain('checkpointedAt');
		} finally {
			await importedDatabase.delete();
		}
	});

	it('rejects malformed and cross-thread archives before replacing stored data', async () => {
		const thread = createThread();
		await repository.saveCheckpoint({
			thread,
			run: createRun(),
			checkpointedAt: CHECKPOINT
		});

		await expect(repository.importThread('{', CHECKPOINT)).rejects.toThrow('not valid JSON');
		const exported = JSON.parse(await repository.exportThread(thread.id, CHECKPOINT)) as {
			schemaVersion: number;
			runs: Array<{ threadId: string }>;
		};
		exported.schemaVersion = 2;
		await expect(repository.importThread(JSON.stringify(exported), CHECKPOINT)).rejects.toThrow(
			'Unsupported session archive version'
		);
		exported.schemaVersion = 1;
		exported.runs[0].threadId = 'thread-elsewhere';
		await expect(repository.importThread(JSON.stringify(exported), CHECKPOINT)).rejects.toThrow(
			'does not belong'
		);
		await expect(repository.loadThread(thread.id)).resolves.toMatchObject({
			runs: [{ id: 'run-1' }]
		});
	});
});
