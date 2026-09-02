# VoxBraid 旁路任务模型

**状态：** 手动调用、分块累积的课堂清稿和页面内多轮自由对话已实现。本文定义 Supabase 接入前的临时旁路能力，不替代 [`session-model.md`](session-model.md) 中可持久化的 `AssistantBranch` / `AssistantMessage`。

## 目标与边界

旁路任务把“清稿、重译、自由提问”统一为同一种调用：

```text
字幕快照 + 任务意图 + 服务端预设 → 一次模型回答
```

第一版采用以下约束：

- 使用 SvelteKit Node 调用 Responses API，正式 API Key 不进入浏览器。
- 每次调用相互独立，非流式，设置 `store: false`，不使用远端 conversation 或 `previous_response_id`。
- 自由问答结果只保存在当前页面内存中；课堂清稿作为可重算阅读投影，按稳定字幕范围保存有序块到 Dexie，不建立回答历史。
- 旁路失败不能中断 Realtime、字幕追加或本地 checkpoint。
- `ask` 和延后的 `retranslate` 只允许手动触发；`summarize` 同时允许手动和页面内自动触发。
- 不自动重试。网络失联时调用可能已经产生费用；用户再次执行是一次新的调用。

这里的 `store: false` 只表示生成的 Response 不保存供后续 API 检索，不将其描述为零数据保留或隐私审计保证。

`POST /api/sidecar/invoke` 继承整站 Basic Auth 边界，不再实现一套旁路专用登录。页面限制同一时间只执行一个调用只是防止误触和重复费用，不是鉴权、限流或防滥用机制。

## 一、任务意图

自由问题、清稿和重译不建立三套接口。浏览器只提交受限的意图，具体 instructions、模型和输出预算由 Node 的预设表决定，不能由浏览器冒充系统指令。过渡实现继续使用 `summarize` 作为清稿任务的内部 kind，产品语义以课堂清稿为准。

```ts
type SidecarTaskKind = 'ask' | 'summarize' | 'retranslate';
type SidecarTrigger = 'manual' | 'periodic';

type SidecarIntent =
	| {
			kind: 'ask';
			trigger: 'manual';
			question: string;
			history?: Array<{ question: string; answer: string }>;
			outputLanguage: string;
	  }
	| {
			kind: 'summarize';
			trigger: SidecarTrigger;
			outputLanguage: string;
	  }
	| {
			kind: 'retranslate';
			trigger: 'manual';
			targetLanguage: string;
	  };
```

`ask` 不允许自动触发，因为没有可自动生成的用户问题。`summarize` 的 `periodic` 表示页面根据新增字幕量自动发起；它不是 Node 定时任务，页面关闭后不会在后台继续调用。

Node 内部维护版本化预设：

```ts
interface SidecarTaskDefinition {
	kind: SidecarTaskKind;
	version: number;
	allowedTriggers: readonly SidecarTrigger[];
	contextChannels: 'source' | 'translation' | 'bilingual';
	instructions: string;
	model: string;
	maxInputTokens: number;
	maxOutputTokens: number;
}
```

模型按任务性质由服务端预设：直接回应真人自由输入的 `ask` 使用 `gpt-5.6-sol`；课堂清稿使用兼顾长上下文质量和成本的 `gpt-5.6-terra`；目标明确且更看重速度的重译暂用 `gpt-5.6-luna`。第一版浏览器不能覆盖该选择；以后若开放配置，也应从服务端允许的模型集合中选择，而不是接受任意模型名。

延后的 `retranslate` 只读取原文；`ask` 每次读取当前 thread 的完整双语文本，并携带当前页面内此前成功问答以支持追问；`summarize` 只读取当前待整理块，并附带上一块清稿末尾作为少量连续性参考。自由问答不锁定首次提问时的字幕范围，每一轮都重新捕获当时的完整会话。失败问答不进入后续 history，因为不存在可信的 assistant answer。若完整字幕、此前问答和当前问题合计超过预算，应明确拒绝，不能静默截断、删除旧轮次或丢掉其中一栏；页面提供显式“清空对话”，由用户决定何时舍弃旧问答后重新开始。

## 二、字幕上下文

Supabase 尚未接入时，Node 无法读取浏览器 IndexedDB。浏览器因此必须在点击时形成一份普通对象快照，并把实际文本随请求发送；正在到达的新 delta 不得改变已经发出的调用。

```ts
type SidecarContextScope = 'latest-run' | 'current-thread';

interface SidecarTranscriptRunInput {
	runId: string;
	sequence: number;
	targetLanguage: string;
	sourceText: string;
	translationText: string;
}

interface SidecarContextPayload {
	threadId: string;
	scope: SidecarContextScope;
	capturedAt: string;
	continuityText?: string;
	runs: SidecarTranscriptRunInput[];
}
```

`continuityText` 只供分块清稿使用；缺失按空串处理，以兼容一次部署切换期间仍缓存旧页面代码的浏览器。其他任务无需构造虚假的衔接内容。

`threadId`、`runId` 和 `scope` 在过渡阶段只用于页面关联和诊断，不是服务端已经验证过的所有权事实。Node 仍要验证字段、run 顺序、总字符数和空上下文，但不能假装自己能从本地 ID 还原正文。

请求形状保持很小：

```ts
interface SidecarInvokeRequest {
	clientRequestId: string;
	intent: SidecarIntent;
	context: SidecarContextPayload;
}
```

`clientRequestId` 只用于关联一次浏览器请求和响应。没有持久化记录时，它不能提供真正的幂等保证。

请求体包含字幕正文，不能依赖 `@sveltejs/adapter-node` 默认的 512K 上限。第一版统一使用以下边界：

- 浏览器在发送前对 `JSON.stringify(request)` 的 UTF-8 字节数做预检，超过 `SIDECAR_MAX_REQUEST_BYTES = 1_500_000` 时返回 `context-too-large`。
- Node 解析后重新校验字段、文本总量和等价的序列化字节数，不能信任浏览器预检。
- Node 部署显式设置 `BODY_SIZE_LIMIT=2M`，为 JSON 结构和编码差异留出余量，使产品自己的结构化错误有机会返回；不能把 adapter 的通用 `Bad Request` 当作产品预算提示。

## 三、服务端准备态

Node 校验请求后，将浏览器输入与服务端预设组合成一次不可变调用：

```ts
interface PreparedSidecarCall {
	clientRequestId: string;
	kind: SidecarTaskKind;
	taskVersion: number;
	model: string;
	instructions: string;
	inputText: string;
	maxInputTokens: number;
	maxOutputTokens: number;
}
```

处理顺序固定为：

1. 校验请求和意图，选取服务端 `SidecarTaskDefinition`。
2. 将所需字幕栏和用户问题组装为唯一一份 `PreparedSidecarCall`。
3. 使用相同的 model、instructions 和 input 调用 Responses Input Tokens API。
4. 计数超时、上游失败或返回不可用结果时 fail-closed，返回 `budget-check-failed`，不调用生成接口。
5. 超过产品预算时返回结构化拒绝，不调用生成接口。
6. 通过后把步骤 2 的同一份 instructions 和 input 发送给 Responses API，并显式使用 `stream: false`、`store: false`、`truncation: 'disabled'`。

计数后禁止重新读取页面状态或重新拼字幕，否则“通过预算的输入”和“实际发送的输入”可能不同。

官方文档目前只确认 Input Tokens API 的接口形状，没有承诺计数免费，也没有声明它与生成接口具有完全相同的最大输入边界。第一版不能依赖这两个未经确认的假设：计数接口的 4xx、超时和 5xx 都走上述 fail-closed 分支，并在显式 opt-in 的真实链路测试中覆盖正常计数和超大输入拒绝。

## 四、结果、错误与 usage

旁路与正式 assistant message 共用一个纯值对象表示模型用量：

```ts
interface ModelUsage {
	inputTokens: number;
	cachedInputTokens: number | null;
	outputTokens: number;
	reasoningTokens: number | null;
	totalTokens: number;
}

type ModelUsageStatus = 'recorded' | 'unavailable';

interface SidecarFailureDiagnostic {
	durationMs: number | null;
	visibilityState: string | null;
	online: boolean | null;
	requestBytes: number | null;
	httpStatus: number | null;
}

type SidecarErrorCode =
	| 'invalid-request'
	| 'empty-context'
	| 'context-too-large'
	| 'browser-network-failed'
	| 'invalid-response'
	| 'budget-check-failed'
	| 'request-timeout'
	| 'upstream-failed'
	| 'upstream-incomplete';

type SidecarInvokeResult =
	| {
			status: 'completed';
			clientRequestId: string;
			responseId: string;
			model: string;
			outputText: string;
			usageStatus: ModelUsageStatus;
			usage: ModelUsage | null;
			completedAt: string;
	  }
	| {
			status: 'failed';
			clientRequestId: string;
			responseId: string | null;
			model: string | null;
			outputText: string | null;
			upstreamStatus: 'failed' | 'incomplete' | 'cancelled' | null;
			usageStatus: ModelUsageStatus;
			usage: ModelUsage | null;
			diagnostic?: SidecarFailureDiagnostic | null;
			error: { code: SidecarErrorCode; message: string };
			failedAt: string;
	  };
```

`browser-network-failed` 表示浏览器没有收到 VoxBraid 旁路端点的 HTTP 响应，不能归类为 OpenAI 上游失败；`invalid-response` 表示端点已经响应，但 HTTP 响应体无法解析为旁路协议。页面必须保留浏览器错误的 name、message、stack/cause、请求耗时、在线状态、页面可见性和请求字节数，或 HTTP 状态、响应头与有界原始响应体摘录。OpenAI 拒绝必须保留 type、code、param、request ID 与有界原始响应；非 completed 终态还要保留 `incomplete_details.reason`。`upstream-failed` 只用于 VoxBraid 服务端已经收到并识别的 OpenAI 上游失败。

课堂清稿失败块还应显示请求与失败时间、run 序号、原文和译文字符范围、已确认的模型及 client request ID，服务端旁路日志必须带同一 ID，避免只展示一个无法与部署日志对应的错误短句。重试同一块时，新的结果可以替换块的当前展示，但必须把此前每次失败的时间、ID、错误和结构化诊断保存在 `failureAttempts`，不能抹除用于排查偶发网络问题的唯一证据。

统一错误展示纪律：固定产品文案只能作为原始错误的前缀，不能替代错误；用户可见的 catch 至少追加 `error.name: error.message`，完整 Error 对象同时写入控制台。HTTP 和 OpenAI 错误按上一段保留结构化信息。目标设备是 iPad，因此“只写 console”不算完成用户可见的错误暴露。

只有上游 `completed` 映射为 `completed`。`failed`、`incomplete` 和 `cancelled` 都映射为旁路 `failed`，但保留原始 `upstreamStatus`、响应中已经存在的文本和 usage；失败且没有任何文本时 `outputText` 为 `null`，不使用空字符串冒充一段输出。官方响应 schema 将 usage 定义为可选，因此 `recorded` 要求 usage 非空且 token 字段完整，`unavailable` 要求 usage 为空；不能因调用完成就假定 usage 一定存在。解析文本时优先使用 API 客户端提供的 `output_text` 聚合结果；若直接解析原始响应，则聚合全部 `output_text` content item，不假设 `output[0]` 一定是最终消息。

## 五、页面瞬时状态

页面只需要一个很小的状态机：

```ts
interface SidecarInvocationView {
	id: string;
	intent: SidecarIntent;
	context: {
		threadId: string;
		scope: SidecarContextScope;
		capturedAt: string;
		runCount: number;
		sourceCharacters: number;
		translationCharacters: number;
		historyTurns: number;
	};
	state: 'requesting' | 'completed' | 'failed';
	result: SidecarInvokeResult | null;
}
```

页面不在 invocation 里复制完整字幕；完整文本只存在于原 session 和正在发送的请求对象中。自由对话在当前页面内按 thread 分别保留有序问答，每轮结果追加而不是覆盖；切换 thread 时显示对应的内存问答，刷新页面后才消失，它仍不是持久化的正式 branch。每次新问题只把该 thread 此前成功问答作为 history，重新捕获当时的完整字幕。同一页面只允许一个旁路调用执行，防止重复点击造成并发费用。旁路工作区位于字幕和诊断之间：课堂清稿与自由对话始终上下排列并使用完整内容宽度，各自保留固定高度滚动区，内容增长不能持续撑高整个页面。每轮结果标出捕获范围、`capturedAt`、模型和 token usage，并提供独立复制按钮。第一版不把文本 token 折算成美元，直到项目建立统一且可维护的文本模型价格口径。

### 课堂清稿

课堂清稿按稳定字幕范围生成并顺序追加，不展示逐 token 跳动。每个请求只负责当前块；上一块清稿最多取末尾约 1,000 字符作为术语和局部语义衔接参考，提示词明确禁止重复输出该参考文本。清稿保留原始论述顺序、概念句式、核心术语、推导关系、提问和回答，并逐项保留每个实质性解释、推导步骤、例子、问题与回应；成稿的信息密度应接近实时译文，原文包含更多有效信息时还应相应展开，而不是压缩成摘要。通过自然段体现对话与话题变化；能从上下文合理判断说话人变化时，可以使用简短角色标签，但不能把不确定身份写成事实。原文转写是主要证据，实时译文作为辅助；模型根据重复术语和上下文修正常见听辨与翻译错误，整理口语填充、重复、语法碎片和省略成分。关键术语、专名、符号以及任何不确定或需要复核的表达必须保留对应原文词语，可在整理后的表述旁内联展示；无法确认的专业词使用 `[术语待确认：原文词语]`。可由上下文可靠恢复的小缺口允许保守补齐；无法恢复的音频或连接缺口统一标记为 `[暂未捕获]`，未捕获的公式、图示和板书引用标记为 `[板书内容暂未捕获]`。字幕事实仍是权威主线，清稿块只是可重算的阅读投影。

页面使用以下分块与费用边界：

- 原文积累约 5,000 字符后，等待附近句末形成候选块；超过约 8,000 字符或约 10 分钟时强制封块，避免一直等不到标点。
- 译文通常晚于原文，活动 run 在自动封块前容许约 2 秒时间水位差；历史长文本按相同比例在附近句末切开两栏，配对只要求近似可读。
- run 从活动态转为终态时，仍有至少约 300 个原文字符或约 120 个译文字符就生成收尾块；用户手动整理时可显式处理更短尾巴。
- 同时只允许一个旁路请求；请求期间新增的 delta 不进入已发出的块，留给下一块。
- 块失败会以固定范围和结构化错误保存并直接显示，不自动重试，也不会覆盖已完成块；用户可手动重试同一块。
- 第一版不计算清稿对原字幕的覆盖率，也不因模型可能压缩内容而额外报警；用真实课程观察到明确问题后再增加证据型检查。

每个 thread 在 Dexie version 3 的 `cleanTranscriptBlocks` store 中保存有序块：稳定源文/译文字符范围、对应 run、状态、清稿文本、模型、任务版本、usage 和错误。失败块和成功块使用相同稳定 ID，手动重试原位替换。页面首次打开或切换 thread 时，以已存块末尾作为继续位置；没有块的既有 run 以当前全文长度为自动基线，避免仅浏览历史就产生付费调用。用户主动点击“整理未处理内容”时，新系统中没有旧清稿的 thread 可以从头分块处理。

页面另提供明确的“重新整理全部”：先只清除该 thread 的 `autoSummaries` 和 `cleanTranscriptBlocks` 可重算投影，再从第一条双流事实开始分块生成。它不删除或修改 thread、run、原文和实时译文；重新生成会产生新的文本模型费用，中途失败按普通失败块保存并允许继续或重试。

Dexie version 2 的 `autoSummaries` 作为旧投影只读兼容：已有整场清稿继续显示在新块之前，但不再被覆盖；有旧投影的既有 run 从页面加载位置开始产生新块，避免重复整理。每个块仍使用 64,000 token 输出预算作为异常上限，并由 Input Tokens API 在生成前做输入预算检查。分块后正常请求远小于该上限，三小时课程的累计输入恢复为随内容近似线性增长。

## 六、与正式 branch 的升级关系

自由问答 invocation 不直接落库；Dexie 中的最新课堂清稿只是可重算投影，不冒充正式 message。Supabase 可用后：

- `SidecarTaskDefinition` 继续作为服务端预设表。
- `SidecarIntent` 成为创建 user message 的任务元数据。
- `SidecarContextPayload` 改为轻量 `ContextSelection`，正文由 Node 从权威字幕解析。
- 一次 invocation 映射为一条 user message 和一次独立 assistant message 尝试。
- `clientRequestId` 可以在数据库唯一约束支持下升级为幂等键。
- 页面 `requesting` 升级为数据库 `pending`，再采用既有 orphan、late-recovered 和 usage 恢复规则。

不能把当前内存 invocation 直接称为 `AssistantMessage`，否则会让调用方误以为它已经具备持久化、恢复和幂等语义。

## 七、第一批实现范围

1. 建立上述共享类型、预设注册表和请求校验。
2. 增加单个 `POST /api/sidecar/invoke`，不为三个任务建立三个端点。
3. 页面增加独立的课堂清稿与自由对话滚动区域；重译交互延后单独设计。
4. 使用假上游覆盖计数失败、预算拒绝、completed、incomplete、timeout、usage 映射和重复点击。
5. 真实付费测试保持显式 opt-in，只用短字幕夹具验证一次 Responses 链路。

官方接口边界参考：

- [Create a model response](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)
- [Count response input tokens](https://developers.openai.com/api/reference/cli/resources/responses/subresources/input_tokens)
