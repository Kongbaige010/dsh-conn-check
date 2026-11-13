/**
 * dsh-conn-check 前端脚本
 * ---------------------------------------------------------------------------
 * 干什么：在会话头部「对话 / 轨迹 / 统计」那一排的右侧，插一排模型小按钮。
 *   点一下 → 让宿主代发一次 max_tokens=1 的请求 → 通=绿 / 不通=红。
 *   ⚙ 里勾选"激活哪几个"（存到 ~/.dsh/dsh-conn-check.json，重启/换会话都保留）。
 *
 * 怎么落地（为什么不走 client 插件槽位）：
 *   槽位需要编译 React 包；这里用 DOM 注入，零构建、纯 ES5 风格，改完刷新即生效。
 *   锚点是 `[role="tablist"]`（会话视图里唯一），React 重渲染会把它连同我们节点一起重建，
 *   所以用 MutationObserver 兜底重插。
 */
(function () {
  if (window.__dshConnCheck) return
  window.__dshConnCheck = true

  /* 界面版本号：每次改动 +1，直接显示在页面上，
   * 这样用户一截图就能确认他跑的是哪一版，不用互相猜。 */
  /* 版本号：仅作内部标识，已不在界面上显示 */
  var UI_VERSION = 'v12'

  var API = '/dsh-conn'
  var BAR_ID = 'dsh-conn-bar'
  var state = {
    list: null,
    results: {},      /* id -> { state: 'busy'|'ok'|'fail', ms, reason } */
    current: null,    /* 当前会话正在用的模型 id（切换成功后点亮） */
    popOpen: false,
    loading: false,
    loops: {},        /* id -> 定时器句柄；有键就表示该模型正在连续测试 */
    sound: true,      /* 连上时是否响提示音 */
  }

  /* ---------------- 样式（一次性注入） ----------------
   * ★ 配色一律取 DSH 主题变量（--dsw-alias-*），带浅色兜底值。
   *   绝对不写死深色底：用户浅色主题下会变成一块纯黑，跟界面完全脱节。
   * ⚠ 不加任何 [class*=…] 全局选择器 —— 那会改到 DSH 自己的布局。
   *   宿主容器只认我们 JS 打上的 .dshcc-host 标记。 */
  var V = function (name, fallback) { return 'var(--dsw-alias-' + name + ',' + fallback + ')' }
  function injectStyle() {
    if (document.getElementById('dsh-conn-style')) return
    var BORDER = V('border-l2', 'rgba(0,0,0,.14)')
    var HOVER = V('interactive-bg-hover', 'rgba(0,0,0,.06)')
    var LABEL1 = V('label-primary', '#1f2733')
    var LABEL2 = V('label-secondary', '#5b6b80')
    var LABEL3 = V('label-tertiary', '#8794a5')
    var BG1 = V('bg-layer-1', 'rgba(127,127,127,.07)')
    var BG2 = V('bg-layer-2', 'rgba(127,127,127,.12)')
    var BGBASE = V('bg-base', '#ffffff')
    var ACCENT = V('state-business-primary', '#3b82f6')
    var OKC = V('state-success-primary', '#12a150')
    var ERRC = V('state-error-primary', '#d92d20')
    var WARNC = V('state-warn-primary', '#b45309')
    var css = [
      /* ---- 顶部模型胶囊 ---- */
      '.dshcc-bar{display:flex;align-items:center;gap:6px;margin-left:auto;padding-left:12px;flex-wrap:nowrap;position:relative;font-size:11.5px;line-height:1}',
      '.dshcc-chips{display:flex;align-items:center;gap:6px;flex-wrap:nowrap;min-width:0}',
      '.dshcc-chip{height:22px;padding:0 9px;border-radius:999px;border:1px solid ' + BORDER + ';background:' + BG1 + ';color:' + LABEL2 + ';cursor:pointer;font-size:11.5px;font-family:inherit;display:inline-flex;align-items:center;gap:5px;white-space:nowrap;transition:border-color .15s,color .15s,background .15s}',
      '.dshcc-chip:hover{border-color:' + ACCENT + ';color:' + LABEL1 + '}',
      '.dshcc-chip[data-st="ok"]{border-color:' + OKC + ';color:' + OKC + ';background:transparent}',
      '.dshcc-chip[data-st="fail"]{border-color:' + ERRC + ';color:' + ERRC + ';background:transparent}',
      '.dshcc-chip[data-st="busy"]{border-color:' + ACCENT + ';color:' + ACCENT + ';background:transparent}',
      '.dshcc-dot{width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.85;flex:none}',
      /* 每个胶囊自带的连续测试开关：一个更小的圆点，跟在名字后面 */
      '.dshcc-loopdot{width:7px;height:7px;border-radius:50%;border:1px solid currentColor;opacity:.4;flex:none;cursor:pointer;transition:opacity .15s,background .15s}',
      '.dshcc-loopdot:hover{opacity:1;background:currentColor}',
      '.dshcc-loopdot[data-on="1"]{background:' + OKC + ';border-color:' + OKC + ';opacity:1;animation:dshcc-pulse 1.2s infinite}',
      '@keyframes dshcc-pulse{0%,100%{opacity:.85}50%{opacity:.25}}',
      '.dshcc-chip[data-st="busy"] .dshcc-dot{animation:dshcc-pulse 1s infinite}',
      /* 每个胶囊上的"切到此模型"按钮：平时半透明，悬停才亮，不抢视觉 */
      '.dshcc-use{flex:none;display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:4px;opacity:.4;cursor:pointer;transition:opacity .15s,background .15s}',
      '.dshcc-use:hover{opacity:1;background:' + HOVER + '}',
      '.dshcc-use svg{display:block;pointer-events:none}',
      '.dshcc-chip[data-cur="1"] .dshcc-use{opacity:1;color:' + ACCENT + '}',
      '.dshcc-chip[data-cur="1"]{border-color:' + ACCENT + '}',
      /* 轻提示 */
      '.dshcc-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483647;max-width:70vw;padding:8px 14px;border-radius:999px;border:1px solid ' + BORDER + ';background:' + BGBASE + ';color:' + LABEL1 + ';font-size:12px;line-height:1.5;box-shadow:0 8px 24px rgba(0,0,0,.16);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dshcc-toast.bad{border-color:' + ERRC + ';color:' + ERRC + '}',
      '.dshcc-toast.good{border-color:' + OKC + ';color:' + OKC + '}',
      '.dshcc-util{height:22px;width:22px;padding:0;border-radius:6px;border:1px solid ' + BORDER + ';background:' + BG1 + ';color:' + LABEL2 + ';cursor:pointer;font-size:12px;line-height:1;display:inline-flex;align-items:center;justify-content:center;font-family:inherit}',
      '.dshcc-util:hover{border-color:' + ACCENT + ';color:' + LABEL1 + '}',
      /* F5 键帽：固定 22px 方块（不撑排版），字号压小才能塞下两个字符 */
      '.dshcc-keycap{font-size:10px;font-weight:700;letter-spacing:-.3px;font-family:ui-monospace,Consolas,monospace;line-height:1}',
      '.dshcc-util.dshcc-spin > *{display:inline-block}',
      '.dshcc-util.dshcc-spin{animation:dshcc-rot .8s linear infinite}',
      /* ---- ⚙ 浮层 ---- */
      /* ⚠⚠ 浮层必须挂在 body 上、用 position:fixed —— 不能放在胶囊行里。
       *   原因（实测）：z-index 已经设到 2147483000 仍被 DSH 的代码块浮条盖住。
       *   那不是数值不够大，而是被**祖先层叠上下文**困住了：祖先的 z-index 小，
       *   子元素数值再大也翻不出去。唯一可靠解法是脱离该子树，挂到 body。
       *   ID 固定为 dsh-conn-pop，避免和 DSH 自己的类名撞车。 */
      '.dshcc-pop{box-sizing:border-box;position:fixed;top:0;left:0;z-index:2147483647;width:320px;max-height:min(420px,calc(100vh - 96px));overflow:auto;background:' + BG1 + ';border:1px solid ' + BORDER + ';border-radius:10px;padding:8px;box-shadow:0 12px 32px rgba(0,0,0,.18);display:none;text-align:left;-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px)}',
      '.dshcc-pop.on{display:block}',
      '.dshcc-pop h4{margin:2px 4px 8px;font-size:11px;font-weight:600;letter-spacing:.4px;color:' + LABEL3 + '}',
      '.dshcc-row{display:flex;align-items:center;gap:8px;padding:5px 6px;border-radius:6px;cursor:pointer;color:' + LABEL1 + ';font-size:12px}',
      '.dshcc-row:hover{background:' + HOVER + '}',
      '.dshcc-row input{margin:0;flex:none}',
      '.dshcc-row .dshcc-meta{margin-left:auto;color:' + LABEL3 + ';font-size:10.5px}',
      '.dshcc-row.dshcc-nokey .dshcc-name{color:' + LABEL3 + '}',
      '.dshcc-swt{display:flex;align-items:center;gap:8px;margin-top:6px;padding:6px 6px 0;border-top:1px solid ' + BORDER + ';border-radius:0 0 6px 6px;cursor:pointer;color:' + LABEL1 + ';font-size:12px}',
      '.dshcc-swt:hover{background:' + HOVER + '}',
      '.dshcc-swt input{margin:0;flex:none}',
      '.dshcc-swt .dshcc-name{flex:1}',
      '.dshcc-swt .dshcc-meta{color:' + LABEL3 + ';font-size:10.5px}',
      '.dshcc-tip{margin:6px 4px 2px;color:' + LABEL3 + ';font-size:10.5px;line-height:1.6;white-space:pre-line}',
      /* ---- 重启按钮：常驻顶部胶囊行，和 ⚙ 并排 ----
       * 不用 fixed，也不用绝对定位：跟着胶囊行正常参与 flex 布局，
       * 既不会压住侧栏/面板图层，也不会被账号按钮盖住。 */
      '.dshcc-restart{flex:0 0 auto;width:24px;height:24px;border:none;border-radius:50%;background:transparent;color:' + LABEL3 + ';cursor:pointer;display:inline-flex;align-items:center;justify-content:center;transition:background .15s,color .15s;padding:0}',
      '.dshcc-restart:hover{background:' + HOVER + ';color:' + LABEL1 + '}',
      '.dshcc-restart.bad{color:' + ERRC + ';background:' + HOVER + '}',
      '.dshcc-restart.busy{color:' + ACCENT + '}',
      '.dshcc-restart svg{display:block}',
      '.dshcc-restart.busy svg{animation:dshcc-rot .9s linear infinite}',
      /* ---- 确认对话框 ---- */
      '.dshcc-mask{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.32);display:flex;align-items:center;justify-content:center;-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px)}',
      '.dshcc-dialog{width:min(400px,calc(100vw - 48px));border-radius:12px;border:1px solid ' + BORDER + ';background:' + BGBASE + ';box-shadow:0 18px 48px rgba(0,0,0,.24);padding:18px 18px 14px;color:' + LABEL1 + ';font-size:13px;line-height:1.55}',
      '.dshcc-dialog-title{font-size:15px;font-weight:600;color:' + LABEL1 + ';margin-bottom:8px}',
      '.dshcc-dialog-body{color:' + LABEL2 + ';margin-bottom:16px}',
      '.dshcc-dialog-warn{margin-top:6px;color:' + WARNC + ';font-size:12px}',
      '.dshcc-dialog-detail{margin-top:4px;padding:8px 10px;border-radius:8px;background:' + BG2 + ';color:' + LABEL2 + ';font-size:12px;word-break:break-all;max-height:180px;overflow:auto}',
      '.dshcc-dialog-row{display:flex;justify-content:flex-end;gap:8px}',
      '.dshcc-dialog-btn{height:30px;padding:0 14px;border-radius:8px;border:1px solid ' + BORDER + ';background:transparent;color:' + LABEL1 + ';font-size:12.5px;cursor:pointer;transition:background .15s,border-color .15s}',
      '.dshcc-dialog-btn:hover{background:' + HOVER + '}',
      '.dshcc-dialog-btn.dshcc-danger{background:' + ERRC + ';border-color:' + ERRC + ';color:#fff}',
      '.dshcc-dialog-btn.dshcc-danger:hover{opacity:.9;background:' + ERRC + '}',

      /* ---- 重启遮罩 ---- */
      '.dshcc-veil{position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.55);color:#fff;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px;font:14px system-ui,-apple-system,"Segoe UI",sans-serif}',
      '.dshcc-veil-hint{margin-top:4px;font-size:12px;opacity:.75;max-width:420px;text-align:center;line-height:1.6;word-break:break-all}',
      '.dshcc-veil-btn{margin-top:10px;height:30px;padding:0 16px;border-radius:8px;border:1px solid rgba(255,255,255,.5);background:transparent;color:#fff;font-size:12.5px;cursor:pointer}',
      '.dshcc-veil .dshcc-spin{width:26px;height:26px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:dshcc-rot .8s linear infinite}',
      '@keyframes dshcc-rot{to{transform:rotate(360deg)}}',
    ].join('')
    var style = document.createElement('style')
    style.id = 'dsh-conn-style'
    style.textContent = css
    document.head.appendChild(style)
  }

  /* ---------------- 小工具 ---------------- */
  function mk(tag, cls, text) {
    var n = document.createElement(tag)
    if (cls) n.className = cls
    if (text != null) n.textContent = text
    return n
  }
  function shorten(name) {
    var s = String(name || '')
    return s.length > 14 ? s.slice(0, 13) + '…' : s
  }
  function api(path, body) {
    var opt = body === undefined ? {} : {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
    return fetch(API + path, opt).then(function (r) { return r.json() })
  }

  /* ---------------- 渲染 ---------------- */
  function render() {
    var bar = document.getElementById(BAR_ID)
    if (!bar || !state.list) return
    var body = bar.querySelector('.dshcc-chips')
    while (body.firstChild) body.removeChild(body.firstChild)

    var picked = state.list.selected || []
    var models = state.list.models || []

    if (!picked.length) {
      var hint = mk('span', 'dshcc-tip', '未激活任何模型 —— 点 ⚙ 勾选')
      hint.style.margin = '0'
      body.appendChild(hint)
    }

    picked.forEach(function (id) {
      var m = models.filter(function (x) { return x.id === id })[0]
      if (!m) return
      var res = state.results[id] || { state: 'idle' }
      var chip = mk('button', 'dshcc-chip')
      chip.type = 'button'
      chip.dataset.id = id
      chip.dataset.st = res.state
      chip.dataset.cur = state.current === id ? '1' : '0'
      chip.appendChild(mk('span', 'dshcc-dot'))
      chip.appendChild(mk('span', 'dshcc-name', shorten(m.providerName)))

      /* 这一个模型自己的连续测试开关：点了就反复测它，不影响其他胶囊 */
      var loopDot = mk('span', 'dshcc-loopdot')
      loopDot.setAttribute('data-on', state.loops[id] ? '1' : '0')
      loopDot.title = state.loops[id]
        ? '连续测试中 —— 点击停止'
        : '只连续测试这一个模型'
      loopDot.addEventListener('click', function (e) {
        e.stopPropagation()
        ensureAudio()
        toggleLoopOne(id)
      })
      chip.appendChild(loopDot)

      /* 切到此模型：点这个小箭头就让**当前会话**改用这个模型 */
      var useBtn = mk('span', 'dshcc-use')
      useBtn.setAttribute('role', 'button')
      useBtn.setAttribute('tabindex', '-1')
      useBtn.setAttribute('data-use', id)
      useBtn.innerHTML = USE_ARROW
      useBtn.title = '让当前会话改用 ' + m.providerName + ' / ' + m.model
      useBtn.addEventListener('click', function (e) {
        e.stopPropagation()
        ensureAudio()
        useModel(id, chip)
      })
      chip.appendChild(useBtn)

      var tip = [m.providerName + ' / ' + m.model, m.site]
      if (!m.hasKey) tip.push('⚠ 没有配密钥')
      if (res.state === 'ok') tip.push('通 · ' + res.ms + ' ms')
      else if (res.state === 'fail') tip.push('不通 · ' + (res.reason || '未知原因') + (res.ms ? ' · ' + res.ms + ' ms' : ''))
      else if (res.state === 'busy') tip.push('测试中…')
      tip.push('点击测试')
      chip.title = tip.join('\n')

      chip.addEventListener('click', function () { ensureAudio(); runOne(id) })
      body.appendChild(chip)
    })

    /* 齿轮浮层内容（浮层在 body 上，不在 bar 里） */
    var pop = ensurePop()
    while (pop.firstChild) pop.removeChild(pop.firstChild)
    pop.appendChild(mk('h4', null, '激活哪些模型（勾选后即时保存）'))
    models.forEach(function (m) {
      var row = mk('label', 'dshcc-row dshcc-mrow' + (m.hasKey ? '' : ' dshcc-nokey'))
      var cb = document.createElement('input')
      cb.type = 'checkbox'
      cb.checked = picked.indexOf(m.id) !== -1
      cb.addEventListener('change', function () {
        var next = (state.list.selected || []).slice()
        var at = next.indexOf(m.id)
        if (cb.checked && at < 0) next.push(m.id)
        if (!cb.checked && at >= 0) next.splice(at, 1)
        state.list.selected = next
        render()
        api('/select', { selected: next }).catch(function () {})
      })
      row.appendChild(cb)
      var name = mk('span', 'dshcc-name', m.providerName + ' · ' + m.model)
      row.appendChild(name)
      var meta = mk('span', 'dshcc-meta')
      if (m.isDefault) meta.textContent = '默认'
      else if (!m.hasKey) meta.textContent = '无密钥'
      row.appendChild(meta)
      row.title = m.site || ''
      pop.appendChild(row)
    })
    /* 提示音开关：连上时响一声，放在这里可以随时关掉 */
    var sndRow = mk('label', 'dshcc-swt')
    var sndCb = document.createElement('input')
    sndCb.type = 'checkbox'
    sndCb.checked = !!state.sound
    sndCb.addEventListener('change', function () {
      state.sound = sndCb.checked
      if (state.sound) beep()   /* 打开时立刻响一声，顺便验证能不能出声 */
    })
    sndRow.appendChild(sndCb)
    sndRow.appendChild(mk('span', 'dshcc-name', '连上时响提示音'))
    var sndMeta = mk('span', 'dshcc-meta', state.sound ? '开' : '关')
    sndRow.appendChild(sndMeta)
    pop.appendChild(sndRow)

    var foot = mk('div', 'dshcc-tip',
      '绿色=通，红色=不通；鼠标停在按钮上看耗时与错误原因。\n主机：' + (state.list.profileDir || '未识别 profile'))
    foot.style.whiteSpace = 'pre-line'
    pop.appendChild(foot)
  }

  /* ---------------- 用户动作 ---------------- */
  function setResult(id, res) {
    state.results[id] = res
  }

  /* ---------------- 提示音：连上了响一声 ----------------
   * 用 Web Audio 现场合成，不依赖任何音频文件（插件目录里不用塞 mp3）。
   * 浏览器要求先有用户手势才能出声——测试都是点出来的，所以没问题；
   * 万一 context 还是 suspended，就 resume 一次再响。 */
  var audioCtx = null

  /* ⚠⚠ 关键：Chrome 的自动播放策略要求 AudioContext 必须在**用户手势的同步栈**里
   *   创建/恢复，否则 state 永远是 'suspended'，声音根本发不出来（实测就是这样）。
   *   所以点击处理器里先同步调 ensureAudio()，等 fetch 回调里再响时 context 已 running。 */
  function ensureAudio() {
    try {
      if (!audioCtx) {
        var AC = window.AudioContext || window.webkitAudioContext
        if (!AC) return null
        audioCtx = new AC()
      }
      if (audioCtx.state === 'suspended' && audioCtx.resume) audioCtx.resume()
      return audioCtx
    } catch (e) { return null }
  }

  function beep() {
    try {
      if (!state.sound) return
      var ctx = ensureAudio()
      if (!ctx) return
      var t0 = ctx.currentTime
      /* 两声上行 880→1320Hz，像“叮—叮”，比单音更容易被注意到 */
      var tones = [[880, 0], [1320, 0.10]]
      for (var i = 0; i < tones.length; i++) {
        var freq = tones[i][0]
        var at = t0 + tones[i][1]
        var osc = ctx.createOscillator()
        var gain = ctx.createGain()
        osc.type = 'sine'
        osc.frequency.value = freq
        gain.gain.setValueAtTime(0.0001, at)
        gain.gain.linearRampToValueAtTime(0.16, at + 0.012)
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.11)
        osc.connect(gain)
        gain.connect(ctx.destination)
        osc.start(at)
        osc.stop(at + 0.13)
      }
      /* 给外部一个可观测信号（自动化验证用），对播放没有任何影响 */
      try { document.dispatchEvent(new CustomEvent('dshcc:beep')) } catch (e2) {}
    } catch (e) { /* 没有声卡/被策略拦住都不该影响测试本身 */ }
  }

  /* 统一落结果：连上了就响。
   * 连续测试模式下只在“由不通变通”时响，否则每 3 秒一声会吵死人。 */
  function commitResult(id, res) {
    var prev = (state.results[id] || {}).state
    setResult(id, res)
    if (res && res.state === 'ok') {
      if (!state.loops[id] || prev !== 'ok') beep()
    }
  }

  function runOne(id) {
    if ((state.results[id] || {}).state === 'busy') return
    setResult(id, { state: 'busy' })
    render()
    api('/test', { id: id }).then(function (d) {
      commitResult(id, { state: d && d.ok ? 'ok' : 'fail', ms: d && d.ms, reason: d && (d.reason || d.error) })
      render()
    }).catch(function (e) {
      setResult(id, { state: 'fail', reason: '宿主无响应：' + String(e && e.message || e) })
      render()
    })
  }

  function runAll() {
    var ids = (state.list && state.list.selected || []).slice()
    var i = 0
    var next = function () {
      if (i >= ids.length) return
      var id = ids[i++]
      setResult(id, { state: 'busy' })
      render()
      api('/test', { id: id }).then(function (d) {
        commitResult(id, { state: d && d.ok ? 'ok' : 'fail', ms: d && d.ms, reason: d && (d.reason || d.error) })
        render()
        next()
      }).catch(function () {
        setResult(id, { state: 'fail', reason: '宿主无响应' })
        render()
        next()
      })
    }
    next()
  }

  /* ---------------- 连续测试（按胶囊独立轮询） ----------------
   * 每个胶囊自己那个小圆点只管它自己：点了就一直反复测这个模型，
   * 两轮之间停 3 秒；再点一次停止。多个胶囊可以同时各自跑，互不干扰。 */
  /* ---------------- 当前会话 id ----------------
   * DSH 不把会话 id 放进 URL / DOM / localStorage，客户端容器也没挂到 window 上，
   * 所以这里顺着 React fiber 往上找 props 里的 session 绑定。
   * 找不到就返回 null —— 绝不拿"最近一个会话"去猜，宁可不切也不能切错。 */
  function fiberOf(el) {
    if (!el) return null
    var ks
    try { ks = Object.keys(el) } catch (e) { return null }
    for (var i = 0; i < ks.length; i++) {
      if (ks[i].indexOf('__reactFiber$') === 0) return el[ks[i]]
      if (ks[i].indexOf('__reactInternalInstance$') === 0) return el[ks[i]]
    }
    return null
  }

  function idFromSession(obj) {
    if (!obj || typeof obj !== 'object') return null
    if (typeof obj.id === 'string' && obj.id) return obj.id
    if (typeof obj.sessionId === 'string' && obj.sessionId) return obj.sessionId
    return null
  }

  function idFromProps(p) {
    if (!p || typeof p !== 'object') return null
    if (typeof p.sessionId === 'string' && p.sessionId) return p.sessionId
    var id = idFromSession(p.session)
    if (id) return id
    if (p.binding) {
      id = idFromSession(p.binding.session)
      if (id) return id
      try {
        var snap = typeof p.binding.session?.getSnapshot === 'function' ? p.binding.session.getSnapshot() : null
        id = idFromSession(snap)
        if (id) return id
      } catch (e) {}
    }
    if (p.slot && p.slot.session) { id = idFromSession(p.slot.session); if (id) return id }
    return null
  }

  function findSessionId() {
    var seeds = []
    var bar = document.getElementById(BAR_ID)
    if (bar && bar.parentElement) seeds.push(bar.parentElement)
    var tl = document.querySelector('[role="tablist"]')
    if (tl) seeds.push(tl)
    for (var i = 0; i < seeds.length; i++) {
      var f = fiberOf(seeds[i])
      var guard = 0
      while (f && guard++ < 600) {
        var id = idFromProps(f.memoizedProps) || idFromProps(f.pendingProps)
        if (id) return id
        f = f.return
      }
    }
    return null
  }

  /* ---------------- 切到此模型 ---------------- */
  var toastTimer = null
  function toast(text, kind) {
    var el = document.getElementById('dsh-conn-toast')
    if (!el) {
      el = mk('div', 'dshcc-toast')
      el.id = 'dsh-conn-toast'
      document.body.appendChild(el)
    }
    el.className = 'dshcc-toast' + (kind ? ' ' + kind : '')
    el.textContent = text
    el.style.display = 'block'
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(function () { el.style.display = 'none' }, 2600)
  }

  var USE_ARROW = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M4 12h13"/><path d="M12 6l6 6-6 6"/></svg>'

  function useModel(id, chip) {
    var sid = findSessionId()
    if (!sid) {
      toast('识别不到当前会话，暂时无法切换', 'bad')
      return
    }
    var prevCur = state.current
    state.current = id
    render()
    api('/use', { sessionId: sid, id: id }).then(function (d) {
      if (d && d.ok) {
        toast('已切换：' + String(d.model || ''), 'good')
        beep()
      } else {
        state.current = prevCur
        toast('切换失败：' + String((d && d.error) || '未知原因'), 'bad')
      }
      render()
    }).catch(function (e) {
      state.current = prevCur
      /* 接口还不存在，最可能是宿主端没重启过（前端改了只要刷新，宿主改了必须重启） */
      toast('切换失败：宿主还没加载该接口，需要重启一次 DSH', 'bad')
      render()
    })
  }

  var LOOP_GAP_MS = 3000

  function toggleLoopOne(id) {
    if (state.loops[id]) {
      clearTimeout(state.loops[id])
      delete state.loops[id]
      render()
      return
    }
    state.loops[id] = -1   /* 占位：第一次请求正在进行 */
    render()
    loopOne(id)
  }

  function loopOne(id) {
    if (!(id in state.loops)) return
    setResult(id, { state: 'busy' })
    render()
    api('/test', { id: id }).then(function (d) {
      if (!(id in state.loops)) return
      commitResult(id, { state: d && d.ok ? 'ok' : 'fail', ms: d && d.ms, reason: d && (d.reason || d.error) })
      render()
      state.loops[id] = setTimeout(function () { loopOne(id) }, LOOP_GAP_MS)
    }).catch(function () {
      if (!(id in state.loops)) return
      setResult(id, { state: 'fail', reason: '宿主无响应' })
      render()
      state.loops[id] = setTimeout(function () { loopOne(id) }, LOOP_GAP_MS)
    })
  }

  /* ---------------- 挂载 ---------------- */
  function buildBar() {
    var bar = mk('div', 'dshcc-bar')
    bar.id = BAR_ID
    var chips = mk('div', 'dshcc-chips')
    chips.style.display = 'flex'
    chips.style.alignItems = 'center'
    chips.style.gap = '6px'
    chips.style.flexWrap = 'wrap'
    bar.appendChild(chips)

    var btnAll = mk('button', 'dshcc-util', '⇄')
    btnAll.type = 'button'
    btnAll.title = '把已激活的模型各测一遍'
    btnAll.addEventListener('click', function (e) { e.stopPropagation(); ensureAudio(); runAll() })
    bar.appendChild(btnAll)

    /* 刷新页面：插件前端改动后点一下就行，不用重启 DSH。
     *
     * ⚠ 图标选型史（别再踩）：
     *   1) ↻  —— 与重启的圆弧箭头只差一个方向，用户报「与重启太像」。
     *   2) 「刷新」文字 —— 太宽，把胶囊行的排版撑开了。
     *   3) 现在：F5 键帽。按钮本身就是圆角方框，里面写 F5，
     *      形状上是「方键帽」，与重启的「圆形箭头」完全不同；
     *      宽度也回到 22px 方块，不再影响排版；
     *      而 F5 本身就是浏览器刷新的通用隐喻，不需要猜。 */
    var btnReload = mk('button', 'dshcc-util dshcc-keycap', 'F5')
    btnReload.type = 'button'
    btnReload.title = '刷新页面（重新加载界面，不会中断对话）'
    btnReload.addEventListener('click', function (e) {
      e.stopPropagation()
      btnReload.classList.add('dshcc-spin')
      try { location.reload() } catch (err) {}
      /* 万一 reload 被拦，1.2 秒后恢复按钮外观，不要一直转 */
      setTimeout(function () { btnReload.classList.remove('dshcc-spin') }, 1200)
    })
    bar.appendChild(btnReload)

    var btnCfg = mk('button', 'dshcc-util', '⚙')
    btnCfg.type = 'button'
    btnCfg.title = '选择激活哪些模型'
    btnCfg.addEventListener('click', function (e) {
      e.stopPropagation()
      state.popOpen = !state.popOpen
      var pop = ensurePop()
      if (state.popOpen) placePop()
      pop.classList.toggle('on', state.popOpen)
    })
    bar.appendChild(btnCfg)

    ensurePop()
    return bar
  }

  /* 浮层：挂在 body 上，才能盖住 DSH 自己的浮条（详见样式处的注释） */
  var POP_ID = 'dsh-conn-pop'
  function getPop() { return document.getElementById(POP_ID) }
  function ensurePop() {
    var pop = getPop()
    if (!pop) {
      pop = mk('div', 'dshcc-pop')
      pop.id = POP_ID
      document.body.appendChild(pop)
    } else if (pop.parentNode !== document.body) {
      document.body.appendChild(pop)
    }
    return pop
  }

  /* 把浮层摆到按钮排下方、右边缘对齐，并夹在视口内。
   * ⚠ 右边界对齐的是**整排按钮的右边缘**（即重启按钮右侧），
   *   而不是 ⚙ 的右边；否则重启按钮旁边会空出一截（用户报过）。 */
  function placePop() {
    var pop = getPop()
    var btn = document.querySelector('.dshcc-bar .dshcc-util[title*="选择激活"]')
    var bar = document.getElementById(BAR_ID)
    if (!pop || !btn) return
    var r = btn.getBoundingClientRect()
    var rr = bar ? bar.getBoundingClientRect() : r
    var anchorRight = (bar && rr.right > r.right) ? rr.right : r.right
    var w = 320
    var left = Math.min(anchorRight - w, window.innerWidth - w - 8)
    if (left < 8) left = 8
    var top = r.bottom + 6
    var maxH = Math.min(420, window.innerHeight - top - 12)
    pop.style.left = Math.round(left) + 'px'
    pop.style.top = Math.round(top) + 'px'
    pop.style.width = w + 'px'
    pop.style.maxHeight = Math.max(160, maxH) + 'px'
  }

  /* 关掉⚙浮层。★ 必须用**捕获阶段**监听：
   * DSH 的 React 组件普遍 e.stopPropagation()，冒泡阶段的 document 监听根本收不到点击，
   * 浮层就"弹出来关不掉"（实测踩到）。捕获阶段早于一切冒泡处理，不受影响。 */
  function closePop() {
    state.popOpen = false
    var p = getPop()
    if (p) p.classList.remove('on')
  }

  function bindOutsideClose() {
    if (window.__dshccOutsideBound) return
    window.__dshccOutsideBound = true
    document.addEventListener('click', function (e) {
      if (!state.popOpen) return
      var b = document.getElementById(BAR_ID)
      if (b && b.contains(e.target)) return
      /* 浮层现在挂在 body 上，不在 bar 里 —— 点浮层内部不能关 */
      var p = getPop()
      if (p && p.contains(e.target)) return
      closePop()
    }, true)
    document.addEventListener('keydown', function (e) {
      if (!state.popOpen) return
      if (e.key === 'Escape' || e.keyCode === 27) closePop()
    }, true)
    /* 切会话/切标签时 DOM 会被换掉，顺手收起来 */
    window.addEventListener('blur', closePop)
    /* 窗口尺寸变了要重算重启按钮的坐标 */
    window.addEventListener('resize', function () {
      try { mountRestartBtn() } catch (err) {}
      if (state.popOpen) placePop()
    })
    /* 页面滚动时浮层是 fixed 的，会脱离按钮 → 重新贴住按钮 */
    window.addEventListener('scroll', function () {
      if (state.popOpen) placePop()
    }, true)
  }

  function mount() {
    var tablist = document.querySelector('[role="tablist"]')
    if (!tablist || !tablist.parentNode) return false
    injectStyle()
    var existing = document.getElementById(BAR_ID)
    if (existing) {
      /* 已被 React 移到别处或位置不对 → 重新贴到 tablist 之后 */
      if (existing.previousElementSibling !== tablist) {
        tablist.parentNode.insertBefore(existing, tablist.nextSibling)
      }
      return true
    }
    var bar = buildBar()
    tablist.parentNode.insertBefore(bar, tablist.nextSibling)
    loadList()
    return true
  }

  function loadList() {
    if (state.loading) return
    state.loading = true
    api('/list').then(function (d) {
      state.loading = false
      state.list = d
      render()
    }).catch(function () {
      state.loading = false
      var bar = document.getElementById(BAR_ID)
      if (!bar) return
      var chips = bar.querySelector('.dshcc-chips')
      while (chips.firstChild) chips.removeChild(chips.firstChild)
      var err = mk('span', 'dshcc-tip', '宿主接口不可用（/dsh-conn/list）')
      err.style.margin = '0'
      err.style.color = '#fca5a5'
      chips.appendChild(err)
    })
  }

  /* ---------------- 重启按钮（住在顶部胶囊行里） ----------------
   * ⚠ 血泪教训：不要试图塞进左下角账号区。
   *   · 账号 trigger 是 width:100% 的不透明整行按钮，同层插入必被整块盖住
   *   · 页面上有多份 settingsArea 副本，querySelector 可能命中 0 尺寸隐藏副本
   *   · 即便用 fixed 浮上去，也会压在侧栏/设置面板的图层上，观感很乱
   * 胶囊行是用户已经能看见的区域，放这里 100% 可见、不与任何面板抢图层。 */
  var RESTART_TITLE = '重启 DeepSeek Harness（改了插件/配置后需要）—— 会中断当前会话'
  var capsCache = null

  function loadCaps() {
    if (capsCache) return Promise.resolve(capsCache)
    return api('/caps').then(function (d) {
      capsCache = d || { restart: false }
      return capsCache
    }).catch(function () {
      capsCache = { restart: false }
      return capsCache
    })
  }

  /* 重启遮罩。⚠ 必须有超时兜底：
   * 实测过重启没起来时，遮罩会一直转下去，用户只能强杀窗口。
   * 超时后直接把真相摆出来：给一个关闭按钮 + 手动重启指引。 */
  var veilTimer = null
  function veil(text) {
    var v = document.getElementById('dsh-conn-veil')
    if (v) return
    v = mk('div', 'dshcc-veil')
    v.id = 'dsh-conn-veil'
    var spin = mk('div', 'dshcc-spin')
    var msg = mk('div', null, text)
    var hint = mk('div', 'dshcc-veil-hint')
    v.appendChild(spin)
    v.appendChild(msg)
    v.appendChild(hint)
    document.body.appendChild(v)

    var started = Date.now()
    veilTimer = setInterval(function () {
      var sec = Math.round((Date.now() - started) / 1000)
      if (sec < 20) return
      /* 20 秒还没换页 → 重启没成功，别再骗用户了 */
      clearInterval(veilTimer)
      spin.style.display = 'none'
      msg.textContent = '重启似乎没有完成（已等 ' + sec + ' 秒）'
      hint.textContent = '请手动关掉窗口再从桌面图标打开。日志：~/.dsh/dsh-conn-restart.log'
      var btn = mk('button', 'dshcc-veil-btn', '关闭遮罩')
      btn.type = 'button'
      btn.addEventListener('click', function () {
        v.style.display = 'none'
      })
      v.appendChild(btn)
    }, 1000)
  }

  /* 真正的确认对话框（不是"再点一次"那种隐性交互 —— 用户点一次就该看到明确的确认） */
  var confirmOpen = false
  function askConfirm(onYes) {
    if (confirmOpen) return
    confirmOpen = true

    var mask = mk('div', 'dshcc-mask')
    mask.id = 'dsh-conn-mask'

    var box = mk('div', 'dshcc-dialog')
    box.appendChild(mk('div', 'dshcc-dialog-title', '重启 DeepSeek Harness？'))

    var body = mk('div', 'dshcc-dialog-body')
    body.appendChild(mk('div', null, '会关闭当前窗口并重新启动应用。'))
    var warn = mk('div', 'dshcc-dialog-warn', '正在进行中的回答会被中断，未提交的输入可能丢失。')
    body.appendChild(warn)
    box.appendChild(body)

    var row = mk('div', 'dshcc-dialog-row')
    var btnNo = mk('button', 'dshcc-dialog-btn', '取消')
    btnNo.type = 'button'
    var btnYes = mk('button', 'dshcc-dialog-btn dshcc-danger', '确认重启')
    btnYes.type = 'button'
    row.appendChild(btnNo)
    row.appendChild(btnYes)
    box.appendChild(row)
    mask.appendChild(box)

    function close() {
      confirmOpen = false
      if (mask.parentNode) mask.parentNode.removeChild(mask)
      document.removeEventListener('keydown', onKey, true)
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); close() }
    }
    btnNo.addEventListener('click', function (e) { e.stopPropagation(); close() })
    btnYes.addEventListener('click', function (e) {
      e.stopPropagation()
      close()
      onYes()
    })
    mask.addEventListener('click', function (e) {
      if (e.target === mask) close()
      else e.stopPropagation()
    })
    document.addEventListener('keydown', onKey, true)
    document.body.appendChild(mask)
    /* 聚焦"取消"，避免手快连按回车直接重启 */
    try { btnNo.focus() } catch (err) {}
  }

  function doRestart(btn) {
    askConfirm(function () {
      btn.classList.add('busy')
      fetch(API + '/restart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function (r) { return r.json().then(function (j) { return { s: r.status, j: j } }) })
        .then(function (out) {
          if (out.s === 200 && out.j && out.j.ok) {
            veil('正在重启 DeepSeek Harness…')
          } else {
            btn.classList.remove('busy')
            var why = (out.j && (out.j.reason || out.j.error)) || ('HTTP ' + out.s)
            btn.title = '重启未执行：' + why
            btn.classList.add('bad')
            setTimeout(function () { btn.classList.remove('bad'); btn.title = RESTART_TITLE }, 4000)
            /* 把完整原因摊开给用户看，而不是只闪一下 title */
            askAlert('无法自动重启', String(why))
          }
        })
        .catch(function (err) {
          btn.classList.remove('busy')
          askAlert('无法自动重启', '请求失败：' + (err && err.message ? err.message : '未知错误'))
        })
    })
  }

  /* 失败时给一个明确的说法，不要静默 */
  function askAlert(title, detail) {
    var mask = mk('div', 'dshcc-mask')
    var box = mk('div', 'dshcc-dialog')
    box.appendChild(mk('div', 'dshcc-dialog-title', title))
    var body = mk('div', 'dshcc-dialog-body')
    var pre = mk('div', 'dshcc-dialog-detail', detail)
    body.appendChild(pre)
    box.appendChild(body)
    var row = mk('div', 'dshcc-dialog-row')
    var okBtn = mk('button', 'dshcc-dialog-btn', '知道了')
    okBtn.type = 'button'
    row.appendChild(okBtn)
    box.appendChild(row)
    mask.appendChild(box)
    function close() { if (mask.parentNode) mask.parentNode.removeChild(mask) }
    okBtn.addEventListener('click', close)
    mask.addEventListener('click', function (e) { if (e.target === mask) close() })
    document.body.appendChild(mask)
  }

  /* 按钮挂在胶囊行尾部（⚙ 右边），随胶囊一起被 DSH 正常布局 */
  function mountRestartBtn() {
    var bar = document.getElementById(BAR_ID)
    if (!bar) return false
    var btn = document.getElementById('dsh-conn-restart')
    if (!btn) {
      btn = document.createElement('button')
      btn.id = 'dsh-conn-restart'
      btn.type = 'button'
      btn.className = 'dshcc-restart'
      btn.title = RESTART_TITLE
      btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>'
      btn.addEventListener('click', function (e) {
        e.preventDefault()
        e.stopPropagation()
        if (btn.dataset.off === '1') return
        doRestart(btn)
      })
      loadCaps().then(function (caps) {
        if (caps && caps.restart === false && caps.exe) {
          btn.dataset.off = '1'
          btn.title = '宿主报告不支持自重启（' + caps.exe + '）'
        }
      })
    }
    if (btn.parentNode !== bar) bar.appendChild(btn)
    return true
  }


  function tryMount(force) {
    var now = Date.now()
    if (!force && now - lastCheck < 250) return
    lastCheck = now
    /* 不要静默吞异常——吞了就只能看到"按钮没出现"而不知道为什么。 */
    try { mount() } catch (err) { window.__dshccErr = 'mount: ' + (err && err.message) }
    try {
      if (document.body) { injectStyle(); bindOutsideClose(); mountRestartBtn() }
    } catch (err) { window.__dshccErr = 'mountRestartBtn: ' + (err && err.message) }
  }

  tryMount(true)
  var obs = new MutationObserver(function () { tryMount(false) })
  try {
    obs.observe(document.documentElement, { childList: true, subtree: true })
  } catch (err) {}
  /* 兜底：某些时刻 DOM 静默（比如只是切换会话），低频补检查 */
  setInterval(function () { tryMount(true) }, 2000)
})()
