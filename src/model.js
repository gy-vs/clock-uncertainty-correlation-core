'use strict';

// 时钟模型：把节点的 RTT 校准观测转换成「本地单调计数 -> 参考时间」的可行区间。
//
// 一条校准观测 c 表示一次往返：
//   本地单调时刻区间 [m0, m1]（发送与收到应答的两个本地读数）
//   参考时钟在该往返期间取过的值区间 [r0, r1]（服务器应答中携带的时钟值）
// 含义：存在某个真实锚点 (m*, r*)，m0 <= m* <= m1 且 r0 <= r* <= r1。
//
// 设节点时钟相对参考时间的瞬时速率恒满足 rate ∈ [1-rho, 1+rho]
// （默认 rho=1e-6，即百万分之一），真实锚点 (m*,r*) 在矩形
// [m0,m1]×[r0,r1] 内任意位置。对事件单调计数 x：
//
//   cone_lo_c(x)（在锚点取最坏位置后，x 处参考时间的最小可能值）：
//     x <= m1: r0 - (1+rho)*(m1-x)   （锚点取矩形右下角，左行用最大速率）
//     x >= m1: r0 + (1-rho)*(x-m1)  （锚点取右下角，右行用最小速率）
//   cone_hi_c(x)（最大可能值）：
//     x <= m0: r1 - (1-rho)*(m0-x)   （锚点取左上角，左行用最小速率）
//     x >= m0: r1 + (1+rho)*(x-m0)  （锚点取左上角，右行用最大速率）
//
// 下界锥折点在 m1（左斜率 1+rho / 右斜率 1-rho），
// 上界锥折点在 m0（左斜率 1-rho / 右斜率 1+rho），折点处连续。
// 零 RTT（m0=m1,r0=r1）时退化为从精确锚点展开的速率锥。
//
// 注意：
//   - 在矩形内部（m0<x<m1）区间同样会按距远角的距离变宽，这不是精度损失，
//     而是因为真实锚点可能在矩形另一角；零 RTT（m0=m1,r0=r1）时退化为精确锚点；
//   - rho=0 时锥就是单位斜率的直线，矩形内呈梯形，仍然保留 RTT 宽度。
//
// 多校准取交集：envLo(x) = max_c cone_lo_c(x)，envHi(x) = min_c cone_hi_c(x)。
// 任何 envLo > envHi 的位置都意味着观测之间（含漂移率假设）互相矛盾。
// 本文件只做纯计算；增量状态见 engine.js。

const POS_INF = Number.POSITIVE_INFINITY;
const NEG_INF = Number.NEGATIVE_INFINITY;

/** 最大/最小堆，数组实现；支持通过 stale 谓词在堆顶惰性删除。 */
class Heap {
  constructor(compare) {
    this.h = [];
    this.cmp = compare; // 父应优先于子时返回 true
  }
  get size() {
    return this.h.length;
  }
  push(entry) {
    const h = this.h;
    let i = h.length;
    h.push(entry);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.cmp(h[i], h[p])) {
        [h[i], h[p]] = [h[p], h[i]];
        i = p;
      } else break;
    }
  }
  /** 丢弃所有满足 stale 的堆顶后返回堆顶。 */
  top(stale) {
    const h = this.h;
    if (!stale) return h[0];
    while (h.length && stale(h[0])) {
      const last = h.pop();
      if (!h.length) break;
      h[0] = last;
      this._sink(0);
    }
    return h[0];
  }
  _sink(i) {
    const h = this.h;
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let best = i;
      if (l < h.length && this.cmp(h[l], h[best])) best = l;
      if (r < h.length && this.cmp(h[r], h[best])) best = r;
      if (best === i) return;
      [h[i], h[best]] = [h[best], h[i]];
      i = best;
    }
  }
}

/**
 * 计算一个节点全部断点上的 envLo / envHi。
 * 断点 = 各校准折点（下界折点 m1、上界折点 m0）+ 各事件单调计数；
 * 锥是分段线性的，上下界的折点只出现在这些位置。
 *
 * @param {Array<{m0:number,m1:number,r0:number,r1:number,id:string}>} cals
 * @param {number[]} eventMonos 已升序的事件单调计数
 * @param {number} rho 漂移率上界
 * @returns {{ at: Map<number,{lo:number,hi:number,loCals:string[],hiCals:string[]}> ,
 *            conflicts: Array }}
 */
export function computeEnvelope(cals, eventMonos, rho) {
  const xs = new Set(eventMonos);
  for (const c of cals) {
    xs.add(c.m0);
    xs.add(c.m1);
  }
  const breaks = [...xs].sort((a, b) => a - b);

  const loAt = sweepLo(cals, breaks, rho);
  const hiAt = sweepHi(cals, breaks, rho);

  const at = new Map();
  const conflicts = [];
  for (const x of breaks) {
    const lo = loAt.get(x);
    const hi = hiAt.get(x);
    const entry = {
      lo: lo ? lo.value : NEG_INF,
      hi: hi ? hi.value : POS_INF,
      loCals: lo ? lo.cals : [],
      hiCals: hi ? hi.cals : [],
    };
    at.set(x, entry);
    if (lo && hi && lo.value > hi.value) conflicts.push(entry);
  }
  return { at, conflicts };
}

/**
 * 只在单个单调计数 x 处求全部校准锥的交。新增事件时使用：O(C)，
 * 不扫描其他事件位置。
 */
export function evaluateCones(cals, x, rho) {
  let lo = NEG_INF;
  let hi = POS_INF;
  let loCal = null;
  let hiCal = null;
  for (const c of cals) {
    const clo = x <= c.m1 ? c.r0 - (1 + rho) * (c.m1 - x) : c.r0 + (1 - rho) * (x - c.m1);
    const chi = x <= c.m0 ? c.r1 - (1 - rho) * (c.m0 - x) : c.r1 + (1 + rho) * (x - c.m0);
    if (clo > lo) {
      lo = clo;
      loCal = c.id;
    }
    if (chi < hi) {
      hi = chi;
      hiCal = c.id;
    }
  }
  return {
    lo,
    hi,
    loCals: loCal ? [loCal] : [],
    hiCals: hiCal ? [hiCal] : [],
  };
}
/**
 * envLo：左分支斜率 (1+rho)，仅在 x<=m1 有效；右分支斜率 (1-rho)，x>=m1 起加入。
 * 扫描点经过 m1 时把右分支入堆，左分支在越过 m1 后惰性丢弃。
 */
function sweepLo(cals, breaks, rho) {
  const byKink = [...cals].sort((a, b) => a.m1 - b.m1);
  const maxHeap = () => new Heap((a, b) => a.key > b.key);
  const left = maxHeap();
  const right = maxHeap();
  for (const c of byKink) {
    left.push({ key: c.r0 - (1 + rho) * c.m1, cal: c });
  }
  let p = 0;
  const result = new Map();
  for (const x of breaks) {
    while (p < byKink.length && byKink[p].m1 <= x) {
      const c = byKink[p++];
      right.push({ key: c.r0 - (1 - rho) * c.m1, cal: c });
    }
    const cands = [];
    const lt = left.top((e) => x > e.cal.m1);
    if (lt) cands.push({ value: lt.key + (1 + rho) * x, cal: lt.cal });
    const rt = right.top();
    if (rt) cands.push({ value: rt.key + (1 - rho) * x, cal: rt.cal });
    if (!cands.length) {
      result.set(x, undefined);
      continue;
    }
    let best = cands[0];
    for (let i = 1; i < cands.length; i++) if (cands[i].value > best.value) best = cands[i];
    result.set(x, { value: best.value, cals: [best.cal.id] });
  }
  return result;
}

/**
 * envHi：左分支斜率 (1-rho)，仅在 x<=m0 有效；右分支斜率 (1+rho)，x>=m0 起加入。
 */
function sweepHi(cals, breaks, rho) {
  const byKink = [...cals].sort((a, b) => a.m0 - b.m0);
  const minHeap = () => new Heap((a, b) => a.key < b.key);
  const left = minHeap();
  const right = minHeap();
  for (const c of byKink) {
    left.push({ key: c.r1 - (1 - rho) * c.m0, cal: c });
  }
  let p = 0;
  const result = new Map();
  for (const x of breaks) {
    while (p < byKink.length && byKink[p].m0 <= x) {
      const c = byKink[p++];
      right.push({ key: c.r1 - (1 + rho) * c.m0, cal: c });
    }
    const cands = [];
    const lt = left.top((e) => x > e.cal.m0);
    if (lt) cands.push({ value: lt.key + (1 - rho) * x, cal: lt.cal });
    const rt = right.top();
    if (rt) cands.push({ value: rt.key + (1 + rho) * x, cal: rt.cal });
    if (!cands.length) {
      result.set(x, undefined);
      continue;
    }
    let best = cands[0];
    for (let i = 1; i < cands.length; i++) if (cands[i].value < best.value) best = cands[i];
    result.set(x, { value: best.value, cals: [best.cal.id] });
  }
  return result;
}
