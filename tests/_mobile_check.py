"""DOM-level mobile layout checks for dashboard.html.

Synthetic fixtures only (fake accounts, fake usage): never touches real
credentials. Starts the gateway on 127.0.0.1:18789 and drives it with
Playwright/Firefox at phone and desktop widths.

Usage:
    python3 _mobile_check.py            # run every check
    python3 _mobile_check.py account    # only checks whose name contains "account"

Screenshots are written to /tmp/mobile-shots for human review; the checks
themselves assert DOM properties (the reviewer model cannot see images).
"""

import json
import os
import shutil
import socket
import subprocess
import sys
import time

FIX = "/tmp/mobile-fixtures"
SHOTS = "/tmp/mobile-shots"
PASSWORD = "testpass123"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # the gateway lives one level up

PASS = FAIL = 0
PORT = 0
BASE = ""


def free_port():
    """Pick a free loopback port so we never collide with another service."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def check(name, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("  [PASS] %s" % name)
    else:
        FAIL += 1
        print("  [FAIL] %s  %s" % (name, extra))


def build_fixtures():
    if os.path.isdir(FIX):
        shutil.rmtree(FIX)
    acc = os.path.join(FIX, "accounts")
    use = os.path.join(FIX, "usage")
    os.makedirs(acc)
    os.makedirs(use)

    def account(uid, nick, realm, enabled=True, slot="", cooldown=0, err=""):
        return {
            "uid": uid,
            "nickname": nick,
            "domain": "www.workbuddy.ai" if realm == "intl" else "www.codebuddy.cn",
            "realm": realm,
            "platform": "CLI",
            "enterpriseId": "",
            "accessToken": "",
            "refreshToken": "",
            "expiresAt": int(time.time()) + 86400 * 30,
            "addedAt": time.time() - 3600,
            "source": "oauth",
            "enabled": enabled,
            "lastError": err,
            "cooldownUntil": cooldown,
            "proxySlot": slot,
            "proxy": "",
            "credits": {"remain": 42, "used": 8, "size": 50, "packages": []},
            "lastCheckin": None,
        }

    accounts = [
        account(
            "11111111-1111-1111-1111-111111111111", "test-user-a", "intl", slot="slot-1"
        ),
        account(
            "22222222-2222-2222-2222-222222222222",
            "test-user-b",
            "intl",
            enabled=False,
            err="HTTP 403",
        ),
        account("33333333-3333-3333-3333-333333333333", "test-user-cn", "cn"),
        account(
            "44444444-4444-4444-4444-444444444444",
            "test-user-d",
            "intl",
            cooldown=time.time() + 45,
            err="HTTP 429",
        ),
    ]
    for a in accounts:
        with open(os.path.join(acc, a["uid"] + ".json"), "w", encoding="utf-8") as fh:
            json.dump(a, fh, ensure_ascii=False, indent=2)

    settings = {
        "proxy_slots": [
            {
                "id": "slot-1",
                "name": "槽 1",
                "url": "http://test-proxy:17901",
                "enabled": True,
            },
            {
                "id": "slot-2",
                "name": "槽 2",
                "url": "http://test-proxy:17902",
                "enabled": True,
            },
        ]
    }
    with open(os.path.join(acc, "settings.json"), "w", encoding="utf-8") as fh:
        json.dump(settings, fh, ensure_ascii=False, indent=2)

    now = time.time()
    with open(os.path.join(use, "usage.jsonl"), "w", encoding="utf-8") as fh:
        for i in range(40):
            ts = now - (40 - i) * 60
            row = {
                "at": ts,
                "iso": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(ts)),
                "model": "deepseek-v4.1-flash" if i % 3 else "glm-5.3",
                "stream": i % 2 == 0,
                "elapsed_ms": 4200 + i * 30,
                "ttft_ms": 1500 + i * 20,
                "gen_ms": 800,
                "prompt_tokens": 12000 + i * 50,
                "completion_tokens": 200 + i,
                "reasoning_tokens": i % 5,
                "cached_tokens": 9000 + i * 40,
                "total_tokens": 12200 + i * 51,
                "credit": 0,
                "cache_hit_pct": 75,
                "tokens_per_sec": 42.5,
                "account": "11111111-1111-1111-1111-111111111111"
                if i % 2
                else "33333333-3333-3333-3333-333333333333",
                "realm": "intl" if i % 2 else "cn",
            }
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")


def set_password():
    # Reuse the project's own hashing so the fixture matches production format.
    sys.path.insert(0, ROOT)
    import wb_settings

    wb_settings.set_panel_password(os.path.join(FIX, "accounts"), PASSWORD)


def wait_port(timeout=20):
    end = time.time() + timeout
    while time.time() < end:
        try:
            with socket.create_connection(("127.0.0.1", PORT), timeout=1):
                return True
        except OSError:
            time.sleep(0.3)
    return False


def wait_identity(timeout=20):
    """Wait until the port answers like our gateway, not some other service."""
    import urllib.request

    end = time.time() + timeout
    while time.time() < end:
        try:
            with urllib.request.urlopen(BASE + "/panel/status", timeout=2) as r:
                data = json.loads(r.read().decode())
                if "panel_password_required" in data:
                    return True
        except Exception:
            time.sleep(0.3)
    return False


HOST_CANDIDATES = ("127.0.0.1", "::")


def start_server():
    """Start the gateway under test and wait for it to answer /health.

    The bind host is probed, not assumed: upstream binds IPv4 only, while a
    deployment that patched in a dual-stack listener only accepts IPv4
    connections on the wildcard socket. The first candidate that answers wins.
    """
    for host in HOST_CANDIDATES:
        proc = subprocess.Popen(
            [
                sys.executable,
                "wb_proxy.py",
                "--host",
                host,
                "--port",
                str(PORT),
                "--accounts-dir",
                os.path.join(FIX, "accounts"),
                "--usage-dir",
                os.path.join(FIX, "usage"),
                "--panel-password",
                PASSWORD,
            ],
            cwd=ROOT,
            env=dict(os.environ),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        if wait_identity():
            return proc
        proc.kill()
        proc.wait()
    raise SystemExit("gateway did not answer on port %d" % PORT)


def login(page):
    page.goto(BASE + "/", timeout=20000)
    page.wait_for_timeout(1200)
    if page.locator("#panelPwdInput").count():
        page.fill("#panelPwdInput", PASSWORD)
        page.click("button:has-text('进入面板')")
        page.wait_for_timeout(1500)


def goto_tab(page, tab):
    # 2026-11 起只剩一套外壳（圣轮/工作台），页面切换统一走 nextGo()。
    page.evaluate("(name) => window.nextGo(name)", tab)
    page.wait_for_timeout(900)


def run_checks(filter_name):
    from playwright.sync_api import sync_playwright

    os.makedirs(SHOTS, exist_ok=True)

    with sync_playwright() as p:
        # 本机通常没有 Playwright 自带的 Firefox / Chromium：优先用系统 Edge / Chrome。
        browser = None
        for channel in ("msedge", "chrome"):
            try:
                browser = p.chromium.launch(channel=channel, headless=True)
                break
            except Exception:
                pass
        if browser is None:
            browser = p.firefox.launch(headless=True)

        # ---------- phone viewport ----------
        page = browser.new_page(viewport={"width": 390, "height": 844})
        login(page)
        page.screenshot(path=os.path.join(SHOTS, "phone-gateway.png"), full_page=True)

        if "nav" in filter_name or filter_name == "":
            # 2026-11 起只有一套外壳：手机上底部导航（#nextBottomNav），桌面上左侧栏。
            # 这里钉几何性质：导航条留在视口内、标签不被截断、不出现横向溢出。
            nav = page.evaluate(
                """
                (() => {
                  const bar = document.getElementById('nextBottomNav');
                  if(!bar) return {ok: false, why: 'missing #nextBottomNav'};
                  const items = Array.from(bar.querySelectorAll('.next-bottom-item'));
                  const r = bar.getBoundingClientRect();
                  return {
                    ok: true,
                    count: items.length,
                    inViewport: r.left >= -1 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1,
                    clipped: items.filter(b => b.scrollWidth > b.clientWidth + 1).length,
                    overflow: Math.round(bar.scrollWidth - bar.clientWidth),
                  };
                })()
                """
            )
            check("bottom-nav-present", nav.get("ok") and nav.get("count", 0) >= 4, nav)
            check("bottom-nav-in-viewport", bool(nav.get("inViewport")), nav)
            check("bottom-nav-labels-not-clipped", nav.get("clipped") == 0, nav)
            check("bottom-nav-no-h-overflow", nav.get("overflow", 1) <= 1, nav)

        if "models" in filter_name or filter_name == "":
            disp = page.evaluate(
                "document.querySelector('#modelsTable tbody tr') ? getComputedStyle(document.querySelector('#modelsTable tbody tr')).display : 'none'"
            )
            check("models-cards", disp == "grid", disp)

        if "growth" in filter_name or filter_name == "":
            # The growth table may be empty (no live CN tasks in fixtures);
            # seed one synthetic row so the card CSS can be asserted.
            page.evaluate(
                """
                (() => {
                  const tb = document.querySelector('#growthTable tbody');
                  if(tb && !tb.querySelector('tr')){
                    tb.innerHTML = '<tr>'
                      + '<td data-label="任务"><b>示例任务</b></td>'
                      + '<td data-label="说明">说明</td>'
                      + '<td data-label="进度">1 / 1</td>'
                      + '<td data-label="奖励">+10 积分</td>'
                      + '<td data-label="状态">待领奖</td></tr>';
                  }
                })()
                """
            )
            disp = page.evaluate(
                "document.querySelector('#growthTable tbody tr') ? getComputedStyle(document.querySelector('#growthTable tbody tr')).display : 'none'"
            )
            check("growth-cards", disp == "grid", disp)

        if "account" in filter_name or filter_name == "":
            # 账号列表自 2026-11 起是独立一页（以前挂在「网关与账号」页里）。
            goto_tab(page, "accounts")
            page.wait_for_timeout(800)
            disp = page.evaluate(
                "getComputedStyle(document.querySelector('#accounts table')).display"
            )
            row_disp = page.evaluate(
                "getComputedStyle(document.querySelector('#accounts tbody tr')).display"
            )
            check(
                "account-cards",
                disp == "block" and row_disp == "grid",
                (disp, row_disp),
            )
            # 窄屏卡片：三个用量数字（请求 / Token / 缓存，都是 td.num）并排一行。
            stats = page.evaluate(
                """
                (() => {
                  const tr = document.querySelector('#accounts tbody tr');
                  const tds = tr ? Array.from(tr.querySelectorAll('td.num')) : [];
                  const rects = tds.map(td => td.getBoundingClientRect());
                  return {
                    grid: tr ? getComputedStyle(tr).display === 'grid' : false,
                    tops: rects.map(r => Math.round(r.top)),
                    widths: rects.map(r => Math.round(r.width)),
                  };
                })()
                """
            )
            tops, stat_w = stats["tops"], stats["widths"]
            check(
                "stats-row",
                stats["grid"]
                and len(tops) == 3
                and max(tops) - min(tops) <= 2
                and len(stat_w) == 3
                and min(stat_w) >= 60,
                (tops, stat_w, stats["grid"]),
            )
            heights = page.evaluate(
                "Array.from(document.querySelectorAll('#accounts button')).filter(b => b.offsetParent).map(b => Math.round(b.getBoundingClientRect().height))"
            )
            check(
                "touch-targets",
                bool(heights) and min(heights) >= 30,
                (min(heights) if heights else None, heights[:6]),
            )
            page.screenshot(
                path=os.path.join(SHOTS, "phone-accounts.png"), full_page=True
            )

        if "analytics" in filter_name or filter_name == "":
            goto_tab(page, "analytics")
            page.wait_for_timeout(1200)
            disp = page.evaluate(
                "document.querySelector('#recent tbody tr') ? getComputedStyle(document.querySelector('#recent tbody tr')).display : 'none'"
            )
            check("analytics-cards", disp == "grid", disp)
            # KPI cards must wrap into a grid, not squeeze into one row.
            kpi = page.evaluate(
                """
                (() => {
                  const cards = Array.from(document.querySelectorAll('#pageAnalytics .kpis .kpi'));
                  if(!cards.length) return {rows: 0, minW: 0, clipped: []};
                  const tops = cards.map(c => Math.round(c.getBoundingClientRect().top));
                  const widths = cards.map(c => Math.round(c.getBoundingClientRect().width));
                  const clipped = cards.filter(c => {
                    const k = c.querySelector('.k'), v = c.querySelector('.v');
                    return (k && k.scrollWidth > k.clientWidth + 2)
                        || (v && v.scrollWidth > v.clientWidth + 2);
                  }).length;
                  return {rows: new Set(tops).size, minW: Math.min.apply(null, widths), clipped: clipped};
                })()
                """
            )
            check(
                "analytics-kpi-wrap",
                kpi["rows"] >= 3 and kpi["minW"] >= 120 and kpi["clipped"] == 0,
                kpi,
            )
            # 用量明细表（#dimTable）在手机上保持表格 + 外层横向滚动：
            # 列多且每格带小条，拆成卡片反而更难读。
            dim = page.evaluate(
                """
                (() => {
                  const t = document.getElementById('dimTable');
                  const wrap = t ? t.closest('.pbody') : null;
                  if(!t) return {ok: false, why: 'missing #dimTable'};
                  return {ok: true, display: getComputedStyle(t).display,
                          scrollable: wrap ? getComputedStyle(wrap).overflowX !== 'visible' : false};
                })()
                """
            )
            check("analytics-dim-table-scrolls", dim.get("ok") and dim.get("display") == "table" and dim.get("scrollable"), dim)
            page.screenshot(
                path=os.path.join(SHOTS, "phone-analytics.png"), full_page=True
            )

        if "slots" in filter_name or filter_name == "":
            goto_tab(page, "settings")
            page.wait_for_timeout(800)
            disp = page.evaluate(
                "document.querySelector('#slotList tbody tr') ? getComputedStyle(document.querySelector('#slotList tbody tr')).display : 'none'"
            )
            check("slots-cards", disp == "grid", disp)
            kv = page.evaluate(
                "getComputedStyle(document.querySelector('#pageSettings table:not(.data-cards)')).display"
            )
            check("kv-table-intact", kv == "table", kv)
            page.screenshot(
                path=os.path.join(SHOTS, "phone-settings.png"), full_page=True
            )

        if "log" in filter_name or filter_name == "":
            goto_tab(page, "logs")
            page.wait_for_timeout(800)
            h = page.evaluate(
                "document.querySelector('#logTerminalBody').getBoundingClientRect().height"
            )
            check("log-terminal-height", h <= 844 * 0.65 + 1, h)
            page.screenshot(path=os.path.join(SHOTS, "phone-logs.png"), full_page=True)

        if "modal" in filter_name or filter_name == "":
            goto_tab(page, "gateway")
            page.evaluate("openLoginModal()")
            page.wait_for_timeout(600)
            mw = page.evaluate(
                "document.querySelector('.modal-mask.show .modal').getBoundingClientRect().width"
            )
            check("modal-fits", mw >= 390 - 24, mw)
            page.screenshot(path=os.path.join(SHOTS, "phone-modal.png"))
            page.evaluate("closeLogin()")

        if "overflow" in filter_name or filter_name == "":
            bad = []
            for tab in ("gateway", "analytics", "logs", "settings"):
                goto_tab(page, tab)
                page.wait_for_timeout(500)
                sw = page.evaluate("document.documentElement.scrollWidth")
                if sw > 391:
                    bad.append((tab, sw))
            check("no-h-overflow", not bad, bad)
        page.close()

        # ---------- desktop viewport (regression) ----------
        dpage = browser.new_page(viewport={"width": 1280, "height": 800})
        login(dpage)
        if "desktop" in filter_name or filter_name == "":
            disp = dpage.evaluate(
                "getComputedStyle(document.querySelector('#accounts table')).display"
            )
            row_disp = dpage.evaluate(
                "getComputedStyle(document.querySelector('#accounts tbody tr')).display"
            )
            check(
                "desktop-table",
                disp == "table" and row_disp == "table-row",
                (disp, row_disp),
            )
        dpage.screenshot(
            path=os.path.join(SHOTS, "desktop-gateway.png"), full_page=True
        )
        dpage.close()
        browser.close()


def main():
    global PORT, BASE
    filter_name = sys.argv[1] if len(sys.argv) > 1 else ""
    PORT = free_port()
    BASE = "http://127.0.0.1:%d" % PORT
    build_fixtures()
    set_password()
    proc = start_server()
    try:
        run_checks(filter_name)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
    print()
    print("PASS=%d FAIL=%d" % (PASS, FAIL))
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
