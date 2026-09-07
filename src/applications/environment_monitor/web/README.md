# Hi3861 环境观测站

正式应用代码位于 `src/applications/environment_monitor`，实现温度、湿度、燃气传感器电阻的云端上报、本地 Web 监测、阈值设置和 ntfy 通知。

系统需求、详细设计、User Stories、项目计划、测试用例和总结见 [项目文档](../PROJECT_DOCUMENT.md)。

## 数据链路

开发板每 30 秒将有效读数通过 MQTTS（MQTT + TLS，QoS 1）上报华为云 IoTDA；Node.js 后端默认每 10 秒读取设备影子，保存至 SQLite 并判断阈值；浏览器每 5 秒刷新后端状态。后台进程持续运行时，关闭网页不影响告警。

阈值包含下限、上限和恢复缓冲。例如温度上限为 35°C、缓冲为 0.5°C：超过 35°C 报警，降到 34.5°C 才恢复。每次状态变化记录一次通知，持续超限不反复推送。失败的通知按顺序重试，数据库保留待发通知及告警状态，重启不会重复创建同一报警。网络超时可能导致 ntfy 已接收但本地未确认，此时重试可能重复发送，消息附带事件编号便于识别。

燃气传感器的值是 **kΩ 电阻，不是 ppm 浓度**。需根据模块和标定结果决定上下限，因此 Web 和设备端的燃气告警均默认关闭。Web 保存阈值时会通过 IoTDA 同步命令 `SetThresholds` 下发到在线开发板；设备校验并持久化成功后返回确认，后端随后保存相同规则。恢复缓冲仅用于 Web 告警状态机，设备端使用启用状态和上下限。设备离线或未确认时，本次保存失败，原有设备端和 Web 端阈值保持不变。

固件检测到任一启用指标从正常变为异常时，会绕过 30 秒普通上报周期，将该次异常读数优先加入 MQTT 队列。这样能缩短异常读数进入 IoTDA 设备影子的时间。Web 后端仍通过轮询设备影子获取数据，因此最终页面和 ntfy 通知延迟还受到 MQTT 网络、IoTDA 影子更新和 `POLL_SECONDS` 的影响；对每条异常事件都有严格接收要求时，应进一步使用 IoTDA 数据转发或应用侧订阅。

## 本地运行

需要 Node.js 24（使用内置 SQLite）及 npm。

```sh
cd src/applications/environment_monitor/web
npm ci
cp .env.example .env
```

如果 `.env` 已存在，请直接编辑，避免覆盖已有配置。本次开发已生成一个忽略提交的 `.env` 和随机 `ADMIN_TOKEN`；尚未填写华为云账号、项目 ID、设备 ID、ntfy Topic。

填写 `.env`，然后：

```sh
npm run build
npm start
```

访问 http://127.0.0.1:8787，输入 `.env` 中的 `ADMIN_TOKEN`。令牌仅保存在当前页面内存，刷新后需重新输入。不能把 IAM 凭据、MQTT 密码写入前端环境变量。

开发模式使用两个终端：

```sh
npm run api
npm run dev
```

开发页面地址以启动输出为准，通常为 http://127.0.0.1:3000。`API_PROXY_TARGET` 指向本地 API；生产模式页面和 API 使用同一地址，无需重编译即可修改后端云接口配置。

## 华为云配置

2026-09-06 通过用户提供的控制台链接核对：实例 `hi3861` 位于 `cn-east-3`，实例 ID 为 `a5ead6e5-eb88-42d6-a0da-969aeffff187`，该实例的产品列表为空，尚无注册设备。

已核对接入地址：

- 应用侧：`https://abcaf9a974.st1.iotda-app.cn-east-3.myhuaweicloud.com`
- 设备侧：`ssl://abcaf9a974.st1.iotda-device.cn-east-3.myhuaweicloud.com:8883`

在实例下创建 MQTT、JSON 格式的产品，在产品模型中添加服务 `Environment`，属性如下（名称区分大小写，设为可读）：

| 属性 | 数据类型 | 单位 | 范围 |
|---|---|---|---|
| `temperature` | decimal | °C | -50～150 |
| `humidity` | decimal | %RH | 0～100 |
| `gas_resistance` | decimal | kΩ | 0～1000000 |

在同一服务中添加命令 `SetThresholds`，并定义以下下发参数：

| 参数 | 类型 |
|---|---|
| `temperature_enabled` | boolean |
| `temperature_low`、`temperature_high` | decimal |
| `humidity_enabled` | boolean |
| `humidity_low`、`humidity_high` | decimal |
| `gas_enabled` | boolean |
| `gas_low`、`gas_high` | decimal |

设备订阅命令 Topic，并通过带相同 `request_id` 的响应 Topic 返回执行结果。IAM 用户除查询影子权限外，还需要 `iotda:commands:send` 权限。

随后注册设备。设备侧 MQTT 用户名使用设备 ID，Client ID 和 MQTT Password 使用华为云 MQTT 连接参数生成工具生成的值；派生后的 MQTT Password 与原始设备密钥不是同一值。Client ID 的时间校验选项和时间戳须与生成密码时一致，开启时间校验的凭据需要更新，不应固化过期凭据。

后端 `.env` 中：

- `IOTDA_PROJECT_ID` 是 IAM 区域项目 ID，**不是实例 ID，也不是资源空间 ID**。
- `IOTDA_DEVICE_ID` 填注册的设备 ID。
- `IOTDA_AUTH_TOKEN` 可用于短期联调；过期后替换并重启服务。
- 持续运行可填写 `IAM_DOMAIN`、`IAM_USERNAME`、`IAM_PASSWORD`，清空 `IOTDA_AUTH_TOKEN`；后端自动获取和续期项目级 Token。IAM 用户需要读取该设备影子的权限。
- 若已有产品属性名称不同，后端可通过三个 `IOTDA_*_PROPERTY` 配置映射；设备上报源码中的属性名也必须与产品模型一致。

平台上报 Topic：`$oc/devices/{device_id}/sys/properties/report`

```json
{"services":[{"service_id":"Environment","properties":{"temperature":25.6,"humidity":48.2,"gas_resistance":12.3}}]}
```

上例仅为报文格式示例，不会自动注入 Web 数据。后端使用 `reported.event_time` 判断新旧，缺失、非数值、过期或乱序数据不会触发新的超限报警。超过 `STALE_SECONDS` 未更新会显示历史读数。

**影子轮询的边界：**它只读取最新值，可能错过两次轮询之间的短暂超限，不能恢复后端停机期间全部历史。本版本用于本机联调；需要每条上报均处理时，应改接 IoTDA 数据转发/应用侧订阅。30 秒默认上报约 2880 条/天，留意实例消息额度及其他设备消息。

## 编译开发板

从仓库根目录操作：

1. 将 `src/applications/environment_monitor/device/tools/device.env.example` 复制到 Git 目录以外的私有文件，填好 Wi-Fi、设备 MQTT 参数和 IoTDA 根 CA PEM 文件路径。根 CA 从华为云官方设备接入文档获取，须匹配当前接入域名的证书链。
2. 导出该文件中的环境变量，运行：

   ```sh
   python3 src/applications/environment_monitor/device/tools/configure_device.py
   ```

   将生成忽略提交且权限为 0600 的 `environment_config.h`。MCU 无进程环境变量，设备配置需在编译前生成；更换设备凭据需重新编译烧录。

3. 正式应用入口已在 `src/applications/sample/wifi-iot/app/BUILD.gn` 中引用 `//applications/environment_monitor:environment_monitor`，无需再修改 vendor demo 列表。
4. 在仓库的 Nix 开发环境中构建：

   ```sh
   nix develop
   cd src
   hb build -f --gn-args='environment_cloud_enabled=true'
   ```

   使用当前 `wifiiot_hispark_pegasus` 产品，确保 SDK 启用 I2C、Wi-Fi、MQTT 与 TLS。默认 `environment_cloud_enabled=false`，不填云配置时仍可构建本地监测应用。

5. 烧录后检查串口：Wi-Fi 获取 IP → NTP 对时 → MQTT connected → 华为云设备影子更新。设备需要访问 NTP UDP 123 和 MQTTS TCP 8883；对时失败时不会跳过 TLS 证书校验。当前 NTP 时间处理支持到 2036 年 NTP era 0 结束前。

采集任务不会等待网络，断线自动重连；只保留一条最近待发读数，不补传过期值。AHT20 读取失败、ADC 无效时不上传伪造值。持续采集替代了原来 1000 次后退出的逻辑。

## ntfy

设置 `NTFY_URL` 为服务根地址，`NTFY_TOPIC` 为订阅主题，受保护的主题再填写 `NTFY_TOKEN`。手机 ntfy 客户端订阅同一服务和主题即可接收通知。未配置 Topic 时仍保存告警，界面显示待推送；填好配置并重启后按发生顺序补发。测试时修改阈值使最新有效读数超限，再恢复阈值，可验证报警与恢复通知。

## 迁移部署

复制 `src/applications/environment_monitor/web`，执行 `npm ci && npm run build`，在目标环境配置同名环境变量并运行 `npm start`。进程环境变量优先于 `.env`。用进程管理器维持后端运行；需要其他主机访问时设置 `HOST=0.0.0.0`，并在反向代理提供 HTTPS。不要把 Vite 开发端口作为部署入口。

持久化 `DB_PATH` 指定的 SQLite 文件及其目录；一个数据库对应一台设备，切换设备时使用新的数据库路径。历史数据保留 30 天，页面显示最近 180 条；告警记录持久保存，页面显示最近 40 条。

## 验证

```sh
npm test
npx tsc --noEmit
npm run build
# 后端运行时验证认证、查询、非法修改拒绝及静态页面：
node backend/http-check.mjs
```

本次完成了告警单元测试、静态类型检查、页面构建和 HTTP 接口检查；普通固件及启用 `environment_cloud_enabled=true` 的云端固件均通过原厂 GCC 7.3 完整构建和链接。云端构建使用无敏感信息的临时占位配置，仅验证编译链路；尚未完成烧录、真实设备到 IoTDA 的 TLS/MQTT 联调及真实 ntfy 推送验证。

接口依据：[IoTDA 属性上报](https://support.huaweicloud.com/api-iothub/iot_06_v5_3010.html)、[查询设备影子](https://support.huaweicloud.com/intl/zh-cn/api-iothub/iot_06_v5_0079.html)、[IAM Token](https://support.huaweicloud.com/intl/en-us/api-iam/iam_30_0001.html)、[ntfy 发布](https://docs.ntfy.sh/publish/)。
