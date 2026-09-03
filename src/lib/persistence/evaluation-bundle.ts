import type { OperationalLogEntry } from '../operational-log';
import { REVISION_LONG_GROUP_CHARACTERS } from '../projection/revision-constants';
import { revisionTransportSummary } from '../projection/revision-transport-summary';
import {
	REALTIME_TRANSLATION_MODEL,
	REALTIME_TRANSLATION_PRICING,
	estimateRealtimeUsage
} from '../realtime/usage-estimate';
import type { ModelUsage, ModelUsageStatus } from '../sidecar/types';
import type { SessionArchive } from './session-archive';

export const EVALUATION_BUNDLE_VERSION = 1 as const;

export interface EvaluationBundleBuild {
	commitSha: string;
	commitMessage: string;
	dirty: boolean;
}

export interface EvaluationBundleCaptureSettings {
	scope: 'export-time-ui';
	transcriptionModel: string;
	noiseReduction: string;
	targetLanguage: string;
}

export interface EvaluationBundleOptions {
	exportedAt: string;
	build: EvaluationBundleBuild;
	captureSettings: EvaluationBundleCaptureSettings;
	realtimeDiagnostic: unknown;
	officialUsageSnapshot: unknown;
}

interface UsageRecord {
	model: string | null;
	usageStatus: ModelUsageStatus;
	usage: ModelUsage | null;
}

function usageSummary(records: readonly UsageRecord[]) {
	const recorded = records.filter(
		(record): record is UsageRecord & { usage: ModelUsage } =>
			record.usageStatus === 'recorded' && record.usage !== null
	);
	return {
		records: records.length,
		recorded: recorded.length,
		unavailable: records.length - recorded.length,
		inputTokens: recorded.reduce((total, record) => total + record.usage.inputTokens, 0),
		cachedInputTokens: recorded.reduce(
			(total, record) => total + (record.usage.cachedInputTokens ?? 0),
			0
		),
		outputTokens: recorded.reduce((total, record) => total + record.usage.outputTokens, 0),
		reasoningTokens: recorded.reduce(
			(total, record) => total + (record.usage.reasoningTokens ?? 0),
			0
		),
		totalTokens: recorded.reduce((total, record) => total + record.usage.totalTokens, 0),
		models: [...new Set(records.flatMap((record) => (record.model ? [record.model] : [])))].sort()
	};
}

export function evaluationBundle(
	archive: SessionArchive,
	operationalLogs: readonly OperationalLogEntry[],
	options: EvaluationBundleOptions
) {
	const cleanRecords: UsageRecord[] = [
		...(archive.cleanTranscriptProjection.legacySummary
			? [archive.cleanTranscriptProjection.legacySummary]
			: []),
		...archive.cleanTranscriptProjection.blocks
	];
	const revisionRecords: UsageRecord[] = archive.revisionProjection.batches;
	const cleanUsage = usageSummary(cleanRecords);
	const revisionUsage = usageSummary(revisionRecords);
	const realtime = estimateRealtimeUsage(archive.runs, Date.parse(options.exportedAt));
	const translationPrice = REALTIME_TRANSLATION_PRICING.components.find(
		(component) => component.model === REALTIME_TRANSLATION_MODEL
	);
	const transcriptionPrice = REALTIME_TRANSLATION_PRICING.components.find(
		(component) => component.model !== REALTIME_TRANSLATION_MODEL
	);
	if (!translationPrice || !transcriptionPrice) {
		throw new Error('Realtime pricing snapshot is incomplete.');
	}
	const relevantLogs = operationalLogs.filter(
		(entry) => entry.threadId === archive.thread.id || entry.threadId === null
	);
	const sourceCharacters = archive.runs.reduce(
		(total, run) => total + run.sourceStream.text.length,
		0
	);
	const cleanedSourceCharacters = archive.cleanTranscriptProjection.blocks.reduce(
		(total, block) =>
			total + (block.status === 'completed' ? block.sourceEnd - block.sourceStart : 0),
		0
	);
	const revisedSourceCharacters = archive.revisionProjection.segments.reduce(
		(total, segment) => total + segment.sourceEnd - segment.sourceStart,
		0
	);
	const longRevisionGroups = archive.revisionProjection.segments.filter(
		(segment) => segment.sourceEnd - segment.sourceStart > REVISION_LONG_GROUP_CHARACTERS
	).length;

	const details = {
		kind: 'voxbraid-evaluation-bundle' as const,
		schemaVersion: EVALUATION_BUNDLE_VERSION,
		exportedAt: options.exportedAt,
		producer: { name: 'VoxBraid', ...options.build },
		captureSettings: options.captureSettings,
		limitations: [
			'captureSettings describes the UI selection at export time, not a per-run persisted configuration history.',
			'realtimeLatestRun contains at most the latest in-memory report for this thread and is capped by the runtime diagnostic event limit.',
			'free conversation turns are not persisted and are absent from this bundle.',
			'superseded successful revision drafts are not retained; projections.revision.segments contains the current readable projection.',
			'clean-transcript failureAttempts do not retain per-attempt usage; no missing token values are inferred.'
		],
		facts: {
			thread: archive.thread,
			runs: archive.runs
		},
		projections: {
			legacyAlignedSegments: archive.segments,
			cleanTranscript: archive.cleanTranscriptProjection,
			revision: archive.revisionProjection
		},
		usage: {
			realtimeEstimate: {
				...realtime,
				pricingSnapshot: {
					verifiedAt: REALTIME_TRANSLATION_PRICING.verifiedAt,
					usdPerMinute: REALTIME_TRANSLATION_PRICING.usdPerMinute,
					components: [
						{
							role: 'translation',
							model: REALTIME_TRANSLATION_MODEL,
							usdPerMinute: translationPrice.usdPerMinute
						},
						{
							role: 'transcription',
							model: options.captureSettings.transcriptionModel,
							usdPerMinute: transcriptionPrice.usdPerMinute
						}
					]
				}
			},
			cleanTranscript: cleanUsage,
			revision: revisionUsage,
			persistedProjectionTasks: {
				inputTokens: cleanUsage.inputTokens + revisionUsage.inputTokens,
				cachedInputTokens: cleanUsage.cachedInputTokens + revisionUsage.cachedInputTokens,
				outputTokens: cleanUsage.outputTokens + revisionUsage.outputTokens,
				reasoningTokens: cleanUsage.reasoningTokens + revisionUsage.reasoningTokens,
				totalTokens: cleanUsage.totalTokens + revisionUsage.totalTokens
			},
			officialAccountSnapshot: options.officialUsageSnapshot
		},
		metrics: {
			characters: {
				source: sourceCharacters,
				realtimeTranslation: archive.runs.reduce(
					(total, run) => total + run.translationStream.text.length,
					0
				),
				cleanTranscript: archive.cleanTranscriptProjection.blocks.reduce(
					(total, block) => total + (block.status === 'completed' ? block.text.length : 0),
					archive.cleanTranscriptProjection.legacySummary?.text.length ?? 0
				),
				revisedSource: archive.revisionProjection.segments.reduce(
					(total, segment) => total + segment.revisedSourceText.length,
					0
				),
				revisedTranslation: archive.revisionProjection.segments.reduce(
					(total, segment) => total + segment.translatedText.length,
					0
				)
			},
			cleanTranscript: {
				completedBlocks: archive.cleanTranscriptProjection.blocks.filter(
					(block) => block.status === 'completed'
				).length,
				failedBlocks: archive.cleanTranscriptProjection.blocks.filter(
					(block) => block.status === 'failed'
				).length,
				sourceCharactersCovered: cleanedSourceCharacters,
				sourceCoverage: sourceCharacters === 0 ? null : cleanedSourceCharacters / sourceCharacters
			},
			revision: {
				segments: archive.revisionProjection.segments.length,
				frozenSegments: archive.revisionProjection.segments.filter(
					(segment) => segment.state === 'frozen'
				).length,
				openSegments: archive.revisionProjection.segments.filter(
					(segment) => segment.state === 'open'
				).length,
				longGroups: longRevisionGroups,
				longGroupThresholdCharacters: REVISION_LONG_GROUP_CHARACTERS,
				longGroupRate:
					archive.revisionProjection.segments.length === 0
						? null
						: longRevisionGroups / archive.revisionProjection.segments.length,
				sourceCharactersCovered: revisedSourceCharacters,
				sourceCoverage: sourceCharacters === 0 ? null : revisedSourceCharacters / sourceCharacters
			},
			revisionTransport: revisionTransportSummary(archive.revisionProjection.batches),
			operationalLogs: {
				total: relevantLogs.length,
				activeWarnings: relevantLogs.filter(
					(entry) => entry.state === 'active' && entry.severity === 'warning'
				).length,
				activeErrors: relevantLogs.filter(
					(entry) => entry.state === 'active' && entry.severity === 'error'
				).length
			}
		},
		diagnostics: {
			operationalLogs: relevantLogs,
			realtimeLatestRun: options.realtimeDiagnostic
		}
	};

	return {
		kind: details.kind,
		schemaVersion: details.schemaVersion,
		exportedAt: details.exportedAt,
		summary: {
			usage: details.usage,
			metrics: details.metrics,
			limitations: details.limitations
		},
		producer: details.producer,
		captureSettings: details.captureSettings,
		limitations: details.limitations,
		facts: details.facts,
		projections: details.projections,
		usage: details.usage,
		metrics: details.metrics,
		diagnostics: details.diagnostics
	};
}

export type EvaluationBundle = ReturnType<typeof evaluationBundle>;

export function stringifyEvaluationBundle(
	archive: SessionArchive,
	operationalLogs: readonly OperationalLogEntry[],
	options: EvaluationBundleOptions
): string {
	return JSON.stringify(evaluationBundle(archive, operationalLogs, options), null, 2);
}
