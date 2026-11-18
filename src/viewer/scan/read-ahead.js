/** 読む向きと速さから、次に調べる元ページを決める。大きなジャンプは読書の速さに数えない。 */
export class ReadAhead {
  constructor() {
    this.reset();
  }

  reset(page = 0, now = performance.now()) {
    this.page = page;
    this.at = now;
    this.direction = 1;
    this.speed = 0;
    this.analysisMs = 500;
  }

  /** ページ番号の直接指定では向きを決めず、移動後の現在地だけを更新する。 */
  move(page, { jump = false, now = performance.now() } = {}) {
    const distance = page - this.page;
    if (!distance) {
      return;
    }
    const elapsed = Math.max(0.1, (now - this.at) / 1000);
    if (jump || Math.abs(distance) > 3) {
      this.speed = 0;
    } else {
      const direction = Math.sign(distance);
      this.speed = (direction === this.direction ? this.speed * 0.4 : 0) + Math.min(12, Math.abs(distance) / elapsed) * 0.6;
      this.direction = direction;
    }
    this.page = page;
    this.at = now;
  }

  measured(ms) {
    this.analysisMs = this.analysisMs * 0.75 + Math.max(1, ms) * 0.25;
  }

  get ahead() {
    return Math.max(6, Math.min(36, Math.ceil(this.speed * (5 + this.analysisMs / 250))));
  }

  /** 現在・すぐ前後・読む先・反対側の順。遠くのページも漏らさず一度ずつ返す。 */
  order(count, current = this.page, ahead = this.ahead, behind = 3) {
    if (count < 1) {
      return [];
    }
    const page = Math.min(count - 1, Math.max(0, current));
    const result = [];
    const seen = new Set();
    const add = n => {
      if (n >= 0 && n < count && !seen.has(n)) {
        seen.add(n);
        result.push(n);
      }
    };
    add(page);
    add(page + this.direction);
    add(page - this.direction);
    for (let d = 2; d <= ahead; d++) {
      add(page + d * this.direction);
    }
    for (let d = 2; d <= behind; d++) {
      add(page - d * this.direction);
    }
    for (let d = 1; result.length < count; d++) {
      add(page + (ahead + d) * this.direction);
      add(page - (behind + d) * this.direction);
    }
    return result;
  }
}
