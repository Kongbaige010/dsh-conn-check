# dsh-conn-check [![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

[![npm version](https://img.shields.io/npm/v/dsh-conn-check)](https://www.npmjs.com/package/dsh-conn-check) [![GitHub stars](https://img.shields.io/github/stars/Kongbaige010/dsh-conn-check?style=social)](https://github.com/Kongbaige010/dsh-conn-check)

**简体中文** · [English](README_en.md)

> 在 DSH 会话头部提供模型连通性检测：点击标签即向对应模型发起一次真实请求，连通显示绿色，失败显示红色。

![会话头部的模型连通性标签](assets/header-chips.png)

> 界面截图，模型名称已作脱敏处理。

---

## 功能

| 元素 | 位置 | 作用 |
|---|---|---|
| 模型标签 | 会话头部 `对话 / 轨迹 / 统计` 右侧 | 点击后由宿主发起一次 `max_tokens=1` 请求，返回连通状态；悬停可查看耗时与失败原因 |
| `●` 状态指示 | 标签内左侧 | 灰色表示未检测，蓝色表示检测中，**绿色表示连通**，**红色表示失败** |
| `○` 连续检测 | 标签内右侧 | 仅对当前模型每 3 秒重复检测一次；多个标签可并行运行 |
| `→` 切换按钮 | 标签内右侧 | 将**当前会话**切换至该模型 |
| `⇄` | 标签行末端 | 依次检测所有已启用的模型。采用串行方式，避免触发服务商限流 |
| `F5` | 同上 | 刷新页面 |
| `⚙` | 同上 | 打开设置面板，选择启用哪些模型，选择即时保存 |
| `⟳` | 同上 | 连续点击两次确认后重启应用 |

悬停时可查看完整错误信息（例如 `HTTP 503`），而非笼统的失败提示。

### 重启功能的三重保护

1. 需连续点击两次确认。首次点击进入待确认状态，3 秒后自动取消。
2. 服务端返回 200 后进程退出，前端立即显示重启进度覆盖层；若 20 秒内未完成，将显示超时提示及日志路径。
3. 在无法获取 Electron `app` 对象的环境（Web 模式、无头模式）下按钮置灰，避免出现点击后无响应的情况。

---

## 模型来源

模型与凭据均在运行时自动读取，无需手动配置：

| 内容 | 来源 |
|---|---|
| 候选模型列表 | `~/.dsh/profiles/<profile>/cordis.patch.yml` → `llm-pi-ai.providers` |
| 当前默认模型 | 同上文件 → `agent-default-model` |
| 模型凭据 | `~/.dsh/.credentials.yaml` → `refs.<ENV_NAME>` |

凭据仅在宿主进程内存中使用，不会下发至页面。源码中不含任何服务商名称、模型名称或密钥字面量。

更换服务商或新增模型后，重启一次即可生效，无需修改插件。

---

## 安装

在 DSH 中依次打开 设置 → 插件 → 添加插件，填入包名：

```
dsh-conn-check
```

或使用 npm 直接安装：

```bash
npm install dsh-conn-check
```

安装完成后重启一次 DSH。详细步骤见 [INSTALL.md](INSTALL.md)。

---

## 已知限制

- 仅支持「OpenAI 兼容」与「Anthropic Messages」两种接口形态，其它协议按 OpenAI 形态发送。
- 单次检测超时上限为 **20 秒**。
- 前端依赖 DOM 注入（挂载于 `[role="tablist"]` 右侧）。DSH 前端大幅改版时可能需要调整选择器。
- 检测请求会产生**极少量实际计费**（`max_tokens=1`）。
- 重启功能**仅在 Windows 桌面版可用**，Web 模式与无头模式下按钮自动置灰。

---

## 卸载

```powershell
$dsh = "$env:LOCALAPPDATA\Programs\DeepSeekRuntime\resources\runtime\cli\bin\dsh.cmd"
& $dsh plugin --profile desktop remove dsh-conn-check
```

如需彻底清除，可一并删除插件目录与状态文件：

```
~/.dsh/local-plugins/dsh-conn-check
~/.dsh/dsh-conn-check.json
```

---

## 文档

- [INSTALL.md](INSTALL.md)：安装步骤与界面说明。
- [docs/DETAIL.md](docs/DETAIL.md)：架构说明、接口定义、目录结构、自检与故障排查（[English](docs/DETAIL_en.md)）。
- [docs/NOTES.md](docs/NOTES.md)：实现过程中已确认的技术约束与已知问题。

---

## 许可

MIT
