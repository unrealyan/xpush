export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  KV: KVNamespace;
  USER_HUB: DurableObjectNamespace<import("./do").UserHub>;

  // 版本元数据（每次部署变化）
  CF_VERSION_METADATA: { id: string; tag?: string; timestamp?: string };

  // secrets
  XPUSH_MASTER_KEY: string;
  VAPID_SUBJECT?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
}

export type ChannelType = "webhook" | "api" | "telegram" | "dingtalk";
export type MsgFormat = "text" | "markdown" | "html";
export type MsgLevel = "info" | "success" | "warning" | "urgent";

export interface MessageRow {
  id: string;
  user_id: string;
  channel_id: string | null;
  title: string | null;
  body: string;
  format: MsgFormat;
  level: MsgLevel;
  meta_json: string | null;
  read: number;
  created_at: number;
}

export interface ChannelRow {
  id: string;
  user_id: string;
  type: ChannelType;
  name: string;
  key: string;
  secret: string | null;
  enabled: number;
  created_at: number;
}

// 单用户：固定 owner
export const OWNER_ID = "owner";
