export function parseTime(value) {
  if (typeof value !== 'string') return NaN;
  return Date.parse(
    value.replace(
      /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
      '$1-$2-$3T$4:$5:$6Z',
    ),
  );
}
export class Cloud {
  constructor(env, request = fetch) {
    this.env = env;
    this.request = request;
    this.token = '';
    this.expires = 0;
  }
  async auth() {
    const e = this.env;
    if (e.IOTDA_AUTH_TOKEN) return e.IOTDA_AUTH_TOKEN;
    if (this.token && Date.now() < this.expires - 60000) return this.token;
    if (!e.IAM_USERNAME || !e.IAM_PASSWORD || !e.IAM_DOMAIN)
      throw new Error('请配置 IAM 凭据或 IOTDA_AUTH_TOKEN');
    const response = await this.request(
      `${e.IAM_ENDPOINT || 'https://iam.cn-east-3.myhuaweicloud.com'}/v3/auth/tokens?nocatalog=true`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({
          auth: {
            identity: {
              methods: ['password'],
              password: {
                user: {
                  name: e.IAM_USERNAME,
                  password: e.IAM_PASSWORD,
                  domain: { name: e.IAM_DOMAIN },
                },
              },
            },
            scope: { project: { id: e.IOTDA_PROJECT_ID } },
          },
        }),
      },
    );
    if (!response.ok)
      throw new Error(`IAM 认证失败（HTTP ${response.status}）`);
    const body = await response.json();
    this.token = response.headers.get('x-subject-token');
    this.expires = Date.parse(body.token?.expires_at);
    if (!this.token || !Number.isFinite(this.expires))
      throw new Error('IAM 响应缺少令牌或过期时间');
    return this.token;
  }
  async read() {
    const e = this.env;
    if (!e.IOTDA_ENDPOINT || !e.IOTDA_PROJECT_ID || !e.IOTDA_DEVICE_ID)
      throw new Error('等待配置华为云接口、项目 ID 和设备 ID');
    const headers = { 'X-Auth-Token': await this.auth() };
    if (e.IOTDA_INSTANCE_ID) headers['Instance-Id'] = e.IOTDA_INSTANCE_ID;
    const response = await this.request(
      `${e.IOTDA_ENDPOINT.replace(/\/$/, '')}/v5/iot/${encodeURIComponent(e.IOTDA_PROJECT_ID)}/devices/${encodeURIComponent(e.IOTDA_DEVICE_ID)}/shadow`,
      { headers, signal: AbortSignal.timeout(15000) },
    );
    if (!response.ok) {
      if (response.status === 401) {
        this.token = '';
        this.expires = 0;
      }
      throw new Error(`IoTDA 读取失败（HTTP ${response.status}）`);
    }
    const body = await response.json();
    const service = body.shadow?.find(
      (s) => s.service_id === (e.IOTDA_SERVICE_ID || 'Environment'),
    );
    if (!service?.reported?.properties)
      throw new Error('尚无匹配服务的设备上报数据，请核对服务 ID');
    const properties = service.reported.properties;
    const mapping = {
      temperature: e.IOTDA_TEMPERATURE_PROPERTY || 'temperature',
      humidity: e.IOTDA_HUMIDITY_PROPERTY || 'humidity',
      gas_resistance: e.IOTDA_GAS_PROPERTY || 'gas_resistance',
    };
    return {
      stamp: parseTime(service.reported.event_time),
      data: Object.fromEntries(
        Object.entries(mapping).map(([key, name]) => [key, properties[name]]),
      ),
    };
  }
}
export async function notify(env, alert, request = fetch) {
  if (!env.NTFY_URL || !env.NTFY_TOPIC) return false;
  const headers = { 'Content-Type': 'application/json' };
  if (env.NTFY_TOKEN) headers.Authorization = `Bearer ${env.NTFY_TOKEN}`;
  const response = await request(env.NTFY_URL.replace(/\/$/, ''), {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(10000),
    body: JSON.stringify({
      topic: env.NTFY_TOPIC,
      title: alert.state === 'normal' ? '环境监测状态更新' : '环境监测报警',
      message: `${alert.message}\n发生时间：${new Date(alert.stamp).toISOString()}\n事件 #${alert.id}`,
      priority: alert.state === 'normal' ? 3 : 4,
    }),
  });
  if (!response.ok) throw new Error(`ntfy 推送失败（HTTP ${response.status}）`);
  return true;
}
