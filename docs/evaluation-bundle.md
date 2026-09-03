# VoxBraid 效果评估数据包

状态：evaluation bundle v1 已实现。它是面向脚本与 LLM 的单会话 JSON 快照，不是恢复格式，不能导入。

## 与恢复备份的边界

- archive v4 只承担可验证、可原子恢复的 thread 事实与投影。
- evaluation bundle v1 以同一份 archive 内容为主体，再加入分析所需的冗余指标、运行日志与运行期诊断。
- 评估包没有向后导入承诺；指标算法变化时可以升 evaluation schema，而不影响用户备份。
- 两种文件都不包含音频、API key、Basic Auth 凭证或 WebSocket 连接内缓存。

## v1 内容

```text
kind / schemaVersion / exportedAt
summary                  usage、metrics 与 limitations 的顶层副本，供 LLM 优先读取
producer                 commitSha、commitMessage、dirty
captureSettings          导出时 UI 中的转写模型、降噪与目标语言（明确标为 export-time-ui）
facts                    thread、runs、完整 Live 原文与实时译文
projections
  legacyAlignedSegments  旧的近似双语分段投影
  cleanTranscript        旧整场清稿与当前分块清稿，包括失败、模型和 usage
  revision               当前修订段，以及每一次成功/失败 batch 的审计元数据、usage、传输诊断
usage
  realtimeEstimate       时长、估算费用和定价快照
  cleanTranscript        已记录/不可用数量及 token 合计
  revision               已记录/不可用数量及 token 合计
  persistedProjectionTasks 清稿与修订两类已持久化任务的 token 合计
  officialAccountSnapshot 页面最近取得的账户级官方消费快照；不宣称归因于当前 thread
metrics                  字符量、清稿/修订覆盖率、长段率、WebSocket 链命中与延迟分桶、日志计数
diagnostics
  operationalLogs        当前 thread 的日志，以及 threadId 为空的全局环境日志
  realtimeLatestRun      仅当页面内最近一次原始报告属于当前 thread 时写入，否则为 null
```

评估时先把顶层 `summary` 交给 LLM；它包含消费、覆盖率、传输表现、运行问题计数和数据边界，足以先判断是否需要继续读取明细。`facts`、`projections` 与 `diagnostics` 保留完整数据，主要供脚本分析，或在摘要暴露出具体问题后按需补充给 LLM。`summary` 是小体积冗余，不替代下方的完整字段。

评估包顶层 `limitations` 明确列出当前数据边界：自由对话仍只存在页面内存；Realtime 原始事件只覆盖当前 thread 最近一次仍在内存的报告并受事件上限约束；导出时 UI 配置不是逐 run 历史；被后续修订替换的旧成功草稿正文没有留存；失败清稿重试不保存每次尝试的 usage。评估包诚实输出现有记录，不从缺失字段推算。若这些数据以后持久化，可以在 evaluation schema 升级后纳入。
