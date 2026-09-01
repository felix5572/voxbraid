import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

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
}

async function createPage(browser, baseUrl, query = '?browser-test=1') {
	const context = await browser.newContext();
	await context.addInitScript(() => {
		const stats = { releases: 0, requests: 0 };
		Object.defineProperty(window, '__voxbraidWakeLockTest', { value: stats });
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
	const browserErrors = [];
	page.on('console', (message) => {
		if (message.type() === 'error') browserErrors.push(message.text());
	});
	await page.goto(`${baseUrl}/${query}`, { waitUntil: 'networkidle' });
	return { browserErrors, context, page };
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
	const { browserErrors, context, page } = await createPage(browser, baseUrl);
	try {
		await waitForReady(page);
		await page.locator('select').selectOption('ja');

		const firstSource = 'First automated capture run.';
		const firstTranslation = '最初の自動収録です。';
		await startCapture(page);
		await page.locator('[data-thread-id]').waitFor();
		assert.equal(await page.locator('[data-thread-id]').isDisabled(), true);
		await emitPair(page, firstSource, firstTranslation);
		await stopCapture(page);
		const firstRun = await waitForRecord(
			page,
			'runs',
			(record) => record.sourceStream.text.includes(firstSource) && record.status === 'completed',
			'第一次暂停后的 Run 保存'
		);
		assert.equal(firstRun.endReason, 'user-paused');
		await page.getByRole('button', { name: new RegExp(firstSource) }).waitFor();

		await page.reload({ waitUntil: 'networkidle' });
		await waitForReady(page);
		await page.getByRole('button', { name: new RegExp(firstSource) }).waitFor();
		await mainText(page, firstSource).waitFor();
		await page.getByText(firstTranslation, { exact: true }).waitFor();
		assert.equal(await page.locator('select').inputValue(), 'ja');

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
	await testDegradeAndRecover(browser, baseUrl);
	await testPeriodicAndPageHideCheckpoints(browser, baseUrl);
	await testConnectionFailure(browser, baseUrl);
	await testStorageTimeoutFallback(browser, baseUrl);
	console.log(
		'[persistence-smoke] passed: pause/resume, session switching, degrade/recover, checkpoints, reload repair, failure, and storage fallback'
	);
} finally {
	await browser?.close();
	await server.close();
}
