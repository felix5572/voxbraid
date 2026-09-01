import { env } from '$env/dynamic/private';
import { readBasicAuthCredentials } from './basic-auth';

function requireEnvironmentVariable(name: string, value: string | undefined): string {
	const normalized = value?.trim();
	if (!normalized) throw new Error(`缺少必需的服务端环境变量：${name}`);
	return normalized;
}

export const serverConfig = Object.freeze({
	openaiApiKey: requireEnvironmentVariable('OPENAI_API_KEY', env.OPENAI_API_KEY),
	basicAuth: readBasicAuthCredentials(
		env.VOXBRAID_BASIC_AUTH_USERNAME,
		env.VOXBRAID_BASIC_AUTH_PASSWORD
	)
});
