/**
 * jsdom 端到端测试：GM_* stub + 页面内 mock credit.linux.do（无真实网络）。
 * 运行：node test/e2e.test.mjs
 */
import { JSDOM } from 'jsdom'
import { readFileSync } from 'node:fs'
import { webcrypto } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = readFileSync(join(ROOT, 'ldc-batch-distribute.user.js'), 'utf8')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, timeout = 10000, step = 60) {
  const t0 = Date.now()
  for (;;) {
    if (fn()) return
    if (Date.now() - t0 > timeout) throw new Error('until: timeout')
    await sleep(step)
  }
}

// 模拟数据统一以 vhxubo（https://linux.do/u/vhxubo.json）为基准，变体仅改 id/username 以覆盖各分支
const USERS_JSON_SAMPLE = JSON.stringify([
  { id: 76303, username: 'vhxubo', name: '归谜', avatar_template: '/user_avatar/linux.do/vhxubo/{size}/2261510_2.png', trust_level: 3 },
  { id: 76303, username: 'vhxubo-dup', name: '' }, // 重复 id → 去重
  { id: 'abc', username: 'noid' }, // 无效 → 跳过
  { id: 76304, username: 'vhxubo-2', name: '' },
  { id: 76305, username: 'vhxubo-3', name: '' },
])

const USERS_JSON_LIVE = JSON.stringify([
  { id: 76303, username: 'vhxubo', name: '归谜' },
  { id: 76304, username: 'vhxubo-2', name: '' },
  { id: 76305, username: 'vhxubo-fail', name: '' }, // mock: username 含 fail → 业务失败
  { id: 76306, username: 'vhxubo-unknown', name: '' }, // mock: username 含 unknown → 状态未知
  { id: 999999, username: 'vhxubo-rich', name: '' }, // mock: 收款人不存在
])

function makeWorld({ storeSeed } = {}) {
  const store = new Map(Object.entries(storeSeed || {}))
  const netlog = []
  const bodies = [] // {url, data}
  const processed = new Set() // 已在上游“落地”但响应丢失的单号
  const menuFns = []

  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://linux.do/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  })
  const w = dom.window

  // jsdom 缺失的 Web API：注入 Node 实现
  try {
    Object.defineProperty(w, 'crypto', { configurable: true, value: webcrypto })
  } catch {}
  if (!w.TextEncoder) w.TextEncoder = TextEncoder
  if (!w.TextDecoder) w.TextDecoder = TextDecoder
  w.URL.createObjectURL = () => 'blob:mock'
  w.URL.revokeObjectURL = () => {}
  const downloads = []
  w.HTMLAnchorElement.prototype.click = function () {
    // 拦截下载：记录 blob 内容
    if (String(this.href).startsWith('blob:')) downloads.push({ name: this.download })
  }

  const GM_xmlhttpRequest = (opts) => {
    netlog.push(opts.method + ' ' + opts.url)
    if (opts.data) bodies.push({ url: opts.url, data: String(opts.data) })
    const respond = (status, text) =>
      w.setTimeout(() => opts.onload && opts.onload({ status, responseText: text }), 25 + Math.random() * 60)
    const netfail = () => w.setTimeout(() => opts.onerror && opts.onerror(new Error('mock network lost')), 30)
    let u
    try {
      u = new w.URL(opts.url)
    } catch {
      return netfail()
    }
    if (u.origin !== 'https://credit.linux.do') return respond(400, '{"error_msg":"harness: unexpected origin"}')
    if (u.pathname === '/epay/api.php') {
      const pid = u.searchParams.get('pid')
      const key = u.searchParams.get('key')
      const otn = u.searchParams.get('out_trade_no') || ''
      if (pid !== 'goodpid' || key !== 'goodsecret') return respond(200, JSON.stringify({ code: -1, msg: '商户信息不存在' }))
      if (otn.startsWith('VERIFY')) return respond(200, JSON.stringify({ code: 0, msg: '订单不存在或已完成' }))
      if (processed.has(otn)) return respond(200, JSON.stringify({ code: 1, msg: 'ok', trade_no: 'MOCKT' + otn.slice(-8) }))
      return respond(200, JSON.stringify({ code: 0, msg: '订单不存在或已完成' }))
    }
    if (u.pathname === '/lpay/distribute' && (opts.method || '').toUpperCase() === 'POST') {
      const auth = (opts.headers && opts.headers.Authorization) || ''
      if (auth !== 'Basic ' + Buffer.from('goodpid:goodsecret').toString('base64'))
        return respond(401, JSON.stringify({ error_msg: '鉴权失败' }))
      let body
      try {
        body = JSON.parse(opts.data)
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
    return respond(404, '404 page not found')
  }

  Object.assign(w, {
    GM_setValue: (k, v) => store.set(k, String(v)),
    GM_getValue: (k) => (store.has(k) ? store.get(k) : undefined),
    GM_deleteValue: (k) => store.delete(k),
    GM_registerMenuCommand: (name, fn) => menuFns.push(fn),
    GM_xmlhttpRequest,
  })

  // 注入全局 crypto 兜底（IIFE 内部引用 crypto）
  w.eval('var crypto = window.crypto; var TextEncoder = window.TextEncoder; var TextDecoder = window.TextDecoder;')
  w.eval(SOURCE)

  const doc = w.document
  const open = () => menuFns[0]()
  const root = () => doc.getElementById('frp-redpacket-host').shadowRoot
  const btn = (text, scope) =>
    [...(scope || root()).querySelectorAll('button')].find((b) => b.textContent.trim() === text)
  const btnIn = (text) => [...root().querySelectorAll('button')].find((b) => b.textContent.includes(text))
  const tab = (name) => root().querySelector(`.frp-tab[data-tab="${name}"]`)
  const id = (i) => root().getElementById(i)
  const batches = () => JSON.parse(store.get('frp_batches_v1') || '[]')

  return { w, dom, store, netlog, bodies, processed, menuFns, open, root, btn, btnIn, tab, id, batches, downloads }
}

async function importRoster(T, json) {
  T.id('frp-paste').value = json
  T.btn('解析并导入').click()
}

async function saveSessionCred(T, pid = 'goodpid', secret = 'goodsecret') {
  T.tab('cred').click()
  const inputs = T.id('frp-sec-cred').querySelectorAll('input.frp-input')
  inputs[0].value = pid
  inputs[0].dispatchEvent(new T.w.Event('input', { bubbles: true }))
  inputs[1].value = secret
  inputs[1].dispatchEvent(new T.w.Event('input', { bubbles: true }))
  T.btnIn('保存到本次会话').click()
}

async function startBatch(T) {
  T.tab('run').click()
  T.btnIn('开始发放').click()
  const modal = T.root().querySelector('.frp-modal-bg')
  const chk = modal.querySelector('input[type=checkbox]')
  chk.click()
  chk.dispatchEvent(new T.w.Event('change', { bubbles: true }))
  T.btn('确认发放', modal).click()
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

const testImportAndQuota = check('名单导入：解析/去重/跳过 + 统一额度 + 单独额度 + 总计', async () => {
  const T = makeWorld()
  T.open()
  assert.ok(T.root(), 'shadow UI 已打开')
  T.tab('roster').click()
  await importRoster(T, USERS_JSON_SAMPLE)
  assert.ok(T.id('frp-importmsg').textContent.includes('已导入 3 人'), '导入 3 人：' + T.id('frp-importmsg').textContent)
  assert.ok(T.id('frp-importmsg').textContent.includes('跳过无效 1'), '跳过无效 1')
  assert.ok(T.id('frp-importmsg').textContent.includes('去重 1'), '按 id 去重 1')
  const rows = T.id('frp-rosterwrap').querySelectorAll('tbody tr')
  assert.equal(rows.length, 3, '表格 3 行')

  // 统一额度
  T.id('frp-uniform').value = '0.66'
  T.btn('应用到已勾选').click()
  await until(() => T.id('frp-rostersum').textContent.includes('1.98'), 3000)
  assert.ok(T.id('frp-rostersum').textContent.includes('合计 1.98 LDC'), '31→3 人 × 0.66 = 1.98')

  // 单独额度：第二行改为 1.234（非法）→ 1.23（合法）
  const secondInput = T.id('frp-rosterwrap').querySelectorAll('tbody tr')[1].querySelector('input:not([type=checkbox])')
  secondInput.value = '1.234'
  secondInput.dispatchEvent(new T.w.Event('change', { bubbles: true }))
  assert.ok(secondInput.className.includes('bad'), '三位小数标记非法')
  secondInput.value = '1.23'
  secondInput.dispatchEvent(new T.w.Event('change', { bubbles: true }))
  await until(() => T.id('frp-rostersum').textContent.includes('2.55'), 3000)
  assert.ok(T.id('frp-rostersum').textContent.includes('合计 2.55 LDC'), '1.98-0.66+1.23=2.55')

  // 搜索过滤
  T.id('frp-search').value = 'vhxubo-2'
  T.id('frp-search').dispatchEvent(new T.w.Event('input', { bubbles: true }))
  assert.equal(T.id('frp-rosterwrap').querySelectorAll('tbody tr').length, 1, '搜索过滤到 1 行')
  T.dom.window.close()
})

const testVerifyBadKey = check('密钥校验：错误密钥提示、正确密钥通过、保存会话', async () => {
  const T = makeWorld()
  T.open()
  await saveSessionCred(T, 'badpid', 'badsecret2')
  // 校验错误密钥
  T.tab('cred').click()
  const inputs = T.id('frp-sec-cred').querySelectorAll('input.frp-input')
  inputs[0].value = 'badpid'
  inputs[0].dispatchEvent(new T.w.Event('input', { bubbles: true }))
  inputs[1].value = 'badsecret'
  inputs[1].dispatchEvent(new T.w.Event('input', { bubbles: true }))
  T.btnIn('校验密钥').click()
  await until(() => T.id('frp-sec-cred').textContent.includes('client_id 或 client_secret 不正确'), 4000)
  // 正确密钥
  inputs[0].value = 'goodpid'
  inputs[0].dispatchEvent(new T.w.Event('input', { bubbles: true }))
  inputs[1].value = 'goodsecret'
  inputs[1].dispatchEvent(new T.w.Event('input', { bubbles: true }))
  T.btnIn('校验密钥').click()
  await until(() => T.id('frp-sec-cred').textContent.includes('密钥校验通过'), 4000)
  T.btnIn('保存到本次会话').click()
  // 头部 pill 更新
  await until(() => T.root().getElementById('frp-keypill').textContent.includes('goo…id'), 2000)
  // 密钥不得出现在任何落盘存储
  for (const [k, v] of T.store) {
    if (k !== 'frp_oplog_v1') assert.ok(!String(v).includes('goodsecret'), 'secret 不落盘: ' + k)
  }
  T.dom.window.close()
})

const testLiveRun = check('实发 mock：成功/业务失败/状态未知 + 查单找回 + 失败重试复用单号', async () => {
  const T = makeWorld()
  T.open()
  await saveSessionCred(T)
  T.tab('roster').click()
  await importRoster(T, USERS_JSON_LIVE)
  T.id('frp-uniform').value = '0.10'
  T.btn('应用到已勾选').click()
  await startBatch(T)

  // 幂等单号先于请求落库：批次创建时 5 行都应有单号（轮询第一刻即查）
  await until(() => T.batches().length > 0, 3000)
  const b0 = T.batches()[0]
  assert.ok(b0.rows.every((r) => /^FRP[0-9A-Za-z]+$/.test(r.outTradeNo)), '单号格式 FRP…')

  await until(() => ['done', 'paused', 'stopped'].includes(T.batches()[0].status), 20000)
  let b = T.batches()[0]
  const row = (name) => T.batches()[0].rows.find((r) => r.username === name)
  assert.equal(row('vhxubo').status, 'success', 'vhxubo 成功')
  assert.ok(/^MOCK/.test(row('vhxubo').tradeNo), 'vhxubo 有交易号')
  assert.equal(row('vhxubo-2').status, 'success', 'vhxubo-2 成功')
  assert.equal(row('vhxubo-fail').status, 'failed', 'vhxubo-fail 失败')
  assert.ok(row('vhxubo-fail').error.includes('余额不足'), '余额不足透出')
  assert.equal(row('vhxubo-unknown').status, 'unknown', 'vhxubo-unknown 待对账')
  assert.equal(row('vhxubo-rich').status, 'failed', 'vhxubo-rich 失败（收款人不存在）')
  assert.ok(b.status === 'paused' || b.status === 'done', '批次暂停/完成')

  // 查单对账：vhxubo-unknown 的单号已在 mock 上游落地 → 补记成功
  T.tab('audit').click()
  T.btnIn('查单对账').click()
  await until(() => row('vhxubo-unknown').status === 'success', 8000)
  assert.ok(/^MOCKT/.test(row('vhxubo-unknown').tradeNo), '对账找回交易号')

  // 失败重试：单号必须复用
  const before = row('vhxubo-fail').outTradeNo
  T.btnIn('重试失败').click()
  await until(() => ['done', 'paused'].includes(T.batches()[0].status) && row('vhxubo-fail').finishedAt > 0, 15000)
  const b2 = T.batches()[0]
  void b
  assert.equal(b2.rows.find((r) => r.username === 'vhxubo-fail').outTradeNo, before, '重试复用原单号')

  // 网络出口审计：全部请求都指向 credit.linux.do 且只有两条路径
  const paths = new Set(T.netlog.map((l) => new URL(l.split(' ')[1]).pathname))
  assert.ok([...paths].every((p) => ['/epay/api.php', '/lpay/distribute'].includes(p)), '仅支付接口: ' + [...paths])
  assert.ok(T.netlog.every((l) => l.includes('credit.linux.do')), '仅 credit.linux.do')
  T.dom.window.close()
})

const testEncryptUnlock = check('密钥加密记住 + 重载解锁 + 错误口令拒绝', async () => {
  const T = makeWorld()
  T.open()
  T.tab('cred').click()
  const inputs = T.id('frp-sec-cred').querySelectorAll('input.frp-input')
  inputs[0].value = 'goodpid'
  inputs[0].dispatchEvent(new T.w.Event('input', { bubbles: true }))
  inputs[1].value = 'goodsecret'
  inputs[1].dispatchEvent(new T.w.Event('input', { bubbles: true }))
  T.btnIn('加密记住到本机').click()
  const modal = T.root().querySelector('.frp-modal-bg')
  modal.querySelector('input').value = 'test-passphrase'
  T.btn('确定', modal).click()
  await until(() => T.store.has('frp_cred_enc_v1'), 5000)
  const enc = JSON.parse(T.store.get('frp_cred_enc_v1'))
  assert.ok(enc.ct && enc.salt && enc.iv, '加密blob存在')
  assert.ok(!JSON.stringify(enc).includes('goodsecret'), '密文不含明文 secret')
  await until(() => T.root().getElementById('frp-keypill').textContent.includes('已就绪'), 2000)
  T.dom.window.close()

  // 模拟重启浏览器：同一存储，新会话
  const T2 = makeWorld({ storeSeed: Object.fromEntries(T.store) })
  T2.open()
  await until(() => T2.root().getElementById('frp-keypill').textContent.includes('加密锁定'), 2000)
  // 错误口令
  T2.tab('cred').click()
  T2.btnIn('解锁密钥').click()
  let m = T2.root().querySelector('.frp-modal-bg')
  m.querySelector('input').value = 'wrong-password'
  T2.btn('确定', m).click()
  await until(() => T2.root().querySelector('.frp-toast')?.className.includes('err'), 5000)
  assert.ok(T2.root().getElementById('frp-keypill').textContent.includes('加密锁定'), '错误口令不解锁')
  // 正确口令
  T2.btnIn('解锁密钥').click()
  m = T2.root().querySelector('.frp-modal-bg')
  m.querySelector('input').value = 'test-passphrase'
  T2.btn('确定', m).click()
  await until(() => T2.root().getElementById('frp-keypill').textContent.includes('已就绪'), 6000)
  T2.dom.window.close()
})

const testInterruptedRecovery = check('中断恢复：running 批次重载后转 paused，sending 转 unknown，继续发放/对账', async () => {
  // 伪造一个“脚本中断”时的落盘状态
  const batchId = 'BTEST01'
  const seed = {
    frp_settings_v1: JSON.stringify({ remark: '粉丝红包', concurrency: 2 }),
    frp_batches_v1: JSON.stringify([
      {
        id: batchId,
        mode: 'live',
        status: 'running',
        createdAt: Date.now() - 60000,
        updatedAt: Date.now() - 30000,
        finishedAt: 0,
        remark: '粉丝红包',
        pid: 'goodpid',
        rows: [
          { id: 76303, username: 'vhxubo', name: '', amountCents: 10, outTradeNo: 'FRPTEST001', status: 'success', tradeNo: 'MOCKA', error: '', finishedAt: 1 },
          { id: 76304, username: 'vhxubo-2', name: '', amountCents: 10, outTradeNo: 'FRPTEST002', status: 'sending', tradeNo: '', error: '', finishedAt: 0 },
          { id: 76305, username: 'vhxubo-fail', name: '', amountCents: 10, outTradeNo: 'FRPTEST003', status: 'pending', tradeNo: '', error: '', finishedAt: 0 },
        ],
        events: [],
      },
    ]),
  }
  const T = makeWorld({ storeSeed: seed })
  T.open()
  await until(() => T.batches()[0].status === 'paused', 4000)
  const b = T.batches()[0]
  assert.equal(b.rows[1].status, 'unknown', 'sending → unknown')
  assert.ok(b.rows[1].error.includes('中断'), '标注中断')

  // 继续：pending 行正常发出（无密钥时会被拦截 → 先注入会话密钥）
  await saveSessionCred(T)
  T.tab('run').click()
  T.btnIn('继续发放').click()
  await until(() => T.batches()[0].rows[2].status === 'failed', 12000) // vhxubo-fail → 余额不足
  // 对账 unknown：vhxubo-2 的单号未在 mock 落地 → failed（未落地）
  T.tab('audit').click()
  T.btnIn('查单对账').click()
  await until(() => T.batches()[0].rows[1].status === 'failed', 8000)
  assert.ok(T.batches()[0].rows[1].error.includes('未落地'), '查单确认未落地')
  T.dom.window.close()
})

const testAuditExportClear = check('审计：批次明细/操作日志/导出/删除', async () => {
  const T = makeWorld()
  T.open()
  await saveSessionCred(T)
  T.tab('roster').click()
  await importRoster(T, JSON.stringify([{ id: 76303, username: 'vhxubo', name: '归谜' }]))
  T.id('frp-uniform').value = '0.05'
  T.btn('应用到已勾选').click()
  await startBatch(T)
  await until(() => ['done', 'paused'].includes(T.batches()[0].status), 12000)
  T.tab('audit').click()
  assert.ok(T.id('frp-sec-audit').textContent.includes('vhxubo'), '批次明细含用户')
  assert.ok(T.id('frp-sec-audit').textContent.includes('batch.start'), '事件流水')
  assert.ok(T.id('frp-sec-audit').textContent.includes('roster.import'), '操作日志')
  // 导出
  T.btnIn('导出全部审计 JSON').click()
  await until(() => T.downloads.length > 0, 3000)
  assert.ok(T.downloads[0].name.includes('审计'), '导出文件名')
  // 删除批次（确认框）
  T.btnIn('删除该批次记录').click()
  const modal = T.root().querySelector('.frp-modal-bg')
  T.btn('确定', modal).click()
  await until(() => T.batches().length === 0, 3000)
  T.dom.window.close()
})

const testUnknownBlocksNewBatch = check('存在待对账记录时禁止开新批次', async () => {
  const T = makeWorld()
  T.open()
  await saveSessionCred(T)
  T.tab('roster').click()
  await importRoster(T, USERS_JSON_LIVE)
  T.id('frp-uniform').value = '0.10'
  T.btn('应用到已勾选').click()
  await startBatch(T)
  await until(() => T.batches()[0].rows.some((r) => r.status === 'unknown'), 20000)
  await until(() => T.batches()[0].status !== 'running', 20000)
  T.tab('run').click()
  const startBtn = T.btnIn('开始发放')
  assert.equal(startBtn.disabled, true, '开始发放被禁用')
  assert.ok(T.id('frp-sec-run').textContent.includes('待对账'), '提示先对账')
  T.dom.window.close()
})

// 防回归：弹窗/toast 必须盖过主面板遮罩，悬浮按钮必须在其下（jsdom 不算层叠，这里静态断言 CSS 数值）
const testModalLayering = check('弹窗层级：modal/toast > 面板遮罩 > 悬浮按钮', async () => {
  const cssPanel = SOURCE.match(/const CSS = `([\s\S]*?)`/)[1]
  const cssLauncher = SOURCE.match(/const LAUNCHER_CSS = `([\s\S]*?)`/)[1]
  const zx = (css, sel) => {
    const m = css.match(new RegExp(sel.replace('.', '\\.') + '\\{[^}]*?z-index:(\\d+)'))
    assert.ok(m, sel + ' 存在 z-index')
    return parseInt(m[1], 10)
  }
  const overlay = zx(cssPanel, '.frp-overlay')
  const modal = zx(cssPanel, '.frp-modal-bg')
  const toast = zx(cssPanel, '.frp-toast')
  const launch = zx(cssLauncher, '.frp-launch')
  assert.ok(modal > overlay, `确认弹窗(${modal}) 必须高于面板遮罩(${overlay})，否则弹窗被遮挡且点击会误关面板`)
  assert.ok(toast > overlay, `面板内 toast(${toast}) 必须高于面板遮罩(${overlay})`)
  assert.ok(overlay > launch, `面板遮罩(${overlay}) 应盖过悬浮按钮(${launch})`)
  assert.ok(modal >= 2_000_000_000, `弹窗层级(${modal}) 应远高于站点 UI`)
})

const tests = [
  ['导入与额度', testImportAndQuota],
  ['弹窗层级', testModalLayering],
  ['密钥校验', testVerifyBadKey],
  ['实发与对账', testLiveRun],
  ['加密记住与解锁', testEncryptUnlock],
  ['中断恢复', testInterruptedRecovery],
  ['审计导出删除', testAuditExportClear],
  ['待对账拦截', testUnknownBlocksNewBatch],
]

console.log('== E2E 开始 ==')
for (const [name, fn] of tests) {
  console.log('▶', name)
  await fn()
}
const failed = results.filter(([s]) => s === 'FAIL')
console.log(`\n== 结果: ${results.length - failed.length}/${results.length} 通过 ==`)
for (const [s, name, msg] of failed) console.log('FAIL:', name, '\n', msg)
process.exit(failed.length ? 1 : 0)
