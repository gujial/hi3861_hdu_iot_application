// Read-only smoke check against the configured local backend; never prints tokens.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
if (existsSync('.env')) process.loadEnvFile('.env');
const base = `http://127.0.0.1:${process.env.PORT || 8787}`;
const headers = {
  Authorization: `Bearer ${process.env.ADMIN_TOKEN}`,
  'Content-Type': 'application/json',
};
assert.equal((await fetch(`${base}/api/status`)).status, 401);
const response = await fetch(`${base}/api/status`, { headers });
assert.equal(response.status, 200);
const status = await response.json();
assert.equal(typeof status.thresholds.temperature.high, 'number');
const invalid = await fetch(`${base}/api/thresholds`, {
  method: 'PUT',
  headers,
  body: JSON.stringify({ temperature: { high: -1 } }),
});
assert.equal(invalid.status, 400);
const unchanged = await (await fetch(`${base}/api/status`, { headers })).json();
assert.deepEqual(status.thresholds, unchanged.thresholds);
assert.equal((await fetch(base)).status, 200);
console.log(
  'HTTP checks passed: authentication, status, invalid edit rejection, static page.',
);
