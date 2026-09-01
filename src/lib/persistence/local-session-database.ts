import Dexie, { type Table } from 'dexie';
import type { CaptureRun, TranscriptSegment, TranslationThread } from '../session/types';

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

	constructor(name = LOCAL_DB_NAME) {
		super(name);
		this.version(1).stores({
			threads: '&id,status,updatedAt',
			runs: '&id,threadId,status,&[threadId+sequence],[threadId+status]',
			segments: '&id,runId,[runId+revision],&[runId+revision+sequence]'
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
