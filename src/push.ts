// Web Push（RFC 8291 aes128gcm + RFC 8292 VAPID），纯 Web Crypto 实现，可在 Workers 运行。
import type { Env } from "./types";

export interface PushSubscription {
  endpoint: string;
  p256dh: string; // base64url，UA 公钥（65B 未压缩点）
  auth: string;   // base64url，16B auth secret
}

const utf8 = (s: string) => new TextEncoder().encode(s);

export function b64urlToBytes(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const bin = atob(s + pad);
  const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
}

export function bytesToB64url(b: ArrayBuffer | Uint8Array): string {
  const a = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = "";
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concat(...arrs: Uint8Array[]): Uint8Array {
  const len = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

// HKDF（Web Crypto 的 deriveBits 同时完成 Extract(salt,ikm)+Expand(info,L)）
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    key,
    length * 8
  );
  return new Uint8Array(bits);
}

// ---------- VAPID（RFC 8292）----------
async function importVapidPrivate(pubB64: string, privB64: string): Promise<CryptoKey> {
  const pub = b64urlToBytes(pubB64); // 0x04 || X(32) || Y(32)
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    x: bytesToB64url(pub.slice(1, 33)),
    y: bytesToB64url(pub.slice(33, 65)),
    d: privB64, // 已是 base64url
    ext: true,
  };
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

export async function vapidAuthHeader(endpoint: string, env: Env): Promise<string> {
  const aud = new URL(endpoint).origin;
  const header = bytesToB64url(utf8(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
  const payload = bytesToB64url(
    utf8(JSON.stringify({ aud, exp, sub: env.VAPID_SUBJECT || "mailto:admin@example.com" }))
  );
  const signingInput = `${header}.${payload}`;
  const key = await importVapidPrivate(env.VAPID_PUBLIC_KEY!, env.VAPID_PRIVATE_KEY!);
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    utf8(signingInput)
  ); // 返回 IEEE-P1363 r||s（64B），正是 JWT ES256 所需
  const jwt = `${signingInput}.${bytesToB64url(sig)}`;
  return `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`;
}

// ---------- aes128gcm 加密（RFC 8291 + 8188）----------
export async function encryptPayload(sub: PushSubscription, plaintext: Uint8Array): Promise<Uint8Array> {
  const uaPublic = b64urlToBytes(sub.p256dh); // 65B
  const authSecret = b64urlToBytes(sub.auth); // 16B

  // 1) 临时 ECDH 密钥对（as = application server）
  const asKeys = (await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  )) as CryptoKeyPair;
  const asPublicRaw = new Uint8Array(
    (await crypto.subtle.exportKey("raw", asKeys.publicKey)) as ArrayBuffer
  ); // 65B
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey } as any, asKeys.privateKey, 256)
  ); // 32B

  // 2) IKM = HKDF(salt=auth, ikm=ecdh, info="WebPush: info"||0x00||ua||as, 32)
  const keyInfo = concat(utf8("WebPush: info"), new Uint8Array([0]), uaPublic, asPublicRaw);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

  // 3) CEK / NONCE（salt = 16 随机字节）
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, concat(utf8("Content-Encoding: aes128gcm"), new Uint8Array([0])), 16);
  const nonce = await hkdf(salt, ikm, concat(utf8("Content-Encoding: nonce"), new Uint8Array([0])), 12);

  // 4) 记录 = plaintext || 0x02（最后一条记录的分隔符）
  const record = concat(plaintext, new Uint8Array([0x02]));
  const cekKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, cekKey, record)
  );

  // 5) 头部：salt(16) || rs(4, BE) || idlen(1) || keyid(as_public, 65)
  const rs = 4096;
  const header = new Uint8Array(16 + 4 + 1 + 65);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, rs, false);
  header[20] = 65;
  header.set(asPublicRaw, 21);

  return concat(header, ciphertext);
}

// ---------- 发送单条 ----------
export async function sendPush(env: Env, sub: PushSubscription, payload: unknown): Promise<number> {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return 0; // 未配置则跳过
  const body = await encryptPayload(sub, utf8(JSON.stringify(payload)));
  const auth = await vapidAuthHeader(sub.endpoint, env);
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: auth,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "86400",
      Urgency: "high",
    },
    body,
  });
  return res.status;
}

// ---------- 向某用户的所有订阅发送，清理失效订阅；返回每条投递状态 ----------
export async function sendPushToAll(
  env: Env,
  userId: string,
  payload: unknown
): Promise<{ endpoint: string; status: number }[]> {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return [];
  const { results } = await env.DB.prepare(
    `SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?`
  )
    .bind(userId)
    .all<{ id: string; endpoint: string; p256dh: string; auth: string }>();

  return Promise.all(
    results.map(async (s) => {
      let status = 0;
      try {
        status = await sendPush(env, s, payload);
        // 404/410 表示订阅已失效，删除
        if (status === 404 || status === 410) {
          await env.DB.prepare(`DELETE FROM push_subscriptions WHERE id = ?`).bind(s.id).run();
        }
      } catch {
        status = -1; // 异常（加密/网络）
      }
      return { endpoint: s.endpoint.slice(0, 48) + "…", status };
    })
  );
}
