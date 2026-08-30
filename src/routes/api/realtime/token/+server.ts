import { serverConfig } from '$lib/server/config';
import { issueTranslationToken } from '$lib/server/realtime-token';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ request, fetch }) =>
	issueTranslationToken({
		request,
		fetcher: fetch,
		apiKey: serverConfig.openaiApiKey
	});
