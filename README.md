<div align="center">

<img src="public/icons/icon-192.png" width="96" height="96" alt="XPush logo" />

# XPush

**统一消息推送接收 · 移动端 PWA · 全栈跑在 Cloudflare**

把 Webhook / REST API / Telegram / 钉钉 的消息，汇聚到一个简约科幻的手机 App，实时到达、锁屏推送。

[![Platform](https://img.shields.io/badge/PWA-iOS%20%7C%20Android-3df0ff?style=flat-square)](#)
[![Powered by Cloudflare](https://img.shields.io/badge/Cloudflare-Workers%20%C2%B7%20D1%20%C2%B7%20DO-f38020?style=flat-square&logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Web Push](https://img.shields.io/badge/Web%20Push-VAPID%20%C2%B7%20aes128gcm-a06bff?style=flat-square)](#)
[![License: MIT](https://img.shields.io/badge/License-MIT-3ee6a0?style=flat-square)](LICENSE)

<br/><br/>

<a href="https://deploy.workers.cloudflare.com/?url=https://github.com/unrealyan/xpush">
  <img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare" height="36" />
</a>

</div>

---

## ✨ 特性

- 📡 **多渠道接入** — 通用 Webhook、REST API、Telegram Bot、钉钉（Outgoing 机器人，HMAC 加签校验）
- ⚡ **实时到达** — Durable Object + WebSocket，前台消息秒级刷新
- 🔔 **离线推送** — 标准 Web Push（VAPID + RFC 8291 `aes128gcm`），锁屏也能收，纯 Web Crypto 实现，无三方依赖
- 📝 **富文本详情** — Markdown（markdown-it + highlight.js 代码高亮）/ HTML（DOMPurify 消毒防 XSS）
- 🎨 **简约科幻 UI** — 暗色玻璃拟态、渠道色彩编码、可装到主屏幕的原生级 PWA
- 🔄 **热更新** — Service Worker network-first + 版本探测，部署即生效，无需清缓存
- 🔒 **单用户私有部署** — 一个主密钥管控，渠道独立 key/签名校验，数据全在你自己的 Cloudflare 账户
- 💸 **近乎零成本** — 全部构建在 Cloudflare 免费额度可覆盖的服务上

## 📱 截图

> 把手机端 PWA 截图放到 `docs/screenshots/` 即可显示。

| 消息列表 | 消息详情 | 渠道管理 | 锁屏推送 |
|:---:|:---:|:---:|:---:|
| ![](docs/screenshots/messages.png) | ![](docs/screenshots/detail.png) | ![](docs/screenshots/channels.png) | ![](docs/screenshots/push.png) |

设计稿与设计说明见 [`design/`](design/)（[mockup.html](design/mockup.html) · [DESIGN.md](design/DESIGN.md)）。

## 🏗 架构

```
                         ┌─────────────── 接入层（公网入口）──────────────┐
  Webhook  ──POST──►     │  /w/:key       通用 Webhook / REST API         │
  Telegram ─webhook─►    │  /tg/:key      Bot 更新（secret_token 校验）    │
  钉钉机器人 ─outgoing─►  │  /ding/:key    Outgoing（HMAC 加签校验）         │
                         └───────────────────┬───────────────────────────┘
                                             │  Cloudflare Worker（Hono）
                          归一化 Message ─────┼──────────────────────────────┐
                                             ▼                              ▼
                                       D1（持久化）              Durable Object（每用户）
                                                                  │         │
                                              在线 WebSocket ◄─────┘         └──► Web Push（VAPID）
                                              前台实时刷新                        离线锁屏通知
                                             ▲
                          Cloudflare Pages/Assets ── PWA 静态资源 + Service Worker
```

| 关注点 | 方案 |
|------|------|
| 前端托管 + API | 单个 **Worker**（Static Assets 托管 PWA + Hono 处理 API/接入/实时） |
| 消息存储 | **D1**（SQLite） |
| 计数 / 幂等 | **KV** |
| 实时 & 推送编排 | **Durable Objects**（WebSocket 扇出） |
| 离线通知 | **Web Push**（VAPID，`aes128gcm`，Web Crypto） |
| 前端 | 原生 JS PWA + markdown-it + highlight.js + DOMPurify（无打包步骤，vendor 自托管） |
| 部署 | **Wrangler** |

## ⚡ 一键部署到 Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/unrealyan/xpush)

点击按钮，Cloudflare 会自动：克隆仓库到你的 Git → 创建并绑定 **D1 / KV / Durable Object** → 构建并部署 Worker。

> 把按钮链接里的 `unrealyan/xpush` 换成你自己的仓库地址。

部署完成后，再补两步（按钮无法自动设置密钥与 D1 表结构）：

```bash
# 1) 应用 D1 表结构（在你本地 clone 的仓库里执行）
npx wrangler d1 migrations apply xpush-db --remote

# 2) 设置 Secrets（也可在 Dashboard → Worker → Settings → Variables and Secrets 里添加）
npx wrangler secret put XPUSH_MASTER_KEY          # 解锁主密钥，自定义强口令
npx web-push generate-vapid-keys                  # 生成下面两个 VAPID 值
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put VAPID_SUBJECT             # 形如 mailto:you@example.com
```

完成后访问分配的 `*.workers.dev` 域名，输入主密钥解锁即可。

---

## 🚀 手动部署（CLI）

> 前置：Node 18+、一个 Cloudflare 账户、`npm i -g wrangler` 并 `wrangler login`。

```bash
git clone <your-repo-url> xpush && cd xpush
npm install

# 1) 创建 D1 / KV，并把输出的 id 填进 wrangler.jsonc
npx wrangler d1 create xpush-db
npx wrangler kv namespace create KV

# 2) 建表
npm run db:migrate:remote
# （可选）灌入演示数据
npm run db:seed:remote

# 3) 设置密钥
npx wrangler secret put XPUSH_MASTER_KEY          # 管理端解锁主密钥，自定义一个强口令

#    生成 VAPID 公私钥（Web Push 用）—— 输出格式与本项目一致
npx web-push generate-vapid-keys
npx wrangler secret put VAPID_PUBLIC_KEY          # 填上面的 Public Key
npx wrangler secret put VAPID_PRIVATE_KEY         # 填上面的 Private Key
npx wrangler secret put VAPID_SUBJECT             # 形如 mailto:you@example.com

# 4) 部署
npm run deploy
```

部署后访问 `https://xpush.<your-subdomain>.workers.dev`，输入主密钥解锁；iOS 需「添加到主屏幕」再到 **我的 → 推送通知** 开启。

更详细的本地开发说明见 [SETUP.md](SETUP.md)。

## 📨 接入与发送

在 App 内 **渠道 → 新建渠道** 拿到接入地址（形如 `/w/<KEY>`），即可推消息：

```bash
curl -X POST https://xpush.<your-subdomain>.workers.dev/w/<KEY> \
  -H 'Content-Type: application/json' \
  -d '{"title":"部署完成","body":"**v1.2.0** 已上线 ✅","format":"markdown","level":"success"}'
```

消息字段：`title` · `body`（也接受 `text`/`message`/`content`）· `format`（`text`/`markdown`/`html`）· `level`（`info`/`success`/`warning`/`urgent`）。

Telegram / 钉钉 接入步骤，以及 Python / Node / Go / Shell / GitHub Actions 等完整示例见 **[USAGE.md](USAGE.md)**。

## 🗂 目录结构

```
public/            # PWA 前端（静态资源，由 Worker 托管）
  app.js  styles.css  sw.js  index.html  manifest.webmanifest  icons/  vendor/
src/
  index.ts         # Hono 路由 + 顶层 fetch（WebSocket 升级）
  do.ts            # UserHub Durable Object（实时扇出）
  ingest.ts        # Telegram / 钉钉 协议解析与签名校验
  push.ts          # Web Push：VAPID 签名 + aes128gcm 加密
  types.ts
migrations/        # D1 表结构
scripts/           # 种子数据 + 本地预览 shim
design/            # 视觉稿与设计方案
```

## 🔒 安全

- **单用户主密钥**：`/api/v1/*` 管理接口需 `Authorization: Bearer <XPUSH_MASTER_KEY>`，密钥用 Wrangler Secret 注入，不入库不入仓。
- **接入鉴权**：每个渠道独立 key；Telegram 校验 `secret_token`，钉钉校验 HMAC-SHA256 加签并防重放。
- **XSS 防护**：HTML 消息经 DOMPurify 白名单消毒后才渲染。
- 发现安全问题请私下反馈，勿直接公开 issue。

## 🛣 路线图

- [x] **M1** 脚手架 · PWA 壳 · 消息列表/详情/渠道/我的
- [x] **M2** 富文本正式渲染（markdown-it + highlight.js + DOMPurify）
- [x] **M3** 接入层协议与签名校验 · 渠道增删改 UI
- [x] **M4** 实时扇出 · Web Push(VAPID) · 通知引导
- [x] **M5** 免打扰时段 · Cron 自动清理 · 主题切换

## 🤝 贡献

欢迎 issue / PR。提交前请 `npm run typecheck` 通过。

## 📄 License

[MIT](LICENSE) © XPush
