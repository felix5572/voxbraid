import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SidecarInvokeRequest, SidecarInvokeResult } from '../sidecar/types';
import { invokeSidecar } from './sidecar-invoke';

const API_KEY = 'server-only-sidecar-key';
const NOW = '2026-09-01T12:00:00.000Z';

function request(overrides: Partial<SidecarInvokeRequest> = {}): Request {
	const body: SidecarInvokeRequest = {
		clientRequestId: 'request-1',
		intent: { kind: 'summarize', trigger: 'manual', outputLanguage: 'zh' },
		context: {
			threadId: 'thread-1',
			scope: 'latest-run',
			capturedAt: '2026-09-01T11:59:00.000Z',
			continuityText: '',
			runs: [
				{
					runId: 'run-1',
					sequence: 1,
					targetLanguage: 'zh',
					sourceText: 'This is the source transcript.',
					translationText: '这是实时译文。'
				}
			]
		},
		...overrides
	};
	return rawRequest(body);
}

function rawRequest(body: unknown): Request {
	return new Request('http://localhost/api/sidecar/invoke', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body)
	});
}

async function result(response: Response): Promise<SidecarInvokeResult> {
	return (await response.json()) as SidecarInvokeResult;
}

function jsonResponse(body: unknown, status = 200, requestId?: string): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'Content-Type': 'application/json',
			...(requestId ? { 'x-request-id': requestId } : {})
		}
	});
}

afterEach(() => vi.restoreAllMocks());

describe('invokeSidecar', () => {
	it('rejects invalid requests before calling OpenAI', async () => {
		const fetcher = vi.fn();
		const invalidBody = (await request().json()) as Record<string, unknown>;
		invalidBody.intent = { kind: 'retranslate', trigger: 'periodic', targetLanguage: 'zh' };
		const response = await invokeSidecar({
			request: rawRequest(invalidBody),
			fetcher,
			apiKey: API_KEY,
			now: () => NOW
		});

		expect(response.status).toBe(400);
		expect(fetcher).not.toHaveBeenCalled();
		expect((await result(response)).status).toBe('failed');
	});

	it('does not invent a client request ID for malformed input', async () => {
		const fetcher = vi.fn();
		const response = await invokeSidecar({
			request: new Request('http://localhost/api/sidecar/invoke', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ intent: { kind: 'summarize' } })
			}),
			fetcher,
			apiKey: API_KEY,
			now: () => NOW
		});

		expect(response.status).toBe(400);
		expect(fetcher).not.toHaveBeenCalled();
		expect(await result(response)).toMatchObject({ clientRequestId: '', status: 'failed' });
	});

	it('fails closed when input token counting fails', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const fetcher = vi.fn(async () => jsonResponse({ error: { code: 'temporary' } }, 503));
		const response = await invokeSidecar({
			request: request(),
			fetcher,
			apiKey: API_KEY,
			now: () => NOW
		});

		expect(response.status).toBe(502);
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(await result(response)).toMatchObject({
			status: 'failed',
			error: { code: 'budget-check-failed' }
		});
	});

	it('rejects an over-budget context without calling generation', async () => {
		const fetcher = vi.fn(async () => jsonResponse({ input_tokens: 120_001 }));
		const response = await invokeSidecar({
			request: request(),
			fetcher,
			apiKey: API_KEY,
			now: () => NOW
		});

		expect(response.status).toBe(413);
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(await result(response)).toMatchObject({
			status: 'failed',
			error: { code: 'context-too-large' }
		});
	});

	it('counts and generates from the exact same prepared text', async () => {
		const requestBodies: Record<string, unknown>[] = [];
		const fetcher = vi.fn(async (...args: [RequestInfo | URL, RequestInit?]) => {
			requestBodies.push(JSON.parse(String(args[1]?.body)) as Record<string, unknown>);
			return requestBodies.length === 1
				? jsonResponse({ input_tokens: 42 })
				: jsonResponse({
						id: 'resp-1',
						model: 'gpt-5.6-terra',
						status: 'completed',
						output_text: '总结结果',
						usage: {
							input_tokens: 42,
							input_tokens_details: { cached_tokens: 10 },
							output_tokens: 8,
							output_tokens_details: { reasoning_tokens: 2 },
							total_tokens: 50
						}
					});
		});
		const response = await invokeSidecar({
			request: request(),
			fetcher,
			apiKey: API_KEY,
			now: () => NOW
		});

		expect(response.status).toBe(200);
		expect(requestBodies[0]).toMatchObject({
			model: 'gpt-5.6-terra',
			truncation: 'disabled'
		});
		expect(requestBodies[1]).toMatchObject({
			store: false,
			stream: false,
			truncation: 'disabled'
		});
		expect(requestBodies[1].instructions).toBe(requestBodies[0].instructions);
		expect(requestBodies[1].input).toBe(requestBodies[0].input);
		expect(await result(response)).toEqual({
			status: 'completed',
			clientRequestId: 'request-1',
			responseId: 'resp-1',
			model: 'gpt-5.6-terra',
			outputText: '总结结果',
			usageStatus: 'recorded',
			usage: {
				inputTokens: 42,
				cachedInputTokens: 10,
				outputTokens: 8,
				reasoningTokens: 2,
				totalTokens: 50
			},
			completedAt: NOW
		});
	});

	it('preserves partial text and usage from incomplete responses', async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({ input_tokens: 42 }))
			.mockResolvedValueOnce(
				jsonResponse({
					id: 'resp-incomplete',
					model: 'gpt-5.6-luna',
					status: 'incomplete',
					output: [
						{
							content: [{ type: 'output_text', text: '部分结果' }]
						}
					],
					usage: { input_tokens: 42, output_tokens: 3, total_tokens: 45 }
				})
			);
		const response = await invokeSidecar({
			request: request(),
			fetcher,
			apiKey: API_KEY,
			now: () => NOW
		});

		expect(response.status).toBe(502);
		expect(await result(response)).toMatchObject({
			status: 'failed',
			responseId: 'resp-incomplete',
			outputText: '部分结果',
			upstreamStatus: 'incomplete',
			usageStatus: 'recorded',
			error: { code: 'upstream-incomplete' }
		});
	});

	it('reports generation timeouts as possibly billable failures', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const abortError = new Error('aborted');
		abortError.name = 'AbortError';
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({ input_tokens: 42 }))
			.mockRejectedValueOnce(abortError);
		const response = await invokeSidecar({
			request: request(),
			fetcher,
			apiKey: API_KEY,
			now: () => NOW,
			timeoutMs: 100
		});
		const body = await response.text();

		expect(response.status).toBe(504);
		expect(JSON.parse(body)).toMatchObject({
			status: 'failed',
			error: { code: 'request-timeout' }
		});
		expect(body).not.toContain(API_KEY);
	});
});
