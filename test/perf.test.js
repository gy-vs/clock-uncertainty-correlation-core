'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { CorrelationKernel } from '../src/index.js';

// 性能用例默认跳过；RUN_PERF=1 npm test 时执行。
const testIf = process.env.RUN_PERF ? test : test.skip;

// 目标：数万事件持续追加 + 局部查询，不能每次比较两个事件都扫描全历史。
const N_EVENTS = 30000;
const NODES = 20;
const N_CALS = 200;
const N_MSGS = 5000;

testIf(
  `${N_EVENTS} 事件规模：增量追加、局部窗口查询与单点比较都可承受`,
  { timeout: 120_000 },
  () => {
  const k = new CorrelationKernel();
  for (let n = 0; n < NODES; n++) {
    k.addNode({ id: `n${n}`, maxDriftRate: 1e-6 });
  }

  const t0 = performance.now();
  // 校准：每节点 10 条，参考时间随单调计数线性增长
  for (let n = 0; n < NODES; n++) {
    for (let c = 0; c < N_CALS / NODES; c++) {
      const m = c * 30000;
      k.addCalibration({
        node: `n${n}`,
        id: `cal${c}`,
        m0: m,
        m1: m + 5,
        r0: 1_000_000 + m,
        r1: 1_000_000 + m + 5,
      });
    }
  }
  // 事件：交错追加到各节点，单调计数大致递增
  for (let i = 0; i < N_EVENTS; i++) {
    const n = i % NODES;
    k.addEvent({ node: `n${n}`, id: `e${i}`, mono: i * 10, wall: 1_700_000_000_000 + i });
  }
  // 消息：从发送事件的所属节点指向接收事件所属节点（跳过同节点）
  let sent = 0;
  for (let m = 0; sent < N_MSGS; m++) {
    const fromIdx = (m * 7) % N_EVENTS;
    const toIdx = (m * 13 + 1) % N_EVENTS;
    const fromN = fromIdx % NODES;
    const toN = toIdx % NODES;
    if (fromN === toN) continue;
    k.addMessage({
      id: `msg${sent++}`,
      from: `n${fromN}`,
      to: `n${toN}`,
      fromMono: fromIdx * 10,
      toMono: toIdx * 10,
    });
  }
  const t1 = performance.now();

  // 局部窗口查询：窗口很窄，命中事件应只是一小部分
  const winLo = 1_000_000 + 100_000;
  const winHi = winLo + 200;
  const tq0 = performance.now();
  const r = k.query({ range: [winLo, winHi] });
  const tq1 = performance.now();

  // 单点比较：与全体事件数量无关；事件 eX 归属节点 n(X % NODES)
  const tc0 = performance.now();
  for (let i = 0; i < 100; i++) {
    const aIdx = i * 17;
    const bIdx = i * 23 + 5;
    k.compare(
      { node: `n${aIdx % NODES}`, id: `e${aIdx}` },
      { node: `n${bIdx % NODES}`, id: `e${bIdx}` }
    );
  }
  const tc1 = performance.now();

  // 旧版本重放（版本号含 addNode/校准/事件；取一个较早版本验证可重复性即可）
  const replayVersion = NODES + N_CALS + 500;
  const tr0 = performance.now();
  const old = k.query({ version: replayVersion, pairs: false });
  const tr1 = performance.now();
  const again = k.query({ version: replayVersion, pairs: false });
  assert.equal(again.events.length, old.events.length);
  assert.ok(old.events.length === 500, `重放版本应含 500 个事件，实际 ${old.events.length}`);

  const totalAppendMs = t1 - t0;
  const queryMs = tq1 - tq0;
  const compareMs = tc1 - tc0;
  const replayMs = tr1 - tr0;
  // eslint-disable-next-line no-console
  console.log(
    `perf: append=${totalAppendMs.toFixed(0)}ms query(win)=${queryMs.toFixed(1)}ms ` +
      `compare100=${compareMs.toFixed(1)}ms replay(v${replayVersion})=${replayMs.toFixed(0)}ms ` +
      `windowEvents=${r.events.length}`
  );

  // 宽松上界：追加平均每条远低于毫秒级；局部查询不应退化为全量成对比较
  assert.ok(totalAppendMs < 60_000, `追加总耗时 ${totalAppendMs}ms 超出预算`);
  assert.ok(queryMs < 5_000, `窗口查询 ${queryMs}ms 超出预算`);
  assert.ok(compareMs < 1_000, `百次比较 ${compareMs}ms 超出预算`);
  assert.ok(r.events.length < N_EVENTS / 2, '窄窗口不应返回大部分事件');
  // 全历史视图只给区间、不枚举事件对：O(N) 即可返回
  const fullT0 = performance.now();
  const full = k.query();
  const fullMs = performance.now() - fullT0;
  assert.equal(full.events.length, N_EVENTS);
  assert.equal(full.pairsEnumerated, false);
  assert.equal(full.proven.length, 0);
  assert.ok(fullMs < 2_000, `全历史视图 ${fullMs}ms 超出预算`);
  }
);

testIf(
  '追加过程中查询的延迟不随历史长度线性增长（局部查询近似 O(窗口)）',
  { timeout: 60_000 },
  () => {
  const k = new CorrelationKernel();
  k.addNode({ id: 'A', maxDriftRate: 0 });
  k.addCalibration({ node: 'A', id: 'c0', m0: 0, m1: 0, r0: 0, r1: 0 });
  let added = 0;
  const measure = (count) => {
    while (added < count) {
      k.addEvent({ node: 'A', id: `e${added}`, mono: added * 100 });
      added++;
    }
    const t = performance.now();
    for (let rep = 0; rep < 5; rep++) {
      k.query({ range: [count * 100 - 1000, count * 100 + 1000] });
    }
    return performance.now() - t;
  };
  const at2k = measure(2000);
  const at20k = measure(20000);
  // eslint-disable-next-line no-console
  console.log(`perf local query 5x: 2k=${at2k.toFixed(1)}ms 20k=${at20k.toFixed(1)}ms`);
  // 窗口大小固定，耗时不应随总量涨一个数量级以上
  assert.ok(at20k < Math.max(50, at2k * 10 + 20));
  }
);
