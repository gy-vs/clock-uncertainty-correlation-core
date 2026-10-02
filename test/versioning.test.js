'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CorrelationKernel } from '../src/index.js';

test('旧版本快照不会被后续追加改写：区间与判断都可重复', () => {
  const k = new CorrelationKernel();
  k.addNode({ id: 'A', maxDriftRate: 0 });
  k.addNode({ id: 'B', maxDriftRate: 0 });
  k.addCalibration({ node: 'A', id: 'c1', m0: 100, m1: 100, r0: 1000, r1: 1010 });
  const v1 = k.addEvent({ node: 'A', id: 'a1', mono: 100 });
  const snapshot = k.query({ version: v1 });
  const intervalBefore = snapshot.events[0].effectiveInterval;

  // 之后追加：同位置的第二条更精确校准，以及大量新事件
  k.addCalibration({ node: 'A', id: 'c2', m0: 100, m1: 100, r0: 1004, r1: 1006 });
  for (let i = 0; i < 50; i++) k.addEvent({ node: 'B', id: `b${i}`, mono: 1000 + i });

  const again = k.query({ version: v1 });
  assert.deepEqual(again.events[0].effectiveInterval, intervalBefore);
  assert.deepEqual(again.events, snapshot.events);
  assert.equal(again.version, v1);
  assert.ok(again.latestVersion > v1, '快照标注的 latestVersion 仍跟随当前');
  // 冻结保护：调用方无法就地篡改快照
  assert.throws(() => {
    snapshot.events[0].mono = 999;
  }, TypeError);
});

test('新版本的判断在旧版本重查时不出现；changes 只报真正改变的部分', () => {
  const k = new CorrelationKernel();
  k.addNode({ id: 'A', maxDriftRate: 0 });
  k.addNode({ id: 'B', maxDriftRate: 0 });
  k.addEvent({ node: 'A', id: 'a1', mono: 100 });
  k.addEvent({ node: 'B', id: 'b1', mono: 200 });
  const v0 = k.currentVersion;
  assert.equal(k.compare('Aa1', 'Bb1', { version: v0 }).relation, 'unknown');

  const v1 = k.addMessage({ id: 'm1', from: 'A', to: 'B', fromMono: 100, toMono: 200 });
  assert.equal(k.compare('Aa1', 'Bb1').relation, 'before');
  assert.equal(k.compare('Aa1', 'Bb1', { version: v0 }).relation, 'unknown');

  const ch = k.changes({
    fromVersion: v0,
    toVersion: v1,
    events: ['Aa1', 'Bb1'],
  });
  const rel = ch.relationChanges.find(
    (c) => c.a === 'Aa1' && c.b === 'Bb1'
  );
  assert.ok(rel);
  assert.equal(rel.before ?? 'unknown', 'unknown');
  assert.equal(rel.after, 'before');
});

test('新增较晚的校准收紧附近事件区间：changes 报 interval-tightened，旧区间保留在 before', () => {
  const k = new CorrelationKernel();
  k.addNode({ id: 'A', maxDriftRate: 0 });
  k.addCalibration({ node: 'A', id: 'loose', m0: 1000, m1: 1010, r0: 5000, r1: 5100 });
  const v1 = k.addEvent({ node: 'A', id: 'a1', mono: 1005 });
  const before = k.query({ version: v1 }).events[0];
  assert.notEqual(before.effectiveInterval[0], before.effectiveInterval[1]);

  k.addCalibration({ node: 'A', id: 'tight', m0: 1005, m1: 1005, r0: 5040, r1: 5060 });
  const ch = k.changes({ fromVersion: v1 });
  const t = ch.changed.find((c) => c.type === 'interval-tightened' && c.key === 'Aa1');
  assert.ok(t, '区间应收紧并被报告');
  assert.ok(t.after.effectiveInterval[0] >= t.before.effectiveInterval[0]);
  assert.ok(t.after.effectiveInterval[1] <= t.before.effectiveInterval[1]);
  assert.equal(t.after.effectiveInterval[0], 5040);
  assert.equal(t.after.effectiveInterval[1], 5060);
});

test('追加不会使已证明的关系倒退或使区间变宽（单调性抽查）', () => {
  const k = new CorrelationKernel();
  k.addNode({ id: 'A', maxDriftRate: 0.001 });
  k.addNode({ id: 'B', maxDriftRate: 0.001 });
  const facts = () => {
    k.addEvent({ node: 'A', id: `a${k.currentVersion}`, mono: k.currentVersion * 100 });
    k.addEvent({ node: 'B', id: `b${k.currentVersion}`, mono: k.currentVersion * 100 });
    if (k.currentVersion % 3 === 0) {
      k.addCalibration({
        node: 'A',
        id: `c${k.currentVersion}`,
        m0: k.currentVersion * 100,
        m1: k.currentVersion * 100,
        r0: 4000 + k.currentVersion * 100,
        r1: 4000 + k.currentVersion * 100,
      });
    }
  };
  let prev = null;
  for (let round = 0; round < 8; round++) {
    facts();
    const v = k.currentVersion;
    const q = k.query({ version: v, nodes: ['A', 'B'] });
    if (prev) {
      for (const e of q.events) {
        const old = prev.events.get(e.key);
        if (old && old.effectiveInterval) {
          assert.ok(e.effectiveInterval[0] >= old.effectiveInterval[0]);
          assert.ok(e.effectiveInterval[1] <= old.effectiveInterval[1]);
        }
      }
      const oldProven = new Set(prev.proven.map((p) => `${p.a}<${p.b}`));
      for (const p of q.proven) {
        // 同一条边不会从 before 翻转为相反方向
        assert.ok(!oldProven.has(`${p.b}<${p.a}`));
      }
    }
    prev = {
      events: new Map(q.events.map((e) => [e.key, e])),
      proven: q.proven,
    };
  }
});

test('窗口查询：只返回区间与窗口相交的事件，未校准节点经消息邻接一并纳入', () => {
  const k = new CorrelationKernel();
  k.addNode({ id: 'A', maxDriftRate: 0 });
  k.addNode({ id: 'B', maxDriftRate: 0 });
  k.addCalibration({ node: 'A', id: 'c', m0: 0, m1: 0, r0: 1000, r1: 1000 });
  k.addEvent({ node: 'A', id: 'inWin', mono: 100 }); // 参考时间 1100
  k.addEvent({ node: 'A', id: 'outWin', mono: 9000 }); // 10000
  k.addEvent({ node: 'B', id: 'uncalRecv', mono: 5 }); // 无校准
  k.addMessage({ id: 'm', from: 'A', to: 'B', fromMono: 100, toMono: 5 });

  const r = k.query({ range: [1050, 1150] });
  const keys = r.events.map((e) => e.key);
  assert.ok(keys.includes('AinWin'));
  assert.ok(!keys.includes('AoutWin'));
  assert.ok(
    keys.includes('BuncalRecv'),
    '未校准的消息接收方虽无窗口可言，仍因因果邻接纳入并携带传播后的区间'
  );
  const recv = r.events.find((e) => e.key === 'BuncalRecv');
  assert.deepEqual(recv.effectiveInterval, [1100, null]);
});

test('节点过滤与窗口组合', () => {
  const k = new CorrelationKernel();
  k.addNode({ id: 'A', maxDriftRate: 0 });
  k.addNode({ id: 'B', maxDriftRate: 0 });
  k.addCalibration({ node: 'A', id: 'c', m0: 0, m1: 0, r0: 1000, r1: 1000 });
  k.addCalibration({ node: 'B', id: 'c', m0: 0, m1: 0, r0: 1000, r1: 1000 });
  k.addEvent({ node: 'A', id: 'a', mono: 10 });
  k.addEvent({ node: 'B', id: 'b', mono: 10 });
  const r = k.query({ range: [900, 2000], nodes: ['A'] });
  assert.deepEqual(r.events.map((e) => e.node), ['A']);
});

test('非法版本号抛出 ValidationError，而不是静默给出当前版本', () => {
  const k = new CorrelationKernel();
  k.addNode({ id: 'A' });
  assert.throws(() => k.query({ version: 5 }), /版本号/);
  assert.throws(() => k.query({ version: -1 }), /版本号/);
});
