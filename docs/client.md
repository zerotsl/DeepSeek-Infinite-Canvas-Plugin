# Client half contract — DeepSeek 无限画板 (persistent DSH Web bundle)

Target: DSH `0.2.1-rc.2`, Web GUI `http://127.0.0.1:56311`.
Evidence: `<pkg>/<file>#Lx-Ly` = installed package under `…/app.asar/dsh/node_modules/@deepseek-ai/<pkg>/`.
Live Client inspection (`Slots`, `Service`, `Theme`, `Builtin`) timed out on every attempt in this
session; everything below is source-verified instead, inferred items marked **[inferred]**.

## 1. Bundle + client module

```json
{ "name": "@local/dsh-infinite-canvas", "version": "1.0.0", "private": true, "type": "module",
  "exports": { ".": "./index.js", "./client": "./client.js", "./locale/*.json": "./locale/*.json", "./icon": "./icon.svg" },
  "files": ["index.js", "client.js", "cordis.patch.yml", "locale/*.json", "icon.svg"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "immediately": true,
      "inject": ["@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-client-ui-layout", "@deepseek-ai/dsh-client-ui-sidebar"] } } }
```

- `exports["./client"]` must point at the browser bundle; the `__ModuleLoader__` factory `id` must
  equal the package name; the factory returns the Cordis object plugin `{ inject, apply }`.
  Baseline template: `…/dsh-agent-preset/skills/cordis-plugin-development/templates/decoration/{package.json,client.js}`.
- `dsh.client.inject` is package load order; module `inject` is Cordis service injection.
  `immediately: true` (template + shipped always-on plugins) materializes the module at boot, which
  a sidebar entry needs; else it may stay lazy. **[inferred]** for "required", verified as the
  shipped convention in `dsh-client-ui-plugin-manager/package.json#L37-L47`.
- Baseline `require()` modules with **no** `dsh.client.external` declaration (verified by shipped
  bundles that require them): `react`, `react/jsx-runtime`, `react-dom`, `@deepseek-ai/cordis`,
  `@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-ui-primitives`,
  `@deepseek-ai/dsh-client-store` (`ui-sidebar/lib/client.js#L7-L11`,
  `ui-layout/lib/client.js#L7-L9`, `ui-plugin-manager/lib/client.js#L7-L12`). Canvas needs `react` only.
- Register everything inside `apply` with `ctx.effect` / `ctx.slots.inject`: slot registrations are
  effect-owned by the caller fiber and removed on unload
  (`ui-renderer/lib/client.js#L1354-L1360`; loader passes module exports as an object plugin,
  `ui-layout/lib/client.js#L588-L600`).

```js
// client.js (skeleton; the rest of this document fills in the pieces)
window.__ModuleLoader__.load({
  id: '@local/dsh-infinite-canvas',
  factory(require) {
    const React = require('react')
    const NS = 'canvas'
    const zh = { 'panel.title': '无限画板' }, en = { 'panel.title': 'Infinite Canvas' }
    return {
      inject: ['slots', 'layout', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'canvas: dictionaries')
        const t = ctx.locale.bind(NS)
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'canvas', locale: NS }, CanvasPanel))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: 'canvas', order: 10, label: () => t('panel.title'), locale: NS,
        }, CanvasIcon))
      },
    }
  },
})
```

## 2. Main panel (central full-bleed surface)

Verified chain: layout declares `main` as root-scoped **keyed**:
`children: { main: { kind: 'keyed', scope: 'root' } }` (`ui-layout/lib/client.js#L631-L634`);
`AppFrame` renders `renderSlot("main", {}, { entryKey: usePanelInfo(i => i.activePanelId) ?? "conversation" })`
inside the center column (`#L118-L120`); the renderer resolves a keyed entry by `entry.options.key`
and renders nothing for a missing key (`ui-renderer/lib/client.js#L1178-L1181`).

```js
ctx.slots.inject('main', function* () {
  yield ctx.slots.register({
    name: 'main', key: 'canvas',        // keyed-slot discriminator; NOT `id`
    locale: 'canvas',                   // → component receives `t` bound to this namespace
    inject: () => ({ hooks: { canvas: canvasStore } }), // → component receives `useCanvas`
  }, CanvasPanel)
})
```

`ctx.slots.inject(name, cb)` is declaration-aware (runs now if declared, else on declaration), may
return one disposer or an iterable (generator form is the shipped Plugins-page shape,
`ui-plugin-manager/lib/client.js#L4411-L4461`). `ctx.slots.register(...)` returns a disposer.

**Component props** — assembled as `{...standardKit, ...injected, ...slotInjected.props, ...ownerProps}`
(`ui-renderer/lib/client.js#L736-L767, L773-L791`):
- `usePanelInfo` — from layout's `ctx.slots.provideRoot({ hooks: { panelInfo } })` (`ui-layout#L618-L621`); selector hook, `usePanelInfo(i => i.activePanelId)`.
- `useSessions`, `useWorkspaces` — root standard hooks; available, not needed for a global canvas.
- `t` — only with the `locale` registration option; namespace-bound and locale-reactive.
- `use<Key>` — from `inject: () => ({ hooks: { canvas: store } })`; other `inject` values spread verbatim. A registration `store` adds `useStore`/`actions`; declared `children` add `renderSlot`/`renderSlotChain`; `renderFactorySlot` is always present. Owner props: `renderSlot("main", {}, …)` passes `{}`.
- No Session binding or sidebar region is required: `main` is the only panel surface, the canvas is global, and the Conversation keeps key `"conversation"`.

**Full-bleed**: center column is `display:flex; flex-direction:column; min-width:0; overflow:hidden`
(`ui-layout/lib/client.js#L73` `.BynINW_centerCol`), slot anchor is `display:contents`, so the
component's root box owns the area:

```js
function CanvasPanel({ t, useCanvas }) {
  const doc = useCanvas((s) => s.doc)
  return React.createElement('div', { style: {
    position: 'relative', flex: '1 1 auto', minHeight: 0, height: '100%', width: '100%', overflow: 'hidden',
    background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)',
    paddingTop: 'var(--dsh-frame-top-clearance, 0px)', // shipped entry pages pad by it; drop only if drawing under the chrome
  } }, /* canvas surface + overlay controls */)
}
```

**Switching / unknown key**:

```js
ctx.layout.selectPanel('canvas')  // open;  ctx.layout.selectPanel(null) → Conversation
```

`LayoutController.selectPanel` checks the live registry (`ctx.slots.entries("main").some(e =>
e.options.key === id)`) and **throws** `Error: layout.selectPanel: main panel "<id>" is not
registered`, leaving the selection intact (`ui-layout/lib/client.js#L462-L472, L614-L620`).
Selection is in-memory (`panelInfo.activePanelId`), resets on reload, and is reset to `null` when
the active panel unregisters (`retainMainPanels` on `main` subscription, `#L689-L690`). So register
the key before any `selectPanel`; a main-only panel is legal but unreachable without a sidebar entry.

## 3. Sidebar launcher (`sidebar.panellist`)

`ui-sidebar` declares a root-scoped **list** (`ui-sidebar/lib/client.js#L503-L506`), projects rows
as `{ id, order ?? 0, label }` sorted ascending, re-projecting on slot/locale change (`#L452-L470`),
and renders one `<button>` per row whose `onClick` calls `selectPanel(id)` — the row owns
selection, tooltip, `aria-label`, `aria-current` (`#L173-L199`). The icon component receives exactly
the owner props `renderSlot("sidebar.panellist", { size, active }, { only: id })` (`#L187-L193`), so
render an icon only.

```js
function CanvasIcon({ size }) {
  return React.createElement('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
    'aria-hidden': true, stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' },
  React.createElement('rect', { x: 3, y: 4, width: 18, height: 16, rx: 3 }),
  React.createElement('path', { d: 'M3 9h18M9 9v11' }))
}
```

Options: `{ name, id, order, label, locale }`; `id` must equal the `main` key; `label` is a string
or a function (shipped: `label: () => t('panel')`, `ui-plugin-manager/lib/client.js#L4477-L4483`);
the label is visible text + accessible name + collapsed-rail tooltip
(`ui-sidebar/README.md#L36-L38`). No entries → no nav. Never call `selectPanel` in the icon.

## 4. Client → own Host half

### 4a. Recommended: exact Fetch route under `/api` + plain `fetch()`

```js
// index.js (Host, ESM)
export const inject = ['connection']
export function apply(ctx) {
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/canvas/doc',                 // MUST be /api/... (assertFetchRoute)
    methods: ['GET', 'POST'],
    requestBody: 'buffered',                 // or 'streaming'
    fetch: async (request) => {
      if (request.method === 'GET') return json(200, { ok: true, doc: readCanvas() })
      const body = await request.json()
      return json(200, { ok: true, rev: applyOps(body.ops) })
    },
  }), 'canvas: /api/canvas/doc')
}
function json(status, value) {
  return new Response(JSON.stringify(value), { status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}
```

```js
// client.js — plain document-relative fetch; NO client connection service needed
async function api(method, body) {
  const response = await fetch('api/canvas/doc', {   // document-relative: no leading slash
    method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`canvas: HTTP ${response.status}`)
  return response.json()
}
```

Route contract: `register({ path, methods: ['GET'|'HEAD'|'POST'…], requestBody: 'buffered'|'streaming',
fetch: (request: Request) => Promise<Response> }) → () => Promise<void>`
(`dsh-client-connection/lib/index.js#L731-L735, L840-L854, L973-L977`); exact shipped usage
`dsh-client-file-upload/lib/index.js#L170-L175`. Routes live inside Connection's single `/api` prefix
route, so Host/Origin trust + browser-cookie admission run before the handler and only an owner
`Peer` reaches it (`#L742-L749, L820-L839, L1044-L1058`); a returned `Response` body is streamed
chunk-by-chunk (`#L88-L112`). Client-side proof: Session-log export registers `/api/session.export`
and the browser fetches document-relative `api/session.export?…`
(`dsh-session-log-export/lib/client.js#L11-L12, L104-L116`; `README.md#L55, L80-L88`).

Auth/origin: signed host-only `HttpOnly; SameSite=Strict` cookie (Secure only on TLS), minted by the
one-time `?token=` index exchange; missing/expired/wrong-authority → 401. Host must be loopback, the
bind IP, or `trustedHosts`; an attached `Origin` must match; `sec-fetch-site: cross-site` → 403.
No token, header, or CORS work is needed from the page (`dsh-client-connection/README.md#L40-L47`).

### 4b. Alternative: generic RPC channel (JSON envelope)

```js
// client.js — ctx module inject must include 'connection'
const result = await ctx.connection.rpc.call('/canvas', 'doc/get', {}, signal) // {ok:true,value}|{ok:false,error}
// index.js
ctx.effect(() => ctx.connection.rpc.handle('/canvas', async (endpoint, payload, signal, peer) => {
  if (endpoint === 'doc/get') return { ok: true, value: readCanvas() }
  return { ok: false, error: { code: 'canvas/unknown-endpoint', message: endpoint, details: {} } }
}), 'canvas: rpc')
```

Wire: POST document-relative `canvas/<endpoint>`, body `{type:'client-request',rpcId,method,payload}`,
JSON in / `{type:'server-response',rpcId,result}` out; client resolves the result envelope and throws
on HTTP/envelope failure. Channel `/^\/[A-Za-z0-9._~-]+$/`, must not be `'/api'`; endpoint segments
`[A-Za-z0-9_$.-]+`; the channel's webServer prefix route still runs cookie `admit()`.
(`dsh-client-connection/lib/client.browser.js#L1199-L1239`; host `index.js#L723-L730, L855-L872`.)

### 4c. Avoid for data: raw `ctx.webServer.register`

`register({ kind, path, handler(req,res) })` has **no auth** (shipped `/plugins/events` is
unauthenticated: `dsh-client-hmr/lib/index.js#L141-L152`). If used, guard it with
`ctx.connection.requestRejection({ headers: req.headers })` → `401|403|undefined`
(`dsh-client-connection/lib/index.js#L736-L740`). Use for streaming only (§5), not read/write JSON.

## 5. Host → Client live updates (SSE; polling fallback)

Server, adapted from the shipped HMR channel (`dsh-client-hmr/lib/index.js#L116-L169`) plus auth:

```js
export const inject = ['webServer', 'connection']
export function apply(ctx) {
  const clients = new Set()
  ctx.effect(() => {
    const dispose = ctx.webServer.register({ kind: 'exact', path: '/canvas/events', handler: (req, res) => {
      const rejected = ctx.connection.requestRejection({ headers: req.headers })
      if (rejected !== undefined) { res.writeHead(rejected); res.end(); return }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      res.write(': connected\n\n'); clients.add(res); res.on('close', () => clients.delete(res))
    } })
    const off = canvasService.onChange((doc) => {
      const line = `data: ${JSON.stringify(doc)}\n\n`
      for (const res of clients) res.write(line)
    })
    return () => { off(); dispose(); for (const res of clients) res.destroy(); clients.clear() }
  }, 'canvas: sse')
}
```

Client, exactly the shipped HMR client shape (`dsh-client-hmr/lib/client.js#L235, L288-L306`):

```js
ctx.effect(() => {
  const source = new EventSource('canvas/events')       // relative; HMR uses "/plugins/events".slice(1)
  source.addEventListener('message', (event) => { try { canvasStore.set(JSON.parse(event.data)) } catch (e) {} })
  return () => source.close()
}, 'canvas: events')
```

- Keep EventSource + authoritative store at **plugin scope**, not in the panel: the keyed `main`
  entry unmounts when another panel/Session is selected (`ui-renderer/lib/client.js#L1178-L1181`),
  so a component-local stream would miss updates while hidden. Expose it with
  `inject: () => ({ hooks: { canvas: canvasStore } })`. Store: `createSnapshotStore(initial)` from
  `@deepseek-ai/dsh-client-store` (baseline module) gives `getSnapshot/subscribe/set`
  (`ui-sidebar/lib/client.js#L452-L469`; `session-log-export/lib/client.js#L45, L133-L140`).
- `EventSource` sends the same-origin cookie automatically; the guard answers 401/403 otherwise.
  Send a full snapshot on connect, then deltas; no CORS headers.
- `text/event-stream` works through the `/api` Fetch-route registry too (return a stream `Response`,
  clean up on `request.signal`); both halves are proven separately, the combination is **[inferred]**.
- Simplest fallback: poll `GET api/canvas/doc` every 1–2 s in a plugin-scope `ctx.effect` (§4a only).

## 6. Theme tokens for the canvas surface

The `Theme` inspect catalog is exactly `BUILTIN_INSPECT_TOKENS`
(`dsh-client-ui-theme/lib/client.js#L1531-L1630`, exported by `exportInspectTokens` `#L1700-L1705`).
The presenter writes resolved tokens as inline custom properties on `body` (`ui-layout#L548-L569`), so
always `var(--token)`, never hardcode; dark-only overrides go under `body[data-ds-dark-theme]`.

| Token | Use | Token | Use |
|---|---|---|---|
| `--dsw-alias-bg-base` | canvas base surface | `--dsw-alias-bg-layer-1` | raised node cards |
| `--dsw-alias-bg-layer-2` | nested/field surface | `--dsw-alias-bg-overlay` | popovers/menus |
| `--dsw-alias-border-l1` / `-l2` | subtle / stronger border | `--dsw-alias-border-l3` / `-l4` | divider / emphasized stroke |
| `--dsw-alias-brand-primary` | primary accent | `--dsw-alias-state-business-primary` | interaction/focus accent |
| `--dsw-alias-interactive-bg-hover` | neutral hover fill | `--dsw-alias-bg-module-platform` | selected fill |
| `--dsw-alias-label-primary` | primary text | `--dsw-alias-label-secondary` | secondary text |
| `--dsw-alias-state-error/success/warn/idle-primary` | status | `--dsw-specific-sidebar-fill` | sidebar-colored chrome |
| `--dsw-radius-xs/sm/md/lg/xl/panel` | 4/8/12/16/20/28 px | `--dsw-shadow-lv1`, `-lv2`, `-lv3` | elevation shadows |
| `--dsw-elevation-panel/-prominent/-soft`, `--dsw-elevation-stroke` | surfaces (pair `border:0`) | `--dsw-focus-ring-color`, `--dsw-focus-ring-width` | 2 px ring |
| `--dsh-content-font-size`, `--dsh-code-font-size` | text scale | `--ds-ease-in-out`, `--ds-transition-duration{,-fast,-slow}` | motion |

Radius/shadow values: `base.css` `#L1407`, `gradient-shadow-text.css` `#L1425`; `-l3` divider use:
`ui-layout#L73`; `-l4` card stroke: `base.css`. Raw `--dsw-static-*` palette tokens are alias inputs
only. Containers/controls inherit host theme; canvas artwork may use its own colors
(`…/cordis-plugin-development/references/ui-plugin.md#L13`).

## 7. Locale (zh + en)

```js
const NS = 'canvas'
ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'canvas: dictionaries') // both built-ins required
const t = ctx.locale.bind(NS)   // t(key[, params]); stable identity per namespace → safe on inject surfaces
```

Slot `locale: NS` gives components the bound `t` prop; every slot outlet re-renders on a locale
switch (`ui-renderer/lib/client.js#L579-L590`), and locale-aware `label: () => t('panel.title')`
re-projects live (ui-sidebar subscribes to `ctx.locale`, `#L470`). Per-locale/language-pack form is
`register(ns, 'ja', {...})`; a dictionary registered after mount is picked up without remount
(`dsh-client-locale/README.md#L36-L42, L48-L64`). `meta.title`/`meta.description` for the plugin
manager ship in exported `locale/<lang>.json`, not this runtime namespace.

## 8. Checklist / pitfalls

- Module `inject: ['slots','layout','locale']` (+`'connection'` only for §4b); `dsh.client.inject` lists those packages.
- `apply` order: locale → `main` → `sidebar.panellist`, all inside `ctx.slots.inject`/`ctx.effect` so unload disposes them.
- `selectPanel` throws on an unknown key and selection is lost on reload; guard with `ctx.slots.entries('main')` if unsure.
- Keyed `main` remounts on every switch: keep doc state and network subscriptions at plugin scope, expose via `inject` hooks.
- Plain React component, no JSX, no second React root, no `document.body` writes; inline style objects for v1.
- `/api` routes already enforce auth (401/403) — add no CORS/token/cookie handling.

## 9. Verified vs inferred

Verified with cited lines: keyed `main` declaration + `entryKey` dispatch; sidebar panellist
projection/label/order and row `selectPanel`; `selectPanel` registry throw; root props assembly;
relative-path `/api` Fetch route end-to-end (register, plain fetch, cookie admission, streaming
bridge); generic RPC channel envelope; HMR SSE server/client shape; theme catalog + radius/shadow
values; locale register/bind and slot `t`.

Inferred: `immediately: true` being boot-required; SSE through the `/api` Fetch registry; exact
full-bleed rendering under Windows caption/macOS traffic lights. Blocking uncertainty: live Client
inspection timed out, so slot options/props came from renderer/owner source rather than a live
manifest — re-check `main`/`sidebar.panellist` occupancy and `Theme.listTokens` if it recovers; no
design decision depends on it.
