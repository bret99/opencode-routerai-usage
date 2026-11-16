import { Plugin } from "@opencode/plugin/tui"
import { For, Show, createSignal } from "solid-js"

/**
 * RouterAI usage / balance widget for OpenCode v2.
 *
 * Live footer line:
 *   routerai · ⇡ 43.7k ⇣ 618k ⇄ 529.8M · ctx 26% · ₽ 574.25 · −0.42
 *
 * Balance comes from GET /api/v1/credits, spend is derived from balance
 * deltas and attributed to the running session.
 */

const CREDITS_PATH = "/credits"
const KEY_PATH = "/key"

// RouterAI settles a request a moment after the response, often once the
// session already went idle, so the last active session keeps a grace window.
const GRACE_MS = 20_000

type Usage = {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

type KeyInfo = {
  usage?: number
  usage_monthly?: number
  limit?: number
  name?: string
}

function emptyUsage(): Usage {
  return { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
}

function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0"
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`
}

function formatMoney(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "—"
  const abs = Math.abs(n)
  if (abs >= 100) return n.toFixed(2)
  if (abs >= 1) return n.toFixed(2)
  if (abs >= 0.01) return n.toFixed(3)
  return n.toFixed(4)
}

function usageTotal(usage: Usage): number {
  return usage.input + usage.output + usage.reasoning + usage.cache.read + usage.cache.write
}

function readRouteraiConfig(entries: unknown[]): { apiKey?: string; baseURL?: string } {
  for (const entry of entries ?? []) {
    const info = (entry as any)?.info
    if (!info || typeof info !== "object") continue
    const groups = [info.provider, info.providers]
    for (const group of groups) {
      if (!group || typeof group !== "object") continue
      for (const [id, value] of Object.entries(group as Record<string, any>)) {
        const settings = { ...(value?.options ?? {}), ...(value?.settings ?? {}) }
        const baseURL = typeof settings.baseURL === "string" ? settings.baseURL : undefined
        const looksRouterai = id === "routerai" || (baseURL ? /routerai\.(ru|com)/i.test(baseURL) : false)
        if (!looksRouterai) continue
        const apiKey = typeof settings.apiKey === "string" && settings.apiKey.trim() ? settings.apiKey.trim() : undefined
        return { apiKey, baseURL: baseURL ?? "https://routerai.ru/api/v1" }
      }
    }
  }
  return {}
}

function originOf(baseURL: string | undefined): string {
  const fallback = "https://routerai.ru"
  if (!baseURL) return fallback
  try {
    return new URL(baseURL).origin
  } catch {
    return fallback
  }
}

export default Plugin.define({
  id: "routerai.usage",
  async setup(context) {
    const options = context.options ?? {}
    const pollActive = typeof options.pollMs === "number" && options.pollMs > 0 ? options.pollMs : 5_000
    const pollIdle = typeof options.pollIdleMs === "number" && options.pollIdleMs > 0 ? options.pollIdleMs : 60_000
    const showSpend = options.showSpend !== false
    const showContext = options.showContext !== false
    // "footer" (default) appends to the composer footer, "app" adds a status
    // line under the composer.
    const placement: "footer" | "app" = options.placement === "app" ? "app" : "footer"

    const theme = context.theme
    const colorText = () => theme.text.base
    const colorMuted = () => theme.text.muted
    const colorError = () => theme.text.feedback.error.base
    const colorWarning = () => theme.text.feedback.warning.base
    const colorSuccess = () => theme.text.feedback.success.base
    const colorPrimary = () => theme.text.action.primary.base

    // ---------------------------------------------------------------- config

    let baseURL = "https://routerai.ru"
    let apiKey: string | undefined = process.env.ROUTERAI_API_KEY?.trim() || undefined

    const loadCredentials = async () => {
      if (apiKey && baseURL) return
      try {
        const entries = await context.client.config.get()
        const found = readRouteraiConfig(entries as unknown[])
        if (found.apiKey) apiKey = found.apiKey
        baseURL = originOf(found.baseURL) ?? baseURL
      } catch {
        // keep whatever we already have
      }    }
    await loadCredentials()

    // ----------------------------------------------------------------- state

    const [balance, setBalance] = createSignal<number | undefined>(undefined)
    const [creditsError, setCreditsError] = createSignal<string | undefined>(undefined)
    const [updatedAt, setUpdatedAt] = createSignal<number | undefined>(undefined)
    const [keyInfo, setKeyInfo] = createSignal<KeyInfo | undefined>(undefined)
    const [spent, setSpent] = createSignal(0)
    const [lastCharge, setLastCharge] = createSignal<number | undefined>(undefined)

    const sessionSpend = new Map<string, number>()
    const [sessionSpendTick, setSessionSpendTick] = createSignal(0)
    const bumpSessionSpend = () => setSessionSpendTick((n) => n + 1)

    // Which session is currently burning credits. Balance deltas are attached to it.
    let recentSession: { id: string; at: number } | undefined

    const currentSessionID = (): string | undefined => {
      const route = context.ui.router.current()
      return route?.type === "session" ? route.sessionID : undefined
    }

    const runningSession = (): string | undefined => {
      const current = currentSessionID()
      if (current && context.data.session.status(current) === "running") return current
      return undefined
    }

    // Balance deltas can only be attributed when a single session is spending.
    const soleRunningSession = (): string | undefined => {
      const running = (context.data.session.list() ?? []).filter((s) => context.data.session.status(s.id) === "running")
      if (running.length === 1) return running[0].id
      return undefined
    }

    // RouterAI bills shortly after the response, often when the session already
    // went idle, so the last active session keeps a short grace window.
    const noteActive = (id: unknown) => {
      if (typeof id === "string") recentSession = { id, at: Date.now() }
    }

    const attributableSession = (): string | undefined => {
      const running = runningSession()
      if (running) return running
      const sole = soleRunningSession()
      if (sole) return sole
      if (recentSession && Date.now() - recentSession.at < GRACE_MS) return recentSession.id
      return undefined
    }

    // ---------------------------------------------------------------- fetch

    let inFlight = false
    let lastBalance: number | undefined

    const refresh = async (options?: { force?: boolean }) => {
      if (inFlight && !options?.force) return
      if (!apiKey) {
        await loadCredentials()
        if (!apiKey) {
          setCreditsError("API key not found")
          return
        }
      }
      inFlight = true
      try {
        const response = await fetch(`${baseURL}/api/v1${CREDITS_PATH}`, {
          headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        })
        if (!response.ok) {
          setCreditsError(response.status === 401 ? "unauthorized (401)" : `HTTP ${response.status}`)
          return
        }
        const payload = (await response.json()) as { data?: { credits?: number } }
        const credits = payload?.data?.credits
        if (typeof credits !== "number" || !Number.isFinite(credits)) {
          setCreditsError("bad response")
          return
        }

        const previous = lastBalance
        if (previous !== undefined) {
          const delta = previous - credits
          if (delta > 0) {
            setSpent((value) => value + delta)
            setLastCharge(delta)
            const target = attributableSession()
            if (target) sessionSpend.set(target, (sessionSpend.get(target) ?? 0) + delta)
            bumpSessionSpend()
          }
        }

        lastBalance = credits
        setBalance(credits)
        setCreditsError(undefined)
        setUpdatedAt(Date.now())
      } catch (error) {
        setCreditsError(error instanceof Error ? error.message : String(error))
      } finally {
        inFlight = false
      }
    }

    const refreshKey = async () => {
      if (!apiKey) return
      try {
        const response = await fetch(`${baseURL}/api/v1${KEY_PATH}`, {
          headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        })
        if (!response.ok) return
        const payload = (await response.json()) as { data?: Record<string, unknown> }
        const data = payload?.data ?? {}
        setKeyInfo({
          usage: typeof data.usage === "number" ? data.usage : undefined,
          usage_monthly: typeof data.usage_monthly === "number" ? data.usage_monthly : undefined,
          limit: typeof data.limit === "number" ? data.limit : undefined,
          name: typeof data.name === "string" ? data.name : undefined,
        })
      } catch {
        // ignore, secondary information
      }
    }

    // ------------------------------------------------------------ poll loop

    let timer: ReturnType<typeof setTimeout> | undefined
    let disposed = false
    let pending: ReturnType<typeof setTimeout> | undefined

    const schedule = () => {
      if (disposed) return
      if (timer) clearTimeout(timer)
      const delay = runningSession() ? pollActive : pollIdle
      timer = setTimeout(async () => {
        await refresh()
        schedule()
      }, delay)
    }

    const refreshSoon = (delay = 1_200) => {
      if (disposed) return
      if (pending) clearTimeout(pending)
      pending = setTimeout(() => {
        pending = undefined
        void refresh()
      }, delay)
    }

    void refresh({ force: true }).then(() => {
      void refreshKey()
    })
    schedule()

    // --------------------------------------------------------------- events

    const stopUsage = context.data.on("session.usage.updated", (event) => {
      noteActive((event as any)?.data?.sessionID)
      refreshSoon()
    })
    const stopRunning = context.data.on("session.execution.started", (event) => {
      noteActive((event as any)?.data?.sessionID)
      schedule()
    })
    const stopDone = context.data.on("session.execution.succeeded", (event) => {
      noteActive((event as any)?.data?.sessionID)
      refreshSoon(2_500)
    })
    const stopFailed = context.data.on("session.execution.failed", (event) => {
      noteActive((event as any)?.data?.sessionID)
      refreshSoon(2_500)
    })
    const stopIdle = context.data.on("session.idle", () => schedule())

    // -------------------------------------------------------- model context

    const modelList = () => {
      const location = context.location ?? context.data.location.default()
      return context.data.location.model.list(location) ?? []
    }

    const contextLimitFor = (providerID?: string, modelID?: string): number | undefined => {
      if (!providerID || !modelID) return undefined
      for (const model of modelList()) {
        if (model.providerID !== providerID) continue
        if (model.id !== modelID && (model as any).modelID !== modelID) continue
        const limit = (model as any).limit?.context
        if (typeof limit === "number" && limit > 0) return limit
      }
      return undefined
    }

    const lastAssistant = (sessionID: string) => {
      const messages = context.data.session.message.list(sessionID) ?? []
      for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index] as any
        if (message?.type !== "assistant") continue
        if (!message.tokens) continue
        return message
      }
      return undefined
    }

    const contextUsage = (sessionID: string | undefined): { used: number; limit?: number; percent?: number } | undefined => {
      if (!sessionID) return undefined
      const message = lastAssistant(sessionID)
      if (!message) return undefined
      const usage = message.tokens as Usage
      const used = usageTotal(usage)
      if (used <= 0) return undefined
      const limit = contextLimitFor(message.model?.providerID ?? (message as any).providerID, message.model?.id ?? (message as any).modelID)
      if (!limit) return { used }
      return { used, limit, percent: Math.round((used / limit) * 100) }
    }

    const sessionTokens = (sessionID: string | undefined): Usage => {
      if (!sessionID) return emptyUsage()
      const info = context.data.session.get(sessionID) as any
      const usage = info?.tokens as Usage | undefined
      if (!usage) return emptyUsage()
      return {
        input: usage.input ?? 0,
        output: usage.output ?? 0,
        reasoning: usage.reasoning ?? 0,
        cache: { read: usage.cache?.read ?? 0, write: usage.cache?.write ?? 0 },
      }
    }

    const contextColor = (percent?: number) => {
      if (percent === undefined) return colorMuted()
      if (percent < 60) return colorSuccess()
      if (percent < 85) return colorWarning()
      return colorError()
    }

    // -------------------------------------------------------------- display

    type Segment = { text: string; color: () => string }

    // A single `<text>` node holds the whole line; colored parts are `<span>`
    // children. Several sibling `<text>` nodes get shrunk independently by the
    // footer layout, which mangles the line when other status items appear.
    const Line = (props: { sessionID?: string; padded?: boolean }) => {
      const tokens = () => sessionTokens(props.sessionID)
      const ctx = () => (showContext ? contextUsage(props.sessionID) : undefined)
      const spend = () => {
        sessionSpendTick()
        return props.sessionID ? (sessionSpend.get(props.sessionID) ?? 0) : 0
      }

      const segments = (): Segment[] => {
        const out: Segment[] = [
          { text: "routerai ", color: colorPrimary },
          { text: `⇡ ${formatTokens(tokens().input)} `, color: colorText },
          { text: `⇣ ${formatTokens(tokens().output + tokens().reasoning)} `, color: colorText },
        ]
        if (tokens().cache.read > 0) out.push({ text: `⇄ ${formatTokens(tokens().cache.read)} `, color: colorText })
        if (ctx()?.percent !== undefined) out.push({ text: `· ctx ${ctx()?.percent}%`, color: () => contextColor(ctx()?.percent) })
        out.push({ text: " · ₽ ", color: colorMuted })
        if (creditsError()) out.push({ text: creditsError()!, color: colorError })
        else out.push({ text: formatMoney(balance()), color: colorSuccess })
        if (showSpend && spend() > 0) out.push({ text: ` · −${formatMoney(spend())}`, color: colorWarning })
        return out
      }

      return (
        <Show when={props.sessionID}>
          <box flexDirection="row" flexShrink={0} paddingLeft={props.padded ? 1 : 0} paddingRight={props.padded ? 1 : 0}>
            <text flexShrink={0}>
              <For each={segments()}>
                {(segment) => <span style={{ fg: segment.color() }}>{segment.text}</span>}
              </For>
            </text>
          </box>
        </Show>
      )
    }

    const stopSlots: Array<() => void> = []

    if (placement === "app") {
      // Own line under the composer, like a status line.
      stopSlots.push(
        context.ui.slot({
          append: "app",
          render: () => <Line sessionID={currentSessionID()} padded />,
        }),
      )
    } else {
      stopSlots.push(
        context.ui.slot({
          append: "prompt.footer.status",
          render: (input) => <Line sessionID={input.sessionID} />,
        }),
      )
    }

    if (options.sidebar === true) {
      stopSlots.push(
        context.ui.slot({
          append: "sidebar.content",
          render: (input) => (
            <box flexDirection="column" paddingTop={1}>
              <text fg={colorPrimary()}>RouterAI</text>
              <Line sessionID={input.sessionID} />
            </box>
          ),
        }),
      )
    }

    // --------------------------------------------------------------- dialog

    const Row = (props: { label: string; value: string; color?: string }) => (
      <box flexDirection="row" gap={1}>
        <text fg={colorMuted()}>{props.label}</text>
        <text fg={props.color ?? colorText()}>{props.value}</text>
      </box>
    )

    const showDetails = async () => {
      await refresh({ force: true })
      void refreshKey()
      const sessionID = currentSessionID()

      context.ui.dialog.set({ size: "medium", centered: true })
      context.ui.dialog.show(() => {
        // Read inside the render closure so a late balance/key response still
        // lands in the open dialog.
        const tokens = sessionTokens(sessionID)
        const ctx = contextUsage(sessionID)
        const info = keyInfo()
        const spend = sessionID ? (sessionSpend.get(sessionID) ?? 0) : 0
        const stamp = updatedAt()
        return (
          <box flexDirection="column" gap={0} paddingLeft={1} paddingRight={1}>
            <text fg={colorPrimary()}>RouterAI</text>
            <text fg={colorMuted()}>{baseURL}</text>
            <box flexDirection="column" paddingTop={1}>
              <Row
                label="Balance:"
                value={creditsError() ? creditsError()! : `₽ ${formatMoney(balance())}`}
                color={creditsError() ? colorError() : colorSuccess()}
              />
              <Show when={info?.usage_monthly !== undefined}>
                <Row label="This month:" value={`₽ ${formatMoney(info?.usage_monthly)}`} />
              </Show>
              <Show when={info?.usage !== undefined}>
                <Row label="Lifetime:" value={`₽ ${formatMoney(info?.usage)}`} />
              </Show>
              <Show when={lastCharge() !== undefined}>
                <Row label="Last charge:" value={`₽ ${formatMoney(lastCharge())}`} />
              </Show>
              <Show when={spend > 0}>
                <Row label="This session:" value={`− ₽ ${formatMoney(spend)}`} color={colorWarning()} />
              </Show>
              <Show when={spent() > 0}>
                <Row label="Since TUI start:" value={`− ₽ ${formatMoney(spent())}`} color={colorWarning()} />
              </Show>
            </box>
            <box flexDirection="column" paddingTop={1}>
              <Row label="Session tokens:" value=" " />
              <Row label="  input" value={formatTokens(tokens.input)} />
              <Row label="  output" value={formatTokens(tokens.output + tokens.reasoning)} />
              <Row label="  cache read" value={formatTokens(tokens.cache.read)} />
              <Row label="  cache write" value={formatTokens(tokens.cache.write)} />
              <Show when={ctx}>
                <Row
                  label="  context"
                  value={ctx?.percent !== undefined ? `${ctx?.percent}% of ${formatTokens(ctx?.limit ?? 0)}` : formatTokens(ctx?.used ?? 0)}
                  color={contextColor(ctx?.percent)}
                />
              </Show>
            </box>
            <box flexDirection="column" paddingTop={1}>
              <Show when={stamp}>
                <text fg={colorMuted()}>Updated: {new Date(stamp!).toLocaleTimeString()}</text>
              </Show>
              <text fg={colorMuted()}>Tab/Enter — close</text>
            </box>
          </box>
        )
      })
    }

    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "routerai.balance",
          title: "RouterAI: balance and token usage",
          group: "RouterAI",
          palette: true,
          slash: { name: "balance", aliases: ["routerai", "credits"] },
          run: () => void showDetails(),
        },
        {
          id: "routerai.refresh",
          title: "RouterAI: refresh balance",
          group: "RouterAI",
          palette: true,
          run: async () => {
            await refresh({ force: true })
            void refreshKey()
            context.ui.toast.show({
              title: "RouterAI",
              message: creditsError() ? `Error: ${creditsError()}` : `Balance: ₽ ${formatMoney(balance())}`,
              variant: creditsError() ? "error" : "success",
            })
          },
        },
      ],
    }))

    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
      if (pending) clearTimeout(pending)
      stopUsage()
      stopRunning()
      stopDone()
      stopFailed()
      stopIdle()
      for (const stop of stopSlots) stop()
    }
  },
})
