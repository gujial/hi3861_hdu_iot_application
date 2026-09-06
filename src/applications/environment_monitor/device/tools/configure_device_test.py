import contextlib
import io
import tempfile
import unittest
from pathlib import Path

from configure_device import generate


class ConfigureDeviceTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.ca = self.root / "ca.pem"
        self.ca.write_text(
            "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n"
        )
        self.env = {
            "ENV_WIFI_SSID": 'lab "wifi"',
            "ENV_WIFI_PASSWORD": "password123",
            "ENV_DEVICE_ID": "product_node",
            "ENV_MQTT_CLIENT_ID": "product_node_0_0_2026090601",
            "ENV_MQTT_PASSWORD": "ab" * 32,
            "ENV_MQTT_URI": "ssl://iot.example.com:8883",
            "ENV_MQTT_CA_FILE": str(self.ca),
            "ENV_SERVICE_ID": "Environment",
            "ENV_NTP_SERVER": "time.example.com",
            "ENV_REPORT_INTERVAL_SECONDS": "30",
        }

    def tearDown(self):
        self.temp.cleanup()

    def run_generate(self, changes=None):
        env = self.env | (changes or {})
        target = self.root / "environment_config.h"
        with contextlib.redirect_stdout(io.StringIO()):
            generate(env, target)
        return target.read_text()

    def test_generates_escaped_header_without_printing_secrets(self):
        output = io.StringIO()
        target = self.root / "environment_config.h"
        with contextlib.redirect_stdout(output):
            generate(self.env, target)
        header = target.read_text()
        self.assertIn('#define ENV_WIFI_SSID "lab \\"wifi\\""', header)
        self.assertIn('#define ENV_NTP_SERVER "time.example.com"', header)
        self.assertNotIn(self.env["ENV_MQTT_PASSWORD"], output.getvalue())
        self.assertEqual(target.stat().st_mode & 0o777, 0o600)

    def test_rejects_client_id_from_another_device(self):
        with self.assertRaisesRegex(SystemExit, "must match ENV_DEVICE_ID"):
            self.run_generate(
                {"ENV_MQTT_CLIENT_ID": "other_node_0_0_2026090601"}
            )

    def test_rejects_invalid_client_timestamp(self):
        with self.assertRaisesRegex(SystemExit, "invalid UTC timestamp"):
            self.run_generate(
                {"ENV_MQTT_CLIENT_ID": "product_node_0_0_2026134001"}
            )

    def test_rejects_non_hmac_password(self):
        with self.assertRaisesRegex(SystemExit, "64-character hexadecimal"):
            self.run_generate({"ENV_MQTT_PASSWORD": "old-password"})

    def test_rejects_insecure_or_wrong_mqtt_endpoint(self):
        for uri in ("tcp://iot.example.com:1883", "ssl://iot.example.com:1883"):
            with self.subTest(uri=uri), self.assertRaisesRegex(
                SystemExit, "ssl://host:8883"
            ):
                self.run_generate({"ENV_MQTT_URI": uri})

    def test_rejects_invalid_report_interval_and_ca(self):
        with self.assertRaisesRegex(SystemExit, "10..3600"):
            self.run_generate({"ENV_REPORT_INTERVAL_SECONDS": "5"})
        bad_ca = self.root / "bad.pem"
        bad_ca.write_text("not a certificate")
        with self.assertRaisesRegex(SystemExit, "PEM certificate"):
            self.run_generate({"ENV_MQTT_CA_FILE": str(bad_ca)})


if __name__ == "__main__":
    unittest.main()
