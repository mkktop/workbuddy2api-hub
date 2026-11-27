"""MiniMax Subscription Key transport over the official OpenAI-compatible API."""

from http.client import HTTPException
from hashlib import sha256
from concurrent.futures import ThreadPoolExecutor
import io
from itertools import count
import json
import re
from threading import Lock
import time
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener


CHAT_HOSTS = {"cn": "https://api.minimax.cn", "global": "https://api.minimax.io"}
QUOTA_HOSTS = {"cn": "https://www.minimax.cn", "global": "https://www.minimax.io"}
ROUTE = "minimax"
_MODEL_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}")
_CATALOG_TTL = 300
_CATALOG_RETRY = 30
_catalog_cache = {}
_catalog_lock = Lock()
_dispatch_lock = Lock()
_dispatch_order = count()
_last_used = {}

# The model API returns identifiers and timestamps. Extended specifications
# come from the official text-openai-api and text-chat-openai references.
_M3_SPECS = {
    "context_length": 1_000_000,
    "context_window": 1_000_000,
    "max_output_tokens": 524_288,
    "input_modalities": ["text", "image", "video"],
    "supports_vision": True,
    "supports_tool_calls": True,
    "supports_reasoning": True,
    "temperature": 1,
    "top_p": 0.95,
}
_MODEL_SPECS = {
    "MiniMax-M3.1-Flash": dict(
        _M3_SPECS, reasoning_efforts=["low", "medium", "high", "xhigh", "max"],
        reasoning_default_effort="max", reasoning_can_disable=False),
    "MiniMax-M3": dict(_M3_SPECS, reasoning_can_disable=True),
}


class _SubscriptionAccount:
    realm = ROUTE

    def __init__(self, uid):
        self.uid = uid


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_http = build_opener(_NoRedirect())


def configured(config):
    return config["enabled"] and bool(active_accounts(config))


def active_accounts(config):
    return [account for account in config["accounts"] if account.get("enabled") is not False]


def public_accounts(config):
    return [{"uid": a["uid"], "name": a.get("name") or "MiniMax 官方套餐", "region": a["region"],
             "enabled": a.get("enabled") is not False} for a in config["accounts"]]


def public_config(config):
    return {
        "enabled": configured(config),
        "region": config["region"],
        "key_set": bool(config["accounts"]),
        "models": config["models"],
    }


def model_entries(config):
    official = _catalog_models(config)
    # The official catalogue may include models whose inference requires
    # another plan. Keep the locally enabled set as the gateway's allow-list.
    fallback = {"object": "model", "created": 0, "owned_by": ROUTE}
    return [_model_entry(model, official.get(model, fallback)) for model in config["models"]]


def official_model_entries(config):
    if not configured(config):
        return []
    return [_model_entry(model, meta) for model, meta in _catalog_models(config).items()]


def _model_entry(model, meta):
    return {"id": model, **meta, **_MODEL_SPECS.get(model, {})}


def _catalog_key(config):
    return config["region"], sha256(config["api_key"].encode()).digest()


def _catalog_models(config):
    models = {}
    for account in active_accounts(config):
        snapshot = _catalog_cache.get(_catalog_key(account))
        if snapshot:
            for model, details in snapshot["models"].items():
                models.setdefault(model, details)
    return models


def _fetch_models(config):
    url = CHAT_HOSTS[config["region"]] + "/v1/models"
    with _open(url, config, timeout=4) as response:
        payload = _read_json(response, url)
    rows = payload.get("data")
    if not isinstance(rows, list):
        raise _error(url, 502, "MiniMax did not return a model list")
    result = {}
    for row in rows:
        model = row.get("id") if isinstance(row, dict) else None
        if isinstance(model, str) and _MODEL_ID.fullmatch(model):
            created = row.get("created")
            owner = row.get("owned_by")
            result[model] = {
                "object": "model",
                "created": created if type(created) is int and created >= 0 else 0,
                "owned_by": owner if isinstance(owner, str) and len(owner) <= 100 else ROUTE,
            }
    if not result:
        raise _error(url, 502, "MiniMax returned an empty text model catalogue")
    return result


def _refresh_account_catalog(account, force):
    key = _catalog_key(account)
    previous = _catalog_cache.get(key)
    if previous:
        ttl = _CATALOG_RETRY if force or previous["failed"] else _CATALOG_TTL
        if time.monotonic() - previous["checked_at"] < ttl:
            return
    try:
        models = _fetch_models(account)
        fetched_at, failed = time.time(), False
    except HTTPError:
        models = previous["models"] if previous else {}
        fetched_at, failed = (previous["fetched_at"] if previous else None), True
    _catalog_cache[key] = {
        "models": models, "fetched_at": fetched_at,
        "checked_at": time.monotonic(), "failed": failed,
    }


def refresh_catalog(config, *, force=False):
    """Merge the enabled accounts' official directories at catalogue read time."""
    if not configured(config):
        return
    accounts = active_accounts(config)
    with _catalog_lock:
        keys = {_catalog_key(account) for account in config["accounts"]}
        for key in list(_catalog_cache):
            if key not in keys:
                _catalog_cache.pop(key, None)
        if len(accounts) == 1:
            _refresh_account_catalog(accounts[0], force)
        else:
            with ThreadPoolExecutor(max_workers=min(4, len(accounts))) as workers:
                list(workers.map(lambda account: _refresh_account_catalog(account, force), accounts))


def catalog_meta(config):
    snapshots = [_catalog_cache.get(_catalog_key(a), {}) for a in active_accounts(config)]
    docs_host = "platform.minimax.cn" if config["region"] == "cn" else "platform.minimax.io"
    return {
        "source": ROUTE,
        "fetched_at": max((s["fetched_at"] for s in snapshots if s.get("fetched_at")), default=None),
        "stale": any(s.get("failed") for s in snapshots),
        "official_models": list(_catalog_models(config)),
        "docs_url": "https://" + docs_host + "/docs/api-reference/text-openai-api",
    }


def _error(url, status, message, *, retry_account=False):
    # Reuse the gateway's HTTP-error paths, with a body that never contains
    # the upstream's raw response, request details, or credentials.
    error = HTTPError(url, status, message, {},
                      io.BytesIO(json.dumps({"error": {"message": message}}).encode()))
    error.retry_account = retry_account
    return error


def _open(url, config, payload=None, timeout=20):
    key = config["api_key"]
    if not key:
        raise _error(url, 503, "MiniMax Subscription Key is not configured")
    headers = {"Authorization": "Bearer " + key, "Content-Type": "application/json"}
    data = json.dumps(payload, ensure_ascii=False).encode() if payload is not None else None
    try:
        return _http.open(Request(url, data=data, headers=headers), timeout=timeout)
    except HTTPError as exc:
        status = exc.code
        exc.close()
        if status in (401, 403):
            raise _error(url, 502, "MiniMax rejected the Subscription Key or request access",
                         retry_account=True) from None
        if status == 429:
            raise _error(url, 429, "MiniMax subscription quota or rate limit reached",
                         retry_account=True) from None
        if status == 400:
            raise _error(url, 400, "MiniMax rejected the model or request parameters") from None
        raise _error(url, 502, "MiniMax upstream request failed") from None
    except (URLError, OSError):
        raise _error(url, 502, "Could not reach the official MiniMax API") from None


def _read_json(response, url):
    try:
        payload = json.loads(response.read(256 * 1024))
    except (ValueError, OSError, HTTPException):
        raise _error(url, 502, "MiniMax returned an invalid response") from None
    if not isinstance(payload, dict):
        raise _error(url, 502, "MiniMax returned an invalid response")
    status = payload.get("base_resp")
    code = str(status.get("status_code", 0)) if isinstance(status, dict) else "0"
    if code in ("1002", "1039", "2049"):
        raise _error(url, 429, "MiniMax subscription quota or rate limit reached", retry_account=True)
    if code == "1004":
        raise _error(url, 502, "MiniMax rejected the Subscription Key", retry_account=True)
    if code == "2013":
        raise _error(url, 400, "MiniMax rejected the model or request parameters")
    if code != "0" or payload.get("error"):
        raise _error(url, 502, "MiniMax upstream request failed")
    return payload


def open_chat(config, payload, *, allowed_accounts=None):
    accounts = [a for a in active_accounts(config)
                if allowed_accounts is None or a["uid"] in allowed_accounts]
    if not config["enabled"] or not accounts:
        raise _error(CHAT_HOSTS[config["region"]], 503, "MiniMax subscription route is unavailable")
    # The shared gateway consumers handle both downstream streaming and
    # aggregation of the same Chat Completions SSE chunks.
    fields = ("model", "messages", "tools", "tool_choice", "parallel_tool_calls",
              "max_tokens", "max_completion_tokens", "temperature", "top_p", "stop",
              "reasoning_effort", "thinking", "response_format")
    body = {name: payload[name] for name in fields if name in payload}
    body.update(stream=True, stream_options={"include_usage": True}, reasoning_split=True)
    while accounts:
        with _dispatch_lock:
            account = min(accounts, key=lambda a: _last_used.get(a["uid"], -1))
            _last_used[account["uid"]] = next(_dispatch_order)
        accounts.remove(account)
        url = CHAT_HOSTS[account["region"]] + "/v1/chat/completions"
        try:
            response = _open(url, account, body, timeout=120)
            if response.headers.get_content_type() != "text/event-stream":
                with response:
                    _read_json(response, url)
                raise _error(url, 502, "MiniMax did not return a chat stream")
            return response, _SubscriptionAccount(account["uid"]), body.get("reasoning_effort")
        except HTTPError as exc:
            if not accounts or not getattr(exc, "retry_account", False):
                raise
            exc.close()


def _remaining(row, interval):
    percent = row.get("current_" + interval + "_remaining_percent")
    if isinstance(percent, (int, float)) and not isinstance(percent, bool) and 0 <= percent <= 100:
        return percent
    total = row.get("current_" + interval + "_total_count")
    count = row.get("current_" + interval + "_usage_count")
    # Legacy count-based plans report the remaining count in usage_count.
    if type(total) is int and type(count) is int and 0 <= count <= total and total > 0:
        return round(count * 100 / total, 1)
    return None


def quota(config):
    url = QUOTA_HOSTS[config["region"]] + "/v1/token_plan/remains"
    with _open(url, config) as response:
        payload = _read_json(response, url)
    rows = payload.get("model_remains")
    if not isinstance(rows, list):
        raise _error(url, 502, "MiniMax did not return subscription quota")
    return [{"model": row["model_name"],
             "interval_percent": _remaining(row, "interval"),
             "weekly_percent": _remaining(row, "weekly")}
            for row in rows if isinstance(row, dict) and isinstance(row.get("model_name"), str)]
