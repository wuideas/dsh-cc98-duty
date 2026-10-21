/**
 * selfcheck.mjs —— 不启动 DSH、用假 ctx 跑一遍 host 半端
 * ============================================================================
 * 验证：插件能被 apply、工具都注册上了、读接口真能打到 98、写闸门拦得住、
 *      设置页那几条 HTTP 路由返回正常。（不发任何写请求。）
 *
 * 跑法（本机）：
 *   $env:DSH_DESKTOP_NODE_EXECUTABLE='C:\Users\<你>\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe'
 *   & 'C:\Users\<你>\AppData\Local\Programs\DeepSeek Harness\resources\runtime\bin\node.cmd' .\selfcheck.mjs
 * ============================================================================
 */
import { join } from 'node:path'
import { homedir } from 'node:os'

const pass = []
const fail = []
const ok = (name, extra = '') => { pass.push(name); console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`) }
const bad = (name, e) => { fail.push(name + ': ' + (e?.message ?? e)); console.log(`  ❌ ${name} — ${e?.message ?? e}`) }

const mod = await import('./index.js')

// ---------- 假宿主 ----------
const tools = new Map()
const routes = []
const ctx = {
  get: (k) => (k === 'dshHomePath' ? (...seg) => join(homedir(), '.dsh', ...seg) : undefined),
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  tools: { register: (t) => { tools.set(t.name, t); return t } },
  webServer: { register: (def) => { routes.push(def); return () => {} } },
  settings: {
    describe: () => [],
    update: async () => { throw new Error('selfcheck：没有宿主设置表单') },
  },
  effect: (fn) => { const d = fn(); return () => { try { d?.() } catch { /* ignore */ } } },
}

console.log('\n== 1. apply ==')
try {
  mod.apply(ctx, { enabled: true })
  ok('apply 不抛')
} catch (e) { bad('apply', e); process.exit(1) }

console.log('\n== 2. 工具注册 ==')
const want = ['cc98_status', 'cc98_whoami', 'cc98_front', 'cc98_topic', 'cc98_board', 'cc98_new', 'cc98_search',
  'cc98_boards', 'cc98_presets', 'cc98_config', 'cc98_login', 'cc98_create_topic', 'cc98_reply', 'cc98_quote_reply']
const missing = want.filter((n) => !tools.has(n))
if (missing.length) bad('工具齐不齐', new Error('缺：' + missing.join(', ')))
else ok('14 个工具都在', [...tools.keys()].join(', '))
ok('Config 导出', mod.Config ? '有' : '无（schemastery 没拿到，设置页降级）')

const call = async (name, args = {}) => {
  const t = tools.get(name)
  if (!t) throw new Error('没这个工具：' + name)
  return await t.execute(args, {})
}

console.log('\n== 3. 读接口（真打 98） ==')
let status
try { status = await call('cc98_status') ; ok('cc98_status', `network=${status.network} token=${status.token} user=${status.user?.name ?? '-'}`) } catch (e) { bad('cc98_status', e) }
try {
  const f = await call('cc98_front')
  ok('cc98_front', `热门 ${f['热门']?.length ?? 0} 条，第一个：${f['热门']?.[0]?.title ?? '-'}`)
} catch (e) { bad('cc98_front', e) }
try {
  const t = await call('cc98_topic', { id: 6666881, posts: 2 })
  ok('cc98_topic', `${t.title}（${t.posts?.length ?? 0} 楼）`)
} catch (e) { bad('cc98_topic', e) }
try {
  const b = await call('cc98_boards', { keyword: '学习' })
  ok('cc98_boards', `匹配 ${b.count} 个版面`)
} catch (e) { bad('cc98_boards', e) }
try {
  const s = await call('cc98_search', { keyword: '保研', size: 3 })
  ok('cc98_search', `${s.count} 条`)
} catch (e) { bad('cc98_search', e) }

console.log('\n== 4. 预设 ==')
try {
  const p = await call('cc98_presets', { action: 'list' })
  ok('cc98_presets/list', `${p.presets?.length ?? 0} 个：${(p.presets || []).map((x) => x.name).join(', ')}`)
  const g = await call('cc98_presets', { action: 'get', name: 'duty' })
  if (!g.content || g.content.length < 100) throw new Error('duty 预设内容太短')
  ok('cc98_presets/get', `duty ${g.content.length} 字`)
} catch (e) { bad('cc98_presets', e) }
try {
  const c = await call('cc98_config', { action: 'get' })
  ok('cc98_config/get', `writeEnabled=${c.config?.writeEnabled}`)
} catch (e) { bad('cc98_config/get', e) }

console.log('\n== 5. 写闸门（不该真发） ==')
try {
  const r = await call('cc98_create_topic', { boardId: 68, title: 'selfcheck 不该发出去', content: 'test' })
  if (r.blocked && r.ok === false) ok('写闸门拦住发帖', r.hint?.slice(0, 40) + '…')
  else bad('写闸门拦住发帖', new Error('居然没拦住：' + JSON.stringify(r).slice(0, 120)))
} catch (e) { bad('写闸门拦住发帖', e) }
try {
  const r = await call('cc98_reply', { topicId: 6666881, content: 'test' })
  if (r.blocked) ok('写闸门拦住回帖')
  else bad('写闸门拦住回帖', new Error('没拦住'))
} catch (e) { bad('写闸门拦住回帖', e) }
try {
  const r = await call('cc98_quote_reply', { topicId: 6666881, postId: 1, content: 'test' })
  if (r.blocked) ok('写闸门拦住引用回复')
  else bad('写闸门拦住引用回复', new Error('没拦住'))
} catch (e) { bad('写闸门拦住引用回复', e) }

console.log('\n== 6. 设置页 HTTP 路由 ==')
const hit = async (method, path, body) => {
  const def = routes.find((r) => r.path === '/api/cc98-duty')
  if (!def) throw new Error('路由没注册')
  const req = {
    method,
    url: 'http://127.0.0.1' + path,
    on: (ev, fn) => {
      if (ev === 'data') { if (body !== undefined) fn(Buffer.from(JSON.stringify(body))) }
      if (ev === 'end') { if (body !== undefined) fn() ; else fn() }
    },
  }
  // 上面的 on 简化版：手工触发 data/end
  const listeners = {}
  req.on = (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn) }
  const res = { statusCode: 0, body: null, setHeader() {}, end(s) { this.body = JSON.parse(s) } }
  const p = def.handler(req, res)
  if (body !== undefined) { for (const fn of listeners['data'] || []) fn(Buffer.from(JSON.stringify(body))) }
  for (const fn of listeners['end'] || []) fn()
  await p
  return res.body
}
for (const [m, p] of [['GET', '/api/cc98-duty/status'], ['GET', '/api/cc98-duty/config'], ['GET', '/api/cc98-duty/presets'],
  ['GET', '/api/cc98-duty/preset?name=duty'], ['POST', '/api/cc98-duty/test']]) {
  try {
    const r = await hit(m, p, m === 'POST' ? {} : undefined)
    if (r && r.ok === true) ok(`${m} ${p}`, Object.keys(r).slice(0, 6).join(','))
    else bad(`${m} ${p}`, new Error(JSON.stringify(r).slice(0, 160)))
  } catch (e) { bad(`${m} ${p}`, e) }
}

console.log(`\n=== 结果：${pass.length} 过 / ${fail.length} 挂 ===`)
if (fail.length) { console.log('失败项：'); for (const f of fail) console.log(' - ' + f); process.exit(2) }
