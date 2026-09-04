import type { SidecarInvocationView } from './types';

export interface StoredConversationInvocation extends SidecarInvocationView {
	threadId: string;
	sequence: number;
	updatedAt: string;
}

export function compareConversationInvocations(
	left: StoredConversationInvocation,
	right: StoredConversationInvocation
): number {
	return (
		left.sequence - right.sequence ||
		left.context.capturedAt.localeCompare(right.context.capturedAt)
	);
}

export function validateConversationInvocation(record: StoredConversationInvocation): void {
	if (
		!record.id ||
		!record.threadId ||
		record.threadId !== record.context.threadId ||
		!Number.isSafeInteger(record.sequence) ||
		record.sequence <= 0 ||
		record.intent.kind !== 'ask' ||
		record.intent.trigger !== 'manual' ||
		!record.intent.question.trim() ||
		!record.context.threadId ||
		!Number.isFinite(Date.parse(record.context.capturedAt)) ||
		!Number.isFinite(Date.parse(record.updatedAt)) ||
		(record.state === 'requesting' && record.result !== null) ||
		(record.state === 'completed' && record.result?.status !== 'completed') ||
		(record.state === 'failed' && record.result?.status !== 'failed') ||
		(record.result !== null && record.result.clientRequestId !== record.id)
	) {
		throw new Error(`Conversation invocation ${record.id || '(missing id)'} has an invalid shape.`);
	}
}

export function abandonConversationInvocation(
	record: StoredConversationInvocation,
	failedAt: string
): StoredConversationInvocation {
	if (record.state !== 'requesting') return record;
	return {
		...record,
		state: 'failed',
		result: {
			status: 'failed',
			clientRequestId: record.id,
			responseId: null,
			model: null,
			outputText: null,
			upstreamStatus: null,
			usageStatus: 'unavailable',
			usage: null,
			error: {
				code: 'request-outcome-unknown',
				message:
					`页面在自由对话请求 ${record.id} 返回终态前终止或重新加载。` +
					'浏览器没有保存到可确认的结果；服务端可能已经处理该请求并产生费用。系统不会自动重试。'
			},
			failedAt
		},
		updatedAt: failedAt
	};
}
