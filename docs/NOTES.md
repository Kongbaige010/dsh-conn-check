# 踩过的坑

> 开发笔记。记录**为什么某些写法不能改**，动代码前先读这份。
> 只是安装使用：看 [INSTALL.md](../INSTALL.md)；功能说明：看 [README.md](../README.md)。

这些坑按主题归组，不按踩到的先后顺序。每条给「现象 → 真因 → 现在的做法」，试错过程已压缩成结论。

---

## 一、重启功能

整个项目最深的坑都在这，前前后后推翻了三次结论。

### 1.1 真正的根因：`ELECTRON_RUN_AS_NODE` 环境变量

**现象**：插件里怎么改都重启不起来（进程 exit=0、无窗口、无报错），但用户双击图标、双击桌面 `.cmd` 都正常。

**真因**：DSH 的 host 进程是这样跑的：

```
DeepSeekRuntime.exe --expose-internals .../dsh-desktop-host/lib/index.js ...
```

它处在 **`ELECTRON_RUN_AS_NODE` 模式**下。插件就跑在这个进程里，所以它 spawn 出去的 PowerShell 脚本**继承了 `ELECTRON_RUN_AS_NODE=1`**。脚本再启动 `DeepSeekRuntime.exe` 时，这个 exe 被当成 **Node 脚本**执行 → 没窗口、无输出、`exit code 0`。

**验证实验**：

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
$p = Start-Process -FilePath $exe -PassThru
# -> HasExited=True, ExitCode=0
```

**为什么手动双击能用**：它由 `explorer.exe` 派生，explorer 的环境里没有这个变量。这就是「桌面 cmd 能用、插件里怎么改都不行」的答案。

**修复**：重启脚本开头必须清掉它。

```powershell
Remove-Item Env:\ELECTRON_RUN_AS_NODE      -ErrorAction SilentlyContinue
Remove-Item Env:\ELECTRON_NO_ATTACH_CONSOLE -ErrorAction SilentlyContinue
```

修复后实测 1 秒内新实例就起来了。

### 1.2 宿主拿不到 Electron `app`

进程树：

```
11816  DeepSeekRuntime.exe                        ← Electron 主进程
  └ 13264  DeepSeekRuntime.exe --expose-internals ← dsh-desktop-host（插件跑在这）
```

宿主是主进程 fork 出的 `ELECTRON_RUN_AS_NODE` 子进程，`process.type === null`，`require('electron')` 拿不到 `app`。

**所以 `app.relaunch()` 这条路根本不通**，DSH 也没有对外暴露「重启」能力，只能从外部把进程拉起来。

第一版按 `app.relaunch()` 写，结果 `/caps` 探测到「不支持」→ 按钮被置灰 → 用户根本看不到按钮。

### 1.3 单实例锁 + 残留子进程

**现象**：点重启 → 窗口关了 → 再也没起来。日志里只有一句假的 `relaunched OK`。

**两层原因**：

1. **DSH 有单实例锁**。已有实例时，新实例启动会立刻 `exit(0)` 把焦点交给老实例。
2. **只杀主进程不够**。`Stop-Process -Id <mainPid>` 只死主进程，残留的 renderer / GPU / host 子进程仍占着锁句柄 → 新实例判定「已有实例」→ `exit(0)` → 残留进程随后也死 → **什么都不剩**。

关键实测对比：

| | 失败那次 | 成功那次 |
|---|---|---|
| 杀掉进程数 | `killed=2` | `killed=6` |
| explorer 后等候 | 30s 仍 `instances=0` | **1s 就 `instances=5`** |

**只杀 2 个就以为清完了，其实还有残留占着锁。**

### 1.4 两段式重启：脚本 A 只拉人，脚本 B 去杀人

难点：终结者要杀「整棵进程树」，但它若是 DSH 的子孙进程，自己也会被连坐。

```
宿主（DSH 子进程）
  └─ detach 启动 脚本A            ← 仍是 DSH 的孙进程
       └─ WMI Win32_Process.Create → 脚本B   ← 父进程变成 WmiPrvSE，脱离进程树
            └─ 杀所有同名进程 → 等锁释放 → 拉起 → 验证存活
```

- **脚本 A** 只做两件事：把脚本 B 写到临时目录（base64 传递，避开转义地狱），用 `Invoke-CimMethod ... Win32_Process Create` 拉起它，**自己立刻退出**。
- **脚本 B** 反复扫同名进程直到清空（日志记 `killed=N remaining=0`），等 3 秒让锁彻底释放，再启动，最后验证存活。

`tests/restart-e2e.mjs` 用替身进程验证这条链路，断言终结者父进程确实是 `WmiPrvSE`（证明已脱离进程树）。

> 这条测试会真的杀进程，锁在 `DSH_ALLOW_REAL_RESTART=1` 后面，默认不跑。

### 1.5 启动方式：别再直接 `Start-Process` 那个 exe

清到 `remaining=0` 之后，新实例**仍然**可能 `exit=0`。

| 启动方式 | 父进程 | 结果 |
|---|---|---|
| `Start-Process -FilePath <exe>`（从 WMI / powershell 里） | powershell.exe | 常 `exit=0`，窗口不出现 |
| 用户双击图标 | **explorer.exe** | 正常启动 |

不是单例锁、不是 Session 隔离（两边都是 SessionId=1）。

**现在的做法**：用 `Start-Process -FilePath "explorer.exe" -ArgumentList '"<exe>"'`，等价于复刻一次双击，由 ShellExecute 在用户会话里拉起。

**验收方式也改了**：不看 `HasExited`，直接**数同名进程个数**（`instances=N`），`N>0` 才算成功，否则退回 `Start-Process` 再试一次。

### 1.6 验收别用固定延时

explorer 启动方式对了，但验收写死 6 秒 —— 这个 exe 有 **246 MB**，冷启动远超 6 秒。

日志里出现过：

```
17:42:18  explorer launch done, instances=0     ← 6 秒没数到，误判失败
17:42:18  explorer failed, trying Start-Process ← 于是又拉一次
17:42:24  RELAUNCH DIED, no instance alive
17:42:59  新实例出现（父进程 explorer）          ← 其实它起来了！
```

两个后果：误报失败 + 重复拉起两个实例打架。用户看到的就是「一直在转」。

**修法**：改成轮询 —— 每秒数一次，explorer 路径最多等 **30 秒**，确实 0 个时才退回 `Start-Process` 再等 20 秒。一旦数到就收工。

### 1.7 前端遮罩必须有超时兜底

旧版只会一直转圈，重启没成功时用户只能强杀窗口。

现在 20 秒后自动把真相摆出来：停止转圈、改文案为「重启似乎没有完成（已等 N 秒）」、给手动重启指引与日志路径、并提供关闭按钮。

### 1.8 `Start-Process` 不报错 ≠ 启动成功

旧写法 `Start-Process -FilePath $exe | Out-Null; 写一条成功日志` —— 只要没抛异常就记成功，事实上窗口根本没起来。

现在必须 `-PassThru` + 复查存活，失败记 `RELAUNCH DIED, exit=N`。

### 1.9 已推翻的旧结论（反面记录）

下面两条曾被当成真因，后来证实都不是。留着是为了避免再走一遍：

| 旧结论 | 为什么是错的 |
|---|---|
| `lockfile` 残留封住了启动 | `lockfile` 是**进程持有**的，进程死就消失（日志里明确写过 `no lockfile present`），它不是封锁文件 |
| `explorer.exe "<exe>"` 能启动程序 | 反了。用户双击时父进程**是** explorer，但那是 ShellExecute 的**结果**。从脚本里直接 `explorer.exe "path"` 只会打开文件夹或转给已有 explorer，不启动程序 |

> 教训：**「父进程是谁」不能反推「该用谁去启动」**。

### 1.10 `.cmd` 脚本的两个致命 bug

写 Windows 批处理时必看：

1. **必须 CRLF 换行**。用 LF 写的 `.cmd` 在 `cmd.exe` 里会被当成一行，整份脚本等于没写。
2. **路径里的 `\` 会被原样写进去**。Python 字符串里写 `\\` 得到两个反斜杠 → cmd 找不到文件 → `start` 静默失败。用 raw string 或列表拼接。

**铁律**：交付任何 `.cmd` / `.ps1` 之前，先把动作命令换成 `echo` 空跑一遍演练。

---

## 二、按钮挂在哪

### 2.1 账号区布局碰不得

在账号区内部做布局，踩了三次：

| 尝试 | 结果 |
|---|---|
| `margin-left:auto` 挤进 settingsArea | 账号 trigger 是 `width:100%` 带背景的整行按钮，把按钮整块盖住 |
| 给容器 `flex` + 强制账号按钮收窄 | 真实 DOM 里账号元素不一定是 `<button>`，选择器落空 |
| 绝对定位 + 抬 `z-index` | 同一层叠上下文里它排在后面就压住我们 |

**现在的做法**：按钮 `appendChild` 到 `document.body`，`position:fixed` + 极高 `z-index`，坐标由 JS 算。它根本不在那个 DOM 层级里，不可能被盖。

### 2.2 `querySelector` 只取第一个命中

页面上往往有多份 `settingsArea`（响应式隐藏容器、切换态残留）。如果第一个是 `0×0` 的隐藏副本，按钮会被设成 `visibility:hidden` 且永不恢复 —— 这是「按钮根本没出现」最隐蔽的原因。

**现在**：`querySelectorAll` 遍历，只接受尺寸 > 8px 且在视口内的那个。

### 2.3 挂上去 ≠ 看得见

400ms 后用 `elementFromPoint` 验证「中心点最顶层是不是自己」，三级降级：

1. 不可见 / 被遮挡 → 钉在左下角
2. 还不行 → 挪进顶部胶囊行（那里必定可见）
3. 都不行 → 胶囊行里弹红色小标签，点一下复制诊断 JSON

测试里用 `elementFromPoint` 断言防回归。

### 2.4 不写 `[class*=…]` 全局选择器

CSS Modules 的类名前缀会随构建变。宿主容器由 JS 打 `.dshcc-host` 标记，CSS 只作用于标记过的容器，**绝不改 DSH 自己的布局**。

---

## 三、前端交互

### 3.1 浮层点外面关不掉 —— 冒泡阶段的 document 监听收不到

DSH 的 React 组件普遍 `e.stopPropagation()`，挂在 `document` **冒泡阶段**的 click 监听被拦死，浮层弹出来就关不掉。

**现在**：`addEventListener(..., true)` 用**捕获阶段**，早于一切冒泡处理；另加 `Esc` 关闭、窗口 blur 关闭。测试专门造了一个会 `stopPropagation` 的元素来复现。

### 3.2 `try/catch` 静默吞异常，一个笔误带崩整个挂载

确认对话框的 CSS 用了一个没定义的变量，`mountRestartBtn()` 抛异常 → 被 `try/catch` 吞掉 → **按钮根本没挂上**，而外界只看到「没有按钮」，毫无线索。

**教训**：`try/catch` 里不要静默丢弃异常，至少存到 `window.__dshccErr`。现在测试直接读这个字段定位。

### 3.3 写死深色配色，在浅色主题下变成一块纯黑

按钮配色一律取 DSH 主题变量，带浅色兜底：

`--dsw-alias-border-l2` / `bg-layer-1` / `label-primary/secondary/tertiary` /
`interactive-bg-hover` / `state-success-primary` / `state-error-primary` /
`state-warn-primary` / `state-business-primary`

---

## 四、能力探测与降级

### 4.1 探测失败 ≠ 不支持

`/caps` 探测不到（旧宿主没这接口、网络抖动）时按「**未知**」处理，按钮保持可点；只有宿主明确回 `restart:false` 且带 `exe` 字段时才标成不可用。

反面教材：第一版把「探测失败」当成「不支持」，结果按钮直接被置灰藏起来，用户连点都点不到。

### 4.2 别猜会话

DSH 不把会话 id 放进 URL / DOM / localStorage，前端只能顺着 React fiber 向上找 `session` 绑定；**找不到就不切换并提示**，绝不用「最近一个会话」兜底 —— 那会切错会话。

---
