import { describe, expect, it } from 'vitest';
import { canStartProjection, type ProjectionLane } from './projection-lanes';

function lanes(...values: ProjectionLane[]): ReadonlySet<ProjectionLane> {
	return new Set(values);
}

describe('projection lanes', () => {
	it('starts any lane when the scheduler is idle', () => {
		expect(canStartProjection('interactive', lanes())).toBe(true);
		expect(canStartProjection('background-clean', lanes())).toBe(true);
		expect(canStartProjection('background-pairs', lanes())).toBe(true);
	});

	it('gives an in-flight interactive request priority over new background work', () => {
		expect(canStartProjection('background-clean', lanes('interactive'))).toBe(false);
		expect(canStartProjection('background-pairs', lanes('interactive'))).toBe(false);
	});

	it('starts interactive work alongside existing background work', () => {
		expect(canStartProjection('interactive', lanes('background-clean'))).toBe(true);
		expect(canStartProjection('interactive', lanes('background-pairs'))).toBe(true);
		expect(canStartProjection('interactive', lanes('background-clean', 'background-pairs'))).toBe(
			true
		);
	});

	it('allows the two distinct background lanes to work independently', () => {
		expect(canStartProjection('background-pairs', lanes('background-clean'))).toBe(true);
		expect(canStartProjection('background-clean', lanes('background-pairs'))).toBe(true);
		expect(canStartProjection('background-clean', lanes('background-clean'))).toBe(false);
	});
});
