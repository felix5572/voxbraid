import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const MARKDOWN_ANSWER = `# 自动问答结果

- **重点**：回答已按 Markdown 渲染。

[安全链接](https://example.com/path) [坏链接](javascript:alert('link'))

<img src=x onerror="alert('image')"><script>alert('script')</script>`;

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

async function waitForStoreCondition(page, storeName, predicate, description, timeoutMs = 4_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const records = await readStore(page, storeName);
		if (predicate(records)) return records;
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

async function waitForLiveRevisionTail(page, expected) {
	await page.waitForFunction(
		(value) =>
			[
				...document.querySelectorAll(
					'[data-capturing-source-tail] .live-source, [data-live-source-tail] .live-source'
				)
			]
				.map((element) => element.textContent ?? '')
				.join('') === value,
		expected
	);
}

async function createPage(browser, baseUrl, query = '?browser-test=1') {
	const context = await browser.newContext({
		...(httpCredentials ? { httpCredentials } : {}),
		permissions: ['clipboard-read', 'clipboard-write']
	});
	const sidecarRequests = [];
	let injectedCleanFailuresRemaining = 1;
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
					{
						days: 1,
						durationSeconds: 93,
						costUsd: 0.07905,
						accountCostUsd: 0.07905,
						breakdown: {
							translationUsd: 0.0527,
							transcriptionUsd: 0.02635,
							sidecarUsd: 0,
							otherUsd: 0
						}
					},
					{
						days: 7,
						durationSeconds: 121,
						costUsd: 0.10285,
						accountCostUsd: 0.10285,
						breakdown: {
							translationUsd: 0.06857,
							transcriptionUsd: 0.03428,
							sidecarUsd: 0,
							otherUsd: 0
						}
					},
					{
						days: 30,
						durationSeconds: 121,
						costUsd: 0.10285,
						accountCostUsd: 0.10285,
						breakdown: {
							translationUsd: 0.06857,
							transcriptionUsd: 0.03428,
							sidecarUsd: 0,
							otherUsd: 0
						}
					}
				],
				monthToDate: {
					periodStart: '2026-09-01T00:00:00.000Z',
					durationSeconds: 121,
					costUsd: 0.10285,
					accountCostUsd: 0.10285,
					breakdown: {
						translationUsd: 0.06857,
						transcriptionUsd: 0.03428,
						sidecarUsd: 0,
						otherUsd: 0
					}
				},
				costMeter: {
					periodStart: '2026-01-01T00:00:00.000Z',
					accountCostUsd: 0.10285
				},
				hardSpendLimit: { status: 'not-configured' },
				updatedAt: '2026-09-01T12:00:00.000Z'
			})
		});
	});
	await page.route('**/api/sidecar/invoke', async (route) => {
		const body = route.request().postDataJSON();
		sidecarRequests.push(body);
		const delayMs =
			body.intent.kind === 'ask' && body.intent.question === 'Hold across thread switch'
				? 500
				: body.intent.kind === 'revise-pairs' &&
					  body.intent.atoms
							?.map((atom) => atom.t)
							.join('')
							.includes('[HOLD_HISTORY]')
					? 2_500
					: body.intent.kind === 'revise-pairs' &&
						  body.intent.atoms
								?.map((atom) => atom.t)
								.join('')
								.includes('[HOLD_PAIR]')
						? 600
						: 25;
		await new Promise((resolve) => setTimeout(resolve, delayMs));
		if (
			body.intent.kind === 'summarize' &&
			body.context.runs[0]?.sourceText.includes('[FAIL_CLEAN_BLOCK]') &&
			injectedCleanFailuresRemaining-- > 0
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
					diagnostic: null,
					error: { code: 'upstream-failed', message: 'Injected block failure.' },
					failedAt: '2026-09-01T12:00:00.000Z'
				})
			});
			return;
		}
		const cleanBlockNumber = sidecarRequests.filter(
			(request) => request.intent.kind === 'summarize'
		).length;
		const askNumber = sidecarRequests.filter((request) => request.intent.kind === 'ask').length;
		const pairNumber = sidecarRequests.filter(
			(request) => request.intent.kind === 'revise-pairs'
		).length;
		const pairAtoms = body.intent.kind === 'revise-pairs' ? (body.intent.atoms ?? []) : [];
		const pairRaw = pairAtoms.map((atom) => atom.t).join('');
		const pairGroups = [];
		if (pairAtoms.length > 0 && pairRaw.includes('[LONG_PAIR]')) {
			pairGroups.push({
				firstAtom: 1,
				lastAtom: pairAtoms.length,
				revisedSourceText: pairRaw.trim(),
				translatedText: `独立句段译文 ${pairNumber}.1`,
				paragraphBreakBefore: false
			});
		} else {
			for (const [index, atom] of pairAtoms.entries()) {
				pairGroups.push({
					firstAtom: index + 1,
					lastAtom: index + 1,
					revisedSourceText: atom.t.trim(),
					translatedText: `独立句段译文 ${pairNumber}.${index + 1}`,
					paragraphBreakBefore: index > 0
				});
			}
		}
		if (pairRaw.includes('[INVALID_REVISION]') && pairGroups[0]) {
			pairGroups[0].translatedText = '';
		}
		if (
			pairRaw.includes('[INVALID_BOUNDARY') &&
			pairGroups[0] &&
			(body.intent.previousInvalidAtomRanges.length === 0 ||
				pairRaw.includes('[INVALID_BOUNDARY_TWICE]'))
		) {
			const invalidRanges = [
				{ firstAtom: 1, lastAtom: pairAtoms.length },
				{ firstAtom: 1, lastAtom: pairAtoms.length }
			];
			pairGroups.splice(
				0,
				pairGroups.length,
				...invalidRanges.map((range, index) => ({
					...range,
					revisedSourceText: `Injected revision group ${index + 1}.`,
					translatedText: `注入的修订组 ${index + 1}。`,
					paragraphBreakBefore: index > 0
				}))
			);
		}
		const outputs = {
			summarize: `课堂清稿第${cleanBlockNumber}块`,
			retranslate: '自动重译结果',
			ask:
				body.intent.question === 'What was captured?'
					? MARKDOWN_ANSWER
					: askNumber === 1
						? '自动问答结果'
						: '自动追问结果',
			'revise-pairs': JSON.stringify({ groups: pairGroups })
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
		await page.getByRole('button', { name: '重试失败块', exact: true }).click();
		const retried = await waitForRecord(
			page,
			'cleanTranscriptBlocks',
			(record) =>
				record.sequence === failed.sequence &&
				record.status === 'completed' &&
				record.failureAttempts?.length === 1,
			'重试成功后保留第一次失败诊断'
		);
		assert.equal(retried.failureAttempts[0].errorCode, 'upstream-failed');
		await waitForRecord(
			page,
			'revisionBatches',
			(record) => record.status === 'completed' && record.openEnd === source.length,
			'长原文的句段对照队列追平'
		);
		assert.deepEqual(browserErrors, []);
	} finally {
		await context.close();
	}
}

async function testDiagnosticsModePreference(browser, baseUrl) {
	const { browserErrors, context, page } = await createPage(browser, baseUrl);
	try {
		await waitForReady(page);
		await startCapture(page);
		await emitPair(
			page,
			'Diagnostics stay out of reading mode. A second sentence triggers revision.',
			'诊断信息默认不干扰阅读。第二句话触发修订。'
		);
		const evidence = page.locator('.raw-evidence').first();
		await evidence.waitFor();
		assert.equal(await evidence.getAttribute('open'), null);
		assert.equal(await page.getByText(/Live 原文片段 · raw/u).count(), 0);

		await page.getByRole('button', { name: '诊断模式 关', exact: true }).click();
		await page.getByRole('button', { name: '诊断模式 开', exact: true }).waitFor();
		await page
			.getByText(/Live 原文片段 · raw/u)
			.first()
			.waitFor();
		assert.notEqual(await evidence.getAttribute('open'), null);
		assert.equal(
			await page.evaluate(() => localStorage.getItem('voxbraid-diagnostics-mode')),
			'true'
		);

		await stopCapture(page);
		await page.reload({ waitUntil: 'networkidle' });
		await waitForReady(page);
		await page.getByRole('button', { name: '诊断模式 开', exact: true }).waitFor();
		assert.deepEqual(browserErrors, []);
	} finally {
		await context.close();
	}
}

async function testCreditBalanceCalibration(browser, baseUrl) {
	const { browserErrors, context, page } = await createPage(browser, baseUrl);
	try {
		await waitForReady(page);
		await page.getByText('余额与明细', { exact: true }).click();
		await page.getByLabel('Billing 当前可用余额（美元）').fill('10.00');
		await page.getByRole('button', { name: '校准预计余额', exact: true }).click();
		await page.locator('[data-estimated-credit-balance-usd="10"]').waitFor();
		const stored = await page.evaluate(() =>
			JSON.parse(localStorage.getItem('voxbraid-openai-credit-balance-anchor') ?? 'null')
		);
		assert.equal(stored.balanceUsd, 10);
		assert.equal(stored.accountCostUsd, 0.10285);

		await page.reload({ waitUntil: 'networkidle' });
		await page.locator('[data-estimated-credit-balance-usd="10"]').waitFor();
		assert.deepEqual(browserErrors, []);
	} finally {
		await context.close();
	}
}

async function testOperationalLogPanelKeepsUserOpenState(browser, baseUrl) {
	const { browserErrors, context, page } = await createPage(browser, baseUrl);
	try {
		await waitForReady(page);
		const recordIssue = () =>
			page.evaluate(() => {
				window.dispatchEvent(
					new CustomEvent('voxbraid:operational-log', {
						detail: {
							action: 'record',
							input: {
								severity: 'warning',
								source: 'system',
								code: 'panel-open-test',
								summary: '运行问题展开状态测试。',
								details: '日志更新不得收起用户已经展开的面板。'
							}
						}
					})
				);
			});
		await recordIssue();
		const panel = page.locator('.operational-log > details');
		await panel.locator(':scope > summary').click();
		assert.notEqual(await panel.getAttribute('open'), null);

		await recordIssue();
		await page.getByText('×2', { exact: true }).waitFor();
		assert.notEqual(await panel.getAttribute('open'), null);

		await page.getByRole('button', { name: '清空记录', exact: true }).click();
		await page.getByText('目前没有运行问题', { exact: true }).waitFor();
		assert.notEqual(await panel.getAttribute('open'), null);
		assert.deepEqual(browserErrors, []);
	} finally {
		await context.close();
	}
}

async function testHiddenPageContinuesRevision(browser, baseUrl) {
	const { browserErrors, context, page, sidecarRequests } = await createPage(browser, baseUrl);
	try {
		await waitForReady(page);
		await startCapture(page);
		await page.evaluate(() => {
			Object.defineProperty(document, 'visibilityState', {
				configurable: true,
				get: () => 'hidden'
			});
		});
		const source = 'Background revision keeps working. A second sentence confirms it.';
		await emitPair(page, source, '后台仍继续修订。第二句话确认这一点。');
		await waitForSidecarRequest(
			page,
			sidecarRequests,
			(request) =>
				request.intent.kind === 'revise-pairs' &&
				request.intent.atoms
					.map((atom) => atom.t)
					.join('')
					.includes(source),
			'页面隐藏时的句段修订请求'
		);
		await waitForPairCoverage(page, source.length, '页面隐藏时句段对照追平');
		await page.evaluate(() => {
			delete document.visibilityState;
		});
		await stopCapture(page);
		assert.deepEqual(browserErrors, []);
	} finally {
		await context.close();
	}
}

async function testInteractiveRequestDuringPairGeneration(browser, baseUrl) {
	const { browserErrors, context, page, sidecarRequests } = await createPage(browser, baseUrl);
	try {
		await waitForReady(page);
		await startCapture(page);
		const source = '[HOLD_PAIR] The background sentence pair request is deliberately slow.';
		await emitPair(page, source, '后台句段请求被故意放慢。');
		await mainText(page, source).waitFor();
		await waitForSidecarRequest(
			page,
			sidecarRequests,
			(request) =>
				request.intent.kind === 'revise-pairs' &&
				request.intent.atoms
					.map((atom) => atom.t)
					.join('')
					.includes('[HOLD_PAIR]'),
			'在飞的句段对照请求'
		);
		await waitForLiveRevisionTail(page, source);
		const continuation = ' New raw words arrive while Luna is still revising.';
		await emitPair(page, continuation, 'Luna处理期间的新内容。');
		await waitForLiveRevisionTail(page, source + continuation);
		const anchorBefore = await page.evaluate(() => {
			const element = document.querySelector('[data-live-source-line]');
			if (!(element instanceof HTMLElement)) throw new Error('实时阅读锚点不存在。');
			window.__voxbraidRevisionReadingAnchor = element;
			const bounds = element.getBoundingClientRect();
			return { left: bounds.left, top: bounds.top, text: element.textContent };
		});
		assert.equal(anchorBefore.text, continuation);
		await page
			.locator('.pair-row:not(.live-row) .source')
			.getByText(source, { exact: true })
			.waitFor();
		await waitForLiveRevisionTail(page, continuation);
		const anchorAfter = await page.evaluate(() => {
			const element = document.querySelector('[data-live-source-line]');
			if (!(element instanceof HTMLElement)) throw new Error('修订后的实时阅读锚点不存在。');
			const bounds = element.getBoundingClientRect();
			return {
				left: bounds.left,
				top: bounds.top,
				sameNode: element === window.__voxbraidRevisionReadingAnchor
			};
		});
		assert.equal(anchorAfter.sameNode, true);
		assert.ok(Math.abs(anchorAfter.left - anchorBefore.left) <= 1);
		assert.ok(Math.abs(anchorAfter.top - anchorBefore.top) <= 2);
		const question = page.getByLabel('字幕问题', { exact: true });
		assert.equal(await question.isEnabled(), true);
		await question.fill('Can I ask while sentence pairs are still running?');
		await page.getByRole('button', { name: '提问', exact: true }).click();
		await waitForSidecarRequest(
			page,
			sidecarRequests,
			(request) =>
				request.intent.kind === 'ask' &&
				request.intent.question === 'Can I ask while sentence pairs are still running?',
			'后台句段生成期间的交互请求'
		);
		await page.getByText(/自动(?:问答|追问)结果/u).waitFor();
		await stopCapture(page);
		await waitForPairCoverage(page, source.length + continuation.length);
		assert.deepEqual(browserErrors, []);
	} finally {
		await context.close();
	}
}

async function testCompletedRunTailIsNotMarkedLive(browser, baseUrl) {
	const { browserErrors, context, page, sidecarRequests } = await createPage(browser, baseUrl);
	try {
		await waitForReady(page);
		await startCapture(page);
		const source = '[HOLD_HISTORY] This raw sentence is waiting for revision.';
		await emitPair(page, source, '这段原文正在等待修订。');
		await waitForSidecarRequest(
			page,
			sidecarRequests,
			(request) =>
				request.intent.kind === 'revise-pairs' &&
				request.intent.atoms
					.map((atom) => atom.t)
					.join('')
					.includes('[HOLD_HISTORY]'),
			'历史段落测试中的在飞修订请求'
		);
		await waitForLiveRevisionTail(page, source);
		await stopCapture(page);
		const historicalTail = page.locator('[data-unrevised-source-tail]');
		await historicalTail.getByText(source, { exact: true }).waitFor();
		await historicalTail.getByText('未修订', { exact: true }).waitFor();
		assert.equal(await page.locator('[data-live-source-tail]').count(), 0);
		assert.deepEqual(browserErrors, []);
	} finally {
		await context.close();
	}
}

async function testOpenWindowRevision(browser, baseUrl) {
	const { browserErrors, context, page, sidecarRequests } = await createPage(browser, baseUrl);
	try {
		await waitForReady(page);
		await startCapture(page);
		const partial = Array.from(
			{ length: 5 },
			(_, index) => `Sentence ${index + 1} ${'word '.repeat(28)}ends. `
		).join('');
		await emitPair(page, partial, '开放窗口译文。');
		const first = await waitForRecord(
			page,
			'revisionBatches',
			(record) =>
				record.status === 'completed' &&
				record.openStart === 0 &&
				record.openEnd === partial.length,
			'首个开放窗口修订'
		);
		const frozenBefore = (await readStore(page, 'revisedSegments'))
			.filter((record) => record.runId === first.runId && record.state === 'frozen')
			.sort((left, right) => left.sourceStart - right.sourceStart);
		assert.ok(frozenBefore.length > 0);

		const ending = ' More context completes one thought. Another ends now.';
		await emitPair(page, ending, '完成。');
		const revised = await waitForRecord(
			page,
			'revisionBatches',
			(record) =>
				record.runId === first.runId &&
				record.sequence > first.sequence &&
				record.status === 'completed' &&
				record.openEnd === partial.length + ending.length,
			'新上下文到达后重写开放窗口',
			7_000
		);
		const revisionRequests = sidecarRequests.filter(
			(request) => request.intent.kind === 'revise-pairs'
		);
		assert.ok(revisionRequests.at(-1).intent.previousDraft.length > 0);
		assert.equal(
			revisionRequests
				.at(-1)
				.intent.previousDraft.map((segment) => segment.rawText)
				.join(''),
			partial.slice(
				frozenBefore.at(-1).sourceEnd,
				partial.indexOf(' Sentence 5', frozenBefore.at(-1).sourceEnd)
			),
			'原子边界变化时只携带仍与当前子句原子对齐的旧草稿'
		);
		const storedSegments = (await readStore(page, 'revisedSegments'))
			.filter((record) => record.runId === revised.runId)
			.sort((left, right) => left.sourceStart - right.sourceStart);
		assert.equal(storedSegments.map((record) => record.rawText).join(''), partial + ending);
		assert.deepEqual(
			storedSegments.filter((record) => record.sourceEnd <= frozenBefore.at(-1).sourceEnd),
			frozenBefore,
			'已冻结的前部在开放尾窗修订后保持逐字段不变'
		);
		assert.ok(
			storedSegments
				.filter((record) => record.sourceStart >= frozenBefore.at(-1).sourceEnd)
				.every((record) => record.producedByBatchId === revised.id)
		);
		const openUpdatedAtBeforeFreeze = new Map(
			storedSegments
				.filter((record) => record.state === 'open')
				.map((record) => [record.id, record.updatedAt])
		);
		const requestCountBeforeFreeze = revisionRequests.length;
		const locallyFrozen = await waitForStoreCondition(
			page,
			'revisedSegments',
			(records) =>
				records.some((record) => record.runId === revised.runId) &&
				records
					.filter((record) => record.runId === revised.runId)
					.every((record) => record.state === 'frozen'),
			'自然句末静默后的本地冻结'
		);
		assert.ok(locallyFrozen.some((record) => record.runId === revised.runId));
		for (const record of locallyFrozen.filter((candidate) => candidate.runId === revised.runId)) {
			const previousUpdatedAt = openUpdatedAtBeforeFreeze.get(record.id);
			if (previousUpdatedAt) {
				assert.equal(
					record.updatedAt,
					previousUpdatedAt,
					'open → frozen 只改变状态，不应触发文本变化动画'
				);
			}
		}
		assert.equal(
			sidecarRequests.filter((request) => request.intent.kind === 'revise-pairs').length,
			requestCountBeforeFreeze,
			'本地冻结不应重复调用模型'
		);
		await stopCapture(page);
		assert.deepEqual(browserErrors, []);
	} finally {
		await context.close();
	}
}

async function testLongRevisionGroupIsAccepted(browser, baseUrl) {
	const { browserErrors, context, page, sidecarRequests } = await createPage(browser, baseUrl);
	try {
		await waitForReady(page);
		await startCapture(page);
		const source = `[LONG_PAIR] ${'long '.repeat(110)}.`;
		await emitPair(page, source, '超长句段。');
		const completed = await waitForRecord(
			page,
			'revisionBatches',
			(record) => record.status === 'completed' && record.openEnd - record.openStart > 480,
			'长段首次接受'
		);
		const accepted = await waitForRecord(
			page,
			'revisedSegments',
			(record) => record.producedByBatchId === completed.id,
			'长段一次接受'
		);
		assert.equal(accepted.rawText, source);
		const requests = sidecarRequests.filter((request) => request.intent.kind === 'revise-pairs');
		assert.equal(requests.length, 1);
		await page.getByText('长段', { exact: true }).waitFor();
		assert.equal(
			(await readStore(page, 'revisionBatches')).filter((record) => record.status === 'failed')
				.length,
			0
		);
		await stopCapture(page);
		assert.deepEqual(browserErrors, []);
	} finally {
		await context.close();
	}
}

async function testInvalidRevisionDoesNotRetry(browser, baseUrl) {
	const { browserErrors, context, page, sidecarRequests } = await createPage(browser, baseUrl);
	try {
		await waitForReady(page);
		await startCapture(page);
		const source = '[INVALID_REVISION] First sentence. Second sentence.';
		await emitPair(page, source, '无效响应测试。');
		await waitForRecord(
			page,
			'revisionBatches',
			(record) => record.status === 'failed' && record.errorCode === 'invalid-response',
			'无效模型响应审计'
		);
		await waitForRecord(
			page,
			'operationalLogs',
			(record) => record.source === 'revision' && record.code === 'invalid-response',
			'底部运行问题记录'
		);
		await page.getByText('运行问题', { exact: true }).waitFor();
		await page.waitForTimeout(5_000);
		assert.equal(
			sidecarRequests.filter((request) => request.intent.kind === 'revise-pairs').length,
			1,
			'同一失败 raw 窗口不应自动重复付费请求'
		);
		await stopCapture(page);
		assert.deepEqual(browserErrors, []);
	} finally {
		await context.close();
	}
}

async function testInvalidRevisionBoundaryGetsOneTargetedRetry(browser, baseUrl) {
	const { browserErrors, context, page, sidecarRequests } = await createPage(browser, baseUrl);
	try {
		await waitForReady(page);
		await startCapture(page);
		const source = '[INVALID_BOUNDARY] First sentence. Second sentence.';
		await emitPair(page, source, '边界纠正测试。');
		const failed = await waitForRecord(
			page,
			'revisionBatches',
			(record) => record.status === 'failed' && record.errorCode === 'invalid-revision-boundary',
			'修订边界首轮失败审计'
		);
		await waitForRecord(
			page,
			'revisionBatches',
			(record) =>
				record.runId === failed.runId &&
				record.sequence > failed.sequence &&
				record.status === 'completed',
			'修订边界定向纠正成功'
		);
		const requests = sidecarRequests.filter((request) => request.intent.kind === 'revise-pairs');
		assert.equal(requests.length, 2);
		assert.deepEqual(requests[0].intent.previousInvalidAtomRanges, []);
		assert.deepEqual(requests[1].intent.previousInvalidAtomRanges, [
			{ firstAtom: 1, lastAtom: requests[0].intent.atoms.length },
			{ firstAtom: 1, lastAtom: requests[0].intent.atoms.length }
		]);
		assert.equal(
			await page.locator('.failed').count(),
			0,
			'已被后续成功批次覆盖的失败不应出现在阅读态'
		);
		await page.getByRole('button', { name: '诊断模式 关', exact: true }).click();
		await page.getByText('第 1 段的早期尝试已纠正', { exact: false }).waitFor();
		await stopCapture(page);
		assert.deepEqual(browserErrors, []);
	} finally {
		await context.close();
	}
}

async function testRepeatedInvalidRevisionBoundaryStopsAfterCorrection(browser, baseUrl) {
	const { browserErrors, context, page, sidecarRequests } = await createPage(browser, baseUrl);
	try {
		await waitForReady(page);
		await startCapture(page);
		const source = '[INVALID_BOUNDARY_TWICE] First sentence. Second sentence.';
		await emitPair(page, source, '重复边界错误测试。');
		await waitForStoreCondition(
			page,
			'revisionBatches',
			(records) =>
				records.filter((record) => record.errorCode === 'invalid-revision-boundary').length >= 2,
			'第二次修订边界失败审计'
		);
		await page.waitForTimeout(5_000);
		assert.equal(
			sidecarRequests.filter((request) => request.intent.kind === 'revise-pairs').length,
			2,
			'第二次边界纠正失败后不得继续自动付费重试'
		);
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

async function waitForPairCoverage(page, sourceLength, label = '句段对照追平原文') {
	return waitForRecord(
		page,
		'revisionBatches',
		(record) => record.status === 'completed' && record.openEnd === sourceLength,
		label
	);
}

function mainText(page, text) {
	return page.locator('.captions').getByText(text, { exact: true });
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
		const firstPairBatch = await waitForRecord(
			page,
			'revisionBatches',
			(record) => record.threadId === firstRun.threadId && record.status === 'completed',
			'首个句段对照批次保存'
		);
		const firstPairSegment = await waitForRecord(
			page,
			'revisedSegments',
			(record) => record.producedByBatchId === firstPairBatch.id,
			'首个句段对照结果原子保存'
		);
		assert.equal(firstPairSegment.rawText, firstSource.slice(0, firstPairBatch.openEnd));
		assert.equal(firstPairSegment.revisedSourceText, firstPairSegment.rawText);
		assert.match(firstPairSegment.translatedText, /^独立句段译文 \d+\.\d+$/);
		await waitForRecord(
			page,
			'revisionBatches',
			(record) =>
				record.threadId === firstRun.threadId &&
				record.runId === firstRun.id &&
				record.status === 'completed' &&
				record.openEnd === firstSource.length,
			'暂停后句段对照追平完整原文'
		);
		const finalFirstRunSegments = (await readStore(page, 'revisedSegments'))
			.filter((record) => record.runId === firstRun.id)
			.sort((left, right) => left.sourceStart - right.sourceStart);
		assert.equal(finalFirstRunSegments.map((record) => record.rawText).join(''), firstSource);
		const restoredPairTranslation = finalFirstRunSegments[0].translatedText;
		await page.getByRole('button', { name: new RegExp(firstTitle) }).waitFor();

		await page.reload({ waitUntil: 'networkidle' });
		await waitForReady(page);
		await page.getByRole('button', { name: new RegExp(firstTitle) }).waitFor();
		await mainText(page, firstSource).waitFor();
		await page.getByText(restoredPairTranslation, { exact: true }).waitFor();
		await page.getByText(firstTranslation.slice(0, 1).repeat(3), { exact: true }).waitFor();
		assert.equal(await page.getByLabel('目标语言', { exact: true }).inputValue(), 'ja');

		const secondSource = 'Second capture run in the same thread.';
		const secondTranslation = '同じ会話の二つ目の収録です。';
		await startCapture(page);
		await emitPair(page, secondSource, secondTranslation);
		await stopCapture(page);
		const secondRun = await waitForRecord(
			page,
			'runs',
			(record) => record.sourceStream.text.includes(secondSource) && record.sequence === 2,
			'继续收音后的第二个 Run 保存'
		);
		await waitForRecord(
			page,
			'revisionBatches',
			(record) =>
				record.runId === secondRun.id &&
				record.status === 'completed' &&
				record.openEnd === secondSource.length,
			'刷新前第二段句段对照追平'
		);
		await page.reload({ waitUntil: 'networkidle' });
		await waitForReady(page);
		await mainText(page, firstSource).waitFor();
		await mainText(page, secondSource).waitFor();

		const summarize = page.getByRole('button', { name: '整理未处理内容', exact: true });
		await summarize.click();
		assert.equal(await summarize.isDisabled(), true);
		await page.getByText('课堂清稿第2块', { exact: true }).waitFor();
		const summaryRequests = sidecarRequests.filter(
			(request) => request.intent.kind === 'summarize'
		);
		assert.equal(summaryRequests.length, 2);
		assert.equal(summaryRequests[0].context.scope, 'latest-run');
		assert.equal(summaryRequests[0].context.runs.length, 1);
		assert.equal(summaryRequests[0].context.runs[0].sourceText, firstSource);
		assert.equal(summaryRequests[1].context.runs[0].sourceText, secondSource);
		assert.equal(summaryRequests[1].context.continuityText, '课堂清稿第1块');
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
		await page.getByRole('button', { name: '重新整理全部', exact: true }).click();
		await page.getByText('课堂清稿第4块', { exact: true }).waitFor();
		assert.equal(await page.getByText('课堂清稿第1块', { exact: true }).count(), 0);
		const rebuiltBlocks = (await readStore(page, 'cleanTranscriptBlocks')).filter(
			(record) => record.threadId === firstRun.threadId
		);
		assert.deepEqual(
			rebuiltBlocks.map((record) => record.sequence).sort((left, right) => left - right),
			[1, 2]
		);

		await page.getByLabel('字幕问题', { exact: true }).fill('What was captured?');
		await page.getByRole('button', { name: '提问', exact: true }).click();
		await page.locator('.answer-text h1').getByText('自动问答结果', { exact: true }).waitFor();
		await page.locator('.answer-text li strong').getByText('重点', { exact: true }).waitFor();
		const renderedAnswer = page.locator('.answer-text').last();
		const safeLink = renderedAnswer.getByRole('link', { name: '安全链接', exact: true });
		await safeLink.waitFor();
		assert.equal(await safeLink.getAttribute('href'), 'https://example.com/path');
		assert.equal(await safeLink.getAttribute('target'), '_blank');
		assert.equal(await safeLink.getAttribute('rel'), 'noopener noreferrer');
		assert.equal(await renderedAnswer.getByRole('link', { name: '坏链接' }).count(), 0);
		assert.equal(await renderedAnswer.locator('script, img, [onerror]').count(), 0);
		assert.equal((await renderedAnswer.textContent()).includes("alert('script')"), false);
		const askRequest = sidecarRequests.find((request) => request.intent.kind === 'ask');
		assert.ok(askRequest);
		assert.equal(askRequest.intent.question, 'What was captured?');
		assert.deepEqual(askRequest.intent.history, []);
		assert.equal(askRequest.context.cleanedTranscript, '课堂清稿第3块\n\n课堂清稿第4块');

		await page.getByLabel('字幕问题', { exact: true }).fill('What did you just answer?');
		await page.getByRole('button', { name: '提问', exact: true }).click();
		await page.getByText('自动追问结果', { exact: true }).waitFor();
		await page.getByText('自动问答结果', { exact: true }).waitFor();
		const askRequests = sidecarRequests.filter((request) => request.intent.kind === 'ask');
		assert.equal(askRequests.length, 2);
		assert.equal(askRequests[1].intent.question, 'What did you just answer?');
		assert.deepEqual(askRequests[1].intent.history, [
			{ question: 'What was captured?', answer: MARKDOWN_ANSWER }
		]);
		assert.equal(askRequests[1].context.cleanedTranscript, askRequest.context.cleanedTranscript);
		assert.equal(askRequests[1].context.runs.length, 2);

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
		assert.equal(await page.getByText('What was captured?', { exact: true }).count(), 0);
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
		await page.getByText('What was captured?', { exact: true }).waitFor();
		await page.getByText('自动追问结果', { exact: true }).waitFor();
		assert.equal(await firstThreadButton.getAttribute('aria-current'), 'page');
		assert.equal(await mainText(page, newThreadSource).count(), 0);

		const newThreadButton = page.locator(`[data-thread-id="${newThread.id}"]`);
		await newThreadButton.click();
		await mainText(page, newThreadSource).waitFor();
		assert.equal(await newThreadButton.getAttribute('aria-current'), 'page');
		assert.equal(await mainText(page, firstSource).count(), 0);
		await page.getByLabel('字幕问题', { exact: true }).fill('Fresh thread question');
		await page.getByRole('button', { name: '提问', exact: true }).click();
		await page.getByText('自动追问结果', { exact: true }).waitFor();
		const freshThreadRequest = sidecarRequests.find(
			(request) =>
				request.intent.kind === 'ask' && request.intent.question === 'Fresh thread question'
		);
		assert.ok(freshThreadRequest);
		assert.equal(freshThreadRequest.context.cleanedTranscript, '');
		await page.getByRole('button', { name: '清空对话', exact: true }).click();
		assert.equal(await page.getByText('Fresh thread question', { exact: true }).count(), 0);

		await firstThreadButton.click();
		await page.getByText('What was captured?', { exact: true }).waitFor();
		await page.waitForFunction(() => {
			const input = document.querySelector('textarea[aria-label="字幕问题"]');
			return input instanceof HTMLTextAreaElement && !input.disabled;
		});
		await page.getByLabel('字幕问题', { exact: true }).fill('Hold across thread switch');
		await page.getByRole('button', { name: '提问', exact: true }).click();
		await waitForSidecarRequest(
			page,
			sidecarRequests,
			(request) =>
				request.intent.kind === 'ask' && request.intent.question === 'Hold across thread switch',
			'跨会话切换中的自由问答请求'
		);
		await newThreadButton.click();
		assert.equal(await page.getByLabel('字幕问题', { exact: true }).isDisabled(), true);
		await page.waitForFunction(() => {
			const input = document.querySelector('textarea[aria-label="字幕问题"]');
			return input instanceof HTMLTextAreaElement && !input.disabled;
		});
		await firstThreadButton.click();
		await page.getByText('Hold across thread switch', { exact: true }).waitFor();
		const downloadPromise = page.waitForEvent('download');
		await page.getByRole('button', { name: '导出恢复备份' }).click();
		const download = await downloadPromise;
		const archivePath = await download.path();
		assert.ok(archivePath);
		const archive = JSON.parse(await readFile(archivePath, 'utf8'));
		assert.equal(archive.schemaVersion, 4);
		assert.ok(Array.isArray(archive.cleanTranscriptProjection.blocks));
		assert.ok(archive.cleanTranscriptProjection.blocks.length > 0);
		assert.ok(Array.isArray(archive.revisionProjection.batches));
		const evaluationDownloadPromise = page.waitForEvent('download');
		await page.getByRole('button', { name: '导出评估数据' }).click();
		const evaluationDownload = await evaluationDownloadPromise;
		const evaluationPath = await evaluationDownload.path();
		assert.ok(evaluationPath);
		const evaluation = JSON.parse(await readFile(evaluationPath, 'utf8'));
		assert.equal(evaluation.kind, 'voxbraid-evaluation-bundle');
		assert.equal(evaluation.schemaVersion, 1);
		assert.ok(evaluation.summary.metrics.revisionTransport);
		assert.equal(typeof evaluation.summary.usage.persistedProjectionTasks.totalTokens, 'number');
		assert.ok(Array.isArray(evaluation.summary.limitations));
		assert.ok(evaluation.metrics.revisionTransport);
		assert.equal(typeof evaluation.usage.persistedProjectionTasks.totalTokens, 'number');
		assert.equal(typeof evaluation.producer.commitSha, 'string');
		assert.ok(Array.isArray(evaluation.diagnostics.operationalLogs));
		await newThreadButton.click();
		const importButton = page.getByRole('button', { name: '恢复备份', exact: true });
		await page.waitForFunction(() => {
			const button = [...document.querySelectorAll('button')].find((item) =>
				item.textContent?.includes('恢复备份')
			);
			return button instanceof HTMLButtonElement && !button.disabled;
		});
		assert.equal(await importButton.isEnabled(), true);
		const importInput = page.locator('input[type="file"][accept*="json"]');
		await importInput.setInputFiles(archivePath);
		await page.getByText('会话已恢复。重复导入同一文件不会创建副本。', { exact: true }).waitFor();
		await mainText(page, firstSource).waitFor();
		const restoredCleanBlocks = (await readStore(page, 'cleanTranscriptBlocks')).filter(
			(record) => record.threadId === archive.thread.id
		);
		assert.deepEqual(
			restoredCleanBlocks.map((record) => record.id).sort(),
			archive.cleanTranscriptProjection.blocks.map((record) => record.id).sort()
		);
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
		await page.waitForFunction(() => {
			const input = document.querySelector('textarea[aria-label="字幕问题"]');
			return input instanceof HTMLTextAreaElement && !input.disabled;
		});
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
		await waitForPairCoverage(
			page,
			immediateSource.length + periodicSource.length,
			'pagehide 场景句段对照追平'
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
		await waitForPairCoverage(
			page,
			'Before a temporary network problem.'.length + afterRecovery.length,
			'网络恢复场景句段对照追平'
		);
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
		await page.getByRole('alert').getByText('模拟连接中断。', { exact: true }).waitFor();
		const failedRun = await waitForRecord(
			page,
			'runs',
			(record) => record.sourceStream.text.includes(source) && record.status === 'interrupted',
			'连接失败后的 checkpoint'
		);
		assert.equal(failedRun.endReason, 'connection-lost');
		assert.equal(failedRun.lastError?.message, '模拟连接中断。');
		await waitForPairCoverage(page, source.length, '连接失败场景句段对照追平');

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
		await waitForPairCoverage(
			page,
			limitedRun.sourceStream.text.length,
			'时长保护场景句段对照追平'
		);
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
		const storageStatus = page.getByRole('status').filter({ hasText: '本地记录未保存' });
		await storageStatus
			.getByText(/本地历史记录不可用；实时翻译仍可继续。/)
			.waitFor({ timeout: 10_000 });
		await storageStatus.getByText(/Error: Local session restore timed out after 5000 ms/).waitFor();
		await page.waitForFunction(() => window.__voxbraidBrowserTest !== undefined);
		assert.equal(await start.isEnabled(), true);

		await startCapture(page);
		await emitPair(page, 'Translation continues without storage.', '保存なしでも翻訳できます。');
		await mainText(page, 'Translation continues without storage.').waitFor();
		await stopCapture(page);
		await page.getByText(/^独立句段译文 \d+\.\d+$/, { exact: true }).waitFor();
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
	await testDiagnosticsModePreference(browser, baseUrl);
	await testCreditBalanceCalibration(browser, baseUrl);
	await testOperationalLogPanelKeepsUserOpenState(browser, baseUrl);
	await testHiddenPageContinuesRevision(browser, baseUrl);
	await testInteractiveRequestDuringPairGeneration(browser, baseUrl);
	await testCompletedRunTailIsNotMarkedLive(browser, baseUrl);
	await testCleanTranscriptContinuesAfterFailure(browser, baseUrl);
	await testOpenWindowRevision(browser, baseUrl);
	await testLongRevisionGroupIsAccepted(browser, baseUrl);
	await testInvalidRevisionDoesNotRetry(browser, baseUrl);
	await testInvalidRevisionBoundaryGetsOneTargetedRetry(browser, baseUrl);
	await testRepeatedInvalidRevisionBoundaryStopsAfterCorrection(browser, baseUrl);
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
