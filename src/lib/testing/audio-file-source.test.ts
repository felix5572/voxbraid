import { describe, expect, it, vi } from 'vitest';
import { AudioFileStreamSource } from './audio-file-source';

function harness() {
	const stopTrack = vi.fn();
	const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
	const destination = { stream } as MediaStreamAudioDestinationNode;
	const source = {
		buffer: null,
		loop: false,
		onended: null,
		connect: vi.fn(),
		disconnect: vi.fn(),
		start: vi.fn(),
		stop: vi.fn()
	} as unknown as AudioBufferSourceNode;
	const context = {
		state: 'suspended',
		decodeAudioData: vi.fn(async () => ({ duration: 12.345 }) as AudioBuffer),
		createBufferSource: vi.fn(() => source),
		createMediaStreamDestination: vi.fn(() => destination),
		resume: vi.fn(async () => undefined),
		close: vi.fn(async () => undefined)
	} as unknown as AudioContext;
	const readFile = vi.fn(async () => new ArrayBuffer(4));
	const controller = new AudioFileStreamSource({ createAudioContext: () => context, readFile });
	const file = { size: 4 } as File;
	return { context, controller, destination, file, readFile, source, stopTrack, stream };
}

describe('AudioFileStreamSource', () => {
	it('prepares a media stream and starts it only after play', async () => {
		const test = harness();
		const onEnded = vi.fn();

		await expect(test.controller.open(test.file, { onEnded })).resolves.toEqual({
			stream: test.stream,
			durationMs: 12_345
		});

		expect(test.readFile).toHaveBeenCalledWith(test.file);
		expect(test.source.loop).toBe(false);
		expect(test.source.connect).toHaveBeenCalledWith(test.destination);
		expect(test.context.resume).toHaveBeenCalledOnce();
		expect(test.source.start).not.toHaveBeenCalled();
		test.controller.play();
		test.controller.play();
		expect(test.source.start).toHaveBeenCalledOnce();
		expect(onEnded).not.toHaveBeenCalled();
	});

	it('stops playback, its generated track, and the audio context', async () => {
		const test = harness();
		await test.controller.open(test.file, { onEnded: vi.fn() });
		test.controller.play();

		test.controller.stop();

		expect(test.source.stop).toHaveBeenCalledOnce();
		expect(test.source.disconnect).toHaveBeenCalledOnce();
		expect(test.stopTrack).toHaveBeenCalledOnce();
		expect(test.context.close).toHaveBeenCalledOnce();
	});

	it('reports natural completion once and releases the generated stream', async () => {
		const test = harness();
		const onEnded = vi.fn();
		await test.controller.open(test.file, { onEnded });
		test.controller.play();

		(test.source.onended as () => void)();

		expect(onEnded).toHaveBeenCalledOnce();
		expect(test.source.stop).not.toHaveBeenCalled();
		expect(test.stopTrack).toHaveBeenCalledOnce();
		expect(test.context.close).toHaveBeenCalledOnce();
	});

	it('rejects an empty recording before creating an audio context', async () => {
		const createAudioContext = vi.fn();
		const controller = new AudioFileStreamSource({
			createAudioContext,
			readFile: vi.fn()
		});

		await expect(controller.open({ size: 0 } as File, { onEnded: vi.fn() })).rejects.toThrow(
			'录音文件为空'
		);
		expect(createAudioContext).not.toHaveBeenCalled();
	});

	it('cancels preparation without starting audio when stopped during file reading', async () => {
		const test = harness();
		let finishReading!: (value: ArrayBuffer) => void;
		const reading = new Promise<ArrayBuffer>((resolve) => {
			finishReading = resolve;
		});
		const controller = new AudioFileStreamSource({
			createAudioContext: () => test.context,
			readFile: () => reading
		});
		const opening = controller.open(test.file, { onEnded: vi.fn() });

		controller.stop();
		finishReading(new ArrayBuffer(4));

		await expect(opening).rejects.toMatchObject({ name: 'AbortError' });
		expect(test.source.start).not.toHaveBeenCalled();
		expect(test.context.close).toHaveBeenCalledOnce();
	});
});
