import { DatabaseSync } from 'node:sqlite';
export const metrics = {
  temperature: { label: '温度', unit: '°C', min: -50, max: 150 },
  humidity: { label: '湿度', unit: '%RH', min: 0, max: 100 },
  gas_resistance: { label: '燃气传感器电阻', unit: 'kΩ', min: 0, max: 1000000 },
};
const defaults = {
  temperature: { enabled: true, low: 0, high: 35, hysteresis: 0.5 },
  humidity: { enabled: true, low: 20, high: 50, hysteresis: 2 },
  gas_resistance: { enabled: false, low: 0, high: 100, hysteresis: 1 },
};
export function validateThresholds(input) {
  if (!input || Object.keys(input).length !== 3)
    throw new Error('请设置全部三项阈值');
  for (const [key, metric] of Object.entries(metrics)) {
    const rule = input[key];
    if (
      !rule ||
      typeof rule.enabled !== 'boolean' ||
      !['low', 'high', 'hysteresis'].every(
        (k) => typeof rule[k] === 'number' && Number.isFinite(rule[k]),
      ) ||
      rule.low < metric.min ||
      rule.high > metric.max ||
      rule.low >= rule.high ||
      rule.hysteresis < 0 ||
      rule.hysteresis * 2 >= rule.high - rule.low
    ) {
      throw new Error(
        `${metric.label}阈值无效：下限须小于上限，恢复缓冲须小于区间的一半`,
      );
    }
  }
  return input;
}
export class Store {
  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS readings(id INTEGER PRIMARY KEY, stamp INTEGER NOT NULL UNIQUE, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS states(metric TEXT PRIMARY KEY, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS alerts(id INTEGER PRIMARY KEY, stamp INTEGER NOT NULL, metric TEXT NOT NULL,
        state TEXT NOT NULL, message TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0, next_try INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS idx_alerts_pending ON alerts(next_try) WHERE sent=0;`);
    this.db
      .prepare('INSERT OR IGNORE INTO settings VALUES(1, ?)')
      .run(JSON.stringify(defaults));
  }
  thresholds() {
    return JSON.parse(
      this.db.prepare('SELECT value FROM settings WHERE id=1').get().value,
    );
  }
  saveThresholds(input, staleSeconds, now = Date.now()) {
    validateThresholds(input);
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare('UPDATE settings SET value=? WHERE id=1')
        .run(JSON.stringify(input));
      const latest = this.latest();
      if (latest && now - latest.stamp <= staleSeconds * 1000)
        this.evaluate(latest.data, now);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  latest() {
    const row = this.db
      .prepare('SELECT stamp, data FROM readings ORDER BY stamp DESC LIMIT 1')
      .get();
    return row ? { stamp: row.stamp, data: JSON.parse(row.data) } : null;
  }
  ingest(data, stamp, staleSeconds, now = Date.now()) {
    if (!Number.isFinite(stamp) || stamp > now + 60000)
      throw new Error('云端数据时间无效');
    for (const [key, m] of Object.entries(metrics)) {
      if (
        typeof data[key] !== 'number' ||
        !Number.isFinite(data[key]) ||
        data[key] < m.min ||
        data[key] > m.max
      )
        throw new Error(`云端 ${key} 缺失或无效`);
    }
    const previous = this.latest();
    if (previous && stamp <= previous.stamp) return false;
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare('INSERT INTO readings(stamp,data) VALUES(?,?)')
        .run(stamp, JSON.stringify(data));
      if (now - stamp <= staleSeconds * 1000) this.evaluate(data, now);
      this.db
        .prepare('DELETE FROM readings WHERE stamp < ?')
        .run(now - 30 * 86400000);
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  evaluate(data, now) {
    for (const [key, rule] of Object.entries(this.thresholds())) {
      const old =
        this.db.prepare('SELECT state FROM states WHERE metric=?').get(key)
          ?.state ?? 'normal';
      const value = data[key];
      let state = 'normal';
      if (rule.enabled) {
        if (value < rule.low) state = 'low';
        else if (value > rule.high) state = 'high';
        else if (old === 'low' && value < rule.low + rule.hysteresis)
          state = 'low';
        else if (old === 'high' && value > rule.high - rule.hysteresis)
          state = 'high';
      }
      this.db
        .prepare('INSERT OR REPLACE INTO states VALUES(?,?)')
        .run(key, state);
      if (state !== old) {
        const m = metrics[key];
        const action = !rule.enabled
          ? '监测已关闭'
          : state === 'normal'
            ? '恢复正常'
            : state === 'high'
              ? '超过上限'
              : '低于下限';
        const message = `${m.label}${action}：${value} ${m.unit}，阈值 ${rule.low}～${rule.high} ${m.unit}`;
        this.db
          .prepare(
            'INSERT INTO alerts(stamp,metric,state,message) VALUES(?,?,?,?)',
          )
          .run(now, key, state, message);
      }
    }
  }
  snapshot(staleSeconds) {
    const latest = this.latest();
    return {
      latest,
      stale: !latest || Date.now() - latest.stamp > staleSeconds * 1000,
      thresholds: this.thresholds(),
      states: Object.fromEntries(
        this.db
          .prepare('SELECT * FROM states')
          .all()
          .map((r) => [r.metric, r.state]),
      ),
      history: this.db
        .prepare(
          'SELECT stamp,data FROM readings ORDER BY stamp DESC LIMIT 180',
        )
        .all()
        .reverse()
        .map((r) => ({ stamp: r.stamp, ...JSON.parse(r.data) })),
      alerts: this.db
        .prepare('SELECT * FROM alerts ORDER BY id DESC LIMIT 40')
        .all(),
      pending: this.db
        .prepare('SELECT COUNT(*) AS n FROM alerts WHERE sent=0')
        .get().n,
    };
  }
  pending(now = Date.now()) {
    // Preserve notification order: a recovery must not overtake its failed alert.
    const oldest = this.db.prepare('SELECT * FROM alerts WHERE sent=0 ORDER BY id LIMIT 1').get();
    return oldest && oldest.next_try <= now ? oldest : undefined;
  }
  delivered(id) {
    this.db.prepare('UPDATE alerts SET sent=1 WHERE id=?').run(id);
  }
  failed(alert, now = Date.now()) {
    this.db
      .prepare('UPDATE alerts SET attempts=attempts+1,next_try=? WHERE id=?')
      .run(
        now + Math.min(300000, 5000 * 2 ** Math.min(alert.attempts, 6)),
        alert.id,
      );
  }
  close() {
    this.db.close();
  }
}
