import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendSidecarRequest } from './client';
import type { SidecarInvokeRequest } from './types';

const request: SidecarInvokeRequest = {
	clientRequestId: 'request-1',
	intent: { kind: 'summarize', trigger: 'manual', outputLanguage: 'zh' },
	context: {
		threadId: 'thread-1',
		scope: 'latest-run',
		capturedAt: '2026-09-02T12:00:00.000Z',
		runs: [
			{
				runId: 'run-1',
				sequence: 1,
				targetLanguage: 'zh',
				sourceText: 'Source',
				translationText: '译文'
			}
		]
	}
};

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('sendSidecarRequest', () => {
	it('reports a browser transport failure without calling it an upstream failure', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Load failed')));

		const result = await sendSidecarRequest(request);

		expect(result).toMatchObject({
			status: 'failed',
			clientRequestId: 'request-1',
			diagnostic: {
				durationMs: expect.any(Number),
				requestBytes: expect.any(Number),
				httpStatus: null
			},
			error: {
				code: 'browser-network-failed',
				message: expect.stringContaining('TypeError: Load failed')
			}
		});
	});

	it('retains the HTTP status and response excerpt for an invalid endpoint response', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response('<h1>Bad gateway</h1>', {
					status: 502,
					statusText: 'Bad Gateway'
				})
			)
		);

		const result = await sendSidecarRequest(request);

		expect(result).toMatchObject({
			status: 'failed',
			diagnostic: { httpStatus: 502, requestBytes: expect.any(Number) },
			error: {
				code: 'invalid-response',
				message: expect.stringContaining('HTTP 502 Bad Gateway')
			}
		});
		if (result.status === 'failed') {
			expect(result.error.message).toContain('<h1>Bad gateway</h1>');
		}
	});

	it('accepts an old server failure without diagnostic during a rolling deployment', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						status: 'failed',
						clientRequestId: 'request-1',
						responseId: null,
						model: 'gpt-5.6-terra',
						outputText: null,
						upstreamStatus: 'failed',
						usageStatus: 'unavailable',
						usage: null,
						error: { code: 'upstream-failed', message: 'old server failure' },
						failedAt: '2026-09-02T12:00:01.000Z'
					}),
					{ status: 502, headers: { 'Content-Type': 'application/json' } }
				)
			)
		);

		const result = await sendSidecarRequest(request);

		expect(result).toMatchObject({
			status: 'failed',
			error: { code: 'upstream-failed', message: 'old server failure' },
			diagnostic: { httpStatus: 502, requestBytes: expect.any(Number) }
		});
	});

	it('rejects a completed response with blank output and retains the response body', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						status: 'completed',
						clientRequestId: 'request-1',
						responseId: 'resp-empty',
						model: 'gpt-5.6-terra',
						outputText: '   ',
						usageStatus: 'unavailable',
						usage: null,
						completedAt: '2026-09-02T12:00:01.000Z'
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } }
				)
			)
		);

		const result = await sendSidecarRequest(request);

		expect(result).toMatchObject({
			status: 'failed',
			error: {
				code: 'invalid-response',
				message: expect.stringContaining('"responseId":"resp-empty"')
			}
		});
	});
});
