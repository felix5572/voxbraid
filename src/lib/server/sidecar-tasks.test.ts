import { describe, expect, it } from 'vitest';
import { prepareSidecarCall, parseSidecarInvokeRequest } from './sidecar-tasks';

function request(kind: 'ask' | 'summarize' | 'retranslate') {
	return {
		clientRequestId: 'request-1',
		intent:
			kind === 'ask'
				? { kind, trigger: 'manual', question: 'What happened?', outputLanguage: 'zh' }
				: kind === 'summarize'
					? { kind, trigger: 'manual', outputLanguage: 'zh' }
					: { kind, trigger: 'manual', targetLanguage: 'zh' },
		context: {
			threadId: 'thread-1',
			scope: 'current-thread',
			capturedAt: '2026-09-01T10:00:00.000Z',
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

		expect(prepared.model).toBe('gpt-5.6-luna');
		expect(prepared.inputText).toContain('The original source.');
		expect(prepared.inputText).toContain('已有的实时译文。');
	});

	it('uses only source text for retranslation', () => {
		const prepared = prepareSidecarCall(parseSidecarInvokeRequest(request('retranslate')));

		expect(prepared.inputText).toContain('The original source.');
		expect(prepared.inputText).not.toContain('已有的实时译文。');
		expect(prepared.inputText).toContain('"targetLanguage": "zh"');
	});

	it('uses Sol for direct human questions', () => {
		const prepared = prepareSidecarCall(parseSidecarInvokeRequest(request('ask')));

		expect(prepared.model).toBe('gpt-5.6-sol');
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
