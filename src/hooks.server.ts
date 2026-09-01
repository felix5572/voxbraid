import { building, dev } from '$app/environment';
import { basicAuthChallenge, isBasicAuthAuthorized } from '$lib/server/basic-auth';
import { serverConfig } from '$lib/server/config';
import type { Handle } from '@sveltejs/kit';

if (!building && !dev && serverConfig.basicAuth === null) {
	throw new Error(
		'生产环境必须配置 VOXBRAID_BASIC_AUTH_USERNAME 与 VOXBRAID_BASIC_AUTH_PASSWORD。'
	);
}

export const handle: Handle = ({ event, resolve }) => {
	if (event.url.pathname === '/api/health') return resolve(event);
	const credentials = serverConfig.basicAuth;
	if (
		credentials === null ||
		isBasicAuthAuthorized(event.request.headers.get('authorization'), credentials)
	) {
		return resolve(event);
	}
	return basicAuthChallenge();
};
