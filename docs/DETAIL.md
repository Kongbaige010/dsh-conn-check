# 技术细节

**简体中文** · [English](DETAIL_en.md)

> 只想知道怎么用：看 [README.md](../README.md)；只想装：看 [INSTALL.md](../INSTALL.md)。
> 这份写给想搞清楚内部怎么跑、或者要改它的人。

---

## 一、为什么必须有宿主侧

浏览器里直接 `fetch` 第三方 API 会被 **CORS** 拦（只有对方主动放行才通），而且密钥绝不能放在页面里。

所以整条链路是：

```
页面按钮
  → 本插件宿主路由（POST /dsh-conn/test）
    → Node 侧发一次真的 HTTP 请求
      → 结果回给页面（{ok, ms, http, reason}）
```

**密钥只在宿主进程内存里用，永远不下发到页面。** 页面拿到的只有「通没通、花了多久、失败原因」。

### 安全栅栏

路由只放行同时满足以下条件的请求：

- Host 是**回环**地址（127.0.0.1 / localhost）
- Origin **同源**
- 不是 cross-site 请求

目的是防止你浏览别的网页时，那个网页偷偷调用本机路由用你的 key 发请求。

---

## 二、路由接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/dsh-conn/list` | 候选模型清单 + 当前激活项 + profile 位置 |
| POST | `/dsh-conn/select` | `{selected:["provider::model"]}` 保存激活选择 |
| POST | `/dsh-conn/test` | `{id}` 真测一个，返回 `{ok, ms, http, reason}` |
| POST | `/dsh-conn/use` | 把指定会话切到指定模型 |
| GET | `/dsh-conn/ui.js` | 前端脚本（页面注入用） |
| GET | `/dsh-conn/caps` | 能力探测：`{restart, electron, processType}` |
| POST | `/dsh-conn/restart` | 先回 200，再走外部重启流程；拿不到桌面宿主能力时回 503 |

> `/dsh-conn/restart` 早期版本依赖 `app.relaunch()`，**现已彻底弃用** —— 插件跑在
> `ELECTRON_RUN_AS_NODE` 子进程里，拿不到 `app` 对象。为什么、以及现在怎么重启，
> 见 [NOTES.md 第一章](NOTES.md#一重启功能)。

---

## 三、目录结构

```
dsh-conn-check/
├── package.json           # dsh.bundle.patch 指向 cordis.patch.yml
├── cordis.patch.yml       # 挂载声明（insert 本插件）
├── icon.svg               # 插件图标
├── lib/index.js           # 宿主：读配置 / 代发请求 / 路由 / 注入前端脚本
├── assets/
│   ├── conn-check.js      # 前端：找 [role=tablist]，插胶囊行
│   └── header-chips.png   # README 用的界面截图
├── locale/{en,zh}.json    # 插件市场里的名称与描述
├── docs/
│   ├── DETAIL.md          # 本文件（中文）
│   ├── DETAIL_en.md       # 本文件（English）
│   └── NOTES.md           # 已知技术约束
└── tests/
    ├── selftest.mjs       # 配置解析自检
    ├── auto-detect.mjs    # 证明「模型是自动读的，没有硬编码」
    ├── fake-host.mjs      # 模拟 cordis 环境跑插件全流程
    ├── mock-ui.mjs        # 假页面 + 真 Chrome，验证前端交互并出截图
    └── restart-e2e.mjs    # 真实杀进程 + 重启（默认锁定）
```

---

## 四、状态与配置在哪

| 路径 | 内容 |
|---|---|
| `~/.dsh/dsh-conn-check.json` | 激活了哪几个模型。换站 / 删模型后会自动过滤掉不存在的项 |
| `~/.dsh/profiles/<profile>/cordis.patch.yml` | **候选模型的唯一真相源** |
| `~/.dsh/.credentials.yaml` | 密钥来源（`refs.<ENV_NAME>`） |
| `~/.dsh/dsh-conn-restart.log` | 重启脚本的日志，重启失败先看这里 |

---

## 五、模型是怎么被读出来的

启动时解析当前 profile 的 `cordis.patch.yml`：

- `llm-pi-ai.providers` → 每个 provider 的 `displayName`、`baseURL`、`apiKeyEnv` 和它的 `models`
- `agent-default-model` → 当前默认的 `provider` + `model`

再把 `apiKeyEnv` 拿到 `.credentials.yaml` 的 `refs.<ENV_NAME>` 里换成真实密钥。

模型 id 统一用 **`provider::modelId`** 形式。代码里没有任何站点名、模型名或密钥字面量 —— `tests/auto-detect.mjs` 专门验证这一点。

---

## 六、切换会话模型

前端 `→` 按钮 → `POST /dsh-conn/use {sessionId, id}` → `sessionController.selectModel({sessionId, provider, model})`。

三条设计约束：

- **不自造写盘逻辑**：直接调用 DSH 内置的 `sessionController.selectModel`，和内置模型选择器同一个接口。
- **不猜会话**：DSH 不把会话 id 放进 URL / DOM / localStorage，前端只能顺着 React fiber 向上找 `session` 绑定；**找不到就不切换并提示**，绝不用「最近一个会话」兜底。
- **取服务要容错**：走 `sessionControllerOf(root)`，依次尝试 `reflect.get` / `get` / `ctx.get`，任何一步抛错都被吞掉 —— 取不到只影响这条路由，不会拖垮其他功能。

⚠ 这条路由是**宿主侧**改动，改了必须重启一次 DSH 才生效；只改前端的话刷新页面即可。

---

## 七、自检与排障

```powershell
cd ~/.dsh/local-plugins/dsh-conn-check
node tests/selftest.mjs      # 15 PASS   配置解析
node tests/auto-detect.mjs   #  8 PASS   证明自动读配置
node tests/fake-host.mjs     # 94 PASS   宿主全流程（路由 / 鉴权 / 测试 / 切换）
node tests/mock-ui.mjs       # 80 PASS   真 Chrome 跑前端交互并出截图
```

合计 **197 项**。加 `--net` 会真的发一次网络请求。

`tests/restart-e2e.mjs` 会**真的杀进程再重启应用**，锁在环境变量后面，默认不跑：

```powershell
$env:DSH_ALLOW_REAL_RESTART = '1'
node tests/restart-e2e.mjs
```

### 重启后按钮没出现，按顺序查

1. 宿主日志里有没有 `[dsh-conn-check] ready · profile=... · models=N`
2. 浏览器 DevTools Console 有没有 `conn-check.js` 加载错误，以及 `window.__dshccErr`
3. `curl http://127.0.0.1:<端口>/dsh-conn/list` 能否返回 JSON（端口 = 当前 GUI 地址的端口）
4. 页面里有没有 `[role="tablist"]` —— 空白 Hero 页没有，进入任一会话才出现

---

## 八、限制

- 仅支持「OpenAI 兼容」与「Anthropic messages」两种接口形态，其它协议按 OpenAI 形态发。
- 单次探测超时硬上限 **20 秒**。
- 重启按钮**仅 Windows 桌面版**可用；其他平台自动置灰，不会假装成功。
- 切换模型依赖 DSH 内部接口 `sessionController.selectModel`。版本不支持时点 `→` 会明确提示，**不影响连通性测试**。
- 插件只拿你的本地配置去发起测试请求，不上传任何内容到第三方。

---

## 九、卸载

设置 → 插件 → 卸载，然后重启 DSH。

如需彻底清除，可手动删除：

```
~/.dsh/local-plugins/dsh-conn-check
~/.dsh/dsh-conn-check.json
```
