'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeEnvelope } from '../src/model.js';

const cal = (id, m0, m1, r0, r1) => ({ id, m0, m1, r0, r1 });

test('零 RTT 锚点：事件就在锚点时区间为零宽，矩形在矩形内按速率锥展开', () => {
  const rho = 0.01;
  const { at } = computeEnvelope([cal('c1', 1000, 1000, 5000, 5000)], [1000, 900, 1100], rho);
  assert.equal(at.get(1000).lo, 5000);
  assert.equal(at.get(1000).hi, 5000);
  // x=900（左侧 100）：参考时间 r* ∈ [4899,4901]
  assert.equal(at.get(900).lo, 4899);
  assert.equal(at.get(900).hi, 4901);
  // x=1100（右侧 100）：r* ∈ [5099,5101]
  assert.equal(at.get(1100).lo, 5099);
  assert.equal(at.get(1100).hi, 5101);
});

test('宽 RTT 矩形：矩形内区间按到远角的距离展开，折点上记录支撑校准', () => {
  const { at } = computeEnvelope([cal('c1', 1000, 1010, 5000, 5002)], [1000, 1005, 1010], 0);
  // rho=0：x<=m1 时 lo = r0-(m1-x)；x>=m0 时 hi = r1+(x-m0)
  assert.equal(at.get(1000).lo, 4990);
  assert.equal(at.get(1000).hi, 5002);
  assert.equal(at.get(1005).lo, 4995);
  assert.equal(at.get(1005).hi, 5007);
  assert.equal(at.get(1010).lo, 5000);
  assert.equal(at.get(1010).hi, 5012);
  assert.deepEqual(at.get(1005).loCals, ['c1']);
});

test('rho=0 下两条速率一致的校准：取交集收紧中间区间', () => {
  const cals = [
    cal('c1', 1000, 1000, 5000, 5000),
    cal('c2', 2000, 2000, 6000, 6000),
  ];
  const { at, conflicts } = computeEnvelope(cals, [1500], 0);
  assert.equal(conflicts.length, 0);
  const mid = at.get(1500);
  // 两条单位斜率直线在此处都给 5500
  assert.equal(mid.lo, 5500);
  assert.equal(mid.hi, 5500);
});

test('带 RTT 宽度的两条校准：交集同时受两条观测约束', () => {
  const cals = [
    cal('c1', 1000, 1000, 5000, 5010),
    cal('c2', 2000, 2000, 5990, 6000),
  ];
  const { at } = computeEnvelope(cals, [1500, 1000, 2000], 0);
  // 中点：c1 下界 5000+500=5500（胜过 c2 下界 5990-500=5490）
  //       c2 上界 6000-500=5500（胜过 c1 上界 5010+500=5510）
  assert.equal(at.get(1500).lo, 5500);
  assert.equal(at.get(1500).hi, 5500);
  assert.deepEqual(at.get(1500).loCals, ['c1']);
  assert.deepEqual(at.get(1500).hiCals, ['c2']);
  // 左锚点也受 c2 锥约束：6000-1000=5000 < 5010，使区间宽度被削去
  assert.deepEqual([at.get(1000).lo, at.get(1000).hi], [5000, 5000]);
});

test('两条零宽锚点在漂移容差内容纳单位速率；速率偏离超过容差才矛盾', () => {
  const sameRate = [
    cal('c1', 1000, 1000, 5000, 5000),
    cal('c2', 2000, 2000, 6000, 6000), // 速率恰为 1，落在 [1-rho,1+rho] 内
  ];
  assert.equal(computeEnvelope(sameRate, [1500], 0.001).conflicts.length, 0);

  const tooSlow = [
    cal('c1', 1000, 1000, 5000, 5000),
    cal('c2', 2000, 2000, 5000, 5000), // 速率 0
  ];
  assert.ok(computeEnvelope(tooSlow, [1000, 2000], 0.001).conflicts.length >= 1);

  // rho=0（恒速率假设）时只有精确单位速率相容
  assert.equal(computeEnvelope(tooSlow, [], 0).conflicts.length >= 1, true);
  assert.equal(computeEnvelope(sameRate, [], 0).conflicts.length, 0);
});

test('漂移容差内的变慢不算矛盾：速率恰在 1-rho 边界时锥相切', () => {
  // c1 下界锥在 m=2000 处 = 5000+(1-rho)*1000 = 5999；
  // 取 c2 上界 r1=5999（往返宽度 1）即相切，仍相容
  const cals = [
    cal('c1', 1000, 1000, 5000, 5001),
    cal('c2', 2000, 2000, 5998, 5999),
  ];
  const { conflicts } = computeEnvelope(cals, [1000, 2000], 0.001);
  assert.equal(conflicts.length, 0);
});

test('速率超出 1-rho 边界即矛盾', () => {
  // c2 上界 5998 < c1 下界锥 5999：空锥
  const cals = [
    cal('c1', 1000, 1000, 5000, 5001),
    cal('c2', 2000, 2000, 5996, 5997),
  ];
  const { conflicts } = computeEnvelope(cals, [1000, 2000], 0.001);
  assert.ok(conflicts.length >= 1);
});

test('无校准时事件完全无界（±Infinity），而不是被赋予零宽精确值', () => {
  const { at, conflicts } = computeEnvelope([], [123], 0.001);
  assert.equal(at.get(123).lo, Number.NEGATIVE_INFINITY);
  assert.equal(at.get(123).hi, Number.POSITIVE_INFINITY);
  assert.equal(conflicts.length, 0);
});

test('后来的校准收紧过去事件区间：重算给出更窄交集', () => {
  const first = computeEnvelope([cal('c1', 1000, 1010, 5000, 5100)], [1005], 0);
  // lo=5000-5=4995, hi=5100+5=5105
  assert.deepEqual([first.at.get(1005).lo, first.at.get(1005).hi], [4995, 5105]);
  const both = computeEnvelope(
    [cal('c1', 1000, 1010, 5000, 5100), cal('c2', 1005, 1005, 5030, 5060)],
    [1005],
    0
  );
  // 零宽锚点 c2 在 x=1005 给 [5030,5060]，与 c1 交集即此
  assert.deepEqual([both.at.get(1005).lo, both.at.get(1005).hi], [5030, 5060]);
});
