import { describe, expect, it, vi } from 'vitest';
import { requestStoragePersistence } from './storage-durability';

describe('requestStoragePersistence', () => {
	it('keeps an already persistent origin without requesting again', async () => {
		const persist = vi.fn(async () => true);

		await expect(requestStoragePersistence({ persisted: async () => true, persist })).resolves.toBe(
			'persistent'
		);
		expect(persist).not.toHaveBeenCalled();
	});

	it('reports whether a new persistence request was accepted', async () => {
		await expect(
			requestStoragePersistence({ persisted: async () => false, persist: async () => true })
		).resolves.toBe('persistent');
		await expect(
			requestStoragePersistence({ persisted: async () => false, persist: async () => false })
		).resolves.toBe('best-effort');
	});

	it('reports unsupported browsers without failing local storage', async () => {
		await expect(requestStoragePersistence({})).resolves.toBe('unsupported');
	});
});
