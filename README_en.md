# dsh-conn-check [![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

[![npm version](https://img.shields.io/npm/v/dsh-conn-check)](https://www.npmjs.com/package/dsh-conn-check) [![GitHub stars](https://img.shields.io/github/stars/Kongbaige010/dsh-conn-check?style=social)](https://github.com/Kongbaige010/dsh-conn-check)

[简体中文](README.md) · **English**

> Model connectivity checks in the DSH session header. Click a chip to send a real request to that model: green means reachable, red means failed.

![Model connectivity chips in the session header](assets/header-chips.png)

> Interface screenshot. Model names have been redacted.

---

## Features

| Element | Location | Description |
|---|---|---|
| Model chip | Right side of the session header, after `对话 / 轨迹 / 统计` | Sends one `max_tokens=1` request from the host process and reports the result. Hover for latency and failure reason |
| `●` status indicator | Left inside the chip | Grey = not tested, blue = testing, **green = reachable**, **red = failed** |
| `○` continuous check | Right inside the chip | Re-tests only this model every 3 seconds. Multiple chips can run in parallel |
| `→` switch button | Right inside the chip | Switches the **current session** to that model |
| `⇄` | End of the chip row | Tests every enabled model in sequence. Serial by design, to avoid provider rate limits |
| `F5` | Same row | Reload the page |
| `⚙` | Same row | Opens the settings panel to choose which models are enabled. Saved immediately |
| `⟳` | Same row | Restarts the application after a two-step confirmation |

Hovering shows the full error message (for example `HTTP 503`) rather than a generic failure notice.

### Three safeguards for restart

1. Requires two consecutive clicks. The first click arms the action and cancels automatically after 3 seconds.
2. The server responds `200` before the process exits, and the UI immediately shows a restart overlay. If the restart has not completed within 20 seconds, a timeout notice with the log path is displayed.
3. Where the Electron `app` object is unavailable (web mode, headless mode), the button is disabled — it cannot appear to accept a click and then never return.

---

## Where models come from

Models and credentials are read at runtime. No manual configuration is required.

| Item | Source |
|---|---|
| Candidate models | `llm-pi-ai.providers` in `~/.dsh/profiles/<profile>/cordis.patch.yml` |
| Current default model | `agent-default-model` in the same file |
| Model credentials | `refs.<ENV_NAME>` in `~/.dsh/.credentials.yaml` |

Credentials stay in host process memory and are never sent to the page. The source contains no provider names, model names, or credential literals.

After changing providers or adding models, restart once. No plugin changes are required.

---

## Installation

In DSH, open Settings → Plugins → Add plugin and enter the package name:

```
dsh-conn-check
```

Or install it with npm:

```bash
npm install dsh-conn-check
```

Restart DSH once after installation. See [INSTALL.md](INSTALL.md) for details.

---

## Known limitations

- Only the OpenAI-compatible and Anthropic Messages API shapes are supported. Other protocols are sent using the OpenAI shape.
- A single check times out after **20 seconds**.
- The frontend relies on DOM injection (mounted to the right of `[role="tablist"]`). A major DSH frontend redesign may require selector changes.
- Check requests incur a **negligible real cost** (`max_tokens=1`).
- Restart is available **only in the Windows desktop app**. In web and headless modes the button is disabled.

---

## Uninstall

```powershell
$dsh = "$env:LOCALAPPDATA\Programs\DeepSeekRuntime\resources\runtime\cli\bin\dsh.cmd"
& $dsh plugin --profile desktop remove dsh-conn-check
```

To remove all traces, delete the plugin directory and the state file as well:

```
~/.dsh/local-plugins/dsh-conn-check
~/.dsh/dsh-conn-check.json
```

---

## Documentation

- [INSTALL.md](INSTALL.md): installation steps and interface overview.
- [docs/DETAIL_en.md](docs/DETAIL_en.md): architecture, routes, directory layout, self-checks, and troubleshooting.
- [docs/NOTES.md](docs/NOTES.md): confirmed technical constraints and known issues.

---

## License

MIT
