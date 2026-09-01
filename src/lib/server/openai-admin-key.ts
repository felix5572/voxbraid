let localEnvironmentLoaded = false;

function normalizedAdminKey(): string | null {
	const value = process.env.OPENAI_ADMIN_KEY?.trim();
	return value || null;
}

export function openAIAdminKey(): string | null {
	const configured = normalizedAdminKey();
	if (configured) return configured;
	if (localEnvironmentLoaded) return null;

	localEnvironmentLoaded = true;
	try {
		process.loadEnvFile('.env.admin.local');
	} catch (error) {
		const code =
			typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
		if (code !== 'ENOENT') {
			console.error('[openai-usage] unable to load local admin environment', error);
		}
	}
	return normalizedAdminKey();
}
