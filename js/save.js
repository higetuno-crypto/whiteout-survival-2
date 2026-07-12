// three非依存。localStorage互換オブジェクトを外から注入する(テスト可能に)。
import { RESOURCES, UPGRADES, sanitizeUnlocked } from './data.js';

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
  };
}

function migrate(raw) {
  const d = defaultSave();
  const out = Object.assign(d, raw);
  out.version = CURRENT_VERSION;
  out.resources = Object.assign(defaultSave().resources, raw.resources ?? {});
  out.upgrades = Object.assign(defaultSave().upgrades, raw.upgrades ?? {});
  out.unlockedAreas = sanitizeUnlocked(raw.unlockedAreas ?? []);
  out.buildProgress = raw.buildProgress ?? {};
  out.npcs = Array.isArray(raw.npcs) ? raw.npcs.filter(n => n && (n.role === 'lumber' || n.role === 'fisher')) : [];
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
