export type StorageDurability = 'persistent' | 'best-effort' | 'unsupported';

export interface StoragePersistenceApi {
	persisted?: () => Promise<boolean>;
	persist?: () => Promise<boolean>;
}

export async function requestStoragePersistence(
	storage: StoragePersistenceApi | undefined = globalThis.navigator?.storage
): Promise<StorageDurability> {
	if (!storage?.persisted || !storage.persist) return 'unsupported';
	if (await storage.persisted()) return 'persistent';
	return (await storage.persist()) ? 'persistent' : 'best-effort';
}
