// ==UserScript==
// @name         LDC 批量分发
// @namespace    vhxubo.ldc.batch-distribute
// @version      1.3.0
// @description  名单来源自由：粘贴 id/username JSON（含整份 /u/用户名.json）、按用户名查询添加、快捷键 Alt+F 一键拉取我的粉丝；展示头像与信任等级 → 统一/单独设置额度 → 通过 credit.linux.do 商户密钥批量打款。无后端、无数据库：数据全部存本机浏览器，除 LDC 支付接口与 linux.do 同源接口外不发任何网络请求，发放全程留痕可审计、可导出。
// @author       vhxubo
// @license      MIT
// @match        https://linux.do/*
// @connect      credit.linux.do
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @icon         data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%A7%A7%3C/text%3E%3C/svg%3E
// @noframes
// @run-at       document-idle
// ==/UserScript==

/**
 * 设计要点：
 *
 * 接口（https://credit.linux.do，仅 /lpay/ 与 /epay/ 前缀在 Cloudflare 放行名单内）：
 *  - POST /lpay/distribute   Basic Auth(client_id:client_secret) 商户分发打款。
 *      body: {user_id:<数字>, username, amount:"两位小数", out_trade_no, remark}
 *      成功 = HTTP 2xx 且 JSON 可解析 且 error_msg 为空 且 code!==-1 且 data.trade_no 非空；
 *      网关可能返回 200 + 非 JSON（CF 拦截页），严禁误判为成功——按「状态未知」处理。
 *  - GET  /epay/api.php?act=order&pid&key&out_trade_no  商户查单（易支付兼容）。
 *      msg 含「商户信息不存在」= 密钥错误；含「订单不存在/服务不存在」= 密钥正确且该单未落地
 *      （据此做零成本密钥校验与打款对账）；code===1 = 订单存在，返回 trade_no。
 *
 * 资金安全（先落库再打款 + 单号幂等）：
 *  - 批次与每笔的商户单号（out_trade_no）在实际发请求之前就写入本地存储；
 *  - 重试一律复用原单号（上游若幂等则天然去重，事后对账也能发现）；
 *  - 网络层失败/响应不可解析 → 「待对账(unknown)」，绝不自动重试，必须先查单定性：
 *      查到 → 补记成功；确认未落地 → 标记失败（可重试）；查单本身失败 → 保持待对账；
 *  - 存在待对账记录时禁止开新批次，防止重复发放。
 *
 * 本地存储（GM_*，脚本沙箱内，页面脚本读不到）：名单 / 设置 / 批次审计 / 操作日志 / 加密密钥 / 悬浮按钮位置。
 * 密钥默认仅存内存（刷新即失）；可选「加密记住」：AES-256-GCM + PBKDF2-SHA256(310k) 口令加密后落盘。
 *
 * 名单拉取与查询（快捷键 Alt+F / 油猴菜单 / 面板按钮，全部走 linux.do 同源、携带当前登录会话）：
 *  - GET https://linux.do/my/follow/followers.json
 *    拉取你自己的粉丝列表，自动翻页合并，按 id 去重、截断至 MAX_ROWS 后整体导入名单。
 *  - GET https://linux.do/u/:username.json：按用户名查询用户，提取 id / username / name 后追加进名单；
 *    把整份该接口响应粘进导入框也能直接导入（只取 user 主体，忽略顶层的 users/badges 等）。
 *  - 同源请求仅访问 linux.do 本身，不经过任何第三方；未登录或站点改版会明确报错，绝不静默吞掉。
 *
 * 名单的唯一硬性要求：数字 id + username（打款接口的必要参数）；name / avatar_template / trust_level
 * 可选，仅用于展示：头像取自 linux.do/ldstatic CDN（{size} 占位符），加载失败自动回退本机生成的色块。
 *
 * 网络出口共三类：credit.linux.do（@connect 白名单）、上述两条 linux.do 同源接口，
 * 以及 linux.do/ldstatic 头像 CDN（仅 <img> 展示）；除此之外一律不发。
 */

(function () {
  'use strict'

  // ============================== 常量 ==============================

  const LDC_BASE = 'https://credit.linux.do'
  const QUERY_PATH = '/epay/api.php'
  const DISTRIBUTE_PATH = '/lpay/distribute'
  const VERSION = '1.3.0'
  const REQUEST_TIMEOUT_MS = 30_000
  const MAX_BODY = 1 << 20
  const PBKDF2_ITERATIONS = 310_000
  const CRED_ENC_VERSION = 1

  const K_ROSTER = 'frp_roster_v1'
  const K_SETTINGS = 'frp_settings_v1'
  const K_BATCHES = 'frp_batches_v1'
  const K_OPLOG = 'frp_oplog_v1'
  const K_CRED_ENC = 'frp_cred_enc_v1'
  const K_LAUNCHER = 'frp_launcher_v1'

  const MAX_ROWS = 1000 // 单次导入上限，防卡死
  const MAX_BATCHES = 50 // 审计批次留存上限（超出后导出再自动清理最旧）
  const MAX_OPLOG = 500
  const MIN_CENTS = 1 // 0.01 LDC
  const MAX_CENTS = 100_000_000 // 单笔上限 100 万，防手滑
  const REMARK_MAX = 100
  const DISPATCH_GAP_MS = 200 // 相邻两笔之间的间隔，避免触发限流

  // 「我的粉丝」同源接口（Discourse JSON 形态）
  const FOLLOW_PATH = '/my/follow/followers.json'
  const FOLLOW_PAGE_CAP = 40 // 自动翻页保护上限

  const STATUS_TEXT = {
    pending: '待发放',
    sending: '发放中',
    success: '成功',
    failed: '失败',
    unknown: '待对账',
  }

  // 示例名单（仅作一键填入演示，可自行清空）
  const SAMPLE_JSON = JSON.stringify([
    {
      id: 76303,
      username: 'vhxubo',
      name: '归谜',
      avatar_template: '/user_avatar/linux.do/vhxubo/{size}/2261510_2.png',
      trust_level: 3,
    },
  ])

  // ============================== 小工具 ==============================

  function loadJSON(key, fallback) {
    try {
      const raw = GM_getValue(key)
      if (raw == null || raw === '') return fallback
      return JSON.parse(raw)
    } catch {
      return fallback
    }
  }
  function saveJSON(key, value) {
    GM_setValue(key, JSON.stringify(value))
  }

  /** 金额分 → "12.34"（打款接口要求两位小数字符串） */
  function fmtCents(cents) {
    return (cents / 100).toFixed(2)
  }
  /** "12.34"/"12.3"/"12" → 分（整数），非法返回 null */
  function parseCents(text) {
    const s = String(text ?? '').trim()
    if (!/^\d+(\.\d{1,2})?$/.test(s)) return null
    const [a, b = ''] = s.split('.')
    const cents = parseInt(a, 10) * 100 + parseInt(((b || '') + '00').slice(0, 2), 10)
    return Number.isSafeInteger(cents) ? cents : null
  }
  function randStr(len) {
    const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    const arr = crypto.getRandomValues(new Uint8Array(len))
    return Array.from(arr, (n) => abc[n % abc.length]).join('')
  }
  function newBatchId() {
    return 'B' + Date.now().toString(36).toUpperCase() + randStr(4)
  }
  /** 商户单号：纯字母数字，幂等键。生成后终生复用，绝不重新生成。 */
  function newOutTradeNo(batchId, seq) {
    return 'FRP' + batchId.slice(1) + seq.toString(36).toUpperCase().padStart(3, '0') + randStr(4)
  }
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms))
  }
  function fmtTime(ts) {
    if (!ts) return '—'
    const d = new Date(ts)
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  }
  function maskPid(pid) {
    const s = String(pid)
    if (s.length <= 6) return s.slice(0, 2) + '…'
    return s.slice(0, 3) + '…' + s.slice(-2)
  }
  function hashHue(str) {
    let h = 0
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0
    return h % 360
  }
  /** 触发浏览器下载（Blob 为本地对象，不产生网络请求） */
  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.documentElement.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 5000)
  }
  function csvCell(v) {
    let s = String(v ?? '')
    // 公式注入防护：以 =+-@ 开头的单元格前置单引号
    if (/^[=+\-@]/.test(s)) s = "'" + s
    return '"' + s.replace(/"/g, '""') + '"'
  }

  // ============================== 全局状态 ==============================

  const state = {
    roster: loadJSON(K_ROSTER, { importedAt: 0, users: [] }),
    settings: Object.assign({ remark: '红包', concurrency: 2 }, loadJSON(K_SETTINGS, {})),
    batches: loadJSON(K_BATCHES, []),
    oplog: loadJSON(K_OPLOG, []),
    credEnc: loadJSON(K_CRED_ENC, null), // {v,salt,iv,ct,pidMask} 口令加密的密钥
    cred: null, // {clientId,clientSecret} 仅内存，刷新即失
    ui: { tab: 'roster', search: '', currentBatchId: null, credShow: false },
  }
  // 页面刷新会中断进行中的批次：running 一律归档为 paused（未知单在，等待对账/继续）
  for (const b of state.batches) {
    if (b.status === 'running') {
      b.status = 'paused'
      b.rows.forEach((r) => {
        if (r.status === 'sending') {
          r.status = 'unknown'
          r.error = '脚本中断，发放结果未知'
        }
      })
      b.events.push({ t: Date.now(), type: 'batch.interrupted', text: '检测到脚本中断，批次已暂停；sending 记录转为待对账' })
    }
  }
  if (state.batches.some((b) => b.status === 'paused' && b.interruptNoted !== true)) {
    saveJSON(K_BATCHES, state.batches)
  }

  function persistRoster() {
    saveJSON(K_ROSTER, state.roster)
  }
  function persistSettings() {
    saveJSON(K_SETTINGS, state.settings)
  }
  function persistBatches() {
    saveJSON(K_BATCHES, state.batches)
    updateLauncherBadge()
  }
  function logOp(type, text) {
    state.oplog.unshift({ t: Date.now(), type, text })
    if (state.oplog.length > MAX_OPLOG) state.oplog.length = MAX_OPLOG
    saveJSON(K_OPLOG, state.oplog)
    if (shadow && refs.oplogList && state.ui.tab === 'audit') renderAuditTab()
  }
  function batchEvent(batch, type, text) {
    batch.events.push({ t: Date.now(), type, text })
  }

  // ============================== LDC 客户端 ==============================

  /** 状态未知错误：网络层失败或响应不可解析，上游可能已处理请求，必须查单对账。 */
  class UnknownStateError extends Error {}

  /**
   * GM_xmlhttpRequest 包装：resolve {status, text}；网络失败/超时 reject UnknownStateError。
   * 注意：4xx/5xx 也走 onload（需要读取错误响应体）。
   */
  function gmText(opts) {
    return new Promise((resolve, reject) => {
      let settled = false
      const fail = (msg) => {
        if (!settled) {
          settled = true
          reject(new UnknownStateError(msg))
        }
      }
      let handle
      try {
        handle = GM_xmlhttpRequest({
          method: opts.method,
          url: opts.url,
          headers: opts.headers || {},
          data: opts.body,
          timeout: REQUEST_TIMEOUT_MS,
          onload: (resp) => {
            if (settled) return
            settled = true
            resolve({ status: resp.status, text: String(resp.responseText || '').slice(0, MAX_BODY) })
          },
          onerror: () => fail('网络请求失败（连接错误或被拦截）'),
          ontimeout: () => fail(`网络请求超时（>${REQUEST_TIMEOUT_MS / 1000}s）`),
          onabort: () => fail('网络请求被中止'),
        })
      } catch (e) {
        fail('请求发起失败: ' + (e && e.message))
      }
      return handle
    })
  }

  function basicAuthHeader(clientId, clientSecret) {
    return 'Basic ' + btoa(unescape(encodeURIComponent(clientId + ':' + clientSecret)))
  }

  function isOrderNotFound(msg) {
    return msg.includes('订单不存在') || msg.includes('服务不存在')
  }

  /**
   * 查单（易支付兼容）：
   *  - {kind:'notfound'}        密钥正确且该单未落地
   *  - {kind:'found', tradeNo}  订单已存在（发放已落地）
   *  - 其他情况抛 Error（无法判定，保持原状态待重查）
   */
  async function ldcQueryOrder(clientId, clientSecret, outTradeNo) {
    const q = new URLSearchParams({ act: 'order', pid: clientId, key: clientSecret, out_trade_no: outTradeNo })
    const resp = await gmText({ method: 'GET', url: LDC_BASE + QUERY_PATH + '?' + q.toString() })
    let ep
    try {
      ep = JSON.parse(resp.text)
    } catch {
      throw new Error(`查单响应异常(${resp.status}): 非 JSON: ${resp.text.slice(0, 120)}`)
    }
    const msg = String(ep.msg ?? '')
    if (msg.includes('商户信息不存在')) throw new Error('查单失败：client_id 或 client_secret 不正确')
    if (isOrderNotFound(msg)) return { kind: 'notfound' }
    if (ep.code === 1) return { kind: 'found', tradeNo: String(ep.trade_no ?? '') }
    throw new Error('查单接口返回异常信息: ' + msg)
  }

  /** 零成本校验密钥：查一个必不存在的随机单号。返回 {ok, msg} */
  async function ldcVerifyCredentials(clientId, clientSecret) {
    if (!clientId || !clientSecret) return { ok: false, msg: '请先填写 client_id 与 client_secret' }
    let res
    try {
      const q = new URLSearchParams({
        act: 'order',
        pid: clientId,
        key: clientSecret,
        out_trade_no: 'VERIFY' + Date.now().toString(36).toUpperCase() + randStr(6),
      })
      res = await gmText({ method: 'GET', url: LDC_BASE + QUERY_PATH + '?' + q.toString() })
    } catch (e) {
      return { ok: false, msg: '无法连接 credit 接口: ' + e.message }
    }
    let ep
    try {
      ep = JSON.parse(res.text)
    } catch {
      return { ok: false, msg: `LDC 接口响应异常(${res.status}): 非 JSON: ${res.text.slice(0, 120)}` }
    }
    const msg = String(ep.msg ?? '')
    if (msg.includes('商户信息不存在')) return { ok: false, msg: 'client_id 或 client_secret 不正确' }
    if (isOrderNotFound(msg)) return { ok: true, msg: '密钥校验通过' }
    return { ok: false, msg: 'LDC 接口返回异常信息: ' + msg }
  }

  /**
   * 商户分发打款（同步）。成功返回 {tradeNo}；
   * 明确业务失败抛 Error；网络失败/响应不可解析抛 UnknownStateError（状态未知，须查单）。
   */
  async function ldcDistribute(clientId, clientSecret, p) {
    const resp = await gmText({
      method: 'POST',
      url: LDC_BASE + DISTRIBUTE_PATH,
      headers: {
        'Content-Type': 'application/json',
        Authorization: basicAuthHeader(clientId, clientSecret),
      },
      body: JSON.stringify({
        user_id: p.userId, // 官方结构体为 uint64，必须传 JSON 数字
        username: p.username,
        amount: p.amount, // 两位小数字符串
        out_trade_no: p.outTradeNo,
        remark: p.remark,
      }),
    })
    let br
    try {
      br = JSON.parse(resp.text)
    } catch {
      // 网关可能返回 200 + HTML（CF 挑战页/代理报错页），严禁判成功
      throw new UnknownStateError(`响应异常(${resp.status}): 非 JSON: ${resp.text.slice(0, 120)}`)
    }
    const tradeNo = String(br.data?.trade_no ?? '')
    if (resp.status >= 200 && resp.status < 300 && !br.error_msg && br.code !== -1 && tradeNo !== '') {
      return { tradeNo }
    }
    throw new Error(`打款失败(${resp.status}): ${String(br.error_msg || resp.text.slice(0, 160))}`)
  }

  // ============================== 密钥管理（WebCrypto 加密落盘） ==============================

  function b64buf(bytes) {
    let s = ''
    for (const b of bytes) s += String.fromCharCode(b)
    return btoa(s)
  }
  function unb64(str) {
    const s = atob(str)
    const out = new Uint8Array(s.length)
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
    return out
  }

  async function deriveAesKey(passphrase, salt) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey'])
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    )
  }

  async function encryptCred(cred, passphrase) {
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const key = await deriveAesKey(passphrase, salt)
    const plain = new TextEncoder().encode(JSON.stringify(cred))
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain))
    return { v: CRED_ENC_VERSION, salt: b64buf(salt), iv: b64buf(iv), ct: b64buf(ct), pidMask: maskPid(cred.clientId) }
  }

  async function decryptCred(blob, passphrase) {
    const key = await deriveAesKey(passphrase, unb64(blob.salt))
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(blob.iv) },
      key,
      unb64(blob.ct),
    )
    return JSON.parse(new TextDecoder().decode(plain))
  }

  // ============================== 粉丝名单拉取（linux.do 同源接口） ==============================

  let fetchingFollowers = false

  /** 同源 GET（携带当前登录会话）；非 2xx 或非 JSON 都明确抛错，绝不静默 */
  async function fetchFollowJson(url) {
    let resp
    try {
      resp = await fetch(url, { method: 'GET', credentials: 'same-origin', headers: { Accept: 'application/json' } })
    } catch (e) {
      throw new Error('同源请求失败：' + (e && e.message))
    }
    const text = String(await resp.text()).slice(0, MAX_BODY)
    if (!resp.ok) {
      const hint = resp.status === 401 || resp.status === 403 ? '（请先登录 linux.do）' : ''
      throw new Error(`HTTP ${resp.status}${hint}`)
    }
    try {
      return JSON.parse(text)
    } catch {
      throw new Error(`响应不是 JSON（可能未登录或站点已改版）：${text.slice(0, 80)}`)
    }
  }

  /** 兼容多种 Discourse 序列化形态：[...] / {users:[...]} / {user_list:[...]|{users:[...]}} / {followers:[...]} */
  function extractUserList(json) {
    if (Array.isArray(json)) return json
    if (!json || typeof json !== 'object') return null
    for (const key of ['users', 'followers', 'user_list', 'follows']) {
      const v = json[key]
      if (Array.isArray(v)) return v
      if (v && typeof v === 'object' && Array.isArray(v.users)) return v.users
    }
    return null
  }

  /** 响应自带翻页链接（load_more_url / more_url / meta.pagination.next）则跟随 */
  function extractMoreUrl(json) {
    const cand =
      json && typeof json === 'object'
        ? json.load_more_url ||
          json.more_url ||
          (json.meta && (json.meta.load_more_url || (json.meta.pagination && json.meta.pagination.next)))
        : null
    if (typeof cand !== 'string' || !cand) return null
    try {
      return new URL(cand, location.origin).href
    } catch {
      return null
    }
  }

  function setFetchBtn(busy, progress) {
    if (!refs.fetchBtn) return
    refs.fetchBtn.disabled = busy
    refs.fetchBtn.textContent = busy ? `拉取中…（已获取 ${progress || 0} 人）` : '拉取我的粉丝（Alt+F）'
  }

  /**
   * 拉取「我的粉丝」并导入名单：自动翻页合并，按 id 去重，超出 MAX_ROWS 截断。
   * 页面未打开时 toast 走悬浮按钮的 shadow（见 toast()），操作结果始终可见。
   */
  async function fetchMyFollowers() {
    if (fetchingFollowers) {
      toast('正在拉取粉丝名单，请稍候…', 'warn')
      return
    }
    fetchingFollowers = true
    setFetchBtn(true)
    try {
      // 1) 拉取第一页
      let json = await fetchFollowJson(location.origin + FOLLOW_PATH)
      if (!extractUserList(json)) throw new Error('接口返回了无法识别的结构（可能未登录或站点已改版）')

      // 2) 翻页合并：优先响应提供的 more 链接，否则 ?page=N 递增；
      //    站点可能忽略翻页参数重复返回同一页，连续两次内容未推进即认为已到底
      const raw = []
      let page = 0
      let staleStreak = 0
      for (;;) {
        page++
        const list = extractUserList(json) || []
        raw.push(...list)
        setFetchBtn(true, raw.length)
        if (!list.length || raw.length >= MAX_ROWS || page >= FOLLOW_PAGE_CAP) break
        const firstId = list[0] && list[0].id
        const more = extractMoreUrl(json)
        json = await fetchFollowJson(more || location.origin + FOLLOW_PATH + '?page=' + (page + 1))
        const next = extractUserList(json)
        if (!next || !next.length) break
        const stale = next[0] && firstId != null && next[0].id === firstId && next.length === list.length
        staleStreak = stale ? staleStreak + 1 : 0
        if (staleStreak >= 2) break
      }

      // 3) 统一校验 / 去重 / 截断后导入（复用粘贴导入管线）
      const res = parseUserArray(raw)
      if (res.error) throw new Error(res.error)
      applyRoster(res, '拉取我的粉丝')
      const parts = [`已拉取 ${res.users.length} 位粉丝并导入名单`]
      if (res.dup) parts.push(`去重 ${res.dup}`)
      if (res.skipped) parts.push(`跳过无效 ${res.skipped}`)
      if (res.truncated) parts.push(`超出 ${MAX_ROWS} 上限已截断`)
      toast(parts.join('，'), 'ok')
      openUI()
      switchTab('roster')
    } catch (e) {
      const msg = e && e.message ? e.message : String(e)
      logOp('roster.followers.fail', '拉取我的粉丝失败：' + msg)
      toast('拉取粉丝失败：' + msg, 'error')
    } finally {
      fetchingFollowers = false
      setFetchBtn(false)
    }
  }

  // ---------- 按用户名查询添加（GET /u/:username.json） ----------

  let lookingUp = false

  /** 追加一个用户到名单（按 id 去重、受 MAX_ROWS 上限约束）；返回 'added' | 'dup' | 'full'。重复时仅刷新展示字段（name/头像/等级），不动额度与勾选 */
  function addRosterUser(u) {
    const id = Number(u && u.id)
    const username = String((u && u.username) ?? '').trim()
    if (!Number.isInteger(id) || id <= 0 || !username) return 'dup' // 无效按已存在处理，调用方另行校验
    const ex = state.roster.users.find((x) => x.id === id)
    if (ex) {
      const name = String((u && u.name) ?? '').trim()
      if (name) ex.name = name
      if (u && u.avatar) ex.avatar = String(u.avatar).trim()
      const tl = normTrustLevel(u && u.trustLevel)
      if (tl !== null) ex.trustLevel = tl
      return 'dup'
    }
    if (state.roster.users.length >= MAX_ROWS) return 'full'
    state.roster.users.push({
      id,
      username,
      name: String((u && u.name) ?? '').trim(),
      avatar: String((u && u.avatar) ?? '').trim(),
      trustLevel: normTrustLevel(u && u.trustLevel),
      included: true,
      amountCents: 0,
    })
    return 'added'
  }

  function setLookupBtn(busy, progress) {
    if (!refs.lookupBtn) return
    refs.lookupBtn.disabled = busy
    refs.lookupBtn.textContent = busy ? `查询中…（${progress || ''}）` : '查询并添加'
  }

  /**
   * 输入用户名（支持空格/逗号/换行分隔多个，自动去掉 @ 前缀），逐个请求
   * /u/:username.json 提取 id / username / name 后追加进名单；单个失败不影响其余。
   */
  async function lookupUsers() {
    if (lookingUp) {
      toast('正在查询用户，请稍候…', 'warn')
      return
    }
    if (!refs.lookup) return
    const names = [
      ...new Set(
        refs.lookup.value
          .split(/[\s,，;；、]+/)
          .map((s) => s.trim().replace(/^@+/, ''))
          .filter(Boolean),
      ),
    ]
    if (!names.length) {
      toast('请先输入要查询的用户名', 'warn')
      return
    }
    if (names.length > 100) {
      toast('一次最多查询 100 个用户名', 'warn')
      return
    }
    lookingUp = true
    setLookupBtn(true, `0/${names.length}`)
    let added = 0
    let dup = 0
    let full = 0
    const failed = []
    try {
      for (let i = 0; i < names.length; i++) {
        const name = names[i]
        setLookupBtn(true, `${i + 1}/${names.length}`)
        try {
          const json = await fetchFollowJson(location.origin + '/u/' + encodeURIComponent(name) + '.json')
          const u = json && json.user
          const id = Number(u && u.id)
          const username = String((u && u.username) ?? '').trim()
          if (!Number.isInteger(id) || id <= 0 || !username) throw new Error('响应中没有有效用户')
          const r = addRosterUser({
            id,
            username,
            name: String((u && u.name) ?? '').trim(),
            avatar: String((u && u.avatar_template) ?? '').trim(),
            trustLevel: normTrustLevel(u && u.trust_level),
          })
          if (r === 'added') added++
          else if (r === 'full') full++
          else dup++
        } catch (e) {
          failed.push(`${name}（${e && e.message ? e.message : '未知错误'}）`)
        }
        if (i < names.length - 1) await sleep(200) // 轻微间隔，避免连发触发限流
      }
      if (added) {
        state.roster.importedAt = Date.now()
        persistRoster()
      }
      const parts = [`查询添加 ${added} 人`]
      if (dup) parts.push(`已在名单 ${dup}`)
      if (full) parts.push(`超出上限跳过 ${full}`)
      if (failed.length) parts.push(`失败 ${failed.length}：${failed.slice(0, 3).join('、')}${failed.length > 3 ? ' …' : ''}`)
      toast(parts.join('，'), added ? 'ok' : failed.length ? 'error' : 'warn')
      logOp('roster.lookup', `按用户名查询：添加 ${added}，已存在 ${dup}${full ? `，超上限 ${full}` : ''}${failed.length ? `，失败 ${failed.length}（${failed.map((s) => s.split('（')[0]).join('、')}）` : ''}`)
      renderRosterTab()
      if (added) openUI(), switchTab('roster')
    } finally {
      lookingUp = false
      setLookupBtn(false)
    }
  }

  // ============================== 批次与发放引擎 ==============================

  const run = { active: false, pause: false, stop: false }

  function hasUnknownRows() {
    return state.batches.some((b) => b.rows.some((r) => r.status === 'unknown'))
  }
  function unknownCount() {
    let n = 0
    for (const b of state.batches) for (const r of b.rows) if (r.status === 'unknown') n++
    return n
  }
  function getBatch(id) {
    return state.batches.find((b) => b.id === id)
  }
  function resumableRows(batch) {
    return batch.rows.filter((r) => r.status === 'pending')
  }

  /** 创建批次：冻结名单快照并先行落盘（单号先于任何请求存在） */
  function createBatch(mode) {
    const users = state.roster.users.filter((u) => u.included)
    const batchId = newBatchId()
    const batch = {
      id: batchId,
      mode, // 'live' | 'dry'
      status: 'running',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      finishedAt: 0,
      remark: state.settings.remark,
      pid: state.cred ? state.cred.clientId : '(演练)',
      rows: users.map((u, i) => ({
        id: u.id,
        username: u.username,
        name: u.name,
        avatar: u.avatar || '',
        trustLevel: typeof u.trustLevel === 'number' ? u.trustLevel : null,
        amountCents: u.amountCents,
        outTradeNo: newOutTradeNo(batchId, i),
        status: 'pending',
        tradeNo: '',
        error: '',
        finishedAt: 0,
      })),
      events: [
        {
          t: Date.now(),
          type: 'batch.start',
          text:
            mode === 'dry'
              ? `创建演练批次：${users.length} 人，合计 ${fmtCents(users.reduce((s, u) => s + u.amountCents, 0))} LDC（不实际打款）`
              : `创建批次：${users.length} 人，合计 ${fmtCents(users.reduce((s, u) => s + u.amountCents, 0))} LDC，商户 ${maskPid(state.cred.clientId)}`,
        },
      ],
    }
    state.batches.unshift(batch)
    if (state.batches.length > MAX_BATCHES) {
      const dropped = state.batches.splice(MAX_BATCHES)
      logOp('batch.prune', `审计批次超过 ${MAX_BATCHES} 条，自动清理最旧 ${dropped.length} 条（请先导出留存）`)
    }
    persistBatches()
    state.ui.currentBatchId = batchId
    return batch
  }

  async function runBatch(batchId) {
    const batch = getBatch(batchId)
    if (!batch) return
    if (run.active) {
      toast('已有批次在进行中', 'warn')
      return
    }
    if (!resumableRows(batch).length) {
      toast('该批次没有待发放的记录', 'warn')
      return
    }
    if (batch.mode === 'live' && !state.cred) {
      toast('请先在「密钥设置」中配置并校验密钥', 'error')
      switchTab('cred')
      return
    }
    run.active = true
    run.pause = false
    run.stop = false
    batch.status = 'running'
    batchEvent(batch, 'batch.run', resumableRows(batch).length + ' 笔进入发放队列')
    persistBatches()
    renderAll()

    const workers = []
    const n = Math.max(1, Math.min(3, parseInt(state.settings.concurrency, 10) || 2))
    for (let w = 0; w < n; w++) workers.push(workerLoop(batch))
    await Promise.all(workers)
    finishBatch(batch)
    run.active = false
    renderAll()
  }

  async function workerLoop(batch) {
    for (;;) {
      if (run.stop || run.pause) return
      const row = batch.rows.find((r) => r.status === 'pending')
      if (!row) return
      await dispatchRow(batch, row)
      if (!run.stop && !run.pause) await sleep(DISPATCH_GAP_MS)
    }
  }

  async function dispatchRow(batch, row) {
    row.status = 'sending'
    row.error = ''
    persistBatches()
    renderAll()

    if (batch.mode === 'dry') {
      // 演练模式：不发任何网络请求，本地模拟结果（含个别失败/待对账，便于预览界面）
      await sleep(60 + Math.random() * 140)
      if (/fail/i.test(row.username)) {
        row.status = 'failed'
        row.error = '演练：模拟打款失败'
      } else if (/unknown/i.test(row.username)) {
        row.status = 'unknown'
        row.error = '演练：模拟网络异常（状态未知）'
      } else {
        row.status = 'success'
        row.tradeNo = 'DRY' + randStr(12)
      }
      row.finishedAt = Date.now()
      persistBatches()
      renderAll()
      return
    }

    const cred = state.cred
    if (!cred) {
      row.status = 'pending'
      run.pause = true
      toast('密钥不可用，批次已暂停', 'error')
      batchEvent(batch, 'batch.autopause', '密钥不可用，自动暂停')
      persistBatches()
      renderAll()
      return
    }
    try {
      const res = await ldcDistribute(cred.clientId, cred.clientSecret, {
        userId: row.id,
        username: row.username,
        amount: fmtCents(row.amountCents),
        outTradeNo: row.outTradeNo, // 幂等键：重试永远复用
        remark: batch.remark,
      })
      row.status = 'success'
      row.tradeNo = res.tradeNo
      row.error = ''
    } catch (e) {
      if (e instanceof UnknownStateError) {
        row.status = 'unknown'
        row.error = e.message
      } else {
        row.status = 'failed'
        row.error = e.message
      }
    }
    row.finishedAt = Date.now()
    persistBatches()
    renderAll()
  }

  function finishBatch(batch) {
    const pending = resumableRows(batch).length
    const sending = batch.rows.some((r) => r.status === 'sending')
    if (sending) {
      batch.rows.forEach((r) => {
        if (r.status === 'sending') {
          r.status = 'unknown'
          r.error = r.error || '批次结束时仍在发送，结果未知'
        }
      })
    }
    if (run.stop) {
      batch.status = 'stopped'
      batchEvent(batch, 'batch.stop', '已手动停止')
    } else if (pending > 0) {
      batch.status = 'paused'
      batchEvent(batch, 'batch.pause', `暂停，剩余 ${pending} 笔待发放`)
    } else {
      batch.status = 'done'
      batch.finishedAt = Date.now()
      const ok = batch.rows.filter((r) => r.status === 'success').length
      const bad = batch.rows.filter((r) => r.status === 'failed').length
      const unk = batch.rows.filter((r) => r.status === 'unknown').length
      batchEvent(batch, 'batch.done', `批次完成：成功 ${ok}，失败 ${bad}，待对账 ${unk}`)
    }
    batch.updatedAt = Date.now()
    persistBatches()
  }

  async function reconcileRow(batch, row) {
    if (batch.mode === 'dry') {
      // 演练批次没有真实单据，直接定性为「确认未落地」
      row.status = 'failed'
      row.error = '演练：查单确认未落地（模拟）'
      batchEvent(batch, 'row.reconcile', `演练批次 ${row.username}（${row.id}）对账定性为失败（可重试）`)
      persistBatches()
      renderAll()
      return true
    }
    if (!state.cred) {
      toast('请先解锁/配置密钥后再对账', 'error')
      return false
    }
    row.error = ''
    try {
      const q = await ldcQueryOrder(state.cred.clientId, state.cred.clientSecret, row.outTradeNo)
      if (q.kind === 'found') {
        row.status = 'success'
        row.tradeNo = q.tradeNo || row.tradeNo
        row.error = ''
        batchEvent(batch, 'row.reconcile', `${row.username}（${row.id}）查单确认已落地，补记成功，交易号 ${q.tradeNo || '—'}`)
      } else {
        row.status = 'failed'
        row.error = '查单确认未落地（可安全重试）'
        batchEvent(batch, 'row.reconcile', `${row.username}（${row.id}）查单确认未落地，转为失败可重试`)
      }
    } catch (e) {
      row.error = '对账失败：' + e.message
      batchEvent(batch, 'row.reconcile.fail', `${row.username}（${row.id}）对账失败：${e.message}`)
      persistBatches()
      renderAll()
      return false
    }
    persistBatches()
    renderAll()
    return true
  }

  async function reconcileBatch(batch) {
    const rows = batch.rows.filter((r) => r.status === 'unknown')
    if (!rows.length) {
      toast('没有待对账的记录', 'warn')
      return
    }
    toast(`开始对账 ${rows.length} 笔…`)
    let ok = 0
    for (const r of rows) {
      const done = await reconcileRow(batch, r)
      if (done) ok++
      await sleep(200)
    }
    toast(`对账完成：定性 ${ok}/${rows.length}，其余保持待对账（稍后重试）`)
  }

  /** 查单定性后的失败（确认未落地）与明确失败都可重试；单号复用。 */
  function retryRows(batch, only) {
    const rows = batch.rows.filter((r) => r.status === 'failed' && (!only || only.includes(r)))
    for (const r of rows) {
      r.status = 'pending'
      r.error = ''
    }
    if (rows.length) batchEvent(batch, 'row.retry', `${rows.length} 笔失败记录转入重试队列（复用原单号）`)
    persistBatches()
    renderAll()
    if (rows.length) runBatch(batch.id)
  }

  function exportBatchCsv(batch) {
    const head = ['时间', '批次ID', '模式', '状态', '用户ID', '用户名', '昵称', '金额LDC', '商户单号', 'LDC交易号', '错误信息']
    const lines = [head.map(csvCell).join(',')]
    for (const r of batch.rows) {
      lines.push(
        [
          fmtTime(r.finishedAt || batch.updatedAt),
          batch.id,
          batch.mode === 'dry' ? '演练' : '实发',
          STATUS_TEXT[r.status] || r.status,
          r.id,
          r.username,
          r.name,
          fmtCents(r.amountCents),
          r.outTradeNo,
          r.tradeNo,
          r.error,
        ]
          .map(csvCell)
          .join(','),
      )
    }
    download(`ldc红包-${batch.id}.csv`, '\uFEFF' + lines.join('\r\n'), 'text/csv;charset=utf-8')
    logOp('batch.export.csv', `导出批次 ${batch.id} 回执 CSV`)
  }

  function exportBatchJson(batch) {
    download(`ldc红包-${batch.id}.json`, JSON.stringify(batch, null, 2), 'application/json')
    logOp('batch.export.json', `导出批次 ${batch.id} 审计 JSON`)
  }

  function exportAllAudit() {
    const payload = {
      exportedAt: Date.now(),
      tool: 'LDC 批量分发 v' + VERSION,
      oplog: state.oplog,
      batches: state.batches,
    }
    download(`ldc红包-审计-${newBatchId()}.json`, JSON.stringify(payload, null, 2), 'application/json')
    logOp('audit.export', '导出全部审计数据')
  }

  // ============================== UI：样式 ==============================

  const CSS = `
:host{all:initial}
*,*::before,*::after{box-sizing:border-box}
.frp-overlay{position:fixed;inset:0;z-index:2147483647;background:rgba(15,23,42,.55);display:flex;align-items:flex-start;justify-content:center;padding:20px 10px;overflow:auto;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}
.frp-panel{--bg:#ffffff;--fg:#0f172a;--muted:#64748b;--line:#e2e8f0;--card:#f8fafc;--pri:#e11d48;--pri-h:#be123c;--acc:#2563eb;--ok:#16a34a;--warn:#d97706;--err:#dc2626;--inp:#ffffff;background:var(--bg);color:var(--fg);width:100%;max-width:1000px;border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.35);display:flex;flex-direction:column;max-height:calc(100vh - 40px)}
@media (prefers-color-scheme: dark){.frp-panel{--bg:#0f172a;--fg:#e2e8f0;--muted:#94a3b8;--line:#1e293b;--card:#1e293b;--acc:#3b82f6;--inp:#0b1222}}
.frp-head{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--line);flex:none}
.frp-head h1{font-size:17px;margin:0;font-weight:700}
.frp-pill{font-size:12px;padding:3px 10px;border-radius:999px;border:1px solid var(--line);background:var(--card);color:var(--muted);white-space:nowrap}
.frp-pill.ok{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 35%, transparent)}
.frp-pill.warn{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 35%, transparent)}
.frp-sp{flex:1}
.frp-tabs{display:flex;gap:2px;padding:8px 12px 0;border-bottom:1px solid var(--line);flex:none;overflow-x:auto}
.frp-tab{appearance:none;border:none;background:none;color:var(--muted);font-size:14px;padding:9px 14px;cursor:pointer;border-radius:8px 8px 0 0;border-bottom:2px solid transparent;white-space:nowrap}
.frp-tab:hover{color:var(--fg)}
.frp-tab.on{color:var(--fg);font-weight:600;border-bottom-color:var(--pri)}
.frp-body{padding:16px 18px 22px;overflow:auto;flex:1;min-height:0}
.frp-sec{display:none}
.frp-sec.on{display:block}
.frp-card{border:1px solid var(--line);border-radius:10px;background:var(--card);padding:12px 14px;margin-bottom:12px}
.frp-card h3{margin:0 0 8px;font-size:13px;color:var(--muted);font-weight:600}
.frp-hint{font-size:12px;color:var(--muted);line-height:1.7;margin:4px 0}
.frp-hint code{background:var(--card);border:1px solid var(--line);border-radius:4px;padding:0 4px;font-size:11px}
.frp-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.frp-grow{flex:1;min-width:120px}
.frp-btn{appearance:none;border:1px solid var(--line);background:var(--bg);color:var(--fg);font-size:13px;padding:7px 14px;border-radius:8px;cursor:pointer;white-space:nowrap}
.frp-btn:hover{border-color:var(--muted)}
.frp-btn:disabled{opacity:.45;cursor:not-allowed}
.frp-btn.pri{background:var(--pri);border-color:var(--pri);color:#fff;font-weight:600}
.frp-btn.pri:hover:not(:disabled){background:var(--pri-h)}
.frp-btn.acc{background:var(--acc);border-color:var(--acc);color:#fff}
.frp-btn.danger{color:var(--err);border-color:color-mix(in srgb,var(--err) 40%, transparent)}
.frp-btn.sm{padding:3px 8px;font-size:12px;border-radius:6px}
.frp-input,textarea.frp-input,select.frp-input{border:1px solid var(--line);border-radius:8px;background:var(--inp);color:var(--fg);font-size:13px;padding:7px 10px;outline:none;font-family:inherit}
.frp-input:focus{border-color:var(--acc)}
.frp-input.bad{border-color:var(--err)}
textarea.frp-input{width:100%;min-height:110px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.5}
.frp-msg{font-size:13px;border-radius:8px;padding:8px 12px;margin:8px 0;line-height:1.6}
.frp-msg.ok{background:color-mix(in srgb,var(--ok) 12%, transparent);color:var(--ok)}
.frp-msg.err{background:color-mix(in srgb,var(--err) 10%, transparent);color:var(--err)}
.frp-msg.warn{background:color-mix(in srgb,var(--warn) 12%, transparent);color:var(--warn)}
.frp-tblwrap{border:1px solid var(--line);border-radius:10px;overflow:auto;max-height:46vh}
table.frp{border-collapse:collapse;width:100%;font-size:13px}
table.frp th{position:sticky;top:0;background:var(--card);color:var(--muted);font-weight:600;text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);white-space:nowrap;z-index:1}
table.frp td{padding:6px 10px;border-bottom:1px solid var(--line);vertical-align:middle}
table.frp tr:last-child td{border-bottom:none}
table.frp td.num{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px}
.frp-ava{width:28px;height:28px;border-radius:50%;color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;flex:none}
.frp-ava-img{width:28px;height:28px;border-radius:50%;flex:none;object-fit:cover;background:var(--card)}
.frp-tl{display:inline-flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;line-height:1;padding:2px 5px;border-radius:5px;flex:none;font-family:ui-monospace,Menlo,Consolas,monospace}
.frp-tl.tl0{background:color-mix(in srgb,var(--muted) 16%,transparent);color:var(--muted)}
.frp-tl.tl1{background:color-mix(in srgb,#3b82f6 16%,transparent);color:var(--acc)}
.frp-tl.tl2{background:color-mix(in srgb,#16a34a 16%,transparent);color:var(--ok)}
.frp-tl.tl3{background:color-mix(in srgb,#f59e0b 20%,transparent);color:var(--warn)}
.frp-tl.tl4{background:color-mix(in srgb,#e11d48 15%,transparent);color:var(--pri)}
.frp-un{display:flex;align-items:center;gap:8px;min-width:140px}
.frp-un .nm{max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.frp-un .nm small{color:var(--muted);font-weight:400}
.frp-badge{display:inline-block;font-size:11px;padding:2px 8px;border-radius:999px;white-space:nowrap}
.frp-badge.b-pending{background:color-mix(in srgb,var(--muted) 15%, transparent);color:var(--muted)}
.frp-badge.b-sending{background:color-mix(in srgb,var(--acc) 15%, transparent);color:var(--acc)}
.frp-badge.b-success{background:color-mix(in srgb,var(--ok) 15%, transparent);color:var(--ok)}
.frp-badge.b-failed{background:color-mix(in srgb,var(--err) 12%, transparent);color:var(--err)}
.frp-badge.b-unknown{background:color-mix(in srgb,var(--warn) 15%, transparent);color:var(--warn)}
.frp-progress{height:8px;border-radius:999px;background:var(--card);border:1px solid var(--line);overflow:hidden;margin:6px 0 10px}
.frp-progress>div{height:100%;background:var(--pri);transition:width .25s}
.frp-stats{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--muted);margin-bottom:8px}
.frp-stats b{color:var(--fg);font-size:14px}
.frp-oplog{max-height:220px;overflow:auto;border:1px solid var(--line);border-radius:10px;font-size:12px}
.frp-oplog div{padding:6px 10px;border-bottom:1px solid var(--line);display:flex;gap:8px}
.frp-oplog div:last-child{border-bottom:none}
.frp-oplog time{color:var(--muted);flex:none;font-family:ui-monospace,Menlo,monospace}
.frp-x{color:var(--muted);cursor:pointer;border:none;background:none;font-size:14px;padding:2px 6px;border-radius:6px}
.frp-x:hover{color:var(--err);background:var(--card)}
.frp-modal-bg{position:fixed;inset:0;background:rgba(15,23,42,.6);display:flex;align-items:center;justify-content:center;padding:16px;z-index:1}
.frp-modal{background:var(--bg);color:var(--fg);border-radius:12px;max-width:520px;width:100%;padding:18px 20px;box-shadow:0 20px 60px rgba(0,0,0,.4);max-height:85vh;overflow:auto}
.frp-modal h3{margin:0 0 10px;font-size:16px}
.frp-modal .acts{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
.frp-kv{display:flex;justify-content:space-between;gap:12px;padding:5px 0;font-size:13px;border-bottom:1px dashed var(--line)}
.frp-kv:last-of-type{border-bottom:none}
.frp-kv b{text-align:right}
.frp-toast{position:fixed;left:50%;bottom:34px;transform:translateX(-50%);background:#1e293b;color:#f8fafc;font-size:13px;padding:9px 16px;border-radius:9px;box-shadow:0 8px 24px rgba(0,0,0,.4);z-index:2;max-width:80vw}
.frp-toast.err{background:var(--err)}
.frp-toast.warn{background:#b45309}
.frp-toast.ok{background:var(--ok)}
label.frp-chk{display:inline-flex;align-items:center;gap:6px;font-size:13px;cursor:pointer}
.frp-details{border:1px solid var(--line);border-radius:10px;margin-bottom:10px;background:var(--card)}
.frp-details summary{cursor:pointer;padding:10px 14px;font-size:13px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;list-style:none}
.frp-details summary::-webkit-details-marker{display:none}
.frp-details summary .tid{font-family:ui-monospace,Menlo,monospace;color:var(--muted);font-size:12px}
.frp-details .inner{padding:0 14px 14px;border-top:1px solid var(--line)}
.frp-mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px}
.err-cell{max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--err);font-size:12px}
`

  // ============================== UI：结构与渲染 ==============================

  let host = null
  let shadow = null
  const refs = {}
  let toastTimer = 0

  const SHELL = `
<div class="frp-overlay" data-act="close-bg">
  <div class="frp-panel" role="dialog" aria-label="LDC 批量分发">
    <div class="frp-head">
      <h1>🧧 LDC 批量分发</h1>
      <span class="frp-pill" id="frp-keypill">…</span>
      <div class="frp-sp"></div>
      <button class="frp-btn sm" id="frp-opencred">密钥设置</button>
      <button class="frp-btn sm" id="frp-close">关闭</button>
    </div>
    <div class="frp-tabs">
      <button class="frp-tab" data-tab="roster">① 名单与额度</button>
      <button class="frp-tab" data-tab="run">② 发放</button>
      <button class="frp-tab" data-tab="audit">③ 审计</button>
      <button class="frp-tab" data-tab="cred">密钥设置</button>
    </div>
    <div class="frp-body">

      <section class="frp-sec" id="frp-sec-roster">
        <div class="frp-card">
          <h3>导入名单（只要求 id 与 username：粘贴 JSON 数组 / 整份 /u/用户名.json / 单个用户对象，或按用户名查询、一键拉取我的粉丝）</h3>
          <textarea class="frp-input" id="frp-paste" placeholder='支持任意来源，例如：[{"id":76303,"username":"vhxubo"}, …] 或整份 https://linux.do/u/用户名.json 响应'></textarea>
          <div class="frp-row" style="margin-top:8px">
            <button class="frp-btn pri" id="frp-import">解析并导入</button>
            <button class="frp-btn" id="frp-sample">填入示例</button>
            <button class="frp-btn acc" id="frp-fetchfollowers">拉取我的粉丝（Alt+F）</button>
            <button class="frp-btn danger" id="frp-clearroster">清空名单</button>
            <span class="frp-hint" id="frp-importmsg"></span>
          </div>
          <div class="frp-row" style="margin-top:8px">
            <input class="frp-input frp-grow" id="frp-lookup" placeholder="按用户名查询并添加：如 vhxubo，支持多个（空格 / 逗号分隔，自动去掉 @）" autocomplete="off" spellcheck="false">
            <button class="frp-btn acc" id="frp-lookupbtn">查询并添加</button>
          </div>
          <div class="frp-hint" style="margin-top:6px">「查询并添加」通过 linux.do 同源接口 /u/用户名.json 自动补齐 id 后追加进名单（按 id 去重，不影响已有额度）；「解析并导入」会整体替换名单。</div>
        </div>
        <div class="frp-card">
          <div class="frp-row">
            <span class="frp-hint">统一额度</span>
            <input class="frp-input" id="frp-uniform" style="width:110px" placeholder="如 0.66" inputmode="decimal">
            <button class="frp-btn acc" id="frp-applyall">应用到已勾选</button>
            <div class="frp-grow"></div>
            <input class="frp-input" id="frp-search" style="width:180px" placeholder="搜索用户名 / 昵称 / ID">
            <span class="frp-pill" id="frp-rostersum"></span>
          </div>
          <div class="frp-hint">头像与信任级别（TL）直接取自名单数据（avatar_template / trust_level 字段）；头像加载失败时自动回退为本地生成的色块。在右侧输入框可为单个用户设置不同额度，留空或 0 视为未设置（发放前会拦截）。</div>
          <div class="frp-tblwrap" id="frp-rosterwrap"></div>
        </div>
      </section>

      <section class="frp-sec" id="frp-sec-run"></section>

      <section class="frp-sec" id="frp-sec-audit"></section>

      <section class="frp-sec" id="frp-sec-cred"></section>

    </div>
  </div>
</div>`

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag)
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') el.className = v
        else if (k === 'text') el.textContent = v
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
        else if (v !== null && v !== undefined) el.setAttribute(k, v)
      }
    }
    for (const c of children.flat()) {
      if (c == null) continue
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c)
    }
    return el
  }

  function toast(text, kind) {
    const root = shadow || launcherShadow // 面板关闭时提示落到悬浮按钮的 shadow 上
    if (!root) return
    const old = root.querySelector('.frp-toast')
    if (old) old.remove()
    const t = h('div', { class: 'frp-toast ' + (kind || ''), text })
    root.appendChild(t)
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => t.remove(), kind === 'error' || kind === 'warn' ? 5200 : 2600)
  }

  /** 本地生成的首字母色块：无头像数据或图片加载失败时的回退 */
  function placeholderAvatar(username) {
    const hue = hashHue(username)
    const ch = [...String(username)][0] || '?'
    return h('span', {
      class: 'frp-ava',
      text: /[a-z0-9]/i.test(ch) ? ch.toUpperCase() : ch,
      style: `background:hsl(${hue},62%,46%)`,
      title: username,
    })
  }

  /** avatar_template → 真实 URL：替换 {size} 占位符，相对路径补 linux.do 域 */
  function avatarUrl(tpl) {
    const path = String(tpl || '').trim()
    if (!path) return ''
    try {
      return new URL(path.replaceAll('{size}', '45'), location.origin).href
    } catch {
      return ''
    }
  }

  /**
   * 头像：优先用名单数据自带的 avatar_template（linux.do / ldstatic CDN，仅 <img> 展示，
   * 不发任何其他请求）；无数据或加载失败时回退为本地生成的首字母色块。
   */
  function avatarEl(u) {
    const username = typeof u === 'string' ? u : (u && u.username) || '?'
    const url = typeof u === 'object' && u ? avatarUrl(u.avatar) : ''
    if (url) {
      const img = h('img', {
        class: 'frp-ava-img',
        src: url,
        alt: '',
        loading: 'lazy',
        referrerpolicy: 'no-referrer',
        title: username,
      })
      img.addEventListener('error', () => img.replaceWith(placeholderAvatar(username)))
      return img
    }
    return placeholderAvatar(username)
  }

  /** 信任级别徽章：TL0-TL4；未知（null/undefined）不展示 */
  function trustBadge(tl) {
    if (typeof tl !== 'number' || tl < 0) return null
    const v = Math.min(tl, 4)
    return h('span', { class: 'frp-tl tl' + v, text: 'TL' + v, title: '信任级别 ' + v })
  }

  function badge(status) {
    return h('span', { class: 'frp-badge b-' + status, text: STATUS_TEXT[status] || status })
  }

  function keyPill() {
    const el = refs.keypill
    if (state.cred) {
      el.textContent = '密钥已就绪 · ' + maskPid(state.cred.clientId)
      el.className = 'frp-pill ok'
    } else if (state.credEnc) {
      el.textContent = '密钥已加密锁定，需解锁'
      el.className = 'frp-pill warn'
    } else {
      el.textContent = '未配置密钥'
      el.className = 'frp-pill'
    }
  }

  function switchTab(tab) {
    state.ui.tab = tab
    renderAll()
  }

  function renderAll() {
    if (!shadow) return
    keyPill()
    for (const btn of shadow.querySelectorAll('.frp-tab')) {
      btn.classList.toggle('on', btn.dataset.tab === state.ui.tab)
    }
    for (const sec of shadow.querySelectorAll('.frp-sec')) {
      sec.classList.toggle('on', sec.id === 'frp-sec-' + state.ui.tab)
    }
    if (state.ui.tab === 'roster') renderRosterTab()
    if (state.ui.tab === 'run') renderRunTab()
    if (state.ui.tab === 'audit') renderAuditTab()
    if (state.ui.tab === 'cred') renderCredTab()
  }

  // ---------- 名单与额度 ----------

  function rosterSummary() {
    const us = state.roster.users
    const incl = us.filter((u) => u.included)
    const total = incl.reduce((s, u) => s + u.amountCents, 0)
    const zero = incl.filter((u) => u.amountCents < MIN_CENTS).length
    return { us, incl, total, zero }
  }

  function renderRosterTab() {
    const { us, incl, total, zero } = rosterSummary()
    refs.rostersum.textContent = us.length
      ? `已选 ${incl.length}/${us.length} 人 · 合计 ${fmtCents(total)} LDC${zero ? ` · ${zero} 人未设额度` : ''}`
      : '名单为空'
    refs.rostersum.className = 'frp-pill' + (zero && us.length ? ' warn' : '')

    const kw = state.ui.search.trim().toLowerCase()
    const list = kw
      ? us.filter((u) => u.username.toLowerCase().includes(kw) || String(u.name).toLowerCase().includes(kw) || String(u.id).includes(kw))
      : us

    const tb = h('tbody')
    for (const u of list) {
      const amountInput = h('input', {
        class: 'frp-input',
        style: 'width:96px;text-align:right',
        value: u.amountCents ? fmtCents(u.amountCents) : '',
        placeholder: '0.00',
        inputmode: 'decimal',
        'data-id': String(u.id),
      })
      amountInput.addEventListener('change', () => {
        if (amountInput.value.trim() === '') {
          u.amountCents = 0
          amountInput.classList.remove('bad')
        } else {
          const c = parseCents(amountInput.value)
          if (c === null || c > MAX_CENTS) {
            amountInput.classList.add('bad')
            toast('金额无效：最多两位小数', 'warn')
            return
          }
          amountInput.classList.remove('bad')
          u.amountCents = c
        }
        persistRoster()
        renderRosterTab()
      })
      const cb = h('input', { type: 'checkbox' })
      cb.checked = u.included
      cb.addEventListener('change', () => {
        u.included = cb.checked
        persistRoster()
        renderRosterTab()
      })
      tb.appendChild(
        h(
          'tr',
          { style: u.included ? '' : 'opacity:.45' },
          h('td', null, cb),
          h('td', null, h('span', { class: 'frp-un' }, avatarEl(u), h('span', { class: 'nm' }, u.username, u.name && u.name !== u.username ? h('small', null, ' · ' + u.name) : null), trustBadge(u.trustLevel))),
          h('td', { class: 'num', text: String(u.id) }),
          h('td', null, amountInput),
          h('td', null, h('button', { class: 'frp-x', title: '移除', text: '✕', onclick: () => removeRosterUser(u.id) })),
        ),
      )
    }
    refs.rosterwrap.replaceChildren(
      h(
        'table',
        { class: 'frp' },
        h('thead', null, h('tr', null, h('th', { text: '发放', style: 'width:44px' }), h('th', { text: '用户' }), h('th', { text: 'ID', style: 'width:110px' }), h('th', { text: '额度 (LDC)', style: 'width:120px' }), h('th', { text: '', style: 'width:40px' }))),
        tb,
      ),
    )
  }

  function removeRosterUser(id) {
    state.roster.users = state.roster.users.filter((u) => u.id !== id)
    persistRoster()
    renderRosterTab()
  }

  /** 信任级别归一：0-4 整数有效，其余（缺失/异常）返回 null 表示未知 */
  function normTrustLevel(v) {
    const tl = Number(v)
    return Number.isInteger(tl) && tl >= 0 && tl <= 4 ? tl : null
  }

  /** 解析用户数组为名单行：仅提取 id/username/name，按 id 去重，超过 MAX_ROWS 截断 */
  function parseUserArray(data) {
    if (!Array.isArray(data)) return { error: '顶层必须是 JSON 数组' }
    const users = []
    const seen = new Set()
    let skipped = 0
    let dup = 0
    let truncated = false
    for (const it of data) {
      const id = Number(it && it.id)
      const username = String((it && it.username) ?? '').trim()
      if (!Number.isInteger(id) || id <= 0 || !username) {
        skipped++
        continue
      }
      if (seen.has(id)) {
        dup++
        continue
      }
      seen.add(id)
      users.push({
        id,
        username,
        name: String((it && it.name) ?? '').trim(),
        avatar: String((it && it.avatar_template) ?? '').trim(), // {size} 占位符，展示时替换
        trustLevel: normTrustLevel(it && it.trust_level),
        included: true,
        amountCents: 0,
      })
      if (users.length >= MAX_ROWS) {
        truncated = true
        break
      }
    }
    if (!users.length) return { error: '没有解析到有效用户（每项需要数字 id 与 username）' }
    return { users, skipped, dup, truncated }
  }

  function applyRoster(res, sourceLabel) {
    state.roster = { importedAt: Date.now(), users: res.users }
    persistRoster()
    const parts = [`${sourceLabel} ${res.users.length} 人`]
    if (res.skipped) parts.push(`跳过无效 ${res.skipped}`)
    if (res.dup) parts.push(`按 id 去重 ${res.dup}`)
    if (res.truncated) parts.push(`超出上限截断至 ${MAX_ROWS}`)
    logOp('roster.import', parts.join('，'))
  }

  /**
   * 把任意粘贴载荷归一成用户数组：
   *  - JSON 数组直接用；{users:[…]} / {user_list:[…]|{users:[…]}} 等 Discourse 包装形态自动拆包；
   *  - {user:{…}}（整份 /u/用户名.json 响应）只取 user 主体（忽略顶层 users 里的 system 等）；
   *  - 单个 {id, username} 对象视为一人。
   */
  function normalizeUserPayload(data) {
    if (Array.isArray(data)) return data
    if (!data || typeof data !== 'object') return null
    if (data.user && typeof data.user === 'object') return [data.user]
    if (Number(data.id) > 0 && String(data.username ?? '').trim()) return [data]
    return extractUserList(data)
  }

  function doImport() {
    const text = refs.paste.value.trim()
    if (!text) {
      refs.importmsg.textContent = '请先粘贴 JSON'
      return
    }
    let data
    try {
      data = JSON.parse(text)
    } catch (e) {
      refs.importmsg.textContent = 'JSON 解析失败：' + e.message
      return
    }
    const list = normalizeUserPayload(data)
    if (!list) {
      refs.importmsg.textContent = '无法识别的结构：需要用户数组、{users:[…]}、单个用户对象或整份 /u/用户名.json 响应'
      return
    }
    const res = parseUserArray(list)
    if (res.error) {
      refs.importmsg.textContent = res.error
      return
    }
    applyRoster(res, '导入名单')
    refs.importmsg.textContent = `已导入 ${res.users.length} 人${res.skipped ? `（跳过无效 ${res.skipped}）` : ''}${res.dup ? `（按 id 去重 ${res.dup}）` : ''}${res.truncated ? `（超出上限截断至 ${MAX_ROWS}）` : ''}`
    refs.paste.value = ''
    renderRosterTab()
  }

  function applyUniform() {
    const cents = parseCents(refs.uniform.value)
    if (cents === null || cents < MIN_CENTS || cents > MAX_CENTS) {
      toast('请输入有效的统一额度（0.01 ~ 1000000，最多两位小数）', 'warn')
      return
    }
    let n = 0
    for (const u of state.roster.users) {
      if (u.included) {
        u.amountCents = cents
        n++
      }
    }
    persistRoster()
    logOp('roster.uniform', `统一额度 ${fmtCents(cents)} LDC 应用到 ${n} 人`)
    renderRosterTab()
    toast(`已将 ${fmtCents(cents)} LDC 应用到 ${n} 人`, 'ok')
  }

  // ---------- 发放 ----------

  function renderRunTab() {
    const sec = refs.secRun
    sec.replaceChildren()

    const batch = getBatch(state.ui.currentBatchId) || state.batches[0] || null
    const { incl, total, zero } = rosterSummary()

    // -- 准备卡片 --
    const checks = []
    if (!state.cred) checks.push(['err', state.credEnc ? '密钥已加密锁定，请到「密钥设置」解锁' : '尚未配置打款密钥，请到「密钥设置」配置并校验'])
    else checks.push(['ok', `打款密钥已就绪（商户 ${maskPid(state.cred.clientId)}）`])
    if (!incl.length) checks.push(['err', '名单为空或没有勾选发放对象'])
    else if (zero) checks.push(['err', `${zero} 个已勾选用户额度为 0，请设置额度（统一或单独）`])
    else checks.push(['ok', `将发放 ${incl.length} 人，合计 ${fmtCents(total)} LDC`])
    if (hasUnknownRows()) checks.push(['err', `存在 ${unknownCount()} 笔「待对账」记录，请先到「审计」完成查单对账，避免重复发放`])

    const canStart = !checks.some((c) => c[0] === 'err') && !run.active
    const remarkInput = h('input', { class: 'frp-input', value: state.settings.remark, style: 'width:220px', maxlength: String(REMARK_MAX), placeholder: '随转账展示给对方' })
    remarkInput.addEventListener('change', () => {
      state.settings.remark = remarkInput.value.slice(0, REMARK_MAX)
      persistSettings()
    })
    const concSel = h('select', { class: 'frp-input' })
    for (const n of [1, 2, 3]) {
      const o = h('option', { value: String(n), text: `并发 ${n}` })
      if (n === (parseInt(state.settings.concurrency, 10) || 2)) o.selected = true
      concSel.appendChild(o)
    }
    concSel.addEventListener('change', () => {
      state.settings.concurrency = parseInt(concSel.value, 10)
      persistSettings()
    })

    const startBtn = h('button', { class: 'frp-btn pri', text: '开始发放（实打款）' })
    startBtn.disabled = !canStart
    startBtn.addEventListener('click', () => confirmStart('live'))
    const dryBtn = h('button', { class: 'frp-btn acc', text: '演练模式（不扣款）' })
    dryBtn.disabled = !incl.length || zero > 0 || hasUnknownRows() || run.active
    dryBtn.addEventListener('click', () => confirmStart('dry'))

    sec.appendChild(
      h(
        'div',
        { class: 'frp-card' },
        h('h3', { text: '发放准备' }),
        ...checks.map(([k, text]) => h('div', { class: 'frp-msg ' + k, text: (k === 'ok' ? '✓ ' : '✕ ') + text })),
        h(
          'div',
          { class: 'frp-row', style: 'margin-top:10px' },
          h('span', { class: 'frp-hint', text: '转账备注' }),
          remarkInput,
          concSel,
          h('div', { class: 'frp-grow' }),
          dryBtn,
          startBtn,
        ),
        h('div', { class: 'frp-hint', text: '打款即时到账、不可撤销。每笔使用独立幂等单号：失败重试复用原单号；网络异常不会自动重发，必须查单对账后定性。' }),
      ),
    )

    // -- 批次进行/最近批次卡片 --
    if (batch) sec.appendChild(renderBatchCard(batch, true))
  }

  function confirmStart(mode) {
    const { incl, total } = rosterSummary()
    const modal = h('div', { class: 'frp-modal-bg' })
    const chk = h('input', { type: 'checkbox' })
    const confirmBtn = h('button', {
      class: 'frp-btn ' + (mode === 'dry' ? 'acc' : 'pri'),
      text: mode === 'dry' ? '开始演练' : '确认发放',
    })
    confirmBtn.disabled = true
    chk.addEventListener('change', () => (confirmBtn.disabled = !chk.checked))
    confirmBtn.addEventListener('click', () => {
      modal.remove()
      const batch = createBatch(mode)
      logOp(mode === 'dry' ? 'batch.dry.start' : 'batch.live.start', `${mode === 'dry' ? '演练' : '实发'}批次 ${batch.id} 开始：${batch.rows.length} 人 / ${fmtCents(batch.rows.reduce((s, r) => s + r.amountCents, 0))} LDC`)
      switchTab('run')
      runBatch(batch.id)
    })
    modal.appendChild(
      h(
        'div',
        { class: 'frp-modal' },
        h('h3', { text: mode === 'dry' ? '演练模式确认' : '确认发放红包' }),
        h('div', { class: 'frp-kv' }, h('span', { text: '发放人数' }), h('b', { text: `${incl.length} 人` })),
        h('div', { class: 'frp-kv' }, h('span', { text: '合计金额' }), h('b', { text: `${fmtCents(total)} LDC` })),
        h('div', { class: 'frp-kv' }, h('span', { text: '转账备注' }), h('b', { text: state.settings.remark || '（空）' })),
        h('div', { class: 'frp-kv' }, h('span', { text: '打款账户' }), h('b', { text: mode === 'dry' ? '演练（不扣款）' : '商户 ' + maskPid(state.cred ? state.cred.clientId : '') })),
        h(
          'div',
          { class: 'frp-msg warn', text: mode === 'dry' ? '演练模式不会产生任何网络请求与扣款，仅模拟流程与界面。' : '资金将从你的商户账户即时转出且不可撤销。请核对人数与总额；发放后如需补发请使用失败重试（单号复用）。' },
        ),
        h('label', { class: 'frp-chk' }, chk, h('span', { text: '我已核对名单、额度与总额' })),
        h('div', { class: 'acts' }, h('button', { class: 'frp-btn', text: '取消', onclick: () => modal.remove() }), confirmBtn),
      ),
    )
    shadow.appendChild(modal)
    // 阻止点击遮罩误关确认框
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        /* 故意不关闭：防误触 */
      }
    })
  }

  function statLine(batch) {
    const c = { pending: 0, sending: 0, success: 0, failed: 0, unknown: 0 }
    for (const r of batch.rows) c[r.status] = (c[r.status] || 0) + 1
    const totalCents = batch.rows.reduce((s, r) => s + (r.status === 'success' ? r.amountCents : 0), 0)
    return { c, totalCents }
  }

  function renderBatchCard(batch, withActions) {
    const { c, totalCents } = statLine(batch)
    const done = c.success + c.failed + c.unknown
    const pct = batch.rows.length ? Math.round((done / batch.rows.length) * 100) : 0

    const card = h('div', { class: 'frp-card' })
    card.appendChild(
      h(
        'div',
        { class: 'frp-row' },
        h('h3', { text: `批次 ${batch.id}（${batch.mode === 'dry' ? '演练' : '实发'} · ${STATUS_BATCH[batch.status] || batch.status}）` }),
        h('div', { class: 'frp-grow' }),
        h('span', { class: 'frp-hint', text: `备注：${batch.remark || '（空）'} · 商户 ${typeof batch.pid === 'string' ? maskPid(batch.pid) : '—'}` }),
      ),
    )
    card.appendChild(
      h(
        'div',
        { class: 'frp-stats' },
        h('span', null, '成功 ', h('b', { text: String(c.success) })),
        h('span', null, '失败 ', h('b', { text: String(c.failed) })),
        h('span', null, '待对账 ', h('b', { text: String(c.unknown) })),
        h('span', null, '待发放 ', h('b', { text: String(c.pending) })),
        h('span', null, '已发出 ', h('b', { text: fmtCents(totalCents) + ' LDC' })),
        h('span', null, `进度 ${done}/${batch.rows.length}`),
      ),
    )
    card.appendChild(h('div', { class: 'frp-progress' }, h('div', { style: `width:${pct}%` })))

    if (withActions) {
      const acts = h('div', { class: 'frp-row', style: 'margin-bottom:10px' })
      if (batch.status === 'running') {
        const pauseBtn = h('button', { class: 'frp-btn sm', text: '暂停' })
        pauseBtn.addEventListener('click', () => {
          run.pause = true
          toast('将在当前请求完成后暂停')
        })
        const stopBtn = h('button', { class: 'frp-btn sm danger', text: '停止' })
        stopBtn.addEventListener('click', () => {
          run.stop = true
          toast('将在当前请求完成后停止')
        })
        acts.appendChild(pauseBtn)
        acts.appendChild(stopBtn)
      } else {
        if (resumableRows(batch).length) {
          const resumeBtn = h('button', { class: 'frp-btn sm acc', text: `继续发放（${resumableRows(batch).length} 笔，复用原单号）` })
          resumeBtn.addEventListener('click', () => runBatch(batch.id))
          acts.appendChild(resumeBtn)
        }
        if (c.failed) {
          const retryBtn = h('button', { class: 'frp-btn sm', text: `重试失败（${c.failed}）` })
          retryBtn.addEventListener('click', () => retryRows(batch))
          acts.appendChild(retryBtn)
        }
        if (c.unknown) {
          const recBtn = h('button', { class: 'frp-btn sm', text: `查单对账（${c.unknown}）` })
          recBtn.addEventListener('click', () => reconcileBatch(batch))
          acts.appendChild(recBtn)
        }
      }
      if (acts.childNodes.length) {
        const csvBtn = h('button', { class: 'frp-btn sm', text: '导出回执 CSV' })
        csvBtn.addEventListener('click', () => exportBatchCsv(batch))
        const jsonBtn = h('button', { class: 'frp-btn sm', text: '导出 JSON' })
        jsonBtn.addEventListener('click', () => exportBatchJson(batch))
        acts.appendChild(csvBtn)
        acts.appendChild(jsonBtn)
        card.appendChild(acts)
      }
    }

    // 明细表（发放页只展示当前批次）
    const tb = h('tbody')
    for (const r of batch.rows) {
      const tr = h(
        'tr',
        null,
        h('td', null, h('span', { class: 'frp-un' }, avatarEl(r), h('span', { class: 'nm' }, r.username, r.name && r.name !== r.username ? h('small', null, ' · ' + r.name) : null), trustBadge(r.trustLevel))),
        h('td', { class: 'num', text: String(r.id) }),
        h('td', { class: 'num', text: fmtCents(r.amountCents) }),
        h('td', null, badge(r.status)),
        h('td', { class: 'num', title: r.outTradeNo, text: r.outTradeNo }),
        h('td', { class: 'num', title: r.tradeNo, text: r.tradeNo || '—' }),
        h('td', { class: 'err-cell', title: r.error, text: r.error || '' }),
      )
      const actTd = h('td', { style: 'white-space:nowrap' })
      if (r.status === 'failed') {
        const b = h('button', { class: 'frp-btn sm', text: '重试' })
        b.addEventListener('click', () => retryRows(batch, [r]))
        actTd.appendChild(b)
      }
      if (r.status === 'unknown') {
        const b = h('button', { class: 'frp-btn sm', text: '查单' })
        b.addEventListener('click', async () => {
          b.disabled = true
          await reconcileRow(batch, r)
        })
        actTd.appendChild(b)
      }
      tr.appendChild(actTd)
      tb.appendChild(tr)
    }
    card.appendChild(
      h(
        'div',
        { class: 'frp-tblwrap' },
        h(
          'table',
          { class: 'frp' },
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              h('th', { text: '用户' }),
              h('th', { text: 'ID', style: 'width:90px' }),
              h('th', { text: '额度', style: 'width:80px' }),
              h('th', { text: '状态', style: 'width:80px' }),
              h('th', { text: '商户单号', style: 'width:150px' }),
              h('th', { text: 'LDC 交易号', style: 'width:150px' }),
              h('th', { text: '错误/备注' }),
              h('th', { text: '', style: 'width:70px' }),
            ),
          ),
          tb,
        ),
      ),
    )
    return card
  }

  const STATUS_BATCH = { running: '进行中', paused: '已暂停', stopped: '已停止', done: '已完成' }

  // ---------- 审计 ----------

  function renderAuditTab() {
    const sec = refs.secAudit
    sec.replaceChildren()

    const exportAllBtn = h('button', { class: 'frp-btn sm', text: '导出全部审计 JSON' })
    exportAllBtn.addEventListener('click', exportAllAudit)
    const clearBtn = h('button', { class: 'frp-btn sm danger', text: '清空审计数据' })
    clearBtn.addEventListener('click', confirmClearAudit)
    sec.appendChild(
      h('div', { class: 'frp-row', style: 'margin-bottom:12px' }, h('h3', { text: '审计', style: 'margin:0;font-size:15px' }), h('div', { class: 'frp-grow' }), exportAllBtn, clearBtn),
    )

    // 批次列表（新→旧）
    if (!state.batches.length) {
      sec.appendChild(h('div', { class: 'frp-hint', text: '暂无批次。每次发放都会在这里留下完整记录：名单快照、单号、交易号、结果与事件流水。' }))
    }
    for (const batch of state.batches.slice(0, 10)) {
      sec.appendChild(renderAuditBatch(batch))
    }
    if (state.batches.length > 10) {
      sec.appendChild(h('div', { class: 'frp-hint', text: `仅展示最近 10 个批次（共 ${state.batches.length}），更多请导出全部审计。` }))
    }

    // 操作日志
    sec.appendChild(h('h3', { text: '操作日志', style: 'margin:16px 0 8px;font-size:14px' }))
    const logBox = refs.oplogList
    logBox.replaceChildren()
    if (!state.oplog.length) logBox.appendChild(h('div', null, h('time', { text: '—' }), h('span', { text: '暂无记录' })))
    for (const e of state.oplog.slice(0, 200)) {
      logBox.appendChild(h('div', null, h('time', { text: fmtTime(e.t) }), h('span', { text: `[${e.type}] ${e.text}` })))
    }
    sec.appendChild(logBox)
  }

  function renderAuditBatch(batch) {
    const { c, totalCents } = statLine(batch)
    const det = h('details', { class: 'frp-details' })
    const sum = h(
      'summary',
      null,
      h('span', null, h('b', { text: `${fmtCents(totalCents)} LDC` }), h('span', { text: ` · ${batch.rows.length} 人 · ${STATUS_BATCH[batch.status] || batch.status}` })),
      h('span', { class: 'tid', text: batch.id }),
      h('span', { class: 'tid', text: fmtTime(batch.createdAt) }),
      h('span', { class: 'frp-badge ' + (batch.mode === 'dry' ? 'b-pending' : 'b-sending'), text: batch.mode === 'dry' ? '演练' : '实发' }),
      c.unknown ? h('span', { class: 'frp-badge b-unknown', text: `待对账 ${c.unknown}` }) : null,
      c.failed ? h('span', { class: 'frp-badge b-failed', text: `失败 ${c.failed}` }) : null,
    )
    const inner = h('div', { class: 'inner' })

    const acts = h('div', { class: 'frp-row', style: 'margin:10px 0' })
    if (resumableRows(batch).length) {
      const b = h('button', { class: 'frp-btn sm acc', text: `继续发放（${resumableRows(batch).length}）` })
      b.addEventListener('click', () => runBatch(batch.id))
      acts.appendChild(b)
    }
    if (c.failed) {
      const b = h('button', { class: 'frp-btn sm', text: `重试失败（${c.failed}）` })
      b.addEventListener('click', () => retryRows(batch))
      acts.appendChild(b)
    }
    if (c.unknown) {
      const b = h('button', { class: 'frp-btn sm', text: `查单对账（${c.unknown}）` })
      b.addEventListener('click', () => reconcileBatch(batch))
      acts.appendChild(b)
    }
    const csv = h('button', { class: 'frp-btn sm', text: '导出 CSV' })
    csv.addEventListener('click', () => exportBatchCsv(batch))
    const js = h('button', { class: 'frp-btn sm', text: '导出 JSON' })
    js.addEventListener('click', () => exportBatchJson(batch))
    acts.appendChild(csv)
    acts.appendChild(js)
    const del = h('button', { class: 'frp-btn sm danger', text: '删除该批次记录' })
    del.addEventListener('click', () => {
      uiConfirm('删除批次记录', `仅删除本机审计记录 ${batch.id}，不影响已发生的资金流转。确定删除？`, () => {
        state.batches = state.batches.filter((b) => b.id !== batch.id)
        persistBatches()
        logOp('batch.delete', `删除批次审计记录 ${batch.id}`)
        renderAll()
      })
    })
    acts.appendChild(del)
    inner.appendChild(acts)

    // 事件流水
    for (const e of batch.events) {
      inner.appendChild(h('div', { class: 'frp-hint' }, h('span', { class: 'frp-mono', text: fmtTime(e.t) + ' ' }), h('span', { text: `[${e.type}] ${e.text}` })))
    }

    // 明细
    const tb = h('tbody')
    for (const r of batch.rows) {
      tb.appendChild(
        h(
          'tr',
          null,
          h('td', null, h('span', { class: 'frp-un' }, avatarEl(r), h('span', { class: 'nm' }, r.username), trustBadge(r.trustLevel))),
          h('td', { class: 'num', text: String(r.id) }),
          h('td', { class: 'num', text: fmtCents(r.amountCents) }),
          h('td', null, badge(r.status)),
          h('td', { class: 'num', text: r.outTradeNo }),
          h('td', { class: 'num', text: r.tradeNo || '—' }),
          h('td', { class: 'err-cell', title: r.error, text: r.error || '' }),
        ),
      )
    }
    inner.appendChild(
      h(
        'div',
        { class: 'frp-tblwrap', style: 'max-height:40vh;margin-top:10px' },
        h(
          'table',
          { class: 'frp' },
          h('thead', null, h('tr', null, h('th', { text: '用户' }), h('th', { text: 'ID' }), h('th', { text: '额度' }), h('th', { text: '状态' }), h('th', { text: '商户单号' }), h('th', { text: 'LDC 交易号' }), h('th', { text: '错误/备注' }))),
          tb,
        ),
      ),
    )
    det.appendChild(sum)
    det.appendChild(inner)
    return det
  }

  function confirmClearAudit() {
    uiConfirm(
      '清空审计数据',
      `将删除本机全部 ${state.batches.length} 个批次记录与 ${state.oplog.length} 条操作日志。若尚未导出，这些记录将无法找回。资金本身不受影响。`,
      () => {
        state.batches = []
        state.oplog = []
        persistBatches()
        saveJSON(K_OPLOG, state.oplog)
        logOp('audit.clear', '清空全部审计数据')
        renderAll()
        toast('审计数据已清空', 'warn')
      },
      '清空',
    )
  }

  // ---------- 密钥设置 ----------

  function renderCredTab() {
    const sec = refs.secCred
    sec.replaceChildren()

    // 已加密锁定提示
    if (!state.cred && state.credEnc) {
      const unlockBtn = h('button', { class: 'frp-btn pri', text: '解锁密钥' })
      unlockBtn.addEventListener('click', uiUnlockCred)
      const forgetBtn = h('button', { class: 'frp-btn danger', text: '删除已记住的密钥' })
      forgetBtn.addEventListener('click', () => {
        uiConfirm('删除已记住的密钥', '将从本机删除加密存储的密钥（不影响 credit 账户本身）。', () => {
          GM_deleteValue(K_CRED_ENC)
          state.credEnc = null
          logOp('cred.forget', '删除本机加密存储的密钥')
          renderAll()
        })
      })
      sec.appendChild(
        h(
          'div',
          { class: 'frp-card' },
          h('h3', { text: '加密锁定的密钥' }),
          h('div', { class: 'frp-hint', text: `本机存有一份口令加密的密钥（商户 ${state.credEnc.pidMask || '—'}）。解锁后可用于发放；也可直接删除。` }),
          h('div', { class: 'frp-row' }, unlockBtn, forgetBtn),
        ),
      )
    }

    const pidInput = h('input', { class: 'frp-input', style: 'width:280px', placeholder: '4-64 位字母数字', autocomplete: 'off', spellcheck: 'false' })
    const secInput = h('input', { class: 'frp-input', style: 'width:280px', type: state.ui.credShow ? 'text' : 'password', placeholder: '4-64 位，不含空白', autocomplete: 'new-password', spellcheck: 'false' })
    const showBtn = h('button', { class: 'frp-btn sm', text: state.ui.credShow ? '隐藏' : '显示' })
    showBtn.addEventListener('click', () => {
      state.ui.credShow = !state.ui.credShow
      renderCredTab()
    })
    if (state.ui._pid) pidInput.value = state.ui._pid
    if (state.ui._sec) secInput.value = state.ui._sec
    pidInput.addEventListener('input', () => (state.ui._pid = pidInput.value))
    secInput.addEventListener('input', () => (state.ui._sec = secInput.value))

    const msgBox = h('div')

    const verifyBtn = h('button', { class: 'frp-btn acc', text: '校验密钥（零成本，不扣款）' })
    verifyBtn.addEventListener('click', async () => {
      msgBox.replaceChildren(h('div', { class: 'frp-hint', text: '校验中…' }))
      const cid = pidInput.value.trim()
      const cs = secInput.value.trim()
      const res = await ldcVerifyCredentials(cid, cs)
      msgBox.replaceChildren(h('div', { class: 'frp-msg ' + (res.ok ? 'ok' : 'err'), text: (res.ok ? '✓ ' : '✕ ') + res.msg }))
      logOp('cred.verify', `${res.ok ? '密钥校验通过' : '密钥校验失败'}：${res.msg}（商户 ${maskPid(cid)}）`)
    })

    const saveBtn = h('button', { class: 'frp-btn pri', text: '保存到本次会话（仅内存）' })
    saveBtn.addEventListener('click', () => {
      const cid = pidInput.value.trim()
      const cs = secInput.value.trim()
      if (!cid || !cs || /\s/.test(cid) || /\s/.test(cs)) {
        msgBox.replaceChildren(h('div', { class: 'frp-msg err', text: 'client_id / client_secret 不能为空且不能含空白字符' }))
        return
      }
      state.cred = { clientId: cid, clientSecret: cs }
      state.ui._sec = ''
      logOp('cred.session', `密钥载入本次会话（商户 ${maskPid(cid)}）`)
      renderAll()
      toast('密钥已就绪（仅本次会话有效，刷新后需重新载入）', 'ok')
    })

    const encBtn = h('button', { class: 'frp-btn', text: '加密记住到本机…' })
    encBtn.addEventListener('click', async () => {
      const cid = pidInput.value.trim()
      const cs = secInput.value.trim()
      if (!cid || !cs || /\s/.test(cid) || /\s/.test(cs)) {
        msgBox.replaceChildren(h('div', { class: 'frp-msg err', text: '请先在上方填写有效的 client_id / client_secret' }))
        return
      }
      const pass = await uiPrompt('设置加密口令', '口令（≥8 位，用于加密密钥；遗忘则无法恢复，只能删除重配）', 'password')
      if (!pass) return
      if (pass.length < 8) {
        toast('口令至少 8 位', 'error')
        return
      }
      try {
        state.credEnc = await encryptCred({ clientId: cid, clientSecret: cs }, pass)
        saveJSON(K_CRED_ENC, state.credEnc)
        state.cred = { clientId: cid, clientSecret: cs }
        state.ui._sec = ''
        logOp('cred.encrypt', `密钥以口令加密后记住到本机（商户 ${maskPid(cid)}；PBKDF2-310k + AES-256-GCM）`)
        renderAll()
        toast('密钥已加密记住，本会话同时可用', 'ok')
      } catch (e) {
        toast('加密失败：' + e.message, 'error')
      }
    })

    const forgetBtn2 = state.credEnc
      ? h('button', { class: 'frp-btn danger', text: '删除本机记住的密钥' })
      : null
    if (forgetBtn2)
      forgetBtn2.addEventListener('click', () => {
        uiConfirm('删除已记住的密钥', '将从本机删除加密存储的密钥。', () => {
          GM_deleteValue(K_CRED_ENC)
          state.credEnc = null
          logOp('cred.forget', '删除本机加密存储的密钥')
          renderAll()
        })
      })

    const cur = state.cred
    sec.appendChild(
      h(
        'div',
        { class: 'frp-card' },
        h('h3', { text: 'credit.linux.do 商户密钥' }),
        h(
          'div',
          { class: 'frp-hint' },
          '打款使用你自己的商户 API 密钥（在 ',
          h('code', { text: 'credit.linux.do' }),
          ' 用户中心创建），资金从该密钥所属账户直接转入目标用户，本工具不经手、不上传、不落明文。当前状态：',
          h('b', { text: cur ? `会话内已配置（商户 ${maskPid(cur.clientId)}）` : state.credEnc ? '已加密锁定，可解锁或重新配置' : '未配置' }),
        ),
        h('div', { class: 'frp-row', style: 'margin:10px 0 4px' }, h('span', { class: 'frp-hint', text: 'client_id' }), pidInput),
        h('div', { class: 'frp-row', style: 'margin:4px 0 4px' }, h('span', { class: 'frp-hint', text: 'client_secret' }), secInput, showBtn),
        h('div', { class: 'frp-row', style: 'margin-top:10px' }, verifyBtn, saveBtn, encBtn, forgetBtn2),
        msgBox,
        h(
          'div',
          { class: 'frp-hint', style: 'margin-top:8px' },
          '· 「校验」通过查一个不存在的单号验证密钥，零成本、不扣款；',
          h('br'),
          '· 「仅内存」= 刷新页面即消失，最安全；「加密记住」= PBKDF2-SHA256(310k) 派生密钥 + AES-256-GCM 加密后存入脚本沙箱，重启浏览器后点「解锁」即可；',
          h('br'),
          '· 密钥只会被发送到 ',
          h('code', { text: 'https://credit.linux.do' }),
          '（Tampermonkey @connect 白名单强制），本工具不包含任何其他网络出口，也不加载任何外部脚本/样式/头像。',
        ),
      ),
    )

    // 接口信息（可审计）
    sec.appendChild(
      h(
        'div',
        { class: 'frp-card' },
        h('h3', { text: '网络出口清单（可审计）' }),
        h('div', { class: 'frp-hint' },
          h('code', { text: 'POST ' + LDC_BASE + DISTRIBUTE_PATH }), ' —— 批量打款（Basic Auth）；',
          h('br'),
          h('code', { text: 'GET  ' + LDC_BASE + QUERY_PATH }), ' —— 密钥校验与查单对账；',
          h('br'),
          h('code', { text: 'GET  https://linux.do/my/follow/followers.json' }), ' —— 拉取你自己的粉丝名单（同源请求，仅使用你当前登录会话，自动翻页）；',
          h('br'),
          h('code', { text: 'GET  https://linux.do/u/:username.json' }), ' —— 按用户名查询用户的 id / username / name（同源，查询添加功能）；',
          h('br'),
          h('code', { text: 'IMG  linux.do/user_avatar/… 或 cdn*.ldstatic.com' }), ' —— 用户头像图片（仅 <img> 展示，加载失败自动回退本机色块，不发其他请求）。',
          h('br'),
          '除上述出口外无任何其他网络请求：无统计、无字体/样式外链。名单、额度、批次与日志全部保存在本机脚本沙箱（GM 存储），可随时导出或清空。',
        ),
      ),
    )
  }

  async function uiUnlockCred() {
    const pass = await uiPrompt('解锁密钥', '输入加密口令', 'password')
    if (!pass) return
    try {
      const cred = await decryptCred(state.credEnc, pass)
      state.cred = cred
      logOp('cred.unlock', '解锁本机加密密钥（商户 ' + maskPid(cred.clientId) + '）')
      renderAll()
      toast('密钥已解锁', 'ok')
    } catch {
      toast('口令错误或数据损坏，解锁失败', 'error')
    }
  }

  // ---------- 通用确认 / 输入弹窗 ----------

  function uiConfirm(title, text, onOk, okText) {
    const modal = h('div', { class: 'frp-modal-bg' })
    const ok = h('button', { class: 'frp-btn danger', text: okText || '确定' })
    ok.addEventListener('click', () => {
      modal.remove()
      onOk()
    })
    modal.appendChild(
      h(
        'div',
        { class: 'frp-modal' },
        h('h3', { text: title }),
        h('div', { class: 'frp-hint', text }),
        h('div', { class: 'acts' }, h('button', { class: 'frp-btn', text: '取消', onclick: () => modal.remove() }), ok),
      ),
    )
    shadow.appendChild(modal)
  }

  function uiPrompt(title, label, type) {
    return new Promise((resolve) => {
      const modal = h('div', { class: 'frp-modal-bg' })
      const input = h('input', { class: 'frp-input', style: 'width:100%', type: type || 'text' })
      const ok = h('button', { class: 'frp-btn pri', text: '确定' })
      const cancel = h('button', { class: 'frp-btn', text: '取消' })
      ok.addEventListener('click', () => {
        modal.remove()
        resolve(input.value)
      })
      cancel.addEventListener('click', () => {
        modal.remove()
        resolve(null)
      })
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') ok.click()
      })
      modal.appendChild(h('div', { class: 'frp-modal' }, h('h3', { text: title }), h('div', { class: 'frp-hint', text: label }), input, h('div', { class: 'acts' }, cancel, ok)))
      shadow.appendChild(modal)
      setTimeout(() => input.focus(), 30)
    })
  }

  // ---------- 打开 / 关闭 ----------

  function bindShell() {
    refs.keypill = shadow.getElementById('frp-keypill')
    refs.paste = shadow.getElementById('frp-paste')
    refs.importmsg = shadow.getElementById('frp-importmsg')
    refs.uniform = shadow.getElementById('frp-uniform')
    refs.search = shadow.getElementById('frp-search')
    refs.rostersum = shadow.getElementById('frp-rostersum')
    refs.rosterwrap = shadow.getElementById('frp-rosterwrap')
    refs.secRun = shadow.getElementById('frp-sec-run')
    refs.secAudit = shadow.getElementById('frp-sec-audit')
    refs.secCred = shadow.getElementById('frp-sec-cred')
    refs.oplogList = h('div', { class: 'frp-oplog' })

    shadow.getElementById('frp-close').addEventListener('click', closeUI)
    shadow.getElementById('frp-opencred').addEventListener('click', () => switchTab('cred'))
    shadow.getElementById('frp-import').addEventListener('click', doImport)
    shadow.getElementById('frp-sample').addEventListener('click', () => {
      refs.paste.value = SAMPLE_JSON
      toast('已填入示例 JSON，点击「解析并导入」生效')
    })
    shadow.getElementById('frp-clearroster').addEventListener('click', () => {
      if (!state.roster.users.length) return
      uiConfirm('清空名单', '仅清空本机名单与已设额度，不影响已发放的批次审计记录。', () => {
        state.roster = { importedAt: 0, users: [] }
        persistRoster()
        logOp('roster.clear', '清空名单')
        renderRosterTab()
      })
    })
    shadow.getElementById('frp-applyall').addEventListener('click', applyUniform)
    refs.fetchBtn = shadow.getElementById('frp-fetchfollowers')
    refs.fetchBtn.addEventListener('click', fetchMyFollowers)
    refs.lookup = shadow.getElementById('frp-lookup')
    refs.lookupBtn = shadow.getElementById('frp-lookupbtn')
    refs.lookupBtn.addEventListener('click', lookupUsers)
    refs.lookup.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) lookupUsers()
    })
    refs.search.addEventListener('input', () => {
      state.ui.search = refs.search.value
      renderRosterTab()
    })
    for (const btn of shadow.querySelectorAll('.frp-tab')) {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab))
    }
    shadow.querySelector('.frp-overlay').addEventListener('click', (e) => {
      if (e.target.classList && e.target.classList.contains('frp-overlay')) {
        if (run.active) toast('批次进行中，请先暂停/停止后再关闭', 'warn')
        else closeUI()
      }
    })
  }

  function openUI() {
    if (host) return
    host = document.createElement('div')
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
    document.documentElement.appendChild(host)
    renderAll()
    // 有未完成的批次（含待对账/待发放）时直接落在发放页
    const unfinished = state.batches.find(
      (b) => b.status === 'running' || b.status === 'paused' || b.status === 'stopped',
    )
    if (unfinished && (resumableRows(unfinished).length || unfinished.rows.some((r) => r.status === 'unknown'))) {
      state.ui.currentBatchId = unfinished.id
      switchTab('run')
    }
  }

  function closeUI() {
    if (run.active) {
      toast('批次进行中，请先暂停/停止', 'warn')
      return
    }
    if (host) host.remove()
    host = null
    shadow = null
  }

  // ---------- 悬浮入口（页面展示） ----------

  let launcherHost = null
  let launcherShadow = null
  let launcherBtn = null
  let launcherBadge = null

  const LAUNCHER_CSS = `
:host{all:initial}
*,*::before,*::after{box-sizing:border-box}
.frp-launch{position:fixed;right:16px;bottom:16px;z-index:2147483646;width:46px;height:46px;border-radius:50%;background:#e11d48;color:#fff;display:flex;align-items:center;justify-content:center;font-size:22px;line-height:1;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.35);user-select:none;-webkit-user-select:none;touch-action:none;transition:transform .12s ease,box-shadow .12s ease;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.frp-launch:hover{transform:scale(1.07);box-shadow:0 8px 26px rgba(0,0,0,.45)}
.frp-launch.dragging{transition:none;opacity:.85;cursor:grabbing}
.frp-launch-badge{position:absolute;top:-5px;right:-6px;min-width:20px;height:20px;border-radius:999px;background:#f59e0b;color:#fff;font-size:11px;font-weight:700;line-height:16px;text-align:center;padding:0 5px;border:2px solid #fff}
.frp-toast{position:fixed;left:50%;bottom:34px;transform:translateX(-50%);background:#1e293b;color:#f8fafc;font-size:13px;padding:9px 16px;border-radius:9px;box-shadow:0 8px 24px rgba(0,0,0,.4);z-index:2147483647;max-width:80vw;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.frp-toast.err{background:#dc2626}
.frp-toast.warn{background:#b45309}
.frp-toast.ok{background:#16a34a}
`

  function mountLauncher() {
    if (launcherHost) return
    launcherHost = document.createElement('div')
    launcherHost.id = 'frp-launcher-host'
    try {
      launcherShadow = launcherHost.attachShadow({ mode: 'open' })
    } catch {
      launcherHost = null
      return
    }
    try {
      const sheet = new CSSStyleSheet()
      sheet.replaceSync(LAUNCHER_CSS)
      launcherShadow.adoptedStyleSheets = [sheet]
    } catch {
      const st = document.createElement('style')
      st.textContent = LAUNCHER_CSS
      launcherShadow.appendChild(st)
    }

    launcherBtn = h('div', { class: 'frp-launch', title: 'LDC 批量分发（点击打开，拖动换位）', text: '🧧' })
    launcherBadge = h('span', { class: 'frp-launch-badge', text: '' })
    launcherBadge.style.display = 'none'
    launcherBtn.appendChild(launcherBadge)

    // 指针拖拽换位；位移小于阈值视为点击 → 打开面板
    let dragging = false
    let moved = false
    let sx = 0
    let sy = 0
    let ox = 0
    let oy = 0
    launcherBtn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return
      dragging = true
      moved = false
      sx = e.clientX
      sy = e.clientY
      const r = launcherBtn.getBoundingClientRect()
      ox = r.left
      oy = r.top
      try {
        launcherBtn.setPointerCapture(e.pointerId)
      } catch {}
    })
    launcherBtn.addEventListener('pointermove', (e) => {
      if (!dragging) return
      const dx = e.clientX - sx
      const dy = e.clientY - sy
      if (!moved && Math.hypot(dx, dy) < 6) return
      moved = true
      launcherBtn.classList.add('dragging')
      const x = Math.min(Math.max(ox + dx, 4), window.innerWidth - launcherBtn.offsetWidth - 4)
      const y = Math.min(Math.max(oy + dy, 4), window.innerHeight - launcherBtn.offsetHeight - 4)
      launcherBtn.style.left = x + 'px'
      launcherBtn.style.top = y + 'px'
      launcherBtn.style.right = 'auto'
      launcherBtn.style.bottom = 'auto'
    })
    launcherBtn.addEventListener('pointerup', () => {
      if (!dragging) return
      dragging = false
      launcherBtn.classList.remove('dragging')
      if (moved) {
        const r = launcherBtn.getBoundingClientRect()
        saveJSON(K_LAUNCHER, { x: Math.round(r.left), y: Math.round(r.top) })
      } else {
        openUI()
      }
    })
    launcherBtn.addEventListener('pointercancel', () => {
      dragging = false
      launcherBtn.classList.remove('dragging')
    })

    // 恢复上次位置（窗口可能变小，做边界钳制）
    const pos = loadJSON(K_LAUNCHER, null)
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
      const x = Math.min(Math.max(pos.x, 4), Math.max(4, window.innerWidth - 60))
      const y = Math.min(Math.max(pos.y, 4), Math.max(4, window.innerHeight - 60))
      launcherBtn.style.left = x + 'px'
      launcherBtn.style.top = y + 'px'
      launcherBtn.style.right = 'auto'
      launcherBtn.style.bottom = 'auto'
    }

    launcherShadow.appendChild(launcherBtn)
    document.documentElement.appendChild(launcherHost)
    updateLauncherBadge()
  }

  /** 悬浮按钮角标：有待对账记录时常亮提醒（面板关闭也能看到） */
  function updateLauncherBadge() {
    if (!launcherBadge || !launcherBtn) return
    const un = unknownCount()
    if (un) {
      launcherBadge.textContent = String(un)
      launcherBadge.style.display = ''
      launcherBtn.title = `LDC 批量分发（${un} 笔待对账，点击打开）`
    } else {
      launcherBadge.style.display = 'none'
      launcherBtn.title = 'LDC 批量分发（点击打开，拖动换位）'
    }
  }

  // ============================== 启动 ==============================

  GM_registerMenuCommand(menuLabel(), openUI)
  GM_registerMenuCommand('👥 拉取我的粉丝名单（Alt+F）', fetchMyFollowers)

  // 快捷键 Alt+F：拉取 linux.do「我的粉丝」并导入名单（排除 Alt+Shift/F 系统组合键；捕获阶段拦截）
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.shiftKey || !e.altKey) return
      if (e.code !== 'KeyF') return
      e.preventDefault()
      e.stopPropagation()
      fetchMyFollowers()
    },
    true,
  )

  mountLauncher()

  function menuLabel() {
    const un = unknownCount()
    const unfinished = state.batches.find((b) => b.status === 'paused' || b.status === 'running')
    if (un) return `🧧 批量分发（${un} 笔待对账）`
    if (unfinished) return '🧧 批量分发（有未完成批次）'
    return '🧧 批量分发'
  }
})()
