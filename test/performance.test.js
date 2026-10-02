'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createKernel } = require('..');

// 30k events across 8 nodes, appended in 300 batches, with periodic
// calibrations and cross-node message edges. Verifies the kernel sustains
// continuous ingest and answers local queries without rescanning history.
test('performance: 30k events, batched appends, local queries', () => {
  const NODES = 8;
  const BATCHES = 300;
  const PER_BATCH = 100;
  const k = createKernel({ maxDriftRate: 0.001 });

  const t0 = Date.now();
  const counters = new Array(NODES).fill(0);
  const sampleMessages = [];
  const diffPairs = []; // messages whose endpoints exist in both v150 and v
  let v = k.initial;
  let v150 = null;

  for (let b = 0; b < BATCHES; b++) {
    const events = [];
    for (let j = 0; j < PER_BATCH; j++) {
      const node = (b * PER_BATCH + j) % NODES;
      counters[node] += 10;
      events.push({ id: `e${b}_${j}`, node: `n${node}`, mono: counters[node] });
    }
    const calibrations = [];
    if (b % 50 === 0) {
      // Rate-1 calibrations (well inside the 0.001 drift bound), one per node.
      for (let n = 0; n < NODES; n++) {
        const m1 = b * 100;
        calibrations.push({
          id: `c${b}_n${n}`,
          node: `n${n}`,
          m1,
          m2: m1 + 10,
          t1: 1000 + m1,
          t2: 1000 + m1 + 5,
        });
      }
    }
    const messages = [];
    if (b > 0) {
      // send on node x in batch b-1, recv on node (x+4)%8 in batch b.
      for (let j = 20; j < 40; j++) {
        const msg = { send: `e${b - 1}_${j}`, recv: `e${b}_${j}` };
        messages.push(msg);
        if (b >= BATCHES - 3) sampleMessages.push(msg);
        if (b >= 140 && b < 150 && j < 30) diffPairs.push([msg.send, msg.recv]);
      }
    }
    v = k.append(v, { events, calibrations, messages });
    if (b === 149) v150 = v;
  }
  const tAppend = Date.now() - t0;

  const st = k.stats(v);
  assert.equal(st.events, BATCHES * PER_BATCH);
  assert.equal(st.nodes, NODES);
  assert.equal(st.calibrations, 6 * NODES);
  assert.equal(st.messages, (BATCHES - 1) * 20);

  const t1 = Date.now();
  for (const m of sampleMessages) {
    assert.equal(k.relation(v, m.send, m.recv).order, 'before');
  }
  // 2000 pairwise relation queries against the latest version.
  let before = 0;
  let unknown = 0;
  for (let i = 0; i < 2000; i++) {
    const a = `e${(i * 37) % BATCHES}_${(i * 11) % PER_BATCH}`;
    const b = `e${(i * 53 + 7) % BATCHES}_${(i * 29 + 3) % PER_BATCH}`;
    const r = k.relation(v, a, b).order;
    if (r === 'before' || r === 'after') before++;
    else if (r === 'unknown') unknown++;
  }
  assert.ok(before > 0);
  const tRelations = Date.now() - t1;

  const t2 = Date.now();
  for (let i = 0; i < 100; i++) {
    const lo = 1000 + i * 100;
    const hits = k.scan(v, { lo, hi: lo + 50 });
    assert.ok(Array.isArray(hits));
  }
  const tScans = Date.now() - t2;

  const t3 = Date.now();
  assert.equal(k.conflicts(v).length, 0);
  const d = k.diff(v150, v, { pairs: diffPairs });
  assert.equal(d.addedEvents.length, (BATCHES - 150) * PER_BATCH);
  const tDiffAndConflicts = Date.now() - t3;

  // Old version remains queryable and stable.
  assert.equal(k.stats(v150).events, 150 * PER_BATCH);
  const again = k.relation(v150, 'e10_0', 'e10_1');
  assert.equal(again.order, k.relation(v150, 'e10_0', 'e10_1').order);

  console.log(
    `  perf: append=${tAppend}ms relations(2060)=${tRelations}ms ` +
      `scans(100)=${tScans}ms conflicts+diff=${tDiffAndConflicts}ms`
  );
  assert.ok(tAppend < 10000, `appends too slow: ${tAppend}ms`);
  assert.ok(tRelations < 5000, `relation queries too slow: ${tRelations}ms`);
  assert.ok(tScans < 5000, `scans too slow: ${tScans}ms`);
});
