/**
 * dsh-conn-check —— 会话头部「模型连通性」小按钮（宿主侧）
 * ---------------------------------------------------------------------------
 * 为什么必须有宿主侧：
 *   浏览器里直接 fetch 第三方站点会被 CORS 拦（只有对方显式放行才通），
 *   所以"点按钮 → 真发一次最小请求"只能由宿主（Node）代发，再回给前端。
 *
 * 三条通路：
 *   ① GET  /dsh-conn/list    → 候选模型清单 + 当前激活了哪几个
 *   ② POST /dsh-conn/select  → 保存"激活哪几个"
 *   ③ POST /dsh-conn/test    → 真发一次 max_tokens=1 的请求，返回 绿/红 与原因
 *   ④ GET  /dsh-conn/ui.js   → 前端脚本（注入到页面执行）
 *
 * 前端注入：桌面端只认 `webserver/index-inject` 的结构化行；web 形态另走 tapIndex，
 *   两条同时注册、各自去重（沿用 dsh-whale-widget 踩过的坑）。
 *
 * 依赖：零外部依赖（自带最小 YAML 解析），避免 link: 安装时解析不到包。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
/** 激活状态落盘位置（与 profile 分开，重装插件不丢选择） */
const STATE_FILE = path.join(DSH_HOME, 'dsh-conn-check.json')

const PROBE_TIMEOUT_MS = 20000
const UI_PATH = '/dsh-conn/ui.js'

/* ========================================================================== *
 * 一、最小 YAML 解析（只吃 cordis.patch.yml / credentials.yaml 这类子集）
 * ========================================================================== */

function miniYaml(text) {
  const rows = []
  const normalize = (indent, content) => {
    if (content === '-') {
      rows.push({ indent, text: '-' })
      return
    }
    if (content.startsWith('- ')) {
      rows.push({ indent, text: '-' })
      normalize(indent + 2, content.slice(2).trim())
      return
    }
    rows.push({ indent, text: content })
  }

  for (const raw of String(text || '').split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#') || raw.trim() === '---') continue
    const indent = raw.match(/^ */)[0].length
    let content = raw.trim()
    const c = content.indexOf(' #')
    if (c > 0) content = content.slice(0, c).trimEnd()
    if (!content) continue
    normalize(indent, content)
  }
  if (!rows.length) return null

  let i = 0
  const isMapLine = (t) => /^[^:]+:(\s|$)/.test(t)
  const scalar = (t) => {
    if (t === 'true') return true
    if (t === 'false') return false
    if (t === 'null' || t === '~') return null
    if (/^-?\d+$/.test(t)) return Number(t)
    if (/^-?\d*\.\d+$/.test(t)) return Number(t)
    return t.replace(/^["']([\s\S]*)["']$/, '$1')
  }
  const parseBlock = (indent) => {
    if (i >= rows.length) return null
    if (rows[i].indent !== indent) return parseBlock(rows[i].indent)
    if (rows[i].text === '-') return parseSeq(indent)
    if (isMapLine(rows[i].text)) return parseMap(indent)
    const value = scalar(rows[i].text)
    i += 1
    return value
  }
  const parseSeq = (indent) => {
    const out = []
    while (i < rows.length && rows[i].indent === indent && rows[i].text === '-') {
      i += 1
      if (i < rows.length && rows[i].indent > indent) out.push(parseBlock(rows[i].indent))
      else out.push(null)
    }
    return out
  }
  const parseMap = (indent) => {
    const out = {}
    while (i < rows.length && rows[i].indent === indent && rows[i].text !== '-') {
      const line = rows[i].text
      if (!isMapLine(line)) { i += 1; continue }
      const sep = line.indexOf(':')
      const key = line.slice(0, sep).trim().replace(/^["'](.*)["']$/, '$1')
      const rest = line.slice(sep + 1).trim()
      i += 1
      if (rest) {
        out[key] = scalar(rest)
      } else if (i < rows.length && rows[i].indent > indent) {
        out[key] = parseBlock(rows[i].indent)
      } else {
        out[key] = null
      }
    }
    return out
  }
  return parseBlock(rows[0].indent)
}

/* ========================================================================== *
 * 二、读配置：profile 在哪、有哪些 provider/模型、key 在哪
 * ========================================================================== */

function readTextSafe(file) {
  try { return fs.readFileSync(file, 'utf8') } catch (err) { return null }
}

/** 依次尝试：环境变量 → desktop → web → 任何含 cordis.patch.yml 的 profile 目录 */
function findProfileDir() {
  const candidates = []
  if (process.env.DSH_PROFILE_DIR) candidates.push(process.env.DSH_PROFILE_DIR)
  const root = path.join(DSH_HOME, 'profiles')
  candidates.push(path.join(root, 'desktop'), path.join(root, 'web'))
  try {
    for (const name of fs.readdirSync(root)) candidates.push(path.join(root, name))
  } catch (err) {}
  for (const dir of candidates) {
    try {
      if (fs.statSync(path.join(dir, 'cordis.patch.yml')).isFile()) return dir
    } catch (err) {}
  }
  return null
}

/** 扫 patch 文本里所有 llm-pi-ai 的 providers 与 agent-default-model */
function parseModelConfig(patch) {
  const entries = Array.isArray(patch) ? patch : (patch ? [patch] : [])
  const providers = []
  let defaults = null

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || entry.disabled === true) continue
    const cfg = entry.config && typeof entry.config === 'object' ? entry.config : {}
    if (entry.id === 'agent-default-model') {
      defaults = { provider: cfg.provider || null, model: cfg.model || null }
    }
    const provs = cfg.providers
    if (!provs || typeof provs !== 'object' || Array.isArray(provs)) continue
    for (const [key, p] of Object.entries(provs)) {
      if (!p || typeof p !== 'object' || p.disabled === true) continue
      const models = Array.isArray(p.models)
        ? p.models.filter((m) => m && m.id).map((m) => ({ id: String(m.id), name: m.name ? String(m.name) : String(m.id) }))
        : []
      providers.push({
        key,
        displayName: p.displayName ? String(p.displayName) : key,
        baseURL: p.baseURL ? String(p.baseURL) : '',
        api: p.api ? String(p.api) : 'openai-completions',
        apiKeyEnv: p.apiKeyEnv ? String(p.apiKeyEnv) : '',
        apiKeyInline: p.apiKey ? String(p.apiKey) : '',
        models,
      })
    }
  }
  return { providers, defaults }
}

function loadCredentialsRefs() {
  for (const file of [path.join(DSH_HOME, '.credentials.yaml'), path.join(DSH_HOME, 'credentials.yaml')]) {
    const text = readTextSafe(file)
    if (!text) continue
    const parsed = miniYaml(text)
    const refs = parsed && typeof parsed === 'object' && parsed.refs && typeof parsed.refs === 'object' && !Array.isArray(parsed.refs)
      ? parsed.refs
      : {}
    if (Object.keys(refs).length) return { file, refs }
  }
  return { file: null, refs: {} }
}

function loadState() {
  const text = readTextSafe(STATE_FILE)
  if (!text) return { selected: null }
  try {
    const parsed = JSON.parse(text)
    if (parsed && Array.isArray(parsed.selected)) return { selected: parsed.selected.map(String) }
  } catch (err) {}
  return { selected: null }
}

function saveState(state) {
  const body = JSON.stringify({ selected: state.selected || [], updatedAt: new Date().toISOString() }, null, 2)
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
    fs.writeFileSync(STATE_FILE, body, 'utf8')
    return true
  } catch (err) {
    return false
  }
}

const idOf = (providerKey, modelId) => providerKey + '::' + modelId

/** 汇总成前端要的清单（含"默认激活"规则：没存过选择时，只激活默认模型） */
function buildCatalog() {
  const profileDir = findProfileDir()
  const patchText = profileDir ? readTextSafe(path.join(profileDir, 'cordis.patch.yml')) : null
  const { providers, defaults } = parseModelConfig(patchText ? miniYaml(patchText) : null)
  const creds = loadCredentialsRefs()

  const models = []
  for (const p of providers) {
    const list = p.models.length ? p.models : []
    for (const m of list) {
      models.push({
        id: idOf(p.key, m.id),
        provider: p.key,
        providerName: p.displayName,
        model: m.id,
        modelName: m.name,
        site: p.baseURL,
        isDefault: !!(defaults && defaults.provider === p.key && defaults.model === m.id),
        hasKey: !!(p.apiKeyInline || (p.apiKeyEnv && creds.refs[p.apiKeyEnv])),
      })
    }
  }

  const state = loadState()
  let selected = state.selected
  if (!selected) {
    const def = models.find((m) => m.isDefault)
    selected = def ? [def.id] : (models.length ? [models[0].id] : [])
  }
  /* 过滤掉配置里已不存在的 id（换站/删模型后不至于显示幽灵按钮） */
  const alive = new Set(models.map((m) => m.id))
  selected = selected.filter((id) => alive.has(id))

  return {
    profileDir,
    credentialsFile: creds.file,
    hasDefaults: !!defaults,
    defaults,
    models,
    selected,
  }
}

/* ========================================================================== *
 * 三、真发一次最小请求
 * ========================================================================== */
async function probeOne(target) {
  const started = Date.now()
  if (!target) return { ok: false, ms: 0, reason: '模型不存在' }
  if (!target.baseURL) return { ok: false, ms: 0, reason: '该站没有配置 baseURL' }
  if (!target.apiKey) return { ok: false, ms: 0, reason: '缺少密钥（' + (target.apiKeyEnv || '未声明 apiKeyEnv') + '）' }

  const base = String(target.baseURL).replace(/\/+$/, '')
  const anthropic = /anthropic/i.test(target.api || '')
  const url = anthropic ? base + '/messages' : base + '/chat/completions'
  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'dsh-conn-check/0.1' }
  let body
  if (anthropic) {
    headers['x-api-key'] = target.apiKey
    headers['anthropic-version'] = '2023-06-01'
    body = { model: target.model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }
  } else {
    headers.Authorization = 'Bearer ' + target.apiKey
    body = { model: target.model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, temperature: 0, stream: false }
  }

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS)
  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ac.signal })
    const text = await res.text()
    const ms = Date.now() - started
    let detail = ''
    try {
      const json = JSON.parse(text)
      const err = json && (json.error && (json.error.message || json.error)) || json.message || null
      detail = err ? String(err) : ''
    } catch (err) {
      detail = text.slice(0, 300)
    }
    if (res.ok) {
      return { ok: true, ms, http: res.status, reason: 'HTTP ' + res.status, detail: detail.slice(0, 300) }
    }
    return { ok: false, ms, http: res.status, reason: 'HTTP ' + res.status + (detail ? '：' + detail.slice(0, 160) : ''), detail: detail.slice(0, 500) }
  } catch (err) {
    const ms = Date.now() - started
    const aborted = err && (err.name === 'AbortError' || /abort/i.test(String(err.message)))
    return { ok: false, ms, reason: aborted ? '超时（>' + PROBE_TIMEOUT_MS / 1000 + 's）' : '网络错误：' + String(err && err.message || err).slice(0, 160) }
  } finally {
    clearTimeout(timer)
  }
}

/** 把 catalog 里的一行补上密钥，交给 probeOne */
function materialize(catalog, id) {
  const hit = catalog.models.find((m) => m.id === id)
  if (!hit) return null
  const profileDir = catalog.profileDir
  const patchText = profileDir ? readTextSafe(path.join(profileDir, 'cordis.patch.yml')) : null
  const { providers } = parseModelConfig(patchText ? miniYaml(patchText) : null)
  const p = providers.find((x) => x.key === hit.provider)
  if (!p) return null
  const refs = loadCredentialsRefs().refs
  const apiKey = p.apiKeyInline || (p.apiKeyEnv ? refs[p.apiKeyEnv] : '') || ''
  return {
    id: hit.id,
    model: hit.model,
    baseURL: p.baseURL,
    api: p.api,
    apiKeyEnv: p.apiKeyEnv,
    apiKey,
  }
}

/* ========================================================================== *
 * 四、自重启（左下角「重启」按钮的后端）
 * --------------------------------------------------------------------------
 * ⚠⚠ 踩过的大坑：桌面端宿主**不是** Electron 主进程。
 *
 *   进程树实测（2026-11-10）：
 *     11816  DeepSeek Harness.exe                        ← Electron 主进程
 *       └ 13264  DeepSeek Harness.exe --expose-internals ← dsh-desktop-host（本插件跑在这）
 *
 *   宿主是主进程 fork 出来的 ELECTRON_RUN_AS_NODE 子进程，里面**没有 electron.app**，
 *   app.relaunch() 根本调不到（实测 /caps 里 process.type === null、require('electron') 拿不到 app）。
 *   第一版按 app.relaunch 写，结果按钮探测到"不支持"直接置灰 → 用户看不到按钮。
 *
 * 正确做法：重启只能从**外部**完成 —— 写一个 PowerShell 脚本并 detach 启动它，
 * 由它在宿主死后继续跑完：
 *   ① 等 1.5s（保证 HTTP 响应已发出、页面遮罩已显示）
 *   ② 优雅关主进程（CloseMainWindow），5s 不退再强杀
 *   ③ 重新拉起 exe
 * 脚本用 `cmd /c start` 启动，脱离本进程树，所以宿主被杀也不影响它。
 * ========================================================================== */
/* 拿 DSH 自己的会话控制器。
 * 用 DSH 内置的 sessionController.selectModel（内置模型选择器走同一接口），
 * 不去自己写盘改状态，免得和 DSH 的会话投影打架。
 * 取不到就返回 undefined —— 只影响"切换模型"这一条路由，不影响其他功能。 */
function sessionControllerOf(root) {
  const pick = (v) => (v && typeof v.selectModel === 'function' ? v : undefined)
  try { if (root && root.reflect && typeof root.reflect.get === 'function') { const v = pick(root.reflect.get('sessionController')); if (v) return v } } catch (err) {}
  try { if (root && typeof root.get === 'function') { const v = pick(root.get('sessionController')); if (v) return v } } catch (err) {}
  try { if (root && root.ctx && typeof root.ctx.get === 'function') { const v = pick(root.ctx.get('sessionController')); if (v) return v } } catch (err) {}
  return undefined
}

function restartPlan() {
  const exe = process.execPath
  const mainPid = process.ppid
  const isDesktopApp = /DeepSeek Harness\.exe$/i.test(exe)
  /* 重启靠 PowerShell + wscript + taskkill，只有 Windows 具备。
   * 别的平台明确 supported=false —— 否则别人点了没反应，还以为是插件坏了。 */
  const isWin = process.platform === 'win32'
  return {
    supported: isWin && isDesktopApp && Number.isInteger(mainPid) && mainPid > 0,
    exe,
    dir: path.dirname(exe),
    mainPid,
    hostPid: process.pid,
    electron: process.versions.electron || null,
    platform: process.platform,
  }
}

const RESTART_LOG = path.join(DSH_HOME, 'dsh-conn-restart.log')

/**
 * 「终结者」脚本（脚本B）：由 WMI 独立拉起，与 DSH 没有任何父子关系。
 * 为什么要分成两个脚本 —— 见 buildRestartScript 的注释。
 */
function buildReaperScript(plan) {
  const q = (s) => String(s).replace(/'/g, "''")
  const NAME = 'DeepSeek Harness'
  return [
    '$ErrorActionPreference = "Continue"',
    'function W($m) { try { Add-Content -LiteralPath \'' + q(RESTART_LOG) + '\' -Value ((Get-Date).ToString("HH:mm:ss") + "  " + $m) -Encoding ASCII } catch {} }',
    /* ⚠⚠⚠ 真因：宿主是以 ELECTRON_RUN_AS_NODE 模式运行的（它是
     *   DeepSeek Harness.exe --expose-internals ... host）。本脚本继承了这个环境变量，
     *   于是它启动的 DeepSeek Harness.exe 也被当成 Node 脚本跑 → 立即退出 exit=0。
     *   实验证据：带 ELECTRON_RUN_AS_NODE=1 启动 → HasExited=True, ExitCode=0。
     *   用户双击图标正常，是因为 explorer 没有这个变量。所以必须先清掉。 */
    'Remove-Item Env:\\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue',
    'Remove-Item Env:\\ELECTRON_NO_ATTACH_CONSOLE -ErrorAction SilentlyContinue',
    '$exePath = \'' + q(plan.exe) + '\'',
    '$exeDir  = \'' + q(plan.dir) + '\'',
    'W ("---- reaper up (main=' + plan.mainPid + ' host=' + plan.hostPid + ')")',
    /* 先等原脚本退出，避免在它还没退出时就把整棵树干掉 */
    /* ⚠ 只等 0.5 秒（发完 HTTP 响应即可）。
     *   实测：等 2 秒反而只能数到 2 个进程（部分正在退出），
     *   立即杀反而能数到全部 6 个——一次杀干净。 */
    'Start-Sleep -Milliseconds 500',
    /* ⚠ 必须用 taskkill /F /T 杀**整棵进程树**，每 100ms 复查一次，
     *   计数归零立刻进入启动阶段（条件驱动，不死等）。 */
    '$killed = 0',
    'for ($i = 0; $i -lt 300; $i++) {',
    '  $n = @(Get-Process -Name \'' + NAME + '\' -ErrorAction SilentlyContinue).Count',
    '  if ($n -eq 0) { break }',
    '  if ($n -gt $killed) { $killed = $n }',
    '  & taskkill /F /T /IM "' + NAME + '.exe" 2>$null | Out-Null',
    '  Start-Sleep -Milliseconds 100',
    '}',
    /* 条件驱动的收尾确认：连续 3 次（300ms）计数为 0 即认为已清空。
     * 实测真因是 ELECTRON_RUN_AS_NODE 环境变量，与锁等待无关，
     * 所以这里只做极短的确认，不再长时间空等。 */
    '$stable = 0',
    'for ($i = 0; $i -lt 120; $i++) {',
    '  Start-Sleep -Milliseconds 100',
    '  $n = @(Get-Process -Name \'' + NAME + '\' -ErrorAction SilentlyContinue).Count',
    '  if ($n -eq 0) { $stable++ } else { $stable = 0; & taskkill /F /T /IM "' + NAME + '.exe" 2>$null | Out-Null }',
    '  if ($stable -ge 3) { break }',
    '}',
    'W ("killed=" + $killed + " stable=" + $stable)',
    'Start-Sleep -Milliseconds 100',
    /* ⚠ 清理 lockfile：实测残留的锁文件会让新实例判定"已有实例"直接退出 */
    'try {',
    '  $lk = Join-Path $env:APPDATA \'@deepseek-ai\\dsh-desktop\\lockfile\'',
    '  if (Test-Path $lk) { Remove-Item $lk -Force -ErrorAction SilentlyContinue; W "lockfile removed" }',
    '} catch { W ("lockfile cleanup EX: " + $_) }',
    'W "relaunching app"',
    /* ⚠⚠ 首选必须是 cmd 的 `start "" "<exe>"` —— 这就是用户桌面 .cmd 里那条命令，
     *     是他亲口验证过 100% 有效的唯一方式。
     *     Start-Process（带重定向/NoNewWindow）实测会让 Electron 卡住 40 秒都数不到进程。 */
    '$inst = 0',
    'function WaitUp($limit) {',
    '  $n = 0',
    '  for ($i = 0; $i -lt $limit; $i++) {',
    '    Start-Sleep -Milliseconds 100',
    '    $n = @(Get-Process -Name \'' + NAME + '\' -ErrorAction SilentlyContinue).Count',
    '    if ($n -gt 0) { break }',
    '  }',
    '  return $n',
    '}',
    'try {',
    '  & cmd.exe /c "start `"`" `"$exePath`""',
    '  W "cmd start issued, waiting up to 60s..."',
    '  $inst = WaitUp 600',
    '  W ("after cmd start wait: instances=" + $inst)',
    '} catch { W ("cmd start EX: " + $_) }',
    /* 兜底：直接 Start-Process（无重定向，避免 Electron 被管道卡住） */
    'if ($inst -eq 0) {',
    '  W "cmd start gave nothing, trying Start-Process"',
    '  try {',
    '    Start-Process -FilePath $exePath -WorkingDirectory $exeDir',
    '    $inst = WaitUp 600',
    '    W ("after Start-Process wait: instances=" + $inst)',
    '  } catch { W ("Start-Process EX: " + $_) }',
    '}',
    'if ($inst -gt 0) { W ("relaunched OK, instances=" + $inst) } else { W "RELAUNCH DIED, no instance alive" }',
    '',
  ].join('\r\n')
}

/**
 * 脚本A：由宿主 detach 启动（它是 DSH 的子孙进程）。
 * 它自己**不杀进程**，只做两件事：
 *   1. 把脚本B（终结者）写到临时目录
 *   2. 用 WMI `Win32_Process.Create` 把脚本B 拉起来 —— 父进程变成 WmiPrvSE，
 *      脱离 DSH 的 job object，不会被"杀整棵树"连坐
 * 然后它立刻退出。
 */
function buildRestartScript(plan) {
  const q = (s) => String(s).replace(/'/g, "''")
  const reaper = buildReaperScript(plan)
  const b64 = Buffer.from(reaper, 'utf8').toString('base64')
  const reaperPath = path.join(os.tmpdir(), 'dsh-conn-restart-reaper.ps1')
  return [
    '$ErrorActionPreference = "Continue"',
    'function W($m) { try { Add-Content -LiteralPath \'' + q(RESTART_LOG) + '\' -Value ((Get-Date).ToString("HH:mm:ss") + "  " + $m) -Encoding ASCII } catch {} }',
    'W "---- restart requested (main=' + plan.mainPid + ' host=' + plan.hostPid + ')"',
    '$reaper = \'' + q(reaperPath) + '\'',
    'try {',
    '  [IO.File]::WriteAllBytes($reaper, [Convert]::FromBase64String(\'' + b64 + '\'))',
    '} catch { W ("write reaper failed: " + $_) }',
    'try {',
    '  $cmd = \'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "\' + $reaper + \'"\'',
    '  $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd }',
    '  if ($r -and $r.ReturnValue -eq 0) { W ("reaper spawned, pid=" + $r.ProcessId) }',
    '  else { W ("reaper spawn failed, rc=" + $(if ($r) { $r.ReturnValue } else { "null" })) }',
    '} catch { W ("reaper spawn EX: " + $_) }',
    '',
  ].join('\r\n')
}

/**
 * 写重启脚本并 detached 启动；返回脚本路径。
 *
 * ⚠ 这里只写**一个**脚本，不再做"脚本A → WMI 创建脚本B"的两层嵌套。
 *   实测：两层嵌套时时正时不正——日志写完 "reaper spawned, pid=N"
 *   之后就再也没有任何输出，脚本B 一行都没执行就没了。
 *   直接 spawn + detached 是 Node 官方做法，子进程独立于宿主，宿主被杀不影响它。
 */
function launchRestartScript(plan) {
  const scriptPath = path.join(os.tmpdir(), 'dsh-conn-restart-reaper.ps1')
  fs.writeFileSync(scriptPath, buildReaperScript(plan), 'utf8')
  /* ⚠⚠ 启动器必须“完全无窗口”（用户报过：点重启会弹一个命令行黑框）：
   *   - cmd /c start ""       → 会新建控制台窗口，就是那个黑框
   *   - cmd /c start "" /b    → 不建窗口，但子进程挂在宿主控制台上，宿主被杀时会被一起带走
   *   - wscript + VBS      → WScript.Shell.Run(..., 0, False) 的 0 = 窗口隐藏，
   *                          wscript.exe 自身也没窗口，且进程完全独立。这是 Windows 上的标准做法。 */
  const vbsPath = path.join(os.tmpdir(), 'dsh-conn-restart-launch.vbs')
  const vbs = [
    'Set sh = CreateObject("WScript.Shell")',
    'sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""' + scriptPath + '""", 0, False',
    '',
  ].join('\r\n')
  fs.writeFileSync(vbsPath, vbs, 'utf8')

  const child = spawn('wscript.exe', [vbsPath], { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
  return scriptPath
}

/* ========================================================================== *
 * 五、工具：读请求体 / 发 JSON / 只允许本机访问
 * ========================================================================== */

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > 1024 * 64) { resolve(''); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(''))
  })
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** 只放行本机页面：Host 必须回环，且不接受跨站/异源请求（防止别的网页偷测你的 key） */
function rejectionOf(req) {
  try {
    const headers = (req && req.headers) || {}
    let host = null
    try { host = new URL('http://' + String(headers.host || '')) } catch (err) { return 403 }
    const hn = host.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    const loopback = hn === 'localhost' || hn.endsWith('.localhost') || hn === '::1' ||
      /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(hn)
    if (!loopback) return 403
    if (String(headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return 403
    const origin = headers.origin
    if (typeof origin === 'string' && origin && origin !== 'null') {
      let o = null
      try { o = new URL(origin) } catch (err) { return 403 }
      if (o.host.toLowerCase() !== host.host.toLowerCase()) return 403
    }
    return null
  } catch (err) {
    return 403
  }
}

/* ========================================================================== *
 * 五、插件本体
 * ========================================================================== */

/* 桌面端注入行：kind:'script' 的 text 是 JS 源码（渲染层 createElement+textContent）。
 * 动态建 <script src> 并**吞掉 onerror**：路由晚就绪/重载时不该让整页 boot 失败。 */
const INLINE_LOADER = [
  'try{',
  'var s=document.createElement("script");',
  's.src="' + UI_PATH + '?t="+Date.now();',
  's.async=true;',
  's.onerror=function(){};',
  '(document.body||document.documentElement).appendChild(s);',
  '}catch(e){}',
].join('')

function loadUiScript() {
  return readTextSafe(path.join(PACKAGE_ROOT, 'assets', 'conn-check.js')) || ''
}

export default {
  name: 'dsh-conn-check',
  /* 不写对象级 inject：apply() 必须立刻跑，先把注入行推进表（桌面端注入表是一次性收集的） */
  apply(root) {
    const disposers = []
    root.effect(() => () => {
      for (const d of disposers) { try { d() } catch (err) {} }
    })

    /* ① 桌面端注入通道：注册得越早越好 */
    disposers.push(root.on('webserver/index-inject', (table) => {
      try {
        if (!Array.isArray(table)) return
        for (const row of table) {
          if (!row) continue
          if (row.kind === 'script-src' && row.src && String(row.src).indexOf('/dsh-conn/ui.js') >= 0) return
          if (row.kind === 'script' && typeof row.text === 'string' && row.text.indexOf('/dsh-conn/ui.js') >= 0) return
        }
        table.push({ kind: 'script', placement: 'body', text: INLINE_LOADER })
      } catch (err) {}
    }))

    /* ② 其余逻辑：等服务就绪再挂路由 */
    root.inject(['webServer'], (ctx) => {
      const webServer = ctx.webServer
      const register = (route) => webServer.register({
        ...route,
        handler: async (req, res) => {
          const code = rejectionOf(req)
          if (code) { sendJson(res, code, { error: 'forbidden' }); return }
          return route.handler(req, res)
        },
      })

      /* —— 清单 —— */
      disposers.push(register({
        kind: 'exact',
        path: '/dsh-conn/list',
        handler: (req, res) => {
          const catalog = buildCatalog()
          sendJson(res, 200, catalog)
        },
      }))

      /* —— 保存激活选择 —— */
      disposers.push(register({
        kind: 'exact',
        path: '/dsh-conn/select',
        handler: async (req, res) => {
          const raw = await readBody(req)
          let body = null
          try { body = JSON.parse(raw) } catch (err) {}
          if (!body || !Array.isArray(body.selected)) { sendJson(res, 400, { error: 'body 需要 {selected:[id]}' }); return }
          const catalog = buildCatalog()
          const alive = new Set(catalog.models.map((m) => m.id))
          const selected = body.selected.map(String).filter((id) => alive.has(id))
          const ok = saveState({ selected })
          sendJson(res, ok ? 200 : 500, { ok, selected, file: STATE_FILE })
        },
      }))

      /* —— 把会话切到某个模型 —— */
      disposers.push(register({
        kind: 'exact',
        path: '/dsh-conn/use',
        handler: async (req, res) => {
          const raw = await readBody(req)
          let body = null
          try { body = JSON.parse(raw) } catch (err) {}
          if (!body || !body.sessionId || !body.id) { sendJson(res, 400, { error: 'body 需要 {sessionId, id}' }); return }
          const catalog = buildCatalog()
          const target = materialize(catalog, String(body.id))
          if (!target) { sendJson(res, 404, { error: '未知模型：' + String(body.id) }); return }
          const provider = String(body.id).split('::')[0]
          const sc = sessionControllerOf(root)
          if (!sc) { sendJson(res, 503, { error: '当前 DSH 版本没有 sessionController，无法切换模型' }); return }
          try {
            const selection = await sc.selectModel({
              sessionId: String(body.sessionId),
              provider,
              model: target.model,
            })
            sendJson(res, 200, { ok: true, sessionId: String(body.sessionId), provider, model: target.model, selection: selection || null })
          } catch (err) {
            sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
          }
        },
      }))

      /* —— 测一个 —— */
      disposers.push(register({
        kind: 'exact',
        path: '/dsh-conn/test',
        handler: async (req, res) => {
          const raw = await readBody(req)
          let body = null
          try { body = JSON.parse(raw) } catch (err) {}
          if (!body || !body.id) { sendJson(res, 400, { error: 'body 需要 {id}' }); return }
          const catalog = buildCatalog()
          const target = materialize(catalog, String(body.id))
          if (!target) { sendJson(res, 404, { error: '未知模型：' + String(body.id) }); return }
          const result = await probeOne(target)
          sendJson(res, 200, { id: target.id, model: target.model, ...result, at: Date.now() })
        },
      }))

      /* —— 前端脚本 —— */
      disposers.push(register({
        kind: 'exact',
        path: UI_PATH,
        handler: (req, res) => {
          const js = loadUiScript()
          res.writeHead(200, {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'no-store',
            'Content-Length': Buffer.byteLength(js),
          })
          res.end(js)
        },
      }))

      /* —— 诊断：前端把页面真实结构报回来 ——
       * 宿主拿不到页面 DOM，靠猜选择器就是"按钮不出现"的根源。
       * 前端每次装载会把候选容器结构 POST 过来，落到 ~/.dsh/dsh-conn-ui.log。 */
      disposers.push(register({
        kind: 'exact',
        path: '/dsh-conn/diag',
        handler: async (req, res) => {
          const raw = await readBody(req)
          try {
            let pretty = raw
            try { pretty = JSON.stringify(JSON.parse(raw), null, 2) } catch (err) {}
            fs.appendFileSync(
              path.join(DSH_HOME, 'dsh-conn-ui.log'),
              '===== ' + new Date().toISOString() + ' =====\n' + pretty + '\n\n',
              'utf8',
            )
          } catch (err) {}
          sendJson(res, 200, { ok: true })
        },
      }))

      /* —— 能力探测：前端据此决定「重启」按钮是亮还是灰 —— */
      disposers.push(register({
        kind: 'exact',
        path: '/dsh-conn/caps',
        handler: (req, res) => {
          const plan = restartPlan()
          sendJson(res, 200, {
            restart: plan.supported,
            exe: plan.exe,
            mainPid: plan.mainPid,
            hostPid: plan.hostPid,
            electron: plan.electron,
            processType: process.type || null,
            platform: process.platform,
          })
        },
      }))

      /* —— 自重启 ——
       * 先把 200 发出去，再启动外部脚本：否则前端拿不到响应，只能看到连接被重置。 */
      disposers.push(register({
        kind: 'exact',
        path: '/dsh-conn/restart',
        handler: (req, res) => {
          const plan = restartPlan()
          if (!plan.supported) {
            sendJson(res, 503, {
              ok: false,
              reason: '当前不是 DeepSeek 桌面端进程（execPath=' + plan.exe + '），无法自重启',
            })
            return
          }
          let scriptPath = null
          try {
            scriptPath = launchRestartScript(plan)
          } catch (err) {
            sendJson(res, 500, { ok: false, reason: '启动重启脚本失败：' + String(err && err.message || err) })
            return
          }
          sendJson(res, 200, { ok: true, relaunching: true, mainPid: plan.mainPid, script: scriptPath })
          console.log('[dsh-conn-check] 重启已排队（main=' + plan.mainPid + '）→ ' + scriptPath)
        },
      }))

      /* ③ web 形态的注入通道（桌面端不走这里，但两条并存不影响） */
      if (typeof webServer.tapIndex === 'function') {
        disposers.push(webServer.tapIndex((html) => {
          if (typeof html !== 'string' || html.indexOf('/dsh-conn/ui.js') !== -1) return html
          const tag = '<script defer src="' + UI_PATH + '"></script>'
          return html.indexOf('</body>') !== -1 ? html.replace('</body>', tag + '</body>') : html + tag
        }))
      }

      /* 自检日志：出问题时能一眼看出插件活着、读到哪个 profile */
      try {
        const catalog = buildCatalog()
        const def = catalog.models.find((m) => m.isDefault)
        console.log('[dsh-conn-check] ready · profile=' + catalog.profileDir +
          ' · models=' + catalog.models.length +
          ' · 默认=' + (def ? def.providerName + '/' + def.model : '未声明') +
          ' · 激活=' + catalog.selected.length)
      } catch (err) {}
    })
  },
}

/* 供自检脚本直接调用（不影响 cordis 加载：默认导出仍是上面的插件对象） */
export { miniYaml, findProfileDir, parseModelConfig, buildCatalog, materialize, probeOne, sessionControllerOf, STATE_FILE, restartPlan, buildRestartScript, buildReaperScript, RESTART_LOG }
