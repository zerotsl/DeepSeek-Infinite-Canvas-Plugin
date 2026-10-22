# Durable storage — infinite canvas (Host)

Verified against installed DSH `0.2.1-rc.2` (Desktop, profile `desktop`) on 2026-10-21. Scope: the plugin-owned
CanvasDoc (`packages/infinite-canvas/model.js`) — global, 10–200 KB, many writes/min while dragging, durable
across Host restarts and plugin upgrades.

## Recommendation

Use the shipped **domain data form** exactly as `dsh-workspace` / `dsh-session-projection-cache` do:
`ctx.storageDomain.open(spec)` → one `Domain`; one table record holds the whole CanvasDoc.

- Spec: name `infinite_canvas`, `version: 1`, `layout: 'single'`, table `scenes` (`domainTable(z.unknown())`).
- Disk (this profile): `E:\T\T...\.dsh\storages\infinite_canvas.json` (pretty-printed JSON).
- Writes are atomic (tmp → fsync → rename; POSIX parent-dir fsync), durable before the promise resolves,
  serialized by the domain's one write chain, emitted as `domain/changed`.
- No approvals, no `ctx.fs` sandbox, no profile-file edits, no Session dependency. The file lives outside the
  profile and its `node_modules`; app upgrades replace only `app.asar`, and plugin manager restoration rewrites
  only the profile's `package.json`/`pnpm-lock.yaml` — restarts and reinstall/upgrade keep the document.
- `store.js` debounces 200 ms, one write in flight; the `ctx.effect` disposer flushes then closes the domain.
  Fallback when the service is absent: plain `node:fs` under `$DSH_HOME/canvas/` (section 6).

## 1. Live profile facts (verified)

| Fact | Value | Evidence |
|---|---|---|
| storage hub / JSON backend rows | mounted; `root: !!js dshHomePath('storages')` | `@deepseek-ai/dsh-base/cordis.patch.yml:179-185` |
| domain form row | `backend: json`, `routes: {}` | same file `:187-190` |
| `ctx.storageDomain` | live service | `cordis_inspect_query` → `Service.listService` catalog |
| resolved `$DSH_HOME` | `E:\T\T...\.dsh` | profile at `...\.dsh\profiles\desktop`; live data below |
| live data | `storages\workspace.json`, `storages\session_projcache\sessions\*.json` | direct directory read |

`root` is required (`dsh-storage-json/lib/index.js:551`), so the backend never falls back to `process.cwd()`.
`$DSH_HOME` resolves explicit path → `$DSH_HOME` → `~/.dsh` (`dsh-home-paths/lib/index.js:109-134`), blank
values ignored. Which backend serves a domain is the domain plugin's `backend`/`routes` config, not the hub's.

## 2. Domain contract (source-verified)

```js
// DomainSpec; defineDomain() validates name/version/layout at module load (:61-91)
{ name: 'infinite_canvas',           // ^[a-z][a-z0-9_]*$; also the unit file name
  version: 1,                        // storage format version, stamped into the medium
  layout: 'single',                  // optional (default 'single'); or 'per-record'
  compatibleVersions: [/*older*/],   // per-record only: accept older stamps when opening
  invalidRecords: 'backup-and-skip', // optional, per-record only
  global: { schema, initial },       // optional singleton slot (unused here)
  tables: { scenes: domainTable(zodSchema) } }   // domainTable(s) === { valueSchema: s }
```

`Domain`: `name`; `table(n)` → `{ get(key) /* sync, memory */, entries(), keys(), size, put(key, v) /* durable
before resolve */, delete(key), update(key, fn) /* fn runs on the write chain */ }`; optional
`global.get()/set(v)`; `close()` (idempotent; drains queued writes).

- Readers are synchronous from validated in-memory state; each write is backend-durable first, then memory, then
  `domain/changed` (`{domain, table, key, operation, value?}` — in-process only, not a UI push).
- **One write chain per domain**: `put`/`delete`/`update`/`global.set` queue; concurrent `update` transforms never
  interleave; `update` on an absent key throws `DomainError('missing-key')`.
- Stable codes: `already-open` (single-open per domain name), `facet-unsupported`, `invalid-record`, `missing-key`,
  `closed`; backend errors pass through (`backend-not-found`, `version-mismatch`, `malformed-medium`). The caller
  owns the handle and closes it; the facility closes leftovers on unmount.
- `ctx.storageDomain` and `ctx.storage.domain` are the same facility (the hub's `domain` getter returns the mounted
  form). Do not call `ctx.storage.backend.get('json').kv.open(...)` directly: it skips validation and change events
  and forces you to order writes yourself.
- `single` layout: `<root>/<name>.json` = `{"unit":{"name","version"},"global":null,"tables":{...}}` (record at
  `tables.scenes.main`); each write rewrites the file; malformed JSON or another version stamp **rejects open
  loudly** (data kept). `per-record`: `<root>/<name>/<table>/<key>.json` = `{"version","record"}`, safe keys
  `[a-zA-Z0-9_-]+`; a malformed/stale document reads as *absent*; `compatibleVersions` admits old stamps.
- Durability/concurrency (`dsh-storage-json/lib/index.js:25-52`): same-dir `.<uuid>.tmp` opened exclusively,
  `fsync`, `rename` over target (Windows `MoveFileExW` replace), POSIX parent-dir fsync; Windows has no explicit
  write-through (README limitation). A write resolves only after publication. The backend does not order writes
  (the domain chain does) and has **no cross-process lock** — two Host instances on one unit are
  last-completion-wins; one process per profile is the design point.

Keep spec version **1 forever** with `single` (it has no `compatibleVersions` migration); the app document version
is `doc.schema` (`model.js`), migrated in `load()`. `per-record` is only worth it for several independent canvases
or domain-version-compatible bumps — but there a corrupt/stale doc is silently absent.

## 3. `store.js` (Host ESM, plain JS)

```js
import { z } from 'zod';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { homedir } from 'node:os'; import { join } from 'node:path';
import { createDoc, SCHEMA_VERSION } from './model.js';

const DOMAIN = 'infinite_canvas', TABLE = 'scenes', KEY = 'main';
// The record is user content: the schema validates nothing; upgrade-safe shape checks/migrations run in
// load(), so a future document shape can never make open() reject previously stored data.
export const canvasDomainSpec = defineDomain({
  name: DOMAIN, version: 1, layout: 'single', tables: { [TABLE]: domainTable(z.unknown()) },
});

export function openCanvasStore(ctx, options = {}) {
  const debounceMs = options.debounceMs ?? 200;
  const location = join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'storages', `${DOMAIN}.json`);
  let domain, table, pending = null, timer = null, writing = null, waiters = [], closed = false;
  const ready = (async () => {
    domain = await ctx.storageDomain.open(canvasDomainSpec); table = domain.table(TABLE);
  })();
  ready.catch(() => {});                       // surfaced by load/save/close; logged by index.js
  const kick = () => {                         // one write in flight; a newer save() supersedes an older one
    if (writing !== null || pending === null) return writing;
    const doc = pending; pending = null; const batch = waiters; waiters = [];
    writing = (async () => {
      try { await ready; await table.put(KEY, doc); batch.forEach((w) => w.resolve()); }
      catch (error) { batch.forEach((w) => w.reject(error)); }
      finally { writing = null; if (pending !== null && timer === null) kick(); }
    })();
    return writing;
  };
  return {
    location, ready,
    get current() { return table?.get(KEY); }, // stored object: do not mutate in place
    save(doc) {                                // debounced; resolves after the covering durable write
      if (closed) return Promise.reject(new Error('canvas store is closed'));
      pending = structuredClone(doc);
      if (timer === null) timer = setTimeout(() => { timer = null; kick(); }, debounceMs);
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
    async load() {
      await ready;
      let doc = table.get(KEY);
      if (doc === undefined) { doc = createDoc(); await table.put(KEY, doc); }
      if (doc === null || typeof doc !== 'object' || typeof doc.schema !== 'number') throw new TypeError('canvas: invalid stored doc');
      if (doc.schema > SCHEMA_VERSION) throw new Error('canvas: stored doc is newer than this plugin');
      // if (doc.schema < SCHEMA_VERSION) migrate here
      return structuredClone({ ...doc, schema: SCHEMA_VERSION });
    },
    // CAS: for read-modify-write across writers use `table.update(KEY, (current) => ...)`, whose transform
    // runs at a serialized chain slot; `save()` above is last-writer-wins on the whole document.
    async close() {                            // ctx.effect disposer: flush, then release the domain
      if (closed) return; closed = true;
      if (timer !== null) { clearTimeout(timer); timer = null; }
      while (pending !== null || writing !== null) { kick(); if (writing !== null) await writing.catch(() => {}); }
      if (domain !== undefined) await domain.close();
    },
  };
}
```

`index.js` wiring — the effect owns the store's lifetime and shares it via `ctx.canvasStore`:

```js
import { openCanvasStore } from './store.js';
export const inject = ['storageDomain'];   // live here; absent service => plugin stays inert
export function apply(ctx) {
  ctx.effect(() => {
    const store = openCanvasStore(ctx); ctx.provide('canvasStore', store);
    store.ready.catch((error) => ctx.logger.error('infinite-canvas: store unavailable: %s', String(error)));
    return () => store.close();
  }, 'infinite-canvas.store');
}
```

## 4. Write frequency, durability, failure notes

- Coalescing: 200 ms trailing debounce plus one in-flight write turns a 60 Hz drag into ≤ ~5 whole-file writes/s;
  `save()` resolving means fsynced + renamed; a hard kill loses only the debounce window.
- Keep the file bounded: `model.js` caps items/text, but `image.src` data URLs can reach 3 MB each and the whole
  file is rewritten per save — consider stripping inline image bytes to hold the doc near ≲ 2 MB.
- Atomic replace prevents partial files. A hand-edited/corrupt file makes `single` open throw `malformed-medium`;
  log it and run without the store — never overwrite it with an empty canvas. Do not set `invalidRecords`
  (per-record only). A reload can surface `already-open` only if the previous `close()` did not finish; restart
  clears it.

## 5. Alternatives and why they lose

| Option | Verdict | Reason |
|---|---|---|
| `ctx.storageDomain.open` | **use** | Validated, atomic+durable, serialized updates, no approvals, DSH-owned medium |
| `ctx.storage.form('domain')` / `ctx.storage.domain` | same object | The hub's `domain` getter returns the mounted form |
| `ctx.storage.backend.get('json').kv.open(...)` | no | Skips validation/events; serialize and version by hand |
| `@deepseek-ai/dsh-storage-json` directly | medium under section 3 | Root `$DSH_HOME/storages`; never hand-edit it |
| plain `node:fs` under `$DSH_HOME` | fallback (section 6) | Works durably, but atomicity, ordering, versioning are yours |
| `ctx.fs.writeText` | no | Sandboxed provider denies writes outside the workspace by default |
| `ctx.workingDirectory` / workspace file | no | Per-Session service; the canvas is global to all sessions/workspaces |

`ctx.fs.writeText` exact shape (`Service.listService("fs")`, `dsh-fs-sandbox/lib/index.js:153-166`):
`writeText(target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal, sandboxPolicy?:
SandboxExecutionPolicy)`; target from `await ctx.fs.resolve(path)`; intent `{kind:'createIfAbsent'}` or
`{kind:'replaceIfVersion', version}`; outcome `{operation, version, before, after}`; policy `{mode, workspaceRoot,
sessionId?}`. The live provider is `SandboxedFileSystem`: omitting the policy resolves the deployment default via
`ctx.sandboxPolicy.resolve()` (shipped default `workspace-write`, workspace root = boot-time `process.cwd()`), so
writing `$DSH_HOME` throws `FS_SANDBOX_DENIED`; only a self-declared `danger-full-access` policy would pass,
which plugin code must not do. `ctx.workingDirectory` exposes `defaultDirectory`/`get(session)`/`ensure(agent)`/
`set(agent, path)` — nothing usable without a Session.

## 6. Fallback when the composition has no storage-domain

Same `{ load, save, close, location }` contract over `$DSH_HOME/canvas/scene.json`, using only `node:fs`; reuse
the debounce/coalescing loop from `store.js` and swap the domain `table` for this file-backed one:

```js
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto'; import { homedir } from 'node:os'; import { join } from 'node:path';
const dir = join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'canvas'), file = join(dir, 'scene.json');
async function writeAtomic(value) {               // storage-json's protocol: tmp -> fsync -> rename
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${randomUUID()}.tmp`), fh = await open(tmp, 'wx', 0o600);
  try { await fh.writeFile(JSON.stringify(value, null, 2), 'utf8'); await fh.sync(); } finally { await fh.close(); }
  await rename(tmp, file);
  if (process.platform !== 'win32') { const d = await open(dir, 'r'); try { await d.sync(); } finally { await d.close(); } }
}
// load: readFile + JSON.parse (ENOENT => createDoc()), then the same schema checks/migration as store.js.
```

Select in `apply`: `const store = ctx.get('storageDomain') !== undefined ? openCanvasStore(ctx) :
openCanvasStoreOnDisk(ctx)`. This profile mounts the storage rows before the bundle's rows (bundle order starts
with `dsh-base`), so domain mode is the default; use the disk form only for compositions without the storage
stack or as an emergency run. Never keep this data in the plugin package, the profile directory, or a workspace
directory: installs, sanitize, and workspace changes rewrite or move those.

## 7. Bundle imports and post-install checklist

`zod` and `@deepseek-ai/dsh-storage-domain` ship with the installation. For a `link:`-installed workspace bundle,
list both in the manifest so DSH's runtime resolution admits them (`@deepseek-ai/dsh-app-boot` README "Linked
directories"); `*` avoids pinning the DSH version: `"peerDependencies": { "@deepseek-ai/dsh-storage-domain": "*",
"zod": "*" }`. If those imports still fail, use this import-free, runtime-compatible spec (the installed `open()`
only calls `valueSchema.parse()` during load validation):

```js
const canvasDomainSpec = { name: 'infinite_canvas', version: 1, layout: 'single',
  tables: { scenes: { valueSchema: { parse: (value) => value } } } };
```

Check after install: (1) the `@local/infinite-canvas` row is active in `Config.listConfigs`; (2) after the first
save `E:\T\T...\.dsh\storages\infinite_canvas.json` exists with
`"unit":{"name":"infinite_canvas","version":1}`; (3) quit and relaunch Desktop and confirm `state`/`canvas_read`
returns the same `rev` and items; (4) reinstall the bundle and confirm the file is untouched. Changing the domain
format requires migrating that file by hand — keep a backup before ever shipping such a change.
