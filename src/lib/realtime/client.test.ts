import { afterEach, describe, expect, it, vi } from 'vitest';
import { RealtimeTranslationClient, type RealtimeTranslationClientDependencies } from './client';
import type { ConnectionStatus, TranslationServerEvent } from './types';

class FakeDataChannel extends EventTarget {
	readyState: RTCDataChannelState = 'connecting';
	readonly sent: string[] = [];

	send(data: string): void {
		this.sent.push(data);
	}

	close(): void {
		if (this.readyState === 'closed') return;
		this.readyState = 'closed';
		this.dispatchEvent(new Event('close'));
	}

	emitMessage(data: string): void {
		this.dispatchEvent(new MessageEvent('message', { data }));
	}
}

class FakePeerConnection extends EventTarget {
	connectionState: RTCPeerConnectionState = 'new';
	readonly dataChannel = new FakeDataChannel();
	readonly addTrack = vi.fn();
	readonly createDataChannel = vi.fn(() => this.dataChannel as unknown as RTCDataChannel);
	readonly createOffer = vi.fn(
		async () => ({ type: 'offer', sdp: 'offer-sdp' }) as RTCSessionDescriptionInit
	);
	readonly setLocalDescription = vi.fn(async () => undefined);
	readonly setRemoteDescription = vi.fn(async () => undefined);
	readonly close = vi.fn(() => {
		this.connectionState = 'closed';
	});

	emitConnectionState(state: RTCPeerConnectionState): void {
		this.connectionState = state;
		this.dispatchEvent(new Event('connectionstatechange'));
	}
}

function createMediaStream() {
	const stop = vi.fn();
	const track = { stop } as unknown as MediaStreamTrack;
	const stream = {
		getAudioTracks: () => [track],
		getTracks: () => [track]
	} as unknown as MediaStream;
	return { stream, stop };
}

function createHarness(overrides: Partial<RealtimeTranslationClientDependencies> = {}) {
	const statuses: ConnectionStatus[] = [];
	const events: TranslationServerEvent[] = [];
	const onError = vi.fn();
	const onConnectionFailure = vi.fn();
	const peerConnection = new FakePeerConnection();
	const media = createMediaStream();
	const dependencies: Partial<RealtimeTranslationClientDependencies> = {
		getUserMedia: vi.fn(async () => media.stream),
		createPeerConnection: vi.fn(() => peerConnection as unknown as RTCPeerConnection),
		fetchToken: vi.fn(async () => ({
			clientSecret: 'test-client-secret',
			expiresAt: 2_000_000_000
		})),
		exchangeSdp: vi.fn(async () => 'answer-sdp'),
		now: () => 1_900_000_000_000,
		connectionTimeoutMs: 20,
		recoveryGraceMs: 10,
		closeGraceMs: 10,
		...overrides
	};
	const client = new RealtimeTranslationClient(
		{
			onStatus: (status) => statuses.push(status),
			onEvent: (event) => events.push(event),
			onError,
			onConnectionFailure
		},
		dependencies
	);

	return {
		client,
		dependencies,
		events,
		media,
		onConnectionFailure,
		onError,
		peerConnection,
		statuses
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe('RealtimeTranslationClient', () => {
	it('requests the selected source transcription model and noise reduction mode', async () => {
		const harness = createHarness();

		await harness.client.start('zh', 'gpt-live-transcribe', 'far_field');

		expect(harness.dependencies.fetchToken).toHaveBeenCalledWith(
			'zh',
			'gpt-live-transcribe',
			'far_field',
			expect.any(AbortSignal)
		);
		await harness.client.stop();
	});

	it('cancels a pending start without reporting a failure', async () => {
		const fetchToken = vi.fn(
			(_targetLanguage, _transcriptionModel, _noiseReduction, signal: AbortSignal) =>
				new Promise<never>((_resolve, reject) => {
					signal.addEventListener(
						'abort',
						() => reject(new DOMException('The operation was aborted.', 'AbortError')),
						{ once: true }
					);
				})
		);
		const harness = createHarness({ fetchToken });
		const startPromise = harness.client.start('zh');
		await vi.waitFor(() => expect(fetchToken).toHaveBeenCalledOnce());

		await Promise.all([startPromise, harness.client.stop()]);

		expect(harness.client.currentStatus).toBe('idle');
		expect(harness.statuses).toContain('stopping');
		expect(harness.statuses).not.toContain('failed');
		expect(harness.media.stop).toHaveBeenCalled();
		expect(harness.onError).not.toHaveBeenCalled();
		expect(harness.onConnectionFailure).not.toHaveBeenCalled();
		expect(harness.dependencies.createPeerConnection).not.toHaveBeenCalled();
	});

	it('rejects an expired client secret without reporting it through the async error callback', async () => {
		const harness = createHarness({
			fetchToken: vi.fn(async () => ({
				clientSecret: 'expired-client-secret',
				expiresAt: 1_800_000_000
			}))
		});

		await expect(harness.client.start('zh')).rejects.toThrow('实时翻译凭证已过期，请重新开始。');

		expect(harness.client.currentStatus).toBe('failed');
		expect(harness.onError).not.toHaveBeenCalled();
		expect(harness.onConnectionFailure).not.toHaveBeenCalled();
		expect(harness.dependencies.createPeerConnection).not.toHaveBeenCalled();
		expect(harness.media.stop).toHaveBeenCalled();
	});

	it('deduplicates connected events and waits through a temporary disconnect', async () => {
		const harness = createHarness();
		await harness.client.start('zh');

		harness.peerConnection.emitConnectionState('connected');
		harness.peerConnection.emitConnectionState('connected');
		harness.peerConnection.emitConnectionState('disconnected');
		harness.peerConnection.emitConnectionState('connected');

		expect(harness.statuses).toEqual([
			'requesting-microphone',
			'requesting-token',
			'connecting',
			'connected',
			'connection-degraded',
			'connected'
		]);
		expect(harness.client.currentStatus).toBe('connected');
		expect(harness.onError).not.toHaveBeenCalled();
		expect(harness.onConnectionFailure).not.toHaveBeenCalled();
		await harness.client.stop();
	});

	it('fails only after the recovery grace period expires', async () => {
		vi.useFakeTimers();
		const harness = createHarness();
		await harness.client.start('zh');
		harness.peerConnection.emitConnectionState('connected');
		harness.peerConnection.emitConnectionState('disconnected');

		await vi.advanceTimersByTimeAsync(10);

		expect(harness.client.currentStatus).toBe('failed');
		expect(harness.onConnectionFailure).toHaveBeenCalledWith(
			expect.stringContaining(
				'网络连接长时间未恢复，请重新开始。诊断：connectionState=disconnected'
			)
		);
		expect(harness.onError).not.toHaveBeenCalled();
		expect(harness.peerConnection.close).toHaveBeenCalledOnce();
	});

	it('fails when the initial WebRTC connection does not become connected in time', async () => {
		vi.useFakeTimers();
		const harness = createHarness({ connectionTimeoutMs: 10 });
		await harness.client.start('zh');

		await vi.advanceTimersByTimeAsync(10);

		expect(harness.client.currentStatus).toBe('failed');
		expect(harness.onConnectionFailure).toHaveBeenCalledWith(
			expect.stringContaining('实时连接建立超时，请检查网络后重新开始。诊断：connectionState=new')
		);
		expect(harness.onError).not.toHaveBeenCalled();
		expect(harness.media.stop).toHaveBeenCalled();
		expect(harness.peerConnection.close).toHaveBeenCalledOnce();
	});

	it('reports protocol errors without declaring the connection failed', async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const harness = createHarness();
		await harness.client.start('zh');
		harness.peerConnection.emitConnectionState('connected');

		harness.peerConnection.dataChannel.emitMessage(
			JSON.stringify({
				type: 'error',
				event_id: 'server-event',
				error: {
					message: 'bad realtime event',
					type: 'invalid_request_error',
					code: 'invalid_event',
					param: 'type'
				}
			})
		);

		expect(harness.onError).toHaveBeenCalledWith(
			'bad realtime event（type=invalid_request_error，code=invalid_event，param=type，event_id=server-event）'
		);
		expect(consoleError).toHaveBeenCalledWith(
			'[realtime-client] server error',
			expect.objectContaining({ type: 'error', event_id: 'server-event' })
		);
		expect(harness.onConnectionFailure).not.toHaveBeenCalled();
		expect(harness.client.currentStatus).toBe('connected');
		await harness.client.stop();
		consoleError.mockRestore();
	});

	it('waits for session.closed while accepting final transcript events', async () => {
		const harness = createHarness();
		await harness.client.start('zh');
		harness.peerConnection.dataChannel.readyState = 'open';
		harness.peerConnection.emitConnectionState('connected');

		const stopPromise = harness.client.stop();
		expect(harness.client.currentStatus).toBe('stopping');
		expect(harness.peerConnection.dataChannel.sent).toEqual(['{"type":"session.close"}']);
		expect(harness.peerConnection.close).not.toHaveBeenCalled();

		harness.peerConnection.dataChannel.emitMessage(
			JSON.stringify({ type: 'session.output_transcript.delta', delta: '最后一句' })
		);
		harness.peerConnection.dataChannel.emitMessage(JSON.stringify({ type: 'session.closed' }));
		await stopPromise;

		expect(harness.events).toContainEqual({
			type: 'session.output_transcript.delta',
			delta: '最后一句'
		});
		expect(harness.client.currentStatus).toBe('idle');
		expect(harness.peerConnection.close).toHaveBeenCalledOnce();
	});
});
