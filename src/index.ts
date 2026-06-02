import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env, MessageRow, MsgFormat, MsgLevel, ChannelType, ChannelRow } from "./types";
import { OWNER_ID } from "./types";
import {
  parseGeneric, parseTelegram, parseDingTalk,
  verifyTelegram, verifyDingTalk,
} from "./ingest";
import { sendPushToAll } from "./push";

export { UserHub } from "./do";

type Vars = {};
const app = new Hono<{ Bindings: Env; Variables: Vars }>();

// ---------- 工具 ----------
function hub(env: Env) {
  const id = env.USER_HUB.idFromName(OWNER_ID);
  return env.USER_HUB.get(id);
}

function genId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

// ---------- 设置（存 KV） ----------
interface Settings {
  retentionDays: number; // 0 = 永久保留
  dnd: { enabled: boolean; start: number; end: number; tzOffset: number }; // start/end: 距 0 点分钟数（本地）；tzOffset: 本地比 UTC 多的分钟数
}
const DEFAULT_SETTINGS: Settings = {
  retentionDays: 30,
  dnd: { enabled: false, start: 1320, end: 480, tzOffset: 0 }, // 22:00–08:00
};
async function getSettings(env: Env): Promise<Settings> {
  const raw = await env.KV.get("settings");
  if (!raw) return { ...DEFAULT_SETTINGS };
  try {
    const s = JSON.parse(raw);
    return { ...DEFAULT_SETTINGS, ...s, dnd: { ...DEFAULT_SETTINGS.dnd, ...(s.dnd || {}) } };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

// 当前是否处于免打扰时段（按用户本地时间）
function inQuietHours(dnd: Settings["dnd"], nowMs: number): boolean {
  if (!dnd.enabled || dnd.start === dnd.end) return false;
  const local = (((Math.floor(nowMs / 60000) + dnd.tzOffset) % 1440) + 1440) % 1440;
  return dnd.start < dnd.end
    ? local >= dnd.start && local < dnd.end
    : local >= dnd.start || local < dnd.end; // 跨午夜
}

// Cron 清理：删除超过保留期的消息
async function cleanupOldMessages(env: Env): Promise<number> {
  const { retentionDays } = await getSettings(env);
  if (!retentionDays || retentionDays <= 0) return 0;
  const cutoff = Date.now() - retentionDays * 86400_000;
  const r = await env.DB.prepare(`DELETE FROM messages WHERE user_id = ? AND created_at < ?`)
    .bind(OWNER_ID, cutoff)
    .run();
  return r.meta.changes ?? 0;
}

function pushPreview(body: string): string {
  return body
    .replace(/<[^>]+>/g, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/[#*`>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

async function insertMessage(
  env: Env,
  input: {
    channelId: string | null;
    title: string | null;
    body: string;
    format: MsgFormat;
    level: MsgLevel;
    meta?: unknown;
  },
  ctx?: ExecutionContext
): Promise<MessageRow> {
  const now = Date.now();
  const row: MessageRow = {
    id: genId("m"),
    user_id: OWNER_ID,
    channel_id: input.channelId,
    title: input.title,
    body: input.body,
    format: input.format,
    level: input.level,
    meta_json: input.meta ? JSON.stringify(input.meta) : null,
    read: 0,
    created_at: now,
  };
  await env.DB.prepare(
    `INSERT INTO messages (id, user_id, channel_id, title, body, format, level, meta_json, read, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
  )
    .bind(
      row.id, row.user_id, row.channel_id, row.title, row.body,
      row.format, row.level, row.meta_json, row.created_at
    )
    .run();

  // 实时扇出（DO，前台在线时列表实时刷新）
  try {
    await hub(env).broadcast(row);
  } catch {
    /* 实时失败不阻断落库 */
  }
  // 发 Web Push（免打扰时段内跳过，但仍入库+实时）
  if (ctx) {
    const payload = {
      title: row.title || "XPush 新消息",
      body: pushPreview(row.body),
      id: row.id,
      url: `/?m=${row.id}`,
    };
    ctx.waitUntil(
      (async () => {
        const s = await getSettings(env);
        if (inQuietHours(s.dnd, Date.now())) return;
        await sendPushToAll(env, OWNER_ID, payload);
      })()
    );
  }
  return row;
}

// 未读数：直接从 D1 统计，避免与 read 标记产生漂移（已建索引 idx_messages_unread）
async function countUnread(env: Env): Promise<number> {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM messages WHERE user_id = ? AND read = 0`
  )
    .bind(OWNER_ID)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

// ---------- 中间件 ----------
app.use("/api/*", cors());

// 单用户鉴权：除少数公开端点外，/api/v1/* 需 Bearer 主密钥
const PUBLIC_API = new Set(["/api/v1/health", "/api/v1/version", "/api/v1/auth/check"]);
app.use("/api/v1/*", async (c, next) => {
  if (PUBLIC_API.has(new URL(c.req.url).pathname)) return next();
  const auth = c.req.header("Authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token || token !== c.env.XPUSH_MASTER_KEY) {
    return c.json({ error: "unauthorized" }, 401);
  }
  return next();
});

// ---------- API：健康检查 / 鉴权 ----------
app.get("/api/v1/health", (c) => c.json({ ok: true, service: "xpush", version: "1.0.0" }));

// 部署版本（前端热更新探测用）：每次 deploy 自动变化
app.get("/api/v1/version", (c) =>
  c.json({ version: c.env.CF_VERSION_METADATA?.id ?? "dev" })
);

app.post("/api/v1/auth/check", async (c) => {
  const { key } = await c.req.json<{ key?: string }>().catch(() => ({ key: undefined }));
  return c.json({ ok: !!key && key === c.env.XPUSH_MASTER_KEY });
});

// ---------- API：消息 ----------
app.get("/api/v1/messages", async (c) => {
  const channel = c.req.query("channel"); // channel id 或 type
  const unreadOnly = c.req.query("unread") === "1";

  let sql = `
    SELECT m.*, ch.name AS channel_name, ch.type AS channel_type
    FROM messages m
    LEFT JOIN channels ch ON ch.id = m.channel_id
    WHERE m.user_id = ?`;
  const binds: unknown[] = [OWNER_ID];

  if (channel && channel !== "all") {
    sql += ` AND (m.channel_id = ? OR ch.type = ?)`;
    binds.push(channel, channel);
  }
  if (unreadOnly) sql += ` AND m.read = 0`;
  sql += ` ORDER BY m.created_at DESC LIMIT 100`;

  const { results } = await c.env.DB.prepare(sql).bind(...binds).all();
  const unread = await countUnread(c.env);
  return c.json({ messages: results, unread });
});

app.get("/api/v1/messages/:id", async (c) => {
  const id = c.req.param("id");
  const row = await c.env.DB.prepare(
    `SELECT m.*, ch.name AS channel_name, ch.type AS channel_type
     FROM messages m LEFT JOIN channels ch ON ch.id = m.channel_id
     WHERE m.id = ? AND m.user_id = ?`
  )
    .bind(id, OWNER_ID)
    .first();
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json({ message: row });
});

app.post("/api/v1/messages/:id/read", async (c) => {
  const id = c.req.param("id");
  await c.env.DB.prepare(
    `UPDATE messages SET read = 1 WHERE id = ? AND user_id = ? AND read = 0`
  )
    .bind(id, OWNER_ID)
    .run();
  return c.json({ ok: true });
});

// 删除单条消息
app.delete("/api/v1/messages/:id", async (c) => {
  const r = await c.env.DB.prepare(`DELETE FROM messages WHERE id = ? AND user_id = ?`)
    .bind(c.req.param("id"), OWNER_ID)
    .run();
  return c.json({ ok: r.meta.changes > 0 });
});

// 清空消息：默认全部，?read=1 仅清已读
app.delete("/api/v1/messages", async (c) => {
  const readOnly = c.req.query("read") === "1";
  const sql = readOnly
    ? `DELETE FROM messages WHERE user_id = ? AND read = 1`
    : `DELETE FROM messages WHERE user_id = ?`;
  const r = await c.env.DB.prepare(sql).bind(OWNER_ID).run();
  return c.json({ ok: true, deleted: r.meta.changes });
});

// ---------- API：渠道 ----------
app.get("/api/v1/channels", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT c.id, c.type, c.name, c.key, c.enabled, c.created_at,
            (SELECT COUNT(*) FROM messages m WHERE m.channel_id = c.id) AS total,
            (SELECT MAX(created_at) FROM messages m WHERE m.channel_id = c.id) AS last_at
     FROM channels c WHERE c.user_id = ? ORDER BY c.created_at ASC`
  )
    .bind(OWNER_ID)
    .all();
  return c.json({ channels: results });
});

const CHANNEL_TYPES = new Set<ChannelType>(["webhook", "api", "telegram", "dingtalk"]);
function randKey(len = 20) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, "").slice(0, len);
}

// 新建渠道：{ type, name, secret? } —— 自动生成入口 key；tg 未给 secret 则生成，ding 需用户回填
app.post("/api/v1/channels", async (c) => {
  const b: { type?: string; name?: string; secret?: string } =
    await c.req.json().catch(() => ({}));
  const type = b.type as ChannelType;
  if (!CHANNEL_TYPES.has(type)) return c.json({ error: "invalid type" }, 400);
  const name = (b.name || "").trim() || defaultName(type);
  const id = genId("ch");
  const key = randKey();
  let secret: string | null = b.secret?.trim() || null;
  if (type === "telegram" && !secret) secret = randKey(24); // 作为 setWebhook 的 secret_token
  await c.env.DB.prepare(
    `INSERT INTO channels (id, user_id, type, name, key, secret, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)`
  )
    .bind(id, OWNER_ID, type, name, key, secret, Date.now())
    .run();
  return c.json({ channel: { id, type, name, key, secret, enabled: 1 } }, 201);
});

function defaultName(type: ChannelType) {
  return { webhook: "新 Webhook", api: "新 API", telegram: "新 Telegram Bot", dingtalk: "新钉钉机器人" }[type];
}

// 更新渠道：{ name?, enabled?, secret? }
app.patch("/api/v1/channels/:id", async (c) => {
  const id = c.req.param("id");
  const b: { name?: string; enabled?: boolean; secret?: string } =
    await c.req.json().catch(() => ({}));
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (typeof b.name === "string") { sets.push("name = ?"); binds.push(b.name.trim()); }
  if (typeof b.enabled === "boolean") { sets.push("enabled = ?"); binds.push(b.enabled ? 1 : 0); }
  if (typeof b.secret === "string") { sets.push("secret = ?"); binds.push(b.secret.trim() || null); }
  if (!sets.length) return c.json({ error: "nothing to update" }, 400);
  binds.push(id, OWNER_ID);
  const r = await c.env.DB.prepare(
    `UPDATE channels SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`
  ).bind(...binds).run();
  return c.json({ ok: r.meta.changes > 0 });
});

// 重置入口 key（及 tg secret_token）
app.post("/api/v1/channels/:id/rotate", async (c) => {
  const id = c.req.param("id");
  const ch = await c.env.DB.prepare(`SELECT type FROM channels WHERE id = ? AND user_id = ?`)
    .bind(id, OWNER_ID).first<{ type: ChannelType }>();
  if (!ch) return c.json({ error: "not found" }, 404);
  const key = randKey();
  const secret = ch.type === "telegram" ? randKey(24) : undefined;
  if (secret !== undefined) {
    await c.env.DB.prepare(`UPDATE channels SET key = ?, secret = ? WHERE id = ? AND user_id = ?`)
      .bind(key, secret, id, OWNER_ID).run();
  } else {
    await c.env.DB.prepare(`UPDATE channels SET key = ? WHERE id = ? AND user_id = ?`)
      .bind(key, id, OWNER_ID).run();
  }
  return c.json({ key, secret });
});

// 删除渠道（消息保留，channel_id 置空）
app.delete("/api/v1/channels/:id", async (c) => {
  const id = c.req.param("id");
  await c.env.DB.prepare(`UPDATE messages SET channel_id = NULL WHERE channel_id = ? AND user_id = ?`)
    .bind(id, OWNER_ID).run();
  const r = await c.env.DB.prepare(`DELETE FROM channels WHERE id = ? AND user_id = ?`)
    .bind(id, OWNER_ID).run();
  return c.json({ ok: r.meta.changes > 0 });
});

// 单渠道详情（含 secret，供配置接入用）
app.get("/api/v1/channels/:id", async (c) => {
  const row = await c.env.DB.prepare(`SELECT * FROM channels WHERE id = ? AND user_id = ?`)
    .bind(c.req.param("id"), OWNER_ID).first<ChannelRow>();
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json({ channel: row });
});

// VAPID 公钥（前端订阅 Web Push 用）
app.get("/api/v1/push/vapid", (c) =>
  c.json({ publicKey: c.env.VAPID_PUBLIC_KEY ?? null })
);

// 注册推送订阅：{ endpoint, keys: { p256dh, auth } }
app.post("/api/v1/push/subscribe", async (c) => {
  const b: { endpoint?: string; keys?: { p256dh?: string; auth?: string } } =
    await c.req.json().catch(() => ({}));
  if (!b.endpoint || !b.keys?.p256dh || !b.keys?.auth)
    return c.json({ error: "invalid subscription" }, 400);
  await c.env.DB.prepare(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`
  )
    .bind(genId("ps"), OWNER_ID, b.endpoint, b.keys.p256dh, b.keys.auth, Date.now())
    .run();
  return c.json({ ok: true });
});

// 注销推送订阅：{ endpoint }
app.post("/api/v1/push/unsubscribe", async (c) => {
  const b: { endpoint?: string } = await c.req.json().catch(() => ({}));
  if (b.endpoint)
    await c.env.DB.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?`)
      .bind(b.endpoint, OWNER_ID).run();
  return c.json({ ok: true });
});

// 推送状态：是否已配置 VAPID + 当前订阅数
app.get("/api/v1/push/status", async (c) => {
  const r = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?`
  ).bind(OWNER_ID).first<{ n: number }>();
  return c.json({ configured: !!c.env.VAPID_PUBLIC_KEY, subscriptions: r?.n ?? 0 });
});

// 测试推送：直接向所有订阅发一条，返回每条投递状态（201=已被推送服务接受）
app.post("/api/v1/push/test", async (c) => {
  const results = await sendPushToAll(c.env, OWNER_ID, {
    title: "XPush 测试推送 🔔",
    body: "这是一条直达测试，收到说明 Web Push 全链路正常。",
    url: "/",
    id: "test",
  });
  return c.json({ sent: results.length, results });
});

// ---------- 设置 ----------
app.get("/api/v1/settings", async (c) => c.json(await getSettings(c.env)));

app.put("/api/v1/settings", async (c) => {
  const cur = await getSettings(c.env);
  const b: Partial<Settings> = await c.req.json().catch(() => ({}));
  const next: Settings = {
    retentionDays: typeof b.retentionDays === "number" ? b.retentionDays : cur.retentionDays,
    dnd: { ...cur.dnd, ...(b.dnd || {}) },
  };
  await c.env.KV.put("settings", JSON.stringify(next));
  return c.json(next);
});

// 手动触发清理（也可由 Cron 自动执行）
app.post("/api/v1/settings/cleanup", async (c) => {
  const deleted = await cleanupOldMessages(c.env);
  return c.json({ ok: true, deleted });
});

// ---------- 接入层 ----------
async function findChannel(env: Env, key: string, type?: ChannelType) {
  let sql = `SELECT * FROM channels WHERE key = ? AND enabled = 1`;
  const binds: unknown[] = [key];
  if (type) { sql += ` AND type = ?`; binds.push(type); }
  return env.DB.prepare(sql).bind(...binds).first<ChannelRow>();
}

// 通用 Webhook / REST API：POST /w/:key  { title?, body, format?, level? } 或任意 JSON
app.post("/w/:key", async (c) => {
  const ch = await findChannel(c.env, c.req.param("key"));
  if (!ch) return c.json({ error: "channel not found or disabled" }, 404);
  const n = parseGeneric(await c.req.text());
  const msg = await insertMessage(c.env, { channelId: ch.id, ...n }, c.executionCtx);
  return c.json({ ok: true, id: msg.id });
});

// Telegram Bot Webhook：POST /tg/:key （校验 secret_token 头）
app.post("/tg/:key", async (c) => {
  const ch = await findChannel(c.env, c.req.param("key"), "telegram");
  if (!ch) return c.json({ error: "channel not found or disabled" }, 404);
  if (!verifyTelegram(c.req.raw.headers, ch.secret)) return c.json({ error: "bad secret_token" }, 401);
  const n = parseTelegram(await c.req.text());
  if (!n) return c.json({ ok: true, skipped: true }); // 非消息更新，回 200 让 TG 不再重试
  const msg = await insertMessage(c.env, { channelId: ch.id, ...n }, c.executionCtx);
  return c.json({ ok: true, id: msg.id });
});

// 钉钉 Outgoing 机器人：POST /ding/:key （校验 timestamp + sign 加签）
app.post("/ding/:key", async (c) => {
  const ch = await findChannel(c.env, c.req.param("key"), "dingtalk");
  if (!ch) return c.json({ error: "channel not found or disabled" }, 404);
  if (!(await verifyDingTalk(c.req.raw.headers, ch.secret, Date.now())))
    return c.json({ error: "bad signature" }, 401);
  const n = parseDingTalk(await c.req.text());
  if (!n) return c.json({ error: "bad payload" }, 400);
  const msg = await insertMessage(c.env, { channelId: ch.id, ...n }, c.executionCtx);
  return c.json({ ok: true, id: msg.id });
});

// ---------- 顶层 fetch：WebSocket 升级 + 其余交给 Hono ----------
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      // 单用户：所有连接进 owner 的 UserHub
      return hub(env).fetch(request);
    }
    return app.fetch(request, env, ctx);
  },

  // Cron：按保留期自动清理旧消息
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(cleanupOldMessages(env));
  },
};
