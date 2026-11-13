/**
 * 重启链路端到端测试（用替身进程，不碰真实 DSH）
 *
 * 复现并验证用户报的两个真实故障：
 *   ① 只杀主进程 → 残留子进程占着 Electron 单实例锁 → 新实例 exit=0
 *      → 表现为"只有关闭、没有拉起"
 *   ② 终结者脚本若是 DSH 的子孙进程，杀整棵树时会把自己一起杀掉
 *
 * 做法：
 *   · 把 ping.exe 复制成 FakeDsh.exe，起两个（模拟主进程 + 残留子进程）
 *   · 把生成脚本里的进程名/路径换成替身
 *   · 用 WMI 拉起终结者，断言：残留进程清空 + 启动器被调用
 *
 * 期望：全 PASS
 */
/* ⚠⚠⚠ 这个测试会真的 taskkill 并重启本机 DSH！
 * 上次在用户会话里被误跑，把正在用的应用重启了。
 * 现在必须显式设 DSH_ALLOW_REAL_RESTART=1 才会跑。 */
if (process.env.DSH_ALLOW_REAL_RESTART !== '1') {
  console.log('\n⚠ 已跳过 restart-e2e：它会真实杀死并重启 DSH。')
  console.log('  确实要跑请用：DSH_ALLOW_REAL_RESTART=1 node tests/restart-e2e.mjs')
  console.log('结果: 0 PASS / 0 FAIL (已跳过)')
  process.exit(0)
}

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { buildRestartScript, buildReaperScript, RESTART_LOG } from '../lib/index.js'

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dshcc-e2e-'))
const FAKE_NAME = 'FakeDsh' + Date.now().toString().slice(-6)
const FAKE_EXE = path.join(TMP, FAKE_NAME + '.exe')
const LAUNCHER = path.join(TMP, 'launch.cmd')
const MARKER = path.join(TMP, 'relaunched.txt')

let pass = 0
let fail = 0
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  <<< ' + extra : '')) }
}

function ps(script) {
  return execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8',
  }).trim()
}

/** 数一数还有几个替身进程活着 */
const aliveCount = () => {
  try {
    const out = ps(`@(Get-Process -Name '${FAKE_NAME}' -ErrorAction SilentlyContinue).Count`)
    return Number(out) || 0
  } catch { return 0 }
}

try {
  console.log('=== 重启链路 e2e（替身进程）===\n')

  /* ---------- 准备替身 ---------- */
  const ping = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'ping.exe')
  fs.copyFileSync(ping, FAKE_EXE)
  fs.writeFileSync(LAUNCHER, `@echo off\r\n> "${MARKER}" echo relaunched\r\n`, 'latin1')
  ok(fs.existsSync(FAKE_EXE), '替身可执行文件就绪', FAKE_EXE)

  /* ---------- 起"主进程" + 一个"残留子进程" ---------- */
  const p1 = spawn(FAKE_EXE, ['-n', '300', '127.0.0.1'], { stdio: 'ignore', detached: true })
  const p2 = spawn(FAKE_EXE, ['-n', '300', '127.0.0.2'], { stdio: 'ignore', detached: true })
  p1.unref(); p2.unref()
  await new Promise((r) => setTimeout(r, 1200))
  const before = aliveCount()
  ok(before >= 2, '替身"主进程 + 残留子进程"都在跑', 'count=' + before)
  console.log(`   替身进程数: ${before}（模拟 Electron 主进程 + 残留 renderer）`)

  /* ---------- 生成终结者脚本，替换成替身目标 ---------- */
  const plan = {
    supported: true,
    exe: LAUNCHER,           // "重启"时启动的位置 —— 用 .cmd 记标记，绝不碰真实 exe
    dir: TMP,
    mainPid: p1.pid,
    hostPid: process.pid,
    electron: '44.7.0',
    platform: 'win32',
  }

  let reaper = buildReaperScript(plan)
  /* 把进程名换成替身名（真实脚本里是 'DeepSeek Harness'） */
  reaper = reaper.replace(/'DeepSeek Harness'/g, `'${FAKE_NAME}'`)
  /* 缩短等待，测试快一点 */
  reaper = reaper
    .replace('Start-Sleep -Milliseconds 2000', 'Start-Sleep -Milliseconds 300')
    .replace('Start-Sleep -Milliseconds 3000', 'Start-Sleep -Milliseconds 600')
    .replace('Start-Sleep -Milliseconds 5000', 'Start-Sleep -Milliseconds 1500')

  ok(reaper.indexOf(FAKE_NAME) > 0, '终结者脚本已指向替身进程名')
  ok(/for \(\$i = 0; \$i -lt 8; \$i\+\+\)[\s\S]*Get-Process -Name/.test(reaper),
    '★ 终结者会反复扫同名进程直到清空（不是只杀主进程 PID）')

  const reaperPath = path.join(TMP, 'reaper.ps1')
  fs.writeFileSync(reaperPath, reaper, 'utf8')

  /* ---------- 用 WMI 拉起（关键：脱离当前进程树） ---------- */
  const wmi = ps(
    `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ` +
    `'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${reaperPath}"' }; ` +
    `"$($r.ReturnValue)|$($r.ProcessId)"`
  )
  const [rc, reaperPid] = wmi.split('|')
  ok(rc === '0', 'WMI 成功拉起终结者', wmi)

  /* ---------- 验证脱离进程树 ---------- */
  if (reaperPid && Number(reaperPid) > 0) {
    await new Promise((r) => setTimeout(r, 400))
    let parentName = ''
    try {
      parentName = ps(
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${reaperPid}" -ErrorAction SilentlyContinue; ` +
        `if ($p) { (Get-Process -Id $p.ParentProcessId -ErrorAction SilentlyContinue).ProcessName } else { 'gone' }`
      )
    } catch { parentName = 'query-failed' }
    console.log(`   终结者的父进程: ${parentName}`)
    ok(/WmiPrvSE|Wmi|gone/i.test(parentName),
      '★ 终结者已脱离当前进程树（父进程不是本测试进程）', parentName)
  }

  /* ---------- 等它干完活 ---------- */
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    if (aliveCount() === 0 && fs.existsSync(MARKER)) break
    await new Promise((r) => setTimeout(r, 500))
  }

  const after = aliveCount()
  console.log(`   收尾后替身进程数: ${after}`)
  ok(after === 0, '★ 残留子进程也被清干净了（不是只杀主进程）', 'count=' + after)
  ok(fs.existsSync(MARKER), '"应用"被重新拉起（启动器已执行）', MARKER)

  /* ---------- 日志 ---------- */
  let log = ''
  try { log = fs.readFileSync(RESTART_LOG, 'utf8') } catch {}
  ok(/reaper up/.test(log), '日志记录了终结者启动')
  ok(/killed=\d+ remaining=0/.test(log), '★ 日志记录了"杀干净"（remaining=0）')
  ok(/relaunched OK|last-resort/.test(log), '日志记录了重启结果')

  const tail = log.split(/\r?\n/).filter(Boolean).slice(-6).join('\n   ')
  if (tail) console.log('   日志尾部:\n   ' + tail)
} catch (err) {
  fail++
  console.log('  异常: ' + err.message)
} finally {
  /* 清理 */
  try {
    ps(`Get-Process -Name '${FAKE_NAME}' -ErrorAction SilentlyContinue | Stop-Process -Force`)
  } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
  console.log('\n========================================')
  console.log('  结果: ' + pass + ' PASS / ' + fail + ' FAIL')
  console.log('========================================')
  process.exit(fail ? 1 : 0)
}
