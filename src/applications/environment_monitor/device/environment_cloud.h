#ifndef ENVIRONMENT_CLOUD_H
#define ENVIRONMENT_CLOUD_H
/* Sampling never waits for a network operation. A full queue drops old readings. */
void EnvironmentCloudInit(void);
void EnvironmentCloudReport(float temperature, float humidity, float gasResistance);
#endif
