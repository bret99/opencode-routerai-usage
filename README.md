<div align="center">

# 💳 routerai-usage

**Live RouterAI balance and token usage widget for the OpenCode v2 terminal UI.**

[![OpenCode v2](https://img.shields.io/badge/OpenCode-v2.x-1f6feb.svg)](https://opencode.ai/docs/build/plugins/cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-SolidJS-3178c6.svg)](https://www.typescriptlang.org/)
[![Platform](https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20WSL-lightgrey.svg)](#-requirements)

`routerai ⇡ 162 ⇣ 23 ⇄ 5.6k · ctx 1% · ₽ 563.04 · −0.0065`

</div>

---

`routerai-usage` is a small TUI-only plugin for **OpenCode v2**. It puts a live
status line into the composer footer so you can see, without leaving the
terminal, how much the current session is costing and how much credit is left
on your RouterAI account.

- `routerai` — the provider whose balance is displayed
- `⇡` — uncached input tokens of the session
- `⇣` — output tokens (including reasoning)
- `⇄` — cache reads (hidden when zero)
- `ctx` — context window fill based on the last assistant message
- `₽` — balance from `GET /api/v1/credits` (green; red on error)
- `−` — how much this session has spent, derived from balance deltas

Because RouterAI reports exact request costs, the plugin can show real money
spent instead of an estimate — see [How it works](#-how-it-works).

---

## ✨ Features

- **Live balance** polled from the RouterAI `credits` endpoint, fast while a
  session is running, slow when idle.
- **Real spend**, not a guess: charges are measured as balance deltas and
  attributed to the session that was actually executing.
- **Token breakdown** per session: input, output, reasoning, cache read and
  cache write.
- **Context gauge** with colour thresholds at 60 % and 85 % of the model's
  context window.
- **Details dialog** at `/balance` with monthly and lifetime usage from
  `/api/v1/key`.
- **Zero configuration** for the common case: the plugin finds the provider and
  API key in your existing `opencode.jsonc`.
- **TUI-only**, so it keeps working when the client is connected to a remote
  OpenCode server.
- **Graceful failure**: a missing key or a network error becomes a red label in
  the footer, never a broken TUI.

---

## 📋 Requirements

| Requirement | Notes |
| :--- | :--- |
| [OpenCode v2](https://opencode.ai/docs/) | `opencode --version` must report `2.x` |
| [RouterAI](https://routerai.ru/) account | Any provider whose `baseURL` points at `routerai.ru` works too |
| RouterAI API key | Via `ROUTERAI_API_KEY` or the provider config |
| Terminal with Unicode | For `⇡ ⇣ ⇄ ₽` glyphs (any modern terminal works) |

No build step and no npm install are required: OpenCode reads the `.tsx`
entrypoint directly and provides `@opencode/plugin/tui`, `solid-js` and the
OpenTUI runtime itself.

---

## 🚀 Quick Start

### 1. Install the plugin

```bash
git clone https://github.com/bret99/opencode-routerai-usage.git \
  ~/.config/opencode/plugins/routerai-usage
```

If you use `XDG_CONFIG_HOME`, the target is
`$XDG_CONFIG_HOME/opencode/plugins/routerai-usage` instead.

Verify the layout:

```bash
ls ~/.config/opencode/plugins/routerai-usage
# README.md  tui.tsx
```

### 2. Register it as a TUI plugin

Create or extend `~/.config/opencode/cli.json`:

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["./plugins/routerai-usage"]
}
```

> **Why `cli.json` and not `opencode.jsonc`?**
> This plugin only touches the terminal UI. TUI plugins are configured in
> `cli.json` so they stay active even when the CLI is attached to a remote
> OpenCode server.

### 3. Add the RouterAI provider

In `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model": "routerai/deepseek/deepseek-v4.1-flash-1017",
  "providers": {
    "routerai": {
      "name": "RouterAI",
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": {
        "baseURL": "https://routerai.ru/api/v1",
        "apiKey": "{env:ROUTERAI_API_KEY}"
      },
      "models": {
        "deepseek/deepseek-v4.1-flash-1017": {
          "name": "DeepSeek V4.1 Flash 1017",
          "capabilities": {
            "tools": true,
            "input": ["text", "image"],
            "output": ["text"]
          },
          "limit": {
            "context": 1048576
          }
        }
      }
    }
  }
}
```

### 4. Export your API key

```bash
echo 'export ROUTERAI_API_KEY="sk-..."' >> ~/.bashrc   # or ~/.zshrc
source ~/.bashrc
```

The plugin resolves credentials in this order:

1. the `ROUTERAI_API_KEY` environment variable;
2. the `routerai` provider in `opencode.jsonc` — or any provider whose
   `baseURL` matches `routerai.(ru|com)` — reading `settings.apiKey` or
   `options.apiKey`.

Keeping the key in the environment is the recommended setup: the plugin reads
provider settings through the API, so an unexpanded `{env:...}` placeholder can
come back literally and produce a `401`.

### 5. Restart the TUI

```bash
opencode --version   # 2.x
opencode
```

The first load of a brand-new plugin needs a fresh TUI process. Afterwards,
config edits are picked up with `/reload`.

---

## 🛠️ Usage

| Action | Result |
| :--- | :--- |
| *(automatic)* | Footer line with balance, tokens and spend |
| `/balance` (aliases `/routerai`, `/credits`) | Details dialog |
| `ctrl+p` → **RouterAI: refresh balance** | Forced refresh plus a toast |
| Send a prompt | Token counters and `−₽` update after the turn |

The details dialog shows the API origin, current balance, monthly and lifetime
usage from `/api/v1/key`, the last observed charge, spend for this session and
since the TUI started, plus the full token breakdown and the context gauge.

---

## ⚙️ Configuration

All options are optional and live in the object form of the plugin entry:

```json
{
  "plugins": [
    {
      "package": "./plugins/routerai-usage",
      "options": {
        "placement": "app",
        "pollMs": 5000,
        "pollIdleMs": 60000,
        "showSpend": true,
        "showContext": true,
        "sidebar": false
      }
    }
  ]
}
```

| Option | Default | Description |
| :--- | :--- | :--- |
| `placement` | `"footer"` | `"footer"` appends to the composer footer; `"app"` renders a separate line under the composer |
| `pollMs` | `5000` | Balance polling period while a session is executing |
| `pollIdleMs` | `60000` | Balance polling period while idle |
| `showSpend` | `true` | Show `−₽` spend for the current session |
| `showContext` | `true` | Show the `ctx` percentage |
| `sidebar` | `false` | Duplicate the line in the sidebar |

The balance is also refreshed right after a turn finishes
(`session.execution.succeeded` / `failed`, `session.usage.updated`) with a
1.2–2.5 s delay, because RouterAI settles the charge a moment after the
response.

---

## 🔍 How it works

RouterAI returns the exact request cost in `usage.cost` of
`/chat/completions`, and in `data.total_cost` of
`GET /api/v1/generation?id=…` (the id comes from the `X-Generation-Id`
response header). Charges match the balance down to the last digit.

OpenCode does not persist those values. With no `cost` configured for the
model, `session.cost` and `message.cost` are always `0`, and
`session.usage.updated` carries tokens only. So the plugin measures **actual
charges as balance deltas**:

1. Poll `GET /api/v1/credits`.
2. When the balance drops, add the delta to the session that was running.
3. If no session is running, attribute the delta to the last active session
   for a 20 s grace window — RouterAI bills slightly after the response.

Data sources:

| Endpoint | Used for |
| :--- | :--- |
| `GET /api/v1/credits` | Current balance, spend deltas |
| `GET /api/v1/key` | Monthly and lifetime usage, key name |
| `session` / `message` data | Tokens per category, model context limit |

Side effect worth knowing: charges made from *other* clients (the RouterAI web
chat, another terminal) are included in "since the last poll" but never
attributed to a session unless one was executing at that moment.

---

## 🧩 Project layout

```text
opencode-routerai-usage/
├── README.md                # this file
├── LICENSE                  # MIT
├── tui.tsx                  # the whole plugin
├── cli.example.json         # cli.json snippet that registers the plugin
├── opencode.example.jsonc   # RouterAI provider snippet
└── .gitignore
```

The plugin is a single file exporting `Plugin.define({ id: "routerai.usage" })`
with a `setup()` that returns a cleanup function. It registers:

- `context.ui.slot()` contributions for `prompt.footer.status`, `app` and
  optionally `sidebar.content`;
- `context.keymap.layer()` commands for the palette and slash commands;
- `context.data.on()` subscriptions for session lifecycle events;
- one polling timer that is cleared on dispose.

---

## 🩺 Troubleshooting

**No line in the footer**

- Check that `cli.json` lists the plugin and the path is relative to the config
  directory.
- Inspect the log:

  ```bash
  grep "plugin operation failed" ~/.local/share/opencode/log/opencode.log | tail -5
  ```

  `stage=read` means a syntax or import problem; `stage=setup` means a runtime
  error inside `setup()`.

**`API key not found` or `unauthorized (401)`**

- `echo $ROUTERAI_API_KEY` must be non-empty in the terminal that launched
  OpenCode.
- A key belonging to another account will be rejected.

**Balance does not move**

- Idle polling is once a minute by default. Force a refresh with `ctrl+p` →
  *RouterAI: refresh balance*.
- If the provider was added after the TUI started, press `/reload`.

**Footer line looks garbled**

- Use `"placement": "app"` to render the line below the composer instead of
  inside the footer, where other status items compete for width.

**After editing `tui.tsx`**

```bash
/reload              # inside the TUI
opencode service restart   # if the change is not picked up
```

---

## 🤝 Contributing

Issues and pull requests are welcome. Please keep the plugin dependency-free
(only OpenCode-provided imports), and test the change in a real TUI session
before opening a PR.

```bash
git clone https://github.com/bret99/opencode-routerai-usage.git
cd opencode-routerai-usage
# symlink into your config for live reload while developing
ln -s "$PWD" ~/.config/opencode/plugins/routerai-usage
```

---

## 💎 Support the Project

If this tool saves you money or time, you can support further development.

### Crypto Wallets

| Asset | Network | Address |
| :--- | :--- | :--- |
| **BTC** | Bitcoin | `bc1qjwl80sv06xj2yhumn6k6xemchryem923wwts5x` |
| **USDT / ETH** | Ethereum (ERC20) | `0xc01b996c7b08ccfad463f27e54f1e74e6ac6f9ff` |
| **USDT / SOL** | Solana | `D7a5CdLaDwkKehnH82y6VJEF3hADWuupuhWCXecHvEnt` |
| **TON** | TON Network | `UQBhPLwdFiJdh6sZ96sZfxrxD9Lu6NFtaUecWeoHSM-EPc0P` |
| **LTC** | Litecoin | `ltc1qkm58ks5kuc64rjwd74sfalc5xsn7h6sr4vt45w` |
| **SOL** | Solana | `D7a5CdLaDwkKehnH82y6VJEF3hADWuupuhWCXecHvEnt` |

---

## 📜 License

This project is licensed under the MIT License — see the
[LICENSE](LICENSE) file for details.

---

<div align="center">

Made for the [OpenCode](https://opencode.ai) terminal and
[RouterAI](https://routerai.ru) users.

</div>
