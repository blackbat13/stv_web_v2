import io
import os
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

from app import CHECKER, MAX_INPUT_SIZE, app, run_checker


SAMPLE = Path(__file__).resolve().parents[1] / "model_checkers" / "stv_v2" / "sample_input" / "Voters1Candidates2.txt"


class RequestTests(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()

    def upload(self, content, action="generate"):
        return self.client.post(
            "/api/models",
            data={"file": (io.BytesIO(content), "model.txt"), "action": action},
        )

    def test_bad_requests(self):
        self.assertEqual(self.client.post("/api/models").status_code, 400)
        self.assertEqual(self.upload(b"").status_code, 400)
        self.assertEqual(self.upload(b"\xff").status_code, 400)
        self.assertEqual(self.upload(b"x", "unknown").status_code, 400)
        self.assertIn(self.upload(b"x" * (MAX_INPUT_SIZE + 1)).status_code, (400, 413))

    def test_timeout_is_reported(self):
        with patch("app.subprocess.run", side_effect=subprocess.TimeoutExpired("stv", 120)):
            response = self.upload(b"model")
        self.assertEqual(response.status_code, 422)
        self.assertIn("timed out", response.json["error"])


@unittest.skipUnless(os.name == "posix" and CHECKER.is_file(), "Requires the Linux STV checker")
class CheckerIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sample = SAMPLE.read_bytes()

    def test_generate_and_verify_true(self):
        generated = run_checker(self.sample, False)
        self.assertIsNone(generated["result"])
        self.assertEqual([graph["name"] for graph in generated["graphs"]], ["Global model", "Coercer1", "Voter1"])
        self.assertEqual(len(generated["graphs"][0]["nodes"]), 15)
        self.assertTrue(all(edge["data"]["kind"] != "strategy" for edge in generated["graphs"][0]["edges"]))
        verified = run_checker(self.sample, True)
        self.assertIs(verified["result"], True)
        self.assertTrue(any(edge["data"]["kind"] == "strategy" for edge in verified["graphs"][0]["edges"]))
        voter = verified["graphs"][2]
        self.assertEqual(sum(edge["data"]["source"] == "1" and edge["data"]["target"] == "3" for edge in voter["edges"]), 2)

    def test_verify_false_and_invalid_model(self):
        false_sample = self.sample[:self.sample.index(b"FORMULA:")] + b"FORMULA: <<Coercer1>><>((Voter1_vote == 99))\n"
        verified = run_checker(false_sample, True)
        self.assertIs(verified["result"], False)
        self.assertTrue(all(edge["data"]["kind"] != "strategy" for edge in verified["graphs"][0]["edges"]))
        with app.test_client() as client:
            response = client.post("/api/models", data={"file": (io.BytesIO(b"invalid model"), "bad.txt"), "action": "generate"})
        self.assertEqual(response.status_code, 422)
        self.assertIn("parse error", response.json["error"].lower())


if __name__ == "__main__":
    unittest.main()
