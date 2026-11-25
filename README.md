# WorkBuddy2API-Hub — 国际版 / 国内版多账号网关

> 把 WorkBuddy（国际版 / 国内版）与华为云 CodeArts 封装成 OpenAI 兼容 API 的本地网关：多账号池、独立出口、自动故障转移、可视化看板。

<p align="center">
  <a href="https://github.com/mkktop/workbuddy2api-hub/releases"><img src="https://img.shields.io/github/v/release/mkktop/workbuddy2api-hub?style=flat-square&label=release" alt="Release"></a>
  <a href="https://github.com/mkktop/workbuddy2api-hub/actions/workflows/tests.yml"><img src="https://github.com/mkktop/workbuddy2api-hub/actions/workflows/tests.yml/badge.svg" alt="tests"></a>
  <a href="https://github.com/mkktop/workbuddy2api-hub/pkgs/container/workbuddy2api-hub"><img src="https://img.shields.io/badge/GHCR-workbuddy2api--hub-blue?style=flat-square" alt="GHCR"></a>
  <img src="https://img.shields.io/badge/Python-3.9+-blue.svg?style=flat-square" alt="Python">
  <img src="https://img.shields.io/badge/API-OpenAI_Compatible-412991?style=flat-square" alt="OpenAI API">
  <img src="https://img.shields.io/badge/Dual_Realm-Intl_%26_CN-0DBD8B?style=flat-square" alt="Dual Realm">
  <img src="https://img.shields.io/badge/License-MIT-green.svg?style=flat-square" alt="License">
</p>

## 目录

- [项目简介](#intro)
- [核心特性](#features)
- [快速开始](#quick-start)
  - [Docker 部署（推荐）](#docker)
  - [本机运行](#local)
  - [源码运行与性能](#python-module)
  - [TLS 出站桥](#tls-bridge)
  - [CodeArts 原生第三出口](#codearts)
- [账号接入与 API Key 权限](#accounts)
- [客户端接入配置](#clients)
- [常用环境变量](#env)
- [主要 API 端点](#endpoints)
- [测试与 CI](#tests)
- [更新与发布](#release)
- [安全与风险](#security)
- [赞助商](#sponsors)
- [致谢与引用声明](#credits)
- [免责声明](#disclaimer)
- [许可证](#license)
- [Star 趋势](#star-history)

<a id="intro"></a>
## 项目简介

本项目运行在你自己的电脑、NAS 或服务器上，把 WorkBuddy 官方客户端使用的接口转换成标准 OpenAI 协议（Chat Completions / Responses），并额外适配 Anthropic Messages（实验性）与华为云 CodeArts。转换后的地址可以直接给 Codex、Claude Code、NextChat 等客户端使用。

适合：个人多账号管理、局域网共享、协议研究与自用自动化。  
不适合：商业转售、共享账号、把管理面板直接暴露在公网。

> [!IMPORTANT]
> **凭证安全**：账号凭证只保存在本机 `accounts/` 目录，不会上传到第三方服务器。管理面板默认密码是 `admin`，首次登录请立即修改；不要把 `8788` 端口或面板直接暴露到公网。
>
> **账号风险**：上游会识别并拦截非官方客户端。2026-10-23 起识别明显收紧，可能随时导致限流、风控或封禁，风险由使用者自行承担。请优先使用官方客户端，不要使用主账号，不要共享账号，也不要用于商业转售。

> ⚡ 本项目是 100% Vibe Coding 协同产物：人类开发者提出架构与业务意图，AI 助手端到端完成逆向分析、链路调度、WAF 指纹脱敏与界面编写。

<a id="features"></a>
## 核心特性

- **标准 API 兼容**：将 WorkBuddy（国际版 / 国内版）与 CodeArts 封装为标准 OpenAI 格式（Chat Completions / Responses），无缝支持 Codex、Claude Code、NextChat 等客户端。
- **开箱即用与多端部署**：便携版免装环境（Windows 自带精简运行时），支持 Docker、NAS（群晖 / 飞牛）一键部署及 OpenWrt 路由器固件。
- **多账号池与出口隔离**：支持浏览器 OAuth 快速导入、每账号独立出口代理槽绑定、设备指纹隔离、自动故障转移与配额轮转。
- **自动化福利与签到**：内置国内版成长任务、星巴克 / 记者节运营活动、小程序任务、加油站签到与猫猫旅行，支持国际版每日活跃会话与 CodeArts 自动签到；手机 App 对话、公众号关注与公益捐赠等必须真实完成的任务只提示、不伪造。
- **可视化管理看板**：提供 Web 仪表盘，支持实时请求日志、Token / 积分透视、多 API Key 权限分发（模型 / 账号白名单）与额度护栏。
- **一键工作台启动**：`start-workbuddy-all.bat` 先用 `--probe-only` 检查端口上的实例是否健康，未运行才拉起网关并打开 WorkBuddy 工作台，避免重复启动或误连陌生服务。
- **自维护发布**：GitHub Actions 自动跑测试、打包 Release 资产并发布多架构镜像 `ghcr.io/mkktop/workbuddy2api-hub`，运行时不依赖上游仓库。

<a id="quick-start"></a>
## 快速开始

<a id="docker"></a>
### Docker 部署（推荐）

预编译多架构镜像（linux/amd64、linux/arm64）发布在 GHCR，无需本地构建。

**方式一：一键脚本**

```bash
# 直连 GitHub 环境：
curl -fsSL https://raw.githubusercontent.com/mkktop/workbuddy2api-hub/main/quick-deploy.sh | bash

# 国内网络 / NAS 加速：
curl -fsSL https://gh-proxy.com/https://raw.githubusercontent.com/mkktop/workbuddy2api-hub/main/quick-deploy.sh | sudo bash
```

> 公网部署或配合反向代理：在管道前指定 `WB_DEPLOY_MODE=public bash`，并搭配 Nginx / Caddy / Cloudflare Tunnel 配置 TLS。

**方式二：单文件 Docker Compose**

```yaml
services:
  wb-proxy:
    image: ghcr.io/mkktop/workbuddy2api-hub:latest
    container_name: wb-proxy
    restart: unless-stopped
    ports:
      - "8788:8788"
    environment:
      - HOST=0.0.0.0
      - PORT=8788
      - TZ=Asia/Shanghai
    volumes:
      - ./accounts:/app/accounts    # 账号凭据与配置（持久化）
      - ./usage:/app/usage          # 用量流水日志（持久化）
```

```bash
docker compose up -d            # 首次启动
docker compose pull && docker compose up -d   # 更新镜像
```

- 建议生产环境把 `:latest` 换成固定版本标签（如 `:v2.4.0`），回滚时改回旧标签并 `docker compose up -d` 即可。
- Compose 默认以 root（`0:0`）运行；如需以宿主用户运行，设置 `PUID` / `PGID` 并确保 `accounts/`、`usage/` 可写。
- Docker 镜像在构建阶段已经编译好当前架构的 Go/uTLS 桥，容器内不需要 Go。未设置 `WB_TLS_FINGERPRINT` 时默认 `auto`；如需彻底关闭桥，可加 `- WB_TLS_FINGERPRINT=python`，卷中的账号、设置和用量不会因此改变。
- 启动后访问 **Web 看板** `http://<主机>:8788/`（默认密码 `admin`，首次登录请修改）与 **API 地址** `http://<主机>:8788/v1`。

<a id="local"></a>
### 本机运行

需要 Python 3.9+。

- **Windows**：双击 `start-wb-proxy.bat`（静默后台运行 + 独立日志窗口）；如需前台控制台窗口，双击 `start-wb-proxy-visible.bat`。
- **macOS / Linux**：双击 `start-wb-proxy.command` 或在终端执行 `./start-wb-proxy.sh [端口]`（默认 `8788`）。
- **局域网共享模式**：运行 `start-wb-proxy-lan.bat`（Windows）或 `./start-wb-proxy-lan.sh`（macOS / Linux），首次启动会自动生成高强度 API Key 并在控制台打印。
- **一键工作台**：`start-workbuddy-all.bat` 先用 `--probe-only` 检查端口上的实例是否健康，未运行才拉起网关并打开工作台，避免重复启动或误连陌生服务。
- 启动后访问 **Web 看板** `http://127.0.0.1:8788/` 与 **API 地址** `http://127.0.0.1:8788/v1`。

<a id="python-module"></a>
### 源码运行与性能

同一份代码、同一个账号池，`python3 wb_proxy.py` 与 `python3 -m wb_proxy` 的常驻内存差 **47–54 MB**（Windows 11 / aarch64、Python 3.12–3.14 四套环境实测一致，见 #702）。成因仍在排查，但只要换成 `-m` 就能拿到这段收益——512 MB 的设备上约 10%。

```bash
cd /path/to/workbuddy2api-hub        # 必须先进入 wb_proxy.py 所在目录
python3 -m wb_proxy --port 8788
```

`-m` 把**当前目录**放进 `sys.path`，而脚本方式放的是脚本所在目录，所以务必先 `cd`。仓库内的资源路径都基于 `__file__` 解析，不受影响。Docker 镜像和 OpenWrt 包已改用 `-m`；Windows / macOS 的 `start-wb-proxy.*` 启动脚本暂未改动。

<a id="tls-bridge"></a>
### TLS 出站桥（默认 `auto`）

未显式配置 TLS 模式的安装默认使用 `WB_TLS_FINGERPRINT=auto`：网关会先尝试随包 Go/uTLS 桥；桥二进制缺失、架构不支持、启动失败、桥进程运行中退出，或当前请求使用自定义 CA / 不兼容代理时，自动回退 Python/OpenSSL。回退只发生在当前进程内，不会反复拉起失败的桥，也不会改变原来的代理出口和证书校验。便携版、Docker 和 OpenWrt 的受支持架构包都自带对应桥，用户不需要安装 Go。

需要强制指定时：

```sh
WB_TLS_FINGERPRINT=python   # 强制 Python/OpenSSL
WB_TLS_FINGERPRINT=node     # 强制桥；桥不可用时报明确错误
```

`node` 模式下不要设置 `WB_TLS_BRIDGE=off`，否则会按显式关闭桥处理而走 Python。OpenWrt 使用 `uci set workbuddy2api.main.tls_mode='auto'`、`'node'` 或 `'python'`。实际模式、最近路线和回退原因可在 `/health`、`/settings` 及面板网络设置中查看。降级到不识别 `auto` 的旧版本前，请临时设置 `WB_TLS_FINGERPRINT=python`。逐路径头顺序、代理 / 桥头隔离和未修改项见 [`docs/OUTBOUND-HEADER-AUDIT.md`](docs/OUTBOUND-HEADER-AUDIT.md)。

<a id="codearts"></a>
### CodeArts 原生第三出口

网关内置进程内直连华为云 CodeArts，支持聊天 SSE 协议转换与自动签到，无需单独运行第三方桥接服务：

1. 打开看板 →「设置 → CodeArts 接入」，勾选「启用 CodeArts 出口」并保存；
2. 切换至看板顶部「CodeArts」视图，点击「+ 添加账号 (OAuth)」完成华为云授权；
3. 在「设置 → API Key」中新建 Key 并绑定出口为 `CodeArts`（或全局通用）即可调用。

CodeArts 的模型 ID 按上游目录**精确匹配**：`deepseek-v4.1-flash` 与 `deepseek-v4.1-flash-1017` 是两个独立模型，不会互相别名或静默回退。`/v1/models?realm=codearts` 返回的是账号当前可用的真实目录 ID；调用时请直接使用返回的完整 ID。

<a id="accounts"></a>
## 账号接入与 API Key 权限

### 账号添加与代理出口绑定

- 打开看板 `http://127.0.0.1:8788/`，点击「+ 添加账号 (OAuth)」，在浏览器中完成官方登录授权即可自动入库。
- **独立代理出口槽（Proxy Slot）**：在看板中可按需配置并命名 HTTP/SOCKS5 出口代理（支持账号密码认证），支持将账号与特定代理槽位绑定，账号身份请求与出站调用均自动走该代理。

### 多 API Key 权限管理

「设置」页支持创建多个独立 API Key：

- **出口绑定**：可固定走国际版、国内版或 CodeArts；
- **模型限制**：支持通配符白名单（如 `deepseek*`、`gpt-6-astra`），违规请求本机直接返回 400；
- **账号白名单**：可精确限定该 Key 仅允许调度的账号范围；
- **用量透视**：数据看板按 Key 独立统计调用次数、Token 消耗、缓存命中与积分。

### 积分调度

- **临期积分优先**：设置 → 账号限额里的「临期积分优先」，默认 7 天。账号「最早到期的积分包」进入窗口后会被优先分派，份额按到期紧迫度和剩余积分加权。
- **每月重置的包**：免费套餐 / 体验版这类「长期有效但按月重置」的积分包默认不计入临期优先，避免月底被误判；如需在重置前先消耗本月额度，打开「每月重置的包也计入临期优先」。
- 积分包明细（来源、剩余、到期或按月重置）见账号页的「积分获取历史」。

<a id="clients"></a>
## 客户端接入配置

- **Base URL**：`http://127.0.0.1:8788/v1`（局域网为 `http://<局域网IP>:8788/v1`）
- **API Key**：看板「设置」中添加并绑定的 Key
- **模型名称**：调用 `/v1/models` 中列出的任意官方对齐模型 ID（如 `deepseek-v4.1-flash`、`gpt-6-astra`、`hy3`）

**Codex CLI / Responses API**

```bash
export OPENAI_BASE_URL="http://127.0.0.1:8788/v1"
export OPENAI_API_KEY="你在看板设置中添加并绑定的API_Key"
```

**Claude Code / Anthropic Messages（实验性）**

网关支持实验性 Messages 协议适配，因长会话缓存命中率差异，默认关闭：

```bash
# 网关端设置 WB_ENABLE_ANTHROPIC_MESSAGES=1 开启后生效：
export ANTHROPIC_BASE_URL="http://127.0.0.1:8788"
export ANTHROPIC_API_KEY="你在看板设置中添加并绑定的API_Key"
```

<a id="env"></a>
## 常用环境变量

### 服务与部署

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8788` | 网关监听端口 |
| `API_KEY` | 自动生成 | 初始 API Key（看板配置多 Key 后优先由看板管理） |
| `WB_DEPLOY_MODE` | `lan` | 部署模式：`lan`（0.0.0.0）、`local`（127.0.0.1）、`public` |
| `WB_MAX_PAYLOAD_BYTES` | `16777216` | 单请求体上限（字节，默认 16 MB，支持 1–256 MB） |
| `WB_TLS_FINGERPRINT` | `auto` | TLS 出站桥模式：`auto` / `python` / `node` |
| `WB_UPDATE_REPO` | `mkktop/workbuddy2api-hub` | 面板更新检查的 GitHub 仓库（`owner/repo`），自建部署可覆盖 |

### 并发、用量与清洗

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `WB_CHAT_SLOT_WAIT` | `30` | 并发槽位的等待秒数：全局对话槽位与 Key 级 `concurrency_limit` 共用这个预算，等到才有名额，超时仍按 429 拒绝 |
| `WB_USAGE_ROTATE_BYTES` | `8388608` | 用量日志的轮转阈值（字节，默认 8 MiB）。`0` 停止新轮转。备份和降级见 [用量目录说明](usage/README.txt) |
| `WB_SANITIZE_LOOSE_BILLING` | `0` | 计费头的宽松兜底：严格解析认不出时，按「像计费头」（含 ≥2 个 `cc_*=` / `cch=` 键值、且不超过 400 字符）整段删除。默认关闭，保持 #853 之后的严格语义；客户端改字段名导致每轮前缀命中率归零时才需要打开 |
| `WB_MSGSTAT_SHARDS` | `0` | 单发 `/v1/messages` 请求收敛到几个账号上（0 = 关闭）。打开后同一 *(key, 模型, system, tools)* 组合的一次性调用固定复用 ≤N 个账号，避免被首条 user 文本打散到整池；上游 prompt 缓存按账号存放，换号即整段重付 |
| `WB_MSGSTAT_DAILY_SALT` | `1` | 上一条的亲和键带当天日期盐，每天各桶重新开一次；`0` 关闭（键跨天不变） |

### 身份与上游调试

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `WB_ENABLE_ANTHROPIC_MESSAGES` | `0` | 是否开启实验性 Anthropic Messages 协议转换 |
| `WB_BACKGROUND_MODEL_TARGET` | 留空 | 后台模型别名改写目标（如 DSH 客户端自动映射） |
| `WB_CA_BUNDLE` | 留空 | 自签根证书路径（供抓包调试或中间代理使用） |
| `WB_CN_CHAT_UPSTREAM` | 官方默认 | 国内版出站代理地址 |
| `WB_IDENTITY_OS` | 宿主系统 | 仅 CLI 身份：覆盖 `x-stainless-os`（如 `Linux` / `Windows`） |
| `WB_IDENTITY_ARCH` | 宿主架构 | 仅 CLI 身份：覆盖 `x-stainless-arch`（如 `x64` / `arm64`） |
| `WB_IDENTITY_NODE_VERSION` | 官方默认 | 仅 CLI 身份：覆盖 `x-stainless-runtime-version` |

遇到上游 `400 / 11-128` 时，先按 [`docs/TROUBLESHOOTING-11-128.md`](docs/TROUBLESHOOTING-11-128.md) 收集同一请求的身份、最小请求和提示词对照结果；不要先轮换账号。

<a id="endpoints"></a>
## 主要 API 端点

| 接口 | 方法 | 端点 | 说明 |
|---|---|---|---|
| 聊天补全 | `POST` | `/v1/chat/completions` | 标准 OpenAI 聊天接口（支持流式 SSE 与思维链回填） |
| 交互式响应 | `POST` | `/v1/responses` | OpenAI Responses 协议接口（Codex 专用） |
| Anthropic Messages | `POST` | `/v1/messages` | 实验性 Messages 协议（需 `WB_ENABLE_ANTHROPIC_MESSAGES=1`） |
| Anthropic Token 计数 | `POST` | `/v1/messages/count_tokens` | 统计 Messages 请求的 token 数 |
| 语音合成 | `POST` | `/v1/audio/speech` | OpenAI 兼容 TTS（WAV / PCM，需在媒体页开启） |
| 语音转写 | `POST` | `/v1/audio/transcriptions` | OpenAI 兼容 ASR（multipart，需在媒体页开启） |
| 模型目录 | `GET` | `/v1/models` | 获取当前出口对齐的官方可用模型列表 |
| 生图 | `POST` | `/v1/images/generations` | 文生图 / 图生图（始终可用，按媒体号池自动选出口） |
| 生视频 | `POST` | `/v1/videos` | 异步生视频任务提交（本地并发排队与空闲调度） |
| 视频状态 | `GET` | `/v1/videos/<id>` | 轮询视频生成进度与结果 |
| 产物下载 | `GET` | `/v1/videos/<id>/content` | 下载视频 MP4 产物直链 |
| 网页搜索 | `POST` | `/v1/tools/search` | 网页搜索网关（需在设置中启用，不消耗模型额度） |
| 网页抓取 | `POST` | `/v1/tools/fetch` | 抓取指定 URL 正文（需在设置中启用） |
| 搜索 + 抓取 | `POST` | `/v1/tools/search_fetch` | 先搜索再抓取结果（需在设置中启用） |
| 余额汇总 | `GET` | `/v1/balance-summary` | 按 API Key 汇总可用 CodeArts 账号积分（Bearer 或 `?key=`） |
| 健康检查 | `GET` | `/health` | 网关运行状态、可用账号数与就绪模型分布 |
| 创建账号授权请求 | `POST` | `/v1/accounts/authorize` | 按 `realm=cn` 或 `intl` 生成一次性浏览器授权链接 |
| 查询授权状态 | `GET` | `/v1/accounts/authorize/<request_id>` | 查询浏览器登录结果；成功后账号自动写入账号列表 |
| 读取账号列表 | `GET` | `/v1/accounts?realm=cn\|intl` | 返回指定版本的脱敏账号列表 |

<a id="tests"></a>
## 测试与 CI

```bash
python tests/run_all.py            # 全部套件
python tests/run_all.py realm      # 只跑名字里含 realm 的
```

- 315 个套件：236 个 Python + 79 个 JS；JS 需要 PATH 上有 `node`，缺失时会跳过并提示。Windows 上如果 `python` 不是 3.9+，请改用 `py -3 tests/run_all.py`。
- `tests/_mobile_check.py` 是独立的 Playwright 手机 / 桌面布局检查器（需自行安装 Playwright），按需手动运行，不在上面的套件集里。
- `tests/_visual_recent.py` 是同一类手动检查器：用合成 fixture 起一份 1480 宽的「请求列表」，验证失败徽章点开的详情弹窗、四个过滤下拉真的把参数发到 `/usage/recent`，并把列表 / 弹窗 / 筛选条截图写到系统临时目录的 `wb-visual-recent/`。
- CI（[`.github/workflows/tests.yml`](.github/workflows/tests.yml)）跑同一条命令：Ubuntu 上 Python 3.9 与 3.12（3.9 是本项目声称的最低版本），Windows 上 Python 3.12；推送 `v*` tag 时额外断言 **tag == 源码版本**（`-ci` 演练 tag 豁免）。

<a id="release"></a>
## 更新与发布

本项目由本仓库自行构建和发布，运行时不依赖上游仓库：

- **镜像**：`ghcr.io/mkktop/workbuddy2api-hub:latest`（多架构 linux/amd64 + linux/arm64）与版本标签 `:vX.Y.Z`。
- **Release**：推送 `v*` 标签后，GitHub Actions 会跑全量测试、打包 `ZIP` / `.ipk` / `.apk` 并生成草稿 Release；发布草稿后自动构建镜像并追加 checksums。
- **面板更新检查**：默认查询本仓库的 Releases；自建部署可通过 `WB_UPDATE_REPO=owner/repo` 指向自己的发布源。

Docker 部署更新：

```bash
cd /path/to/workbuddy2api-hub
docker compose pull && docker compose up -d
```

升级前建议备份 `docker-compose.yml` 与 `accounts/`；回滚时把 `image:` 改回旧版本标签并重新 `up -d`。完整发布纪律与提交规范见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

<a id="security"></a>
## 安全与风险

- **凭证只在本地**：账号凭证保存在 `accounts/`，不要提交到 Git，也不要把该目录同步到公共位置。
- **不要公网裸奔**：面板与 `8788` 端口默认没有 TLS。公网部署请关闭直接暴露，使用 Nginx / Caddy / Cloudflare Tunnel 反代并启用 HTTPS。
- **面板密码**：默认 `admin`，首次登录立即修改；多人共用时按需为不同使用者创建独立 API Key。
- **凭证泄露处置**：立即关闭公网暴露，联系官方吊销全部 OAuth / 设备授权，确认旧 token 返回 `401` 后再重新授权。
- **上游风控**：上游持续收紧对非官方客户端的识别与拦截，限流、账号限制或封禁由使用者自行承担。
- **无可用性担保**：本项目不提供商业服务，也不承诺与上游接口永久兼容。

<a id="sponsors"></a>
## 💖 赞助商

> 想出现在这里？欢迎提交 Pull Request 添加赞助信息。

<table>
<tr>
<td width="180" align="center" valign="middle">
  <a href="https://agentrouter.org/register?aff=unrV"><img src="https://raw.githubusercontent.com/88lin/picx-images-hosting/master/90C5FAD072EA247822CB88BB32512A41.webp" alt="Agent Router" width="150"></a>
</td>
<td valign="middle"><b><a href="https://agentrouter.org/register?aff=unrV">Agent Router</a></b>&nbsp;是免费公益大模型 API 平台，支持 Claude-opus-5.5、GPT-6 Astra、GPT-6.1 Sol、deepseek-v4-flash 等主流模型，国内直连。注册送 ＄175（每日签到得 ＄25，被邀得 ＄50），支持 GitHub / LinuxDo 登录。</td>
</tr>
</table>

<a id="credits"></a>
## 致谢与引用声明 (Credits & References)

本项目在原 `workbuddy2api-hub` 社区成果基础上继续维护，MIT 许可证、原作者署名与历史贡献记录均保留。在协议逆向、风控规避、任务链路与工程化设计过程中，本项目参考、吸纳并致谢以下优秀开源项目与技术成果（排名不分先后）：

### 核心逆向与协议参考

- **[Sliverkiss/workbuddy2api](https://github.com/Sliverkiss/workbuddy2api)**：成长任务逆向、设备指纹派生（`derive_id`）、调度器（`Scheduler`）与 `reasoning_content` 回填设计；
- **[L0NE-6/WorkBuddy-Daily](https://github.com/L0NE-6/WorkBuddy-Daily)**：国内版微信小程序专属事件指纹与动态专家深链任务模型；
- **[88lin/workbuddy-auto-signin](https://github.com/88lin/workbuddy-auto-signin)**：猫猫日常旅行与成长能量开盲盒（Buddy 盲盒）安全生命周期；
- **[linguo2625469/workbuddy2api-panel](https://github.com/linguo2625469/workbuddy2api-panel)**：国内版连登管家闭环逻辑与轻量对话活跃上报事件；
- **[misakano7545/workbuddy2api-panel](https://github.com/misakano7545/workbuddy2api-panel)**：Go/uTLS 桥接、语音兼容、Responses 历史回放及上游错误分类参考；
- **[Zhengyuuuui/workbuddy2api](https://github.com/Zhengyuuuui/workbuddy2api)**：国际版 11140 账号封禁识别、冷却规避与故障排查清单；
- **[yuanyuanyuan430/workbuddy2api-hub](https://github.com/yuanyuanyuan430/workbuddy2api-hub)**：国际版 EdgeOne CDN 证书错配排查与活跃上报优雅降级方案；
- **[CangShui/workbuddy-cliproxy-fix](https://github.com/CangShui/workbuddy-cliproxy-fix)** & **[lovingfish/workbuddy-cliproxy](https://github.com/lovingfish/workbuddy-cliproxy)**：早期客户端代理修复与网关通信原型；
- **[mmqz/cpa-multi-plugins](https://github.com/mmqz/cpa-multi-plugins)**：多插件管理与出站调度结构参考；
- **[ardeyouxipianyi/workbuddy2api](https://github.com/ardeyouxipianyi/workbuddy2api)**：国内版早期分发包逆向分析与出站 User-Agent 规范。

### 工程化与生态基础

- **[aodianjun/workbuddy2api-hub](https://github.com/aodianjun/workbuddy2api-hub)**：OpenWrt 路由器打包配方（`.ipk` / `.apk`）与系统服务支持；
- **[YTjungle666/workbuddy2api-hub](https://github.com/YTjungle666/workbuddy2api-hub)**：社区维护的 Rust 后端与启动器重写分支，提供无 Python 运行时依赖的单文件静态二进制（功能以上游 `v2.0.1` 为对齐基线，非本仓库发布物）；
- **[astral-sh/python-build-standalone](https://github.com/astral-sh/python-build-standalone)**：Windows 便携版免安装精简独立 Python 运行时构建基石；
- **[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)**：DSH 客户端协议与提示词指纹清洗规避参考。

感谢所有向本项目提交 PR、反馈 Issue 与分享实测样本的社区贡献者！

> 📌 **提交代码贡献前**：请先查看并**严格遵循**贡献手册 [`CONTRIBUTING.md`](CONTRIBUTING.md)——提交格式、测试门禁与端到端冒烟要求都在那里（AI / 智能体请特别注意其中的硬性规则节）。

<a id="disclaimer"></a>
## 免责声明 (Disclaimer)

本项目仅用于协议学习与个人开发测试，不提供任何商业服务或可用性担保。因使用非官方客户端产生的账号风控、限制或封禁由使用者自行承担，请优先使用官方客户端。

<a id="license"></a>
## 许可证

[MIT](LICENSE)。版权声明与许可文本见仓库根目录的 `LICENSE`；本项目保留原作者的署名与历史贡献记录。

<a id="star-history"></a>
## ⭐ Star 趋势

<p align="center">
  <a href="https://star-history.com/#mkktop/workbuddy2api-hub&Date">
    <img src="https://api.star-history.com/svg?repos=mkktop/workbuddy2api-hub&type=Date" alt="Star History Chart" width="760">
  </a>
</p>
