// XPush PWA — 单用户客户端
const KEY_STORE = "xpush_key";
const THEME_STORE = "xpush_theme";
let masterKey = localStorage.getItem(KEY_STORE) || "";

// 主题：在最早时机应用，避免闪烁
function applyTheme(t) {
  if (t && t !== "default") document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}
applyTheme(localStorage.getItem(THEME_STORE) || "default");
let currentTab = "messages";
let activeFilter = "all";
let ws = null;
let wsAlive = false;

const $ = (s, r = document) => r.querySelector(s);
const view = $("#view");
const nav = $("#nav");
const gate = $("#gate");

// ---------- 渠道图标 ----------
const ICONS = {
  webhook: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 9a3 3 0 1 0-2.8-4M6 15a3 3 0 1 0 2.8 4M15 18a3 3 0 1 0 4-2.8M9 6L6.5 11M15 18l-2.5-5M18 9l-5 2.5"/></svg>',
  api: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v3m0 8v3a2 2 0 0 0 2 2h3m8 0h3a2 2 0 0 0 2-2v-3m0-8V5a2 2 0 0 0-2-2h-3"/><path d="M7 12h10M12 7v10" stroke-width="1.5"/></svg>',
  telegram: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21.5 4.3L2.5 11.6c-1 .4-1 1.7.1 2l4.8 1.5 1.8 5.7c.2.7 1.1.9 1.6.3l2.6-2.6 4.9 3.6c.6.4 1.4.1 1.6-.6l3.3-15.5c.2-.9-.7-1.6-1.4-1.3z"/></svg>',
  dingtalk: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.5 2 2 5.8 2 10.5c0 2.7 1.5 5.1 3.8 6.6-.2.8-.8 2.3-.9 2.6 0 0 0 .3.2.4.2 0 4-1.6 4.6-1.9.7.1 1.5.2 2.3.2 5.5 0 10-3.8 10-8.5S17.5 2 12 2z"/></svg>',
};
const TYPE_LABEL = { webhook: "Webhook", api: "REST API", telegram: "Telegram", dingtalk: "钉钉" };
const LEVEL_TAG = { urgent: "紧急", warning: "警告", success: "成功", info: "" };

// ---------- API ----------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${masterKey}`,
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401) {
    showGate();
    throw new Error("unauthorized");
  }
  return res.json();
}

// ---------- 工具 ----------
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
function relTime(ms) {
  const d = Date.now() - ms;
  if (d < 60000) return "刚刚";
  if (d < 3600000) return Math.floor(d / 60000) + " 分钟前";
  if (d < 86400000) return new Date(ms).toTimeString().slice(0, 5);
  if (d < 172800000) return "昨天";
  return new Date(ms).toISOString().slice(5, 10).replace("-", "/");
}
function fmtDate(ms) {
  const dt = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())} ${p(dt.getHours())}:${p(dt.getMinutes())}`;
}
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 1800);
}

// ---------- 富文本渲染（markdown-it + highlight.js + DOMPurify）----------
const md = window.markdownit({
  html: false,         // Markdown 内的裸 HTML 不直接信任（HTML 格式走单独的 DOMPurify 通道）
  linkify: true,
  breaks: true,
  highlight(code, lang) {
    const hljs = window.hljs;
    try {
      if (lang && hljs.getLanguage(lang))
        return `<pre><code class="hljs language-${lang}">${hljs.highlight(code, { language: lang }).value}</code></pre>`;
      return `<pre><code class="hljs">${hljs.highlightAuto(code).value}</code></pre>`;
    } catch {
      return `<pre><code class="hljs">${esc(code)}</code></pre>`;
    }
  },
});

// 链接统一加 target/rel
const _linkOpen = md.renderer.rules.link_open || ((t, i, o, e, s) => s.renderToken(t, i, o));
md.renderer.rules.link_open = (tokens, idx, opts, env, self) => {
  const t = tokens[idx];
  t.attrSet("target", "_blank");
  t.attrSet("rel", "noopener noreferrer");
  return _linkOpen(tokens, idx, opts, env, self);
};

// DOMPurify 配置：允许富文本常见标签 + 代码高亮的 class，禁止脚本/事件
const PURIFY_CFG = {
  ALLOWED_TAGS: [
    "p", "br", "hr", "strong", "b", "em", "i", "del", "s", "a", "code", "pre", "span",
    "blockquote", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6",
    "table", "thead", "tbody", "tr", "th", "td", "img",
  ],
  ALLOWED_ATTR: ["href", "title", "target", "rel", "class", "src", "alt"],
  ALLOW_DATA_ATTR: false,
};

function renderRich(msg) {
  let html;
  if (msg.format === "markdown") html = md.render(msg.body);
  else if (msg.format === "html") html = msg.body;
  else html = `<p>${esc(msg.body).replace(/\n/g, "<br>")}</p>`;
  return window.DOMPurify.sanitize(html, PURIFY_CFG);
}

// ---------- 视图：消息列表 ----------
async function renderMessages() {
  view.innerHTML = `
    <div class="appbar">
      <div class="title"><span class="logo-mark"><svg viewBox="0 0 24 24" fill="none" stroke="#04101a" stroke-width="2.5"><path d="M4 4l16 16M20 4L4 20"/></svg></span>消息</div>
      <div class="actions"><span id="liveDot" class="live-dot off" title="实时连接"></span></div>
    </div>
    <div class="chips" id="chips"></div>
    <div id="bannerSlot"></div>
    <div class="scroll" id="list"><div class="empty">加载中…</div></div>`;
  renderPushBanner();
  await loadMessages();
}

function renderPushBanner() {
  const slot = $("#bannerSlot");
  if (!slot) return;
  const dismissed = localStorage.getItem("push_dismissed") === "1";
  if (!pushSupported() || dismissed || Notification.permission !== "default") { slot.innerHTML = ""; return; }
  slot.innerHTML = `<div class="banner">
    <div class="bi"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0"/></svg></div>
    <div class="bt">开启锁屏推送<small>离线也能第一时间收到消息</small></div>
    <button class="bgo" id="bGo">开启</button><span class="bx" id="bX">✕</span></div>`;
  $("#bGo").onclick = async () => { const ok = await enablePush(); if (ok) renderPushBanner(); };
  $("#bX").onclick = () => { localStorage.setItem("push_dismissed", "1"); renderPushBanner(); };
}

async function loadMessages() {
  let data;
  try {
    data = await api(`/api/v1/messages${activeFilter !== "all" ? `?channel=${activeFilter}` : ""}`);
  } catch { return; }

  const chips = [
    { k: "all", label: "全部", badge: data.unread },
    { k: "webhook", label: "Webhook" },
    { k: "api", label: "API" },
    { k: "telegram", label: "Telegram" },
    { k: "dingtalk", label: "钉钉" },
  ];
  $("#chips").innerHTML = chips
    .map(
      (c) =>
        `<div class="chip ${c.k === activeFilter ? "active" : ""}" data-k="${c.k}">${c.label}${
          c.badge ? ` <span class="badge">${c.badge}</span>` : ""
        }</div>`
    )
    .join("");
  $("#chips").querySelectorAll(".chip").forEach((el) =>
    el.addEventListener("click", () => { activeFilter = el.dataset.k; loadMessages(); })
  );

  const list = $("#list");
  if (!data.messages.length) { list.innerHTML = `<div class="empty">暂无消息</div>`; return; }
  list.innerHTML = data.messages.map((m) => cardHTML(m)).join("");
  list.querySelectorAll(".card").forEach((el) => {
    attachSwipe(el);
    el.addEventListener("click", () => {
      if ((el._x || 0) < -10) { el.style.transition = "transform .2s"; el.style.transform = "translateX(0)"; el._x = 0; return; }
      openDetail(el.dataset.id);
    });
  });
  list.querySelectorAll(".swipe-del").forEach((el) =>
    el.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (await confirmAction("删除这条消息？", "删除后不可恢复。")) {
        await api(`/api/v1/messages/${el.dataset.del}`, { method: "DELETE" });
        toast("已删除");
        loadMessages();
      }
    })
  );
}

// 左滑显露删除按钮（iOS 风格）
function attachSwipe(card) {
  const W = 84;
  let x0 = 0, y0 = 0, base = 0, axis = null;
  const setX = (v) => { card.style.transform = `translateX(${v}px)`; card._x = v; };
  card.addEventListener("touchstart", (e) => {
    const t = e.touches[0]; x0 = t.clientX; y0 = t.clientY; base = card._x || 0; axis = null;
    card.style.transition = "none";
  }, { passive: true });
  card.addEventListener("touchmove", (e) => {
    const t = e.touches[0], mx = t.clientX - x0, my = t.clientY - y0;
    if (axis === null && (Math.abs(mx) > 6 || Math.abs(my) > 6)) axis = Math.abs(mx) > Math.abs(my) ? "x" : "y";
    if (axis !== "x") return;
    e.preventDefault();
    setX(Math.max(-W, Math.min(0, base + mx)));
  }, { passive: false });
  const settle = () => {
    if (axis !== "x") return;
    card.style.transition = "transform .22s";
    setX((card._x || 0) < -W / 2 ? -W : 0);
  };
  card.addEventListener("touchend", settle, { passive: true });
  card.addEventListener("touchcancel", settle, { passive: true });
}

function cardHTML(m) {
  const type = m.channel_type || "webhook";
  const tag = LEVEL_TAG[m.level] || "";
  const fmtTag = m.format !== "text" ? (tag ? ` · ${m.format}` : m.format) : "";
  const preview = (m.title ? m.title + " — " : "") + stripMd(m.body);
  return `<div class="swipe-wrap">
    <button class="swipe-del" data-del="${m.id}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>删除</button>
    <div class="card s-${type} ${m.read ? "" : "unread"}" data-id="${m.id}">
      <div class="src-ico">${ICONS[type] || ICONS.webhook}</div>
      <div class="body">
        <div class="row1"><span class="name">${esc(m.channel_name || TYPE_LABEL[type])}</span><span class="time">${relTime(m.created_at)}</span></div>
        <div class="preview">${esc(preview)}</div>
        ${(tag || fmtTag) ? `<span class="tag ${m.level}">${esc((tag + fmtTag).trim())}</span>` : ""}
      </div>
    </div>
  </div>`;
}
function stripMd(s) {
  return String(s)
    .replace(/<[^>]+>/g, "")        // HTML 标签
    .replace(/```[\s\S]*?```/g, "") // 代码块
    .replace(/[#*`>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

// ---------- 视图：消息详情 ----------
async function openDetail(id) {
  let data;
  try { data = await api(`/api/v1/messages/${id}`); } catch { return; }
  const m = data.message;
  nav.classList.add("hidden");
  const type = m.channel_type || "webhook";
  const meta = m.meta_json ? JSON.parse(m.meta_json) : {};
  const metaLine = Object.entries(meta)
    .filter(([k]) => k !== "via")
    .map(([k, v]) => `${k}: ${v}`)
    .join(" · ");
  view.innerHTML = `
    <div class="d-bar">
      <div class="icon-btn" id="back"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg></div>
      <div style="flex:1;min-width:0"><div class="name">${esc(m.channel_name || TYPE_LABEL[type])}</div><div class="sub">${fmtDate(m.created_at)} · ${m.format}</div></div>
      <div class="icon-btn" id="detDel" style="color:var(--pink)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg></div>
    </div>
    <div class="scroll pad">
      <div class="d-hero">
        ${LEVEL_TAG[m.level] ? `<span class="pill ${m.level}">${LEVEL_TAG[m.level]}</span>` : ""}
        ${m.title ? `<h2>${esc(m.title)}</h2>` : ""}
        ${metaLine ? `<div class="meta">${esc(metaLine)}</div>` : ""}
      </div>
      <div class="rich">${renderRich(m)}</div>
    </div>
    <div class="d-actions">
      <div class="btn" id="markRead">标为已读</div>
      <div class="btn primary" id="backList">返回列表</div>
    </div>`;
  $("#back").onclick = () => showTab("messages");
  $("#backList").onclick = () => showTab("messages");
  $("#markRead").onclick = async () => {
    await api(`/api/v1/messages/${id}/read`, { method: "POST" });
    toast("已标为已读");
  };
  $("#detDel").onclick = async () => {
    if (await confirmAction("删除这条消息？", "删除后不可恢复。")) {
      await api(`/api/v1/messages/${id}`, { method: "DELETE" });
      toast("已删除");
      showTab("messages");
    }
  };
  if (!m.read) api(`/api/v1/messages/${id}/read`, { method: "POST" }).catch(() => {});
}

// ---------- 视图：渠道 ----------
function endpointOf(c) {
  const o = location.origin;
  if (c.type === "webhook" || c.type === "api") return `${o}/w/${c.key}`;
  if (c.type === "telegram") return `${o}/tg/${c.key}`;
  return `${o}/ding/${c.key}`;
}

async function renderChannels() {
  view.innerHTML = `
    <div class="appbar"><div class="title" style="font-size:20px;">渠道接入</div>
      <div class="actions"><div class="icon-btn" id="addCh"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg></div></div>
    </div>
    <div class="sec-title" id="chCount"></div>
    <div class="scroll" id="chList"><div class="empty">加载中…</div></div>
    <div class="add-btn" id="addCh2">＋ 新建渠道（Webhook / API / Telegram / 钉钉）</div>`;
  $("#addCh").onclick = openCreateSheet;
  $("#addCh2").onclick = openCreateSheet;
  await loadChannels();
}

async function loadChannels() {
  let data;
  try { data = await api("/api/v1/channels"); } catch { return; }
  $("#chCount").textContent = `已接入 ${data.channels.length}`;
  const list = $("#chList");
  if (!data.channels.length) { list.innerHTML = `<div class="empty">还没有渠道，点上方 ＋ 新建</div>`; return; }
  list.innerHTML = data.channels.map((c) => {
    const ep = endpointOf(c);
    const masked = c.type === "telegram" || c.type === "dingtalk"
      ? `${TYPE_LABEL[c.type]} ····${String(c.key).slice(-4)}` : ep;
    return `<div class="ch-card s-${c.type}" data-id="${c.id}">
      <div class="ch-top">
        <div class="src-ico">${ICONS[c.type]}</div>
        <div class="nm">${esc(c.name)}<small>${TYPE_LABEL[c.type]}</small></div>
        <button class="toggle ${c.enabled ? "on" : "off"}" data-id="${c.id}" data-en="${c.enabled}"></button>
      </div>
      <div class="ep" data-open="${c.id}"><span class="u">${esc(masked)}</span><span class="cp">›</span></div>
      <div class="ch-foot"><span>累计 ${c.total || 0} 条</span><span>${c.last_at ? "最近 " + relTime(c.last_at) : "暂无消息"}</span></div>
    </div>`;
  }).join("");
  list.querySelectorAll(".toggle").forEach((el) =>
    el.addEventListener("click", async (e) => {
      e.stopPropagation();
      const en = el.dataset.en !== "1";
      await api(`/api/v1/channels/${el.dataset.id}`, { method: "PATCH", body: JSON.stringify({ enabled: en }) });
      toast(en ? "已启用" : "已停用");
      loadChannels();
    })
  );
  list.querySelectorAll(".ep[data-open]").forEach((el) =>
    el.addEventListener("click", () => openChannelSheet(el.dataset.open))
  );
}

// ---------- 底部弹窗基础 ----------
function openSheet(html) {
  closeSheet();
  const bd = document.createElement("div");
  bd.className = "sheet-backdrop";
  bd.id = "sheet";
  bd.innerHTML = `<div class="sheet"><div class="sheet-handle"></div>${html}</div>`;
  bd.addEventListener("click", (e) => { if (e.target === bd) closeSheet(); });
  $("#app").appendChild(bd);
  // 隐藏底层视图，避免卡片的 backdrop-filter 在某些浏览器透出到弹窗之上
  view.style.visibility = "hidden";
  nav.style.visibility = "hidden";
  requestAnimationFrame(() => bd.classList.add("show"));
  return bd;
}
function closeSheet() {
  const bd = $("#sheet");
  if (bd) {
    bd.classList.remove("show");
    setTimeout(() => {
      bd.remove();
      if (!$("#sheet")) { view.style.visibility = ""; nav.style.visibility = ""; }
    }, 220);
  }
}
// 二次确认（底部弹窗，破坏性操作用）
function confirmAction(title, desc, okText = "删除") {
  return new Promise((resolve) => {
    const bd = openSheet(`
      <h3>${esc(title)}</h3>
      <div class="desc">${esc(desc)}</div>
      <div class="sheet-actions">
        <div class="btn" id="cCancel">取消</div>
        <div class="btn-danger" id="cOk">${esc(okText)}</div>
      </div>`);
    bd.querySelector("#cCancel").onclick = () => { closeSheet(); resolve(false); };
    bd.querySelector("#cOk").onclick = () => { closeSheet(); resolve(true); };
  });
}

function copyBtn(text) {
  return `<span class="cp" data-copy="${esc(text)}">⧉</span>`;
}
function wireCopy(root) {
  root.querySelectorAll(".cp[data-copy]").forEach((el) =>
    el.addEventListener("click", () => { navigator.clipboard?.writeText(el.dataset.copy); toast("已复制"); })
  );
}

// ---------- 新建渠道 ----------
let pickType = "webhook";
function openCreateSheet() {
  pickType = "webhook";
  const types = ["webhook", "api", "telegram", "dingtalk"];
  const bd = openSheet(`
    <h3>新建渠道</h3>
    <div class="desc">选择接入类型并命名，创建后给你专属接入地址。</div>
    <div class="type-grid">
      ${types.map((t) => `<div class="type-opt ${t === "webhook" ? "sel" : ""}" data-t="${t}">
        <div class="src-ico s-${t}" style="border:none;background:rgba(120,160,255,.08)">${ICONS[t]}</div>
        <div class="tn">${TYPE_LABEL[t]}</div></div>`).join("")}
    </div>
    <div class="field"><label>渠道名称</label><input id="chName" placeholder="例如：生产告警 / 订单系统" autocomplete="off"></div>
    <div class="field hidden" id="secretField"><label>钉钉加签密钥（机器人安全设置里的 SEC 开头串）</label><input id="chSecret" placeholder="SEC..." autocomplete="off"></div>
    <div class="sheet-actions"><div class="btn" onclick="">取消</div><div class="btn primary" id="createBtn">创建</div></div>`);
  const opts = bd.querySelectorAll(".type-opt");
  opts.forEach((el) => el.addEventListener("click", () => {
    opts.forEach((o) => o.classList.remove("sel"));
    el.classList.add("sel");
    pickType = el.dataset.t;
    bd.querySelector("#secretField").classList.toggle("hidden", pickType !== "dingtalk");
  }));
  bd.querySelector(".sheet-actions .btn:not(.primary)").onclick = closeSheet;
  bd.querySelector("#createBtn").onclick = async () => {
    const name = bd.querySelector("#chName").value.trim();
    const secret = bd.querySelector("#chSecret")?.value.trim() || undefined;
    const r = await api("/api/v1/channels", { method: "POST", body: JSON.stringify({ type: pickType, name, secret }) });
    if (r.channel) { toast("渠道已创建"); openChannelSheet(r.channel.id); }
  };
}

// ---------- 渠道配置 / 接入说明 ----------
async function openChannelSheet(id) {
  let data;
  try { data = await api(`/api/v1/channels/${id}`); } catch { return; }
  const c = data.channel;
  const ep = endpointOf(c);
  const bd = openSheet(`
    <h3>${esc(c.name)}</h3>
    <div class="desc">${TYPE_LABEL[c.type]} · ${c.enabled ? "已启用" : "已停用"}</div>
    <div class="kv-box"><div class="k">接入地址（POST）</div><div class="v"><span>${esc(ep)}</span>${copyBtn(ep)}</div></div>
    ${c.secret ? `<div class="kv-box"><div class="k">${c.type === "telegram" ? "secret_token" : "加签密钥"}</div><div class="v"><span>${esc(c.secret)}</span>${copyBtn(c.secret)}</div></div>` : ""}
    ${howto(c, ep)}
    <div class="field"><label>重命名</label><input id="renm" value="${esc(c.name)}"></div>
    <div class="sheet-actions">
      <div class="btn" id="rotateBtn">重置密钥</div>
      <div class="btn primary" id="saveBtn">保存名称</div>
    </div>
    <div class="sheet-actions"><div class="btn-danger" id="delBtn">删除渠道</div></div>`);
  wireCopy(bd);
  bd.querySelector("#saveBtn").onclick = async () => {
    await api(`/api/v1/channels/${id}`, { method: "PATCH", body: JSON.stringify({ name: bd.querySelector("#renm").value }) });
    toast("已保存"); closeSheet(); loadChannels();
  };
  bd.querySelector("#rotateBtn").onclick = async () => {
    await api(`/api/v1/channels/${id}/rotate`, { method: "POST" });
    toast("密钥已重置"); openChannelSheet(id);
  };
  bd.querySelector("#delBtn").onclick = async () => {
    if (await confirmAction("删除该渠道？", "渠道的接入地址将失效；历史消息保留。")) {
      await api(`/api/v1/channels/${id}`, { method: "DELETE" });
      toast("渠道已删除"); closeSheet(); loadChannels();
    }
  };
}

function howto(c, ep) {
  if (c.type === "webhook" || c.type === "api")
    return `<div class="howto"><b>用法</b>：向上面地址发 <code>POST</code>，JSON 体支持 <code>{title, body, format, level}</code>，<code>format</code> 可为 <code>text/markdown/html</code>。非 JSON 体按纯文本处理。</div>`;
  if (c.type === "telegram")
    return `<div class="howto"><b>接入步骤</b>：用你的 Bot Token 调用 <code>setWebhook</code>：<br><code>url=${esc(ep)}</code><br><code>secret_token=</code>上方密钥。之后 Bot 收到的消息会自动同步到这里。</div>`;
  return `<div class="howto"><b>接入步骤</b>：在钉钉群「智能群助手 → 添加机器人 → Outgoing」里，回调地址填上方接入地址，并把它的「加签」密钥（SEC 开头）填到本渠道的加签密钥。@机器人 即可推送到这里。</div>`;
}

// ---------- 视图：我的 ----------
const THEMES = [
  { k: "default", g: "linear-gradient(135deg,#3df0ff,#a06bff)" },
  { k: "green", g: "linear-gradient(135deg,#3ff0c8,#4fe0ff)" },
  { k: "aurora", g: "linear-gradient(135deg,#ff90c8,#b06bff)" },
];
const pad2 = (n) => String(n).padStart(2, "0");
const fmtMin = (m) => `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
const parseMin = (s) => { const [h, m] = s.split(":").map(Number); return (h || 0) * 60 + (m || 0); };
let SETTINGS = { retentionDays: 30, dnd: { enabled: false, start: 1320, end: 480, tzOffset: 0 } };

async function renderMe() {
  const on = await pushEnabled();
  const sub = pushSupported()
    ? (Notification.permission === "denied" ? "已被浏览器拒绝，请到系统设置开启" : on ? "已开启 · Web Push" : "点击开启锁屏推送")
    : "当前环境不支持（iOS 需先添加到主屏幕）";
  try { SETTINGS = await api("/api/v1/settings"); } catch {}
  const theme = localStorage.getItem(THEME_STORE) || "default";
  const dndText = SETTINGS.dnd.enabled ? `${fmtMin(SETTINGS.dnd.start)} – ${fmtMin(SETTINGS.dnd.end)}` : "未开启";
  const retText = SETTINGS.retentionDays > 0 ? `保留 ${SETTINGS.retentionDays} 天` : "永久保留";
  view.innerHTML = `
    <div class="appbar"><div class="title" style="font-size:20px;">我的</div></div>
    <div class="scroll pad">
      <div class="me-hero"><div class="avatar">U</div><div><div class="nm">owner</div><div class="em">unrealyan@gmail.com</div></div></div>

      <div class="sec-title">外观</div>
      <div class="set-group">
        <div class="set-row"><div class="si"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v3M12 20v3M4 12H1M23 12h-3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/></svg></div><div class="lab">主题色<small>点击切换</small></div>
          <div class="swatches">${THEMES.map((t) => `<span class="sw ${t.k === theme ? "on" : ""}" data-theme="${t.k}" style="background:${t.g}"></span>`).join("")}</div>
        </div>
      </div>

      <div class="sec-title">通知</div>
      <div class="set-group">
        <div class="set-row"><div class="si"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0"/></svg></div><div class="lab">推送通知<small id="pushSub">${sub}</small></div><button class="toggle ${on ? "on" : "off"}" id="pushToggle"></button></div>
        <div class="set-row tap" id="dndRow"><div class="si"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></div><div class="lab">免打扰<small>该时段静音推送</small></div><div class="val">${dndText} ›</div></div>
      </div>

      <div class="sec-title">数据</div>
      <div class="set-group">
        <div class="set-row tap" id="retRow"><div class="si"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg></div><div class="lab">自动清理<small>定时删除过期消息</small></div><div class="val">${retText} ›</div></div>
        <div class="set-row tap" id="clearMsg"><div class="si" style="color:var(--pink)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg></div><div class="lab">清空所有消息<small>不可恢复</small></div><div class="val">›</div></div>
        <div class="set-row"><div class="si"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></svg></div><div class="lab">关于 XPush<small>v1.0 · Powered by Cloudflare</small></div><div class="val">›</div></div>
        <div class="set-row tap" id="lockRow"><div class="si"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg></div><div class="lab">锁定 / 切换密钥</div><div class="val">›</div></div>
      </div>
    </div>`;

  view.querySelectorAll(".sw").forEach((el) =>
    el.addEventListener("click", () => {
      const t = el.dataset.theme;
      applyTheme(t);
      localStorage.setItem(THEME_STORE, t);
      view.querySelectorAll(".sw").forEach((s) => s.classList.toggle("on", s === el));
    })
  );
  $("#pushToggle").onclick = async () => {
    const tg = $("#pushToggle");
    if (tg.classList.contains("on")) { await disablePush(); }
    else { const ok = await enablePush(); if (!ok) return; }
    renderMe();
  };
  $("#dndRow").onclick = () => openDndSheet();
  $("#retRow").onclick = () => openRetentionSheet();
  $("#clearMsg").onclick = async () => {
    if (await confirmAction("清空所有消息？", "将删除全部历史消息，不可恢复。", "清空")) {
      const r = await api("/api/v1/messages", { method: "DELETE" });
      toast(`已清空 ${r.deleted ?? 0} 条`);
    }
  };
  $("#lockRow").onclick = () => { localStorage.removeItem(KEY_STORE); masterKey = ""; showGate(); };
}

function openDndSheet() {
  const d = SETTINGS.dnd;
  let enabled = d.enabled;
  const bd = openSheet(`
    <h3>免打扰</h3>
    <div class="desc">该时段内新消息不弹系统通知（消息仍会正常收到、列表照常更新）。</div>
    <div class="set-row" style="padding:6px 0 14px"><div class="lab">开启免打扰</div><button class="toggle ${enabled ? "on" : "off"}" id="dndTg"></button></div>
    <div class="field"><label>开始时间</label><input type="time" id="dndStart" value="${fmtMin(d.start)}"></div>
    <div class="field"><label>结束时间（次日）</label><input type="time" id="dndEnd" value="${fmtMin(d.end)}"></div>
    <div class="sheet-actions"><div class="btn" id="dndCancel">取消</div><div class="btn primary" id="dndSave">保存</div></div>`);
  bd.querySelector("#dndTg").onclick = (e) => {
    enabled = !enabled;
    e.target.classList.toggle("on", enabled);
    e.target.classList.toggle("off", !enabled);
  };
  bd.querySelector("#dndCancel").onclick = closeSheet;
  bd.querySelector("#dndSave").onclick = async () => {
    const dnd = {
      enabled,
      start: parseMin(bd.querySelector("#dndStart").value),
      end: parseMin(bd.querySelector("#dndEnd").value),
      tzOffset: -new Date().getTimezoneOffset(),
    };
    SETTINGS = await api("/api/v1/settings", { method: "PUT", body: JSON.stringify({ dnd }) });
    toast("已保存"); closeSheet(); renderMe();
  };
}

function openRetentionSheet() {
  const opts = [{ d: 7, t: "保留 7 天" }, { d: 30, t: "保留 30 天" }, { d: 90, t: "保留 90 天" }, { d: 0, t: "永久保留" }];
  const cur = SETTINGS.retentionDays;
  const bd = openSheet(`
    <h3>自动清理</h3>
    <div class="desc">每天定时删除超过保留期的消息（Cron）。</div>
    <div>${opts.map((o) => `<div class="opt-row ${o.d === cur ? "on" : ""}" data-d="${o.d}"><span>${o.t}</span><span class="ck">✓</span></div>`).join("")}</div>`);
  bd.querySelectorAll(".opt-row").forEach((el) =>
    el.addEventListener("click", async () => {
      SETTINGS = await api("/api/v1/settings", { method: "PUT", body: JSON.stringify({ retentionDays: Number(el.dataset.d) }) });
      toast("已保存"); closeSheet(); renderMe();
    })
  );
}

// ---------- Tab 切换 ----------
function showTab(tab) {
  currentTab = tab;
  nav.classList.remove("hidden");
  nav.querySelectorAll(".n").forEach((n) => n.classList.toggle("on", n.dataset.tab === tab));
  if (tab === "messages") renderMessages();
  else if (tab === "channels") renderChannels();
  else if (tab === "me") renderMe();
}
nav.querySelectorAll(".n").forEach((n) => n.addEventListener("click", () => showTab(n.dataset.tab)));

// ---------- 实时（WebSocket）----------
function connectWS() {
  try {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => { wsAlive = true; setLive(true); };
    ws.onclose = () => { wsAlive = false; setLive(false); setTimeout(connectWS, 4000); };
    ws.onmessage = (e) => {
      try {
        const { type } = JSON.parse(e.data);
        if (type === "message" && currentTab === "messages") loadMessages();
      } catch {}
    };
  } catch {}
}
function setLive(on) {
  const d = $("#liveDot");
  if (d) d.classList.toggle("off", !on);
}

// ---------- Web Push ----------
function urlB64ToU8(s) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}
function pushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}
async function pushEnabled() {
  if (!pushSupported() || Notification.permission !== "granted") return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    return !!(await reg.pushManager.getSubscription());
  } catch { return false; }
}
async function enablePush() {
  if (!pushSupported()) { toast("此浏览器不支持推送"); return false; }
  const perm = await Notification.requestPermission();
  if (perm !== "granted") { toast("未授予通知权限"); return false; }
  let publicKey;
  try { ({ publicKey } = await api("/api/v1/push/vapid")); } catch { return false; }
  if (!publicKey) { toast("服务端未配置 VAPID 密钥"); return false; }
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToU8(publicKey) });
  const j = sub.toJSON();
  await api("/api/v1/push/subscribe", { method: "POST", body: JSON.stringify({ endpoint: sub.endpoint, keys: j.keys }) });
  toast("已开启推送通知");
  return true;
}
async function disablePush() {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await api("/api/v1/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint: sub.endpoint }) });
      await sub.unsubscribe();
    }
  } catch {}
  toast("已关闭推送通知");
}

// ---------- 解锁门 ----------
function showGate() {
  gate.classList.remove("hidden");
  nav.classList.add("hidden");
  view.innerHTML = "";
  $("#gateKey").value = "";
  $("#gateKey").focus();
}
async function tryUnlock() {
  const key = $("#gateKey").value.trim();
  if (!key) return;
  const r = await fetch("/api/v1/auth/check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key }),
  }).then((x) => x.json()).catch(() => ({ ok: false }));
  if (r.ok) {
    masterKey = key;
    localStorage.setItem(KEY_STORE, key);
    gate.classList.add("hidden");
    boot();
  } else {
    $("#gateErr").textContent = "密钥错误";
  }
}
$("#gateBtn").onclick = tryUnlock;
$("#gateKey").addEventListener("keydown", (e) => { if (e.key === "Enter") tryUnlock(); });

// ---------- 启动 ----------
async function boot() {
  showTab("messages");
  connectWS();
  // 通知点击深链：/?m=<id> 直接打开该消息
  const mid = new URLSearchParams(location.search).get("m");
  if (mid) {
    history.replaceState(null, "", location.pathname);
    openDetail(mid);
  }
}

(async function init() {
  if (!masterKey) { showGate(); return; }
  try {
    const h = await fetch("/api/v1/messages", { headers: { Authorization: `Bearer ${masterKey}` } });
    if (h.status === 401) { showGate(); return; }
    boot();
  } catch { showGate(); }
})();

// ---------- 热更新 ----------
let APP_VERSION = null;
let updateShown = false;
let reloading = false;

function showUpdateBar() {
  if (updateShown) return;
  updateShown = true;
  const bar = document.createElement("div");
  bar.className = "update-bar";
  bar.innerHTML = `<span>发现新版本</span><button id="uRefresh">立即刷新</button><span class="ux" id="uClose">✕</span>`;
  $("#app").appendChild(bar);
  requestAnimationFrame(() => bar.classList.add("show"));
  $("#uRefresh").onclick = applyUpdate;
  $("#uClose").onclick = () => { bar.classList.remove("show"); setTimeout(() => bar.remove(), 250); updateShown = false; };
}

async function applyUpdate() {
  const btn = $("#uRefresh");
  if (btn) btn.textContent = "更新中…";
  try {
    const reg = await navigator.serviceWorker.ready;
    if (reg.waiting) reg.waiting.postMessage("SKIP_WAITING"); // 新 SW 立即接管
    // 让 SW 强制拉新壳资源，确保一次刷新即最新
    await new Promise((resolve) => {
      const onMsg = (e) => {
        if (e.data && e.data.type === "REFRESHED") {
          navigator.serviceWorker.removeEventListener("message", onMsg);
          resolve();
        }
      };
      navigator.serviceWorker.addEventListener("message", onMsg);
      (reg.active || navigator.serviceWorker.controller)?.postMessage("REFRESH");
      setTimeout(resolve, 2500); // 兜底
    });
  } catch {}
  reloading = true;
  location.reload();
}

async function checkVersion(initial) {
  try {
    const r = await fetch("/api/v1/version", { cache: "no-store" });
    if (!r.ok) return;
    const { version } = await r.json();
    if (!version) return;
    if (initial) { APP_VERSION = version; return; }
    if (APP_VERSION && version !== APP_VERSION) showUpdateBar();
  } catch {}
}

if ("serviceWorker" in navigator) {
  // 记录启动时版本
  checkVersion(true);
  navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).then((reg) => {
    // SW 本身有新版本 → 提示
    reg.addEventListener("updatefound", () => {
      const nw = reg.installing;
      if (!nw) return;
      nw.addEventListener("statechange", () => {
        if (nw.state === "installed" && navigator.serviceWorker.controller) showUpdateBar();
      });
    });
    // 回到前台时检查更新（部署后无需手动操作）
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) { reg.update().catch(() => {}); checkVersion(false); }
    });
    // 定期轮询版本
    setInterval(() => checkVersion(false), 5 * 60 * 1000);
  }).catch(() => {});
  // 新 SW 接管后自动重载一次
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
}
