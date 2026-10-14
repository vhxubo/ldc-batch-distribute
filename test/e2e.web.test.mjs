/**
 * 网页版（index.html）jsdom 端到端测试。
 * 页面内 mock 中继与 credit.linux.do 契约（无真实网络），存储走 jsdom localStorage。
 * 运行：node test/e2e.web.test.mjs
 */
import { JSDOM } from 'jsdom'
import { readFileSync } from 'node:fs'
import { webcrypto } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HTML = readFileSync(join(ROOT, 'index.html'), 'utf8')
const SCRIPT = (() => {
  const m = HTML.match(/<script>([\s\S]*)<\/script>/)
  if (!m) throw new Error('index.html 中未找到 <script>')
  return m[1]
})()

const PAGE_ORIGIN = 'https://vhxubo.github.io'
const PROXY = 'https://frp-relay.example.workers.dev'
const PROXY_TOKEN = 'relay-secret-token'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, timeout = 10000, step = 60) {
  const t0 = Date.now()
  for (;;) {
    if (fn()) return
    if (Date.now() - t0 > timeout) throw new Error('until: timeout')
    await sleep(step)
  }
}

const USERS_JSON_SAMPLE = JSON.stringify([
  { id: 6799, username: 'gjkldsjgjlkf', name: '馄饨' },
  { id: 20078, username: 'jackal', name: 'jackal' },
  { id: 20078, username: 'jackal-dup', name: '' }, // 重复 id → 去重
  { id: 'abc', username: 'noid' }, // 无效 → 跳过
  { id: 24726, username: 'SSSS', name: '抹茶毛巾卷' },
])

const USERS_JSON_LIVE = JSON.stringify([
  { id: 11, username: 'alice', name: 'A' },
  { id: 12, username: 'bob', name: 'B' },
  { id: 13, username: 'carl-fail', name: 'C' },
  { id: 14, username: 'dave-unknown', name: 'D' },
  { id: 999999, username: 'eve-rich', name: 'E' }, // mock: 收款人不存在
])

/**
 * 构造一个页面世界：先播种 localStorage（seed），再执行页面脚本（脚本加载即自动打开面板）。
 */
async function makeWorld({ settings, seed } = {}) {
  const netlog = [] // {method,url,headers,body}
  const violations = [] // 违反网络出口白名单的请求
  const processed = new Set() // 已在上游“落地”但响应丢失的单号
  const downloads = []

  const dom = new JSDOM(`<!doctype html><html><head></head><body></body></html>`, {
    url: PAGE_ORIGIN + '/ldc-batch-distribute/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  })
  const w = dom.window

  try {
    Object.defineProperty(w, 'crypto', { configurable: true, value: webcrypto })
  } catch {}
  if (!w.TextEncoder) w.TextEncoder = TextEncoder
  if (!w.TextDecoder) w.TextDecoder = TextDecoder
  w.URL.createObjectURL = () => 'blob:mock'
  w.URL.revokeObjectURL = () => {}
  w.HTMLAnchorElement.prototype.click = function () {
    if (String(this.href).startsWith('blob:')) downloads.push({ name: this.download })
  }

  // —— 播种（必须在 eval 之前）——
  const seedSettings = Object.assign({ remark: '粉丝红包', concurrency: 2, proxyUrl: PROXY, proxyToken: '' }, settings)
  w.localStorage.setItem('frp_settings_v1', JSON.stringify(seedSettings))
  if (seed) for (const [k, v] of Object.entries(seed)) w.localStorage.setItem(k, v)
  const proxyToken = seedSettings.proxyToken

  // —— mock 中继（对齐 credit.linux.do 契约）——
  const PROXY_ORIGIN = new URL(PROXY).origin
  w.fetch = async (url, init = {}) => {
    const u = new w.URL(String(url))
    const entry = { method: init.method || 'GET', url: String(url), headers: init.headers || {}, body: init.body }
    netlog.push(entry)
    const respond = (status, text) => ({ status, text: async () => text })
    const netfail = () => {
      throw new w.Error('mock network lost')
    }
    if (u.origin !== PROXY_ORIGIN || !['/lpay/distribute', '/epay/api.php'].includes(u.pathname)) {
      violations.push(String(url))
      return respond(400, '{"error_msg":"harness: unexpected origin/path"}')
    }
    if (proxyToken && (init.headers || {})['x-frp-token'] !== proxyToken) {
      return respond(403, '{"error_msg":"中继口令不正确"}')
    }
    if (u.pathname === '/epay/api.php') {
      const pid = u.searchParams.get('pid')
      const key = u.searchParams.get('key')
      const otn = u.searchParams.get('out_trade_no') || ''
      if (pid !== 'goodpid' || key !== 'goodsecret') return respond(200, JSON.stringify({ code: -1, msg: '商户信息不存在' }))
      if (otn.startsWith('VERIFY')) return respond(200, JSON.stringify({ code: 0, msg: '订单不存在或已完成' }))
      if (processed.has(otn)) return respond(200, JSON.stringify({ code: 1, msg: 'ok', trade_no: 'MOCKT' + otn.slice(-8) }))
      return respond(200, JSON.stringify({ code: 0, msg: '订单不存在或已完成' }))
    }
    // /lpay/distribute
    const auth = (init.headers || {}).Authorization || ''
    if (auth !== 'Basic ' + Buffer.from('goodpid:goodsecret').toString('base64'))
      return respond(401, JSON.stringify({ error_msg: '鉴权失败' }))
    let body
    try {
      body = JSON.parse(init.body)
    } catch {
      return respond(200, '<html>bad gateway</html>')
    }
    if (typeof body.user_id !== 'number') return respond(200, JSON.stringify({ error_msg: 'user_id 必须是数字' }))
    if (body.user_id === 999999) return respond(200, JSON.stringify({ error_msg: '收款人不存在' }))
    if (/fail/i.test(body.username || '')) return respond(200, JSON.stringify({ error_msg: '余额不足' }))
    if (/unknown/i.test(body.username || '')) {
      processed.add(body.out_trade_no)
      return netfail()
    }
    return respond(200, JSON.stringify({ code: 1, data: { trade_no: 'MOCK' + Math.random().toString(36).slice(2, 10) } }))
  }

  // —— 执行页面脚本（readyState=complete → 自动 openUI）——
  w.eval('var crypto = window.crypto; var TextEncoder = window.TextEncoder; var TextDecoder = window.TextDecoder;')
  w.eval(SCRIPT)

  const doc = w.document
  const root = () => doc.getElementById('frp-page-root').shadowRoot
  const btn = (text, scope) =>
    [...(scope || root()).querySelectorAll('button')].find((b) => b.textContent.trim() === text)
  const btnIn = (text) => [...root().querySelectorAll('button')].find((b) => b.textContent.includes(text))
  const tab = (name) => root().querySelector(`.frp-tab[data-tab="${name}"]`)
  const id = (i) => root().querySelector('#' + i)
  const lsGet = (k) => {
    const v = w.localStorage.getItem(k)
    return v == null ? undefined : v
  }
  const batches = () => JSON.parse(lsGet('frp_batches_v1') || '[]')
  const getSettings = () => JSON.parse(lsGet('frp_settings_v1') || '{}')
  const credInputs = () => {
    const all = [...T.id('frp-sec-cred').querySelectorAll('input.frp-input')]
    return {
      proxy: all.find((i) => i.placeholder && i.placeholder.includes('workers.dev')),
      token: all.find((i) => i.placeholder && i.placeholder.includes('留空')),
      pid: all.find((i) => i.placeholder && i.placeholder.includes('字母数字')),
      secret: all.find((i) => i.placeholder && i.placeholder.includes('空白')),
    }
  }

  // 等待页面自动挂载（DOMContentLoaded 在 eval 后异步触发）
  await until(() => doc.getElementById('frp-page-root'), 3000, 20)

  const T = { w, dom, netlog, violations, downloads, root, btn, btnIn, tab, id, lsGet, batches, getSettings, credInputs }

  async function saveSessionCred(pid = 'goodpid', secret = 'goodsecret') {
    T.tab('cred').click()
    const ci = T.credInputs()
    ci.pid.value = pid
    ci.pid.dispatchEvent(new T.w.Event('input', { bubbles: true }))
    ci.secret.value = secret
    ci.secret.dispatchEvent(new T.w.Event('input', { bubbles: true }))
    T.btnIn('保存到本次会话').click()
  }
  async function startBatch(mode) {
    T.tab('run').click()
    T.btnIn(mode === 'dry' ? '演练模式' : '开始发放').click()
    const modal = T.root().querySelector('.frp-modal-bg')
    const chk = modal.querySelector('input[type=checkbox]')
    chk.click()
    chk.dispatchEvent(new T.w.Event('change', { bubbles: true }))
    T.btn(mode === 'dry' ? '开始演练' : '确认发放', modal).click()
  }
  T.saveSessionCred = saveSessionCred
  T.startBatch = startBatch
  return T
}

const results = []
function check(name, fn) {
  return async () => {
    try {
      await fn()
      results.push(['PASS', name, ''])
      console.log('  ✓ PASS', name)
    } catch (e) {
      results.push(['FAIL', name, e.stack || e.message])
      console.log('  ✗ FAIL', name, '\n    ', e.stack || e.message)
    }
  }
}

// ============================== 用例 ==============================

const testPageBoots = check('页面启动：加载即出面板、CSP 白名单、中继卡片', async () => {
  assert.ok(HTML.includes("connect-src 'self' https://*.workers.dev"), 'CSP connect-src 白名单')
  const T = await makeWorld()
  assert.ok(T.root(), '面板已挂载')
  assert.ok(T.root().textContent.includes('名单与额度'), '标签存在')
  T.tab('cred').click()
  assert.ok(T.root().textContent.includes('中继（Cloudflare Worker，必填）'), '中继卡片存在')
  assert.ok(T.getSettings().proxyUrl === PROXY, '种子中继地址已载入')
  T.dom.window.close()
})

const testImportAndQuota = check('名单导入：解析/去重/跳过 + 统一额度 + 单独额度', async () => {
  const T = await makeWorld()
  T.tab('roster').click()
  T.id('frp-paste').value = USERS_JSON_SAMPLE
  T.btn('解析并导入').click()
  assert.ok(T.id('frp-importmsg').textContent.includes('已导入 3 人'), '导入 3 人')
  assert.ok(T.id('frp-importmsg').textContent.includes('跳过无效 1'), '跳过无效')
  assert.ok(T.id('frp-importmsg').textContent.includes('去重 1'), '按 id 去重')
  assert.equal(T.id('frp-rosterwrap').querySelectorAll('tbody tr').length, 3, '表格 3 行')

  T.id('frp-uniform').value = '0.66'
  T.btn('应用到已勾选').click()
  await until(() => T.id('frp-rostersum').textContent.includes('1.98'), 3000)

  const secondInput = T.id('frp-rosterwrap').querySelectorAll('tbody tr')[1].querySelector('input:not([type=checkbox])')
  secondInput.value = '1.234'
  secondInput.dispatchEvent(new T.w.Event('change', { bubbles: true }))
  assert.ok(secondInput.className.includes('bad'), '三位小数标记非法')
  secondInput.value = '1.23'
  secondInput.dispatchEvent(new T.w.Event('change', { bubbles: true }))
  await until(() => T.id('frp-rostersum').textContent.includes('2.55'), 3000)
  assert.ok(T.id('frp-rostersum').textContent.includes('合计 2.55 LDC'), '统一+单独额度总计')
  T.dom.window.close()
})

const testProxyConfig = check('中继配置：非法地址拦截、合法地址去尾斜杠持久化、口令持久化', async () => {
  const T = await makeWorld()
  T.tab('cred').click()
  const { proxy, token } = T.credInputs()
  assert.equal(proxy.value, PROXY, '已载入中继地址')
  proxy.value = 'http://evil.example.com'
  proxy.dispatchEvent(new T.w.Event('change', { bubbles: true }))
  assert.ok(proxy.className.includes('bad'), 'http 非本机地址被拦截')
  assert.equal(T.getSettings().proxyUrl, PROXY, '非法值未持久化')
  proxy.value = 'https://my-relay.example.workers.dev/'
  proxy.dispatchEvent(new T.w.Event('change', { bubbles: true }))
  assert.equal(T.getSettings().proxyUrl, 'https://my-relay.example.workers.dev', '去尾斜杠后持久化')
  token.value = PROXY_TOKEN
  token.dispatchEvent(new T.w.Event('change', { bubbles: true }))
  assert.equal(T.getSettings().proxyToken, PROXY_TOKEN, '口令持久化')
  T.dom.window.close()
})

const testVerifyBadKey = check('密钥校验：错误提示、正确通过、secret 不落盘、仅访问中继', async () => {
  const T = await makeWorld()
  await T.saveSessionCred('badpid', 'badsecret2')
  const { pid, secret } = T.credInputs()
  pid.value = 'badpid'
  pid.dispatchEvent(new T.w.Event('input', { bubbles: true }))
  secret.value = 'badsecret2'
  secret.dispatchEvent(new T.w.Event('input', { bubbles: true }))
  T.btnIn('校验密钥').click()
  await until(() => T.id('frp-sec-cred').textContent.includes('client_id 或 client_secret 不正确'), 4000)
  pid.value = 'goodpid'
  pid.dispatchEvent(new T.w.Event('input', { bubbles: true }))
  secret.value = 'goodsecret'
  secret.dispatchEvent(new T.w.Event('input', { bubbles: true }))
  T.btnIn('校验密钥').click()
  await until(() => T.id('frp-sec-cred').textContent.includes('密钥校验通过'), 4000)
  T.btnIn('保存到本次会话').click()
  await until(() => T.id('frp-keypill').textContent.includes('已就绪'), 3000)
  for (let i = 0; i < T.w.localStorage.length; i++) {
    const k = T.w.localStorage.key(i)
    const v = T.w.localStorage.getItem(k)
    if (k !== 'frp_oplog_v1') assert.ok(!v.includes('goodsecret'), 'secret 不落盘: ' + k)
  }
  assert.ok(T.netlog.length >= 2, '校验请求已发出')
  assert.ok(T.netlog.every((e) => e.url.startsWith(PROXY + '/epay/api.php')), '仅访问中继的查单路径')
  T.dom.window.close()
})

const testDryRun = check('演练模式：零网络请求，模拟成功/失败/待对账 + 演练对账', async () => {
  const T = await makeWorld()
  T.tab('roster').click()
  T.id('frp-paste').value = USERS_JSON_LIVE
  T.btn('解析并导入').click()
  T.id('frp-uniform').value = '0.10'
  T.btn('应用到已勾选').click()
  await T.startBatch('dry')
  await until(() => ['done', 'paused', 'stopped'].includes(T.batches()[0].status), 15000)
  const by = Object.fromEntries(T.batches()[0].rows.map((r) => [r.username, r.status]))
  assert.equal(by['alice'], 'success')
  assert.equal(by['carl-fail'], 'failed')
  assert.equal(by['dave-unknown'], 'unknown')
  assert.equal(T.netlog.length, 0, '演练零网络')
  T.tab('audit').click()
  T.btnIn('查单对账').click()
  await until(() => T.batches()[0].rows.every((r) => r.status !== 'unknown'), 6000)
  T.dom.window.close()
})

const testLiveRun = check('实发 mock：成功/失败/未知 + 查单找回 + 重试复用单号 + 口令头', async () => {
  const T = await makeWorld({ settings: { proxyToken: PROXY_TOKEN } })
  await T.saveSessionCred()
  T.tab('roster').click()
  T.id('frp-paste').value = USERS_JSON_LIVE
  T.btn('解析并导入').click()
  T.id('frp-uniform').value = '0.10'
  T.btn('应用到已勾选').click()
  await T.startBatch('live')

  await until(() => T.batches().length > 0, 3000)
  assert.ok(T.batches()[0].rows.every((r) => /^FRP[0-9A-Za-z]+$/.test(r.outTradeNo)), '单号格式 FRP…')

  await until(() => ['done', 'paused', 'stopped'].includes(T.batches()[0].status), 20000)
  const row = (name) => T.batches()[0].rows.find((r) => r.username === name)
  assert.equal(row('alice').status, 'success')
  assert.ok(/^MOCK/.test(row('alice').tradeNo))
  assert.equal(row('carl-fail').status, 'failed')
  assert.ok(row('carl-fail').error.includes('余额不足'))
  assert.equal(row('dave-unknown').status, 'unknown')
  assert.equal(row('eve-rich').status, 'failed')

  assert.ok(T.netlog.length > 0)
  assert.ok(T.netlog.every((e) => e.headers['x-frp-token'] === PROXY_TOKEN), '中继口令头随请求发送')

  T.tab('audit').click()
  T.btnIn('查单对账').click()
  await until(() => row('dave-unknown').status === 'success', 8000)
  assert.ok(/^MOCKT/.test(row('dave-unknown').tradeNo), '对账找回交易号')

  const before = row('carl-fail').outTradeNo
  T.btnIn('重试失败').click()
  await until(() => ['done', 'paused'].includes(T.batches()[0].status) && row('carl-fail').finishedAt > 0, 15000)
  assert.equal(row('carl-fail').outTradeNo, before, '重试复用原单号')

  assert.equal(T.violations.length, 0, '无越界请求: ' + T.violations.join(','))
  T.dom.window.close()
})

const testEncryptUnlock = check('加密记住 + 重载解锁（错误口令拒绝）', async () => {
  const T = await makeWorld()
  T.tab('cred').click()
  const { pid, secret } = T.credInputs()
  pid.value = 'goodpid'
  pid.dispatchEvent(new T.w.Event('input', { bubbles: true }))
  secret.value = 'goodsecret'
  secret.dispatchEvent(new T.w.Event('input', { bubbles: true }))
  T.btnIn('加密记住到本机').click()
  const modal = T.root().querySelector('.frp-modal-bg')
  modal.querySelector('input').value = 'test-passphrase'
  T.btn('确定', modal).click()
  await until(() => T.lsGet('frp_cred_enc_v1') !== undefined, 5000)
  const encBlob = T.lsGet('frp_cred_enc_v1')
  assert.ok(JSON.parse(encBlob).ct, '加密 blob 存在')
  assert.ok(!encBlob.includes('goodsecret'), '密文不含明文 secret')
  await until(() => T.id('frp-keypill').textContent.includes('已就绪'), 3000)
  T.dom.window.close()

  // 模拟同一浏览器的持久存储：带着加密 blob 重新加载页面
  const T2 = await makeWorld({ seed: { frp_cred_enc_v1: encBlob } })
  await until(() => T2.root().getElementById('frp-keypill').textContent.includes('加密锁定'), 3000)
  T2.tab('cred').click()
  T2.btnIn('解锁密钥').click()
  let m = T2.root().querySelector('.frp-modal-bg')
  m.querySelector('input').value = 'wrong-password'
  T2.btn('确定', m).click()
  await until(() => T2.root().querySelector('.frp-toast')?.className.includes('err'), 5000)
  assert.ok(T2.root().getElementById('frp-keypill').textContent.includes('加密锁定'), '错误口令不解锁')
  T2.btnIn('解锁密钥').click()
  m = T2.root().querySelector('.frp-modal-bg')
  m.querySelector('input').value = 'test-passphrase'
  T2.btn('确定', m).click()
  await until(() => T2.root().getElementById('frp-keypill').textContent.includes('已就绪'), 6000)
  T2.dom.window.close()
})

const testInterruptedRecovery = check('中断恢复：running→paused、sending→unknown、继续+对账', async () => {
  const seedBatches = JSON.stringify([
    {
      id: 'BTEST01', mode: 'live', status: 'running', createdAt: Date.now() - 60000, updatedAt: Date.now() - 30000,
      finishedAt: 0, remark: '粉丝红包', pid: 'goodpid',
      rows: [
        { id: 11, username: 'alice', name: '', amountCents: 10, outTradeNo: 'FRPTEST001', status: 'success', tradeNo: 'MOCKA', error: '', finishedAt: 1 },
        { id: 12, username: 'bob', name: '', amountCents: 10, outTradeNo: 'FRPTEST002', status: 'sending', tradeNo: '', error: '', finishedAt: 0 },
        { id: 13, username: 'carl-fail', name: '', amountCents: 10, outTradeNo: 'FRPTEST003', status: 'pending', tradeNo: '', error: '', finishedAt: 0 },
      ],
      events: [],
    },
  ])
  const T = await makeWorld({ seed: { frp_batches_v1: seedBatches } })
  await until(() => T.batches()[0].status === 'paused', 4000)
  assert.equal(T.batches()[0].rows[1].status, 'unknown', 'sending → unknown')
  assert.ok(T.batches()[0].rows[1].error.includes('中断'), '标注中断')

  await T.saveSessionCred()
  T.tab('run').click()
  T.btnIn('继续发放').click()
  await until(() => T.batches()[0].rows[2].status === 'failed', 12000)
  T.tab('audit').click()
  T.btnIn('查单对账').click()
  await until(() => T.batches()[0].rows[1].status === 'failed', 8000)
  assert.ok(T.batches()[0].rows[1].error.includes('未落地'), '查单确认未落地')
  T.dom.window.close()
})

const testAuditExportClear = check('审计：明细/日志/导出/删除', async () => {
  const T = await makeWorld()
  await T.saveSessionCred()
  T.tab('roster').click()
  T.id('frp-paste').value = JSON.stringify([{ id: 11, username: 'alice', name: 'A' }])
  T.btn('解析并导入').click()
  T.id('frp-uniform').value = '0.05'
  T.btn('应用到已勾选').click()
  await T.startBatch('live')
  await until(() => ['done', 'paused'].includes(T.batches()[0].status), 12000)
  T.tab('audit').click()
  assert.ok(T.id('frp-sec-audit').textContent.includes('alice'))
  assert.ok(T.id('frp-sec-audit').textContent.includes('batch.start'))
  assert.ok(T.id('frp-sec-audit').textContent.includes('roster.import'))
  T.btnIn('导出全部审计 JSON').click()
  await until(() => T.downloads.length > 0, 3000)
  T.btnIn('删除该批次记录').click()
  const modal = T.root().querySelector('.frp-modal-bg')
  T.btn('确定', modal).click()
  await until(() => T.batches().length === 0, 3000)
  T.dom.window.close()
})

const testUnknownBlocksNewBatch = check('存在待对账记录时禁止开新批次', async () => {
  const T = await makeWorld()
  await T.saveSessionCred()
  T.tab('roster').click()
  T.id('frp-paste').value = USERS_JSON_LIVE
  T.btn('解析并导入').click()
  T.id('frp-uniform').value = '0.10'
  T.btn('应用到已勾选').click()
  await T.startBatch('live')
  await until(() => T.batches()[0].rows.some((r) => r.status === 'unknown'), 20000)
  await until(() => T.batches()[0].status !== 'running', 20000)
  T.tab('run').click()
  assert.equal(T.btnIn('开始发放').disabled, true, '开始发放被禁用')
  assert.ok(T.id('frp-sec-run').textContent.includes('待对账'), '提示先对账')
  T.dom.window.close()
})

const testMissingProxyBlocks = check('未配置中继：校验提示且零请求、开始发放被拦', async () => {
  const T = await makeWorld({ settings: { proxyUrl: '' } })
  T.tab('cred').click()
  const { pid, secret } = T.credInputs()
  pid.value = 'goodpid'
  pid.dispatchEvent(new T.w.Event('input', { bubbles: true }))
  secret.value = 'goodsecret'
  secret.dispatchEvent(new T.w.Event('input', { bubbles: true }))
  T.btnIn('校验密钥').click()
  await until(() => T.id('frp-sec-cred').textContent.includes('中继地址'), 4000)
  assert.equal(T.netlog.length, 0, '未配置中继不发请求')
  T.tab('run').click()
  assert.equal(T.btnIn('开始发放').disabled, true, '开始发放被禁用')
  assert.ok(T.id('frp-sec-run').textContent.includes('中继地址'), '提示配置中继')
  T.dom.window.close()
})

const tests = [
  ['页面启动', testPageBoots],
  ['导入与额度', testImportAndQuota],
  ['中继配置', testProxyConfig],
  ['密钥校验', testVerifyBadKey],
  ['演练模式', testDryRun],
  ['实发与对账', testLiveRun],
  ['加密记住与解锁', testEncryptUnlock],
  ['中断恢复', testInterruptedRecovery],
  ['审计导出删除', testAuditExportClear],
  ['待对账拦截', testUnknownBlocksNewBatch],
  ['缺中继拦截', testMissingProxyBlocks],
]

console.log('== 网页版 E2E 开始 ==')
for (const [name, fn] of tests) {
  console.log('▶', name)
  await fn()
}
const failed = results.filter(([s]) => s === 'FAIL')
console.log(`\n== 结果: ${results.length - failed.length}/${results.length} 通过 ==`)
for (const [s, name, msg] of failed) console.log('FAIL:', name, '\n', msg)
process.exit(failed.length ? 1 : 0)
