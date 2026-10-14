#!/usr/bin/env python3
"""
从 ldc-batch-distribute.user.js 派生网页版 index.html。

用户脚本与网页版共享全部业务逻辑（名单/额度/发放引擎/审计/加密密钥），
差异仅在运行环境适配层：
  - GM_* 存储 → localStorage
  - GM_xmlhttpRequest → fetch（发往自部署的 Cloudflare Worker 透传中继）
  - 菜单命令打开面板 → 页面加载即打开
  - Shadow DOM 覆盖层 → 普通页面布局 + 内联 <style>
  - linux.do 同源名单接口（拉取粉丝 / 按用户名查询）仅用户脚本版可直连，网页版保留入口但由 CSP 拦截

用法：python3 tools/derive-web-page.py   （在仓库根目录执行）
修改了用户脚本后重新运行即可同步网页版。
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "ldc-batch-distribute.user.js"
DST = ROOT / "index.html"

src = SRC.read_text(encoding="utf-8")


def sub(old: str, new: str, count_expected: int = 1) -> None:
    global src
    n = src.count(old)
    assert n == count_expected, f"锚点出现 {n} 次（期望 {count_expected}）: {old[:80]!r}"
    src = src.replace(old, new)


# 1) 去掉 userscript 元数据头
src, n = re.subn(r"// ==UserScript==.*?// ==/UserScript==\n", "", src, flags=re.S)
assert n == 1, "metadata block"

# 2) 上游常量注释（浏览器不直连，经中继）
sub(
    "  const LDC_BASE = 'https://credit.linux.do'",
    "  const LDC_BASE = 'https://credit.linux.do' // 上游真实地址（浏览器不直连，经中继 Worker 透传）",
)

# 3) 全部接口 URL 改走中继
sub("LDC_BASE + QUERY_PATH", "apiBase() + QUERY_PATH", 3)
sub("LDC_BASE + DISTRIBUTE_PATH", "apiBase() + DISTRIBUTE_PATH", 2)

# 4) 设置默认值增加中继字段
sub(
    "settings: Object.assign({ remark: '红包', concurrency: 2 }, loadJSON(K_SETTINGS, {})),",
    "settings: Object.assign({ remark: '红包', concurrency: 2, proxyUrl: '', proxyToken: '' }, loadJSON(K_SETTINGS, {})),",
)

# 5) apiBase()：中继地址取自设置
sub(
    "  function persistRoster() {",
    """  /** 中继（Cloudflare Worker）地址：浏览器 → 中继 → credit.linux.do */
  function apiBase() {
    return String(state.settings.proxyUrl || '').replace(/\\/+$/, '')
  }

  function persistRoster() {""",
)

# 6) 未配置中继时的防护（发不出请求、也不会产生未知状态）
sub(
    "  async function ldcVerifyCredentials(clientId, clientSecret) {\n    if (!clientId || !clientSecret) return { ok: false, msg: '请先填写 client_id 与 client_secret' }",
    "  async function ldcVerifyCredentials(clientId, clientSecret) {\n    if (!apiBase()) return { ok: false, msg: '请先在下方填写并保存「中继地址」' }\n    if (!clientId || !clientSecret) return { ok: false, msg: '请先填写 client_id 与 client_secret' }",
)
sub(
    "  async function ldcQueryOrder(clientId, clientSecret, outTradeNo) {\n    const q = new URLSearchParams(",
    "  async function ldcQueryOrder(clientId, clientSecret, outTradeNo) {\n    if (!apiBase()) throw new Error('未配置中继地址')\n    const q = new URLSearchParams(",
)
sub(
    "  async function ldcDistribute(clientId, clientSecret, p) {\n    const resp = await gmText({",
    "  async function ldcDistribute(clientId, clientSecret, p) {\n    if (!apiBase()) throw new Error('未配置中继地址')\n    const resp = await gmText({",
)

# 7) 发放页检查清单：中继地址
sub(
    "    else checks.push(['ok', `打款密钥已就绪（商户 ${maskPid(state.cred.clientId)}）`])",
    """    else checks.push(['ok', `打款密钥已就绪（商户 ${maskPid(state.cred.clientId)}）`])
    if (!apiBase()) checks.push(['err', '尚未配置「中继地址」，请到「密钥设置」填写你的 Worker 中继 URL'])
    else checks.push(['ok', `中继地址已配置（${apiBase()}）`])""",
)

# 8) runBatch：实发前的中继检查
sub(
    """    if (batch.mode === 'live' && !state.cred) {
      toast('请先在「密钥设置」中配置并校验密钥', 'error')
      switchTab('cred')
      return
    }""",
    """    if (batch.mode === 'live' && !apiBase()) {
      toast('请先在「密钥设置」中配置中继地址', 'error')
      switchTab('cred')
      return
    }
    if (batch.mode === 'live' && !state.cred) {
      toast('请先在「密钥设置」中配置并校验密钥', 'error')
      switchTab('cred')
      return
    }""",
)

# 9) 密钥设置页：插入「中继」配置卡片
sub(
    """  function renderCredTab() {
    const sec = refs.secCred
    sec.replaceChildren()
""",
    """  function renderCredTab() {
    const sec = refs.secCred
    sec.replaceChildren()

    // —— 中继（Cloudflare Worker）设置 ——
    const proxyCard = h('div', { class: 'frp-card' },
      h('h3', { text: '中继（Cloudflare Worker，必填）' }),
      h('div', { class: 'frp-hint' },
        'credit.linux.do 不允许浏览器跨域直连（无 CORS），网页版经由你自部署的透传中继访问：',
        '中继只按原样转发请求，无状态、无存储、无日志，密钥依旧只在你的浏览器与 credit 之间流转。',
      ),
    )
    const proxyInput = h('input', { class: 'frp-input', style: 'width:280px', placeholder: 'https://你的中继.workers.dev', value: state.settings.proxyUrl || '', spellcheck: 'false' })
    proxyInput.addEventListener('change', () => {
      const v = proxyInput.value.trim().replace(/\\/+$/, '')
      if (v && !/^https:\\/\\/[a-z0-9.-]+(:\\d+)?$/i.test(v) && !/^http:\\/\\/(localhost|127\\.0\\.0\\.1)(:\\d+)?$/i.test(v)) {
        proxyInput.classList.add('bad')
        toast('中继地址无效：须为 https://…（本机调试可用 http://localhost:端口）', 'warn')
        return
      }
      proxyInput.classList.remove('bad')
      state.settings.proxyUrl = v
      persistSettings()
      renderAll()
    })
    const tokenInput = h('input', { class: 'frp-input', style: 'width:220px', placeholder: '留空 = 不启用', value: state.settings.proxyToken || '' })
    tokenInput.addEventListener('change', () => {
      state.settings.proxyToken = tokenInput.value.trim()
      persistSettings()
    })
    proxyCard.appendChild(h('div', { class: 'frp-row' }, h('span', { class: 'frp-hint', text: '中继地址' }), proxyInput))
    proxyCard.appendChild(h('div', { class: 'frp-row', style: 'margin-top:6px' }, h('span', { class: 'frp-hint', text: '中继口令' }), tokenInput))
    proxyCard.appendChild(h('div', { class: 'frp-hint', style: 'margin-top:6px' },
      '部署见仓库 worker/ 目录（npx wrangler deploy，约两分钟）；中继口令须与 Worker 环境变量 SHARED_TOKEN 一致（防止他人盗用你的中继）；',
      '若给 Worker 绑定自定义域名，请同步编辑 index.html 顶部 CSP 注释处的 connect-src 白名单。'))
    sec.appendChild(proxyCard)
""",
)

# 10) 页脚说明
sub(
    """    </div>
  </div>
</div>`""",
    """      <div class="frp-hint" style="margin-top:14px;text-align:center">上游 credit.linux.do（经你自部署的中继透传） · 无后端无数据库 · 名单/密钥/审计全部存本机浏览器 · 本页即全部代码，公开可审计</div>
    </div>
  </div>
</div>`""",
)

# 11) 移除「关闭」按钮与 overlay 关闭逻辑
sub("      <button class=\"frp-btn sm\" id=\"frp-close\">关闭</button>\n", "")
sub("    shadow.getElementById('frp-close').addEventListener('click', closeUI)\n", "")
sub(
    """    shadow.querySelector('.frp-overlay').addEventListener('click', (e) => {
      if (e.target.classList && e.target.classList.contains('frp-overlay')) {
        if (run.active) toast('批次进行中，请先暂停/停止后再关闭', 'warn')
        else closeUI()
      }
    })
""",
    "",
)

# 12) 删除 closeUI
sub(
    """  function closeUI() {
    if (run.active) {
      toast('批次进行中，请先暂停/停止', 'warn')
      return
    }
    if (host) host.remove()
    host = null
    shadow = null
  }

""",
    "",
)

# 13) 启动方式：加载即打开
sub(
    "  GM_registerMenuCommand(menuLabel(), openUI)\n",
    """  // 页面版：加载即打开面板
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', openUI)
  else openUI()
""",
)
sub(
    """  function menuLabel() {
    const un = unknownCount()
    const unfinished = state.batches.find((b) => b.status === 'paused' || b.status === 'running')
    if (un) return `🧧 批量分发（${un} 笔待对账）`
    if (unfinished) return '🧧 批量分发（有未完成批次）'
    return '🧧 批量分发'
  }
""",
    "",
)

# 14) 挂载方式：普通容器 + 内联 <style>
sub(
    """    host = document.createElement('div')
    host.id = 'frp-redpacket-host'
    try {
      shadow = host.attachShadow({ mode: 'open' })
    } catch {
      return
    }
    // 样式经 adoptedStyleSheets 注入：不写内联 <style>，不受页面 CSP 影响，也不产生网络请求
    try {
      const sheet = new CSSStyleSheet()
      sheet.replaceSync(CSS)
      shadow.adoptedStyleSheets = [sheet]
    } catch {
      const styleEl = document.createElement('style')
      styleEl.textContent = CSS
      shadow.appendChild(styleEl)
    }
    shadow.innerHTML = SHELL
    bindShell()
    document.documentElement.appendChild(host)""",
    """    host = document.createElement('div')
    host.id = 'frp-page-root'
    try {
      shadow = host.attachShadow({ mode: 'open' })
    } catch {
      return
    }
    // 页面背景：挂在文档上（shadow 内样式不影响宿主 body）
    const pageStyle = document.createElement('style')
    pageStyle.textContent = 'body{margin:0;background:#e2e8f0}@media (prefers-color-scheme: dark){body{background:#0b1222}}'
    document.head.appendChild(pageStyle)
    shadow.innerHTML = SHELL
    const styleEl = document.createElement('style')
    styleEl.textContent = CSS
    shadow.appendChild(styleEl)
    document.body.appendChild(host)
    bindShell()""",
)

# 15) CSS：覆盖层 → 页面布局
sub(
    ".frp-overlay{position:fixed;inset:0;z-index:2147483647;background:rgba(15,23,42,.55);display:flex;align-items:flex-start;justify-content:center;padding:20px 10px;overflow:auto;font-family:",
    ".frp-overlay{min-height:100vh;background:#e2e8f0;display:flex;align-items:flex-start;justify-content:center;padding:24px 10px;font-family:",
)
sub(
    ".frp-panel{--bg:#ffffff;--fg:#0f172a;--muted:#64748b;--line:#e2e8f0;--card:#f8fafc;--pri:#e11d48;--pri-h:#be123c;--acc:#2563eb;--ok:#16a34a;--warn:#d97706;--err:#dc2626;--inp:#ffffff;background:var(--bg);color:var(--fg);width:100%;max-width:1000px;border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.35);display:flex;flex-direction:column;max-height:calc(100vh - 40px)}",
    ".frp-panel{--bg:#ffffff;--fg:#0f172a;--muted:#64748b;--line:#e2e8f0;--card:#f8fafc;--pri:#e11d48;--pri-h:#be123c;--acc:#2563eb;--ok:#16a34a;--warn:#d97706;--err:#dc2626;--inp:#ffffff;background:var(--bg);color:var(--fg);width:100%;max-width:1000px;border-radius:14px;box-shadow:0 12px 40px rgba(15,23,42,.18);display:flex;flex-direction:column}",
)
sub(
    "@media (prefers-color-scheme: dark){.frp-panel{",
    "@media (prefers-color-scheme: dark){.frp-overlay{background:#0b1222}.frp-panel{",
)

# 16) 文案：网络出口与密钥去向（中继链路）
# 16a) linux.do 同源名单接口仅用户脚本版可用（网页版 CSP 不允许直连 linux.do）
sub(
    """          h('code', { text: 'GET  https://linux.do/my/follow/followers.json' }), ' —— 拉取你自己的粉丝名单（同源请求，仅使用你当前登录会话，自动翻页）；',
          h('br'),
          h('code', { text: 'GET  https://linux.do/u/:username.json' }), ' —— 按用户名查询用户的 id / username / name（同源，查询添加功能）。',
          h('br'),""",
    """          '（「拉取我的粉丝」「按用户名查询」需 linux.do 登录态，为用户脚本版专享；网页版 CSP 不允许直连 linux.do）',
          h('br'),""",
)
sub(
    "'除上述出口外无任何其他网络请求：无统计、无 CDN、无头像加载（头像为本机生成的色块）、无字体/样式外链。名单、额度、批次与日志全部保存在本机脚本沙箱（GM 存储），可随时导出或清空。',",
    "'除此之外页面无任何网络出口（CSP 白名单强制：仅本页与 *.workers.dev）：无统计、无 CDN、无头像加载（头像为本机生成的色块）、无字体/样式外链。名单、额度、批次与日志全部保存在本机浏览器 localStorage，可随时导出或清空。',",
)
sub(
    "'· 密钥只会被发送到 ',\n          h('code', { text: 'https://credit.linux.do' }),\n          '（Tampermonkey @connect 白名单强制），本工具不包含任何其他网络出口，也不加载任何外部脚本/样式/头像。',",
    "'· 密钥只经你的中继发往 ',\n          h('code', { text: 'https://credit.linux.do' }),\n          '（中继只透传、无存储；页面 CSP 将网络出口限制为本页与 *.workers.dev），页面不加载任何外部脚本/样式/头像。',",
)

assert "closeUI" not in src, "closeUI 残留"
assert "menuLabel" not in src, "menuLabel 残留"

# 17) GM_* 适配层（放在 IIFE 之前）
PROLOGUE = """'use strict';
// ============================== 网页版适配层 ==============================
// GM_* 存储 → localStorage；GM_xmlhttpRequest → fetch（发往自部署的中继 Worker）。
// 业务逻辑与用户脚本版完全一致。

function GM_setValue(k, v) { localStorage.setItem(k, String(v)) }
function GM_getValue(k) { const v = localStorage.getItem(k); return v == null ? undefined : v }
function GM_deleteValue(k) { localStorage.removeItem(k) }
function GM_registerMenuCommand() { /* 页面版无需菜单 */ }

function GM_xmlhttpRequest(opts) {
  const ctrl = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try { ctrl.abort() } catch {}
  }, opts.timeout || 30000)
  ;(async () => {
    try {
      const headers = Object.assign({}, opts.headers || {})
      // 中继口令（与 Worker 环境变量 SHARED_TOKEN 对应，可选）
      let proxyToken = ''
      try { proxyToken = String(JSON.parse(localStorage.getItem('frp_settings_v1') || '{}').proxyToken || '') } catch {}
      if (proxyToken) headers['x-frp-token'] = proxyToken
      const resp = await fetch(opts.url, {
        method: opts.method || 'GET',
        headers,
        body: opts.data != null ? opts.data : undefined,
        signal: ctrl.signal,
      })
      const text = await resp.text()
      clearTimeout(timer)
      if (opts.onload) opts.onload({ status: resp.status, responseText: text })
    } catch (e) {
      clearTimeout(timer)
      if (timedOut) { if (opts.ontimeout) opts.ontimeout(e) }
      else if (opts.onerror) opts.onerror(e)
    }
  })()
  return { abort() { try { ctrl.abort() } catch {} } }
}

"""

# 去掉 IIFE 自带的 'use strict'（已提前），保留 IIFE 结构
body = src
assert "(function () {" in body, "IIFE 开头"
iife_body_start = body.index("'use strict'", body.index("(function () {"))
body = body[:iife_body_start] + body[iife_body_start + len("'use strict'") :]

script = PROLOGUE + body

FAVICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%A7%A7%3C/text%3E%3C/svg%3E"

html = f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="LDC 批量分发：纯前端批量打款。无后端、无登录、无数据库，数据全部存本机浏览器；除支付接口（经自部署中继）外零网络请求。">
<!--
  CSP 网络出口白名单：本页只允许访问「自身」与「*.workers.dev」（你的中继 Worker）。
  若你为 Worker 绑定了自定义域名，请把下方 connect-src 里的 https://*.workers.dev 改成你的域名。
-->
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self' https://*.workers.dev; base-uri 'none'; form-action 'none'">
<title>🧧 LDC 批量分发</title>
<link rel="icon" href="{FAVICON}">
</head>
<body>
<script>
{script}</script>
</body>
</html>
"""

DST.write_text(html, encoding="utf-8")
print(f"OK: {SRC.name} -> {DST.name} ({len(html)} bytes)")
sys.exit(0)
