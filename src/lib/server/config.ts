import { env } from '$env/dynamic/private';

function requireEnvironmentVariable(name: string, value: string | undefined): string {
	const normalized = value?.trim();
	if (!normalized) throw new Error(`缺少必需的服务端环境变量：${name}`);
	return normalized;
}

export const serverConfig = Object.freeze({
	openaiApiKey: requireEnvironmentVariable('OPENAI_API_KEY', env.OPENAI_API_KEY)
});
