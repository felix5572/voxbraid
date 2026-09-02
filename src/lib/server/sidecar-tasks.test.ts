import { describe, expect, it } from 'vitest';
import { prepareSidecarCall, parseSidecarInvokeRequest } from './sidecar-tasks';

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
