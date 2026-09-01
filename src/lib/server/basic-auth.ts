import { timingSafeEqual } from 'node:crypto';

export interface BasicAuthCredentials {
	username: string;
	password: string;
}

function optionalEnvironmentVariable(value: string | undefined): string | null {
	const normalized = value?.trim();
	return normalized || null;
}

export function readBasicAuthCredentials(
	usernameValue: string | undefined,
	passwordValue: string | undefined
): BasicAuthCredentials | null {
	const username = optionalEnvironmentVariable(usernameValue);
	const password = optionalEnvironmentVariable(passwordValue);
	if (username === null && password === null) return null;
	if (username === null || password === null) {
		throw new Error('VOXBRAID_BASIC_AUTH_USERNAME 与 VOXBRAID_BASIC_AUTH_PASSWORD 必须同时配置。');
	}
	if (username.includes(':')) throw new Error('Basic Auth 用户名不能包含冒号。');
	return Object.freeze({ username, password });
}

function secureEqual(actual: string, expected: string): boolean {
	const actualBytes = Buffer.from(actual);
	const expectedBytes = Buffer.from(expected);
	return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function isBasicAuthAuthorized(
	authorization: string | null,
	credentials: BasicAuthCredentials
): boolean {
	if (!authorization?.startsWith('Basic ')) return false;

	let decoded: string;
	try {
		decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
	} catch {
		return false;
	}
	const separator = decoded.indexOf(':');
	if (separator < 0) return false;
	return (
		secureEqual(decoded.slice(0, separator), credentials.username) &&
		secureEqual(decoded.slice(separator + 1), credentials.password)
	);
}

export function basicAuthChallenge(): Response {
	return new Response('VoxBraid authentication required.', {
		status: 401,
		headers: {
			'Cache-Control': 'no-store, private',
			'Content-Type': 'text/plain; charset=utf-8',
			'WWW-Authenticate': 'Basic realm="VoxBraid", charset="UTF-8"'
		}
	});
}
