import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import type { SidecarInvokeRequest, SidecarRevisionAtom } from '../sidecar/types';
import { parseSidecarInvokeRequest, prepareSidecarCall } from './sidecar-tasks';
import {
	ResponsesWebSocketManager,
	REVISION_CHAIN_MAX_AGE_MS,
	REVISION_CHAIN_MAX_FROZEN_CHARACTERS,
	REVISION_CHAIN_MAX_TURNS,
	revisionChainDelta,
	revisionChainShouldRotate,
	WebSocketOutcomeUnknownError
} from './responses-websocket';

type Handler = (...args: never[]) => void;

class FakeWebSocket {
	readyState = 0;
	readonly sent: Array<Record<string, unknown>> = [];
	private readonly handlers = new Map<string, Handler[]>();

	constructor(
		private readonly onSend: (payload: Record<string, unknown>, socket: FakeWebSocket) => void
	) {
		queueMicrotask(() => {
			this.readyState = 1;
			this.emit('open');
		});
	}

	on(event: string, listener: Handler): this {
		const handlers = this.handlers.get(event) ?? [];
		handlers.push(listener);
		this.handlers.set(event, handlers);
		return this;
	}

	send(data: string, callback?: (error?: Error) => void): void {
		const payload = JSON.parse(data) as Record<string, unknown>;
		this.sent.push(payload);
		callback?.();
		queueMicrotask(() => this.onSend(payload, this));
	}

	serverEvent(value: unknown): void {
		this.emit('message', Buffer.from(JSON.stringify(value)));
	}

	ping(): void {
		this.emit('pong');
	}

	close(code = 1000, reason = ''): void {
		this.readyState = 3;
		this.emit('close', code, Buffer.from(reason));
	}

	terminate(): void {
		this.close(1006, 'terminated');
	}

	private emit(event: string, ...args: unknown[]): void {
		for (const handler of this.handlers.get(event) ?? []) handler(...(args as never[]));
	}
}

function atoms(texts: string[]): SidecarRevisionAtom[] {
	let offset = 0;
	return texts.map((text, index) => {
		const atom = {
			i: index + 1,
			start: offset,
			end: offset + text.length,
			t: text,
			boundary: (text.trimEnd().endsWith('.')
				? 'sentence'
				: 'open') as SidecarRevisionAtom['boundary']
		};
		offset = atom.end;
		return atom;
	});
}

function preparedPair(texts: string[], threadId = 'thread-1') {
	const revisionAtoms = atoms(texts);
	const sourceText = texts.join('');
	const request: SidecarInvokeRequest = {
		clientRequestId: `request-${sourceText.length}`,
		intent: {
			kind: 'revise-pairs',
			trigger: 'periodic',
			targetLanguage: 'zh',
			tokenizerVersion: 2,
			atoms: revisionAtoms,
			continuity: [],
			previousDraft: [],
			previousInvalidAtomRanges: []
		},
		context: {
			threadId,
			scope: 'latest-run',
			capturedAt: '2026-09-02T12:00:00.000Z',
			runs: [
				{
					runId: 'run-1',
					sequence: 1,
					targetLanguage: 'zh',
					sourceText,
					translationText: ''
				}
			]
		}
	};
	return prepareSidecarCall(parseSidecarInvokeRequest(request));
}

function generationBody(prepared: ReturnType<typeof preparedPair>): Record<string, unknown> {
	return {
		model: prepared.model,
		instructions: prepared.instructions,
		input: prepared.inputText,
		store: false,
		stream: false
	};
}

function completedEvent(payload: Record<string, unknown>, id: string): unknown {
	return {
		type: 'response.completed',
		stream_id: payload.stream_id,
		response: {
			id,
			status: 'completed',
			model: 'gpt-5.6-luna',
			output_text: '{"groups":[]}'
		}
	};
}

describe('revision WebSocket chain protocol', () => {
	it('sends only appended atoms while retaining the complete current layout', () => {
		const previous = atoms(['First sentence.', ' Second sentence.']);
		const current = atoms(['First sentence.', ' Second sentence.', ' Third sentence.']);
		const delta = revisionChainDelta(previous, current, 'run-1');

		expect(delta).toMatchObject({
			replaceFrom: null,
			atoms: [{ i: 3, t: ' Third sentence.' }],
			openRange: { firstAtom: 1, lastAtom: 3 }
		});
		expect(delta?.currentLayout.map((item) => item.i)).toEqual([1, 2, 3]);
	});

	it('replaces a growing or resegmented open tail instead of duplicating it', () => {
		const previous = atoms(['The value is 3,']);
		const current = atoms(['The value is 3,000.']);
		const delta = revisionChainDelta(previous, current, 'run-1');

		expect(delta?.replaceFrom).toBe('run-1:0');
		expect(delta?.atoms).toEqual([
			{
				id: 'run-1:0',
				i: 1,
				t: 'The value is 3,000.',
				boundary: 'sentence'
			}
		]);
	});

	it('keeps a matching suffix usable after a frozen prefix leaves the open window', () => {
		const previous = atoms(['First sentence.', ' Second sentence.', ' Tail']);
		const current = previous.slice(1).map((atom, index) => ({ ...atom, i: index + 1 }));
		const delta = revisionChainDelta(previous, current, 'run-1');

		expect(delta?.atoms).toEqual([]);
		expect(delta?.openRange).toMatchObject({ firstAtom: 1, lastAtom: 2 });
	});

	it('rejects snapshots that cannot be safely overlapped or appended', () => {
		const previous = atoms(['First sentence.']);
		const current = atoms(['Different sentence.']).map((atom) => ({
			...atom,
			start: 100,
			end: 119
		}));
		expect(revisionChainDelta(previous, current, 'run-1')).toBeNull();
	});

	it('rotates by age, successful turns, or frozen source distance', () => {
		const base = { createdAtMs: 1_000, originOpenStart: 100, turns: 1 };
		expect(revisionChainShouldRotate(base, { openStart: 100 }, 1_001)).toBe(false);
		expect(
			revisionChainShouldRotate(base, { openStart: 100 }, 1_000 + REVISION_CHAIN_MAX_AGE_MS)
		).toBe(true);
		expect(
			revisionChainShouldRotate(
				{ ...base, turns: REVISION_CHAIN_MAX_TURNS },
				{ openStart: 100 },
				1_001
			)
		).toBe(true);
		expect(
			revisionChainShouldRotate(
				base,
				{ openStart: 100 + REVISION_CHAIN_MAX_FROZEN_CHARACTERS },
				1_001
			)
		).toBe(true);
	});
});

describe('ResponsesWebSocketManager', () => {
	it('repeats instructions and continues with a tail delta on the same stream', async () => {
		let responseSequence = 0;
		let socket: FakeWebSocket;
		const manager = new ResponsesWebSocketManager({
			webSocketFactory: () => {
				socket = new FakeWebSocket((payload, activeSocket) => {
					responseSequence += 1;
					activeSocket.serverEvent(completedEvent(payload, `resp-${responseSequence}`));
				});
				return socket;
			}
		});
		const first = preparedPair(['First sentence.', ' Second sentence.']);
		await manager.invoke({
			prepared: first,
			body: generationBody(first),
			apiKey: 'key',
			timeoutMs: 500
		});
		const second = preparedPair(['First sentence.', ' Second sentence.', ' Third sentence.']);
		const result = await manager.invoke({
			prepared: second,
			body: generationBody(second),
			apiKey: 'key',
			timeoutMs: 500
		});

		expect(socket!.sent).toHaveLength(2);
		expect(socket!.sent[0]).not.toHaveProperty('previous_response_id');
		expect(socket!.sent[0]).not.toHaveProperty('stream');
		expect(socket!.sent[1]).toMatchObject({
			previous_response_id: 'resp-1',
			stream_id: socket!.sent[0].stream_id,
			instructions: second.instructions
		});
		expect(String(socket!.sent[1].input)).toContain('revisionChainDelta');
		expect(String(socket!.sent[1].input)).toContain('Third sentence.');
		expect(String(socket!.sent[0].input)).toContain('frozenContinuity');
		expect(String(socket!.sent[0].input)).toContain('previousDraft');
		expect(String(socket!.sent[1].input)).not.toContain('frozenContinuity');
		expect(String(socket!.sent[1].input)).not.toContain('previousDraft');
		expect(result.transportDiagnostic).toMatchObject({
			transport: 'websocket',
			chainAction: 'continued',
			chainTurn: 2
		});
	});

	it('rebuilds exactly once when the connection cache loses the previous response', async () => {
		let sendCount = 0;
		let socket: FakeWebSocket;
		const manager = new ResponsesWebSocketManager({
			webSocketFactory: () => {
				socket = new FakeWebSocket((payload, activeSocket) => {
					sendCount += 1;
					if (sendCount === 2) {
						activeSocket.serverEvent({
							type: 'error',
							stream_id: payload.stream_id,
							error: { code: 'previous_response_not_found', message: 'evicted' }
						});
						return;
					}
					activeSocket.serverEvent(completedEvent(payload, `resp-${sendCount}`));
				});
				return socket;
			}
		});
		const first = preparedPair(['First sentence.']);
		await manager.invoke({
			prepared: first,
			body: generationBody(first),
			apiKey: 'key',
			timeoutMs: 500
		});
		const second = preparedPair(['First sentence.', ' Second sentence.']);
		const result = await manager.invoke({
			prepared: second,
			body: generationBody(second),
			apiKey: 'key',
			timeoutMs: 500
		});

		expect(socket!.sent).toHaveLength(3);
		expect(socket!.sent[2]).not.toHaveProperty('previous_response_id');
		expect(socket!.sent[2].input).toBe(second.inputText);
		expect(result.transportDiagnostic.chainAction).toBe('rebuilt');
	});

	it('routes interleaved terminal events to the matching stream', async () => {
		let socket: FakeWebSocket;
		const manager = new ResponsesWebSocketManager({
			webSocketFactory: () => {
				socket = new FakeWebSocket(() => undefined);
				return socket;
			}
		});
		const first = preparedPair(['First sentence.'], 'thread-a');
		const second = preparedPair(['Second sentence.'], 'thread-b');
		const firstPromise = manager.invoke({
			prepared: first,
			body: generationBody(first),
			apiKey: 'key',
			timeoutMs: 500
		});
		const secondPromise = manager.invoke({
			prepared: second,
			body: generationBody(second),
			apiKey: 'key',
			timeoutMs: 500
		});
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		const [firstPayload, secondPayload] = socket!.sent;
		socket!.serverEvent(completedEvent(secondPayload, 'resp-b'));
		socket!.serverEvent(completedEvent(firstPayload, 'resp-a'));

		const [firstResult, secondResult] = await Promise.all([firstPromise, secondPromise]);
		expect((firstResult.body as { id: string }).id).toBe('resp-a');
		expect((secondResult.body as { id: string }).id).toBe('resp-b');
		expect(firstResult.transportDiagnostic.streamId).not.toBe(
			secondResult.transportDiagnostic.streamId
		);
	});

	it('reports an unknown outcome when the socket closes after send', async () => {
		const manager = new ResponsesWebSocketManager({
			webSocketFactory: () =>
				new FakeWebSocket((_payload, socket) => socket.close(1006, 'network lost'))
		});
		const prepared = preparedPair(['First sentence.']);

		await expect(
			manager.invoke({ prepared, body: generationBody(prepared), apiKey: 'key', timeoutMs: 500 })
		).rejects.toBeInstanceOf(WebSocketOutcomeUnknownError);
	});
});
