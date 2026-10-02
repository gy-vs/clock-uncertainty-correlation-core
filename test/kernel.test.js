'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createKernel } = require('..');

// Shared calibration fixtures (drift rate 0 unless stated otherwise).
// cA1: exchange on node A spanning local counts [0, 10], reference [1000, 1005].
//   => constraint points (0, [995, 1000])), (10, [1005, 1015]); the prefix
//   intersection tightens the second point to [1005, 1010].
const cA1 = { id: 'cA1', node: 'A', m1: 0, m2: 10, t1: 1000, t2: 1005 };
// cA2: a later, precise exchange (small round-trip): ref(100) = 1099 exactly.
const cA2 = { id: 'cA2', node: 'A', m1: 100, m2: 102, t1: 1099, t2: 1101 };
// cH1: node H, event h at local count 0 lands in [1019.5, 1025].
const cH1 = { id: 'cH1', node: 'H', m1: 0, m2: 10, t1: 1025, t2: 1029.5 };

test('continuous appends produce new versions; old versions are not rewritten', () => {
  const k = createKernel({ maxDriftRate: 0 });

  const v1 = k.append(k.initial, {
    calibrations: [cA1],
    events: [{ id: 'e20', node: 'A', mono: 20 }],
  });
  const before = k.interval(v1, 'e20');
  assert.equal(before.lo, 1015);
  assert.equal(before.hi, 1020);
  assert.ok(before.boundedBelow && before.boundedAbove);
  const snapshot = { lo: before.lo, hi: before.hi };

  // A later calibration tightens the node's intervals.
  const v2 = k.append(v1, { calibrations: [cA2] });
  assert.equal(k.stats(v2).seq, 2);

  const after = k.interval(v2, 'e20');
  assert.equal(after.lo, 1019);
  assert.equal(after.hi, 1019);

  // The old version still is reproducible and the previously returned object
  // was not mutated behind the caller's back.
  const again = k.interval(v1, 'e20');
  assert.deepEqual({ lo: again.lo, hi: again.hi }, snapshot);
  assert.deepEqual({ lo: before.lo, hi: before.hi }, snapshot);
});

test('cross-node message edges prove order even with identical/illogical wall times', () => {
  const k = createKernel({ maxDriftRate: 0 });
  const v1 = k.append(k.initial, {
    calibrations: [cA1],
    events: [
      { id: 'sA', node: 'A', mono: 0, wall: 99999 },
      { id: 'uB', node: 'B', mono: 3, wall: 1 },
      { id: 'rB', node: 'B', mono: 7, wall: 2 },
      { id: 'u2B', node: 'B', mono: 9, wall: 3 },
    ],
  });

  // No message edge yet: B is uncalibrated, nothing can be said.
  assert.equal(k.relation(v1, 'sA', 'rB').order, 'unknown');

  const v2 = k.append(v1, { messages: [{ send: 'sA', recv: 'rB' }] });

  const fwd = k.relation(v2, 'sA', 'rB');
  assert.equal(fwd.order, 'before');
  assert.equal(fwd.basis.causal, true);
  assert.equal(fwd.basis.time, false); // B has no calibration at all

  assert.equal(k.relation(v2, 'rB', 'sA').order, 'after');
  // Causality propagates transitively along B's monotonic chain.
  assert.equal(k.relation(v2, 'sA', 'u2B').order, 'before');
  // uB lies before the receive on B: no causal path from sA, still unknown.
  assert.equal(k.relation(v2, 'sA', 'uB').order, 'unknown');

  // The uncalibrated node is not assigned a fake precise reference time.
  const ri = k.interval(v2, 'rB');
  assert.equal(ri.boundedBelow, false);
  assert.equal(ri.boundedAbove, false);

  // Old version still says unknown.
  assert.equal(k.relation(v1, 'sA', 'rB').order, 'unknown');

  const d = k.diff(v1, v2, { pairs: [['sA', 'rB'], ['sA', 'u2B'], ['sA', 'uB']] });
  assert.deepEqual(d.addedMessages, [{ send: 'sA', recv: 'rB' }]);
  assert.deepEqual(
    d.relationChanges,
    [
      { a: 'sA', b: 'rB', before: 'unknown', after: 'before' },
      { a: 'sA', b: 'u2B', before: 'unknown', after: 'before' },
    ]
  );
});

test('disjoint reference-time intervals prove order; overlapping intervals stay unknown', () => {
  const k = createKernel({ maxDriftRate: 0 });
  const cC1 = { id: 'cC1', node: 'C', m1: 0, m2: 10, t1: 2000, t2: 2005 };
  const cD1 = { id: 'cD1', node: 'D', m1: 0, m2: 10, t1: 1005, t2: 1010 };
  const v = k.append(k.initial, {
    calibrations: [cA1, cC1, cD1],
    events: [
      { id: 'a0', node: 'A', mono: 0 }, // [995, 1000]
      { id: 'a5', node: 'A', mono: 5 }, // [1000, 1005]
      { id: 'c0', node: 'C', mono: 0 }, // [1995, 2000]
      { id: 'd0', node: 'D', mono: 0 }, // [1000, 1005]
    ],
  });

  const r1 = k.relation(v, 'a0', 'c0');
  assert.equal(r1.order, 'before');
  assert.equal(r1.basis.time, true);
  assert.equal(r1.basis.causal, false);
  assert.equal(k.relation(v, 'c0', 'a0').order, 'after');

  // Identical intervals: no order can be established from time.
  const r2 = k.relation(v, 'a5', 'd0');
  assert.equal(r2.order, 'unknown');
  assert.equal(r2.basis.time, false);
});

test('recalibration: requerying a new version tightens intervals and flips judgments', () => {
  const k = createKernel({ maxDriftRate: 0 });
  const v1 = k.append(k.initial, {
    calibrations: [cA1, cH1],
    events: [
      { id: 'e20', node: 'A', mono: 20 }, // v1: [1015, 1020]
      { id: 'h', node: 'H', mono: 0 }, // [1019.5, 1025]
    ],
  });
  assert.equal(k.relation(v1, 'e20', 'h').order, 'unknown');

  const v2 = k.append(v1, { calibrations: [cA2] }); // e20 -> [1019, 1019]
  const r = k.relation(v2, 'e20', 'h');
  assert.equal(r.order, 'before');
  assert.equal(r.basis.time, true);

  const d = k.diff(v1, v2, { pairs: [['e20', 'h']] });
  assert.deepEqual(d.addedCalibrations, ['cA2']);
  const change = d.intervalChanges.find((c) => c.id === 'e20');
  assert.deepEqual(change.before, { lo: 1015, hi: 1020 });
  assert.deepEqual(change.after, { lo: 1019, hi: 1019 });
  assert.ok(!d.intervalChanges.some((c) => c.id === 'h'), 'untouched node must not appear');
  assert.deepEqual(d.relationChanges, [{ a: 'e20', b: 'h', before: 'unknown', after: 'before' }]);
});

test('conflict: mutually inconsistent calibrations are reported, not silently dropped', () => {
  const k = createKernel({ maxDriftRate: 0 });
  const cD1 = { id: 'cD1', node: 'D', m1: 0, m2: 10, t1: 1000, t2: 1005 };
  const cD2 = { id: 'cD2', node: 'D', m1: 20, m2: 30, t1: 3000, t2: 3005 };
  const v = k.append(k.initial, {
    calibrations: [cA1, cD1, cD2],
    events: [
      { id: 'a0', node: 'A', mono: 0 },
      { id: 'dMid', node: 'D', mono: 15 }, // between the contradictory observations
    ],
  });

  const cs = k.conflicts(v);
  const calibConflict = cs.find(
    (c) =>
      c.type === 'calibration-inconsistent' &&
      c.calibrations.includes('cD1') &&
      c.calibrations.includes('cD2')
  );
  assert.ok(calibConflict, 'expected a conflict naming both calibrations');

  const iv = k.interval(v, 'dMid');
  assert.equal(iv.inconsistent, true);
  assert.equal(iv.calibrationConflict, true);

  // No fabricated ordering from contradictory evidence.
  const r = k.relation(v, 'dMid', 'a0');
  assert.equal(r.order, 'unknown');
  assert.equal(r.basis.time, false);

  // scan skips events with no consistent reference time.
  assert.ok(!k.scan(v, { lo: 0, hi: 4000 }).some((e) => e.id === 'dMid'));
});

test('conflict: message receive preceding send in the same node monotonic order', () => {
  const k = createKernel({ maxDriftRate: 0 });
  const v = k.append(k.initial, {
    events: [
      { id: 'x', node: 'A', mono: 50 },
      { id: 'y', node: 'A', mono: 40 },
    ],
    messages: [{ send: 'x', recv: 'y' }],
  });

  const cs = k.conflicts(v);
  const c = cs.find((c) => c.type === 'message-violates-monotonic');
  assert.ok(c, 'expected message-violates-monotonic');
  assert.deepEqual(c.message, { send: 'x', recv: 'y' });
  assert.equal(c.node, 'A');
  assert.ok(!cs.some((c) => c.type === 'causal-cycle'));

  // The monotonic order itself still stands: y is before x.
  const r = k.relation(v, 'x', 'y');
  assert.equal(r.order, 'after');
  assert.equal(r.basis.causal, true);
});

test('conflict: message edge incompatible with calibration bounds', () => {
  const k = createKernel({ maxDriftRate: 0 });
  const cE1 = { id: 'cE1', node: 'E', m1: 0, m2: 10, t1: 100, t2: 105 };
  const v = k.append(k.initial, {
    calibrations: [cA1, cE1],
    events: [
      { id: 's0', node: 'A', mono: 0 }, // [995, 1000]
      { id: 'rE', node: 'E', mono: 5 }, // [100, 105]
    ],
    messages: [{ send: 's0', recv: 'rE' }],
  });

  const cs = k.conflicts(v);
  const c = cs.find((c) => c.type === 'message-violates-calibration');
  assert.ok(c, 'expected message-violates-calibration');
  assert.deepEqual(c.message, { send: 's0', recv: 'rE' });
  assert.deepEqual(c.sendInterval, { lo: 995, hi: 1000 });
  assert.deepEqual(c.recvInterval, { lo: 100, hi: 105 });

  // Causality says s0 <= rE, clocks say rE < s0: reported as conflict,
  // not resolved by arbitrarily dropping one side.
  assert.equal(k.relation(v, 's0', 'rE').order, 'conflict');
});

test('conflict: causal cycle across nodes', () => {
  const k = createKernel({ maxDriftRate: 0 });
  const v = k.append(k.initial, {
    events: [
      { id: 'a1', node: 'A', mono: 1 },
      { id: 'b1', node: 'B', mono: 1 },
    ],
    messages: [
      { send: 'a1', recv: 'b1' },
      { send: 'b1', recv: 'a1' },
    ],
  });
  const cs = k.conflicts(v);
  const c = cs.find((c) => c.type === 'causal-cycle');
  assert.ok(c, 'expected causal-cycle');
  assert.ok(c.events.includes('a1') && c.events.includes('b1'));
  assert.equal(k.relation(v, 'a1', 'b1').order, 'unknown');
});

test('uncalibrated node: unbounded interval, but message edges still prove order', () => {
  const k = createKernel({ maxDriftRate: 0 });
  const v1 = k.append(k.initial, {
    calibrations: [cA1],
    events: [
      { id: 'a0', node: 'A', mono: 0 },
      { id: 'f1', node: 'F', mono: 1, wall: 500 },
      { id: 'f2', node: 'F', mono: 2, wall: 501 },
    ],
  });

  const iv = k.interval(v1, 'f1');
  assert.equal(iv.lo, -Infinity);
  assert.equal(iv.hi, Infinity);
  assert.equal(iv.boundedBelow, false);
  assert.equal(iv.boundedAbove, false);

  // Same wall clock readings prove nothing without evidence.
  assert.equal(k.relation(v1, 'f1', 'a0').order, 'unknown');

  const v2 = k.append(v1, { messages: [{ send: 'a0', recv: 'f1' }] });
  assert.equal(k.relation(v2, 'a0', 'f1').order, 'before');
  assert.equal(k.relation(v2, 'a0', 'f2').order, 'before'); // transitive
  assert.equal(k.relation(v2, 'f1', 'a0').order, 'after');

  // Uncalibrated events appear in any reference-time window as unbounded.
  const hits = k.scan(v2, { lo: 1000, hi: 1010 });
  const f = hits.find((e) => e.id === 'f1');
  assert.ok(f);
  assert.equal(f.boundedBelow, false);
  assert.equal(f.boundedAbove, false);
});

test('drift widens intervals away from calibration points', () => {
  const k = createKernel({ maxDriftRate: 0.1 });
  const g1 = { id: 'g1', node: 'G', m1: 0, m2: 10, t1: 1000, t2: 1005 };
  const v = k.append(k.initial, {
    calibrations: [g1],
    events: [
      { id: 'gNear', node: 'G', mono: 10 },
      { id: 'gFar', node: 'G', mono: 110 },
    ],
  });
  const near = k.interval(v, 'gNear');
  const far = k.interval(v, 'gFar');
  assert.ok(Math.abs(near.lo - 1005) < 1e-9);
  assert.ok(Math.abs(near.hi - 1011) < 1e-9);
  assert.ok(Math.abs(far.lo - 1095) < 1e-9);
  assert.ok(Math.abs(far.hi - 1121) < 1e-9);
  assert.ok(far.hi - far.lo > near.hi - near.lo);
});

test('scan returns exactly the events whose intervals intersect the window', () => {
  const k = createKernel({ maxDriftRate: 0 });
  const events = [];
  for (let m = 0; m <= 50; m += 5) events.push({ id: `a${m}`, node: 'A', mono: m });
  events.push({ id: 'f1', node: 'F', mono: 1 });
  const v = k.append(k.initial, { calibrations: [cA1], events });

  const ids = k.scan(v, { lo: 1000, hi: 1010 }).map((e) => e.id);
  assert.deepEqual(new Set(ids), new Set(['a0', 'a5', 'a10', 'a15', 'f1']));

  const open = k.scan(v, { lo: 1015 }).filter((e) => e.node === 'A').map((e) => e.id);
  assert.equal(open.length, 8); // a15 .. a50

  const low = k.scan(v, { hi: 999 }).filter((e) => e.node === 'A').map((e) => e.id);
  assert.deepEqual(low, ['a0']);
});

test('malformed input is rejected with errors, not reported as data conflict', () => {
  const k = createKernel({ maxDriftRate: 0 });
  const v = k.append(k.initial, { events: [{ id: 'e1', node: 'A', mono: 1 }] });
  assert.throws(() => k.append(v, { events: [{ id: 'e1', node: 'A', mono: 2 }] }), /duplicate event id/);
  assert.throws(() => k.append(v, { events: [{ id: 'e2', node: 'A', mono: 1 }] }), /duplicate monotonic count/);
  assert.throws(
    () => k.append(v, { calibrations: [{ id: 'c', node: 'A', m1: 5, m2: 1, t1: 0, t2: 0 }] }),
    /m1 must be <= m2/
  );
  assert.throws(
    () => k.append(v, { events: [{ id: 'e3', node: 'A', mono: 3 }], messages: [{ send: 'e3', recv: 'nope' }] }),
    /recv endpoint not found/
  );
  assert.throws(() => k.relation(v, 'e1', 'ghost'), /unknown event/);
  assert.equal(k.interval(v, 'ghost'), null);
  assert.throws(() => k.diff(v, k.initial), /descendant/);
});

test('event lookup and stats', () => {
  const k = createKernel({ maxDriftRate: 0 });
  const v = k.append(k.initial, {
    calibrations: [cA1],
    events: [{ id: 'e1', node: 'A', mono: 1, wall: 42 }],
    messages: [],
  });
  assert.deepEqual(k.get(v, 'e1'), { id: 'e1', node: 'A', mono: 1, wall: 42, seq: 1 });
  assert.equal(k.get(v, 'nope'), null);
  assert.deepEqual(k.stats(v), { seq: 1, nodes: 1, events: 1, calibrations: 1, messages: 0 });
});
