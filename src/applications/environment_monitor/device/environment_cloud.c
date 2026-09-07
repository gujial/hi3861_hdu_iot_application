#include "environment_cloud.h"
#include "environment_config.h"
#include <stdio.h>
#include <string.h>
#include <math.h>
#include <unistd.h>
#include "securec.h"
#include "cmsis_os2.h"
#include "wifi_device.h"
#include "lwip/netifapi.h"
#include "MQTTClient.h"
#include "cJSON.h"
#include "kv_store.h"

typedef struct { float temperature, humidity, gas; unsigned int tick; } Reading;
typedef struct { char requestId[80]; EnvironmentThresholds thresholds; } ThresholdCommand;
int EnvironmentSyncTime(void);
static osMessageQueueId_t queue;
static osMessageQueueId_t commandQueue;
static osMutexId_t thresholdsMutex;
static volatile int wifiConnected;
static EnvironmentThresholds currentThresholds = {
    ENV_LOCAL_TEMP_LOW, ENV_LOCAL_TEMP_HIGH,
    ENV_LOCAL_HUMIDITY_LOW, ENV_LOCAL_HUMIDITY_HIGH,
    ENV_LOCAL_GAS_LOW, ENV_LOCAL_GAS_HIGH, 1, 1,
    ENV_LOCAL_GAS_ALARM_ENABLED
};

void EnvironmentCloudGetThresholds(EnvironmentThresholds *thresholds)
{
    if (!thresholds) return;
    if (thresholdsMutex) osMutexAcquire(thresholdsMutex, osWaitForever);
    *thresholds = currentThresholds;
    if (thresholdsMutex) osMutexRelease(thresholdsMutex);
}

static int Number(const cJSON *object, const char *name, float *value)
{
    const cJSON *item = cJSON_GetObjectItemCaseSensitive(object, name);
    if (!cJSON_IsNumber(item)) return 0;
    *value = (float)item->valuedouble;
    return isfinite(*value);
}

static int Boolean(const cJSON *object, const char *name, int *value)
{
    const cJSON *item = cJSON_GetObjectItemCaseSensitive(object, name);
    if (!cJSON_IsBool(item)) return 0;
    *value = cJSON_IsTrue(item);
    return 1;
}

static int ValidThresholds(const EnvironmentThresholds *t)
{
    return (t->temperatureEnabled == 0 || t->temperatureEnabled == 1) &&
           (t->humidityEnabled == 0 || t->humidityEnabled == 1) &&
           (t->gasEnabled == 0 || t->gasEnabled == 1) &&
           t->temperatureLow >= -50 && t->temperatureHigh <= 150 &&
           t->temperatureLow < t->temperatureHigh &&
           t->humidityLow >= 0 && t->humidityHigh <= 100 &&
           t->humidityLow < t->humidityHigh &&
           t->gasLow >= 0 && t->gasHigh <= 1000000 &&
           t->gasLow < t->gasHigh;
}

static int CommandArrived(void *context, char *topicName, int topicLen,
                          MQTTClient_message *message)
{
    (void)context;
    int handled = 1;
    ThresholdCommand command = {0};
    size_t topicSize = topicLen > 0 ? (size_t)topicLen : strlen(topicName);
    char topic[192];
    const char marker[] = "request_id=";
    const char *request = NULL;
    if (topicSize < sizeof(topic)) {
        memcpy(topic, topicName, topicSize);
        topic[topicSize] = '\0';
        request = strstr(topic, marker);
    }
    cJSON *root = cJSON_ParseWithLength((const char *)message->payload,
                                        (size_t)message->payloadlen);
    const cJSON *name = root ? cJSON_GetObjectItemCaseSensitive(root, "command_name") : NULL;
    const cJSON *service = root ? cJSON_GetObjectItemCaseSensitive(root, "service_id") : NULL;
    const cJSON *paras = root ? cJSON_GetObjectItemCaseSensitive(root, "paras") : NULL;
    if (!request || (size_t)(request - topic) >= topicSize ||
        !cJSON_IsString(name) || strcmp(name->valuestring, "SetThresholds") != 0 ||
        !cJSON_IsString(service) || strcmp(service->valuestring, ENV_SERVICE_ID) != 0 ||
        !cJSON_IsObject(paras)) {
        handled = 0;
    } else {
        request += sizeof(marker) - 1;
        size_t remaining = topicSize - (size_t)(request - topic);
        if (remaining == 0 || remaining >= sizeof(command.requestId)) handled = 0;
        else {
            memcpy(command.requestId, request, remaining);
            command.requestId[remaining] = '\0';
            handled =
                Boolean(paras, "temperature_enabled", &command.thresholds.temperatureEnabled) &&
                Number(paras, "temperature_low", &command.thresholds.temperatureLow) &&
                Number(paras, "temperature_high", &command.thresholds.temperatureHigh) &&
                Boolean(paras, "humidity_enabled", &command.thresholds.humidityEnabled) &&
                Number(paras, "humidity_low", &command.thresholds.humidityLow) &&
                Number(paras, "humidity_high", &command.thresholds.humidityHigh) &&
                Boolean(paras, "gas_enabled", &command.thresholds.gasEnabled) &&
                Number(paras, "gas_low", &command.thresholds.gasLow) &&
                Number(paras, "gas_high", &command.thresholds.gasHigh) &&
                ValidThresholds(&command.thresholds);
        }
    }
    if (handled && osMessageQueuePut(commandQueue, &command, 0, 0) != osOK)
        handled = 0;
    if (!handled) printf("[environment] invalid threshold command\n");
    cJSON_Delete(root);
    MQTTClient_freeMessage(&message);
    MQTTClient_free(topicName);
    return 1;
}

static int ApplyCommand(MQTTClient client, const ThresholdCommand *command)
{
    char saved[128];
    int savedLength = snprintf(saved, sizeof(saved),
        "%d,%.3f,%.3f,%d,%.3f,%.3f,%d,%.3f,%.3f",
        command->thresholds.temperatureEnabled,
        command->thresholds.temperatureLow, command->thresholds.temperatureHigh,
        command->thresholds.humidityEnabled,
        command->thresholds.humidityLow, command->thresholds.humidityHigh,
        command->thresholds.gasEnabled,
        command->thresholds.gasLow, command->thresholds.gasHigh);
    if (savedLength < 0 || (size_t)savedLength >= sizeof(saved) ||
        UtilsSetValue("env.thresholds", saved) != 0) return -1;
    if (thresholdsMutex) osMutexAcquire(thresholdsMutex, osWaitForever);
    currentThresholds = command->thresholds;
    if (thresholdsMutex) osMutexRelease(thresholdsMutex);
    char topic[180], payload[180];
    int topicLength = snprintf(topic, sizeof(topic),
        "$oc/devices/%s/sys/commands/response/request_id=%s",
        ENV_DEVICE_ID, command->requestId);
    int payloadLength = snprintf(payload, sizeof(payload),
        "{\"result_code\":0,\"response_name\":\"COMMAND_RESPONSE\","
        "\"paras\":{\"result\":\"success\"}}");
    if (topicLength < 0 || (size_t)topicLength >= sizeof(topic) ||
        payloadLength < 0 || (size_t)payloadLength >= sizeof(payload)) return -1;
    MQTTClient_message message = MQTTClient_message_initializer;
    MQTTClient_deliveryToken token;
    message.payload = payload;
    message.payloadlen = payloadLength;
    message.qos = 1;
    int rc = MQTTClient_publishMessage(client, topic, &message, &token);
    if (rc == MQTTCLIENT_SUCCESS)
        rc = MQTTClient_waitForCompletion(client, token, 10000);
    if (rc == MQTTCLIENT_SUCCESS)
        printf("[environment] thresholds updated from cloud\n");
    return rc;
}
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
        if (rc == MQTTCLIENT_SUCCESS)
            rc = MQTTClient_setCallbacks(client, NULL, NULL, CommandArrived, NULL);
        if (rc == MQTTCLIENT_SUCCESS) rc = MQTTClient_connect(client, &options);
        if (rc == MQTTCLIENT_SUCCESS) {
            rc = MQTTClient_subscribe(client,
                "$oc/devices/" ENV_DEVICE_ID "/sys/commands/#", 1);
        }
        if (rc == MQTTCLIENT_SUCCESS) {
            backoff = 2;
            printf("[environment] MQTT connected\n");
            while (wifiConnected && MQTTClient_isConnected(client)) {
                ThresholdCommand command;
                if (osMessageQueueGet(commandQueue, &command, NULL, 0) == osOK &&
                    ApplyCommand(client, &command) != MQTTCLIENT_SUCCESS) break;
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
    char saved[128] = {0};
    EnvironmentThresholds restored;
    if (UtilsGetValue("env.thresholds", saved, sizeof(saved)) >= 0 &&
        sscanf(saved, "%d,%f,%f,%d,%f,%f,%d,%f,%f",
            &restored.temperatureEnabled, &restored.temperatureLow,
            &restored.temperatureHigh, &restored.humidityEnabled,
            &restored.humidityLow, &restored.humidityHigh,
            &restored.gasEnabled, &restored.gasLow, &restored.gasHigh) == 9 &&
        ValidThresholds(&restored)) {
        currentThresholds = restored;
        printf("[environment] restored cloud thresholds\n");
    }
    queue = osMessageQueueNew(1, sizeof(Reading), NULL);
    commandQueue = osMessageQueueNew(2, sizeof(ThresholdCommand), NULL);
    thresholdsMutex = osMutexNew(NULL);
    if (!queue || !commandQueue || !thresholdsMutex) return;
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
