/* Minimal bounded SNTP bootstrap for TLS certificate validity checks. */
#include "environment_config.h"
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <sys/time.h>
#include "cmsis_os2.h"
#include "hi_systick.h"
#include "lwip/sockets.h"
#include "lwip/netdb.h"

static int SyncServer(const char *server)
{
    struct addrinfo hints = {0}, *address = NULL;
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_DGRAM;
    if (getaddrinfo(server, "123", &hints, &address) != 0) {
        printf("[environment] NTP DNS failed: %s\n", server);
        return -1;
    }
    int fd = socket(address->ai_family, address->ai_socktype, address->ai_protocol);
    if (fd < 0) {
        printf("[environment] NTP socket failed: %s\n", server);
        freeaddrinfo(address);
        return -1;
    }
    struct timeval timeout = {5, 0};
    int result = -1;
    unsigned char request[48] = {0}, response[48] = {0};
    request[0] = 0x23; /* NTP v4, client mode. */
    static uint32_t sequence;
    uint32_t nonce = osKernelGetTickCount() ^ ++sequence;
    memcpy(request + 40, &nonce, sizeof(nonce));
    request[47] = 1;
    int received = -1;
    if (setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout)) == 0 &&
        connect(fd, address->ai_addr, address->ai_addrlen) == 0 &&
        send(fd, request, sizeof(request), 0) == sizeof(request)) {
        received = recv(fd, response, sizeof(response), 0);
    }
    if (received == sizeof(response) &&
        (response[0] & 7) == 4 && (response[0] >> 6) != 3 &&
        ((response[0] >> 3) & 7) >= 3 && response[1] > 0 && response[1] < 16 &&
        memcmp(response + 24, request + 40, 8) == 0) {
        uint32_t seconds = (uint32_t)response[40] << 24 | (uint32_t)response[41] << 16 |
                           (uint32_t)response[42] << 8 | response[43];
        if (seconds >= 3913056000UL) { /* 2024-01-01 in NTP era zero. */
            hi_systick_set_real_time(seconds - 2208988800UL);
            result = 0;
            printf("[environment] time synchronized via %s\n", server);
        }
    }
    if (result != 0) {
        printf("[environment] NTP %s failed (%s)\n", server,
               received < 0 ? "timeout/network" : "invalid response");
    }
    closesocket(fd);
    freeaddrinfo(address);
    return result;
}

int EnvironmentSyncTime(void)
{
    if (hi_systick_get_real_time() >= 1704067200) return 0;
    static const char *servers[] = {
        ENV_NTP_SERVER,
        "ntp.ntsc.ac.cn",
        "time.pool.aliyun.com",
        "cn.pool.ntp.org",
    };
    for (unsigned int i = 0; i < sizeof(servers) / sizeof(servers[0]); ++i) {
        if (i > 0 && strcmp(servers[i], ENV_NTP_SERVER) == 0) continue;
        if (SyncServer(servers[i]) == 0) return 0;
    }
    return -1;
}
