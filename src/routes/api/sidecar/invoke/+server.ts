import { serverConfig } from '$lib/server/config';
import { invokeSidecar } from '$lib/server/sidecar-invoke';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ request, fetch }) =>
	invokeSidecar({ request, fetcher: fetch, apiKey: serverConfig.openaiApiKey });
