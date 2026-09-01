import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.RUN_REALTIME_TEST !== '1') {
	console.log('[realtime-smoke] skipped; set RUN_REALTIME_TEST=1 to use the paid API');
	process.exit(0);
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const audioPath =
	process.env.REALTIME_TEST_AUDIO ?? join(root, 'local-recordings', 'hello-can-you-hear-me.webm');
const targetLanguage = process.env.REALTIME_TEST_LANGUAGE ?? 'zh';
const fixtureExpectations = {
	'hello-can-you-hear-me.webm': {
		source: ['hello', 'testing', 'hear'],
		translations: { zh: ['你好', '测试', '听'] }
	},
	'park-story.webm': {
		source: [
			'park',
			'lake',
			'noodles',
			'lunch',
			'vegetables',
			'train',
			'photos',
			'sat',
			'dog',
			'noon',
			'afternoon',
			'children'
		],
		translations: {
			zh: [
				'公园',
				'湖',
				'面条',
				'午饭',
				'蔬菜',
				'火车',
				'照片',
				'坐',
				'遛狗',
				'中午',
				'下午',
				'孩子'
			]
		}
	}
};

function keywordList(value) {
	return value
		?.split(',')
		.map((keyword) => keyword.trim())
		.filter(Boolean);
}

function assertKeywordCoverage(label, text, keywords) {
	if (keywords.length === 0) return null;
	const normalized = text.toLocaleLowerCase();
	const matched = keywords.filter((keyword) => normalized.includes(keyword.toLocaleLowerCase()));
	const required = Math.ceil((keywords.length * 2) / 3);
	if (matched.length < required) {
		throw new Error(
			`${label}只命中 ${matched.length}/${keywords.length} 个关键词，至少需要 ${required} 个。`
		);
	}
	return { matched: matched.length, total: keywords.length, required };
}

async function firstAccessible(paths) {
	for (const path of paths.filter(Boolean)) {
		try {
			await access(path);
			return path;
		} catch {
			// Try the next known system-browser location.
		}
	}
	return null;
}

const chromePath = await firstAccessible([
	process.env.CHROME_PATH,
	'/usr/bin/google-chrome',
	'/usr/bin/chromium',
	'/usr/bin/chromium-browser'
]);

await access(audioPath);
const [{ chromium }, { createServer }] = await Promise.all([
	import('playwright-core'),
	import('vite')
]);
const server = await createServer({
	root,
	logLevel: 'error',
	server: { host: '127.0.0.1', port: 0 }
});

let browser;
try {
	await server.listen();
	const address = server.httpServer?.address();
	if (!address || typeof address === 'string') throw new Error('无法读取测试服务器端口。');

	try {
		browser = await chromium.launch({
			...(chromePath ? { executablePath: chromePath } : {}),
			headless: true,
			args: ['--autoplay-policy=no-user-gesture-required']
		});
	} catch (error) {
		throw new Error(
			'无法启动 Chromium。请按 README 安装 chromium-headless-shell，或设置 CHROME_PATH。',
			{ cause: error }
		);
	}
	const page = await browser.newPage();
	await page.route('**/api/openai/usage-summary', async (route) => {
		await route.fulfill({
			contentType: 'application/json',
			body: JSON.stringify({
				periodStart: '2026-09-01T00:00:00.000Z',
				periodEnd: '2026-09-01T12:00:00.000Z',
				durationSeconds: 0,
				costUsd: 0,
				updatedAt: '2026-09-01T12:00:00.000Z'
			})
		});
	});
	const browserErrors = [];
	page.on('console', (message) => {
		if (message.type() !== 'error') return;
		browserErrors.push(message.text());
		console.error('[browser]', message.text());
	});
	await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'networkidle' });

	const audioBase64 = (await readFile(audioPath)).toString('base64');
	const result = await page.evaluate(
		async ({ audioBase64, fileName, targetLanguage }) => {
			const [{ RealtimeTranslationClient }, { AudioFileStreamSource }] = await Promise.all([
				import('/src/lib/realtime/client.ts'),
				import('/src/lib/testing/audio-file-source.ts')
			]);
			const bytes = Uint8Array.from(atob(audioBase64), (value) => value.charCodeAt(0));
			const file = new File([bytes], fileName, { type: 'audio/webm' });
			const audioSource = new AudioFileStreamSource();
			const statuses = [];
			const errors = [];
			let source = '';
			let translation = '';
			let audioDurationMs = 0;
			let settle;
			let fail;
			const finished = new Promise((resolve, reject) => {
				settle = resolve;
				fail = reject;
			});
			let client;
			client = new RealtimeTranslationClient(
				{
					onStatus: (status) => {
						statuses.push(status);
						if (status === 'connected') audioSource.play();
					},
					onEvent: (event) => {
						if (event.type === 'session.input_transcript.delta') source += event.delta ?? '';
						if (event.type === 'session.output_transcript.delta') {
							translation += event.delta ?? '';
						}
					},
					onError: (message) => errors.push(message),
					onConnectionFailure: (message) => fail(new Error(message))
				},
				{
					getUserMedia: async () => {
						const playback = await audioSource.open(file, {
							onEnded: () => {
								void client.stop().then(settle, fail);
							}
						});
						audioDurationMs = playback.durationMs;
						return playback.stream;
					}
				}
			);

			await client.start(targetLanguage);
			await Promise.race([
				finished,
				new Promise((_, reject) =>
					setTimeout(
						() => reject(new Error('真实链路测试等待结果超时。')),
						Math.max(45_000, audioDurationMs + 30_000)
					)
				)
			]);
			return { statuses, source, translation, errors };
		},
		{ audioBase64, fileName: basename(audioPath), targetLanguage }
	);

	if (!result.statuses.includes('connected')) throw new Error('WebRTC 没有进入 connected。');
	if (!result.source.trim()) throw new Error('没有收到源语言字幕。');
	if (!result.translation.trim()) throw new Error('没有收到目标语言字幕。');
	assert.deepEqual(browserErrors, []);

	const fixtureExpectation = fixtureExpectations[basename(audioPath)];
	const sourceKeywords =
		keywordList(process.env.REALTIME_TEST_SOURCE_KEYWORDS) ?? fixtureExpectation?.source ?? [];
	const translationKeywords =
		keywordList(process.env.REALTIME_TEST_TRANSLATION_KEYWORDS) ??
		fixtureExpectation?.translations[targetLanguage] ??
		[];
	const sourceCoverage = assertKeywordCoverage('源语言字幕', result.source, sourceKeywords);
	const translationCoverage = assertKeywordCoverage(
		'目标语言字幕',
		result.translation,
		translationKeywords
	);

	console.log('[realtime-smoke] passed');
	if (sourceCoverage || translationCoverage) {
		console.log(
			`keyword coverage: source ${sourceCoverage?.matched ?? 0}/${sourceCoverage?.total ?? 0}, translation ${translationCoverage?.matched ?? 0}/${translationCoverage?.total ?? 0}`
		);
	}
	if (process.env.REALTIME_TEST_VERBOSE === '1') {
		console.log(`source: ${result.source.trim()}`);
		console.log(`translation: ${result.translation.trim()}`);
	}
	if (result.errors.length > 0) console.log(`protocol errors: ${result.errors.join(' | ')}`);
} finally {
	await browser?.close();
	await server.close();
}
