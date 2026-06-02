// 本地预览 shim —— 仅用于在不支持 workerd 的机器上预览 PWA + 验证 API 契约。
// 生产运行在真实 Cloudflare Worker（src/index.ts），与此文件无关。
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL("../public", import.meta.url)));
const KEY = process.env.XPUSH_MASTER_KEY || "dev-master-key-change-me";
const PORT = process.env.PORT || 4400;
const now = Date.now();

const channels = [
  { id: "ch_webhook", type: "webhook", name: "GitHub Webhook", key: "ax9fk2demo", secret: null, enabled: 1, created_at: now },
  { id: "ch_api", type: "api", name: "REST API · 订单系统", key: "apidemo01", secret: null, enabled: 1, created_at: now },
  { id: "ch_tg", type: "telegram", name: "价格监控 Bot", key: "tgbotdemo", secret: "tg_secret_demo_token", enabled: 1, created_at: now },
  { id: "ch_ding", type: "dingtalk", name: "运维告警群", key: "dingdemo01", secret: "SECdemoxxxxxxx", enabled: 0, created_at: now },
];
const rid = (n = 16) => Array.from({ length: n }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)]).join("");
const settings = { retentionDays: 30, dnd: { enabled: false, start: 1320, end: 480, tzOffset: 0 } };
const messages = [
  { id: "m1", channel_id: "ch_ding", channel_name: "运维告警群", channel_type: "dingtalk", title: "生产环境 CPU 告警",
    body: "检测到 `prod-east` 集群多个节点 CPU 使用率持续 **超过 90%**，已自动触发扩容流程。\n\n### 受影响节点\n\n| 节点 | CPU | 状态 |\n|------|-----|------|\n| node-07 | 94% | 扩容中 |\n| node-12 | 91% | 扩容中 |\n\n### 处理建议\n- 检查近 10 分钟流量是否异常\n- 确认扩容实例是否就绪\n\n```\nkubectl get pods -n prod-east --watch\n```",
    format: "markdown", level: "urgent", meta_json: '{"sourceIp":"10.0.3.12","cluster":"prod-east","rule":"cpu>90%"}', read: 0, created_at: now - 30000 },
  { id: "m2", channel_id: "ch_webhook", channel_name: "GitHub Webhook", channel_type: "webhook", title: "Deploy to production succeeded",
    body: '<p>✅ <b>Deploy to production succeeded</b></p><p>commit <code>a1b9f3c</code> by <a href="#">@unrealyan</a></p>',
    format: "html", level: "success", meta_json: '{"repo":"xpush","env":"production"}', read: 0, created_at: now - 120000 },
  { id: "m3", channel_id: "ch_tg", channel_name: "价格监控 Bot", channel_type: "telegram", title: "BTC 行情提醒",
    body: "📈 **BTC 突破 $72,000**，24h 涨幅 +5.2%。监控规则「BTC-高位」已命中。",
    format: "markdown", level: "info", meta_json: '{"symbol":"BTC","price":72000}', read: 1, created_at: now - 3600000 },
  { id: "m4", channel_id: "ch_api", channel_name: "REST API · 订单系统", channel_type: "api", title: "新订单通知",
    body: "新订单 #20260602-8841 已支付，金额 ￥1,299.00，来自客户「李雷」。",
    format: "text", level: "info", meta_json: '{"orderId":"20260602-8841"}', read: 1, created_at: now - 7200000 },
  { id: "m5", channel_id: "ch_webhook", channel_name: "GitHub Webhook", channel_type: "webhook", title: "CI Pipeline 测试通过",
    body: "单元测试通过 412/412，覆盖率 87.3%。构建产物已上传至 R2。",
    format: "text", level: "success", meta_json: '{"passed":412,"coverage":87.3}', read: 1, created_at: now - 86400000 },
];
const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json", ".json": "application/json" };
const unread = () => messages.filter((m) => !m.read).length;
const authed = (req) => (req.headers.authorization || "").replace(/^Bearer\s+/i, "") === KEY;
const json = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;

  // ---- API ----
  if (p.startsWith("/api/")) {
    if (p === "/api/v1/health") return json(res, 200, { ok: true });
    if (p === "/api/v1/version") return json(res, 200, { version: process.env.SHIM_VERSION || "shim-v1" });
    if (p === "/api/v1/auth/check" && req.method === "POST") {
      let b = ""; for await (const c of req) b += c;
      const { key } = JSON.parse(b || "{}");
      return json(res, 200, { ok: key === KEY });
    }
    if (!authed(req)) return json(res, 401, { error: "unauthorized" });
    if (p === "/api/v1/messages" && req.method === "GET") {
      const ch = url.searchParams.get("channel");
      let list = messages;
      if (ch && ch !== "all") list = messages.filter((m) => m.channel_id === ch || m.channel_type === ch);
      return json(res, 200, { messages: list, unread: unread() });
    }
    const mDetail = p.match(/^\/api\/v1\/messages\/([^/]+)$/);
    if (mDetail && req.method === "GET") {
      const m = messages.find((x) => x.id === mDetail[1]);
      return m ? json(res, 200, { message: m }) : json(res, 404, { error: "not found" });
    }
    const mRead = p.match(/^\/api\/v1\/messages\/([^/]+)\/read$/);
    if (mRead && req.method === "POST") {
      const m = messages.find((x) => x.id === mRead[1]); if (m) m.read = 1;
      return json(res, 200, { ok: true });
    }
    if (p === "/api/v1/messages" && req.method === "DELETE") {
      const readOnly = url.searchParams.get("read") === "1";
      let n = 0;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (!readOnly || messages[i].read) { messages.splice(i, 1); n++; }
      }
      return json(res, 200, { ok: true, deleted: n });
    }
    const mDel = p.match(/^\/api\/v1\/messages\/([^/]+)$/);
    if (mDel && req.method === "DELETE") {
      const i = messages.findIndex((x) => x.id === mDel[1]);
      if (i >= 0) messages.splice(i, 1);
      return json(res, 200, { ok: i >= 0 });
    }
    if (p === "/api/v1/channels" && req.method === "GET") {
      return json(res, 200, { channels: channels.map((c) => ({
        ...c, total: messages.filter((m) => m.channel_id === c.id).length,
        last_at: Math.max(0, ...messages.filter((m) => m.channel_id === c.id).map((m) => m.created_at)) || null,
      })) });
    }
    if (p === "/api/v1/channels" && req.method === "POST") {
      let bd = ""; for await (const c of req) bd += c;
      const b = JSON.parse(bd || "{}");
      const ch = { id: "ch_" + rid(), type: b.type, name: (b.name || "").trim() || ("新" + b.type),
        key: rid(20), secret: (b.secret || "").trim() || (b.type === "telegram" ? rid(24) : null), enabled: 1, created_at: Date.now() };
      channels.push(ch);
      return json(res, 201, { channel: ch });
    }
    const cDetail = p.match(/^\/api\/v1\/channels\/([^/]+)$/);
    if (cDetail) {
      const i = channels.findIndex((c) => c.id === cDetail[1]);
      if (i < 0) return json(res, 404, { error: "not found" });
      if (req.method === "GET") return json(res, 200, { channel: channels[i] });
      if (req.method === "PATCH") {
        let bd = ""; for await (const c of req) bd += c;
        const b = JSON.parse(bd || "{}");
        if (typeof b.name === "string") channels[i].name = b.name.trim();
        if (typeof b.enabled === "boolean") channels[i].enabled = b.enabled ? 1 : 0;
        if (typeof b.secret === "string") channels[i].secret = b.secret.trim() || null;
        return json(res, 200, { ok: true });
      }
      if (req.method === "DELETE") {
        messages.forEach((m) => { if (m.channel_id === channels[i].id) m.channel_id = null; });
        channels.splice(i, 1);
        return json(res, 200, { ok: true });
      }
    }
    const cRotate = p.match(/^\/api\/v1\/channels\/([^/]+)\/rotate$/);
    if (cRotate && req.method === "POST") {
      const ch = channels.find((c) => c.id === cRotate[1]);
      if (!ch) return json(res, 404, { error: "not found" });
      ch.key = rid(20);
      if (ch.type === "telegram") ch.secret = rid(24);
      return json(res, 200, { key: ch.key, secret: ch.secret });
    }
    if (p === "/api/v1/push/vapid") return json(res, 200, { publicKey: null });
    if (p === "/api/v1/settings" && req.method === "GET") return json(res, 200, settings);
    if (p === "/api/v1/settings" && req.method === "PUT") {
      let bd = ""; for await (const c of req) bd += c;
      const b = JSON.parse(bd || "{}");
      if (typeof b.retentionDays === "number") settings.retentionDays = b.retentionDays;
      if (b.dnd) settings.dnd = { ...settings.dnd, ...b.dnd };
      return json(res, 200, settings);
    }
    if (p === "/api/v1/settings/cleanup" && req.method === "POST") return json(res, 200, { ok: true, deleted: 0 });
    return json(res, 404, { error: "no route" });
  }
  if (p === "/ws") { res.writeHead(501); return res.end(); }

  // ---- 静态资源 ----
  let f = decodeURIComponent(p);
  if (f === "/") f = "/index.html";
  try {
    const data = await readFile(join(ROOT, f));
    res.writeHead(200, { "Content-Type": TYPES[extname(f)] || "application/octet-stream" });
    res.end(data);
  } catch {
    // SPA 回退
    const data = await readFile(join(ROOT, "index.html"));
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(data);
  }
}).listen(PORT, () => console.log("xpush dev shim on " + PORT));
