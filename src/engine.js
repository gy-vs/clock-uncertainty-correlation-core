'use strict';

import { computeEnvelope, evaluateCones } from './model.js';
import { ValidationError, assertFiniteNumber, assertString } from './errors.js';

const POS = Number.POSITIVE_INFINITY;
const NEG = Number.NEGATIVE_INFINITY;
export const DEFAULT_RHO = 1e-6;

export function eventKey(nodeId, eventId) {
  return `${nodeId}${eventId}`;
}

// ---------------------------------------------------------------------------
// Engine：持有「某个版本」的全部状态。live 引擎持续追加；历史版本通过重放得到
// 一个一次性的 replay 引擎，两者状态形状完全相同。
//
// 可达性刻意不做全量传递闭包：稠密图上闭包更新是 O(E^2) 且每个端点要持有
// 完整位集，会在数千条消息后耗尽内存。这里只增量维护邻接表，
// 成环检测与「a 是否到达 b」都按需在（稀疏的）邻接表上 DFS，O(V+E)。
// ---------------------------------------------------------------------------
export class Engine {
  constructor({ clockEpsilon = 0 } = {}) {
    if (typeof clockEpsilon !== 'number' || clockEpsilon < 0 || !Number.isFinite(clockEpsilon)) {
      throw new ValidationError('clockEpsilon 必须是非负有限数');
    }
    this.clockEpsilon = clockEpsilon;

    this.nodes = new Map(); // nodeId -> {id,rho,events,cals}
    this.events = new Map(); // key -> event
    this.eventOrder = []; // 按追加顺序的 key（供选择/重放）
    this.messages = new Map(); // msgId -> {id, from, to, fromMono, toMono}
    this.pending = new Map(); // `${side}:${msgId}` -> msgId（引用的事件尚未提交）

    // 消息端点图（稀疏邻接表）：只有出现在消息里的事件才是端点
    this.epIndex = new Map(); // event key -> 端点号
    this.epKey = []; // 端点号 -> key
    this.epSucc = new Map(); // 端点 key -> Set(后继端点 key)，含链边与消息边
    this.msgEdgeRef = new Map(); // 端点间消息边 `from=>to` -> 消息 id
    // 可达性 DFS 的复用邮戳（避免每次建 Set 的分配尖峰）
    this._epMark = null;
    this._epStamp = 0;

    // 事件级 successor/predecessor（含节点内链 + 消息边），供 eff 传播与路径
    this.succ = new Map();
    this.pred = new Map();

    // 冲突登记表（append-only；任何一条事实都不会被静默丢弃）。
    // 大规模矛盾输入可能产生海量冲突：证据链截断保留，登记表总量封顶，
    // 超出部分计入 conflictTruncated（query 结果带该计数，绝不静默丢弃语义）。
    this.conflicts = new Map(); // key -> conflict 对象
    this._conflictSeen = new Set(); // 已见过的冲突 id（用于去重统计）
    this.conflictTruncated = 0;
    this.conflictCap = 5_000;
    this.maxEvidenceChain = 64;
    this.edges = new Map(); // 边 key -> {from,to,kind}，去重

    this.version = 0;
  }

  // ---- 基础工具 -----------------------------------------------------------

  getEvent(key) {
    return this.events.get(key);
  }

  ensureNode(id, rho) {
    let n = this.nodes.get(id);
    if (!n) {
      n = { id, rho: rho ?? DEFAULT_RHO, events: [], cals: [], calSeq: 0 };
      this.nodes.set(id, n);
    } else if (rho !== undefined && rho !== n.rho) {
      throw new ValidationError(`节点 ${id} 的漂移率界在不同 addNode 调用中不一致`);
    }
    return n;
  }

  // 二分插入保持按 mono 升序；返回下标
  _insertSorted(arr, item) {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].mono < item.mono) lo = mid + 1;
      else hi = mid;
    }
    arr.splice(lo, 0, item);
    return lo;
  }

  // ---- 提交事实 -----------------------------------------------------------

  addNode({ id, maxDriftRate = DEFAULT_RHO } = {}) {
    assertString(id, 'node.id');
    if (typeof maxDriftRate !== 'number' || maxDriftRate < 0 || maxDriftRate >= 1) {
      throw new ValidationError('maxDriftRate 必须是 [0,1) 内的数值');
    }
    this.ensureNode(id, maxDriftRate);
  }

  addEvent({ node: nodeId, id, mono, wall } = {}) {
    assertString(nodeId, 'event.node');
    assertString(id, 'event.id');
    assertFiniteNumber(mono, 'event.mono');
    if (wall !== undefined) assertFiniteNumber(wall, 'event.wall');
    const key = eventKey(nodeId, id);
    if (this.events.has(key)) throw new ValidationError(`事件 ${key} 重复提交`);
    const n = this.ensureNode(nodeId);

    // 同一节点单调计数必须严格递增（相等是结构性输入错误），二分查找
    if (this._findByMono(nodeId, mono)) {
      throw new ValidationError(
        `节点 ${nodeId} 上单调计数 ${mono} 已对应另一事件，违反单调严格递增（新事件 id=${id}）`
      );
    }

    const ev = {
      id,
      node: nodeId,
      key,
      mono,
      wall: wall ?? null, // 墙上时间仅登记留存，绝不参与跨节点排序
      rawLo: NEG,
      rawHi: POS,
      rawLoCals: [],
      rawHiCals: [],
      effLo: NEG,
      effHi: POS,
      // 区间来源只保留「直接前驱事件 + 那条边」；完整证据链在出冲突时惰性回溯，
      // 避免在每次松弛上构造深层嵌套对象（大规模图上会撑爆内存）。
      effLoPred: null,
      effLoEdge: null,
      effHiPred: null,
      effHiEdge: null,
      clockConflict: null,
    };
    // 单事件校准区间：只在自己的 mono 处求值 O(C)，不重扫该节点其他事件
    if (n.cals.length) {
      const cell = evaluateCones(n.cals, mono, n.rho);
      ev.rawLo = cell.lo;
      ev.rawHi = cell.hi;
      ev.rawLoCals = cell.loCals;
      ev.rawHiCals = cell.hiCals;
      if (cell.lo > cell.hi) {
        ev.clockConflict = 'infeasible';
        this._registerClockConflict(n, ev, cell);
      }
    }
    this.events.set(key, ev);
    this.eventOrder.push(key);
    const idx = this._insertSorted(n.events, ev);

    // 节点内链边：与插入位置两侧事件建立顺序
    const before = idx > 0 ? n.events[idx - 1] : null;
    const after = idx < n.events.length - 1 ? n.events[idx + 1] : null;
    this._linkEvents(before, ev, 'chain');
    this._linkEvents(ev, after, 'chain');

    // 新增事件不改变任何校准锥；原始区间已在插入前单点求值，这里只做区间传播
    this._seedAndDrain(ev, before, after);

    // 绑定引用本事件的待决消息
    for (const [dKey, msgId] of [...this.pending]) {
      const msg = this.messages.get(msgId);
      if (
        (dKey === `from:${msgId}` && msg.from === nodeId && msg.fromMono === mono) ||
        (dKey === `to:${msgId}` && msg.to === nodeId && msg.toMono === mono)
      ) {
        this._tryResolveMessage(msg);
      }
    }
    return key;
  }

  addCalibration({ node: nodeId, id, m0, m1, r0, r1 } = {}) {
    assertString(nodeId, 'calibration.node');
    assertString(id, 'calibration.id');
    assertFiniteNumber(m0, 'm0');
    assertFiniteNumber(m1, 'm1');
    assertFiniteNumber(r0, 'r0');
    assertFiniteNumber(r1, 'r1');
    if (m1 < m0) throw new ValidationError(`校准 ${id}：m1(${m1}) < m0(${m0})，往返区间反向`);
    if (r1 < r0) throw new ValidationError(`校准 ${id}：r1(${r1}) < r0(${r0})，参考时钟区间反向`);
    const n = this.ensureNode(nodeId);
    if (n.cals.some((c) => c.id === id)) throw new ValidationError(`校准 ${id} 重复提交`);

    const cal = { id: `${nodeId}:${id}`, node: nodeId, shortId: id, m0, m1, r0, r1 };
    n.cals.push(cal); // 重算时统一排序
    this._refreshNodeIntervals(n);
    // 区间只会收紧：从该节点全部事件重新播种并扩散
    this._seedAndDrainAll(n);
    return cal.id;
  }

  addMessage({ id, from, to, fromMono, toMono } = {}) {
    assertString(id, 'message.id');
    assertString(from, 'message.from');
    assertString(to, 'message.to');
    assertFiniteNumber(fromMono, 'fromMono');
    assertFiniteNumber(toMono, 'toMono');
    if (this.messages.has(id)) throw new ValidationError(`消息 ${id} 重复提交`);
    // 节点可能尚未显式建立，先确保其存在以便校验同节点情况
    this.ensureNode(from);
    this.ensureNode(to);

    const msg = { id, from, to, fromMono, toMono, resolved: false, fromKey: null, toKey: null };
    this.messages.set(id, msg);
    if (from === to && fromMono >= toMono) {
      // 同节点消息要求严格早于，且直接与单调序比对
      this._registerConflict({
        type: 'cycle',
        id: `cycle:msg:${id}`,
        message: id,
        path: [{ kind: 'message', message: id, from: msgKey(from, fromMono), to: msgKey(to, toMono) }],
        detail: `消息 ${id} 声称 ${from}@${fromMono} -> ${to}@${toMono}，与同一节点单调序矛盾`,
      });
    }
    this._tryResolveMessage(msg);
    return id;
  }

  // ---- 消息解析与图维护 ----------------------------------------------------

  _tryResolveMessage(msg) {
    const fromEv = this._findByMono(msg.from, msg.fromMono);
    const toEv = this._findByMono(msg.to, msg.toMono);
    if (!fromEv) this.pending.set(`from:${msg.id}`, msg.id);
    else this.pending.delete(`from:${msg.id}`);
    if (!toEv) this.pending.set(`to:${msg.id}`, msg.id);
    else this.pending.delete(`to:${msg.id}`);
    if (!fromEv || !toEv || msg.resolved) return;

    msg.resolved = true;
    msg.fromKey = fromEv.key;
    msg.toKey = toEv.key;
    if (fromEv.key === toEv.key) {
      this._registerConflict({
        type: 'cycle',
        id: `cycle:msg:${msg.id}`,
        message: msg.id,
        path: [{ kind: 'message', message: msg.id, from: fromEv.key, to: toEv.key }],
        detail: `消息 ${msg.id} 的发送与接收落在同一事件 ${fromEv.key}`,
      });
      return;
    }
    this._addEndpoint(fromEv);
    this._addEndpoint(toEv);
    this._addGraphEdge(fromEv, toEv, 'message', msg.id);
  }

  _findByMono(nodeId, mono) {
    const n = this.nodes.get(nodeId);
    if (!n) return null;
    // 事件按 mono 有序；常见追加按时间正序，这里用二分
    const arr = n.events;
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].mono < mono) lo = mid + 1;
      else hi = mid;
    }
    return lo < arr.length && arr[lo].mono === mono ? arr[lo] : null;
  }

  _addEndpoint(ev) {
    if (this.epIndex.has(ev.key)) return;
    this.epIndex.set(ev.key, this.epKey.length);
    this.epKey.push(ev.key);
    this.epSucc.set(ev.key, new Set());

    // 与同节点相邻端点建立链边（端点集是事件集的子集，事件按 mono 有序）
    const n = this.nodes.get(ev.node);
    let pos = 0;
    {
      let lo = 0;
      let hi = n.events.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (n.events[mid].mono < ev.mono) lo = mid + 1;
        else hi = mid;
      }
      pos = lo;
    }
    for (let q = pos - 1; q >= 0; q--) {
      const p = n.events[q];
      if (this.epIndex.has(p.key)) {
        this._addEndpointEdge(p, ev, 'chain');
        break;
      }
    }
    for (let q = pos + 1; q < n.events.length; q++) {
      const a = n.events[q];
      if (this.epIndex.has(a.key)) {
        this._addEndpointEdge(ev, a, 'chain');
        break;
      }
    }
  }

  /**
   * 端点图加边（链边/消息边），含成环检测。返回边是否被接受。
   *
   * 不变式：成环边被检测到后不入图，因此已接受的边构成的图始终是 DAG。
   */
  _addEndpointEdge(u, v, kind, refId) {
    const set = this.epSucc.get(u.key);
    if (set.has(v.key)) return true; // 边已存在（同方向重复约束）
    if (this._endpointReaches(v.key, u.key)) {
      const path = this._endpointPath(v.key, u.key) ?? [];
      path.push({ kind, refId: refId ?? null, from: u.key, to: v.key });
      this._registerConflict({
        type: 'cycle',
        id: `cycle:${kind}:${refId ?? `${u.key}>${v.key}`}`,
        message: kind === 'message' ? refId : null,
        path,
        detail: `${kind === 'message' ? `消息 ${refId}` : `边 ${u.key}->${v.key}`} 与既有约束形成环`,
      });
      return false; // 环边登记但不入图、不参与传播
    }
    set.add(v.key);
    if (kind === 'message') this.msgEdgeRef.set(`${u.key}=>${v.key}`, refId);
    return true;
  }

  /**
   * 端点图上 from 是否能到达 target。用引擎级 Int32Array 邮戳做 DFS：
   * 不分配 Set/Map，标记数组跨调用复用（数万端点仅 ~40KB，且无分配尖峰）。
   */
  _endpointReaches(from, target) {
    if (from === target) return true;
    const n = this.epKey.length;
    if (!this._epMark || this._epMark.length < n) {
      const grown = new Int32Array(Math.max(n, (this._epMark ? this._epMark.length : 0) * 2, 64));
      if (this._epMark) grown.set(this._epMark);
      this._epMark = grown;
    }
    const stamp = ++this._epStamp;
    const mark = this._epMark;
    const tIdx = this.epIndex.get(target);
    const stack = [this.epIndex.get(from)];
    mark[stack[0]] = stamp;
    while (stack.length) {
      const i = stack.pop();
      for (const nxtKey of this.epSucc.get(this.epKey[i])) {
        const j = this.epIndex.get(nxtKey);
        if (j === tIdx) return true;
        if (mark[j] !== stamp) {
          mark[j] = stamp;
          stack.push(j);
        }
      }
    }
    return false;
  }

  /** DFS/BFS 取端点图上 a -> b 的一条具体路径（冲突证据）；不存在返回 null。 */
  _endpointPath(a, b) {
    const prev = new Map([[a, null]]);
    const queue = [a];
    for (let qi = 0; qi < queue.length; qi++) {
      const cur = queue[qi];
      if (cur === b) break;
      for (const nxtKey of this.epSucc.get(cur)) {
        if (!prev.has(nxtKey)) {
          prev.set(nxtKey, { from: cur, to: nxtKey, ...this._edgeKind(cur, nxtKey) });
          queue.push(nxtKey);
        }
      }
    }
    if (!prev.has(b)) return null;
    const steps = [];
    let cur = b;
    while (prev.get(cur)) {
      const { from, to, kind, refId } = prev.get(cur);
      steps.unshift({ kind, refId, from, to });
      cur = from;
    }
    return steps;
  }

  /** 端点图上一条邻接边是链边还是消息边（消息边附带消息 id）。 */
  _edgeKind(fromKey, toKey) {
    const refId = this.msgEdgeRef.get(`${fromKey}=>${toKey}`);
    return refId !== undefined ? { kind: 'message', refId } : { kind: 'chain', refId: null };
  }

  /** 事件级图（eff 传播用，边密度与端点图相同 + 所有链边）。 */
  _linkEvents(u, v, kind, refId) {
    if (!u || !v) return;
    if (!this.succ.has(u.key)) this.succ.set(u.key, []);
    if (!this.pred.has(v.key)) this.pred.set(v.key, []);
    this.succ.get(u.key).push({ key: v.key, kind, refId: refId ?? null });
    this.pred.get(v.key).push({ key: u.key, kind, refId: refId ?? null });
  }

  _addGraphEdge(u, v, kind, refId) {
    const edgeKey = `${u.key}=>${v.key}:${kind}:${refId ?? ''}`;
    if (this.edges.has(edgeKey)) return;
    this.edges.set(edgeKey, { from: u.key, to: v.key, kind, refId: refId ?? null });
    if (!this._addEndpointEdge(u, v, kind, refId)) return; // 成环边已登记，不进入传播
    this._linkEvents(u, v, kind, refId);

    // 消息边对时间区间的约束：u 的下界推给 v，v 的上界推回 u，再扩散到全图。
    this._relaxLoFrom(u, v, refId);
    this._relaxHiFrom(u, v, refId);
    this._drainLo();
    this._drainHi();
  }

  // ---- 时钟区间与传播 -----------------------------------------------------

  /** 重算一个节点全部事件的原始校准区间（新增校准时调用；不做跨节点传播）。 */
  _refreshNodeIntervals(n) {
    const cals = [...n.cals].sort((a, b) => a.m0 - b.m0);
    const monos = n.events.map((e) => e.mono);
    const { at, conflicts } = computeEnvelope(cals, monos, n.rho);

    for (const ev of n.events) {
      const cell = at.get(ev.mono);
      ev.rawLo = cell.lo;
      ev.rawHi = cell.hi;
      ev.rawLoCals = cell.loCals;
      ev.rawHiCals = cell.hiCals;
      ev.clockConflict = cell.lo > cell.hi ? 'infeasible' : null;
      if (cell.lo > cell.hi) this._registerClockConflict(n, ev, cell);
    }
    // 断点处（可能没有事件）的矛盾也要登记，以便定位到校准观测本身
    for (const cf of conflicts) {
      const cid = `clock:${n.id}@${cf.mono}`;
      if (!this.conflicts.has(cid)) {
        this._registerConflict({
          type: 'clock-model',
          id: cid,
          node: n.id,
          event: null,
          mono: cf.mono,
          lo: cf.lo,
          hi: cf.hi,
          loCals: cf.loCals.slice(),
          hiCals: cf.hiCals.slice(),
          detail: `节点 ${n.id} 在单调计数 ${cf.mono} 处校准锥为空（${cf.lo} > ${cf.hi}）`,
        });
      }
    }
  }

  _registerClockConflict(n, ev, cell) {
    this._registerConflict({
      type: 'clock-model',
      id: `clock:${ev.key}`,
      node: n.id,
      event: ev.id,
      mono: ev.mono,
      lo: cell.lo,
      hi: cell.hi,
      loCals: cell.loCals.slice(),
      hiCals: cell.hiCals.slice(),
      detail: `节点 ${n.id} 在单调计数 ${ev.mono}（事件 ${ev.id}）处校准锥为空：下界 ${cell.lo} > 上界 ${cell.hi}`,
    });
  }

  _loQ() {
    if (!this._loQueue) this._loQueue = [];
    return this._loQueue;
  }
  _hiQ() {
    if (!this._hiQueue) this._hiQueue = [];
    return this._hiQueue;
  }

  /** 新增单个事件后的播种：自身原始区间 + 两侧链邻接。 */
  _seedAndDrain(ev, before, after) {
    this._enqueueLo(ev, ev.rawLo, null, null);
    this._enqueueHi(ev, ev.rawHi, null, null);
    if (before) {
      this._enqueueLo(ev, before.effLo, before, { kind: 'chain', refId: null });
      this._enqueueHi(before, ev.effHi, ev, { kind: 'chain', refId: null });
    }
    if (after) {
      this._enqueueLo(after, ev.effLo, ev, { kind: 'chain', refId: null });
      this._enqueueHi(ev, after.effHi, after, { kind: 'chain', refId: null });
    }
    this._drainLo();
    this._drainHi();
  }

  /** 节点区间整体收紧（新增校准）后：全节点重新播种并扩散。 */
  _seedAndDrainAll(n) {
    for (const ev of n.events) {
      this._enqueueLo(ev, ev.rawLo, null, null);
      this._enqueueHi(ev, ev.rawHi, null, null);
    }
    // 同节点链：顺序一遍，让紧约束沿链入队
    for (let i = 1; i < n.events.length; i++) {
      const a = n.events[i - 1];
      const b = n.events[i];
      this._enqueueLo(b, a.effLo, a, { kind: 'chain', refId: null });
      this._enqueueHi(a, b.effHi, b, { kind: 'chain', refId: null });
    }
    this._drainLo();
    this._drainHi();
  }

  _enqueueLo(ev, value, pred, edge) {
    if (value > ev.effLo) {
      ev.effLo = value;
      ev.effLoPred = pred;
      ev.effLoEdge = edge;
      this._loQ().push(ev);
    }
  }
  _enqueueHi(ev, value, pred, edge) {
    if (value < ev.effHi) {
      ev.effHi = value;
      ev.effHiPred = pred;
      ev.effHiEdge = edge;
      this._hiQ().push(ev);
    }
  }

  /** 加入消息边 u->v 时的首次松弛（之后由队列扩散）。 */
  _relaxLoFrom(u, v, refId) {
    this._enqueueLo(v, u.effLo, u, { kind: 'message', refId });
  }
  _relaxHiFrom(u, v, refId) {
    this._enqueueHi(u, v.effHi, v, { kind: 'message', refId });
  }

  _drainLo() {
    const q = this._loQ();
    let head = 0;
    while (head < q.length) {
      const u = q[head++];
      if (u.effLo > u.effHi + this.clockEpsilon && Number.isFinite(u.effHi)) {
        // 纯校准锥自身矛盾已由 clock-model 登记；只在确有传播前驱时报 clock-path
        if (u.effLoPred) this._reportClockPathConflict(u, 'lo');
      }
      for (const edge of this.succ.get(u.key) ?? []) {
        const v = this.events.get(edge.key);
        this._enqueueLo(v, u.effLo, u, { kind: edge.kind, refId: edge.refId });
      }
    }
    q.length = 0;
  }

  _drainHi() {
    const q = this._hiQ();
    let head = 0;
    while (head < q.length) {
      const u = q[head++];
      if (u.effHi < u.effLo - this.clockEpsilon && Number.isFinite(u.effLo)) {
        // 纯校准锥自身矛盾已由 clock-model 登记；只在确有传播后继时报 clock-path
        if (u.effHiPred) this._reportClockPathConflict(u, 'hi');
      }
      for (const edge of this.pred.get(u.key) ?? []) {
        const p = this.events.get(edge.key);
        this._enqueueHi(p, u.effHi, u, { kind: edge.kind, refId: edge.refId });
      }
    }
    q.length = 0;
  }

  _reportClockPathConflict(ev, side) {
    // 不先为重复/将被截断的报告回溯长链：先沿前驱指针定出远端事件与冲突 id。
    // lo 侧沿 effLoPred 走向「最早前驱」（下界从那里传播而来）；
    // hi 侧沿 effHiPred 走向「最晚后继」（上界从那里回推而来）。
    const predOf = side === 'lo' ? (n) => n.effLoPred : (n) => n.effHiPred;
    const edgeOf = side === 'lo' ? (n) => n.effLoEdge : (n) => n.effHiEdge;
    let far = ev;
    let steps = 0;
    while (predOf(far) && steps <= this.maxEvidenceChain + 1) {
      far = predOf(far);
      steps++;
    }
    const farKey = far.key;
    const id = `clock-path:${farKey}:${ev.key}:${side}`;
    if (this._conflictSeen.has(id)) return;

    // 回溯证据链并统一成「时间早 -> 时间晚」方向：
    // lo 侧原始每步 pred -> node（朝晚）；hi 侧沿 ev 走向后继，需反转后倒序。
    const raw = [];
    let node = ev;
    const seen = new Set();
    while (raw.length < this.maxEvidenceChain) {
      const pred = predOf(node);
      if (!pred || seen.has(node.key)) break;
      seen.add(node.key);
      raw.push({ edge: edgeOf(node), from: pred.key, to: node.key });
      node = pred;
    }
    const chain =
      side === 'lo'
        ? raw.map((s) => ({ kind: s.edge.kind, refId: s.edge.refId, from: s.from, to: s.to }))
        : raw
            .slice()
            .reverse()
            .map((s) => ({ kind: s.edge.kind, refId: s.edge.refId, from: s.to, to: s.from }));

    const farEv = this.events.get(farKey);
    this._registerConflict({
      type: 'clock-path',
      id,
      node: ev.node,
      event: ev.id,
      bound: side,
      effLo: ev.effLo,
      effHi: ev.effHi,
      // 传播远端：lo=最早前驱，hi=最晚后继；另一端是本事件
      remote: farKey,
      chainTruncated: steps > this.maxEvidenceChain,
      // 越界两侧的支撑校准：远端事件撑出走传播的边界，本事件撑出对立边界
      remoteCalibrations: farEv
        ? (side === 'lo' ? farEv.rawLoCals : farEv.rawHiCals).slice()
        : [],
      localCalibrations: (side === 'lo' ? ev.rawHiCals : ev.rawLoCals).slice(),
      chain,
      detail:
        side === 'lo'
          ? `前驱链（远端 ${farKey}）要求 ${ev.key} 的参考时间 >= ${ev.effLo}，但 ${ev.key} 的校准上界只有 ${ev.effHi}`
          : `后继链（远端 ${farKey}）回推 ${ev.key} 的参考时间 <= ${ev.effHi}，但 ${ev.key} 的校准下界有 ${ev.effLo}`,
    });
  }

  _registerConflict(c) {
    if (this._conflictSeen.has(c.id)) return;
    this._conflictSeen.add(c.id);
    if (this.conflicts.size >= this.conflictCap) {
      this.conflictTruncated++;
      return;
    }
    // 长证据链只保留两端（从源头与从目标各一段），中段以省略标记代替
    if (Array.isArray(c.path) && c.path.length > this.maxEvidenceChain) {
      const half = this.maxEvidenceChain >> 1;
      const head = c.path.slice(0, half);
      const tail = c.path.slice(c.path.length - half);
      c.path = [
        ...head,
        { kind: '…', omitted: c.path.length - this.maxEvidenceChain, from: head[half - 1].to, to: tail[0].from },
        ...tail,
      ];
    }
    if (Array.isArray(c.chain) && c.chain.length > this.maxEvidenceChain) {
      const half = this.maxEvidenceChain >> 1;
      const head = c.chain.slice(0, half);
      const tail = c.chain.slice(c.chain.length - half);
      c.chain = [
        ...head,
        { kind: '…', omitted: c.chain.length - this.maxEvidenceChain, from: head[half - 1].to, to: tail[0].from },
        ...tail,
      ];
    }
    this.conflicts.set(c.id, c);
  }

  // ---- 查询原语 -----------------------------------------------------------

  /** 图上 a 是否先于 b（端点邻接表 DFS + 同节点单调序）。 */
  graphBefore(aKey, bKey) {
    const a = this.events.get(aKey);
    const b = this.events.get(bKey);
    if (!a || !b) return false;
    if (a.node === b.node) return a.mono < b.mono;
    if (!this.epIndex.has(aKey) || !this.epIndex.has(bKey)) return false;
    return this._endpointReaches(aKey, bKey);
  }

  /** BFS 取事件级图上 a -> b 的一条边链（关系证据）。 */
  eventPath(aKey, bKey) {
    const prev = new Map([[aKey, null]]);
    const queue = [aKey];
    for (let qi = 0; qi < queue.length; qi++) {
      const cur = queue[qi];
      if (cur === bKey) break;
      for (const e of this.succ.get(cur) ?? []) {
        if (!prev.has(e.key)) {
          prev.set(e.key, { from: cur, edge: e });
          queue.push(e.key);
        }
      }
    }
    if (!prev.has(bKey)) return null;
    const steps = [];
    let cur = bKey;
    while (prev.get(cur)) {
      const { from, edge } = prev.get(cur);
      steps.unshift({ kind: edge.kind, refId: edge.refId, from, to: cur });
      cur = from;
    }
    return steps;
  }

  /** 由图（不含时钟区间）可证明的 a -> b 关系及证据。 */
  graphRelation(aKey, bKey) {
    if (this.graphBefore(aKey, bKey)) return { rel: 'before', evidence: this.eventPath(aKey, bKey) };
    if (this.graphBefore(bKey, aKey)) return { rel: 'after', evidence: this.eventPath(bKey, aKey) };
    return { rel: 'unknown', evidence: null };
  }

  /**
   * 两事件最终关系：
   *   before / after 有图证据或区间不重叠证据；否则 unknown。
   */
  relation(aKey, bKey) {
    const g = this.graphRelation(aKey, bKey);
    if (g.rel !== 'unknown') return g;
    const a = this.events.get(aKey);
    const b = this.events.get(bKey);
    if (!a || !b) return { rel: 'unknown', evidence: null };
    const eps = this.clockEpsilon;
    if (a.effHi + eps < b.effLo) {
      return {
        rel: 'before',
        evidence: {
          kind: 'clock',
          aUpper: a.effHi,
          bLower: b.effLo,
          aUpperCals: a.rawHiCals.slice(),
          bLowerCals: b.rawLoCals.slice(),
          note: `${aKey} 的参考时间上界 < ${bKey} 的下界`,
        },
      };
    }
    if (b.effHi + eps < a.effLo) {
      return {
        rel: 'after',
        evidence: {
          kind: 'clock',
          bUpper: b.effHi,
          aLower: a.effLo,
          bUpperCals: b.rawHiCals.slice(),
          aLowerCals: a.rawLoCals.slice(),
          note: `${bKey} 的参考时间上界 < ${aKey} 的下界`,
        },
      };
    }
    return { rel: 'unknown', evidence: null };
  }
}

function msgKey(nodeId, mono) {
  return `${nodeId}@${mono}`;
}
