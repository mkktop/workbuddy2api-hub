"""Exercise the prefixed model API through the real HTTP handler."""

from email.message import Message
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
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from _isolated_dirs import isolated_data_dirs

_DATA = isolated_data_dirs("wb-model-gateway-")
ACCOUNTS = os.environ["ACCOUNTS_DIR"]

import wb_minimax
import wb_model_gateway as routing
import wb_proxy as gateway
import wb_settings as settings


KEY = "multi-route-test-key"
BOUND_KEY = "domestic-test-key"
ACCOUNT_KEY = "account-scoped-test-key"
MINIMAX_KEY = "minimax-bound-test-key"
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
             "models": ["wb-cn/*", INTL_MODEL, "fixture/*", "codearts/*", "offline/*", "minimax/*"]},
            {"id": "cn-key", "key": BOUND_KEY, "realm": "cn", "models": ["*"]},
            {"id": "account-key", "key": ACCOUNT_KEY, "accounts": ["mock-account"]},
            {"id": "minimax-key", "key": MINIMAX_KEY, "realm": "minimax"},
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

    def test_minimax_subscription_settings_catalogue_and_chat(self):
        model = "MiniMax-M3.1-Flash"
        public_model = "minimax/" + model
        subscription_key = "sk-cp-fixture-key"
        panel = {"X-Panel-Token": gateway.PANEL.create()}
        config_patch = {"enabled": True, "region": "global", "api_key": subscription_key, "models": [model]}
        self.addCleanup(settings.set_minimax_config, ACCOUNTS, {"api_key": None})
        self.use(gateway, "CURRENT_REALM", "intl")
        self.use(wb_minimax, "_catalog_cache", {})
        self.assertEqual(self.request("/v1/chat/completions", self.chat(public_model))[0], 503)
        self.assertEqual(self.request("/realm", {"realm": "minimax"}, extra_headers=panel)[0], 400)
        self.assertEqual(self.request("/settings/save", {"minimax": config_patch})[0], 401)
        self.assertEqual(self.request("/settings/save", {"minimax": dict(config_patch, api_key="payg-key")}, extra_headers=panel)[0], 400)
        status, saved = self.request("/settings/save", {"minimax": config_patch}, extra_headers=panel)
        self.assertEqual(status, 200, saved)
        self.assertEqual(saved["minimax"], {"enabled": True, "region": "global", "key_set": True, "models": [model]})
        self.assertNotIn(subscription_key, json.dumps(self.request("/settings", extra_headers=panel)[1]))
        official = {"object": "list", "data": [
            {"id": model, "object": "model", "created": 100, "owned_by": "MiniMax"},
            {"id": "MiniMax-M3", "object": "model", "created": 90, "owned_by": "MiniMax"},
        ]}
        with patch.object(wb_minimax._http, "open",
                          return_value=io.BytesIO(json.dumps(official).encode())) as discovery:
            status, catalogue = self.request("/v1/models")
            req = discovery.call_args.args[0]
            self.assertEqual(req.full_url, "https://api.minimax.io/v1/models")
            self.assertEqual(req.get_method(), "GET")
            self.assertEqual(req.get_header("Authorization"), "Bearer " + subscription_key)
            self.assertEqual(discovery.call_count, 1)
        self.assertEqual(status, 200)
        entry = next(row for row in catalogue["data"] if row["id"] == public_model)
        self.assertEqual(entry["upstream_model"], model)
        self.assertEqual(entry["route_realm"], "minimax")
        self.assertEqual(entry["created"], 100)
        self.assertEqual(entry["context_length"], 1_000_000)
        self.assertEqual(entry["max_output_tokens"], 524_288)
        self.assertNotIn("minimax/MiniMax-M3", [row["id"] for row in catalogue["data"]])
        self.assertEqual(self.request("/realm")[1]["options"][:3], ["intl", "cn", "minimax"])
        status, panel_catalogue = self.request("/panel/model-catalog?realm=minimax", extra_headers=panel)
        self.assertEqual(status, 200, panel_catalogue)
        enabled, discovered = panel_catalogue["data"]
        self.assertEqual(enabled["client_model_id"], public_model)
        self.assertEqual(discovered["id"], "minimax/MiniMax-M3")
        self.assertTrue(discovered["catalog_only"])
        self.assertNotIn("client_model_id", discovered)
        self.assertEqual(discovered["context_length"], 1_000_000)
        self.assertEqual(panel_catalogue["catalog"]["official_models"], [model, "MiniMax-M3"])
        self.assertFalse(panel_catalogue["catalog"]["stale"])
        status, legacy = self.request("/models?realm=minimax", key=MINIMAX_KEY)
        self.assertEqual(status, 200, legacy)
        self.assertEqual([row["id"] for row in legacy["data"]], [public_model])
        config = settings.minimax_config(ACCOUNTS)
        wb_minimax._catalog_cache[wb_minimax._catalog_key(config)]["checked_at"] -= wb_minimax._CATALOG_RETRY
        with patch.object(wb_minimax._http, "open", side_effect=OSError("offline")):
            status, stale_catalogue = self.request(
                "/panel/model-catalog?realm=minimax&refresh=1", extra_headers=panel)
        self.assertEqual(status, 200)
        self.assertEqual(stale_catalogue["data"], panel_catalogue["data"])
        self.assertTrue(stale_catalogue["catalog"]["stale"])
        self.assertEqual(stale_catalogue["catalog"]["fetched_at"], panel_catalogue["catalog"]["fetched_at"])
        rotated = [dict(account, api_key="sk-cp-other-key") for account in config["accounts"]]
        self.assertFalse(wb_minimax.catalog_meta(dict(config, accounts=rotated))["official_models"])
        status, bound_catalogue = self.request("/v1/models", key=MINIMAX_KEY)
        self.assertEqual(status, 200, bound_catalogue)
        self.assertEqual([row["id"] for row in bound_catalogue["data"]], [public_model])
        self.assertEqual(self.request("/v1/chat/completions", self.chat(CN_MODEL), key=MINIMAX_KEY)[0], 403)
        self.assertEqual(self.request("/chat/completions?realm=cn", self.chat(CN_MODEL), key=MINIMAX_KEY)[0], 403)
        self.use(gateway.Handler, "_agents_client_allowed", lambda self: True)
        agents = gateway.agents_module()
        with patch.object(agents, "overview", return_value={}):
            for key_id, visible in (("multi-key", True), ("cn-key", False), ("account-key", False)):
                status, view = self.request("/agents?realm=cn&key_id=" + key_id, extra_headers=panel)
                self.assertEqual(status, 200, view)
                self.assertEqual(any(m["id"] == public_model for m in view["models"]), visible)
            status, view = self.request("/agents?realm=cn&key_id=minimax-key", extra_headers=panel)
            self.assertEqual((status, view["realm"]), (200, "minimax"))
            self.assertEqual([row["id"] for row in view["models"]], [public_model])
            self.assertEqual(view["models"][0]["context_window"], 1_000_000)
        apply_payload = {"client": "codex", "base_url": "http://127.0.0.1:8788/v1",
                         "model": public_model, "models": [public_model]}
        with patch.object(agents, "integrate", return_value={}) as integrate:
            status, applied = self.request("/agents/apply", dict(apply_payload, key_id="multi-key"),
                                           extra_headers=panel)
            self.assertEqual(status, 200, applied)
            self.assertEqual(integrate.call_args.kwargs["model"], public_model)
            self.assertEqual(self.request("/agents/apply", dict(apply_payload, key_id="cn-key"),
                                          extra_headers=panel)[0], 403)
            self.assertEqual(integrate.call_count, 1)
            status, result = self.request("/agents/apply", dict(apply_payload, key_id="minimax-key"),
                                          extra_headers=panel)
            self.assertEqual(status, 200, result)
        for key in (BOUND_KEY, ACCOUNT_KEY):
            self.assertEqual(self.request("/v1/chat/completions", self.chat(public_model), key=key)[0], 403)
        self.assertEqual(self.request("/panel/minimax/quota")[0], 401)
        self.use(gateway, "open_upstream_with_fallback", OPEN_WITH_FALLBACK)

        def response(payload, content_type):
            result = io.BytesIO(payload.encode())
            result.headers = Message()
            result.headers["Content-Type"] = content_type
            return result

        chunk = {"id": "chatcmpl-minimax", "object": "chat.completion.chunk",
                 "model": model, "choices": [
                     {"index": 0, "delta": {"role": "assistant", "content": "套餐回复"}, "finish_reason": None}]}
        final = dict(chunk, choices=[{"index": 0, "delta": {}, "finish_reason": "stop"}],
                     usage={"prompt_tokens": 2, "completion_tokens": 1, "total_tokens": 3})
        transcript = ("data: " + json.dumps(chunk) + "\n\ndata: " +
                      json.dumps(final) + "\n\ndata: [DONE]\n\n")
        requests = []

        def simulated_upstream(req, timeout):
            requests.append((req.full_url, req.get_header("Authorization"), req.data))
            if req.full_url.endswith("/token_plan/remains"):
                return response(json.dumps({"model_remains": [{
                    "model_name": "general", "current_interval_remaining_percent": 67,
                    "current_weekly_total_count": 100, "current_weekly_usage_count": 83,
                }]}), "application/json")
            return response(transcript, "text/event-stream")

        with patch.object(wb_minimax._http, "open", side_effect=simulated_upstream):
            status, result = self.request("/v1/chat/completions", self.chat(public_model), key=MINIMAX_KEY)
            self.assertEqual((status, result["model"]), (200, public_model))
            self.assertEqual(result["choices"][0]["message"]["content"], "套餐回复")
            status, result = self.request("/v1/responses", {"model": public_model, "input": "ping", "stream": True})
            self.assertEqual(status, 200, result)
            self.assertIn("response.completed", result)
            status, result = self.request("/v1/messages", self.chat(public_model, max_tokens=32))
            self.assertEqual((status, result.get("model")), (200, public_model), result)
            status, result = self.request("/panel/minimax/quota", extra_headers=panel)
            self.assertEqual((status, result), (200, {"windows": [
                {"model": "general", "interval_percent": 67, "weekly_percent": 83.0}
            ]}))
            status, result = self.request("/realm", {"realm": "minimax"}, extra_headers=panel)
            self.assertEqual((status, result["current"]), (200, "minimax"))
            self.assertEqual(json.loads(Path(gateway.realm_state_file()).read_text())["realm"], "minimax")
            gateway.CURRENT_REALM = "intl"
            self.assertEqual(gateway.load_persisted_realm(), "minimax")
            status, result = self.request("/chat/completions", self.chat(model))
            self.assertEqual((status, result["model"]), (200, public_model))
            status, result = self.request("/chat/completions", self.chat(model), key=MINIMAX_KEY)
            self.assertEqual((status, result["model"]), (200, public_model))
        for url, authorization, body in requests[:3]:
            self.assertEqual(url, "https://api.minimax.io/v1/chat/completions")
            self.assertEqual(authorization, "Bearer " + subscription_key)
            payload = json.loads(body)
            self.assertEqual(payload["model"], model)
            self.assertTrue(payload["stream"])
            self.assertTrue(payload["stream_options"]["include_usage"])
        self.assertEqual(requests[3], ("https://www.minimax.io/v1/token_plan/remains", "Bearer " + subscription_key, None))
        self.assertNotIn(subscription_key, Path(gateway.USAGE_LOG).read_text(encoding="utf-8"))
        status, analytics = self.request("/usage/analytics?realm=all&range=all", extra_headers=panel)
        self.assertEqual(status, 200, analytics)
        mini_usage = next(entry for entry in analytics["models"] if entry["model"] == public_model)
        self.assertEqual(mini_usage["window"]["requests"], 5)
        self.assertEqual(mini_usage["window"]["total_tokens"], 15)
        status, scoped = self.request("/usage?realm=minimax", extra_headers=panel)
        self.assertEqual((status, scoped["requests"], scoped["total_tokens"]), (200, 5, 15))
        status, recent = self.request("/usage/recent?realm=all&watch=1&limit=12", extra_headers=panel)
        self.assertEqual(status, 200, recent)
        mini_rows = [row for row in recent["rows"] if row.get("route_id") == "minimax"]
        self.assertEqual(len(mini_rows), 5)
        self.assertTrue(all(row["requested_model"] == public_model for row in mini_rows))
        self.assertTrue(all(row["realm"] == "minimax" for row in mini_rows))

        error = response(json.dumps({"base_resp": {"status_code": 1002, "status_msg": subscription_key}}),
                         "application/json")
        with patch.object(wb_minimax._http, "open", return_value=error):
            status, result = self.request("/v1/responses", {"model": public_model, "input": "ping"})
            self.assertEqual(status, 429, result)
            self.assertNotIn(subscription_key, json.dumps(result))
        status, saved = self.request("/settings/save", {"minimax": {"api_key": None}}, extra_headers=panel)
        self.assertEqual(status, 200, saved)
        self.assertFalse(saved["minimax"]["enabled"])
        self.assertFalse(saved["minimax"]["key_set"])
        self.assertEqual(self.request("/realm")[1]["current"], "intl")
        self.assertEqual(self.request("/v1/chat/completions", self.chat(public_model), key=MINIMAX_KEY)[0], 503)

    def test_minimax_account_pool_and_model_toggle(self):
        original = json.loads(json.dumps(settings.load(ACCOUNTS)))
        self.addCleanup(settings.save, ACCOUNTS, original)
        self.use(gateway, "open_upstream_with_fallback", OPEN_WITH_FALLBACK)
        self.use(wb_minimax, "_last_used", {})
        panel = {"X-Panel-Token": gateway.PANEL.create()}

        def save(patch):
            return self.request("/settings/save", {"minimax": patch}, extra_headers=panel)

        secrets = ["sk-cp-first-fixture", "sk-cp-second-fixture"]
        for region, secret in zip(("cn", "global"), secrets):
            status, result = save({"account": {"name": region, "region": region, "api_key": secret}})
            self.assertEqual(status, 200, result)
            self.assertNotIn(secret, json.dumps(result))
        self.assertFalse(result["channels"]["minimax"], "adding accounts must not enable the channel")
        self.assertFalse(result["minimax"]["enabled"])
        accounts = result["minimax_accounts"]
        self.assertEqual([a["region"] for a in accounts], ["cn", "global"])
        self.assertEqual(len({a["uid"] for a in accounts}), 2)
        self.assertEqual(save({"account": {"region": "cn", "api_key": secrets[0]}})[0], 400)
        status, result = self.request("/settings/save", {"channels": {"minimax": True}}, extra_headers=panel)
        self.assertEqual(status, 200, result)
        self.assertTrue(result["minimax"]["enabled"])
        self.assertEqual(save({"model_toggle": {"id": "MiniMax-M3", "enabled": True}})[0], 200)
        self.assertIn("MiniMax-M3", settings.minimax_config(ACCOUNTS)["models"])
        self.assertEqual(save({"model_toggle": {"id": "MiniMax-M3", "enabled": False}})[0], 200)
        self.assertNotIn("MiniMax-M3", settings.minimax_config(ACCOUNTS)["models"])

        model = "minimax/MiniMax-M3.1-Flash"
        attempts = []
        fail_first = False

        def upstream(req, timeout):
            auth = req.get_header("Authorization")
            attempts.append((req.host, auth))
            if fail_first and auth.endswith(secrets[0]):
                raise HTTPError(req.full_url, 429, "fixture", {}, None)
            chunks = [
                {"id": "pool", "choices": [{"index": 0, "delta": {"content": "ok"},
                                           "finish_reason": "stop"}],
                 "usage": {"prompt_tokens": 2, "completion_tokens": 1, "total_tokens": 3}},
            ]
            response = io.BytesIO(("".join("data: " + json.dumps(chunk) + "\n\n" for chunk in chunks)
                                   + "data: [DONE]\n\n").encode())
            response.headers = Message()
            response.headers["Content-Type"] = "text/event-stream"
            return response

        with patch.object(wb_minimax._http, "open", side_effect=upstream):
            for _ in range(2):
                self.assertEqual(self.request("/v1/chat/completions", self.chat(model), key=MINIMAX_KEY)[0], 200)
            self.assertEqual([host for host, _ in attempts], ["api.minimax.cn", "api.minimax.io"])
            fail_first = True
            self.assertEqual(self.request("/v1/chat/completions", self.chat(model), key=MINIMAX_KEY)[0], 200)
            self.assertEqual([host for host, _ in attempts[-2:]], ["api.minimax.cn", "api.minimax.io"])
            self.assertEqual(save({"account": {"uid": accounts[0]["uid"], "enabled": False}})[0], 200)
            self.assertEqual(self.request("/v1/chat/completions", self.chat(model), key=MINIMAX_KEY)[0], 200)
            self.assertEqual(attempts[-1][0], "api.minimax.io")
        _, recent = self.request("/usage/recent?realm=minimax&limit=12", extra_headers=panel)
        self.assertEqual({row["account"] for row in recent["rows"]}, {a["uid"] for a in accounts})
        status, paused = self.request("/settings/save", {"channels": {"minimax": False}}, extra_headers=panel)
        self.assertEqual(status, 200, paused)
        self.assertEqual([a["uid"] for a in paused["minimax_accounts"]], [a["uid"] for a in accounts])
        self.assertEqual(self.request("/v1/chat/completions", self.chat(model), key=MINIMAX_KEY)[0], 503)

    def test_channel_switches_are_independent_of_accounts_and_legacy_default(self):
        original = json.loads(json.dumps(settings.load(ACCOUNTS)))
        self.addCleanup(settings.save, ACCOUNTS, original)
        self.use(gateway, "CURRENT_REALM", "intl")
        panel = {"X-Panel-Token": gateway.PANEL.create()}
        switches = {"intl": False, "cn": False, "minimax": False, "codearts": False}
        self.assertEqual(self.request("/settings/save", {"channels": switches})[0], 401)
        self.assertEqual(self.request("/settings/save", {"channels": {"cn": "false"}}, extra_headers=panel)[0], 400)
        status, view = self.request("/settings/save", {"channels": switches}, extra_headers=panel)
        self.assertEqual(status, 200, view)
        self.assertEqual(view["channels"], switches)
        self.assertEqual(self.request("/realm")[1], {"current": "", "options": []})
        self.assertEqual(self.request("/v1/chat/completions", self.chat(CN_MODEL))[0], 503)
        self.assertEqual(self.request("/chat/completions?realm=cn", self.chat(MODEL))[0], 503)
        self.assertFalse(any(row["route_id"] in ("wb-intl", "wb-cn")
                             for row in self.request("/v1/models")[1]["data"]))
        self.assertEqual(self.request("/codearts/accounts", extra_headers=panel)[0], 200)
        with patch.object(gateway.wb_codearts, "oauth_start", return_value={"session_id": "fixture"}):
            self.assertEqual(self.request("/codearts/accounts/oauth/start", {}, extra_headers=panel)[0], 200)
        status, view = self.request("/settings/save", {"channels": {"cn": True, "minimax": True}},
                                    extra_headers=panel)
        self.assertEqual(status, 200, view)
        self.assertTrue(view["channels"]["minimax"])
        self.assertFalse(view["minimax"]["enabled"], "an enabled channel can wait for an account")
        self.assertEqual(self.request("/realm")[1], {"current": "cn", "options": ["cn"]})
        self.assertEqual(self.request("/v1/chat/completions", self.chat(CN_MODEL))[0], 200)

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
