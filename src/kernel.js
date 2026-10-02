'use strict';

/**
 * Clock Uncertainty Correlation kernel.
 *
 * Model
 * -----
 * - Each node emits events stamped with a LOCAL MONOTONIC COUNTER. The counter
 *   is assumed to tick in the same units as the reference clock (e.g. both in
 *   milliseconds) and to advance at a rate within [1-rho, 1+rho] of reference
 *   time, where rho is the kernel's `maxDriftRate`.
 * - A calibration observation is one round-trip exchange with the reference
 *   clock: the node sent a request at local count m1, the reference clock
 *   received it at t1, replied at t2, and the node received the reply at local
 *   count m2 (m1 <= m2, t1 <= t2). This yields HARD bounds, not a point offset:
 *       ref(m1) in [t2 - (m2-m1)(1+rho), t1]
 *       ref(m2) in [t2, t1 + (m2-m1)(1+rho)]
 * - Between calibration points, bounds propagate with the drift cone; the
 *   tightest interval for an event is the intersection of all propagated
 *   bounds of its node. A node with no calibrations gets an UNBOUNDED
 *   interval — the kernel never invents a precise reference time for it.
 * - Causality across nodes comes from message edges (send -> recv) plus the
 *   per-node monotonic order. It is tracked with vector clocks, so a message
 *   edge proves "before" even when wall-clock readings are identical or when
 *   one side has no calibration at all.
 * - Raw wall-clock readings submitted with events are stored and echoed back
 *   for display only; they are NEVER used to derive ordering or intervals.
 *
 * Versions
 * --------
 * `append` returns a new immutable version; previously returned versions are
 * never mutated, so judgments obtained from an old version are reproducible.
 * State is shared structurally per node, so appending is cheap and queries
 * never rescan the whole history.
 */

const NEG_INF = -Infinity;
const POS_INF = Infinity;

function isFiniteNumber(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

function requireNonEmptyString(value, what) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${what} must be a non-empty string, got: ${String(value)}`);
  }
}

function requireFiniteNumber(value, what) {
  if (!isFiniteNumber(value)) {
    throw new TypeError(`${what} must be a finite number, got: ${String(value)}`);
  }
}

/** First index i in sorted array `arr` with arr[i] > x (plain numbers). */
function upperBound(arr, x) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index i in sorted array `arr` with arr[i] >= x (plain numbers). */
function lowerBound(arr, x) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function createKernel(options) {
  const opts = options || {};
  const rho = opts.maxDriftRate === undefined ? 1e-4 : opts.maxDriftRate;
  if (!isFiniteNumber(rho) || rho < 0 || rho >= 1) {
    throw new TypeError('maxDriftRate must be a finite number in [0, 1)');
  }
  const driftLo = 1 - rho;
  const driftHi = 1 + rho;

  // -------------------------------------------------------------------------
  // Versions
  // -------------------------------------------------------------------------

  function makeVersion(seq, nodes, messages, eventsById, calibrationsById) {
    return {
      seq,
      nodes, // Map<node, {events: [...], calibs: [...], _prep, _index}>
      messages, // array of {send, recv, seq}
      eventsById, // Map<id, {id, node, mono, wall, seq}>
      calibrationsById, // Map<id, {id, node, m1, m2, t1, t2, seq}>
      _vc: null, // lazy: Map<eventId, Map<node, mono>>
      _vcConflicts: null,
      _conflicts: null,
    };
  }

  const initial = makeVersion(0, new Map(), [], new Map(), new Map());

  function assertVersion(v) {
    if (!v || !v.nodes || !v.eventsById || typeof v.seq !== 'number') {
      throw new TypeError('not a version handle produced by this kernel');
    }
  }

  // -------------------------------------------------------------------------
  // Ingest
  // -------------------------------------------------------------------------

  function validateCalibration(raw) {
    requireNonEmptyString(raw.id, 'calibration.id');
    requireNonEmptyString(raw.node, 'calibration.node');
    requireFiniteNumber(raw.m1, 'calibration.m1');
    requireFiniteNumber(raw.m2, 'calibration.m2');
    requireFiniteNumber(raw.t1, 'calibration.t1');
    requireFiniteNumber(raw.t2, 'calibration.t2');
    if (raw.m1 > raw.m2) {
      throw new TypeError(`calibration ${raw.id}: m1 must be <= m2`);
    }
    if (raw.t1 > raw.t2) {
      throw new TypeError(`calibration ${raw.id}: t1 must be <= t2`);
    }
  }

  function validateEvent(raw) {
    requireNonEmptyString(raw.id, 'event.id');
    requireNonEmptyString(raw.node, 'event.node');
    requireFiniteNumber(raw.mono, 'event.mono');
    if (raw.wall !== undefined) requireFiniteNumber(raw.wall, 'event.wall');
  }

  function insertEventSorted(events, rec) {
    // events are sorted by mono; mono must be unique per node
    let lo = 0;
    let hi = events.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (events[mid].mono <= rec.mono) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0 && events[lo - 1].mono === rec.mono) {
      throw new TypeError(
        `duplicate monotonic count ${rec.mono} on node ${rec.node} (event ${rec.id})`
      );
    }
    events.splice(lo, 0, rec);
  }

  function insertCalibSorted(calibs, rec) {
    let pos = 0;
    while (
      pos < calibs.length &&
      (calibs[pos].m1 < rec.m1 || (calibs[pos].m1 === rec.m1 && calibs[pos].m2 <= rec.m2))
    ) {
      pos++;
    }
    calibs.splice(pos, 0, rec);
  }

  /**
   * Append a batch of observations. Returns a NEW version; `version` is not
   * modified. batch: { calibrations?: [...], events?: [...], messages?: [...] }.
   * A message is {send: eventId, recv: eventId}; both endpoints must exist in
   * the resulting version (they may be introduced in the same batch).
   */
  function append(version, batch) {
    assertVersion(version);
    const input = batch || {};
    const calibs = input.calibrations || [];
    const events = input.events || [];
    const messages = input.messages || [];
    if (!Array.isArray(calibs) || !Array.isArray(events) || !Array.isArray(messages)) {
      throw new TypeError('batch.calibrations / batch.events / batch.messages must be arrays');
    }

    const nextSeq = version.seq + 1;
    const eventsById = new Map(version.eventsById);
    const calibrationsById = new Map(version.calibrationsById);
    const touched = new Map(); // node -> fresh node state (copy-on-write)

    const nodeStateFor = (node) => {
      let ns = touched.get(node);
      if (ns) return ns;
      const old = version.nodes.get(node);
      ns = {
        events: old ? old.events.slice() : [],
        calibs: old ? old.calibs.slice() : [],
        _prep: null,
        _index: null,
      };
      touched.set(node, ns);
      return ns;
    };

    for (const raw of events) {
      validateEvent(raw);
      if (eventsById.has(raw.id)) {
        throw new TypeError(`duplicate event id: ${raw.id}`);
      }
      const rec = {
        id: raw.id,
        node: raw.node,
        mono: raw.mono,
        wall: raw.wall === undefined ? null : raw.wall,
        seq: nextSeq,
      };
      insertEventSorted(nodeStateFor(rec.node).events, rec);
      eventsById.set(rec.id, rec);
    }

    for (const raw of calibs) {
      validateCalibration(raw);
      if (calibrationsById.has(raw.id)) {
        throw new TypeError(`duplicate calibration id: ${raw.id}`);
      }
      const rec = {
        id: raw.id,
        node: raw.node,
        m1: raw.m1,
        m2: raw.m2,
        t1: raw.t1,
        t2: raw.t2,
        seq: nextSeq,
      };
      insertCalibSorted(nodeStateFor(rec.node).calibs, rec);
      calibrationsById.set(rec.id, rec);
    }

    let allMessages = version.messages;
    if (messages.length > 0) {
      const known = new Set();
      for (const m of version.messages) known.add(`${m.send}${m.recv}`);
      const added = [];
      for (const raw of messages) {
        requireNonEmptyString(raw.send, 'message.send');
        requireNonEmptyString(raw.recv, 'message.recv');
        if (raw.send === raw.recv) {
          throw new TypeError(`message endpoints must differ (event ${raw.send})`);
        }
        if (!eventsById.has(raw.send)) {
          throw new TypeError(`message send endpoint not found: ${raw.send}`);
        }
        if (!eventsById.has(raw.recv)) {
          throw new TypeError(`message recv endpoint not found: ${raw.recv}`);
        }
        const key = `${raw.send}${raw.recv}`;
        if (known.has(key)) continue; // idempotent re-submission
        known.add(key);
        added.push({ send: raw.send, recv: raw.recv, seq: nextSeq });
      }
      if (added.length > 0) allMessages = version.messages.concat(added);
    }

    let nodes = version.nodes;
    if (touched.size > 0) {
      nodes = new Map(version.nodes);
      for (const [node, ns] of touched) nodes.set(node, ns);
    }
    return makeVersion(nextSeq, nodes, allMessages, eventsById, calibrationsById);
  }

  // -------------------------------------------------------------------------
  // Calibration geometry (per node, cached on the immutable node state)
  // -------------------------------------------------------------------------

  function getPrep(node, ns) {
    if (ns._prep) return ns._prep;
    const pts = [];
    const conflicts = [];
    for (const c of ns.calibs) {
      const span = (c.m2 - c.m1) * driftHi;
      const aLo = c.t2 - span;
      const aHi = c.t1;
      const bLo = c.t2;
      const bHi = c.t1 + span;
      if (aLo > aHi || bLo > bHi) {
        // The reference clock spent longer inside the exchange than the local
        // counter could possibly have advanced: this single observation is
        // impossible under the drift bound. Reported, and excluded from
        // interval computation so it cannot poison the whole node.
        conflicts.push({
          type: 'calibration-inconsistent',
          node,
          calibrations: [c.id],
          detail:
            'round-trip observation is impossible under the configured drift bound ' +
            `(t2 - t1 = ${c.t2 - c.t1} exceeds (m2 - m1) * (1 + drift) = ${span})`,
        });
        continue;
      }
      pts.push({ m: c.m1, lo: aLo, hi: aHi, cid: c.id });
      pts.push({ m: c.m2, lo: bLo, hi: bHi, cid: c.id });
    }
    pts.sort((x, y) => x.m - y.m);

    const n = pts.length;
    const ptsM = new Array(n);
    const preLo = new Array(n);
    const preHi = new Array(n);
    const sufLo = new Array(n);
    const sufHi = new Array(n);

    // Prefix: tightest intersection of points 0..i, propagated to pts[i].m.
    let cur = null;
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      ptsM[i] = p.m;
      if (!cur) {
        cur = { m: p.m, lo: p.lo, hi: p.hi, loSrc: p.cid, hiSrc: p.cid };
      } else {
        const d = p.m - cur.m;
        const lo = cur.lo + d * driftLo;
        const hi = cur.hi + d * driftHi;
        const nlo = Math.max(lo, p.lo);
        const nhi = Math.min(hi, p.hi);
        const loSrc = lo >= p.lo ? cur.loSrc : p.cid;
        const hiSrc = hi <= p.hi ? cur.hiSrc : p.cid;
        if (nlo > nhi) {
          conflicts.push({
            type: 'calibration-inconsistent',
            node,
            calibrations: loSrc === hiSrc ? [loSrc] : [loSrc, hiSrc],
            detail:
              'calibration observations are mutually inconsistent under the ' +
              'configured drift bound',
          });
          // Keep going from the newest point so later events still get a
          // best-effort interval; the contradiction is reported above and the
          // node is flagged via hasConflicts.
          cur = { m: p.m, lo: p.lo, hi: p.hi, loSrc: p.cid, hiSrc: p.cid };
        } else {
          cur = { m: p.m, lo: nlo, hi: nhi, loSrc, hiSrc };
        }
      }
      preLo[i] = cur.lo;
      preHi[i] = cur.hi;
    }

    // Suffix: tightest intersection of points i..n-1, propagated to pts[i].m.
    cur = null;
    for (let i = n - 1; i >= 0; i--) {
      const p = pts[i];
      if (!cur) {
        cur = { m: p.m, lo: p.lo, hi: p.hi, loSrc: p.cid, hiSrc: p.cid };
      } else {
        const d = cur.m - p.m;
        const lo = cur.lo - d * driftHi;
        const hi = cur.hi - d * driftLo;
        const nlo = Math.max(lo, p.lo);
        const nhi = Math.min(hi, p.hi);
        const loSrc = lo >= p.lo ? cur.loSrc : p.cid;
        const hiSrc = hi <= p.hi ? cur.hiSrc : p.cid;
        if (nlo > nhi) {
          conflicts.push({
            type: 'calibration-inconsistent',
            node,
            calibrations: loSrc === hiSrc ? [loSrc] : [loSrc, hiSrc],
            detail:
              'calibration observations are mutually inconsistent under the ' +
              'configured drift bound',
          });
          cur = { m: p.m, lo: p.lo, hi: p.hi, loSrc: p.cid, hiSrc: p.cid };
        } else {
          cur = { m: p.m, lo: nlo, hi: nhi, loSrc, hiSrc };
        }
      }
      sufLo[i] = cur.lo;
      sufHi[i] = cur.hi;
    }

    ns._prep = {
      count: n,
      ptsM,
      preLo,
      preHi,
      sufLo,
      sufHi,
      conflicts,
      hasConflicts: conflicts.length > 0,
    };
    return ns._prep;
  }

  /** Tightest [lo, hi] reference-time interval for local count m on a node. */
  function intervalAt(prep, m) {
    let lo = NEG_INF;
    let hi = POS_INF;
    if (prep.count === 0) return { lo, hi };
    const i = upperBound(prep.ptsM, m) - 1; // last point with ptsM <= m
    if (i >= 0) {
      const d = m - prep.ptsM[i];
      lo = Math.max(lo, prep.preLo[i] + d * driftLo);
      hi = Math.min(hi, prep.preHi[i] + d * driftHi);
    }
    const j = lowerBound(prep.ptsM, m); // first point with ptsM >= m
    if (j < prep.count) {
      const d = prep.ptsM[j] - m;
      lo = Math.max(lo, prep.sufLo[j] - d * driftHi);
      hi = Math.min(hi, prep.sufHi[j] - d * driftLo);
    }
    return { lo, hi };
  }

  /** Upper envelope only (non-decreasing in m when no conflicts). */
  function hiBoundAt(prep, m) {
    let hi = POS_INF;
    const i = upperBound(prep.ptsM, m) - 1;
    if (i >= 0) hi = Math.min(hi, prep.preHi[i] + (m - prep.ptsM[i]) * driftHi);
    const j = lowerBound(prep.ptsM, m);
    if (j < prep.count) hi = Math.min(hi, prep.sufHi[j] - (prep.ptsM[j] - m) * driftLo);
    return hi;
  }

  /** Prefix-only lower envelope (non-decreasing in m when no conflicts). */
  function preLoAt(prep, m) {
    const i = upperBound(prep.ptsM, m) - 1;
    if (i < 0) return NEG_INF;
    return prep.preLo[i] + (m - prep.ptsM[i]) * driftLo;
  }

  function publicInterval(iv) {
    return {
      lo: iv.lo,
      hi: iv.hi,
      boundedBelow: iv.lo !== NEG_INF,
      boundedAbove: iv.hi !== POS_INF,
      inconsistent: iv.lo > iv.hi,
    };
  }

  // -------------------------------------------------------------------------
  // Causality (vector clocks over: per-node mono chain + message edges)
  // -------------------------------------------------------------------------

  function nodeIndex(ns) {
    if (!ns._index) {
      const map = new Map();
      for (let i = 0; i < ns.events.length; i++) map.set(ns.events[i].id, i);
      ns._index = map;
    }
    return ns._index;
  }

  function computeCausality(version) {
    if (version._vc) return;
    const vc = new Map();
    const vcConflicts = [];

    const inEdges = new Map(); // recvId -> sendId[]
    const outEdges = new Map(); // sendId -> recvId[]
    for (const msg of version.messages) {
      const s = version.eventsById.get(msg.send);
      const r = version.eventsById.get(msg.recv);
      // Same-node edges that contradict the monotonic order are excluded from
      // the graph (they would fabricate a cycle); they are reported as
      // 'message-violates-monotonic' conflicts by conflicts().
      if (s.node === r.node && s.mono >= r.mono) continue;
      if (!inEdges.has(msg.recv)) inEdges.set(msg.recv, []);
      inEdges.get(msg.recv).push(msg.send);
      if (!outEdges.has(msg.send)) outEdges.set(msg.send, []);
      outEdges.get(msg.send).push(msg.recv);
    }

    const indeg = new Map();
    const queue = [];
    for (const [, ns] of version.nodes) {
      for (let i = 0; i < ns.events.length; i++) {
        const e = ns.events[i];
        const d = (i > 0 ? 1 : 0) + (inEdges.has(e.id) ? inEdges.get(e.id).length : 0);
        indeg.set(e.id, d);
        if (d === 0) queue.push(e);
      }
    }

    const mergeInto = (target, source) => {
      if (!source) return;
      for (const [k, val] of source) {
        const cur = target.get(k);
        if (cur === undefined || cur < val) target.set(k, val);
      }
    };

    let head = 0;
    while (head < queue.length) {
      const e = queue[head++];
      const ns = version.nodes.get(e.node);
      const idx = nodeIndex(ns).get(e.id);
      const v = new Map();
      if (idx > 0) mergeInto(v, vc.get(ns.events[idx - 1].id));
      const sends = inEdges.get(e.id);
      if (sends) for (const sid of sends) mergeInto(v, vc.get(sid));
      const known = v.get(e.node);
      if (known === undefined || known < e.mono) v.set(e.node, e.mono);
      vc.set(e.id, v);

      if (idx + 1 < ns.events.length) {
        const succ = ns.events[idx + 1];
        const d = indeg.get(succ.id) - 1;
        indeg.set(succ.id, d);
        if (d === 0) queue.push(succ);
      }
      const outs = outEdges.get(e.id);
      if (outs) {
        for (const rid of outs) {
          const d = indeg.get(rid) - 1;
          indeg.set(rid, d);
          if (d === 0) queue.push(version.eventsById.get(rid));
        }
      }
    }

    if (vc.size < version.eventsById.size) {
      // Events still blocked are part of (or downstream of) a causal cycle.
      const stuck = [];
      for (const [id, e] of version.eventsById) {
        if (!vc.has(id)) {
          stuck.push(id);
          // Degraded clock: the event knows only itself. Relations involving
          // it fall back to "unknown" rather than inventing an order.
          vc.set(id, new Map([[e.node, e.mono]]));
        }
      }
      vcConflicts.push({
        type: 'causal-cycle',
        events: stuck,
        detail: 'message edges and monotonic order form a cycle; no consistent causal order exists',
      });
    }

    version._vc = vc;
    version._vcConflicts = vcConflicts;
  }

  /** vc(a) <= vc(b) componentwise: a happens-before-or-equals b. */
  function vcLeq(a, b) {
    for (const [k, val] of a) {
      const other = b.get(k);
      if (other === undefined || other < val) return false;
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  function getEvent(version, id) {
    const e = version.eventsById.get(id);
    return e || null;
  }

  /**
   * Reference-time interval for one event, or null if the event id is unknown
   * in this version. Bounds may be infinite; `inconsistent` means the node's
   * calibration constraints are contradictory around this event (see
   * conflicts()).
   */
  function interval(version, id) {
    assertVersion(version);
    const e = version.eventsById.get(id);
    if (!e) return null;
    const ns = version.nodes.get(e.node);
    const prep = getPrep(e.node, ns);
    const iv = intervalAt(prep, e.mono);
    return {
      id: e.id,
      node: e.node,
      mono: e.mono,
      wall: e.wall,
      lo: iv.lo,
      hi: iv.hi,
      boundedBelow: iv.lo !== NEG_INF,
      boundedAbove: iv.hi !== POS_INF,
      inconsistent: iv.lo > iv.hi,
      calibrationConflict: prep.hasConflicts,
    };
  }

  /**
   * Proven order between two events.
   * order: 'before' | 'after' | 'unknown' | 'same' | 'conflict'
   * basis: which evidence classes establish the order — 'causal' (monotonic
   * order + message edges) and/or 'time' (disjoint reference-time intervals).
   */
  function relation(version, aId, bId) {
    assertVersion(version);
    const a = version.eventsById.get(aId);
    const b = version.eventsById.get(bId);
    if (!a) throw new TypeError(`unknown event: ${aId}`);
    if (!b) throw new TypeError(`unknown event: ${bId}`);
    const ia = interval(version, aId);
    const ib = interval(version, bId);
    if (aId === bId) {
      return {
        a: aId,
        b: bId,
        order: 'same',
        basis: { causal: false, time: false },
        aInterval: publicInterval(ia),
        bInterval: publicInterval(ib),
      };
    }
    computeCausality(version);
    const va = version._vc.get(aId);
    const vb = version._vc.get(bId);
    const causalAB = vcLeq(va, vb);
    const causalBA = vcLeq(vb, va);
    const timeAB = !ia.inconsistent && !ib.inconsistent && ia.hi <= ib.lo;
    const timeBA = !ia.inconsistent && !ib.inconsistent && ib.hi <= ia.lo;

    let order;
    if (causalAB && causalBA) {
      order = 'conflict'; // causal cycle involving both events
    } else if (causalAB && timeBA) {
      order = 'conflict'; // causality says a<=b, clocks say b<a
    } else if (causalBA && timeAB) {
      order = 'conflict';
    } else if (causalAB || timeAB) {
      order = 'before';
    } else if (causalBA || timeBA) {
      order = 'after';
    } else {
      order = 'unknown';
    }
    return {
      a: aId,
      b: bId,
      order,
      basis: {
        causal: causalAB || causalBA,
        time: timeAB || timeBA,
      },
      aInterval: publicInterval(ia),
      bInterval: publicInterval(ib),
    };
  }

  /**
   * Events whose reference-time interval intersects [range.lo, range.hi]
   * (open-ended sides allowed). Uses the per-node monotonic order plus the
   * precomputed bound envelopes to prune, instead of scanning all history.
   */
  function scan(version, range) {
    assertVersion(version);
    if (range && range.lo !== undefined) requireFiniteNumber(range.lo, 'range.lo');
    if (range && range.hi !== undefined) requireFiniteNumber(range.hi, 'range.hi');
    const lo = range && range.lo !== undefined ? range.lo : NEG_INF;
    const hi = range && range.hi !== undefined ? range.hi : POS_INF;
    if (lo > hi) throw new TypeError('range.lo must be <= range.hi');

    const out = [];
    for (const [node, ns] of version.nodes) {
      const prep = getPrep(node, ns);
      const events = ns.events;
      let start = 0;
      let end = events.length; // exclusive
      if (prep.count > 0 && !prep.hasConflicts) {
        // hiBound(mono) is non-decreasing along the node: events before the
        // first index whose upper bound reaches `lo` cannot intersect.
        if (lo !== NEG_INF) {
          let a = 0;
          let b = events.length;
          while (a < b) {
            const mid = (a + b) >>> 1;
            if (hiBoundAt(prep, events[mid].mono) >= lo) b = mid;
            else a = mid + 1;
          }
          start = a;
        }
        // prefix lower envelope is non-decreasing: events past the last index
        // whose lower bound stays <= `hi` cannot intersect.
        if (hi !== POS_INF) {
          let a = 0;
          let b = events.length;
          while (a < b) {
            const mid = (a + b) >>> 1;
            if (preLoAt(prep, events[mid].mono) <= hi) a = mid + 1;
            else b = mid;
          }
          end = a;
        }
      }
      for (let i = start; i < end; i++) {
        const e = events[i];
        const iv = intervalAt(prep, e.mono);
        if (iv.lo > iv.hi) continue; // inconsistent: no reference time exists
        if (iv.hi < lo || iv.lo > hi) continue;
        out.push({
          id: e.id,
          node: e.node,
          mono: e.mono,
          wall: e.wall,
          lo: iv.lo,
          hi: iv.hi,
          boundedBelow: iv.lo !== NEG_INF,
          boundedAbove: iv.hi !== POS_INF,
        });
      }
    }
    return out;
  }

  /**
   * All contradictions detectable in this version. Nothing is silently
   * dropped: every conflict names the observations / events involved.
   */
  function conflicts(version) {
    assertVersion(version);
    if (version._conflicts) return version._conflicts;
    const list = [];
    for (const [node, ns] of version.nodes) {
      const prep = getPrep(node, ns);
      for (const c of prep.conflicts) list.push(c);
    }
    computeCausality(version);
    for (const c of version._vcConflicts) list.push(c);
    for (const msg of version.messages) {
      const s = version.eventsById.get(msg.send);
      const r = version.eventsById.get(msg.recv);
      if (s.node === r.node && s.mono >= r.mono) {
        list.push({
          type: 'message-violates-monotonic',
          message: { send: msg.send, recv: msg.recv },
          node: s.node,
          sendMono: s.mono,
          recvMono: r.mono,
          detail:
            'message receive is not after its send in the monotonic order of node ' + s.node,
        });
        continue;
      }
      const is = interval(version, msg.send);
      const ir = interval(version, msg.recv);
      if (!is.inconsistent && !ir.inconsistent && ir.hi < is.lo) {
        list.push({
          type: 'message-violates-calibration',
          message: { send: msg.send, recv: msg.recv },
          sendInterval: { lo: is.lo, hi: is.hi },
          recvInterval: { lo: ir.lo, hi: ir.hi },
          detail:
            'calibration bounds place the receive entirely before the send; ' +
            'observations and message constraint cannot all hold',
        });
      }
    }
    version._conflicts = list;
    return list;
  }

  /**
   * What changed between two versions (vNew must be a descendant of vOld).
   * options.pairs: optional array of [aId, bId] whose relation judgments
   * should be compared across the two versions.
   */
  function diff(vOld, vNew, options) {
    assertVersion(vOld);
    assertVersion(vNew);
    if (vNew.seq < vOld.seq) {
      throw new TypeError('diff requires the second version to be a descendant of the first');
    }
    const opts = options || {};

    const addedEvents = [];
    for (const [id, e] of vNew.eventsById) {
      if (e.seq > vOld.seq) addedEvents.push(id);
    }
    const addedCalibrations = [];
    for (const [id, c] of vNew.calibrationsById) {
      if (c.seq > vOld.seq) addedCalibrations.push(id);
    }
    const addedMessages = vNew.messages
      .filter((m) => m.seq > vOld.seq)
      .map((m) => ({ send: m.send, recv: m.recv }));

    const intervalChanges = [];
    for (const [id, e] of vOld.eventsById) {
      const nsOld = vOld.nodes.get(e.node);
      const nsNew = vNew.nodes.get(e.node);
      if (nsOld === nsNew) continue; // node untouched: interval cannot change
      const before = interval(vOld, id);
      const after = interval(vNew, id);
      if (
        before.lo !== after.lo ||
        before.hi !== after.hi ||
        before.inconsistent !== after.inconsistent
      ) {
        intervalChanges.push({
          id,
          before: { lo: before.lo, hi: before.hi },
          after: { lo: after.lo, hi: after.hi },
        });
      }
    }

    const key = (c) => JSON.stringify(c);
    const oldConflicts = new Set(conflicts(vOld).map(key));
    const newConflicts = new Set(conflicts(vNew).map(key));
    const conflictsAdded = conflicts(vNew).filter((c) => !oldConflicts.has(key(c)));
    const conflictsResolved = conflicts(vOld).filter((c) => !newConflicts.has(key(c)));

    const relationChanges = [];
    if (Array.isArray(opts.pairs)) {
      for (const pair of opts.pairs) {
        const [aId, bId] = pair;
        const before = relation(vOld, aId, bId).order;
        const after = relation(vNew, aId, bId).order;
        if (before !== after) relationChanges.push({ a: aId, b: bId, before, after });
      }
    }

    return {
      fromSeq: vOld.seq,
      toSeq: vNew.seq,
      addedEvents,
      addedCalibrations,
      addedMessages,
      intervalChanges,
      conflictsAdded,
      conflictsResolved,
      relationChanges,
    };
  }

  function stats(version) {
    assertVersion(version);
    return {
      seq: version.seq,
      nodes: version.nodes.size,
      events: version.eventsById.size,
      calibrations: version.calibrationsById.size,
      messages: version.messages.length,
    };
  }

  return {
    maxDriftRate: rho,
    initial,
    append,
    get: getEvent,
    interval,
    relation,
    scan,
    conflicts,
    diff,
    stats,
  };
}

module.exports = { createKernel };
