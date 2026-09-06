import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.mjs';
import { Cloud, notify, parseTime } from './cloud.mjs';
const sample = (t) => ({ temperature: t, humidity: 35, gas_resistance: 10 });
test('edge transitions, hysteresis, duplicate and out-of-order readings', () => {
  const s = new Store(),
    now = Date.now();
  s.ingest(sample(36), now, 60, now);
  s.ingest(sample(37), now + 1, 60, now + 1);
  assert.equal(s.snapshot(60).alerts.length, 1);
  assert.equal(s.ingest(sample(20), now, 60, now + 2), false);
  s.ingest(sample(34.8), now + 3, 60, now + 3);
  assert.equal(s.snapshot(60).alerts.length, 1);
  s.ingest(sample(34.5), now + 4, 60, now + 4);
  assert.equal(s.snapshot(60).alerts[0].state, 'normal');
  s.ingest(sample(-1), now + 5, 60, now + 5);
  assert.equal(s.snapshot(60).alerts[0].state, 'low');
  s.close();
});
test('stale readings cannot alarm; invalid threshold edits are atomic', () => {
  const s = new Store(),
    now = Date.now();
  s.ingest(sample(80), now - 120000, 60, now);
  assert.equal(s.snapshot(60).alerts.length, 0);
  const rules = s.thresholds();
  rules.temperature.high = 10;
  s.saveThresholds(rules, 60, now);
  assert.equal(s.snapshot(60).alerts.length, 0);
  const bad = s.thresholds();
  bad.humidity.low = 80;
  assert.throws(() => s.saveThresholds(bad, 60, now));
  assert.equal(s.thresholds().humidity.low, 20);
  assert.throws(() => s.ingest({ ...sample(20), humidity: NaN }, now, 60, now));
  s.close();
});
test('thresholds, alarm state and notification retries survive restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'environment-test-')),
    path = join(dir, 'db');
  try {
    let s = new Store(path),
      now = Date.now();
    s.ingest(sample(40), now, 60, now);
    const first = s.pending();
    s.failed(first, now);
    assert.equal(s.pending(now), undefined);
    s.close();
    s = new Store(path);
    assert.equal(s.pending(now + 6000).attempts, 1);
    s.ingest(sample(41), now + 1, 60, now + 1);
    assert.equal(s.snapshot(60).alerts.length, 1);
    const rules = s.thresholds();
    rules.temperature.high = 45;
    s.saveThresholds(rules, 60, now + 2);
    assert.equal(s.snapshot(60).alerts.length, 2);
    s.delivered(first.id);
    s.close();
    s = new Store(path);
    assert.equal(s.thresholds().temperature.high, 45);
    assert.equal(s.snapshot(60).pending, 1);
    s.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('cloud uses reported service time and property mapping', async () => {
  const cloud = new Cloud(
    {
      IOTDA_AUTH_TOKEN: 'test',
      IOTDA_ENDPOINT: 'https://iot.example',
      IOTDA_PROJECT_ID: 'p',
      IOTDA_DEVICE_ID: 'd',
      IOTDA_SERVICE_ID: 'Room',
      IOTDA_TEMPERATURE_PROPERTY: 'temp',
    },
    async (url, options) => {
      assert.match(url, /\/devices\/d\/shadow$/);
      assert.equal(options.headers['X-Auth-Token'], 'test');
      return Response.json({
        shadow: [
          {
            service_id: 'Room',
            reported: {
              event_time: '20260906T010203Z',
              properties: { temp: 21, humidity: 40, gas_resistance: 5 },
            },
          },
        ],
      });
    },
  );
  const result = await cloud.read();
  assert.equal(result.data.temperature, 21);
  assert.equal(result.stamp, Date.parse('2026-09-06T01:02:03Z'));
  assert.ok(Number.isNaN(parseTime(undefined)));
});
test('ntfy sends UTF-8 JSON and propagates failed delivery', async () => {
  const env = {
    NTFY_URL: 'https://ntfy.example',
    NTFY_TOPIC: 'room',
    NTFY_TOKEN: 'secret',
  };
  const alert = {
    id: 2,
    stamp: Date.now(),
    message: '温度超过上限',
    state: 'high',
  };
  assert.equal(
    await notify(env, alert, async (url, options) => {
      const data = JSON.parse(options.body);
      assert.equal(data.topic, 'room');
      assert.match(data.message, /温度/);
      assert.equal(options.headers.Authorization, 'Bearer secret');
      return new Response('{}');
    }),
    true,
  );
  await assert.rejects(
    notify(env, alert, async () => new Response('', { status: 503 })),
    /503/,
  );
  assert.equal(await notify({}, alert), false);
});

test('a recovery cannot overtake a notification awaiting retry', () => {
  const s = new Store(), now = Date.now();
  s.ingest(sample(40), now, 60, now);
  s.failed(s.pending(now), now);
  s.ingest(sample(20), now + 1, 60, now + 1);
  assert.equal(s.pending(now + 2), undefined);
  assert.equal(s.pending(now + 6000).state, 'high');
  s.close();
});
