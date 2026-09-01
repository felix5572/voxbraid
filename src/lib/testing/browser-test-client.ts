import type { RealtimeTranslationClientOptions, TranslationClient } from '../realtime/client';
import type { ConnectionStatus, TargetLanguage } from '../realtime/types';

export interface BrowserTestBridge {
	emitSource(delta: string): void;
	emitTranslation(delta: string): void;
	degrade(): void;
	recover(): void;
	fail(message?: string): void;
}

declare global {
	interface Window {
		__voxbraidBrowserTest?: BrowserTestBridge;
	}
}

export class BrowserTestRealtimeClient implements TranslationClient {
	private status: ConnectionStatus = 'idle';
	private elapsedMs = 0;

	constructor(private readonly options: RealtimeTranslationClientOptions) {
		window.__voxbraidBrowserTest = {
			emitSource: (delta) => this.emitTranscript('session.input_transcript.delta', delta),
			emitTranslation: (delta) => this.emitTranscript('session.output_transcript.delta', delta),
			degrade: () => this.degrade(),
			recover: () => this.recover(),
			fail: (message = '浏览器测试模拟连接中断。') => this.fail(message)
		};
	}

	get currentStatus(): ConnectionStatus {
		return this.status;
	}

	async start(targetLanguage: TargetLanguage): Promise<void> {
		void targetLanguage;
		if (this.status !== 'idle' && this.status !== 'failed') return;
		this.setStatus('requesting-microphone');
		this.setStatus('requesting-token');
		this.setStatus('connecting');
		setTimeout(() => {
			if (this.status === 'connecting') this.setStatus('connected');
		}, 0);
	}

	async stop(): Promise<void> {
		if (this.status === 'idle') return;
		this.setStatus('stopping');
		await Promise.resolve();
		this.setStatus('idle');
	}

	private emitTranscript(
		type: 'session.input_transcript.delta' | 'session.output_transcript.delta',
		delta: string
	): void {
		if (this.status !== 'connected') {
			throw new Error(`Cannot emit a browser-test transcript while status is ${this.status}.`);
		}
		this.elapsedMs += 200;
		this.options.onEvent({ type, delta, elapsed_ms: this.elapsedMs });
	}

	private fail(message: string): void {
		if (this.status === 'idle' || this.status === 'failed') return;
		this.setStatus('failed');
		this.options.onConnectionFailure(message);
	}

	private degrade(): void {
		if (this.status === 'connected') this.setStatus('connection-degraded');
	}

	private recover(): void {
		if (this.status === 'connection-degraded') this.setStatus('connected');
	}

	private setStatus(status: ConnectionStatus): void {
		if (this.status === status) return;
		this.status = status;
		this.options.onStatus(status);
	}
}
