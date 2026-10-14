/**
 * Worker 单元测试：Node ≥ 18 原生 Request/Response/fetch 全局，无需模拟环境。
 * 运行：node test/worker.test.mjs
 */
import assert from 'node:assert'

const worker = (await import('../worker/worker.mjs')).default

// 捕获 worker 发往上游的请求
let upstreamCalls = []
const realFetch = globalThis.fetch
function mockUpstream(fn) {
  upstreamCalls = []
  globalThis.fetch = async (url, init) => {
    const call = { url: String(url), method: init?.method, headers: init?.headers, body: init?.body }
    upstreamCalls.push(call)
    return fn ? fn(call) : new Response('{"code":1,"data":{"trade_no":"MOCK123"}}', { status: 200, headers: { 'content-type': 'application/json' } })
  }
}
globalThis.fetch = realFetch

const results = []
async function check(name, fn) {
  try {
    await fn()
    results.push(true)
    console.log('  ✓ PASS', name)
  } catch (e) {
    results.push(false)
    console.log('  ✗ FAIL', name, '\n    ', e.message)
  }
}

await check('OPTIONS 预检：204 + CORS 头', async () => {
  const req = new Request('https://relay.workers.dev/lpay/distribute', { method: 'OPTIONS' })
  const res = await worker.fetch(req, {})
  assert.equal(res.status, 204)
  assert.equal(res.headers.get('access-control-allow-origin'), '*')
  assert.equal(res.headers.get('access-control-allow-headers'), 'Authorization, Content-Type, x-frp-token')
  assert.equal(res.headers.get('access-control-max-age'), '86400')
})

await check('路径白名单：其他路径一律 404', async () => {
  for (const p of ['/', '/api.php', '/lpay/other', '/admin']) {
    const res = await worker.fetch(new Request('https://relay.workers.dev' + p, { method: 'GET' }), {})
    assert.equal(res.status, 404, p)
  }
})

await check('方法白名单：DELETE 405', async () => {
  const res = await worker.fetch(new Request('https://relay.workers.dev/epay/api.php', { method: 'DELETE' }), {})
  assert.equal(res.status, 405)
})

await check('POST /lpay/distribute：透传方法/路径/头/体，响应带 CORS', async () => {
  mockUpstream()
  const req = new Request('https://relay.workers.dev/lpay/distribute', {
    method: 'POST',
    headers: {
      Authorization: 'Basic Z29vZHBpZDpnb29kc2VjcmV0',
      'Content-Type': 'application/json',
      'x-frp-token': 'tok-123',
      'cf-connecting-ip': '1.2.3.4',
    },
    body: JSON.stringify({ user_id: 6799, username: 'gjkldsjgjlkf', amount: '0.66', out_trade_no: 'FRPX', remark: '粉丝红包' }),
  })
  const res = await worker.fetch(req, { ALLOW_ORIGIN: 'https://me.github.io' })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://me.github.io')
  assert.equal(res.headers.get('content-type'), 'application/json')
  assert.equal(await res.text(), '{"code":1,"data":{"trade_no":"MOCK123"}}')
  assert.equal(upstreamCalls.length, 1)
  const call = upstreamCalls[0]
  assert.equal(call.url, 'https://credit.linux.do/lpay/distribute')
  assert.equal(call.method, 'POST')
  assert.equal(call.headers.get('authorization'), 'Basic Z29vZHBpZDpnb29kc2VjcmV0')
  assert.equal(call.headers.get('content-type'), 'application/json')
  assert.equal(call.headers.get('x-frp-token'), null, '口令头不透传')
  assert.equal(call.headers.get('cf-connecting-ip'), null, 'CF 注入头不透传')
  assert.ok(call.body.includes('"user_id":6799'))
})

await check('GET /epay/api.php：查询串透传', async () => {
  mockUpstream()
  const req = new Request('https://relay.workers.dev/epay/api.php?act=order&pid=goodpid&key=goodsecret&out_trade_no=VERIFYX')
  const res = await worker.fetch(req, {})
  assert.equal(res.status, 200)
  assert.equal(upstreamCalls[0].url, 'https://credit.linux.do/epay/api.php?act=order&pid=goodpid&key=goodsecret&out_trade_no=VERIFYX')
  assert.equal(upstreamCalls[0].method, 'GET')
  assert.equal(upstreamCalls[0].body, undefined)
})

await check('SHARED_TOKEN：缺/错 403，对则放行', async () => {
  mockUpstream()
  const url = 'https://relay.workers.dev/lpay/distribute'
  const base = { method: 'POST', headers: { Authorization: 'Basic x', 'Content-Type': 'application/json' }, body: '{}' }
  let res = await worker.fetch(new Request(url, base), { SHARED_TOKEN: 'tok-123' })
  assert.equal(res.status, 403)
  res = await worker.fetch(new Request(url, { ...base, headers: { ...base.headers, 'x-frp-token': 'wrong' } }), { SHARED_TOKEN: 'tok-123' })
  assert.equal(res.status, 403)
  res = await worker.fetch(new Request(url, { ...base, headers: { ...base.headers, 'x-frp-token': 'tok-123' } }), { SHARED_TOKEN: 'tok-123' })
  assert.equal(res.status, 200)
})

await check('上游错误状态原样透传', async () => {
  mockUpstream(() => new Response('{"error_msg":"余额不足"}', { status: 200, headers: { 'content-type': 'application/json' } }))
  const res = await worker.fetch(new Request('https://relay.workers.dev/epay/api.php?act=order&pid=1&key=2&out_trade_no=3'), {})
  assert.equal(res.status, 200)
  assert.ok((await res.text()).includes('余额不足'))
})

const failed = results.filter((x) => !x).length
console.log(`\n== worker 测试: ${results.length - failed}/${results.length} 通过 ==`)
process.exit(failed ? 1 : 0)
