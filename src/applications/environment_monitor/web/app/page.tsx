'use client';
import { useEffect, useState } from 'react';
import {
  Thermometer,
  Droplets,
  Wind,
  Activity,
  Bell,
  Settings2,
  LockKeyhole,
} from 'lucide-react';
type Key = 'temperature' | 'humidity' | 'gas_resistance';
type Rule = { enabled: boolean; low: number; high: number; hysteresis: number };
type Rules = Record<Key, Rule>;
type Sample = Record<Key, number> & { stamp: number };
type Status = {
  latest: { stamp: number; data: Record<Key, number> } | null;
  stale: boolean;
  thresholds: Rules;
  states: Record<Key, string>;
  history: Sample[];
  alerts: {
    id: number;
    stamp: number;
    message: string;
    sent: number;
    state: string;
  }[];
  pending: number;
  cloudStatus: string;
  notificationStatus: string;
  device: string;
};
const fields = [
  {
    key: 'temperature' as Key,
    title: '温度',
    unit: '°C',
    Icon: Thermometer,
    color: '#d76535',
  },
  {
    key: 'humidity' as Key,
    title: '相对湿度',
    unit: '%RH',
    Icon: Droplets,
    color: '#368eac',
  },
  {
    key: 'gas_resistance' as Key,
    title: '燃气传感器电阻',
    unit: 'kΩ',
    Icon: Wind,
    color: '#698244',
  },
];
const time = (stamp: number) =>
  new Date(stamp).toLocaleString('zh-CN', { hour12: false });
export default function Home() {
  const [token, setToken] = useState('');
  const [input, setInput] = useState('');
  const [status, setStatus] = useState<Status | null>(null);
  const [rules, setRules] = useState<Rules | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [metric, setMetric] = useState<Key>('temperature');
  async function request(path: string, options: RequestInit = {}) {
    const response = await fetch(path, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    });
    const text = await response.text();
    let body: (Status & { error?: string }) | null = null;
    if (text) {
      try {
        body = JSON.parse(text) as Status & { error?: string };
      } catch {
        throw new Error(`监测服务返回了无效响应（HTTP ${response.status}）`);
      }
    }
    if (!response.ok)
      throw new Error(body?.error || `监测服务请求失败（HTTP ${response.status}）`);
    if (!body) throw new Error('监测服务返回了空响应');
    return body;
  }
  useEffect(() => {
    if (!token) return;
    let active = true;
    async function refresh() {
      try {
        const data = await request('/api/status');
        if (active) {
          setStatus(data);
          setRules((old) => old ?? data.thresholds);
          setError('');
        }
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : '连接失败');
      }
    }
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [token]);
  const update = (key: Key, field: keyof Rule, value: number | boolean) =>
    setRules(
      (old) => old && { ...old, [key]: { ...old[key], [field]: value } },
    );
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setMessage('');
    try {
      await request('/api/thresholds', {
        method: 'PUT',
        body: JSON.stringify(rules),
      });
      setMessage('阈值已保存，后端持续监测中');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }
  const samples = status?.history ?? [];
  const values = samples.map((s) => s[metric]);
  const min = values.length ? Math.min(...values) : 0,
    max = values.length ? Math.max(...values) : 1;
  const points = samples
    .map(
      (s, i) =>
        `${30 + (i / Math.max(samples.length - 1, 1)) * 900},${170 - ((s[metric] - min) / Math.max(max - min, 1)) * 130}`,
    )
    .join(' ');
  return (
    <main>
      <header>
        <div className="brand">
          <Activity size={24} />
          <span>
            环境观测站<small>HI3861 · ENVIRONMENT</small>
          </span>
        </div>
        <span className="chip">本地监测中心</span>
      </header>
      <section className="intro">
        <div>
          <p className="eyebrow">掌握环境的每一次变化</p>
          <h1>环境监测</h1>
          <p className="muted">实时观测 · 阈值管理 · 消息提醒</p>
        </div>
        <div className="connection">
          <i
            className={status && !status.stale && !error ? 'dot live' : 'dot'}
          />
          {!status
            ? '等待连接'
            : error
              ? '连接异常'
              : status.stale
                ? '数据未更新'
                : '数据更新中'}
          <small>
            {status?.latest
              ? `最近上报 ${time(status.latest.stamp)}`
              : '尚无设备上报'}
          </small>
        </div>
      </section>
      {!status && (
        <form
          className="login"
          onSubmit={(e) => {
            e.preventDefault();
            setToken(input);
          }}
        >
          <LockKeyhole />
          <div>
            <label htmlFor="token">连接本地监测服务</label>
            <p>输入本地配置中的访问令牌，查看数据并管理阈值。</p>
          </div>
          <input
            id="token"
            type="password"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="访问令牌"
            required
          />
          <button type="submit">连接</button>
        </form>
      )}
      {error && (
        <p role="alert" className="notice error">
          {error}。请检查服务和访问令牌。
          {status && (
            <button
              onClick={() => {
                setToken('');
                setStatus(null);
                setRules(null);
              }}
            >
              重新连接
            </button>
          )}
        </p>
      )}
      {status && (
        <p className="notice">
          {status.cloudStatus} · {status.device}
          {status.stale && ' · 当前为历史值，暂不据此触发新的报警'}
        </p>
      )}
      <section className="metrics">
        {fields.map(({ key, title, unit, Icon, color }) => (
          <article
            className="metric"
            key={key}
            style={{ '--accent': color } as React.CSSProperties}
          >
            <div className="metric-title">
              <span>{title}</span>
              <Icon size={22} />
            </div>
            <div className="value">
              {status?.latest
                ? status.latest.data[key].toFixed(
                    key === 'gas_resistance' ? 2 : 1,
                  )
                : '—'}
              <small>{unit}</small>
            </div>
            <div className="metric-footer">
              <span>
                {!status
                  ? '等待数据'
                  : status.stale
                    ? '历史读数'
                    : !status.thresholds[key].enabled
                      ? '未启用报警'
                      : status.states[key] === 'high'
                        ? '超过上限'
                        : status.states[key] === 'low'
                          ? '低于下限'
                          : '正常范围'}
              </span>
              <span>
                {status?.thresholds[key].enabled
                  ? `${status.thresholds[key].low} – ${status.thresholds[key].high}`
                  : '—'}
              </span>
            </div>
          </article>
        ))}
      </section>
      <section className="panel trend">
        <div className="section-heading">
          <div>
            <h2>变化趋势</h2>
            <p>最近 180 次采集记录</p>
          </div>
          <div className="tabs">
            {fields.map((f) => (
              <button
                key={f.key}
                aria-pressed={metric === f.key}
                className={metric === f.key ? 'selected' : ''}
                onClick={() => setMetric(f.key)}
              >
                {f.title}
              </button>
            ))}
          </div>
        </div>
        {samples.length > 1 ? (
          <>
            <div className="chart-label">
              {max.toFixed(2)} / {min.toFixed(2)}{' '}
              {fields.find((f) => f.key === metric)?.unit}（最高 / 最低）
            </div>
            <svg
              viewBox="0 0 960 210"
              role="img"
              aria-label={`${fields.find((f) => f.key === metric)?.title}趋势`}
            >
              <path
                d="M30 40H930 M30 105H930 M30 170H930"
                stroke="#e1e6df"
                fill="none"
              />
              <polyline
                points={points}
                stroke={fields.find((f) => f.key === metric)?.color}
                strokeWidth="3"
                fill="none"
              />
            </svg>
            <div className="chart-times">
              <span>{time(samples[0].stamp)}</span>
              <span>{time(samples[samples.length - 1].stamp)}</span>
            </div>
          </>
        ) : (
          <div className="empty">
            <Activity size={30} />
            <p>等待连续的环境数据</p>
            <small>设备接入后，趋势会自动显示在这里</small>
          </div>
        )}
      </section>
      <div className="lower">
        <section className="panel">
          <div className="section-heading">
            <div>
              <h2>
                <Settings2 size={19} />
                报警阈值
              </h2>
              <p>超出范围触发通知，恢复缓冲可减少边界反复报警</p>
            </div>
          </div>
          {rules ? (
            <form onSubmit={save}>
              <div className="rule-head">
                <span>监测项目</span>
                <span>下限</span>
                <span>上限</span>
                <span>恢复缓冲</span>
              </div>
              {fields.map((f) => (
                <div className="rule" key={f.key}>
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={rules[f.key].enabled}
                      onChange={(e) =>
                        update(f.key, 'enabled', e.target.checked)
                      }
                    />
                    {f.title}
                    <small>{f.unit}</small>
                  </label>
                  {(['low', 'high', 'hysteresis'] as const).map((k) => (
                    <input
                      key={k}
                      aria-label={`${f.title}${k === 'low' ? '下限' : k === 'high' ? '上限' : '恢复缓冲'}`}
                      type="number"
                      step="any"
                      required
                      value={
                        Number.isNaN(rules[f.key][k]) ? '' : rules[f.key][k]
                      }
                      onChange={(e) => update(f.key, k, e.target.valueAsNumber)}
                    />
                  ))}
                </div>
              ))}
              <p className="hint">
                燃气读数是电阻值，需结合传感器标定设置阈值。
              </p>
              <div className="save">
                <span role="status">{message}</span>
                <button disabled={saving}>
                  {saving ? '保存中…' : '保存阈值'}
                </button>
              </div>
            </form>
          ) : (
            <p className="empty">连接服务后可设置阈值</p>
          )}
        </section>
        <section className="panel">
          <div className="section-heading">
            <div>
              <h2>
                <Bell size={19} />
                报警记录
              </h2>
              <p>
                {status?.notificationStatus || '连接服务后查看通知状态'}
                {status?.pending ? ` · ${status.pending} 条待推送` : ''}
              </p>
            </div>
          </div>
          <div className="alerts">
            {status?.alerts.length ? (
              status.alerts.map((a) => (
                <article key={a.id}>
                  <span
                    className={a.state === 'normal' ? 'event normal' : 'event'}
                  >
                    {a.state === 'normal' ? '状态更新' : '阈值报警'}
                  </span>
                  <p>{a.message}</p>
                  <small>
                    {time(a.stamp)} · {a.sent ? '已推送' : '待推送'}
                  </small>
                </article>
              ))
            ) : (
              <div className="empty">
                <Bell size={28} />
                <p>暂无报警记录</p>
                <small>报警和恢复通知都会保留在这里</small>
              </div>
            )}
          </div>
        </section>
      </div>
      <footer>
        Hi3861 → 华为云 IoTDA → 环境观测站 → ntfy
        <span>关闭网页后，后端仍会持续监测</span>
      </footer>
    </main>
  );
}
