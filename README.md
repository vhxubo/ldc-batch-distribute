# LDC 批量分发 🧧

名单来源自由（粘贴 id/username JSON、整份 /u/用户名.json、按用户名查询添加、快捷键 Alt+F 一键拉取我的粉丝）→ 统一/单独设置额度 → 通过你自己的 [credit.linux.do](https://credit.linux.do)（LDC）商户密钥**批量打款**。

- **无后端业务、无登录、无数据库**：名单、额度、批次审计全部存本机浏览器，可随时导出
- **除 LDC 支付接口与 linux.do 同源名单接口（用户脚本版专享）外零网络请求**，且出口白名单在浏览器（CSP）与部署层强制
- **资金安全**：单号幂等（先落库再打款、重试复用单号、状态未知必须查单对账）、防重复发放
- **全程可审计**：名单快照、逐笔单号/交易号、事件流水、操作日志，支持导出 CSV / JSON

## 两种形态

| | 🌐 网页版 `index.html` | 🐒 用户脚本 `ldc-batch-distribute.user.js` |
|---|---|---|
| 部署 | GitHub Pages / 任意静态托管 + 自部署 Cloudflare Worker 中继 | Tampermonkey 安装即用 |
| 额外组件 | Worker 中继（约 40 行，无状态无存储，见 `worker/`） | 无 |
| 适合 | 想要独立网页、不想装油猴 | 只在自己浏览器里用、零部署 |

两者业务逻辑完全一致（网页版由用户脚本经 `tools/derive-web-page.py` 派生），数据互不相通、各自存本机。

## 为什么网页版需要一个中继

`credit.linux.do` 的 API **不支持 CORS**（实测 `OPTIONS /lpay/distribute` 返回 404，响应无 `Access-Control-Allow-Origin`），浏览器里的静态网页无论部署在哪都无法直连打款接口——这是浏览器安全边界，不是实现选择。

因此网页版经你**自部署的透传中继**访问（`worker/worker.mjs`）：

- 只放行 `/lpay/distribute` 与 `/epay/api.php` 两个路径，其余一律 404
- 无状态、无存储、无日志：不落任何数据，密钥头原样透传、中继不解析
- 代码 40 行公开可审计，部署在你自己的 Cloudflare 账户
- 可选 `SHARED_TOKEN` 中继口令防止他人盗用，`ALLOW_ORIGIN` 限定页面来源

> ⚠️ 不要使用第三方公共 CORS 代理：那会把你的商户密钥暴露给代理运营方。

## 网页版部署（约 5 分钟）

**第 1 步：部署中继 Worker（Cloudflare 免费层）**

```bash
cd worker
npx wrangler login
npx wrangler deploy
# 建议配置（防止他人盗用你的中继）：
npx wrangler secret put SHARED_TOKEN          # 输入一个自定义口令
npx wrangler deploy --var ALLOW_ORIGIN:https://你的用户名.github.io
```

记下 Worker 地址（形如 `https://ldc-redpacket-relay.你的子域.workers.dev`）。

**第 2 步：GitHub Pages 部署页面**

把本仓库推送到 GitHub（`index.html` 在仓库根），仓库 Settings → Pages → Branch 选 `main` / `(root)`。几分钟后得到 `https://你的用户名.github.io/仓库名/`。

> 页面 CSP 已把网络出口锁定为「本页 + `*.workers.dev`」。若你给 Worker 绑定自定义域名，请编辑 `index.html` 顶部 CSP 注释处的 `connect-src`。

**第 3 步：页面配置**

打开页面 → 「密钥设置」→ 填入中继地址（与可选中继口令）→ 填入 credit 商户 `client_id` / `client_secret` → 「校验密钥」（零成本）→ 「保存到本次会话」或「加密记住到本机」。

本地调试：`python3 -m http.server 8000` 后访问 `http://localhost:8000`（Worker 可用 `cd worker && npx wrangler dev`，中继地址填 `http://localhost:8787`）。

## 用户脚本版安装

Tampermonkey → 新建脚本 → 粘贴 `ldc-batch-distribute.user.js` 全文保存 → 打开任意 linux.do 页面 → Tampermonkey 菜单 → 「🧧 批量分发」。

## 使用流程（两版一致）

1. **密钥**：在 credit.linux.do 用户中心创建商户 API 密钥；网页版还需填中继地址
2. **名单与额度**：粘贴用户 JSON（必需 `id`、`username` 字段；支持数组 / `{users:[…]}` / 整份 /u/用户名.json / 单个用户对象）→ 解析导入；或在输入框按用户名查询添加（同源接口自动补 id）；油猴版可 Alt+F 一键拉取我的粉丝 → 「统一额度」批量填充，或在每行输入框为**单个用户设置不同额度**；可勾选/取消、搜索过滤
3. **发放**：核对人数与总额 → 确认。可选「演练模式」**零网络请求**预演全流程；实发可暂停/停止/继续
4. **审计**：逐笔结果与事件流水；失败可重试（复用原单号）；「待对账」逐笔或批量查单定性；导出 CSV / JSON；存在待对账记录时禁止开新批次

## 安全模型

| 项目 | 做法 |
|---|---|
| 密钥存储 | 默认**仅内存**（刷新即失）；可选「加密记住」：口令 PBKDF2-SHA256（310k）派生 AES-256-GCM 密钥加密后落盘；保存会话后 secret 输入框自动清空，审计/导出永不包含密钥 |
| 密钥传输 | 仅随请求发往 credit.linux.do（网页版经你自部署中继透传，中继不解析、不存储）；用户脚本版由 `@connect credit.linux.do` 白名单强制 |
| 网络出口 | 网页版 CSP `connect-src 'self' https://*.workers.dev` 浏览器层强制；无统计、无 CDN、无头像加载（头像为本机生成的色块）、无字体/样式外链；页面本身即全部代码，公开可审计 |
| 重复打款防护 | 幂等单号先于请求落盘、重试复用；网络异常/非 JSON 响应记「待对账」绝不自动重发，必须查单定性（已落地补记成功、未落地转失败）；待对账未清零禁止开新批次 |
| 金额 | 以「分」整数计算（避免浮点误差），最多两位小数，单笔上限 100 万 LDC |
| 中继滥用 | `SHARED_TOKEN` 口令 + `ALLOW_ORIGIN` 来源限定（可选，推荐） |

## 本地开发与测试

```bash
npm install
npm test          # 三套测试：用户脚本 e2e + 网页版 e2e + Worker 单测（全部 mock，无真实网络）
npm run build:web # 修改用户脚本后，重新派生网页版 index.html
```

- `test/e2e.test.mjs` — 用户脚本版 jsdom 端到端（GM stub + mock credit 接口），8 项
- `test/e2e.web.test.mjs` — 网页版 jsdom 端到端（fetch mock + localStorage + 中继契约），11 项
- `test/worker.test.mjs` — Worker 单测（透传/CORS/路径与方法白名单/口令），7 项
- `test/harness.html` — 浏览器手工调试 harness（GM stub + mock 接口，静态服务后打开）

覆盖：名单解析/去重/跳过、统一与单独额度、中继配置校验与口令、密钥校验（好/坏）、secret 不落盘、演练零网络、mock 实发（成功/余额不足/收款人不存在/断网未知）、查单找回、重试复用单号、口令头、加密记住与解锁/错误口令拒绝、中断恢复、审计导出删除、待对账与缺中继拦截。

## 注意事项

- 请勿在多个标签页同时发放；打款即时到账、不可撤销，发放前务必核对总额
- 实发前建议先给自己转 0.01 LDC 验证链路；「演练模式」不产生任何请求与扣款
- 审计批次本机最多留存 50 个（超出自动清理最旧），需要长期留存请导出 JSON
