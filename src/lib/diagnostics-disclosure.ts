export function diagnosticsDisclosure(node: HTMLDetailsElement, enabled: boolean) {
	let previous = enabled;
	node.open = enabled;

	return {
		update(next: boolean): void {
			if (next === previous) return;
			previous = next;
			node.open = next;
		}
	};
}
