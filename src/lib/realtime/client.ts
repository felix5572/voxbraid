import { parseServerEvent } from './transcript';
import { exchangeTranslationSdp, fetchTranslationToken } from './transport';
import type {
	ConnectionStatus,
	TargetLanguage,
	TranslationServerEvent,
	TranslationTokenResponse
} from './types';

const CONNECTION_TIMEOUT_MS = 15_000;
const RECOVERY_GRACE_MS = 8_000;
const CLOSE_GRACE_MS = 1_500;

type Timer = ReturnType<typeof setTimeout>;

export interface RealtimeTranslationClientOptions {
	onStatus: (status: ConnectionStatus) => void;
	onEvent: (event: TranslationServerEvent) => void;
	onError: (message: string) => void;
	onConnectionFailure: (message: string) => void;
}

export interface TranslationClient {
	readonly currentStatus: ConnectionStatus;
	start(targetLanguage: TargetLanguage): Promise<void>;
	stop(): Promise<void>;
}

export interface RealtimeTranslationClientDependencies {
	getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
	createPeerConnection: () => RTCPeerConnection;
	fetchToken: (
		targetLanguage: TargetLanguage,
		signal: AbortSignal
	) => Promise<TranslationTokenResponse>;
	exchangeSdp: (clientSecret: string, offerSdp: string, signal: AbortSignal) => Promise<string>;
	now: () => number;
	setTimer: (callback: () => void, delay: number) => Timer;
	clearTimer: (timer: Timer) => void;
	connectionTimeoutMs: number;
	recoveryGraceMs: number;
	closeGraceMs: number;
}

const DEFAULT_DEPENDENCIES: RealtimeTranslationClientDependencies = {
	getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
	createPeerConnection: () => new RTCPeerConnection(),
	fetchToken: (targetLanguage, signal) => fetchTranslationToken(targetLanguage, fetch, signal),
	exchangeSdp: (clientSecret, offerSdp, signal) =>
		exchangeTranslationSdp(clientSecret, offerSdp, fetch, signal),
	now: () => Date.now(),
	setTimer: (callback, delay) => setTimeout(callback, delay),
	clearTimer: (timer) => clearTimeout(timer),
	connectionTimeoutMs: CONNECTION_TIMEOUT_MS,
	recoveryGraceMs: RECOVERY_GRACE_MS,
	closeGraceMs: CLOSE_GRACE_MS
};

export function realtimeErrorMessage(error: unknown): string {
	if (error instanceof DOMException && error.name === 'NotAllowedError') {
		return '没有获得麦克风权限。请允许访问麦克风后重试。';
	}
	if (error instanceof Error && error.message) return error.message;
	return '实时翻译连接失败，请稍后重试。';
}

function stopTracks(stream: MediaStream | null): void {
	for (const track of stream?.getTracks() ?? []) track.stop();
}

function readRealtimeErrorMessage(event: TranslationServerEvent): string | null {
	if (
		event.type !== 'error' ||
		!('error' in event) ||
		typeof event.error !== 'object' ||
		event.error === null ||
		!('message' in event.error) ||
		typeof event.error.message !== 'string'
	) {
		return null;
	}
	return event.error.message;
}

export class RealtimeTranslationClient implements TranslationClient {
	private status: ConnectionStatus = 'idle';
	private peerConnection: RTCPeerConnection | null = null;
	private dataChannel: RTCDataChannel | null = null;
	private mediaStream: MediaStream | null = null;
	private abortController: AbortController | null = null;
	private connectionTimer: Timer | null = null;
	private recoveryTimer: Timer | null = null;
	private closeResolver: (() => void) | null = null;
	private stopPromise: Promise<void> | null = null;
	private runId = 0;
	private readonly dependencies: RealtimeTranslationClientDependencies;

	constructor(
		private readonly options: RealtimeTranslationClientOptions,
		dependencies: Partial<RealtimeTranslationClientDependencies> = {}
	) {
		this.dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencies };
	}

	get currentStatus(): ConnectionStatus {
		return this.status;
	}

	async start(targetLanguage: TargetLanguage): Promise<void> {
		if (this.status !== 'idle' && this.status !== 'failed') return;

		const runId = ++this.runId;
		const abortController = new AbortController();
		this.abortController = abortController;

		try {
			this.setStatus('requesting-microphone');
			const mediaStream = await this.dependencies.getUserMedia({
				audio: {
					channelCount: 1,
					echoCancellation: false,
					noiseSuppression: false,
					autoGainControl: false
				}
			});
			if (!this.isRunActive(runId, abortController)) {
				stopTracks(mediaStream);
				return;
			}
			this.mediaStream = mediaStream;

			this.setStatus('requesting-token');
			const token = await this.dependencies.fetchToken(targetLanguage, abortController.signal);
			if (!this.isRunActive(runId, abortController)) return;
			if (token.expiresAt * 1_000 <= this.dependencies.now()) {
				throw new Error('实时翻译凭证已过期，请重新开始。');
			}

			this.setStatus('connecting');
			const peerConnection = this.dependencies.createPeerConnection();
			this.peerConnection = peerConnection;
			this.bindPeerConnection(peerConnection, runId);
			this.startConnectionTimer(peerConnection, runId);

			for (const track of mediaStream.getAudioTracks()) {
				peerConnection.addTrack(track, mediaStream);
			}

			const dataChannel = peerConnection.createDataChannel('oai-events');
			this.dataChannel = dataChannel;
			this.bindDataChannel(dataChannel, runId);

			const offer = await peerConnection.createOffer();
			if (!this.isRunActive(runId, abortController)) return;
			await peerConnection.setLocalDescription(offer);
			if (!this.isRunActive(runId, abortController)) return;

			const answerSdp = await this.dependencies.exchangeSdp(
				token.clientSecret,
				offer.sdp ?? '',
				abortController.signal
			);
			if (!this.isRunActive(runId, abortController)) return;

			await peerConnection.setRemoteDescription({ type: 'answer', sdp: answerSdp });
			if (!this.isRunActive(runId, abortController)) return;
		} catch (error) {
			if (abortController.signal.aborted || runId !== this.runId) return;
			this.abortController = null;
			this.clearConnectionTimer();
			this.clearRecoveryTimer();
			this.teardown();
			this.setStatus('failed');
			throw error;
		}
	}

	stop(): Promise<void> {
		if (this.stopPromise) return this.stopPromise;

		const promise = this.performStop();
		this.stopPromise = promise;
		void promise.finally(() => {
			if (this.stopPromise === promise) this.stopPromise = null;
		});
		return promise;
	}

	private async performStop(): Promise<void> {
		const hasActiveRun =
			this.status !== 'idle' || this.peerConnection !== null || this.mediaStream !== null;
		if (!hasActiveRun) return;

		this.abortController?.abort();
		this.abortController = null;
		this.clearConnectionTimer();
		this.clearRecoveryTimer();
		this.setStatus('stopping');
		stopTracks(this.mediaStream);

		await this.requestGracefulClose();
		++this.runId;
		this.teardown();
		this.setStatus('idle');
	}

	private bindDataChannel(dataChannel: RTCDataChannel, runId: number): void {
		dataChannel.addEventListener('close', () => this.closeResolver?.());
		dataChannel.addEventListener('message', (messageEvent) => {
			if (typeof messageEvent.data !== 'string') return;
			const event = parseServerEvent(messageEvent.data);
			if (!event || runId !== this.runId) return;

			this.options.onEvent(event);
			if (event.type === 'session.closed') {
				this.closeResolver?.();
				return;
			}
			const message = readRealtimeErrorMessage(event);
			if (message) this.options.onError(message);
		});
	}

	private bindPeerConnection(peerConnection: RTCPeerConnection, runId: number): void {
		peerConnection.addEventListener('track', (event) => {
			// Translation audio is intentionally not played in the subtitle-first MVP.
			event.track.enabled = false;
		});
		peerConnection.addEventListener('connectionstatechange', () => {
			if (runId !== this.runId || this.status === 'stopping' || this.status === 'idle') return;

			if (peerConnection.connectionState === 'connected') {
				this.clearConnectionTimer();
				this.clearRecoveryTimer();
				this.setStatus('connected');
				return;
			}

			if (peerConnection.connectionState === 'disconnected') {
				this.setStatus('connection-degraded');
				this.startRecoveryTimer(peerConnection, runId);
				return;
			}

			if (peerConnection.connectionState === 'failed') {
				this.failConnection(runId, '实时连接已中断，请重新开始。');
			}
		});
	}

	private startConnectionTimer(peerConnection: RTCPeerConnection, runId: number): void {
		this.clearConnectionTimer();
		this.connectionTimer = this.dependencies.setTimer(() => {
			this.connectionTimer = null;
			if (
				runId === this.runId &&
				this.peerConnection === peerConnection &&
				this.status === 'connecting'
			) {
				this.failConnection(runId, '实时连接建立超时，请检查网络后重新开始。');
			}
		}, this.dependencies.connectionTimeoutMs);
	}

	private startRecoveryTimer(peerConnection: RTCPeerConnection, runId: number): void {
		if (this.recoveryTimer) return;
		this.recoveryTimer = this.dependencies.setTimer(() => {
			this.recoveryTimer = null;
			if (
				runId === this.runId &&
				this.peerConnection === peerConnection &&
				this.status === 'connection-degraded'
			) {
				this.failConnection(runId, '网络连接长时间未恢复，请重新开始。');
			}
		}, this.dependencies.recoveryGraceMs);
	}

	private failConnection(runId: number, message: string): void {
		if (runId !== this.runId) return;
		this.abortController?.abort();
		this.abortController = null;
		this.clearConnectionTimer();
		this.clearRecoveryTimer();
		++this.runId;
		this.teardown();
		this.setStatus('failed');
		this.options.onConnectionFailure(message);
	}

	private requestGracefulClose(): Promise<void> {
		const dataChannel = this.dataChannel;
		if (!dataChannel || dataChannel.readyState !== 'open') return Promise.resolve();

		return new Promise<void>((resolve) => {
			let settled = false;
			const timer = this.dependencies.setTimer(finish, this.dependencies.closeGraceMs);

			function finish(): void {
				if (settled) return;
				settled = true;
				resolve();
			}

			this.closeResolver = () => {
				this.dependencies.clearTimer(timer);
				finish();
			};

			try {
				dataChannel.send(JSON.stringify({ type: 'session.close' }));
			} catch {
				this.closeResolver();
			}
		}).finally(() => {
			this.closeResolver = null;
		});
	}

	private isRunActive(runId: number, abortController: AbortController): boolean {
		return runId === this.runId && !abortController.signal.aborted;
	}

	private setStatus(status: ConnectionStatus): void {
		if (this.status === status) return;
		this.status = status;
		this.options.onStatus(status);
	}

	private clearConnectionTimer(): void {
		if (!this.connectionTimer) return;
		this.dependencies.clearTimer(this.connectionTimer);
		this.connectionTimer = null;
	}

	private clearRecoveryTimer(): void {
		if (!this.recoveryTimer) return;
		this.dependencies.clearTimer(this.recoveryTimer);
		this.recoveryTimer = null;
	}

	private teardown(): void {
		this.closeResolver?.();
		this.closeResolver = null;
		this.dataChannel?.close();
		this.peerConnection?.close();
		stopTracks(this.mediaStream);
		this.dataChannel = null;
		this.peerConnection = null;
		this.mediaStream = null;
	}
}
