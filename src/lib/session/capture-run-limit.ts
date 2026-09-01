export const CAPTURE_RUN_DURATION_LIMIT_MS = 2 * 60 * 60 * 1_000;
export const CAPTURE_RUN_DURATION_WARNING_MS = 5 * 60 * 1_000;

export function captureRunRemainingMs(
	mediaStartedAt: string | null,
	nowMs: number,
	limitMs = CAPTURE_RUN_DURATION_LIMIT_MS
): number | null {
	if (!mediaStartedAt) return null;
	const startedAtMs = Date.parse(mediaStartedAt);
	if (!Number.isFinite(startedAtMs)) return null;
	return Math.max(0, limitMs - Math.max(0, nowMs - startedAtMs));
}

export function formatRemainingDuration(remainingMs: number): string {
	const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1_000));
	const hours = Math.floor(totalSeconds / 3_600);
	const minutes = Math.floor((totalSeconds % 3_600) / 60);
	const seconds = totalSeconds % 60;
	return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
