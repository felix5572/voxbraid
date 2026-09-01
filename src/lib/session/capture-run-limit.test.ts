import { describe, expect, it } from 'vitest';
import {
	CAPTURE_RUN_DURATION_LIMIT_MS,
	captureRunRemainingMs,
	formatRemainingDuration
} from './capture-run-limit';

describe('capture run duration protection', () => {
	it('starts from media connection time and reaches zero at the limit', () => {
		const startedAt = '2026-09-01T10:00:00.000Z';
		const startMs = Date.parse(startedAt);

		expect(captureRunRemainingMs(startedAt, startMs)).toBe(CAPTURE_RUN_DURATION_LIMIT_MS);
		expect(captureRunRemainingMs(startedAt, startMs + CAPTURE_RUN_DURATION_LIMIT_MS)).toBe(0);
		expect(captureRunRemainingMs(startedAt, startMs + CAPTURE_RUN_DURATION_LIMIT_MS + 1)).toBe(0);
	});

	it('does not start before media is connected', () => {
		expect(captureRunRemainingMs(null, Date.now())).toBeNull();
		expect(captureRunRemainingMs('invalid', Date.now())).toBeNull();
	});

	it('formats the remaining wall time for the live display', () => {
		expect(formatRemainingDuration(7_200_000)).toBe('2:00:00');
		expect(formatRemainingDuration(1_001)).toBe('0:00:02');
		expect(formatRemainingDuration(0)).toBe('0:00:00');
	});
});
