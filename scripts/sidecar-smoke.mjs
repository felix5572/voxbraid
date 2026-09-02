import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.RUN_SIDECAR_TEST !== '1') {
	console.log('[sidecar-smoke] skipped; set RUN_SIDECAR_TEST=1 to use the paid API');
	process.exit(0);
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
try {
	process.loadEnvFile(join(root, '.env'));
} catch (error) {
	if (error?.code !== 'ENOENT') throw error;
}
if (!process.env.OPENAI_API_KEY?.trim()) {
	throw new Error('缺少 OPENAI_API_KEY，无法运行真实旁路测试。');
}

const basicAuthUsername = process.env.VOXBRAID_BASIC_AUTH_USERNAME;
const basicAuthPassword = process.env.VOXBRAID_BASIC_AUTH_PASSWORD;
if ((basicAuthUsername && !basicAuthPassword) || (!basicAuthUsername && basicAuthPassword)) {
	throw new Error('Basic Auth 测试配置不完整，请同时设置用户名和密码。');
}
const authorization =
	basicAuthUsername && basicAuthPassword
		? `Basic ${Buffer.from(`${basicAuthUsername}:${basicAuthPassword}`).toString('base64')}`
		: null;

const { createServer } = await import('vite');
const server = await createServer({
	root,
	logLevel: 'error',
	server: { host: '127.0.0.1', port: 0 }
});

try {
	await server.listen();
	const address = server.httpServer?.address();
	if (!address || typeof address === 'string') throw new Error('无法读取测试服务器端口。');
	const endpoint = `http://127.0.0.1:${address.port}/api/sidecar/invoke`;
	const cases = [
		{
			kind: 'ask',
			expectedModel: 'gpt-5.6-sol',
			intent: {
				kind: 'ask',
				trigger: 'manual',
				question: 'Where did the speaker walk?',
				outputLanguage: 'English'
			}
		},
		{
			kind: 'summarize',
			expectedModel: 'gpt-5.6-terra',
			intent: { kind: 'summarize', trigger: 'manual', outputLanguage: '中文 (zh)' }
		},
		{
			kind: 'retranslate',
			expectedModel: 'gpt-5.6-luna',
			intent: { kind: 'retranslate', trigger: 'manual', targetLanguage: '中文 (zh)' }
		},
		{
			kind: 'revise-pairs',
			expectedModel: 'gpt-5.6-luna',
			intent: {
				kind: 'revise-pairs',
				trigger: 'manual',
				targetLanguage: 'zh',
				tokens: [
					{ i: 1, start: 0, end: 3, t: 'The' },
					{ i: 2, start: 3, end: 9, t: ' first' },
					{ i: 3, start: 9, end: 16, t: ' topic.' },
					{ i: 4, start: 16, end: 20, t: ' Now' },
					{ i: 5, start: 20, end: 23, t: ' we' },
					{ i: 6, start: 23, end: 28, t: ' turn' },
					{ i: 7, start: 28, end: 31, t: ' to' },
					{ i: 8, start: 31, end: 33, t: ' a' },
					{ i: 9, start: 33, end: 37, t: ' new' },
					{ i: 10, start: 37, end: 44, t: ' topic.' }
				],
				continuity: [],
				previousDraft: [],
				oversizedGroupNumbers: [],
				previousInvalidLastTokenIndexes: []
			}
		}
	];

	for (const testCase of cases) {
		const response = await fetch(endpoint, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				...(authorization ? { Authorization: authorization } : {})
			},
			body: JSON.stringify({
				clientRequestId: crypto.randomUUID(),
				intent: testCase.intent,
				context: {
					threadId: 'paid-smoke-thread',
					scope: 'latest-run',
					capturedAt: new Date().toISOString(),
					runs: [
						{
							runId: 'paid-smoke-run',
							sequence: 1,
							targetLanguage: 'zh',
							sourceText:
								testCase.kind === 'revise-pairs'
									? testCase.intent.tokens.map((token) => token.t).join('')
									: 'The speaker visited a public park, walked beside a lake, and took the train home after lunch.',
							translationText: '讲者去了公园，在湖边散步，午饭后乘火车回家。'
						}
					]
				}
			})
		});
		const body = await response.json().catch(() => null);
		if (!response.ok) {
			throw new Error(
				`${testCase.kind} 真实旁路测试失败（HTTP ${response.status}）：${JSON.stringify(body)}`
			);
		}
		assert.equal(body?.status, 'completed');
		assert.equal(typeof body.responseId, 'string');
		assert.equal(body.model, testCase.expectedModel);
		assert.ok(body.outputText?.trim(), `${testCase.kind} 没有返回文本。`);
		if (testCase.kind === 'revise-pairs') {
			const output = JSON.parse(body.outputText);
			assert.ok(output.groups.length >= 2, 'revise-pairs 应识别明确的话题切换。');
			assert.ok(
				output.groups.every(
					(group, index, groups) =>
						index === 0 || group.lastTokenIndex > groups[index - 1].lastTokenIndex
				),
				'revise-pairs 的 lastTokenIndex 不得在段落后重置。'
			);
			assert.equal(output.groups.at(-1)?.lastTokenIndex, testCase.intent.tokens.length);
			assert.equal(
				output.groups.at(-1)?.lastTokenText.trim(),
				testCase.intent.tokens.at(-1).t.trim()
			);
			assert.ok(output.groups.every((group) => group.revisedSourceText?.trim()));
		}
		assert.ok(
			(body.usageStatus === 'recorded' && body.usage?.totalTokens >= 0) ||
				(body.usageStatus === 'unavailable' && body.usage === null),
			`${testCase.kind} usage 状态与内容不一致。`
		);
		if (process.env.SIDECAR_TEST_VERBOSE === '1') console.log(body.outputText.trim());
		console.log(
			`[sidecar-smoke] passed ${testCase.kind}: ${body.model}, ${body.usage?.totalTokens ?? 'usage unavailable'} total tokens`
		);
	}
} finally {
	await server.close();
}
