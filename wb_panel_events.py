"""Real-time call events for the dashboard's live view.

Every finished call already funnels through ``record_usage`` / ``record_error``
in wb_proxy. This module adds the missing half - "a call has started and is
still running" - and fans both halves out to the dashboard streams.

Three ground rules, each learned from how this gateway is shaped:

* Pure data structure plus SSE framing. No HTTP here, and no import of wb_proxy:
  when the gateway runs as a script, ``wb_proxy`` is ``__main__`` and importing
  it would load a shadow copy of the whole gateway.
* Publishing never blocks and never raises. It runs on request threads, so a
  slow dashboard must never slow down a model call. Each subscriber owns a
  bounded queue; one that falls behind is reset instead of stalling producers.
* Every durable frame is numbered and kept in a bounded ring whether or not
  anyone is watching (a few dict updates per call), so a dashboard that opens
  late or reconnects receives exactly what it missed. Only the progress frames
  are skipped when nobody is watching - they describe a moment, not a call.

A trace lives on the request thread (thread-local). It is opened when the
request is admitted and closed by whichever comes first: a usage row
(``finish``) or the end of the request (``finish_open``). That is deliberate -
the usage row, not the trace, is the record of what a call cost.
"""

import json
import queue
import threading
import time
import uuid
from collections import deque

RING_MAX = 500            # durable frames kept for Last-Event-ID replay
RECENT_MAX = 40           # finished calls handed to a freshly opened stream
SUBSCRIBER_MAX = 8        # concurrent dashboard streams (one thread each)
QUEUE_MAX = 256           # per-subscriber backlog before it is reset
LIVE_MAX = 512            # in-flight calls held in memory
LIVE_INTERVAL = 0.5       # seconds between progress frames
STALE_SECONDS = 900.0     # an in-flight call with no end for this long is dropped

# Trace ids are matched across threads only for the gateway's own loopback call
# (see Handler._trace_begin), never trusted from a remote client.
ID_LENGTH = 12

_LOCK = threading.RLock()
_SEQ = 0
_RING = deque(maxlen=RING_MAX)
_RECENT = deque(maxlen=RECENT_MAX)
_LIVE = {}
_SUBS = []
_LOCAL = threading.local()
_REDACT = None
_LAST_LIVE = 0.0
_REAP_AT = 0.0


def configure(redact=None):
    """Install the masker applied to every frame on the way out."""
    global _REDACT
    _REDACT = redact


def reset():
    """Forget everything; for tests and a fresh interpreter."""
    global _SEQ, _LAST_LIVE, _REAP_AT
    with _LOCK:
        _SEQ = 0
        _LAST_LIVE = 0.0
        _REAP_AT = 0.0
        _RING.clear()
        _RECENT.clear()
        _LIVE.clear()
        del _SUBS[:]
    _LOCAL.trace = None


def kind_for(route):
    """Best-effort call type from the path, before a usage row says it exactly."""
    route = str(route or "")
    if route.endswith("/chat/completions") or route.endswith("/completions"):
        return "chat"
    if "/responses" in route or "/messages" in route or route.startswith("/v1beta/"):
        return "chat"
    if "/images/" in route:
        return "image"
    if "/videos" in route:
        return "video"
    if route.endswith("/speech"):
        return "tts"
    if route.endswith("/transcriptions"):
        return "asr"
    if route.startswith("/v1/tools/"):
        return "web"
    return "chat"


class _Trace(object):
    __slots__ = ("id", "t0", "route", "kind", "key", "model", "stream",
                 "account", "chunks", "status", "closed")


def _open_trace():
    trace = getattr(_LOCAL, "trace", None)
    if trace is None or trace.closed:
        return None
    return trace


def _reap_locked(now):
    """Drop calls whose thread never got to close them (process-level oddities)."""
    global _REAP_AT
    if now < _REAP_AT:
        return
    _REAP_AT = now + 60.0
    for trace_id in [k for k, t in _LIVE.items() if now - t.t0 > STALE_SECONDS]:
        _LIVE.pop(trace_id, None)


def _offer(sub, frame):
    try:
        sub.queue.put_nowait(frame)
    except queue.Full:
        # Never wait on a request thread: the laggard is told to resync instead.
        sub.dead = True


def _emit(frame):
    """Number, record and fan out one durable frame.

    Numbering and the ring do not depend on having a viewer: a call that starts
    and ends while every dashboard is closed is still an event a reconnecting
    dashboard must receive. What nobody watching saves is the fan-out only.
    """
    global _SEQ
    with _LOCK:
        _SEQ += 1
        frame["seq"] = _SEQ
        frame["t"] = round(time.time(), 3)
        _RING.append(frame)
        for sub in list(_SUBS):
            _offer(sub, frame)


def begin(route, key=None, content_length=None, adopt=None):
    """Open a trace for the request on this thread; returns its id (or None)."""
    try:
        now = time.time()
        with _LOCK:
            _reap_locked(now)
            if adopt:
                shared = _LIVE.get(adopt)
                if shared is not None and not shared.closed:
                    _LOCAL.trace = shared
                    return shared.id
            if len(_LIVE) >= LIVE_MAX:
                _LOCAL.trace = None
                return None
            trace = _Trace()
            trace.id = uuid.uuid4().hex[:ID_LENGTH]
            trace.t0 = now
            trace.route = str(route or "")[:120]
            trace.kind = kind_for(trace.route)
            trace.key = key
            trace.model = None
            trace.stream = None
            trace.account = None
            trace.chunks = 0
            trace.status = None
            trace.closed = False
            _LIVE[trace.id] = trace
            _LOCAL.trace = trace
        _emit({"type": "start", "id": trace.id, "route": trace.route,
               "kind": trace.kind, "key": key, "len": content_length})
        return trace.id
    except Exception:
        return None


def meta(model=None, stream=None):
    """Fill in what only the parsed body knows. A body without ``stream`` is not streamed."""
    trace = _open_trace()
    if trace is None:
        return
    with _LOCK:
        trace.model = str(model)[:120] if model else None
        trace.stream = bool(stream)
    _emit({"type": "meta", "id": trace.id, "model": trace.model,
           "stream": trace.stream})


def bind(account_uid):
    """The call was assigned to this account (again, on a failover)."""
    trace = _open_trace()
    if trace is None or not account_uid:
        return
    with _LOCK:
        trace.account = str(account_uid)
    _emit({"type": "bind", "id": trace.id, "account": trace.account})


def tick():
    """One streamed chunk went out. Lock-free: the counter only feeds progress."""
    trace = getattr(_LOCAL, "trace", None)
    if trace is not None and not trace.closed:
        trace.chunks += 1


def status(code):
    """Remember the response status in case the call ends without a usage row."""
    trace = _open_trace()
    if trace is not None:
        trace.status = code


def current_id():
    trace = _open_trace()
    return trace.id if trace is not None else None


def _entry(trace, now):
    return {"id": trace.id, "t0": round(trace.t0, 3), "route": trace.route,
            "kind": trace.kind, "key": trace.key, "model": trace.model,
            "stream": trace.stream, "account": trace.account,
            "chunks": trace.chunks,
            "elapsed_ms": int((now - trace.t0) * 1000)}


def finish(row):
    """A usage row was written: close the trace it belongs to (or stand alone)."""
    try:
        trace = getattr(_LOCAL, "trace", None)
        _LOCAL.trace = None
        call_id = None
        if trace is not None and not trace.closed:
            with _LOCK:
                trace.closed = True
                _LIVE.pop(trace.id, None)
            call_id = trace.id
        if call_id is None:
            call_id = uuid.uuid4().hex[:ID_LENGTH]
        data = dict(row) if isinstance(row, dict) else {"outcome": "failed"}
        frame = {"type": "finish", "id": call_id, "row": data}
        with _LOCK:
            _RECENT.append(frame)
        _emit(frame)
        return call_id
    except Exception:
        return None


def finish_open():
    """End of request: close a trace that never produced a usage row."""
    try:
        trace = getattr(_LOCAL, "trace", None)
        _LOCAL.trace = None
        if trace is None or trace.closed:
            return None
        now = time.time()
        code = int(trace.status or 200)
        ok = 200 <= code < 400
        with _LOCK:
            trace.closed = True
            _LIVE.pop(trace.id, None)
        row = {
            "at": now,
            "iso": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(now)),
            "model": trace.model or "unknown",
            "stream": bool(trace.stream),
            "outcome": "completed" if ok else "rejected",
            "kind": trace.kind,
            "elapsed_ms": int((now - trace.t0) * 1000),
            "key": trace.key,
            "route": trace.route,
            "status": code,
        }
        if trace.account:
            row["account"] = trace.account
        if not ok:
            row["error"] = True
        frame = {"type": "finish", "id": trace.id, "row": row}
        with _LOCK:
            _RECENT.append(frame)
        _emit(frame)
        return trace.id
    except Exception:
        return None


def _publish_live_locked(now):
    global _LAST_LIVE
    if not _SUBS or not _LIVE or now - _LAST_LIVE < LIVE_INTERVAL:
        return False
    _LAST_LIVE = now
    frame = {"type": "live", "t": round(now, 3),
             "live": [_entry(t, now) for t in list(_LIVE.values())]}
    for sub in list(_SUBS):
        _offer(sub, frame)
    return True


def live_due(now=None):
    """Publish one progress frame if the interval has elapsed (any caller)."""
    try:
        with _LOCK:
            return _publish_live_locked(time.time() if now is None else now)
    except Exception:
        return False


class Subscriber(object):
    __slots__ = ("queue", "dead")


def subscribe(last_id=None):
    """Register a stream. Returns a Subscriber, or None when at capacity.

    ``last_id`` is the Last-Event-ID the browser sent back. When the ring still
    covers it the missed frames are queued in order and the stream resumes. A
    client that already saw the newest event gets silence: nothing was missed,
    so even a snapshot would be noise. Otherwise (first visit, or too long
    offline) a snapshot replaces the gap: everything in flight now plus the
    calls that finished meanwhile.
    """
    global _SEQ
    with _LOCK:
        if len(_SUBS) >= SUBSCRIBER_MAX:
            return None
        sub = Subscriber()
        sub.queue = queue.Queue(maxsize=QUEUE_MAX)
        sub.dead = False
        now = time.time()
        # Up to date means: nothing newer exists, or the ring still reaches back
        # to where the client stopped. An id from beyond the newest event is a
        # client that outlived a restart - its state is stale, so it gets a reset.
        known = isinstance(last_id, int) and last_id >= 0
        upto_date = known and (
            last_id == _SEQ
            or last_id < _SEQ and bool(_RING) and _RING[0]["seq"] <= last_id + 1)
        if upto_date:
            for frame in _RING:
                if frame["seq"] > last_id:
                    _offer(sub, frame)
        else:
            _SEQ += 1
            _offer(sub, {
                "type": "snapshot", "seq": _SEQ, "t": round(now, 3),
                "reset": last_id is not None,
                "live": [_entry(t, now) for t in list(_LIVE.values())],
                "recent": [dict(f) for f in _RECENT],
            })
        _SUBS.append(sub)
    return sub


def unsubscribe(sub):
    with _LOCK:
        if sub in _SUBS:
            _SUBS.remove(sub)


def next_frame(sub, timeout):
    """Next frame for this stream, None on a quiet timeout."""
    if sub.dead:
        return {"type": "reset", "reason": "lagged", "t": round(time.time(), 3)}
    try:
        return sub.queue.get(timeout=max(0.0, timeout))
    except queue.Empty:
        return None


def render(frame):
    """One SSE frame as text. ``id`` is the event number a reconnect sends back."""
    if _REDACT is not None:
        frame = _REDACT(frame)
    head = ""
    if frame.get("seq") is not None:
        head = "id: %d\n" % frame["seq"]
    body = json.dumps(frame, ensure_ascii=False, separators=(",", ":"))
    return head + "event: %s\ndata: %s\n\n" % (frame.get("type") or "message", body)


def stats():
    """Counts for tests and diagnostics."""
    with _LOCK:
        return {"live": len(_LIVE), "ring": len(_RING), "recent": len(_RECENT),
                "subscribers": len(_SUBS), "seq": _SEQ}
