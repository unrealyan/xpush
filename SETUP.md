# XPush 开发与部署

单用户私有部署。全栈跑在一个 Cloudflare Worker 上（Static Assets 托管 PWA + Hono 处理 API/接入/实时）。

## 目录结构

```
public/                # PWA 前端（静态资源，由 Worker 的 ASSETS 托管）
  index.html  app.js  styles.css  sw.js  manifest.webmanifest  icons/
src/
  index.ts             # Hono 路由 + 顶层 fetch（WS 升级）
  do.ts                # UserHub Durable Object（WebSocket 扇出）
  types.ts
migrations/
  0001_init.sql        # D1 表结构（只放迁移，勿放种子）
scripts/
  seed.sql             # 演示种子数据（手动执行，非迁移）
  devserver.mjs        # 本地预览 shim（仅当本机无法跑 workerd 时使用）
design/                # 视觉稿与设计方案（mockup.html / DESIGN.md）
wrangler.jsonc
```

## 首次配置

```bash
npm install

# 1) 创建 D1，并把输出的 database_id 填入 wrangler.jsonc
npx wrangler d1 create xpush-db

# 2) 创建 KV，并把 id 填入 wrangler.jsonc
npx wrangler kv namespace create KV

# 3) 应用表结构
npm run db:migrate:local      # 本地
npm run db:migrate:remote     # 生产

# 4) 设置密钥（单用户主密钥 + VAPID）
npx wrangler secret put XPUSH_MASTER_KEY
npx wrangler secret put VAPID_SUBJECT       # mailto:you@example.com
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
# 生成 VAPID：npx web-push generate-vapid-keys（M4 启用推送时）
```

本地密钥放在 `.dev.vars`（已 gitignore）。

## 本地开发

```bash
npm run dev            # wrangler dev（需要 macOS 13.5+ / Linux glibc 2.35+）
npm run db:seed:local  # 灌入演示数据
```

> ⚠️ 本机若是 macOS < 13.5，workerd 无法启动（`wrangler dev` 会报错）。
> 此时用预览 shim 看前端：`node scripts/devserver.mjs` → http://localhost:4400
> （默认主密钥 `dev-master-key-change-me`）。shim 只为预览/验证契约，**不是生产运行时**。

## 部署

```bash
npm run deploy         # wrangler deploy（自动应用 DO 迁移）
```

## 接入示例（M1 已支持通用 Webhook）

```bash
curl -X POST https://<your-worker>/w/<channelKey> \
  -H 'Content-Type: application/json' \
  -d '{"title":"部署完成","body":"**v1.2.0** 已上线","format":"markdown","level":"success"}'
```

## 里程碑

- [x] **M1** 脚手架 + PWA 壳 + D1 + DO 骨架 + 列表/详情/渠道/我的
- [x] **M2** 富文本正式渲染：markdown-it + highlight.js + DOMPurify（vendor 于 `public/vendor/`，离线可用）
- [x] **M3** 接入层：Telegram（secret_token 校验）/ 钉钉（HMAC 加签校验）协议解析 + 渠道增删改/启停/重置/复制 UI
- [x] **M4** 实时 & 推送：DO 扇出 + Web Push(VAPID, RFC8291 aes128gcm，纯 Web Crypto) + 通知授权/引导 + 离线扇出
- [ ] **M5** 设置：免打扰时段 + 自动清理(Cron Triggers) + 主题切换落地

### VAPID 密钥生成（M4）

```bash
node --input-type=module -e "
const kp=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
const pub=new Uint8Array(await crypto.subtle.exportKey('raw',kp.publicKey));
const jwk=await crypto.subtle.exportKey('jwk',kp.privateKey);
const u=b=>btoa(String.fromCharCode(...b)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+\$/,'');
console.log('PUBLIC=',u(pub)); console.log('PRIVATE=',jwk.d);"
# 然后 wrangler secret put VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT
```

> 推送链路：消息落库 → DO 实时扇出；若无在线 WebSocket 连接，则用 VAPID 签名 + aes128gcm 加密向所有订阅端推送（404/410 自动清理失效订阅）。aes128gcm 加密与 VAPID JWT 已用「加密→解密」往返单测验证（见提交说明）。
```
