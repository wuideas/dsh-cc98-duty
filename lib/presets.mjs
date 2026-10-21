/**
 * lib/presets.mjs —— 「预设」：插件自带的一叠提示词，用户可以改、可以另存
 * ============================================================================
 * 与 bili 的 duty.md 是同一个思路：**提示词是插件的一部分，但用户改过的那份要留住**。
 *   · 插件包里的 `prompts/<name>.md` 是出厂版
 *   · 家目录里的 `presets/<name>.md` 是生效版（首次启动从出厂版铺过去）
 *   · 记账 `presets/<name>.sha256`：家里那份 === 上次铺的 ⇒ 用户没改过 ⇒ 新版可覆盖
 *                                 家里那份 ≠ 上次铺的 ⇒ 用户改过 ⇒ 新版另存 `.md.new`，不覆盖
 * ============================================================================
 */
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

/** 出厂预设的说明（顺序就是设置页里的顺序） */
export const PRESET_META = [
  { name: 'duty', label: '值夜班 · 每日一轮', desc: '看首页 + 关注版面 + 关键词，挑出值得读的帖子写日报（只读）' },
  { name: 'watch', label: '关键词盯梢', desc: '只盯你关心的关键词，按时间列出候选，快速扫一眼' },
  { name: 'reply', label: '回帖助手', desc: '读懂一个帖子后起草回复；发不发由你确认（写操作）' },
  { name: 'post', label: '发帖草稿', desc: '按版面规矩起草新帖：标题、正文、发在哪个版（写操作）' },
]

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex')

function presetDir(stateDir) {
  const d = join(stateDir, 'presets')
  mkdirSync(d, { recursive: true })
  return d
}

function safeName(name) {
  return String(name || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40)
}

/**
 * 首次运行铺预设；用户改过的保留，新版另存 .new
 * @returns {string[]} 记了几条日志
 */
export function ensurePresets(pluginDir, stateDir, log = () => {}) {
  const notes = []
  const dir = presetDir(stateDir)
  const srcDir = join(pluginDir, 'prompts')
  for (const meta of PRESET_META) {
    const shippedFile = join(srcDir, meta.name + '.md')
    if (!existsSync(shippedFile)) { notes.push(`缺出厂预设：${shippedFile}`); continue }
    const homeFile = join(dir, meta.name + '.md')
    const ledger = join(dir, meta.name + '.sha256')
    const freshFile = join(dir, meta.name + '.md.new')
    const shipped = readFileSync(shippedFile, 'utf8')
    const hShip = sha(shipped)
    const readIf = (f) => { try { return readFileSync(f, 'utf8') } catch { return '' } }
    if (!existsSync(homeFile)) {
      writeFileSync(homeFile, shipped, 'utf8')
      writeFileSync(ledger, hShip, 'utf8')
      notes.push(`已铺预设：${meta.name}.md`)
      continue
    }
    const hHome = sha(readIf(homeFile))
    const hLast = readIf(ledger).trim()
    if (hHome === hShip) { if (hLast !== hShip) writeFileSync(ledger, hShip, 'utf8'); continue }
    if (!hLast || hHome !== hLast) {
      if (hShip !== hLast && readIf(freshFile) !== shipped) {
        writeFileSync(freshFile, shipped, 'utf8')
        notes.push(`预设 ${meta.name} 有新版、但你改过家里的那份 ⇒ 新版另存 ${meta.name}.md.new`)
      }
      continue
    }
    writeFileSync(homeFile, shipped, 'utf8')
    writeFileSync(ledger, hShip, 'utf8')
    notes.push(`预设 ${meta.name} 已更新到出厂版`)
  }
  for (const n of notes) log(n)
  return notes
}

/** 列出全部预设（出厂 + 用户自建） */
export function listPresets(stateDir) {
  const dir = presetDir(stateDir)
  let files = []
  try { files = readdirSync(dir).filter((f) => f.endsWith('.md')) } catch { /* 空 */ }
  const known = new Map(PRESET_META.map((m) => [m.name, m]))
  const out = []
  for (const f of files) {
    const name = f.replace(/\.md$/, '')
    let content = ''
    try { content = readFileSync(join(dir, f), 'utf8') } catch { continue }
    const meta = known.get(name)
    let updatedAt = null
    try { updatedAt = statSync(join(dir, f)).mtime.toISOString() } catch { /* 没有就算了 */ }
    out.push({
      name,
      label: meta ? meta.label : name,
      desc: meta ? meta.desc : '自定义预设',
      builtin: Boolean(meta),
      chars: content.length,
      updatedAt,
      preview: content.split('\n').slice(0, 4).join('\n'),
    })
  }
  out.sort((a, b) => (a.builtin === b.builtin ? a.name.localeCompare(b.name) : a.builtin ? -1 : 1))
  return out
}

export function readPreset(stateDir, name) {
  const n = safeName(name)
  if (!n) throw new Error('预设名不合法')
  const f = join(presetDir(stateDir), n + '.md')
  if (!existsSync(f)) throw new Error(`没有预设：${n}`)
  return { name: n, content: readFileSync(f, 'utf8'), path: f }
}

/** 保存预设（改出厂的那份 = 改家里的生效版；也可以新建自定义预设） */
export function savePreset(stateDir, name, content) {
  const n = safeName(name)
  if (!n) throw new Error('预设名不合法（只允许字母数字下划线短横线）')
  const dir = presetDir(stateDir)
  writeFileSync(join(dir, n + '.md'), String(content ?? ''), 'utf8')
  return { name: n, path: join(dir, n + '.md') }
}

export function presetFilePath(stateDir, name) {
  return join(presetDir(stateDir), safeName(name) + '.md')
}
