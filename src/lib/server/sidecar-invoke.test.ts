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
	it('generates and validates revision pairs with one bounded Responses call', async () => {
		const fetcher = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
			async () =>
				jsonResponse({
					id: 'resp-pair-1',
					model: 'gpt-5.6-luna',
					status: 'completed',
					output_text: JSON.stringify({
						groups: [
							{
								firstAtom: 1,
								lastAtom: 2,
								revisedSourceText: 'First sentence. Second sentence.',
								translatedText: '第一句和第二句。',
								paragraphBreakBefore: false
							}
						]
					}),
					usage: { input_tokens: 80, output_tokens: 20, total_tokens: 100 }
				})
		);
		const response = await invokeSidecar({
			request: rawRequest({
				clientRequestId: 'pair-request-1',
				intent: {
					kind: 'revise-pairs',
					trigger: 'periodic',
					targetLanguage: 'zh',
					atoms: [
						{ i: 1, start: 0, end: 15, t: 'First sentence.', boundary: 'sentence' },
						{ i: 2, start: 15, end: 32, t: ' Second sentence.', boundary: 'sentence' }
					],
					continuity: [],
					previousDraft: [],
					oversizedGroupNumbers: [],
					previousInvalidAtomRanges: []
				},
				context: {
					threadId: 'thread-1',
					scope: 'latest-run',
					capturedAt: NOW,
					continuityText: '',
					cleanedTranscript: '',
					runs: [
						{
							runId: 'run-1',
							sequence: 1,
							targetLanguage: 'zh',
							sourceText: 'First sentence. Second sentence.',
							translationText: ''
						}
					]
				}
			}),
			fetcher,
			apiKey: API_KEY,
			now: () => NOW
		});

		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(String(fetcher.mock.calls[0]?.[0])).toContain('/v1/responses');
		const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
		expect(body).toMatchObject({
			model: 'gpt-5.6-luna',
			reasoning: { effort: 'none' },
			text: { format: { type: 'json_schema', name: 'revision_pair_batch', strict: true } }
		});
		expect(await result(response)).toMatchObject({
			status: 'completed',
			outputText: JSON.stringify({
				groups: [
					{
						firstAtom: 1,
						lastAtom: 2,
						revisedSourceText: 'First sentence. Second sentence.',
						translatedText: '第一句和第二句。',
						paragraphBreakBefore: false
					}
				]
			})
		});
	});

	it('returns an oversized revision group for the browser soft-limit policy to handle', async () => {
		const source = 'x'.repeat(600);
		const fetcher = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
			async () =>
				jsonResponse({
					id: 'resp-pair-oversized',
					model: 'gpt-5.6-luna',
					status: 'completed',
					output_text: JSON.stringify({
						groups: [
							{
								firstAtom: 1,
								lastAtom: 3,
								revisedSourceText: source,
								translatedText: '超长组',
								paragraphBreakBefore: false
							}
						]
					}),
					usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 }
				})
		);
		const response = await invokeSidecar({
			request: rawRequest({
				clientRequestId: 'pair-request-oversized',
				intent: {
					kind: 'revise-pairs',
					trigger: 'periodic',
					targetLanguage: 'zh',
					atoms: [
						{ i: 1, start: 0, end: 240, t: source.slice(0, 240), boundary: 'forced' },
						{ i: 2, start: 240, end: 480, t: source.slice(240, 480), boundary: 'forced' },
						{ i: 3, start: 480, end: 600, t: source.slice(480), boundary: 'open' }
					],
					continuity: [],
					previousDraft: [],
					oversizedGroupNumbers: [],
					previousInvalidAtomRanges: []
				},
				context: {
					threadId: 'thread-1',
					scope: 'latest-run',
					capturedAt: NOW,
					continuityText: '',
					cleanedTranscript: '',
					runs: [
						{
							runId: 'run-1',
							sequence: 1,
							targetLanguage: 'zh',
							sourceText: source,
							translationText: ''
						}
					]
				}
			}),
			fetcher,
			apiKey: API_KEY,
			now: () => NOW
		});

		expect(response.status).toBe(200);
		expect(await result(response)).toMatchObject({ status: 'completed' });
	});

	it('rejects completed revision pair output with invalid atom coverage', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const fetcher = vi.fn(async () =>
			jsonResponse({
				id: 'resp-pair-invalid',
				model: 'gpt-5.6-luna',
				status: 'completed',
				output_text: JSON.stringify({
					groups: [
						{
							firstAtom: 2,
							lastAtom: 2,
							revisedSourceText: 'First sentence.',
							translatedText: '错误覆盖。',
							paragraphBreakBefore: false
						}
					]
				})
			})
		);
		const body = {
			clientRequestId: 'pair-request-2',
			intent: {
				kind: 'revise-pairs',
				trigger: 'periodic',
				targetLanguage: 'zh',
				atoms: [{ i: 1, start: 0, end: 15, t: 'First sentence.', boundary: 'sentence' }],
				continuity: [],
				previousDraft: [],
				oversizedGroupNumbers: [],
				previousInvalidAtomRanges: []
			},
			context: {
				threadId: 'thread-1',
				scope: 'latest-run',
				capturedAt: NOW,
				runs: [
					{
						runId: 'run-1',
						sequence: 1,
						targetLanguage: 'zh',
						sourceText: 'First sentence.',
						translationText: ''
					}
				]
			}
		};
		const response = await invokeSidecar({
			request: rawRequest(body),
			fetcher,
			apiKey: API_KEY,
			now: () => NOW
		});
		const failure = await result(response);

		expect(response.status).toBe(502);
		expect(failure).toMatchObject({
			status: 'failed',
			error: { code: 'invalid-revision-boundary' }
		});
		if (failure.status !== 'failed') throw new Error('Expected failed pair response.');
		expect(failure.error.message).toContain('原子覆盖校验');
		expect(failure.error.message).toContain('firstAtom');
	});

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
		const fetcher = vi.fn(async () =>
			jsonResponse(
				{
					error: {
						message: 'temporary failure',
						type: 'server_error',
						code: 'temporary',
						param: 'input'
					}
				},
				503,
				'count-request-1'
			)
		);
		const response = await invokeSidecar({
			request: request(),
			fetcher,
			apiKey: API_KEY,
			now: () => NOW
		});

		expect(response.status).toBe(502);
		expect(fetcher).toHaveBeenCalledTimes(1);
		const failure = await result(response);
		expect(failure).toMatchObject({
			status: 'failed',
			error: { code: 'budget-check-failed' }
		});
		if (failure.status === 'failed') {
			expect(failure.error.message).toContain('type=server_error');
			expect(failure.error.message).toContain('code=temporary');
			expect(failure.error.message).toContain('param=input');
			expect(failure.error.message).toContain('count-request-1');
			expect(failure.error.message).toContain('"message":"temporary failure"');
		}
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

	it('preserves structured and raw OpenAI generation errors', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({ input_tokens: 42 }))
			.mockResolvedValueOnce(
				jsonResponse(
					{
						error: {
							message: 'rate limit reached',
							type: 'rate_limit_error',
							code: 'rate_limit_exceeded',
							param: 'model'
						}
					},
					429,
					'generation-request-1'
				)
			);

		const response = await invokeSidecar({
			request: request(),
			fetcher,
			apiKey: API_KEY,
			now: () => NOW
		});
		const failure = await result(response);

		expect(response.status).toBe(502);
		expect(failure).toMatchObject({ status: 'failed', error: { code: 'upstream-failed' } });
		if (failure.status === 'failed') {
			expect(failure.error.message).toContain('type=rate_limit_error');
			expect(failure.error.message).toContain('code=rate_limit_exceeded');
			expect(failure.error.message).toContain('param=model');
			expect(failure.error.message).toContain('generation-request-1');
			expect(failure.error.message).toContain('"message":"rate limit reached"');
		}
	});

	it('preserves a non-JSON upstream response body', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({ input_tokens: 42 }))
			.mockResolvedValueOnce(
				new Response('<html><h1>upstream unavailable</h1></html>', {
					status: 502,
					statusText: 'Bad Gateway',
					headers: { 'Content-Type': 'text/html', 'x-request-id': 'proxy-request-1' }
				})
			);

		const response = await invokeSidecar({
			request: request(),
			fetcher,
			apiKey: API_KEY,
			now: () => NOW
		});
		const failure = await result(response);

		expect(response.status).toBe(502);
		if (failure.status !== 'failed') throw new Error('Expected sidecar failure.');
		expect(failure.error.message).toContain('proxy-request-1');
		expect(failure.error.message).toContain('<html><h1>upstream unavailable</h1></html>');
		expect(failure.error.message).not.toContain('[上游响应共 4 字符]\nnull');
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
					incomplete_details: { reason: 'max_output_tokens' },
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
		const failure = await result(response);
		expect(failure).toMatchObject({
			status: 'failed',
			responseId: 'resp-incomplete',
			outputText: '部分结果',
			upstreamStatus: 'incomplete',
			usageStatus: 'recorded',
			error: { code: 'upstream-incomplete' }
		});
		if (failure.status === 'failed') {
			expect(failure.error.message).toContain('incomplete_details.reason=max_output_tokens');
		}
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
