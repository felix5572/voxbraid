import { REALTIME_TRANSLATION_PRICING } from '../realtime/usage-estimate';

export interface AccountCostMeter {
	periodStart: string;
	accountCostUsd: number;
}

export interface CreditBalanceAnchor {
	balanceUsd: number;
	accountCostUsd: number;
	meterPeriodStart: string;
	capturedAt: string;
}

export interface CreditBalanceEstimate {
	balanceUsd: number;
	spentSinceAnchorUsd: number;
	capturedAt: string;
}

export function createCreditBalanceAnchor(
	balanceUsd: number,
	meter: AccountCostMeter,
	capturedAt = new Date().toISOString()
): CreditBalanceAnchor {
	if (!Number.isFinite(balanceUsd) || balanceUsd < 0) {
		throw new Error('Credit balance must be a non-negative number.');
	}
	if (!Number.isFinite(meter.accountCostUsd) || meter.accountCostUsd < 0) {
		throw new Error('Account cost meter must be a non-negative number.');
	}
	return {
		balanceUsd,
		accountCostUsd: meter.accountCostUsd,
		meterPeriodStart: meter.periodStart,
		capturedAt
	};
}

export function isCreditBalanceAnchor(value: unknown): value is CreditBalanceAnchor {
	return (
		typeof value === 'object' &&
		value !== null &&
		'balanceUsd' in value &&
		typeof value.balanceUsd === 'number' &&
		Number.isFinite(value.balanceUsd) &&
		value.balanceUsd >= 0 &&
		'accountCostUsd' in value &&
		typeof value.accountCostUsd === 'number' &&
		Number.isFinite(value.accountCostUsd) &&
		value.accountCostUsd >= 0 &&
		'meterPeriodStart' in value &&
		typeof value.meterPeriodStart === 'string' &&
		'capturedAt' in value &&
		typeof value.capturedAt === 'string'
	);
}

export function estimateCreditBalance(
	anchor: CreditBalanceAnchor | null,
	meter: AccountCostMeter | null
): CreditBalanceEstimate | null {
	if (!anchor || !meter || anchor.meterPeriodStart !== meter.periodStart) return null;
	const spentSinceAnchorUsd = Math.max(0, meter.accountCostUsd - anchor.accountCostUsd);
	return {
		balanceUsd: anchor.balanceUsd - spentSinceAnchorUsd,
		spentSinceAnchorUsd,
		capturedAt: anchor.capturedAt
	};
}

export function estimateRemainingAudioHours(
	balanceUsd: number,
	recentCostUsd: number,
	recentAudioSeconds: number
): number | null {
	if (
		!Number.isFinite(balanceUsd) ||
		!Number.isFinite(recentCostUsd) ||
		!Number.isFinite(recentAudioSeconds) ||
		balanceUsd < 0 ||
		recentCostUsd < 0 ||
		recentAudioSeconds < 0
	) {
		return null;
	}
	const baseHourlyUsd = REALTIME_TRANSLATION_PRICING.usdPerMinute * 60;
	const observedHourlyUsd =
		recentAudioSeconds > 0 ? recentCostUsd / (recentAudioSeconds / 3_600) : 0;
	const hourlyUsd = Math.max(baseHourlyUsd, observedHourlyUsd);
	return hourlyUsd > 0 ? balanceUsd / hourlyUsd : null;
}
