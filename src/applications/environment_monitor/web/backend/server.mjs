import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { resolve, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, validateThresholds } from './store.mjs';
import { Cloud, notify } from './cloud.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(resolve(root, '.env')))
  process.loadEnvFile(resolve(root, '.env'));
const env = process.env;
const host = env.HOST || '127.0.0.1';
const port = Number(env.PORT || 8787);
const stale = Number(env.STALE_SECONDS || 60);
const poll = Number(env.POLL_SECONDS || 10);
if (![stale, poll, port].every(Number.isFinite) || poll < 2 || stale <= poll)
  throw new Error('Invalid polling/stale/port settings');
if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 16)
  throw new Error('请在 .env 设置至少 16 位 ADMIN_TOKEN');
for (const key of ['IOTDA_ENDPOINT', 'IAM_ENDPOINT', 'NTFY_URL']) {
  if (env[key]) {
    const url = new URL(env[key]);
    if (
      url.protocol !== 'https:' &&
      !(
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
        url.protocol === 'http:'
      )
    )
      throw new Error(`${key} requires HTTPS (localhost HTTP is allowed)`);
  }
}
const dbPath = resolve(root, env.DB_PATH || 'data/environment.sqlite');
mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
const store = new Store(dbPath);
const cloud = new Cloud(env);
let cloudStatus = '等待首次读取',
  thresholdSyncStatus = '尚未下发设备阈值',
  notificationStatus =
    env.NTFY_URL && env.NTFY_TOPIC ? '就绪' : '尚未配置 ntfy';
let stopping = false;
async function pollCloud() {
  try {
    const reading = await cloud.read();
    store.ingest(reading.data, reading.stamp, stale);
    cloudStatus = '已连接华为云';
  } catch (error) {
    cloudStatus = error.message;
  }
  if (!stopping) setTimeout(pollCloud, poll * 1000).unref();
}
async function pushAlerts() {
  const alert = store.pending();
  if (alert && env.NTFY_URL && env.NTFY_TOPIC) {
    try {
      if (await notify(env, alert)) {
        store.delivered(alert.id);
        notificationStatus = '最近一次推送成功';
      }
    } catch (error) {
      store.failed(alert);
      notificationStatus = error.message;
    }
  }
  if (!stopping) setTimeout(pushAlerts, 2000).unref();
}
function authorized(req) {
  const expected = Buffer.from(`Bearer ${env.ADMIN_TOKEN}`),
    actual = Buffer.from(req.headers.authorization || '');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function json(res, status, value) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(value));
}
async function body(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (Buffer.byteLength(text) > 8192) throw new Error('请求过大');
  }
  return JSON.parse(text);
}
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path.startsWith('/api/')) {
    if (!authorized(req)) return json(res, 401, { error: '访问令牌无效' });
    try {
      if (path === '/api/status' && req.method === 'GET')
        return json(res, 200, {
          ...store.snapshot(stale),
          cloudStatus,
          thresholdSyncStatus,
          notificationStatus,
          device: env.IOTDA_DEVICE_ID || '尚未配置设备',
          staleSeconds: stale,
        });
      if (path === '/api/thresholds' && req.method === 'PUT') {
        const rules = validateThresholds(await body(req));
        try {
          const result = await cloud.setThresholds(rules);
          store.saveThresholds(rules, stale);
          thresholdSyncStatus = `设备已确认（命令 ${result.command_id || '无编号'}）`;
          return json(res, 200, { ok: true, thresholdSyncStatus });
        } catch (error) {
          thresholdSyncStatus = error.message;
          throw error;
        }
      }
      return json(res, 404, { error: '接口不存在' });
    } catch (error) {
      return json(res, 400, { error: error.message });
    }
  }
  if (req.method !== 'GET' && req.method !== 'HEAD')
    return json(res, 405, { error: 'Method not allowed' });
  const staticRoot = resolve(root, env.STATIC_DIR || 'dist/client');
  let file;
  try {
    file = resolve(staticRoot, '.' + decodeURIComponent(path));
  } catch {
    return json(res, 400, { error: 'Invalid path' });
  }
  if (file !== staticRoot && !file.startsWith(staticRoot + '/'))
    return json(res, 403, { error: 'Forbidden' });
  if (path === '/') file = resolve(staticRoot, 'index.html');
  try {
    const contents = readFileSync(file);
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.ico': 'image/x-icon',
      '.json': 'application/json',
    };
    res.writeHead(200, {
      'Content-Type': types[extname(file)] || 'application/octet-stream',
    });
    res.end(req.method === 'HEAD' ? undefined : contents);
  } catch {
    json(res, 404, { error: '页面尚未构建，请先运行 npm run build' });
  }
});
server.listen(port, host, () =>
  console.log(`Environment API: http://${host}:${port}`),
);
pollCloud();
pushAlerts();
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    stopping = true;
    server.close(() => process.exit(0));
  });
