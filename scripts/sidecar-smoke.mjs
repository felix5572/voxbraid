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
	const { sourceClauseAtoms } = await server.ssrLoadModule(
		'/src/lib/projection/revision-projection.ts'
	);
	const revisionSource =
		'The first topic, with one example. The sample contains 3,000 observations, so the numeric comma remains inside one clause. ' +
		`${'continuous speech without punctuation '.repeat(9)}. ` +
		'Now we turn to a new topic.';
	const revisionAtoms = sourceClauseAtoms(revisionSource, 0, revisionSource.length, 'en').map(
		(atom) => ({
			i: atom.index,
			start: atom.start,
			end: atom.end,
			t: atom.text,
			boundary: atom.boundary
		})
	);
	const revisionSourceContinued = `${revisionSource} This final clause arrives later, and it confirms that the same WebSocket chain can replace or append the live tail.`;
	const revisionAtomsContinued = sourceClauseAtoms(
		revisionSourceContinued,
		0,
		revisionSourceContinued.length,
		'en'
	).map((atom) => ({
		i: atom.index,
		start: atom.start,
		end: atom.end,
		t: atom.text,
		boundary: atom.boundary
	}));
	assert.equal(revisionAtoms.map((atom) => atom.t).join(''), revisionSource);
	assert.ok(revisionAtoms.some((atom) => atom.boundary === 'forced'));
	assert.ok(revisionAtoms.some((atom) => atom.t.includes('3,000')));
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
				atoms: revisionAtoms,
				continuity: [],
				previousDraft: [],
				oversizedGroupNumbers: [],
				previousInvalidAtomRanges: []
			}
		},
		{
			kind: 'revise-pairs-continued',
			expectedModel: 'gpt-5.6-luna',
			intent: {
				kind: 'revise-pairs',
				trigger: 'manual',
				targetLanguage: 'zh',
				atoms: revisionAtomsContinued,
				continuity: [],
				previousDraft: [],
				oversizedGroupNumbers: [],
				previousInvalidAtomRanges: []
			}
		}
	];

	for (const testCase of cases) {
		const revisionCase = testCase.intent.kind === 'revise-pairs';
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
							sourceText: revisionCase
								? testCase.intent.atoms.map((atom) => atom.t).join('')
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
		if (revisionCase) {
			const output = JSON.parse(body.outputText);
			assert.ok(output.groups.length >= 2, 'revise-pairs 应识别明确的话题切换。');
			assert.ok(
				output.groups.every(
					(group, index, groups) =>
						index === 0 || group.firstAtom === groups[index - 1].lastAtom + 1
				),
				'revise-pairs 的原子范围必须连续且不得在段落后重置。'
			);
			assert.equal(output.groups[0]?.firstAtom, 1);
			assert.equal(output.groups.at(-1)?.lastAtom, testCase.intent.atoms.length);
			assert.ok(output.groups.every((group) => group.revisedSourceText?.trim()));
			assert.equal(body.transportDiagnostic?.transport, 'websocket');
			assert.equal(
				body.transportDiagnostic?.chainAction,
				testCase.kind === 'revise-pairs' ? 'bootstrap' : 'continued'
			);
		}
		assert.ok(
			(body.usageStatus === 'recorded' && body.usage?.totalTokens >= 0) ||
				(body.usageStatus === 'unavailable' && body.usage === null),
			`${testCase.kind} usage 状态与内容不一致。`
		);
		if (process.env.SIDECAR_TEST_VERBOSE === '1') console.log(body.outputText.trim());
		console.log(
			`[sidecar-smoke] passed ${testCase.kind}: ${body.model}, ${body.usage?.totalTokens ?? 'usage unavailable'} total tokens, ${body.usage?.cachedInputTokens ?? 'cached unavailable'} cached input, ${body.transportDiagnostic?.transport ?? 'transport unavailable'}/${body.transportDiagnostic?.chainAction ?? 'n/a'}, ${body.transportDiagnostic?.completedMs ?? 'latency unavailable'} ms`
		);
	}
} finally {
	await server.close();
}
