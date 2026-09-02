# VoxBraid 句段对照翻译投影

状态：设计草案，尚未实现。
核对日期：2026-09-02。

## 一、产品定位

页面新增第三个阅读区域，暂名「句段对照」，放在现有原文/实时译文区域下方。它不是第三条 Realtime 事实流，而是消费原文转写后由文本模型生成的可重算投影：

```text
麦克风音频
  └─ Realtime Translation session
       ├─ sourceStream       原文事实（gpt-live-transcribe）
       └─ translationStream  实时译文事实（gpt-realtime-translate）

sourceStream
  └─ 本地稳定切句
       └─ 文本模型语义分组与翻译（gpt-5.6-luna）
            └─ TranslationPairSegment[]  句段对照投影
```

三层语义必须分开：

1. 原文流保存 OpenAI 返回的完整追加转写，是新投影的主要证据。
2. 实时译文流继续原样保存和展示，是独立听取音频所得的低延迟译文。
3. 句段对照是文本模型根据原文生成的派生结果，可以重新计算、失败、删除或换模型，不能写回两条事实流。

第一版不把实时译文作为文本模型输入。两条 Realtime 流没有可靠的逐句对应关系，把某段译文尾部硬塞给某段原文会制造虚假的对齐；同时，独立生成的新译文才有资格与实时译文互相校验，而不是被它锚定。模型只读取当前原文原子和少量已完成句段的连续性上下文。

这一区域不是课堂清稿的缩小版。课堂清稿面向较长范围，允许修复缺口并生成完整课堂记录；句段对照面向几秒到十几秒的增量范围，目标是低延迟、忠实翻译、清楚分句和稳定阅读，不补写没有证据的课程内容。

## 二、页面形态

现有 `.captions` 继续保留上下排列的「原文」和「译文」。其下新增独立固定高度面板，不挤压现有两栏：

```text
┌─ 句段对照 ─ 基于原文 · gpt-5.6-luna ─────────────┐
│  English/source                中文/target         │
│  ─────────────────────────────────────────────── │
│  The first semantic unit.     第一个语义单元。     │
│  The question continues ...   这个问题继续……       │
│                                                   │
│  已处理到 03:42 · 78 字等待句末             回到最新 │
└───────────────────────────────────────────────────┘
```

每个已完成句段使用同一行的两列网格：左侧始终显示从原文事实流截取的原样文本，右侧显示文本模型译文。一个模型请求可以返回多个句段，每个句段可以合并若干相邻原文句子。

展示纪律：

- 已显示的稳定句段不因后续 delta 或自动模型结果逐词重写。数据层仍支持 revision 和用户显式重译；冻结是默认展示纪律，不是永久禁止生成新版。
- 全部原子都以真实句末结束的句段在首次成功后标记为 `stable`。包含 `forced-tail` 的句段标记为 `provisional`，允许下一批在有更多原文后原子替换；页面明确显示「暂定」，不能冒充已经定稿。
- Responses API 的 token 流不直接渲染；整批结构化结果校验成功后一次性追加。
- 未处理尾部不显示一个持续增长的正文行，只在状态栏显示「已积累 N 字 / 等待句末」，避免读者正在看的单词横向跳动。
- 新批次追加时可以产生纵向滚动；自动跟随底部沿用现有“用户向上滚动后暂停跟随”的规则，并提供「回到最新」。
- run 切换时显示稳定分隔条；每个 run 使用自己创建时的目标语言，不能用页面当前选择覆盖历史标签。
- iPad 横屏保持双列；窄屏允许一条句段内部上下堆叠，但不能把所有原文和所有译文拆成两个失去对应关系的大区块。

第一版允许模型在当前批次内部重组句子和决定段落边界，但不回头重排已经展示的旧批次。全局重排虽然可能更漂亮，却会重新引入阅读跳动和 revision 管理，留给明确证据出现后的后续版本。

## 三、本地原文原子与候选批次

模型不能可靠返回 UTF-16 字符偏移，也不能让它重写左栏原文。因此页面先把原文流投影成带稳定 ID 的原子：

```ts
interface SourceSentenceAtom {
	id: string; // `${runId}:${sourceStart}:${sourceEnd}`
	runId: string;
	sequence: number;
	sourceStart: number;
	sourceEnd: number;
	text: string; // 始终由完整 sourceStream.slice() 得到
	boundary: 'sentence' | 'forced-tail';
}
```

原子化是纯函数，只读取一个 run 的完整 `sourceStream.text` 和已提交游标：

1. 优先使用项目共用的 `sentenceBoundaries()` 识别真实句末，不能再写第三套标点规则。
2. 缺少标点的长文本在硬字符上限附近选择空白边界，生成 `forced-tail`，避免一场无标点讲话永远不触发。
3. 活动 run 的未完成尾巴保留在内存，不进入原子；run 结束时强制收尾。
4. 原子 ID、范围和文本由应用生成，模型无权修改。

调度器从尚未处理的连续原子形成 `TranslationPairCandidate`。第一批先把阈值作为可测试常量，而不是写死在组件中：

```ts
interface TranslationPairCandidate {
	threadId: string;
	runId: string;
	targetLanguage: string;
	sourceStart: number;
	sourceEnd: number;
	atoms: SourceSentenceAtom[];
	continuity: TranslationPairContinuity[];
	finalizing: boolean;
}
```

推荐初始触发规则：

- 至少有一个完整句子，并且原文安静约 1.2 秒时可以发起。
- 已积累两个完整句子时立即发起，不继续等待安静窗口。
- 从首个未处理字符起约 20 秒或约 800 字符时强制形成候选，防止长句/无标点内容停住。
- run 结束时处理剩余非空尾巴。
- 一个请求进行期间的新 delta 不进入已发候选；完成后重新读取事实流形成下一批。

这些数字只是首轮实测起点。候选函数还应返回进度原因，例如 `waiting-for-sentence`、`waiting-for-quiet-window`、`ready`，页面直接展示原因，不能复制一套阈值逻辑猜状态。

`forced-tail` 使用一个有界的可修改尾窗：下一批在真实句末到来时可以回退到上一个 provisional batch 的 `sourceStart`，携带旧原子和新增原子生成更完整的 revision；最多额外纳入约 800 字符，使单次回退输入不超过约 1,600 原文字符。如果下一个硬窗口仍没有句末，上一窗口转为 stable，只保留最新窗口 provisional，防止一句无标点讲话让重试输入无限增长。

1.2 秒安静窗口需要 worker 自己的可取消 tick；它按 `sourceStream.updatedAt` 与当前墙钟的差值计算，不能等下一条 delta 唤醒，也不能用 `elapsed_ms` 冒充页面静默时间。请求在飞时新增内容自然留到下一批，因此上游越慢，下一批通常越大、请求频率自然下降；800 字符硬上限负责在积压时把队列拆成多个有界批次。

## 四、文本模型契约

第一版使用 `gpt-5.6-luna`、Responses API、`reasoning.effort: 'none'`、`store: false` 和结构化输出。官方 OpenAI 文档将 Luna 定位为成本敏感、高吞吐工作负载，并确认它支持 Responses、Streaming 和 Structured Outputs；其上下文窗口远大于本功能的有界微批次。模型当前价格和能力以[官方模型页](https://developers.openai.com/api/docs/models/gpt-5.6-luna)为准。

虽然模型和 Responses API 支持 streaming，第一版仍使用非流式结构化结果。这里的延迟主要由候选形成和一次短生成决定；把未完成 JSON/token 直接画进页面只会牺牲稳定阅读。Responses API 允许用 `text.format` 约束结构化 JSON，并用 `max_output_tokens` 限制生成，见[官方 Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create)。

输入只包含：

- 目标语言；
- 当前连续 `SourceSentenceAtom[]`；
- 上一至两个已完成对照句段的原文和译文，最多约 1,500 字符，只用于术语、指代和局部语意衔接；
- 服务端版本化 instructions。

模型输出：

```ts
interface TranslationPairModelOutput {
	groups: Array<{
		atomIds: string[];
		translatedText: string;
		paragraphBreakBefore: boolean;
	}>;
}
```

服务端必须验证：

1. 当前批次的每个 atom ID 恰好出现一次；
2. ID 顺序与输入一致，每组只包含连续 atom；
3. 不出现未知、重复或跨 run 的 ID；
4. `translatedText` 非空且总输出处于产品上限内；
5. 所有验证通过后，应用才从 atom 范围自行拼出精确 `sourceText`。

任一约束不满足都返回结构化失败，不猜测模型原意，也不保存半批结果。

Structured Outputs 使用一份随 `taskVersion` 固定的静态 schema，`atomIds` 保持普通字符串数组。当前批次合法 ID 的枚举、顺序和连续性由服务端在响应后校验，不能把每批 ID 动态写进 JSON Schema 的 `enum`，否则每次请求都会产生一个新 schema，并可能反复承担首次 schema 编译延迟。

提示词职责保持窄：忠实翻译当前原文；合并属于同一语义单元的相邻句子；根据提问、回答、话题转折和论述延续决定段落边界；保留专名、数字、术语和语气；不总结、不扩写、不补造未捕获内容。上下文和 atom 文本都是不可信引用数据，不是 instructions。

## 五、持久化模型

不要复用现有 `TranscriptSegment`。旧 segment 是双流的规则投影，`alignment` 只表示两栏按顺序近似配对；新结果具有模型、费用、错误、批次验证和重试语义。混进同一张表会丢失来源边界。

建议 Dexie 新增两个 store：

```ts
interface TranslationPairBatch {
	id: string;
	threadId: string;
	runId: string;
	sequence: number; // run 内批次顺序
	revision: number;
	projectionState: 'stable' | 'provisional';
	targetLanguage: string;
	sourceStart: number;
	sourceEnd: number;
	sourceElapsedEndMs: number | null;
	status: 'completed' | 'failed';
	capturedAt: string;
	completedAt: string | null;
	model: string | null;
	taskVersion: number;
	clientRequestId: string;
	responseId: string | null;
	usageStatus: ModelUsageStatus;
	usage: ModelUsage | null;
	errorCode: SidecarErrorCode | null;
	error: string | null;
	diagnostic: SidecarFailureDiagnostic | null;
	failureAttempts: TranslationPairFailureAttempt[];
}

interface TranslationPairSegment {
	id: string;
	batchId: string;
	batchRevision: number;
	threadId: string;
	runId: string;
	sequence: number; // run 内展示顺序
	sourceStart: number;
	sourceEnd: number;
	sourceText: string;
	translatedText: string;
	paragraphBreakBefore: boolean;
	createdAt: string;
}
```

一次成功请求在同一个 IndexedDB 事务中写入 batch 和全部 segments。自动流程不替换 stable 成功 batch；用户显式重译或 provisional 收尾可以增加同一 batch 的 revision，并在事务内原子替换该 batch 当前 segments。失败 batch 保存固定 source 范围、原始错误和诊断，并显示一条对应的失败行。失败范围视为已占位，后续批次可以继续；重试与显式重译共用 revision 路径并保留 `failureAttempts`。

`sourceElapsedEndMs` 只保存候选形成时该 run 的 `sourceStream.lastElapsedMs`，表示整个 batch 末端的近似课程时间。当前事实模型没有逐 delta 字符位置，因而无法在重算原子时恢复每个句子首次完整出现的 `elapsed_ms`；第一版不在 atom 上伪造逐句时间。若以后确实需要，必须先在事实层保存稀疏的字符位置/elapsed checkpoint。

恢复时按 run 和 batch sequence 读取，不重新调用模型。当前游标由完成或失败 batch 覆盖到的最大 `sourceEnd` 推导；仅打开历史页面不产生费用。新版 archive 把句段对照作为可选投影分节完整导出，保留 batch/segment 的 `taskVersion`、model、usage 和来源范围。导入时先校验所有范围属于 archive 内对应 run、文本与 `sourceStream.slice()` 一致、revision 内无重叠，再整节接受；任一投影校验失败则拒绝该投影分节，不能部分导入。事实数据与投影仍分节，删除 thread 时两张表一起级联。

## 六、共用 worker、调度车道与并发

清稿和句段对照具有相同的“候选 → 单并发请求 → 成功/失败占位 → 游标推进 → run 收尾”生命周期。实现句段对照前，先从 `AutoSummaryPanel.svelte` 抽出组件无关的最小 worker 和策略接口；组件只渲染状态和任务载荷：

```ts
interface ProjectionPolicy<Candidate, Progress> {
	nextCandidate(
		run: CaptureRun,
		cursor: ProjectionCursor,
		options: CandidateOptions
	): Candidate | null;
	progress(run: CaptureRun, cursor: ProjectionCursor): Progress;
}

class ProjectionWorker<Candidate> {
	// 持有在飞请求、run 收尾队列、连续基础设施失败计数和捕获目标守卫。
}
```

第一批不把现有 Dexie 清稿表迁成一张通用 `ProjectionBatch` 表。两种任务可以共享 TypeScript 元数据接口和 worker，但继续使用各自载荷/store；等两个真实调用方都跑通后再根据实际重复决定是否合表，避免先为抽象升级数据库、拖慢主体功能。

请求优先级使用具名车道，而不是继续增加 `summaryRequesting` 一类互锁布尔量：

```ts
type ProjectionLane = 'interactive' | 'background-clean' | 'background-pairs';

function canStartProjection(lane: ProjectionLane, inFlight: ReadonlySet<ProjectionLane>): boolean;
```

每条车道最多一个请求在飞；`interactive` 有请求时两个 background 车道不启动新请求。已经在飞的 background 请求不被取消，完成后才让交互任务优先。车道规则是纯函数并单元测试，面板不自行复制优先级判断。

句段对照使用 `background-pairs` 单并发 worker。约束如下：

- 同一页面最多一个句段对照请求在飞；新 delta 只标记有待处理内容，不并发发起。
- 用户发起自由对话或课堂清稿时，不取消已在飞的句段对照请求，但暂停调度下一批；交互任务结束后继续。
- 切换 thread 或 run 时，晚到结果按请求捕获时的 thread/run 写入，不写到当前页面；如果目标已被删除则明确丢弃并记日志。
- 页面隐藏、网络离线或持久化尚未恢复时不启动新请求；已经在飞的失败按完整浏览器诊断落库。
- 自动失败不阻塞后续批次；连续三次基础设施失败后暂停该 worker 并显示原因，避免服务故障时持续产生请求。用户可显式恢复。

这里不沿用通用 sidecar 的“每次先调用 Input Tokens API”。候选输入由服务端严格限制为小批原文和短 continuity，额外计数请求会把调用次数和关键路径延迟近乎翻倍。安全性写成静态、可测试的不变量：

```ts
const MAX_BATCH_SOURCE_CHARACTERS = 1_600; // 包含一次 provisional 回退
const MAX_CONTINUITY_CHARACTERS = 1_500;
const MAX_PREPARED_INPUT_UTF8_BYTES = 32_000; // 包括 instructions、JSON 与所有文本
```

服务端在调用 OpenAI 前对最终 `instructions + input` 的 UTF-8 字节数执行断言；BPE token 数不会超过输入字节数，因此该上限与 Luna 官方 1,050,000 token 上下文窗口之间保留了数量级余量。改动任一字符常量时必须重跑“不等式仍成立”的测试。超出常量的候选由 VoxBraid 直接结构化拒绝；OpenAI 侧错误仍按现有纪律原样暴露。若以后开放任意范围重译，再回到 Input Tokens fail-closed 预算检查。

## 七、费用与观测

每个 batch 保存模型 usage，页面状态至少展示：

- 当前 worker 状态和已等待秒数；
- 已处理到的 run / source 字符范围；
- 未处理字符数及等待原因；
- 最近 batch 的输入/输出/总 token；
- 失败 batch 的 client request ID、HTTP/OpenAI 原始错误、耗时、页面可见性和在线状态。

官方消费聚合必须纳入 `gpt-5.6-luna` 的 line item；它已经被其他 sidecar 任务纳入时无需重复加集合项。第一版不在页面按 batch 折算美元，沿用官方账单和 usage token 观测。

高频成本的主要风险不是单次上下文，而是调用次数。真实课程需要记录「每小时 batch 数、平均输入/输出 token、平均端到端延迟、失败率」，再调整 1.2 秒、2 句、20 秒和 800 字符四个阈值。不能只凭一次十秒口播决定三小时课程的调度参数。

## 八、第一批实现范围

第一批包含：

1. 共用 `atomize()`、candidate 和进度原因纯函数及测试；原子是原文派生投影的统一字符坐标，但第一版不迁移现有清稿范围；
2. 从清稿面板抽出最小 `ProjectionWorker`、`ProjectionPolicy` 与车道协调器，保持现有全部浏览器场景通过，不迁移清稿 store；
3. 句段对照策略、服务端版本化任务、静态 Structured Outputs schema 与响应校验；
4. Dexie pair batch + segment 原子仓储、revision 和 archive 升级测试；
5. 固定高度横向中英句段面板、自动跟随、provisional 展示和状态信息；
6. 假模型浏览器自动化：连续 delta、整批稳定追加、forced-tail revision、失败后继续、刷新恢复、切 thread 不串写；
7. 显式 opt-in 的真实短录音测试，确认 Luna 结构化结果契约，并测量每小时 batch 数、平均延迟和失败率后再调阈值。

第一批不包含：

- 自动回头修改已经展示的 stable 成功句段；
- 全课程全局重新分段；
- 将实时译文硬配给原文句子；
- 说话人识别、置信度和协议不存在的精确时间对齐；
- 用户自选任意模型或任意 prompt；
- 将派生译文写回原文、Realtime 译文或课堂清稿。

实现顺序先固定原子坐标，再通过清稿这个现有调用方验证 worker 搬家没有改变行为，然后让句段对照成为第二个策略，最后接持久化和 UI。UI 不应先用临时字符串数组跑起来后再补身份、失败和恢复语义，否则第三个区域很快会成为又一份无法解释来源的字幕副本。
