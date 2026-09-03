<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import { inlineErrorDetails } from '../error-details';
	import { emitOperationalLog, resolveOperationalIssue } from '../operational-log';
	import type { LocalSessionRepository } from '../persistence/local-session-repository';
	import { sentenceBoundaries } from '../session/sentence-boundary';
	import type { CaptureRun } from '../session/types';
	import { activeCaptureRun, type TranslationSessionState } from '../session/translation-session';
	import { sendSidecarRequest, sidecarLocalFailure } from '../sidecar/client';
	import type {
		SidecarErrorCode,
		SidecarInvokeRequest,
		SidecarInvokeResult,
		SidecarRevisionContextSegment,
		SidecarRevisionDraftSegment
	} from '../sidecar/types';
	import { ProjectionWorker } from './projection-worker';
	import {
		REVISION_FINALIZING_RETRY_DELAY_MS,
		canAutomaticallyRetryFinalizing,
		revisionBackoffMs
	} from './revision-recovery';
	import {
		reconcileRevisionSegmentPresentation,
		revisionLongGroupSummary,
		supersededFailedBatches
	} from './revision-display';
	import { revisionTransportSummary } from './revision-transport-summary';
	import {
		REVISION_LONG_GROUP_CHARACTERS,
		REVISION_MAX_CONTINUITY_CHARACTERS,
		REVISION_QUIET_WINDOW_MS,
		REVISION_TASK_VERSION,
		REVISION_TOKENIZER_VERSION
	} from './revision-constants';
	import {
		parseRevisionModelOutput,
		RevisionBoundaryError,
		type ValidatedRevisionGroup
	} from './revision-output';
	import {
		commitRevisionGroups,
		revisionTextEndsNaturally,
		revisionTrigger,
		sourceClauseAtoms,
		type RevisionTriggerResult,
		type SourceClauseAtom
	} from './revision-projection';
	import type {
		RevisionTrigger,
		StoredRevisedSegment,
		StoredRevisionBatch
	} from './revision-records';

	interface Props {
		session: TranslationSessionState | null;
		repository: LocalSessionRepository | null;
		disabled?: boolean;
		diagnosticsMode?: boolean;
		onRequestingChange?: (requesting: boolean) => void;
	}

	interface RevisionCandidate {
		runId: string;
		runSequence: number;
		targetLanguage: string;
		sourceText: string;
		openStart: number;
		openEnd: number;
		atoms: SourceClauseAtom[];
		trigger: RevisionTrigger;
		finalizing: boolean;
		triggerResult: RevisionTriggerResult;
		finalizingRetryKey: string | null;
	}

	interface ActiveRequest {
		clientRequestId: string;
		runId: string;
		runSequence: number;
		batchSequence: number;
		capturedAt: string;
		openStart: number;
		openEnd: number;
		attempt: number;
		sourceElapsedEndMs: number | null;
	}

	type RevisionDisplayRow =
		| {
				kind: 'revised';
				id: string;
				runSequence: number;
				sourceStart: number;
				segment: StoredRevisedSegment;
		  }
		| {
				kind: 'raw';
				id: string;
				runId: string;
				runSequence: number;
				sourceStart: number;
				sourceEnd: number;
				rawText: string;
				status: 'capturing' | 'live' | 'unrevised';
		  };

	interface LiveTailLine {
		sourceStart: number;
		text: string;
	}

	interface ReadingAnchor {
		runId: string;
		sourceOffset: number;
		top: number;
		line: boolean;
	}

	let {
		session,
		repository,
		disabled = false,
		diagnosticsMode = false,
		onRequestingChange = () => undefined
	}: Props = $props();
	let batches = $state<StoredRevisionBatch[]>([]);
	let segments = $state<StoredRevisedSegment[]>([]);
	let phase = $state<'loading' | 'idle' | 'requesting' | 'freezing'>('loading');
	let loadedThreadId = $state<string | null>(null);
	let activeRequest = $state<ActiveRequest | null>(null);
	let statusNowMs = $state(Date.now());
	let errorMessage = $state('');
	let persistenceMessage = $state('');
	let consecutiveInfrastructureFailures = $state(0);
	let recoveryNotBeforeMs = $state(0);
	let reloadRequired = $state(false);
	let scroller: HTMLDivElement;
	let following = $state(true);
	const worker = new ProjectionWorker();
	const automaticBaselines = new SvelteMap<string, number>();
	const pendingSince = new SvelteMap<string, number>();
	const lastAutomaticRequestAt = new SvelteMap<string, number>();
	const finalizingRetries = new SvelteMap<string, { notBeforeMs: number; consumed: boolean }>();
	const threadId = $derived(session?.thread.id ?? null);
	const allFailedBatches = $derived(batches.filter((batch) => batch.status === 'failed'));
	const supersededFailureIds = $derived(
		new Set(supersededFailedBatches(batches).map((batch) => batch.id))
	);
	const failedBatches = $derived(
		allFailedBatches.filter((batch) => !supersededFailureIds.has(batch.id))
	);
	const visibleFailedBatches = $derived(diagnosticsMode ? allFailedBatches : failedBatches);
	const footerErrorMessage = $derived(
		failedBatches.at(-1)?.error === errorMessage ? '' : errorMessage
	);
	const totalTokens = $derived(
		batches.reduce((total, batch) => total + (batch.usage?.totalTokens ?? 0), 0)
	);
	const transportSummary = $derived(revisionTransportSummary(batches));
	const longGroupSummary = $derived(revisionLongGroupSummary(segments));
	const orderedSegments = $derived(
		[...segments].sort(
			(left, right) => left.runSequence - right.runSequence || left.sourceStart - right.sourceStart
		)
	);
	const displayRows = $derived.by(() => {
		const currentSegments =
			loadedThreadId === session?.thread.id ? orderedSegments : ([] as StoredRevisedSegment[]);
		const activeRunId = session ? activeCaptureRun(session)?.id : null;
		const rows: RevisionDisplayRow[] = currentSegments.map((segment) => ({
			kind: 'revised',
			id: segment.id,
			runSequence: segment.runSequence,
			sourceStart: segment.sourceStart,
			segment
		}));
		for (const run of session?.runs ?? []) {
			let sourceStart = currentSegments
				.filter((segment) => segment.runId === run.id)
				.reduce((maximum, segment) => Math.max(maximum, segment.sourceEnd), 0);
			if (sourceStart >= run.sourceStream.text.length) continue;
			const capturedEnd =
				activeRequest?.runId === run.id && run.id === activeRunId
					? Math.min(run.sourceStream.text.length, Math.max(sourceStart, activeRequest.openEnd))
					: sourceStart;
			if (capturedEnd > sourceStart) {
				rows.push({
					kind: 'raw',
					id: `raw:${run.id}:${sourceStart}`,
					runId: run.id,
					runSequence: run.sequence,
					sourceStart,
					sourceEnd: capturedEnd,
					rawText: run.sourceStream.text.slice(sourceStart, capturedEnd),
					status: 'capturing'
				});
				sourceStart = capturedEnd;
			}
			if (sourceStart >= run.sourceStream.text.length) continue;
			rows.push({
				kind: 'raw',
				id: `raw:${run.id}:${sourceStart}`,
				runId: run.id,
				runSequence: run.sequence,
				sourceStart,
				sourceEnd: run.sourceStream.text.length,
				rawText: run.sourceStream.text.slice(sourceStart),
				status: run.id === activeRunId ? 'live' : 'unrevised'
			});
		}
		return rows.sort(
			(left, right) => left.runSequence - right.runSequence || left.sourceStart - right.sourceStart
		);
	});

	function liveTailLines(rawText: string, absoluteStart: number): LiveTailLine[] {
		const boundaries = sentenceBoundaries(rawText);
		const lines: LiveTailLine[] = [];
		let start = 0;
		for (const boundary of boundaries) {
			lines.push({ sourceStart: absoluteStart + start, text: rawText.slice(start, boundary.end) });
			start = boundary.end;
		}
		if (start < rawText.length) {
			const tail = rawText.slice(start);
			const previous = lines.at(-1);
			if (previous && tail.trim().length === 0) previous.text += tail;
			else lines.push({ sourceStart: absoluteStart + start, text: tail });
		}
		return lines.length > 0 ? lines : [{ sourceStart: absoluteStart, text: rawText }];
	}

	function batchesForRun(runId: string): StoredRevisionBatch[] {
		return batches
			.filter((batch) => batch.runId === runId)
			.sort((left, right) => left.sequence - right.sequence);
	}

	function segmentsForRun(runId: string): StoredRevisedSegment[] {
		return segments
			.filter((segment) => segment.runId === runId)
			.sort((left, right) => left.sourceStart - right.sourceStart);
	}

	function frozenEndForRun(runId: string): number {
		return (
			segmentsForRun(runId)
				.filter((segment) => segment.state === 'frozen')
				.at(-1)?.sourceEnd ?? 0
		);
	}

	function nextBatchSequence(runId: string): number {
		return (
			batchesForRun(runId).reduce((maximum, batch) => Math.max(maximum, batch.sequence), 0) + 1
		);
	}

	function continuityBefore(
		runSequence: number,
		sourceStart: number
	): SidecarRevisionContextSegment[] {
		const candidates = orderedSegments
			.filter(
				(segment) =>
					segment.state === 'frozen' &&
					(segment.runSequence < runSequence ||
						(segment.runSequence === runSequence && segment.sourceEnd <= sourceStart))
			)
			.slice(-2);
		const result: SidecarRevisionContextSegment[] = [];
		let remaining = REVISION_MAX_CONTINUITY_CHARACTERS;
		for (const segment of [...candidates].reverse()) {
			if (remaining < 2) break;
			const total = segment.revisedSourceText.length + segment.translatedText.length;
			if (total <= remaining) {
				result.unshift({
					revisedSourceText: segment.revisedSourceText,
					translatedText: segment.translatedText
				});
				remaining -= total;
				continue;
			}
			const translationCharacters = Math.min(
				segment.translatedText.length,
				Math.max(1, Math.floor((remaining * segment.translatedText.length) / total))
			);
			const sourceCharacters = Math.min(
				segment.revisedSourceText.length,
				Math.max(1, remaining - translationCharacters)
			);
			result.unshift({
				revisedSourceText: segment.revisedSourceText.slice(-sourceCharacters),
				translatedText: segment.translatedText.slice(-translationCharacters)
			});
			break;
		}
		return result;
	}

	function previousDraft(
		runId: string,
		start: number,
		end: number,
		atoms: readonly SourceClauseAtom[]
	): SidecarRevisionDraftSegment[] {
		const atomStarts = new Set(atoms.map((atom) => atom.start));
		const atomEnds = new Set(atoms.map((atom) => atom.end));
		return segmentsForRun(runId)
			.filter(
				(segment) =>
					segment.state === 'open' &&
					segment.sourceStart >= start &&
					segment.sourceEnd <= end &&
					atomStarts.has(segment.sourceStart) &&
					atomEnds.has(segment.sourceEnd)
			)
			.map((segment) => ({
				sourceStart: segment.sourceStart,
				sourceEnd: segment.sourceEnd,
				rawText: segment.rawText,
				revisedSourceText: segment.revisedSourceText,
				translatedText: segment.translatedText,
				paragraphBreakBefore: segment.paragraphBreakBefore
			}));
	}

	function infrastructureFailure(result: SidecarInvokeResult): boolean {
		return (
			result.status === 'failed' &&
			(result.error.code === 'browser-network-failed' ||
				result.error.code === 'request-timeout' ||
				result.error.code === 'websocket-outcome-unknown' ||
				result.error.code === 'upstream-failed')
		);
	}

	function revisionIssueKey(
		value: Pick<RevisionCandidate, 'runId' | 'openStart' | 'openEnd'>
	): string {
		return `revision:${value.runId}:${value.openStart}:${value.openEnd}`;
	}

	function recoveryIssueKey(value: string): string {
		return `revision-recovery:${value}`;
	}

	function appendBatch(batch: StoredRevisionBatch): void {
		batches = [...batches, batch].sort(
			(left, right) => left.runSequence - right.runSequence || left.sequence - right.sequence
		);
	}

	function numericData(value: string | undefined): number | null {
		if (value === undefined) return null;
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}

	function captureReadingAnchor(runId: string): ReadingAnchor | null {
		if (!scroller) return null;
		if (following) {
			const line = [...scroller.querySelectorAll<HTMLElement>('[data-live-source-line]')].find(
				(element) => element.dataset.runId === runId
			);
			const sourceOffset = numericData(line?.dataset.sourceStart);
			if (line && sourceOffset !== null) {
				return { runId, sourceOffset, top: line.getBoundingClientRect().top, line: true };
			}
		}
		const viewport = scroller.getBoundingClientRect();
		const row = [...scroller.querySelectorAll<HTMLElement>('[data-revision-display-row]')].find(
			(element) => {
				const bounds = element.getBoundingClientRect();
				return bounds.bottom > viewport.top && bounds.top < viewport.bottom;
			}
		);
		const sourceOffset = numericData(row?.dataset.sourceStart);
		if (!row || sourceOffset === null || !row.dataset.runId) return null;
		return {
			runId: row.dataset.runId,
			sourceOffset,
			top: row.getBoundingClientRect().top,
			line: false
		};
	}

	function anchorElement(anchor: ReadingAnchor): HTMLElement | null {
		if (anchor.line) {
			return (
				[...scroller.querySelectorAll<HTMLElement>('[data-live-source-line]')].find(
					(element) =>
						element.dataset.runId === anchor.runId &&
						numericData(element.dataset.sourceStart) === anchor.sourceOffset
				) ?? null
			);
		}
		return (
			[...scroller.querySelectorAll<HTMLElement>('[data-revision-display-row]')].find((element) => {
				if (element.dataset.runId !== anchor.runId) return false;
				const start = numericData(element.dataset.sourceStart);
				const end = numericData(element.dataset.sourceEnd);
				return (
					start !== null &&
					end !== null &&
					start <= anchor.sourceOffset &&
					end > anchor.sourceOffset
				);
			}) ?? null
		);
	}

	async function restoreReadingAnchor(anchor: ReadingAnchor): Promise<void> {
		await tick();
		if (!scroller) return;
		const element = anchorElement(anchor);
		if (element) scroller.scrollTop += element.getBoundingClientRect().top - anchor.top;
	}

	function replaceOpenSegments(runId: string, next: StoredRevisedSegment[]): void {
		const anchor = captureReadingAnchor(runId);
		segments = [
			...segments.filter((segment) => segment.runId !== runId || segment.state === 'frozen'),
			...next
		].sort(
			(left, right) => left.runSequence - right.runSequence || left.sourceStart - right.sourceStart
		);
		if (anchor) void restoreReadingAnchor(anchor);
	}

	async function persistBatch(
		capturedRepository: LocalSessionRepository | null,
		batch: StoredRevisionBatch,
		nextSegments: StoredRevisedSegment[],
		facts: { thread: TranslationSessionState['thread']; run: CaptureRun; checkpointedAt: string }
	): Promise<void> {
		if (!capturedRepository) {
			persistenceMessage = '本地存储不可用；本页关闭后修订对照会丢失。';
			return;
		}
		try {
			await capturedRepository.saveRevisionBatch({
				batch: $state.snapshot(batch),
				segments: $state.snapshot(nextSegments),
				facts: $state.snapshot(facts)
			});
		} catch (error) {
			console.error('[revision-pairs] save failed', error);
			persistenceMessage = `修订对照已生成，但保存到本设备失败。\n${inlineErrorDetails(error)}`;
			emitOperationalLog({
				severity: 'error',
				source: 'storage',
				code: 'revision-save-failed',
				summary: '修订对照已生成，但保存到本设备失败。',
				details: inlineErrorDetails(error),
				threadId: batch.threadId,
				runId: batch.runId,
				requestId: batch.clientRequestId
			});
		}
	}

	function completedSegments(
		candidate: RevisionCandidate,
		batchId: string,
		groups: ValidatedRevisionGroup[],
		updatedAt: string,
		sourceElapsedEndMs: number | null
	): StoredRevisedSegment[] {
		const plan = commitRevisionGroups({
			requestStart: candidate.openStart,
			requestEnd: candidate.openEnd,
			rawText: candidate.sourceText,
			groups,
			finalizing: candidate.finalizing,
			quietForMs: candidate.triggerResult.quietForMs
		});
		return groups.map((group, index) => {
			const state = group.sourceEnd <= plan.frozenEnd ? 'frozen' : 'open';
			return {
				id: `${batchId}:${index + 1}`,
				threadId: session?.thread.id ?? '',
				runId: candidate.runId,
				runSequence: candidate.runSequence,
				sourceStart: group.sourceStart,
				sourceEnd: group.sourceEnd,
				rawText: group.rawText,
				revisedSourceText: group.revisedSourceText,
				translatedText: group.translatedText,
				paragraphBreakBefore: group.paragraphBreakBefore,
				state,
				boundaryState: group.endingBoundary === 'sentence' ? 'complete' : 'forced-tail',
				producedByBatchId: batchId,
				sourceElapsedEndMs,
				frozenAt: state === 'frozen' ? updatedAt : null,
				updatedAt
			};
		});
	}

	function failureBatch(input: {
		candidate: RevisionCandidate;
		batchId: string;
		sequence: number;
		capturedAt: string;
		updatedAt: string;
		clientRequestId: string;
		result: SidecarInvokeResult;
		errorCode?: SidecarErrorCode;
		error?: string;
		threadId: string;
	}): StoredRevisionBatch {
		const { result } = input;
		return {
			id: input.batchId,
			threadId: input.threadId,
			runId: input.candidate.runId,
			runSequence: input.candidate.runSequence,
			sequence: input.sequence,
			openStart: input.candidate.openStart,
			openEnd: input.candidate.openEnd,
			tokenizerVersion: REVISION_TOKENIZER_VERSION,
			taskVersion: REVISION_TASK_VERSION,
			trigger: input.candidate.trigger,
			status: 'failed',
			capturedAt: input.capturedAt,
			completedAt: null,
			model: result.model,
			clientRequestId: input.clientRequestId,
			responseId: result.responseId,
			usageStatus: result.usageStatus,
			usage: result.usage,
			upstreamStatus: result.status === 'failed' ? result.upstreamStatus : null,
			errorCode:
				input.errorCode ?? (result.status === 'failed' ? result.error.code : 'invalid-response'),
			error:
				input.error ??
				(result.status === 'failed'
					? `${result.error.code}：${result.error.message}`
					: 'invalid-response：模型输出无法验证。'),
			diagnostic: result.status === 'failed' ? (result.diagnostic ?? null) : null,
			transportDiagnostic: result.transportDiagnostic ?? null,
			updatedAt: input.updatedAt
		};
	}

	async function requestCandidate(candidate: RevisionCandidate): Promise<boolean> {
		const capturedSession = session;
		const capturedRepository = repository;
		if (!capturedSession || loadedThreadId !== capturedSession.thread.id) return false;
		const capturedThreadId = capturedSession.thread.id;
		const capturedRun = capturedSession.runs.find((run) => run.id === candidate.runId);
		if (!capturedRun) return false;
		const capturedFacts = $state.snapshot({
			thread: capturedSession.thread,
			run: capturedRun,
			checkpointedAt: new Date().toISOString()
		});
		const continuity = continuityBefore(candidate.runSequence, candidate.openStart);
		const draft = previousDraft(
			candidate.runId,
			candidate.openStart,
			candidate.openEnd,
			candidate.atoms
		);
		let previousInvalidAtomRanges: Array<{ firstAtom: number; lastAtom: number }> = [];
		let attempt = 1;
		let sequence = nextBatchSequence(candidate.runId);
		if (candidate.trigger === 'periodic') {
			lastAutomaticRequestAt.set(candidate.runId, statusNowMs);
		}
		if (candidate.finalizingRetryKey) {
			const retry = finalizingRetries.get(candidate.finalizingRetryKey);
			if (retry) finalizingRetries.set(candidate.finalizingRetryKey, { ...retry, consumed: true });
		}
		onRequestingChange(true);
		phase = 'requesting';
		errorMessage = '';

		while (attempt <= 2) {
			const clientRequestId = crypto.randomUUID();
			const batchId = crypto.randomUUID();
			const capturedAt = new Date().toISOString();
			const request: SidecarInvokeRequest = {
				clientRequestId,
				intent: {
					kind: 'revise-pairs',
					trigger: candidate.trigger,
					targetLanguage: candidate.targetLanguage,
					tokenizerVersion: REVISION_TOKENIZER_VERSION,
					atoms: candidate.atoms.map((atom) => ({
						i: atom.index,
						start: atom.start,
						end: atom.end,
						t: atom.text,
						boundary: atom.boundary
					})),
					continuity,
					previousDraft: draft,
					previousInvalidAtomRanges
				},
				context: {
					threadId: capturedThreadId,
					scope: 'latest-run',
					capturedAt,
					continuityText: '',
					cleanedTranscript: '',
					runs: [
						{
							runId: candidate.runId,
							sequence: candidate.runSequence,
							targetLanguage: candidate.targetLanguage,
							sourceText: candidate.sourceText,
							translationText: ''
						}
					]
				}
			};
			worker.beginRequest(clientRequestId, capturedThreadId);
			activeRequest = {
				clientRequestId,
				runId: candidate.runId,
				runSequence: candidate.runSequence,
				batchSequence: sequence,
				capturedAt,
				openStart: candidate.openStart,
				openEnd: candidate.openEnd,
				attempt,
				sourceElapsedEndMs: capturedRun.sourceStream.lastElapsedMs
			};
			let result: SidecarInvokeResult;
			try {
				result = await sendSidecarRequest(request);
			} catch (error) {
				console.error('[revision-pairs] browser request failed', error);
				result = sidecarLocalFailure(
					clientRequestId,
					'invalid-response',
					inlineErrorDetails(error)
				);
			}
			const updatedAt = new Date().toISOString();
			let groups: ValidatedRevisionGroup[] | null = null;
			let boundaryError: RevisionBoundaryError | null = null;
			let validationError: string | null = null;
			if (result.status === 'completed') {
				try {
					groups = parseRevisionModelOutput(result.outputText, candidate.atoms).groups;
				} catch (error) {
					if (error instanceof RevisionBoundaryError) boundaryError = error;
					else validationError = inlineErrorDetails(error);
				}
			} else if (result.error.code === 'invalid-revision-boundary' && result.outputText) {
				try {
					parseRevisionModelOutput(result.outputText, candidate.atoms);
				} catch (error) {
					if (error instanceof RevisionBoundaryError) boundaryError = error;
				}
			}

			if (groups && result.status === 'completed') {
				const nextSegments = reconcileRevisionSegmentPresentation(
					segmentsForRun(candidate.runId).filter((segment) => segment.state === 'open'),
					completedSegments(
						candidate,
						batchId,
						groups,
						updatedAt,
						capturedRun.sourceStream.lastElapsedMs
					).map((segment) => ({ ...segment, threadId: capturedThreadId }))
				);
				const batch: StoredRevisionBatch = {
					id: batchId,
					threadId: capturedThreadId,
					runId: candidate.runId,
					runSequence: candidate.runSequence,
					sequence,
					openStart: candidate.openStart,
					openEnd: candidate.openEnd,
					tokenizerVersion: REVISION_TOKENIZER_VERSION,
					taskVersion: REVISION_TASK_VERSION,
					trigger: candidate.trigger,
					status: 'completed',
					capturedAt,
					completedAt: result.completedAt,
					model: result.model,
					clientRequestId,
					responseId: result.responseId,
					usageStatus: result.usageStatus,
					usage: result.usage,
					upstreamStatus: null,
					errorCode: null,
					error: null,
					diagnostic: null,
					transportDiagnostic: result.transportDiagnostic ?? null,
					updatedAt
				};
				await persistBatch(capturedRepository, batch, nextSegments, capturedFacts);
				if (loadedThreadId === capturedThreadId && worker.ownsRequest(clientRequestId)) {
					appendBatch(batch);
					replaceOpenSegments(candidate.runId, nextSegments);
					for (const correctedFailure of supersededFailedBatches(batches)) {
						resolveOperationalIssue(revisionIssueKey(correctedFailure), 'corrected');
					}
				}
				worker.finishRequest(clientRequestId);
				activeRequest = null;
				onRequestingChange(false);
				phase = 'idle';
				consecutiveInfrastructureFailures = 0;
				recoveryNotBeforeMs = 0;
				reloadRequired = false;
				finalizingRetries.delete(revisionIssueKey(candidate));
				resolveOperationalIssue(revisionIssueKey(candidate), 'corrected');
				resolveOperationalIssue(recoveryIssueKey(capturedThreadId));
				pendingSince.set(candidate.runId, statusNowMs);
				return true;
			}

			const error =
				boundaryError && result.status === 'completed'
					? `invalid-revision-boundary：${boundaryError.name}: ${boundaryError.message}`
					: validationError
						? `invalid-response：${validationError}`
						: undefined;
			const failed = failureBatch({
				candidate,
				batchId,
				sequence,
				capturedAt,
				updatedAt,
				clientRequestId,
				result,
				error,
				errorCode: validationError
					? 'invalid-response'
					: boundaryError && result.status === 'completed'
						? 'invalid-revision-boundary'
						: undefined,
				threadId: capturedThreadId
			});
			await persistBatch(capturedRepository, failed, [], capturedFacts);
			if (loadedThreadId === capturedThreadId && worker.ownsRequest(clientRequestId))
				appendBatch(failed);
			worker.finishRequest(clientRequestId);

			if (boundaryError && attempt === 1) {
				previousInvalidAtomRanges = boundaryError.returnedAtomRanges;
				attempt += 1;
				sequence += 1;
				continue;
			}
			activeRequest = null;
			onRequestingChange(false);
			if (infrastructureFailure(result)) {
				consecutiveInfrastructureFailures += 1;
				const backoffMs = revisionBackoffMs(consecutiveInfrastructureFailures);
				if (backoffMs > 0) {
					recoveryNotBeforeMs = statusNowMs + backoffMs;
					emitOperationalLog({
						severity: 'warning',
						source: 'revision',
						code: 'automatic-backoff',
						summary: `修订服务连续失败，${Math.ceil(backoffMs / 1_000)} 秒后自动恢复。`,
						details: failed.error,
						threadId: capturedThreadId,
						runId: candidate.runId,
						requestId: clientRequestId,
						dedupeKey: recoveryIssueKey(capturedThreadId)
					});
				}
			} else {
				consecutiveInfrastructureFailures = 0;
			}
			if (
				candidate.finalizing &&
				!candidate.finalizingRetryKey &&
				canAutomaticallyRetryFinalizing(result)
			) {
				finalizingRetries.set(revisionIssueKey(candidate), {
					notBeforeMs: statusNowMs + REVISION_FINALIZING_RETRY_DELAY_MS,
					consumed: false
				});
			}
			reloadRequired =
				result.status === 'failed' && result.error.code === 'atomizer-version-mismatch';
			phase = 'idle';
			errorMessage = failed.error ?? '当前修订对照生成失败。';
			emitOperationalLog({
				severity:
					result.status === 'failed' && result.retryDisposition === 'automatic'
						? 'warning'
						: 'error',
				source: 'revision',
				code: result.status === 'failed' ? result.error.code : 'invalid-response',
				summary: reloadRequired
					? '页面与服务端的原文切分版本不同，请刷新页面。'
					: failureSummary(failed.error),
				details: failed.error,
				threadId: capturedThreadId,
				runId: candidate.runId,
				requestId: clientRequestId,
				dedupeKey: revisionIssueKey(candidate)
			});
			return false;
		}
		activeRequest = null;
		onRequestingChange(false);
		phase = 'idle';
		return false;
	}

	function openSegmentsForRun(runId: string): StoredRevisedSegment[] {
		return segmentsForRun(runId).filter((segment) => segment.state === 'open');
	}

	function canFreezeLocally(run: CaptureRun): boolean {
		const open = openSegmentsForRun(run.id);
		if (open.length === 0 || open.at(-1)?.sourceEnd !== run.sourceStream.text.length) return false;
		const active = run.status === 'starting' || run.status === 'live' || run.status === 'stopping';
		if (!active) return true;
		const updatedAt = run.sourceStream.updatedAt
			? Date.parse(run.sourceStream.updatedAt)
			: Number.NaN;
		const quietForMs = Number.isFinite(updatedAt) ? Math.max(0, statusNowMs - updatedAt) : 0;
		return (
			revisionTextEndsNaturally(run.sourceStream.text.slice(open[0].sourceStart)) &&
			quietForMs >= REVISION_QUIET_WINDOW_MS
		);
	}

	function nextLocallyFreezableRun(): CaptureRun | null {
		if (!session) return null;
		const active = activeCaptureRun(session);
		for (const run of session.runs) {
			if (run.id !== active?.id && canFreezeLocally(run)) return run;
		}
		return active && canFreezeLocally(active) ? active : null;
	}

	async function freezeLocally(run: CaptureRun): Promise<void> {
		const capturedThreadId = threadId;
		const capturedRepository = repository;
		if (!capturedThreadId || loadedThreadId !== capturedThreadId) return;
		phase = 'freezing';
		const frozenAt = new Date().toISOString();
		try {
			const next = capturedRepository
				? await capturedRepository.freezeRevisionOpenSegments(capturedThreadId, run.id, frozenAt)
				: segmentsForRun(run.id).map((segment) =>
						segment.state === 'open'
							? {
									...segment,
									state: 'frozen' as const,
									frozenAt
								}
							: segment
					);
			if (loadedThreadId === capturedThreadId) {
				segments = [...segments.filter((segment) => segment.runId !== run.id), ...next].sort(
					(left, right) =>
						left.runSequence - right.runSequence || left.sourceStart - right.sourceStart
				);
			}
			if (!capturedRepository) {
				persistenceMessage = '本地存储不可用；本页关闭后修订对照会丢失。';
			}
		} catch (error) {
			console.error('[revision-pairs] local freeze failed', error);
			persistenceMessage = `修订对照本地冻结失败。\n${inlineErrorDetails(error)}`;
			emitOperationalLog({
				severity: 'error',
				source: 'storage',
				code: 'revision-freeze-failed',
				summary: '修订对照本地冻结失败。',
				details: inlineErrorDetails(error),
				threadId: capturedThreadId,
				runId: run.id
			});
		} finally {
			if (loadedThreadId === capturedThreadId) phase = 'idle';
		}
	}

	function candidateForRun(run: CaptureRun, manual: boolean): RevisionCandidate | null {
		if (!manual && automaticBaselines.has(run.id)) return null;
		const openStart = frozenEndForRun(run.id);
		if (run.sourceStream.text.length <= openStart) {
			pendingSince.delete(run.id);
			return null;
		}
		if (!pendingSince.has(run.id)) pendingSince.set(run.id, statusNowMs);
		const active = run.status === 'starting' || run.status === 'live' || run.status === 'stopping';
		const finalizing = !active;
		const latestBatch = batchesForRun(run.id).at(-1);
		const result = revisionTrigger({
			text: run.sourceStream.text,
			frozenEnd: openStart,
			latestCapturedEnd: latestBatch?.openEnd ?? openStart,
			nowMs: statusNowMs,
			streamUpdatedAt: run.sourceStream.updatedAt,
			pendingSinceMs: pendingSince.get(run.id) ?? null,
			lastAutomaticRequestAtMs: lastAutomaticRequestAt.get(run.id) ?? null,
			manual,
			finalizing
		});
		if (!result.ready || result.capturedSourceEnd <= openStart) return null;
		if (
			!manual &&
			latestBatch?.openStart === openStart &&
			latestBatch.openEnd === result.capturedSourceEnd
		) {
			const key = `revision:${run.id}:${openStart}:${result.capturedSourceEnd}`;
			const retry = finalizing ? finalizingRetries.get(key) : null;
			if (!retry || retry.consumed || statusNowMs < retry.notBeforeMs) return null;
		}
		const atoms = sourceClauseAtoms(run.sourceStream.text, openStart, result.capturedSourceEnd);
		return {
			runId: run.id,
			runSequence: run.sequence,
			targetLanguage: run.targetLanguage,
			sourceText: run.sourceStream.text.slice(openStart, result.capturedSourceEnd),
			openStart,
			openEnd: result.capturedSourceEnd,
			atoms,
			trigger: manual ? 'manual' : finalizing ? 'finalizing' : 'periodic',
			finalizing,
			triggerResult: result,
			finalizingRetryKey:
				!manual && finalizing && latestBatch?.openEnd === result.capturedSourceEnd
					? `revision:${run.id}:${openStart}:${result.capturedSourceEnd}`
					: null
		};
	}

	function nextCandidate(manual: boolean): RevisionCandidate | null {
		if (!session) return null;
		const active = activeCaptureRun(session);
		for (const run of session.runs) {
			if (run.id === active?.id) continue;
			const candidate = candidateForRun(run, manual);
			if (candidate) return candidate;
		}
		return active ? candidateForRun(active, manual) : null;
	}

	async function processManual(): Promise<void> {
		if (
			disabled ||
			phase === 'loading' ||
			phase === 'requesting' ||
			phase === 'freezing' ||
			!session
		)
			return;
		phase = 'idle';
		consecutiveInfrastructureFailures = 0;
		recoveryNotBeforeMs = 0;
		errorMessage = '';
		for (const run of session.runs) automaticBaselines.delete(run.id);
		while (true) {
			const candidate = nextCandidate(true);
			if (!candidate || !(await requestCandidate(candidate))) return;
			if (!candidate.finalizing) return;
		}
	}

	async function loadProjection(
		nextThreadId: string | null,
		nextRepository: LocalSessionRepository | null
	): Promise<void> {
		const generation = worker.beginLoad();
		batches = [];
		segments = [];
		automaticBaselines.clear();
		pendingSince.clear();
		lastAutomaticRequestAt.clear();
		finalizingRetries.clear();
		recoveryNotBeforeMs = 0;
		reloadRequired = false;
		errorMessage = '';
		persistenceMessage = '';
		loadedThreadId = null;
		phase = worker.requesting ? 'requesting' : nextThreadId ? 'loading' : 'idle';
		if (!nextThreadId) return;
		if (nextRepository) {
			try {
				const stored = await nextRepository.loadRevisionProjection(nextThreadId);
				if (!worker.ownsLoad(generation) || session?.thread.id !== nextThreadId) return;
				batches = stored.batches;
				segments = stored.segments;
			} catch (error) {
				console.error('[revision-pairs] restore failed', error);
				persistenceMessage = `修订对照记录读取失败；本页仍可继续生成。\n${inlineErrorDetails(error)}`;
				emitOperationalLog({
					severity: 'error',
					source: 'storage',
					code: 'revision-restore-failed',
					summary: '修订对照记录读取失败；本页仍可继续生成。',
					details: inlineErrorDetails(error),
					threadId: nextThreadId
				});
			}
		}
		if (!worker.ownsLoad(generation) || session?.thread.id !== nextThreadId) return;
		const activeRunId = session ? activeCaptureRun(session)?.id : null;
		for (const run of session?.runs ?? []) {
			if (segments.some((segment) => segment.runId === run.id)) continue;
			if (run.id === activeRunId) continue;
			automaticBaselines.set(run.id, run.sourceStream.text.length);
		}
		loadedThreadId = nextThreadId;
		phase = worker.requesting ? 'requesting' : 'idle';
	}

	function updateFollow(): void {
		following = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
	}

	function resumeFollowing(): void {
		following = true;
		scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
	}

	function revealLatestContent(): void {
		if (!following || !scroller) return;
		const rawLines = scroller.querySelectorAll<HTMLElement>('[data-follow-source-line]');
		const latest = rawLines.item(rawLines.length - 1) ?? scroller.lastElementChild;
		if (!(latest instanceof HTMLElement)) return;
		const viewportBottom = scroller.getBoundingClientRect().bottom;
		const overflow = latest.getBoundingClientRect().bottom - viewportBottom;
		if (overflow > 0) scroller.scrollTop += overflow;
	}

	function requestTime(timestamp: string): string {
		const parsed = new Date(timestamp);
		return Number.isNaN(parsed.getTime()) ? timestamp : parsed.toLocaleTimeString();
	}

	function courseTime(elapsedMs: number | null): string {
		if (elapsedMs === null) return '未知';
		const totalSeconds = Math.floor(elapsedMs / 1_000);
		return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
	}

	function waitingStatus(): string {
		const run = session ? (activeCaptureRun(session) ?? session.runs.at(-1)) : null;
		if (!run) return '等待 Live 原文。';
		const frozen = segmentsForRun(run.id)
			.filter((segment) => segment.state === 'frozen')
			.at(-1);
		const start = frozen?.sourceEnd ?? 0;
		const pending = Math.max(0, run.sourceStream.text.length - start);
		const trigger = revisionTrigger({
			text: run.sourceStream.text,
			frozenEnd: start,
			latestCapturedEnd: batchesForRun(run.id).at(-1)?.openEnd ?? start,
			nowMs: statusNowMs,
			streamUpdatedAt: run.sourceStream.updatedAt,
			pendingSinceMs: pendingSince.get(run.id) ?? null,
			lastAutomaticRequestAtMs: lastAutomaticRequestAt.get(run.id) ?? null,
			manual: false,
			finalizing: false
		});
		const reason =
			trigger.waitingFor === 'nothing'
				? '等待新原文'
				: trigger.waitingFor === 'request-interval'
					? diagnosticsMode
						? `请求间隔 ${Math.ceil(trigger.requestIntervalRemainingMs / 1_000)} 秒`
						: '等待标点或短暂停顿'
					: trigger.waitingFor === 'punctuation-or-quiet'
						? '等待标点或短暂停顿'
						: '准备修订';
		const readingStatus = `第 ${run.sequence} 段 · 冻结至约 ${courseTime(frozen?.sourceElapsedEndMs ?? null)} · ${reason}`;
		const transport = batchesForRun(run.id).at(-1)?.transportDiagnostic;
		return diagnosticsMode
			? `${readingStatus} · 开放区 ${pending} 字 · 累计 ${totalTokens} tokens${transport ? ` · ${transport.transport}/${transport.chainAction} · turn ${transport.chainTurn ?? '—'} · ${transport.completedMs ?? '—'} ms` : ''}`
			: readingStatus;
	}

	function failureSummary(error: string | null): string {
		return (error?.split('\n', 1)[0] ?? '未知错误').slice(0, 180);
	}

	function recentlyChanged(timestamp: string): boolean {
		const changedAt = Date.parse(timestamp);
		return Number.isFinite(changedAt) && statusNowMs - changedAt < 2_000;
	}

	function metric(value: number | null, suffix = ''): string {
		return value === null ? '暂无' : `${value}${suffix}`;
	}

	$effect(() => {
		const nextThreadId = threadId;
		const nextRepository = repository;
		untrack(() => void loadProjection(nextThreadId, nextRepository));
	});

	$effect(() => {
		if (!threadId) return;
		statusNowMs = Date.now();
		const timer = window.setInterval(() => (statusNowMs = Date.now()), 1_000);
		return () => window.clearInterval(timer);
	});

	$effect(() => {
		const currentThreadId = threadId;
		if (
			!currentThreadId ||
			loadedThreadId !== currentThreadId ||
			disabled ||
			phase !== 'idle' ||
			reloadRequired ||
			statusNowMs < recoveryNotBeforeMs ||
			document.visibilityState !== 'visible' ||
			!navigator.onLine
		)
			return;
		const freezable = nextLocallyFreezableRun();
		if (freezable) {
			void freezeLocally(freezable);
			return;
		}
		const candidate = nextCandidate(false);
		if (candidate) void requestCandidate(candidate);
	});

	$effect(() => {
		const latest = displayRows.at(-1);
		const latestRevision =
			latest?.kind === 'raw'
				? `${latest.id}:${latest.sourceEnd}`
				: latest
					? `${latest.id}:${latest.segment.updatedAt}`
					: null;
		if (!latestRevision) return;
		void tick().then(() => {
			revealLatestContent();
		});
	});
</script>

<section class="panel" aria-labelledby="revision-pairs-title">
	<header>
		<div>
			<p class="eyebrow">REVISED TRANSCRIPT</p>
			<h3 id="revision-pairs-title">修订原文 · 对照译文</h3>
		</div>
		<button
			type="button"
			disabled={disabled ||
				phase === 'loading' ||
				phase === 'requesting' ||
				phase === 'freezing' ||
				!session}
			onclick={() => (reloadRequired ? location.reload() : void processManual())}
		>
			{reloadRequired ? '刷新页面' : recoveryNotBeforeMs > statusNowMs ? '立即恢复' : '整理全部'}
		</button>
	</header>

	<div class="status" aria-live="polite">
		{#if phase === 'loading'}
			正在读取本地修订对照…
		{:else if phase === 'requesting' && activeRequest}
			正在修订第 {activeRequest.runSequence} 段 · 课程约 {courseTime(
				activeRequest.sourceElapsedEndMs
			)} · 已等待 {Math.max(
				0,
				Math.floor((statusNowMs - Date.parse(activeRequest.capturedAt)) / 1_000)
			)} 秒{#if diagnosticsMode}
				· 第 {activeRequest.batchSequence} 批 · 第
				{activeRequest.attempt} 次 · {requestTime(activeRequest.capturedAt)} 发起 · raw
				{activeRequest.openStart}–{activeRequest.openEnd} · 此前累计 {totalTokens} tokens{/if}
		{:else if phase === 'freezing'}
			正在本地冻结已完成的开放段（不会调用模型）…
		{:else if reloadRequired}
			版本已更新，请刷新页面后继续修订。
		{:else if recoveryNotBeforeMs > statusNowMs}
			修订服务暂时不可用 · {Math.ceil((recoveryNotBeforeMs - statusNowMs) / 1_000)} 秒后自动重试
		{:else}
			{waitingStatus()}
		{/if}
	</div>
	{#if diagnosticsMode && transportSummary.total > 0}
		<details class="transport-observability">
			<summary>
				WebSocket 链命中 {transportSummary.continued}/{transportSummary.websocket}（{metric(
					transportSummary.chainHitRate === null
						? null
						: Math.round(transportSummary.chainHitRate * 100),
					'%'
				)}）· 全部传输完整结果平均 {metric(transportSummary.averageCompletedMs, ' ms')}
			</summary>
			<div>
				<span>
					bootstrap {transportSummary.bootstrap} · rebuilt {transportSummary.rebuilt} · HTTP 回退
					{transportSummary.httpFallback}
				</span>
				{#each transportSummary.turnBuckets as bucket (bucket.label)}
					<span>
						{bucket.label}：{bucket.count} 批 · 平均输入 {metric(
							bucket.averageInputTokens,
							' tokens'
						)} · 平均缓存 {metric(bucket.averageCachedInputTokens, ' tokens')} · 平均完成
						{metric(bucket.averageCompletedMs, ' ms')}
					</span>
				{/each}
				<span
					>长段 {longGroupSummary.long}/{longGroupSummary.total}（&gt; {REVISION_LONG_GROUP_CHARACTERS}
					字）</span
				>
				<span>
					未解决失败：{transportSummary.failures.length === 0
						? '无'
						: transportSummary.failures
								.map((failure) => `${failure.code} ${failure.count}`)
								.join(' · ')} · 已纠正尝试 {transportSummary.correctedFailures}
				</span>
			</div>
		</details>
	{/if}

	<div class="column-head" aria-hidden="true"><span>修订原文</span><span>对照译文</span></div>
	<div class="pairs-scroll" bind:this={scroller} onscroll={updateFollow}>
		{#if displayRows.length === 0 && visibleFailedBatches.length === 0}
			<p class="placeholder">开始后，Live 原文会立即显示在这里，再由 Luna 回望修订。</p>
		{/if}
		{#each displayRows as row (row.id)}
			{#if row.kind === 'revised'}
				{#key row.segment.updatedAt}
					<div
						class:paragraph-break={row.segment.paragraphBreakBefore}
						class:recently-changed={recentlyChanged(row.segment.updatedAt)}
						class="pair-row revision-row"
						data-revision-display-row
						data-run-id={row.segment.runId}
						data-source-start={row.segment.sourceStart}
						data-source-end={row.segment.sourceEnd}
					>
						<div class="source">{row.segment.revisedSourceText}</div>
						<div class="translation">{row.segment.translatedText}</div>
						<details class="raw-evidence" open={diagnosticsMode}>
							<summary aria-label="查看 Live 原文片段" title="查看 Live 原文片段">
								<span class="evidence-icon" aria-hidden="true">↳</span>
								{#if diagnosticsMode}
									<span>Live 原文片段 · raw {row.segment.sourceStart}–{row.segment.sourceEnd}</span>
								{/if}
							</summary>
							<code>{row.segment.rawText}</code>
						</details>
						{#if row.segment.state === 'open'}<span class="open-badge">修订中</span>{/if}
						{#if row.segment.sourceEnd - row.segment.sourceStart > REVISION_LONG_GROUP_CHARACTERS}
							<span class="long-badge">长段</span>
						{/if}
						{#if row.segment.boundaryState === 'forced-tail'}<span class="forced-badge">句未完</span
							>{/if}
					</div>
				{/key}
			{:else}
				<div
					class="pair-row"
					class:capturing-row={row.status === 'capturing'}
					class:live-row={row.status === 'live'}
					class:unrevised-row={row.status === 'unrevised'}
					data-revision-display-row
					data-run-id={row.runId}
					data-source-start={row.sourceStart}
					data-source-end={row.sourceEnd}
					data-capturing-source-tail={row.status === 'capturing' ? row.runId : undefined}
					data-live-source-tail={row.status === 'live' ? row.runId : undefined}
					data-unrevised-source-tail={row.status === 'unrevised' ? row.runId : undefined}
				>
					<div class="source live-source">
						{#each liveTailLines(row.rawText, row.sourceStart) as line (line.sourceStart)}<span
								data-follow-source-line={row.status !== 'unrevised' ? true : undefined}
								data-live-source-line={row.status === 'live' ? true : undefined}
								data-run-id={row.runId}
								data-source-start={line.sourceStart}>{line.text}</span
							>{/each}
					</div>
					<div
						class="translation live-translation"
						aria-label={row.status === 'capturing' ? '正在生成修订译文' : '等待修订译文'}
					></div>
					<span
						class:live-badge={row.status === 'live'}
						class:unrevised-badge={row.status === 'unrevised'}
						class:capturing-badge={row.status === 'capturing'}
					>
						{row.status === 'live' ? '实时' : row.status === 'capturing' ? '回望中' : '未修订'}
					</span>
					{#if diagnosticsMode}<span class="raw-range">raw {row.sourceStart}–{row.sourceEnd}</span
						>{/if}
				</div>
			{/if}
		{/each}
		{#each visibleFailedBatches as batch (batch.id)}
			<details
				class="failed"
				class:corrected={supersededFailureIds.has(batch.id)}
				open={diagnosticsMode}
			>
				<summary>
					{#if supersededFailureIds.has(batch.id)}
						第 {batch.runSequence} 段的早期尝试已纠正
					{:else}
						第 {batch.runSequence} 段未修订成功
					{/if}
					· {failureSummary(batch.error)}
				</summary>
				<span>raw {batch.openStart}–{batch.openEnd} · request {batch.clientRequestId}</span>
				{#if batch.diagnostic}
					<span>
						耗时 {batch.diagnostic.durationMs ?? '未知'} ms · 页面 {batch.diagnostic
							.visibilityState ?? '未知'}
						· online {String(batch.diagnostic.online ?? '未知')} · HTTP {batch.diagnostic
							.httpStatus ?? '未收到'}
					</span>
				{/if}
				{#if batch.transportDiagnostic}
					<span>
						传输 {batch.transportDiagnostic.transport} · 链 {batch.transportDiagnostic.chainAction}
						· turn {batch.transportDiagnostic.chainTurn ?? '—'} · stream {batch.transportDiagnostic
							.streamId ?? '—'} · 首事件 {batch.transportDiagnostic.firstEventMs ?? '—'} ms · 完成 {batch
							.transportDiagnostic.completedMs ?? '—'} ms
					</span>
					{#if batch.transportDiagnostic.fallbackError}
						<code>WebSocket 发送前失败：{batch.transportDiagnostic.fallbackError}</code>
					{/if}
				{/if}
				<code>{batch.error}</code>
			</details>
		{/each}
	</div>

	<footer>
		<div>
			{#if footerErrorMessage}
				<details class="error" role="alert" open={diagnosticsMode}>
					<summary>{failureSummary(footerErrorMessage)}</summary>
					<code>{footerErrorMessage}</code>
				</details>
			{/if}
			{#if persistenceMessage}<span class="warning">{persistenceMessage}</span>{/if}
		</div>
		{#if !following}<button type="button" class="secondary" onclick={resumeFollowing}
				>回到最新</button
			>{/if}
	</footer>
</section>

<style>
	.panel {
		padding: 16px;
		border: 1px solid #29322e;
		border-radius: 14px;
		background: #090d0c;
	}
	header,
	footer,
	.column-head,
	.pair-row {
		display: flex;
	}
	header,
	footer {
		align-items: center;
		justify-content: space-between;
		gap: 14px;
	}
	.eyebrow {
		margin: 0 0 2px;
		color: #72b39e;
		font-size: 9px;
		font-weight: 800;
		letter-spacing: 0.15em;
	}
	h3 {
		margin: 0;
		font-size: 17px;
	}
	button {
		padding: 8px 11px;
		border: 1px solid #415149;
		border-radius: 9px;
		background: #122019;
		color: #d9eee6;
		font: inherit;
		font-size: 12px;
		font-weight: 700;
		cursor: pointer;
	}
	button:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}
	.status {
		margin-top: 12px;
		padding: 9px 11px;
		border-radius: 8px;
		background: #101714;
		color: #9eaaa4;
		font-size: 12px;
	}
	.transport-observability {
		margin: 0 0 10px;
		padding: 8px 10px;
		border: 1px solid #26342e;
		border-radius: 8px;
		color: #aabbb4;
		font-size: 11px;
	}
	.transport-observability summary {
		cursor: pointer;
	}
	.transport-observability div {
		display: grid;
		gap: 3px;
		margin-top: 7px;
	}
	.column-head {
		margin-top: 12px;
		padding: 0 12px 7px;
		color: #72b39e;
		font-size: 10px;
		font-weight: 800;
		letter-spacing: 0.08em;
	}
	.column-head span,
	.source,
	.translation {
		flex: 1 1 0;
		min-width: 0;
	}
	.column-head span + span,
	.translation {
		margin-left: 18px;
	}
	.pairs-scroll {
		max-height: 46vh;
		overflow: auto;
		overflow-anchor: none;
		border-top: 1px solid #202824;
		border-bottom: 1px solid #202824;
	}
	.pair-row {
		position: relative;
		flex-wrap: wrap;
		padding: 10px 12px;
		border-top: 1px solid #181f1c;
		font-size: 16px;
		line-height: 1.55;
	}
	.pair-row:first-child {
		border-top: 0;
	}
	.pair-row.paragraph-break {
		border-top-color: #27312d;
	}
	.revision-row.recently-changed {
		animation: revision-changed 9s ease-out;
	}
	@keyframes revision-changed {
		from {
			background: rgb(114 179 158 / 10%);
		}
		to {
			background: transparent;
		}
	}
	.translation {
		color: #c9e8dd;
	}
	.live-row {
		background: #0d1411;
	}
	.capturing-row {
		background: #0e1512;
	}
	.unrevised-row {
		background: #101210;
	}
	.live-source {
		color: #aebbb5;
	}
	.live-source span {
		display: block;
	}
	.live-translation,
	.raw-range {
		color: #718078;
	}
	.raw-evidence {
		position: absolute;
		right: 8px;
		bottom: 4px;
		color: #718078;
		font-size: 10px;
	}
	.raw-evidence[open] {
		position: static;
		flex: 0 0 100%;
		margin-top: 3px;
	}
	.raw-evidence summary {
		width: fit-content;
		cursor: pointer;
		list-style: none;
	}
	.raw-evidence summary::-webkit-details-marker {
		display: none;
	}
	.evidence-icon {
		display: inline-grid;
		width: 18px;
		height: 18px;
		place-items: center;
		border: 1px solid #2b3732;
		border-radius: 50%;
		color: #75827c;
	}
	.raw-evidence code {
		display: block;
		margin-top: 5px;
		white-space: pre-wrap;
		word-break: break-word;
	}
	.open-badge,
	.long-badge,
	.forced-badge,
	.capturing-badge,
	.live-badge,
	.unrevised-badge,
	.raw-range {
		position: absolute;
		right: 8px;
		font-size: 9px;
		color: #819088;
	}
	.open-badge,
	.capturing-badge,
	.live-badge,
	.unrevised-badge {
		top: 4px;
	}
	.live-badge {
		color: #72b39e;
	}
	.capturing-badge {
		color: #8ba99e;
	}
	.long-badge {
		top: 4px;
		right: 42px;
		color: #b7a77d;
	}
	.unrevised-badge {
		color: #b7a77d;
	}
	.forced-badge {
		bottom: 4px;
		right: 34px;
		color: #c6a56f;
	}
	.raw-range {
		bottom: 4px;
	}
	.placeholder {
		margin: 0;
		padding: 24px 12px;
		color: #718078;
		font-size: 13px;
	}
	.failed {
		margin: 10px 12px;
		padding: 10px;
		border: 1px solid #553d36;
		border-radius: 8px;
		color: #d8a99c;
		font-size: 11px;
	}
	.failed summary {
		cursor: pointer;
		font-weight: 700;
	}
	.failed.corrected {
		border-color: #34423c;
		color: #91a59c;
	}
	.failed span,
	.failed code {
		display: block;
		margin-top: 5px;
		white-space: pre-wrap;
		word-break: break-word;
	}
	footer {
		align-items: flex-start;
		margin-top: 10px;
	}
	footer > div {
		display: grid;
		gap: 5px;
	}
	.error,
	.warning {
		white-space: pre-wrap;
		font-size: 11px;
	}
	.error {
		color: #e2a090;
	}
	.error summary {
		cursor: pointer;
	}
	.error code {
		display: block;
		margin-top: 5px;
		white-space: pre-wrap;
	}
	.warning {
		color: #cdb17d;
	}
	.secondary {
		background: transparent;
	}
	@media (max-width: 720px) {
		.column-head {
			display: none;
		}
		.pair-row {
			display: grid;
			gap: 8px;
		}
		.translation {
			margin-left: 0;
			padding-top: 8px;
			border-top: 1px solid #1c2823;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.revision-row.recently-changed {
			animation: none;
		}
	}
</style>
