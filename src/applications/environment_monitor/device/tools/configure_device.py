#!/usr/bin/env python3
"""Generate an ignored firmware header from environment variables (never print secrets)."""

import json
import os
import re
from pathlib import Path


def main():
    names = [
        "WIFI_SSID",
        "WIFI_PASSWORD",
        "DEVICE_ID",
        "MQTT_CLIENT_ID",
        "MQTT_PASSWORD",
        "MQTT_URI",
        "MQTT_CA_FILE",
    ]
    values = {name: os.environ.get("ENV_" + name, "") for name in names}
    missing = [name for name, value in values.items() if not value]
    if missing:
        raise SystemExit(
            "Missing environment variables: " + ", ".join("ENV_" + n for n in missing)
        )
    if not values["MQTT_URI"].startswith("ssl://"):
        raise SystemExit("ENV_MQTT_URI must use ssl://host:8883")
    service = os.environ.get("ENV_SERVICE_ID", "Environment")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", service):
        raise SystemExit("Invalid ENV_SERVICE_ID")
    if not re.fullmatch(r"[A-Za-z0-9_-]+", values["DEVICE_ID"]):
        raise SystemExit("Invalid ENV_DEVICE_ID")
    if (
        len(values["WIFI_SSID"].encode()) > 32
        or len(values["WIFI_PASSWORD"].encode()) > 64
    ):
        raise SystemExit("Wi-Fi configuration is too long")
    ca = Path(values.pop("MQTT_CA_FILE")).read_text()
    if "-----BEGIN CERTIFICATE-----" not in ca:
        raise SystemExit("CA file must contain a PEM certificate")
    values.update(
        SERVICE_ID=service,
        MQTT_CA_PEM=ca,
        NTP_SERVER=os.environ.get("ENV_NTP_SERVER", "pool.ntp.org"),
    )
    target = Path(__file__).resolve().parents[1] / "environment_config.h"
    interval = int(os.environ.get("ENV_REPORT_INTERVAL_SECONDS", "30"))
    if not 10 <= interval <= 3600:
        raise SystemExit("ENV_REPORT_INTERVAL_SECONDS must be 10..3600")
    target.write_text(
        "/* Generated locally. Do not commit credentials. */\n"
        + "#define ENV_REPORT_INTERVAL_SECONDS "
        + str(interval)
        + "\n"
        + "\n".join(
            "#define ENV_" + k + " " + json.dumps(v, ensure_ascii=True)
            for k, v in values.items()
        )
        + "\n"
    )
    target.chmod(0o600)
    print("Device configuration generated. Values omitted.")


if __name__ == "__main__":
    main()
