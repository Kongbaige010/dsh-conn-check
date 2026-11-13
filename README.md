# dsh-conn-check

> 只是要**安装使用**：看 [INSTALL.md](INSTALL.md)。
> 本文是技术笔记（设计取舍、接口、踩过的坑），维护或改动前再读。

两块小工具，都挂在界面上随点随用：

1. **模型连通性按钮** —— 会话头部 `对话 / 轨迹 / 统计` 右侧一排模型胶囊，点一下真发一次最小请求，通=绿、不通=红。
2. **重启按钮** —— 胶囊行最右端的 ⟳，点了重启 DeepSeek Harness（改插件/配置后不必再去任务管理器）。
3. **切换会话模型** —— 每个胶囊右端的小箭头 `→`，点了让当前会话直接改用该模型。

---

## 一、它做什么

| 元素 | 位置 | 作用 |
|---|---|---|
| 模型胶囊（如 `Alpha-Free`） | 会话头部右侧 | 点一下 → 宿主代发一次 `max_tokens=1` 请求 → 绿/红；悬停看耗时与失败原因 |
| `⇄` | 同上 | 把当前激活的模型挨个测一遍（串行，避免打爆中转站） |
| `⚙` | 同上 | 浮层里勾选「激活哪几个」，勾选即时保存 |
| ⟳ 重启 | 胶囊行最右端 | **点两次**确认后重启整个应用；按钮变绿闪一下即表示已发起 |
| `→` 箭头 | 每个胶囊右端 | 把当前会话切到该模型（成功后该胶囊高亮） |

状态色：灰=没测过，蓝=测试中，**绿=通**，**红=不通**（悬停能看到 `HTTP 503：...` 这类原文）。

重启按钮的三重保险：① 要连点两次（第一次只是"上膛"，3 秒后自动取消）；② 服务端先返回 200 再退出，前端立刻盖一层「正在重启」遮罩；③ **拿不到 Electron app 时按钮直接置灰**（web/headless 模式），绝不"点了就消失又不回来"。

## 二、为什么需要宿主侧

浏览器里 `fetch` 第三方 API 会被 CORS 拦（只有对方放行才通）。所以：
**按钮 → 本插件宿主路由 → Node 发请求 → 结果回给页面**。
密钥只在宿主内存里用，**不会**下发到页面。

## 三、接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/dsh-conn/list` | 候选模型清单 + 当前激活项 + profile 位置 |
| POST | `/dsh-conn/select` | `{selected:["provider::model"]}` 保存激活选择 |
| POST | `/dsh-conn/test` | `{id}` 真测一个，返回 `{ok,ms,http,reason}` |
| GET | `/dsh-conn/ui.js` | 前端脚本（页面注入用） |
| GET | `/dsh-conn/caps` | 能力探测：`{restart:boolean, electron, processType}` |
| POST | `/dsh-conn/restart` | 先回 200，再 `app.relaunch() + app.exit(0)`；拿不到 app 时 503 拒绝 |

安全栅栏：只放行 **回环 Host + 同源 Origin + 非 cross-site** 的请求，防止别的网页偷用你的 key。

## 四、装 / 卸

```powershell
$dsh = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"

# 装（link 方式：改代码不用重装，重启即生效）
& $dsh plugin --profile desktop add "link:<你的用户目录>/.dsh/local-plugins/dsh-conn-check"

# 卸
& $dsh plugin --profile desktop remove dsh-conn-check
```

装完**重启 DeepSeek Harness** 才生效（插件在宿主启动时加载）。

## 五、文件结构与状态

```
dsh-conn-check/
├── package.json          # dsh.bundle.patch 指向 cordis.patch.yml
├── cordis.patch.yml      # 挂载声明（insert 本插件）
├── lib/index.js          # 宿主：读配置 / 代发请求 / 4 条路由 / 注入行
├── assets/conn-check.js  # 前端：找 [role=tablist]，插按钮栏
└── tests/
    ├── selftest.mjs      # 配置解析自检（--net 可真发一次）
    ├── fake-host.mjs     # 模拟 cordis 环境跑插件全流程（--net 可打通到真接口）
    └── mock-ui.mjs       # 假页面 + 真 Chrome 验证前端交互与截图
```

| 位置 | 内容 |
|---|---|
| `~/.dsh/dsh-conn-check.json` | 激活了哪几个模型（换站删模型后自动过滤幽灵项） |
| `~/.dsh/profiles/<profile>/cordis.patch.yml` | 候选模型的唯一真相源（读其中的 `llm-pi-ai.providers` 与 `agent-default-model`） |
| `~/.dsh/.credentials.yaml` | 密钥来源（`refs.<ENV_NAME>`） |

## 六、自检与排障

```powershell
cd ~/.dsh/local-plugins/dsh-conn-check
node tests/selftest.mjs --net    # 期望 18 PASS / 0 FAIL
node tests/fake-host.mjs --net   # 期望 58 PASS / 0 FAIL
node tests/mock-ui.mjs shot.png  # 期望 36 PASS / 0 FAIL，并出截图（含确认框）
node tests/auto-detect.mjs      # 期望 8 PASS / 0 FAIL（证明自动读配置，无硬编码）
node tests/restart-e2e.mjs      # 期望 6 PASS / 0 FAIL（真实杀进程+重启验证）
```

重启后按钮没出现，按顺序查：

1. 宿主日志里有没有 `[dsh-conn-check] ready · profile=... · models=7`；
2. 浏览器 DevTools Console 有没有 `conn-check.js` 加载错误；
3. `curl http://127.0.0.1:<端口>/dsh-conn/list` 能否返回 JSON（端口即当前 GUI 地址的端口）；
4. 页面里有没有 `[role="tablist"]`（空白 Hero 页没有，进入任一会话才出现）。

## 七、已知边界

- 只认「OpenAI 兼容」与「Anthropic messages」两种接口形态；其它协议按 OpenAI 形态发。
- 超时硬上限 20 s。
- 前端靠 DOM 注入（`[role="tablist"]` 右边），DSH 前端大改版时可能需要调整选择器。
- 探测请求会真实计费极小额度（`max_tokens=1`）。

---

## 八、踩过的坑（改之前先读）

### 1. 宿主不是 Electron 主进程，`app.relaunch()` 用不了

进程树实测：

```
11816  DeepSeek Harness.exe                        ← Electron 主进程
  └ 13264  DeepSeek Harness.exe --expose-internals ← dsh-desktop-host（插件跑在这）
```

宿主是主进程 fork 出的 `ELECTRON_RUN_AS_NODE` 子进程，`process.type === null`，
`require('electron')` 拿不到 `app`。第一版按 `app.relaunch()` 写，
结果 `/caps` 探测到「不支持」→ 按钮被置灰 → 用户根本看不到按钮。

**现在**：写一个 PowerShell 脚本并用 `cmd /c start` detach 启动，
由它在宿主死后继续完成「关窗 → 强杀 → 重新拉起」。
脚本日志落在 `~/.dsh/dsh-conn-restart.log`。

### 2. 浮层点外面关不掉 —— 冒泡阶段的 document 监听收不到

DSH 的 React 组件普遍 `e.stopPropagation()`，挂在 `document` 冒泡阶段的
click 监听被拦死，浮层弹出来就关不掉。

**现在**：改 `addEventListener(..., true)` 用**捕获阶段**，早于一切冒泡处理；
另加 `Esc` 关闭、窗口 blur 关闭。测试里专门造了一个 `stopPropagation` 元素复现该场景。

### 3. 重启失败的真因：Electron 单实例锁 + 残留子进程

**现象**：点重启 → 窗口关了 → 再也没起来。日志里只有一句假的 `relaunched OK`。

**实测证据**（当时已有一个 DSH 在跑）：

```
spawned pid=49348
结果: 已退出, exit=0     <-- 主动退出，典型的单实例锁行为
```

**两层原因**：

1. **DSH 有单实例锁**。已有实例时，新实例启动会立刻 `exit(0)` 把焦点交给老实例。
2. **只杀主进程不够**。`Stop-Process -Id <mainPid>` 只死主进程，
   残留的 renderer / GPU / host 子进程仍然占着锁句柄 →
   新实例看到"已有实例"→ exit(0) → 残留进程随后也死 → **什么都不剩**。

**为什么不能用 `app.relaunch()`**：插件跑在 forked host 进程里
（`process.type === null`、没有 `app` 对象），拿不到 Electron API。
**DSH 确实没有对外暴露的"重启"能力**，只能从外部拉起。

### 3a. 两段式重启：脚本A 只拉人，脚本B 去杀人

难点：终结者要杀"整棵进程树"，但它若是 DSH 的子孙进程，自己也会被连坐。

```
宿主（DSH 子进程）
  └─ detach 启动 开脚本A        ← 仍是 DSH 的孙进程
       └─ WMI Win32_Process.Create → 脚本B   ← 父进程变成 WmiPrvSE，脱离了！
            └─ 杀所有同名进程 → 等锁释放 → Start-Process 拉起 → 5s 后验证存活
```

脚本A 只做两件事：把脚本B写到临时目录（base64 传递避免转义地狱），
然后用 `Invoke-CimMethod ... Win32_Process Create` 把它拉起来，**自己立刻退出**。

脚本B 反复扫 8 次同名进程直到清空，日志记 `killed=N remaining=0`，
然后等 3 秒让锁彻底释放，再 `Start-Process -WorkingDirectory` 启动，5 秒后验证 `HasExited`。

验证（`tests/restart-e2e.mjs`，用替身进程，11 项全 PASS）：

| 断言 | 结果 |
|---|---|
| 终结者父进程 | `WmiPrvSE` ✓ 已脱离进程树 |
| 替身进程数 2 → 0 | ✓ 残留子进程也被清干净 |
| 启动器被执行 | ✓ 重启动作真的发生了 |

### 3a2. 最后一公里：只有 `explorer.exe` 能拉起它

把残留进程清到 `remaining=0` 之后，新实例**仍然** `exit=0`。对比两条路：

| 启动方式 | 父进程 | 结果 |
|---|---|---|
| `Start-Process -FilePath <exe>`（从 WMI/powershell 里） | powershell.exe | **exit=0**，窗口不出现 |
| 用户双击图标 | **explorer.exe** | 正常启动 |

测试过的不是单例锁、不是 Session 隔离（两边都是 SessionId=1）。
结论是从非 ShellExecute 路径拉起时，它会自己退出。

**现在的做法**：用 `Start-Process -FilePath "explorer.exe" -ArgumentList '"<exe>"'`，
等价于复刻一次双击，由 ShellExecute 在用户会话拉起。
验证方式也改了：不看 `HasExited`，直接**数同名进程个数**（`instances=N`），
N>0 才算成功，否则退回 `Start-Process` 再试一次。

### 3a2b. 延时误判：6 秒数不到进程，就判定重启失败

explorer 启动方式对了，但验收写死了 6 秒 —— 这个 exe 有 **246 MB**，冷启动远超 6 秒。

```
17:42:12  relaunching app
17:42:18  explorer launch done, instances=0     ← 6 秒没数到，误判失败
17:42:18  explorer failed, trying Start-Process ← 于是又拉一次
17:42:24  Start-Process launch done, instances=0
17:42:24  RELAUNCH DIED, no instance alive
    ...
17:42:59  新实例出现（父进程 explorer）          ← 其实它起来了！
```

两个后果：误报失败 + 重复拉起两个实例打架。用户看到的就是"一直在转"。

**修法**：改成轮询 —— 每秒数一次同名进程，explorer 路径最多等 **30 秒**，只有确实 0 个时才退回
`Start-Process` 再等 20 秒。一旦数到就收工，不再重复拉起。

### 3a2c. 独立重启器：`桌面\重启DSH.cmd`

不依赖插件上下文，双击即可用。它由 explorer 拉起，不在 DSH 进程树里，
所以可以安全地先杀干净再拉起。用于插件自身需要重启才能加载新代码的场景（鸡生蛋问题）。

### 3a3. 前端遮罩必须有超时兜底

旧版只会一直转圈。重启没成功时用户只能强杀窗口。
现在 20 秒后自动把真相摆出来：停止转圈、改文案为
"重启似乎没有完成（已等 N 秒）"、给手动重启指引与日志路径、并提供关闭按钮。

### 3a00. ✅✅ 真正的根因：`ELECTRON_RUN_AS_NODE` 环境变量

**这一条解释了之前所有矛盾现象。**

DSH 的 host 进程是这样跑的：

```
DeepSeek Harness.exe --expose-internals .../dsh-desktop-host/lib/index.js ...
```

它是在 **`ELECTRON_RUN_AS_NODE` 模式**下执行的。插件就跑在这个进程里，所以它 spawn 出去的
PowerShell 脚本**继承了 `ELECTRON_RUN_AS_NODE=1`**。于是脚本再启动
`DeepSeek Harness.exe` 时，这个 exe 也被当成 **Node 脚本**跑 → 没窗口、
无任何输出、`exit code 0`。

**实验证据**：

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
$p = Start-Process -FilePath $exe -PassThru
# -> HasExited=True, ExitCode=0
```

**为什么用户手动双击、桌面 .cmd 都正常**：它们由 `explorer.exe` 派生，
explorer 的环境里没有这个变量。**这就是"桌面 cmd 能用、插件里怎么改都不行"的答案。**

**修复**：reaper 脚本开头必须先清掉它：

```powershell
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Remove-Item Env:\ELECTRON_NO_ATTACH_CONSOLE -ErrorAction SilentlyContinue
```

**修复后实测**：

```
19:36:12  killed=6 stable=15
19:36:17  cmd start issued, waiting up to 60s...
19:36:18  after cmd start wait: instances=5     ← 1 秒就起来
19:36:18  relaunched OK, instances=5
```

### 3a0. ❌ 已被推翻的旧结论：lockfile + explorer 启动方式

> 以下两条曾被当作真因，后来证实都不是，保留作反面记录。
> 经验：`lockfile` 是进程持有的，进程死就消失（日志就写过 `no lockfile present`），
> 不是封锁文件；而 explorer.exe 启动确实不靠谱，但不是主因。


**两个真因，缺一不可：**

| # | 真因 | 证据 |
|---|---|---|
| 1 | `%APPDATA%\@deepseek-ai\dsh-desktop\lockfile` 残留 → 新实例判定"已有实例"直接 `quit()` | 删掉它后一次就成功（19:00），不删一直失败（18:58） |
| 2 | **`explorer.exe "<exe>"` 不会启动程序** | 只要用它就必登 `instances=0`，换 `Start-Process` / `cmd start` 立刻成功 |

**关于第 2 条的误区**：用户双击图标时父进程确实是 `explorer.exe`，
但那是 ShellExecute 的**结果**，不能反推成"用 explorer.exe 去启动"。
从脚本里 `explorer.exe "path"` 只会去打开文件夹或转给已有 explorer，不启动程序。

**最终可用写法**（三步）：

```powershell
# 1. taskkill 杀整棵树，等到连续 10 次（5s）计数为 0
& taskkill /F /T /IM "DeepSeek Harness.exe"
# 2. 删掉残留锁文件
Remove-Item "$env:APPDATA\@deepseek-ai\dsh-desktop\lockfile" -Force
# 3. Start-Process + 工作目录，并捕获 stderr 便于失败时定位
Start-Process -FilePath $exe -WorkingDirectory $dir -PassThru `
  -RedirectStandardError $err -RedirectStandardOutput $out -NoNewWindow
```

**对比实测**：

| 时间 | 旧/新代码 | 结果 |
|---|---|---|
| 17:41–18:03 多次 | explorer 启动 | ❌ 全部 `instances=0` |
| 18:58 | Start-Process（无 lockfile 清理） | ❌ `child exitcode=` 空，两次启动都 0 |
| **19:00** | **Start-Process + lockfile 清理** | ✅ **`relaunched OK, instances=5`** |

### 3a4. ✅ 实测通过：插件按钮能重启

```
17:56:18  ---- restart requested (main=45728 host=49508)
17:56:18  reaper spawned, pid=40496
17:56:21  killed=6 remaining=0
17:56:24  relaunching app
17:56:24  explorer launched, waiting up to 30s...
17:56:25  after explorer wait: instances=5
17:56:25  relaunched OK, instances=5
```

**对比之前失败的那次**：

| | 失败（17:46） | 成功（17:56） |
|---|---|---|
| 杀掉进程数 | `killed=2` | `killed=6` |
| explorer 后等候 | 30s 仍 `instances=0` | **1s 就 `instances=5`** |

**关键差异在 `killed`：只杀了 2 个就以为清完了，其实还有残留进程占着单实例锁，
新实例起来就 `quit()`。现在 `taskkill`-style 循环扫到 6 个全清掉，锁真正释放，
explorer 一拉就起来了（1 秒内就数到 5 个进程）。

### 3a5. `.cmd` 重启器里的两个致命 bug

顺手留下的经验，写 Windows 批处理时必看：

1. **必须 CRLF 换行**。用 LF 写的 `.cmd` 在 `cmd.exe` 里会被当成一行，整份脚本等于没写。
2. **路径里的 `\` 会被原样写进去**。Python 字符串写 `\\` 得到的是两个反斜杠，
   cmd 找不到文件 → `start` 静默失败。用 raw string 或列表拼接。

**铁律**：交付任何 `.cmd` / `.ps1` 之前，先空跑一遍演练（把动作命令换成 `echo`）。

### 3b. `Start-Process` 不报错 ≠ 启动成功（旧坑）

旧写法 `Start-Process -FilePath $exe | Out-Null; W "relaunched OK"`，
只要没抛异常就记一条成功日志 —— 事实上窗口根本没起来。
现在必须 `-PassThru` + 几秒后复查 `HasExited`，失败记 `RELAUNCH DIED, exit=N`。

### 3c. `BG2 is not defined` —— 一个未定义变量把整个挂载函数带崩

确认对话框的 CSS 用了 `BG2`，但只定义了 `BG1`。
`mountRestartBtn()` 抛异常 → 被 `try/catch` 吞掉 → **按钮根本没挂上**。

**教训**：`try/catch` 里不要静默丢弃异常，至少存到 `window.__dshccErr`。

### 3b. `BG2 is not defined` —— 一个未定义变量把整个挂载函数带崩

确认对话框的 CSS 用了 `BG2`，但只定义了 `BG1`。
`mountRestartBtn()` 抛异常 → 被 `try/catch` 吞掉 → **按钮根本没挂上**，
而外界只看到"没有按钮"。

**教训**：`try/catch` 里不要静默丢弃异常，至少存到 `window.__dshccErr`；
现在测试会直接读这个字段定位。

### 4. 账号区布局碰不得 —— 按钮必须脱离 DSH 的 DOM

踩了三次坑，每次都是"在账号区里部做布局"带来的：

| 尝试 | 结果 |
|---|---|
| `margin-left:auto` 距进 settingsArea | 账号 trigger 是 `width:100%` 带背景的整行按钮，把按钮整块盖住 |
| 给容器 `flex` + 强制账号按钮收窄 | 真实 DOM 里账号元素不一定是 `<button>`，选择器落空 |
| 绝对定位 + 抬 z-index | 同一层叠上下文里排在后面就压住我们 |

**现在**：按钮 `appendChild` 到 `document.body`，`position:fixed` + `z-index:2147483000`，
坐标由 JS 算到账号区右端。它根本不在那个 DOM 层级里，不可能被盖。

### 4b. `querySelector` 只取第一个命中 —— 隐藏副本会让按钮永远不出现

页面上往往有多份 `settingsArea`（响应式隐藏容器、切换态残留）。
如果第一个是 `0×0` 的隐藏副本，原来的代码会把按钮设成 `visibility:hidden`
并且永辽不恢复 —— 这是"按钮根本没出现"的最隐蔽原因。

**现在**：`querySelectorAll` 遍历，只接受尺寸 >8px 且在视口内的那个。

### 4c. 可见版本号

挂上去不算数，400ms 后用 `elementFromPoint` 验证"中心点最顶层是不是自己"：

1. 不可见 / 被遮挡 → 钉在左下角
2. 还不行 → 挪进顶部胶囊行（用户已经能看见胶囊，那里必定可见）
3. 都不行 → 胶囊行里弹红色小标签，点一下复制诊断 JSON

胶囊行尾巴常驻显示版本号（`v7`）。**用户一截图就能确认跑的是哪一版**，
不用双方盲猜"你刷新了吗 / 我改了啊" 。

第一版在 `settingsArea` 里插 `<button>`，`margin-left:auto` 靠右 ——
结果账号 trigger 自带不透明背景，把我们的按钮整个盖住（抬 `z-index` 无效：
同一层叠上下文里它排在后面就压住我们）。

**现在**：不改 DOM 层级，而是让**账号按钮自己让出宽度**——
给容器打 `.dshcc-host`，用
`.dshcc-host>button:not(.dshcc-restart){flex:1 1 auto;width:auto!important}`
把它压窄，重启按钮 `flex:0 0 auto` 稳稳待在右端。
测试里用 `elementFromPoint` 断言「按钮中心点最顶层就是自己」来防回归。

### 4. 写死深色配色，在浅色主题下变成一块纯黑

按钮配色一律取 DSH 主题变量，带浅色兜底：

`--dsw-alias-border-l2` / `bg-layer-1` / `label-primary/secondary/tertiary` /
`interactive-bg-hover` / `state-success-primary` / `state-error-primary` /
`state-warn-primary` / `state-business-primary`

### 5. 探测失败 ≠ 不支持，不能因此把按钮藏起来

`/caps` 探测不到（旧宿主没这接口、网络抖动）时按「未知」处理，按钮保持可点；
只有宿主新版明确回 `restart:false` 且带 `exe` 字段时才标成不可用。

### 6. 不写 `[class*=…]` 全局选择器

CSS Modules 的类名前缀会随构建变。宿主容器由 JS 打 `.dshcc-host` 标记，
CSS 只作用于标记过的容器，**绝不改 DSH 自己的布局**。

---

## 切换会话模型（每胶囊一个按钮）

胶囊上问号形状之外的那个小箭头，点一下就让**当前会话**改用该模型。

链路：前端 → `POST /dsh-conn/use {sessionId, id}` → `sessionController.selectModel({sessionId, provider, model})`

- **不自造写盘逻辑**：直接调用 DSH 内置的 `sessionController.selectModel`，与内置模型选择器同一接口。
- **不猜会话**：DSH 不把会话 id 放进 URL / DOM / localStorage，前端只能顺着 React fiber 向上找 `session` 绑定；
  找不到就**不切换**并提示，绝不用「最近一个会话」兜底。
- service 取用走 `sessionControllerOf(root)`，依次尝试 `reflect.get` / `get` / `ctx.get`，
  任何一步抛错都被吞掉——取不到只影响这条路由，不会拖垮其他功能。

⚠ 这条路由是**宿主侧**改动，必须重启一次 DSH 才生效；前端改动只需刷新页面。
