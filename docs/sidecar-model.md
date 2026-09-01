# VoxBraid 旁路任务模型

**状态：** 第一批手动调用已实现；第二批增加完整上下文自动总结。本文定义 Supabase 接入前的临时旁路能力，不替代 [`session-model.md`](session-model.md) 中可持久化的 `AssistantBranch` / `AssistantMessage`。

## 目标与边界

旁路任务把“总结、重译、自由提问”统一为同一种调用：

```text
字幕快照 + 任务意图 + 服务端预设 → 一次模型回答
```

第一版采用以下约束：

- 使用 SvelteKit Node 调用 Responses API，正式 API Key 不进入浏览器。
- 每次调用相互独立，非流式，设置 `store: false`，不使用远端 conversation 或 `previous_response_id`。
- 自由问答结果只保存在当前页面内存中；自动总结作为可重算阅读投影，只保存每个 thread 的最新一版到 Dexie，不建立回答历史。
- 旁路失败不能中断 Realtime、字幕追加或本地 checkpoint。
- `ask` 和延后的 `retranslate` 只允许手动触发；`summarize` 同时允许手动和页面内自动触发。
- 不自动重试。网络失联时调用可能已经产生费用；用户再次执行是一次新的调用。

这里的 `store: false` 只表示生成的 Response 不保存供后续 API 检索，不将其描述为零数据保留或隐私审计保证。

`POST /api/sidecar/invoke` 继承整站 Basic Auth 边界，不再实现一套旁路专用登录。页面限制同一时间只执行一个调用只是防止误触和重复费用，不是鉴权、限流或防滥用机制。

## 一、任务意图

自由问题、总结和重译不建立三套接口。浏览器只提交受限的意图，具体 instructions、模型和输出预算由 Node 的预设表决定，不能由浏览器冒充系统指令。

```ts
type SidecarTaskKind = 'ask' | 'summarize' | 'retranslate';
type SidecarTrigger = 'manual' | 'periodic';

type SidecarIntent =
	| {
			kind: 'ask';
			trigger: 'manual';
			question: string;
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

模型按任务性质由服务端预设：直接回应真人自由输入的 `ask` 使用 `gpt-5.6-sol`；自动总结和目标明确的重译先使用速度快、成本低的 `gpt-5.6-luna`，通过真实会话观察质量后再决定是否升级。第一版浏览器不能覆盖该选择；以后若开放配置，也应从服务端允许的模型集合中选择，而不是接受任意模型名。

延后的 `retranslate` 只读取原文；`ask` 和 `summarize` 每次读取当前 thread 的完整双语文本，让模型同时看到原始转写和直接语音翻译。自由问答不锁定首次提问时的字幕范围，每一轮都重新捕获当时的完整会话。若双语输入超过预算，应明确拒绝，不能静默截断或丢掉其中一栏。

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
	runs: SidecarTranscriptRunInput[];
}
```

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

type SidecarErrorCode =
	| 'invalid-request'
	| 'empty-context'
	| 'context-too-large'
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
			error: { code: SidecarErrorCode; message: string };
			failedAt: string;
	  };
```

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
	};
	state: 'requesting' | 'completed' | 'failed';
	result: SidecarInvokeResult | null;
}
```

页面不再复制完整字幕到 invocation；完整文本只存在于原 session 和正在发送的请求对象中。同一页面只允许一个旁路调用执行，防止重复点击造成并发费用。旁路工作区位于字幕和诊断之间：自动总结与自由对话始终上下排列并使用完整内容宽度，各自保留固定高度滚动区，内容增长不能持续撑高整个页面。结果标出 `capturedAt`、模型和 token usage，并提供复制按钮。第一版不把文本 token 折算成美元，直到项目建立统一且可维护的文本模型价格口径。

### 自动总结

自动总结不维护“旧总结 + 新增字幕”的语义合并协议。每次触发都捕获当时 current-thread 的全部原文和实时译文，让模型从头生成一份完整、可独立阅读的新总结；成功后稳定替换旧结果，不展示逐 token 跳动。字幕事实仍是权威主线，总结只是随时可重算的有损阅读投影。

页面使用以下费用保护：

- 上次成功总结或页面初始化以后新增约 3,000 个原文字符时触发。
- 连续收音时两次自动请求至少间隔 5 分钟。
- run 从活动态转为终态时，若仍有至少约 300 个新增原文字符，触发一次收尾总结。
- 同时只允许一个旁路请求；请求期间新增的 delta 不进入已发出的请求，留给下一次完整重算。
- 失败保留旧总结，不推进用于下一次触发的基线，也不自动紧密重试。
- 若完整上下文超过请求体或 token 预算，本会话的自动总结进入明确的停止状态，不再每条 delta 或每五分钟重复产生必然失败的请求；用户仍可阅读和复制最后一版总结。

每个 thread 在 Dexie 的 `autoSummaries` store 中只保留一条最新投影：总结文本、revision、`capturedAt`、捕获时两栏字符数、模型和 usage。字符数只用于判断何时再次触发，不用于截取输入。页面首次打开或切换 thread 时若没有已有总结，以当时全文长度作为基线，不因浏览历史记录立刻产生一次付费调用。

全量重算让总结不会累积语义漂移，但固定周期内反复发送不断增长的全文，会让长会话的累计输入随时长近似二次增长。MVP 接受这项成本以换取简单、可信的语义；如果真实长会话的费用或输入上限成为问题，正式解法是分层总结——用已确认的旧摘要替代早期全文，再拼接尚未覆盖的新字幕——而不是缩短冷却间隔或静默截断上下文。

## 六、与正式 branch 的升级关系

自由问答 invocation 不直接落库；Dexie 中的最新自动总结只是可重算投影，不冒充正式 message。Supabase 可用后：

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
3. 页面增加独立的自动总结与自由对话滚动区域；重译交互延后单独设计。
4. 使用假上游覆盖计数失败、预算拒绝、completed、incomplete、timeout、usage 映射和重复点击。
5. 真实付费测试保持显式 opt-in，只用短字幕夹具验证一次 Responses 链路。

官方接口边界参考：

- [Create a model response](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)
- [Count response input tokens](https://developers.openai.com/api/reference/cli/resources/responses/subresources/input_tokens)
