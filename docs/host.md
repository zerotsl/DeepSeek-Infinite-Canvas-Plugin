# Host-half contracts — DeepSeek 无限画板 canvas bundle

Research target: installed DSH `0.2.1-rc.2`. `<dsh>` = `E:\T\T...\AppData\Local\Programs\DeepSeek Harness\resources\app.asar\dsh`.
Markers: **[V]** verified in installed compiled source · **[R]** verified from installed README / inspect-provider types · **[T]** source-verified by teammate `agent-ui` (same install) · **[I]** inferred, needs runtime check.
Scope: Host half only (tool, system prompt, optional-dependency pattern, Host↔Client seam, agent-context hygiene). Slots/theme/locale for the canvas panel live in `docs/client.md`.

## 1. Bundle skeleton (Host)

`package.json` needs no dependencies for a plain-JS Host half (`references/host-plugin.md` [R]). Patch row inserts one plugin:

```yaml
# cordis.patch.yml
- insert:
    - id: deepseek-canvas
      name: '@local/deepseek-canvas'
      config: {}
```

```js
// index.js — plain ESM, no @deepseek-ai/* imports required
export const name = 'deepseek-canvas'
export function apply(ctx, config) {
  // all registrations here; returned effects are disposed on unload
}
// optional `export const inject = ['tools', 'systemPrompt']` (see §4)
// optional `export const Config` (StandardSchemaV1; omit in a plain-JS bundle unless you hand-write one)
```

## 2. Tool registration — `ctx.tools.register(definition)` **[V]**

### 2.1 Exact shape

`ToolDefinition` extends `ToolSchema` (`<dsh>/node_modules/@deepseek-ai/dsh-tools/README.md`, Service inspect of `tools`):

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | wire tool name; unique per layer; `run_code` is reserved and throws |
| `description` | yes | model-facing text, repeated every request |
| `parameters` | yes | **raw JSON Schema object** (`Record<string, unknown>`), not zod/not the `defineTool` DSL |
| `output.schema` | yes | JSON Schema for the canonical value, enforced subset |
| `output.render(args, value)` | yes | `ContentBlock[]` — the **only** content the model sees |
| `output.presentationMeta?(args, value)` | no | JSON persisted as result `meta` (card data, `tool/result` event meta) |
| `execute(args, exec)` | yes | async; returns canonical JSON value; throw for failure |
| `deferLoading?` | no | deferred-schema marker (`deferLoading: true`) |
| `timeoutMs?` | no | **declarative only** — the registry never enforces it (README "Known limitations") |
| `isConcurrencySafe?(args)` | no | exact `true` allows parallel scheduling; otherwise exclusive |
| `projectContent?`, `finalizeContent?` | no | `(exec, result) => ContentBlock[] \| undefined` content transforms |
| `presentCall?`, `presentResult?` | no | Host-local presenters — **not consumed by the Web Client** (README §"Host presentation descriptors") |

Does **not** exist: `strict`, `title`, `annotations`, `scope` on the definition (JSON-Schema `title` is annotation-only inside `parameters`/`output.schema`). `presentAs` is a service method, not a field: `ctx.tools.presentAs('native' | 'ptc')`, scoped only (agent.ctx) **[V]** `lib/index.js:2911`.

`register()` at runtime **[V]** `lib/index.js:2974-2983`: requires `output` + `output.render` function, `assertSupportedJsonSchema(output.schema)`, finite `timeoutMs`, rejects name `run_code`, returns a disposer. **It does not validate `parameters` and does not validate model arguments** — that validation belongs to `defineTool` (`lib/index.js:838-887`). With a raw literal, validate args inside `execute` and throw on bad input.

Enforced JSON-Schema subset (used for `output.schema`, and by PTC codegen) **[V]** `lib/index.js:34-58, 323-339`: `type` (single string), `oneOf` (≥2, no sibling constraints), `properties`/`required`/`additionalProperties` (object only), `items` (array only), scalar `enum`/`const`, plus annotations `description`/`title`/`default`/`examples`. Annotation-only `{}` = unconstrained JSON. `parameters` should be an object-rooted schema; model-facing projection just needs lossless JSON (`schemaOf`, `lib/index.js:3135-3145`).

### 2.2 Minimal working literal (canvas tool, object parameter schema)

```js
ctx.inject(['tools'], (ctx) => {
  ctx.tools.register({
    name: 'canvas_edit',
    description: 'Apply edits to the DeepSeek infinite canvas. Use for adding, updating, or deleting nodes. Returns the new canvas revision and counts.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ops: {
          type: 'array',
          description: 'Ordered operations to apply.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              action: { type: 'string', enum: ['add', 'update', 'delete'] },
              id: { type: 'string', description: 'Target node id (update/delete).' },
              text: { type: 'string', description: 'Node text (add/update).' },
            },
            required: ['action'],
          },
        },
      },
      required: ['ops'],
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          added: { type: 'integer' }, updated: { type: 'integer' },
          deleted: { type: 'integer' }, total: { type: 'integer' },
          revision: { type: 'integer' }, summary: { type: 'string' },
        },
        required: ['added', 'updated', 'deleted', 'total', 'revision', 'summary'],
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
      presentationMeta: (_args, value) => ({ added: value.added, updated: value.updated, deleted: value.deleted, total: value.total }),
    },
    async execute(args, exec) {
      // raw registration: validate model arguments yourself
      if (!Array.isArray(args.ops)) throw new Error('invalid arguments: `ops` must be an array')
      const result = canvas.apply(args.ops)          // plugin-owned store
      return { ...result.counts, revision: result.revision, summary: result.summary }
    },
  })
})
```

`defineTool` variant (only if the bundle can resolve `@deepseek-ai/dsh-tools`): it takes a **different `parameters` grammar** (`{ op: { type: 'string', required: true, description } }`, `additionalProperties` must be explicit, `type: 'json'` allowed), compiles it to JSON Schema and auto-validates args (`INVALID_ARGS`). Do not mix the two grammars. **[I]** A profile-installed bundle has no automatic import path to `<dsh>/node_modules/@deepseek-ai/*` (profile `node_modules` holds only installed bundles), and shipping a dependency on a duplicate `dsh-tools` copy is avoidable — prefer the raw literal.

### 2.3 How the model sees it **[R][V]**

- Registration is enough: `ToolRuntime` feeds `schemas()` into system-prompt assembly; a manual `ctx.systemPrompt.tools()` provider is not needed.
- Model receives `{ name, description, parameters }` (plus `deferLoading`) as a wire schema field, ordered lexicographically by name unless the deployment's `toolOrder` config overrides (`lib/index.js:2932-2944`; system-prompt README).
- Schema/description tokens are paid on every request; keep `description` short (< ~500 chars) and parameter descriptions terse.
- Visibility: global by default; per-agent registration through `agent.ctx` shadows globals; per-agent hiding via `ctx.tools.restrict({ allow | deny })` **[V]**; duplicates in one layer throw.

## 3. System-prompt section — `ctx.systemPrompt.section(section)` **[R][V]**

```js
ctx.inject(['systemPrompt'], (ctx) => {
  ctx.systemPrompt.section({
    name: 'canvas:guidance',
    order: 3200,                       // first-party map below; any finite number is legal
    text: () =>                        // runs at every prompt assembly (sync, per request)
      '## Infinite canvas\n' +
      'The user has a persistent infinite canvas panel. Use `canvas_edit` for canvas changes; ' +
      `current document revision ${canvas.revision}, ${canvas.nodeCount()} nodes.`,
    // interpolate: true by default; set false when the text contains literal {{...}}
  })
})
```

`PromptSection` **[R]** = `{ name: string, order: number, text: string | ((context: AssembleContext) => string), interpolate?: boolean, complete?: boolean }`, `AssembleContext = { scope?, signal? }`.

- Registration [`lib/index.js:253-256`]: non-finite `order` throws; duplicate `name` in one layer throws; a scoped (`agent.ctx`) section shadows the global one; registration/disposal emits `system-prompt/change`.
- Assembly [`lib/index.js:356-399`]: sections collected, sorted by `order` ascending then code-unit name; each `text` function is called per assembly with `AssembleContext`; `renderPrompt` drops empty sections and joins with blank lines; `{{var}}` interpolation is strict (unknown/throwing references fail assembly), disabled by `interpolate: false`; **at most one** effective `complete: true` section (becomes the whole prompt — do not use here).
- Placement: first-party `SECTION_ORDERS` are `HARNESS_IDENTITY -1000`, persona `0`, `PLAN_POLICY 500`, `TEAM_POLICY 600`, `PTC_ONLY 800`, tool guidance `1000–3100`, `MCP_SERVERS 3100`, `TOOLS_SDK 5000`, `HARNESS_SOURCE 10000`, `WEB_SURFACE 10100`, persona suffix `10200` **[V]** `dsh-system-prompt/lib/index.js:10-42`. Canvas guidance belongs with tool guidance: use `3200` (after MCP, before the generated SDK) or `1050`-style values near the tool sections. External contributions may use any finite order (README).
- Model effect: one system-role message (surface node / in-history replacement) **[R]**; unchanged text leaves the prompt prefix stable, so only include changing facts you accept invalidating cache from that token onward.
- Alternative for per-step facts: `ctx.systemPrompt.context({ name, order, text, required?, interpolate? })` renders as a running *user-role snapshot* ("Current runtime context…"), not a system section **[R]**. Same registration semantics (`lib/index.js:279-282`). Use sparingly; section text is usually enough.
- Do not add a section that merely restates the tool schema; the schema is already sent.

## 4. Optional dependencies — stay inert when services are missing **[V]**

Cordis: `Plugin.Base.inject` = "Services the plugin requires; it only loads while all are available"; `ctx.inject(deps, callback)` is a child plugin body that unloads/re-runs when a required service changes (`<dsh>/node_modules/@deepseek-ai/cordis/src/registry.ts:100-111, 164-187`). `ctx.get('tools')` reads a service optionally and needs an `undefined` check (Service inspect `access.optional`).

```js
export function apply(ctx, config) {
  const canvas = createCanvasStore(config)              // plugin-owned state

  // each block is a Cordis child fiber: it runs only while the service exists,
  // re-runs when it appears/changes, and its registrations are disposed with the plugin
  ctx.inject(['tools'], (ctx) => { /* §2 registration */ })
  ctx.inject(['systemPrompt'], (ctx) => { /* §3 section */ })
  ctx.inject(['connection'], (ctx) => { /* §6 RPC/fetch route */ })

  ctx.effect(() => () => canvas.dispose(), 'canvas: store')
}
```

Rules: never touch `ctx.tools`/`ctx.systemPrompt` at module top level (a profile without those rows must load the bundle inertly); registrations made through another service's context (e.g. `ctx.connection.rpc.handle`) are owned by that service, so wrap their disposers in your own `ctx.effect(...)` for unload cleanliness; the tool/route must not throw during activation.

## 5. Custom tool card in chat — feasible from the bundle, Client half only

The Web Client renders each atomic tool call through the **keyed** `tool.call.toolview` slot; unregistered names get the generic card (**[R]** `@deepseek-ai/dsh-client-ui-tool/README.md:12, 34-52`). Registration is a plain React component supplied by the same bundle's client module — no Harness Client package import (`require('react')` comes from the browser module table; template `references/ui-plugin.md` + **[T]** agent-ui).

```js
// client.js — browser half of the same bundle
window.__ModuleLoader__.load({
  id: '@local/deepseek-canvas',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    // props = ToolCallOwnerProps (callId, toolName, phase + stage block, cwd?, home?, loadImage,
    // openFile, inspect); result block carries content + persisted meta (presentationMeta)
    function CanvasCallRow(props) {
      const meta = props.block?.meta ?? {}
      const label = props.phase === 'result'
        ? `canvas · ${meta.added ?? 0} added, ${meta.updated ?? 0} updated`
        : 'canvas'
      return h('div', { style: { fontSize: 12, opacity: 0.8 } }, label)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
          name: 'tool.call.toolview',
          key: 'canvas_edit',            // exact wire tool name from §2
        }, CanvasCallRow))
      },
    }
  },
})
```

- Cards receive raw call arguments, result content, failure state, and persisted result metadata; **Host `presentCall`/`presentResult` never reach the Web Client** (**[V]** dsh-tools README §"Host presentation descriptors"; ui-tool README). Put card numbers in `output.presentationMeta` and/or in `output.render` text.
- Exact prop TypeScript shape lives in the installed `@deepseek-ai/dsh-client-ui-tool` `src/client/contract/slots.ts`; it is not shipped as `.d.ts` in this build and Client inspect timed out in this session — use the README contract above and confirm with `Slots.listSubTree` when a page answers (`[T]` agent-ui continues on this in `docs/client.md`).
- If `ui-tool` is not mounted, the slot owner is absent, the `inject` callback never runs, and tool calls fall back to the generic card — the Host half keeps working. Never throw from the component (`slot entry crashed` blanks the row).

## 6. Host method callable from the Client half — the seam

**Not available to a bundle:** a new `ctx.remote.<namespace>`. Remote methods are TypeScript methods carrying `@Remote`, imported from `@deepseek-ai/dsh-typert-protocol` (e.g. `<dsh>/node_modules/@deepseek-ai/dsh-api-job-controller/lib/index.js:2`); their wire descriptors are generated build artifacts (`TYPERT_REMOTE`, lazy zod schema factories) and the Client mounts a **fixed, build-time list** in `@deepseek-ai/dsh-api-remotes` ("the capability set is fixed by explicit build-time value imports; the Client does not discover the Host's active Services or Remote definitions at runtime"; "additional capabilities require an explicit `/remote` value import and mount"). `ctx.typert.register(contribution)` exists at runtime (`dsh-typert-registry` README) but requires the generated descriptors/codecs — **not a plain-JS seam; do not attempt**.

Recommended seam — **generic Connection RPC channel** (JSON unary, no build artifacts) **[V/T]**:

```js
// Host index.js
ctx.inject(['connection'], (ctx) => {
  ctx.effect(() => ctx.connection.rpc.handle('/deepseek-canvas',
    async (endpoint, payload, signal, peer) => {
      if (endpoint === 'state') return { ok: true, value: { revision: canvas.revision, nodes: canvas.nodes() } }
      if (endpoint === 'apply') return { ok: true, value: canvas.apply(payload.ops) }
      return { ok: false, error: { code: 'canvas/unknown-endpoint', message: `unknown endpoint ${endpoint}`, details: {} } }
    }), 'canvas: rpc channel')
})
```

```js
// client.js — inside the factory, client plugin injects ['connection']
const result = await ctx.connection.rpc.call('/deepseek-canvas', 'state', null, signal)
// result = { ok: true, value } | { ok: false, error: { code, message, details } }
```

Facts **[V]** `@deepseek-ai/dsh-client-connection/lib/index.js:723-735, 855-872, 888-930`; `lib/client.browser.js:1200-1239, 1443, 1497`; **[T]** agent-ui end-to-end: channel must match `/^\/[A-Za-z0-9._~-]+$/` and must not be `/api`; the browser POSTs to the document-relative path (`deepseek-canvas/state`); Connection applies its Host/Origin fence and browser-cookie authentication before the handler runs; payloads are buffered JSON; unary only (streams are `/api`-only). No Agent object is needed — this is the key advantage over commands.

Alternative for GET snapshots / streaming (SSE) — **exact authenticated Fetch route** **[V/T]**: register `{ path: '/api/canvas.state', methods: ['GET', 'HEAD', 'POST'], requestBody: 'buffered' | 'streaming', fetch: async (request) => new Response(...) }` via `ctx.connection.fetch.register(...)`; the browser uses plain document-relative `fetch('api/canvas.state')`. Path must be under `/api/` and unique (`assertFetchRoute`, `endpointFromPath`); browser peers are owner principals; response streaming is bridged chunk-by-chunk. Precedent: `@deepseek-ai/dsh-session-log-export` (`/api/session.export`) and `@deepseek-ai/dsh-client-file-upload`. Wrap the returned disposer in `ctx.effect`.

Alternative — **slash command** (only if a user-visible command is wanted): Host `ctx.commands.register({ name: 'canvas', description, handler: ({ agent, rawInput }) => ({ kind: 'success', text: JSON.stringify(...) }) })`; Client `ctx.remote.commands.execute(agent, '/canvas ' + JSON.stringify(action), [], signal)` **[R]** commands README "Dispatching from an adapter" + api-remotes mounts the Commands contribution. Caveats: the Client needs a live Agent handle for the Remote call (unverified from a panel component), commands are logged (`command/run`, `command/done`, not model messages), and text-only results — the RPC channel is strictly better for UI state.

**Host→Client push is not available plain-JS.** Forwarded events are an allowlist fixed at build time in `@deepseek-ai/dsh-api-remotes` (`API_REMOTE_FORWARDED_EVENTS`; `ctx.remote.$on` legal keys derive from it). For live canvas updates: Client re-reads the RPC channel after each mutation, on panel focus/visibility, and optionally on a short interval; a Host bridge to session projections (`wire.view`) is only appropriate for state derivable from the session log (`references/practices.md:38`), which a plugin-owned canvas document is not.

## 7. Agent-context hygiene and result size **[R][V]**

- The model sees **only** `output.render(...)` content (`ContentBlock[]` — `{ type: 'text', text }` is enough). The canonical value is execution-local; a PTC program can read it, the conversation cannot. Therefore render text must carry every fact the model needs: revision, counts, created/updated ids, and an actionable failure message.
- Failure: `throw new Error('canvas: node 42 does not exist')` → durable result `{ content: [{ type: 'text', text: 'Error: …' }], isError: true, error: { message } }` **[V]** `lib/index.js:3712-3726`. Do not try to return `{ isError: true }`; there is no such return shape.
- Token budget: result content is resent on every later request until compaction. Keep it under ~4 KB; return a summary + `revision` and keep the full document in plugin storage (`docs/storage.md`). Never dump the whole canvas JSON.
- Oversize fallback only if unavoidable: this deployment mounts `ctx.spillStore` (`saveText({ owner: { sessionId }, source: { kind: 'tool', toolName, callId, label }, suggestedName, content }) → { locator, bytes, retrievalHint }`) and the `toolResultPruner` service exists in the Host catalog; do not depend on either — cap text in `render` first.
- `exec` (2nd `execute` arg) = `ToolRunContext`: `callId`, `rootCallId`, `name`, frozen `arguments`, optional `agent` (⇒ `agent.session.id`), optional `parent`, `signal` (cooperative cancellation), `deferContext(userMessage)`, `concludeTurn()`. Do not call `concludeTurn()` from canvas tools; `deferContext` is only for extra user-role context.
- Cheap model continuity: the §3 dynamic section can expose `revision`/node count each step, so the model does not need a read tool call before editing; include `revision` in the tool parameters for optimistic-concurrency checks if concurrent edits matter.

## 8. Open items / uncertainty

1. Client inspect (`Slots`, `Theme`, `Builtin`, client `Service`) times out in this session even with a live page — exact `tool.call.toolview` TS prop fields and Client `inject` service names were taken from READMEs and `agent-ui`'s source reads **[T]**; re-verify when inspection answers.
2. `ctx.remote.commands.execute` requires a client-side Agent handle; not proven from a panel component. RPC channel / fetch route avoid the issue and are preferred.
3. RPC channel and exact Fetch route were verified as mechanisms in shipped plugins, not yet exercised from a third-party bundle in this profile; first install should smoke-test `rpc.call` and disposal on HMR/unload.
4. `timeoutMs` is declarative only; enforce your own deadline with `exec.signal` if a canvas operation can hang.
