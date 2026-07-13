// three非依存。「対象の半径内に(条件を満たして)いる間、開始遅延後、一定間隔で
// tickを発火する」という近接自動処理パターンの共通ステートマシン。
// 伐採(T7)・納品(T8)・調理/採取(T12/T13/T15)で使い回す。
//
// 半径内かどうか(inRange)の判定は呼び出し側が行い、真偽値で渡す。
// radius は「呼び出し側が距離判定に使う値」を保持するだけの付随データ。
export class ProximityAction {
  constructor({ radius, startDelay = 0, interval, requireStill = false }) {
    this.radius = radius;
    this.startDelay = startDelay;
    this.interval = interval;
    this.requireStill = requireStill;
    this.timer = 0;   // 条件を満たして連続で範囲内にいる累計時間
    this.accum = 0;   // startDelay 超過後の tick 用アキュムレータ
  }

  // 毎フレーム呼ぶ。inRange(bool)・still(bool)・dt を渡し、発火すべき tick 回数(0..n)を返す。
  // inRange && (requireStill ? still : true) の間だけ timer を進め、途切れたら reset。
  update(inRange, still, dt) {
    const ok = inRange && (this.requireStill ? still : true);
    if (!ok) { this.reset(); return 0; }
    this.timer += dt;
    if (this.timer <= this.startDelay) return 0; // 開始遅延中は蓄積しない
    this.accum += dt;
    let ticks = 0;
    while (this.accum >= this.interval) { this.accum -= this.interval; ticks++; }
    return ticks;
  }

  // 開始遅延を超えて作動中か(演出のON/OFF判定に使う)
  get active() { return this.timer > this.startDelay; }

  reset() { this.timer = 0; this.accum = 0; }
}
