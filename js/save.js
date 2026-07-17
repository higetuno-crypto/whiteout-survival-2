// three非依存。localStorage互換オブジェクトを外から注入する(テスト可能に)。
import { RESOURCES, UPGRADES, AREAS, NPC_ROLES, sanitizeUnlocked } from './data.js';

export const SAVE_KEY = 'snow_survival2_save_slot1';
export const BACKUP_KEY = 'snow_survival2_save_backup';
export const CURRENT_VERSION = 2; // v2(FB3): wheat/farmStock追加、depotAuto/fishHutStock撤去、NPCロール拡張

// depot(倉庫)が種別保管する資源(FB2で個別回収可に)。wheat を追加(4種)。
const DEPOT_KINDS = ['log', 'rawFish', 'cookedFish', 'wheat'];

export function defaultSave() {
  return {
    version: CURRENT_VERSION,
    money: 0,
    resources: Object.fromEntries(Object.keys(RESOURCES).map(k => [k, 0])),
    upgrades: Object.fromEntries(Object.keys(UPGRADES).map(k => [k, 0])),
    unlockedAreas: ['camp'],
    buildProgress: {},   // {facilityId: 納品済み丸太数}
    npcs: [],            // [{role: NPC_ROLESのいずれか}]
    moneyTower: 0,       // 売店脇に積まれた未回収の金額
    farmStock: 0,          // 農場の内部ストック(自動成長。FB3。旧fishHutStockの後継)
    ranchFed: 0,           // 牧場の総給餌数(T15。3匹ごとにgoods1個の算出基準)
    ranchPending: 0,       // 牧場の未回収goods個数(T16。リロードで消えないように)
    depotStored: Object.fromEntries(DEPOT_KINDS.map(k => [k, 0])), // 倉庫の種別在庫(FB2。4種)
    padPaid: {},           // {areaId: {money, log}} 解錠パッドへの部分支払い(T16)
  };
}

function migrate(raw) {
  const d = defaultSave();
  // Object.assignは旧フィールド(depotAuto/fishHutStock等)も引き継いでしまうため、
  // defaultSaveに存在するキーだけを採用する(撤去フィールドの持ち越しを防ぐ)。
  const out = defaultSave();
  for (const k of Object.keys(d)) if (k in raw) out[k] = raw[k];
  out.version = CURRENT_VERSION;
  out.resources = Object.assign(defaultSave().resources, raw.resources ?? {});
  out.upgrades = Object.assign(defaultSave().upgrades, raw.upgrades ?? {});
  out.unlockedAreas = sanitizeUnlocked(raw.unlockedAreas ?? []);
  out.npcs = Array.isArray(raw.npcs) ? raw.npcs.filter(n => n && NPC_ROLES.includes(n.role)) : [];
  // 型サニタイズ: 手編集や部分破損で「起動はするが状態破損」になるのを防ぐ
  const num = (v, fb) => (Number.isFinite(v) ? v : fb);
  out.money = num(out.money, 0);
  out.moneyTower = num(out.moneyTower, 0);
  out.farmStock = num(out.farmStock, 0);
  out.ranchFed = num(out.ranchFed, 0);
  out.ranchPending = num(out.ranchPending, 0);
  // depotStored: DEPOT_KINDS(4種)の数値オブジェクトに矯正(未知キーは捨て、欠損はwheat含め0補完)
  const ds = (out.depotStored && typeof out.depotStored === 'object' && !Array.isArray(out.depotStored)) ? out.depotStored : {};
  out.depotStored = Object.fromEntries(DEPOT_KINDS.map(k => [k, num(ds[k], 0)]));
  for (const k of Object.keys(out.resources)) out.resources[k] = num(out.resources[k], 0);
  for (const k of Object.keys(out.upgrades)) out.upgrades[k] = num(out.upgrades[k], 0);
  if (!out.buildProgress || typeof out.buildProgress !== 'object' || Array.isArray(out.buildProgress)) out.buildProgress = {};
  // padPaid: 実在エリアのエントリだけ残し、money/log を数値に矯正(未知エリア/型破損は捨てる)
  const validAreas = new Set(AREAS.map(a => a.id));
  const pp = {};
  if (out.padPaid && typeof out.padPaid === 'object' && !Array.isArray(out.padPaid)) {
    for (const [id, v] of Object.entries(out.padPaid)) {
      if (!validAreas.has(id) || !v || typeof v !== 'object') continue;
      pp[id] = { money: num(v.money, 0), log: num(v.log, 0) };
    }
  }
  out.padPaid = pp;
  return out;
}

export function load(storage) {
  const txt = storage.getItem(SAVE_KEY);
  if (txt === null) return { save: defaultSave(), corrupted: false };
  try {
    return { save: migrate(JSON.parse(txt)), corrupted: false };
  } catch {
    storage.setItem(BACKUP_KEY, txt); // 消さずに退避
    return { save: defaultSave(), corrupted: true };
  }
}

export function persist(storage, save) {
  storage.setItem(SAVE_KEY, JSON.stringify(save));
}
