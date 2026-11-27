# -*- coding: utf-8 -*-
"""Public model IDs, authorization and dispatch for the multiprovider API."""

import re
import threading

import wb_settings


POST_OPERATIONS = {
    "/v1/chat/completions": "chat",
    "/v1/completions": "chat",
    "/v1/responses": "responses",
    "/v1/responses/compact": "compact",
    "/v1/messages": "messages",
    "/v1/messages/count_tokens": "count_tokens",
}
CHAT = "chat"
GEMINI = "/v1beta/models/"
ROUTE_ID = re.compile(r"[a-z][a-z0-9-]{0,47}")


class RouteError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status = status
        self.code = code


class Provider:
    """One stable public route, backed by an account pool or an external API.

    The catalogue yields upstream model entries with an id and optional
    capabilities (a subset of the registered operation names). An operation
    writes its protocol response through the handler. An adapter using the
    shared text operations can implement open_chat instead. It receives a
    Chat payload, session key and account allow-list, and returns
    (Chat SSE stream, account object with uid, actual reasoning effort).
    """

    def __init__(self, route_id, catalog, operations, enabled, *, realm=None,
                 account_ids=None, open_chat=None):
        self.id = route_id
        self.catalog = catalog
        self.operations = dict(operations)
        self.enabled = enabled
        self.realm = realm
        self.account_ids = account_ids
        self.open_chat = open_chat

    def capabilities(self, entry):
        declared = entry.get("gateway_operations", self.operations)
        if not isinstance(declared, (list, tuple, set, frozenset, dict)):
            return []
        return [operation for operation in self.operations
                if operation in declared]


class Route:
    def __init__(self, provider, model, operation):
        self.provider = provider
        self.model = model
        self.operation = operation

    @property
    def public_model(self):
        return self.provider.id + "/" + self.model

    @property
    def usage_realm(self):
        return self.provider.realm or self.provider.id

    def dispatch(self, handler, payload):
        return self.provider.operations[self.operation](handler, payload)

    def run(self, callback, *args):
        # One handler thread can serve multiple HTTP/1.1 requests.
        previous = current_route()
        _local.route = self
        try:
            return callback(*args)
        finally:
            _local.route = previous


def parse_model(public_model):
    if isinstance(public_model, str):
        route_id, sep, model = public_model.partition("/")
        if (sep and ROUTE_ID.fullmatch(route_id) and model and model == model.strip()
                and len(model) <= 256 and not any(c.isspace() or ord(c) < 32 for c in model)):
            return route_id, model
    raise RouteError(400, "invalid_model_id", "model must be <route>/<model>")


class Registry:
    def __init__(self, providers, banned=None):
        self.providers = {}
        self.banned = banned or (lambda model: False)
        for provider in providers:
            if not ROUTE_ID.fullmatch(provider.id) or provider.id in self.providers:
                raise ValueError("invalid or duplicate gateway route: " + provider.id)
            self.providers[provider.id] = provider

    def qualify(self, realm, model):
        if not model or model.partition("/")[0] in self.providers:
            return model
        for provider in self.providers.values():
            if provider.realm == realm:
                return provider.id + "/" + model
        return model

    @staticmethod
    def _allowed_route(provider, key, pinned_realm):
        bound = (key or {}).get("realm")
        if ((bound and bound != provider.realm)
                or (pinned_realm and pinned_realm != provider.realm)):
            return False
        allowed = wb_settings.key_allowed_accounts(key)
        return (allowed is None or
                (provider.account_ids is not None and not allowed.isdisjoint(provider.account_ids())))

    def _allowed_model(self, provider, key, model):
        return (not self.banned(model)
                and wb_settings.key_allows_model(key, provider.id + "/" + model))

    def _entries(self, provider):
        try:
            return {entry["id"]: entry for entry in provider.catalog()
                    if isinstance(entry, dict) and isinstance(entry.get("id"), str)}
        except (OSError, RuntimeError, ValueError) as exc:
            raise RouteError(503, "catalog_unavailable",
                             "model catalogue unavailable for " + provider.id) from exc

    def catalog(self, key=None, pinned_realm=None, *, route_id=None):
        models, unavailable = [], []
        for provider in self.providers.values():
            if route_id is not None and provider.id != route_id:
                continue
            if not self._allowed_route(provider, key, pinned_realm) or not provider.enabled():
                continue
            try:
                entries = self._entries(provider)
            except RouteError:
                unavailable.append(provider.id)
                continue
            for name, entry in entries.items():
                capabilities = provider.capabilities(entry)
                public_model = provider.id + "/" + name
                try:
                    parse_model(public_model)
                except RouteError:
                    continue
                if capabilities and self._allowed_model(provider, key, name):
                    models.append(dict(entry, id=public_model, route_id=provider.id,
                                       route_realm=provider.realm, upstream_model=name,
                                       gateway_operations=capabilities))
        return models, unavailable

    def resolve(self, public_model, operation, key=None, pinned_realm=None):
        route_id, model = parse_model(public_model)
        provider = self.providers.get(route_id)
        if provider is None:
            raise RouteError(404, "route_not_found", "unknown model route: " + route_id)
        if (not self._allowed_route(provider, key, pinned_realm)
                or not self._allowed_model(provider, key, model)):
            raise RouteError(403, "model_not_allowed", "model is forbidden by gateway policy")
        if not provider.enabled():
            raise RouteError(503, "route_unavailable", "model route is disabled: " + route_id)
        entry = self._entries(provider).get(model)
        if entry is None:
            raise RouteError(404, "model_not_found", "model not found: " + public_model)
        if operation not in provider.capabilities(entry):
            raise RouteError(400, "unsupported_operation",
                             "model does not support " + operation + ": " + public_model)
        return Route(provider, model, operation)


_local = threading.local()


def current_route():
    return getattr(_local, "route", None)


def chat_adapter():
    route = current_route()
    return route.provider.open_chat if route else None


def response_model(model):
    route = current_route()
    return route.public_model if route else model
