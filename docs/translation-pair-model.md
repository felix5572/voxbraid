# VoxBraid Live 事实与子句级修订对照投影

状态：第四版「子句原子 + 语义重组」已实现，等待真实课程观测。
核对日期：2026-09-02。

## 一、产品定位

页面保留 OpenAI Realtime 返回的两条最快事实流，并在其下提供一份可回望修订的阅读投影：

```text
麦克风音频
  └─ Realtime Translation session
       ├─ sourceStream       Live 原文事实（gpt-live-transcribe）
       └─ translationStream  Live 译文事实（gpt-realtime-translate）

sourceStream
  └─ 本地按 ASR 标点切成请求级子句原子
       └─ gpt-5.6-luna 有界滑动尾窗
            ├─ revisedSourceText  修订原文
            └─ translatedText     对照译文
```

四种文本的职责不同：

1. Live 原文逐 delta 原样追加，是修订投影唯一的原文证据，不能被 Luna 回写。
2. Live 译文由翻译模型直接听音频得到，继续独立保存和展示。
3. 修订原文在有限尾窗内修复标点、明显识别碎片和句段组织，但始终保留对应 raw 范围。
4. 对照译文与修订原文由同一次 Luna 请求生成，左右两栏引用同一组 raw 子句原子。

句段对照不读取 Live 译文。Realtime 原文和译文没有可靠的逐句坐标，硬拼会制造虚假对齐；新译文只从可见 raw 原文生成，才是可验证的对照版本。

它也不是课堂清稿的缩小版。课堂清稿面向长范围，允许保守恢复缺口；句段对照只处理几十秒以内的开放尾窗，目标是先显示、后修订、低延迟和稳定阅读。

## 二、页面与展示语义

修订区每个 run 同时可能有三层内容：

```text
frozen segments    修订原文 | 对照译文    自动流程不再修改
open segments      修订原文 | 对照译文    标「修订中」，可被下一版整体替换
live raw tail      Live 原文 | 空          标「实时」，delta 到达即追加
```

`liveTail = sourceStream.text.slice(max(openEnd, frozenEnd))`，只从事实流派生，不持久化。Luna 在飞时新增 raw 仍立即追加；响应完成并通过整批校验后，只替换它捕获到的范围，更新期间的新尾巴继续保留。

展示纪律：

- 默认阅读态隐藏 raw 坐标、batch/request ID、attempt 和 token 数；页面级诊断模式统一显示这些信息。
- `实时`、`修订中`、`句未完`、课程时间和等待原因属于阅读状态，不随诊断开关隐藏。
- frozen 前缀不被自动请求重写；open 尾窗可以根据更多后文重新断句、合句和翻译。
- 文本确实变化时以低对比背景短暂提示；仅状态从 open 变 frozen 不闪动。
- 失败摘要始终可见且可展开完整原始错误；失败不清空上一版成功草稿。
- 用户向上滚动后暂停自动跟随，并可显式回到最新。
- 每个 run 使用创建时的目标语言；窄屏可把单行左右栏改为上下排列，但不能拆散对应关系。

全课程重排不属于实时默认行为。需要时应由用户显式发起，避免阅读位置持续漂移，也避免与课堂清稿职责重叠。

## 三、子句原子坐标系

### 3.1 本地切分

浏览器把本次 `[frozenEnd, capturedSourceEnd)` 按 ASR 标点切成连续子句原子：

```ts
type SourceAtomBoundary = 'sentence' | 'clause' | 'open' | 'forced';

interface SourceClauseAtom {
	index: number; // 当前请求内从 1 开始
	start: number; // sourceStream 的绝对 UTF-16 偏移
	end: number;
	text: string; // 所有 atom 首尾相接，逐字还原请求 raw
	boundary: SourceAtomBoundary;
}
```

确定性切分规则：

- `. ! ? 。！？` 形成 `sentence`，沿用小数、常见缩写和 initialism 保护；
- `，；：` 直接形成 `clause`；
- ASCII `, ; :` 仅在后接空白或输入末尾时形成 `clause`，避免 `3,000` 和 URL 内部误切；
- `—` 仅在独立出现或两侧为空白时形成 `clause`；
- `、` 不切；
- 窗口末尾没有标点的部分为 `open`；
- 无标点连续范围超过约 240 字时，按最近词边界产生 `forced` 原子，保证坐标仍小且请求可推进。

空白归入相邻原子，所有原子逐字拼接必须等于 raw。原子只服务于一次请求，不持久化；持久化身份仍是绝对 `sourceStart/sourceEnd`。

服务端用同一纯函数重新切分并逐项核对起止、文本与 boundary，防止浏览器提供另一套坐标。缺少 `Intl.Segmenter` 时明确报错，不静默退化为逐字符协议。

### 3.2 模型输入与输出

发送给模型的当前事实只保留一套请求内坐标：

```json
[
	{ "i": 1, "t": "Okay, ", "boundary": "clause" },
	{ "i": 2, "t": "today we study Fourier transforms.", "boundary": "sentence" }
]
```

模型输出连续原子范围：

```ts
interface RevisionGroup {
	firstAtom: number;
	lastAtom: number;
	revisedSourceText: string;
	translatedText: string;
	paragraphBreakBefore: boolean;
}
```

应用由 `firstAtom/lastAtom` 自行拼出不可修改的 `rawText`。模型可以：

- 把短碎片、口头承接或明显续句合成一行；
- 在逗号、分号等子句边界拆开 ASR 连成的长句；
- 根据提问、回答、话题转换或论述步骤另起段落。

默认偏好是一句一行，但这只是提示词偏好。协议不限制“一组最多几句”或“一组最多几个原子”：真正影响阅读的是 raw 行长，不是句号或原子数量。三个很短的碎片句可以合理合并；两句很长的内容仍会被长度偏好要求拆开。

服务端硬校验：

1. 第一组从 atom 1 开始，后续 `firstAtom === 上组 lastAtom + 1`；
2. `lastAtom >= firstAtom` 且不越界，末组覆盖最后一个 atom；
3. 所有组严格按顺序把请求 raw 铺满一次，无空洞、重叠或编号重置；
4. 修订原文和译文非空，总输出不超过产品上限；
5. 整批 raw 不超过 1,600 字。

这些硬错误绝不猜测或 forced 接受。首轮边界错误会保存失败审计，并把模型返回的无效 `{firstAtom,lastAtom}` 序列加入一次定向纠正请求；第二次仍错就停止，同一 raw 不再自动付费重试。

### 3.3 240 字软行长

单组 raw 约 240 字是可读性偏好，不是正确性约束：

- 第一次只有组长度超限时，保存失败审计并针对同一 raw 定向重试一次；
- 第二次唯一违规仍是组长度时，无论包含几个原子或句子都接受；首轮超限失败与第二次成功分别留在审计链中；
- 第二次若还有覆盖、顺序、越界、空输出等硬错误，仍然失败。

这样不会因模型坚持保留一个长句而锁死窗口。任何窗口在至多两次请求后前进或明确失败；同样的失败输入不会在每秒 tick 中无限重放。

### 3.4 previousDraft

下一次请求携带上一版 open segments，帮助模型在没有新证据时保持分组和措辞。浏览器发送前只保留起止位置仍与本次原子边界对齐的 draft；例如 raw 从 `3,` 增长为 `3,000` 导致重切时，失配旧稿直接不发，不因此拒绝整个请求。服务端仍严格拒绝任何未对齐 draft。

真正发给模型的 previousDraft 只包含请求内 `firstAtom/lastAtom` 与两栏派生文本，不暴露绝对字符坐标。当前 raw 始终拥有最高证据地位，旧稿只是稳定性提示。

## 四、触发、回望与冻结

### 4.1 有界触发

```ts
capturedSourceEnd = Math.min(sourceStream.text.length, frozenEnd + 1_600);
```

相对最近一次 batch 的 `openEnd` 出现新文本，满足以下任一条件即可请求：

- 新增文本出现任意 clause/sentence 标点边界；
- 新增无标点原文至少 40 字且安静约 1.2 秒；短于 40 字的犹豫停顿不单独产生付费请求；
- 开放窗口约 20 秒或约 800 字；
- run 结束；
- 用户显式触发。

自动请求至少间隔 4 秒；手动与 finalizing 绕过。积压超出 1,600 字时，当前窗口成功推进后继续分批追赶，不等待新 delta。请求在飞期间只继续追加事实流，不并发第二个句段请求。

### 4.2 连续前缀冻结

冻结不是逐组独立打标签，而是推进一个连续前缀游标：

- 正常自动提交时，冻结游标只能落在以 `sentence` 原子结束的组之后；游标落下后，其前所有组一起 frozen；
- 尾部保留按最近两个完整句子计算，而不是按“最近两个组”计算，因为一句话可能被拆成多组；
- 长静默且草稿已覆盖全部 raw、尾部是自然句末时，本地把 open 全部转 frozen，不重复调用模型；
- finalizing 时草稿已覆盖全部 raw，同样本地冻结；仍有 raw 尾巴时才发最后一次请求；
- 无自然句末且达到 1,600 字硬窗口时，允许在合法组边界强制推进，段保持 `forced-tail`，避免永久停滞。

落库 `boundaryState` 只表达组末原子的事实：末原子为 `sentence` 时是 `complete`，其余 `clause/open/forced` 都是 `forced-tail`。它不编码组内句数，也不把软行长超限伪装成句末状态。

## 五、持久化与备份

Live 原文每个 delta 立即进入页面状态；普通时段约 10 秒合并 checkpoint，暂停、失败、页面隐藏和 `pagehide` 立即 flush。当前模型不保存每个 Realtime event ID 或逐 delta 时间，因此 `sourceElapsedEndMs` 只能是生成时的近似课程位置，不能冒充精确逐句时间。

句段投影继续使用 Dexie v5 的 `revisionBatches` 与 `revisedSegments`：

- 每次 Luna 调用单独保存成功或失败 batch，保留 usage、response ID、原始错误和重试证据；
- 成功事务原子替换该 run 的 open segments，frozen 前缀不回写；
- 失败只写审计，上一版 open 草稿和 Live 尾巴仍可读；
- segments 必须与 `sourceStream.text.slice(sourceStart, sourceEnd)` 逐字一致并连续覆盖；
- `frozenEnd/openEnd` 从 segments 推导，不保存第二份游标事实。

第四版只更换请求级原子协议和任务版本，不改数据库字段，也不升 Dexie 或 archive schema。现有 v5 投影可继续显示；新请求用 taskVersion 4 写入后续 batch。调试阶段不保留旧协议运行时分支。

archive v3 继续导出事实和当前投影。v1/v2 导入只恢复仍满足当前不变量的 thread、runs 和旧 `segments` 事实，明确提示旧备份不含当前修订对照；不转换旧投影，也不自动产生 Luna 费用。

## 六、模型、调度与费用

修订任务使用 `gpt-5.6-luna`、Responses API、`reasoning.effort: none`、`store: false` 和非流式 Structured Outputs。schema 随 taskVersion 固定，不为每批 atom 动态生成 enum，避免 schema 首次编译延迟。

句段对照使用 `background-pairs` 单并发车道：

- 同一页面最多一个句段请求在飞；
- 交互问答可以与已在飞后台请求并行发起；
- 交互请求在飞时不启动新的后台请求，但不取消已经发出的请求；
- 页面隐藏、离线或持久化未恢复时不启动；
- 相同失败 raw 不自动重试，连续三次基础设施失败暂停 worker，用户可显式恢复。

微批次不调用 Input Tokens 预检。服务端在发 OpenAI 前限制：raw 1,600 字、continuity 1,500 字、最终 instructions + input 64KB。请求天然有界，额外计数只会增加一次网络往返。

每个 batch 保存真实 usage。真实课程应观测：每小时请求数、首稿延迟、冻结延迟、平均输入/输出 token、边界纠正率、软行长 forced 接受率、失败率和相邻草稿编辑距离。240 字、1.2 秒、4 秒、800/1,600 字都是可调起点，不是对三小时课程效果的先验保证。

## 七、验证范围

本地验证覆盖：

- 标点保护、子句/句末分类、无标点 forced 原子与逐字铺满；
- 任意新标点触发、四秒节流、安静窗口和 1,600 字追赶；
- 原子范围连续覆盖、缺口/重叠/越界拒绝；
- 多个短句可以合并，不存在句数或原子数硬限制；
- 240 字软超限只纠正一次，第二次接受；
- previousDraft 边界过滤与服务端严格校验；
- Live raw 先显示、请求期间继续追加、响应后只替换捕获范围；
- frozen 前缀稳定、收尾本地冻结、失败审计和同窗口不重复付费；
- 刷新恢复、长积压追赶和跨 thread 请求归属。

协议字段从 v3 的词 token `lastTokenIndex/lastTokenText` 改为 v4 的子句原子 `firstAtom/lastAtom`。下一步应运行一次 opt-in Luna 冒烟，再用真实课堂持续观察协议校验失败率与阅读分组；只有真实数据能决定是否继续调整标点与频率阈值。
