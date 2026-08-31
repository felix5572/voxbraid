# VoxBraid 核心会话模型

本文定义 VoxBraid 在产品层的会话、连续收音区间、字幕片段和上下文对话支线。它是 IndexedDB、Supabase、历史记录、暂停继续、主动重连和 GPT 上下文问答共同遵守的领域模型。

## 设计目标

- 用户可以像使用聊天会话一样持续追加翻译内容。
- 暂停只中断当前收音，不结束或清空产品会话。
- 底层 WebRTC 或 OpenAI Realtime 连接可以更换，不改变用户看到的会话身份。
- 字幕在刷新、断网、页面回收和连接重建后仍能恢复。
- 不假设源语言字幕和译文增量天然逐句对应。
- 模型生成内容与原始转录分开保存，并记录回答使用的字幕范围语义，但不冻结或复制当时的完整字幕文本。

## 核心对象

```text
翻译会话 Translation Thread
├── 原始转录主线
│   └── 收音片段 Capture Run
│       └── 字幕片段 Transcript Segment
└── GPT 对话支线 Assistant Branch
    └── 对话消息 Assistant Message
```

### Translation Thread

`Translation Thread` 是用户看到的长期翻译记录，语义类似一个 ChatGPT 聊天会话。用户可以暂停、离开页面、重新打开并继续追加新的收音片段。

它不等同于 OpenAI Realtime session，也不应使用 OpenAI 返回的 session ID 作为产品主键。

建议字段：

```ts
interface TranslationThread {
	id: string;
	ownerId: string | null;
	title: string | null;
	defaultTargetLanguage: string;
	status: 'active' | 'archived';
	createdAt: string;
	updatedAt: string;
}
```

自用阶段 `ownerId` 可以为空，开放给其他用户时再绑定身份系统。标题也可以暂时留空，以后根据第一段字幕自动生成。MVP 不需要显式“结束会话”；离开后仍可继续，只有“新建会话”和“归档”会改变用户所在的容器。

### Capture Run

`Capture Run` 表示一次连续收音区间，通常从用户点击开始或继续，到用户暂停、连接失效或页面被挂起为止。一个 run 通常对应一条 WebRTC 连接和一个 OpenAI Realtime session。

建议字段：

```ts
type CaptureRunStatus = 'starting' | 'live' | 'stopping' | 'completed' | 'interrupted' | 'failed';

type CaptureRunEndReason =
	| 'user-paused'
	| 'connection-lost'
	| 'page-suspended'
	| 'page-terminated'
	| 'permission-denied'
	| 'startup-failed';

interface RunError {
	code: string | null;
	message: string;
}

interface TranscriptStreamSnapshot {
	text: string;
	lastElapsedMs: number | null;
	updatedAt: string | null;
}

interface CaptureRun {
	id: string;
	threadId: string;
	sequence: number;
	status: CaptureRunStatus;
	targetLanguage: string;
	createdAt: string;
	mediaStartedAt: string | null;
	endedAt: string | null;
	lastActivityAt: string | null;
	hiddenAt: string | null;
	audioDurationMs: number;
	endTimeEstimated: boolean;
	endReason: CaptureRunEndReason | null;
	recoveredFromRunId: string | null;
	clientPlatform: string | null;
	lastError: RunError | null;
	sourceStream: TranscriptStreamSnapshot;
	translationStream: TranscriptStreamSnapshot;
	currentSegmentRevision: number | null;
}
```

`createdAt` 是用户发起本次收音的时间；`mediaStartedAt` 是媒体连接真正开始、run 相对时间轴开始计时的时间，两者不能混用。`sourceStream` 和 `translationStream` 保存各自完整的追加文本，是“先保全文本、再整理段落”的兜底事实；segment 是其可读投影，而不是唯一副本。

`recoveredFromRunId` 只表示系统因连接失效或页面挂起而自动重建了一个后续 run。用户主动暂停后继续无需设置该字段；同属一个 thread 且 sequence 相邻已经能够表达产品连续性。

Realtime Translation 当前事件不提供可靠的逐段源语言字段，因此领域模型不保存一个看似精确的 `detectedSourceLanguage`。以后如果另行调用模型推断语言，应将结果作为带来源和置信度的派生标注挂在 segment 上，而不是冒充 Realtime 协议事实。

同一个 thread 的不同 run 可以选择不同 `targetLanguage`。历史记录和导出必须在 run 分隔处标明实际目标语言，不能只显示 thread 的默认值。

### Transcript Segment

`Transcript Segment` 是根据完整原文流和译文流生成的可阅读、可保存、可导出投影。它不是 Realtime 事实，也不参与实时字幕展示；投影不好看时可以用同一份完整流重新生成。

建议字段：

```ts
type SegmentAlignment = 'approximate' | 'unpaired';

interface TranscriptSegment {
	id: string;
	runId: string;
	revision: number;
	sequence: number;
	sourceText: string;
	translatedText: string;
	alignment: SegmentAlignment;
	createdAt: string;
	updatedAt: string;
}
```

`alignment` 只有两种诚实语义：两侧都有文本时为 `approximate`；只有一侧有文本时为 `unpaired`。VoxBraid 不声称某段原文与译文具有协议级一一对应关系。segment 是否来自仍在进行或已经结束的收音，由所属 `CaptureRun.status` 推导，不再重复保存一套流式状态。

## 完整事实流与阅读投影

源文本和译文是两条独立、仅追加的事实流。实时事实 reducer 只处理 `source-delta`、`translation-delta` 和 `run-closed`：每个 delta 直接追加到对应完整流，同时更新最后活动时间和近似服务端会话时长。即使 delta 在 run 关闭后迟到，也继续进入完整流并增加诊断计数，不能静默丢弃。

实时页面直接从两条完整流派生有界的最近文本，不依赖 segment；显示裁剪不能修改或截断事实流。MVP 的阅读投影采用以下简单规则：

1. 原文和译文分别按各自标点切块；没有标点的文本先作为一个完整块保留，不在缺少真实阅读反馈时提前拍定长度阈值。
2. 两组块按生成顺序 `zip`；两侧都有文本时标记 `approximate`，多出来的尾部标记 `unpaired`。
3. `elapsed_ms` 不参与跨流配对。本次真实探针只证明它与事件到达时间近似线性同步，足以否定“译文时间回指源音频区间”的旧假设，但不能把单次观察写成稳定 API 契约。
4. 投影只为历史记录易读，不参与计费、审计、实时字幕或事实保全。拆句、并句造成局部错位是可接受的展示误差，不为 MVP 增加失步检测、静音重同步、语义对齐或全局最优匹配。
5. 投影函数只读取两条完整字符串，因此可以延迟执行并随时重跑；排版效果以后根据真实历史阅读体验调整。

开发期定时探针必须显式启用，只在本地内存和控制台暴露 trace，不默认保存用户谈话内容。用于自动化测试的 trace 必须是用户明确提供且适合进入仓库的内容，或经过脱敏的合成样本。

重新分段采用**版本化投影**，不原地覆盖当前 revision：尚未生成阅读投影时 `currentSegmentRevision` 为空，首次分段使用 revision 1；后续需要改变既有段落边界或 ID 时，在同一个 IndexedDB `readwrite` 事务中跨 `segments` 和 `runs` object store 写入下一 revision 的全部 segment，并更新 `run.currentSegmentRevision`。Supabase 侧使用单个数据库事务或 RPC 完成同样的切换，不能由客户端拆成两次独立写入。普通历史界面只显示当前 revision；若 assistant message 的轻量上下文范围引用了旧 revision 中的 segment，该 revision 仍需保留。这样既不会留下“新 revision 已写入但 current 指针未切换”的半完成状态，也能保持历史问题中“截至哪一段”一类描述可解释。

活动 run 只更新完整流，不要求同步维护 segment。MVP 可以在暂停、run 关闭或首次打开历史记录时生成 revision 1；“重新分段”指用相同完整流生成新的阅读投影。

以上协议能力以 OpenAI 的 [Realtime Translation server events](https://developers.openai.com/api/reference/resources/realtime/translation-server-events) 为准；`approximate` 和 `unpaired` 是 VoxBraid 的展示判断，不是远端事件类型。

## ID 与顺序分配

所有实体 ID 都由应用层生成，数据库使用 UUID 类型且不依赖自增主键。离线转录对象由浏览器通过 `crypto.randomUUID()` 生成，服务端拥有的 branch 和 message 由 Node 生成。ID 只负责身份和引用，不参与展示排序。

MVP 对一个 thread 采用**单活跃写入者**约束：同一时刻只有一个标签页或设备可以创建 run 和 segment，其他端只读或显式接管。客户端在一个 IndexedDB 事务内读取当前最大 sequence 并分配下一个值。同步到 Supabase 后，对 `(thread_id, sequence)` 和 `(run_id, revision, sequence)` 建立唯一约束；若以后允许多端并发，由服务端在冲突时重排 sequence，记录之间仍通过 UUID 引用。

UUID 或 ULID 都不能独自解决两个离线客户端分配相同 sequence 的问题，因此不把 ID 的字典顺序当作并发协调机制。

## 时间轴、时长与异常恢复

`elapsed_ms` 作为可空、非负的服务端观察值保存，不假定固定量化步长，也不把单次探针结果提升为协议契约。它只能用于估算 run / OpenAI session 的活动进度，跨 run 不可直接比较，不能用于原文与译文的语义对齐。

`audioDurationMs` 优先取两条流观察到的最大 `elapsed_ms`。若协议时间不可用，则使用 `lastActivityAt - mediaStartedAt` 估算，并设置 `endTimeEstimated: true`。自用 MVP 只保存时长和所用模型等事实；成本按当前价格配置近似计算，不把单价写死在 run 类型里，也暂不保存历史价格快照。

页面重新打开时，遗留的 `starting`、`live` 或 `stopping` run 标记为 `interrupted`：

- `endedAt` 依次取 `lastActivityAt`、最新 segment 的 `updatedAt`、`createdAt`。
- `endReason` 记为 `page-terminated`，并将 `endTimeEstimated` 设为 `true`。
- 已保存的完整流原样保留；已有阅读投影可以保留或从完整流重建，不能因生命周期状态不完整而删除事实文本。

## GPT 上下文对话支线

用户可以在一个 translation thread 中创建一条或多条独立的 GPT 对话支线，例如：

- “根据上下文总结一下刚刚的主要内容。”
- “刚才提到了哪些人名和日期？”
- “用中文解释这一段里的专业术语。”
- “基于今天的全部内容生成复习提纲。”

对话支线与原始转录共享 thread，但不能把模型回答写回 transcript segment。原始转录是证据主线，摘要、问答和推断是派生内容。

### Assistant Branch

一条 branch 表示围绕当前翻译会话展开的多轮对话。用户可以创建“课堂总结”“术语解释”等多条支线，互不污染各自的聊天历史。

```ts
interface AssistantBranch {
	id: string;
	threadId: string;
	title: string | null;
	status: 'active' | 'archived';
	openAIConversationId: string | null;
	createdAt: string;
	updatedAt: string;
}
```

`openAIConversationId` 只是调用优化和服务端关联信息，不是产品主键。VoxBraid 必须保存自己的消息历史；即使远端 conversation 不可用，也能从本地或 Supabase 数据恢复并重新构造上下文。

### Assistant Message

```ts
type AssistantMessageStatus =
	'pending' | 'streaming' | 'completed' | 'incomplete' | 'failed' | 'cancelled';

type AssistantUsageStatus = 'not-applicable' | 'pending' | 'recorded' | 'unknown';

interface AssistantUsage {
	model: string;
	inputTokens: number;
	cachedInputTokens: number | null;
	outputTokens: number;
	reasoningTokens: number | null;
	totalTokens: number;
}

type ContextSelection =
	| { mode: 'through-segment'; anchorSegmentId: string }
	| { mode: 'selected-segments'; segmentIds: string[] }
	| { mode: 'recent-wall-window'; endAt: string; durationMs: number };

interface AssistantMessageError {
	code: string;
	message: string;
}

interface AssistantMessage {
	id: string;
	threadId: string;
	branchId: string;
	sequence: number;
	role: 'user' | 'assistant';
	content: string;
	status: AssistantMessageStatus;
	contextSelection: ContextSelection | null;
	replyToMessageId: string | null;
	retryOfMessageId: string | null;
	openAIResponseId: string | null;
	usageStatus: AssistantUsageStatus;
	usage: AssistantUsage | null;
	error: AssistantMessageError | null;
	generationDeadlineAt: string | null;
	createdAt: string;
	updatedAt: string;
	finishedAt: string | null;
	orphanedAt: string | null;
	lateResultRecordedAt: string | null;
	completionKind: 'normal' | 'late-recovered' | null;
}
```

只有用户消息保存可选的 `contextSelection`；对应的助手回答通过 `replyToMessageId` 找到该选择。它只说明用户选择了“截至某段”“指定片段”或“某个墙钟窗口”，用于历史界面解释问题和支持重试，不保存当时解析出的全文，也不承诺多年后逐字复现模型输入。普通追问可以继续使用 branch 的对话历史，同时显式决定是否补充最新字幕。

`AssistantMessage.threadId` 是为 RLS 和常用查询保留的冗余归属字段，必须与 `branch.threadId` 一致；它不是客户端可以任意指定的第二套所有权来源。数据库复合外键负责阻止跨 thread 的 branch 引用，Node 还必须验证上下文所引用的 run 和 segment 属于同一 thread。

用户消息写入后即为 `completed` 和 `usageStatus: 'not-applicable'`，其 `replyToMessageId`、`retryOfMessageId`、`openAIResponseId`、`usage`、`error`、`generationDeadlineAt`、`finishedAt`、`orphanedAt`、`lateResultRecordedAt` 和 `completionKind` 均为空；生成状态主要描述 assistant message。assistant message 的 `contextSelection` 为空，通过 `replyToMessageId` 读取用户问题上的范围。

MVP 只实际产生 `pending`、`completed` 和 `failed`。`streaming`、`incomplete` 和 `cancelled` 保留在领域类型中，等实施步骤 8b 建立持久化增量所有权和断连恢复后再启用。

OpenAI Response 状态与产品 message 状态不是直接透传关系。8a 只有上游 `completed` 映射为产品 `completed`；上游 `failed`、`incomplete` 或 `cancelled` 都映射为产品 `failed`，同时保留完整返回中已有的文本、usage 和原始原因。8b 再启用更细的产品状态。

每次 Responses API 调用尝试都创建一条新的 assistant message。重试通过 `retryOfMessageId` 指向上一次尝试，不能覆盖旧 message 的 Response ID、输出或 usage；否则失败重试产生的用量无法对账。重试会按原用户消息保存的 `contextSelection` 从**当前持久化字幕**重新解析范围，不会复用一份隐藏的冻结文本；字幕定稿或重新分段后，模型输入可能发生变化，UI 应把动作标为“使用最新字幕重试”。

`usageStatus` 不使用布尔值或靠 `usage: null` 猜测语义：

- `not-applicable`：用户消息，本来就不产生模型用量。
- `pending`：assistant 调用尚未结束，暂时没有最终 usage。
- `recorded`：API 返回的 usage 已持久化。
- `unknown`：调用可能已经发生并计费，但 usage 无法取回。

第四个 `pending` 值是必要的：正在执行的调用既不能提前标记为 `recorded`，也不能在尚未失联时标记为 `unknown`。

`recorded` 要求 `usage` 非空且 input、output、total token 完整；其他三个状态要求 `usage` 为空。cached input 和 reasoning 明细未由所选模型返回时可以为空。

### 轻量上下文范围

“刚刚”“截至现在”和“选中这一段”必须由应用解析，而不是让模型自行猜测。VoxBraid 保存轻量的 `ContextSelection`，但不建立 `context_snapshots` 表、不复制源文和译文，也不把逐字复现历史模型输入作为自用 MVP 的目标。

`recent-wall-window` 使用明确的 `endAt` 和墙钟 `durationMs`，不依赖 segment 时间字段。MVP 根据 run 的 `mediaStartedAt`、`endedAt` 或 `lastActivityAt` 选择与窗口相交的完整 run，因此可能比请求范围多带一些文本；最终仍受上下文预算限制。若以后确实需要在一个很长的 run 内精确截取“最近十分钟”，应先增加块级检查点或独立 capture-time 索引，不能从阅读投影反推精确媒体时间。

关系型存储可以把 `contextSelection` 映射为 message 上的 `context_mode`、`context_anchor_segment_id`、`context_end_at`、`context_duration_ms` 可空列：`through-segment` 使用 anchor，`recent-wall-window` 使用 end time 和 duration；`selected-segments` 使用 `assistant_message_context_segments(message_id, segment_id, ordinal)` 关联表。只有用户消息持有这些引用。它们的目的只是保持范围可解释，不是审计证据。

segment ID 只表示用户在某个阅读投影 revision 中指向的位置。被消息范围引用的旧 revision 按既有规则保留，重试直接从该 revision 解析轻量选择，不尝试把旧 segment 映射到新分段边界；引用已经无法解析时提示用户重新选择，不能静默换成另一个近似范围。

### 调用边界

- Realtime Translation 继续只负责音频、转录和翻译。
- GPT 问答由 SvelteKit Node 使用标准服务端 API Key 调用 Responses API。
- 浏览器只向 VoxBraid Node 提交问题、branch ID 和轻量上下文选择，不接触正式 API Key。
- GPT 请求与实时媒体链路解耦；摘要失败不能中断收音和字幕。
- VoxBraid 数据库是消息与范围元数据的事实来源，OpenAI conversation 只承载模型侧多轮上下文。

### MVP 非流式调用所有权与恢复

MVP 的 assistant 回答由 Node 独占写入，采用以下顺序：

1. Node 完成授权，把 `contextSelection` 解析为一份不可变的内存文本对象，并对系统指令、branch 历史和这份文本做 token 预算检查。检查失败时不创建用户消息、assistant message 或其他持久记录，也不调用生成接口；浏览器保留问题草稿和选择范围。
2. 预算通过后，Node 在一个事务中写入用户消息及其轻量范围、`status: 'pending'`、`usageStatus: 'pending'`、空 `content` 的 assistant message，并根据服务端配置写入 `generationDeadlineAt`。branch 内的 message `sequence` 也由 Node 在该事务中分配，并由 `UNIQUE (branch_id, sequence)` 兜底。
3. Node 把步骤 1 中参与预算计算的**同一份内存文本对象**原样加入非流式 Responses API 请求。发送前禁止根据 segment ID 再解析一次，否则并发到达的 delta 或 revision 切换会使实际输入越过已经通过的预算。
4. 得到完整响应后，Node 在一个数据库事务中写入 `content`、Response ID、usage、`finishedAt` 和最终状态。只有事务成功后才把已保存的 message 返回浏览器。
5. 捕获到调用失败时，Node 使用条件更新把仍为 `pending` 的记录改为 `failed`，保存原始错误信息；无法可靠取得 usage 时标记为 `unknown`。

Node 可以在一次请求期间临时持有尚未提交的完整响应，但持久化的调用意图和最终结果不能只存在进程内存中。若实例在 API 已接受请求后崩溃，数据库至少保留 pending，后续会诚实地转成 `failed + unknown`，而不是假装没有发生过调用。

遗留 pending 的判定和修改权属于 Node，不属于浏览器：每次读取或写入一个 branch 前，Node 都先检查该 branch 中 `generationDeadlineAt <= now` 的 pending，并以 `WHERE status = 'pending'` 的条件更新将其改为 `failed`、`usageStatus: 'unknown'`，错误码记为 `orphaned-request`，同时写入 `orphanedAt`。不需要 cron；普通 branch 加载本身会触发修复。

请求超时和 pending 失效阈值分别由服务端配置 `ASSISTANT_REQUEST_TIMEOUT_MS` 与 `ASSISTANT_PENDING_TIMEOUT_MS` 提供，后者必须大于前者并留出数据库提交余量，不能散落魔数。活动 Node 也必须在 pending deadline 前终止上游等待。

若上游结果仍在判死后迟到返回，同一次 API 调用仍然只对应原来那条 assistant message。Node 只允许通过条件 `UPDATE` 恢复满足以下任一条件的原记录：仍为 `pending`；或为 `failed + orphaned-request + usageStatus: unknown`。成功结果更新为 `completed`、`completionKind: 'late-recovered'` 并写入 `lateResultRecordedAt`；上游最终失败但携带完整 usage 时保持 `failed`，只把 usage 改为 `recorded`。该路径禁止 upsert 或 insert-on-conflict；影响 0 行是合法结果，说明记录已被其他路径推进或随用户硬删除 thread 一并删除，绝不能重新创建用户数据。

`finishedAt` 表示上游实际完成时间；上游未提供可用完成时间时，使用 Node 观察到完整结果的时刻。`orphanedAt` 表示本地判死时间，`lateResultRecordedAt` 表示迟到结果成功落库时间。生成耗时使用 `finishedAt - createdAt`，恢复延迟使用 `lateResultRecordedAt - orphanedAt`，不能混用。

正常创建接口会等到 `completed` 或 `failed` 已经入库才返回，因此 UI 不为 pending 设计独立消息气泡，请求期间只显示普通加载状态。历史记录中若出现 `failed + unknown`，应提示“本次调用可能已产生费用”；自用 MVP 需要核实时由用户查看 OpenAI Platform 用量，不实现自动账单对账。若用户已经手动重试而旧调用随后恢复，两条真实调用和回答都保留；迟到恢复的旧回答默认折叠，标注“此前超时的调用后来返回了结果”，避免与重试回答混淆。

步骤 8b 若启用流式输出，Node 仍必须是权威写入者：在向浏览器转发 delta 的同时防抖持久化部分 `content`，浏览器不能成为唯一副本；并补齐断连、实例替换和遗留 `streaming` 的恢复规则。

### 上下文预算与调用用量

Node 在调用 Responses API 前，先对实际组装的完整请求计算输入 token：系统指令、branch 对话历史和解析后的字幕文本都必须计入。输入预算和 `maxOutputTokens` 按模型与产品配置管理，不在领域类型中写死某个模型的上下文上限。

若请求超过 VoxBraid 配置的输入预算，MVP 直接拒绝并提示用户选择更短时间或更少 segment。系统不能静默截断旧消息，也不能擅自把“今天全部内容”改成“最近几分钟”，因为这会改变用户问题的语义。被拒绝的请求不创建用户消息、assistant message 或全文副本。以后增加分块摘要或分层合并时，应作为用户可见的独立策略。

Responses API 返回 usage 时，将 model、input、cached input、output、reasoning 和 total token 写入该次 assistant message，并设置 `usageStatus: 'recorded'`。这些是调用事实，必须保存。调用已发出但 API 未返回 usage 时保留 `usage: null`、设置 `usageStatus: 'unknown'`，同时保留原始服务端错误日志。

自用 MVP 不建立 `pricing_snapshots`，也不把历史估算成本当作账单事实；界面需要估算时使用当前配置价格计算，并明确它可能随价格变化。权威用量和费用以 OpenAI Platform 为准。开放给其他用户或需要可复算账单时，再引入不可变价格快照、费用明细和正式对账。

上述字段和策略以 OpenAI 的 [Responses API](https://developers.openai.com/api/reference/cli/resources/responses/methods/create) 与 [Input Tokens API](https://developers.openai.com/api/reference/typescript/resources/responses/subresources/input_tokens) 为边界。VoxBraid 不依赖 API 自动截断来执行产品语义。

第一版先使用文本输入。以后如果增加语音命令，应提供明确的“向 GPT 提问”按住说话模式，而不是从环境音中自动猜测哪句话是命令。否则讲者说出的类似句子可能被误当成用户指令。

## 暂停与继续

“暂停”是产品会话内的自然时间断点：

1. 立即停止麦克风轨道。
2. 请求 Realtime session 冲刷尚未返回的字幕。
3. 将当前 run 标记为 `completed`，结束原因为 `user-paused`。
4. 保留 thread、已有字幕和当前阅读位置。
5. 用户点击“继续翻译”时，在同一 thread 中创建下一个 run。

暂停不会新建 thread，也不会清空字幕。UI 应在相邻 run 之间显示轻量的时间分隔，而不是把它们伪装成完全连续的音频。

字幕段落不得自动跨 run 合并。暂停可能发生在一句话中间；保留断点比猜测前后语义连续性更可靠。正常冲刷后能够稳定归属的段落标记为 `final`；超时后仍未稳定的段落标记为 `interrupted`，继续后的内容从新段落开始。

## 断线与重建

连接恢复分为两类：

- 同一 `RTCPeerConnection` 短暂进入 `disconnected` 后恢复：继续使用当前 run。
- 必须重新获取 token 并建立新的 WebRTC 连接：结束当前 run，原因记为 `connection-lost`；在同一 thread 中创建新 run，并设置 `recoveredFromRunId`。

这样主动重连不需要假装延续同一个 OpenAI session。用户看到的翻译会话保持连续，底层媒体边界则被准确记录。

## 页面隐藏与生命周期恢复

`visibilitychange` 的 `hidden` 只表示页面暂时不可见，不等于媒体已经停止。页面隐藏时记录 `hiddenAt` 并立即保存检查点，但不立刻结束 run；回到前台后检查麦克风轨道和 WebRTC 状态：

- 轨道和连接仍有效：清除 `hiddenAt`，继续当前 run。
- 页面仍在但媒体已经失效：结束当前 run，原因记为 `page-suspended`；用户或以后实现的自动恢复流程创建新 run。
- 页面被系统回收后重新打开：按上一节的遗留 run 规则标记为 `page-terminated`。

这是领域模型要求的后续实现策略，不代表当前 Web 客户端已经具备锁屏后恢复能力。Web 版本仍不承诺锁屏期间连续采集。

## 生命周期

```text
没有当前 thread
  └── 新建或打开 thread
        ├── 开始/继续 ──> 创建 run ──> live
        │                              ├── 暂停 ──> completed
        │                              ├── 短暂断线并恢复 ──> live
        │                              └── 连接失效 ──> interrupted
        │                                                   └── 重建为新 run
        ├── 再次继续 ──> 追加新 run
        └── 新建会话 ──> 切换到新的 thread
```

## 持久化边界

存储分阶段落地，完整路线和迁移冻结条件见 [`persistence-roadmap.md`](persistence-roadmap.md)。本地阶段使用 Dexie 封装 IndexedDB，只建立 `threads`、`runs` 和 `segments` 三个 store；GPT 支线等 Supabase 可用后由 Node 持久化，不先在浏览器复制一套权威 assistant 存储。

运行期间：

- transcript delta 先在内存中归并，不逐条写 Supabase。
- 当前完整流快照经过短时间防抖后写入 IndexedDB，实时事实路径不等待阅读投影。
- 暂停、断线和页面隐藏时立即持久化 run 检查点；暂停或关闭后可以生成或刷新 segment revision。
- 页面重新打开时，按“时间轴、时长与异常恢复”的规则修复遗留 run，保留已有文本；阅读投影缺失时可以重新生成。
- 待上传状态作为本地同步元数据保存，不进入实时媒体关键路径。
- assistant branch 和 message 由 Node 写入 Supabase，不修改已保存的 transcript segment；浏览器可以缓存查询结果，但不能成为唯一副本。

Supabase 的关系约束至少包括：

```sql
ALTER TABLE assistant_branches
  ADD CONSTRAINT assistant_branches_id_thread_key UNIQUE (id, thread_id);

ALTER TABLE assistant_messages
  ADD CONSTRAINT assistant_messages_branch_thread_fkey
  FOREIGN KEY (branch_id, thread_id)
  REFERENCES assistant_branches (id, thread_id) ON DELETE CASCADE;

ALTER TABLE assistant_messages
  ADD CONSTRAINT assistant_messages_branch_sequence_key
  UNIQUE (branch_id, sequence);
```

`assistant_messages.thread_id` 还应直接引用 `translation_threads.id`。父表上的组合唯一约束即使在 `id` 已是主键时仍需显式创建，供复合外键引用。这样 message 和 branch 必须属于同一 thread 的规则由数据库保证，而不是依赖每个调用点都记得检查；RLS 也可以直接按 message 的 `thread_id` 判断所有权。上下文 segment 通过 `context_anchor_segment_id` 或 `assistant_message_context_segments` 引用，Node 在写入事务前验证它们最终属于同一 thread。

领域类型中的 `AssistantUsage` 可以保持内嵌对象，但 Supabase 不把所有高频统计字段只塞进 JSONB。`usage_status`、`model`、`input_tokens`、`output_tokens` 和 `total_tokens` 映射为 `assistant_messages` 的独立可索引列；cached input、reasoning 等扩展明细可以保留在 `usage_details` JSONB。成本界面根据这些事实字段和当前价格配置生成近似值。

成本与异常调用审计至少覆盖 `usage_status = 'unknown'`，以及 `status = 'pending' AND generation_deadline_at <= now()` 的尚未清扫记录。Supabase 落地时把该口径封装成 view，避免不同报表各自复制并遗漏条件。

归档、共享和删除遵循以下规则：

- thread 归档后，其 run、segment、branch 和 message 整体只读；branch 自身的 `status` 不随之改写，恢复 thread 后仍保留原来的支线状态。
- branch 归档只隐藏该支线，不删除 message。以后若支持硬删除 branch，可以级联删除其 message 和多选范围关联行。
- 硬删除 thread 时级联删除其全部 run、所有 segment revision、branch、message 和范围关联行；这是用户隐私删除边界。Supabase 迁移必须用自动化测试验证该级联不会被上下文外键阻塞。
- RLS 和服务端授权从 thread 的 `ownerId` 继承，不能只根据客户端传入的 branch、message 或 segment ID 放行；迁移测试还必须断言跨 thread 引用 branch 或 segment 会被拒绝。
- 没有任何 assistant message 上下文范围引用的非当前 segment revision，可以以后由明确的清理任务整组回收；MVP 不自动清理，也不只删除 revision 中的部分 segment。

## 核心约束

1. 产品 thread ID、capture run ID 和 OpenAI session ID 是不同概念。
2. 一个 run 只属于一个 thread；一个 segment 只属于一个 run 和一个投影 revision。
3. 同一 thread 内的 run 和同一 run、同一 revision 内的 segment 都有稳定、单调的顺序号；MVP 以单活跃写入者保证分配安全，多端并发以后由服务端协调。
4. 暂停和重新连接不会覆盖或拼接已有字幕。
5. 数据库或同步失败不能中断正在进行的翻译。
6. 页面恢复必须优先保留用户已看到的文本，不能因状态不完整而删除草稿。
7. 模型回答只记录可解释的轻量上下文范围，不复制或冻结当时的字幕全文；预算计算和实际发送必须使用同一份内存文本对象。
8. Assistant branch 不能成为字幕的唯一副本，也不能反向覆盖原始转录。
9. 每条增量先进入完整流，再参与分段；无法可靠对齐的文本宁可标记为 `unpaired`，也不能静默丢弃或强行错配。
10. 所有实体使用应用层生成的 UUID；浏览器生成离线转录对象，Node 生成服务端对象。时间顺序只能由显式 sequence 和时间字段表达。
11. 重新分段只能在同一个 IndexedDB 或数据库事务中创建新的完整 revision 并切换当前版本，不能删除 assistant message 上下文范围仍引用的旧 revision。
12. 每次 GPT 调用尝试都独立保存状态、输出和用量；重试不得覆盖既有调用记录。
13. Assistant pending 是服务端持久化的运营状态，只能由 Node 推进或判死；浏览器不能直接修改，也不需要将其渲染为聊天消息。

## 实施位置

项目实施顺序只以 README 的“建议实施顺序”为准，本文不维护第二套编号。本领域模型首先服务于 README 第 4 步的类型、双流 reducer 和暂停继续；Dexie、Supabase 与 GPT 支线的存储阶段由 [`persistence-roadmap.md`](persistence-roadmap.md) 解释，但不能改变 README 的项目级先后关系。
