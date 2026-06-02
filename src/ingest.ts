import type { MsgFormat, MsgLevel } from "./types";

export interface Normalized {
  title: string | null;
  body: string;
  format: MsgFormat;
  level: MsgLevel;
  meta: Record<string, unknown>;
}

const enc = new TextEncoder();

/** Base64(HMAC-SHA256(secret, data)) —— 用于钉钉加签校验 */
export async function hmacSha256B64(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  let s = "";
  const bytes = new Uint8Array(sig);
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

/** 常量时间字符串比较，避免计时侧信道 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const LEVELS = new Set(["info", "success", "warning", "urgent"]);

/** 通用 Webhook / REST API：直接读 JSON 字段，或退化为纯文本 */
export function parseGeneric(raw: string): Normalized {
  try {
    const j = JSON.parse(raw);
    const level: MsgLevel = LEVELS.has(j.level) ? j.level : "info";
    const format: MsgFormat =
      j.format === "markdown" || j.format === "html" ? j.format : "text";
    return {
      title: j.title ?? null,
      body: String(j.body ?? j.text ?? j.message ?? j.content ?? raw),
      format,
      level,
      meta: { via: "webhook" },
    };
  } catch {
    return { title: null, body: raw, format: "text", level: "info", meta: { via: "webhook" } };
  }
}

/**
 * Telegram Bot Webhook 校验 + 解析。
 * 用户用自己的 bot token 调 setWebhook(url=/tg/:key, secret_token=<channel.secret>)。
 * Telegram 每次回调把 secret_token 放在 X-Telegram-Bot-Api-Secret-Token 头里。
 */
export function verifyTelegram(headers: Headers, secret: string | null): boolean {
  if (!secret) return true; // 未配置 secret 则不校验（不推荐）
  const got = headers.get("x-telegram-bot-api-secret-token") ?? "";
  return safeEqual(got, secret);
}

export function parseTelegram(raw: string): Normalized | null {
  let u: any;
  try { u = JSON.parse(raw); } catch { return null; }
  const m = u.message || u.channel_post || u.edited_message || u.edited_channel_post;
  if (!m) return null; // 忽略非消息类更新（如 callback_query）
  const text = m.text ?? m.caption ?? "[非文本消息]";
  const from = m.from ? [m.from.first_name, m.from.last_name].filter(Boolean).join(" ") : "";
  const chatTitle = m.chat?.title || m.chat?.username || from || "Telegram";
  return {
    title: m.chat?.title ? null : null, // 标题留空，渠道名即来源；正文为消息文本
    body: String(text),
    format: "text",
    level: "info",
    meta: { via: "telegram", from, chatId: m.chat?.id },
  };
}

/**
 * 钉钉 Outgoing 机器人 校验 + 解析。
 * 钉钉回调头：timestamp、sign。
 *   sign == Base64(HMAC-SHA256(appSecret, `${timestamp}\n${appSecret}`))
 * 同时校验 timestamp 在 1 小时内，防重放。
 */
export async function verifyDingTalk(headers: Headers, secret: string | null, nowMs: number): Promise<boolean> {
  if (!secret) return true;
  const ts = headers.get("timestamp") ?? "";
  const sign = headers.get("sign") ?? "";
  if (!ts || !sign) return false;
  const t = parseInt(ts, 10);
  if (!Number.isFinite(t) || Math.abs(nowMs - t) > 3600_000) return false;
  const expected = await hmacSha256B64(secret, `${ts}\n${secret}`);
  return safeEqual(sign, expected);
}

export function parseDingTalk(raw: string): Normalized | null {
  let d: any;
  try { d = JSON.parse(raw); } catch { return null; }
  const text = (d.text?.content ?? d.content ?? "").trim();
  const title = d.conversationTitle || d.senderNick || "钉钉";
  return {
    title: null,
    body: text || "[消息]",
    format: "text",
    level: "info",
    meta: { via: "dingtalk", senderNick: d.senderNick, conversation: title },
  };
}
