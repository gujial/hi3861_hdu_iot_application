#ifndef ENVIRONMENT_CLOUD_H
#define ENVIRONMENT_CLOUD_H
typedef struct {
    float temperatureLow, temperatureHigh;
    float humidityLow, humidityHigh;
    float gasLow, gasHigh;
    int temperatureEnabled, humidityEnabled, gasEnabled;
} EnvironmentThresholds;
/* Sampling never waits for a network operation. A full queue drops old readings. */
void EnvironmentCloudInit(void);
void EnvironmentCloudReport(float temperature, float humidity, float gasResistance);
void EnvironmentCloudGetThresholds(EnvironmentThresholds *thresholds);
#endif
