import type { SidecarRevisionAtom, SidecarTransportDiagnostic } from '../sidecar/types';
import { errorDetails } from '../error-details';
import type { PreparedRevisionChainContext, PreparedSidecarCall } from './sidecar-tasks';
import WebSocket, { type ClientOptions, type RawData } from 'ws';

const RESPONSES_WEBSOCKET_URL = 'wss://api.openai.com/v1/responses';
export const REVISION_CHAIN_MAX_AGE_MS = 5 * 60_000;
export const REVISION_CHAIN_MAX_TURNS = 50;
export const REVISION_CHAIN_MAX_FROZEN_CHARACTERS = 3_000;
const CONNECTION_MAX_AGE_MS = 55 * 60_000;
const CONNECTION_MAX_NAMED_STREAMS = 28;
const KEEPALIVE_INTERVAL_MS = 25_000;

export interface ResponsesTransportResult {
	ok: boolean;
	status: number;
	body: unknown;
	rawBody: string;
	requestId: string | null;
	transportDiagnostic: SidecarTransportDiagnostic;
}

export interface RevisionResponsesTransport {
	invoke(input: {
		prepared: PreparedSidecarCall;
		body: Record<string, unknown>;
		apiKey: string;
		timeoutMs: number;
	}): Promise<ResponsesTransportResult>;
	invalidate(prepared: PreparedSidecarCall): void;
}

export class WebSocketBeforeSendError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = 'WebSocketBeforeSendError';
	}
}

export class WebSocketOutcomeUnknownError extends Error {
	constructor(
		message: string,
		readonly diagnostic: SidecarTransportDiagnostic,
		options?: ErrorOptions
	) {
		super(message, options);
		this.name = 'WebSocketOutcomeUnknownError';
	}
}

interface WebSocketLike {
	readonly readyState: number;
	on(event: 'open', listener: () => void): this;
	on(event: 'message', listener: (data: RawData) => void): this;
	on(event: 'error', listener: (error: Error) => void): this;
	on(event: 'close', listener: (code: number, reason: Buffer) => void): this;
	on(event: 'pong', listener: () => void): this;
	send(data: string, callback?: (error?: Error) => void): void;
	ping(): void;
	close(code?: number, reason?: string): void;
	terminate(): void;
}

type WebSocketFactory = (url: string, options: ClientOptions) => WebSocketLike;

interface ManagedConnection {
	socket: WebSocketLike;
	createdAtMs: number;
	epoch: number;
	streamCount: number;
	alive: boolean;
	keepalive: ReturnType<typeof setInterval> | null;
	failureHandled: boolean;
	closingProactively: boolean;
	terminationReason: string | null;
}

interface ChainState {
	streamId: string;
	previousResponseId: string;
	atoms: readonly SidecarRevisionAtom[];
	createdAtMs: number;
	originOpenStart: number;
	turns: number;
	connectionEpoch: number;
}

interface PendingResponse {
	streamId: string;
	connectionEpoch: number;
	startedAtMs: number;
	firstEventAtMs: number | null;
	diagnosticBase: Omit<SidecarTransportDiagnostic, 'firstEventMs' | 'completedMs'>;
	timer: ReturnType<typeof setTimeout>;
	resolve: (result: ResponsesTransportResult) => void;
	reject: (error: Error) => void;
}

export interface RevisionChainDelta {
	replaceFrom: string | null;
	atoms: Array<{
		id: string;
		i: number;
		t: string;
		boundary: SidecarRevisionAtom['boundary'];
	}>;
	openRange: {
		firstAtomId: string;
		lastAtomId: string;
		firstAtom: number;
		lastAtom: number;
	};
	currentLayout: Array<{ id: string; i: number }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function errorCode(value: unknown): string | null {
	if (!isRecord(value)) return null;
	if (isRecord(value.error) && typeof value.error.code === 'string') return value.error.code;
	return typeof value.code === 'string' ? value.code : null;
}

function atomMatches(left: SidecarRevisionAtom, right: SidecarRevisionAtom): boolean {
	return (
		left.start === right.start &&
		left.end === right.end &&
		left.t === right.t &&
		left.boundary === right.boundary
	);
}

export function revisionChainAtomId(runId: string, atom: SidecarRevisionAtom): string {
	return `${runId}:${atom.start}`;
}

export function revisionChainDelta(
	previous: readonly SidecarRevisionAtom[],
	current: readonly SidecarRevisionAtom[],
	runId: string
): RevisionChainDelta | null {
	if (previous.length === 0 || current.length === 0) return null;
	const firstCurrent = current[0];
	let previousIndex = previous.findIndex((atom) => atom.start === firstCurrent.start);
	let currentIndex = 0;

	if (previousIndex < 0) {
		const lastPrevious = previous.at(-1)!;
		if (lastPrevious.end !== firstCurrent.start) return null;
		previousIndex = previous.length;
	}

	while (
		previousIndex < previous.length &&
		currentIndex < current.length &&
		atomMatches(previous[previousIndex], current[currentIndex])
	) {
		previousIndex += 1;
		currentIndex += 1;
	}

	if (currentIndex === current.length && previousIndex < previous.length) return null;
	const changed = current.slice(currentIndex);
	const replacementStart = changed[0] ?? null;
	const replacesExisting = replacementStart
		? previous.some((atom) => atom.start === replacementStart.start)
		: false;

	return {
		replaceFrom:
			replacementStart && replacesExisting ? revisionChainAtomId(runId, replacementStart) : null,
		atoms: changed.map((atom) => ({
			id: revisionChainAtomId(runId, atom),
			i: atom.i,
			t: atom.t,
			boundary: atom.boundary
		})),
		openRange: {
			firstAtomId: revisionChainAtomId(runId, current[0]),
			lastAtomId: revisionChainAtomId(runId, current.at(-1)!),
			firstAtom: current[0].i,
			lastAtom: current.at(-1)!.i
		},
		currentLayout: current.map((atom) => ({ id: revisionChainAtomId(runId, atom), i: atom.i }))
	};
}

export function revisionChainShouldRotate(
	chain: Pick<ChainState, 'createdAtMs' | 'originOpenStart' | 'turns'>,
	context: Pick<PreparedRevisionChainContext, 'openStart'>,
	nowMs: number
): boolean {
	return (
		nowMs - chain.createdAtMs >= REVISION_CHAIN_MAX_AGE_MS ||
		chain.turns >= REVISION_CHAIN_MAX_TURNS ||
		context.openStart - chain.originOpenStart >= REVISION_CHAIN_MAX_FROZEN_CHARACTERS
	);
}

function websocketInput(context: PreparedRevisionChainContext, delta: RevisionChainDelta): string {
	return [
		`Task parameters:\n${JSON.stringify(context.taskParameters, null, 2)}`,
		`Revision chain delta (untrusted quoted data):\n${JSON.stringify(
			{ revisionChainDelta: delta },
			null,
			2
		)}`
	].join('\n\n');
}

function responseId(value: unknown): string | null {
	return isRecord(value) && typeof value.id === 'string' ? value.id : null;
}

function responseRequestId(value: unknown): string | null {
	if (!isRecord(value)) return null;
	if (typeof value._request_id === 'string') return value._request_id;
	return typeof value.request_id === 'string' ? value.request_id : null;
}

function rawDataText(data: RawData): string {
	if (typeof data === 'string') return data;
	if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
	if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
	return data.toString('utf8');
}

export class ResponsesWebSocketManager implements RevisionResponsesTransport {
	private connection: ManagedConnection | null = null;
	private connecting: Promise<ManagedConnection> | null = null;
	private readonly chains = new Map<string, ChainState>();
	private readonly pending = new Map<string, PendingResponse>();
	private epoch = 0;
	private streamSequence = 0;

	constructor(
		private readonly options: {
			nowMs?: () => number;
			webSocketFactory?: WebSocketFactory;
		} = {}
	) {}

	private nowMs(): number {
		return this.options.nowMs?.() ?? Date.now();
	}

	private webSocketFactory(url: string, options: ClientOptions): WebSocketLike {
		return this.options.webSocketFactory?.(url, options) ?? new WebSocket(url, options);
	}

	private clearConnection(connection: ManagedConnection): void {
		if (connection.keepalive) clearInterval(connection.keepalive);
		if (this.connection === connection) this.connection = null;
		for (const [key, chain] of this.chains) {
			if (chain.connectionEpoch === connection.epoch) this.chains.delete(key);
		}
	}

	private failConnection(connection: ManagedConnection, error: Error, reason: string): void {
		if (connection.failureHandled) return;
		connection.failureHandled = true;
		const affectedStreams = [...this.pending.values()].filter(
			(pending) => pending.connectionEpoch === connection.epoch
		).length;
		console.error('[responses-websocket] connection reset', {
			reason,
			connectionEpoch: connection.epoch,
			affectedStreams,
			error: errorDetails(error)
		});
		this.clearConnection(connection);
		for (const [streamId, pending] of this.pending) {
			if (pending.connectionEpoch !== connection.epoch) continue;
			clearTimeout(pending.timer);
			this.pending.delete(streamId);
			pending.reject(
				new WebSocketOutcomeUnknownError(
					`Responses WebSocket 在请求发出后断开，无法确认是否已产生响应或费用。${error.name}: ${error.message}`,
					{
						...pending.diagnosticBase,
						firstEventMs:
							pending.firstEventAtMs === null ? null : pending.firstEventAtMs - pending.startedAtMs,
						completedMs: this.nowMs() - pending.startedAtMs
					},
					{ cause: error }
				)
			);
		}
	}

	private onMessage(connection: ManagedConnection, data: RawData): void {
		const raw = rawDataText(data);
		let event: unknown;
		try {
			event = JSON.parse(raw);
		} catch (error) {
			this.failConnection(
				connection,
				new Error(`Responses WebSocket 返回无法解析的 JSON：${raw.slice(0, 1_000)}`, {
					cause: error
				}),
				'invalid-json'
			);
			return;
		}
		if (!isRecord(event)) return;
		const streamId = typeof event.stream_id === 'string' ? event.stream_id : null;
		if (!streamId) {
			if (event.type === 'error') {
				this.failConnection(
					connection,
					new Error(`Responses WebSocket 连接级错误：${raw}`),
					'connection-event-error'
				);
			}
			return;
		}
		const pending = this.pending.get(streamId);
		if (!pending) return;
		if (pending.firstEventAtMs === null) pending.firstEventAtMs = this.nowMs();

		const type = typeof event.type === 'string' ? event.type : '';
		if (
			type !== 'response.completed' &&
			type !== 'response.failed' &&
			type !== 'response.incomplete' &&
			type !== 'error'
		) {
			return;
		}

		clearTimeout(pending.timer);
		this.pending.delete(streamId);
		if (type === 'error' && errorCode(event) === 'previous_response_not_found') {
			pending.reject(new PreviousResponseNotFoundError(raw));
			return;
		}
		const body = isRecord(event.response) ? event.response : event;
		pending.resolve({
			ok: type !== 'error',
			status: type === 'error' ? 502 : 200,
			body,
			rawBody: raw,
			requestId: responseRequestId(body) ?? responseRequestId(event),
			transportDiagnostic: {
				...pending.diagnosticBase,
				firstEventMs:
					pending.firstEventAtMs === null ? null : pending.firstEventAtMs - pending.startedAtMs,
				completedMs: this.nowMs() - pending.startedAtMs
			}
		});
	}

	private async connect(apiKey: string): Promise<ManagedConnection> {
		if (this.connecting) return this.connecting;
		this.connecting = new Promise<ManagedConnection>((resolve, reject) => {
			let opened = false;
			let settled = false;
			const socket = this.webSocketFactory(RESPONSES_WEBSOCKET_URL, {
				headers: { Authorization: `Bearer ${apiKey}` }
			});
			const connection: ManagedConnection = {
				socket,
				createdAtMs: this.nowMs(),
				epoch: ++this.epoch,
				streamCount: 0,
				alive: true,
				keepalive: null,
				failureHandled: false,
				closingProactively: false,
				terminationReason: null
			};

			socket.on('open', () => {
				opened = true;
				settled = true;
				connection.keepalive = setInterval(() => {
					if (!connection.alive) {
						connection.terminationReason = 'keepalive-timeout';
						socket.terminate();
						return;
					}
					connection.alive = false;
					socket.ping();
				}, KEEPALIVE_INTERVAL_MS);
				connection.keepalive.unref?.();
				resolve(connection);
			});
			socket.on('pong', () => {
				connection.alive = true;
			});
			socket.on('message', (data) => this.onMessage(connection, data));
			socket.on('error', (error) => {
				if (!opened && !settled) {
					settled = true;
					reject(
						new WebSocketBeforeSendError(
							`Responses WebSocket 建连失败。${error.name}: ${error.message}`,
							{ cause: error }
						)
					);
					return;
				}
				this.failConnection(connection, error, 'socket-error');
			});
			socket.on('close', (code, reason) => {
				const message = `Responses WebSocket 已关闭（code=${code}, reason=${reason.toString('utf8') || 'empty'}）。`;
				if (!opened && !settled) {
					settled = true;
					reject(new WebSocketBeforeSendError(message));
					return;
				}
				if (connection.closingProactively) return;
				this.failConnection(
					connection,
					new Error(message),
					connection.terminationReason ?? 'socket-close'
				);
			});
		}).finally(() => {
			this.connecting = null;
		});
		return this.connecting;
	}

	private async connectionFor(apiKey: string): Promise<ManagedConnection> {
		const current = this.connection;
		if (current && current.socket.readyState === WebSocket.OPEN) {
			const expired = this.nowMs() - current.createdAtMs >= CONNECTION_MAX_AGE_MS;
			const streamsExhausted = current.streamCount >= CONNECTION_MAX_NAMED_STREAMS;
			if (!expired && !streamsExhausted) return current;
			if (this.pending.size > 0) {
				throw new WebSocketBeforeSendError(
					'Responses WebSocket 需要轮换，但当前连接仍有其他 stream 在飞。'
				);
			}
			current.closingProactively = true;
			this.clearConnection(current);
			current.socket.close(1000, 'proactive rotation');
		}
		const connected = await this.connect(apiKey);
		this.connection = connected;
		return connected;
	}

	private newStream(connection: ManagedConnection): string {
		connection.streamCount += 1;
		this.streamSequence += 1;
		return `revision.${connection.epoch}.${this.streamSequence}`;
	}

	private async invokeOnce(input: {
		prepared: PreparedSidecarCall;
		body: Record<string, unknown>;
		apiKey: string;
		timeoutMs: number;
		forceRebuild: boolean;
	}): Promise<ResponsesTransportResult> {
		const context = input.prepared.revisionChainContext;
		if (!context) throw new WebSocketBeforeSendError('修订请求缺少 WebSocket 链上下文。');
		const connection = await this.connectionFor(input.apiKey);
		const nowMs = this.nowMs();
		let chain = this.chains.get(context.chainKey) ?? null;
		if (
			chain &&
			(chain.connectionEpoch !== connection.epoch ||
				revisionChainShouldRotate(chain, context, nowMs))
		) {
			this.chains.delete(context.chainKey);
			chain = null;
		}

		let delta: RevisionChainDelta | null = null;
		if (chain) {
			delta = revisionChainDelta(chain.atoms, context.atoms, context.runId);
			if (!delta) {
				this.chains.delete(context.chainKey);
				chain = null;
			}
		}
		let incrementalInput = chain && delta ? websocketInput(context, delta) : null;
		if (
			chain &&
			incrementalInput &&
			input.prepared.maxPreparedInputBytes !== null &&
			new TextEncoder().encode(incrementalInput).byteLength > input.prepared.maxPreparedInputBytes
		) {
			this.chains.delete(context.chainKey);
			chain = null;
			incrementalInput = null;
		}

		const chainAction: SidecarTransportDiagnostic['chainAction'] = chain
			? 'continued'
			: input.forceRebuild
				? 'rebuilt'
				: 'bootstrap';
		const streamId = chain?.streamId ?? this.newStream(connection);
		if (this.pending.has(streamId)) {
			throw new WebSocketBeforeSendError(`Responses WebSocket stream ${streamId} 已有请求在飞。`);
		}
		const startedAtMs = this.nowMs();
		const chainCreatedAtMs = chain?.createdAtMs ?? startedAtMs;
		const chainTurn = (chain?.turns ?? 0) + 1;
		const diagnosticBase: Omit<SidecarTransportDiagnostic, 'firstEventMs' | 'completedMs'> = {
			transport: 'websocket',
			chainAction,
			streamId,
			chainTurn,
			chainAgeMs: startedAtMs - chainCreatedAtMs
		};
		const payload: Record<string, unknown> = {
			...input.body,
			type: 'response.create',
			stream_id: streamId,
			...(chain ? { previous_response_id: chain.previousResponseId } : {}),
			...(chain && incrementalInput ? { input: incrementalInput } : {})
		};
		delete payload.stream;
		delete payload.background;
		const result = await new Promise<ResponsesTransportResult>((resolve, reject) => {
			const timer = setTimeout(() => {
				const activePending = this.pending.get(streamId);
				this.pending.delete(streamId);
				connection.terminationReason = 'request-timeout';
				connection.socket.terminate();
				reject(
					new WebSocketOutcomeUnknownError(
						`Responses WebSocket 在 ${input.timeoutMs} ms 内没有返回终态，无法确认是否已产生费用。`,
						{
							...diagnosticBase,
							firstEventMs:
								activePending?.firstEventAtMs === null ||
								activePending?.firstEventAtMs === undefined
									? null
									: activePending.firstEventAtMs - startedAtMs,
							completedMs: this.nowMs() - startedAtMs
						}
					)
				);
			}, input.timeoutMs);
			this.pending.set(streamId, {
				streamId,
				connectionEpoch: connection.epoch,
				startedAtMs,
				firstEventAtMs: null,
				diagnosticBase,
				timer,
				resolve,
				reject
			});
			try {
				connection.socket.send(JSON.stringify(payload), (error) => {
					if (error) this.failConnection(connection, error, 'send-callback-error');
				});
			} catch (error) {
				clearTimeout(timer);
				this.pending.delete(streamId);
				reject(
					new WebSocketOutcomeUnknownError(
						'Responses WebSocket 写入请求帧时抛错，无法确认帧是否已发送。',
						{
							...diagnosticBase,
							firstEventMs: null,
							completedMs: this.nowMs() - startedAtMs
						},
						{ cause: error }
					)
				);
			}
		});

		const id = responseId(result.body);
		if (result.ok && isRecord(result.body) && result.body.status === 'completed' && id) {
			this.chains.set(context.chainKey, {
				streamId,
				previousResponseId: id,
				atoms: context.atoms.map((atom) => ({ ...atom })),
				createdAtMs: chainCreatedAtMs,
				originOpenStart: chain?.originOpenStart ?? context.openStart,
				turns: chainTurn,
				connectionEpoch: connection.epoch
			});
		} else {
			this.chains.delete(context.chainKey);
		}
		return result;
	}

	async invoke(input: {
		prepared: PreparedSidecarCall;
		body: Record<string, unknown>;
		apiKey: string;
		timeoutMs: number;
	}): Promise<ResponsesTransportResult> {
		try {
			return await this.invokeOnce({ ...input, forceRebuild: false });
		} catch (error) {
			if (!(error instanceof PreviousResponseNotFoundError)) throw error;
			this.invalidate(input.prepared);
			return this.invokeOnce({ ...input, forceRebuild: true });
		}
	}

	invalidate(prepared: PreparedSidecarCall): void {
		const key = prepared.revisionChainContext?.chainKey;
		if (key) this.chains.delete(key);
	}
}

class PreviousResponseNotFoundError extends Error {
	constructor(readonly rawEvent: string) {
		super(`Responses WebSocket previous_response_not_found。原始事件：${rawEvent}`);
		this.name = 'PreviousResponseNotFoundError';
	}
}

let singleton: ResponsesWebSocketManager | null = null;

export function responsesWebSocketManager(): ResponsesWebSocketManager {
	singleton ??= new ResponsesWebSocketManager();
	return singleton;
}
