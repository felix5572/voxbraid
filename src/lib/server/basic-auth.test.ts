import { describe, expect, it } from 'vitest';
import { basicAuthChallenge, isBasicAuthAuthorized, readBasicAuthCredentials } from './basic-auth';

const credentials = Object.freeze({ username: 'voxbraid', password: 'correct:long-password' });

function basic(username: string, password: string): string {
	return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

describe('readBasicAuthCredentials', () => {
	it('keeps local authentication optional when both values are absent', () => {
		expect(readBasicAuthCredentials(undefined, '  ')).toBeNull();
	});

	it('requires the username and password as a pair', () => {
		expect(() => readBasicAuthCredentials('voxbraid', undefined)).toThrow('必须同时配置');
		expect(() => readBasicAuthCredentials(undefined, 'password')).toThrow('必须同时配置');
	});

	it('rejects a username that cannot be represented by Basic Auth', () => {
		expect(() => readBasicAuthCredentials('invalid:name', 'password')).toThrow('不能包含冒号');
	});
});

describe('Basic Auth', () => {
	it('accepts exact credentials including a colon in the password', () => {
		expect(
			isBasicAuthAuthorized(basic(credentials.username, credentials.password), credentials)
		).toBe(true);
	});

	it('rejects missing, malformed, and incorrect credentials', () => {
		expect(isBasicAuthAuthorized(null, credentials)).toBe(false);
		expect(isBasicAuthAuthorized('Bearer token', credentials)).toBe(false);
		expect(isBasicAuthAuthorized('Basic not-base64!', credentials)).toBe(false);
		expect(isBasicAuthAuthorized(basic('voxbraid', 'wrong'), credentials)).toBe(false);
	});

	it('returns a browser-compatible challenge without caching it', () => {
		const response = basicAuthChallenge();
		expect(response.status).toBe(401);
		expect(response.headers.get('www-authenticate')).toBe(
			'Basic realm="VoxBraid", charset="UTF-8"'
		);
		expect(response.headers.get('cache-control')).toBe('no-store, private');
	});
});
