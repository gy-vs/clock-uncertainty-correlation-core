# Clock Uncertainty Correlation

多节点时间关联内核（Node.js 库，非命令行工具）。面向事故分析等场景：若干服务各自记录**本机单调计数**与墙上时间，并偶尔与参考时钟做往返校准。本库回答的问题是：在时钟偏移、往返延迟与缓慢漂移都存在的情况下，两个事件之间**能证明**什么先后关系、每个事件可能落在参考时间的哪个**区间**、哪些关系只能判定为**未知**——而不是凭界面上毫秒数字的大小臆测因果。

本库不生成模拟日志、不访问外部时间服务器，也从不把不同节点的原始墙上时间当作全局事实（事件携带的 `wall` 字段仅被存储和回显，不参与任何推导）。

## 模型

- **事件**：`{id, node, mono, wall?}`。`mono` 是本机单调计数，同一节点内唯一且隐含先后顺序。
- **校准观测**：`{id, node, m1, m2, t1, t2}`，表示一次往返：本地计数 `m1` 发出请求，参考时钟于 `t1` 收到、`t2` 回复，本地计数 `m2` 收到回复（`m1<=m2, t1<=t2`）。它不是"永远准确的偏移常数"，而是给出硬边界：
  `ref(m1) ∈ [t2 − (m2−m1)(1+ρ), t1]`，`ref(m2) ∈ [t2, t1 + (m2−m1)(1+ρ)]`。
- **漂移**：`createKernel({maxDriftRate: ρ})`（默认 `1e-4`）。本地计数与参考时间须使用相同单位（如都为毫秒）；事件越远离校准点，区间越宽。
- **消息边**：`{send: eventId, recv: eventId}`，附加的因果约束（发送不晚于接收）。即使两侧墙上时间相同、甚至一侧完全未校准，消息边仍能证明先后。

## API

```js
const { createKernel } = require('clock-uncertainty-correlation');
const k = createKernel({ maxDriftRate: 1e-4 });
```

### 追加（返回新版本，旧版本永不被改写）

```js
const v1 = k.append(k.initial, {
  calibrations: [/* ... */],
  events: [/* ... */],
  messages: [{ send: 'evtA', recv: 'evtB' }],
});
const v2 = k.append(v1, { calibrations: [/* 更晚的校准 */] });
```

输入畸形（重复 id、同节点重复单调计数、`m1>m2`、消息端点不存在等）会**抛异常**——这是调用错误，与"数据互相矛盾"（见 `conflicts`）是两类情况。

### 查询（全部以版本句柄为第一个参数）

- `k.interval(v, eventId)` → `{lo, hi, boundedBelow, boundedAbove, inconsistent, calibrationConflict, ...}`；未知事件返回 `null`。未校准节点返回无界区间，**不会**被赋予看似精确的参考时间。
- `k.relation(v, aId, bId)` → `{order, basis, aInterval, bInterval}`。`order ∈ 'before' | 'after' | 'unknown' | 'same' | 'conflict'`；`basis` 标明依据是 `causal`（单调序 + 消息边，向量时钟判定）还是 `time`（参考时间区间不重叠）。
- `k.scan(v, {lo?, hi?})` → 参考时间窗口内所有可能事件的数组（含各自区间）；利用单调序与预计算的包络剪枝，不扫描全部历史。
- `k.conflicts(v)` → 冲突数组，每条都定位到相关观测/事件：
  - `calibration-inconsistent`：同一节点的校准观测在漂移上界下无法同时成立（`calibrations: [...]`）；
  - `message-violates-monotonic`：消息接收在同节点单调序中不晚于发送；
  - `message-violates-calibration`：校准区间把接收整个放在发送之前（附双方区间）；
  - `causal-cycle`：消息边与单调序构成环（`events: [...]`）。
- `k.diff(vOld, vNew, {pairs?})` → 两个版本间发生改变的判断：新增事件/校准/消息、区间收紧（`intervalChanges`）、新增/解除的冲突，以及指定事件对的 `relationChanges`。
- `k.get(v, eventId)`、`k.stats(v)`。

### 语义要点

- **缺少证据 ≠ 矛盾**：区间重叠或没有因果路径时返回 `unknown`；只有约束无法同时成立时才产生 `conflicts` 条目。任何冲突都不会通过悄悄丢弃某条观测来"制造"确定排序；矛盾区域的区间被标记为 `inconsistent`，涉冲突事件的 `relation` 回退为 `unknown` 或 `conflict`。
- **版本**：版本句柄是不可变快照（按节点结构共享）。持旧版本再查询，结果与当时完全一致；追加只会产生新版本。
- **性能**：单事件区间查询为 O(log 校准数)；先后判定为 O(节点数)（向量时钟，按版本惰性计算一次）；`scan` 按节点二分剪枝。3 万事件、300 批追加约 1 秒，两千次关系判定约 0.1 秒（见 `test/performance.test.js`）。

## 测试

```sh
npm test
```

测试覆盖：连续追加与旧版本不可改写、跨节点消息（含墙上时间相同/倒挂）、校准修正后重新查询与 `diff`、三类矛盾报告、未校准节点的无界区间、漂移导致的区间展宽、窗口扫描，以及 3 万事件的追加与局部查询性能。
