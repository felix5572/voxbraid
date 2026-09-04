<script lang="ts">
	import { onDestroy } from 'svelte';
	import { inlineErrorDetails } from '../error-details';
	import type { AudioTestReport } from './audio-test-report';

	let {
		active,
		file = $bindable(),
		report,
		onDownload
	}: {
		active: boolean;
		file: File | null;
		report: AudioTestReport | null;
		onDownload: () => void;
	} = $props();

	type ActiveRecording = {
		recorder: MediaRecorder;
		stream: MediaStream;
		chunks: Blob[];
	};

	// Keep browser-native recording objects out of Svelte's deep proxy so identity checks stay stable.
	let recording = $state.raw<ActiveRecording | null>(null);
	let recordingError = $state('');

	function downloadFile(recordedFile: File): void {
		const url = URL.createObjectURL(recordedFile);
		const link = document.createElement('a');
		link.href = url;
		link.download = recordedFile.name;
		document.body.append(link);
		link.click();
		link.remove();
		setTimeout(() => URL.revokeObjectURL(url), 0);
	}

	function releaseRecordingStream(stream: MediaStream): void {
		for (const track of stream.getTracks()) track.stop();
	}

	async function startRecording(): Promise<void> {
		if (active || recording) return;
		recordingError = '';
		try {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((candidate) =>
				MediaRecorder.isTypeSupported(candidate)
			);
			const recorder = mimeType
				? new MediaRecorder(stream, { mimeType })
				: new MediaRecorder(stream);
			const current: ActiveRecording = { recorder, stream, chunks: [] };
			recording = current;

			recorder.ondataavailable = (event) => {
				if (event.data.size > 0) current.chunks.push(event.data);
			};
			recorder.onerror = (event) => {
				const original = 'error' in event ? event.error : event;
				recordingError = `录音失败，请重新尝试。\n${inlineErrorDetails(original)}`;
				releaseRecordingStream(stream);
				recording = null;
			};
			recorder.onstop = () => {
				releaseRecordingStream(stream);
				if (recording === current) recording = null;
				const type = recorder.mimeType || mimeType || 'audio/webm';
				const extension = type.includes('mp4') ? 'm4a' : 'webm';
				const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
				const recordedFile = new File(current.chunks, `voxbraid-test-${timestamp}.${extension}`, {
					type
				});
				if (recordedFile.size === 0) {
					recordingError = '没有录到声音，请重新尝试。';
					return;
				}
				file = recordedFile;
				downloadFile(recordedFile);
			};
			recorder.start();
		} catch (error) {
			console.error('[audio-test-recorder] start failed', error);
			recordingError = `无法开始录音。\n${inlineErrorDetails(error)}`;
		}
	}

	function stopRecording(): void {
		if (recording?.recorder.state !== 'inactive') recording?.recorder.stop();
	}

	onDestroy(() => {
		if (!recording) return;
		recording.recorder.ondataavailable = null;
		recording.recorder.onstop = null;
		if (recording.recorder.state !== 'inactive') recording.recorder.stop();
		releaseRecordingStream(recording.stream);
	});
</script>

<section class="audio-test" aria-label="录音回放测试">
	<div class="heading">
		<div>
			<strong>开发测试模式</strong>
			<p>本地录音将作为真实 WebRTC 音轨发送至 OpenAI；报告不包含录音名称或字幕正文。</p>
		</div>
		<span>真实 API 计费</span>
	</div>
	<div class="fields">
		<label class="file-field">
			<span>录音文件</span>
			<input
				type="file"
				accept="audio/*,.m4a"
				disabled={active || recording !== null}
				onchange={(event) => (file = event.currentTarget.files?.item(0) ?? null)}
			/>
		</label>
	</div>
	{#if file}<p class="selected">当前回放：{file.name}</p>{/if}
	<details class="recorder-tools">
		<summary>{recording ? '正在录音…' : '录制新的测试片段'}</summary>
		<div class="recorder-body">
			{#if recording}
				<button class="record stop-recording" onclick={stopRecording}>停止并保存</button>
			{:else}
				<button class="record" onclick={() => void startRecording()} disabled={active}>
					开始录音
				</button>
			{/if}
			<p class="note">停止后会自动下载到本机并选为当前回放。日常录 5–20 秒，偶尔录约 1–3 分钟。</p>
			{#if recordingError}<p class="recording-error" role="alert">{recordingError}</p>{/if}
		</div>
	</details>
	{#if report}
		<div class="result">
			<span>测试已结束 · {report.result.outcome} · {report.runs.length} 个 Run</span>
			<button onclick={onDownload}>下载诊断报告</button>
		</div>
	{/if}
</section>

<style>
	.audio-test {
		padding: 18px;
		border: 1px solid #4d4930;
		border-radius: 18px;
		display: grid;
		gap: 15px;
		background: rgba(58, 51, 24, 0.2);
	}
	.heading,
	.fields,
	.result {
		display: flex;
		align-items: center;
	}
	.heading,
	.result {
		justify-content: space-between;
		gap: 18px;
	}
	.heading strong {
		color: #e6d99c;
		font-size: 14px;
	}
	.heading p,
	.note {
		margin: 4px 0 0;
		color: #898572;
		font-size: 12px;
		line-height: 1.5;
	}
	.heading > span {
		flex: none;
		padding: 6px 9px;
		border: 1px solid #60582e;
		border-radius: 999px;
		color: #d7c873;
		font-size: 11px;
	}
	.fields {
		flex-wrap: wrap;
		gap: 18px;
	}
	label {
		min-height: 42px;
		display: flex;
		align-items: center;
		gap: 12px;
		color: #929c97;
		font-size: 13px;
	}
	.file-field {
		flex: 1 1 360px;
	}
	.file-field input {
		min-width: 0;
		color: #aeb6b2;
	}
	.file-field input::file-selector-button {
		margin-right: 10px;
		padding: 8px 11px;
		border: 1px solid #434c48;
		border-radius: 9px;
		background: #151b18;
		color: #dce5e0;
		cursor: pointer;
	}
	.record {
		flex: none;
		padding: 10px 13px;
		border: 1px solid #426057;
		background: #18251f;
		color: #a8dfcc;
	}
	.recorder-tools {
		border-top: 1px solid #3b3929;
		padding-top: 12px;
	}
	.recorder-tools summary {
		width: fit-content;
		color: #9ea8a3;
		cursor: pointer;
		font-size: 12px;
	}
	.recorder-body {
		margin-top: 12px;
		display: flex;
		align-items: center;
		gap: 12px;
	}
	.recorder-body .note {
		margin: 0;
	}
	.stop-recording {
		border-color: #704a46;
		background: #321d1b;
		color: #efb4ad;
	}
	.selected,
	.recording-error {
		margin: 0;
		font-size: 12px;
	}
	.selected {
		color: #aeb6b2;
	}
	.recording-error {
		color: #ef9f96;
	}
	.result {
		padding-top: 14px;
		border-top: 1px solid #3b3929;
		color: #b8b5a2;
		font-size: 12px;
	}
	button {
		padding: 9px 12px;
		border: 0;
		border-radius: 9px;
		background: #d7c873;
		color: #1d1a0b;
		font-weight: 680;
		cursor: pointer;
	}
	button:disabled {
		cursor: not-allowed;
		opacity: 0.5;
	}

	@media (max-width: 640px) {
		.heading,
		.result {
			align-items: flex-start;
			flex-direction: column;
		}
		.fields,
		.fields label {
			align-items: stretch;
			flex-direction: column;
		}
		.file-field {
			flex-basis: auto;
		}
		.recorder-body {
			align-items: flex-start;
			flex-direction: column;
		}
	}
</style>
