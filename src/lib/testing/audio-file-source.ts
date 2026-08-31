export interface AudioFilePlayback {
	stream: MediaStream;
	durationMs: number;
}

export interface AudioFilePlaybackOptions {
	onEnded: () => void;
}

export interface AudioFileStreamSourceDependencies {
	createAudioContext: () => AudioContext;
	readFile: (file: File) => Promise<ArrayBuffer>;
}

interface ActivePlayback {
	context: AudioContext;
	source: AudioBufferSourceNode | null;
	destination: MediaStreamAudioDestinationNode | null;
	started: boolean;
}

const DEFAULT_DEPENDENCIES: AudioFileStreamSourceDependencies = {
	createAudioContext: () => new AudioContext(),
	readFile: (file) => file.arrayBuffer()
};

function abortError(): DOMException {
	return new DOMException('Audio file playback was cancelled.', 'AbortError');
}

export class AudioFileStreamSource {
	private active: ActivePlayback | null = null;
	private generation = 0;

	constructor(
		private readonly dependencies: AudioFileStreamSourceDependencies = DEFAULT_DEPENDENCIES
	) {}

	async open(file: File, options: AudioFilePlaybackOptions): Promise<AudioFilePlayback> {
		if (file.size <= 0) throw new Error('录音文件为空，请重新选择。');
		this.stop();
		const generation = this.generation;
		const playback: ActivePlayback = {
			context: this.dependencies.createAudioContext(),
			source: null,
			destination: null,
			started: false
		};
		this.active = playback;

		try {
			const resume =
				playback.context.state === 'suspended' ? playback.context.resume() : Promise.resolve();
			const encodedAudio = await this.dependencies.readFile(file);
			const buffer = await playback.context.decodeAudioData(encodedAudio);
			await resume;
			if (!this.isCurrent(playback, generation)) throw abortError();

			const source = playback.context.createBufferSource();
			const destination = playback.context.createMediaStreamDestination();
			playback.source = source;
			playback.destination = destination;
			source.buffer = buffer;
			source.connect(destination);
			source.onended = () => {
				if (!this.isCurrent(playback, generation)) return;
				this.active = null;
				this.generation += 1;
				this.release(playback, false);
				options.onEnded();
			};

			return {
				stream: destination.stream,
				durationMs: Math.round(buffer.duration * 1_000)
			};
		} catch (error) {
			if (this.active === playback) {
				this.active = null;
				this.generation += 1;
				this.release(playback, true);
			}
			throw error;
		}
	}

	play(): void {
		const playback = this.active;
		if (!playback?.source || playback.started) return;
		playback.source.start();
		playback.started = true;
	}

	stop(): void {
		this.generation += 1;
		const playback = this.active;
		this.active = null;
		if (playback) this.release(playback, true);
	}

	private isCurrent(playback: ActivePlayback, generation: number): boolean {
		return this.active === playback && this.generation === generation;
	}

	private release(playback: ActivePlayback, stopSource: boolean): void {
		if (playback.source) {
			playback.source.onended = null;
			if (stopSource && playback.started) {
				try {
					playback.source.stop();
				} catch {
					// A source that ended between the state check and cleanup is already stopped.
				}
			}
			playback.source.disconnect();
		}
		for (const track of playback.destination?.stream.getTracks() ?? []) track.stop();
		void playback.context.close().catch(() => undefined);
	}
}
