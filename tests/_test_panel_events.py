"""面板实时流：每一次调用都有始有终，而且绝不拖慢调用本身。

首页的「圣轮」把每一次模型调用画成一颗星：请求进来时出生，分配到账号时飞向
那只眼，结束时被中心吸收或碎裂。画面要成立，服务端必须把三件事按顺序推给
浏览器——开始、（可选的）分配账号、结束——并且一条都不能漏，否则星星会永远
悬在半空，或者调用结束了画面上却什么都没发生。

这个套件钉住四层：

1. 事件总线本身（wb_panel_events）：一条调用的完整生命周期、无人观看时的
   零开销、断线续传与快照的分界、落后太多的订阅者被重置而不是拖住请求线程。
2. 钩子接在了对的地方：用量行一落盘就发结束；没写用量行的调用（被拒、被限流）
   在请求收尾时结束；Gemini 的回环调用并入外层那一条。
3. 路由边界：/usage/events 与 /usage/recent 同一道门——只认面板会话。
4. 真实网关 + 真实套接字：SSE 帧在线上的样子、Last-Event-ID 续传。

起真实网关的那一段用临时账号目录和空闲端口，不碰网络，也不碰真实账号。

    python tests/_test_panel_events.py
"""
import email
import http.client
import inspect
import io
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)                    # the gateway lives one level up
sys.path.insert(0, HERE)

from _isolated_dirs import isolated_data_dirs  # noqa: E402  (its own data root)
import _lifecycle as life                     # noqa: E402  (spare port + managed process)

_TMP = isolated_data_dirs("wb-panel-events-")

import wb_proxy as proxy  # noqa: E402
import wb_panel_events as bus  # noqa: E402

PY = os.path.join(ROOT, "python", "python.exe")
if not os.path.exists(PY):
    PY = sys.executable

KEY = "events-suite-key"
PASSWORD = "events-suite-password"
MODEL_ID = "events-suite-model"
PANEL_ONLY_MESSAGE = "panel password required"


def injected_models(realm=None):
    """The model listing without walking anything upstream."""
    return [(MODEL_ID, {"name": "Injected"})]


def chat_body():
    return json.dumps({"model": MODEL_ID, "max_tokens": 1,
                       "messages": [{"role": "user", "content": "hi"}]}).encode()


def drain(sub, timeout=0.05):
    """Every frame waiting on a subscriber, in order."""
    frames = []
    while True:
        frame = bus.next_frame(sub, timeout)
        if frame is None:
            return frames
        frames.append(frame)


def kinds(frames):
    return [frame["type"] for frame in frames]


class BusTests(unittest.TestCase):
    """The event bus on its own: no HTTP, no gateway state."""

    def setUp(self):
        bus.reset()

    def tearDown(self):
        bus.configure(None)
        bus.reset()

    def test_one_call_is_traced_from_start_to_finish(self):
        sub = bus.subscribe()
        call_id = bus.begin("/v1/chat/completions", key="k1", content_length=420)
        bus.meta("gpt-5", True)
        bus.bind("acct-1")
        for _ in range(3):
            bus.tick()
        bus.live_due(now=time.time() + bus.LIVE_INTERVAL + 0.01)
        bus.finish({"model": "gpt-5", "outcome": "completed", "total_tokens": 12})

        frames = drain(sub)
        self.assertEqual(kinds(frames),
                         ["snapshot", "start", "meta", "bind", "live", "finish"])
        start = frames[1]
        self.assertEqual(start["id"], call_id)
        self.assertEqual(start["route"], "/v1/chat/completions")
        self.assertEqual(start["kind"], "chat")
        self.assertEqual(start["key"], "k1")
        self.assertEqual(start["len"], 420)
        self.assertEqual(frames[2]["model"], "gpt-5")
        self.assertIs(frames[2]["stream"], True)
        self.assertEqual(frames[3]["account"], "acct-1")
        live = frames[4]["live"]
        self.assertEqual([entry["id"] for entry in live], [call_id])
        self.assertEqual(live[0]["chunks"], 3)
        self.assertEqual(live[0]["account"], "acct-1")
        finish = frames[5]
        self.assertEqual(finish["id"], call_id)
        self.assertEqual(finish["row"]["total_tokens"], 12)
        # 结束之后再无在途：星星不会永远悬在半空。
        self.assertEqual(bus.stats()["live"], 0)
        bus.live_due(now=time.time() + bus.LIVE_INTERVAL + 0.01)
        self.assertEqual(drain(sub), [])

    def test_progress_frames_wait_for_their_interval(self):
        sub = bus.subscribe()
        bus.begin("/v1/chat/completions")
        drain(sub)
        # 第一帧进度不等：在途调用一出现就该有反馈。之后按间隔发。
        self.assertTrue(bus.live_due(now=1000.0))
        self.assertFalse(bus.live_due(now=1000.0 + bus.LIVE_INTERVAL / 2))
        self.assertTrue(bus.live_due(now=1000.0 + bus.LIVE_INTERVAL))
        self.assertEqual(kinds(drain(sub)), ["live", "live"])
        # 进度帧是过眼云烟：不进环，也就不会被续传重放。
        self.assertEqual(bus.stats()["ring"], 1)

    def test_frames_are_numbered_in_the_order_they_happened(self):
        sub = bus.subscribe()
        for _ in range(5):
            bus.begin("/v1/responses")
            bus.finish({"outcome": "completed"})
        seqs = [frame["seq"] for frame in drain(sub)]
        self.assertEqual(len(seqs), 11)
        self.assertEqual(seqs, sorted(seqs))
        self.assertEqual(len(set(seqs)), len(seqs))

    def test_a_call_nobody_watched_is_there_when_a_dashboard_opens(self):
        call_id = bus.begin("/v1/chat/completions")
        bus.tick()
        bus.finish({"model": "m", "outcome": "completed"})
        # 无人观看时只剩编号入环这一点点开销；进度帧则整个省掉。
        self.assertEqual(bus.stats(), {"live": 0, "ring": 2, "recent": 1,
                                       "subscribers": 0, "seq": 2})
        bus.live_due(now=time.time() + bus.LIVE_INTERVAL + 0.01)
        # 首次到访的观众拿到快照：此刻的在途 + 这期间结束的调用。
        snapshot = drain(bus.subscribe())[0]
        self.assertEqual(snapshot["type"], "snapshot")
        self.assertIs(snapshot["reset"], False)
        self.assertEqual(snapshot["live"], [])
        self.assertEqual([frame["row"]["model"] for frame in snapshot["recent"]], ["m"])
        self.assertEqual(snapshot["recent"][0]["id"], call_id)

    def test_a_dashboard_that_was_closed_gets_what_it_missed(self):
        # 每个面板都关着的那段时间里发生了一次调用：重连时按序号补发，不漏。
        bus.begin("/v1/chat/completions")
        bus.finish({"outcome": "completed"})
        frames = drain(bus.subscribe(last_id=0))
        self.assertEqual(kinds(frames), ["start", "finish"])
        self.assertEqual([frame["seq"] for frame in frames], [1, 2])

    def test_a_gap_beyond_the_ring_gets_a_resetting_snapshot(self):
        for _ in range(bus.RING_MAX + 10):
            bus.finish({"outcome": "completed"})
        # 环只留最近的一段：客户端停在环够不着的地方，只能用快照把缺口补上。
        frames = drain(bus.subscribe(last_id=3))
        self.assertEqual(kinds(frames), ["snapshot"])
        self.assertIs(frames[0]["reset"], True)
        self.assertEqual(len(frames[0]["recent"]), bus.RECENT_MAX)

    def test_an_id_from_before_a_restart_gets_a_resetting_snapshot(self):
        # 服务端重启后序号从头数：客户端手里那个「未来」的序号说明它的状态已过期。
        frames = drain(bus.subscribe(last_id=999))
        self.assertEqual(kinds(frames), ["snapshot"])
        self.assertIs(frames[0]["reset"], True)

    def test_a_call_still_running_is_in_the_snapshot(self):
        call_id = bus.begin("/v1/messages", key="k9")
        bus.meta("glm-5", False)
        entry = drain(bus.subscribe())[0]["live"][0]
        self.assertEqual(entry["id"], call_id)
        self.assertEqual(entry["key"], "k9")
        self.assertEqual(entry["model"], "glm-5")
        self.assertIs(entry["stream"], False)
        self.assertEqual(entry["route"], "/v1/messages")

    def test_a_reconnect_inside_the_ring_resumes_where_it_left_off(self):
        first = bus.subscribe()
        snapshot = drain(first)[0]
        bus.begin("/v1/chat/completions")
        bus.finish({"outcome": "completed"})
        self.assertEqual(kinds(drain(first)), ["start", "finish"])
        bus.unsubscribe(first)
        # 浏览器带着它看到的最后一个序号回来：只补发之后的帧，不再发快照。
        resumed = bus.subscribe(snapshot["seq"])
        frames = drain(resumed)
        self.assertEqual(kinds(frames), ["start", "finish"])
        self.assertGreater(frames[0]["seq"], snapshot["seq"])
        bus.unsubscribe(resumed)
        # 已经看到最后一帧的观众回来：什么都不补。
        upto_date = bus.subscribe(frames[-1]["seq"])
        self.assertEqual(drain(upto_date), [])
        bus.unsubscribe(upto_date)

    def test_a_client_that_missed_nothing_gets_silence(self):
        # 拿到快照后立刻重连：环是空的，但什么都没发生，再来一份快照只是噪声。
        first = bus.subscribe()
        snapshot = drain(first)[0]
        bus.unsubscribe(first)
        resumed = bus.subscribe(snapshot["seq"])
        self.assertEqual(drain(resumed), [])

    def test_a_first_visit_is_not_a_reset(self):
        self.assertIs(drain(bus.subscribe())[0]["reset"], False)

    def test_a_usage_row_without_a_trace_still_shows_up(self):
        # 视频任务在别的线程里结束：没有开始帧，这一次调用照样要出现在画面上。
        sub = bus.subscribe()
        drain(sub)
        call_id = bus.finish({"model": "veo", "kind": "video", "outcome": "completed"})
        frames = drain(sub)
        self.assertEqual(kinds(frames), ["finish"])
        self.assertEqual(frames[0]["id"], call_id)
        self.assertEqual(frames[0]["row"]["kind"], "video")

    def test_a_rejected_call_is_closed_with_its_status(self):
        sub = bus.subscribe()
        drain(sub)
        call_id = bus.begin("/v1/chat/completions", key="k1")
        bus.meta("gpt-5", False)
        bus.status(429)
        # 请求收尾：没写用量行，这一条也得有结束。
        self.assertEqual(bus.finish_open(), call_id)
        frames = drain(sub)
        self.assertEqual(kinds(frames), ["start", "meta", "finish"])
        row = frames[-1]["row"]
        self.assertEqual(row["outcome"], "rejected")
        self.assertEqual(row["status"], 429)
        self.assertEqual(row["model"], "gpt-5")
        self.assertEqual(row["key"], "k1")
        self.assertEqual(row["route"], "/v1/chat/completions")
        self.assertEqual(row["kind"], "chat")
        self.assertIn("error", row)
        self.assertRegex(row["iso"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$")
        self.assertLessEqual(row["elapsed_ms"], 5000)
        # 收尾只管一次：同一条线程上再收一次什么也不发。
        self.assertIsNone(bus.finish_open())
        self.assertEqual(drain(sub), [])

    def test_an_unrecorded_success_is_closed_as_completed(self):
        sub = bus.subscribe()
        drain(sub)
        bus.begin("/v1/tools/search")
        bus.finish_open()
        row = drain(sub)[-1]["row"]
        self.assertEqual(row["outcome"], "completed")
        self.assertEqual(row["status"], 200)
        self.assertEqual(row["kind"], "web")
        self.assertNotIn("error", row)

    def test_a_recorded_status_survives_a_redirect(self):
        sub = bus.subscribe()
        drain(sub)
        bus.begin("/v1/videos")
        bus.status(307)
        bus.finish_open()
        self.assertEqual(drain(sub)[-1]["row"]["outcome"], "completed")

    def test_a_usage_row_closes_the_trace_so_the_cleanup_is_a_no_op(self):
        sub = bus.subscribe()
        drain(sub)
        call_id = bus.begin("/v1/chat/completions")
        self.assertEqual(bus.finish({"outcome": "completed"}), call_id)
        self.assertIsNone(bus.finish_open())
        self.assertEqual(kinds(drain(sub)), ["start", "finish"])

    def test_a_gemini_loopback_joins_the_outer_call(self):
        sub = bus.subscribe()
        drain(sub)
        outer = bus.begin("/v1beta/models/gemini:generateContent", key="k1")
        self.assertEqual(bus.current_id(), outer)
        seen = {}

        def inner_request():
            # 回环那一次带着外层的 id 进来：不新开一条，也不发开始帧。
            seen["id"] = bus.begin("/v1/chat/completions", key="k1", adopt=outer)
            seen["finish"] = bus.finish({"model": "gemini", "outcome": "completed"})

        thread = threading.Thread(target=inner_request)
        thread.start()
        thread.join(5)
        self.assertEqual(seen["id"], outer)
        self.assertEqual(seen["finish"], outer)
        self.assertEqual(kinds(drain(sub)), ["start", "finish"])
        # 外层请求收尾时这一条早已关闭：不会多出第二次结束。
        self.assertIsNone(bus.finish_open())
        self.assertEqual(drain(sub), [])
        self.assertEqual(bus.stats()["live"], 0)

    def test_an_unknown_adopted_id_opens_its_own_call(self):
        inner_id = bus.begin("/v1/chat/completions", adopt="not-a-trace")
        self.assertTrue(inner_id)
        self.assertNotEqual(inner_id, "not-a-trace")
        self.assertEqual(bus.stats()["live"], 1)

    def test_a_trace_does_not_leak_to_the_next_request_on_the_thread(self):
        # 一条 keep-alive 线程服务很多请求：上一条没关好，下一条的用量会记到
        # 它头上。begin 总是另起一条，finish 之后线程上不留东西。
        first = bus.begin("/v1/chat/completions")
        bus.finish({"outcome": "failed"})
        second = bus.begin("/v1/responses")
        self.assertNotEqual(first, second)
        self.assertEqual(bus.current_id(), second)
        bus.finish_open()
        self.assertIsNone(bus.current_id())

    def test_a_laggard_is_reset_instead_of_stalling_the_caller(self):
        slow = bus.subscribe()
        fast = bus.subscribe()
        drain(slow)
        drain(fast)
        for _ in range(bus.QUEUE_MAX):
            slow.queue.put_nowait({"type": "fill"})
        started = time.monotonic()
        for _ in range(5):
            bus.begin("/v1/chat/completions")   # must return promptly, never block
        self.assertLess(time.monotonic() - started, 1.0)
        self.assertTrue(slow.dead)
        reset = bus.next_frame(slow, 0.01)
        self.assertEqual((reset["type"], reset["reason"]), ("reset", "lagged"))
        # 另一条正常的流不受影响。
        self.assertFalse(fast.dead)
        self.assertEqual(kinds(drain(fast)), ["start"] * 5)

    def test_the_subscriber_cap_leaves_the_gateway_untouched(self):
        subs = [bus.subscribe() for _ in range(bus.SUBSCRIBER_MAX)]
        self.assertEqual(bus.stats()["subscribers"], bus.SUBSCRIBER_MAX)
        self.assertIsNone(bus.subscribe())
        bus.unsubscribe(subs[0])
        self.assertIsNotNone(bus.subscribe())
        bus.unsubscribe(subs[0])      # unsubscribing twice is harmless
        self.assertEqual(bus.stats()["subscribers"], bus.SUBSCRIBER_MAX)

    def test_the_in_flight_cap_is_bounded(self):
        for _ in range(bus.LIVE_MAX + 3):
            bus.begin("/v1/chat/completions")
        self.assertEqual(bus.stats()["live"], bus.LIVE_MAX)

    def test_a_call_that_never_ends_is_reaped(self):
        bus.begin("/v1/chat/completions")
        later = time.time() + bus.STALE_SECONDS + 5
        with mock.patch.object(bus.time, "time", return_value=later):
            bus.begin("/v1/chat/completions")
        self.assertEqual(bus.stats()["live"], 1)

    def test_hook_failures_never_reach_the_caller(self):
        self.assertIsNotNone(bus.begin(None))
        self.assertIsNotNone(bus.begin("/x", key=object(), content_length=object()))
        self.assertIsNotNone(bus.finish(None))
        self.assertEqual(bus.stats()["recent"], 1)
        # 没有在途调用时这些全是空操作，而不是异常。
        bus.meta("m", True)
        bus.bind("a")
        bus.tick()
        bus.status(500)
        self.assertIsNone(bus.current_id())
        self.assertIsNone(bus.finish_open())

    def test_route_decides_the_call_type(self):
        table = {
            "/v1/chat/completions": "chat", "/chat/completions": "chat",
            "/v1/completions": "chat", "/v1/responses": "chat",
            "/v1/responses/compact": "chat", "/v1/messages": "chat",
            "/v1beta/models/g:streamGenerateContent": "chat",
            "/v1/images/generations": "image", "/v1/images/edits": "image",
            "/u/ref/v1/images/generations": "image",
            "/v1/videos": "video", "/v1/audio/speech": "tts",
            "/v1/audio/transcriptions": "asr", "/v1/tools/search": "web",
            "/u/abc/v1/chat/completions": "chat", "/something/else": "chat",
        }
        for route, kind in table.items():
            with self.subTest(route=route):
                self.assertEqual(bus.kind_for(route), kind)

    def test_render_is_standard_sse_with_the_sequence_as_id(self):
        text = bus.render({"type": "start", "seq": 7, "id": "abc"})
        self.assertEqual(
            text, 'id: 7\nevent: start\ndata: {"type":"start","seq":7,"id":"abc"}\n\n')
        # 没有序号的帧（进度帧、重置帧）不带 id：浏览器无从续传。
        self.assertTrue(bus.render({"type": "reset"}).startswith("event: reset\n"))

    def test_render_keeps_a_frame_on_one_data_line(self):
        text = bus.render({"type": "finish", "seq": 1,
                           "row": {"message": "line one\nline two\r\n\r\nid: 99"}})
        head, _, data = text.partition("data: ")
        self.assertEqual(data.count("\n"), 2)     # only the frame's own terminator
        self.assertNotIn("\nid: 99", text)

    def test_render_masks_the_same_way_the_usage_listing_does(self):
        seen = []

        def mask(frame):
            seen.append(frame["type"])
            return dict(frame, row=dict(frame.get("row") or {}, message="138****5678"))

        bus.configure(redact=mask)
        text = bus.render({"type": "finish", "row": {"message": "call 13812345678"}})
        self.assertIn("138****5678", text)
        self.assertNotIn("13812345678", text)
        self.assertEqual(seen, ["finish"])


class MemoryRequest(proxy.Handler):
    """The real Handler with its socket replaced by memory.

    The hooks are wired into do_POST and the request cleanup, so the request has
    to go through the real dispatcher for a test to mean anything.
    ``hang_up_after`` makes the Nth write fail, which is what a dashboard closing
    its tab looks like to the stream handler. ``stall`` parks the first write
    until release(), the picture of a client that has stopped reading.
    """

    def __init__(self, path, headers=None, command="GET", body=b"", hang_up_after=None,
                 stall=False):
        self.path = path
        self.command = command
        self.request_version = "HTTP/1.1"
        self.close_connection = True
        # 网关按 Content-Length 读请求体；不带的话它读到的是 0 字节。
        fields = dict(headers or {})
        if body:
            fields.setdefault("Content-Length", str(len(body)))
        self.headers = email.message_from_string(
            "".join("%s: %s\r\n" % item for item in fields.items()))
        self.rfile = io.BytesIO(body)
        self.out = io.BytesIO()
        self.wfile = self                   # wfile.write() lands in out
        self.status = None
        self.sent_headers = []
        self.writes = 0
        self.hang_up_after = hang_up_after
        self._stall = threading.Event() if stall else None
        self.client_address = ("127.0.0.1", 0)

    def write(self, data):
        self.writes += 1
        if self._stall is not None:
            self._stall.wait(10)
            self._stall = None
        if self.hang_up_after is not None and self.writes > self.hang_up_after:
            raise ConnectionResetError("client hung up")
        self.out.write(data)

    def release(self):
        if self._stall is not None:
            self._stall.set()

    def flush(self):
        pass

    def send_response(self, code, message=None):
        self.status = code

    def send_header(self, key, value):
        self.sent_headers.append((key, value))

    def end_headers(self):
        pass

    def log_message(self, fmt, *args):
        pass


class NoEvents(object):
    """What wb_proxy falls back to when the module is missing from a package."""

    def __getattr__(self, name):
        return lambda *args, **kwargs: None


class HookTests(unittest.TestCase):
    """The hooks inside the gateway: where they sit and what they emit."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="panel-events-")
        self.addCleanup(self._tmp.cleanup)
        self.directory = self._tmp.name
        bus.reset()
        self.addCleanup(bus.reset)

    def post(self, path, body, headers):
        request = MemoryRequest(path, headers=headers, command="POST", body=body)
        with mock.patch.multiple(proxy, ACCOUNTS_DIR=self.directory, API_KEY=None,
                                 POOL=None, fetch_models=injected_models):
            request.do_POST()
        return request

    def test_a_refused_call_is_started_and_closed_by_the_real_dispatcher(self):
        # 坏 JSON：鉴权通过、body 解析失败，既没有用量行也没有模型。
        sub = bus.subscribe()
        drain(sub)
        request = self.post("/v1/chat/completions", b"{not json",
                            {"X-Panel-Token": proxy.PANEL.create()})
        self.assertEqual(request.status, 400)
        self.assertEqual(kinds(drain(sub)), ["start"])
        self.assertEqual(bus.stats()["live"], 1)
        # 请求收尾（handle_one_request 的 finally）把这一条关掉。
        bus.finish_open()
        finish = drain(sub)[0]
        self.assertEqual(finish["type"], "finish")
        self.assertEqual(finish["row"]["outcome"], "rejected")
        self.assertEqual(finish["row"]["status"], 400)
        self.assertEqual(bus.stats()["live"], 0)

    def test_a_call_that_reaches_the_pool_is_traced_with_its_model(self):
        sub = bus.subscribe()
        drain(sub)
        request = self.post("/chat/completions", chat_body(),
                            {"X-Panel-Token": proxy.PANEL.create()})
        self.assertGreaterEqual(request.status, 400)     # no pool: it cannot succeed
        frames = drain(sub)
        self.assertEqual(kinds(frames)[:2], ["start", "meta"])
        start, finish = frames[0], frames[-1]
        self.assertEqual(finish["type"], "finish")
        self.assertEqual(finish["id"], start["id"])
        self.assertEqual(frames[1]["model"], MODEL_ID)
        self.assertIs(frames[1]["stream"], False)
        self.assertEqual(finish["row"]["status"], request.status)
        # 无论结束来自用量行还是请求收尾，都只结束一次。
        self.assertIsNone(bus.finish_open())
        self.assertEqual(drain(sub), [])

    def test_a_streamed_call_reports_its_stream_flag(self):
        sub = bus.subscribe()
        drain(sub)
        body = json.dumps({"model": MODEL_ID, "stream": True,
                           "messages": [{"role": "user", "content": "hi"}]}).encode()
        self.post("/v1/chat/completions", body, {"X-Panel-Token": proxy.PANEL.create()})
        frames = drain(sub)
        self.assertEqual([frame["type"] for frame in frames[:2]], ["start", "meta"])
        self.assertIs(frames[1]["stream"], True)

    def test_account_management_writes_are_not_calls(self):
        sub = bus.subscribe()
        drain(sub)
        self.post("/accounts/import", b"[]", {"X-Panel-Token": proxy.PANEL.create()})
        self.assertEqual(drain(sub), [])
        self.assertEqual(bus.stats()["live"], 0)

    def test_a_keyless_deployment_traces_calls_too(self):
        sub = bus.subscribe()
        drain(sub)
        with mock.patch.object(proxy, "auth_required", return_value=False):
            self.post("/v1/chat/completions", b"{not json", {})
        self.assertEqual(kinds(drain(sub)), ["start"])

    def test_the_stream_is_closed_to_everything_but_a_panel_session(self):
        for label, headers in (("anonymous", {}),
                               ("an API key alone", {"Authorization": "Bearer nope"}),
                               ("a wrong panel token", {"X-Panel-Token": "nope"})):
            with self.subTest(label=label):
                request = MemoryRequest("/usage/events", headers=headers)
                request.do_GET()
                self.assertEqual(request.status, 401)
                self.assertEqual(bus.stats()["subscribers"], 0)

    def open_stream_until(self, hang_up_after=1, headers=None, **kwargs):
        """Run the stream handler on its own thread; return (thread, request)."""
        request = MemoryRequest("/usage/events", headers=headers,
                                hang_up_after=hang_up_after, **kwargs)
        thread = threading.Thread(target=request.do_GET)
        thread.start()
        deadline = time.time() + 5
        while time.time() < deadline and bus.stats()["subscribers"] == 0:
            time.sleep(0.01)
        return thread, request

    def test_a_panel_session_gets_a_snapshot_then_holds_the_line(self):
        thread, request = self.open_stream_until(
            headers={"X-Panel-Token": proxy.PANEL.create()})
        self.assertEqual(bus.stats()["subscribers"], 1)
        bus.begin("/v1/chat/completions")
        thread.join(5)
        self.assertFalse(thread.is_alive())
        self.assertEqual(request.status, 200)
        headers = dict(request.sent_headers)
        self.assertEqual(headers["Content-Type"], "text/event-stream; charset=utf-8")
        self.assertEqual(headers["X-Accel-Buffering"], "no")
        self.assertEqual(headers["Cache-Control"], "no-cache")
        self.assertEqual(headers["Connection"], "close")
        wire = request.out.getvalue()
        self.assertTrue(wire.startswith(b"id: "), wire[:80])
        self.assertIn(b"event: snapshot", wire)
        # 随后来的开始帧写到了断开的连接上：第二次写失败，流到此为止。
        self.assertEqual(request.writes, 2)
        # 客户端走后订阅随之注销：连接线程不泄漏。
        self.assertEqual(bus.stats()["subscribers"], 0)

    def test_an_awkward_last_event_id_still_gets_a_snapshot(self):
        for odd in ("soon", "-4", "1e9", ""):
            with self.subTest(last_id=odd):
                bus.reset()
                thread, request = self.open_stream_until(
                    headers={"X-Panel-Token": proxy.PANEL.create(),
                             "Last-Event-ID": odd})
                bus.begin("/v1/chat/completions")
                thread.join(5)
                self.assertEqual(request.status, 200)
                self.assertIn(b"event: snapshot", request.out.getvalue())

    def test_a_laggard_is_told_to_resync_and_the_stream_ends(self):
        # 客户端停止读取：第一帧写不出去，队列只能涨。涨满之后不能反过来
        # 拖住请求线程——订阅者被标记重置，等它恢复读取时收到的是 reset 而不是
        # 一大段过期帧，流随之结束，由面板重连。
        thread, request = self.open_stream_until(
            hang_up_after=None, stall=True,
            headers={"X-Panel-Token": proxy.PANEL.create()})
        for _ in range(bus.QUEUE_MAX):
            self.assertTrue(bus.begin("/v1/chat/completions"))     # never blocks
        self.assertTrue(bus.begin("/v1/chat/completions"))         # one over the brim
        request.release()
        thread.join(10)
        self.assertFalse(thread.is_alive())
        self.assertEqual(request.status, 200)
        wire = request.out.getvalue()
        # 恢复读取后收到的不是积压的旧帧，而是重置；流到此结束。
        self.assertEqual(wire.count(b"event: "), 2)
        self.assertIn(b"event: snapshot", wire)
        self.assertIn(b'event: reset\ndata: {"type":"reset","reason":"lagged"', wire)
        self.assertEqual(bus.stats()["subscribers"], 0)

    def test_too_many_streams_answer_503(self):
        subs = [bus.subscribe() for _ in range(bus.SUBSCRIBER_MAX)]
        try:
            request = MemoryRequest("/usage/events", headers={
                "X-Panel-Token": proxy.PANEL.create()})
            request.do_GET()
            self.assertEqual(request.status, 503)
        finally:
            for sub in subs:
                bus.unsubscribe(sub)

    def test_every_hook_is_fail_safe(self):
        # 打包漏掉模块时 wb_proxy 用空实现顶上：整条请求路径照常工作。
        with mock.patch.object(proxy, "wb_panel_events", NoEvents()):
            request = self.post("/v1/chat/completions", chat_body(), {
                "X-Panel-Token": proxy.PANEL.create()})
            self.assertGreaterEqual(request.status, 400)
            refused = self.post("/v1/chat/completions", b"{not json", {
                "X-Panel-Token": proxy.PANEL.create()})
            self.assertEqual(refused.status, 400)
            stream = MemoryRequest("/usage/events", headers={
                "X-Panel-Token": proxy.PANEL.create()})
            stream.do_GET()
            self.assertEqual(stream.status, 503)

    def test_the_request_cleanup_is_wired_in(self):
        # 收尾挂在 handle_one_request 的 finally 上：所有响应路径都会经过它。
        source = inspect.getsource(proxy.Handler.handle_one_request)
        self.assertIn("finally:", source)
        self.assertIn("wb_panel_events.finish_open()", source)


class _Stream(threading.Thread):
    """One live /usage/events connection on a raw socket, parsed into frames."""

    HEAD_END = b"\r\n\r\n"

    def __init__(self, port, headers):
        threading.Thread.__init__(self, daemon=True)
        self.port = port
        self.headers = headers
        self.frames = []
        self.raw = b""
        self.head = b""
        self.error = None
        self.sock = None

    def run(self):
        try:
            self.sock = socket.create_connection(("127.0.0.1", self.port), timeout=10)
            head = "GET /usage/events HTTP/1.1\r\nHost: x\r\n"
            head += "".join("%s: %s\r\n" % item for item in self.headers.items())
            self.sock.sendall((head + "\r\n").encode())
            buffer = b""
            while True:
                data = self.sock.recv(65536)
                if not data:
                    break
                buffer += data
                # 先吃掉响应头：它同样以空行结尾，不能当成第一帧。
                if not self.head:
                    if self.HEAD_END not in buffer:
                        continue
                    self.head, buffer = buffer.split(self.HEAD_END, 1)
                while b"\n\n" in buffer:
                    frame, buffer = buffer.split(b"\n\n", 1)
                    self.raw += frame + b"\n\n"
                    self.frames.append(self.parse(frame))
        except Exception as exc:            # the suite closes the socket to stop
            self.error = exc

    @staticmethod
    def parse(frame):
        """One SSE frame: its ``event`` line plus the JSON on its ``data`` line.

        The frame's ``id:`` line is the event number and the data repeats it as
        ``seq``; the data's own ``id`` is the call, so the line is not kept.
        """
        out = {}
        for line in frame.decode("utf-8").split("\n"):
            key, _, value = line.partition(": ")
            if key == "data":
                out.update(json.loads(value))
            elif key == "event":
                out["event"] = value
        return out

    def stop(self):
        if self.sock is not None:
            try:
                self.sock.close()
            except OSError:
                pass


class LiveGatewayTests(unittest.TestCase):
    """A real gateway on a spare port: the frames as they cross the wire."""

    @classmethod
    def setUpClass(cls):
        cls._work = tempfile.TemporaryDirectory(prefix="events-live-")
        store = os.path.join(cls._work.name, "accounts")
        os.makedirs(store)
        with open(os.path.join(store, "settings.json"), "w", encoding="utf-8") as fh:
            json.dump({"api_keys": [{"id": "k1", "name": "t", "key": KEY,
                                     "enabled": True}]}, fh)
        cls.port = life.free_port()
        cls.proc = life.spawn_managed(
            [PY, os.path.join(ROOT, "wb_proxy.py"), "--port", str(cls.port),
             "--host", "127.0.0.1", "--accounts-dir", store,
             "--panel-password", PASSWORD],
            cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT,
            env=dict(os.environ,
                     WB_PROXY_USAGE_DIR=os.path.join(cls._work.name, "usage"),
                     # 这一套件不该碰网络：更新检查指向一个不存在的域名。
                     WB_UPDATE_REPO="offline.invalid/none"))
        cls.ready = False
        for _ in range(40):
            time.sleep(0.5)
            try:
                if cls.http("GET", "/health")[0] == 200:
                    cls.ready = True
                    break
            except Exception:
                if cls.proc.poll() is not None:
                    break

    @classmethod
    def tearDownClass(cls):
        life.stop_managed(cls.proc)
        cls._work.cleanup()

    @classmethod
    def http(cls, method, path, body=None, headers=None, conn=None):
        own = conn is None
        conn = conn or http.client.HTTPConnection("127.0.0.1", cls.port, timeout=20)
        try:
            conn.request(method, path, body=body, headers=headers or {})
            resp = conn.getresponse()
            return resp.status, dict(resp.getheaders()), resp.read()
        finally:
            if own:
                conn.close()

    def setUp(self):
        if not self.ready:
            self.fail("the gateway did not start")
        status, _, body = self.http("POST", "/panel/login",
                                    json.dumps({"password": PASSWORD}).encode())
        self.assertEqual(status, 200, body)
        self.token = json.loads(body)["token"]

    def call(self, body, conn=None):
        return self.http("POST", "/v1/chat/completions", body, {
            "Authorization": "Bearer " + KEY, "Content-Type": "application/json"},
            conn=conn)

    def wait_for(self, stream, count, timeout=10):
        deadline = time.time() + timeout
        while time.time() < deadline and len(stream.frames) < count:
            if stream.error is not None:
                break
            time.sleep(0.02)
        return list(stream.frames[:count])

    def test_the_route_answers_to_the_panel_session_only(self):
        for label, headers in (("anonymous", {}),
                               ("an API key alone", {"Authorization": "Bearer " + KEY}),
                               ("a wrong panel token", {"X-Panel-Token": "nope"})):
            with self.subTest(label=label):
                status, _, body = self.http("GET", "/usage/events", headers=headers)
                self.assertEqual(status, 401)
                self.assertIn(PANEL_ONLY_MESSAGE, body.decode())

    def test_every_call_crosses_the_wire_start_to_finish(self):
        stream = _Stream(self.port, {"X-Panel-Token": self.token})
        stream.start()
        try:
            first = self.wait_for(stream, 1)
            self.assertTrue(first, "the stream sent nothing")
            self.assertEqual(first[0]["event"], "snapshot")
            self.assertIn(("id: %d\n" % first[0]["seq"]).encode(), stream.raw)

            # 同一条 keep-alive 连接连发两次：同一个服务端线程，帧的先后是确定的。
            conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=20)
            try:
                # 一次被拒的调用（坏 JSON）：没有用量行，靠请求收尾结束。
                status, _, _ = self.call(b"{not json", conn=conn)
                self.assertEqual(status, 400)
                # 一次走到账号池入口的调用：没有账号，失败。
                pool_status, _, _ = self.call(chat_body(), conn=conn)
                self.assertGreaterEqual(pool_status, 400)
            finally:
                conn.close()

            frames = self.wait_for(stream, 6)
            # 进度帧按时间发，可能恰好插在中间：它不属于调用的生命周期。
            frames = [f for f in stream.frames if f["event"] != "live"]
            self.assertEqual([f["event"] for f in frames],
                             ["snapshot", "start", "finish", "start", "meta", "finish"],
                             stream.raw.decode("utf-8", "replace"))
            rejected, pooled = frames[1:3], frames[3:6]
            self.assertEqual(rejected[0]["id"], rejected[1]["id"])
            self.assertEqual(rejected[0]["route"], "/v1/chat/completions")
            self.assertEqual(rejected[1]["row"]["outcome"], "rejected")
            self.assertEqual(rejected[1]["row"]["status"], 400)
            self.assertEqual(pooled[0]["id"], pooled[2]["id"])
            self.assertEqual(pooled[1]["model"], MODEL_ID)
            self.assertIs(pooled[1]["stream"], False)
            self.assertEqual(pooled[2]["row"]["status"], pool_status)
            seqs = [f["seq"] for f in frames]
            self.assertEqual(seqs, sorted(seqs))
            self.assertEqual(len(set(seqs)), len(seqs))
            # 每一帧都把自己的序号写在 id 行上：断线重连靠它续传。
            for frame in frames:
                wire = "id: %d\nevent: %s\n" % (frame["seq"], frame["event"])
                self.assertIn(wire.encode(), stream.raw)
        finally:
            stream.stop()

    def test_a_reconnect_resumes_from_the_last_frame_it_saw(self):
        probe = _Stream(self.port, {"X-Panel-Token": self.token})
        probe.start()
        try:
            snapshot = self.wait_for(probe, 1)[0]
            seq = snapshot["seq"]
        finally:
            probe.stop()
        resumed = _Stream(self.port, {"X-Panel-Token": self.token,
                                     "Last-Event-ID": seq})
        resumed.start()
        try:
            # 环里没有比它更新的帧：什么都不该来，尤其不该再来一份快照。
            time.sleep(1.0)
            self.assertEqual(resumed.frames, [], resumed.raw.decode("utf-8", "replace"))
            self.assertIsNone(resumed.error)
        finally:
            resumed.stop()

    def test_an_id_the_gateway_never_reached_is_told_to_reset(self):
        # 重启后序号从头数。带着一个「未来」的序号回来，说明客户端的状态已经过期。
        stale = _Stream(self.port, {"X-Panel-Token": self.token,
                                    "Last-Event-ID": "999999999"})
        stale.start()
        try:
            frame = self.wait_for(stale, 1)[0]
            self.assertEqual(frame["event"], "snapshot")
            self.assertIs(frame["reset"], True)
        finally:
            stale.stop()


if __name__ == "__main__":
    unittest.main(verbosity=1)
