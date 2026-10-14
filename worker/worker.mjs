/**
 * LDC 支付中继（Cloudflare Worker）—— 透传代理
 *
 * credit.linux.do 不允许浏览器跨域直连（无 CORS：OPTIONS 预检 404、响应无
 * Access-Control-Allow-Origin），因此 GitHub Pages 上的静态网页需要一个中继。
 *
 * 设计原则（无后端化）：
 *   - 无状态、无存储、无日志：不落任何数据库/KV，不记录请求与密钥
 *   - 仅放行支付接口两个路径（/lpay/distribute、/epay/api.php），其余一律 404
 *   - 请求头按原样透传（Authorization / Content-Type 由浏览器 → credit.linux.do），
 *     中继不解析、不修改鉴权信息
 *   - 可选环境变量：
 *       SHARED_TOKEN  中继口令：设置后要求请求头 x-frp-token 匹配，防止他人盗用你的中继
 *       ALLOW_ORIGIN  允许的页面来源（CORS Origin），如 https://yourname.github.io；默认 *
 *
 * 部署：cd worker && npx wrangler deploy
 * 口令：npx wrangler secret put SHARED_TOKEN
 */

const UPSTREAM = 'https://credit.linux.do'

// 逐跳头 / 与客户端相关头：不向上游转发
const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te',
  'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
  'accept-encoding', 'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor',
  'cf-worker', 'cf-ew-via', 'true-client-ip', 'x-forwarded-for', 'x-forwarded-proto',
  'x-forwarded-host', 'x-real-ip', 'cdn-loop', 'x-frp-token',
])

const ALLOWED_PATHS = new Set(['/lpay/distribute', '/epay/api.php'])

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOW_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, x-frp-token',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const cors = corsHeaders(env)

    if (!ALLOWED_PATHS.has(url.pathname)) {
      return new Response(JSON.stringify({ error_msg: 'relay: not found' }), {
        status: 404,
        headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }
    if (request.method !== 'GET' && request.method !== 'POST' && request.method !== 'OPTIONS') {
      return new Response(JSON.stringify({ error_msg: 'relay: method not allowed' }), {
        status: 405,
        headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }
    if (env.SHARED_TOKEN && request.headers.get('x-frp-token') !== env.SHARED_TOKEN) {
      return new Response(JSON.stringify({ error_msg: 'relay: 中继口令不正确' }), {
        status: 403,
        headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors })
    }

    // 透传：方法、路径、查询串、头（去逐跳头）、请求体
    const headers = new Headers()
    for (const [k, v] of request.headers) {
      if (!HOP_HEADERS.has(k.toLowerCase())) headers.set(k, v)
    }
    const body = request.method === 'POST' ? await request.text() : undefined
    const upstream = await fetch(UPSTREAM + url.pathname + url.search, {
      method: request.method,
      headers,
      body,
    })
    const respBody = await upstream.text()
    const respHeaders = new Headers(cors)
    const ct = upstream.headers.get('content-type')
    if (ct) respHeaders.set('Content-Type', ct)
    return new Response(respBody, { status: upstream.status, headers: respHeaders })
  },
}
