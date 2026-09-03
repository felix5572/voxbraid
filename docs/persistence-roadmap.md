# VoxBraid 持久化与 Schema 固化路线

本文记录自用 MVP 从浏览器本地持久化过渡到 Supabase 的一致方案。目标是在领域模型仍快速变化时保持修改成本低，同时在开始保存重要真实数据后及时建立可靠迁移纪律。

## 已确定的方向

- 当前不立即接入 Supabase，也不为每次字段调整积累 Postgres migration。
- 浏览器本地持久化使用 Dexie 封装 IndexedDB；转录主线保存 thread、run 和 segment，旁路第二批额外保存每个 thread 最新一版可重算课堂清稿。
- GPT branch 和 message 等 Supabase 可用后再实现，由 Node 作为权威写入者；浏览器不能成为模型回答的唯一持有者。
- 不建立 `context_snapshots` 或字幕全文副本。用户消息只保留轻量的上下文范围，精确模型输入不作为审计对象。
- 自用 MVP 不建立 `pricing_snapshots`。保存模型和 token 用量事实，费用仅按当前配置近似展示；正式对外计费前再设计历史价格与对账。
- 领域模型、Dexie record 和 Supabase row 分层映射，不要求三者字段形状完全相同。
- Repository 按原子业务操作设计，而不是暴露逐对象 CRUD。

## 分层边界

```text
领域类型与纯 reducer
        │
        ▼
事务型 SessionRepository
        │
        ├── Dexie / IndexedDB（当前：本地转录与恢复）
        │
        └── Supabase / Postgres（字段稳定后：跨设备与 Node 权威数据）
```

页面和 reducer 不直接依赖 Dexie table，也不直接使用 Supabase 生成的 row 类型。存储适配层负责时间、可空字段、嵌套对象和关系表之间的转换。

## 阶段 A：领域模型与 reducer（README 第 4 步）

先实现 thread、run、segment 类型、事实 reducer 和独立投影函数，并用测试锁定以下行为：

- 源文和译文增量直接进入各自完整流，事实路径不依赖分段。
- 迟到 delta、缺失时间点、结尾冲刷和异常中断不会丢字。
- 阅读投影只读取两条完整字符串，独立切块后按顺序近似组合，无法成对的尾部标记为 `unpaired`。
- 暂停结束当前 run，继续在同一 thread 中追加新 run。
- 新 segment revision 与当前 revision 指针必须原子切换。

这一阶段不需要 Supabase 账号或数据库迁移。

## 阶段 B：可重建的 Dexie 本地库（README 第 5 步）

转录第一版建立三个事实与投影 store；课堂清稿先后增加旧版整场投影和新版分块投影：

| Store                                 | 内容                                                        |
| ------------------------------------- | ----------------------------------------------------------- |
| `threads`                             | 产品会话、默认目标语言、标题和归档状态                      |
| `runs`                                | 收音生命周期、完整双流快照、恢复信息和当前 segment revision |
| `segments`                            | 当前及必要历史 revision 的可读双语段落                      |
| `autoSummaries`                       | 每个 thread 最新一版完整重算清稿、捕获长度、模型和 usage    |
| `cleanTranscriptBlocks`               | 每个 thread 按稳定字幕范围累积的清稿块、状态、模型和 usage  |
| `revisionBatches` / `revisedSegments` | 修订对照请求审计与当前可读投影                              |
| `operationalLogs`                     | 最近 300 条应用级 warning/error、恢复状态与有界诊断         |

assistant branch 和 message 不进入这一阶段。待上传标记可以先作为上述 record 的本地元数据存在；真正设计同步队列时再决定是否增加独立 outbox。

`autoSummaries` 通过 Dexie version 2 加入；Dexie version 3 增加 `cleanTranscriptBlocks`；version 5 使用 `revisionBatches` / `revisedSegments` 保存当前修订对照；version 6 增加全局 `operationalLogs`。运行问题不进入会话 JSON 归档；原始双流仍是可重新生成阅读投影的完整事实来源，导入同一 thread 时会清除本地旧投影以免正文与导入事实不一致。

### Schema epoch

生产构建始终使用固定数据库名 `voxbraid`；开发构建在数据仍可丢弃的阶段使用带显式 epoch 的独立数据库名，例如：

```ts
const LOCAL_DB_EPOCH = 1;
const LOCAL_DB_NAME = import.meta.env.DEV ? `voxbraid-dev-${LOCAL_DB_EPOCH}` : 'voxbraid';
```

较大的 schema 改动可以递增开发 epoch，直接让新代码打开一套干净结构，而不为每次试验写升级脚本；epoch 变化不能影响生产库。若重要内容是在开发服务器中录制，它仍属于开发 epoch 数据，不能因为生产库名稳定就跳过以下纪律：

1. 第一次递增 epoch 之前，逐个导出仍需保留的 thread；开发期测试会话允许直接放弃，不为整库备份增加合并、去重和对账规则。
2. 递增 epoch 时不自动删除旧 IndexedDB；旧库作为人工恢复来源保留。
3. 一旦保存了任何不愿丢失的真实会议、课堂或讲座，epoch 阶段立即结束。
4. epoch 阶段结束后，所有本地 schema 变化使用 Dexie `version().upgrade()`，并测试从仍可能存在的旧版本升级。

Dexie 的 schema version 和 upgrade 机制见其 [Database Versioning](https://dexie.org/docs/Tutorial/Design) 文档；跨 store 原子写入使用 [Dexie transactions](https://dexie.org/docs/Dexie/Dexie.transaction%28%29)。

### Repository 以事务为单位

接口只随实际用例增长，首批操作建议为：

```ts
interface SessionRepository {
	saveCheckpoint(input: {
		thread: TranslationThread;
		run: CaptureRun;
		checkpointedAt: string;
	}): Promise<void>;
	loadThread(threadId: string): Promise<StoredThread | null>;
	listThreads(): Promise<TranslationThread[]>;
	replaceSegmentRevision(input: {
		run: CaptureRun;
		segments: TranscriptSegment[];
		checkpointedAt: string;
	}): Promise<void>;
	repairAbandonedRuns(threadId: string, checkpointedAt: string): Promise<CaptureRun[]>;
	clearCleanTranscript(threadId: string): Promise<void>;
	exportThread(threadId: string, exportedAt: string): Promise<string>;
	importThread(json: string, checkpointedAt: string): Promise<string>;
}
```

- `saveCheckpoint` 在一个事务中保存 thread 元数据、完整流快照和 run 元数据；实时事实路径不依赖 segment。本地 record 可以保存 `checkpointedAt` 等恢复元数据，但这些字段不进入领域类型。run 双流是 append-only 事实，checkpoint 与派生投影保存路径都可以延长双流，但任何写入路径都不得用较短快照回退已落盘内容；非前缀变化必须拒绝。
- `replaceSegmentRevision` 在一个事务内写入新 revision 的全部 segment，并切换 `run.currentSegmentRevision`。
- `repairAbandonedRuns` 在页面恢复时一次性修复遗留 run。
- `clearCleanTranscript` 在一个事务中只删除旧整场清稿和新版分块清稿投影，供用户明确选择“重新整理全部”；它不能触碰字幕事实。
- `exportThread` 和 `importThread` 使用带 `schemaVersion` 的 thread 级 JSON；导入前验证对象结构、跨 thread 引用和稳定顺序号，再在一个事务内替换该 thread 的本地记录。相同文件重复导入按稳定 thread ID 覆盖恢复，不创建副本；MVP 不增加整库归档格式。
- 本地库打开后尽力调用浏览器 Storage API 请求持久存储。浏览器可能拒绝或不支持该请求，因此它只降低自动回收风险，不能替代逐会话 JSON 备份。
- 完整流变脏后以 10 秒为最大合并间隔保存。这里使用持续写入也会周期触发的 throttle/coalescing 语义，不能把普通 trailing debounce 重置到连续讲话结束才第一次落盘。暂停、连接失败、页面隐藏和 `pagehide` 时立即 flush `saveCheckpoint`；组件卸载不能直接丢弃最后的内存状态。浏览器可能随时终止异步卸载工作，因此恢复能力不能只依赖最后一次 unload 写入。
- 页面侧 checkpoint 协调器使用 `clean / dirty / saving / saving-dirty` 四态，而不是单个 dirty 布尔值。保存期间出现的新 delta 必须进入 `saving-dirty`，旧快照完成后仍保持待保存；写入失败回到 `dirty` 并保留原始错误供日志和重试，不另设会阻断实时翻译的失败终态。
- `SessionRepository` 的输入必须是可结构化克隆的普通领域对象。Svelte `$state` 的深层代理不能直接交给 IndexedDB；页面在 Repository 边界必须先取得普通对象快照。该约束需要由真实浏览器持久化测试覆盖，`fake-indexeddb` 上使用普通测试对象无法暴露代理克隆错误；以后每增加一条 Repository 页面写入路径，必须同步增加一个真实浏览器场景并保持控制台零错误断言。
- 页面启动时先修复最近 thread 中遗留的活动 run，再恢复完整双流；恢复完成前暂不允许选择语言或开始新 run，避免新状态被异步恢复覆盖。恢复设有有限等待时间，IndexedDB 拒绝或持续阻塞时都明确降级，但实时翻译可继续以内存模式运行。
- 已有 thread 停止收音后可以显式新建会话；旧 thread 保留在本地库中，后续 run 不再永久追加到同一个产品会话。页面使用轻量 thread 列表切换会话，只有选中时才加载对应 runs 和完整字幕；活动收音期间禁止切换。会话首次获得足够的源文时本地生成稳定标题；搜索、手动重命名、删除、归档和历史阅读投影留到会话管理后续阶段。以后实现 thread 删除时，必须在同一事务中删除该 thread 的 runs、segments、`autoSummaries` 和 `cleanTranscriptBlocks` 投影，不能遗留清稿孤儿记录。
- 当前 checkpoint 会重写 run 内两条完整流，累计写入量随长会话呈二次增长。如果 10 秒的崩溃丢失窗口以后不可接受，正式解法是增加追加式 `stream_chunks`，让每次只保存新增文本；不能单纯缩短完整快照间隔来换取更高写入放大。MVP 暂不增加该 store。

不要先设计 `saveThread`、`saveRun`、`saveSegment` 一类通用接口再由页面拼事务；这会让关键原子性依赖每个调用方都正确组合。

## 阶段 C：固化 Supabase 首版 Schema（README 第 7 步）

满足以下条件后才开始固化：

- thread、run、segment 字段已经由真实会话验证。
- reducer 和 Dexie 恢复路径稳定，至少经历过暂停、刷新、页面回收和异常断线测试。
- 已经不再频繁重命名字段或调整对象边界。

固化流程：

1. 在 `supabase/schemas/*.sql` 编写声明式 schema，开发期允许直接修改这些文件。
2. 用 `supabase db diff -f initial_schema` 生成首版 migration，并人工审查 SQL。
3. 显式补齐 RLS、view、函数、触发器、复合外键和级联规则，不假设 diff 能完整推导所有对象。
4. 用 `supabase db reset` 从零重建并运行约束测试。
5. 验证后才连接远端项目并执行 `supabase db push`。

Supabase 官方推荐用 migration 管理本地数据库变更，也支持以 `supabase/schemas` 声明当前目标结构再生成差异；RLS policy 等对象需要特别复核：[Database Migrations](https://supabase.com/docs/guides/local-development/database-migrations)、[Declarative Database Schemas](https://supabase.com/docs/guides/local-development/declarative-database-schemas)。

迁移只有一个权威来源。MVP 不再同时引入 Prisma 或 Drizzle 的第二套 migration 系统。

### 迁移纪律分界

- 远端尚无重要数据：允许重写或 squash 成一份干净的初始 migration。
- 远端开始保存重要数据：已经应用的 migration 不再修改，只追加向前迁移。
- 每次 migration 都必须通过空库重建测试；涉及删除或外键时还要覆盖真实升级路径。

Supabase 首批表仍是 `translation_threads`、`capture_runs`、`transcript_segments`。GPT 8a 开始时再增加 `assistant_branches`、`assistant_messages` 和按需的 `assistant_message_context_segments`，不增加 context snapshot 或 pricing snapshot 表。

## 阶段 D：GPT 支线（README 第 8–9 步）

GPT 支线依赖 Node + Supabase 的持久化闭环，不在 Dexie 过渡期提前实现：

1. Node 在内存中解析轻量上下文范围并完成预算检查。
2. 预算通过后，以一个事务创建用户消息和 pending assistant message。
3. 发送给模型的必须是刚刚参与预算检查的同一份内存文本。
4. Node 在返回浏览器之前事务性保存回答和 usage。
5. 遗留 pending、迟到恢复、重试和硬删除边界遵守核心会话模型。

非流式 8a 稳定后再评估流式 8b。开放给其他用户或需要正式账单时，再增加 Auth、RLS 强化、pricing snapshot 和对账系统。

项目级实施顺序只以 README 为准；本文只说明各存储阶段内部的依赖和退出条件，不另设并行路线图。
