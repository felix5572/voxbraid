export type ProjectionLane = 'interactive' | 'background-clean' | 'background-pairs';

export function canStartProjection(
	lane: ProjectionLane,
	inFlight: ReadonlySet<ProjectionLane>
): boolean {
	if (inFlight.has(lane)) return false;
	if (lane === 'interactive') return true;
	return !inFlight.has('interactive');
}
