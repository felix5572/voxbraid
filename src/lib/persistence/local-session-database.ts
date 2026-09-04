import Dexie, { type Table } from 'dexie';
import type { CaptureRun, TranscriptSegment, TranslationThread } from '../session/types';
import type { StoredAutoSummary } from '../sidecar/auto-summary';
import type { StoredCleanTranscriptBlock } from '../sidecar/clean-transcript';
import type { StoredRevisedSegment, StoredRevisionBatch } from '../projection/revision-records';
import type { OperationalLogEntry } from '../operational-log';
import type { StoredConversationInvocation } from '../sidecar/conversation-records';

export const LOCAL_DB_EPOCH = 1;
export const LOCAL_DB_NAME = import.meta.env.DEV ? `voxbraid-dev-${LOCAL_DB_EPOCH}` : 'voxbraid';
export const LOCAL_CHECKPOINT_INTERVAL_MS = 10_000;

export interface LocalThreadRecord extends TranslationThread {
	checkpointedAt: string;
}

export interface LocalRunRecord extends CaptureRun {
	checkpointedAt: string;
}

export type LocalSegmentRecord = TranscriptSegment;

export class VoxBraidLocalDatabase extends Dexie {
	threads!: Table<LocalThreadRecord, string>;
	runs!: Table<LocalRunRecord, string>;
	segments!: Table<LocalSegmentRecord, string>;
	autoSummaries!: Table<StoredAutoSummary, string>;
	cleanTranscriptBlocks!: Table<StoredCleanTranscriptBlock, string>;
	revisionBatches!: Table<StoredRevisionBatch, string>;
	revisedSegments!: Table<StoredRevisedSegment, string>;
	operationalLogs!: Table<OperationalLogEntry, string>;
	conversationInvocations!: Table<StoredConversationInvocation, string>;

	constructor(name = LOCAL_DB_NAME) {
		super(name);
		this.version(1).stores({
			threads: '&id,status,updatedAt',
			runs: '&id,threadId,status,&[threadId+sequence],[threadId+status]',
			segments: '&id,runId,[runId+revision],&[runId+revision+sequence]'
		});
		this.version(2).stores({
			autoSummaries: '&threadId,updatedAt'
		});
		this.version(3).stores({
			cleanTranscriptBlocks: '&id,threadId,runId,status,updatedAt,&[threadId+sequence]'
		});
		this.version(4).stores({
			translationPairBatches: '&id,threadId,runId,&[runId+sequence]',
			translationPairSegments: '&id,batchId,&[batchId+batchRevision+sequence]'
		});
		this.version(5).stores({
			translationPairBatches: null,
			translationPairSegments: null,
			revisionBatches: '&id,threadId,runId,&[runId+sequence]',
			revisedSegments: '&id,threadId,runId,state,&[runId+sourceStart]'
		});
		this.version(6).stores({
			operationalLogs: '&id,lastOccurredAt,severity,source,threadId,state,dedupeKey'
		});
		this.version(7).stores({
			conversationInvocations: '&id,threadId,state,&[threadId+sequence]'
		});
	}
}

export function toThreadRecord(
	thread: TranslationThread,
	checkpointedAt: string
): LocalThreadRecord {
	return { ...thread, checkpointedAt };
}

export function fromThreadRecord(record: LocalThreadRecord): TranslationThread {
	const { checkpointedAt, ...thread } = record;
	void checkpointedAt;
	return thread;
}

export function toRunRecord(run: CaptureRun, checkpointedAt: string): LocalRunRecord {
	return { ...run, checkpointedAt };
}

export function fromRunRecord(record: LocalRunRecord): CaptureRun {
	const { checkpointedAt, ...run } = record;
	void checkpointedAt;
	return run;
}
