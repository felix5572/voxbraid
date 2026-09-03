import { openAIAdminKey } from '$lib/server/openai-admin-key';
import { OpenAIUsageRequestError, OpenAIUsageSummaryCache } from '$lib/server/openai-usage-summary';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

const cache = new OpenAIUsageSummaryCache();
const responseHeaders = { 'Cache-Control': 'no-store, private' };

export const GET: RequestHandler = async ({ fetch, url }) => {
	const apiKey = openAIAdminKey();
	if (!apiKey) {
		return json({ message: '官方用量查询未配置。' }, { status: 503, headers: responseHeaders });
	}

	try {
		const summary = await cache.get(
			{ apiKey, fetcher: fetch },
			url.searchParams.get('refresh') === '1'
		);
		return json(summary, { headers: responseHeaders });
	} catch (error) {
		console.error('[openai-usage] official summary failed', {
			name: error instanceof Error ? error.name : 'UnknownError',
			message: error instanceof Error ? error.message : 'Unknown failure',
			status: error instanceof OpenAIUsageRequestError ? error.status : null,
			requestId: error instanceof OpenAIUsageRequestError ? error.requestId : null,
			code: error instanceof OpenAIUsageRequestError ? error.upstreamCode : null
		});
		return json({ message: '官方用量暂时不可用。' }, { status: 502, headers: responseHeaders });
	}
};
