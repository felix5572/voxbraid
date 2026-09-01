const ADMIN_ENV_FILE = '.env.admin.local';
const REALTIME_MODELS = ['gpt-realtime-translate', 'gpt-realtime-whisper'];

try {
	process.loadEnvFile(ADMIN_ENV_FILE);
} catch (error) {
	throw new Error(`无法读取 ${ADMIN_ENV_FILE}。请先在其中配置 OPENAI_ADMIN_KEY。`, {
		cause: error
	});
}

const adminKey = process.env.OPENAI_ADMIN_KEY;
if (!adminKey) throw new Error(`${ADMIN_ENV_FILE} 中缺少 OPENAI_ADMIN_KEY。`);

const now = new Date();
const defaultStart = `${now.getUTCFullYear()}-01-01`;
const startDate = process.env.OPENAI_USAGE_START ?? defaultStart;
const startTime = Date.parse(`${startDate}T00:00:00Z`);
if (!Number.isFinite(startTime)) {
	throw new Error('OPENAI_USAGE_START 必须是 YYYY-MM-DD。');
}
const endTime = Math.ceil(Date.now() / 1_000) + 1;

async function costBuckets() {
	const buckets = [];
	let page = null;
	do {
		const url = new URL('https://api.openai.com/v1/organization/costs');
		url.searchParams.set('start_time', String(startTime / 1_000));
		url.searchParams.set('end_time', String(endTime));
		url.searchParams.set('bucket_width', '1d');
		url.searchParams.set('limit', '180');
		url.searchParams.append('group_by', 'project_id');
		url.searchParams.append('group_by', 'line_item');
		if (page) url.searchParams.set('page', page);

		const response = await fetch(url, { headers: { Authorization: `Bearer ${adminKey}` } });
		const body = await response.json().catch(() => null);
		if (!response.ok) {
			throw new Error(
				`OpenAI Costs API 返回 HTTP ${response.status}：${body?.error?.message ?? body?.error?.code ?? '未知错误'}`
			);
		}

		buckets.push(...(body.data ?? []));
		page = body.has_more ? body.next_page : null;
	} while (page);
	return buckets;
}

const totals = new Map(
	REALTIME_MODELS.map((model) => [model, { seconds: 0, usd: 0, units: new Set() }])
);
for (const bucket of await costBuckets()) {
	for (const result of bucket.results ?? []) {
		const total = totals.get(result.line_item);
		if (!total) continue;
		total.seconds += Number(result.quantity ?? 0);
		total.usd += Number(result.amount?.value ?? 0);
		if (result.quantity_unit) total.units.add(result.quantity_unit);
	}
}

const [translation, transcription] = REALTIME_MODELS.map((model) => totals.get(model));
const totalUsd = translation.usd + transcription.usd;
const audioSeconds = Math.max(translation.seconds, transcription.seconds);

console.log(`OpenAI Realtime 用量（${startDate} 至今）`);
for (const model of REALTIME_MODELS) {
	const total = totals.get(model);
	const unit = total.units.size > 0 ? ` ${[...total.units].join(', ')}` : '';
	console.log(`- ${model}: ${total.seconds} 秒${unit}，$${total.usd.toFixed(5)}`);
}
console.log(`- 实际音频：${audioSeconds} 秒（两模型处理同一段音频，不重复相加）`);
console.log(`- 官方总费用：$${totalUsd.toFixed(5)}`);
