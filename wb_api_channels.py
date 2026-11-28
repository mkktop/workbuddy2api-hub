"""Official API key channels using the gateway's Chat Completions codecs."""

import hashlib
from itertools import count
import json
import re
from threading import Lock
import time
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, Request, build_opener


CHAT_BASE = {
    "zhipu": "https://open.bigmodel.cn/api/coding/paas/v4",
    "deepseek": "https://api.deepseek.com",
}
DOCS = {
    "zhipu": "https://docs.bigmodel.cn/cn/coding-plan/overview",
    "deepseek": "https://api-docs.deepseek.com/api/list-models/",
}
_CHAT_FIELDS = ("model", "messages", "tools", "tool_choice", "parallel_tool_calls",
                "temperature", "top_p", "stop", "response_format", "user")
_EFFORTS = {"minimal": "low", "light": "low", "low": "low", "medium": "high",
            "high": "high", "max": "max", "ultra": "max"}
_CATALOG_TTL = 300
_lock = Lock()
_order = count()
_last_used = {}
_deepseek_catalog = {}


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_http = build_opener(_NoRedirect())


class _ApiAccount:
    def __init__(self, uid, realm):
        self.uid = uid
        self.realm = realm


def active_accounts(config):
    return [account for account in config["accounts"] if account.get("enabled") is not False]


def configured(config):
    return config["enabled"] and bool(active_accounts(config))


def public_accounts(config):
    return [{"uid": account["uid"], "name": account.get("name") or account["uid"],
             "enabled": account.get("enabled") is not False} for account in config["accounts"]]


def _open(url, account, payload=None, timeout=12):
    headers = {"Authorization": "Bearer " + account["api_key"],
               "Accept": "application/json" if payload is None else "text/event-stream"}
    if payload is not None:
        headers["Content-Type"] = "application/json"
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
    return _http.open(Request(url, data=data, headers=headers), timeout=timeout)


def _official_json(url, account):
    with _open(url, account) as response:
        body = response.read(2 * 1024 * 1024 + 1)
    if len(body) > 2 * 1024 * 1024:
        raise ValueError("Upstream response is too large")
    result = json.loads(body)
    if not isinstance(result, dict):
        raise ValueError("Upstream returned an invalid response")
    return result


def _zhipu_models():
    # The Coding Plan publishes its eligible models separately from standard API models.
    return [{"id": model, "object": "model", "owned_by": "zhipu", "name": name,
             "context_length": 1_000_000, "context_window": 1_000_000,
             "max_output_tokens": 131_072, "max_output": 131_072,
             "input_modalities": ["text", "image"] if vision else ["text"],
             "supports_vision": vision, "supports_tool_calls": True,
             "supports_reasoning": True, "reasoning_efforts": ["low", "high", "max"],
             "reasoning_default_effort": "max", "reasoning_can_disable": False}
            for model, name, vision in (("glm-5.4", "GLM-5.4", True),
                                        ("glm-5.3", "GLM-5.3", False),
                                        ("glm-5.3-flash", "GLM-5.3-Flash", True))]


def _deepseek_models(payload):
    data = payload.get("data")
    if not isinstance(data, list):
        raise ValueError("DeepSeek did not return a model catalogue")
    result = []
    for row in data:
        if not isinstance(row, dict) or not isinstance(row.get("id"), str):
            continue
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", row["id"]):
            continue
        effort = row.get("effort")
        effort = effort if isinstance(effort, dict) else {}
        supported = effort.get("supported_levels")
        levels = [level for level in supported if level in ("low", "high", "max")] if isinstance(supported, list) else []
        modalities = row.get("input_modalities")
        modalities = [item for item in modalities if item in ("text", "image")] if isinstance(modalities, list) else []
        result.append({"id": row["id"], "object": "model", "owned_by": "deepseek",
                       "name": row.get("name") or row["id"], "input_modalities": modalities,
                       "context_length": row.get("context_window"), "context_window": row.get("context_window"),
                       "max_output_tokens": row.get("max_output_tokens"), "max_output": row.get("max_output_tokens"),
                       "supports_vision": "image" in modalities, "supports_tool_calls": True,
                       "supports_reasoning": bool(levels), "reasoning_can_disable": True if levels else None,
                       "reasoning_efforts": levels, "reasoning_default_effort": effort.get("default_level")})
    return result


def model_catalog(realm, config, *, force=False):
    meta = {"source": realm, "docs_url": DOCS[realm], "fetched_at": None, "stale": False}
    if not configured(config):
        return [], meta
    if realm == "zhipu":
        return _zhipu_models(), meta
    accounts = active_accounts(config)
    key = tuple(sorted(hashlib.sha256(account["api_key"].encode()).hexdigest() for account in accounts))
    now = time.time()
    with _lock:
        cached = _deepseek_catalog.get(key)
    if cached and now < cached["retry_at"] and not force:
        return cached["models"], cached["meta"]
    models = None
    for account in accounts:
        try:
            models = _deepseek_models(_official_json(CHAT_BASE[realm] + "/models", account))
            break
        except HTTPError as exc:
            if exc.fp is not None:
                exc.close()
        except (OSError, ValueError):
            pass
    if models is None:
        models = cached["models"] if cached else []
        meta.update(stale=True, fetched_at=cached["meta"]["fetched_at"] if cached else None)
    else:
        meta["fetched_at"] = now
    with _lock:
        if len(_deepseek_catalog) >= 16 and key not in _deepseek_catalog:
            _deepseek_catalog.pop(next(iter(_deepseek_catalog)))
        _deepseek_catalog[key] = {"models": models, "meta": meta,
                                  "retry_at": now + (30 if meta["stale"] else _CATALOG_TTL)}
    return models, meta


def _chat_body(realm, payload):
    body = {field: payload[field] for field in _CHAT_FIELDS if field in payload}
    body["stream"] = True
    max_tokens = payload.get("max_completion_tokens")
    if max_tokens is None:
        max_tokens = payload.get("max_tokens")
    if max_tokens is not None:
        body["max_tokens"] = max_tokens
    reasoning = payload.get("reasoning")
    effort = payload.get("reasoning_effort") or payload.get("reasoningEffort")
    if not effort and isinstance(reasoning, dict):
        effort = reasoning.get("effort")
    effort = effort.strip().lower() if isinstance(effort, str) else ""
    thinking = payload.get("thinking")
    mode = thinking.get("type") if isinstance(thinking, dict) else None
    disabled = mode == "disabled" or (mode not in ("enabled", "adaptive") and effort == "none")
    if realm == "deepseek":
        body["stream_options"] = {"include_usage": True}
        if disabled:
            body["thinking"] = {"type": "disabled"}
            effort = "none"
        else:
            effort = "high" if effort == "xhigh" else _EFFORTS.get(effort, "high")
            body["thinking"] = {"type": "enabled"}
            body["reasoning_effort"] = effort
    else:
        effort = "low" if disabled else ("max" if effort == "xhigh" else _EFFORTS.get(effort, "max"))
        body["thinking"] = {"type": "enabled"}
        if isinstance(thinking, dict) and isinstance(thinking.get("clear_thinking"), bool):
            body["thinking"]["clear_thinking"] = thinking["clear_thinking"]
        body["reasoning_effort"] = effort
        if "tool_stream" in payload:
            body["tool_stream"] = payload["tool_stream"]
    return body, effort


def open_chat(realm, config, payload, *, allowed_accounts=None):
    url = CHAT_BASE[realm] + "/chat/completions"
    accounts = [account for account in active_accounts(config)
                if allowed_accounts is None or account["uid"] in allowed_accounts]
    if not config["enabled"] or not accounts:
        raise HTTPError(url, 503, "Upstream API channel is unavailable", None, None)
    body, effort = _chat_body(realm, payload)
    while accounts:
        with _lock:
            account = min(accounts, key=lambda row: _last_used.get(row["uid"], -1))
            _last_used[account["uid"]] = next(_order)
        accounts.remove(account)
        try:
            response = _open(url, account, body, timeout=120)
        except HTTPError as exc:
            status = exc.code
            if exc.fp is not None:
                exc.close()
            if accounts and status in (401, 402, 403, 429):
                continue
            if status in (401, 403) or status >= 500 or 300 <= status < 400:
                status = 502
            raise HTTPError(url, status, "Upstream API rejected the request", None, None) from None
        except OSError:
            raise HTTPError(url, 502, "Upstream API could not be reached", None, None) from None
        if response.headers.get_content_type() != "text/event-stream":
            response.close()
            raise HTTPError(url, 502, "Upstream API did not return a chat stream", None, None)
        return response, _ApiAccount(account["uid"], realm), effort


def deepseek_balance(account):
    data = _official_json(CHAT_BASE["deepseek"] + "/user/balance", account)
    rows = data.get("balance_infos")
    if not isinstance(rows, list):
        raise ValueError("DeepSeek did not return balance information")
    return {"is_available": data.get("is_available") is True,
            "balances": [{"currency": row["currency"], "total_balance": str(row["total_balance"])}
                         for row in rows if isinstance(row, dict)
                         and row.get("currency") in ("CNY", "USD")
                         and "total_balance" in row]}
