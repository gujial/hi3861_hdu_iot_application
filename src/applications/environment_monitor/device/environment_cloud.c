#include "environment_cloud.h"
#include "environment_config.h"
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include "securec.h"
#include "cmsis_os2.h"
#include "wifi_device.h"
#include "lwip/netifapi.h"
#include "MQTTClient.h"

typedef struct { float temperature, humidity, gas; unsigned int tick; } Reading;
int EnvironmentSyncTime(void);
static osMessageQueueId_t queue;
static volatile int wifiConnected;
static void WifiChanged(int state, WifiLinkedInfo *info)
{
    (void)info;
    wifiConnected = state == WIFI_STATE_AVALIABLE;
}
static WifiEvent wifiEvents = { .OnWifiConnectionChanged = WifiChanged };

static int JoinWifi(int netId)
{
    if (ConnectTo(netId) != WIFI_SUCCESS) return -1;
    for (int i = 0; i < 30 && !wifiConnected; ++i) sleep(1);
    if (!wifiConnected) return -1;
    struct netif *iface = netifapi_netif_find("wlan0");
    if (!iface || netifapi_dhcp_start(iface) != ERR_OK) { Disconnect(); wifiConnected = 0; return -1; }
    /* Connect retries below also cover DHCP/DNS not being ready yet. */
    sleep(3);
    return 0;
}

static void CloudTask(void *argument)
{
    (void)argument;
    WifiDeviceConfig wifi = {0};
    int netId = -1;
    if (strcpy_s(wifi.ssid, sizeof(wifi.ssid), ENV_WIFI_SSID) != EOK ||
        strcpy_s(wifi.preSharedKey, sizeof(wifi.preSharedKey), ENV_WIFI_PASSWORD) != EOK) return;
    wifi.securityType = WIFI_SEC_TYPE_PSK;
    if (RegisterWifiEvent(&wifiEvents) != WIFI_SUCCESS || EnableWifi() != WIFI_SUCCESS ||
        AddDeviceConfig(&wifi, &netId) != WIFI_SUCCESS) {
        printf("[environment] Wi-Fi setup failed\n");
        return;
    }
    unsigned int backoff = 2;
    for (;;) {
        if (!wifiConnected && JoinWifi(netId) != 0) { sleep(5); continue; }
        if (EnvironmentSyncTime() != 0) {
            printf("[environment] time synchronization failed; retrying before TLS\n");
            sleep(5);
            continue;
        }
        MQTTClient client = NULL;
        MQTTClient_connectOptions options = MQTTClient_connectOptions_initializer;
        MQTTClient_SSLOptions ssl = MQTTClient_SSLOptions_initializer;
        const cert_string ca = { (const unsigned char *)ENV_MQTT_CA_PEM, sizeof(ENV_MQTT_CA_PEM) };
        ssl.los_trustStore = &ca;
        ssl.enableServerCertAuth = 1;
        ssl.verify = 1;
        ssl.sslVersion = MQTT_SSL_VERSION_TLS_1_2;
        options.ssl = &ssl;
        options.username = ENV_DEVICE_ID;
        options.password = ENV_MQTT_PASSWORD;
        options.keepAliveInterval = 60;
        options.cleansession = 1;
        options.connectTimeout = 10;
        options.MQTTVersion = MQTTVERSION_3_1_1;
        int rc = MQTTClient_create(&client, ENV_MQTT_URI, ENV_MQTT_CLIENT_ID,
                                   MQTTCLIENT_PERSISTENCE_NONE, NULL);
        if (rc == MQTTCLIENT_SUCCESS) rc = MQTTClient_connect(client, &options);
        if (rc == MQTTCLIENT_SUCCESS) {
            backoff = 2;
            printf("[environment] MQTT connected\n");
            while (wifiConnected && MQTTClient_isConnected(client)) {
                Reading reading;
                if (osMessageQueueGet(queue, &reading, NULL, 0) == osOK) {
                    if ((osKernelGetTickCount() - reading.tick) / osKernelGetTickFreq() > 10) continue;
                    char payload[384];
                    int length = snprintf(payload, sizeof(payload),
                        "{\"services\":[{\"service_id\":\"%s\",\"properties\":{"
                        "\"temperature\":%.2f,\"humidity\":%.2f,\"gas_resistance\":%.3f}}]}",
                        ENV_SERVICE_ID, reading.temperature, reading.humidity, reading.gas);
                    if (length < 0 || (size_t)length >= sizeof(payload)) continue;
                    MQTTClient_message message = MQTTClient_message_initializer;
                    MQTTClient_deliveryToken token;
                    message.payload = payload;
                    message.payloadlen = length;
                    message.qos = 1;
                    rc = MQTTClient_publishMessage(client,
                        "$oc/devices/" ENV_DEVICE_ID "/sys/properties/report", &message, &token);
                    if (rc == MQTTCLIENT_SUCCESS) rc = MQTTClient_waitForCompletion(client, token, 10000);
                    if (rc != MQTTCLIENT_SUCCESS) break;
                }
                MQTTClient_yield();
                sleep(1);
            }
            MQTTClient_disconnect(client, 1000);
        }
        if (client) MQTTClient_destroy(&client);
        printf("[environment] MQTT retry in %u seconds (code %d)\n", backoff, rc);
        sleep(backoff);
        if (backoff < 32) backoff *= 2;
    }
}
void EnvironmentCloudInit(void)
{
    queue = osMessageQueueNew(1, sizeof(Reading), NULL);
    if (!queue) return;
    osThreadAttr_t attr = {0};
    attr.name = "EnvironmentCloud";
    attr.stack_size = 10240;
    attr.priority = osPriorityNormal;
    if (!osThreadNew(CloudTask, NULL, &attr)) { osMessageQueueDelete(queue); queue = NULL; }
}
void EnvironmentCloudReport(float temperature, float humidity, float gasResistance)
{
    if (!queue) return;
    static unsigned int lastQueued;
    unsigned int now = osKernelGetTickCount();
    if ((now - lastQueued) / osKernelGetTickFreq() < ENV_REPORT_INTERVAL_SECONDS) return;
    lastQueued = now;
    Reading reading = {temperature, humidity, gasResistance, now}, old;
    if (osMessageQueuePut(queue, &reading, 0, 0) != osOK) {
        osMessageQueueGet(queue, &old, NULL, 0);
        osMessageQueuePut(queue, &reading, 0, 0);
    }
}
