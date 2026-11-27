# Technical details

[简体中文](DETAIL.md) · **English**

> Just want to use it: see [README.md](../README.md). Just want to install: see [INSTALL.md](../INSTALL.md).
> This document is for people who want to understand how it works internally, or who intend to change it.

---

## 1. Why a host side is mandatory

Calling a third-party API with `fetch` straight from the browser is blocked by **CORS** — it only passes when the other side opts in — and an API key must never live in the page.

So the whole path is:

```
page button
  → this plugin's host route (POST /dsh-conn/test)
    → Node issues one real HTTP request
      → result returns to the page ({ok, ms, http, reason})
```

**The key is used only inside the host process's memory and never sent down to the page.** The page receives only "reachable or not, how long it took, why it failed".

### Security fence

The route admits only requests that satisfy all of the following at once:

- Host is a **loopback** address (127.0.0.1 / localhost)
- Origin is **same-origin**
- Not a cross-site request

The point is to stop some other web page you happen to have open from quietly calling the local route and spending your key.

---

## 2. Routes

| Method | Path | Description |
|---|---|---|
| GET | `/dsh-conn/list` | Candidate models, the active selection, and the profile location |
| POST | `/dsh-conn/select` | `{selected:["provider::model"]}` persists the active selection |
| POST | `/dsh-conn/test` | `{id}` really tests one, returns `{ok, ms, http, reason}` |
| POST | `/dsh-conn/use` | Switches the given session to the given model |
| GET | `/dsh-conn/ui.js` | Front-end script (for page injection) |
| GET | `/dsh-conn/caps` | Capability probe: `{restart, electron, processType}` |
| POST | `/dsh-conn/restart` | Answers 200 first, then runs the external restart; returns 503 when desktop host capabilities are unavailable |

> `/dsh-conn/restart` relied on `app.relaunch()` in early versions and **that is now fully abandoned** — the plugin runs inside an `ELECTRON_RUN_AS_NODE` child process and has no `app` object. Why, and how restart works now, is in [NOTES.md chapter 1](NOTES.md#一重启功能).

---

## 3. Directory layout

```
dsh-conn-check/
├── package.json           # dsh.bundle.patch points at cordis.patch.yml
├── cordis.patch.yml       # mount declaration (inserts this plugin)
├── icon.svg               # plugin icon
├── lib/index.js           # host: read config / proxy requests / routes / inject front-end script
├── assets/
│   ├── conn-check.js      # front end: find [role=tablist], insert the chip row
│   └── header-chips.png   # interface screenshot used by README
├── locale/{en,zh}.json    # name and description shown in the plugin market
├── docs/
│   ├── DETAIL.md          # this file (Chinese)
│   ├── DETAIL_en.md       # this file (English)
│   └── NOTES.md           # known technical constraints
└── tests/
    ├── selftest.mjs       # config-parsing self-check
    ├── auto-detect.mjs    # proves "models are read automatically, nothing hard-coded"
    ├── fake-host.mjs      # simulates the cordis environment and runs the whole plugin
    ├── mock-ui.mjs        # fake page + real Chrome, verifies the front end and produces screenshots
    └── restart-e2e.mjs    # really kills the process and restarts (locked by default)
```

---

## 4. Where state and configuration live

| Path | Contents |
|---|---|
| `~/.dsh/dsh-conn-check.json` | Which models are active. Entries that no longer exist are filtered out automatically after switching sites or deleting a model |
| `~/.dsh/profiles/<profile>/cordis.patch.yml` | **the single source of truth for candidate models** |
| `~/.dsh/.credentials.yaml` | key source (`refs.<ENV_NAME>`) |
| `~/.dsh/dsh-conn-restart.log` | log from the restart script; look here first when a restart fails |

---

## 5. How models are read

At startup the current profile's `cordis.patch.yml` is parsed:

- `llm-pi-ai.providers` → each provider's `displayName`, `baseURL`, `apiKeyEnv` and its `models`
- `agent-default-model` → the current default `provider` + `model`

Each `apiKeyEnv` is then resolved against `refs.<ENV_NAME>` in `.credentials.yaml` to obtain the real key.

Model ids always take the form **`provider::modelId`**. There is no site name, model name or key literal anywhere in the code — `tests/auto-detect.mjs` exists specifically to verify that.

---

## 6. Switching the session's model

Front-end `→` button → `POST /dsh-conn/use {sessionId, id}` → `sessionController.selectModel({sessionId, provider, model})`.

Three design constraints:

- **No home-grown persistence**: it calls DSH's built-in `sessionController.selectModel`, the same interface the built-in model picker uses.
- **No guessing the session**: DSH does not put the session id in the URL, the DOM or localStorage, so the front end walks up the React fiber to find the `session` binding; **if it cannot find one it does not switch and says so**, rather than falling back to "the most recent session".
- **Service lookup tolerates failure**: it goes through `sessionControllerOf(root)`, trying `reflect.get` / `get` / `ctx.get` in turn and swallowing any throw at each step — failing to get it only affects this one route, never the rest.

⚠ This route is a **host-side** change, so DSH must be restarted once for it to take effect; front-end-only changes just need a page refresh.

---

## 7. Self-checks and troubleshooting

```powershell
cd ~/.dsh/local-plugins/dsh-conn-check
node tests/selftest.mjs      # 15 PASS   config parsing
node tests/auto-detect.mjs   #  8 PASS   proves config is read automatically
node tests/fake-host.mjs     # 94 PASS   full host flow (routes / auth / test / switch)
node tests/mock-ui.mjs       # 80 PASS   real Chrome drives the front end and produces screenshots
```

**197 checks** in total. Adding `--net` makes a real network request.

`tests/restart-e2e.mjs` **really kills the process and restarts the app**; it sits behind an environment variable and does not run by default:

```powershell
$env:DSH_ALLOW_REAL_RESTART = '1'
node tests/restart-e2e.mjs
```

### Buttons missing after a restart? Check in this order

1. Is there a `[dsh-conn-check] ready · profile=... · models=N` line in the host log
2. Any `conn-check.js` load error, and `window.__dshccErr`, in the browser DevTools console
3. Does `curl http://127.0.0.1:<port>/dsh-conn/list` return JSON (port = the port in the current GUI address)
4. Is there a `[role="tablist"]` in the page — a blank Hero page has none; open any session and it appears

---

## 8. Limitations

- Only the "OpenAI-compatible" and "Anthropic messages" shapes are supported; other protocols are sent in the OpenAI shape.
- The per-probe timeout has a hard cap of **20 seconds**.
- The restart button works on the **Windows desktop build only**; elsewhere it is greyed out rather than pretending to succeed.
- Switching models depends on the internal DSH interface `sessionController.selectModel`. When a version does not support it, clicking `→` says so clearly, and **connectivity testing is unaffected**.
- The plugin only uses your local configuration to issue test requests; it uploads nothing to any third party.

---

## 9. Uninstall

Settings → Plugins → Uninstall, then restart DSH.

To remove everything, delete these manually:

```
~/.dsh/local-plugins/dsh-conn-check
~/.dsh/dsh-conn-check.json
```
