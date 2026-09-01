import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

try {
	process.loadEnvFile('.env');
} catch (error) {
	if (error?.code !== 'ENOENT') throw error;
}

const basicAuthUsername = process.env.VOXBRAID_BASIC_AUTH_USERNAME;
const basicAuthPassword = process.env.VOXBRAID_BASIC_AUTH_PASSWORD;
const httpCredentials =
	basicAuthUsername && basicAuthPassword
		? { username: basicAuthUsername, password: basicAuthPassword }
		: undefined;

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

async function readStore(page, storeName) {
	return page.evaluate(async (name) => {
		const { LOCAL_DB_NAME } = await import('/src/lib/persistence/local-session-database.ts');
		const openRequest = indexedDB.open(LOCAL_DB_NAME);
		const database = await new Promise((resolve, reject) => {
			openRequest.onsuccess = () => resolve(openRequest.result);
			openRequest.onerror = () => reject(openRequest.error);
		});
		const request = database.transaction(name).objectStore(name).getAll();
		const records = await new Promise((resolve, reject) => {
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		database.close();
		return records;
	}, storeName);
}

async function waitForRecord(page, storeName, predicate, description, timeoutMs = 4_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const record = (await readStore(page, storeName)).find(predicate);
		if (record) return record;
		await page.waitForTimeout(50);
	}
	throw new Error(`等待 ${description} 超时。`);
}

async function waitForSidecarRequest(page, requests, predicate, description, timeoutMs = 4_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const request = requests.find(predicate);
		if (request) return request;
		await page.waitForTimeout(50);
	}
	throw new Error(`等待 ${description} 超时。`);
}

async function waitForReady(page) {
	const start = page.getByRole('button', { name: '开始翻译' });
	await start.waitFor({ state: 'visible' });
	await page.waitForFunction(() => {
		const button = [...document.querySelectorAll('button')].find((item) =>
			item.textContent?.includes('开始翻译')
		);
		return button instanceof HTMLButtonElement && !button.disabled;
	});
	assert.equal(await start.isEnabled(), true);
	await page.waitForFunction(() => window.__voxbraidBrowserTest !== undefined);
	await page.getByText('本地持久存储已启用', { exact: true }).waitFor();
	assert.deepEqual(await page.evaluate(() => window.__voxbraidStorageTest), {
		persistedChecks: 1,
		persistRequests: 1
	});
	await page
		.locator('[data-official-window-days="30"] [data-official-cost-usd="0.10285"]')
		.waitFor();
}

async function createPage(browser, baseUrl, query = '?browser-test=1') {
	const context = await browser.newContext({
		...(httpCredentials ? { httpCredentials } : {}),
		permissions: ['clipboard-read', 'clipboard-write']
	});
	const sidecarRequests = [];
	await context.addInitScript(() => {
		const stats = { releases: 0, requests: 0 };
		const storageStats = { persistedChecks: 0, persistRequests: 0 };
		Object.defineProperty(window, '__voxbraidWakeLockTest', { value: stats });
		Object.defineProperty(window, '__voxbraidStorageTest', { value: storageStats });
		Object.defineProperty(navigator, 'storage', {
			configurable: true,
			value: {
				persisted: async () => {
					storageStats.persistedChecks += 1;
					return false;
				},
				persist: async () => {
					storageStats.persistRequests += 1;
					return true;
				}
			}
		});
		Object.defineProperty(navigator, 'wakeLock', {
			configurable: true,
			value: {
				request: async () => {
					stats.requests += 1;
					let released = false;
					const sentinel = new EventTarget();
					Object.defineProperty(sentinel, 'released', { get: () => released });
					sentinel.release = async () => {
						if (released) return;
						released = true;
						stats.releases += 1;
						sentinel.dispatchEvent(new Event('release'));
					};
					return sentinel;
				}
			}
		});
	});
	const page = await context.newPage();
	await page.route('**/api/openai/usage-summary', async (route) => {
		await route.fulfill({
			contentType: 'application/json',
			body: JSON.stringify({
				periodStart: '2026-09-01T00:00:00.000Z',
				periodEnd: '2026-09-01T12:00:00.000Z',
				windows: [
					{ days: 1, durationSeconds: 93, costUsd: 0.07905 },
					{ days: 7, durationSeconds: 121, costUsd: 0.10285 },
					{ days: 30, durationSeconds: 121, costUsd: 0.10285 }
				],
				updatedAt: '2026-09-01T12:00:00.000Z'
			})
		});
	});
	await page.route('**/api/sidecar/invoke', async (route) => {
		const body = route.request().postDataJSON();
		sidecarRequests.push(body);
		await new Promise((resolve) => setTimeout(resolve, 25));
		if (
			body.intent.kind === 'summarize' &&
			body.context.runs[0]?.sourceText.includes('[FAIL_CLEAN_BLOCK]')
		) {
			await route.fulfill({
				contentType: 'application/json',
				body: JSON.stringify({
					status: 'failed',
					clientRequestId: body.clientRequestId,
					responseId: null,
					model: 'gpt-5.6-terra',
					outputText: null,
					upstreamStatus: 'failed',
					usageStatus: 'unavailable',
					usage: null,
					error: { code: 'upstream-failed', message: 'Injected block failure.' },
					failedAt: '2026-09-01T12:00:00.000Z'
				})
			});
			return;
		}
		const cleanBlockNumber = sidecarRequests.filter(
			(request) => request.intent.kind === 'summarize'
		).length;
		const outputs = {
			summarize: `课堂清稿第${cleanBlockNumber}块`,
			retranslate: '自动重译结果',
			ask: '自动问答结果'
		};
		await route.fulfill({
			contentType: 'application/json',
			body: JSON.stringify({
				status: 'completed',
				clientRequestId: body.clientRequestId,
				responseId: `response-${sidecarRequests.length}`,
				model:
					body.intent.kind === 'ask'
						? 'gpt-5.6-sol'
						: body.intent.kind === 'summarize'
							? 'gpt-5.6-terra'
							: 'gpt-5.6-luna',
				outputText: outputs[body.intent.kind],
				usageStatus: 'recorded',
				usage: {
					inputTokens: 120,
					cachedInputTokens: 0,
					outputTokens: 20,
					reasoningTokens: 2,
					totalTokens: 140
				},
				completedAt: '2026-09-01T12:00:00.000Z'
			})
		});
	});
	const browserErrors = [];
	page.on('console', (message) => {
		if (message.type() === 'error') browserErrors.push(message.text());
	});
	await page.goto(`${baseUrl}/${query}`, { waitUntil: 'networkidle' });
	return { browserErrors, context, page, sidecarRequests };
}

async function testCleanTranscriptContinuesAfterFailure(browser, baseUrl) {
	const { browserErrors, context, page, sidecarRequests } = await createPage(browser, baseUrl);
	try {
		await waitForReady(page);
		await startCapture(page);
		const source = `[FAIL_CLEAN_BLOCK] ${'a'.repeat(8_000)} ${'b'.repeat(8_000)}.`;
		await emitPair(page, source, '课堂译文。'.repeat(500));
		const failed = await waitForRecord(
			page,
			'cleanTranscriptBlocks',
			(record) => record.status === 'failed',
			'清稿失败块占位'
		);
		const completed = await waitForRecord(
			page,
			'cleanTranscriptBlocks',
			(record) => record.status === 'completed' && record.sequence > failed.sequence,
			'失败后的后续清稿块继续'
		);
		assert.equal(failed.sequence, 1);
		assert.equal(completed.sequence, 2);
		assert.ok(sidecarRequests.filter((request) => request.intent.kind === 'summarize').length >= 2);
		await stopCapture(page);
		assert.deepEqual(browserErrors, []);
	} finally {
		await context.close();
	}
}

async function emitPair(page, source, translation) {
	await page.evaluate(
		({ sourceText, translationText }) => {
			const bridge = window.__voxbraidBrowserTest;
			if (!bridge) throw new Error('Browser-test bridge is unavailable.');
			bridge.emitSource(sourceText);
			bridge.emitTranslation(translationText);
		},
		{ sourceText: source, translationText: translation }
	);
}

async function startCapture(page) {
	await page.getByRole('button', { name: '开始翻译' }).click();
	await page.getByText('实时翻译中', { exact: true }).waitFor();
}

async function waitForRunningUsageEstimate(page) {
	await page.waitForFunction(() => {
		const duration = document.querySelector('[data-duration-seconds]');
		const cost = document.querySelector('[data-estimated-cost-usd]');
		return (
			Number(duration?.getAttribute('data-duration-seconds')) >= 1 &&
			Number(cost?.getAttribute('data-estimated-cost-usd')) > 0
		);
	});
}

async function stopCapture(page) {
	await page.getByRole('button', { name: '停止翻译' }).click();
	await page.getByRole('button', { name: '开始翻译' }).waitFor();
}

function mainText(page, text) {
	return page.getByRole('main').getByText(text, { exact: true });
}

async function testPauseResumeAndNewThread(browser, baseUrl) {
	const { browserErrors, context, page, sidecarRequests } = await createPage(browser, baseUrl);
	try {
		await waitForReady(page);
		await page.getByText('字号 22', { exact: true }).click();
		const captionFontSize = page.getByLabel('字幕字号', { exact: true });
		await captionFontSize.fill('18');
		assert.equal(
			await page
				.locator('.captions article p')
				.first()
				.evaluate((element) => {
					return getComputedStyle(element).fontSize;
				}),
			'18px'
		);
		await page.reload({ waitUntil: 'networkidle' });
		await waitForReady(page);
		assert.equal(await page.getByLabel('字幕字号', { exact: true }).inputValue(), '18');
		const targetLanguageSelect = page.getByLabel('目标语言', { exact: true });
		const transcriptionModelSelect = page.getByLabel('原文模型', { exact: true });
		const noiseReductionSelect = page.getByLabel('输入降噪', { exact: true });
		await targetLanguageSelect.selectOption('ja');
		await transcriptionModelSelect.selectOption('gpt-live-transcribe');
		await noiseReductionSelect.selectOption('off');
		assert.equal(await transcriptionModelSelect.inputValue(), 'gpt-live-transcribe');
		assert.equal(await noiseReductionSelect.inputValue(), 'off');

		const firstSourceChunks = [
			'First automated capture run.',
			' The second source sentence must remain visible.',
			' The third source sentence must also reach IndexedDB.'
		];
		const firstSource = firstSourceChunks.join('');
		const firstTitle = firstSourceChunks[0];
		const firstTranslation = '最初の自動収録です。二つ目と三つ目の原文も保存します。';
		await startCapture(page);
		assert.equal(await transcriptionModelSelect.isDisabled(), true);
		assert.equal(await noiseReductionSelect.isDisabled(), true);
		await page.locator('[data-thread-id]').waitFor();
		assert.equal(await page.locator('[data-thread-id]').isDisabled(), true);
		for (const sourceChunk of firstSourceChunks) {
			await emitPair(page, sourceChunk, firstTranslation.slice(0, 1));
		}
		await stopCapture(page);
		const firstRun = await waitForRecord(
			page,
			'runs',
			(record) => record.sourceStream.text.includes(firstSource) && record.status === 'completed',
			'第一次暂停后的 Run 保存'
		);
		assert.equal(firstRun.endReason, 'user-paused');
		await page.getByRole('button', { name: new RegExp(firstTitle) }).waitFor();

		await page.reload({ waitUntil: 'networkidle' });
		await waitForReady(page);
		await page.getByRole('button', { name: new RegExp(firstTitle) }).waitFor();
		await mainText(page, firstSource).waitFor();
		await page.getByText(firstTranslation.slice(0, 1).repeat(3), { exact: true }).waitFor();
		assert.equal(await page.getByLabel('目标语言', { exact: true }).inputValue(), 'ja');

		const secondSource = 'Second capture run in the same thread.';
		const secondTranslation = '同じ会話の二つ目の収録です。';
		await startCapture(page);
		await emitPair(page, secondSource, secondTranslation);
		await stopCapture(page);
		await waitForRecord(
			page,
			'runs',
			(record) => record.sourceStream.text.includes(secondSource) && record.sequence === 2,
			'继续收音后的第二个 Run 保存'
		);
		await page.reload({ waitUntil: 'networkidle' });
		await waitForReady(page);
		await mainText(page, firstSource).waitFor();
		await mainText(page, secondSource).waitFor();

		const summarize = page.getByRole('button', { name: '整理未处理内容', exact: true });
		await summarize.click();
		assert.equal(await summarize.isDisabled(), true);
		await page.getByText('课堂清稿第2块', { exact: true }).waitFor();
		assert.equal(sidecarRequests.length, 2);
		assert.equal(sidecarRequests[0].intent.kind, 'summarize');
		assert.equal(sidecarRequests[0].context.scope, 'latest-run');
		assert.equal(sidecarRequests[0].context.runs.length, 1);
		assert.equal(sidecarRequests[0].context.runs[0].sourceText, firstSource);
		assert.equal(sidecarRequests[1].context.runs[0].sourceText, secondSource);
		assert.equal(sidecarRequests[1].context.continuityText, '课堂清稿第1块');
		await waitForRecord(
			page,
			'cleanTranscriptBlocks',
			(record) => record.threadId === firstRun.threadId && record.text === '课堂清稿第2块',
			'分块课堂清稿保存'
		);
		await page.getByRole('button', { name: '复制', exact: true }).first().click();
		await page.getByText('已复制', { exact: true }).waitFor();
		await page.reload({ waitUntil: 'networkidle' });
		await waitForReady(page);
		await page.getByText('课堂清稿第1块', { exact: true }).waitFor();
		await page.getByText('课堂清稿第2块', { exact: true }).waitFor();

		await page.getByLabel('字幕问题', { exact: true }).fill('What was captured?');
		await page.getByRole('button', { name: '提问', exact: true }).click();
		await page.getByText('自动问答结果', { exact: true }).waitFor();
		const askRequest = sidecarRequests.find((request) => request.intent.kind === 'ask');
		assert.ok(askRequest);
		assert.equal(askRequest.intent.question, 'What was captured?');

		await startCapture(page);
		await emitPair(page, 'x'.repeat(3_000), '自動要約'.repeat(300));
		await stopCapture(page);
		const automaticSummary = await waitForSidecarRequest(
			page,
			sidecarRequests,
			(request) => request.intent.kind === 'summarize' && request.intent.trigger === 'periodic',
			'达到字符阈值后的自动总结'
		);
		assert.equal(automaticSummary.context.scope, 'latest-run');
		assert.equal(automaticSummary.context.runs.length, 1);
		await waitForRecord(
			page,
			'cleanTranscriptBlocks',
			(record) => record.threadId === firstRun.threadId && record.sequence === 3,
			'暂停后的尾块清稿追加'
		);

		const threadsBeforeNew = await readStore(page, 'threads');
		assert.equal(threadsBeforeNew.length, 1);
		await page.getByRole('button', { name: '新建会话' }).click();
		await page.getByText('开始后，原文字幕会显示在这里。', { exact: true }).waitFor();
		assert.equal(await mainText(page, firstSource).count(), 0);
		assert.equal((await readStore(page, 'threads')).length, 1);

		const newThreadSource = 'A fresh product thread.';
		await startCapture(page);
		await emitPair(page, newThreadSource, '新しい会話です。');
		await stopCapture(page);
		await waitForRecord(
			page,
			'runs',
			(record) => record.sourceStream.text.includes(newThreadSource),
			'新会话 Run 保存'
		);
		const threadsAfterNew = await readStore(page, 'threads');
		assert.equal(threadsAfterNew.length, 2);
		assert.ok(threadsAfterNew.some((thread) => thread.id === firstRun.threadId));
		const newThread = threadsAfterNew.find((thread) => thread.id !== firstRun.threadId);
		assert.ok(newThread);

		const firstThreadButton = page.locator(`[data-thread-id="${firstRun.threadId}"]`);
		await firstThreadButton.click();
		await mainText(page, firstSource).waitFor();
		await mainText(page, secondSource).waitFor();
		assert.equal(await firstThreadButton.getAttribute('aria-current'), 'page');
		assert.equal(await mainText(page, newThreadSource).count(), 0);

		const newThreadButton = page.locator(`[data-thread-id="${newThread.id}"]`);
		await newThreadButton.click();
		await mainText(page, newThreadSource).waitFor();
		assert.equal(await newThreadButton.getAttribute('aria-current'), 'page');
		assert.equal(await mainText(page, firstSource).count(), 0);

		await firstThreadButton.click();
		const downloadPromise = page.waitForEvent('download');
		await page.getByRole('button', { name: '导出当前会话 JSON' }).click();
		const download = await downloadPromise;
		const archivePath = await download.path();
		assert.ok(archivePath);
		await newThreadButton.click();
		const importButton = page.getByRole('button', { name: '导入会话 JSON' });
		await page.waitForFunction(() => {
			const button = [...document.querySelectorAll('button')].find((item) =>
				item.textContent?.includes('导入会话 JSON')
			);
			return button instanceof HTMLButtonElement && !button.disabled;
		});
		assert.equal(await importButton.isEnabled(), true);
		const importInput = page.locator('input[type="file"][accept*="json"]');
		await importInput.setInputFiles(archivePath);
		await page.getByText('会话已恢复。重复导入同一文件不会创建副本。', { exact: true }).waitFor();
		await mainText(page, firstSource).waitFor();
		assert.equal((await readStore(page, 'threads')).length, 2);

		await page.setViewportSize({ width: 768, height: 1_024 });
		const sessionMenu = page.getByRole('button', { name: '打开会话列表' });
		await sessionMenu.click();
		await page.getByRole('button', { name: '关闭会话列表', exact: true }).last().waitFor();
		assert.equal(
			await page
				.getByRole('button', { name: '关闭会话列表', exact: true })
				.last()
				.evaluate((element) => element === document.activeElement),
			true
		);
		await page.keyboard.press('Escape');
		await page.waitForFunction(
			() => document.activeElement?.getAttribute('aria-label') === '打开会话列表'
		);
		assert.equal(await sessionMenu.evaluate((element) => element === document.activeElement), true);
		await sessionMenu.click();
		await firstThreadButton.click();
		await mainText(page, firstSource).waitFor();
		assert.equal(await firstThreadButton.getAttribute('aria-current'), 'page');
		assert.deepEqual(browserErrors, []);
	} finally {
		await context.close();
	}
}

async function testPeriodicAndPageHideCheckpoints(browser, baseUrl) {
	const { browserErrors, context, page } = await createPage(browser, baseUrl);
	try {
		await waitForReady(page);
		await startCapture(page);
		const immediateSource = 'Saved by the pagehide checkpoint.';
		await emitPair(page, immediateSource, 'pagehide で保存されます。');
		await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
		await waitForRecord(
			page,
			'runs',
			(record) => record.sourceStream.text.includes(immediateSource),
			'pagehide 立即 checkpoint'
		);

		const periodicSource = ' Saved by the periodic checkpoint.';
		await emitPair(page, periodicSource, ' 定期保存されます。');
		await waitForRecord(
			page,
			'runs',
			(record) => record.sourceStream.text.includes(periodicSource),
			'10 秒周期 checkpoint',
			12_000
		);

		await page.reload({ waitUntil: 'networkidle' });
		await waitForReady(page);
		await mainText(page, `${immediateSource}${periodicSource}`).waitFor();
		const repairedRun = await waitForRecord(
			page,
			'runs',
			(record) =>
				record.sourceStream.text.includes(periodicSource) && record.status === 'interrupted',
			'刷新后的遗留 Run 修复'
		);
		assert.equal(repairedRun.endReason, 'page-terminated');
		assert.equal(repairedRun.endTimeEstimated, true);
		assert.deepEqual(browserErrors, []);
	} finally {
		await context.close();
	}
}

async function testDegradeAndRecover(browser, baseUrl) {
	const { browserErrors, context, page } = await createPage(browser, baseUrl);
	try {
		await waitForReady(page);
		await startCapture(page);
		await waitForRunningUsageEstimate(page);
		await page.waitForFunction(() => window.__voxbraidWakeLockTest?.requests === 1);
		await emitPair(page, 'Before a temporary network problem.', '一時的な通信問題の前です。');
		await page.evaluate(() => window.__voxbraidBrowserTest?.degrade());
		await page.getByText('等待连接恢复', { exact: true }).waitFor();
		const liveRun = await waitForRecord(
			page,
			'runs',
			(record) => record.status === 'live',
			'连接降级期间保持 live'
		);
		assert.equal(liveRun.endedAt, null);
		assert.equal(await page.evaluate(() => window.__voxbraidWakeLockTest?.releases), 0);

		await page.evaluate(() => window.__voxbraidBrowserTest?.recover());
		await page.getByText('实时翻译中', { exact: true }).waitFor();
		assert.deepEqual(await page.evaluate(() => window.__voxbraidWakeLockTest), {
			releases: 0,
			requests: 1
		});
		const afterRecovery = ' Captions continue after recovery.';
		await emitPair(page, afterRecovery, ' 復帰後も字幕が続きます。');
		await stopCapture(page);
		await waitForRecord(
			page,
			'runs',
			(record) => record.sourceStream.text.includes(afterRecovery) && record.status === 'completed',
			'连接恢复后的字幕保存'
		);
		await page.waitForFunction(() => window.__voxbraidWakeLockTest?.releases === 1);
		assert.deepEqual(browserErrors, []);
	} finally {
		await context.close();
	}
}

async function testConnectionFailure(browser, baseUrl) {
	const { browserErrors, context, page } = await createPage(browser, baseUrl);
	try {
		await waitForReady(page);
		await startCapture(page);
		const source = 'Keep text produced before a failed connection.';
		await emitPair(page, source, '接続失敗前の字幕を保存します。');
		await page.evaluate(() => window.__voxbraidBrowserTest?.fail('模拟连接中断。'));
		await page.getByText('模拟连接中断。', { exact: true }).waitFor();
		const failedRun = await waitForRecord(
			page,
			'runs',
			(record) => record.sourceStream.text.includes(source) && record.status === 'interrupted',
			'连接失败后的 checkpoint'
		);
		assert.equal(failedRun.endReason, 'connection-lost');
		assert.equal(failedRun.lastError?.message, '模拟连接中断。');

		await page.reload({ waitUntil: 'networkidle' });
		await waitForReady(page);
		await mainText(page, source).waitFor();
		assert.deepEqual(browserErrors, []);
	} finally {
		await context.close();
	}
}

async function testCaptureRunDurationLimit(browser, baseUrl) {
	const { browserErrors, context, page } = await createPage(
		browser,
		baseUrl,
		'?browser-test=1&capture-run-limit-ms=100'
	);
	try {
		await waitForReady(page);
		await startCapture(page);
		await emitPair(page, 'Automatic duration protection.', '自动时长保护。');
		await page.getByRole('button', { name: '开始翻译' }).waitFor({ timeout: 4_000 });
		await page
			.getByText('已达到单次连续收音 2 小时安全上限，翻译已自动停止并保存。', {
				exact: true
			})
			.waitFor();
		const limitedRun = await waitForRecord(
			page,
			'runs',
			(record) => record.endReason === 'duration-limit' && record.status === 'completed',
			'达到安全时长上限后的 Run 保存'
		);
		assert.equal(limitedRun.sourceStream.text, 'Automatic duration protection.');
		assert.deepEqual(browserErrors, []);
	} finally {
		await context.close();
	}
}

async function testStorageTimeoutFallback(browser, baseUrl) {
	const { browserErrors, context, page } = await createPage(
		browser,
		baseUrl,
		'?browser-test=1&storage-test=hang'
	);
	try {
		const start = page.getByRole('button', { name: '开始翻译' });
		await start.waitFor({ state: 'visible' });
		assert.equal(await start.isDisabled(), true);
		await page
			.getByText('本地历史记录不可用；实时翻译仍可继续。', { exact: true })
			.waitFor({ timeout: 7_000 });
		await page.waitForFunction(() => window.__voxbraidBrowserTest !== undefined);
		assert.equal(await start.isEnabled(), true);

		await startCapture(page);
		await emitPair(page, 'Translation continues without storage.', '保存なしでも翻訳できます。');
		await mainText(page, 'Translation continues without storage.').waitFor();
		await stopCapture(page);
		const expectedError = '[persistence] restore failed';
		assert.ok(browserErrors.some((message) => message.includes(expectedError)));
		assert.deepEqual(
			browserErrors.filter((message) => !message.includes(expectedError)),
			[]
		);
	} finally {
		await context.close();
	}
}

const chromePath = await firstAccessible([
	process.env.CHROME_PATH,
	'/usr/bin/google-chrome',
	'/usr/bin/chromium',
	'/usr/bin/chromium-browser'
]);
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
	const baseUrl = `http://127.0.0.1:${address.port}`;

	try {
		browser = await chromium.launch({
			...(chromePath ? { executablePath: chromePath } : {}),
			headless: true
		});
	} catch (error) {
		throw new Error(
			'无法启动 Chromium。请按 README 安装 chromium-headless-shell，或设置 CHROME_PATH。',
			{ cause: error }
		);
	}

	await testPauseResumeAndNewThread(browser, baseUrl);
	await testCleanTranscriptContinuesAfterFailure(browser, baseUrl);
	await testDegradeAndRecover(browser, baseUrl);
	await testPeriodicAndPageHideCheckpoints(browser, baseUrl);
	await testConnectionFailure(browser, baseUrl);
	await testCaptureRunDurationLimit(browser, baseUrl);
	await testStorageTimeoutFallback(browser, baseUrl);
	console.log(
		'[persistence-smoke] passed: pause/resume, session switching, sidecar tasks and block failure continuation, degrade/recover, checkpoints, reload repair, failure, duration protection, and storage fallback'
	);
} finally {
	await browser?.close();
	await server.close();
}
