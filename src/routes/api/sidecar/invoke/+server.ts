import { serverConfig } from '$lib/server/config';
import { invokeSidecar } from '$lib/server/sidecar-invoke';
import { responsesWebSocketManager } from '$lib/server/responses-websocket';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ request, fetch }) =>
	invokeSidecar({
		request,
		fetcher: fetch,
		apiKey: serverConfig.openaiApiKey,
		revisionResponsesTransport: serverConfig.responsesWebSocketEnabled
			? responsesWebSocketManager()
			: null
	});
