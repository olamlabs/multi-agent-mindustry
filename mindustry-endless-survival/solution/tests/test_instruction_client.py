"""Exercise the documented client against refused and mixed-result responses."""
import io
import json
import os
from pathlib import Path
import unittest
import urllib.error
from unittest.mock import patch

class Response(io.StringIO):
    pass

class InstructionClientTests(unittest.TestCase):
    def setUp(self):
        text = (Path(__file__).resolve().parents[2] / "instruction.md").read_text()
        example = text.split("```python\n", 1)[1].split("```", 1)[0]
        self.client = {}
        exec(compile(example.split("players = call(", 1)[0], "instruction.md", "exec"), self.client)
        self.client["open"] = lambda *_args, **_kwargs: io.StringIO("test-only\n")
        self.environment = patch.dict(os.environ, {
            "MINDUSTRY_SIM_URL": "http://unused.invalid", "MINDUSTRY_SEAT_TOKEN": "test-only",
        })
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def invoke(self, result):
        with patch("urllib.request.urlopen", return_value=Response(json.dumps(result))):
            return self.client["call"]("/act", {"ops": []})

    def test_mixed_batch_raises_and_retains_successful_operations(self):
        result = {"results": [
            {"index": 0, "ok": True, "effect": {"queued": 1}, "error": None},
            {"index": 1, "ok": False, "effect": None,
             "error": {"code": "out_of_range", "message": "outside transfer range"}},
        ]}
        with self.assertRaises(self.client["GameAPIError"]) as caught:
            self.invoke(result)
        self.assertIs(caught.exception.response["results"][0]["ok"], True)
        self.assertIn("input 1: out_of_range", str(caught.exception))

    def test_success_is_returned(self):
        result = {"results": [{"index": 0, "ok": True, "effect": {"queued": 1}}]}
        self.assertEqual(self.invoke(result), result)

    def test_streamed_error_with_http_success_raises(self):
        with self.assertRaises(self.client["GameAPIError"]) as caught:
            self.invoke({"error": "engine failed after response headers"})
        self.assertIn("engine failed", str(caught.exception))

    def test_http_failure_body_is_preserved(self):
        body = {"error": "timeout_sec belongs in the URL", "status": {"phase": "running"}}
        failure = urllib.error.HTTPError("http://unused.invalid/wait", 400, "bad request", {},
                                         io.BytesIO(json.dumps(body).encode()))
        with patch("urllib.request.urlopen", side_effect=failure):
            with self.assertRaises(self.client["GameAPIError"]) as caught:
                self.client["call"]("/wait", {"timeout_sec": 10})
        self.assertEqual(caught.exception.response, body)
        self.assertIn("HTTP 400", str(caught.exception))

if __name__ == "__main__":
    unittest.main()
