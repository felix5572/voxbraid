const ADMIN_ENV_FILE = '.env.admin.local';
const REALTIME_MODELS = ['gpt-realtime-translate', 'gpt-live-transcribe', 'gpt-realtime-whisper'];
const SIDECAR_MODELS = ['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra'];

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

async function organizationSpendLimit() {
	const response = await fetch('https://api.openai.com/v1/organization/spend_limit', {
		headers: { Authorization: `Bearer ${adminKey}` }
	});
	const body = await response.json().catch(() => null);
	if (response.status === 404 && body?.error?.code === 'not_found') return null;
	if (!response.ok) {
		return { unavailable: `HTTP ${response.status}: ${body?.error?.message ?? '未知错误'}` };
	}
	return body;
}

const totals = new Map(
	REALTIME_MODELS.map((model) => [model, { seconds: 0, usd: 0, units: new Set() }])
);
const sidecarTotals = new Map(SIDECAR_MODELS.map((model) => [model, { usd: 0, lineItems: 0 }]));
let accountUsd = 0;
for (const bucket of await costBuckets()) {
	for (const result of bucket.results ?? []) {
		accountUsd += Number(result.amount?.value ?? 0);
		const total = totals.get(result.line_item);
		if (total) {
			if (result.quantity_unit === 'duration_seconds') {
				total.seconds += Number(result.quantity ?? 0);
			}
			total.usd += Number(result.amount?.value ?? 0);
			if (result.quantity_unit) total.units.add(result.quantity_unit);
			continue;
		}
		const sidecarModel = SIDECAR_MODELS.find(
			(model) => result.line_item === model || result.line_item?.startsWith(`${model},`)
		);
		if (!sidecarModel) continue;
		const sidecarTotal = sidecarTotals.get(sidecarModel);
		sidecarTotal.usd += Number(result.amount?.value ?? 0);
		sidecarTotal.lineItems += 1;
	}
}

const translation = totals.get('gpt-realtime-translate');
const transcriptionSeconds =
	totals.get('gpt-live-transcribe').seconds + totals.get('gpt-realtime-whisper').seconds;
const realtimeUsd = [...totals.values()].reduce((sum, total) => sum + total.usd, 0);
const sidecarUsd = [...sidecarTotals.values()].reduce((sum, total) => sum + total.usd, 0);
const totalUsd = realtimeUsd + sidecarUsd;
const audioSeconds = Math.max(translation.seconds, transcriptionSeconds);
const spendLimit = await organizationSpendLimit();

console.log(`VoxBraid OpenAI 用量（${startDate} 至今）`);
for (const model of REALTIME_MODELS) {
	const total = totals.get(model);
	const unit = total.units.size > 0 ? ` ${[...total.units].join(', ')}` : '';
	console.log(`- ${model}: ${total.seconds} 秒${unit}，$${total.usd.toFixed(5)}`);
}
for (const model of SIDECAR_MODELS) {
	const total = sidecarTotals.get(model);
	console.log(`- ${model}: $${total.usd.toFixed(5)}（${total.lineItems} 条费用明细）`);
}
console.log(`- 实际音频：${audioSeconds} 秒（两模型处理同一段音频，不重复相加）`);
console.log(`- VoxBraid 已识别费用：$${totalUsd.toFixed(5)}`);
console.log(`- 全账户官方费用：$${accountUsd.toFixed(5)}`);
console.log(`- 账户其他费用：$${Math.max(0, accountUsd - totalUsd).toFixed(5)}`);
if (spendLimit?.unavailable) {
	console.log(`- 组织硬消费上限：暂不可用（${spendLimit.unavailable}）`);
} else if (spendLimit) {
	console.log(
		`- 组织硬消费上限：$${(Number(spendLimit.threshold_amount) / 100).toFixed(2)} / ${spendLimit.interval}（${spendLimit.enforcement?.status ?? '状态未知'}）`
	);
} else {
	console.log('- 组织硬消费上限：未配置');
}
console.log('- 预付信用余额：官方 Admin API 不提供，请在 OpenAI Billing 页面核对');
