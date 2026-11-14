# dsh-conn-check

> DSH 会话头部的一排模型连通性胶囊：**点一下真发一次请求**，通=绿、不通=红。

![会话头部的模型连通性胶囊](assets/header-chips.png)

> 真实界面截图，模型名已脱敏。

---

## 它做什么

| 元素 | 位置 | 作用 |
|---|---|---|
| 模型胶囊 | 会话头部 `对话 / 轨迹 / 统计` 右侧 | 点一下 → 宿主代发一次 `max_tokens=1` 请求 → 绿 / 红；悬停看耗时与失败原因 |
| `●` 状态点 | 胶囊内最左 | 灰=没测过，蓝=测试中，**绿=通**，**红=不通** |
| `○` 连续测试小点 | 胶囊内右侧 | 只让**这一个**模型每 3 秒重测一次；多个胶囊可同时各跑各的 |
| `→` 箭头 | 胶囊最右 | 把**当前会话**切到该模型 |
| `⇄` | 胶囊行右端 | 把激活的模型挨个测一遍（串行，避免打爆中转站） |
| `F5` | 同上 | 刷新页面 |
| `⚙` | 同上 | 浮层里勾选「激活哪几个」，勾选即时保存 |
| `⟳` | 同上 | **连点两次**确认后重启整个应用 |

失败悬停能看到 `HTTP 503：...` 这类**原文**，不是一句笼统的「失败」。

### 重启按钮的三重保险

① 要连点两次（第一次只是「上膛」，3 秒后自动取消）；
② 服务端先返回 200 再退出，前端立刻盖一层「正在重启」遮罩，20 秒没成功会把真相和日志路径摆出来；
③ **拿不到 Electron app 时按钮直接置灰**（web / headless 模式），绝不「点了就消失又不回来」。

---

## 模型从哪来

自动读取，**不需要任何配置**：

| 内容 | 来源 |
|---|---|
| 候选模型 | `~/.dsh/profiles/<profile>/cordis.patch.yml` 里的 `llm-pi-ai.providers` |
| 当前默认模型 | 同上，`agent-default-model` |
| 密钥 | `~/.dsh/.credentials.yaml`（`refs.<ENV_NAME>`） |

密钥**只在宿主进程内存里用，不下发到页面**。代码里没有任何站点名、模型名或密钥字面量。

换站、加模型之后重启一次，胶囊会自动跟着变，不用改插件。

---

## 怎么装

见 [INSTALL.md](INSTALL.md)。概括是三步：

```
放好目录 → 设置 → 插件 → 添加插件 → 重启一次 DSH
```

---

## 已知边界

- 只认「OpenAI 兼容」与「Anthropic messages」两种接口形态；其它协议按 OpenAI 形态发。
- 单次探测超时硬上限 **20 秒**。
- 前端靠 DOM 注入（`[role="tablist"]` 右边），DSH 前端大改版时可能需要调整选择器。
- 探测请求会真实计费**极小额度**（`max_tokens=1`）。
- 重启按钮**只在 Windows 桌面版**可用；web / headless 模式下自动置灰。

---

## 卸载

```powershell
$dsh = "$env:LOCALAPPDATA\Programs\DeepSeekRuntime\resources\runtime\cli\bin\dsh.cmd"
& $dsh plugin --profile desktop remove dsh-conn-check
```

再删掉目录与状态文件即可完全清净：

```
~/.dsh/local-plugins/dsh-conn-check
~/.dsh/dsh-conn-check.json
```

---

## 文档

| 文件 | 读者 | 内容 |
|---|---|---|
| [INSTALL.md](INSTALL.md) | 要装的人 | 逐步安装过程、装完长什么样 |
| [docs/DETAIL.md](docs/DETAIL.md) | 想深入的人 | 宿主侧为什么必需、路由接口、目录结构、自检与排障 |
| [docs/NOTES.md](docs/NOTES.md) | 维护者 | 踩过的坑，**改代码前必读** |

---

## 许可

MIT
