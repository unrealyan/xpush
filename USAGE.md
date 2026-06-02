# XPush 使用指南

线上地址：`https://xpush.unrealyan.workers.dev`
主密钥（管理端解锁）：自行保管，勿写进脚本。

---

## 一、接收端（手机）—— 开启推送

1. iPhone Safari 打开线上地址 → 输入主密钥解锁
2. 分享 → **添加到主屏幕**（iOS 必须装成 PWA 才能用 Web Push）
3. 打开 App → **我的 → 推送通知** 打开 → 允许系统通知
4. 完成。之后：
   - App 在前台：消息**实时**刷进列表
   - App 在后台/锁屏：走 **Web Push** 弹系统通知，点开直达详情

> Android Chrome 同理；桌面 Chrome/Edge 也支持。

---

## 二、发送端 —— 各终端接入示例

> 先在 **渠道页 → 新建渠道** 选对应类型，复制「接入地址」（形如 `/w/<KEY>`）。
> 下面用 `<KEY>` 代指你的渠道密钥；演示可用种子渠道 `ax9fk2demo`。

消息字段（JSON）：

| 字段 | 说明 | 取值 |
|------|------|------|
| `title` | 标题（可选） | 任意字符串 |
| `body` | 正文（也接受 `text`/`message`/`content`） | 任意字符串 |
| `format` | 正文格式 | `text`(默认) / `markdown` / `html` |
| `level` | 级别（影响标签颜色） | `info`(默认) / `success` / `warning` / `urgent` |

### 1) 通用 Webhook / REST API — `POST /w/<KEY>`

**curl（最常用）**
```bash
curl -X POST https://xpush.unrealyan.workers.dev/w/<KEY> \
  -H 'Content-Type: application/json' \
  -d '{"title":"部署完成","body":"**v1.2.0** 已上线 ✅","format":"markdown","level":"success"}'
```

**纯文本（非 JSON 也可，自动当正文）**
```bash
curl -X POST https://xpush.unrealyan.workers.dev/w/<KEY> -d '生产环境 CPU 92%，请关注'
```

**Python**
```python
import requests
requests.post("https://xpush.unrealyan.workers.dev/w/<KEY>", json={
    "title": "订单告警",
    "body": "新订单 #20260602-8841 已支付 ￥1,299.00",
    "level": "info",
})
```

**Node.js（18+ 内置 fetch）**
```js
await fetch("https://xpush.unrealyan.workers.dev/w/<KEY>", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ title: "构建失败", body: "`main` 分支测试未通过", format: "markdown", level: "urgent" }),
});
```

**Go**
```go
package main
import ("bytes"; "net/http")
func main() {
  body := []byte(`{"title":"巡检","body":"全部节点正常","level":"success"}`)
  http.Post("https://xpush.unrealyan.workers.dev/w/<KEY>", "application/json", bytes.NewReader(body))
}
```

**Shell 封装（放进 ~/.zshrc 随手推）**
```bash
xpush() { curl -s -X POST https://xpush.unrealyan.workers.dev/w/<KEY> \
  -H 'Content-Type: application/json' \
  -d "{\"title\":\"$1\",\"body\":\"$2\"}" >/dev/null; }
# 用法： xpush "脚本完成" "备份已上传 R2"
```

**GitHub Actions（CI 通知）**
```yaml
- name: Notify XPush
  if: always()
  run: |
    curl -X POST https://xpush.unrealyan.workers.dev/w/${{ secrets.XPUSH_KEY }} \
      -H 'Content-Type: application/json' \
      -d "{\"title\":\"构建 ${{ job.status }}\",\"body\":\"${{ github.repository }} @ ${{ github.sha }}\",\"level\":\"$([ '${{ job.status }}' = 'success' ] && echo success || echo urgent)\"}"
```

**HTML 富文本示例**
```bash
curl -X POST https://xpush.unrealyan.workers.dev/w/<KEY> \
  -H 'Content-Type: application/json' \
  -d '{"title":"日报","body":"<p>今日处理 <b>128</b> 单</p><ul><li>退款 3</li><li>投诉 1</li></ul>","format":"html"}'
```

### 2) Telegram Bot — `POST /tg/<KEY>`

1. 找 [@BotFather](https://t.me/BotFather) 创建 bot，拿到 `BOT_TOKEN`
2. XPush 新建 **Telegram** 渠道，复制接入地址 `/tg/<KEY>` 与 `secret_token`
3. 给 Telegram 注册 webhook（把你的 bot 收到的消息转发到 XPush）：
```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -d "url=https://xpush.unrealyan.workers.dev/tg/<KEY>" \
  -d "secret_token=<SECRET_TOKEN>"
```
4. 之后任何人给该 bot 发消息、或把 bot 拉群收到的消息，都会同步进 XPush。
   （XPush 校验 `X-Telegram-Bot-Api-Secret-Token`，伪造请求会被拒）

### 3) 钉钉 Outgoing 机器人 — `POST /ding/<KEY>`

1. 钉钉群 → 群设置 → **智能群助手 → 添加机器人 → 自定义(Outgoing)**
2. 「消息接收地址 / POST 地址」填：`https://xpush.unrealyan.workers.dev/ding/<KEY>`
3. 安全设置勾 **加签**，复制 `SEC` 开头的密钥
4. 回到 XPush 该渠道，把 `SEC...` 填进「加签密钥」并保存
5. 在群里 **@机器人** 说话，消息即推进 XPush
   （钉钉回调自带 `timestamp`+`sign`，XPush 用加签密钥校验并防重放）

**本地模拟测试（不接真钉钉，自行算签名验证通路）**
```bash
KEY=<KEY>; SEC=<你在渠道里填的SEC密钥>
TS=$(node -e 'console.log(Date.now())')
SIGN=$(node -e "console.log(require('crypto').createHmac('sha256','$SEC').update('$TS\n$SEC').digest('base64'))")
curl -X POST "https://xpush.unrealyan.workers.dev/ding/$KEY" \
  -H "timestamp: $TS" -H "sign: $SIGN" \
  -d '{"text":{"content":"钉钉加签测试 ✅"},"senderNick":"张三","conversationTitle":"运维群"}'
```

---

## 三、快速自测（30 秒验证全链路）

```bash
# 用种子 webhook 渠道发一条紧急 markdown
curl -X POST https://xpush.unrealyan.workers.dev/w/ax9fk2demo \
  -H 'Content-Type: application/json' \
  -d '{"title":"通路测试","body":"# 收到就说明链路通了\n- 实时刷新\n- 锁屏推送","format":"markdown","level":"urgent"}'
```
- 手机 App 在前台 → 列表秒出这条
- 手机锁屏且已开推送 → 收到系统通知，点开直达

> 注：渠道被「停用」会返回 404；找不到 key 也返回 404。
