/**
 * lib/state.mjs —— 插件的"家"与配置读写
 * ============================================================================
 * 规矩：**配置、凭证、token、预设、日志都放插件自己的家**
 *   `$DSH_HOME/cc98-duty/`，绝不写进插件包目录（装进 node_modules 后可能只读，升级会被覆盖）。
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/**
 * ⭐ ctx.get('dshHomePath') 返回的是**函数**不是字符串：
 *   `dshHomePath(...segments) => join(resolveDshHome(), ...segments)`。
 *   当字符串用会让路径变成「函数源码 + \cc98-duty」⇒ mkdir ENOENT ⇒ 插件不激活。
 */
export function stateDirOf(ctx) {
  let dir = ''
  try {
    const p = ctx?.get?.('dshHomePath')
    if (typeof p === 'function') {
      const v = p('cc98-duty')
      if (v) dir = String(v)
    } else if (typeof p === 'string' && p) {
      dir = join(p, 'cc98-duty')
    }
  } catch { /* 拿不到就用下面的兜底 */ }
  if (!dir) dir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'cc98-duty')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}

export function writeJson(file, value) {
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, file)
}

/** 本地日期 YYYY-MM-DD */
export function dayKey(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

export function nowIso() {
  return new Date().toISOString()
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
  return dir
}

export function exists(p) {
  try { return existsSync(p) } catch { return false }
}
