-- 本地开发种子数据（仅本地，勿在生产执行）
-- 单用户 owner + 四类渠道 + 演示消息（对应效果图内容）

INSERT OR REPLACE INTO users (id, email, created_at)
VALUES ('owner', 'unrealyan@gmail.com', unixepoch() * 1000);

INSERT OR REPLACE INTO channels (id, user_id, type, name, key, secret, enabled, created_at) VALUES
  ('ch_webhook', 'owner', 'webhook',  'GitHub Webhook', 'ax9fk2demo', NULL, 1, unixepoch() * 1000),
  ('ch_api',     'owner', 'api',      'REST API · 订单系统', 'apidemo01', NULL, 1, unixepoch() * 1000),
  ('ch_tg',      'owner', 'telegram', '价格监控 Bot', 'tgbotdemo', 'tg_secret_demo', 1, unixepoch() * 1000),
  ('ch_ding',    'owner', 'dingtalk', '运维告警群', 'dingdemo01', 'ding_sign_demo', 0, unixepoch() * 1000);

INSERT OR REPLACE INTO messages (id, user_id, channel_id, title, body, format, level, meta_json, read, created_at) VALUES
  ('m1', 'owner', 'ch_ding', '生产环境 CPU 告警',
   '检测到 `prod-east` 集群多个节点 CPU 使用率持续 **超过 90%**，已自动触发扩容流程。

### 受影响节点

| 节点 | CPU | 状态 |
|------|-----|------|
| node-07 | 94% | 扩容中 |
| node-12 | 91% | 扩容中 |

### 处理建议
- 检查近 10 分钟流量是否异常
- 确认扩容实例是否就绪

```
kubectl get pods -n prod-east --watch
```',
   'markdown', 'urgent', '{"sourceIp":"10.0.3.12","cluster":"prod-east","rule":"cpu>90%"}', 0, unixepoch() * 1000 - 30000),

  ('m2', 'owner', 'ch_webhook', 'Deploy to production succeeded',
   '<p>✅ <b>Deploy to production succeeded</b></p><p>commit <code>a1b9f3c</code> by <a href="#">@unrealyan</a></p>',
   'html', 'success', '{"repo":"xpush","env":"production"}', 0, unixepoch() * 1000 - 120000),

  ('m3', 'owner', 'ch_tg', 'BTC 行情提醒',
   '📈 **BTC 突破 $72,000**，24h 涨幅 +5.2%。监控规则「BTC-高位」已命中。',
   'markdown', 'info', '{"symbol":"BTC","price":72000}', 1, unixepoch() * 1000 - 3600000),

  ('m4', 'owner', 'ch_api', '新订单通知',
   '新订单 #20260602-8841 已支付，金额 ￥1,299.00，来自客户「李雷」。',
   'text', 'info', '{"orderId":"20260602-8841"}', 1, unixepoch() * 1000 - 7200000),

  ('m5', 'owner', 'ch_webhook', 'CI Pipeline 测试通过',
   '单元测试通过 412/412，覆盖率 87.3%。构建产物已上传至 R2。',
   'text', 'success', '{"passed":412,"coverage":87.3}', 1, unixepoch() * 1000 - 86400000);
