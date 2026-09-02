import { describe, expect, it } from 'vitest';
import type { SidecarIntent, SidecarInvokeRequest } from '../sidecar/types';
import { prepareSidecarCall, parseSidecarInvokeRequest } from './sidecar-tasks';

type RevisionPairIntent = Extract<SidecarIntent, { kind: 'revise-pairs' }>;

function revisionPairRequest(): SidecarInvokeRequest & { intent: RevisionPairIntent } {
	return {
		clientRequestId: 'pair-request-1',
		intent: {
			kind: 'revise-pairs',
			trigger: 'periodic',
			targetLanguage: 'zh',
			tokens: [
				{ i: 1, start: 0, end: 15, t: 'First sentence.' },
				{ i: 2, start: 15, end: 32, t: ' Second sentence.' }
			],
			continuity: [{ revisedSourceText: 'Earlier.', translatedText: '此前。' }],
			previousDraft: [],
			oversizedGroupNumbers: [] as number[],
			previousInvalidLastTokenIndexes: [] as number[]
		},
		context: {
			threadId: 'thread-1',
			scope: 'latest-run',
			capturedAt: '2026-09-02T10:00:00.000Z',
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
	};
}

function request(kind: 'ask' | 'summarize' | 'retranslate') {
	return {
		clientRequestId: 'request-1',
		intent:
			kind === 'ask'
				? {
						kind,
						trigger: 'manual',
						question: 'What happened?',
						history: [],
						outputLanguage: 'zh'
					}
				: kind === 'summarize'
					? { kind, trigger: 'manual', outputLanguage: 'zh' }
					: { kind, trigger: 'manual', targetLanguage: 'zh' },
		context: {
			threadId: 'thread-1',
			scope: 'current-thread',
			capturedAt: '2026-09-01T10:00:00.000Z',
			continuityText: '',
			cleanedTranscript: '整理后的课堂内容。',
			runs: [
				{
					runId: 'run-1',
					sequence: 1,
					targetLanguage: 'zh',
					sourceText: 'The original source.',
					translationText: '已有的实时译文。'
				}
			]
		}
	};
}

describe('sidecar task preparation', () => {
	it('prepares bounded Luna structured output without an input-token preflight', () => {
		const prepared = prepareSidecarCall(parseSidecarInvokeRequest(revisionPairRequest()));

		expect(prepared).toMatchObject({
			kind: 'revise-pairs',
			model: 'gpt-5.6-luna',
			taskVersion: 3,
			inputTokenPreflight: 'skip-bounded',
			maxPreparedInputBytes: 64_000,
			reasoningEffort: 'none',
			structuredOutput: 'revision-pairs'
		});
		expect(prepared.revisionTokens.map((token) => token.i)).toEqual([1, 2]);
		expect(prepared.inputText).toContain('currentTokens');
		expect(prepared.inputText).toContain('"i": 1');
		expect(prepared.inputText).toContain('Earlier.');
		expect(prepared.inputText).not.toContain('realtimeTranslation');
		expect(prepared.instructions).toContain('lastTokenIndex');
		expect(prepared.instructions).toContain('never restarts');
		expect(prepared.instructions).toContain('Protocol example');
	});

	it('shows the model only request-local token coordinates for previous drafts', () => {
		const value = revisionPairRequest();
		value.intent.previousDraft = [
			{
				sourceStart: 0,
				sourceEnd: 15,
				rawText: 'First sentence.',
				revisedSourceText: 'First sentence.',
				translatedText: '第一句。',
				paragraphBreakBefore: false
			}
		];
		const prepared = prepareSidecarCall(parseSidecarInvokeRequest(value));

		expect(prepared.inputText).toContain('"firstTokenIndex": 1');
		expect(prepared.inputText).toContain('"lastTokenIndex": 1');
		expect(prepared.inputText).not.toContain('"sourceStart"');
		expect(prepared.inputText).not.toContain('"sourceEnd"');
		expect(prepared.inputText).not.toContain('"rawText"');
	});

	it('turns a rejected boundary sequence into a server-owned correction', () => {
		const value = revisionPairRequest();
		value.intent.previousInvalidLastTokenIndexes = [46, 86, 61, 86];
		const prepared = prepareSidecarCall(parseSidecarInvokeRequest(value));

		expect(prepared.inputText).toMatch(
			/"previousInvalidLastTokenIndexes": \[\s+46,\s+86,\s+61,\s+86\s+\]/u
		);
		expect(prepared.inputText).toContain('strictly increasing cumulative lastTokenIndex');
		expect(prepared.inputText).toContain('"finalLastTokenIndex": 2');
	});

	it('rejects mismatched or over-sized revision pair input before OpenAI', () => {
		const mismatch = revisionPairRequest();
		mismatch.context.runs[0].sourceText = 'different source';
		expect(() => prepareSidecarCall(parseSidecarInvokeRequest(mismatch))).toThrow(
			'token 文本或目标语言与 Run 事实切片不一致'
		);

		const oversized = revisionPairRequest();
		oversized.intent.tokens = [{ i: 1, start: 0, end: 1_601, t: 'x'.repeat(1_601) }];
		oversized.context.runs[0].sourceText = 'x'.repeat(1_601);
		expect(() => parseSidecarInvokeRequest(oversized)).toThrow('超过 1600 字符硬上限');
	});

	it('rejects token indexes and ranges that are not exact and continuous', () => {
		const gap = revisionPairRequest();
		gap.intent.tokens[1].start = 16;
		expect(() => parseSidecarInvokeRequest(gap)).toThrow('token 编号、字符范围或连续顺序无效');
	});

	it('keeps a maximum bounded pair input comfortably below the static byte limit', () => {
		const value = revisionPairRequest();
		const source = '原'.repeat(1_600);
		value.intent.tokens = [{ i: 1, start: 0, end: 1_600, t: source }];
		value.intent.continuity = [
			{
				revisedSourceText: '修'.repeat(750),
				translatedText: '译'.repeat(750)
			}
		];
		value.context.runs[0].sourceText = source;
		const prepared = prepareSidecarCall(parseSidecarInvokeRequest(value));
		const bytes = new TextEncoder().encode(
			JSON.stringify({ instructions: prepared.instructions, input: prepared.inputText })
		).byteLength;

		expect(bytes).toBeLessThanOrEqual(64_000);
	});

	it('adds a server-owned correction for an oversized-group retry', () => {
		const value = revisionPairRequest();
		value.intent.oversizedGroupNumbers = [2];
		const prepared = prepareSidecarCall(parseSidecarInvokeRequest(value));

		expect(prepared.inputText).toContain('groups 2 exceeded');
	});

	it('keeps both transcript channels for summaries and questions', () => {
		const prepared = prepareSidecarCall(parseSidecarInvokeRequest(request('summarize')));

		expect(prepared.model).toBe('gpt-5.6-terra');
		expect(prepared.taskVersion).toBe(5);
		expect(prepared.maxOutputTokens).toBe(64_000);
		expect(prepared.instructions).toContain('source transcript as primary evidence');
		expect(prepared.instructions).toContain('every substantive explanation');
		expect(prepared.instructions).toContain('information density close');
		expect(prepared.instructions).toContain('speaker change is reasonably inferable');
		expect(prepared.instructions).toContain('[暂未捕获]');
		expect(prepared.instructions).toContain('[板书内容暂未捕获]');
		expect(prepared.instructions).toContain('Preserve the source-language wording');
		expect(prepared.instructions).toContain('[术语待确认：source wording]');
		expect(prepared.instructions).toContain('never repeat or rewrite it');
		expect(prepared.inputText).toContain('The original source.');
		expect(prepared.inputText).toContain('已有的实时译文。');
		expect(prepared.inputText).not.toContain('cleanedTranscriptProjection');
	});

	it('passes previous cleaned text as continuity without treating it as output scope', () => {
		const value = request('summarize');
		value.context.scope = 'latest-run';
		value.context.continuityText = '上一块清稿的结尾。';
		const prepared = prepareSidecarCall(parseSidecarInvokeRequest(value));

		expect(prepared.inputText).toContain('continuityTranscript');
		expect(prepared.inputText).toContain('上一块清稿的结尾。');
	});

	it('uses only source text for retranslation', () => {
		const prepared = prepareSidecarCall(parseSidecarInvokeRequest(request('retranslate')));

		expect(prepared.inputText).toContain('The original source.');
		expect(prepared.inputText).not.toContain('已有的实时译文。');
		expect(prepared.inputText).toContain('"targetLanguage": "zh"');
	});

	it('uses Sol for direct human questions', () => {
		const value = request('ask');
		if (value.intent.kind !== 'ask') throw new Error('Expected ask intent.');
		(value.intent.history as Array<{ question: string; answer: string }>).push({
			question: 'Who introduced the term?',
			answer: 'The lecturer introduced it.'
		});
		const prepared = prepareSidecarCall(parseSidecarInvokeRequest(value));

		expect(prepared.model).toBe('gpt-5.6-sol');
		expect(prepared.instructions).toContain('prior conversation turns');
		expect(prepared.inputText).toContain('Who introduced the term?');
		expect(prepared.inputText).toContain('The lecturer introduced it.');
		expect(prepared.inputText).toContain('What happened?');
		expect(prepared.inputText).toContain('cleanedTranscriptProjection');
		expect(prepared.inputText).toContain('整理后的课堂内容。');
		expect(prepared.instructions).toContain('derived context');
	});

	it('accepts old single-turn questions without a history field', () => {
		const value = request('ask');
		if (value.intent.kind !== 'ask') throw new Error('Expected ask intent.');
		delete (value.intent as { history?: unknown }).history;

		const parsed = parseSidecarInvokeRequest(value);
		expect(parsed.intent).toMatchObject({ kind: 'ask', history: [] });
	});

	it('accepts old requests without cleaned transcript context', () => {
		const value = request('ask');
		delete (value.context as { cleanedTranscript?: unknown }).cleanedTranscript;

		const parsed = parseSidecarInvokeRequest(value);
		expect(parsed.context.cleanedTranscript).toBe('');
	});

	it('rejects malformed cleaned transcript context', () => {
		const value = request('ask');
		(value.context as { cleanedTranscript?: unknown }).cleanedTranscript = 42;

		expect(() => parseSidecarInvokeRequest(value)).toThrow('课堂清稿上下文格式无效');
	});

	it('rejects malformed conversation history', () => {
		const value = request('ask');
		if (value.intent.kind !== 'ask') throw new Error('Expected ask intent.');
		(value.intent.history as unknown[]) = [{ question: 'Follow up', answer: '' }];

		expect(() => parseSidecarInvokeRequest(value)).toThrow('对话历史格式无效');
	});

	it('accepts periodic summaries but keeps questions and retranslations manual', () => {
		const value = request('summarize');
		value.intent.trigger = 'periodic';
		expect(parseSidecarInvokeRequest(value).intent).toMatchObject({
			kind: 'summarize',
			trigger: 'periodic'
		});

		const question = request('ask');
		question.intent.trigger = 'periodic';
		expect(() => parseSidecarInvokeRequest(question)).toThrow('手动触发');

		const retranslation = request('retranslate');
		retranslation.intent.trigger = 'periodic';
		expect(() => parseSidecarInvokeRequest(retranslation)).toThrow('手动触发');
	});

	it('rejects non-increasing run sequences', () => {
		const value = request('ask');
		value.context.runs.push({ ...value.context.runs[0], runId: 'run-2' });

		expect(() => parseSidecarInvokeRequest(value)).toThrow('顺序无效');
	});
});
