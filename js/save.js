// three非依存。localStorage互換オブジェクトを外から注入する(テスト可能に)。
import { RESOURCES, UPGRADES, AREAS, sanitizeUnlocked } from './data.js';

export const SAVE_KEY = 'snow_survival2_save_slot1';
export const BACKUP_KEY = 'snow_survival2_save_backup';
export const CURRENT_VERSION = 1;

export function defaultSave() {
  return {
    version: CURRENT_VERSION,
    money: 0,
    resources: Object.fromEntries(Object.keys(RESOURCES).map(k => [k, 0])),
    upgrades: Object.fromEntries(Object.keys(UPGRADES).map(k => [k, 0])),
    unlockedAreas: ['camp'],
    buildProgress: {},   // {facilityId: 納品済み丸太数}
    npcs: [],            // [{role:'lumber'|'fisher'}]
    moneyTower: 0,       // 売店脇に積まれた未回収の金額
    fishHutStock: 0,      // 釣り小屋の内部ストック(0..10。T15)
    ranchFed: 0,           // 牧場の総給餌数(T15。3匹ごとにgoods1個の算出基準)
    padPaid: {},           // {areaId: {money, log}} 解錠パッドへの部分支払い(T16)
  };
}

function migrate(raw) {
  const d = defaultSave();
  const out = Object.assign(d, raw);
  out.version = CURRENT_VERSION;
  out.resources = Object.assign(defaultSave().resources, raw.resources ?? {});
  out.upgrades = Object.assign(defaultSave().upgrades, raw.upgrades ?? {});
  out.unlockedAreas = sanitizeUnlocked(raw.unlockedAreas ?? []);
  out.npcs = Array.isArray(raw.npcs) ? raw.npcs.filter(n => n && (n.role === 'lumber' || n.role === 'fisher')) : [];
  // 型サニタイズ: 手編集や部分破損で「起動はするが状態破損」になるのを防ぐ
  const num = (v, fb) => (Number.isFinite(v) ? v : fb);
  out.money = num(out.money, 0);
  out.moneyTower = num(out.moneyTower, 0);
  out.fishHutStock = num(out.fishHutStock, 0);
  out.ranchFed = num(out.ranchFed, 0);
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
