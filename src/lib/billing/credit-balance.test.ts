import { describe, expect, it } from 'vitest';
import {
	createCreditBalanceAnchor,
	estimateCreditBalance,
	estimateRemainingAudioHours,
	isCreditBalanceAnchor
} from './credit-balance';

describe('credit balance estimate', () => {
	it('subtracts later official account costs from a local balance calibration', () => {
		const anchor = createCreditBalanceAnchor(
			10,
			{ periodStart: '2026-01-01T00:00:00.000Z', accountCostUsd: 7.5 },
			'2026-09-03T10:00:00.000Z'
		);

		expect(
			estimateCreditBalance(anchor, {
				periodStart: '2026-01-01T00:00:00.000Z',
				accountCostUsd: 8.25
			})
		).toEqual({
			balanceUsd: 9.25,
			spentSinceAnchorUsd: 0.75,
			capturedAt: '2026-09-03T10:00:00.000Z'
		});
	});

	it('invalidates a calibration when the official cost meter period rolls over', () => {
		const anchor = createCreditBalanceAnchor(10, {
			periodStart: '2026-01-01T00:00:00.000Z',
			accountCostUsd: 7.5
		});

		expect(
			estimateCreditBalance(anchor, {
				periodStart: '2027-01-01T00:00:00.000Z',
				accountCostUsd: 0.1
			})
		).toBeNull();
	});

	it('uses at least the base realtime hourly price for a remaining-hours estimate', () => {
		expect(estimateRemainingAudioHours(6.12, 0, 0)).toBeCloseTo(2);
		expect(estimateRemainingAudioHours(10, 8, 3_600)).toBe(1.25);
	});

	it('validates stored anchors before use', () => {
		expect(
			isCreditBalanceAnchor({
				balanceUsd: 10,
				accountCostUsd: 7.5,
				meterPeriodStart: '2026-01-01T00:00:00.000Z',
				capturedAt: '2026-09-03T10:00:00.000Z'
			})
		).toBe(true);
		expect(isCreditBalanceAnchor({ balanceUsd: -1 })).toBe(false);
	});
});
