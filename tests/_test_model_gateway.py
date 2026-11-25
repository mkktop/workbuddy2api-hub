"""Exercise the prefixed model API through the real HTTP handler."""

import http.client
import io
import json
import os
import sys
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from _isolated_dirs import isolated_data_dirs

_DATA = isolated_data_dirs("wb-model-gateway-")
ACCOUNTS = os.environ["ACCOUNTS_DIR"]

import wb_model_gateway as routing
import wb_proxy as gateway
import wb_settings as settings


KEY = "multi-route-test-key"
BOUND_KEY = "domestic-test-key"
ACCOUNT_KEY = "account-scoped-test-key"
MODEL = "example/shared-model"
CN_MODEL = "wb-cn/" + MODEL
INTL_MODEL = "wb-intl/" + MODEL
MESSAGES = [{"role": "user", "content": "ping"}]
OPEN_WITH_FALLBACK = gateway.open_upstream_with_fallback


def sse_events(body):
    return [json.loads(line[6:]) for line in body.splitlines()
            if line.startswith("data: {")]


class ModelGatewayTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        settings.set_enable_anthropic_messages(ACCOUNTS, True)
        settings.set_api_keys(ACCOUNTS, [
            {"id": "multi-key", "key": KEY,
             "models": ["wb-cn/*", INTL_MODEL, "fixture/*", "codearts/*", "offline/*"]},
            {"id": "cn-key", "key": BOUND_KEY, "realm": "cn", "models": ["*"]},
            {"id": "account-key", "key": ACCOUNT_KEY, "accounts": ["mock-account"]},
        ])
        cls.server = gateway.GatewayServer(("127.0.0.1", 0), gateway.Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)

    def setUp(self):
        self.calls = []

        def fixture_invoke(handler, payload):
            selected = routing.current_route()
            self.calls.append((selected.provider.id, payload["model"], False))
            gateway.record_usage(payload["model"], {"total_tokens": 3}, key=handler._key_id())
            return handler._json(200, {"model": selected.public_model})

        extra = routing.Provider(
            "fixture", lambda: [{"id": "model", "object": "model"}],
            {"chat": fixture_invoke}, lambda: True)
        regions = tuple(gateway.MODEL_GATEWAY.providers.values())
        self.use(gateway, "MODEL_GATEWAY", routing.Registry(regions + (extra,)))
        self.use(gateway, "fetch_models", lambda realm=None: [
            (MODEL, {}), ("domestic-catalogue-model" if realm == "cn" else "intl-other", {})])
        self.use(gateway, "open_upstream_with_fallback", self.open_upstream)
        self.use(gateway, "API_KEY", None)
        self.use(gateway, "POOL", None)
        self.use(gateway, "USAGE_LOG", os.path.join(os.environ["WB_PROXY_USAGE_DIR"], "usage.jsonl"))
        if os.path.exists(gateway.USAGE_LOG):
            os.unlink(gateway.USAGE_LOG)
        self.conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=8)
        self.addCleanup(self.conn.close)

    def use(self, obj, name, value):
        patcher = patch.object(obj, name, value)
        patcher.start()
        self.addCleanup(patcher.stop)

    def open_upstream(self, payload, *, target_realm, allow_realm_fallback, **kwargs):
        self.calls.append((target_realm, payload["model"], allow_realm_fallback))
        chunk = {"id": "chatcmpl-stub", "object": "chat.completion.chunk",
                 "model": payload["model"], "choices": [
                     {"index": 0, "delta": {"role": "assistant", "content": "pong"}, "finish_reason": None}]}
        final = dict(chunk, choices=[{"index": 0, "delta": {}, "finish_reason": "stop"}],
                     usage={"prompt_tokens": 2, "completion_tokens": 1, "total_tokens": 3})
        stream = io.BytesIO(("data: " + json.dumps(chunk) + "\n\ndata: " +
                             json.dumps(final) + "\n\ndata: [DONE]\n\n").encode())
        stream._wb_billed_model = "upstream-resolved-model"
        stream._wb_account_uid = "mock-account"
        return stream, SimpleNamespace(uid="mock-account", realm=target_realm), None

    def request(self, path, payload=None, key=KEY, extra_headers=None):
        headers = {"Content-Type": "application/json"}
        if key:
            headers["Authorization"] = "Bearer " + key
        headers.update(extra_headers or {})
        self.conn.request("GET" if payload is None else "POST", path,
                          json.dumps(payload) if payload is not None else None, headers)
        response = self.conn.getresponse()
        data = response.read().decode()
        return response.status, data if "text/event-stream" in (response.getheader("Content-Type") or "") else json.loads(data)

    def chat(self, model, **extra):
        return {"model": model, "messages": MESSAGES, **extra}

    def test_catalogue_and_key_policy_match(self):
        status, doc = self.request("/v1/models?realm=codearts")
        self.assertEqual(status, 200, doc)
        rows = {row["id"]: row for row in doc["data"]}
        self.assertEqual(set(rows), {CN_MODEL, INTL_MODEL, "wb-cn/domestic-catalogue-model", "fixture/model"})
        self.assertEqual(rows[CN_MODEL]["route_id"], "wb-cn")
        self.assertEqual(rows[CN_MODEL]["upstream_model"], MODEL)
        self.assertIn("responses", rows[INTL_MODEL]["gateway_operations"])
        _, bound = self.request("/v1/models", key=BOUND_KEY)
        self.assertEqual({row["route_id"] for row in bound["data"]}, {"wb-cn"})
        self.assertEqual(self.request("/v1/models", key=None)[0], 401)

    def test_route_failures_stop_before_inference(self):
        cases = [("bare-model", 400, "invalid_model_id"),
                 ("missing/model", 404, "route_not_found"),
                 ("wb-cn/not-found", 404, "model_not_found"),
                 ("wb-intl/intl-other", 403, "model_not_allowed"),
                 ("codearts/model", 503, "route_unavailable")]
        for model, expected, code in cases:
            status, body = self.request("/v1/chat/completions", self.chat(model))
            self.assertEqual((status, body["error"]["code"]), (expected, code))
        self.assertEqual(self.request("/v1/chat/completions", self.chat(INTL_MODEL), key=BOUND_KEY)[0], 403)
        self.assertEqual(self.request("/v1/responses", {"model": "fixture/model", "input": "ping"})[0], 400)
        self.assertEqual(self.request("/gateway/settings/save", {})[0], 404)
        self.assertEqual(self.calls, [])

    def test_one_click_setup_writes_public_model_ids(self):
        base_url = "http://127.0.0.1:8788/v1"
        agents = gateway.agents_module()
        self.use(gateway.Handler, "_agents_client_allowed", lambda self: True)
        with patch.object(agents, "integrate", return_value={}) as integrate:
            status, result = self.request("/agents/apply", {
                "client": "codex", "base_url": base_url, "realm": "cn",
                "model": MODEL, "models": [{"id": MODEL}, {"id": INTL_MODEL}],
            }, extra_headers={"X-Panel-Token": gateway.PANEL.create()})
        self.assertEqual(status, 200, result)
        self.assertEqual(integrate.call_args.args[2], base_url)
        self.assertEqual(integrate.call_args.kwargs["model"], CN_MODEL)
        self.assertEqual([item["id"] for item in integrate.call_args.kwargs["models"]],
                         [CN_MODEL, INTL_MODEL])

    def test_protocols_use_same_route_and_echo_public_id(self):
        status, result = self.request("/v1/chat/completions?realm=intl", self.chat(CN_MODEL),
                                      extra_headers={"X-Realm": "codearts"})
        self.assertEqual(status, 200, result)
        self.assertEqual(result["model"], CN_MODEL)
        self.assertEqual(result["choices"][0]["message"]["content"], "pong")
        status, raw = self.request("/v1/chat/completions", self.chat(INTL_MODEL, stream=True))
        self.assertEqual(status, 200, raw)
        self.assertEqual({e["model"] for e in sse_events(raw)}, {INTL_MODEL})
        status, result = self.request("/v1/responses", {"model": INTL_MODEL, "input": "ping"})
        self.assertEqual((status, result.get("model")), (200, INTL_MODEL), result)
        status, raw = self.request("/v1/responses", {"model": CN_MODEL, "input": "ping", "stream": True})
        self.assertEqual(status, 200, raw)
        self.assertEqual({e["response"]["model"] for e in sse_events(raw) if "response" in e}, {CN_MODEL})
        status, result = self.request("/v1/messages", self.chat(INTL_MODEL, max_tokens=32))
        self.assertEqual((status, result.get("model")), (200, INTL_MODEL), result)
        status, raw = self.request("/v1/messages", self.chat(CN_MODEL, max_tokens=32, stream=True))
        self.assertEqual(status, 200, raw)
        self.assertEqual([e["message"]["model"] for e in sse_events(raw) if e["type"] == "message_start"], [CN_MODEL])
        status, result = self.request("/v1/messages/count_tokens", self.chat(CN_MODEL, max_tokens=32))
        self.assertEqual(status, 200, result)
        self.assertGreater(result["input_tokens"], 0)
        self.assertEqual(self.calls, [(region, MODEL, False) for region in
                                     ("cn", "intl", "intl", "cn", "intl", "cn")])
        with open(gateway.USAGE_LOG, encoding="utf-8") as rows:
            logged = [json.loads(row) for row in rows]
        self.assertEqual([r["route_id"] for r in logged], ["wb-" + c[0] for c in self.calls])
        self.assertEqual(logged[0]["requested_model"], CN_MODEL)
        self.assertEqual(logged[0]["upstream_model"], "upstream-resolved-model")
        self.assertEqual(logged[0]["account"], "mock-account")

    def test_gemini_bridge_preserves_route_key_and_status(self):
        prompt = {"contents": [{"role": "user", "parts": [{"text": "ping"}]}]}
        dom = "/v1beta/models/wb-cn%2Fexample%2Fshared-model:generateContent"
        status, result = self.request(dom + "?key=" + KEY, prompt, key=None)
        self.assertEqual((status, result.get("modelVersion")), (200, CN_MODEL), result)
        self.assertEqual(self.calls, [("cn", MODEL, False)])
        intl = dom.replace("wb-cn", "wb-intl").replace("generateContent", "streamGenerateContent")
        status, result = self.request(intl, prompt, key=None, extra_headers={"x-goog-api-key": BOUND_KEY})
        self.assertEqual((status, result["error"]["status"]), (403, "PERMISSION_DENIED"))
        self.assertEqual(len(self.calls), 1)

    def test_new_adapter_registers_without_an_http_route(self):
        status, result = self.request("/v1/chat/completions", self.chat("fixture/model"))
        self.assertEqual((status, result.get("model")), (200, "fixture/model"), result)
        self.assertEqual(self.calls, [("fixture", "model", False)])
        def broken_catalog():
            raise OSError("private token")

        unavailable = routing.Provider("offline", broken_catalog,
                                       {"chat": lambda *args: None}, lambda: True)
        registry = routing.Registry(tuple(gateway.MODEL_GATEWAY.providers.values()) + (unavailable,))
        self.use(gateway, "MODEL_GATEWAY", registry)
        status, result = self.request("/v1/models")
        self.assertEqual(status, 200, result)
        self.assertIn("offline", result["unavailable_routes"])
        status, result = self.request("/v1/chat/completions", self.chat("offline/model"))
        self.assertEqual((status, result["error"]["code"]), (503, "catalog_unavailable"))
        self.assertNotIn("private token", json.dumps(result))

    def test_chat_adapter_reuses_codecs_and_receives_account_scope(self):
        def cross_platform_lookup(uid):
            self.fail("external usage touched the WorkBuddy account pool: " + uid)

        def open_chat(payload, *, session_key, allowed_accounts):
            self.assertEqual(allowed_accounts, {"mock-account"})
            selected = routing.current_route()
            return self.open_upstream(payload, target_realm=selected.usage_realm,
                                      allow_realm_fallback=False)

        adapter = routing.Provider(
            "new-platform", lambda: [{"id": MODEL}], gateway.TEXT_MODEL_OPERATIONS,
            lambda: True, open_chat=open_chat, account_ids=lambda: ["mock-account"])
        registry = routing.Registry(tuple(gateway.MODEL_GATEWAY.providers.values()) + (adapter,))
        self.use(gateway, "MODEL_GATEWAY", registry)
        self.use(gateway, "open_upstream_with_fallback", OPEN_WITH_FALLBACK)
        self.use(gateway, "POOL", SimpleNamespace(accounts=[], get=cross_platform_lookup))
        status, catalogue = self.request("/v1/models", key=ACCOUNT_KEY)
        public_model = "new-platform/" + MODEL
        self.assertEqual(status, 200)
        self.assertEqual([row["id"] for row in catalogue["data"]], [public_model])
        self.assertEqual(self.request("/v1/chat/completions",
                                      self.chat("fixture/model"), key=ACCOUNT_KEY)[0], 403)
        status, response = self.request("/v1/responses",
                                        {"model": public_model, "input": "ping"}, key=ACCOUNT_KEY)
        self.assertEqual((status, response.get("model")), (200, public_model), response)
        status, response = self.request("/v1/messages",
                                        self.chat(public_model, max_tokens=32), key=ACCOUNT_KEY)
        self.assertEqual((status, response.get("model")), (200, public_model), response)
        self.assertEqual(self.calls, [("new-platform", MODEL, False)] * 2)

    def test_selected_route_failure_does_not_use_legacy_fallback(self):
        def failed_upstream(payload, *, target_realm, **kwargs):
            self.calls.append(target_realm)
            raise RuntimeError("no usable account for " + target_realm)

        self.use(gateway, "open_upstream_with_fallback", OPEN_WITH_FALLBACK)
        self.use(gateway, "open_upstream", failed_upstream)
        self.use(gateway, "realm_fallback_enabled", lambda: True)
        self.use(gateway, "realm_fallback_target", lambda *args: "cn")
        status, result = self.request("/v1/chat/completions", self.chat(INTL_MODEL))
        self.assertEqual(status, 503, result)
        self.assertEqual(self.calls, ["intl"])
        with open(gateway.USAGE_LOG, encoding="utf-8") as rows:
            row = json.loads(rows.readline())
        self.assertEqual((row["route_id"], row["realm"]), ("wb-intl", "intl"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
