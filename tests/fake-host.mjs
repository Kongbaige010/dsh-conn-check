/**
 * 宿主侧加载验证：不用重启 DSH，直接模拟 cordis 环境跑一遍插件
 *   node tests/fake-host.mjs           # 配置 + 注入行 + 路由（不联网）
 *   node tests/fake-host.mjs --net     # 额外真发一次 /dsh-conn/test
 */
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import plugin, { restartPlan, buildRestartScript, buildReaperScript, RESTART_LOG } from '../lib/index.js'
import { STATE_FILE, sessionControllerOf } from '../lib/index.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
let pass = 0
let fail = 0
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  <<< ' + extra : '')) }
}
const section = (t) => console.log('\n=== ' + t + ' ===')

/* ---------- fake cordis ---------- */
const injectRows = []
const routes = []
let tapIndexFn = null
let injectedDeps = null
let injectCb = null
const headDisposers = []

const scCalls = []
const fakeSessionController = {
  async selectModel(req) {
    scCalls.push(req)
    if (req.sessionId === 'boom') throw new Error('会话不存在')
    return { provider: req.provider, model: req.model }
  },
}

const root = {
  effect(fn) { const d = fn(); headDisposers.push(d) },
  on(evt, cb) {
    if (evt === 'webserver/index-inject') injectRows.push(cb)
    return () => {}
  },
  inject(deps, cb) { injectedDeps = deps; injectCb = cb },
  /* Cordis 的可选服务查找；模拟 DSH 宿主里已注册的 sessionController */
  get(name) { return name === 'sessionController' ? fakeSessionController : undefined },
}
const webServer = {
  register(route) { routes.push(route); return () => {} },
  tapIndex(fn) { tapIndexFn = fn; return () => {} },
}

section('1. 插件对象结构')
ok(plugin && plugin.name === 'dsh-conn-check', 'name = dsh-conn-check')
ok(typeof plugin.apply === 'function', 'apply() 是可调用的函数')
ok(!plugin.inject, '没有对象级 inject（保证注入行第一时间注册）')

section('2. apply() 不依赖服务就注册注入行')
plugin.apply(root)
ok(injectRows.length === 1, '订阅了 webserver/index-inject', 'got ' + injectRows.length)

const table = []
injectRows[0](table)
const row = table[0]
ok(table.length === 1, '注入表里推了 1 行', 'got ' + table.length)
ok(row && row.kind === 'script', "行类型是 kind:'script'（桌面端唯一生效通道）", row && row.kind)
ok(row && row.placement === 'body', 'placement = body')
ok(row && typeof row.text === 'string' && row.text.indexOf('/dsh-conn/ui.js') >= 0, '脚本里指向 /dsh-conn/ui.js')
ok(row && row.text.indexOf('onerror') >= 0, '加载失败被吞掉（不拖垮整页 boot）')

const table2 = [row]
injectRows[0](table2)
ok(table2.length === 1, '重复触发不重复推入（幂等）', 'got ' + table2.length)

section('3. 路由注册')
ok(injectedDeps && injectedDeps.indexOf('webServer') >= 0, "inject 依赖含 webServer", JSON.stringify(injectedDeps))
injectCb({ webServer })
const paths = routes.map((r) => r.path).sort()
ok(routes.length === 8, '注册了 8 条路由（含新增 /dsh-conn/use）', 'got ' + routes.length + ' → ' + paths.join(','))
ok(paths.indexOf('/dsh-conn/list') >= 0, '/dsh-conn/list')
ok(paths.indexOf('/dsh-conn/select') >= 0, '/dsh-conn/select')
ok(paths.indexOf('/dsh-conn/test') >= 0, '/dsh-conn/test')
ok(paths.indexOf('/dsh-conn/ui.js') >= 0, '/dsh-conn/ui.js')
ok(paths.indexOf('/dsh-conn/caps') >= 0, '/dsh-conn/caps')
ok(paths.indexOf('/dsh-conn/restart') >= 0, '/dsh-conn/restart')
ok(paths.indexOf('/dsh-conn/diag') >= 0, '/dsh-conn/diag（前端回报页面结构）')
ok(typeof tapIndexFn === 'function', 'web 形态的 tapIndex 也挂上了')
/* tapIndex 注入不应重复 */
const html1 = tapIndexFn('<html><body>x</body></html>')
const html2 = tapIndexFn(html1)
ok(html1.indexOf('/dsh-conn/ui.js') > 0, 'tapIndex 注入 script 标签')
ok(html1 === html2, 'tapIndex 幂等')

/* ---------- 假 req/res ---------- */
function fakeReq(headers, bodyText) {
  const req = new EventEmitter()
  req.headers = Object.assign({ host: '127.0.0.1:57841' }, headers || {})
  req.destroy = () => {}
  if (bodyText !== undefined) {
    setTimeout(() => {
      req.emit('data', Buffer.from(bodyText, 'utf8'))
      req.emit('end')
    }, 0)
  } else {
    setTimeout(() => req.emit('end'), 0)
  }
  return req
}
function fakeRes() {
  const res = {
    statusCode: 0, headers: null, body: '',
    writeHead(code, headers) { res.statusCode = code; res.headers = headers; return res },
    end(b) { res.body = b ? String(b) : ''; res.done && res.done() },
  }
  res.finished = new Promise((r) => { res.done = r })
  return res
}
async function call(pathname, { headers, body } = {}) {
  const route = routes.find((r) => r.path === pathname)
  const res = fakeRes()
  await route.handler(fakeReq(headers, body), res)
  await res.finished
  let json = null
  try { json = JSON.parse(res.body) } catch (err) {}
  return { code: res.statusCode, headers: res.headers, body: res.body, json }
}

section('4. 安全栅栏')
const badHost = await call('/dsh-conn/list', { headers: { host: 'evil.example.com:80' } })
ok(badHost.code === 403, '非回环 Host → 403', String(badHost.code))
const crossSite = await call('/dsh-conn/list', { headers: { 'sec-fetch-site': 'cross-site' } })
ok(crossSite.code === 403, 'cross-site 请求 → 403', String(crossSite.code))
const badOrigin = await call('/dsh-conn/list', { headers: { origin: 'http://evil.com' } })
ok(badOrigin.code === 403, '异源 Origin → 403', String(badOrigin.code))
const goodOrigin = await call('/dsh-conn/list', { headers: { origin: 'http://127.0.0.1:57841' } })
ok(goodOrigin.code === 200, '同源 Origin → 200', String(goodOrigin.code))

section('5. /dsh-conn/list')
const list = await call('/dsh-conn/list')
ok(list.code === 200, 'HTTP 200')
ok(list.json && Array.isArray(list.json.models) && list.json.models.length > 0, 'models 非空', 'count=' + (list.json && list.json.models.length))
ok(list.json && Array.isArray(list.json.selected), 'selected 是数组')
ok(list.json && !!list.json.profileDir, 'profileDir 已识别')
console.log('   模型: ' + (list.json.models || []).map((m) => m.providerName + (m.isDefault ? '★' : '')).join(', '))
console.log('   激活: ' + JSON.stringify(list.json.selected))

section('6. /dsh-conn/select')
const before = (list.json.models || []).map((m) => m.id)
const pickTwo = before.slice(0, 2)
const sel = await call('/dsh-conn/select', { body: JSON.stringify({ selected: pickTwo }) })
ok(sel.code === 200 && sel.json.ok === true, '保存成功', JSON.stringify(sel.json))
ok(fs.existsSync(STATE_FILE), '状态文件已落盘', STATE_FILE)
const list2 = await call('/dsh-conn/list')
ok(JSON.stringify(list2.json.selected) === JSON.stringify(pickTwo), '重新读取后选择一致', JSON.stringify(list2.json.selected))
const badSel = await call('/dsh-conn/select', { body: JSON.stringify({ selected: ['幽灵id::x'] }) })
ok(badSel.code === 200 && badSel.json.selected.length === 0, '不存在的 id 被过滤掉', JSON.stringify(badSel.json.selected))
/* 复原成默认模型，避免留下奇怪的激活状态 */
const def = (list.json.models || []).filter((m) => m.isDefault)[0]
await call('/dsh-conn/select', { body: JSON.stringify({ selected: def ? [def.id] : [before[0]] }) })
ok(true, '已复原为默认选择')

section('7. /dsh-conn/ui.js')
const ui = await call('/dsh-conn/ui.js')
ok(ui.code === 200, 'HTTP 200')
ok(/javascript/.test((ui.headers || {})['Content-Type'] || ''), 'Content-Type = javascript', (ui.headers || {})['Content-Type'])
const localUi = fs.readFileSync(path.join(HERE, '..', 'assets', 'conn-check.js'), 'utf8')
ok(ui.body === localUi, '返回内容与 assets/conn-check.js 一致')
ok(ui.body.indexOf('dsh-conn-bar') > 0, '脚本内容正确（含 BAR_ID）')

section('8. /dsh-conn/test 参数校验')
const noId = await call('/dsh-conn/test', { body: JSON.stringify({}) })
ok(noId.code === 400, '缺 id → 400', String(noId.code))
const ghost = await call('/dsh-conn/test', { body: JSON.stringify({ id: 'nope::nope' }) })
ok(ghost.code === 404, '未知模型 → 404', String(ghost.code))

if (process.argv.includes('--net')) {
  section('9. /dsh-conn/test 真发一次')
  const target = (list.json.models || []).filter((m) => m.isDefault)[0] || (list.json.models || [])[0]
  console.log('   目标: ' + target.id)
  const t0 = Date.now()
  const r = await call('/dsh-conn/test', { body: JSON.stringify({ id: target.id }) })
  console.log('   结果: ' + JSON.stringify(r.json))
  ok(r.code === 200, 'HTTP 200')
  ok(r.json && typeof r.json.ok === 'boolean', '返回 ok 布尔值')
  ok(r.json && typeof r.json.ms === 'number', '返回耗时')
  ok(Date.now() - t0 < 25000, '在超时上限内返回')
}

console.log('\n=== 10. 自重启（caps / restart）===')
{
  const caps = await call('/dsh-conn/caps')
  ok(caps.code === 200, 'caps HTTP 200')
  ok(caps.json && typeof caps.json.restart === 'boolean', 'caps.restart 是布尔值', JSON.stringify(caps.json))
  ok(caps.json && 'electron' in caps.json, 'caps 带 electron 版本字段')
  /* 本测试跑在纯 node 里 → 应当老实报"不支持"，而不是假装支持 */
  ok(caps.json.restart === false, '非 Electron 进程下 restart=false（不谎报能力）', JSON.stringify(caps.json))
  const r = await call('/dsh-conn/restart', { body: '{}' })
  ok(r.code === 503, '拿不到 app 时 /restart 返回 503 而不是退出进程', String(r.code))
  ok(r.json && r.json.ok === false && typeof r.json.reason === 'string', '给出了拒绝原因', JSON.stringify(r.json))
  ok(process.pid > 0, '进程仍然活着（没有盲退）')
}

console.log('\n=== 11. 重启脚本生成（模拟桌面端环境）===')
{
  /* 真实环境里宿主是 DeepSeek Harness.exe 的 --expose-internals 子进程，
   * process.execPath 指向 exe、process.ppid 是 Electron 主进程。
   * 这里用一份伪造的 plan 直接验证脚本内容。 */
  const fakePlan = {
    supported: true,
    exe: 'C:\\Users\\Some User\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe',
    mainPid: 11816,
    hostPid: 13264,
    electron: '44.7.0',
    platform: 'win32',
  }
  const ps = buildRestartScript(fakePlan)
  ok(typeof ps === 'string' && ps.length > 200, '生成了非空 PowerShell 脚本', 'len=' + ps.length)
  /* 脚本A（宿主直接拉起的那个）只负责写子脚本 + 用 WMI 拉起它，不自己杀进程：
   * 它是 DSH 的孙进程，自己去杀整棵树会被连坐。 */
  ok(ps.indexOf('Win32_Process') >= 0 && ps.indexOf('Create') >= 0, '★ 用 WMI Win32_Process.Create 拉起终结者（脱离进程树）')
  ok(ps.indexOf('FromBase64String') >= 0, '子脚本以 base64 传递（避开转义地狱）')
  ok(ps.indexOf('Stop-Process') < 0, '★ 脚本A 自己不杀进程（避免自我连坐）')
  ok(ps.indexOf(RESTART_LOG) >= 0, '日志落到 ' + RESTART_LOG)
  ok(ps.indexOf('dsh-conn-restart-reaper.ps1') >= 0, '脚本A 把终结者写到临时目录')

  /* 脚本B（终结者）才是真正干活的： */
  const rp = buildReaperScript(fakePlan)
  ok(/Get-Process -Name 'DeepSeek Harness'/.test(rp), '★ 终结者按进程名扫全部实例（而不是只杀主进程 PID）')
  ok(rp.indexOf('taskkill /F /T') >= 0, '★ 用 taskkill /F /T 杀整棵进程树（Stop-Process 会对部分子进程失败）')
  ok(/stable/.test(rp), '★ 等到进程数连续为 0 才算稳定（进程消失 ≠ 锁释放）')
  ok(/stable -ge 3/.test(rp), '连续 3 次确认为 0 就放行（真因是环境变量，不是等锁）')
  ok(/Start-Sleep -Milliseconds 100/.test(rp), '每轮只等 100ms（条件驱动）')
  ok(!/Start-Sleep -Seconds/.test(rp), '启动前不再等整秒（真因不是等锁）')
  ok(rp.indexOf('Main=' + fakePlan.mainPid) >= 0 || rp.indexOf('main=' + fakePlan.mainPid) >= 0, '日志记下最初的主进程 ' + fakePlan.mainPid)
  ok(rp.indexOf('-WorkingDirectory') >= 0, '★ 启动时指定工作目录（否则 Electron 启动即退）')
  ok(rp.indexOf('WaitUp') >= 0, '★ 启动后轮询数进程（不是等固定秒数——曾因此误判失败）')
  ok(/WaitUp 60/.test(rp), '★ 启动后最多等 60 秒（246MB 应用冷启动很慢）')
  ok(/cmd\.exe \/c "start/.test(rp), '★ 首选 cmd start ""（用户桌面 .cmd 验证过的唯一方式）')
  ok(rp.indexOf('explorer.exe') < 0, '★ 不再用 explorer.exe 启动（实测它根本不启动程序，只去开文件夹）')
  ok(/Start-Process -FilePath \$exePath -WorkingDirectory \$exeDir/.test(rp), '★ 用 Start-Process + 工作目录启动（实测有效）')
  ok(/lockfile/.test(rp), '★ 清理 lockfile（残留锁会让新实例直接退出）')
  ok(/cmd.exe \/c "start/.test(rp), 'cmd start 作为最后兜底')
  ok(rp.indexOf('RELAUNCH DIED') >= 0, '真死了会记 RELAUNCH DIED，不再假成功')
  ok(rp.indexOf('DeepSeek Harness.exe') >= 0, '启动路径指向桌面端 exe')

  /* 路径含单引号时必须转义成双写，否则 PowerShell 语法炸弹 */
  const trickyPlan = Object.assign({}, fakePlan, { exe: "C:\\a'b\\App.exe", dir: "C:\\a'b" })
  ok(buildReaperScript(trickyPlan).indexOf("C:\\a''b\\App.exe") >= 0, "终结者里路径单引号被转义（a'b → a''b）")
  /* 脚本A 里可见的路径只有 reaper 脚本路径（exe 路径已进 base64） */
  const trickyA = buildRestartScript(trickyPlan)
  ok(/\[IO\.File\]::WriteAllBytes/.test(trickyA), '脚本A 用 WriteAllBytes 写二进制（不怕中文/符号）')

  /* 非桌面端必须判为不支持 */
  const nodePlan = restartPlan()
  ok(nodePlan.supported === false, '在纯 node 下 restartPlan.supported=false', String(nodePlan.supported))
}

/* ---- 启动器：必须完全无窗口（用户报过点重启弹命令行黑框）---- */
section('11. /dsh-conn/use —— 给会话切换模型')
const modelIds = (list.json.models || []).map((m) => m.id)
const target = modelIds.find((x) => x.indexOf('::') > 0) || modelIds[0]
const useOk = await call('/dsh-conn/use', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'sess-1', id: target }) })
ok(useOk.code === 200, '正常请求 → 200', String(useOk.code) + ' ' + useOk.body)
ok(useOk.json && useOk.json.ok === true, '返回 ok:true', useOk.body)
const sent = scCalls[scCalls.length - 1]
ok(!!sent, '真的调用了 sessionController.selectModel', JSON.stringify(sent))
ok(sent && sent.sessionId === 'sess-1', '★ 把会话 id 原样传给 DSH', sent && sent.sessionId)
ok(sent && target.indexOf(sent.provider + '::') === 0, '★ provider 从 provider::model 正确拆出', sent && sent.provider)
ok(sent && typeof sent.model === 'string' && sent.model.length > 0, '★ model 传的是纯模型名', sent && sent.model)

const useNoSid = await call('/dsh-conn/use', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: target }) })
ok(useNoSid.code === 400, '缺 sessionId → 400（绝不猜会话）', String(useNoSid.code))

const useBadModel = await call('/dsh-conn/use', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'sess-1', id: 'nope::nope' }) })
ok(useBadModel.code === 404, '未知模型 → 404', String(useBadModel.code))

const useBoom = await call('/dsh-conn/use', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'boom', id: target }) })
ok(useBoom.code === 500, 'DSH 抛错 → 500', String(useBoom.code))
ok(useBoom.json && String(useBoom.json.error).indexOf('会话不存在') >= 0, '★ 把 DSH 的错误原文回给前端', useBoom.body)

const useCross = await call('/dsh-conn/use', { headers: { 'sec-fetch-site': 'cross-site' }, body: JSON.stringify({ sessionId: 's', id: target }) })
ok(useCross.code === 403, '★ 跨站请求同样被挡（防别站切模型）', String(useCross.code))

section('12. sessionControllerOf 的容错')
ok(sessionControllerOf({}) === undefined, '空 root → undefined（不抛）')
ok(sessionControllerOf({ get: () => ({}) }) === undefined, '服务没有 selectModel → undefined')
ok(sessionControllerOf({ get: (n) => (n === 'sessionController' ? { selectModel() {} } : undefined) }) !== undefined, '有 selectModel → 取到')
ok(sessionControllerOf({ get: () => { throw new Error('x') } }) === undefined, '查找抛错 → 吞掉并返回 undefined')
ok(sessionControllerOf({ reflect: { get: () => fakeSessionController } }) === fakeSessionController, 'reflect.get 通道也能取到')

const SRC = fs.readFileSync(path.join(HERE, '..', 'lib', 'index.js'), 'utf8')
ok(!/spawn\('cmd\.exe'/.test(SRC), '★ 启动器不走 cmd.exe（cmd start 会新建控制台黑框）')
ok(/spawn\('wscript\.exe'/.test(SRC), '★ 启动器走 wscript.exe（窗口隐藏，进程独立）')
ok(/WScript\.Shell/.test(SRC), '★ 用 WScript.Shell.Run 静默拉起 PowerShell')
ok(/,\s*0,\s*False/.test(SRC), '★ Run 的第 2 参为 0（SW_HIDE，不显窗口）')

console.log('\n========================================')
console.log('  结果: ' + pass + ' PASS / ' + fail + ' FAIL')
console.log('========================================')
process.exit(fail ? 1 : 0)
