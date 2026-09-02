import type { CaptureRun, TranscriptSegment, TranslationThread } from '../session/types';
import type { StoredAutoSummary } from '../sidecar/auto-summary';
import type { StoredCleanTranscriptBlock } from '../sidecar/clean-transcript';
import type {
	StoredTranslationPairBatch,
	StoredTranslationPairProjection,
	StoredTranslationPairSegment
} from '../projection/translation-pair-records';
import {
	fromRunRecord,
	fromThreadRecord,
	type LocalRunRecord,
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

export interface SaveTranslationPairBatchInput {
	batch: StoredTranslationPairBatch;
	segments: StoredTranslationPairSegment[];
	facts?: {
		thread: TranslationThread;
		run: CaptureRun;
		checkpointedAt: string;
	};
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

function validateTranslationPairBatchShape(input: SaveTranslationPairBatchInput): void {
	const { batch, segments } = input;
	if (
		batch.sequence <= 0 ||
		batch.revision <= 0 ||
		batch.runSequence <= 0 ||
		batch.sourceStart < 0 ||
		batch.sourceEnd <= batch.sourceStart ||
		(batch.status === 'completed' && segments.length === 0) ||
		(batch.status === 'failed' && segments.length !== 0) ||
		(batch.usageStatus === 'recorded' && batch.usage === null) ||
		(batch.usageStatus === 'unavailable' && batch.usage !== null)
	) {
		throw new Error(`Translation pair batch ${batch.id} has an invalid shape.`);
	}
	let expectedStart = batch.sourceStart;
	for (const [index, segment] of segments.entries()) {
		if (
			segment.batchId !== batch.id ||
			segment.batchRevision !== batch.revision ||
			segment.threadId !== batch.threadId ||
			segment.runId !== batch.runId ||
			segment.runSequence !== batch.runSequence ||
			segment.sequence !== index + 1 ||
			segment.sourceStart !== expectedStart ||
			segment.sourceEnd <= segment.sourceStart ||
			!segment.translatedText.trim()
		) {
			throw new Error(`Translation pair segment ${segment.id} does not match batch ${batch.id}.`);
		}
		expectedStart = segment.sourceEnd;
	}
	if (segments.length > 0 && expectedStart !== batch.sourceEnd) {
		throw new Error(`Translation pair batch ${batch.id} is not covered by its segments.`);
	}
	if (
		input.facts &&
		(input.facts.thread.id !== batch.threadId ||
			input.facts.run.id !== batch.runId ||
			input.facts.run.threadId !== batch.threadId)
	) {
		throw new Error(`Translation pair batch ${batch.id} fact snapshot has a different identity.`);
	}
}

function extendRunFacts(stored: LocalRunRecord, captured: CaptureRun): LocalRunRecord {
	const storedRun = fromRunRecord(stored);
	if (
		(!captured.sourceStream.text.startsWith(storedRun.sourceStream.text) &&
			!storedRun.sourceStream.text.startsWith(captured.sourceStream.text)) ||
		(!captured.translationStream.text.startsWith(storedRun.translationStream.text) &&
			!storedRun.translationStream.text.startsWith(captured.translationStream.text))
	) {
		throw new Error(`Run ${captured.id} fact streams are not append-only.`);
	}
	return {
		...stored,
		sourceStream:
			captured.sourceStream.text.length > storedRun.sourceStream.text.length
				? captured.sourceStream
				: storedRun.sourceStream,
		translationStream:
			captured.translationStream.text.length > storedRun.translationStream.text.length
				? captured.translationStream
				: storedRun.translationStream
	};
}

export class LocalSessionRepository {
	constructor(readonly database = new VoxBraidLocalDatabase()) {}

	async saveCheckpoint(input: SaveCheckpointInput): Promise<void> {
		validateCheckpoint(input);
		await this.database.transaction('rw', this.database.threads, this.database.runs, async () => {
			await this.database.threads.put(toThreadRecord(input.thread, input.checkpointedAt));
			const incoming = toRunRecord(input.run, input.checkpointedAt);
			const stored = await this.database.runs.get(input.run.id);
			const extended = stored ? extendRunFacts(stored, input.run) : incoming;
			await this.database.runs.put({
				...incoming,
				sourceStream: extended.sourceStream,
				translationStream: extended.translationStream
			});
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

	async loadAutoSummary(threadId: string): Promise<StoredAutoSummary | null> {
		return (await this.database.autoSummaries.get(threadId)) ?? null;
	}

	async saveAutoSummary(summary: StoredAutoSummary): Promise<void> {
		const thread = await this.database.threads.get(summary.threadId);
		if (!thread) throw new Error(`Thread not found: ${summary.threadId}.`);
		await this.database.autoSummaries.put(summary);
	}

	async loadCleanTranscriptBlocks(threadId: string): Promise<StoredCleanTranscriptBlock[]> {
		const blocks = await this.database.cleanTranscriptBlocks
			.where('threadId')
			.equals(threadId)
			.toArray();
		return blocks.sort((left, right) => left.sequence - right.sequence);
	}

	async saveCleanTranscriptBlock(block: StoredCleanTranscriptBlock): Promise<void> {
		if (
			block.sequence <= 0 ||
			block.sourceStart < 0 ||
			block.sourceEnd < block.sourceStart ||
			block.translationStart < 0 ||
			block.translationEnd < block.translationStart
		) {
			throw new Error(`Clean transcript block ${block.id} has invalid ranges.`);
		}
		await this.database.transaction(
			'rw',
			this.database.threads,
			this.database.runs,
			this.database.cleanTranscriptBlocks,
			async () => {
				const [thread, run] = await Promise.all([
					this.database.threads.get(block.threadId),
					this.database.runs.get(block.runId)
				]);
				if (!thread) throw new Error(`Thread not found: ${block.threadId}.`);
				if (!run) throw new Error(`Run not found: ${block.runId}.`);
				if (run.threadId !== block.threadId || run.sequence !== block.runSequence) {
					throw new Error(`Clean transcript block ${block.id} does not match its run.`);
				}
				await this.database.cleanTranscriptBlocks.put(block);
			}
		);
	}

	async clearCleanTranscript(threadId: string): Promise<void> {
		await this.database.transaction(
			'rw',
			this.database.threads,
			this.database.autoSummaries,
			this.database.cleanTranscriptBlocks,
			async () => {
				if (!(await this.database.threads.get(threadId))) {
					throw new Error(`Thread not found: ${threadId}.`);
				}
				await this.database.autoSummaries.delete(threadId);
				await this.database.cleanTranscriptBlocks.where('threadId').equals(threadId).delete();
			}
		);
	}

	async loadTranslationPairProjection(threadId: string): Promise<StoredTranslationPairProjection> {
		return this.database.transaction(
			'r',
			this.database.translationPairBatches,
			this.database.translationPairSegments,
			async () => {
				const batches = await this.database.translationPairBatches
					.where('threadId')
					.equals(threadId)
					.toArray();
				const batchIds = batches.map((batch) => batch.id);
				const segments =
					batchIds.length === 0
						? []
						: await this.database.translationPairSegments
								.where('batchId')
								.anyOf(batchIds)
								.toArray();
				return {
					batches: batches.sort(
						(left, right) => left.runSequence - right.runSequence || left.sequence - right.sequence
					),
					segments: segments.sort(
						(left, right) =>
							left.runSequence - right.runSequence ||
							left.sourceStart - right.sourceStart ||
							left.sequence - right.sequence
					)
				};
			}
		);
	}

	async saveTranslationPairBatch(input: SaveTranslationPairBatchInput): Promise<void> {
		validateTranslationPairBatchShape(input);
		const { batch, segments } = input;
		await this.database.transaction(
			'rw',
			this.database.threads,
			this.database.runs,
			this.database.translationPairBatches,
			this.database.translationPairSegments,
			async () => {
				let [thread, run] = await Promise.all([
					this.database.threads.get(batch.threadId),
					this.database.runs.get(batch.runId)
				]);
				if (!thread && input.facts) {
					thread = toThreadRecord(input.facts.thread, input.facts.checkpointedAt);
					await this.database.threads.put(thread);
				}
				if (!run && input.facts) {
					run = toRunRecord(input.facts.run, input.facts.checkpointedAt);
					await this.database.runs.put(run);
				} else if (
					run &&
					input.facts &&
					(run.sourceStream.text.length < input.facts.run.sourceStream.text.length ||
						run.translationStream.text.length < input.facts.run.translationStream.text.length)
				) {
					run = extendRunFacts(run, input.facts.run);
					await this.database.runs.put(run);
				}
				if (!thread) throw new Error(`Thread not found: ${batch.threadId}.`);
				if (!run) throw new Error(`Run not found: ${batch.runId}.`);
				if (
					run.threadId !== batch.threadId ||
					run.sequence !== batch.runSequence ||
					batch.sourceEnd > run.sourceStream.text.length
				) {
					throw new Error(`Translation pair batch ${batch.id} does not match its run.`);
				}
				for (const segment of segments) {
					if (
						segment.sourceText !==
						run.sourceStream.text.slice(segment.sourceStart, segment.sourceEnd)
					) {
						throw new Error(`Translation pair segment ${segment.id} changed source facts.`);
					}
				}
				await this.database.translationPairSegments.where('batchId').equals(batch.id).delete();
				await this.database.translationPairBatches.put(batch);
				if (segments.length > 0) await this.database.translationPairSegments.bulkPut(segments);
			}
		);
	}

	async clearTranslationPairProjection(threadId: string): Promise<void> {
		await this.database.transaction(
			'rw',
			this.database.threads,
			this.database.translationPairBatches,
			this.database.translationPairSegments,
			async () => {
				if (!(await this.database.threads.get(threadId))) {
					throw new Error(`Thread not found: ${threadId}.`);
				}
				const batchIds = (
					await this.database.translationPairBatches.where('threadId').equals(threadId).toArray()
				).map((batch) => batch.id);
				if (batchIds.length > 0) {
					await this.database.translationPairSegments.where('batchId').anyOf(batchIds).delete();
				}
				await this.database.translationPairBatches.where('threadId').equals(threadId).delete();
			}
		);
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
		const [stored, translationPairs] = await Promise.all([
			this.loadThread(threadId),
			this.loadTranslationPairProjection(threadId)
		]);
		if (!stored) throw new Error(`Thread not found: ${threadId}.`);
		return stringifySessionArchive({
			schemaVersion: SESSION_ARCHIVE_VERSION,
			exportedAt,
			...stored,
			translationPairs
		});
	}

	async importThread(value: string, checkpointedAt: string): Promise<string> {
		const archive = parseSessionArchive(value);
		await this.database.transaction(
			'rw',
			[
				this.database.threads,
				this.database.runs,
				this.database.segments,
				this.database.autoSummaries,
				this.database.cleanTranscriptBlocks,
				this.database.translationPairBatches,
				this.database.translationPairSegments
			],
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
				const importedPairBatchCollisions = await this.database.translationPairBatches.bulkGet(
					archive.translationPairs.batches.map((batch) => batch.id)
				);
				if (
					importedPairBatchCollisions.some(
						(batch) => batch !== undefined && batch.threadId !== archive.thread.id
					)
				) {
					throw new Error('Imported translation pair batch ID belongs to another thread.');
				}
				const importedPairSegmentCollisions = await this.database.translationPairSegments.bulkGet(
					archive.translationPairs.segments.map((segment) => segment.id)
				);
				if (
					importedPairSegmentCollisions.some(
						(segment) => segment !== undefined && segment.threadId !== archive.thread.id
					)
				) {
					throw new Error('Imported translation pair segment ID belongs to another thread.');
				}

				if (existingRunIds.length > 0) {
					await this.database.segments.where('runId').anyOf(existingRunIds).delete();
				}
				await this.database.autoSummaries.delete(archive.thread.id);
				await this.database.cleanTranscriptBlocks
					.where('threadId')
					.equals(archive.thread.id)
					.delete();
				const pairBatchIds = (
					await this.database.translationPairBatches
						.where('threadId')
						.equals(archive.thread.id)
						.toArray()
				).map((batch) => batch.id);
				if (pairBatchIds.length > 0) {
					await this.database.translationPairSegments.where('batchId').anyOf(pairBatchIds).delete();
				}
				await this.database.translationPairBatches
					.where('threadId')
					.equals(archive.thread.id)
					.delete();
				await this.database.runs.where('threadId').equals(archive.thread.id).delete();
				await this.database.threads.put(toThreadRecord(archive.thread, checkpointedAt));
				await this.database.runs.bulkPut(
					archive.runs.map((run) => toRunRecord(run, checkpointedAt))
				);
				await this.database.segments.bulkPut(archive.segments);
				await this.database.translationPairBatches.bulkPut(archive.translationPairs.batches);
				await this.database.translationPairSegments.bulkPut(archive.translationPairs.segments);
			}
		);
		return archive.thread.id;
	}

	close(): void {
		this.database.close();
	}
}
