import { describe, expect, it } from 'vitest';
import { diagnosticsDisclosure } from './diagnostics-disclosure';

describe('diagnosticsDisclosure', () => {
	it('only synchronizes open state when diagnostics mode changes', () => {
		const node = { open: false } as HTMLDetailsElement;
		const action = diagnosticsDisclosure(node, false);

		node.open = true;
		action.update(false);
		expect(node.open).toBe(true);

		action.update(true);
		expect(node.open).toBe(true);
		node.open = false;
		action.update(true);
		expect(node.open).toBe(false);

		action.update(false);
		expect(node.open).toBe(false);
	});
});
