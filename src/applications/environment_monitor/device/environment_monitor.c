/*
 * Copyright (C) 2021 HiHope Open Source Organization .
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 *
 * limitations under the License.
 */

#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

#include "cmsis_os2.h"
#include "hi_io.h"
#include "iot_errno.h"
#include "iot_gpio.h"
#include "iot_i2c.h"
#include "iot_pwm.h"
#include "ohos_init.h"
// #include "iot_adc.h"
#include "aht20.h"
#include "oled_ssd1306.h"

#include "hi_adc.h"
#include "securec.h"
#include <math.h>
#ifdef ENVIRONMENT_CLOUD_ENABLED
#include "environment_cloud.h"
#include "environment_config.h"
#else
#define ENV_LOCAL_TEMP_LOW 0.0f
#define ENV_LOCAL_TEMP_HIGH 35.0f
#define ENV_LOCAL_HUMIDITY_LOW 20.0f
#define ENV_LOCAL_HUMIDITY_HIGH 50.0f
#define ENV_LOCAL_GAS_ALARM_ENABLED 0
#define ENV_LOCAL_GAS_LOW 0.0f
#define ENV_LOCAL_GAS_HIGH 100.0f
#endif

// #ifndef ARRAY_SIZE
// #define ARRAY_SIZE(a) (sizeof(a) / sizeof((a)[0]))
// #endif

#define MS_PER_S 1000

#define BEEP_TIMES 3
#define BEEP_DURATION 100
#define BEEP_PWM_DUTY 50
#define BEEP_PWM_FREQ 4000
#define BEEP_PIN_NAME 9
#define BEEP_PIN_FUNCTION 5
#define WIFI_IOT_PWM_PORT_PWM0 0

#define GAS_SENSOR_CHAN_NAME 5
// #define GAS_SENSOR_PIN_NAME WIFI_IOT_IO_NAME_GPIO_11

#define AHT20_BAUDRATE (400 * 1000)
#define AHT20_I2C_IDX 0

#define ADC_RESOLUTION 2048
#define STACK_SIZE 4096
#define DELAY_500MS 500000
#define IDX_0 0
#define IDX_1 1
#define IDX_2 2
#define IDX_3 3
#define IDX_4 4
#define IDX_5 5
#define IDX_6 6
#define VOLTAGE_5V (5.0)
#define EPS (1e-7)

static float ConvertToVoltage(unsigned short data) {
  return (float)data * 1.8 * 4 / 4096;
}

static void SoundAlarm(int gasAlarm) {
  int pulses = gasAlarm ? 3 : 1;
  unsigned int onTime = gasAlarm ? 150000 : DELAY_500MS;
  for (int i = 0; i < pulses; ++i) {
    IoTPwmStart(WIFI_IOT_PWM_PORT_PWM0, BEEP_PWM_DUTY, BEEP_PWM_FREQ);
    usleep(onTime);
    IoTPwmStop(WIFI_IOT_PWM_PORT_PWM0);
    if (gasAlarm)
      usleep(100000);
  }
}

static void EnvironmentMonitorTask(void *argument) {
  (void)argument;
  int ret = 0;
  uint32_t retval = 0;
  float humidity = 0.0f;
  float temperature = 0.0f;
  float gasSensorResistance = 0.0f;
  static char line[32] = {0};

  OledInit();
  OledFillScreen(0);
  IoTI2cInit(AHT20_I2C_IDX, AHT20_BAUDRATE);

  // set BEEP pin as PWM function
  IoTGpioInit(BEEP_PIN_NAME);
  retval = hi_io_set_func(BEEP_PIN_NAME, BEEP_PIN_FUNCTION);
  if (retval != IOT_SUCCESS) {
    printf("IoTGpioInit(9) failed, %0X!\n", retval);
  }
  IoTGpioSetDir(BEEP_PIN_NAME, IOT_GPIO_DIR_OUT);
  IoTPwmInit(WIFI_IOT_PWM_PORT_PWM0);

  for (int i = 0; i < BEEP_TIMES; i++) {
    // ret = snprintf(line, sizeof(line), "beep %d/%d", (i + 1), BEEP_TIMES);
    ret = snprintf_s(line, sizeof(line), sizeof(line) - 1, "beep %d/%d",
                     (i + 1), BEEP_TIMES);
    if (ret < 0) {
      continue;
    }

    OledShowString(0, IDX_0, line, 1);

    IoTPwmStart(WIFI_IOT_PWM_PORT_PWM0, BEEP_PWM_DUTY, BEEP_PWM_FREQ);
    usleep(BEEP_DURATION * MS_PER_S);
    IoTPwmStop(WIFI_IOT_PWM_PORT_PWM0);
    usleep((MS_PER_S - BEEP_DURATION) * MS_PER_S);
  }

  while (IOT_SUCCESS != AHT20_Calibrate()) {
    printf("AHT20 sensor init failed!\r\n");
    usleep(MS_PER_S);
  }

  while (1) {
    retval = AHT20_StartMeasure();
    if (retval != IOT_SUCCESS) {
      printf("trigger measure failed!\r\n");
      usleep(DELAY_500MS);
      continue;
    }

    usleep(80 * 1000);
    retval = AHT20_GetMeasureResult(&temperature, &humidity);
    if (retval != IOT_SUCCESS) {
      printf("get humidity data failed!\r\n");
      usleep(DELAY_500MS);
      continue;
    }

    int gasValid = 0;
    unsigned short data = 0;
    ret = hi_adc_read(GAS_SENSOR_CHAN_NAME, &data, HI_ADC_EQU_MODEL_4,
                      HI_ADC_CUR_BAIS_DEFAULT, 0);
    if (ret == IOT_SUCCESS) {
      float Vx = ConvertToVoltage(data);
      // Vcc            ADC            GND
      //  |    ______   |     ______   |
      //  +---| MG-2 |---+---| 1kom |---+
      //       ------         ------
      // 查阅原理图，ADC 引脚位于 1K 电阻和燃气传感器之间，燃气传感器另一端接在
      // 5V 电源正极上 串联电路电压和阻止成正比： Vx / 5 == 1kom / (1kom + Rx)
      //   => Rx + 1 == 5/Vx
      //   =>  Rx = 5/Vx - 1
      if (Vx > EPS && Vx < VOLTAGE_5V) {
        gasSensorResistance = VOLTAGE_5V / Vx - 1;
        gasValid = 1;
        printf("\r\n hi_adc_read ok, data=%hu, vx=%f, gasSensorResistance=%f",
               data, Vx, gasSensorResistance);
      }
    } else {
      printf("\r\n hi_adc_read fail, ret=%d", ret);
    }

#ifdef ENVIRONMENT_CLOUD_ENABLED
    if (gasValid && isfinite(temperature) && isfinite(humidity)) {
      EnvironmentCloudReport(temperature, humidity, gasSensorResistance);
    }
#endif
    OledShowString(0, IDX_5, "                ", 1);
    OledShowString(0, IDX_6, "                ", 1);
    OledShowString(0, IDX_0, "Sensor values:", 1);

    // ret = snprintf(line, sizeof(line), "temp: %.2f", temperature);
    ret = snprintf_s(line, sizeof(line), sizeof(line) - 1, "temp: %.2f",
                     temperature);
    if (ret < 0) {
      continue;
    }
    OledShowString(0, IDX_1, line, 1);

    // ret = snprintf(line, sizeof(line), "humi: %.2f", humidity);
    ret = snprintf_s(line, sizeof(line), sizeof(line) - 1, "humi: %.2f",
                     humidity);
    if (ret < 0) {
      continue;
    }
    OledShowString(0, IDX_2, line, 1);

    // ret = snprintf(line, sizeof(line), "gas: %.2f kom", gasSensorResistance);
    ret = gasValid ? snprintf_s(line, sizeof(line), sizeof(line) - 1,
                                "gas: %.2f kom", gasSensorResistance)
                   : snprintf_s(line, sizeof(line), sizeof(line) - 1,
                                "gas: error      ");
    if (ret < 0) {
      continue;
    }
    OledShowString(0, IDX_3, line, 1);

    int temperatureAlarm =
        temperature > ENV_LOCAL_TEMP_HIGH || temperature < ENV_LOCAL_TEMP_LOW;
    int humidityAlarm =
        humidity < ENV_LOCAL_HUMIDITY_LOW || humidity > ENV_LOCAL_HUMIDITY_HIGH;
    int gasAlarm = ENV_LOCAL_GAS_ALARM_ENABLED && gasValid &&
                   (gasSensorResistance < ENV_LOCAL_GAS_LOW ||
                    gasSensorResistance > ENV_LOCAL_GAS_HIGH);
    if (gasAlarm) {
      OledShowString(0, IDX_5, "GAS WARNING!!!  ", 1);
      if (temperatureAlarm || humidityAlarm)
        OledShowString(0, IDX_6, "TEMP/HUMI WARN! ", 1);
    } else {
      if (temperatureAlarm)
        OledShowString(0, IDX_5, "temp abnormal!!", 1);
      if (humidityAlarm)
        OledShowString(0, temperatureAlarm ? IDX_6 : IDX_5, "humi abnormal!!",
                       1);
    }
    if (gasAlarm || temperatureAlarm || humidityAlarm)
      SoundAlarm(gasAlarm);

    usleep(DELAY_500MS);
  }
}

static void EnvironmentMonitorInit(void) {
  osThreadAttr_t attr;
#ifdef ENVIRONMENT_CLOUD_ENABLED
  EnvironmentCloudInit();
#endif

  IoTGpioInit(BEEP_PIN_NAME);
  hi_io_set_func(BEEP_PIN_NAME, BEEP_PIN_FUNCTION);
  IoTPwmInit(WIFI_IOT_PWM_PORT_PWM0);

  attr.name = "EnvironmentMonitor";
  attr.attr_bits = 0U;
  attr.cb_mem = NULL;
  attr.cb_size = 0U;
  attr.stack_mem = NULL;
  attr.stack_size = STACK_SIZE;
  attr.priority = osPriorityNormal;

  if (osThreadNew(EnvironmentMonitorTask, NULL, &attr) == NULL) {
    printf("[EnvironmentMonitor] Failed to create monitor task!\n");
  }
}

APP_FEATURE_INIT(EnvironmentMonitorInit);
