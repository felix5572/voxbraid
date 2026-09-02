import { describe, expect, it } from 'vitest';
import { ProjectionWorker } from './projection-worker';

describe('ProjectionWorker', () => {
	it('allows only the captured request to finish the lane', () => {
		const worker = new ProjectionWorker();
		worker.beginRequest('request-1', 'thread-1');

		expect(worker.requesting).toBe(true);
		expect(worker.ownsRequest('request-1', 'thread-1')).toBe(true);
		expect(worker.finishRequest('late-request')).toBe(false);
		expect(worker.requesting).toBe(true);
		expect(worker.finishRequest('request-1')).toBe(true);
		expect(worker.requesting).toBe(false);
	});

	it('rejects overlapping work and invalidates stale loads', () => {
		const worker = new ProjectionWorker();
		worker.beginRequest('request-1', 'thread-1');
		expect(() => worker.beginRequest('request-2', 'thread-2')).toThrow('already in flight');

		const firstLoad = worker.beginLoad();
		const secondLoad = worker.beginLoad();
		expect(worker.ownsLoad(firstLoad)).toBe(false);
		expect(worker.ownsLoad(secondLoad)).toBe(true);
		expect(worker.cancelRequest()).toBe('request-1');
	});
});
