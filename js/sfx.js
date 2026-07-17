// WebAudioプロシージャル効果音(FB2 G5)。音声ファイルなし=全部コード生成。
// three非依存・DOM依存(AudioContext)。node環境でもimportは安全(ctxは遅延生成)。
//
// 構成:
//   synth系  — (ctx, dest, when) を受け取る音生成の純関数。OfflineAudioContextでも動く(検証用)
//   Sfx      — シングルトン。初回ユーザー操作でAudioContextを生成+resume(iOS Safari対策)。
//              種類ごとの間引き(最短間隔)と距離減衰(プレイヤー=リスナー基準)でうるささを防ぐ
//
// 音量方針: master 0.5、各音のpeakは0.3〜0.75。NPCが17人working状態でも刺さらないよう
// 高頻度音(pop/chop)は間引き50msと30mフェードで自然に抑える。

/* ================= 音生成プリミティブ ================= */

// アタック+指数減衰のゲインエンベロープを作って dest に接続する
function env(ctx, dest, t, peak, decay, attack = 0.002) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.001, t + attack + decay);
  g.connect(dest);
  return g;
}

// 単音。freq は数値、または [[相対時刻, Hz], ...] のステップ列(コインの2音など)
function tone(ctx, dest, t, { type = 'triangle', freq, peak, decay, attack = 0.002 }) {
  const o = ctx.createOscillator();
  o.type = type;
  if (Array.isArray(freq)) {
    for (const [dt, f] of freq) o.frequency.setValueAtTime(f, t + dt);
  } else {
    o.frequency.setValueAtTime(freq, t);
  }
  const g = env(ctx, dest, t, peak, decay, attack);
  o.connect(g);
  o.start(t);
  o.stop(t + attack + decay + 0.05);
}

// ホワイトノイズバッファ(ctxごとにキャッシュ。sampleRateが変わったら作り直し)
let _noiseBuf = null;
function getNoise(ctx) {
  if (!_noiseBuf || _noiseBuf.sampleRate !== ctx.sampleRate) {
    _noiseBuf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.06), ctx.sampleRate);
    const d = _noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  return _noiseBuf;
}

// コイン「チャリーン」: B5→E6 の2音(定番)。pitchMul で連続回収の階段上昇
export function synthCoin(ctx, dest, t, pitchMul = 1) {
  tone(ctx, dest, t, { type: 'triangle', freq: [[0, 988 * pitchMul], [0.055, 1319 * pitchMul]], peak: 0.5, decay: 0.3 });
}

// 納品/釣り上げ「ポコッ」: sine の下降スイープ
export function synthPop(ctx, dest, t, vol = 1) {
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(520, t);
  o.frequency.exponentialRampToValueAtTime(150, t + 0.09);
  const g = env(ctx, dest, t, 0.75 * vol, 0.11);
  o.connect(g);
  o.start(t);
  o.stop(t + 0.17);
}

// 伐採「コッ」: 低いthud(下降triangle) + 高域ノイズの立ち上がり
export function synthChop(ctx, dest, t, vol = 1) {
  const o = ctx.createOscillator();
  o.type = 'triangle';
  o.frequency.setValueAtTime(160, t);
  o.frequency.exponentialRampToValueAtTime(70, t + 0.06);
  const g = env(ctx, dest, t, 0.7 * vol, 0.07);
  o.connect(g);
  o.start(t);
  o.stop(t + 0.14);
  const src = ctx.createBufferSource();
  src.buffer = getNoise(ctx);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 2400;
  bp.Q.value = 0.8;
  const ng = env(ctx, dest, t, 0.5 * vol, 0.045);
  src.connect(bp);
  bp.connect(ng);
  src.start(t);
}

// エリア解放ファンファーレ: C5-E5-G5-C6 のアルペジオ + E6 を重ねてキラッと締める
export function synthFanfare(ctx, dest, t) {
  const notes = [523.25, 659.25, 783.99, 1046.5];
  notes.forEach((f, i) => {
    tone(ctx, dest, t + i * 0.09, { type: 'triangle', freq: f, peak: 0.4, decay: i === 3 ? 0.7 : 0.28 });
  });
  tone(ctx, dest, t + 0.36, { type: 'triangle', freq: 1318.5, peak: 0.3, decay: 0.7 });
}

// 建設完成「タ・ダーン」: G4→C5 の2音
export function synthComplete(ctx, dest, t) {
  tone(ctx, dest, t, { type: 'triangle', freq: 392, peak: 0.4, decay: 0.12 });
  tone(ctx, dest, t + 0.1, { type: 'triangle', freq: 523.25, peak: 0.45, decay: 0.5 });
}

/* ================= Sfx シングルトン ================= */

const HEAR_NEAR = 9;   // この距離まではフル音量
const HEAR_FAR = 30;   // ここで無音(それ以遠はノードも作らない)

export class Sfx {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.enabled = true;
    this._lx = 0;
    this._lz = 0;
    this._lastAt = {};       // 種類ごとの最終再生時刻(間引き用)
    this._coinStep = 0;      // 連続回収のピッチ階段(半音単位)
    this._coinLastT = 0;
    // iOS Safari: AudioContextはユーザージェスチャ内で生成/resumeしないと無音。
    // 最初の操作(ジョイスティック=pointerdown / キー)で解錠する。リスナーは残す
    // (バックグラウンド復帰でsuspendedに戻ることがあるため、毎回resumeを試みる)。
    if (typeof document !== 'undefined') {
      const unlock = () => this._ensureCtx();
      document.addEventListener('pointerdown', unlock, { passive: true });
      document.addEventListener('keydown', unlock);
    }
  }

  _ensureCtx() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!this.ctx) {
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  // リスナー(プレイヤー)位置。毎フレームstep()冒頭で更新される
  setListener(x, z) { this._lx = x; this._lz = z; }

  // 再生ゲート: 種類ごとの最短間隔 + (x,z指定時)距離減衰。鳴らせるなら音量係数、ダメならnull
  _gate(kind, minGap, x, z) {
    if (!this.enabled || !this.ctx || this.ctx.state !== 'running') return null;
    const now = this.ctx.currentTime;
    if (now - (this._lastAt[kind] ?? -9) < minGap) return null;
    let vol = 1;
    if (x !== undefined) {
      const d = Math.hypot(x - this._lx, z - this._lz);
      if (d >= HEAR_FAR) return null;
      if (d > HEAR_NEAR) vol = 1 - (d - HEAR_NEAR) / (HEAR_FAR - HEAR_NEAR);
    }
    this._lastAt[kind] = now;
    return vol;
  }

  // コイン回収(札束がプレイヤーに届いた瞬間)。0.3秒以内の連続でピッチが半音ずつ上がる
  coin() {
    const vol = this._gate('coin', 0.035);
    if (vol === null) return;
    const now = this.ctx.currentTime;
    this._coinStep = now - this._coinLastT < 0.3 ? Math.min(this._coinStep + 1, 14) : 0;
    this._coinLastT = now;
    synthCoin(this.ctx, this.master, now, Math.pow(2, this._coinStep / 12));
  }

  pop(x, z) {
    const vol = this._gate('pop', 0.05, x, z);
    if (vol !== null) synthPop(this.ctx, this.master, this.ctx.currentTime, vol);
  }

  chop(x, z) {
    const vol = this._gate('chop', 0.05, x, z);
    if (vol !== null) synthChop(this.ctx, this.master, this.ctx.currentTime, vol);
  }

  fanfare() {
    if (this._gate('fanfare', 0.5) !== null) synthFanfare(this.ctx, this.master, this.ctx.currentTime);
  }

  complete(x, z) {
    const vol = this._gate('complete', 0.2, x, z);
    if (vol !== null) synthComplete(this.ctx, this.master, this.ctx.currentTime);
  }
}

export const sfx = new Sfx();
