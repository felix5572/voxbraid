import { errorDetails } from '../error-details';
import { emitOperationalLog } from '../operational-log';
import {
	isSidecarInvokeResult,
	type SidecarErrorCode,
	type SidecarFailureDiagnostic,
	type SidecarInvokeRequest,
	type SidecarInvokeResult
} from './types';

export { errorDetails as sidecarErrorDetails } from '../error-details';

export function sidecarLocalFailure(
	clientRequestId: string,
	code: SidecarErrorCode,
	message: string,
	diagnostic: SidecarFailureDiagnostic | null = null
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
		retryDisposition: 'manual-only',
		diagnostic,
		error: { code, message },
		failedAt: new Date().toISOString()
	};
}

function responseExcerpt(body: string): string {
	if (!body) return '[空响应体]';
	const limit = 4_096;
	return body.length > limit
		? `[响应体共 ${body.length} 字符；以下为前 ${limit} 字符]\n${body.slice(0, limit)}\n[响应已截断]`
		: `[响应体共 ${body.length} 字符]\n${body}`;
}

function browserDiagnostic(
	startedAt: number,
	requestBytes: number | null,
	httpStatus: number | null
): SidecarFailureDiagnostic {
	return {
		durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
		visibilityState: typeof document === 'undefined' ? null : document.visibilityState,
		online: typeof navigator === 'undefined' ? null : navigator.onLine,
		requestBytes,
		httpStatus
	};
}

function browserRequestContext(diagnostic: SidecarFailureDiagnostic): string {
	const values = [
		`request: POST /api/sidecar/invoke`,
		`elapsedMs: ${diagnostic.durationMs ?? 'unknown'}`,
		`requestBytes: ${diagnostic.requestBytes ?? 'unknown'}`,
		`httpStatus: ${diagnostic.httpStatus ?? 'none'}`
	];
	if (typeof navigator !== 'undefined') {
		values.push(`navigator.onLine: ${diagnostic.online}`, `userAgent: ${navigator.userAgent}`);
	}
	if (typeof document !== 'undefined') {
		values.push(`visibilityState: ${diagnostic.visibilityState}`);
	}
	if (typeof location !== 'undefined') values.push(`page: ${location.href}`);
	return values.join('\n');
}

function responseDetails(response: Response, rawBody: string): string {
	const headers = [...response.headers.entries()]
		.map(([name, value]) => `${name}: ${value}`)
		.join('\n');
	return [
		`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`,
		`url: ${response.url || '[浏览器未提供]'}`,
		`redirected: ${response.redirected}`,
		`type: ${response.type}`,
		`headers:\n${headers || '[无可见响应头]'}`,
		responseExcerpt(rawBody)
	].join('\n');
}

export async function sendSidecarRequest(
	request: SidecarInvokeRequest
): Promise<SidecarInvokeResult> {
	const startedAt = performance.now();
	let serializedRequest: string;
	try {
		serializedRequest = JSON.stringify(request);
	} catch (error) {
		return sidecarLocalFailure(
			request.clientRequestId,
			'invalid-response',
			`浏览器无法序列化旁路请求。\n原始错误：\n${errorDetails(error)}`,
			browserDiagnostic(startedAt, null, null)
		);
	}
	const requestBytes = new TextEncoder().encode(serializedRequest).byteLength;
	let response: Response;
	try {
		response = await fetch('/api/sidecar/invoke', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: serializedRequest
		});
	} catch (error) {
		const diagnostic = browserDiagnostic(startedAt, requestBytes, null);
		console.error(
			'[sidecar-client] browser request failed before receiving an HTTP response',
			error
		);
		return sidecarLocalFailure(
			request.clientRequestId,
			'browser-network-failed',
			`浏览器没有收到 VoxBraid 旁路端点的 HTTP 响应。\n${browserRequestContext(diagnostic)}\n原始错误：\n${errorDetails(error)}`,
			diagnostic
		);
	}

	let rawBody: string;
	try {
		rawBody = await response.text();
	} catch (error) {
		const diagnostic = browserDiagnostic(startedAt, requestBytes, response.status);
		console.error('[sidecar-client] browser failed while reading the HTTP response body', error);
		return sidecarLocalFailure(
			request.clientRequestId,
			'browser-network-failed',
			`浏览器收到 HTTP ${response.status}，但读取 VoxBraid 响应体失败。\n${browserRequestContext(diagnostic)}\n原始错误：\n${errorDetails(error)}`,
			diagnostic
		);
	}

	let body: unknown = null;
	try {
		body = JSON.parse(rawBody);
	} catch {
		// The diagnostic below intentionally retains a bounded excerpt of proxy or server error pages.
	}
	if (!isSidecarInvokeResult(body) || body.clientRequestId !== request.clientRequestId) {
		const diagnostic = browserDiagnostic(startedAt, requestBytes, response.status);
		console.error('[sidecar-client] unrecognized HTTP response', {
			status: response.status,
			statusText: response.statusText,
			body: responseExcerpt(rawBody)
		});
		return sidecarLocalFailure(
			request.clientRequestId,
			'invalid-response',
			`VoxBraid 旁路端点返回了无法识别的响应。\n${browserRequestContext(diagnostic)}\n${responseDetails(response, rawBody)}`,
			diagnostic
		);
	}
	for (const warning of body.warnings ?? []) {
		emitOperationalLog({
			severity: 'warning',
			source: 'server',
			code: warning.code,
			summary: warning.message,
			details: warning.details ?? null,
			threadId: request.context.threadId,
			runId: request.context.runs[0]?.runId ?? null,
			requestId: request.clientRequestId
		});
	}
	if (body.status === 'failed') {
		return {
			...body,
			diagnostic: browserDiagnostic(startedAt, requestBytes, response.status)
		};
	}
	return body;
}
