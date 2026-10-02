# Clock Uncertainty Correlation

多节点事故分析用的**带不确定性时间关联内核**。它是一个可被其他 Node.js 程序调用的库
（没有命令行入口），解决的问题是：

- 各服务只写本机**单调计数**和（可能偏移/漂移的）**墙上时间**，偶尔收到与参考时钟的
  **往返校准（RTT）记录**；
- 直接按墙上时间排序会给出错误因果；
- 需要判断两件事究竟**已被证明先后**，还是只能说**时间区间重叠（未知）**；
- 校准不是恒定偏移、RTT 只限定一个范围，节点时钟还会缓慢漂移；
- 输入事实持续追加，旧版本的判断必须可重复，不能被后续追加悄悄改写。

本库不生成模拟日志、不访问任何外部时间服务器，也从不把不同节点的原始墙上时间
当作全局事实——`wall` 字段只登记留存，不参与任何排序。

## 安装与测试

```bash
npm test            # 功能/语义测试（性能用例默认跳过）
RUN_PERF=1 npm test # 额外运行 3 万事件规模的性能用例
```

无外部运行时依赖，Node.js >= 18（使用内置 `node:test`、ESM、`structuredClone`）。

## 快速上手

```js
import { CorrelationKernel } from 'clock-uncertainty-correlation';

const k = new CorrelationKernel();

k.addNode({ id: 'api', maxDriftRate: 1e-6 }); // 可选；默认 1e-6
k.addNode({ id: 'db',  maxDriftRate: 1e-6 });

// 一次往返校准：本地单调时刻 m0..m1 期间，参考时钟落在 r0..r1
k.addCalibration({ node: 'api', id: 'c1', m0: 1000, m1: 1006, r0: 5000, r1: 5002 });

k.addEvent({ node: 'api', id: 'req',  mono: 1003, wall: 1700000000123 });
k.addEvent({ node: 'db',  id: 'done', mono: 2050 });

// 跨节点消息：api 在单调 1003 发送的消息，db 在单调 2050 收到
k.addMessage({ id: 'm1', from: 'api', to: 'db', fromMono: 1003, toMono: 2050 });

const v = k.currentVersion;

const r = k.query({ range: [4900, 5100] }); // 局部窗口关联
r.events;    // 每个事件在参考时间上可能处于的区间
r.proven;    // 已证明的先后关系（证据：链边/消息边，或区间不重叠）
r.unknown;   // 尚不能证明先后的事件对（区间重叠）
r.conflicts; // 输入自相矛盾的定位说明（与“未知”严格区分）

k.compare({ node: 'api', id: 'req' }, { node: 'db', id: 'done' });
// { relation: 'before',
//   evidence: [ { kind: 'message', refId: 'm1', from: 'apireq', to: 'dbdone' } ] }

k.query({ version: v });        // 任何旧版本可重复查询，结果被 Object.freeze 冻结
k.changes({ fromVersion: v });  // 新版本下区间收紧 / 关系改变 / 新增冲突
```

## 输入接口（全部 append-only）

| 方法 | 字段 | 含义 |
| --- | --- | --- |
| `addNode({id, maxDriftRate?})` | `maxDriftRate ∈ [0,1)`，默认 `1e-6` | 声明节点时钟相对参考时间的速率界 `rate ∈ [1-ρ,1+ρ]` |
| `addEvent({node, id, mono, wall?})` | `mono` 有限数；`wall` 仅留存 | 提交事件。同节点 `mono` 重复是结构性错误，直接抛 `ValidationError` |
| `addCalibration({node, id, m0,m1, r0,r1})` | `m1≥m0, r1≥r0` | 往返观测：本地单调时刻处于 `[m0,m1]` 的某真实瞬间，参考时钟值处于 `[r0,r1]` |
| `addMessage({id, from, to, fromMono, toMono})` | | 因果约束：`from` 节点 `fromMono` 的发送严格先于 `to` 节点 `toMono` 的接收。**允许先于事件提交**：端点事件齐备前为 pending（查询中以 warning 明示），齐备时自动生效 |

每次成功提交返回一个**新版本号**（= 事实日志长度）。输入用法错误（缺字段、区间反向、
重复 id 等）抛 `ValidationError`；**事实之间互相矛盾不抛异常**，在查询结果的
`conflicts` 中返回可定位的说明。

## 查询接口

### `query(opts?)`

事件选择集（给任一即做局部查询，并在该选择集上枚举事件对）：

- `range: [lo, hi]`：参考时间窗口。区间与窗口相交的事件入选；与入选事件由消息边
  邻接的**未校准**事件也一并纳入（它们没有可用的参考时间，但因果关系仍可判断）。
- `nodes: string[]`：只保留这些节点。
- `events: (string | {node,id})[]`：显式事件列表。
- 都不给：返回**全历史事件区间视图**（`pairsEnumerated:false`，不做 O(N²) 配对）。

其他选项：`version`（指定历史版本）、`pairs`（强制/关闭事件对枚举）、
`includeUnknown`（默认 true）、`includeSameNodeRelations`（默认 false）。

结果字段：

```text
{
  version, latestVersion, range, pairsEnumerated,
  events: [{
    key, id, node, mono, wall,
    calibrated: boolean,                  // 该节点是否存在任何校准
    referenceInterval: [lo,hi] | null,    // 校准锥给出的原始区间
    effectiveInterval: [lo,hi|null,...] | null, // 纳入消息/链传播后的最紧区间
    rawLowerCalibrations, rawUpperCalibrations: string[], // 支撑边界的校准 id
  }],
  proven:  [{ a, b, relation: 'before'|'after', evidence }],
  unknown: [{ a, b, relation: 'unknown', evidence: null }],
  conflicts: ConflictReport[],
  conflictsTruncated: number,  // 矛盾过多时未收录的条数（语义不静默丢弃）
  warnings: [{ kind: 'unresolved-message', ... }],
}
```

事件 key 为 `node + '\\u0001' + id`，也可以始终用 `{node,id}` 引用，
`eventKey(node,id)` 由库导出。返回对象整体 `Object.freeze`，
调用方持有的快照不会被后续追加改写。

### `compare(a, b, opts?)`

只判断两个事件，不扫描全体事件。`evidence` 两类：

- **图证据**：`[{kind:'chain'|'message', refId, from, to}, ...]`，可核对的约束链；
- **时钟证据**：`{kind:'clock', aUpper, bLower, aUpperCals, bLowerCals, note}`，
  即一个事件的参考时间**上界严格小于**另一个的下界（端点相接不算证明）。

### `changes({fromVersion, toVersion?, range?, nodes?, events?})`

比较两个版本：

- `changed`：`event-added` / `interval-tightened`（含 `before`/`after` 区间）；
- `relationChanges`：`relation-appeared` / `relation-changed`（旧/新关系 + 证据）；
- `conflictsAdded`、`warningsResolved`（如先到的消息后来被事件补齐）。

追加只会**收紧**区间、只会让 unknown 变 before/after，不会使已证明关系倒退或翻转。

## 不确定性模型（为什么不能照抄墙上毫秒数）

一次校准只保证存在锚点 `(m*, r*) ∈ [m0,m1]×[r0,r1]`。设节点时钟相对参考时间的
速率恒满足 `rate ∈ [1-ρ,1+ρ]`，则在任意单调计数 x 处，该校准允许：

```text
cone_lo(x) = x ≤ m1 ? r0 - (1+ρ)(m1-x) : r0 + (1-ρ)(x-m1)
cone_hi(x) = x ≤ m0 ? r1 - (1-ρ)(m0-x) : r1 + (1+ρ)(x-m0)
```

多次校准取交集：`envLo(x)=max cone_lo`，`envHi(x)=min cone_hi`。

- 零 RTT（`m0=m1, r0=r1`）退化为从精确锚点展开的速率锥；
- `ρ=0` 表示假定恒速率，RTT 宽度仍保留；
- 未校准节点在所有 x 上为 `±∞`，输出 `calibrated:false`、区间 `null`，
  **绝不伪造精确参考时间**；
- `envLo > envHi` 即观测之间（含漂移率假设）无法同时成立。

在此之上叠加偏序约束（同节点单调序 + 消息边）做差分约束传播：
`u 先于 v ⇒ t(v) ≥ t(u)` 与 `t(u) ≤ t(v)`。每个事件得到“最紧可行区间”，
两事件只有在**图上可达**或**区间严格不重叠**时才判 `before/after`，
否则一律 `unknown`——界面上毫秒数字小不构成因果。

## 矛盾 vs 证据不足

- **证据不足** → `relation:'unknown'` / `calibrated:false`，`conflicts` 为空；
- **输入矛盾** → `conflicts` 中给出类型与可定位证据：
  - `cycle`：单调序 + 消息边成环（给出沿环的消息/链边路径；环边登记但不入图，
    不会靠“丢掉一条”来制造确定排序）；
  - `clock-model`：校准锥在某单调计数（可定位到事件或校准断点）处为空，
    给出撑出矛盾下界/上界的具体校准 id；
  - `clock-path`：消息/链要求的顺序与校准时间范围无法同时成立，
    给出传播链与两端支撑校准。

病态输入下矛盾数量可能极大：证据链截断到 64 步（中段以省略标记表示）、
登记表封顶 5000 条，超出部分计入 `conflictsTruncated`。

## 增量与复杂度

- 事件按节点有序数组二分插入；新事件只在自身 mono 处求一次全部校准锥 O(C)；
- 校准区间用分段线性扫描（堆）在折点上求交，新增校准只重算本节点；
- 区间传播是有界单调松弛（Bellman-Ford 风格），约束只增不减，队列复用、无 `shift` 二次开销；
- 消息端点只维护**稀疏邻接表**，可达性按需 DFS（复用 `Int32Array` 邮戳，无分配尖峰）；
  刻意不维护全量传递闭包——稠密图上闭包更新是 O(E²) 且会爆内存；
- `compare` 是按需 DFS 或常数区间比较，不扫描全历史；
- 局部窗口选择为 O(E + 消息邻接)；事件对 O(S²) 只在窗口选择集 S 上计算；
- 旧版本查询通过 append-only 事实日志确定性重放得到，live 状态不受影响。

实测（`RUN_PERF=1`，3 万事件 / 200 校准 / 5000 消息）：增量追加约 2–3 秒、
窄窗口查询亚秒级、百次两两比较约 10ms、早期版本重放毫秒级、峰值堆约 250MB。

## 目录

```text
src/model.js    RTT 矩形 + 漂移率锥 → 参考时间可行区间（纯函数）
src/engine.js   事件/校准/消息的增量状态、偏序图、区间传播、冲突登记
src/kernel.js   append-only 日志、版本化 query/compare/changes、结果冻结
src/errors.js   ValidationError
test/           模型、引擎、版本化、矛盾负载、性能测试
```
