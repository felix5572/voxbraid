import { describe, expect, it } from 'vitest';
import { prepareSidecarCall, parseSidecarInvokeRequest } from './sidecar-tasks';

function translationPairRequest() {
	return {
		clientRequestId: 'pair-request-1',
		intent: {
			kind: 'translate-pairs',
			trigger: 'periodic',
			targetLanguage: 'zh',
			atoms: [
				{ id: 'run-1:0:15', text: 'First sentence.' },
				{ id: 'run-1:15:32', text: ' Second sentence.' }
			],
			continuity: [{ sourceText: 'Earlier.', translatedText: '此前。' }]
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
		const prepared = prepareSidecarCall(parseSidecarInvokeRequest(translationPairRequest()));

		expect(prepared).toMatchObject({
			kind: 'translate-pairs',
			model: 'gpt-5.6-luna',
			taskVersion: 1,
			inputTokenPreflight: 'skip-bounded',
			maxPreparedInputBytes: 32_000,
			reasoningEffort: 'none',
			structuredOutput: 'translation-pairs',
			translationPairAtomIds: ['run-1:0:15', 'run-1:15:32']
		});
		expect(prepared.inputText).toContain('currentAtoms');
		expect(prepared.inputText).toContain('Earlier.');
		expect(prepared.inputText).not.toContain('realtimeTranslation');
		expect(prepared.instructions).toContain('exactly once');
	});

	it('rejects mismatched or over-sized translation pair input before OpenAI', () => {
		const mismatch = translationPairRequest();
		mismatch.context.runs[0].sourceText = 'different source';
		expect(() => prepareSidecarCall(parseSidecarInvokeRequest(mismatch))).toThrow(
			'atom 文本或目标语言与 Run 事实切片不一致'
		);

		const oversized = translationPairRequest();
		oversized.intent.atoms = [{ id: 'run-1:0:1601', text: 'x'.repeat(1_601) }];
		oversized.context.runs[0].sourceText = 'x'.repeat(1_601);
		expect(() => parseSidecarInvokeRequest(oversized)).toThrow('超过 1600 字符上限');
	});

	it('rejects atom IDs that do not form one exact run-local character range', () => {
		const wrongRun = translationPairRequest();
		wrongRun.intent.atoms[0].id = 'run-other:0:15';
		expect(() => prepareSidecarCall(parseSidecarInvokeRequest(wrongRun))).toThrow(
			'atom ID、字符范围或连续顺序无效'
		);

		const gap = translationPairRequest();
		gap.intent.atoms[1].id = 'run-1:16:33';
		expect(() => prepareSidecarCall(parseSidecarInvokeRequest(gap))).toThrow(
			'atom ID、字符范围或连续顺序无效'
		);
	});

	it('keeps a maximum bounded pair input comfortably below the static byte limit', () => {
		const value = translationPairRequest();
		const source = '原'.repeat(1_600);
		value.intent.atoms = [{ id: 'run-1:0:1600', text: source }];
		value.intent.continuity = [{ sourceText: '前'.repeat(750), translatedText: '译'.repeat(750) }];
		value.context.runs[0].sourceText = source;
		const prepared = prepareSidecarCall(parseSidecarInvokeRequest(value));
		const bytes = new TextEncoder().encode(
			JSON.stringify({ instructions: prepared.instructions, input: prepared.inputText })
		).byteLength;

		expect(bytes).toBeLessThanOrEqual(32_000);
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
