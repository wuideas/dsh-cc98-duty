/**
 * dsh-cc98-duty —— host 半端
 * ============================================================================
 * 它是什么：把 CC98（浙大校内论坛）做成一个**真正的 DSH 插件**。
 *
 *   1. 把 98 的能力注册成 dsh 工具（看首页 / 读帖 / 搜帖 / 列版面 / 发帖 / 回帖 / 评论）
 *      —— 全部走内置的纯 JS HTTP 客户端（`lib/cc98.mjs`），**不需要 Python**。
 *   2. 设置页（`client.js`）通过 `/api/cc98-duty/*` 读写配置、登录、看状态、编辑预设。
 *   3. **写操作默认关**：总闸 `writeEnabled` + 每次给对「确认词」才允许发 —— 这个号挂着
 *      使用者的浙大通行证，它写出去的每个字都算在他头上。
 *
 * 家（`$DSH_HOME/cc98-duty/`）里都有什么：
 *   config.json（开关/条数/关键词） · credential.json（账号密码，本机） · token.json（OIDC）
 *   presets/（出厂预设 + 用户改过的） · out/（将来的日报） · duty.log
 * ============================================================================
 */
import { loadHostDeps } from './lib/hostdeps.mjs'

const hostDeps = await loadHostDeps()
const z = hostDeps.z
const defineTool = hostDeps.defineTool

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from './lib/cc98.mjs'
import { nowIso, readJson, stateDirOf, writeJson } from './lib/state.mjs'
import { ensurePresets, listPresets, readPreset, savePreset } from './lib/presets.mjs'

export const name = 'cc98-duty'
export const inject = ['webServer', 'tools', 'settings']

const DEFAULTS = {
  enabled: true,
  perDay: 2,
  presetName: 'duty',
  workspace: '',
  dutyReadOnly: true,
  writeEnabled: false,
  confirmWord: '我确认',
  keywords: ['保研', '推免', '选课', '课程评价', '实习', '科研'],
}

/**
 * 🔴 每个字段都要 `.extra('volatile', true)`：DSH 的 settings.update() 只认 volatile 字段，
 *   没有这个标记写设置时会抛 "no volatile fields"。另外两个条件：loader entry 的 id
 *   必须等于命名空间名（cordis.patch.yml 里就是 `cc98-duty`）+ 本模块导出 Config。
 */
export const Config = !z ? undefined : z.object({
  /** 插件总开关（关掉后工具仍注册，但会在返回值里提示） */
  enabled: z.boolean().default(true).extra('volatile', true),
  /** 每天最多挑几条（给将来的定时值班用；0 = 不定时） */
  perDay: z.natural().default(2).extra('volatile', true),
  /** 默认预设名（prompts/ 里那一叠） */
  presetName: z.string().default('duty').extra('volatile', true),
  /** 使用者平时的工作区（放 AGENTS.md 的那个目录；留空 = 不读人设） */
  workspace: z.string().default('').extra('volatile', true),
  /** 值班轮只读（给将来的定时值班用：那一轮不给写工具；交互式写操作仍看 writeEnabled） */
  dutyReadOnly: z.boolean().default(true).extra('volatile', true),
  /** 🔴 写操作总闸：默认关。打开后模型才能发帖/回帖/评论（还要对确认词） */
  writeEnabled: z.boolean().default(false).extra('volatile', true),
  /** 写操作的确认词：每次发内容都必须原样带上 */
  confirmWord: z.string().default('我确认').extra('volatile', true),
  /** 关注关键词（值班预设用） */
  keywords: z.array(z.string()).default(['保研', '推免', '选课', '课程评价', '实习', '科研']).extra('volatile', true),
})

const CONFIG_KEYS = ['enabled', 'perDay', 'presetName', 'workspace', 'dutyReadOnly', 'writeEnabled', 'confirmWord', 'keywords']

const clampInt = (v, min, max, dflt) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.max(min, Math.min(max, Math.trunc(n)))
}

export function apply(ctx, config) {
  const pluginDir = dirname(fileURLToPath(import.meta.url))
  const stateDir = stateDirOf(ctx)
  const logFile = join(stateDir, 'duty.log')
  const cfgFile = join(stateDir, 'config.json')
  mkdirSync(join(stateDir, 'out'), { recursive: true })

  const log = (msg) => {
    const line = `${nowIso()}  ${msg}`
    try { appendFileSync(logFile, line + '\n', 'utf8') } catch { /* 日志写不进去不致命 */ }
    try { ctx.logger?.info?.(`[cc98-duty] ${msg}`) } catch { /* 没有 logger 就算 */ }
  }
  for (const n of hostDeps.notes || []) log(n)

  // 自己的版本号（设置页要显示）
  let myVer = ''
  const myVersion = () => {
    if (myVer) return myVer
    try { myVer = String(JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')).version || '') } catch { myVer = '' }
    return myVer
  }

  ensurePresets(pluginDir, stateDir, log)

  const client = createClient({ home: stateDir, log })

  /* ─────────────────────────── 配置：本地优先 + 尽量同步宿主 ─────────────────────────── */

  /**
   * ⚠️ `apply(ctx, config)` 传进来的 config，字段值**不保证是标量** —— 热重载时实测到过
   *   对象（`presetName=[object Object]`、`writeEnabled` 被 Boolean() 算成 true）。
   *   🔴 所以**只按字面类型收**：写闸门只有字面 `true` 才算开，绝不让对象/字符串"碰巧"打开它。
   */
  const isBool = (v) => typeof v === 'boolean'
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
  const isStr = (v) => typeof v === 'string'
  const normalize = (src, fallback = DEFAULTS) => {
    const o = { ...DEFAULTS, ...fallback, ...(src || {}) }
    const dropped = []
    const pick = (key, test) => {
      if (test(o[key])) return o[key]
      if (o[key] !== undefined && o[key] !== null) dropped.push(key + ':' + (typeof o[key]))
      return DEFAULTS[key]
    }
    const out = {
      enabled: pick('enabled', isBool),
      perDay: (() => {
        const v = o.perDay
        if (isNum(v)) return clampInt(v, 0, 20, DEFAULTS.perDay)
        if (isStr(v) && v.trim() !== '' && Number.isFinite(Number(v))) return clampInt(Number(v), 0, 20, DEFAULTS.perDay)
        if (v !== undefined && v !== null) dropped.push('perDay:' + typeof v)
        return DEFAULTS.perDay
      })(),
      presetName: (() => {
        const v = o.presetName
        return isStr(v) && v.trim() ? v.trim().slice(0, 40) : DEFAULTS.presetName
      })(),
      workspace: isStr(o.workspace) ? o.workspace : '',
      dutyReadOnly: isBool(o.dutyReadOnly) ? o.dutyReadOnly : DEFAULTS.dutyReadOnly,
      writeEnabled: isBool(o.writeEnabled) ? o.writeEnabled : DEFAULTS.writeEnabled,   // 🔴 对象绝不等于开
      confirmWord: isStr(o.confirmWord) ? o.confirmWord.slice(0, 40) : DEFAULTS.confirmWord,
      keywords: Array.isArray(o.keywords)
        ? o.keywords.filter((k) => isStr(k) || isNum(k)).map((k) => String(k)).filter((k) => k.trim()).slice(0, 40)
        : DEFAULTS.keywords.slice(),
    }
    if (dropped.length) log(`配置里有非标量字段（已按默认值处理）：${dropped.join('、')}`)
    return out
  }

  let settingsRow = { at: 0, row: null }
  const describeRow = (fresh = false) => {
    const t = Date.now()
    if (!fresh && t - settingsRow.at < 2500) return settingsRow.row
    let row = null
    try {
      const rows = ctx.settings?.describe?.() || []
      row = rows.find((r) => r?.ns === name)
        || rows.find((r) => r?.value && typeof r.value === 'object' && 'confirmWord' in r.value)
        || null
    } catch (e) { log(`读 DSH 设置表单失败（不影响用）：${e?.message ?? e}`) }
    settingsRow = { at: t, row }
    return row
  }

  /** 读配置：config.json 里有值的以它为准；没有再听宿主那一行；最后才是默认值 */
  const loadCfg = () => {
    const saved = readJson(cfgFile, {}) || {}
    const row = describeRow()
    const hostVal = row?.value && typeof row.value === 'object' ? row.value : (config && typeof config === 'object' ? config : {})
    const base = normalize(hostVal)
    const merged = normalize({ ...base, ...saved })
    return merged
  }
  const cfg = loadCfg()
  const refreshCfg = () => { Object.assign(cfg, loadCfg()) }

  /** 写配置：本地 config.json 一定写；宿主那份 best-effort（写不进去只提示，不算失败） */
  const persistCfg = async (patch) => {
    const clean = {}
    for (const k of CONFIG_KEYS) if (k in (patch || {})) clean[k] = patch[k]
    Object.assign(cfg, normalize({ ...cfg, ...clean }))
    writeJson(cfgFile, cfg)
    let host = { ok: false, error: 'DSH 这边没有可写的设置表单（值只落在插件自己的 config.json 里）' }
    try {
      const row = describeRow(true)
      if (row?.ns && typeof ctx.settings?.update === 'function') {
        await ctx.settings.update(row.ns, clean, row.revision)
        const after = describeRow(true)
        host = { ok: true, ns: row.ns, user: after?.user || null }
      }
    } catch (e) {
      host = { ok: false, error: e?.message ?? String(e) }
    }
    log(`设置已更新：${JSON.stringify(clean)}（DSH 同步${host.ok ? '成功' : '没写成：' + host.error}）`)
    return { clean, host }
  }

  /* ─────────────────────────── 工具 ─────────────────────────── */

  const textOutput = {
    schema: { type: 'object', properties: {}, additionalProperties: true },
    render: (_args, value) => [{
      type: 'text',
      text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    }],
  }
  /** 工具返回值一律过一遍：宿主只吃"无损 JSON" */
  const safe = (v) => {
    if (v === undefined || v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
    try { return JSON.parse(JSON.stringify(v)) } catch { return String(v) }
  }
  const tool = (spec) => ctx.tools.register(defineTool({
    ...spec,
    output: textOutput,
    async execute(args, exec) {
      // ⭐ 总开关：settings 里 `enabled` 关掉后，除 status / config 外的工具一律拒绝
      //    （不碰 profile、不用重启；设置页和 cc98_config 照常可用，才能再打开）
      refreshCfg()
      if (!cfg.enabled && spec.name !== 'cc98_status' && spec.name !== 'cc98_config') {
        return safe({
          ok: false,
          disabled: true,
          hint: '插件总开关关着（设置 → 刷CC98 → 启用插件）。要用的话先把它打开，或者调 cc98_config 传 { enabled: true }。',
        })
      }
      return safe(await spec.execute(args || {}, exec))
    },
  }))

  /** 写操作闸门：总闸 + 确认词 + 最小间隔。返回 null = 放行，否则返回给模型的拒绝说明 */
  let lastWriteAt = 0
  const writeGate = (confirm) => {
    refreshCfg()
    if (!cfg.writeEnabled) {
      return {
        ok: false,
        blocked: true,
        hint: '写操作总闸关着（设置页 → 刷CC98 → 写操作闸门）。这个号挂着使用者的浙大通行证，'
          + '要发公开内容必须先由他本人在设置页里打开闸门。',
      }
    }
    if (!cfg.confirmWord) return { ok: false, blocked: true, hint: '没设确认词，不允许写。' }
    if (String(confirm ?? '') !== cfg.confirmWord) {
      return {
        ok: false,
        blocked: true,
        hint: `确认词不对。要在 98 上真的发出这句话，必须把确认词原样放进 confirm 参数（当前确认词：${cfg.confirmWord}）；`
          + '没拿到使用者明确同意前，不要猜。',
      }
    }
    const gap = Date.now() - lastWriteAt
    if (lastWriteAt && gap < 20000) {
      return { ok: false, blocked: true, hint: `刚发过一条（${Math.round(gap / 1000)} 秒前），至少隔 20 秒再发下一条 —— 别刷屏。` }
    }
    return null
  }

  tool({
    name: 'cc98_status',
    description: '看 CC98 这边的情况：网络是否可达（要浙大内网）、登录的是谁、token 还剩多久、写操作闸门开没开、插件版本与家目录。',
    parameters: {},
    async execute() {
      refreshCfg()
      let st
      try { st = await client.status() } catch (e) { st = { network: '不可达：' + (e?.message ?? e), token: '未知' } }
      return {
        ok: true,
        ...st,
        pluginEnabled: cfg.enabled,
        write: { enabled: cfg.writeEnabled, confirmWordSet: Boolean(cfg.confirmWord) },
        preset: cfg.presetName,
        perDay: cfg.perDay,
        home: stateDir,
        version: myVersion(),
      }
    },
  })

  tool({
    name: 'cc98_whoami',
    description: '看登录的是谁（昵称 / uid）。没登录时返回提示。',
    parameters: {},
    async execute() {
      try { return { ok: true, user: await client.me(), credential: client.getCredentialSummary() } } catch (e) {
        return { ok: false, error: e?.message ?? String(e), credential: client.getCredentialSummary() }
      }
    },
  })

  tool({
    name: 'cc98_front',
    description: '拿 CC98 首页信息流：热门（十大）+ 各分区（学习 / 情感 / 校园新闻 / 二手 / 求职 …）。游客也能读，不消耗登录态。',
    parameters: {},
    async execute() { return { ok: true, ...(await client.front()) } },
  })

  tool({
    name: 'cc98_topic',
    description: '读一个帖子：标题、作者、正文（已把 UBB 转成纯文本）、前 N 楼。**判断内容要看正文，别看标题下结论**。',
    parameters: {
      id: { type: 'number', description: '帖子 id（98 的 topic id）' },
      posts: { type: 'number', description: '读几楼（默认 12，最多 50）' },
    },
    async execute(args) {
      const id = Number(args.id)
      if (!id) return { ok: false, error: '缺 id（数字）' }
      return { ok: true, ...(await client.topic(id, clampInt(args.posts ?? 12, 1, 50, 12))) }
    },
  })

  tool({
    name: 'cc98_board',
    description: '列一个版面的帖子（按最新回复）。不知道版面 id 时先用 cc98_boards 查。',
    parameters: {
      boardId: { type: 'number', description: '版面 id，例如 学习天地=68' },
      size: { type: 'number', description: '返回几条（默认 20，最多 50）' },
      from: { type: 'number', description: '从第几条开始（默认 0）' },
    },
    async execute(args) {
      const id = Number(args.boardId)
      if (!id) return { ok: false, error: '缺 boardId（数字）' }
      return { ok: true, ...(await client.board(id, { size: clampInt(args.size ?? 20, 1, 50, 20), from: clampInt(args.from ?? 0, 0, 100000, 0) })) }
    },
  })

  tool({
    name: 'cc98_new',
    description: '全站最新帖（不按版面过滤）。',
    parameters: { size: { type: 'number', description: '返回几条（默认 20，最多 50）' } },
    async execute(args) { return { ok: true, ...(await client.latest(clampInt(args.size ?? 20, 1, 50, 20))) } },
  })

  tool({
    name: 'cc98_search',
    description: '搜 CC98 的帖子（关键词）。要登录。',
    parameters: {
      keyword: { type: 'string', description: '关键词' },
      size: { type: 'number', description: '返回几条（默认 20，最多 50）' },
    },
    async execute(args) {
      const kw = String(args.keyword ?? '').trim()
      if (!kw) return { ok: false, error: '缺 keyword' }
      return { ok: true, ...(await client.search(kw, clampInt(args.size ?? 20, 1, 50, 20))) }
    },
  })

  tool({
    name: 'cc98_boards',
    description: '列 CC98 的版面 id → 名字（可给关键词过滤）。要发帖时先用它确认 boardId。',
    parameters: { keyword: { type: 'string', description: '按名字过滤（可选）' } },
    async execute(args) {
      const all = await client.boardsList()
      const kw = String(args.keyword ?? '').trim()
      const list = kw ? all.filter((b) => String(b.name || '').includes(kw)) : all
      return { ok: true, count: list.length, boards: list.slice(0, 300) }
    },
  })

  tool({
    name: 'cc98_presets',
    description: '看/改插件自带的「预设」（提示词）：action=list 列出、get 读一个、save 保存一个（可改出厂预设，也可新建自定义预设）。',
    parameters: {
      action: { type: 'string', description: 'list / get / save' },
      name: { type: 'string', description: '预设名，例如 duty / watch / reply / post' },
      content: { type: 'string', description: 'save 时的正文' },
    },
    async execute(args) {
      const action = String(args.action || 'list').toLowerCase()
      if (action === 'list') return { ok: true, presets: listPresets(stateDir), home: stateDir }
      if (action === 'get') {
        try { return { ok: true, ...readPreset(stateDir, String(args.name || '')) } } catch (e) { return { ok: false, error: e?.message ?? String(e) } }
      }
      if (action === 'save') {
        try { return { ok: true, ...savePreset(stateDir, String(args.name || ''), String(args.content ?? '')) } } catch (e) { return { ok: false, error: e?.message ?? String(e) } }
      }
      return { ok: false, error: 'action 只能是 list / get / save' }
    },
  })

  tool({
    name: 'cc98_config',
    description: '读 / 改插件设置。action=get 返回当前配置；action=set 传 patch（可含 enabled / perDay / presetName / workspace / writeEnabled / confirmWord / keywords）。'
      + '\n🔴 改 writeEnabled / confirmWord 等于碰「能不能拿这个号发公开内容」——必须有使用者明确同意，不要自己改。',
    parameters: {
      action: { type: 'string', description: 'get / set' },
      patch: { type: 'object', description: '要改的字段（action=set 时）', additionalProperties: true },
    },
    async execute(args) {
      const action = String(args.action || 'get').toLowerCase()
      refreshCfg()
      if (action === 'get') return { ok: true, config: cfg, home: stateDir, confirmWordSet: Boolean(cfg.confirmWord) }
      if (action === 'set') {
        const patch = args.patch && typeof args.patch === 'object' ? args.patch : {}
        const { clean, host } = await persistCfg(patch)
        return { ok: true, applied: clean, config: cfg, host }
      }
      return { ok: false, error: 'action 只能是 get / set' }
    },
  })

  tool({
    name: 'cc98_login',
    description: '用 CC98 站内账号密码登录（密码只落本机插件家目录，不写进 profile）。第一次用或 token 失效时用。',
    parameters: {
      username: { type: 'string', description: 'CC98 站内账号（注册时那个用户名，不是学号）' },
      password: { type: 'string', description: 'CC98 站内密码' },
    },
    async execute(args) {
      const username = String(args.username ?? '').trim()
      const password = String(args.password ?? '')
      if (!username || !password) return { ok: false, error: 'username 和 password 都要给' }
      client.setCredential(username, password)
      await client.logout()
      try {
        const me = await client.me()
        const st = await client.status()
        log(`登录成功：${me.name}（#${me.id}）`)
        return { ok: true, user: me, tokenExpiresInMin: st.token_expires_in_min, credentialFile: client.credentialPath }
      } catch (e) {
        log(`登录失败：${e?.message ?? e}`)
        return { ok: false, error: e?.message ?? String(e) }
      }
    },
  })

  tool({
    name: 'cc98_create_topic',
    description: '在 CC98 发一个新帖（正文用 UBB）。🔴 会以使用者的账号公开发布 —— 必须 writeEnabled 打开且 confirm 对上确认词。'
      + '\nPOST 之前先想清楚：发在哪个版（cc98_boards 查）、标题是否准确、正文是否适合他本人。'
      + '\n发完会自动回查版面第一页确认（官方接口不返回内容）。',
    parameters: {
      boardId: { type: 'number', description: '版面 id' },
      title: { type: 'string', description: '标题' },
      content: { type: 'string', description: '正文（UBB；纯文本也能发）' },
      contentType: { type: 'number', description: '0=UBB（默认）/ 1=Markdown' },
      confirm: { type: 'string', description: '确认词（设置页里那个，原样带上）' },
    },
    async execute(args) {
      const blocked = writeGate(args.confirm)
      if (blocked) return blocked
      lastWriteAt = Date.now()
      return { ok: true, ...(await client.createTopic({
        boardId: Number(args.boardId),
        title: String(args.title ?? ''),
        content: String(args.content ?? ''),
        contentType: Number(args.contentType) || 0,
      })) }
    },
  })

  tool({
    name: 'cc98_reply',
    description: '回复一个帖子（占一个新楼层）。🔴 会以使用者的账号公开回复 —— 必须 writeEnabled 打开且 confirm 对上确认词。'
      + '\n注意：98 没有「楼中楼评论」；要对某一层说话用 cc98_quote_reply（引用回复）。',
    parameters: {
      topicId: { type: 'number', description: '帖子 id' },
      content: { type: 'string', description: '回复正文（UBB）' },
      confirm: { type: 'string', description: '确认词（原样带上）' },
    },
    async execute(args) {
      const blocked = writeGate(args.confirm)
      if (blocked) return blocked
      lastWriteAt = Date.now()
      return { ok: true, ...(await client.replyTopic(Number(args.topicId), { content: String(args.content ?? '') })) }
    },
  })

  tool({
    name: 'cc98_quote_reply',
    description: '引用回复某一层楼（98 的「对某条回复说话」= 引用回复，会占一个新楼层，不是楼中楼评论）。'
      + '自动拼官方同款 [quote] 前缀。🔴 会以使用者的账号公开发布 —— 必须 writeEnabled 打开且 confirm 对上确认词。',
    parameters: {
      topicId: { type: 'number', description: '帖子 id' },
      postId: { type: 'number', description: '要引用的那一层的 postId（cc98_topic 的 posts[].postId）' },
      content: { type: 'string', description: '回复正文（UBB）' },
      posts: { type: 'number', description: '在帖子前多少楼里找这一层（默认 50，最大 50）' },
      confirm: { type: 'string', description: '确认词（原样带上）' },
    },
    async execute(args) {
      const blocked = writeGate(args.confirm)
      if (blocked) return blocked
      lastWriteAt = Date.now()
      return { ok: true, ...(await client.quoteReply(Number(args.topicId), {
        postId: Number(args.postId),
        content: String(args.content ?? ''),
        posts: clampInt(args.posts ?? 50, 1, 50, 50),
      })) }
    },
  })

  /* ─────────────────────────── 设置页的 HTTP 路由 ─────────────────────────── */

  const sendJson = (res, code, obj) => {
    try {
      res.statusCode = code
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify(obj))
    } catch (e) { log(`回 HTTP 失败：${e?.message ?? e}`) }
  }
  const readBody = (req) => new Promise((resolve) => {
    let b = ''
    req.on('data', (c) => { b += c; if (b.length > 2e6) { try { req.destroy() } catch { /* ignore */ } } })
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}) } catch { resolve({}) } })
    req.on('error', () => resolve({}))
  })

  const statusPayload = async () => {
    refreshCfg()
    let cc98
    try { cc98 = await client.status() } catch (e) { cc98 = { network: '不可达：' + (e?.message ?? e), token: '未知', has_token: false } }
    return {
      ok: true,
      home: stateDir,
      version: myVersion(),
      config: cfg,
      presets: listPresets(stateDir),
      account: client.getCredentialSummary(),
      cc98,
      pluginEnabled: cfg.enabled,
      write: { enabled: cfg.writeEnabled, confirmWordSet: Boolean(cfg.confirmWord) },
    }
  }

  const handle = async (req, res, url) => {
    refreshCfg()
    const path = url.pathname

    if (req.method === 'GET' && path === '/api/cc98-duty/status') return sendJson(res, 200, await statusPayload())

    if (req.method === 'GET' && path === '/api/cc98-duty/config') {
      return sendJson(res, 200, { ok: true, config: cfg, home: stateDir })
    }

    if (req.method === 'POST' && path === '/api/cc98-duty/config') {
      const body = await readBody(req)
      const patch = body && typeof body.patch === 'object' && body.patch ? body.patch : body || {}
      const { clean, host } = await persistCfg(patch)
      return sendJson(res, 200, { ok: true, applied: clean, config: cfg, host })
    }

    if (req.method === 'GET' && path === '/api/cc98-duty/presets') {
      return sendJson(res, 200, { ok: true, presets: listPresets(stateDir) })
    }

    if (req.method === 'GET' && path === '/api/cc98-duty/preset') {
      try {
        const r = readPreset(stateDir, String(url.searchParams.get('name') || cfg.presetName || 'duty'))
        return sendJson(res, 200, { ok: true, name: r.name, content: r.content })
      } catch (e) { return sendJson(res, 200, { ok: false, error: e?.message ?? String(e) }) }
    }

    if (req.method === 'POST' && path === '/api/cc98-duty/preset') {
      const body = await readBody(req)
      try {
        const r = savePreset(stateDir, String(body.name || ''), String(body.content ?? ''))
        log(`预设已保存：${r.name}`)
        return sendJson(res, 200, { ok: true, name: r.name })
      } catch (e) { return sendJson(res, 200, { ok: false, error: e?.message ?? String(e) }) }
    }

    if (req.method === 'POST' && path === '/api/cc98-duty/login') {
      const body = await readBody(req)
      const username = String(body.username || '').trim()
      const password = String(body.password || '')
      if (!username || !password) return sendJson(res, 200, { ok: false, error: '账号和密码都要填' })
      client.setCredential(username, password)
      await client.logout()
      try {
        const me = await client.me()
        const st = await client.status()
        log(`设置页登录成功：${me.name}（#${me.id}）`)
        return sendJson(res, 200, { ok: true, user: me, expiresInMin: st.token_expires_in_min })
      } catch (e) {
        log(`设置页登录失败：${e?.message ?? e}`)
        return sendJson(res, 200, { ok: false, error: e?.message ?? String(e) })
      }
    }

    if (req.method === 'POST' && path === '/api/cc98-duty/logout') {
      await client.logout()
      return sendJson(res, 200, { ok: true })
    }

    // 「试一下」：拉一次首页 + 版面表，验证网络/接口都通
    if (req.method === 'POST' && path === '/api/cc98-duty/test') {
      const t0 = Date.now()
      try {
        const front = await client.front()
        let boardsCount = 0
        try { boardsCount = (await client.boardsList()).length } catch { boardsCount = 0 }
        const hot = front['热门'] || []
        return sendJson(res, 200, {
          ok: true,
          ms: Date.now() - t0,
          sample: {
            hotCount: hot.length,
            boardsCount,
            firstTitle: hot[0]?.title || null,
          },
        })
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: e?.message ?? String(e) })
      }
    }

    return sendJson(res, 404, { ok: false, error: `unknown ${req.method} ${path}` })
  }

  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/api/cc98-duty',
      handler: async (req, res) => {
        try { await handle(req, res, new URL(req.url, 'http://127.0.0.1')) } catch (e) {
          sendJson(res, 500, { ok: false, error: e?.message ?? String(e) })
        }
      },
    }), 'cc98-duty: /api/cc98-duty 路由')
  } catch (e) { log(`HTTP 路由没挂上：${e?.message ?? e}`) }

  log(`已挂载（家=${stateDir}，版本=${myVersion()}，写闸门=${cfg.writeEnabled ? '开' : '关'}，预设=${cfg.presetName}）`)
}
