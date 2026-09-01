import { describe, expect, it, vi } from 'vitest';
import { CheckpointWriter } from './checkpoint-writer';

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

describe('CheckpointWriter', () => {
	it('moves a dirty snapshot through saving to clean', async () => {
		const save = vi.fn(async () => undefined);
		const writer = new CheckpointWriter(save);

		expect(writer.state).toBe('clean');
		writer.markDirty('first');
		expect(writer.state).toBe('dirty');

		await writer.flush();

		expect(save).toHaveBeenCalledWith('first');
		expect(writer.state).toBe('clean');
		expect(writer.lastError).toBeNull();
	});

	it('preserves changes made while an older snapshot is saving', async () => {
		const first = deferred();
		const second = deferred();
		const save = vi
			.fn<(value: string) => Promise<void>>()
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		const writer = new CheckpointWriter(save);

		writer.markDirty('first');
		const firstFlush = writer.flush();
		expect(writer.state).toBe('saving');

		writer.markDirty('second');
		expect(writer.state).toBe('saving-dirty');
		const secondFlush = writer.flush();

		first.resolve();
		await firstFlush;
		expect(writer.state).toBe('saving');
		expect(save).toHaveBeenNthCalledWith(2, 'second');

		second.resolve();
		await secondFlush;
		expect(writer.state).toBe('clean');
	});

	it('returns to dirty after failure and can retry the same snapshot', async () => {
		const failure = new Error('IndexedDB unavailable');
		const save = vi
			.fn<(value: string) => Promise<void>>()
			.mockRejectedValueOnce(failure)
			.mockResolvedValueOnce();
		const writer = new CheckpointWriter(save);

		writer.markDirty('retry me');
		await expect(writer.flush()).rejects.toBe(failure);
		expect(writer.state).toBe('dirty');
		expect(writer.lastError).toBe(failure);

		await writer.flush();
		expect(save).toHaveBeenCalledTimes(2);
		expect(writer.state).toBe('clean');
		expect(writer.lastError).toBeNull();
	});
});
