import type { CaptureRun, TranscriptSegment, TranslationThread } from '../session/types';
import {
	fromRunRecord,
	fromThreadRecord,
	toRunRecord,
	toThreadRecord,
	VoxBraidLocalDatabase
} from './local-session-database';
import {
	SESSION_ARCHIVE_VERSION,
	parseSessionArchive,
	stringifySessionArchive
} from './session-archive';

const ABANDONED_STATUSES = new Set(['starting', 'live', 'stopping']);

export interface StoredThread {
	thread: TranslationThread;
	runs: CaptureRun[];
	segments: TranscriptSegment[];
}

export interface SaveCheckpointInput {
	thread: TranslationThread;
	run: CaptureRun;
	checkpointedAt: string;
}

export interface ReplaceSegmentRevisionInput {
	run: CaptureRun;
	segments: TranscriptSegment[];
	checkpointedAt: string;
}

function compareRuns(left: CaptureRun, right: CaptureRun): number {
	return left.sequence - right.sequence;
}

function compareSegments(left: TranscriptSegment, right: TranscriptSegment): number {
	return (
		left.runId.localeCompare(right.runId) ||
		left.revision - right.revision ||
		left.sequence - right.sequence
	);
}

function estimateAudioDuration(run: CaptureRun, endedAt: string): number {
	if (run.audioDurationMs > 0 || run.mediaStartedAt === null) return run.audioDurationMs;
	return Math.max(0, Date.parse(endedAt) - Date.parse(run.mediaStartedAt));
}

function latestSegmentUpdate(segments: TranscriptSegment[]): string | null {
	return segments.reduce<string | null>(
		(latest, segment) =>
			latest === null || segment.updatedAt > latest ? segment.updatedAt : latest,
		null
	);
}

function repairedRun(run: CaptureRun, segments: TranscriptSegment[]): CaptureRun {
	const endedAt = run.lastActivityAt ?? latestSegmentUpdate(segments) ?? run.createdAt;
	return {
		...run,
		status: 'interrupted',
		endedAt,
		hiddenAt: null,
		audioDurationMs: estimateAudioDuration(run, endedAt),
		endTimeEstimated: true,
		endReason: 'page-terminated'
	};
}

function validateCheckpoint(input: SaveCheckpointInput): void {
	if (input.run.threadId !== input.thread.id) {
		throw new Error(`Run ${input.run.id} does not belong to thread ${input.thread.id}.`);
	}
}

function validateRevision(input: ReplaceSegmentRevisionInput): number {
	const revision = input.run.currentSegmentRevision;
	if (!Number.isInteger(revision) || revision === null || revision <= 0) {
		throw new Error('Run must point to a positive current segment revision.');
	}
	if (input.segments.length === 0) throw new Error('A segment revision must not be empty.');
	for (const segment of input.segments) {
		if (segment.runId !== input.run.id || segment.revision !== revision) {
			throw new Error(`Segment ${segment.id} does not belong to run revision ${revision}.`);
		}
	}
	return revision;
}

export class LocalSessionRepository {
	constructor(readonly database = new VoxBraidLocalDatabase()) {}

	async saveCheckpoint(input: SaveCheckpointInput): Promise<void> {
		validateCheckpoint(input);
		await this.database.transaction('rw', this.database.threads, this.database.runs, async () => {
			await this.database.threads.put(toThreadRecord(input.thread, input.checkpointedAt));
			await this.database.runs.put(toRunRecord(input.run, input.checkpointedAt));
		});
	}

	async loadThread(threadId: string): Promise<StoredThread | null> {
		return this.database.transaction(
			'r',
			this.database.threads,
			this.database.runs,
			this.database.segments,
			async () => {
				const threadRecord = await this.database.threads.get(threadId);
				if (!threadRecord) return null;
				const runRecords = await this.database.runs.where('threadId').equals(threadId).toArray();
				const runIds = runRecords.map((run) => run.id);
				const segments =
					runIds.length === 0
						? []
						: await this.database.segments.where('runId').anyOf(runIds).toArray();
				return {
					thread: fromThreadRecord(threadRecord),
					runs: runRecords.map(fromRunRecord).sort(compareRuns),
					segments: segments.sort(compareSegments)
				};
			}
		);
	}

	async listThreads(): Promise<TranslationThread[]> {
		const records = await this.database.threads.orderBy('updatedAt').reverse().toArray();
		return records.map(fromThreadRecord);
	}

	async replaceSegmentRevision(input: ReplaceSegmentRevisionInput): Promise<void> {
		const revision = validateRevision(input);
		await this.database.transaction('rw', this.database.runs, this.database.segments, async () => {
			const storedRun = await this.database.runs.get(input.run.id);
			if (!storedRun) throw new Error(`Run not found: ${input.run.id}.`);
			if (storedRun.threadId !== input.run.threadId) {
				throw new Error(`Run ${input.run.id} changed thread identity.`);
			}
			await this.database.segments
				.where('[runId+revision]')
				.equals([input.run.id, revision])
				.delete();
			await this.database.segments.bulkPut(input.segments);
			await this.database.runs.put(toRunRecord(input.run, input.checkpointedAt));
		});
	}

	async repairAbandonedRuns(threadId: string, checkpointedAt: string): Promise<CaptureRun[]> {
		return this.database.transaction(
			'rw',
			this.database.threads,
			this.database.runs,
			this.database.segments,
			async () => {
				const thread = await this.database.threads.get(threadId);
				if (!thread) return [];
				const runRecords = await this.database.runs.where('threadId').equals(threadId).toArray();
				const abandoned = runRecords.filter((run) => ABANDONED_STATUSES.has(run.status));
				const repaired: CaptureRun[] = [];
				for (const record of abandoned) {
					const segments = await this.database.segments.where('runId').equals(record.id).toArray();
					const run = repairedRun(fromRunRecord(record), segments);
					await this.database.runs.put(toRunRecord(run, checkpointedAt));
					repaired.push(run);
				}
				if (repaired.length > 0) {
					await this.database.threads.put(
						toThreadRecord(
							{ ...fromThreadRecord(thread), updatedAt: checkpointedAt },
							checkpointedAt
						)
					);
				}
				return repaired.sort(compareRuns);
			}
		);
	}

	async exportThread(threadId: string, exportedAt: string): Promise<string> {
		const stored = await this.loadThread(threadId);
		if (!stored) throw new Error(`Thread not found: ${threadId}.`);
		return stringifySessionArchive({
			schemaVersion: SESSION_ARCHIVE_VERSION,
			exportedAt,
			...stored
		});
	}

	async importThread(value: string, checkpointedAt: string): Promise<void> {
		const archive = parseSessionArchive(value);
		await this.database.transaction(
			'rw',
			this.database.threads,
			this.database.runs,
			this.database.segments,
			async () => {
				const existingRuns = await this.database.runs
					.where('threadId')
					.equals(archive.thread.id)
					.toArray();
				const importedRunCollisions = await this.database.runs.bulkGet(
					archive.runs.map((run) => run.id)
				);
				if (
					importedRunCollisions.some(
						(run) => run !== undefined && run.threadId !== archive.thread.id
					)
				) {
					throw new Error('Imported run ID already belongs to another thread.');
				}
				const existingRunIds = existingRuns.map((run) => run.id);
				const existingRunIdSet = new Set(existingRunIds);
				const importedSegmentCollisions = await this.database.segments.bulkGet(
					archive.segments.map((segment) => segment.id)
				);
				if (
					importedSegmentCollisions.some(
						(segment) => segment !== undefined && !existingRunIdSet.has(segment.runId)
					)
				) {
					throw new Error('Imported segment ID already belongs to another thread.');
				}

				if (existingRunIds.length > 0) {
					await this.database.segments.where('runId').anyOf(existingRunIds).delete();
				}
				await this.database.runs.where('threadId').equals(archive.thread.id).delete();
				await this.database.threads.put(toThreadRecord(archive.thread, checkpointedAt));
				await this.database.runs.bulkPut(
					archive.runs.map((run) => toRunRecord(run, checkpointedAt))
				);
				await this.database.segments.bulkPut(archive.segments);
			}
		);
	}

	close(): void {
		this.database.close();
	}
}
