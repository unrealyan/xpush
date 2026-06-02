# XPush 设计 & 实施方案

> 统一消息推送接收 · 移动端 PWA · 全栈基于 Cloudflare
> 视觉稿见 [mockup.html](mockup.html)（已确认：青蓝紫科幻方向）

---

## 1. 视觉系统

| 维度 | 规范 |
|------|------|
| 基调 | 深空暗色 `#06080f`，顶部双色径向辉光（蓝/紫） |
| 主题色 | 青 `#3df0ff` · 蓝 `#5b8bff` · 紫 `#a06bff`（渐变主色） |
| 渠道色彩编码 | Webhook 青 · API 绿 `#3ee6a0` · Telegram 蓝 · 钉钉 琥珀 `#ffb547` |
| 卡片 | 玻璃拟态：半透明面板 + `backdrop-filter: blur` + 1px 微光描边 |
| 字体 | 系统字体栈（SF Pro / PingFang SC），等宽用 SF Mono |
| 圆角 | 卡片 16–18px，按钮 13–14px，图标容器 11–12px |
| 高光 | 关键元素辉光 `0 0 24px rgba(61,240,255,.25)` |

主题色可在「我的 → 外观」切换（青蓝紫 / 青绿 / 蓝白），以 CSS 变量驱动，深浅模式同样以变量切换。

## 2. 界面清单（本期范围）

1. **消息列表** — 渠道筛选 chips（带未读数）、色彩编码卡片、未读霓虹点、状态标签、下拉刷新、底部三段导航。
2. **消息详情** — Hero 头卡（标题/级别/来源元信息）+ HTML/Markdown 富文本渲染（标题、行内代码、表格、列表、代码块高亮）+ 操作条。
3. **渠道管理** — 渠道卡（图标/名称/类型/启停开关/接入地址或脱敏 Token/复制/今日量/最近时间）+ 新建渠道。
4. **PWA 安装 / 通知引导** — 添加到主屏幕 → 允许通知 → 接入首个渠道，三步引导 + 主 CTA。
5. **设置 / 我的** — 账户、主题色、深色模式、推送开关、免打扰时段、自动清理、关于。

## 3. 富文本渲染策略（详情页核心）

- **Markdown**：`markdown-it` 解析，`Shiki`/`highlight.js` 代码高亮。
- **HTML**：`DOMPurify` 严格白名单消毒后渲染，防 XSS（消息来自外部不可信源）。
- 统一注入排版样式表，保证表格/列表/代码块在暗色下可读。
- 富文本在客户端渲染；服务端只存原始内容 + 格式标记（`format: html | markdown | text`）。

---

## 4. Cloudflare 技术架构

```
                         ┌─────────────── 接入层（公网入口）──────────────┐
  Webhook  ──POST──►     │  /w/:channelKey      通用 Webhook              │
  REST API ──POST──►     │  /api/v1/messages    Bearer Token 鉴权          │
  Telegram ──setWebhook► │  /tg/:botKey         Bot 更新                   │
  钉钉机器人 ─outgoing──► │  /ding/:channelKey   加签校验                   │
                         └───────────────────┬───────────────────────────┘
                                             │  Cloudflare Worker（Hono 路由）
                                             ▼
                            归一化 Message → D1（持久化） + KV（计数/游标）
                                             │
                                  Durable Object（每用户：连接管理 + 实时扇出）
                                             │
                        ┌────────────────────┼────────────────────┐
                        ▼                     ▼                     ▼
                  Web Push（VAPID）      WebSocket 实时推      PWA（Pages 托管）
                  锁屏/后台通知          前台列表实时更新       Service Worker
```

### 组件选型

| 关注点 | Cloudflare 方案 |
|--------|----------------|
| 前端托管 | **Pages**（PWA 静态资源 + Service Worker） |
| API / 接入 | **Workers** + **Hono** 路由框架 |
| 消息存储 | **D1**（SQLite）：messages / channels / push_subscriptions / users |
| 计数 / 游标 / 限流 | **KV**（未读数、渠道日计数、idempotency key） |
| 实时 & 推送编排 | **Durable Objects**（每用户一个实例，管 WebSocket + Web Push 扇出） |
| 离线推送 | **Web Push（VAPID）** 经 Service Worker；iOS 16.4+ 需「添加到主屏幕」后才可用 |
| 附件（如有） | **R2**（可选，本期消息以文本/富文本为主） |
| 定时清理 | **Cron Triggers**（按保留期清理过期消息） |
| 部署 | **Wrangler** |

### 数据模型（D1 概要）

- `users(id, email, created_at)`
- `channels(id, user_id, type, name, key, secret, enabled, created_at)` — type ∈ webhook|api|telegram|dingtalk
- `messages(id, user_id, channel_id, title, body, format, level, meta_json, read, created_at)`
- `push_subscriptions(id, user_id, endpoint, p256dh, auth, created_at)`

### 关键流程

1. **接入**：外部源 POST → Worker 校验渠道 key/签名 → 归一化 → 写 D1 → KV 未读 +1 → 调用用户 DO 扇出。
2. **实时**：DO 向在线 WebSocket 推新消息；离线则发 Web Push。
3. **送达**：Service Worker 收到 push → 展示系统通知 → 点击深链到详情。
4. **鉴权**：用户态用会话/JWT；接入态用 per-channel key + 签名（钉钉加签、Telegram secret_token）。
5. **幂等**：以来源消息 ID 或内容哈希做 KV 去重，避免重复推送。

---

## 5. 实施路线图

- **M1 脚手架**：Pages + Worker(Hono) + D1 schema + Wrangler 配置；静态 PWA 壳 + manifest + SW。
- **M2 列表/详情**：消息 CRUD API + 列表/详情 UI + Markdown/HTML 安全渲染。
- **M3 接入层**：Webhook / REST / Telegram / 钉钉 四类入口 + 渠道管理页 + 签名校验。
- **M4 实时 & 推送**：Durable Object 扇出 + WebSocket + Web Push(VAPID) + SW 通知 + 引导页。
- **M5 设置 & 收尾**：主题/免打扰/自动清理(Cron) + PWA 安装引导打磨 + 部署。

## 6. 已确认决策

- **单用户私有部署**：无多用户体系，鉴权用单一主密钥（管理态访问 + per-channel 接入 key）。
- 接入层与 PWA 由**同一个 Worker** 承载（Workers Static Assets 托管前端 + Hono 处理 API），无需单独 Pages。
- 域名与 VAPID 密钥后续准备；消息以文本/富文本为主，暂不引入 R2。
