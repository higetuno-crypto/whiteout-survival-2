// three非依存。エリア・施設・資源・価格・強化の全定義と純粋判定ロジック。
// ★新エリアはAREASに1エントリ足すだけで増やせる(スペック: データ駆動+前方互換)

export const RESOURCES = {
  log:        { name: '丸太',   emoji: '🪵' },
  rawFish:    { name: '生魚',   emoji: '🐟' },
  cookedFish: { name: '焼き魚', emoji: '🍖' },
  plank:      { name: '板材',   emoji: '🪚' },
  goods:      { name: '特産品', emoji: '🎁' },
};

export const PRICES = { log: 3, rawFish: 5, cookedFish: 12, plank: 15, goods: 40 };
export const MARKET_MULT = 1.5; // 大市場解錠後の売値倍率

// cx/cz(中心)・hw/hd(半幅/半奥行)はワールド座標(m)。campを原点に隣接配置
export const AREAS = [
  { id: 'camp',    name: 'スタートキャンプ', cost: {},                      cx: 0,   cz: 0,   hw: 13, hd: 10 },
  { id: 'lake',    name: '湖',               cost: { money: 65 },           cx: 0,   cz: -26, hw: 13, hd: 10 },
  { id: 'forest',  name: '森',               cost: { money: 250, log: 20 }, cx: -30, cz: 0,   hw: 13, hd: 10 },
  { id: 'hut',     name: '仲間の小屋',       cost: { money: 400 },          cx: 30,  cz: 0,   hw: 13, hd: 10 },
  { id: 'fishery', name: '漁場',             cost: { money: 700, log: 40 }, cx: 30,  cz: -26, hw: 13, hd: 10 },
  { id: 'ranch',   name: '牧場',             cost: { money: 1200 },         cx: -30, cz: -26, hw: 13, hd: 10 },
  { id: 'market',  name: '大市場',           cost: { money: 2000, log: 80 },cx: 0,   cz: 26,  hw: 13, hd: 10 },
];

// kind: fence(柵) / bridge(橋) / shop(売店) / campfire(焚き火) / sawmill(製材所)
//       npcHut(仲間の小屋) / fishHut(釣り小屋) / ranchPen(牧場の柵) / market(大市場)
// lx/lz はエリア中心からのローカル座標
export const FACILITIES = [
  { id: 'fence_camp',   areaId: 'camp',    kind: 'fence',    costLogs: 20, lx: 0,    lz: 0 },
  { id: 'shop_camp',    areaId: 'camp',    kind: 'shop',     costLogs: 10, lx: 6,    lz: 4 },
  { id: 'fire_camp',    areaId: 'camp',    kind: 'campfire', costLogs: 8,  lx: -6,   lz: 4 },
  { id: 'bridge_lake',  areaId: 'lake',    kind: 'bridge',   costLogs: 15, lx: 0,    lz: 12 },
  { id: 'sawmill',      areaId: 'forest',  kind: 'sawmill',  costLogs: 25, lx: 0,    lz: 0 },
  { id: 'npchut',       areaId: 'hut',     kind: 'npcHut',   costLogs: 20, lx: 0,    lz: 0 },
  { id: 'fishhut',      areaId: 'fishery', kind: 'fishHut',  costLogs: 30, lx: 0,    lz: 0 },
  { id: 'ranchpen',     areaId: 'ranch',   kind: 'ranchPen', costLogs: 35, lx: 0,    lz: 0 },
  { id: 'bigmarket',    areaId: 'market',  kind: 'market',   costLogs: 40, lx: 0,    lz: 0 },
];

export const UPGRADES = {
  capacity: { name: '所持容量',   base: 10, perLv: 5,  baseCost: 20,  emoji: '🎒' },
  speed:    { name: '移動速度',   base: 4.3, perLv: 0.5, baseCost: 25, emoji: '👟' },
  npcCap:   { name: '仲間の容量', base: 6,  perLv: 3,  baseCost: 40,  emoji: '📦' },
};
export function upgradeCost(key, lv) { return Math.round(UPGRADES[key].baseCost * Math.pow(1.7, lv)); }
export function upgradeValue(key, lv) { return UPGRADES[key].base + UPGRADES[key].perLv * lv; }

// オーナーFB(2周目): 仲間は「性能そのまま・数で稼ぐ」方向へ。安く始まり最大17人。
export const NPC_HIRE_COSTS = [50, 75, 100, 150, 200, 300, 400, 500, 650, 800, 1000, 1500, 2000, 2500, 3000, 4000, 5000];
export const VISUAL_STACK_CAP = 15; // 背中スタックの表示上限(内部カウントは無制限)

export function canUnlockArea(areaId, unlockedIds, wallet) {
  const area = AREAS.find(a => a.id === areaId);
  if (!area || unlockedIds.includes(areaId)) return { ok: false, missing: {} };
  const missing = {};
  for (const [k, v] of Object.entries(area.cost)) {
    const have = wallet[k] ?? 0;
    if (have < v) missing[k] = v - have;
  }
  return { ok: Object.keys(missing).length === 0, missing };
}

export function sanitizeUnlocked(ids) {
  const valid = new Set(AREAS.map(a => a.id));
  const out = ['camp'];
  for (const id of ids ?? []) if (valid.has(id) && !out.includes(id)) out.push(id);
  return out;
}

// エリアは格子配置(x方向±30、z方向±26)。辺を接する2エリアが隣接
export function areAreasAdjacent(a, b) {
  const dx = Math.abs(a.cx - b.cx), dz = Math.abs(a.cz - b.cz);
  return (dx === 30 && dz === 0) || (dx === 0 && dz === 26);
}
