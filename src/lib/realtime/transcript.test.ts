import { describe, expect, it } from 'vitest';
import { parseServerEvent } from './transcript';

describe('parseServerEvent', () => {
	it('accepts events with a string type', () => {
		expect(parseServerEvent('{"type":"session.created"}')).toEqual({
			type: 'session.created'
		});
	});

	it('rejects malformed and untyped messages', () => {
		expect(parseServerEvent('not json')).toBeNull();
		expect(parseServerEvent('{"delta":"hello"}')).toBeNull();
	});
});
