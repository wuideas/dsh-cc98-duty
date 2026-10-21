/**
 * dsh-cc98-duty —— 浏览器半端（「设置」里的一页「刷CC98」）
 * ============================================================================
 * 形态照抄同一台机器上已经验收过的 dsh-bili-scroll：
 *
 *   window.__ModuleLoader__.load({
 *     id: 'dsh-cc98-duty',                       // 必须等于 package.json 的 name
 *     factory: (require) => { ... return { inject: ['slots'], apply(ctx) {...} } },
 *   })
 *
 * 约定：
 *   · client bundle 不是 ESM、也不是普通 React 组件文件，是自注册脚本。
 *   · React 只能 require('react')，不许 import。
 *   · 进「设置」用 slots.inject('settings.section', ...)，label 是左侧导航那一项。
 *   · 所有网络请求走 /api/cc98-duty/*（宿主半端 index.js 注册的路由）。
 *     **必须检查 res.ok，也要看 body 里的 ok:false** —— 「HTTP 500 被当成保存成功」
 *     是 bili 踩过的坑，这里把失败一律 throw 出来显示在页面上。
 *
 * 这一页要满足使用者对「刷CC98」的期待：
 *   顶部状态 → 账号 → 值班设置 → 写操作闸门（危险区）→ 预设 → 试一下 → 底部小字。
 *   写操作默认关；改预设时如果还没保存，切下拉框要先问一句。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-cc98-duty',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = '/api/cc98-duty'
    /** 与宿主 index.js 的 DEFAULTS.perDay 保持一致（只有宿主没给值时才用到） */
    const DEFAULT_PER_DAY = 2
    /** 宿主默认预设名（prompts/duty.md） */
    const DEFAULT_PRESET = 'duty'

    const clampInt = (v, min, max, dflt) => {
      const n = Number(v)
      if (!Number.isFinite(n)) return dflt
      return Math.max(min, Math.min(max, Math.trunc(n)))
    }
    const errText = (e) => (e && e.message ? String(e.message) : String(e == null ? '未知错误' : e))

    /* ────────────── 网络：res.ok 与 body.ok 都要看 ────────────── */

    const readJson = async (res) => {
      let text = ''
      try { text = await res.text() } catch { return null }
      if (!text) return null
      try { return JSON.parse(text) } catch { return { ok: false, error: text.slice(0, 300) } }
    }

    /**
     * body === undefined ⇒ GET；否则 POST JSON。
     * 任何失败都 throw Error（由页面显示 message），绝不把失败当成功。
     */
    const jfetch = async (path, body) => {
      const init = { credentials: 'same-origin' }
      if (body !== undefined) {
        init.method = 'POST'
        init.headers = { 'content-type': 'application/json' }
        init.body = JSON.stringify(body === null ? {} : body)
      }
      let res
      try {
        res = await fetch(API + path, init)
      } catch (e) {
        throw new Error('连不上插件后端（' + errText(e) + '）')
      }
      const data = await readJson(res)
      if (!res.ok) {
        const why = res.status === 401 ? '（未登录 / 没权限）' : res.status === 403 ? '（被宿主拦了）' : ''
        const detail = data && data.error ? '：' + data.error : ''
        throw new Error('HTTP ' + res.status + why + detail)
      }
      if (!data || typeof data !== 'object') throw new Error('插件后端返回了空响应')
      if (data.ok === false) throw new Error(data.error || '插件后端返回 ok:false（没给原因）')
      return data
    }
    const apiGet = (path) => jfetch(path)
    const apiPost = (path, body) => jfetch(path, body === undefined ? {} : body)

    /* ────────────── 样式：沿用 bili 的内联 <style> + data-* 选择器 ──────────────
     * 颜色一律走 DSH 的 --dsw-alias-* 变量、兜底中性 rgba ⇒ 深浅色都不刺眼。
     * 只有强调色（蓝 #3b82f6）和告警色（琥珀 #f59e0b）是写死的，跟 bili 一致。 */
    const CSS = `
[data-cc-page]{display:flex;flex-direction:column;gap:18px;padding:2px 2px 8px;max-width:640px;font-size:13px;}
[data-cc-sec]{display:flex;flex-direction:column;gap:8px;}
[data-cc-h]{font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-cc-row]{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
[data-cc-grow]{flex:1 1 0;min-width:0;}
[data-cc-label]{font-size:13px;}
[data-cc-note]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);word-break:break-word;}
[data-cc-top]{display:flex;flex-direction:column;gap:7px;padding:10px 12px;border-radius:10px;
  border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.08));}
[data-cc-badges]{display:flex;flex-wrap:wrap;gap:6px;align-items:center;}
[data-cc-badge]{font-size:11px;line-height:18px;padding:1px 7px;border-radius:6px;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.14));
  color:var(--dsw-alias-label-secondary,#c9ccd1);}
[data-cc-badge][data-good]{color:#22c55e;}
[data-cc-badge][data-warn]{color:#f59e0b;}
[data-cc-sw]{flex:none;width:38px;height:22px;border-radius:11px;border:0;cursor:pointer;position:relative;
  background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.35));transition:background .15s;padding:0;}
[data-cc-sw][data-on]{background:#3b82f6;}
[data-cc-sw] i{position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;
  transition:left .15s;display:block;}
[data-cc-sw][data-on] i{left:19px;}
[data-cc-sw][disabled]{opacity:.45;cursor:default;}
[data-cc-input]{width:100%;box-sizing:border-box;padding:7px 9px;border-radius:8px;font-size:12px;
  border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.22));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.10));color:inherit;font-family:inherit;}
[data-cc-input]:focus{outline:none;border-color:#3b82f6;}
[data-cc-input][disabled]{opacity:.5;cursor:default;}
[data-cc-num]{width:88px;flex:none;text-align:center;}
[data-cc-code]{font-family:ui-monospace,SFMono-Regular,Consolas,'Liberation Mono',monospace;
  font-size:11px;line-height:17px;min-height:170px;resize:vertical;}
textarea[data-cc-input]{resize:vertical;}
[data-cc-dim]{opacity:.55;}
[data-cc-dim] [data-cc-input][disabled]{opacity:1;}
[data-cc-btn]{padding:7px 12px;border-radius:8px;font-size:12px;cursor:pointer;font-family:inherit;
  border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.24));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.14));color:inherit;transition:background .15s;}
[data-cc-btn]:hover:not([disabled]){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.24));}
[data-cc-btn][data-primary]{background:#3b82f6;border-color:#3b82f6;color:#fff;}
[data-cc-btn][data-primary]:hover:not([disabled]){background:#2f6fe0;border-color:#2f6fe0;}
[data-cc-btn][disabled]{opacity:.5;cursor:default;}
[data-cc-msg]{font-size:11px;line-height:16px;padding:7px 9px;border-radius:8px;word-break:break-word;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));
  color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-cc-msg][data-warn]{color:#f59e0b;}
[data-cc-msg][data-good]{color:#22c55e;}
[data-cc-danger]{padding:12px;border-radius:10px;
  border:1px solid rgba(245,158,11,.36);background:rgba(245,158,11,.06);}
[data-cc-danger] > [data-cc-h]{color:#f59e0b;}
[data-cc-warnbox]{font-size:12px;line-height:18px;padding:8px 10px;border-radius:8px;
  border-left:3px solid #f59e0b;background:rgba(245,158,11,.10);
  color:var(--dsw-alias-label-secondary,#c9ccd1);}
[data-cc-rule]{height:1px;margin:2px 0;background:var(--dsw-alias-border-l2,rgba(128,128,128,.18));}
[data-cc-foot]{padding-top:10px;border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.14));}
`

    /* ────────────── 小组件 ────────────── */

    function Switch({ on, onChange, disabled }) {
      return h('button', {
        'data-cc-sw': '',
        'data-on': on ? '' : undefined,
        disabled: Boolean(disabled),
        title: on ? '已开' : '已关',
        onClick: () => { if (!disabled) onChange(!on) },
      }, h('i'))
    }

    function ToggleRow({ label, note, on, onChange, disabled }) {
      return h('div', { 'data-cc-row': '' },
        h('div', { 'data-cc-grow': '' },
          h('div', { 'data-cc-label': '' }, label),
          note ? h('div', { 'data-cc-note': '' }, note) : null),
        h(Switch, { on: Boolean(on), onChange, disabled }))
    }

    /** 预设名 → 人看的 label（找不到就退回名字本身） */
    const presetLabelOf = (name, list) => {
      const hit = (Array.isArray(list) ? list : []).find((x) => x && x.name === name)
      return hit && hit.label ? String(hit.label) : String(name || '（未命名）')
    }

    /* ══════════════════════════════════════════════════════════════════════
     * 设置页正文
     * ══════════════════════════════════════════════════════════════════════ */

    function Panel() {
      const [st, setSt] = React.useState(null)       // GET /status 的返回
      const [loadErr, setLoadErr] = React.useState('')
      const [busy, setBusy] = React.useState('')     // 正在进行的动作 key（'' = 空闲）
      const [msg, setMsg] = React.useState(null)     // { where, tone, text } —— 只显示在对应段落里

      /* ⚠️ 输入框全部绑「本地草稿」：status 刷新不能把用户正在打的字冲掉
       * （bili 2026-10-14 被陌生人验收时抓到过这个 bug）。 */
      const [perDay, setPerDay] = React.useState(null)
      const [kws, setKws] = React.useState(null)
      const [ws, setWs] = React.useState(null)
      const [confirmWord, setConfirmWord] = React.useState(null)
      const [userName, setUserName] = React.useState('')
      const [password, setPassword] = React.useState('')
      const [presetName, setPresetName] = React.useState(null)
      const [presetText, setPresetText] = React.useState('')
      const [presetBase, setPresetBase] = React.useState('')   // 上次读到/保存成功的内容
      const [presetReady, setPresetReady] = React.useState(false)

      const alive = React.useRef(true)
      const prefilled = React.useRef(false)          // 账号输入框只自动铺一次

      React.useEffect(() => {
        alive.current = true
        return () => { alive.current = false }
      }, [])

      const say = (where, text, tone) => {
        if (!alive.current) return
        setMsg({ where: where, text: String(text == null ? '' : text), tone: tone || '' })
      }
      const clearSay = (where) => setMsg((old) => (old && old.where === where ? null : old))

      /* ── 读状态 ── */
      async function fetchStatus() {
        try {
          const d = await apiGet('/status')
          if (!alive.current) return false
          setSt(d)
          setLoadErr('')
          return true
        } catch (e) {
          if (!alive.current) return false
          // 首屏失败才砸出整页错误；已经渲染出页面时刷新失败不清空旧数据
          if (!st) setLoadErr(errText(e))
          return false
        }
      }

      React.useEffect(() => { fetchStatus() }, [])   // 只在挂载时拉一次，不轮询

      async function doRefresh() {
        setBusy('refresh')
        const ok = await fetchStatus()
        if (!alive.current) return
        if (ok) clearSay('status')
        else say('status', st
          ? '刷新失败，页面显示的还是上次的数据（插件后端没有响应或返回了错误）'
          : '刷新失败：插件后端没有响应', 'warn')
        setBusy('')
      }

      /* ── 配置 patch（所有开关 / 保存按钮都走这里） ── */
      async function patchConfig(body, where, what, busyKey) {
        setBusy(busyKey)
        try {
          const r = await apiPost('/config', { patch: body })
          if (!alive.current) return false
          if (r.config && typeof r.config === 'object') {
            setSt((old) => (old ? { ...old, config: r.config } : old))
          }
          /* host = 有没有同步到 DSH 原生设置；失败只提示，不算致命。
           * applied = 宿主真正收下的字段；没列进去的说明这个版本的宿主还不认识，
           * 必须说出来，不能假装保存成功（例如 dutyReadOnly 老宿主会忽略）。 */
          const keys = Object.keys(body || {})
          const applied = r.applied && typeof r.applied === 'object' ? r.applied : null
          const ignored = applied ? keys.filter((k) => !(k in applied)) : []
          const hostErr = r.host && r.host.ok === false ? String(r.host.error || 'DSH 原生设置没写成') : ''
          let tone = 'good'
          let text = (what || '设置') + '：已保存'
          if (keys.length && ignored.length === keys.length) {
            tone = 'warn'
            text = (what || '设置') + '失败：宿主没认这些字段（' + ignored.join('、')
              + '）—— 设置页可能比插件本体新，什么都没改'
          } else {
            const extra = []
            if (ignored.length) extra.push('宿主忽略了：' + ignored.join('、'))
            if (hostErr) extra.push('插件自己那份已保存，但没同步到 DSH 原生设置（' + hostErr + '）')
            if (extra.length) { tone = 'warn'; text += '（' + extra.join('；') + '）' }
          }
          say(where, text, tone)
          await fetchStatus()
          return true
        } catch (e) {
          if (alive.current) say(where, (what || '设置') + '失败：' + errText(e), 'warn')
          return false
        } finally {
          if (alive.current) setBusy('')
        }
      }

      /* ── 值班设置 ── */
      async function saveDuty() {
        const n = clampInt(perDay, 0, 20, DEFAULT_PER_DAY)
        const list = String(kws == null ? '' : kws)
          .split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 40)
        setPerDay(String(n))
        setKws(list.join('\n'))
        await patchConfig(
          { perDay: n, keywords: list, workspace: String(ws == null ? '' : ws).trim() },
          'duty', '值班设置', 'save-duty',
        )
      }

      /* ── 写操作闸门 ── */
      async function setWrite(v) {
        await patchConfig({ writeEnabled: Boolean(v) }, 'gate',
          '写操作闸门' + (v ? '（打开）' : '（关闭）'), 'gate-write')
      }

      async function saveWord() {
        const w = String(confirmWord == null ? '' : confirmWord).trim()
        if (!w) { say('gate', '确认词不能为空 —— 空确认词等于写操作全被拒', 'warn'); return }
        if (w.length > 40) { say('gate', '确认词最长 40 个字', 'warn'); return }
        setConfirmWord(w)
        await patchConfig({ confirmWord: w }, 'gate', '确认词', 'save-word')
      }

      async function setDutyReadOnly(v) {
        await patchConfig({ dutyReadOnly: Boolean(v) }, 'gate',
          '值班只读' + (v ? '（开）' : '（关）'), 'gate-ro')
      }

      /* ── 登录 / 退出 ── */
      async function doLogin() {
        const u = String(userName || '').trim()
        const p = String(password || '')
        if (!u || !p) { say('account', '账号和密码都要填（密码不回显，只提交这一次）', 'warn'); return }
        setBusy('login')
        try {
          const r = await apiPost('/login', { username: u, password: p })
          if (!alive.current) return
          const name = r.user && r.user.name ? String(r.user.name) : u
          const min = Number(r.expiresInMin)
          say('account', '已登录：' + name
            + (Number.isFinite(min) && min > 0 ? '（token 约 ' + min + ' 分钟后过期）' : ''), 'good')
          setPassword('')
          await fetchStatus()
        } catch (e) {
          if (alive.current) say('account', '登录失败：' + errText(e), 'warn')
        } finally {
          if (alive.current) setBusy('')
        }
      }

      async function doLogout() {
        setBusy('logout')
        try {
          await apiPost('/logout')
          if (!alive.current) return
          say('account', '已退出登录（本机 credential.json 还在，下次点「登录」就行）', 'good')
          await fetchStatus()
        } catch (e) {
          if (alive.current) say('account', '退出登录失败：' + errText(e), 'warn')
        } finally {
          if (alive.current) setBusy('')
        }
      }

      /* ── 试一下 ── */
      async function doTest() {
        setBusy('test')
        say('test', '正在测试…', '')
        try {
          const r = await apiPost('/test')
          if (!alive.current) return
          const s = r.sample && typeof r.sample === 'object' ? r.sample : {}
          const hot = clampInt(s.hotCount, 0, 1e9, 0)
          const boards = clampInt(s.boardsCount, 0, 1e9, 0)
          const first = s.firstTitle ? String(s.firstTitle) : '（没有）'
          say('test', '网络正常 · 热门 ' + hot + ' 条 · 版面 ' + boards + ' 个 · 第一条：' + first, 'good')
        } catch (e) {
          if (alive.current) say('test', '测试没通过：' + errText(e), 'warn')
        } finally {
          if (alive.current) setBusy('')
        }
      }

      /* ── 预设 ── */
      async function loadPreset(name) {
        const n = String(name || '')
        if (!n) { setPresetText(''); setPresetBase(''); setPresetReady(false); return }
        setBusy('preset-load')
        try {
          const r = await apiGet('/preset?name=' + encodeURIComponent(n))
          if (!alive.current) return
          const content = typeof r.content === 'string' ? r.content : String(r.content == null ? '' : r.content)
          setPresetText(content)
          setPresetBase(content)
          setPresetReady(true)
          clearSay('preset')
        } catch (e) {
          if (!alive.current) return
          // 读失败就别让「保存」有机会把别的预设内容写进去
          setPresetReady(false)
          setPresetText('')
          setPresetBase('')
          say('preset', '读取预设「' + n + '」失败：' + errText(e), 'warn')
        } finally {
          if (alive.current) setBusy('')
        }
      }

      async function onPresetChange(e) {
        const next = String(e.target.value || '')
        if (next === presetName) return
        const dirty = presetReady && presetText !== presetBase
        if (dirty) {
          const ask = typeof window !== 'undefined' && typeof window.confirm === 'function'
          const ok = ask
            ? window.confirm('预设「' + presetLabelOf(presetName, presets) + '」有没保存的改动，切到「'
                + presetLabelOf(next, presets) + '」会丢掉这些改动。确定切换吗？')
            : true
          if (!ok) { e.target.value = presetName == null ? '' : String(presetName); return }
        }
        setPresetName(next)
        await loadPreset(next)
      }

      async function savePresetFile() {
        if (!presetName) { say('preset', '没有选中的预设 —— 先在上面选一个', 'warn'); return }
        if (!presetReady) { say('preset', '这个预设还没读出来，不能保存（先点「重新读取」）', 'warn'); return }
        if (presetText === presetBase) { say('preset', '内容没改动，不用保存', ''); return }
        setBusy('preset-save')
        try {
          await apiPost('/preset', { name: presetName, content: presetText })
          if (!alive.current) return
          setPresetBase(presetText)
          say('preset', '已保存预设「' + presetLabelOf(presetName, presets)
            + '」（' + String(presetText).length + ' 字）', 'good')
          await fetchStatus()
        } catch (e) {
          if (alive.current) say('preset', '保存预设失败：' + errText(e), 'warn')
        } finally {
          if (alive.current) setBusy('')
        }
      }

      /* ── 从 status 里拆出各段用的值（st 还没到时全用空对象兜底；任何字段缺失都有默认值） ── */
      const cfg = st && st.config && typeof st.config === 'object' ? st.config : {}
      const presets = st && Array.isArray(st.presets)
        ? st.presets.filter((p) => p && typeof p === 'object' && p.name)
        : []
      const cc98 = st && st.cc98 && typeof st.cc98 === 'object' ? st.cc98 : {}
      const account = st && st.account && typeof st.account === 'object'
        ? st.account
        : (cc98.credential && typeof cc98.credential === 'object' ? cc98.credential : {})
      const writeInfo = st && st.write && typeof st.write === 'object' ? st.write : {}
      const home = st && st.home ? String(st.home) : ''
      const version = st && st.version ? String(st.version) : '?'
      const defaultPreset = cfg.presetName ? String(cfg.presetName) : DEFAULT_PRESET

      /* 草稿初始化：只在第一次拿到配置时铺；之后 status 刷新不覆盖（会冲掉正在打的字） */
      React.useEffect(() => {
        if (!st || !st.config) return
        if (perDay === null) setPerDay(String(clampInt(cfg.perDay, 0, 20, DEFAULT_PER_DAY)))
        if (kws === null) setKws(Array.isArray(cfg.keywords) ? cfg.keywords.join('\n') : '')
        if (ws === null) setWs(typeof cfg.workspace === 'string' ? cfg.workspace : '')
        if (confirmWord === null) setConfirmWord(typeof cfg.confirmWord === 'string' ? cfg.confirmWord : '')
      }, [cfg])

      /* 账号输入框：第一次知道本机存过哪个账号时铺进去；密码永远不回显 */
      React.useEffect(() => {
        if (prefilled.current) return
        const savedName = account && account.configured !== false && account.username
          ? String(account.username) : ''
        if (!savedName) return
        prefilled.current = true
        setUserName((old) => (old ? old : savedName))
      }, [account])

      /* 预设：第一次拿到 presets 时挑一个（默认 cfg.presetName，没有就第一份）并读内容 */
      React.useEffect(() => {
        if (!st || presetName !== null) return
        if (!presets.length) return   // 空列表先不选；等刷新/宿主铺好预设后再初始化
        const want = defaultPreset
        const pick = presets.some((p) => p.name === want)
          ? want
          : (presets[0] && presets[0].name ? String(presets[0].name) : '')
        setPresetName(pick)
        if (pick) loadPreset(pick)
      }, [st])

      /* 预设列表变了（比如被删了）：当前选中的不在了就换到第一份
       * 注意：不能把「没有预设」当成选中，否则 select 的 value 会跟选项对不上。 */
      React.useEffect(() => {
        if (!presets.length || presetName === null || presetDirty) return
        if (presets.some((p) => p.name === presetName)) return
        const pick = String(presets[0].name)
        setPresetName(pick)
        loadPreset(pick)
      }, [st])

      /* ── 页面上的小工具 ── */
      const msgFor = (where) => {
        if (!msg || msg.where !== where) return null
        return h('div', {
          'data-cc-msg': '',
          'data-good': msg.tone === 'good' ? '' : undefined,
          'data-warn': msg.tone === 'warn' ? '' : undefined,
        }, msg.text)
      }
      const btn = (key, label, onClick, opts) => {
        const o = opts || {}
        return h('button', {
          'data-cc-btn': '',
          'data-primary': o.primary ? '' : undefined,
          disabled: Boolean(busy) || Boolean(o.disabled),
          onClick: () => { if (!busy) onClick() },
        }, busy === key ? '…' : label)
      }

      /* ── 首屏：还没拿到 status ── */
      if (!st) {
        return h('div', { 'data-cc-page': '' },
          h('div', { 'data-cc-top': '' },
            h('div', { 'data-cc-badges': '' },
              h('span', { 'data-cc-badge': '' }, loadErr ? '读取失败' : '读取中…')),
            h('div', { 'data-cc-note': '' }, loadErr
              ? '读不到插件状态：' + loadErr
              : '正在向插件后端要状态…')),
          loadErr ? h('div', { 'data-cc-msg': '', 'data-warn': '' },
            '设置页读不到数据。常见原因：插件刚装完还没重启 dsh；或者这个插件版本没有 /api/cc98-duty 路由。') : null,
          loadErr ? h('div', { 'data-cc-row': '' }, btn('refresh', '重试', doRefresh)) : null,
        )
      }

      /* ── 派生值 ── */
      const network = typeof cc98.network === 'string' ? cc98.network : '未知'
      const networkWarn = /不可达|失败|错误|error/i.test(network)
      const tokenText = typeof cc98.token === 'string' ? cc98.token : ''
      const cc98User = cc98.user && typeof cc98.user === 'object' ? cc98.user : null
      const loggedIn = Boolean(cc98User && cc98User.name) || tokenText === '有效'
      const extMin = Number(cc98.token_expires_in_min)
      let loginText = cc98User && cc98User.name
        ? '已登录：' + String(cc98User.name)
        : (tokenText ? '登录：' + tokenText : '登录：未知')
      if (loggedIn && Number.isFinite(extMin)) {
        loginText += extMin >= 0 ? '（token 剩 ' + extMin + ' 分钟）' : '（token 已过期）'
      }
      const acctName = account && account.configured !== false && account.username
        ? String(account.username) : ''
      const writeOn = typeof cfg.writeEnabled === 'boolean' ? cfg.writeEnabled : writeInfo.enabled === true
      const roOn = typeof cfg.dutyReadOnly === 'boolean' ? cfg.dutyReadOnly : true
      const wordSet = writeInfo.confirmWordSet === true
        || (typeof cfg.confirmWord === 'string' && cfg.confirmWord.length > 0)
      const selectedPreset = presets.find((p) => p.name === presetName) || null
      const presetDirty = presetReady && presetText !== presetBase

      return h('div', { 'data-cc-page': '' },

        /* 1 ── 顶部状态条 ── */
        h('div', { 'data-cc-top': '' },
          h('div', { 'data-cc-badges': '' },
            h('span', {
              'data-cc-badge': '',
              'data-good': networkWarn ? undefined : '',
              'data-warn': networkWarn ? '' : undefined,
            }, 'CC98 网络：' + network),
            h('span', { 'data-cc-badge': '', 'data-good': loggedIn ? '' : undefined }, loginText),
            acctName ? h('span', { 'data-cc-badge': '' }, '本站账号：' + acctName) : null,
            h('span', { 'data-cc-badge': '' }, 'v' + version),
            h('div', { 'data-cc-grow': '' }),
            btn('refresh', '刷新', doRefresh)),
          h('div', { 'data-cc-note': '' }, '家目录：' + (home || '（未知）')),
          msgFor('status')),

        /* 2 ── 账号 ── */
        h('div', { 'data-cc-sec': '' },
          h('div', { 'data-cc-h': '' }, 'CC98 账号'),
          h('div', { 'data-cc-row': '' },
            h('input', {
              'data-cc-input': '', 'data-cc-grow': '',
              placeholder: 'CC98 站内账号（不是学号 / 不是校园卡号）',
              value: userName,
              autoComplete: 'username',
              spellCheck: false,
              disabled: Boolean(busy),
              onChange: (e) => { prefilled.current = true; setUserName(e.target.value) },
            }),
            h('input', {
              'data-cc-input': '', 'data-cc-grow': '', type: 'password',
              placeholder: 'CC98 站内密码（只提交，不回显）',
              value: password,
              autoComplete: 'current-password',
              disabled: Boolean(busy),
              onChange: (e) => setPassword(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter' && !busy) doLogin() },
            }),
            h('button', {
              'data-cc-btn': '', 'data-primary': '', disabled: Boolean(busy), onClick: doLogin,
            }, busy === 'login' ? '…' : '登录'),
            loggedIn ? h('button', {
              'data-cc-btn': '', disabled: Boolean(busy), onClick: doLogout,
            }, busy === 'logout' ? '…' : '退出') : null),
          h('div', { 'data-cc-note': '' },
            '账号密码只落本机 ~/.dsh/cc98-duty/credential.json（不写进 DSH 的 profile，也不上传）。',
            h('br'),
            loggedIn
              ? '现在登录的是：' + (cc98User && cc98User.name ? String(cc98User.name) : (acctName || '（已登录）'))
              : (acctName
                  ? '本机存了账号「' + acctName + '」，但登录态不可用 —— 重新填一次密码登录。'
                  : '还没登录过。CC98 要浙大内网；登录用站内账号密码，不是统一身份认证。')),
          msgFor('account')),

        /* 3 ── 值班设置 ── */
        h('div', { 'data-cc-sec': '' },
          h('div', { 'data-cc-h': '' }, '值班设置'),
          h('div', { 'data-cc-row': '' },
            h('div', { 'data-cc-grow': '' },
              h('div', { 'data-cc-label': '' }, '每天最多挑几条'),
              h('div', { 'data-cc-note': '' }, '0 = 不自动（手动「跑一轮」仍然可以）')),
            h('input', {
              'data-cc-input': '', 'data-cc-num': '', type: 'number', min: 0, max: 20,
              value: perDay == null ? '' : perDay,
              disabled: Boolean(busy),
              onChange: (e) => setPerDay(e.target.value),
              onBlur: () => setPerDay(String(clampInt(perDay, 0, 20, DEFAULT_PER_DAY))),
            })),
          h('div', { 'data-cc-label': '' }, '关注关键词（一行一个）'),
          h('textarea', {
            'data-cc-input': '', rows: 4,
            placeholder: '一行一个关键词；留空用默认（保研 / 推免 / 选课 / 课程评价 / 实习 / 科研）',
            value: kws == null ? '' : kws,
            disabled: Boolean(busy),
            onChange: (e) => setKws(e.target.value),
          }),
          h('div', { 'data-cc-note': '' },
            '留空 = 用宿主内置的那几组关键词。关键词只在「值夜班」这类预设里用得到，不影响手动读帖。'),
          h('div', { 'data-cc-label': '' }, '平时工作区路径'),
          h('input', {
            'data-cc-input': '',
            placeholder: '例如 C:/Users/<你>/Documents/我的工作区（留空 = 不读人设）',
            value: ws == null ? '' : ws,
            disabled: Boolean(busy),
            onChange: (e) => setWs(e.target.value),
          }),
          h('div', { 'data-cc-note': '' },
            '留空 = 不读任何 AGENTS.md，按中性口吻说话；填了才会按那个工作区里的人设来。'),
          h('div', { 'data-cc-row': '' },
            btn('save-duty', '保存', saveDuty, { primary: true }),
            h('div', { 'data-cc-note': '' }, '改完数字 / 关键词 / 工作区，点一下「保存」才生效。')),
          msgFor('duty')),

        /* 4 ── 写操作闸门（危险区） ── */
        h('div', { 'data-cc-sec': '', 'data-cc-danger': '' },
          h('div', { 'data-cc-h': '' }, '写操作闸门（危险区）'),
          h(ToggleRow, {
            label: '允许模型用这个号发公开内容',
            note: '默认关。关着时回帖 / 评论 / 发帖一律被宿主拒绝（只读照常）。',
            on: writeOn,
            disabled: Boolean(busy),
            onChange: setWrite,
          }),
          h('div', { 'data-cc-warnbox': '' },
            '⚠️ 打开后模型可以拿这个号发公开内容 —— 发出去的字都算在账号主人头上，先确认你愿意。'),
          h('div', { 'data-cc-dim': writeOn ? undefined : '' },
            h('div', { 'data-cc-row': '' },
              h('div', { 'data-cc-grow': '' },
                h('div', { 'data-cc-label': '' }, '确认词'),
                h('div', { 'data-cc-note': '' },
                  writeOn
                    ? '每次发评论 / 回复 / 发帖都必须带这个确认词，宿主会逐个核对；对不上就不发。'
                    : '总闸关着时这里改不了。打开上面的开关后，才能设置/修改确认词。')),
              h('input', {
                'data-cc-input': '', 'data-cc-grow': '', placeholder: '例如：我确认',
                value: confirmWord == null ? '' : confirmWord,
                disabled: Boolean(busy) || !writeOn,
                onChange: (e) => setConfirmWord(e.target.value),
              }),
              btn('save-word', '保存确认词', saveWord, { disabled: !writeOn })),
            h('div', { 'data-cc-row': '' },
              h('span', {
                'data-cc-badge': '', 'data-warn': wordSet ? undefined : '',
              }, wordSet ? '确认词已设置' : '确认词还没设 —— 写操作会被拒'))),
          h('div', { 'data-cc-rule': '' }),
          h(ToggleRow, {
            label: '值班轮保持只读',
            note: '默认开。关掉后值班轮本身不禁止写，但真正的写操作仍要过上面的总闸 + 确认词。',
            on: roOn,
            disabled: Boolean(busy),
            onChange: setDutyReadOnly,
          }),
          msgFor('gate')),

        /* 5 ── 预设 ── */
        h('div', { 'data-cc-sec': '' },
          h('div', { 'data-cc-h': '' }, '预设（「跑一轮」用的提示词）'),
          h('div', { 'data-cc-row': '' },
            h('select', {
              'data-cc-input': '', 'data-cc-grow': '',
              /* 受控 select 的 value 必须总能对上某个 option，否则 React 会报
               * "value does not match any option"（presetName 还没初始化时用第一份兜底） */
              value: presets.length === 0
                ? ''
                : String(presetName != null ? presetName : (presets[0] && presets[0].name) || ''),
              disabled: Boolean(busy) || presets.length === 0,
              onChange: onPresetChange,
            },
              presets.length
                ? presets.map((p) => h('option', { key: String(p.name), value: String(p.name) },
                    (p.label ? String(p.label) : String(p.name)) + (p.builtin ? '（内置）' : '（自定义）')))
                : h('option', { value: '' }, '（没有预设）')),
            presetDirty ? h('span', { 'data-cc-badge': '', 'data-warn': '' }, '有未保存改动') : null),
          selectedPreset
            ? h('div', { 'data-cc-note': '' },
                (selectedPreset.desc ? String(selectedPreset.desc) : '')
                + (typeof selectedPreset.chars === 'number' ? '（' + selectedPreset.chars + ' 字）' : ''))
            : null,
          presets.length === 0
            ? h('div', { 'data-cc-note': '' },
                '（没有预设）插件里一个预设都没有 —— 确认 prompts/ 目录在，然后重启 dsh 让宿主铺一遍预设。')
            : null,
          h('textarea', {
            'data-cc-input': '', 'data-cc-code': '', rows: 12,
            placeholder: presets.length ? '预设正文（Markdown）' : '（没有预设）',
            value: presetText,
            disabled: Boolean(busy) || presets.length === 0 || !presetReady,
            onChange: (e) => setPresetText(e.target.value),
          }),
          h('div', { 'data-cc-row': '' },
            btn('preset-save', '保存预设', savePresetFile, { primary: true, disabled: !presetDirty || !presetReady }),
            btn('preset-load', '重新读取', () => loadPreset(presetName), { disabled: !presetName }),
            btn('preset-default', '设为默认预设', async () => {
              if (!presetName) { say('preset', '先选一个预设', 'warn'); return }
              await patchConfig({ presetName: String(presetName) }, 'preset',
                '默认预设', 'preset-default')
            }, { disabled: !presetName }),
            h('div', { 'data-cc-note': '' }, presetText ? String(presetText.length) + ' 字' : '')),
          h('div', { 'data-cc-note': '' },
            '预设是给「跑一轮」用的提示词，默认用 ' + defaultPreset
            + '。这里改的是本机生效版；升级插件不会覆盖你改过的内容。'),
          msgFor('preset')),

        /* 6 ── 试一下 ── */
        h('div', { 'data-cc-sec': '' },
          h('div', { 'data-cc-h': '' }, '试一下'),
          h('div', { 'data-cc-row': '' },
            btn('test', '测试 98 连接', doTest, { primary: true }),
            h('div', { 'data-cc-note': '' }, '拉一次首页 + 版面表，验证网络和接口都通（游客就能测，不消耗登录态）。')),
          msgFor('test')),

        /* 7 ── 底部小字 ── */
        h('div', { 'data-cc-sec': '', 'data-cc-foot': '' },
          h('div', { 'data-cc-note': '' },
            '插件家目录：' + (home || '（未知）'),
            h('br'),
            '版本：v' + version + ' · 包名 dsh-cc98-duty',
            h('br'),
            '本插件不收集任何数据；凭证只落本机。')),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        /* 样式：内联 <style>，随插件卸载一起摘掉（抄 bili） */
        if (typeof document !== 'undefined') {
          const style = document.createElement('style')
          style.setAttribute('data-plugin-css', 'dsh-cc98-duty')
          style.textContent = CSS
          document.head.appendChild(style)
          if (typeof ctx.effect === 'function') {
            ctx.effect(() => () => style.remove(), 'dsh-cc98-duty: 设置页样式')
          }
        }

        /* ⭐ 进「设置」：label 就是左侧导航里那一项（抄 dsh-meme / dsh-bili-scroll） */
        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'cc98-duty', order: 31, label: '刷CC98' },
          () => h(Panel),
        ))
      },
    }
  },
})
