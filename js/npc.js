// 仲間NPC(雇用・役割・自動作業)。T9レビューの「システム=1モジュール1クラス」方針で main.js から分離。
// 役割は lumber(伐採→納品)と fisher(釣り→売却)の2種。makeCharacter(NPC_COLORS)を流用し、
// 各NPCは自分のStackCarrier(見た目)と単一資源の内部カウント this.count を持つ。
// 移動は faceAngle+animateWalk を流用した直進+水面クランプ。柵完成後はプレイヤーと同じ壁に
// 当たり(clampFenceWalls)、campの内外をまたぐ移動はゲート経由(gateWaypoint)で歩く(FB2 G4)。
import * as THREE from 'three';
import { makeCharacter, animateWalk, faceAngle, NPC_COLORS, StackCarrier } from './entities.js';
import { pushOutOfRect, LAKE_WATER } from './world.js';
import { ProximityAction } from './proximity.js';
import { AREAS } from './data.js';
import { clampFenceWalls, gateWaypoint } from './nav.js';
import { sfx } from './sfx.js';

const NPC_SPEED = 3.4;                          // プレイヤー(4.3〜)よりやや遅い固定値
const FACE_RATE = 10;                           // 向き補間レート(プレイヤーは11)
const WALK_RATE = 10;                           // 歩行位相の速度(脚振りの見た目)
const HUT = AREAS.find(a => a.id === 'hut');    // スポーン/idle基準(仲間の小屋エリア)
const CAMP = AREAS.find(a => a.id === 'camp');  // 柵の建つエリア(壁とゲートの基準)

// 単一資源のkind(StackCarrier.syncTo用)。lumber=log / fisher=rawFish。
// countsオブジェクトはNPCごとに1個を再利用する(毎フレームの生成を避ける。統合レビュー指摘)。
function kindOf(role) { return role === 'lumber' ? 'log' : 'rawFish'; }

export class Npc {
  constructor(role, scene, spawn) {
    this.role = role;
    const ch = makeCharacter(NPC_COLORS);
    this.ch = ch;
    this.root = ch.root;
    this.root.position.copy(spawn);
    scene.add(this.root);

    this.carrier = new StackCarrier(this.root); // 背中スタック(見た目)。真実は this.count
    this.count = 0;                             // 内部インベントリ(単一資源)
    this._counts = { [kindOf(role)]: 0 };       // syncTo用の再利用オブジェクト(毎フレーム生成しない)
    this.walkPhase = 0;
    this._moving = false;                       // このフレーム実際に移動したか(carrier揺れ/歩行アニメ用)
    this._swayT = 0;                            // idle体揺れの位相
    this.state = 'toWork';                      // ステートマシン
    this.reservedTree = null;                   // 予約中の木(lumber)
    this.recheck = 0;                           // idle中の前提条件再チェック用カウントダウン
    this._backPos = new THREE.Vector3();        // 釣りフライトの着地目標(毎フレームの生成回避)

    // 作業タイマー: lumber=伐採0.5s / fisher=釣り1.4s
    this.workTimer = new ProximityAction({ radius: 0, startDelay: 0, interval: role === 'lumber' ? 0.5 : 1.12, requireStill: false }); // 釣りはFB2で20%高速化
    // 売却タイマー(fisher): 売店で0.12s毎
    this.sellTimer = new ProximityAction({ radius: 0, startDelay: 0, interval: 0.12, requireStill: false });
    // 配達アダプタ(lumber): BuildManager.serveDeliverer が使う。納品は0.12s毎(プレイヤーは0.1s)。
    this.deliverer = {
      pos: this.root.position,
      deliver: new ProximityAction({ radius: 2.5, startDelay: 0, interval: 0.12, requireStill: false }),
      takeLog: () => { if (this.count > 0) { this.count -= 1; return 1; } return 0; },
      popLogVisual: () => this.carrier.popVisualOf('log'),
    };
  }

  // (tx,tz)へ移動。到達(本来の目標にdist<=arrive)なら true。歩いたフレームは animateWalk(moving) を回す。
  // 柵完成後(this._fenceOn)は、campの内外をまたぐならゲート経由地へ進路を差し替える。
  // 経由地は通過側に張り出している(nav.js GATE_PASS)ため、境界を越えた次のフレームには
  // gateWaypoint が null になり自然に本来の目標へ直進する(状態を持たない)。
  _moveToward(tx, tz, dt, arrive) {
    const p = this.root.position;
    if (Math.hypot(tx - p.x, tz - p.z) <= arrive) return true;
    let mx = tx, mz = tz;
    if (this._fenceOn) {
      const wp = gateWaypoint(p.x, p.z, tx, tz, CAMP);
      if (wp) { mx = wp.x; mz = wp.z; }
    }
    const dx = mx - p.x, dz = mz - p.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 1e-4) return false;                 // 経由地ちょうど(次フレームで再評価)
    const inv = 1 / dist;
    p.x += dx * inv * NPC_SPEED * dt;
    p.z += dz * inv * NPC_SPEED * dt;
    faceAngle(this.root, Math.atan2(dx, dz), dt, FACE_RATE);
    this.walkPhase += dt * WALK_RATE;
    pushOutOfRect(p, LAKE_WATER.cx, LAKE_WATER.cz, LAKE_WATER.hw + 0.3, LAKE_WATER.hd + 0.3); // 水面クランプ
    if (this._fenceOn) clampFenceWalls(p, CAMP);   // 柵の壁(ゲート開口部以外)に当たる
    animateWalk(this.ch, this.walkPhase, true, dt);
    this._moving = true;
    return false;
  }

  _stand(dt) { animateWalk(this.ch, this.walkPhase, false, dt); }       // 静止姿勢へ減衰
  _idleSway(dt) {                                                        // idle: ゆっくり体を揺らす
    animateWalk(this.ch, this.walkPhase, false, dt);
    this._swayT += dt * 2;
    this.ch.bodyGroup.rotation.x = 0.05 * Math.sin(this._swayT);
  }

  _reserveTree(world) {
    const t = world.nearestTree(this.root.position, 999, tr => !tr.reservedBy || tr.reservedBy === this);
    if (t) { t.reservedBy = this; this.reservedTree = t; } else this.reservedTree = null;
  }
  _releaseTree() {
    if (this.reservedTree && this.reservedTree.reservedBy === this) this.reservedTree.reservedBy = null;
    this.reservedTree = null;
  }

  update(dt, ctx) {
    this._moving = false;
    this._fenceOn = !!ctx.buildMgr.sites.get('fence_camp')?.completed;
    if (this.role === 'lumber') this._updateLumber(dt, ctx);
    else this._updateFisher(dt, ctx);
    this._counts[kindOf(this.role)] = this.count;
    this.carrier.syncTo(this._counts);
    this.carrier.update(dt, this.root, this.walkPhase, this._moving);
  }

  // ===== 伐採係: 木を予約→伐採(count++)→満杯で最寄り未完成サイトへ納品(count 0で戻る) =====
  _updateLumber(dt, ctx) {
    const { world, buildMgr, eco } = ctx;
    const cap = eco.npcCapacity();
    // FB2: 納品先は資材置き場(完成済みなら)を最優先。無ければ従来どおり未完成サイトへ直接。
    const depot = buildMgr.sites.get('depot');
    const hasDest = depot?.completed || !!buildMgr.nearestIncompleteSite(this.root.position, Infinity);
    if (!hasDest) this.state = 'idle';

    switch (this.state) {
      case 'idle': {
        this._releaseTree();
        const fire = buildMgr.sites.get('fire_camp');
        const hx = fire ? fire.x + 2 : HUT.cx, hz = fire ? fire.z : HUT.cz;
        if (this._moveToward(hx, hz, dt, 1.0)) this._idleSway(dt);
        this.recheck -= dt;
        if (this.recheck <= 0) {
          this.recheck = 5;
          if (depot?.completed || buildMgr.nearestIncompleteSite(this.root.position, Infinity)) this.state = this.count >= cap ? 'toDeliver' : 'toWork';
        }
        break;
      }
      case 'toWork': {
        if (this.count >= cap) { this.state = 'toDeliver'; break; }
        if (!this.reservedTree || this.reservedTree.reservedBy !== this) this._reserveTree(world);
        if (!this.reservedTree) { this.state = 'idle'; break; }
        const t = this.reservedTree;
        if (this._moveToward(t.x, t.z, dt, 1.6)) { this.state = 'work'; this.workTimer.reset(); }
        break;
      }
      case 'work': {
        const t = this.reservedTree;
        if (!t || t.reservedBy !== this) { this.state = 'toWork'; break; }
        this._stand(dt);
        const full = this.count >= cap;
        const ticks = this.workTimer.update(!full, false, dt); // 満杯なら止める(働いても増えない見た目を防ぐ)
        for (let i = 0; i < ticks; i++) { if (this.count >= cap) break; this.count += 1; t.pulse = 1; sfx.chop(t.x, t.z); }
        if (this.count >= cap) { this._releaseTree(); this.state = 'toDeliver'; }
        break;
      }
      case 'toDeliver': {
        if (this.count === 0) { this.state = 'toWork'; break; }
        // 資材置き場があればそこへ、無ければ従来の未完成サイトへ
        const dest = depot?.completed ? depot : buildMgr.nearestIncompleteSite(this.root.position, Infinity);
        if (!dest) { this.state = 'idle'; break; }
        const arrived = this._moveToward(dest.x, dest.z, dt, 2.2);
        if (!depot?.completed) buildMgr.serveDeliverer(dt, this.deliverer); // 直接納品モードのみ
        if (arrived) { this.state = 'deliver'; this.sellTimer.reset(); }
        break;
      }
      case 'deliver': {
        this._stand(dt);
        if (depot?.completed) {
          // 資材置き場へ0.12s毎に1本降ろす(sellTimerを流用: interval 0.12)
          const ticks = this.sellTimer.update(this.count > 0, false, dt);
          for (let i = 0; i < ticks; i++) {
            if (this.count <= 0) break;
            this.count -= 1;
            const from = this.carrier.popVisualOf('log');
            this._backPos.set(this.root.position.x, 1.6, this.root.position.z);
            depot.depositTo('log', 1, from ?? this._backPos);
          }
        } else {
          buildMgr.serveDeliverer(dt, this.deliverer);
          // 目の前のサイトが完成(範囲内に未完成が無い)→別の未完成サイトへ歩き直す
          if (this.count > 0 && !buildMgr.nearestIncompleteSite(this.root.position, this.deliverer.deliver.radius)) this.state = 'toDeliver';
        }
        if (this.count === 0) this.state = 'toWork';
        break;
      }
    }
  }

  // ===== 釣り係: 釣り場で釣り(count++)→満杯で資材置き場(無ければ売店)へ→count 0で戻る =====
  _updateFisher(dt, ctx) {
    const { world, buildMgr, shopSystem, eco } = ctx;
    const cap = eco.npcCapacity();
    const shop = buildMgr.sites.get('shop_camp');
    const depot = buildMgr.sites.get('depot');
    const bridge = buildMgr.sites.get('bridge_lake');
    // FB2: 納品先は資材置き場を最優先(生魚を置く→自動加工/自動販売が回す)。無ければ売店で直接売る。
    const dest = depot?.completed ? depot : (shop?.completed ? shop : null);
    // 前提条件: 湖解錠(fishSpotあり) & 橋完成 & 納品先あり。未達なら小屋の近くで待機。
    const ready = !!world.fishSpot && bridge?.completed && !!dest;
    if (!ready) this.state = 'idle';

    switch (this.state) {
      case 'idle': {
        if (this._moveToward(HUT.cx, HUT.cz + 4, dt, 1.0)) this._idleSway(dt);
        this.recheck -= dt;
        if (this.recheck <= 0) { this.recheck = 5; if (ready) this.state = this.count >= cap ? 'toShop' : 'toWork'; }
        break;
      }
      case 'toWork': {
        if (this.count >= cap) { this.state = 'toShop'; break; }
        const spot = world.fishSpot;
        if (this._moveToward(spot.x, spot.z, dt, 1.6)) { this.state = 'work'; this.workTimer.reset(); }
        break;
      }
      case 'work': {
        this._stand(dt);
        const full = this.count >= cap;
        const ticks = this.workTimer.update(!full, false, dt);
        for (let i = 0; i < ticks; i++) {
          if (this.count >= cap) break;
          this.count += 1;
          this._backPos.set(this.root.position.x, 1.8, this.root.position.z);
          world.spawnFishCatch(this._backPos); // 水面→背中フライト + 水しぶき(プレイヤーと同じ演出)
          sfx.pop(this.root.position.x, this.root.position.z); // 釣り上げポコッ(G5)
        }
        if (this.count >= cap) this.state = 'toShop';
        break;
      }
      case 'toShop': {
        if (this.count === 0) { this.state = 'toWork'; break; }
        if (this._moveToward(dest.x, dest.z, dt, 1.8)) { this.state = 'sell'; this.sellTimer.reset(); }
        break;
      }
      case 'sell': {
        this._stand(dt);
        const ticks = this.sellTimer.update(this.count > 0, false, dt);
        for (let i = 0; i < ticks; i++) {
          if (this.count <= 0) break;
          this.count -= 1;
          if (depot?.completed) {
            // 資材置き場へ生魚を降ろす(加工/販売は置き場の自動装置が担う)
            const from = this.carrier.popVisualOf('rawFish');
            this._backPos.set(this.root.position.x, 1.6, this.root.position.z);
            depot.depositTo('rawFish', 1, from ?? this._backPos);
          } else {
            shopSystem.deposit(eco.sellPrice('rawFish')); // 未回収金(マネータワー)へ積む
          }
        }
        if (this.count === 0) this.state = 'toWork';
        break;
      }
    }
  }
}

export class NpcManager {
  constructor(scene) {
    this.scene = scene;
    this.npcs = [];
  }

  // 役割を指定して1体スポーン(支払いは呼び出し側=雇用フロー/チートが担う。ここは生成のみ)。
  hire(role) {
    const idx = this.npcs.length;
    const spawn = new THREE.Vector3(HUT.cx - 3, 0, HUT.cz + 2 + idx * 1.6); // 小屋の前に少しずつずらして並べる
    const npc = new Npc(role, this.scene, spawn);
    this.npcs.push(npc);
    return npc;
  }

  update(dt, ctx) { for (const n of this.npcs) n.update(dt, ctx); }

  serialize() { return this.npcs.map(n => ({ role: n.role })); }

  // セーブ復元(役割どおり再雇用状態でスポーン、支払いなし)。roleはsave.js側で検証済みだが二重に弾く。
  restore(saved) {
    for (const s of saved ?? []) if (s && (s.role === 'lumber' || s.role === 'fisher')) this.hire(s.role);
  }

  count() { return this.npcs.length; }
  list() { return this.npcs; }
}
