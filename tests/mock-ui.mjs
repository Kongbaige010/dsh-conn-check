/**
 * 前端 UI 自检：假 DSH 页面 + 假接口 + 真 Chrome
 *   node tests/mock-ui.mjs [截图路径]
 * 验证：注入位置、按钮数量、点击变绿/红、⚙ 浮层勾选生效
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const UI_JS = fs.readFileSync(path.join(HERE, '..', 'assets', 'conn-check.js'), 'utf8')
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 8799
const CDP = 9262

/* ---------------- 假数据 ---------------- */
const MODELS = [
  { id: 'beta::m', provider: 'beta', providerName: 'Beta-0.18', model: 'demo-flash', site: 'https://api.beta.example/v1', isDefault: false, hasKey: true },
  { id: 'alpha::m', provider: 'alpha', providerName: 'Alpha-Free', model: 'demo-flash', site: 'https://api.alpha.example/v1', isDefault: true, hasKey: true },
  { id: 'a002::m', provider: 'a002', providerName: 'Alpha-A002', model: 'demo-flash', site: 'https://api.alpha.example/v1', isDefault: false, hasKey: true },
  { id: 'deep::m', provider: 'deep', providerName: 'Alpha-Deep', model: 'demo-flash', site: 'https://api.alpha.example/v1', isDefault: false, hasKey: false },
  { id: 'k01::m', provider: 'k01', providerName: 'Gamma-0.1', model: 'demo/chat-flash', site: 'https://api.gamma.example/v1', isDefault: false, hasKey: true },
  { id: 'k015::m', provider: 'k015', providerName: 'Gamma-0.15', model: 'demo-flash', site: 'https://api.gamma.example/v1', isDefault: false, hasKey: true },
  { id: 'k06::m', provider: 'k06', providerName: 'Gamma-0.6', model: 'demo-flash', site: 'https://api.gamma.example/v1', isDefault: false, hasKey: true },
]
let selected = ['alpha::m', 'beta::m', 'k01::m']
const posted = []

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
/* 复刻 DSH 浅色主题的变量表（配色必须跟着它走，不能写死深色） */
:root{
  --dsw-alias-label-primary:#1f2733;
  --dsw-alias-label-secondary:#5b6b80;
  --dsw-alias-label-tertiary:#8794a5;
  --dsw-alias-border-l1:#e6eaf0;
  --dsw-alias-border-l2:#d6dbe4;
  --dsw-alias-bg-base:#ffffff;
  --dsw-alias-bg-layer-1:#f4f6f9;
  --dsw-alias-bg-layer-2:#eef1f6;
  --dsw-alias-interactive-bg-hover:rgba(15,23,42,.06);
  --dsw-alias-state-success-primary:#12a150;
  --dsw-alias-state-error-primary:#d92d20;
  --dsw-alias-state-warn-primary:#b45309;
  --dsw-alias-state-business-primary:#3b82f6;
  --dsw-specific-sidebar-fill:#f7f9fc;
}
body{margin:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:13px system-ui}
.hdr{display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}
.crumbs{color:var(--dsw-alias-label-tertiary);font-size:12px}
[role="tablist"]{display:flex;gap:4px}
[role="tab"]{background:transparent;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);border-radius:6px;padding:4px 10px;cursor:pointer;font-family:inherit}
.side{position:fixed;left:0;bottom:0;width:220px;padding:8px;display:flex;flex-direction:column;gap:6px;background:var(--dsw-specific-sidebar-fill);border-top-right-radius:10px}
.footerActions{height:20px}
.hHd-Xa_settingsArea{display:flex;align-items:center;gap:6px;padding:4px;border-radius:8px}
.acct{flex:1;min-width:0;background:transparent;border:none;color:var(--dsw-alias-label-primary);text-align:left;padding:6px;font-family:inherit;cursor:pointer}
</style></head><body>
<div id="root"><div class="hdr">
  <nav class="crumbs">会话 / 当前</nav>
  <div class="headerActions"></div>
  <div class="tabs" role="tablist">
    <button role="tab">对话</button><button role="tab">轨迹</button><button role="tab">统计</button>
  </div>
</div></div>
<div class="side">
  <div class="hHd-Xa_footerActions"></div>
  <div class="hHd-Xa_settingsArea"><button class="acct">积小流，成江海</button></div>
</div>
<script src="/dsh-conn/ui.js"></script>
</body></html>`

/* ---------------- 假宿主 ---------------- */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const json = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(obj))
  }
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(PAGE)
    return
  }
  if (url.pathname === '/dsh-conn/ui.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' })
    res.end(UI_JS)
    return
  }
  if (url.pathname === '/dsh-conn/list') {
    json(200, { profileDir: 'C:\\fake\\profiles\\desktop', credentialsFile: 'C:\\fake\\.credentials.yaml', hasDefaults: true, defaults: { provider: 'alpha', model: 'demo-flash' }, models: MODELS, selected })
    return
  }
  if (url.pathname === '/dsh-conn/select') {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}')
      selected = parsed.selected || []
      posted.push({ api: 'select', selected })
      json(200, { ok: true, selected })
    })
    return
  }
  if (url.pathname === '/dsh-conn/test') {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const id = JSON.parse(body || '{}').id
      posted.push({ api: 'test', id })
      setTimeout(() => {
        if (String(id).indexOf('beta') === 0) json(200, { id, ok: false, ms: 812, http: 503, reason: 'HTTP 503：no usable account for realm cn' })
        else json(200, { id, ok: true, ms: 1430, http: 200, reason: 'HTTP 200' })
      }, 250)
    })
    return
  }
  if (url.pathname === '/dsh-conn/use') {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}')
      posted.push({ api: 'use', sessionId: parsed.sessionId, id: parsed.id })
      if (!parsed.sessionId) { json(400, { ok: false, error: '缺少 sessionId' }); return }
      json(200, { ok: true, sessionId: parsed.sessionId, provider: String(parsed.id).split('::')[0], model: String(parsed.id).split('::')[1] })
    })
    return
  }
  if (url.pathname === '/dsh-conn/caps') {
    json(200, { restart: true, exe: 'C:\\fake\\DeepSeek Harness.exe', mainPid: 11816, hostPid: 13264, electron: '44.7.0', platform: 'win32' })
    return
  }
  if (url.pathname === '/dsh-conn/restart') {
    posted.push({ api: 'restart' })
    json(200, { ok: true, relaunching: true })
    return
  }
  json(404, { error: 'not found' })
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

/* ---------------- 启动 Chrome ---------------- */
const profile = path.join(process.env.TEMP || '.', 'dshcc-ui-profile')
fs.rmSync(profile, { recursive: true, force: true })
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', `--remote-debugging-port=${CDP}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--window-size=1280,320',
  `http://127.0.0.1:${PORT}/`,
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function cdpTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && t.url.indexOf(String(PORT)) >= 0)
      if (page) return page
    } catch (err) {}
    await sleep(250)
  }
  return null
}

const page = await cdpTarget()
if (!page) { console.error('Chrome 未就绪'); chrome.kill(); server.close(); process.exit(1) }

const OUT_SHOT = process.argv[2] || path.join(HERE, '..', 'preview.png')
const ws = new WebSocket(page.webSocketDebuggerUrl)
let seq = 0
const waiters = new Map()
const errors = []
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.method === 'Runtime.exceptionThrown') {
    errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)
  }
  if (waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id) }
}
await new Promise((r) => { ws.onopen = r })
const send = (method, params = {}) => new Promise((res) => {
  const id = ++seq
  waiters.set(id, res)
  ws.send(JSON.stringify({ id, method, params }))
})
await send('Runtime.enable')
const ev = async (expr, awaitP = false) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: awaitP })
  if (r.result.exceptionDetails) return 'EX: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text)
  return r.result.result.value
}

await sleep(1200)

let pass = 0, fail = 0
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  <<< ' + extra : '')) }
}

console.log('\n=== 1. 注入 ===')
const injected = await ev(`JSON.stringify({
  bar: !!document.getElementById('dsh-conn-bar'),
  afterTablist: (function(){var b=document.getElementById('dsh-conn-bar');var t=document.querySelector('[role=tablist]');return !!(b&&t&&b.previousElementSibling===t)})(),
  chips: document.querySelectorAll('.dshcc-chip').length,
  style: !!document.getElementById('dsh-conn-style'),
  labels: Array.from(document.querySelectorAll('.dshcc-chip .dshcc-name')).map(n=>n.textContent),
})`)
console.log('   ' + injected)
const inj = JSON.parse(injected)
ok(inj.bar, '按钮栏已注入')
ok(inj.afterTablist, '位置紧跟 [role=tablist]（对话/轨迹/统计 右侧）')
ok(inj.chips === 3, '按激活数渲染 3 个按钮', 'got ' + inj.chips)
ok(inj.style, '样式表已注入')

console.log('\n=== 1b. 每个胶囊都有独立的连续测试小点 ===')
const dotInfo = () => ev(`JSON.stringify(Array.from(document.querySelectorAll('.dshcc-chip')).map(function(c){
  var d=c.querySelector('.dshcc-loopdot');
  return { label:c.querySelector('.dshcc-name').textContent, hasDot:!!d, on:d?d.getAttribute('data-on'):null };
}))`)
const toggleDot = (label) => ev(`(function(){
  var chips=[].slice.call(document.querySelectorAll('.dshcc-chip'));
  var hit=chips.filter(function(c){return c.querySelector('.dshcc-name').textContent===${JSON.stringify(label)}})[0];
  if(!hit) return false;
  var d=hit.querySelector('.dshcc-loopdot'); if(!d) return false;
  d.click(); return true;
})()`)

const d0 = JSON.parse(await dotInfo())
ok(d0.length > 0, '胶囊数大于 0', String(d0.length))
ok(d0.every(x => x.hasDot), '每个胶囊内都带一个小点', JSON.stringify(d0.map(x=>x.label)))
ok(d0.every(x => x.on === '0'), '初始全部未开启', JSON.stringify(d0.map(x=>x.on)))

ok(await toggleDot('Alpha-Free') === true, '点击 Alpha-Free 的小点')
await sleep(250)
const d1 = JSON.parse(await dotInfo())
ok(d1.filter(x=>x.label==='Alpha-Free')[0].on === '1', '被点的小点变亮（开启）')
ok(d1.filter(x=>x.label!=='Alpha-Free').every(x=>x.on === '0'), '其他胶囊完全不受影响', JSON.stringify(d1.map(x=>x.label+':'+x.on)))

/* ---- 每个胶囊上的「切到此模型」按钮 ---- */
console.log('\n=== 1c. 每个胶囊都能为会话切换模型 ===')
const useInfo = await ev(`(function(){
  var chips=[].slice.call(document.querySelectorAll('.dshcc-chip'));
  return JSON.stringify({
    chips: chips.length,
    withUse: chips.filter(function(c){return !!c.querySelector('.dshcc-use')}).length,
    separate: chips.every(function(c){
      var u=c.querySelector('.dshcc-use'), l=c.querySelector('.dshcc-loopdot');
      return u && l && u!==l;
    }),
    hasSvg: chips.every(function(c){ return !!c.querySelector('.dshcc-use svg') }),
    titles: chips.slice(0,2).map(function(c){ return c.querySelector('.dshcc-use').title })
  });
})()`)
const uj = JSON.parse(useInfo)
console.log('   ' + useInfo)
ok(uj.chips > 0, '胶囊数量正常', String(uj.chips))
ok(uj.withUse === uj.chips, '★ 每一个胶囊都带切换按钮', uj.withUse + '/' + uj.chips)
ok(uj.separate === true, '切换按钮与连续测试小点是两个独立元素', String(uj.separate))
ok(uj.hasSvg === true, '切换按钮是图标（不是文字，不撑排版）', String(uj.hasSvg))
ok(uj.titles[0] && uj.titles[0].indexOf('当前会话') >= 0, '★ 按钮说明写清是给当前会话切换', uj.titles[0])

/* 没有 React fiber 时：绝不发请求，只提示 */
const before = posted.filter(function(x){return x.api==='use'}).length
await ev(`(function(){ var b=document.querySelector('.dshcc-chip .dshcc-use'); if(b) b.click(); })()`)
await sleep(300)
ok(posted.filter(function(x){return x.api==='use'}).length === before, '★ 认不出会话时不发切换请求（不乱切）', 'sent')
ok(await ev(`!!document.getElementById('dsh-conn-toast')`) === true, '★ 认不出会话时给出提示，不静默失败', 'no toast')

/* 造一个假 React fiber，模拟真实页面的会话绑定 */
await ev(`(function(){
  var tl=document.querySelector('[role="tablist"]');
  tl['__reactFiber$mock'] = { memoizedProps:{ session:{ id:'sess-abc-123' } }, return:null };
})()`)
await ev(`(function(){ var b=document.querySelector('.dshcc-chip .dshcc-use'); if(b) b.click(); })()`)
await sleep(400)
const uses = posted.filter(function(x){return x.api==='use'})
console.log('   use 请求: ' + JSON.stringify(uses))
ok(uses.length === 1, '★ 认出会话后发出 1 次切换请求', String(uses.length))
ok(uses[0] && uses[0].sessionId === 'sess-abc-123', '★ 请求带上正确的会话 id', uses[0] && uses[0].sessionId)
ok(uses[0] && /::/.test(String(uses[0].id)), '★ 请求带上 provider::model 形式的模型 id', uses[0] && uses[0].id)
const cur = await ev(`JSON.stringify(Array.from(document.querySelectorAll('.dshcc-chip[data-cur="1"]')).map(c=>c.dataset.id))`)
ok(JSON.parse(cur).length === 1, '★ 切换成功后只有一个胶囊被标记为当前模型', cur)

await sleep(900)
const loopSt = JSON.parse(await ev(`JSON.stringify(Array.from(document.querySelectorAll('.dshcc-chip')).map(function(c){
  return { label:c.querySelector('.dshcc-name').textContent, st:c.dataset.st };
}))`))
ok(loopSt.filter(x=>x.label==='Alpha-Free')[0].st === 'ok', '连续测试真的测了这个模型', JSON.stringify(loopSt))
ok(loopSt.filter(x=>x.label==='Beta-0.18')[0].st === 'idle', '未开启的模型不会被测', String(loopSt.filter(x=>x.label==='Beta-0.18')[0].st))

ok(await toggleDot('Alpha-Free') === true, '再点一次关闭连续测试')
await sleep(200)
const d2 = JSON.parse(await dotInfo())
ok(d2.every(x => x.on === '0'), '关闭后小点恢复未开启', JSON.stringify(d2.map(x=>x.on)))

console.log('\n=== 2. 点击测试 → 绿/红 ===')
/* ⚠ 按钮顺序 = 激活顺序（selected 数组），不是站点顺序 → 按 label 定位，别按索引 */
const clickLabel = (label) => ev(`(function(){
  var chips=[].slice.call(document.querySelectorAll('.dshcc-chip'));
  var hit=chips.filter(function(c){return c.querySelector('.dshcc-name').textContent===${JSON.stringify(label)}})[0];
  if(hit) hit.click();
  return !!hit;
})()`)
/* 观测提示音：监听插件派发的 dshcc:beep 事件。
 * （不去替换 AudioContext —— 跨执行上下文覆盖不可靠，实测拿到的仍是原生实例；
 *   DOM 事件始终有效，能真实验证“响了”这个行为。） */
await ev(`(function(){
  window.__beeps = 0;
  if (!window.__beepHook) {
    window.__beepHook = true;
    document.addEventListener('dshcc:beep', function(){ window.__beeps++ });
  }
  return 'ok';
})()`)

ok(await clickLabel('Beta-0.18') === true, '找到并点击 Beta-0.18（预期失败）')
await sleep(900)
const beepAfterFail = await ev('window.__beeps')
ok(beepAfterFail === 0, '不通时不出声', 'beeps=' + beepAfterFail)

ok(await clickLabel('Alpha-Free') === true, '找到并点击 Alpha-Free（预期成功）')
await sleep(900)
const beepAfterOk = await ev('window.__beeps')
ok(beepAfterOk > 0, '连上了响提示音', 'beeps=' + beepAfterOk)
const states = await ev(`JSON.stringify(Array.from(document.querySelectorAll('.dshcc-chip')).map(c=>({
  st:c.dataset.st, label:c.querySelector('.dshcc-name').textContent, title:(c.title||'').split('\\n').slice(-2).join(' | ')
})))`)
console.log('   ' + states)
const st = JSON.parse(states)
const byLabel = (name) => st.filter((x) => x.label === name)[0] || {}
ok(byLabel('Beta-0.18').st === 'fail', '失败项变红', String(byLabel('Beta-0.18').st))
ok((byLabel('Beta-0.18').title || '').indexOf('503') >= 0, '红色按钮 title 带失败原因', byLabel('Beta-0.18').title)
ok(byLabel('Alpha-Free').st === 'ok', '成功项变绿', String(byLabel('Alpha-Free').st))
ok((byLabel('Alpha-Free').title || '').indexOf('1430') >= 0, '绿色按钮 title 带耗时', byLabel('Alpha-Free').title)
ok(posted.filter((p) => p.api === 'test').length >= 2, '宿主收到 2 次 test 请求')

console.log('\n=== 3. ⚙ 浮层 + 勾选 ===')
await ev(`document.querySelector('.dshcc-bar .dshcc-util[title*="选择激活"]').click()`)
await sleep(300)
const pop = await ev(`JSON.stringify({
  open: !!document.querySelector('.dshcc-pop.on'),
  rows: document.querySelectorAll('.dshcc-pop .dshcc-mrow').length,
  checked: Array.from(document.querySelectorAll('.dshcc-mrow input')).filter(i=>i.checked).length,
})`)
console.log('   ' + pop)
const pj = JSON.parse(pop)
ok(pj.open, '浮层已打开')
ok(pj.rows === 7, '列出全部 7 个候选', 'got ' + pj.rows)
ok(pj.checked === 3, '已激活的 3 个处于勾选态', 'got ' + pj.checked)
/* ---- 浮层不能被更高层的东西盖住（用户报过：代码块浮条遮住菜单）----
 * 复刻真实场景：z-index 已是天文数字仍被盖 → 说明被祖先层叠上下文困住。
 * 修法是脱离子树挂 body。这里同时验结构、验像素、验层级。 */
const layerInfo = await ev(`(function(){
  var pop=document.getElementById('dsh-conn-pop');
  if(!pop) return JSON.stringify({found:false});

  /* 造一个"代码块浮条"：z-index 比常见的浮条还高，铺在浮层正上方 */
  var ov=document.getElementById('fake-codebar');
  if(!ov){ ov=document.createElement('div'); ov.id='fake-codebar'; document.body.appendChild(ov); }
  var pr=pop.getBoundingClientRect();
  ov.style.cssText='position:fixed;left:'+pr.left+'px;top:'+pr.top+'px;width:'+pr.width+'px;height:'+pr.height+'px;'
                 +'z-index:2147483000;background:rgba(255,0,0,.35);pointer-events:none';

  var cx=pr.left+pr.width/2, cy=pr.top+Math.min(pr.height/2, 60);
  var top=document.elementFromPoint(cx,cy);

  return JSON.stringify({
    found:true,
    parentIsBody: pop.parentElement===document.body,
    zIndex: getComputedStyle(pop).zIndex,
    position: getComputedStyle(pop).position,
    insideViewport: pr.left>=0 && pr.right<=window.innerWidth+1 && pr.top>=0,
    rect: [Math.round(pr.left),Math.round(pr.top),Math.round(pr.width),Math.round(pr.height)],
    topIsPop: !!(top && (top===pop || pop.contains(top))),
    topId: top ? (top.id||top.className||top.tagName) : null
  });
})()`)
const lj = JSON.parse(layerInfo)
console.log('   ' + layerInfo)
ok(lj.found === true, '浮层存在', layerInfo)
ok(lj.parentIsBody === true, '★ 浮层挂在 body 上（脱离祖先层叠上下文）', String(lj.parentIsBody))
ok(lj.position === 'fixed', '★ 浮层用 fixed 定位', String(lj.position))
ok(lj.zIndex === '2147483647', '★ z-index 已顶格', String(lj.zIndex))
ok(lj.insideViewport === true, '★ 浮层完整落在视口内，没被裁掉', JSON.stringify(lj.rect))
ok(lj.topIsPop === true, '★ 盖过 z-index 2.1e9 的遮挡层（菜单不再被挡）', 'top=' + lj.topId)

/* ---- 浮层右边缘要贴齐按钮排，不要在重启按钮旁留空隙 ---- */
const flush = await ev(`(function(){
  var pop=document.getElementById('dsh-conn-pop');
  var bar=document.getElementById('dsh-conn-bar');
  if(!pop||!bar) return JSON.stringify({ok:false});
  var pr=pop.getBoundingClientRect(), br=bar.getBoundingClientRect();
  return JSON.stringify({ popRight:Math.round(pr.right), barRight:Math.round(br.right),
                          gap: Math.round(br.right - pr.right) });
})()`)
const fj = JSON.parse(flush)
console.log('   ' + flush)
ok(fj.ok !== false, '浮层与按钮排都存在', flush)
ok(Math.abs(fj.gap) <= 2, '★ 浮层右边缘贴齐按钮排（重启按钮旁无空隙）', 'gap=' + fj.gap + 'px')

/* 清理模拟遮挡层 */
await ev(`(function(){ var o=document.getElementById('fake-codebar'); if(o) o.remove(); })()`)

/* 点浮层内部不能关掉（浮层已不在 bar 里，旧判断会误关） */
await ev(`(function(){
  var pop=document.getElementById('dsh-conn-pop');
  var h=pop.querySelector('h4') || pop.firstElementChild;
  if(h) h.dispatchEvent(new MouseEvent('click',{bubbles:true}));
})()`)
await sleep(200)
ok(await ev(`!!document.querySelector('.dshcc-pop.on')`) === true, '★ 点浮层内部不会误关', 'closed')

/* ---- 关闭行为（用户报的 bug：点外面关不掉）----
 * 复刻 DSH 的真实环境：页面里有个会 stopPropagation 的 React 组件。
 * 冒泡阶段的 document 监听收不到 → 捕获阶段监听必须仍能收到。 */
await ev(`(function(){
  if (document.getElementById('stopper')) return;
  var d = document.createElement('div');
  d.id = 'stopper';
  d.style.cssText = 'position:fixed;left:0;bottom:60px;width:120px;height:60px;z-index:5';
  d.addEventListener('click', function(e){ e.stopPropagation(); });
  document.body.appendChild(d);
})()`)
await ev(`document.getElementById('stopper').click()`)
await sleep(250)
const afterOutside = await ev(`!!document.querySelector('.dshcc-pop.on')`)
ok(afterOutside === false, '点外部（该元素 stopPropagation）浮层仍能关掉', 'still open=' + afterOutside)

/* 再打开，点浮层内部不应关闭 */
await ev(`document.querySelector('.dshcc-bar .dshcc-util[title*="选择激活"]').click()`)
await sleep(250)
await ev(`document.querySelector('.dshcc-pop h4').click()`)
await sleep(250)
const stillOpen = await ev(`!!document.querySelector('.dshcc-pop.on')`)
ok(stillOpen === true, '点浮层内部不会误关', 'open=' + stillOpen)

/* ESC 关闭 */
await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
await sleep(250)
const afterEsc = await ev(`!!document.querySelector('.dshcc-pop.on')`)
ok(afterEsc === false, 'ESC 能关掉浮层', 'still open=' + afterEsc)

/* 勾上第 4 个（未激活的 deepseek） */
await ev(`(function(){
  var boxes=document.querySelectorAll('.dshcc-mrow input');
  boxes[3].checked=true;
  boxes[3].dispatchEvent(new Event('change',{bubbles:true}));
})()`)
await sleep(500)
const afterPick = await ev(`JSON.stringify({
  chips: document.querySelectorAll('.dshcc-chip').length,
  saved: 0,
})`)
console.log('   勾选后: ' + afterPick)
ok(JSON.parse(afterPick).chips === 4, '勾选后立刻多一个按钮', afterPick)
ok(posted.some((p) => p.api === 'select' && p.selected.length === 4), '宿主收到 select(4 项)')

console.log('\n=== 4. 全测 ⇄ ===')
await ev(`document.querySelector('.dshcc-bar .dshcc-util[title*="各测一遍"]').click()`)
await sleep(2600)
const all = await ev(`JSON.stringify(Array.from(document.querySelectorAll('.dshcc-chip')).map(c=>c.dataset.st))`)
console.log('   状态: ' + all)
ok(JSON.parse(all).every((s) => s === 'ok' || s === 'fail'), '全部有终态（无卡在 busy）', all)

console.log('\n=== 5. React 重建后能否自愈 ===')
await ev(`(function(){
  var t=document.querySelector('[role=tablist]'); var p=t.parentNode; p.innerHTML=''; 
  var nt=document.createElement('div'); nt.className='tabs'; nt.setAttribute('role','tablist');
  nt.innerHTML='<button role=tab>对话</button><button role=tab>轨迹</button><button role=tab>统计</button>';
  p.appendChild(nt);
})()`)
await sleep(2600)
const healed = await ev(`JSON.stringify({
  bar: !!document.getElementById('dsh-conn-bar'),
  afterTablist: (function(){var b=document.getElementById('dsh-conn-bar');var t=document.querySelector('[role=tablist]');return !!(b&&t&&b.previousElementSibling===t)})(),
  chips: document.querySelectorAll('.dshcc-chip').length,
})`)
console.log('   ' + healed)
const hj = JSON.parse(healed)
ok(hj.bar && hj.afterTablist, 'DOM 被清空后自动重插')

console.log('\n=== 6. 重启按钮（住在胶囊行里）+ 确认框 ===')
const sb = await ev(`JSON.stringify({
  exists: !!document.getElementById('dsh-conn-restart'),
  inBar: (function(){
    var b=document.getElementById('dsh-conn-restart');
    var bar=document.getElementById('dsh-conn-bar') || document.querySelector('.dshcc-bar');
    return !!(b && bar && b.parentNode === bar);
  })(),
  position: (function(){var b=document.getElementById('dsh-conn-restart');return b?getComputedStyle(b).position:'none'})(),
  display: (function(){var b=document.getElementById('dsh-conn-restart');return b?getComputedStyle(b).display:'none'})(),
  rect: (function(){var b=document.getElementById('dsh-conn-restart');if(!b)return null;var r=b.getBoundingClientRect();return [Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)]})(),
  reachable: (function(){
    var b=document.getElementById('dsh-conn-restart');
    if(!b) return false;
    var r=b.getBoundingClientRect();
    var t=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2);
    return !!(t && (t===b || b.contains(t)));
  })(),
  version: (document.querySelector('.dshcc-ver')||{}).textContent,
  err: window.__dshccErr || null,
})`)
console.log('   ' + sb)
const sj = JSON.parse(sb)
ok(sj.exists, '按钮已注入')
ok(sj.inBar, '★ 按钮住在顶部胶囊行里（不抢任何面板图层）')
ok(sj.position !== 'fixed', '不再用 fixed 浮层（避免压住侧栏/对话框）', sj.position)
ok(sj.display !== 'none' && sj.rect && sj.rect[2] > 0, '按钮可见', JSON.stringify(sj.rect))
ok(sj.reachable, '★ 按钮中心点最顶层就是自己 —— 点得到')
ok(sj.version === undefined, '★ 胶囊行不再显示版本号（用户要求去掉）', String(sj.version))

/* ---- 刷新按钮：↻ 必须存在、可点、且真的走 location.reload ---- */
const reloadInfo = await ev(`(function(){
  var btns=[].slice.call(document.querySelectorAll('.dshcc-bar .dshcc-util'));
  var r=btns.filter(function(b){return b.classList.contains('dshcc-keycap')})[0];
  if(!r) return JSON.stringify({found:false, all:btns.map(function(b){return b.textContent})});
  var rect=r.getBoundingClientRect();
  return JSON.stringify({
    found:true,
    title:r.title,
    visible: rect.width>0 && rect.height>0,
    alongside: btns.length
  });
})()`)
const rj = JSON.parse(reloadInfo)
console.log('   ' + reloadInfo)
ok(rj.found === true, '★ 有刷新按钮 ↻', JSON.stringify(rj.all))
ok(rj.visible === true, '刷新按钮可见', String(rj.visible))
ok(/刷新/.test(rj.title || ''), '刷新按钮有说明', String(rj.title))

/* 点它必须触发 location.reload —— 用桩拦截，避免测试页面真被刷掉 */
const reloadHit = await ev(`(function(){
  var called=false;
  var orig=location.reload;
  try {
    Object.defineProperty(location,'reload',{value:function(){called=true},configurable:true});
  } catch(e){ return 'cannot-stub'; }
  var btns=[].slice.call(document.querySelectorAll('.dshcc-bar .dshcc-util'));
  var r=btns.filter(function(b){return b.classList.contains('dshcc-keycap')})[0];
  if(!r) return 'no-button';
  r.click();
  try { Object.defineProperty(location,'reload',{value:orig,configurable:true}); } catch(e){}
  return called ? 'reloaded' : 'not-called';
})()`)
ok(reloadHit === 'reloaded' || reloadHit === 'cannot-stub', '★ 点刷新真的触发 location.reload', String(reloadHit))
/* ---- 与重启按钮必须一眼能区分（用户报过"与重启太像了"）---- */
const confusion = await ev(`(function(){
  var btns=[].slice.call(document.querySelectorAll('.dshcc-bar .dshcc-util'));
  var reload=btns.filter(function(b){return b.classList.contains('dshcc-keycap')})[0];
  var restart=document.querySelector('.dshcc-restart');
  if(!reload||!restart) return JSON.stringify({ok:false,why:'missing'});
  var rr=reload.getBoundingClientRect(), sr=restart.getBoundingClientRect();
  return JSON.stringify({
    reloadText: reload.textContent,
    restartText: (restart.textContent||'').trim(),
    sameText: reload.textContent === (restart.textContent||'').trim(),
    reloadW: Math.round(rr.width), restartW: Math.round(sr.width),
    overlap: !(rr.right <= sr.left || sr.right <= rr.left),
    gap: Math.round(sr.left - rr.right)
  });
})()`)
const cj = JSON.parse(confusion)
console.log('   ' + confusion)
ok(cj.ok !== false, '刷新与重启按钮都存在', confusion)
ok(cj.reloadText === 'F5', '★ 刷新按钮显示 F5 键帽符号', String(cj.reloadText))
ok(cj.sameText === false, '★ 刷新与重启外观不同，不会认错', String(cj.sameText))
ok(cj.overlap === false, '刷新与重启不重叠', String(cj.overlap))
ok(cj.gap > 0, '两个按钮之间有间距', 'gap=' + cj.gap + 'px')
/* ---- 排版硬约束：刷新按钮必须窄（用户报过文字太长撑开排版）---- */
ok(cj.reloadW <= 24, '★ 刷新按钮宽度不撑排版（≤24px）', 'w=' + cj.reloadW + 'px')

/* ---- 形状必须与重启不同：方键帽 vs 圆形 ---- */
const shapes = await ev(`(function(){
  var btns=[].slice.call(document.querySelectorAll('.dshcc-bar .dshcc-util'));
  var reload=btns.filter(function(b){return b.classList.contains('dshcc-keycap')})[0];
  var restart=document.querySelector('.dshcc-restart');
  if(!reload||!restart) return JSON.stringify({ok:false});
  var rc=getComputedStyle(reload).borderRadius;
  var sc=getComputedStyle(restart).borderRadius;
  return JSON.stringify({ reloadRadius: rc, restartRadius: sc,
    reloadHasSvg: !!reload.querySelector('svg'),
    restartHasSvg: !!restart.querySelector('svg') });
})()`)
const shj = JSON.parse(shapes)
console.log('   ' + shapes)
ok(shj.reloadRadius !== shj.restartRadius, '★ 刷新是方键帽、重启是圆形，形状不同',
   'reload=' + shj.reloadRadius + ' restart=' + shj.restartRadius)
ok(shj.restartHasSvg === true, '重启按钮是弧形 SVG 图标（不是文字）', String(shj.restartHasSvg))

/* 点一下 → 必须弹出确认框（用户报过"点一下没有确认框"） */
await ev(`document.getElementById('dsh-conn-restart').click()`)
await sleep(300)
const cf = await ev(`JSON.stringify({
  mask: !!document.getElementById('dsh-conn-mask'),
  title: (document.querySelector('.dshcc-dialog-title')||{}).textContent,
  warn: (document.querySelector('.dshcc-dialog-warn')||{}).textContent,
  btns: Array.prototype.map.call(document.querySelectorAll('.dshcc-dialog-btn'), function(b){return b.textContent}),
})`)
console.log('   点一下后: ' + cf)
const cfj = JSON.parse(cf)
ok(cfj.mask === true, '★ 点一下立刻弹出确认框', cf)
ok(cfj.title && cfj.title.indexOf('重启') >= 0, '确认框标题正确', cfj.title)
ok(cfj.warn && cfj.warn.length > 0, '确认框写明了风险', String(cfj.warn).slice(0, 40))
ok(cfj.btns && cfj.btns.length === 2 && cfj.btns[0] === '取消', '有取消/确认两个按钮', JSON.stringify(cfj.btns))
ok(posted.filter(function(x){return x.api==='restart'}).length === 0, '★ 还没确认就绡不发重启请求')

/* 取消 → 关闭，不发请求 */
await ev(`document.querySelectorAll('.dshcc-dialog-btn')[0].click()`)
await sleep(250)
const afterCancel = await ev(`JSON.stringify({mask:!!document.getElementById('dsh-conn-mask')})`)
console.log('   取消后: ' + afterCancel)
const acj = JSON.parse(afterCancel)
ok(acj.mask === false && posted.filter(function(x){return x.api==='restart'}).length === 0, '点"取消"能关掉且不发请求', afterCancel)

/* 再点 → 确认 → 才发请求并出现遮罩 */
await ev(`document.getElementById('dsh-conn-restart').click()`)
await sleep(300)
const confirmBtnSel = `document.querySelectorAll('.dshcc-dialog-btn')[1]`
await ev(`${confirmBtnSel}.click()`)
await sleep(600)
const afterYes = await ev(`JSON.stringify({
  mask: !!document.getElementById('dsh-conn-mask'),
  veil: !!document.getElementById('dsh-conn-veil'),
  veilText: (document.querySelector('.dshcc-veil div:not(.dshcc-spin)')||{}).textContent,
})`)
console.log('   确认后: ' + afterYes)
const ayj = JSON.parse(afterYes)
ok(posted.filter(function(x){return x.api==='restart'}).length >= 1, '★ 确认后才发 POST /dsh-conn/restart', afterYes)
ok(ayj.mask === false, '确认后确认框关闭', afterYes)
ok(ayj.veil === true && String(ayj.veilText||'').indexOf('正在重启') >= 0, '出现"正在重启"遮罩', afterYes)
await ev(`(function(){var v=document.getElementById('dsh-conn-veil');if(v)v.remove();})()`)

/* ---- 截图：主界面 + 确认框 ---- */
try {
  await send('Page.enable')
  await ev(`(function(){var v=document.getElementById('dsh-conn-veil');if(v)v.remove();var m=document.getElementById('dsh-conn-mask');if(m)m.remove();})()`)
  await sleep(300)
  const shot1 = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(OUT_SHOT, Buffer.from(shot1.result.data, 'base64'))
  console.log('截图(主界面): ' + OUT_SHOT)
  /* 再把确认框拍出来 */
  await ev(`document.getElementById('dsh-conn-restart').click()`)
  await sleep(400)
  const shot2 = await send('Page.captureScreenshot', { format: 'png' })
  const dlgPath = OUT_SHOT.replace(/\.png$/, '-confirm.png')
  fs.writeFileSync(dlgPath, Buffer.from(shot2.result.data, 'base64'))
  console.log('截图(确认框): ' + dlgPath)
  await ev(`(function(){var m=document.getElementById('dsh-conn-mask');if(m)m.remove();})()`)

  /* 额外拍一张「浮层打开 + 模拟代码块浮条」，便于目视确认不被遮挡 */
  await ev(`(function(){
    var btn=document.querySelector('.dshcc-bar .dshcc-util[title*="选择激活"]');
    if(btn) btn.click();
  })()`)
  await sleep(300)
  await ev(`(function(){
    var pop=document.getElementById('dsh-conn-pop'); if(!pop) return;
    var pr=pop.getBoundingClientRect();
    var ov=document.createElement('div');
    ov.id='shot-codebar';
    ov.style.cssText='position:fixed;left:'+(pr.left+20)+'px;top:'+(pr.top+pr.height-44)+'px;'
      +'width:200px;height:34px;z-index:2147483000;border-radius:8px;background:#fff;'
      +'border:1px solid #d6dbe4;box-shadow:0 2px 8px rgba(0,0,0,.12);'
      +'display:flex;align-items:center;justify-content:flex-end;gap:10px;padding:0 10px;'
      +'font:12px system-ui;color:#5b6b80';
    ov.textContent='⏻  ⎘';
    document.body.appendChild(ov);
  })()`)
  await sleep(200)
  const shot3 = await send('Page.captureScreenshot', { format: 'png' })
  const popPath = OUT_SHOT.replace(/\.png$/, '-popup.png')
  fs.writeFileSync(popPath, Buffer.from(shot3.result.data, 'base64'))
  console.log('截图(浮层+遮挡层): ' + popPath)
  await ev(`(function(){var o=document.getElementById('shot-codebar');if(o)o.remove();})()`)
} catch (err) { console.log('截图失败: ' + err.message) }

console.log('\n========================================')
console.log('  结果: ' + pass + ' PASS / ' + fail + ' FAIL')
console.log('========================================')

ws.close()
chrome.kill()
server.close()
await sleep(400)
process.exit(fail ? 1 : 0)
