'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CorrelationKernel } from '../src/index.js';

// 大规模矛盾输入：数千条互相成环的消息。内核不能 OOM，也不能悄悄丢弃
// 冲突语义——超出证据存储预算的部分通过 conflictsTruncated 明示。
test('海量矛盾输入：冲突登记封顶并报告截断数，且已证明的正向边仍有效', () => {
  const k = new CorrelationKernel();
  k.addNode({ id: 'A', maxDriftRate: 0 });
  k.addNode({ id: 'B', maxDriftRate: 0 });

  // 200 个事件交替放在两节点上，构造一个清晰的正向链 A0->B0->A1->B1...
  // 正向链：a0->b0, a1->b1 ...；
  // 反向矛盾：b_i -> a_i（与 a_i->b_i 直接成环，每条独立定位）
  const n = 200;
  for (let i = 0; i < n; i++) {
    k.addEvent({ node: 'A', id: `a${i}`, mono: i * 10 });
    k.addEvent({ node: 'B', id: `b${i}`, mono: i * 10 });
  }
  for (let i = 0; i < n; i++) {
    k.addMessage({ id: `fwd${i}`, from: 'A', to: 'B', fromMono: i * 10, toMono: i * 10 });
    k.addMessage({ id: `back${i}`, from: 'B', to: 'A', fromMono: i * 10, toMono: i * 10 });
  }

  const r = k.query();
  assert.ok(r.conflicts.length > 0);
  assert.equal(typeof r.conflictsTruncated, 'number');
  // 每条保留冲突都必须可定位
  for (const c of r.conflicts) {
    assert.ok(c.id);
    assert.ok(c.detail);
    assert.ok(Array.isArray(c.path));
    assert.ok(c.path.length >= 1);
    assert.ok(c.path.length <= 65); // 64 + 至多一个省略标记
  }
  // 被接受的正向消息仍可证明先后；矛盾没有导致任意丢弃输入来制造排序
  assert.equal(k.compare({ node: 'A', id: 'a0' }, { node: 'B', id: 'b0' }).relation, 'before');
}, { timeout: 30_000 });

test('小规模矛盾输入不触发截断：conflictsTruncated 为 0', () => {
  const k = new CorrelationKernel();
  k.addNode({ id: 'A' });
  k.addNode({ id: 'B' });
  k.addEvent({ node: 'A', id: 's', mono: 1 });
  k.addEvent({ node: 'B', id: 'r', mono: 2 });
  k.addMessage({ id: 'f', from: 'A', to: 'B', fromMono: 1, toMono: 2 });
  k.addMessage({ id: 'b', from: 'B', to: 'A', fromMono: 2, toMono: 1 });
  const r = k.query();
  assert.equal(r.conflictsTruncated, 0);
  assert.equal(r.conflicts.length, 1);
});
