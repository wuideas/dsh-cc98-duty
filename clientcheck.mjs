/**
 * clientcheck.mjs —— 把 browser 半端（client.js）真的挂起来跑一遍
 * ============================================================================
 * GUI 里的设置页我（AI）看不到，所以这里造一个最小的「假浏览器」：
 *   · 假 React（useState / useEffect / useRef / createElement）—— 能触发重渲染
 *   · 假 document（只够 client.js 注册样式与挂载）
 *   · 假 window.__ModuleLoader__（client bundle 的自注册入口）
 *   · fetch 直接接到本插件**真**的 /api/cc98-duty 路由（index.js 的 handler）
 * 然后：挂载 → 等 effect 拉数据 → 检查页面文案 → 真点按钮（测试连接 / 写闸门开关）→ 校验结果。
 *
 * ⚠️ 最后会把 writeEnabled 恢复成 false（绝不留下开着的写闸门）。
 *
 * 跑法：
 *   $env:DSH_DESKTOP_NODE_EXECUTABLE='...\DeepSeek Harness.exe'
 *   & '...\node.cmd' .\clientcheck.mjs
 * ============================================================================
 */
import { join } from 'node:path'
import { homedir } from 'node:os'

const pass = []
const fail = []
const ok = (n, e = '') => { pass.push(n); console.log(`  ✅ ${n}${e ? ' — ' + e : ''}`) }
const bad = (n, e) => { fail.push(n + ': ' + (e?.message ?? e)); console.log(`  ❌ ${n} — ${e?.message ?? e}`) }

/* ─────────────── 1. host 半端：真路由 ─────────────── */
const host = await import('./index.js')
const tools = new Map()
const routes = []
const hostCtx = {
  get: (k) => (k === 'dshHomePath' ? (...seg) => join(homedir(), '.dsh', ...seg) : undefined),
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  tools: { register: (t) => { tools.set(t.name, t); return t } },
  webServer: { register: (d) => { routes.push(d); return () => {} } },
  settings: { describe: () => [], update: async () => { throw new Error('no-host') } },
  effect: (fn) => { const d = fn(); return () => { try { d?.() } catch { /* ignore */ } } },
}
host.apply(hostCtx, { enabled: true })
const route = routes.find((r) => r.path === '/api/cc98-duty')
if (!route) { console.error('宿主路由没注册'); process.exit(1) }

/* ─────────────── 2. 假浏览器环境 ─────────────── */
class Emitter {
  constructor() { this.l = {} }
  on(ev, fn) { (this.l[ev] = this.l[ev] || []).push(fn); return this }
  emit(ev, ...a) { for (const fn of this.l[ev] || []) fn(...a); return this }
}

const realFetch = globalThis.fetch.bind(globalThis)
const fakeFetch = (input, init = {}) => new Promise((resolve, reject) => {
  const url = String(input)
  // 插件自己的路由 → 打进真的 host 半端；其余（api.cc98.org / openid）→ 放行给真 fetch
  if (!url.includes('/api/cc98-duty')) return realFetch(input, init).then(resolve, reject)
  const req = new Emitter()
  req.method = String(init.method || 'GET').toUpperCase()
  req.url = 'http://127.0.0.1' + url.slice(url.indexOf('/api'))
  req.headers = init.headers || {}
  let statusCode = 200
  let ended = false
  const res = {
    get statusCode() { return statusCode },
    set statusCode(v) { statusCode = v },
    setHeader() {},
    end(s) {
      if (ended) return
      ended = true
      const bodyText = s === undefined || s === null ? '' : String(s)
      let body = {}
      try { body = bodyText ? JSON.parse(bodyText) : {} } catch { body = { ok: false, error: bodyText.slice(0, 200) } }
      resolve({
        ok: statusCode < 400,
        status: statusCode,
        async text() { return bodyText },
        async json() { return body },
      })
    },
  }
  const p = Promise.resolve(route.handler(req, res)).catch(reject)
  queueMicrotask(() => {
    if (init.body !== undefined && init.body !== null) req.emit('data', String(init.body))
    req.emit('end')
  })
  p.catch(() => { /* handler 内部已兜底 */ })
})

const styleEls = []
const makeEl = (tag) => ({
  tagName: tag, attrs: {}, textContent: '', children: [],
  setAttribute(k, v) { this.attrs[k] = v },
  appendChild(c) { this.children.push(c); return c },
  remove() { const i = styleEls.indexOf(this); if (i >= 0) styleEls.splice(i, 1) },
})
const fakeDocument = {
  head: makeEl('head'),
  createElement: (t) => { const el = makeEl(t); styleEls.push(el); return el },
}
let confirmAnswer = true
const fakeWindow = { confirm: () => confirmAnswer }

/* ─────────────── 3. 假 React（够 client.js 用） ─────────────── */
let rerenderRequested = false
let currentInstance = null
let effectsToRun = []
let rootInst = null            // ⭐ Panel 的实例要跨渲染保留（状态在这）

const newInst = () => ({ hooks: [], cursor: 0 })

const React = {
  createElement(type, props, ...children) {
    const kids = children.flat(Infinity).filter((c) => c !== undefined && c !== null && c !== false)
    return { type, props: { ...(props || {}), children: kids.length === 0 ? undefined : kids.length === 1 ? kids[0] : kids } }
  },
  useState(init) {
    const inst = currentInstance
    if (!inst) throw new Error('useState 在组件外被调用')
    const i = inst.cursor++
    if (!(i in inst.hooks)) inst.hooks[i] = typeof init === 'function' ? init() : init
    const set = (v) => {
      inst.hooks[i] = typeof v === 'function' ? v(inst.hooks[i]) : v
      rerenderRequested = true
    }
    return [inst.hooks[i], set]
  },
  useRef(init) {
    const inst = currentInstance
    if (!inst) throw new Error('useRef 在组件外被调用')
    const i = inst.cursor++
    if (!(i in inst.hooks)) inst.hooks[i] = { current: init }
    return inst.hooks[i]
  },
  useEffect(fn, deps) {
    const inst = currentInstance
    if (!inst) throw new Error('useEffect 在组件外被调用')
    const i = inst.cursor++
    const prev = inst.hooks[i]
    const changed = !prev || !deps || deps.length !== prev.deps.length || deps.some((d, j) => !Object.is(d, prev.deps[j]))
    if (changed) {
      const rec = { deps, fn }
      inst.hooks[i] = rec
      effectsToRun.push(rec)
    }
  },
}

/* 递归渲染：函数组件就地调用（嵌套组件无 hooks，给临时实例）；返回展开后的树 */
function render(node) {
  if (node === null || node === undefined || node === false || node === true) return null
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(render).flat(Infinity).filter((c) => c !== null && c !== undefined)
  if (typeof node.type === 'function') {
    const prev = currentInstance
    currentInstance = newInst()
    currentInstance.cursor = 0
    let out
    try { out = node.type(node.props || {}) } finally { currentInstance = prev }
    return render(out)
  }
  const kids = node.props && node.props.children !== undefined ? render(node.props.children) : []
  return { type: node.type, props: node.props || {}, children: kids }
}

/** 渲染根（Panel）：实例跨次保留，state 不丢 */
function renderRoot() {
  if (!rootInst) rootInst = newInst()
  const el = reg.comp()
  const panelFn = el.type
  const prev = currentInstance
  currentInstance = rootInst
  rootInst.cursor = 0
  let out
  try { out = panelFn(el.props || {}) } finally { currentInstance = prev }
  return render(out)
}

const flush = async (rounds = 10) => {
  for (let r = 0; r < rounds; r++) {
    while (effectsToRun.length) {
      const rec = effectsToRun.shift()
      try { await rec.fn() } catch { /* 页面 effect 自己兜错 */ }
    }
    await new Promise((res) => setTimeout(res, 80))
    if (!rerenderRequested) break
    rerenderRequested = false
    tree = renderRoot()
  }
}

const texts = (node, out = []) => {
  if (node === null || node === undefined) return out
  if (typeof node === 'string') { out.push(node); return out }
  if (Array.isArray(node)) { for (const n of node) texts(n, out); return out }
  texts(node.children, out)
  return out
}
const findByKey = (node, key) => {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) { for (const n of node) { const f = findByKey(n, key); if (f) return f } return null }
  if (node.props && node.props['data-cc-btn'] === key) return node
  return findByKey(node.children, key)
}
/** 按钮的 key 只用于 busy 文案，没有 data 属性 ⇒ 按可见文字找 */
const findButton = (node, label, out = []) => {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const n of node) findButton(n, label, out); return out }
  if (node.type === 'button') {
    const t = texts(node).join('')
    if (t.includes(label)) out.push(node)
  }
  findButton(node.children, label, out)
  return out
}
const findAll = (node, pred, out = []) => {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const n of node) findAll(n, pred, out); return out }
  if (pred(node)) out.push(node)
  findAll(node.children, pred, out)
  return out
}
const allText = () => texts(tree).join(' | ')
const has = (s) => allText().includes(s)

/* ─────────────── 4. 挂载 client.js ─────────────── */
let factoryRef = null
globalThis.window = fakeWindow
globalThis.document = fakeDocument
globalThis.fetch = fakeFetch
globalThis.window.__ModuleLoader__ = { load: ({ id, factory }) => { if (id !== 'dsh-cc98-duty') throw new Error('client id 不对：' + id); factoryRef = factory } }
fakeWindow.__ModuleLoader__ = globalThis.window.__ModuleLoader__

await import('./client.js')
if (!factoryRef) { console.error('client.js 没注册 factory'); process.exit(1) }
const factory = factoryRef

const reg = { meta: null, comp: null }
const slots = {
  inject: (name, cb) => { if (name !== 'settings.section') throw new Error('槽位名不对：' + name); cb() },
  register: (meta, comp) => { reg.meta = meta; reg.comp = comp; return { dispose() {} } },
}
const clientCtx = {
  get: (k) => (k === 'slots' ? slots : undefined),
  effect: (fn) => { const d = fn(); return () => { try { d?.() } catch { /* ignore */ } } },
}
const clientMod = factory((name) => {
  if (name === 'react') return React
  throw new Error('client 请求了未知模块：' + name)
})
clientMod.apply(clientCtx)

/* ─────────────── 5. 断言 ─────────────── */
console.log('\n== 1. 注册 ==')
try {
  if (reg.meta?.label !== '刷CC98') throw new Error('导航 label 不对：' + JSON.stringify(reg.meta))
  ok('设置页注册', `label=${reg.meta.label} id=${reg.meta.id} order=${reg.meta.order}`)
} catch (e) { bad('设置页注册', e) }
try {
  if (!styleEls.length) throw new Error('没注入样式')
  ok('样式注入', `${styleEls[0].textContent.length} 字符`)
} catch (e) { bad('样式注入', e) }

let tree = null
console.log('\n== 2. 首次挂载 ==')
try {
  tree = renderRoot()
  await flush()
  tree = renderRoot()
  await flush()
  ok('挂载不抛，渲染出内容', allText().slice(0, 80) + '…')
} catch (e) { bad('挂载', e); process.exit(1) }

for (const [name, kw] of [
  ['状态条：网络', '内网可达'],
  ['状态条：登录名', '值夜班的鱼'],
  ['账号区', 'CC98'],
  ['写操作闸门', '写操作'],
  ['预设区', '预设'],
  ['测试按钮', '测试 98 连接'],
]) {
  if (has(kw)) ok('页面含：' + name)
  else bad('页面含：' + name, new Error('没找到「' + kw + '」，实际文本：' + allText().slice(0, 300)))
}
if (has('正在读取') || has('读取中')) bad('加载态已结束', new Error('还停在加载中'))
else ok('加载态已结束（数据到手）')

console.log('\n== 3. 真点按钮：测试 98 连接 ==')
try {
  const btn = findButton(tree, '测试 98 连接')[0]
  if (!btn) throw new Error('找不到测试按钮')
  await btn.props.onClick()
  await flush()
  tree = renderRoot(); await flush()
  tree = renderRoot()
  if (has('网络正常 · 热门')) ok('点「测试 98 连接」→ 页面显示结果', (allText().match(/网络正常 · 热门[^|]*/) || [''])[0])
  else bad('点「测试 98 连接」', new Error('没看到结果文案：' + allText().slice(0, 200)))
} catch (e) { bad('点「测试 98 连接」', e) }

console.log('\n== 4. 真点开关：写闸门开 → 关（验证后必须关回去） ==')
try {
  const swList = () => findAll(tree, (n) => n.props && 'data-cc-sw' in n.props)
  if (swList().length < 3) throw new Error('开关数量不对（应至少 3 个：启用插件 / 写闸门 / 值班只读）：' + swList().length)
  // 顺序：0=启用插件  1=写操作闸门  2=值班轮只读
  let toggle = swList()[1]
  await toggle.props.onClick()          // 打开写闸门
  await flush()
  tree = renderRoot(); await flush()
  tree = renderRoot()
  const stOn = await (await fetch('/api/cc98-duty/status')).json()
  if (stOn.write?.enabled === true) ok('点写闸门 → 宿主真的打开了', 'writeEnabled=true')
  else bad('点写闸门', new Error('宿主没变化：' + JSON.stringify(stOn.write)))
  if (has('每次发评论')) ok('页面展开确认词区', '确认词说明出现')
  else bad('确认词区展开', new Error('没看到确认词说明'))
  // 关回去 —— 绝不留开着的写闸门
  const toggle2 = swList()[1]
  await toggle2.props.onClick()
  await flush()
  tree = renderRoot(); await flush()
  const stOff = await (await fetch('/api/cc98-duty/status')).json()
  if (stOff.write?.enabled === false) ok('写闸门已恢复成「关」')
  else bad('写闸门恢复', new Error('writeEnabled=' + JSON.stringify(stOff.write)))
} catch (e) { bad('写闸门开关', e) }

console.log('\n== 4.5 总开关：关 → 开（验证后必须开回去） ==')
try {
  const swList = () => findAll(tree, (n) => n.props && 'data-cc-sw' in n.props)
  await swList()[0].props.onClick()      // 关掉总开关
  await flush()
  tree = renderRoot(); await flush()
  tree = renderRoot()
  const stDis = await (await fetch('/api/cc98-duty/status')).json()
  if (stDis.pluginEnabled === false) ok('点「启用插件」→ 宿主 enabled=false')
  else bad('总开关关闭', new Error('pluginEnabled=' + JSON.stringify(stDis.pluginEnabled)))
  if (has('插件已关闭')) ok('页面显示「插件已关闭」徽章')
  else bad('关闭徽章', new Error('没看到徽章：' + allText().slice(0, 160)))
  await swList()[0].props.onClick()      // 开回去
  await flush()
  tree = renderRoot(); await flush()
  const stBack = await (await fetch('/api/cc98-duty/status')).json()
  if (stBack.pluginEnabled === true) ok('总开关已恢复成「开」')
  else bad('总开关恢复', new Error('pluginEnabled=' + JSON.stringify(stBack.pluginEnabled)))
} catch (e) { bad('总开关', e) }

console.log('\n== 5. 预设下拉 ==')
try {
  if (has('值夜班 · 每日一轮')) ok('预设下拉含出厂预设')
  else bad('预设下拉', new Error('没找到预设标签：' + allText().slice(0, 200)))
} catch (e) { bad('预设下拉', e) }

console.log(`\n=== 结果：${pass.length} 过 / ${fail.length} 挂 ===`)
if (fail.length) { for (const f of fail) console.log(' - ' + f); process.exit(2) }
