/**
 * lib/cc98.mjs —— CC98 HTTP 客户端（纯 Node 内置 fetch，零第三方依赖）
 * ============================================================================
 * 为什么不用 Python：DSH 宿主是 Node 22+，内置 fetch 足够；bili 插件用 Python 只是
 * 因为内置了别人的 MCP。这里直接把 cc98.py 那套取数逻辑搬到 JS，去掉 venv / pip / 子进程。
 *
 * 家目录（`$DSH_HOME/cc98-duty/`）里放：`credential.json`、`token.json`、`boards.cache.json`。
 * 写接口一律要过上层闸门（见 index.js 的 writeAllowed）—— 这一层只负责发请求，不判断该不该发。
 * ============================================================================
 */
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const API = 'https://api.cc98.org'
export const TOKEN_URL = 'https://openid.cc98.org/connect/token'
// CC98 官方 Web 客户端的 OIDC 公共凭据（公开信息，cc98-cli 同款）
export const CLIENT_ID = '9a1fd200-8687-44b1-4c20-08d50a96e5cd'
export const CLIENT_SECRET = '8b53f727-08e2-4509-8857-e34bf92b27f2'
export const SCOPE = 'cc98-api openid offline_access'
const UA = 'cc98-duty/0.1 (dsh-cc98-duty, personal)'

export class CC98Error extends Error {}

// ---------------------------------------------------------------- 小工具

export function readJsonSafe(file, fallback = null) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}

export function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, file)
}

function nowIso() {
  const d = new Date()
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const p = (n) => String(Math.floor(Math.abs(n))).padStart(2, '0')
  return new Date(d.getTime() + off * 60000).toISOString().replace('Z', `${sign}${p(off / 60)}:${p(off % 60)}`)
}

/** UBB → 纯文本（帖子正文 CC98 用的是 UBB） */
const TAG_RE = /\[(\/?)([a-zA-Z][\w-]*)(?:=[^\]]*)?\]/g
export function ubbToText(s) {
  if (!s) return ''
  let t = String(s).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  t = t.replace(/\[img[^\]]*\]([\s\S]*?)\[\/img\]/gi, '[图片]')
  t = t.replace(/\[(?:em|表情)[^\]]*\]/gi, '')
  t = t.replace(/\[url=([^\]]+)\]([\s\S]*?)\[\/url\]/gi, '$2 ($1)')
  t = t.replace(TAG_RE, '')
  t = t.replace(/\[br\]/g, '\n').replace(/\[hr\]/g, '\n---\n')
  t = t.replace(/\n{3,}/g, '\n\n')
  return t.trim()
}

export function shortText(s, n = 60) {
  const t = String(s || '').replace(/\n/g, ' ').trim()
  return t.length <= n ? t : t.slice(0, n) + '…'
}

// ---------------------------------------------------------------- 客户端

/**
 * @param {{home:string, log?:(m:string)=>void, timeoutMs?:number}} opts
 */
export function createClient({ home, log = () => {}, timeoutMs = 20000 }) {
  const credPath = join(home, 'credential.json')
  const tokenPath = join(home, 'token.json')
  const boardCachePath = join(home, 'boards.cache.json')
  let memToken = null
  let knownAccount = ''

  async function http(url, { method = 'GET', headers = {}, body = null, form = null, timeout = timeoutMs } = {}) {
    const h = { 'User-Agent': UA, Accept: 'application/json', ...headers }
    let payload = null
    if (form) {
      payload = new URLSearchParams(form).toString()
      h['Content-Type'] = 'application/x-www-form-urlencoded'
    } else if (body !== null && body !== undefined) {
      payload = typeof body === 'string' ? body : JSON.stringify(body)
      h['Content-Type'] = 'application/json'
    }
    let res
    try {
      res = await fetch(url, { method, headers: h, body: payload, signal: AbortSignal.timeout(timeout) })
    } catch (e) {
      const msg = e?.name === 'TimeoutError' ? `请求超时（${timeout}ms）` : String(e?.message || e)
      throw new CC98Error(`连不上 ${url.split('?')[0]}（${msg}）。八成是不在浙大内网。`)
    }
    const text = await res.text()
    let parsed = text
    try { parsed = text ? JSON.parse(text) : null } catch { /* 非 JSON 原样返回 */ }
    return { status: res.status, data: parsed, text }
  }

  // ---------- 凭证 & token ----------

  function loadCredential() {
    const c = readJsonSafe(credPath)
    if (!c || !c.username || !c.password) throw new CC98Error('还没配账号：先在设置页里填 CC98 站内账号和密码（或调 cc98_config 工具）')
    return c
  }

  function setCredential(username, password) {
    if (!username || !password) throw new CC98Error('username / password 都不能为空')
    writeJsonAtomic(credPath, { username, password, saved_at: nowIso() })
    knownAccount = username
  }

  function getCredentialSummary() {
    const c = readJsonSafe(credPath)
    if (!c || !c.username) return { configured: false }
    return { configured: true, username: c.username, saved_at: c.saved_at }
  }

  function loadToken() {
    if (memToken) return memToken
    const t = readJsonSafe(tokenPath)
    if (t && t.access_token) memToken = t
    return memToken
  }

  function tokenFresh(tok, marginSec = 120) {
    if (!tok || !tok.access_token) return false
    if (!tok.expires_at_ts) return true
    return Date.now() / 1000 + marginSec < tok.expires_at_ts
  }

  async function requestToken(form) {
    const { status, data } = await http(TOKEN_URL, { method: 'POST', form })
    if (status !== 200 || !data || !data.access_token) {
      const detail = data && (data.error_description || data.error) ? '：' + (data.error_description || data.error) : ''
      throw new CC98Error(`登录失败（HTTP ${status}）${detail}`)
    }
    const tok = {
      access_token: data.access_token,
      refresh_token: data.refresh_token || null,
      expires_at_ts: Date.now() / 1000 + Number(data.expires_in || 3600),
      obtained_at: nowIso(),
      account: data.account || null,
    }
    memToken = tok
    writeJsonAtomic(tokenPath, tok)
    return tok
  }

  /** 有 token 用 token，快过期就 refresh，refresh 不行就密码登录 */
  async function ensureLogin({ force = false } = {}) {
    let tok = loadToken()
    if (!force && tokenFresh(tok)) return tok
    if (!force && tok && tok.refresh_token) {
      try {
        const n = await requestToken({
          refresh_token: tok.refresh_token,
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          grant_type: 'refresh_token',
          scope: SCOPE,
        })
        n.account = tok.account || n.account
        memToken = n
        writeJsonAtomic(tokenPath, n)
        return n
      } catch (e) {
        log('refresh token 失败，改走密码登录：' + (e?.message || e))
      }
    }
    const cred = loadCredential()
    const n = await requestToken({
      username: cred.username,
      password: cred.password,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'password',
      scope: SCOPE,
    })
    return n
  }

  async function logout() {
    memToken = null
    try { writeJsonAtomic(tokenPath, {}) } catch { /* 没就没 */ }
  }

  // ---------- 通用 API 调用 ----------

  async function api(path, { params, auth = true, method = 'GET', body = null, retry = true } = {}) {
    let url = API + path
    if (params) {
      const qs = new URLSearchParams()
      for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) qs.append(k, String(v))
      url += (url.includes('?') ? '&' : '?') + qs.toString()
    }
    const headers = {}
    if (auth) {
      const tok = await ensureLogin()
      headers.Authorization = 'Bearer ' + tok.access_token
    }
    const { status, data, text } = await http(url, { method, headers, body })
    if (status === 401 && auth && retry) {
      await ensureLogin({ force: true })
      return api(path, { params, auth, method, body, retry: false })
    }
    if (status >= 400) {
      const detail = typeof data === 'object' && data ? (data.message || data.error || data.title || '') : String(text || '').slice(0, 200)
      throw new CC98Error(`接口 ${path} 返回 HTTP ${status}${detail ? '：' + detail : ''}`)
    }
    return data
  }

  /** 版 id → 版名（缓存 6 小时） */
  async function boardMap() {
    const cache = readJsonSafe(boardCachePath)
    if (cache && cache.saved_at_ts > Date.now() / 1000 - 6 * 3600 && cache.map) return cache.map
    const data = await api('/board/all', { auth: false })
    const map = {}
    for (const group of data || []) for (const b of group.boards || []) map[String(b.id)] = b.name
    writeJsonAtomic(boardCachePath, { saved_at_ts: Date.now() / 1000, map })
    return map
  }

  function topicItem(t, boards) {
    const bid = t.boardId
    return {
      id: t.id,
      title: t.title,
      boardId: bid,
      board: boards[String(bid)] || t.boardName || null,
      author: t.userName || t.authorName || null,
      replyCount: t.replyCount ?? null,
      hitCount: t.hitCount ?? t.hit ?? null,
      lastPostTime: t.lastPostTime || t.time || t.createTime || null,
      url: `https://www.cc98.org/topic/${t.id}`,
    }
  }

  const SECTION_LABELS = {
    hotTopic: '热门（十大）',
    academics: '讲座 / 学术',
    study: '学习',
    emotion: '情感',
    schoolNews: '校内新闻',
    schoolEvent: '校园活动',
    specialOffer: '优惠',
    fleaMarket: '二手',
    partTimeJob: '兼职',
    fullTimeJob: '求职',
  }

  // ---------- 读接口 ----------

  async function status() {
    const out = { now: nowIso(), home, api: API }
    try {
      await api('/config/index', { auth: false })
      out.network = '内网可达'
    } catch (e) {
      out.network = '不可达：' + (e?.message || e)
    }
    const tok = loadToken()
    out.has_token = Boolean(tok && tok.access_token)
    if (out.has_token) {
      out.token_expires_in_min = Math.floor((Number(tok.expires_at_ts || 0) - Date.now() / 1000) / 60)
      try {
        const me = await api('/me')
        out.user = { id: me.id, name: me.name }
        out.token = '有效'
        knownAccount = me.name || ''
      } catch (e) {
        out.token = '失效：' + (e?.message || e)
      }
    } else {
      out.token = '未登录'
    }
    out.credential = getCredentialSummary()
    return out
  }

  async function me() {
    const u = await api('/me')
    return { id: u.id, name: u.name, ...(u.photoUrl ? { photoUrl: u.photoUrl } : {}) }
  }

  async function front() {
    const cfg = (await api('/config/index', { auth: false })) || {}
    let boards = {}
    try { boards = await boardMap() } catch { /* 版面名拿不到不影响主流程 */ }
    const hot = (cfg.hotTopic || []).map((t) => topicItem(t, boards))
    const sections = {}
    for (const [key, label] of Object.entries(SECTION_LABELS)) {
      if (key === 'hotTopic') continue
      sections[label] = (cfg[key] || []).map((t) => ({
        id: t.id,
        title: t.title,
        boardId: t.boardId,
        board: boards[String(t.boardId)] || t.boardName || null,
        author: t.userName || t.authorName || null,
        time: t.time || t.createTime || null,
      }))
    }
    return {
      更新于: cfg.lastUpdateTime || null,
      全站: {
        今日主题: cfg.todayTopicCount,
        今日帖数: cfg.todayCount,
        主题总数: cfg.topicCount,
        用户数: cfg.userCount,
        在线: cfg.onlineUserCount,
      },
      热门: hot,
      分区: sections,
    }
  }

  async function topic(id, posts = 12) {
    const info = (await api(`/topic/${id}`)) || {}
    const raw = (await api(`/Topic/${id}/post`, { params: { from: 0, size: Math.max(1, Math.min(50, posts)) } })) || []
    const plain = raw.map((p) => ({
      postId: p.id,
      floor: p.floor,
      author: p.userName,
      time: p.time,
      isAnonymous: p.isAnonymous,
      content: ubbToText(p.content),
      contentRaw: p.content || '',
    }))
    return {
      id: info.id || id,
      title: info.title,
      boardId: info.boardId,
      author: info.userName,
      createTime: info.time,
      replyCount: info.replyCount,
      hitCount: info.hitCount,
      url: `https://www.cc98.org/topic/${info.id || id}`,
      opening_text: plain.length ? plain[0].content : '',
      posts: plain,
    }
  }

  async function board(id, { size = 20, from = 0 } = {}) {
    let boards = {}
    try { boards = await boardMap() } catch { /* ignore */ }
    const data = (await api(`/board/${id}/topic`, { params: { from, size } })) || []
    return {
      boardId: Number(id),
      board: boards[String(id)] || null,
      count: data.length,
      topics: data.map((t) => topicItem(t, boards)),
    }
  }

  async function latest(size = 20) {
    let boards = {}
    try { boards = await boardMap() } catch { /* ignore */ }
    const data = (await api('/topic/new', { params: { from: 0, size } })) || []
    return { count: data.length, topics: data.map((t) => topicItem(t, boards)) }
  }

  async function search(keyword, size = 20) {
    let boards = {}
    try { boards = await boardMap() } catch { /* ignore */ }
    const data = (await api('/topic/search', { params: { keyword, from: 0, size } })) || []
    return { keyword, count: data.length, topics: data.map((t) => topicItem(t, boards)) }
  }

  async function boardsList() {
    const map = await boardMap()
    return Object.entries(map).map(([id, name]) => ({ id: Number(id), name }))
  }

  // ---------- 写接口（上层闸门负责「该不该发」，这里只管「怎么发」） ----------
  // 端点来自 ZJU-CC98 官方客户端源码（PWA / Forum / 社区 CLI）：
  //   发新帖  POST /board/{boardId}/topic   body { title, content, contentType, type, tag1, tag2 }
  //   回帖    POST /topic/{topicId}/post    body { title:"", content, contentType }
  //   contentType: 0 = UBB（默认），1 = Markdown；type 普通帖 = 0；tag1/tag2 = -1
  // ⚠️ 官方两个客户端都**只判断 HTTP 200、不解析响应体** ⇒ 新帖 id 从响应里拿不可靠，
  //    所以下面统一「发完回查」：去版面列表 / 帖子详情里核对，而不是信响应。

  /** ISO 时间 → "YYYY-MM-DD HH:mm" */
  const fmtTime = (s) => {
    const t = String(s || '')
    const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(t)
    return m ? `${m[1]} ${m[2]}` : t
  }

  /** 发完回查：版面第一页里找同名标题（官方不发 body，只能这样确认） */
  async function verifyTopicCreated(boardId, title) {
    try {
      const list = (await api(`/board/${boardId}/topic`, { params: { from: 0, size: 5 } })) || []
      const hit = list.find((t) => String(t.title || '').trim() === String(title).trim())
      return hit ? { verified: true, topicId: hit.id, replyCount: hit.replyCount ?? null } : { verified: false }
    } catch (e) {
      log('发帖回查失败（不影响"发过"这个事实）：' + (e?.message || e))
      return { verified: false, verifyError: String(e?.message || e) }
    }
  }

  /** 发新帖 */
  async function createTopic({ boardId, title, content, contentType = 0, type = 0, tag1 = -1, tag2 = -1 }) {
    const bid = Number(boardId)
    if (!bid) throw new CC98Error('缺 boardId')
    const t = String(title ?? '').trim()
    if (!t) throw new CC98Error('缺 title')
    if (!content || !String(content).trim()) throw new CC98Error('缺 content')
    await api(`/board/${bid}/topic`, {
      method: 'POST',
      body: { title: t, content: String(content), contentType: Number(contentType) ? 1 : 0, type: Number(type) || 0, tag1: Number(tag1) || -1, tag2: Number(tag2) || -1 },
    })
    const v = await verifyTopicCreated(bid, t)
    return {
      ok: true,
      sent: true,
      verified: v.verified,
      topicId: v.topicId ?? null,
      url: v.topicId ? `https://www.cc98.org/topic/${v.topicId}` : null,
      note: v.verified ? '已回查确认发出来了' : 'HTTP 200（普通帖直接成功），但回查没在版面第一页看到它 —— 可能审核/延迟，去版面看一眼',
    }
  }

  /** 回帖（回复主题；引用回复也是它，正文前面拼 [quote]） */
  async function replyTopic(topicId, { content, contentType = 0 }) {
    const tid = Number(topicId)
    if (!tid) throw new CC98Error('缺 topicId')
    if (!content || !String(content).trim()) throw new CC98Error('缺 content')
    let before = null
    try { before = await api(`/topic/${tid}`) } catch { /* 拿不到旧值就不做前后对比 */ }
    await api(`/topic/${tid}/post`, {
      method: 'POST',
      body: { title: '', content: String(content), contentType: Number(contentType) ? 1 : 0 },
    })
    let verified = false
    try {
      const after = await api(`/topic/${tid}`)
      const b = Number(before?.replyCount ?? -1)
      const a = Number(after?.replyCount ?? -2)
      verified = b >= 0 && a > b
    } catch { /* 回查失败不算发失败 */ }
    return {
      ok: true,
      sent: true,
      verified,
      url: `https://www.cc98.org/topic/${tid}`,
      note: verified ? '已回查确认楼层数 +1' : 'HTTP 200；回查没确认到楼层变化（可能延迟），去帖子看一眼',
    }
  }

  /**
   * 引用回复：98 没有「楼中楼评论」接口（官方 PWA / Forum / CLI / API 文档四处都没有），
   * 最接近的就是引用回复 —— 拼一段官方同款 [quote] 前缀，再正常回帖（占一个新楼层）。
   * @param {number} topicId
   * @param {{postId:number, content:string, posts?:number}} opts
   */
  async function quoteReply(topicId, { postId, content, posts = 50 }) {
    const tid = Number(topicId)
    const pid = Number(postId)
    if (!tid) throw new CC98Error('缺 topicId')
    if (!pid) throw new CC98Error('缺 postId（要引用哪一层）')
    if (!content || !String(content).trim()) throw new CC98Error('缺 content')
    const t = await topic(tid, Math.max(5, Math.min(50, Number(posts) || 50)))
    const p = (t.posts || []).find((x) => Number(x.postId) === pid)
    if (!p) {
      throw new CC98Error(`在这个帖子的前 ${Math.max(5, Math.min(50, Number(posts) || 50))} 楼里没找到 postId=${pid}；`
        + '把 posts 调大（最多 50）或换一个帖子再试')
    }
    const raw = p.contentRaw || p.content || ''
    const quote = `[quote][b]以下是引用${p.floor}楼：用户${p.author}在${fmtTime(p.time)}的发言：`
      + `[color=blue][url=/topic/${tid}#${p.floor}]>>查看原帖<<[/url][/color][/b]\n${raw}[/quote]\n`
    return replyTopic(tid, { content: quote + String(content) })
  }

  return {
    home,
    credentialPath: credPath,
    tokenPath,
    setCredential,
    getCredentialSummary,
    ensureLogin,
    logout,
    status,
    me,
    front,
    topic,
    board,
    latest,
    search,
    boardsList,
    createTopic,
    replyTopic,
    quoteReply,
  }
}
