'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CorrelationKernel, ValidationError } from '../src/index.js';

function setup({ rho = 0 } = {}) {
  const k = new CorrelationKernel();
  k.addNode({ id: 'A', maxDriftRate: rho });
  k.addNode({ id: 'B', maxDriftRate: rho });
  k.addNode({ id: 'C', maxDriftRate: rho });
  return k;
}

test('同节点：单调计数决定先后，墙上时间不参与', () => {
  const k = setup();
  k.addEvent({ node: 'A', id: 'a1', mono: 100, wall: 9000 });
  k.addEvent({ node: 'A', id: 'a2', mono: 200, wall: 1000 }); // 墙上时间更小，但是后发生
  assert.equal(k.compare('Aa1', 'Aa2').relation, 'before');
  assert.equal(k.compare('Aa2', 'Aa1').relation, 'after');
});

test('单调计数重复是结构性输入错误，直接抛出', () => {
  const k = setup();
  k.addEvent({ node: 'A', id: 'a1', mono: 100 });
  assert.throws(() => k.addEvent({ node: 'A', id: 'a2', mono: 100 }), ValidationError);
});

test('未校准节点：没有参考时间区间，且跨节点关系未知——墙上数字小不代表因果', () => {
  const k = setup();
  k.addEvent({ node: 'A', id: 'a1', mono: 100, wall: 1000 });
  k.addEvent({ node: 'B', id: 'b1', mono: 100, wall: 999 });
  const r = k.query();
  const a1 = r.events.find((e) => e.id === 'a1');
  const b1 = r.events.find((e) => e.id === 'b1');
  assert.equal(a1.calibrated, false);
  assert.equal(a1.referenceInterval, null);
  assert.equal(a1.effectiveInterval, null);
  assert.equal(b1.calibrated, false);
  const pair = k.compare('Aa1', 'Bb1');
  assert.equal(pair.relation, 'unknown');
  assert.equal(pair.evidence, null);
  assert.equal(r.conflicts.length, 0); // 未知 ≠ 矛盾
});

test('墙上时间相同，但消息边可以证明先后', () => {
  const k = setup();
  k.addEvent({ node: 'A', id: 'send', mono: 100, wall: 5000 });
  k.addEvent({ node: 'B', id: 'recv', mono: 200, wall: 5000 });
  assert.equal(k.compare('Asend', 'Brecv').relation, 'unknown');
  k.addMessage({ id: 'm1', from: 'A', to: 'B', fromMono: 100, toMono: 200 });
  const cmp = k.compare('Asend', 'Brecv');
  assert.equal(cmp.relation, 'before');
  assert.deepEqual(cmp.evidence, [
    { kind: 'message', refId: 'm1', from: 'Asend', to: 'Brecv' },
  ]);
});

test('区间不重叠可以由时钟证明先后，并给出支撑该边界的校准', () => {
  const k = setup();
  k.addCalibration({ node: 'A', id: 'ca', m0: 100, m1: 100, r0: 1000, r1: 1010 });
  k.addCalibration({ node: 'B', id: 'cb', m0: 100, m1: 100, r0: 2000, r1: 2010 });
  k.addEvent({ node: 'A', id: 'a1', mono: 100 });
  k.addEvent({ node: 'B', id: 'b1', mono: 100 });
  const cmp = k.compare('Aa1', 'Bb1');
  assert.equal(cmp.relation, 'before');
  assert.equal(cmp.evidence.kind, 'clock');
  assert.deepEqual(cmp.evidence.aUpperCals, ['A:ca']);
  assert.deepEqual(cmp.evidence.bLowerCals, ['B:cb']);
});

test('区间只是重叠（端点相接不算）：关系保持未知', () => {
  const k = setup();
  k.addCalibration({ node: 'A', id: 'ca', m0: 100, m1: 100, r0: 1000, r1: 1100 });
  k.addCalibration({ node: 'B', id: 'cb', m0: 100, m1: 100, r0: 1100, r1: 1200 });
  k.addEvent({ node: 'A', id: 'a1', mono: 100 });
  k.addEvent({ node: 'B', id: 'b1', mono: 100 });
  assert.equal(k.compare('Aa1', 'Bb1').relation, 'unknown');
});

test('消息边把校准区间传播给未校准节点：未校准事件获得有界区间', () => {
  const k = setup();
  k.addCalibration({ node: 'A', id: 'ca', m0: 100, m1: 100, r0: 1000, r1: 1000 });
  k.addEvent({ node: 'A', id: 'a1', mono: 100 });
  k.addEvent({ node: 'A', id: 'a2', mono: 200 });
  k.addEvent({ node: 'B', id: 'b1', mono: 500 });
  k.addMessage({ id: 'm1', from: 'A', to: 'B', fromMono: 200, toMono: 500 });
  const r = k.query();
  const b1 = r.events.find((e) => e.key === 'Bb1');
  // A:a2 在锚点之后 100（rho=0，零 RTT），参考时间恰为 1100；
  // 消息 a2->b1 把 b1 的下界推到 1100，上界仍无界
  assert.deepEqual(b1.effectiveInterval, [1100, null]);
  assert.equal(b1.referenceInterval, null, '原始区间仍为 null，不伪造校准');
  assert.equal(k.compare('Aa1', 'Bb1').relation, 'before');
});

test('消息链的传递性：A→B→C 证明 A 先于 C', () => {
  const k = setup();
  for (const [n, m] of [['A', 1], ['B', 2], ['C', 3]]) {
    k.addEvent({ node: n, id: 'e', mono: m });
  }
  k.addMessage({ id: 'm1', from: 'A', to: 'B', fromMono: 1, toMono: 2 });
  k.addMessage({ id: 'm2', from: 'B', to: 'C', fromMono: 2, toMono: 3 });
  const cmp = k.compare('Ae', 'Ce');
  assert.equal(cmp.relation, 'before');
  assert.deepEqual(cmp.evidence.map((s) => s.kind), ['message', 'message']);
  assert.equal(k.compare('Ce', 'Ae').relation, 'after');
});

test('消息可先于事件提交：事件补齐后自动生效，并在 warning 中体现过程', () => {
  const k = setup();
  const vMsg = k.addMessage({ id: 'early', from: 'A', to: 'B', fromMono: 10, toMono: 20 });
  let r = k.query({ version: vMsg });
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0].kind, 'unresolved-message');
  k.addEvent({ node: 'A', id: 's', mono: 10 });
  k.addEvent({ node: 'B', id: 'r', mono: 20 });
  r = k.query();
  assert.equal(r.warnings.length, 0);
  assert.equal(k.compare('As', 'Br').relation, 'before');
  const ch = k.changes({ fromVersion: vMsg });
  assert.ok(ch.warningsResolved.some((w) => w.message === 'early'));
});

test('反向消息形成环：登记 cycle 冲突并给出沿环的观测路径，且不丢弃任何输入', () => {
  const k = setup();
  k.addEvent({ node: 'A', id: 's', mono: 10 });
  k.addEvent({ node: 'B', id: 'r', mono: 20 });
  k.addMessage({ id: 'fwd', from: 'A', to: 'B', fromMono: 10, toMono: 20 });
  k.addMessage({ id: 'rev', from: 'B', to: 'A', fromMono: 20, toMono: 10 });
  const r = k.query();
  const cycles = r.conflicts.filter((c) => c.type === 'cycle');
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].message, 'rev');
  // 路径定位到具体消息：fwd 已在环上
  assert.ok(cycles[0].path.some((s) => s.kind === 'message' && s.refId === 'fwd'));
  // 正向边仍然有效：环边被拒绝，但既有序序没有被改写
  assert.equal(k.compare('As', 'Br').relation, 'before');
});

test('同节点消息与单调序相反：直接报告 cycle', () => {
  const k = setup();
  k.addEvent({ node: 'A', id: 'a1', mono: 10 });
  k.addEvent({ node: 'A', id: 'a2', mono: 20 });
  k.addMessage({ id: 'back', from: 'A', to: 'A', fromMono: 20, toMono: 10 });
  const r = k.query();
  assert.ok(r.conflicts.some((c) => c.type === 'cycle' && c.message === 'back'));
});

test('校准与消息约束互相矛盾：clock-path 冲突定位到源事件与传播链', () => {
  const k = setup();
  // A 事件参考时间约 2000，B 事件参考时间约 1000，但消息称 A 先于 B
  k.addCalibration({ node: 'A', id: 'ca', m0: 10, m1: 10, r0: 2000, r1: 2000 });
  k.addCalibration({ node: 'B', id: 'cb', m0: 20, m1: 20, r0: 1000, r1: 1000 });
  k.addEvent({ node: 'A', id: 's', mono: 10 });
  k.addEvent({ node: 'B', id: 'r', mono: 20 });
  k.addMessage({ id: 'bad', from: 'A', to: 'B', fromMono: 10, toMono: 20 });
  const r = k.query();
  const cp = r.conflicts.find((c) => c.type === 'clock-path');
  assert.ok(cp, '应检测到时间约束与图约束不可同时成立');
  assert.equal(cp.event, 'r');
  assert.ok(cp.chain.some((s) => s.kind === 'message' && s.refId === 'bad'));
});

test('校准观测本身互相矛盾：clock-model 冲突给出涉及的观测与空锥位置', () => {
  const k = new CorrelationKernel();
  k.addNode({ id: 'A', maxDriftRate: 0 });
  k.addCalibration({ node: 'A', id: 'c1', m0: 100, m1: 100, r0: 1000, r1: 1000 });
  k.addCalibration({ node: 'A', id: 'c2', m0: 200, m1: 200, r0: 0, r1: 100 });
  k.addEvent({ node: 'A', id: 'a1', mono: 150 });
  const r = k.query();
  const cm = r.conflicts.filter((c) => c.type === 'clock-model');
  assert.ok(cm.length >= 1);
  const atEvent = cm.find((c) => c.event === 'a1');
  assert.ok(atEvent, '事件位置的空锥要能定位到事件');
  const cals = [...atEvent.loCals, ...atEvent.hiCals];
  assert.ok(cals.includes('A:c1') && cals.includes('A:c2'));
});
