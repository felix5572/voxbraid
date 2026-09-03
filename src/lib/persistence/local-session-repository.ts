import type { CaptureRun, TranscriptSegment, TranslationThread } from '../session/types';
import type { StoredAutoSummary } from '../sidecar/auto-summary';
import type { StoredCleanTranscriptBlock } from '../sidecar/clean-transcript';
import type {
	StoredRevisedSegment,
	StoredRevisionBatch,
	StoredRevisionProjection
} from '../projection/revision-records';
import { REVISION_MAX_OPEN_SOURCE_CHARACTERS } from '../projection/revision-constants';
import { OPERATIONAL_LOG_LIMIT, type OperationalLogEntry } from '../operational-log';
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
	stringifySessionArchive,
	type SessionArchive
} from './session-archive';
import { stringifyEvaluationBundle, type EvaluationBundleOptions } from './evaluation-bundle';

const ABANDONED_STATUSES = new Set(['starting', 'live', 'stopping']);

export interface StoredThread {
	thread: TranslationThread;
	runs: CaptureRun[];
	segments: TranscriptSegment[];
}

export interface ImportThreadResult {
	threadId: string;
	warnings: string[];
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

export interface SaveRevisionBatchInput {
	batch: StoredRevisionBatch;
	segments: StoredRevisedSegment[];
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

function validateRevisionBatchShape(input: SaveRevisionBatchInput): void {
	const { batch, segments } = input;
	if (
		batch.sequence <= 0 ||
		batch.runSequence <= 0 ||
		batch.openStart < 0 ||
		batch.openEnd <= batch.openStart ||
		batch.openEnd - batch.openStart > REVISION_MAX_OPEN_SOURCE_CHARACTERS ||
		(batch.status === 'completed' && segments.length === 0) ||
		(batch.status === 'failed' && segments.length !== 0) ||
		(batch.status === 'completed' &&
			(batch.completedAt === null ||
				batch.model === null ||
				batch.responseId === null ||
				batch.upstreamStatus !== null ||
				batch.errorCode !== null ||
				batch.error !== null)) ||
		(batch.status === 'failed' &&
			(batch.completedAt !== null || batch.errorCode === null || batch.error === null)) ||
		(batch.usageStatus === 'recorded' && batch.usage === null) ||
		(batch.usageStatus === 'unavailable' && batch.usage !== null)
	) {
		throw new Error(`Revision batch ${batch.id} has an invalid shape.`);
	}
	let expectedStart = batch.openStart;
	let sawOpen = false;
	for (const segment of segments) {
		if (
			segment.producedByBatchId !== batch.id ||
			segment.threadId !== batch.threadId ||
			segment.runId !== batch.runId ||
			segment.runSequence !== batch.runSequence ||
			segment.sourceStart !== expectedStart ||
			segment.sourceEnd <= segment.sourceStart ||
			segment.rawText.length !== segment.sourceEnd - segment.sourceStart ||
			!segment.revisedSourceText.trim() ||
			!segment.translatedText.trim() ||
			(segment.state === 'frozen' && segment.frozenAt === null) ||
			(segment.state === 'open' && segment.frozenAt !== null)
		) {
			throw new Error(`Revised segment ${segment.id} does not match batch ${batch.id}.`);
		}
		if (sawOpen && segment.state === 'frozen') {
			throw new Error(`Revision batch ${batch.id} places frozen content after open content.`);
		}
		if (segment.state === 'open') sawOpen = true;
		expectedStart = segment.sourceEnd;
	}
	if (segments.length > 0 && expectedStart !== batch.openEnd) {
		throw new Error(`Revision batch ${batch.id} is not covered by its segments.`);
	}
	if (
		input.facts &&
		(input.facts.thread.id !== batch.threadId ||
			input.facts.run.id !== batch.runId ||
			input.facts.run.threadId !== batch.threadId)
	) {
		throw new Error(`Revision batch ${batch.id} fact snapshot has a different identity.`);
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

	async loadOperationalLogs(): Promise<OperationalLogEntry[]> {
		return this.database.operationalLogs
			.orderBy('lastOccurredAt')
			.reverse()
			.limit(OPERATIONAL_LOG_LIMIT)
			.toArray();
	}

	async saveOperationalLog(entry: OperationalLogEntry): Promise<void> {
		await this.database.transaction('rw', this.database.operationalLogs, async () => {
			await this.database.operationalLogs.put(entry);
			const overflow = (await this.database.operationalLogs.count()) - OPERATIONAL_LOG_LIMIT;
			if (overflow > 0) {
				const oldest = await this.database.operationalLogs
					.orderBy('lastOccurredAt')
					.limit(overflow)
					.primaryKeys();
				await this.database.operationalLogs.bulkDelete(oldest);
			}
		});
	}

	async clearOperationalLogs(): Promise<void> {
		await this.database.operationalLogs.clear();
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

	async loadRevisionProjection(threadId: string): Promise<StoredRevisionProjection> {
		return this.database.transaction(
			'r',
			this.database.revisionBatches,
			this.database.revisedSegments,
			async () => {
				const batches = await this.database.revisionBatches
					.where('threadId')
					.equals(threadId)
					.toArray();
				const segments = await this.database.revisedSegments
					.where('threadId')
					.equals(threadId)
					.toArray();
				return {
					batches: batches.sort(
						(left, right) => left.runSequence - right.runSequence || left.sequence - right.sequence
					),
					segments: segments.sort(
						(left, right) =>
							left.runSequence - right.runSequence || left.sourceStart - right.sourceStart
					)
				};
			}
		);
	}

	async saveRevisionBatch(input: SaveRevisionBatchInput): Promise<void> {
		validateRevisionBatchShape(input);
		const { batch, segments } = input;
		await this.database.transaction(
			'rw',
			this.database.threads,
			this.database.runs,
			this.database.revisionBatches,
			this.database.revisedSegments,
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
				} else if (run && input.facts) {
					const extended = extendRunFacts(run, input.facts.run);
					if (
						extended.sourceStream !== run.sourceStream ||
						extended.translationStream !== run.translationStream
					) {
						run = extended;
						await this.database.runs.put(run);
					}
				}
				if (!thread) throw new Error(`Thread not found: ${batch.threadId}.`);
				if (!run) throw new Error(`Run not found: ${batch.runId}.`);
				if (
					run.threadId !== batch.threadId ||
					run.sequence !== batch.runSequence ||
					batch.openEnd > run.sourceStream.text.length
				) {
					throw new Error(`Revision batch ${batch.id} does not match its run.`);
				}
				for (const segment of segments) {
					if (
						segment.rawText !== run.sourceStream.text.slice(segment.sourceStart, segment.sourceEnd)
					) {
						throw new Error(`Revised segment ${segment.id} changed source facts.`);
					}
				}
				if (batch.status === 'completed') {
					const existing = await this.database.revisedSegments
						.where('runId')
						.equals(batch.runId)
						.toArray();
					const frozen = existing
						.filter((segment) => segment.state === 'frozen')
						.sort((left, right) => left.sourceStart - right.sourceStart);
					const frozenEnd = frozen.at(-1)?.sourceEnd ?? 0;
					if (frozenEnd !== batch.openStart) {
						throw new Error(
							`Revision batch ${batch.id} starts at ${batch.openStart}, expected frozen end ${frozenEnd}.`
						);
					}
					await this.database.revisedSegments
						.where('runId')
						.equals(batch.runId)
						.filter((segment) => segment.state === 'open')
						.delete();
					await this.database.revisedSegments.bulkPut(segments);
				}
				await this.database.revisionBatches.put(batch);
			}
		);
	}

	async freezeRevisionOpenSegments(
		threadId: string,
		runId: string,
		frozenAt: string
	): Promise<StoredRevisedSegment[]> {
		return this.database.transaction(
			'rw',
			this.database.runs,
			this.database.revisedSegments,
			async () => {
				const run = await this.database.runs.get(runId);
				if (!run || run.threadId !== threadId) throw new Error(`Run not found: ${runId}.`);
				const stored = (
					await this.database.revisedSegments.where('runId').equals(runId).toArray()
				).sort((left, right) => left.sourceStart - right.sourceStart);
				const next = stored.map((segment) =>
					segment.state === 'open' ? { ...segment, state: 'frozen' as const, frozenAt } : segment
				);
				if (next.some((segment, index) => segment !== stored[index])) {
					await this.database.revisedSegments.bulkPut(next);
				}
				return next;
			}
		);
	}

	async clearRevisionProjection(threadId: string): Promise<void> {
		await this.database.transaction(
			'rw',
			this.database.threads,
			this.database.revisionBatches,
			this.database.revisedSegments,
			async () => {
				if (!(await this.database.threads.get(threadId))) {
					throw new Error(`Thread not found: ${threadId}.`);
				}
				await this.database.revisedSegments.where('threadId').equals(threadId).delete();
				await this.database.revisionBatches.where('threadId').equals(threadId).delete();
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

	private async archiveSnapshot(
		threadId: string,
		exportedAt: string
	): Promise<SessionArchive | null> {
		return this.database.transaction(
			'r',
			[
				this.database.threads,
				this.database.runs,
				this.database.segments,
				this.database.autoSummaries,
				this.database.cleanTranscriptBlocks,
				this.database.revisionBatches,
				this.database.revisedSegments
			],
			async () => {
				const threadRecord = await this.database.threads.get(threadId);
				if (!threadRecord) return null;
				const runRecords = await this.database.runs.where('threadId').equals(threadId).toArray();
				const runIds = runRecords.map((run) => run.id);
				const [segments, legacySummary, cleanBlocks, revisionBatches, revisedSegments] =
					await Promise.all([
						runIds.length === 0
							? Promise.resolve([])
							: this.database.segments.where('runId').anyOf(runIds).toArray(),
						this.database.autoSummaries.get(threadId),
						this.database.cleanTranscriptBlocks.where('threadId').equals(threadId).toArray(),
						this.database.revisionBatches.where('threadId').equals(threadId).toArray(),
						this.database.revisedSegments.where('threadId').equals(threadId).toArray()
					]);
				return {
					schemaVersion: SESSION_ARCHIVE_VERSION,
					exportedAt,
					thread: fromThreadRecord(threadRecord),
					runs: runRecords.map(fromRunRecord).sort(compareRuns),
					segments: segments.sort(compareSegments),
					revisionProjection: {
						batches: revisionBatches.sort(
							(left, right) =>
								left.runSequence - right.runSequence || left.sequence - right.sequence
						),
						segments: revisedSegments.sort(
							(left, right) =>
								left.runSequence - right.runSequence || left.sourceStart - right.sourceStart
						)
					},
					cleanTranscriptProjection: {
						legacySummary: legacySummary ?? null,
						blocks: cleanBlocks.sort((left, right) => left.sequence - right.sequence)
					}
				};
			}
		);
	}

	async exportThread(threadId: string, exportedAt: string): Promise<string> {
		const archive = await this.archiveSnapshot(threadId, exportedAt);
		if (!archive) throw new Error(`Thread not found: ${threadId}.`);
		return stringifySessionArchive(archive);
	}

	async exportEvaluationBundle(
		threadId: string,
		options: EvaluationBundleOptions
	): Promise<string> {
		const [archive, operationalLogs] = await Promise.all([
			this.archiveSnapshot(threadId, options.exportedAt),
			this.loadOperationalLogs()
		]);
		if (!archive) throw new Error(`Thread not found: ${threadId}.`);
		return stringifyEvaluationBundle(archive, operationalLogs, options);
	}

	async importThread(value: string, checkpointedAt: string): Promise<ImportThreadResult> {
		const parsed = parseSessionArchive(value);
		const { archive } = parsed;
		await this.database.transaction(
			'rw',
			[
				this.database.threads,
				this.database.runs,
				this.database.segments,
				this.database.autoSummaries,
				this.database.cleanTranscriptBlocks,
				this.database.revisionBatches,
				this.database.revisedSegments
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
				const importedRevisionBatchCollisions = await this.database.revisionBatches.bulkGet(
					archive.revisionProjection.batches.map((batch) => batch.id)
				);
				if (
					importedRevisionBatchCollisions.some(
						(batch) => batch !== undefined && batch.threadId !== archive.thread.id
					)
				) {
					throw new Error('Imported revision batch ID belongs to another thread.');
				}
				const importedRevisedSegmentCollisions = await this.database.revisedSegments.bulkGet(
					archive.revisionProjection.segments.map((segment) => segment.id)
				);
				if (
					importedRevisedSegmentCollisions.some(
						(segment) => segment !== undefined && segment.threadId !== archive.thread.id
					)
				) {
					throw new Error('Imported revised segment ID belongs to another thread.');
				}
				const importedCleanBlockCollisions = await this.database.cleanTranscriptBlocks.bulkGet(
					archive.cleanTranscriptProjection.blocks.map((block) => block.id)
				);
				if (
					importedCleanBlockCollisions.some(
						(block) => block !== undefined && block.threadId !== archive.thread.id
					)
				) {
					throw new Error('Imported clean transcript block ID belongs to another thread.');
				}

				if (existingRunIds.length > 0) {
					await this.database.segments.where('runId').anyOf(existingRunIds).delete();
				}
				await this.database.autoSummaries.delete(archive.thread.id);
				await this.database.cleanTranscriptBlocks
					.where('threadId')
					.equals(archive.thread.id)
					.delete();
				await this.database.revisedSegments.where('threadId').equals(archive.thread.id).delete();
				await this.database.revisionBatches.where('threadId').equals(archive.thread.id).delete();
				await this.database.runs.where('threadId').equals(archive.thread.id).delete();
				await this.database.threads.put(toThreadRecord(archive.thread, checkpointedAt));
				await this.database.runs.bulkPut(
					archive.runs.map((run) => toRunRecord(run, checkpointedAt))
				);
				await this.database.segments.bulkPut(archive.segments);
				await this.database.revisionBatches.bulkPut(archive.revisionProjection.batches);
				await this.database.revisedSegments.bulkPut(archive.revisionProjection.segments);
				if (archive.cleanTranscriptProjection.legacySummary) {
					await this.database.autoSummaries.put(archive.cleanTranscriptProjection.legacySummary);
				}
				await this.database.cleanTranscriptBlocks.bulkPut(archive.cleanTranscriptProjection.blocks);
			}
		);
		return { threadId: archive.thread.id, warnings: parsed.warnings };
	}

	close(): void {
		this.database.close();
	}
}
