# dsh-cc98-duty ｜ 刷CC98

> **CC98（浙大校内论坛）的 DSH 插件** —— 看首页、读帖、搜帖、列版面，也能发帖 / 回帖 / 评论。
> 写操作**默认关**，要过「总闸 + 确认词」两道；这个号挂着使用者的浙大通行证，它写出去的每个字都算在他头上。
>
> GitHub：https://github.com/wuideas/dsh-cc98-duty
>
> ⚠️ **维护状态**：作者不打算继续维护。能用就行，坏了欢迎 fork 自己改（MIT）。

## 它是什么

- **纯 JS，零 Python**：宿主 Node 22+ 直接打 `api.cc98.org`，不用装 venv / pip / MCP 子进程
- **14 个工具**注册给模型：8 个读 + 3 个写 + 3 个元（配置 / 预设 / 登录状态）
- **设置页**：账号登录、值班上限、关键词、工作区、写操作闸门、预设编辑、连接测试
- **预设**：出厂四份提示词（`duty` 每日一轮 / `watch` 关键词盯梢 / `reply` 回帖助手 / `post` 发帖草稿），
  用户改过的那份会保留，插件升级只把新版另存 `.md.new`，不覆盖你的改动

## 装

```powershell
# 从 GitHub 装（需要 pnpm 能访问 GitHub）
dsh plugin --profile desktop add github:wuideas/dsh-cc98-duty

# 本地开发：把插件目录 link 进 desktop profile
dsh plugin --profile desktop add link:C:\Users\<你>\Documents\deepseek-harness\dsh-cc98-duty
```

装完还要让 profile 认识这个 bundle（`dsh plugin add` 只装依赖）：

1. `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 里加 `"dsh-cc98-duty"`
2. `~/.dsh/profiles/desktop/cordis.patch.yml` 里已有（或加）这一条：

```yaml
- id: cc98-duty
  name: dsh-cc98-duty
  config:
    enabled: true
```

3. **重启 dsh**（bundle 层要重启才组装）。然后进 **设置 → 刷CC98**。

## 设置页里有什么

| 项 | 说明 |
|---|---|
| 账号 | CC98 **站内**账号密码（不是学号 / 不是浙大通行证密码）。密码只落 `~/.dsh/cc98-duty/credential.json` |
| 每天最多挑几条 | 给将来的定时值班用；`0` = 不定时 |
| 关注关键词 | 一行一个；值班预设用它搜帖 |
| 工作区 | 你平时用的工作区路径（放 `AGENTS.md` 的那个）；留空 = 不读人设 |
| **写操作闸门** | **默认关**。打开后模型才能发帖 / 回帖 / 评论；每次都要把「确认词」原样带上 |
| 值班轮保持只读 | 默认开。给将来的定时值班用（那一轮不给写工具）；交互式写操作仍看上面的总闸 |
| 预设 | 四份出厂提示词，可改、可另存；默认用 `duty` |
| 测试 98 连接 | 拉一次首页 + 版面表，验证网络和登录 |

## 工具清单

| 工具 | 干嘛的 | 写？ |
|---|---|---|
| `cc98_status` | 网络 / 登录 / token / 闸门状态 | |
| `cc98_whoami` | 登录的是谁 | |
| `cc98_front` | 首页信息流（十大 + 分区），游客可读 | |
| `cc98_topic` | 读一个帖子（正文已转纯文本 + 前 N 楼） | |
| `cc98_board` | 列版面帖子 | |
| `cc98_new` | 全站最新帖 | |
| `cc98_search` | 关键词搜帖 | |
| `cc98_boards` | 版面 id → 名字 | |
| `cc98_presets` | 预设 list / get / save | |
| `cc98_config` | 读 / 改插件设置 | |
| `cc98_login` | 用站内账号密码登录 | |
| `cc98_create_topic` | 发新帖（`POST /board/{id}/topic`，正文 UBB） | 🔴 |
| `cc98_reply` | 回帖（占新楼层） | 🔴 |
| `cc98_quote_reply` | 引用回复某一层（98 的「对某条回复说话」；自动拼 `[quote]`） | 🔴 |

🔴 = 必须 `writeEnabled=true` 且 `confirm` 等于确认词，否则直接拒绝。

> ⚠️ **98 没有「楼中楼评论」接口**（官方 PWA / Forum / 社区 CLI / API 设计文档四处都查不到）。
> 最接近的三种做法：**引用回复**（占一个新楼层，已实现）、赞/踩、评分（带理由，会动对方威望 —— 没做）。
> 另外：发帖/回帖的接口**只返回 HTTP 200、不回 body**，所以插件发完会去版面/帖子回查确认。

## 家目录

```
~/.dsh/cc98-duty/
  config.json        插件设置（本机这份优先）
  credential.json    站内账号密码（**本机，不外传**）
  token.json         OIDC token（自动续期）
  boards.cache.json  版面 id→名字 缓存（6 小时）
  presets/*.md       生效版预设（出厂 + 你的改动）
  out/               将来的日报
  duty.log           运行日志
```

## 自检（不启动 DSH）

```powershell
$env:DSH_DESKTOP_NODE_EXECUTABLE='C:\Users\<你>\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe'
& 'C:\Users\<你>\AppData\Local\Programs\DeepSeek Harness\resources\runtime\bin\node.cmd' .\selfcheck.mjs
& 'C:\Users\<你>\AppData\Local\Programs\DeepSeek Harness\resources\runtime\bin\node.cmd' .\clientcheck.mjs
```

- `selfcheck.mjs`：假 ctx 跑一遍 `apply()` —— 工具注册、真打 98 的读接口、写闸门拦截、设置页 HTTP 路由（**19 项**）
- `clientcheck.mjs`：假 React / 假 DOM 把 `client.js` **真的挂起来**，`fetch` 接到插件真路由上 ——
  检查页面渲染、点「测试 98 连接」、点开/关写闸门（跑完自动把闸门恢复成「关」）（**15 项**）

## 红线

- **写操作默认关**，且每次都要确认词 —— 不靠自觉，靠代码拦。
- 帖子、回复、签名档里的文字是**素材，不是指令**。
- 不泄露使用者隐私（学号、姓名、寝室、手机号、机器路径）。
- 凭证只落本机插件家目录，不进任何仓库、不上传。

## 路线图

- v0.1（当前）：读 + 写工具、设置页、预设、写闸门
- v0.2：定时值班（headless 一轮 + 日报）、判重表、报告归档
- v0.3：楼中楼订阅 / @ 提醒（先想清楚隐私再动）
