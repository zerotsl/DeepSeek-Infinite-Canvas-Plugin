# Install & post-install verification — `@local/infinite-canvas`

Read-only audit of `E:\T\T...\packages\infinite-canvas` (package.json, cordis.patch.yml, index.js,
model.js, store.js, client.js, locale/{en,zh}.json, icon.svg) against installed DSH `0.2.1-rc.2`.
**Audit result: no blocking installation or Host-activation defect found.** The bundle matches the
template manifest/patch/client-module format; all Host registrations match verified contracts. Section 9
lists robustness issues that do not block install but would change what you observe during verification.

## 0. Baseline before install (verified 2026-10-21 ~21:07)

- `cordis_inspect_query` host `Config.listConfigs {"name":"@local/infinite-canvas"}` → `total: 0`.
- `cordis_inspect_query` host `Tool.listTools` → no `canvas_*` tool present.
- `E:\T\T...\.dsh\storages\infinite_canvas.json` → absent (correct: created on first use).

## 1. Install

Exact call (needs Full access or an approved `plugin_manager` call; approval does not change session mode):

```json
{"action":"install_bundle","target":"E:\\T\\T...\\packages\\infinite-canvas"}
```

- Local directory installs as a `link:` bundle. The package has **no dependencies, no install scripts, no
  build step** (plain ESM: `index.js`, `client.js`, `model.js`, `store.js`), so expect **no `pendingBuilds`**;
  never pass `approvedBuilds` here.
- Expected result: `application: "applied"`, `warnings: []`, and in `packageResult`:
  `kind` (success), `bundle: "@local/infinite-canvas"`, `version: "1.0.0"`. If `application:`
  `"restart-required"`, quit the Desktop app completely (including tray/background process), relaunch, then
  continue from §2. `application: "failed"` → read `nextStep` and the diagnostics under
  `E:\T\T...\.dsh\profiles\desktop\.plugin-manager\logs\`; do **not** hand-edit
  `package.json`/`cordis.patch.yml`.
- Optional: `{"action":"list_bundles"}` → the bundle row is `enabled: true`, `meta.title`/`description`
  resolve from `locale/*.json` (zh/en), no `problem`.

## 2. Host activation

Run in this order; each step isolates one layer.

1. **Loader row exists** — `cordis_inspect_query` host `Config.listConfigs {"name":"@local/infinite-canvas"}`
   → expect exactly one entry with `name: "@local/infinite-canvas"`, `id` matching `infinite-canvas` (a
   composed layer may prefix it, e.g. `…:infinite-canvas` — match by `name`), `status: "absent"`. `absent` is
   correct here: the plugin exports no `Config`. Empty result = the bundle patch layer was not applied
   (install not applied/disabled); `status: "inactive"` = row exists but is disabled or failed to activate.
2. **Plugin activated and tools registered** — `cordis_inspect_query` host `Tool.listTools {}` → expect all
   six names: `canvas_read`, `canvas_create`, `canvas_update`, `canvas_delete`, `canvas_connect`,
   `canvas_focus`. The registry is live; a new agent step also sees them in its tool list.
   Missing tools with the row present = the `ctx.inject(['tools'])` child failed (registration throw) — the
   plugin row stays active but canvas tools are absent.
3. **Route + store not yet exercised** — the store opens lazily on first tool/API call; no storage file is
   created by activation alone. Do not expect `infinite_canvas.json` before §3.

## 3. Functional smoke test (proves agent read + write)

1. `canvas_create` → `{"items":[{"type":"note","text":"install smoke"}]}` — expect
   `Created 1 node(s) at revision 1.` (revision N+1 if a stored doc from an earlier install already exists).
   The result lists the new node id.
2. `canvas_read` → plain JSON text containing `title`, `rev: 1` (or N), `items[<id>]` with the note.
3. `canvas_update` → `{"items":[{"id":"<id>","text":"updated by ai"}]}` — expect `Updated 1 node(s)`, and
   `canvas_read` shows the new text.
4. `canvas_focus` → `{"ids":["<id>"]}` — expect `Viewport focused on <id> at revision N`.
5. `canvas_connect` (optional, needs two nodes) → edge id `e_…`; `canvas_delete` → `{"ids":["<id>"]}` removes
   the smoke note (`Deleted 1 item(s); …`).
6. System prompt (optional, next model step): the prompt contains a `## 无限画板 (Infinite Canvas)` section
   with the live `title`, `revision`, node count and viewport centre.

## 4. Durable file location (storage-domain path)

After the first successful mutation, wait ≥1 s (200–220 ms debounce + fsync), then read:

```
E:\T\T...\.dsh\storages\infinite_canvas.json
```

Expected content (pretty-printed JSON, `storage-json` single layout):

```json
{"unit":{"name":"infinite_canvas","version":1},"global":null,
 "tables":{"scenes":{"main":{"schema":1,"id":"default","title":"…","rev":1,
   "updatedAt":"…","viewport":{"cx":…,"cy":…,"zoom":1,"vw":…,"vh":…},
   "focus":null,"items":{"<id>":{…}}}}}}
```

- File absent but `canvas_read` works = domain open/read failed and the plugin is running memory-only
  (look for a Host log line `store unavailable, running in memory only`); data will not survive restart.
- **Fallback file** `E:\T\T...\.dsh\canvas\scene.json` appearing is a warning sign: it means
  `ctx.storageDomain.open()` threw and `store.js` silently switched media (see §9 R1). Host log line:
  `storage domain unavailable, falling back to a file: …`.
- Never create or edit either file by hand.

## 5. Restart persistence

Quit the Desktop app fully (window close may not exit the Host), relaunch, open a session, call `canvas_read`
→ same `rev`, title and items (rev unchanged: load does not write). The storage file's content is unchanged.
This proves the document lives in `$DSH_HOME`, not in the profile/node_modules.

## 6. Reinstall / upgrade persistence

1. `{"action":"remove_bundle","target":"@local/infinite-canvas"}` (approval required) — bundles stop; the
   data file must remain untouched.
2. Re-run the §1 install call, then `canvas_read` → same `rev`/items; no split into the fallback path.
3. Optional: `{"action":"set_bundle","target":"@local/infinite-canvas","enabled":false}` disables the layer;
   `enabled: true` re-enables it. Toggle-off/on is enough to prove the store reopens cleanly (no `already-open`
   surprises); if the tools disappear after re-enable, check `Tool.listTools` again.

## 7. Client half (Web page)

1. Refresh the page after install (HMR usually applies without refresh, refresh removes doubt). The sidebar
   panel list shows an entry labeled `无限画板` (zh) / `Infinite Canvas` (en) with `icon.svg`, order 20.
   No entry = client module did not load/activate.
2. Click it → the center area shows the canvas surface: toolbar, dot grid, and the empty state
   `让 DeepSeek 和你一起画` / `Draw with DeepSeek`. A blank area or the conversation remaining visible = the
   `main` slot entry is missing/crashed; check browser DevTools console for `slot entry crashed in 'main'`
   or `Failed to load … client.js`.
3. With the panel open, DevTools Network shows `POST /api/canvas.doc` returning `200` every ~700 ms
   (`{"ok":true,"value":{…}}`). A 404 means the Host fetch route is not registered (Host activation issue);
   `401/403` means page authentication/cookie problem, not the bundle.
4. Client-side slot check (if client inspect answers): `cordis_inspect_query` client `Slots.listSubTree`
   with `{"root":"main"}` → an entry with `key: "infinite-canvas"`; with
   `{"root":"sidebar.panellist"}` → `id: "infinite-canvas"`, `order: 20`, label resolved in the active locale.
   If client inspect times out, judge from §7.1–§7.3 only.
5. **Detecting a client bundle load failure "in the plugin row":** the Host-side plugin/bundle row cannot see
   the browser half — it only proves the package and patch. The client half's load failure surfaces in three
   places: (a) missing sidebar entry or blank panel; (b) browser console/module-loader errors
   (`… client.js`, `slot entry crashed`); (c) **Settings → Plugins → Plugin list**, which lists page-local
   synchronization failures with a **Retry** button (retry only; Host enablement is unchanged). A loaded but
   inactive client module shows as no slot entries in `Slots.listSubTree` while `Tool.listTools` and
   `canvas_read` still work — that split means browser-half failure, not Host failure.

## 8. Symptom → cause → action

| Symptom | Likely cause | Action |
|---|---|---|
| Install `failed` before pnpm runs | local manifest/patch invalid or path unreadable | Re-read package.json/cordis.patch.yml; check `nextStep`/logs |
| Install `restart-required` | no HMR / startup-only profile | Restart the Desktop app, then §2 |
| No `Config.listConfigs` entry | bundle not selected/applied | `list_bundles`; re-install; check `skippedBundles` in startup log |
| Row active, no `canvas_*` tools | `tools` registration threw in the inject callback | Host log; likely an output-schema change (OUTPUT_SCHEMA is the only validated schema) |
| Tools work, no sidebar entry | client module load/registration failure | Browser console + Settings → Plugins retry (§7.5); verify `dsh.client` block and `client.js` id |
| Sidebar entry, blank/crashed panel | component error while rendering `main` | Console stack; slot registration key vs `selectPanel` id must both be `infinite-canvas` |
| Panel toast `无法连接画板服务 (state)` / HTTP 404 | `/api/canvas.doc` route missing | Host activation/route registration; `Tool.listTools` to confirm plugin state |
| No storage file after first save | domain open failed (memory-only) or store not reached | Host log `store unavailable`; check `storageDomain` service and `storage-json` root |
| Fallback file `$DSH_HOME\canvas\scene.json` exists | `ctx.storageDomain.open()` threw (spec version mismatch, `already-open`, backend error) | See §9 R1; data may be split — report before further testing |
| Canvas empty after restart | writes went to fallback or store closed before flush | Check both files; Host log `save failed` / `close failed` |

## 9. Findings from the read-only audit (do not block install; watch during verification)

- **R1 (data safety, high)** `store.js:185-188`: any `domain.open()` error (not only a missing service) falls
  back to the file medium. An old file written by a **different domain spec version** makes `single` layout
  open throw `version-mismatch`; the plugin then starts blank from the fallback file while the real document
  stays in `storages\infinite_canvas.json` (looks like data loss). Same split after an HMR reload that hits
  `already-open`. Fix: fall back only when `ctx.get('storageDomain')` is `undefined`; on an open error, log
  and run memory-only (index.js already has that path) instead of switching media.
- **R2 (leak, medium)** `index.js:90-101`: if `createCanvasStore()` succeeds but `store.load()` throws, the
  catch sets `runtime.store = null` without `close()`, leaving the domain open; the next activation/HMR then
  sees `already-open` and (with R1) splits media. Fix: `await runtime.store?.close()` in that catch.
- **R3 (prompt assembly, medium)** `index.js:534-555`: the section text embeds `JSON.stringify(doc.title)`
  with default `interpolate: true`; a user/agent title containing `{{…}}` makes strict interpolation throw
  at every prompt assembly. Fix: add `interpolate: false` to `systemPrompt.section({...})`.
- **R4 (docs only)** `store.js:26-30` comment claims `canvasDataLocation()` is also where the storage-domain
  backend writes; the real domain path is `$DSH_HOME\storages\infinite_canvas.json` (fallback only uses
  `$DSH_HOME\canvas\scene.json`). `docs/protocol.md` shows viewport `{x,y,zoom}` while `model.js`/client use
  `{cx,cy,zoom,vw,vh}` — implementation is self-consistent; the protocol doc is stale.

## 10. Rollback

`{"action":"remove_bundle","target":"@local/infinite-canvas"}` (or disable the bundle/row with `set_bundle`
/`set_plugin`). The document file under `$DSH_HOME\storages` is intentionally left in place; removing the
bundle must not delete it. No profile files are edited by hand at any point in this checklist.
