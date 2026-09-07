# Hi3861 环境监测设备应用

这是 `environment_monitor` 正式应用的设备端，面向 HiHope HiSpark Pegasus。应用持续采集 AHT20 温湿度与 MQ-2 模拟电阻值，在 SSD1306 OLED 显示数据，并通过蜂鸣器提供本地温湿度报警。启用云端功能后，设备通过 MQTTS 将有效数据上报至华为云 IoTDA。

硬件连接：

- 蜂鸣器：GPIO 9 / PWM0
- MQ-2：GPIO 11 / ADC5
- AHT20 与 SSD1306：GPIO 13、14 / I2C0

正式构建入口为 `//applications/environment_monitor:environment_monitor`，已由 `//applications/sample/wifi-iot/app:app` 引用。设备库目标为 `//applications/environment_monitor/device:environment_monitor_device`。

云端配置由 `tools/configure_device.py` 生成到本目录的 `environment_config.h`。该文件包含本机 Wi-Fi 和设备凭据，已被 Git 忽略。完整的华为云产品模型、Web 后端、编译、烧录和 ntfy 配置说明见 [环境观测站](../web/README.md)。

面向居住者和家人的日常操作、报警处置与常见问题见 [家庭环境监测系统用户使用手册](../家庭环境监测系统用户使用手册.md)。

`device.env` 中的阈值是首次启动和恢复出厂配置。Web 可通过 IoTDA `SetThresholds` 同步命令更新启用状态及上下限；设备校验后写入 KV 存储，重启后继续生效。MQ-2 本地蜂鸣报警默认关闭，只有完成充分预热和实际模块标定后才应启用。燃气报警使用连续三短声，温湿度报警使用单次长声。

设备每次采样后先判断本地阈值。当温度、湿度或燃气电阻从正常状态首次进入异常状态时，固件调用 `EnvironmentCloudReportNow` 绕过普通上报周期，把当前异常读数立即放入容量为 1 的 MQTT 队列；若队列已有普通读数，则用异常读数替换。持续异常仍按 `ENV_REPORT_INTERVAL_SECONDS` 周期上报，避免每次采样都发送消息。采集线程只入队，不等待网络操作，因此 OLED 与蜂鸣器不会被 MQTT 阻塞。串口出现以下日志表示已触发异常边沿上报：

```text
[environment] alarm transition queued for immediate report
```

配置生成器测试使用临时目录和占位凭据，不会读取或覆盖本机的 `device.env`：

```sh
cd src/applications/environment_monitor/device/tools
python3 -m unittest -v configure_device_test.py
```
