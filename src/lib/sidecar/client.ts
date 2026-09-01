import {
	isSidecarInvokeResult,
	type SidecarErrorCode,
	type SidecarInvokeRequest,
	type SidecarInvokeResult
} from './types';

export function sidecarLocalFailure(
	clientRequestId: string,
	code: SidecarErrorCode,
	message: string
): SidecarInvokeResult {
	return {
		status: 'failed',
		clientRequestId,
		responseId: null,
		model: null,
		outputText: null,
		upstreamStatus: null,
		usageStatus: 'unavailable',
		usage: null,
		error: { code, message },
		failedAt: new Date().toISOString()
	};
}

export async function sendSidecarRequest(
	request: SidecarInvokeRequest
): Promise<SidecarInvokeResult> {
	const response = await fetch('/api/sidecar/invoke', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(request)
	});
	const body: unknown = await response.json().catch(() => null);
	if (!isSidecarInvokeResult(body) || body.clientRequestId !== request.clientRequestId) {
		throw new Error(`旁路端点返回了无法识别的响应（HTTP ${response.status}）。`);
	}
	return body;
}
