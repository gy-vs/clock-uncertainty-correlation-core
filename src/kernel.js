'use strict';

import { Engine, eventKey, DEFAULT_RHO } from './engine.js';
import { ValidationError, assertString } from './errors.js';

const POS = Number.POSITIVE_INFINITY;
const NEG = Number.NEGATIVE_INFINITY;

function deepFreeze(o) {
  if (o === null || typeof o !== 'object' || Object.isFrozen(o)) return o;
  for (const v of Object.values(o)) deepFreeze(v);
  return Object.freeze(o);
}

/**
 * 多节点时间关联内核。
 *
 * 事实（节点 / 事件 / 校准 / 消息）只能追加；每次成功追加产生一个新版本号。
 * live 引擎在追加过程中增量维护全部索引与区间传播；旧版本通过确定性重放复现，
 * 不修改任何已交给调用方的快照（所有查询结果均被 Object.freeze 冻结）。
 */
export class CorrelationKernel {
  constructor({ clockEpsilon = 0 } = {}) {
    this._clockEpsilon = clockEpsilon;
    this._log = []; // append-only 事实日志，版本号 = 日志长度
    this._live = new Engine({ clockEpsilon });
  }

  // ---- 输入接口 -----------------------------------------------------------

  /** 可选：预先登记节点并指定漂移率界（不登记时使用默认 1e-6）。 */
  addNode(spec) {
    this._live.addNode(spec);
    this._log.push({ kind: 'node', spec: { ...spec } });
    this._live.version = this._log.length;
    return this._log.length;
  }

  /**
   * 提交一个事件。
   * @param {{node:string,id:string,mono:number,wall?:number}} e
   *   mono 为本机单调计数（与校准的 m0/m1 同一时钟、同一单位，通常是秒/毫秒数值）
   *   wall 仅登记，不参与任何跨节点判断
   */
  addEvent(e) {
    const spec = { node: e.node, id: e.id, mono: e.mono };
    if (e.wall !== undefined) spec.wall = e.wall;
    this._live.addEvent(spec);
    this._log.push({ kind: 'event', spec });
    this._live.version = this._log.length;
    return this._log.length;
  }

  /**
   * 提交一次往返校准观测。
   * @param {{node:string,id:string,m0:number,m1:number,r0:number,r1:number}} c
   *   m0/m1：发送请求与收到应答时的本机单调读数；r0/r1：应答携带的参考时钟区间
   */
  addCalibration(c) {
    const spec = { node: c.node, id: c.id, m0: c.mono0 ?? c.m0, m1: c.mono1 ?? c.m1, r0: c.ref0 ?? c.r0, r1: c.ref1 ?? c.r1 };
    this._live.addCalibration(spec);
    this._log.push({ kind: 'calibration', spec });
    this._live.version = this._log.length;
    return this._log.length;
  }

  /**
   * 提交一条跨节点因果约束：from 节点在 fromMono 发送的消息在 to 节点 toMono 收到。
   * 允许先于事件提交：相关事件齐备前处于 pending，齐备时自动生效。
   */
  addMessage(m) {
    const spec = { id: m.id, from: m.from, to: m.to, fromMono: m.fromMono, toMono: m.toMono };
    this._live.addMessage(spec);
    this._log.push({ kind: 'message', spec });
    this._live.version = this._log.length;
    return this._log.length;
  }

  get currentVersion() {
    return this._log.length;
  }

  // ---- 版本化查询 ----------------------------------------------------------

  /** 取得某版本下的引擎（当前版本直接返回 live；旧版本重放，不触碰 live）。 */
  _engineAt(version) {
    if (version === undefined || version === null || version === this._log.length) {
      return { engine: this._live, live: true };
    }
    if (!Number.isInteger(version) || version < 0 || version > this._log.length) {
      throw new ValidationError(`版本号必须是 [0, ${this._log.length}] 内的整数，收到 ${String(version)}`);
    }
    const eng = new Engine({ clockEpsilon: this._clockEpsilon });
    for (let i = 0; i < version; i++) this._replayOne(eng, this._log[i]);
    eng.version = version;
    return { engine: eng, live: false };
  }

  _replayOne(eng, fact) {
    switch (fact.kind) {
      case 'node':
        eng.addNode(fact.spec);
        break;
      case 'event':
        eng.addEvent(fact.spec);
        break;
      case 'calibration':
        eng.addCalibration(fact.spec);
        break;
      case 'message':
        eng.addMessage(fact.spec);
        break;
    }
  }

  /**
   * 区间关联查询。
   *
   * 事件选择集（任一）：
   *   range   参考时间窗口 [lo,hi]；区间与窗口相交的事件，加上由消息边邻接的
   *           未校准事件
   *   nodes   只保留这些节点上的事件
   *   events  显式事件引用列表（key 字符串或 {node,id}）
   * 都不给 = 全历史事件视图（返回每个事件的区间，但不枚举事件对）。
   *
   * 事件对枚举（proven/unknown）是 O(S^2)，因此只在选择集上执行；
   * 显式 pairs:true 可对当前选择集强制枚举，pairs:false 可只取事件区间。
   *
   * @param {object} opts
   * @param {[number,number]} [opts.range]
   * @param {string[]} [opts.nodes]
   * @param {Array<string|{node:string,id:string}>} [opts.events]
   * @param {number} [opts.version]
   * @param {boolean} [opts.pairs] 是否枚举事件对（默认：有选择集时 true）
   * @param {boolean} [opts.includeSameNodeRelations=false]
   * @param {boolean} [opts.includeUnknown=true]
   */
  query(opts = {}) {
    const version = opts.version ?? this._log.length;
    const { engine, live } = this._engineAt(version);
    void live;
    const range = opts.range ? validateRange(opts.range) : null;
    const nodes = opts.nodes ? validateNodeList(opts.nodes) : null;
    const explicit = Array.isArray(opts.events)
      ? opts.events.map(resolveEventRef)
      : null;
    const hasSelector = Boolean(range || nodes || explicit);
    const pairsWanted = opts.pairs ?? hasSelector;
    const includeUnknown = opts.includeUnknown !== false;
    const includeSame = opts.includeSameNodeRelations === true;

    const conflicts = [...engine.conflicts.values()].map(cloneConflict);

    // 选择事件
    let keys;
    if (explicit) {
      keys = [];
      for (const ref of explicit) {
        if (!engine.events.has(ref)) throw new ValidationError(`事件 ${ref} 在版本 ${version} 不存在`);
        keys.push(ref);
      }
    } else if (range) {
      keys = this._selectByRange(engine, range[0], range[1]);
    } else {
      keys = engine.eventOrder.slice();
    }
    if (nodes) keys = keys.filter((k) => nodes.has(engine.events.get(k).node));

    const events = keys.map((k) => eventView(engine, engine.events.get(k)));

    // 事件对枚举仅在选择集上进行；全历史视图默认只给区间，避免 O(N^2)
    const proven = [];
    const unknown = [];
    if (pairsWanted) {
      for (let i = 0; i < keys.length; i++) {
        for (let j = i + 1; j < keys.length; j++) {
          const a = keys[i];
          const b = keys[j];
          const sameNode = engine.events.get(a).node === engine.events.get(b).node;
          if (sameNode && !includeSame) continue;
          const r = engine.relation(a, b);
          const pair = { a, b, relation: r.rel, evidence: r.evidence ? cloneJson(r.evidence) : null };
          if (r.rel !== 'unknown') proven.push(pair);
          else if (includeUnknown) unknown.push(pair);
        }
      }
    }

    const warnings = [];
    for (const [, msg] of engine.messages) {
      if (!msg.resolved) {
        warnings.push({
          kind: 'unresolved-message',
          message: msg.id,
          from: msg.from,
          to: msg.to,
          fromMono: msg.fromMono,
          toMono: msg.toMono,
          detail: `消息 ${msg.id} 引用的事件尚未齐备，当前版本不构成约束`,
        });
      }
    }

    return deepFreeze({
      version,
      latestVersion: this._log.length,
      range: range ? [range[0], range[1]] : null,
      pairsEnumerated: pairsWanted,
      events,
      proven,
      unknown,
      conflicts,
      conflictsTruncated: engine.conflictTruncated,
      warnings,
    });
  }

  /**
   * 窗口选择：校准区间与 [lo,hi] 相交的事件；另把与这些事件由消息边相连的
   * 未校准（±∞）事件整段纳入——它们没有可用的参考时间，但因果关系仍可判断。
   */
  _selectByRange(engine, lo, hi) {
    const selected = new Set();
    for (const [k, ev] of engine.events) {
      if (ev.rawLo === NEG && ev.rawHi === POS) continue;
      if (ev.rawLo <= hi && ev.rawHi >= lo) selected.add(k);
    }
    // 消息邻接扩展（沿消息边双向；未校准节点没有窗口边界，因果邻接全部纳入）
    const queue = [...selected];
    while (queue.length) {
      const k = queue.pop();
      for (const e of engine.succ.get(k) ?? []) {
        if (e.kind === 'message' && !selected.has(e.key)) {
          selected.add(e.key);
          queue.push(e.key);
        }
      }
      for (const e of engine.pred.get(k) ?? []) {
        if (e.kind === 'message' && !selected.has(e.key)) {
          selected.add(e.key);
          queue.push(e.key);
        }
      }
    }
    return engine.eventOrder.filter((k) => selected.has(k));
  }

  /**
   * 比较两个具体事件（不扫描全体事件）。
   * @returns {{version,a,b,relation:'before'|'after'|'unknown',evidence}}
   */
  compare(a, b, opts = {}) {
    const aKey = resolveEventRef(a);
    const bKey = resolveEventRef(b);
    const version = opts.version ?? this._log.length;
    const { engine } = this._engineAt(version);
    if (!engine.events.has(aKey)) throw new ValidationError(`事件 ${aKey} 在该版本不存在`);
    if (!engine.events.has(bKey)) throw new ValidationError(`事件 ${bKey} 在该版本不存在`);
    const r = engine.relation(aKey, bKey);
    return deepFreeze({
      version,
      latestVersion: this._log.length,
      a: aKey,
      b: bKey,
      relation: r.rel,
      evidence: r.evidence ? cloneJson(r.evidence) : null,
    });
  }

  /**
   * 两个版本之间发生变化的判断。
   * @param {object} opts
   * @param {number} opts.fromVersion 旧版本（可重复查询的旧快照版本）
   * @param {number} [opts.toVersion] 新版本，缺省为当前
   * @param {[number,number]} [opts.range]/[opts.nodes]/[opts.events] 限定比较范围；
   *        关系变化（relationChanges）只在该选择集上比较，全历史默认不比关系对
   */
  changes(opts = {}) {
    if (!Number.isInteger(opts.fromVersion)) {
      throw new ValidationError('changes 需要整数 fromVersion');
    }
    const toVersion = opts.toVersion ?? this._log.length;
    const hasSelector = Boolean(opts.range || opts.nodes || opts.events);
    const base = {
      range: opts.range,
      nodes: opts.nodes,
      events: opts.events,
      pairs: hasSelector ? true : false,
      includeUnknown: true,
      includeSameNodeRelations: true,
    };
    const old = this.query({ ...base, version: opts.fromVersion });
    const now = this.query({ ...base, version: toVersion });

    const oldEv = new Map(old.events.map((e) => [e.key, e]));
    const newEv = new Map(now.events.map((e) => [e.key, e]));

    const changed = [];
    for (const [k, e] of newEv) {
      const before = oldEv.get(k);
      if (!before) {
        changed.push({ type: 'event-added', key: k, after: e });
      } else if (!sameInterval(before, e) || before.calibrated !== e.calibrated) {
        changed.push({ type: 'interval-tightened', key: k, before, after: e });
      }
    }

    const oldRel = new Map(old.proven.concat(old.unknown).map((p) => [pairKey(p.a, p.b), p]));
    const newRel = new Map(now.proven.concat(now.unknown).map((p) => [pairKey(p.a, p.b), p]));
    const relationChanges = [];
    for (const [pk, p] of newRel) {
      const q = oldRel.get(pk);
      if (!q) {
        relationChanges.push({ type: 'relation-appeared', ...p });
      } else if (q.relation !== p.relation) {
        relationChanges.push({
          type: 'relation-changed',
          a: p.a,
          b: p.b,
          before: q.relation,
          after: p.relation,
          evidence: p.evidence,
        });
      }
    }

    const oldConf = new Map(old.conflicts.map((c) => [c.id, c]));
    const newConf = new Map(now.conflicts.map((c) => [c.id, c]));
    const conflictsAdded = [...newConf.keys()].filter((id) => !oldConf.has(id)).map((id) => newConf.get(id));
    const warningsResolved = old.warnings
      .filter((w) => !now.warnings.some((w2) => w2.message === w.message))
      .map((w) => ({ kind: 'message-resolved', message: w.message }));

    return deepFreeze({
      fromVersion: opts.fromVersion,
      toVersion,
      changed,
      relationChanges,
      conflictsAdded,
      warningsResolved,
      hasChanges:
        changed.length > 0 ||
        relationChanges.length > 0 ||
        conflictsAdded.length > 0 ||
        warningsResolved.length > 0,
    });
  }
}

// ---------------------------------------------------------------------------

function eventView(engine, ev) {
  const calibrated = ev.rawLo !== NEG || ev.rawHi !== POS;
  return {
    key: ev.key,
    id: ev.id,
    node: ev.node,
    mono: ev.mono,
    wall: ev.wall,
    calibrated,
    // 原始校准区间（未经消息/链传播）
    referenceInterval: calibrated ? [ev.rawLo, ev.rawHi] : null,
    // 纳入全部顺序约束后该事件可能处于的最紧参考时间区间
    effectiveInterval: boundPair(ev.effLo, ev.effHi),
    rawLowerCalibrations: ev.rawLoCals.slice(),
    rawUpperCalibrations: ev.rawHiCals.slice(),
  };
}

function boundPair(lo, hi) {
  if (lo === NEG && hi === POS) return null;
  return [lo === NEG ? null : lo, hi === POS ? null : hi];
}

function validateRange(range) {
  if (!Array.isArray(range) || range.length !== 2) {
    throw new ValidationError('range 必须是 [下界, 上界]');
  }
  const [lo, hi] = range;
  if (typeof lo !== 'number' || typeof hi !== 'number' || lo > hi) {
    throw new ValidationError('range 上下界必须为数值且 lo <= hi');
  }
  return [lo, hi];
}

function validateNodeList(list) {
  if (!Array.isArray(list) || list.some((n) => typeof n !== 'string')) {
    throw new ValidationError('nodes 必须是字符串数组');
  }
  return new Set(list);
}

function resolveEventRef(ref) {
  if (typeof ref === 'string') return ref;
  if (ref && typeof ref === 'object' && ref.node && ref.id !== undefined) {
    return eventKey(ref.node, String(ref.id));
  }
  throw new ValidationError('事件引用必须是 key 字符串或 {node,id}');
}

function pairKey(a, b) {
  return `${a}${b}`;
}

function sameInterval(a, b) {
  const ia = a.effectiveInterval;
  const ib = b.effectiveInterval;
  if (ia === null && ib === null) return true;
  if (ia === null || ib === null) return false;
  return ia[0] === ib[0] && ia[1] === ib[1];
}

function cloneConflict(c) {
  return structuredClone(c);
}

function cloneJson(v) {
  return v === undefined ? v : structuredClone(v);
}

export { DEFAULT_RHO };
