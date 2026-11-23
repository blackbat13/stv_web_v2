import io
import os
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

from app import CHECKER, MAX_FORMULA_SIZE, MAX_INPUT_SIZE, MAX_OUTPUT_SIZE, ROOT, ModelError, app, extract_formula, run_checker


SAMPLE = Path(__file__).resolve().parents[1] / "model_checkers" / "stv_v2" / "sample_input" / "Voters1Candidates2.txt"


class RequestTests(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()

    def upload(self, content, action="generate", formula=None, **options):
        data = {"file": (io.BytesIO(content), "model.txt"), "action": action}
        if formula is not None:
            data["formula"] = formula
        data.update(options)
        return self.client.post(
            "/api/models",
            data=data,
        )

    def test_bad_requests(self):
        self.assertEqual(self.client.post("/api/models").status_code, 400)
        self.assertEqual(self.upload(b"").status_code, 400)
        self.assertEqual(self.upload(b"\xff").status_code, 400)
        self.assertEqual(self.upload(b"x", "unknown").status_code, 400)
        self.assertIn(self.upload(b"x" * (MAX_INPUT_SIZE + 1)).status_code, (400, 413))
        for formula in ("", "  ", "x\0y", "x" * (MAX_FORMULA_SIZE + 1)):
            self.assertEqual(self.upload(b"model", "verify", formula).status_code, 400)

    @unittest.skipUnless((ROOT / "node_modules" / "codemirror" / "lib" / "codemirror.js").is_file(), "Requires npm install")
    def test_editor_assets(self):
        for filename in ("codemirror.js", "codemirror.css"):
            response = self.client.get(f"/assets/codemirror/{filename}")
            self.assertEqual(response.status_code, 200)
            response.close()
        self.assertEqual(self.client.get("/assets/codemirror/other.js").status_code, 404)

    def test_extract_formula_before_or_after_agents(self):
        self.assertEqual(extract_formula("Agent A:\ninit q0\nFORMULA: <<A>><>\n(x == 1)\n"), "<<A>><>\n(x == 1)")
        self.assertEqual(extract_formula("FORMULA: <<A>><>\n(x == 1)\n\nAgent A:\ninit q0\n"), "<<A>><>\n(x == 1)")
        self.assertEqual(extract_formula("Agent A:\ninit q0\n"), "")

    def test_timeout_is_reported(self):
        with patch("app.subprocess.run", side_effect=subprocess.TimeoutExpired("stv", 120)):
            response = self.upload(b"model")
        self.assertEqual(response.status_code, 422)
        self.assertIn("timed out", response.json["error"])

    def test_oversized_checker_output_is_not_silently_truncated(self):
        def fake_run(command, **kwargs):
            kwargs["stdout"].write(b"x" * (MAX_OUTPUT_SIZE + 1))
            return subprocess.CompletedProcess(command, 0)

        with patch("app.subprocess.run", side_effect=fake_run):
            response = self.upload(b"model", "verify", on_the_fly="1")
        self.assertEqual(response.status_code, 422)
        self.assertIn("output exceeds", response.json["error"])

    def test_option_validation_and_forwarding(self):
        self.assertEqual(self.upload(b"model", "verify", on_the_fly="invalid").status_code, 400)
        self.assertEqual(self.upload(b"model", "verify", on_the_fly="1", natural_strategy="1").status_code, 400)
        self.assertEqual(self.upload(b"model", "generate", counterexample="1").status_code, 400)
        with patch("app.run_checker", return_value={"graphs": [], "result": False}) as checker:
            response = self.upload(b"model", "verify", formula="x", on_the_fly="1", epsilon="1", counterexample="1")
        self.assertEqual(response.status_code, 200)
        checker.assert_called_once_with(
            b"model", True, "x", on_the_fly=True, epsilon=True, counterexample=True, natural_strategy=False
        )

    def test_warning_alone_is_not_a_counterexample(self):
        def fake_run(command, **kwargs):
            kwargs["stdout"].write(b"Verification result: FALSE\nWarning: deadlock\n")
            return subprocess.CompletedProcess(command, 0)

        with patch("app.subprocess.run", side_effect=fake_run):
            response = self.upload(b"model", "verify", on_the_fly="1", counterexample="1")
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.json["counterexample"])
        self.assertEqual(response.json["warnings"], ["Warning: deadlock"])

    def test_only_expected_config_warning_is_hidden_from_response(self):
        warning = "Warning: could not open the config file 'config.txt', using the defaults"
        error = f"Model checker failed:\n{warning}\nWarning: another warning\nModel parse error: invalid"
        with patch("app.run_checker", side_effect=ModelError(error)):
            with self.assertLogs(app.logger, level="WARNING") as logs:
                response = self.upload(b"model")
        self.assertEqual(response.status_code, 422)
        self.assertNotIn(warning, response.json["error"])
        self.assertIn("Warning: another warning", response.json["error"])
        self.assertIn("Model parse error: invalid", response.json["error"])
        self.assertIn(warning, logs.output[0])


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
        self.assertNotIn("could not open the config file", response.json["error"])

    def test_override_formula_without_changing_specification(self):
        original = self.sample
        with app.test_client() as client:
            def request_model(action, formula=None):
                data = {"file": (io.BytesIO(original), "model.txt"), "action": action}
                if formula is not None:
                    data["formula"] = formula
                return client.post("/api/models", data=data)

            generated = request_model("generate")
            self.assertEqual(generated.status_code, 200)
            self.assertEqual(generated.json["formula"], original.decode().split("FORMULA:", 1)[1].strip())
            response = request_model("verify", "<<Coercer1>><>((Voter1_vote == 99))")
            self.assertEqual(response.status_code, 200)
            self.assertIs(response.json["result"], False)
            self.assertTrue(all(edge["data"]["kind"] != "strategy" for edge in response.json["graphs"][0]["edges"]))
            response = request_model("verify", generated.json["formula"])
            self.assertIs(response.json["result"], True)
            self.assertTrue(any(edge["data"]["kind"] == "strategy" for edge in response.json["graphs"][0]["edges"]))
            response = request_model("verify", "not a formula")
            self.assertEqual(response.status_code, 422)
            self.assertIn("Invalid formula", response.json["error"])
        self.assertEqual(SAMPLE.read_bytes(), original)

    def test_formula_before_agents(self):
        agents, formula = self.sample.split(b"FORMULA:", 1)
        first = b"FORMULA:" + formula.strip() + b"\n\n" + agents
        with app.test_client() as client:
            response = client.post("/api/models", data={"file": (io.BytesIO(first), "model.txt"), "action": "generate"})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json["formula"], formula.decode().strip())

    def test_on_the_fly_verification_does_not_request_or_parse_dot_files(self):
        with patch("app.subprocess.run", wraps=subprocess.run) as command, patch("app.parse_graph") as parse:
            verified = run_checker(self.sample, True, on_the_fly=True)
        args = command.call_args.args[0]
        self.assertEqual(args[args.index("-m") + 1], "2")
        self.assertNotIn("--OUTPUT_DOT_FILES", args)
        parse.assert_not_called()
        self.assertIs(verified["result"], True)
        self.assertEqual(verified["graphs"], [])

    def test_epsilon_transitions_change_generated_model(self):
        deadlocks = self.sample.replace(b"idle: q3->q3", b"")
        regular = run_checker(deadlocks, False)
        epsilon = run_checker(deadlocks, False, epsilon=True)
        self.assertGreater(len(epsilon["graphs"][0]["edges"]), len(regular["graphs"][0]["edges"]))
        self.assertTrue(any("ɛ" in edge["data"]["label"] for edge in epsilon["graphs"][0]["edges"]))

    def test_natural_strategy_and_counterexample_output(self):
        formula = "<<Coercer1>><>((Voter1_vote == 99))"
        natural = run_checker(self.sample, True, natural_strategy=True)
        self.assertIs(natural["result"], True)
        self.assertIn("-->", natural["natural_strategy"])
        self.assertIn("Complexity after reduction:", natural["natural_strategy"])
        failed = run_checker(self.sample, True, formula, counterexample=True, natural_strategy=True)
        self.assertIs(failed["result"], False)
        self.assertEqual(failed["natural_strategy"], "No natural strategy present.")
        self.assertIn("States:", failed["counterexample"])
        self.assertIn("Decisions:", failed["counterexample"])
        self.assertNotIn("No natural strategy present.", failed["counterexample"])
        on_the_fly = run_checker(self.sample, True, formula, on_the_fly=True, counterexample=True)
        self.assertIs(on_the_fly["result"], False)
        self.assertIn("States:", on_the_fly["counterexample"])
        self.assertEqual(on_the_fly["graphs"], [])
        with self.assertRaises(ModelError):
            run_checker(self.sample, True, on_the_fly=True, natural_strategy=True)

    def test_deadlock_warning_is_separate_from_verification_outputs(self):
        deadlocks = self.sample.replace(b"idle: q3->q3", b"")
        formula = "<<Coercer1>><>((Voter1_vote == 99))"
        result = run_checker(deadlocks, True, formula, counterexample=True, natural_strategy=True)
        self.assertIn("States:", result["counterexample"])
        self.assertNotIn("Warning:", result["counterexample"])
        self.assertEqual(result["natural_strategy"], "No natural strategy present.")
        self.assertTrue(any("without outgoing transitions" in warning for warning in result["warnings"]))
        self.assertFalse(any("config.txt" in warning for warning in result["warnings"]))


if __name__ == "__main__":
    unittest.main()
