import { test } from 'node:test';
import assert from 'node:assert/strict';
import { insideArea, clampFenceWalls, gateWaypoint, FENCE_TH, GATE_OPEN, GATE_PASS } from '../js/nav.js';

// campと同形のテスト用エリア(実データに依存しない)
const AREA = { cx: 0, cz: 0, hw: 13, hd: 10 };

test('insideArea: 内側true・外側false・境界上はfalse', () => {
  assert.equal(insideArea(0, 0, AREA), true);
  assert.equal(insideArea(12.9, -9.9, AREA), true);
  assert.equal(insideArea(20, 0, AREA), false);
  assert.equal(insideArea(0, -26, AREA), false);
  assert.equal(insideArea(13, 0, AREA), false);   // 壁面ちょうどは外扱い
  assert.equal(insideArea(0, 10, AREA), false);
});

test('clampFenceWalls: 東壁(ゲート外)は内外それぞれの面へ押し出す', () => {
  const out = { x: 13.2, z: 5 };                  // 外側から壁に食い込み
  clampFenceWalls(out, AREA);
  assert.equal(out.x, 13 + FENCE_TH);
  assert.equal(out.z, 5);
  const inn = { x: 12.8, z: 5 };                  // 内側から壁に食い込み
  clampFenceWalls(inn, AREA);
  assert.equal(inn.x, 13 - FENCE_TH);
});

test('clampFenceWalls: ゲート開口部(辺中点±GATE_OPEN)は素通り', () => {
  const p = { x: 13.2, z: GATE_OPEN - 0.1 };
  clampFenceWalls(p, AREA);
  assert.equal(p.x, 13.2);                        // 押されない
  const q = { x: 0.5, z: -10.3 };                 // 北ゲートの開口部
  clampFenceWalls(q, AREA);
  assert.equal(q.z, -10.3);
});

test('clampFenceWalls: 壁から離れていれば不変・角の外側も不変', () => {
  const far = { x: 14, z: 5 };
  clampFenceWalls(far, AREA);
  assert.deepEqual(far, { x: 14, z: 5 });
  const corner = { x: 14, z: 10.2 };              // 南北壁のx範囲(hw+TH)の外
  clampFenceWalls(corner, AREA);
  assert.deepEqual(corner, { x: 14, z: 10.2 });
});

test('clampFenceWalls: 南北壁(ゲート外)も押し出す', () => {
  const p = { x: 5, z: 10.3 };
  clampFenceWalls(p, AREA);
  assert.equal(p.z, 10 + FENCE_TH);
  const q = { x: -5, z: -9.8 };
  clampFenceWalls(q, AREA);
  assert.equal(q.z, -10 + FENCE_TH);
});

test('gateWaypoint: 内→内・外→外はnull(直進でよい)', () => {
  assert.equal(gateWaypoint(0, 5, 3, -3, AREA), null);
  assert.equal(gateWaypoint(30, 0, 30, -26, AREA), null);
});

test('gateWaypoint: 内→外は最寄りゲートの通過側(外)の点を返す', () => {
  const wp = gateWaypoint(0, 5, 0, 20, AREA);     // 南へ抜ける
  assert.deepEqual(wp, { x: 0, z: 10 + GATE_PASS });
  assert.equal(insideArea(wp.x, wp.z, AREA), false); // 通過側=外にある
  const east = gateWaypoint(10, 0, 30, 0, AREA);  // 東へ抜ける
  assert.deepEqual(east, { x: 13 + GATE_PASS, z: 0 });
});

test('gateWaypoint: 外→内は最寄りゲートの通過側(内)の点を返す', () => {
  const wp = gateWaypoint(0, -20, 0, 5, AREA);    // 北から入る
  assert.deepEqual(wp, { x: 0, z: -10 + GATE_PASS });
  assert.equal(insideArea(wp.x, wp.z, AREA), true);
  const west = gateWaypoint(-30, 0, 0, 0, AREA);  // 西から入る
  assert.deepEqual(west, { x: -13 + GATE_PASS, z: 0 });
});

test('gateWaypoint: 経路合計が最短のゲートを選ぶ', () => {
  // (10,8)から東の(30,0)へ: 東ゲート経由(≈25.5)が南ゲート経由(≈41.8)より短い
  const wp = gateWaypoint(10, 8, 30, 0, AREA);
  assert.deepEqual(wp, { x: 13 + GATE_PASS, z: 0 });
});
