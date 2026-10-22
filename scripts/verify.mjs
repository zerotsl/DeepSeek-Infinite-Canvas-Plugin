/**
 * Offline verification for the infinite-canvas bundle.
 * Runs without the Harness: syntax + module-contract + model + store behaviour.
 * Usage: node scripts/verify.mjs
 */
import assert from 'node:assert/strict';
import { readFile, rm, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const bundle = join(here, '..', 'packages', 'infinite-canvas');
const results = [];
const ok = (name) => results.push({ name, status: 'PASS' });
const fail = (name, error) => {
  results.push({ name, status: 'FAIL', error: String(error?.stack ?? error) });
};

async function check(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (error) {
    fail(name, error);
  }
}

/* ---------------------------------------------------------------- *
 * 1. manifest / locale / icon / files
 * ---------------------------------------------------------------- */
await check('manifest + exports + files', async () => {
  const manifest = JSON.parse(await readFile(join(bundle, 'package.json'), 'utf8'));
  assert.equal(manifest.type, 'module');
  assert.ok(manifest.exports['.'], 'exports["."]');
  assert.ok(manifest.exports['./client'], 'exports["./client"]');
  assert.ok(manifest.exports['./locale/*.json'], 'locale export');
  assert.ok(manifest.exports['./icon'], 'icon export');
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.equal(manifest.dsh.client.immediately, true);
  assert.ok(Array.isArray(manifest.dsh.client.inject));
  for (const relative of [
    manifest.exports['.'],
    manifest.exports['./client'],
    manifest.exports['./icon'],
    manifest.dsh.bundle.patch,
    'locale/zh.json',
    'locale/en.json',
  ]) {
    assert.ok(existsSync(join(bundle, relative)), `missing file ${relative}`);
  }
  for (const file of manifest.files) {
    if (file.includes('*')) continue;
    assert.ok(existsSync(join(bundle, file)), `files[] entry missing on disk: ${file}`);
  }
  for (const language of ['zh', 'en']) {
    const locale = JSON.parse(await readFile(join(bundle, 'locale', `${language}.json`), 'utf8'));
    assert.ok(locale.meta?.title, `${language} meta.title`);
    assert.ok(locale.meta?.description, `${language} meta.description`);
  }
  const icon = await readFile(join(bundle, 'icon.svg'), 'utf8');
  assert.ok(icon.trimStart().startsWith('<svg'), 'icon.svg starts with <svg');
  assert.ok(icon.trimEnd().endsWith('</svg>'), 'icon.svg ends with </svg>');
  assert.ok(!/&(?![a-zA-Z#])/.test(icon), 'icon.svg has no bare ampersands');
  assert.ok(Buffer.byteLength(icon) < 256 * 1024, 'icon under 256 KiB');
  const patch = await readFile(join(bundle, 'cordis.patch.yml'), 'utf8');
  assert.match(patch, /- insert:/);
  assert.match(patch, new RegExp(`name: '${manifest.name}'`));
});

/* ---------------------------------------------------------------- *
 * 2. model behaviour
 * ---------------------------------------------------------------- */
const now = '2026-10-21T00:00:00.000Z';
let model;
await check('import model.js', async () => {
  model = await import(pathToFileURL(join(bundle, 'model.js')).href);
});
if (model) {
  await check('model: createDoc + upsert', async () => {
    const doc = model.createDoc(now);
    assert.equal(doc.rev, 0);
    const result = model.applyOps(doc, [{ op: 'upsert', item: { type: 'note', text: 'hi', x: 10, y: 20 } }], 'ai', now);
    assert.equal(result.doc.rev, 1);
    assert.equal(result.applied.length, 1);
    assert.equal(result.applied[0].item.by, 'ai');
    assert.equal(result.applied[0].item.w, 280);
  });
  await check('model: edges + cascade delete + errors', async () => {
    let doc = model.createDoc(now);
    let step = model.applyOps(doc, [{ op: 'upsert', item: { type: 'note', text: 'a', x: 0, y: 0 } }], 'ai', now);
    doc = step.doc;
    const a = step.applied[0].item.id;
    step = model.applyOps(doc, [{ op: 'upsert', item: { type: 'note', text: 'b', x: 300, y: 0 } }], 'ai', now);
    doc = step.doc;
    const b = step.applied[0].item.id;
    step = model.applyOps(doc, [{ op: 'upsert', item: { type: 'edge', from: a, to: b, label: 'then' } }], 'ai', now);
    doc = step.doc;
    assert.equal(Object.keys(doc.items).length, 3);
    const deleted = model.applyOps(doc, [{ op: 'delete', id: a }], 'ai', now);
    assert.equal(deleted.applied.length, 2, 'node + attached edge removed');
    assert.equal(Object.keys(deleted.doc.items).length, 1);
    const patchMissing = model.applyOps(deleted.doc, [{ op: 'patch', id: 'nope', patch: { text: 'x' } }], 'ai', now);
    assert.equal(patchMissing.errors.length, 1);
    assert.equal(patchMissing.doc.rev, deleted.doc.rev, 'failed op does not bump revision');
    const invalid = model.applyOps(deleted.doc, [{ op: 'upsert', item: { type: 'bogus' } }], 'ai', now);
    assert.equal(invalid.errors.length, 1);
  });
  await check('model: syncPayload delta vs full', async () => {
    const doc = model.createDoc(now);
    doc.rev = 5;
    const log = [{ rev: 5, ops: [{ op: 'upsert', item: { id: 'x' } }], by: 'ai', at: 1 }];
    const delta = model.syncPayload(doc, log, 4);
    assert.equal(delta.full, false);
    assert.equal(delta.ops.length, 1);
    const full = model.syncPayload(doc, log, 0);
    assert.equal(full.full, true);
    assert.ok(full.items);
    const noop = model.syncPayload(doc, log, 5);
    assert.equal(noop.full, false);
    assert.equal(noop.ops, undefined);
  });
  await check('model: placeItems + summarizeDoc + focusViewport', async () => {
    let doc = model.createDoc(now);
    let step = model.applyOps(doc, [{ op: 'upsert', item: { type: 'note', text: 'first', x: 0, y: 0 } }], 'ai', now);
    doc = step.doc;
    const placements = model.placeItems(doc, 3);
    assert.equal(placements.length, 3);
    assert.ok(placements[0].x > 200, 'placement continues to the right of existing content');
    const summary = model.summarizeDoc(doc, { limit: 10 });
    assert.equal(summary.total, 1);
    assert.equal(summary.nextCursor, null);
    assert.ok(Number.isFinite(summary.viewport.visibleWorld.w));
    const target = model.focusViewport(doc, { ids: [Object.keys(doc.items)[0]] });
    assert.ok(target && Number.isFinite(target.cx) && target.zoom >= 0.1 && target.zoom <= 4);
    assert.equal(model.focusViewport(doc, { ids: ['missing'] }), null);
  });
  await check('model: syncPayload dead-end and restart safety', async () => {
    const doc = model.createDoc(now);
    doc.rev = 5;
    // a client that claims a newer revision than the host must get a full resync
    assert.equal(model.syncPayload(doc, [], 9).full, true);
    // an empty log (fresh Host restart) with since < rev must also resync fully
    assert.equal(model.syncPayload(doc, [], 2).full, true);
    // since === rev with an empty log stays a cheap no-op
    const same = model.syncPayload(doc, [], 5);
    assert.equal(same.full, false);
    assert.equal(same.ops, undefined);
  });
  await check('model: inline data URLs are bounded', async () => {
    const big = `data:image/png;base64,${'A'.repeat(300000)}`;
    const small = 'data:image/png;base64,AAAA';
    const doc = model.createDoc(now);
    const result = model.applyOps(
      doc,
      [
        { op: 'upsert', item: { type: 'image', src: big, x: 0, y: 0 } },
        { op: 'upsert', item: { type: 'image', src: small, x: 300, y: 0 } },
        { op: 'upsert', item: { type: 'image', src: 'javascript:alert(1)', x: 600, y: 0 } },
      ],
      'ai',
      now,
    );
    const sources = result.applied.map((op) => op.item.src);
    assert.equal(sources[0], '', 'oversized inline image dropped');
    assert.equal(sources[1], small, 'small inline image kept');
    assert.equal(sources[2], '', 'non-http/data source rejected');
  });
  await check('model: edge geometry and frameId clearing', async () => {
    const doc = model.createDoc(now);
    const result = model.applyOps(
      doc,
      [{ op: 'upsert', item: { type: 'edge', from: 'a', to: 'b' } }],
      'ai',
      now,
    );
    assert.equal(result.applied[0].item.w, 0);
    assert.equal(result.applied[0].item.h, 0);
  });
  await check('model: freehand strokes', async () => {
    const doc = model.createDoc(now);
    const result = model.applyOps(
      doc,
      [{ op: 'upsert', item: { type: 'stroke', x: 100, y: 200, points: [[0, 0], [10, 20], [30, 40]], width: 4 } }],
      'ai',
      now,
    );
    const stroke = result.applied[0].item;
    assert.equal(stroke.type, 'stroke');
    assert.equal(stroke.w, 30, 'bbox width from points');
    assert.equal(stroke.h, 40, 'bbox height from points');
    assert.equal(stroke.width, 4);
    assert.equal(stroke.points.length, 3);
    const moved = model.applyOps(result.doc, [{ op: 'patch', id: stroke.id, patch: { x: 300, y: 400 } }], 'ai', now);
    assert.equal(moved.doc.items[stroke.id].x, 300);
    assert.deepEqual(moved.doc.items[stroke.id].points, [[0, 0], [10, 20], [30, 40]], 'points stay relative when moved');
    const invalid = model.applyOps(result.doc, [{ op: 'upsert', item: { type: 'stroke', points: [] } }], 'ai', now);
    assert.equal(invalid.errors.length, 1, 'empty stroke rejected');
    const summary = model.summarizeDoc(result.doc, {});
    assert.equal(summary.items[0].points, 3, 'summary reports the point count');
  });
  await check('model: agent task cards', async () => {
    const doc = model.createDoc(now);
    const created = model.applyOps(
      doc,
      [{ op: 'upsert', item: { type: 'agent', text: 'Agent1', task: '拆分需求', status: 'running' } }],
      'user',
      now,
    );
    const agent = created.applied[0].item;
    assert.equal(agent.type, 'agent');
    assert.equal(agent.status, 'running');
    assert.equal(agent.task, '拆分需求');
    const patched = model.applyOps(created.doc, [{ op: 'patch', id: agent.id, patch: { status: 'done', agentResult: '完成' } }], 'ai', now);
    assert.equal(patched.doc.items[agent.id].status, 'done');
    assert.equal(patched.doc.items[agent.id].agentResult, '完成');
    const summary = model.summarizeDoc(patched.doc, {});
    assert.equal(summary.items[0].status, 'done');
    assert.equal(summary.items[0].task, '拆分需求');
    const invalid = model.applyOps(doc, [{ op: 'upsert', item: { type: 'agent', status: 'bogus' } }], 'user', now);
    assert.equal(invalid.applied[0].item.status, 'idle', 'invalid status normalized');
    assert.equal(invalid.applied[0].item.w, 440, 'default agent card is born bigger (w)');
    assert.equal(invalid.applied[0].item.h, 340, 'default agent card is born bigger (h)');
    const defaultNote = model.applyOps(doc, [{ op: 'upsert', item: { type: 'note', text: '默认便签' } }], 'user', now);
    assert.equal(defaultNote.applied[0].item.w, 280, 'default sticky note is born bigger (w)');
    assert.equal(defaultNote.applied[0].item.h, 200, 'default sticky note is born bigger (h)');
    const withRole = model.applyOps(
      doc,
      [{ op: 'upsert', item: { type: 'agent', text: '研究员', task: '设计访谈', role: '# 角色\n你是一位研究员', output: 'document' } }],
      'user',
      now,
    );
    assert.equal(withRole.applied[0].item.output, 'document', 'document output mode stored');
    assert.ok(withRole.applied[0].item.role.includes('用户研究员') || withRole.applied[0].item.role.includes('研究员'));
    const rolePatched = model.applyOps(withRole.doc, [{ op: 'patch', id: withRole.applied[0].item.id, patch: { role: '# 角色\n你是产品经理', output: 'canvas' } }], 'user', now);
    assert.equal(rolePatched.doc.items[withRole.applied[0].item.id].role, '# 角色\n你是产品经理');
    assert.equal(rolePatched.doc.items[withRole.applied[0].item.id].output, 'canvas');
    const describedRole = model.describeItem(rolePatched.doc.items[withRole.applied[0].item.id]);
    assert.ok(String(describedRole.role).includes('产品经理'), 'role shown in describeItem');
    const projectAgent = model.applyOps(
      created.doc,
      [{ op: 'upsert', item: { type: 'agent', text: '子Agent', task: '做小程序', project: '小程序', parentId: agent.id } }],
      'ai',
      now,
    );
    assert.equal(projectAgent.applied[0].item.project, '小程序', 'project name stored on the child agent');
    assert.equal(projectAgent.applied[0].item.parentId, agent.id, 'parent agent id stored');
    const describedChild = model.describeItem(projectAgent.applied[0].item);
    assert.equal(describedChild.project, '小程序', 'describeItem exposes the project');
    assert.equal(describedChild.parentId, agent.id, 'describeItem exposes the parent');
    const detached = model.applyOps(
      projectAgent.doc,
      [{ op: 'patch', id: projectAgent.applied[0].item.id, patch: { parentId: '' } }],
      'ai',
      now,
    );
    assert.equal(detached.doc.items[projectAgent.applied[0].item.id].parentId, null, 'empty parentId clears to null');
  });
  await check('model: animated GIF inline budget', async () => {
    const gif = `data:image/gif;base64,${'A'.repeat(500000)}`;
    const withGif = model.applyOps(model.createDoc(now), [{ op: 'upsert', item: { type: 'image', src: gif, x: 0, y: 0 } }], 'ai', now);
    assert.equal(withGif.applied[0].item.src, gif, 'large animated GIF kept');
    const png = `data:image/png;base64,${'A'.repeat(500000)}`;
    const withPng = model.applyOps(model.createDoc(now), [{ op: 'upsert', item: { type: 'image', src: png, x: 0, y: 0 } }], 'ai', now);
    assert.equal(withPng.applied[0].item.src, '', 'oversized static PNG still dropped');
  });
  await check('model: title/focus/viewport ops and log bounds', async () => {
    const doc = model.createDoc(now);
    const titled = model.applyOps(doc, [{ op: 'title', title: '  我的画板  ' }], 'user', now);
    assert.equal(titled.doc.title, '我的画板');
    const focused = model.applyOps(titled.doc, [{ op: 'focus', cx: 100, cy: -50, zoom: 9 }], 'ai', now);
    assert.equal(focused.doc.focus.zoom, 4, 'zoom clamped');
    const viewport = model.applyOps(focused.doc, [{ op: 'viewport', viewport: { cx: 1, cy: 2, zoom: 0.5, vw: 800, vh: 600 } }], 'user', now);
    assert.equal(viewport.doc.viewport.zoom, 0.5);
    let log = [];
    for (let index = 1; index <= 600; index += 1) log = model.appendLog(log, { rev: index, ops: [], by: 'ai', at: index });
    assert.equal(log.length, 400);
    assert.equal(log[log.length - 1].rev, 600);
  });
}

/* ---------------------------------------------------------------- *
 * 3. store behaviour (file fallback; domain branch needs the Host)
 * ---------------------------------------------------------------- */
await check('store: file fallback load/save/close', async () => {
  const temporaryHome = join(here, '..', '.verify-home');
  await rm(temporaryHome, { recursive: true, force: true });
  await mkdir(temporaryHome, { recursive: true });
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = temporaryHome;
  try {
    const storeModule = await import(pathToFileURL(join(bundle, 'store.js')).href);
    assert.equal(storeModule.canvasDataLocation(), join(temporaryHome, 'canvas', 'scene.json'));
    const ctxStub = { get: () => undefined };
    const messages = [];
    const store = await storeModule.createCanvasStore(ctxStub, (message) => messages.push(message));
    const doc = await store.load();
    assert.equal(doc.rev, 0, 'fresh document');
    const written = await readFile(join(temporaryHome, 'canvas', 'scene.json'), 'utf8');
    assert.equal(JSON.parse(written).schema, 1, 'fresh doc persisted on first load');
    doc.rev = 7;
    doc.title = 'saved';
    await store.save(doc);
    await store.flush();
    const reloaded = JSON.parse(await readFile(join(temporaryHome, 'canvas', 'scene.json'), 'utf8'));
    assert.equal(reloaded.rev, 7);
    assert.equal(reloaded.title, 'saved');
    const again = await store.load();
    assert.equal(again.rev, 7, 'reload sees the saved revision');
    await store.close();
    await assert.rejects(() => store.save(doc), /closed/, 'save after close rejects');
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await rm(temporaryHome, { recursive: true, force: true });
  }
});

/* ---------------------------------------------------------------- *
 * 4. client module contract (syntax + factory + slot registrations)
 * ---------------------------------------------------------------- */
await check('client: parses, factory returns plugin, registers panel + sidebar entry', async () => {
  const source = await readFile(join(bundle, 'client.js'), 'utf8');
  let captured = null;
  const reactStub = {
    createElement: (...args) => ({ type: 'react-element', args }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: null }),
    useMemo: (factory) => factory(),
    useCallback: (fn) => fn,
    createContext: () => ({}),
  };
  const windowStub = { __ModuleLoader__: { load: (definition) => { captured = definition; } } };
  const documentStub = { baseURI: 'http://127.0.0.1:56311/', createElement: () => ({}), head: { appendChild: () => {} } };
  const navigatorStub = { language: 'zh-CN', clipboard: { writeText: async () => {} } };
  const fetchStub = async () => ({ ok: true, json: async () => ({ ok: true, value: {} }) });
  const evaluate = new Function('window', 'document', 'navigator', 'fetch', 'performance', 'requestAnimationFrame', 'ResizeObserver', 'console', source);
  evaluate(windowStub, documentStub, navigatorStub, fetchStub, { now: () => 0 }, () => 0, undefined, { log() {}, error() {}, warn() {} });
  assert.ok(captured, 'module loader registration captured');
  assert.equal(captured.id, '@local/infinite-canvas');
  assert.equal(typeof captured.factory, 'function');
  const plugin = captured.factory((name) => {
    if (name === 'react') return reactStub;
    throw new Error(`unexpected require(${JSON.stringify(name)})`);
  });
  assert.equal(typeof plugin.apply, 'function');
  assert.ok(Array.isArray(plugin.inject));
  assert.ok(plugin.inject.includes('slots'));
  const registrations = [];
  const localeStub = {
    getLocale: () => ({ id: 'zh-CN' }),
    subscribe: () => () => {},
    bind: () => (key) => key,
  };
  const ctxStub = {
    get: (name) => (name === 'locale' ? localeStub : undefined),
    slots: {
      inject: (key, callback) => {
        const disposer = callback();
        return typeof disposer === 'function' ? disposer : () => {};
      },
      register: (options, component) => {
        registrations.push({ options, component });
        return () => {};
      },
    },
  };
  plugin.apply(ctxStub);
  const main = registrations.find((entry) => entry.options.name === 'main');
  assert.ok(main, 'main slot registered');
  assert.equal(main.options.key, 'infinite-canvas');
  assert.equal(typeof main.component, 'function');
  const sidebar = registrations.find((entry) => entry.options.name === 'sidebar.panellist');
  assert.ok(sidebar, 'sidebar.panellist registered');
  assert.equal(sidebar.options.id, 'infinite-canvas', 'sidebar id matches the main key');
  assert.equal(typeof sidebar.options.order, 'number');
  const label = sidebar.options.label();
  assert.equal(typeof label, 'string');
  assert.ok(label.length > 0);
  assert.equal(typeof sidebar.component, 'function');
  const iconProps = { size: 16, active: true };
  const icon = sidebar.component(iconProps);
  assert.ok(icon, 'sidebar icon renders an element');
  // the panel component must be callable React (it is only invoked by the renderer)
  assert.equal(typeof main.component, 'function');
});

/* ---------------------------------------------------------------- *
 * 4b. client render smoke tests (walks the element tree in one pass)
 * ---------------------------------------------------------------- */
const SEED_ITEMS = {
  'seed-note': {
    id: 'seed-note', type: 'note', x: 0, y: 0, w: 240, h: 168, z: 1,
    text: '你好', color: 'yellow', by: 'user', createdAt: 'x', updatedAt: 'x',
  },
  'seed-target': {
    id: 'seed-target', type: 'note', x: 400, y: 0, w: 240, h: 168, z: 3,
    text: '', color: 'blue', by: 'user', createdAt: 'x', updatedAt: 'x',
  },
  'seed-edge': {
    id: 'seed-edge', type: 'edge', x: 0, y: 0, w: 0, h: 0, z: 2,
    color: 'yellow', from: 'seed-note', to: 'seed-target', by: 'user', createdAt: 'x', updatedAt: 'x',
  },
  'seed-stroke': {
    id: 'seed-stroke', type: 'stroke', x: 0, y: 300, w: 60, h: 40, z: 4,
    points: [[0, 0], [30, 20], [60, 40]], width: 3, color: 'white', by: 'user', createdAt: 'x', updatedAt: 'x',
  },
  'seed-frame': {
    id: 'seed-frame', type: 'frame', x: -820, y: -420, w: 520, h: 380, z: 0,
    text: '画框', color: 'gray', by: 'user', createdAt: 'x', updatedAt: 'x',
  },
  'seed-agent': {
    id: 'seed-agent', type: 'agent', x: 800, y: 0, w: 280, h: 200, z: 6,
    text: 'Agent1', task: '拆分需求', status: 'running', color: 'purple', by: 'user', createdAt: 'x', updatedAt: 'x',
  },
};

async function renderPanelScenario({ selection = [], items = {}, patches = [] } = {}) {
  const source = await readFile(join(bundle, 'client.js'), 'utf8');
  let patched = source.replace(
    'const [selection, setSelection] = useState([]);',
    `const [selection, setSelection] = useState(${JSON.stringify(selection)});`,
  );
  patched = patched.replace('items: {},', `items: ${JSON.stringify(items)},`);
  for (const [find, replace] of patches) patched = patched.replace(find, replace);
  assert.ok(
    patched.includes(`const [selection, setSelection] = useState(${JSON.stringify(selection)});`),
    'selection scenario patch',
  );
  assert.ok(patched.includes(`items: ${JSON.stringify(items)},`), 'items scenario patch');

  let captured = null;
  let renderHooks = null;
  const react = {
    createElement(type, props, ...children) {
      const flat = [];
      const push = (child) => {
        if (Array.isArray(child)) child.forEach(push);
        else if (child !== null && child !== undefined && child !== false && child !== true) flat.push(child);
      };
      children.forEach(push);
      return { type, props: props ?? {}, children: flat };
    },
    useState(initial) {
      const index = renderHooks.index++;
      if (!(index in renderHooks.store)) renderHooks.store[index] = typeof initial === 'function' ? initial() : initial;
      return [renderHooks.store[index], () => {}];
    },
    useRef(initial) {
      const index = renderHooks.index++;
      if (!(index in renderHooks.store)) renderHooks.store[index] = { current: initial };
      return renderHooks.store[index];
    },
    useMemo(factory) {
      return factory();
    },
    useCallback(fn) {
      return fn;
    },
    useEffect() {},
    useLayoutEffect() {},
    createContext: () => ({ Provider: 'Provider', Consumer: 'Consumer' }),
  };
  const windowStub = { __ModuleLoader__: { load: (definition) => { captured = definition; } } };
  const documentStub = { baseURI: 'http://127.0.0.1:56311/', createElement: () => ({}), head: { appendChild: () => {} } };
  const navigatorStub = { language: 'zh-CN', clipboard: { writeText: async () => {} } };
  const evaluate = new Function('window', 'document', 'navigator', 'fetch', 'performance', 'requestAnimationFrame', 'ResizeObserver', 'console', patched);
  evaluate(
    windowStub,
    documentStub,
    navigatorStub,
    async () => ({ ok: true, json: async () => ({ ok: true, value: {} }) }),
    { now: () => 0 },
    () => 0,
    undefined,
    { log() {}, error() {}, warn() {} },
  );
  const plugin = captured.factory((name) => {
    if (name === 'react') return react;
    throw new Error(`unexpected require(${JSON.stringify(name)})`);
  });
  const registrations = [];
  const localeStub = { getSnapshot: () => ({ active: 'zh-CN' }), subscribe: () => () => {}, bind: () => (key) => key };
  plugin.apply({
    get: (name) => (name === 'locale' ? localeStub : undefined),
    slots: {
      inject: (_key, callback) => {
        const disposer = callback();
        return typeof disposer === 'function' ? disposer : () => {};
      },
      register: (options, component) => {
        registrations.push({ options, component });
        return () => {};
      },
    },
  });
  const panel = registrations.find((entry) => entry.options.name === 'main');
  assert.ok(panel, 'panel component registered');

  const hostElements = [];
  let depth = 0;
  const render = (element) => {
    if (element === null || element === undefined || element === false || element === true) return;
    if (Array.isArray(element)) {
      element.forEach(render);
      return;
    }
    if (typeof element !== 'object') return;
    if (typeof element.type === 'function') {
      depth += 1;
      assert.ok(depth < 200, 'render tree too deep (possible recursion)');
      const previous = renderHooks;
      renderHooks = { index: 0, store: [] };
      let output;
      try {
        output = element.type({ ...element.props, children: element.children });
      } finally {
        renderHooks = previous;
        depth -= 1;
      }
      render(output);
      return;
    }
    hostElements.push(element);
    (element.children ?? []).forEach(render);
  };
  render({ type: panel.component, props: {}, children: [] });
  return { hostElements, registrations, render };
}

const classOf = (hostElements) => hostElements.map((element) => element.props.className ?? '').join(' ');

await check('client: panel render pass produces the canvas chrome', async () => {
  const { hostElements, registrations, render } = await renderPanelScenario();
  assert.ok(hostElements.length > 20, `expected a rich tree, rendered ${hostElements.length} host elements`);
  const classes = classOf(hostElements);
  for (const expected of ['dsic-root', 'dsic-bar', 'dsic-stage', 'dsic-world', 'dsic-hint', 'dsic-addtext', 'dsic-tool-label']) {
    assert.ok(classes.includes(expected), `missing ${expected} in rendered tree`);
  }
  const emptyScenario = await renderPanelScenario({
    patches: [['loaded: false,', 'loaded: true,']],
  });
  const emptyClasses = classOf(emptyScenario.hostElements);
  assert.ok(emptyClasses.includes('dsic-empty'), 'empty-canvas onboarding rendered');
  assert.ok(emptyClasses.includes('dsic-empty-status'), 'onboarding shows the cyberpunk terminal status line');
  assert.ok(emptyClasses.includes('dsic-empty-cta'), 'onboarding CTA keeps its neon treatment');
  const emptySource = await readFile(join(bundle, 'client.js'), 'utf8');
  assert.ok(emptySource.includes('dsic-empty-glitch') && emptySource.includes('dsic-empty-scan'), 'onboarding carries glitch + scanline effects');
  const styleTag = hostElements.find((element) => element.type === 'style');
  assert.ok(styleTag, 'stylesheet element rendered');
  assert.ok(String(styleTag.children?.[0] ?? '').includes('dsic-overlay-editor'), 'overlay editor styles present');
  assert.ok(String(styleTag.children?.[0] ?? '').includes('dsic-plus'), 'plus-bubble styles present');
  const sidebar = registrations.find((entry) => entry.options.name === 'sidebar.panellist');
  render({ type: sidebar.component, props: { size: 18, active: true }, children: [] });
  assert.ok(hostElements.some((element) => element.type === 'svg'), 'sidebar icon renders an svg');
});

await check('client: selected-node and selected-edge render paths (TDZ regression)', async () => {
  const note = await renderPanelScenario({ selection: ['seed-note'], items: SEED_ITEMS });
  const noteClasses = classOf(note.hostElements);
  assert.ok(noteClasses.includes('dsic-node'), 'node rendered');
  assert.ok(noteClasses.includes('dsic-node-text'), 'node text rendered');
  assert.ok(noteClasses.includes('dsic-selectallbtn'), 'toolbar has a one-click select-all button');
  assert.ok(
    note.hostElements.some((element) => String(element.props.title ?? '').includes('同类型')),
    'selection bar offers selecting every node of the same kind',
  );
  assert.ok(noteClasses.includes('dsic-handle'), 'resize handles rendered for the selected node');
  assert.ok(noteClasses.includes('dsic-selectframe'), 'cyberpunk selection frame rendered');
  const selectFrame = note.hostElements.find(
    (element) => String(element.props.className ?? '') === 'dsic-selectframe',
  );
  const selectedNoteCard = note.hostElements.find(
    (element) => String(element.props.className ?? '') === 'dsic-node dsic-note',
  );
  assert.ok(selectFrame && selectedNoteCard, 'selection frame and selected card both rendered');
  assert.equal(String(selectFrame.props.style.width), '100%', 'selection frame fills its own card (can never drift)');
  assert.equal(String(selectFrame.props.style.height), '100%', 'selection frame height fills its own card');
  assert.equal(String(selectFrame.props.style.left), '0', 'selection frame is anchored inside the card');
  assert.ok(String(selectFrame.props.style['--dsic-frame-corner']).endsWith('px'), 'selection frame corner tick sized for the zoom');
  const inlineHandleCount = note.hostElements.filter(
    (element) => String(element.props.className ?? '') === 'dsic-handle',
  ).length;
  assert.equal(inlineHandleCount, 8, 'eight handles are children of the selected card');
  assert.ok(noteClasses.includes('dsic-node-plus'), 'quick-add plus bubble rendered for the selected node');
  const plusButtons = note.hostElements.filter((element) => String(element.props.className ?? '') === 'dsic-node-plus');
  assert.equal(plusButtons.length, 4, 'four quick-add bubbles around the selected node');
  const plusSides = plusButtons.map((element) => element.props['data-side']).sort();
  assert.deepEqual(plusSides, ['bottom', 'left', 'right', 'top'], 'bubbles on every side of the node');
  assert.ok(noteClasses.includes('dsic-selbar-colors'), 'colour section laid out horizontally');
  assert.ok(noteClasses.includes('dsic-selbar'), 'selection bar rendered');
  assert.ok(noteClasses.includes('dsic-selbar-count'), 'selection count shown');
  assert.ok(noteClasses.includes('dsic-selbar-kind'), 'selection type shown');
  const kindChip = note.hostElements.find((element) => String(element.props.className ?? '') === 'dsic-selbar-kind');
  assert.ok(kindChip && String(kindChip.children.join('')).includes('你好'), 'selection bar names the selected item');
  assert.ok(noteClasses.includes('dsic-selbar-label'), 'colour section labelled');
  const selButtons = note.hostElements.filter((element) => String(element.props.className ?? '') === 'dsic-selbtn');
  assert.ok(selButtons.length >= 3, 'labelled selection actions rendered');
  assert.ok(
    selButtons.some((element) => String(element.props.title ?? '').includes('Enter')),
    'edit action hints its shortcut',
  );
  assert.ok(noteClasses.includes('dsic-twinkle'), 'starry twinkle layer rendered');
  assert.ok(noteClasses.includes('dsic-scanlines'), 'CRT scanline overlay rendered');
  assert.ok(noteClasses.includes('dsic-vignette'), 'edge vignette rendered');
  assert.ok(noteClasses.includes('dsic-hud'), 'HUD corner brackets rendered');
  const clientSourceForCss = await readFile(join(bundle, 'client.js'), 'utf8');
  assert.ok(!clientSourceForCss.includes('will-change:transform'), 'world layer is never promoted (no re-raster flashes)');
  assert.ok(!/\.dsic-edges\{[^}]*drop-shadow/.test(clientSourceForCss), 'no whole-canvas glow filter on the edge layer');
  assert.ok(clientSourceForCss.includes("className: 'dsic-scanbeam'"), 'the slow scan-beam is kept');
  assert.ok(clientSourceForCss.includes('animation:dsic-scan 11s linear infinite'), 'scan-beam sweeps every 11s');
  assert.ok(
    clientSourceForCss.includes('rgba(148,163,184,.035) 0px'),
    'CRT scanline texture kept at 1px/3px @ .035',
  );
  assert.ok(
    !clientSourceForCss.includes('animation:dsic-twinkle'),
    'no looping twinkle animation',
  );
  assert.ok(
    !clientSourceForCss.includes('data-auto-height'),
    'auto-height mutation is gone: card geometry is always the stored w/h',
  );
  const stageElement = note.hostElements.find((element) => String(element.props.className ?? '') === 'dsic-stage');
  assert.ok(stageElement, 'canvas stage rendered');
  const starBackground = String(stageElement.props.style.backgroundImage ?? '');
  assert.ok(
    (starBackground.match(/radial-gradient\(circle/g) ?? []).length >= 3,
    'three dot layers keep the black/white star field',
  );
  assert.ok(starBackground.includes('rgba(255,255,255,.55)'), 'big white stars are the brightest layer');
  assert.ok(starBackground.includes('rgba(34,211,238,.055)'), 'cyan neon grid layer present');
  assert.ok(starBackground.includes('rgba(168,85,247,.05)'), 'violet major-grid layer present');
  assert.ok(noteClasses.includes('dsic-hud-tag'), 'HUD corner readouts rendered');
  assert.ok(noteClasses.includes('dsic-nixie'), 'Steins;Gate divergence meter rendered top-left');
  assert.ok(noteClasses.includes('dsic-nixie-caption'), 'divergence meter caption rendered');
  const nixieDigits = note.hostElements.filter((element) => String(element.props.className ?? '') === 'dsic-nixie-cell');
  assert.ok(nixieDigits.length >= 6, 'nixie tube digits rendered');
  const nixieText = nixieDigits
    .map((element) => (Array.isArray(element.children) ? element.children.join('') : String(element.children ?? '')))
    .join('')
    .replace(/\D/g, '');
  assert.ok(nixieText.includes('1048596'), 'divergence starts at the Steins;Gate worldline 1.048596');

  const groupedNote = await renderPanelScenario({
    selection: ['seed-note'],
    items: {
      ...SEED_ITEMS,
      'seed-note': { ...SEED_ITEMS['seed-note'], frameId: 'seed-frame' },
    },
  });
  const groupedClasses = classOf(groupedNote.hostElements);
  assert.ok(groupedClasses.includes('dsic-selbar-kind'), 'selection bar shows the owning frame');
  assert.ok(
    groupedNote.hostElements.some((element) => String(element.props.title ?? '') === '移出画框'),
    'grouped node can be detached from its frame',
  );
  const groupedAgent = await renderPanelScenario({
    selection: ['seed-agent'],
    items: {
      ...SEED_ITEMS,
      'seed-agent': { ...SEED_ITEMS['seed-agent'], frameId: 'seed-frame' },
    },
  });
  const groupedAgentCardClasses = classOf(groupedAgent.hostElements);
  assert.ok(groupedAgentCardClasses.includes('dsic-agent-parent'), 'agent card shows the frame it belongs to');

  const frameSelection = await renderPanelScenario({ selection: ['seed-frame'], items: SEED_ITEMS });
  const frameClasses = classOf(frameSelection.hostElements);
  assert.ok(frameClasses.includes('dsic-handle'), 'frame selection still shows resize handles');
  assert.ok(
    frameSelection.hostElements.some((element) => String(element.props.title ?? '') === '贴合内容'),
    'frame selection offers fit-to-content',
  );
  assert.ok(
    frameSelection.hostElements.some((element) => String(element.props.title ?? '').includes('收进这个画框')),
    'frame selection offers gather-nodes (frame and Agent move together)',
  );
  assert.ok(
    frameSelection.hostElements.some((element) => String(element.props.title ?? '').includes('连带')),
    'frame selection has a carry-contents toggle (off = only the frame moves)',
  );

  const realDocUnused = null;
  const edge = await renderPanelScenario({ selection: ['seed-edge'], items: SEED_ITEMS });
  const edgeClasses = classOf(edge.hostElements);
  assert.ok(edgeClasses.includes('dsic-edge'), 'edge rendered');
  assert.ok(edgeClasses.includes('dsic-plus'), 'quick-add plus bubble rendered for the selected connector');
  assert.ok(!edgeClasses.includes('dsic-handle'), 'no resize handles for an edge');
  const toolbarSource = await readFile(join(bundle, 'client.js'), 'utf8');
  assert.ok(/\.dsic-btn\{[^}]*height:38px/.test(toolbarSource), 'every toolbar button shares one height');
  assert.ok(/\.dsic-tool\{[^}]*height:38px/.test(toolbarSource), 'tool buttons share the same height');
  assert.ok(/\.dsic-addtext\{[^}]*height:38px/.test(toolbarSource), 'labelled toolbar buttons share the same height');
  assert.ok(
    toolbarSource.includes('.dsic-tool-label{font-size:11px') && toolbarSource.includes('.dsic-addtext span{font-size:11px'),
    'toolbar labels share one font size',
  );
  assert.ok(/\.dsic-tool\{[^}]*border:0 !important/.test(toolbarSource), 'tool buttons render without the light frame');
  assert.ok(/\.dsic-addtext\{[^}]*border-color:transparent/.test(toolbarSource), 'labelled buttons render without the light frame');
  assert.ok(
    edge.hostElements.some((element) => String(element.props.id ?? '').startsWith('dsic-arrow-')),
    'each edge gets a matching arrow marker',
  );
  const edgeLine = edge.hostElements.find((element) => String(element.props.className ?? '') === 'dsic-edge-line');
  assert.ok(edgeLine, 'solid edge line rendered');
  assert.ok(/^#[0-9a-f]{6}$/i.test(String(edgeLine.props.stroke ?? '')), 'edge stroke is a solid colour, not a gradient');
  assert.ok(!String(edgeLine.props.stroke).includes('url('), 'no gradient paint on edges');
  assert.ok(edgeClasses.includes('dsic-edge-scan'), 'edges carry the scan-line texture');
  assert.ok(edgeClasses.includes('dsic-edge-port'), 'connectors have circuit-style port dots');
  assert.ok(edgeClasses.includes('dsic-edge-flow'), 'selected edge shows the flowing energy dash');
  const edgeGeometry = (result) => {
    const line = result.hostElements.find((element) => String(element.props.className ?? '') === 'dsic-edge-line');
    return line ? line.props.d : null;
  };
  const normalEdgePath = edgeGeometry(edge);
  const draggedEdge = await renderPanelScenario({
    selection: ['seed-edge'],
    items: SEED_ITEMS,
    patches: [['const [dragDraft, setDragDraft] = useState(null);', "const [dragDraft, setDragDraft] = useState({ 'seed-note': { x: 140, y: 120 } });"]],
  });
  assert.ok(normalEdgePath, 'edge path available');
  assert.notEqual(edgeGeometry(draggedEdge), normalEdgePath, 'edge follows the node while it is being dragged');

  const multi = await renderPanelScenario({ selection: ['seed-note', 'seed-target'], items: SEED_ITEMS });
  const multiClasses = classOf(multi.hostElements);
  assert.ok(multiClasses.includes('dsic-selbar'), 'multi-selection bar rendered');
  assert.ok(!multiClasses.includes('dsic-plus'), 'no plus bubble for multi-selection');

  const stroke = await renderPanelScenario({ selection: ['seed-stroke'], items: SEED_ITEMS });
  const strokeClasses = classOf(stroke.hostElements);
  assert.ok(strokeClasses.includes('dsic-stroke'), 'freehand stroke rendered');
  assert.ok(strokeClasses.includes('dsic-stroke-hit'), 'stroke hit target rendered');
  assert.ok(strokeClasses.includes('dsic-handle'), 'resize handles for a selected stroke');
  assert.ok(strokeClasses.includes('dsic-plus'), 'quick-add plus for a selected stroke');

  const agent = await renderPanelScenario({ selection: ['seed-agent'], items: SEED_ITEMS });
  const agentClasses = classOf(agent.hostElements);
  assert.ok(agentClasses.includes('dsic-agent'), 'agent card rendered');
  assert.ok(agentClasses.includes('dsic-agent-status'), 'agent status pill rendered');
  assert.ok(agentClasses.includes('dsic-agent-run'), 'agent run button rendered');
  assert.ok(agentClasses.includes('dsic-agent-task'), 'agent task text rendered');
  const agentPlusBubbles = agent.hostElements.filter((element) => String(element.props.className ?? '') === 'dsic-node-plus');
  assert.equal(agentPlusBubbles.length, 4, 'agent selection keeps the four quick-add bubbles');
  assert.ok(agentClasses.includes('dsic-handle'), 'agent cards are resizable too');
  assert.ok(agentClasses.includes('dsic-selectframe'), 'agent selection uses the same neon frame');
  const agentFrameEl = agent.hostElements.find(
    (element) => String(element.props.className ?? '') === 'dsic-selectframe',
  );
  assert.equal(String(agentFrameEl.props.style.width), '100%', 'agent frame is a child of its own card (no offset possible)');
  const agentHandles = agent.hostElements.filter(
    (element) => String(element.props.className ?? '') === 'dsic-handle',
  );
  assert.equal(agentHandles.length, 8, 'agent card owns its eight resize handles');
  assert.ok(
    agentHandles.every((element) => String(element.props.style.transform ?? '').includes('translate(-50%, -50%)')),
    'handles are centred on their own card corners/edges',
  );
  const scaledAgent = await renderPanelScenario({
    selection: ['seed-agent'],
    items: {
      ...SEED_ITEMS,
      'seed-agent': { ...SEED_ITEMS['seed-agent'], w: 560, h: 420, meta: { sizeBase: { w: 280, h: 210 } } },
    },
  });
  const scaledCard = scaledAgent.hostElements.find((element) =>
    String(element.props.className ?? '').includes('dsic-agent-scale'),
  );
  assert.ok(scaledCard, 'agent content is wrapped in a proportional scale layer');
  assert.match(String(scaledCard.props.style.transform), /^scale\((1\.9|2\.0|2)\)$/, 'agent text scales with the card box');
  assert.equal(String(scaledCard.props.style.width), '280', 'scale layer layout width compensates the transform');
  assert.equal(String(scaledCard.props.style.height), '210', 'scale layer layout height compensates the transform');
  const scaledNote = await renderPanelScenario({
    selection: ['seed-note'],
    items: {
      ...SEED_ITEMS,
      'seed-note': { ...SEED_ITEMS['seed-note'], w: 480, h: 336, meta: { sizeBase: { w: 240, h: 168 } } },
    },
  });
  const scaledNoteEl = scaledNote.hostElements.find(
    (element) => String(element.props.className ?? '') === 'dsic-node dsic-note',
  );
  assert.ok(scaledNoteEl, 'note rendered');
  assert.ok(Number(scaledNoteEl.props.style['--dsic-text-scale']) > 1.9, 'note type scales with the note box');
  const hugeNote = await renderPanelScenario({
    selection: ['seed-note'],
    items: {
      ...SEED_ITEMS,
      'seed-note': { ...SEED_ITEMS['seed-note'], w: 2400, h: 1680, meta: { sizeBase: { w: 240, h: 168 } } },
    },
  });
  const hugeNoteEl = hugeNote.hostElements.find(
    (element) => String(element.props.className ?? '') === 'dsic-node dsic-note',
  );
  assert.ok(
    Number(hugeNoteEl.props.style['--dsic-text-scale']) > 9,
    'very large cards scale the type linearly (no small cap)',
  );
  const agentCard = agent.hostElements.find(
    (element) => String(element.props.className ?? '') === 'dsic-node dsic-agent',
  );
  assert.ok(agentCard, 'agent card element found');
  assert.equal(String(agentCard.props.style.height), String(SEED_ITEMS['seed-agent'].h), 'agent card renders the stored height exactly');
  assert.equal(agentCard.props['data-auto-height'], undefined, 'auto height is fully removed');
  assert.equal(agentCard.props.style['--dsic-agent-accent'], '#E5DCFF', 'agent card exposes its colour as an accent');
  assert.ok(String(agentCard.props.style['--dsic-agent-accent-line']).startsWith('rgba('), 'agent accent line derived');
  assert.ok(agentClasses.includes('dsic-agent-avatar-ring'), 'running agent shows the spinning ring');
  assert.ok(agentClasses.includes('dsic-agent-typing'), 'running agent shows the typing dots');

  const idleAgent = await renderPanelScenario({
    items: {
      ...SEED_ITEMS,
      'seed-agent': { ...SEED_ITEMS['seed-agent'], status: 'idle', task: '' },
    },
  });
  const idleAgentClasses = classOf(idleAgent.hostElements);
  assert.ok(idleAgentClasses.includes('dsic-agent-quip'), 'idle agent shows a playful quip');
  assert.ok(idleAgentClasses.includes('dsic-agent-empty-emoji'), 'idle agent shows the mascot');
  assert.ok(idleAgentClasses.includes('dsic-agent-hint'), 'idle agent shows the usage hint');

  const roleAgent = await renderPanelScenario({
    selection: ['seed-agent'],
    items: {
      ...SEED_ITEMS,
      'seed-agent': {
        ...SEED_ITEMS['seed-agent'],
        status: 'idle',
        task: '设计访谈提纲',
        role: '# 角色\n你是一位做了 200 场用户访谈的用户研究员',
        output: 'document',
      },
    },
  });
  const roleAgentClasses = classOf(roleAgent.hostElements);
  assert.ok(roleAgentClasses.includes('dsic-agent-role'), 'agent card shows the role badge');
  assert.ok(roleAgentClasses.includes('dsic-agent-role-text'), 'role badge shows the preview');

  const roleDialog = await renderPanelScenario({
    items: SEED_ITEMS,
    patches: [
      [
        'const [roleEditor, setRoleEditor] = useState(null);',
        "const [roleEditor, setRoleEditor] = useState({ id: 'seed-agent', role: '# 角色', output: 'document' });",
      ],
    ],
  });
  const roleDialogClasses = classOf(roleDialog.hostElements);
  assert.ok(roleDialogClasses.includes('dsic-role-card'), 'role dialog rendered');
  assert.ok(roleDialogClasses.includes('dsic-role-input'), 'role textarea rendered');
  assert.ok(roleDialogClasses.includes('dsic-role-example'), 'example-role button rendered');

  const promptDialog = await renderPanelScenario({
    items: SEED_ITEMS,
    patches: [['const [promptOpen, setPromptOpen] = useState(null);', "const [promptOpen, setPromptOpen] = useState('manage');"]],
  });
  const promptClasses = classOf(promptDialog.hostElements);
  assert.ok(promptClasses.includes('dsic-prompt-card'), 'prompt library dialog rendered');
  assert.ok(promptClasses.includes('dsic-prompt-new'), 'new-prompt button rendered');
  assert.ok(promptClasses.includes('dsic-prompt-examples'), 'example-prompt button rendered');
  assert.ok(promptClasses.includes('dsic-prompt-input'), 'prompt editor textarea rendered');

  const projectMenu = await renderPanelScenario({
    items: {
      ...SEED_ITEMS,
      'seed-project-frame': {
        id: 'seed-project-frame',
        type: 'frame',
        x: -1600,
        y: 0,
        w: 1000,
        h: 720,
        z: 0,
        text: '项目 1',
        color: 'blue',
        meta: { workspacePath: 'E:\\T\\T...\\docs' },
        by: 'user',
        createdAt: 'x',
        updatedAt: 'x',
      },
      'seed-project-agent': {
        id: 'seed-project-agent',
        type: 'agent',
        x: -1560,
        y: 70,
        w: 440,
        h: 340,
        z: 1,
        text: '项目 1',
        color: 'blue',
        project: '项目 1',
        frameId: 'seed-project-frame',
        task: '',
        status: 'idle',
        by: 'user',
        createdAt: 'x',
        updatedAt: 'x',
      },
      'seed-project-empty': {
        id: 'seed-project-empty',
        type: 'frame',
        x: -2400,
        y: 0,
        w: 1000,
        h: 720,
        z: 0,
        text: '项目 2',
        color: 'blue',
        meta: { kind: 'project' },
        by: 'user',
        createdAt: 'x',
        updatedAt: 'x',
      },
    },
    patches: [['const [projectsOpen, setProjectsOpen] = useState(false);', 'const [projectsOpen, setProjectsOpen] = useState(true);']],
  });
  const projectMenuClasses = classOf(projectMenu.hostElements);
  assert.ok(projectMenuClasses.includes('dsic-projectbtn'), 'toolbar has a projects button');
  assert.ok(projectMenuClasses.includes('dsic-projects'), 'project menu opens');
  assert.ok(projectMenuClasses.includes('dsic-projects-new'), 'project menu offers a new independent project');
  const projectRows = projectMenu.hostElements.filter((element) => String(element.props.className ?? '') === 'dsic-project-row');
  assert.equal(projectRows.length, 2, 'project frames (even temporarily empty) are listed in the menu');
  assert.ok(
    String(projectRows[0].props.title ?? '').includes('项目'),
    'project row carries a jump title',
  );
  assert.ok(projectMenuClasses.includes('dsic-project-open'), 'linked project offers opening its local folder');

  const linkedFrame = await renderPanelScenario({
    selection: ['seed-frame'],
    items: {
      ...SEED_ITEMS,
      'seed-frame': { ...SEED_ITEMS['seed-frame'], text: '项目 1', meta: { workspacePath: 'E:\\T\\T...\\docs' } },
    },
  });
  const linkedFrameClasses = classOf(linkedFrame.hostElements);
  assert.ok(linkedFrameClasses.includes('dsic-frame-open'), 'project frame shows the open-workspace button');
  const pathDialog = await renderPanelScenario({
    items: SEED_ITEMS,
    patches: [
      [
        'const [pathDialog, setPathDialog] = useState(null);',
        "const [pathDialog, setPathDialog] = useState({ id: 'seed-frame', value: 'E:\\\\无限画布\\\\docs' });",
      ],
    ],
  });
  const pathDialogClasses = classOf(pathDialog.hostElements);
  assert.ok(pathDialogClasses.includes('dsic-path-card'), 'local path dialog rendered');
  assert.ok(pathDialogClasses.includes('dsic-path-input'), 'path input rendered');

  const modelDialog = await renderPanelScenario({
    items: SEED_ITEMS,
    patches: [
      ['const [modelOpen, setModelOpen] = useState(false);', 'const [modelOpen, setModelOpen] = useState(true);'],
      [
        'const [modelCatalogData, setModelCatalogData] = useState(null);',
        "const [modelCatalogData, setModelCatalogData] = useState({ current: { provider: 'p1', model: 'm1' }, default: { provider: 'p1', model: 'm1' }, providers: [{ id: 'p1', name: 'Provider 1', models: [{ id: 'm1', name: 'Model 1' }, { id: 'm2', name: 'Model 2' }] }], failures: [] });",
      ],
      [
        'const [modelSel, setModelSel] = useState(() => loadModelChoice());',
        "const [modelSel, setModelSel] = useState({ provider: 'p1', model: 'm2' });",
      ],
    ],
  });
  const modelClasses = classOf(modelDialog.hostElements);
  assert.ok(modelClasses.includes('dsic-modelbtn'), 'toolbar has a model picker button');
  assert.ok(modelClasses.includes('dsic-model-card'), 'model picker dialog rendered');
  const modelRows = modelDialog.hostElements.filter((element) => String(element.props.className ?? '') === 'dsic-model-row');
  assert.ok(modelRows.length >= 2, 'model rows rendered');
  assert.ok(modelClasses.includes('dsic-model-provider'), 'models grouped by provider');

  const helpDialog = await renderPanelScenario({
    items: SEED_ITEMS,
    patches: [['const [helpOpen, setHelpOpen] = useState(false);', 'const [helpOpen, setHelpOpen] = useState(true);']],
  });
  const helpClasses = classOf(helpDialog.hostElements);
  assert.ok(helpClasses.includes('dsic-help-card'), 'help dialog rendered');
  const helpSections = helpDialog.hostElements.filter(
    (element) => String(element.props.className ?? '') === 'dsic-help-section',
  );
  assert.equal(helpSections.length, 7, 'help covers text, canvas, projects, media/model, batch, shortcuts and AI');

  const skinDialog = await renderPanelScenario({
    items: SEED_ITEMS,
    patches: [['const [skinOpen, setSkinOpen] = useState(false);', 'const [skinOpen, setSkinOpen] = useState(true);']],
  });
  const skinClasses = classOf(skinDialog.hostElements);
  assert.ok(skinClasses.includes('dsic-skin-card'), 'skin dialog rendered');
  assert.ok(skinClasses.includes('dsic-skin-grid'), 'skin preset grid rendered');
  const skinItems = skinDialog.hostElements.filter((element) => String(element.props.className ?? '') === 'dsic-skin-item');
  assert.ok(skinItems.length >= 3, 'at least three built-in skins');
  assert.ok(skinClasses.includes('dsic-skin-custom'), 'custom background section rendered');

  const bigEditorScenario = await renderPanelScenario({
    items: SEED_ITEMS,
    patches: [
      [
        'const [bigEditor, setBigEditor] = useState(null);',
        "const [bigEditor, setBigEditor] = useState({ id: 'seed-agent', field: 'task', value: '把需求拆成三张便签' });",
      ],
    ],
  });
  const bigEditorClasses = classOf(bigEditorScenario.hostElements);
  assert.ok(bigEditorClasses.includes('dsic-bigeditor'), 'standalone big editor rendered');
  assert.ok(bigEditorClasses.includes('dsic-bigeditor-input'), 'big editor textarea rendered');
  assert.ok(bigEditorClasses.includes('dsic-bigeditor-foot'), 'big editor actions rendered');

  const delegationView = await renderPanelScenario({
    selection: ['seed-agent'],
    items: {
      ...SEED_ITEMS,
      'seed-agent': {
        ...SEED_ITEMS['seed-agent'],
        status: 'done',
        task: '把新产品拆成三个项目',
        project: '品牌官网',
        agentResult: '已完成 3 个节点',
      },
      'seed-child': {
        id: 'seed-child',
        type: 'agent',
        x: 800,
        y: 420,
        w: 360,
        h: 280,
        z: 8,
        text: '小程序',
        project: '小程序',
        parentId: 'seed-agent',
        task: '做小程序',
        status: 'done',
        color: 'blue',
        by: 'ai',
        createdAt: 'x',
        updatedAt: 'x',
      },
    },
  });
  const delegationClasses = classOf(delegationView.hostElements);
  assert.ok(delegationClasses.includes('dsic-agent-project-name'), 'project chip rendered on the agent card');
  assert.ok(delegationClasses.includes('dsic-agent-children'), 'coordinator card shows child progress');
  assert.ok(delegationClasses.includes('dsic-agent-delegate'), 'coordinator card offers delegation');
  assert.ok(delegationClasses.includes('dsic-agent-runchildren'), 'coordinator card offers running its children');
  const childView = await renderPanelScenario({
    selection: ['seed-child'],
    items: {
      'seed-parent': {
        id: 'seed-parent',
        type: 'agent',
        x: -600,
        y: 0,
        w: 360,
        h: 280,
        z: 6,
        text: '协调者',
        parentId: 'upstream-agent',
        task: '拆项目',
        status: 'idle',
        color: 'purple',
        by: 'ai',
        createdAt: 'x',
        updatedAt: 'x',
      },
      'seed-child': {
        id: 'seed-child',
        type: 'agent',
        x: 0,
        y: 0,
        w: 360,
        h: 280,
        z: 8,
        text: '小程序',
        project: '小程序',
        parentId: 'seed-parent',
        task: '做小程序',
        status: 'idle',
        color: 'blue',
        by: 'ai',
        createdAt: 'x',
        updatedAt: 'x',
      },
    },
  });
  const childClasses = classOf(childView.hostElements);
  assert.ok(childClasses.includes('dsic-agent-parent'), 'child card shows the coordinator it belongs to');
  assert.ok(!childClasses.includes('dsic-agent-delegate'), 'child cards cannot delegate further');

  const delegateDialog = await renderPanelScenario({
    items: SEED_ITEMS,
    patches: [
      [
        'const [delegateFor, setDelegateFor] = useState(null);',
        "const [delegateFor, setDelegateFor] = useState({ id: 'seed-agent' });",
      ],
      ["const [delegateText, setDelegateText] = useState('');", "const [delegateText, setDelegateText] = useState('品牌官网、小程序');"],
    ],
  });
  const delegateDialogClasses = classOf(delegateDialog.hostElements);
  assert.ok(delegateDialogClasses.includes('dsic-delegate-card'), 'delegate dialog rendered');
  assert.ok(delegateDialogClasses.includes('dsic-delegate-input'), 'delegate textarea rendered');
  assert.ok(delegateDialogClasses.includes('dsic-delegate-parent'), 'delegate dialog names the coordinator');

  assert.ok(clientSourceForCss.includes("callCanvas('delegate'"), 'panel sends the delegate action to the host');
  assert.ok(clientSourceForCss.includes('contextIds: projectContextIds(child)'), 'child runs send their project context ids');
  assert.ok(clientSourceForCss.includes('agentDelegateTip'), 'delegation copy is wired into the card');
  assert.ok(clientSourceForCss.includes('--dsic-text-scale'), 'sticky/text type scale variable is wired');
  assert.ok(clientSourceForCss.includes('calc(15px * var(--dsic-text-scale,1))'), 'note font size follows the box');
  assert.ok(clientSourceForCss.includes('sizeBase'), 'resizing records the content base size');
  assert.ok(clientSourceForCss.includes('contentScaleOf(item, rect)'), 'agent scale derived from its rendered rect');
  assert.ok(clientSourceForCss.includes('const createProject = useCallback'), 'panel can create an independent project');
  assert.ok(clientSourceForCss.includes('projectNoteHint'), 'project workspace seeds a hint note');
  assert.ok(clientSourceForCss.includes('focusProjectFrame'), 'project jump helper wired');
  assert.ok(clientSourceForCss.includes('projectsAnchor'), 'project menu is anchored under its toolbar button');
  assert.ok(
    clientSourceForCss.includes('const right = Math.round(current.cx - frameW / 2)'),
    'new project lands in the current view, not off-screen',
  );
  assert.ok(clientSourceForCss.includes("callCanvas('open-path'"), 'panel can open a linked local path through the host');
  assert.ok(clientSourceForCss.includes('dsic-frame-open'), 'project frame renders the open-workspace button');
  assert.ok(clientSourceForCss.includes("callCanvas('models'"), 'model catalog fetched from the host');
  assert.ok(clientSourceForCss.includes('model: modelSel ?? undefined'), 'generation requests carry the chosen model');
  assert.ok(clientSourceForCss.includes('dsic-model-card'), 'model picker dialog is wired');
  assert.ok(clientSourceForCss.includes('helpProjectTitle'), 'help documents the project / Agent workflow');
  assert.ok(clientSourceForCss.includes('helpMediaTitle'), 'help documents media, prompts, skin and model');
  assert.ok(clientSourceForCss.includes('helpBulkTitle'), 'help documents multi-select and batch actions');
  assert.ok(clientSourceForCss.includes('helpKeysTitle'), 'help ships a keyboard shortcut sheet');
  assert.ok(clientSourceForCss.includes('关联本地路径'), 'help mentions linking a local path');
  assert.ok(clientSourceForCss.includes('gatherFrameNodes'), 'frame can gather its nodes (including Agents)');
  assert.ok(clientSourceForCss.includes('detachFromFrame'), 'a node can be detached from its frame');
  assert.ok(clientSourceForCss.includes('dsic-selectframe'), 'cyberpunk selection frame is wired');
  assert.ok(clientSourceForCss.includes('.dsic-handle::after'), 'resize handles use the neon cyberpunk style');
  assert.ok(
    clientSourceForCss.includes("commit([{ op: 'upsert', item: { ...item, ...rect, meta: nextMeta, updatedAt } }]);"),
    'resizing commits only the grabbed node — siblings are untouched',
  );
  assert.ok(
    clientSourceForCss.includes('gesture.startWorld.x - defaults.w / 2'),
    'a clicked Agent is created centred on the click point (never below it)',
  );
  assert.ok(
    clientSourceForCss.includes('const isClick = dragScreen < 6'),
    'click detection is measured in screen pixels, so low zoom no longer turns clicks into drags',
  );
  assert.ok(
    !clientSourceForCss.includes('overlaps(finalRect)'),
    'new Agents are not silently shifted away from the click point',
  );
  assert.ok(
    clientSourceForCss.includes("showChrome: tool === 'select' && createDraft === null"),
    'selection frame and handles hide while a create tool is active',
  );
  assert.ok(
    clientSourceForCss.includes('.dsic-node[data-selected="true"]{overflow:visible}'),
    'selected cards expose their own frame and handles outside their box',
  );
  const createToolScenario = await renderPanelScenario({
    selection: ['seed-agent'],
    items: SEED_ITEMS,
    patches: [["const [tool, setTool] = useState('select');", "const [tool, setTool] = useState('agent');"]],
  });
  const createToolClasses = classOf(createToolScenario.hostElements);
  assert.ok(!createToolClasses.includes('dsic-selectframe'), 'no stale selection frame while creating an Agent');
  assert.ok(!createToolClasses.includes('dsic-handle'), 'no stale resize handles while creating an Agent');
  assert.ok(
    clientSourceForCss.includes('z: highestZ(store.doc.items)'),
    'new nodes get their own z and never shift existing cards',
  );
  assert.ok(
    clientSourceForCss.includes('const hostFrame = frameContainingPoint('),
    'new nodes created inside a frame are attached to it',
  );
  assert.ok(
    clientSourceForCss.includes("mode: 'agent-place'"),
    'the Agent card is created on mouse-down at the pressed point (it cannot drift on release)',
  );
  assert.ok(
    clientSourceForCss.includes('openBigEditor(gesture.id)'),
    'the large editor opens after the press point has been fixed',
  );
  assert.ok(
    clientSourceForCss.includes('dsic-place-marker'),
    'a crosshair marks the exact world point that was placed (drift diagnostics)',
  );
  assert.ok(
    clientSourceForCss.includes('frameCarryRef.current || Boolean(event.altKey)'),
    'frames carry their contents only when the toggle (or Alt) is active',
  );
  assert.ok(
    clientSourceForCss.includes("raw === null ? true : raw !== '0'"),
    'dragging a frame carries its contents by default (mouse drag moves the whole block)',
  );
  assert.ok(
    clientSourceForCss.includes('Agent cards never use the inline overlay'),
    'Agent editing is routed to the large panel everywhere',
  );
  assert.ok(
    clientSourceForCss.includes('lastCanvasPointRef.current = {'),
    'the panel remembers the exact canvas point the user clicked',
  );
  assert.ok(
    clientSourceForCss.includes('agentPlaceHint'),
    'Agent tool arms placement first: click the canvas, then the editor opens',
  );
  assert.ok(clientSourceForCss.includes('const selectAllItems = useCallback'), 'one-click select-all handler wired');
  assert.ok(clientSourceForCss.includes('const selectSameKind = useCallback'), 'select-same-kind handler wired');
  assert.ok(clientSourceForCss.includes('selectAllDone'), 'select-all reports the ticked count');
  assert.ok(
    !clientSourceForCss.includes('createAgentAtPoint(lastPoint)'),
    'pressing Agent no longer creates/opens anything before the placement click',
  );
  assert.ok(
    clientSourceForCss.includes('anchor:\n                scope === '),
    'AI generation anchors at the remembered click point instead of the viewport centre',
  );
  const media = await renderPanelScenario({
    items: SEED_ITEMS,
    patches: [['const [mediaOpen, setMediaOpen] = useState(false);', 'const [mediaOpen, setMediaOpen] = useState(true);']],
  });
  const mediaClasses = classOf(media.hostElements);
  assert.ok(mediaClasses.includes('dsic-media-card'), 'media generation dialog rendered');
  assert.ok(mediaClasses.includes('dsic-tabs'), 'image/GIF tabs rendered');
  assert.ok(mediaClasses.includes('dsic-media-limits'), 'capability limits block rendered');
  assert.ok(mediaClasses.includes('dsic-mediabtn'), 'media toolbar button rendered');

  const ai = await renderPanelScenario({
    items: SEED_ITEMS,
    patches: [
      ['const [aiDialog, setAiDialog] = useState(false);', 'const [aiDialog, setAiDialog] = useState(true);'],
      ["const [aiPrompt, setAiPrompt] = useState('');", "const [aiPrompt, setAiPrompt] = useState('画一个三步流程');"],
      [
        'const [aiPending, setAiPending] = useState(null);',
        "const [aiPending, setAiPending] = useState({ sessionId: 'session-smoke', title: '测试对话', at: 0 });",
      ],
    ],
  });
  const aiClasses = classOf(ai.hostElements);
  assert.ok(aiClasses.includes('dsic-aibtn'), 'AI generate button rendered in the toolbar');
  const aiButton = ai.hostElements.find((element) => String(element.props.className ?? '') === 'dsic-btn dsic-addtext dsic-aibtn');
  assert.ok(aiButton, 'toolbar AI button element found');
  const textOf = (node) => {
    if (node === null || node === undefined) return '';
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(textOf).join('');
    if (typeof node === 'object') return textOf(node.children ?? []);
    return '';
  };
  assert.ok(textOf(aiButton).includes('生成'), 'AI toolbar button is labelled 生成');
  assert.ok(
    !ai.hostElements.some((element) => String(element.props.title ?? '').startsWith('添加文字')),
    'the 添加文字 toolbar button was removed',
  );
  assert.ok(aiClasses.includes('dsic-ai-input'), 'AI prompt dialog rendered');
  assert.ok(aiClasses.includes('dsic-primary'), 'AI submit button rendered');
  assert.ok(aiClasses.includes('dsic-scope'), 'AI scope selector rendered');
  assert.ok(aiClasses.includes('dsic-mode'), 'AI ask/auto mode selector rendered');
  assert.ok(aiClasses.includes('dsic-aipending'), 'AI pending chip rendered while generating');
  assert.ok(aiClasses.includes('dsic-aiopen'), 'pending chip offers opening the conversation');
  const dialogControls = ai.hostElements.filter((element) =>
    String(element.props.className ?? '').includes('dsic-scope-option'),
  );
  assert.ok(dialogControls.length >= 4, 'scope and mode options rendered');
  assert.ok(
    dialogControls.some((option) => String(option.props.className ?? '').includes('dsic-scope-option') && option.props.disabled === true),
    'selection scope disabled without selection',
  );
  const backdrop = ai.hostElements.find((element) => (element.props.className ?? '') === 'dsic-dialog');
  assert.ok(backdrop, 'dialog backdrop rendered');
  assert.equal(typeof backdrop.props.onPointerDown, 'function', 'backdrop pointer-down handler exists');
  assert.equal(typeof backdrop.props.onClick, 'function', 'backdrop click handler exists');
  backdrop.props.onClick({ target: backdrop, currentTarget: backdrop, stopPropagation() {} });
  assert.ok(classOf(ai.hostElements).includes('dsic-dialog-backdrop-hint'), 'backdrop hint rendered');

  const aiSelection = await renderPanelScenario({
    selection: ['seed-note'],
    items: SEED_ITEMS,
    patches: [
      ['const [aiDialog, setAiDialog] = useState(false);', 'const [aiDialog, setAiDialog] = useState(true);'],
      ["const [aiScope, setAiScope] = useState('canvas');", "const [aiScope, setAiScope] = useState('selection');"],
    ],
  });
  const selectionScopeOptions = aiSelection.hostElements.filter(
    (element) => String(element.props.className ?? '').includes('dsic-scope-option'),
  );
  assert.ok(
    selectionScopeOptions.some((option) => option.props['data-active'] === 'true' && option.props.disabled !== true),
    'selection scope active and enabled when nodes are selected',
  );
});

/* ---------------------------------------------------------------- *
 * 4c. media generation: GIF encoder round-trip and SVG image builder
 * ---------------------------------------------------------------- */
await check('media: GIF encoder round-trip and SVG image generator', async () => {
  const source = await readFile(join(bundle, 'client.js'), 'utf8');
  const start = source.indexOf('// #region media-generation');
  const end = source.indexOf('// #endregion media-generation');
  assert.ok(start > 0 && end > start, 'media generation region present');
  const region = source.slice(start, end);
  const factory = new Function('document', 'btoa', 'Buffer', `${region}\nreturn { encodeGif, gifColorIndex, buildImageSvg, generateMediaAsset };`);
  const btoaStub = (value) => Buffer.from(value, 'binary').toString('base64');
  const media = factory(undefined, btoaStub, Buffer);

  assert.equal(media.gifColorIndex(0, 0, 0), 0, 'black maps to first palette slot');
  assert.equal(media.gifColorIndex(255, 255, 255), 215, 'white maps to last palette slot');

  const lzwDecode = (data, minCodeSize) => {
    const clear = 1 << minCodeSize;
    const endCode = clear + 1;
    let size = minCodeSize + 1;
    let dict = [];
    const reset = () => {
      dict = [];
      for (let index = 0; index < clear; index += 1) dict.push([index]);
      dict.push(null, null);
      size = minCodeSize + 1;
    };
    reset();
    const out = [];
    let bitPos = 0;
    const readCode = () => {
      let value = 0;
      for (let bit = 0; bit < size; bit += 1) {
        const byteIndex = bitPos >> 3;
        if (byteIndex >= data.length) return null;
        value |= ((data[byteIndex] >> (bitPos & 7)) & 1) << bit;
        bitPos += 1;
      }
      return value;
    };
    let previous = null;
    for (;;) {
      const code = readCode();
      if (code === null || code === endCode) break;
      if (code === clear) {
        reset();
        previous = null;
        continue;
      }
      let entry;
      if (code < dict.length && dict[code]) entry = dict[code];
      else if (previous) entry = previous.concat(previous[0]);
      else break;
      for (const value of entry) out.push(value);
      if (previous) {
        dict.push(previous.concat(entry[0]));
        if (dict.length > 1 << size && size < 12) size += 1;
      }
      previous = entry;
    }
    return out;
  };

  const width = 6;
  const height = 3;
  const frameA = Uint8Array.from({ length: width * height }, (_, index) => (index % 2 === 0 ? 0 : 215));
  const frameB = Uint8Array.from({ length: width * height }, (_, index) => (index % 3 === 0 ? 215 : 40));
  const url = media.encodeGif({ width, height, frames: [frameA, frameB], delayMs: 90 });
  assert.ok(url.startsWith('data:image/gif;base64,'), 'GIF data URL returned');
  const bytes = Buffer.from(url.slice('data:image/gif;base64,'.length), 'base64');
  assert.equal(bytes.subarray(0, 6).toString('ascii'), 'GIF89a', 'GIF header');
  assert.equal(bytes[bytes.length - 1], 0x3b, 'GIF trailer');
  const readU16 = (buffer, offset) => buffer[offset] | (buffer[offset + 1] << 8);
  let offset = 6;
  assert.equal(readU16(bytes, offset), width);
  offset += 2;
  assert.equal(readU16(bytes, offset), height);
  offset += 2;
  const packed = bytes[offset];
  offset += 1;
  offset += 2;
  const tableSize = 1 << ((packed & 0x07) + 1);
  assert.equal(tableSize, 256, 'global colour table size');
  offset += tableSize * 3;
  const decodedFrames = [];
  while (offset < bytes.length) {
    const marker = bytes[offset];
    if (marker === 0x3b) break;
    if (marker === 0x21) {
      offset += 2;
      for (;;) {
        const size = bytes[offset];
        offset += 1;
        if (size === 0) break;
        offset += size;
      }
      continue;
    }
    assert.equal(marker, 0x2c, 'image descriptor marker');
    offset += 1;
    offset += 8;
    const imagePacked = bytes[offset];
    offset += 1;
    assert.equal(imagePacked, 0, 'no local colour table');
    const minCodeSize = bytes[offset];
    offset += 1;
    const data = [];
    for (;;) {
      const size = bytes[offset];
      offset += 1;
      if (size === 0) break;
      for (let index = 0; index < size; index += 1) data.push(bytes[offset + index]);
      offset += size;
    }
    decodedFrames.push(lzwDecode(data, minCodeSize));
  }
  assert.equal(decodedFrames.length, 2, 'two frames encoded');
  assert.deepEqual(decodedFrames[0].slice(0, frameA.length), Array.from(frameA), 'first frame round-trips');
  assert.deepEqual(decodedFrames[1].slice(0, frameB.length), Array.from(frameB), 'second frame round-trips');

  const svg = media.buildImageSvg({ width: 640, height: 360, title: '测试 <海报>', subtitle: '副标题', style: 'poster', hue: 210 });
  assert.ok(svg.startsWith('<svg'), 'SVG root');
  assert.ok(svg.endsWith('</svg>'), 'SVG closed');
  assert.ok(svg.includes('测试 &lt;海报&gt;'), 'title XML-escaped');
  const asset = media.generateMediaAsset({ kind: 'image', prompt: '发布会海报', style: 'poster', ratio: 'wide', subtitle: '无限画板' });
  assert.ok(asset.src.startsWith('data:image/svg+xml;base64,'), 'SVG data URL');
  assert.ok(asset.width > 0 && asset.height > 0, 'display size returned');
  const decodedSvg = Buffer.from(asset.src.split(',')[1], 'base64').toString('utf8');
  assert.ok(decodedSvg.includes('发布会海报'), 'prompt embedded as the title');
  assert.throws(
    () => media.generateMediaAsset({ kind: 'gif', prompt: 'x', style: 'waves', ratio: 'wide', subtitle: '' }),
    /canvas/,
    'GIF generation needs a browser canvas',
  );
});

/* ---------------------------------------------------------------- *
 * 4d. prompt library: browser-storage round-trip and normalisation
 * ---------------------------------------------------------------- */
await check('prompt library: storage round-trip and normalisation', async () => {
  const source = await readFile(join(bundle, 'client.js'), 'utf8');
  const start = source.indexOf('// #region prompt-library');
  const end = source.indexOf('// #endregion prompt-library');
  assert.ok(start > 0 && end > start, 'prompt library region present');
  const storage = {
    data: {},
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : null;
    },
    setItem(key, value) {
      this.data[key] = String(value);
    },
  };
  const factory = new Function('localStorage', `${source.slice(start, end)}\nreturn { normalizePromptEntry, loadPrompts, persistPrompts, newPromptId, promptExamples };`);
  const lib = factory(storage);
  assert.ok(lib.newPromptId().startsWith('p_'), 'prompt ids are prefixed');
  assert.equal(lib.normalizePromptEntry({ id: '', body: 'x' }), null, 'empty id rejected');
  assert.equal(lib.normalizePromptEntry({ id: 'a', body: '   ' }), null, 'empty body rejected');
  const normalized = lib.normalizePromptEntry({ id: 'a', name: '', body: '用 {{产品}} 写一段介绍' });
  assert.equal(normalized.name, '未命名提示词', 'fallback name');
  assert.equal(normalized.body, '用 {{产品}} 写一段介绍');
  lib.persistPrompts([normalized]);
  const reloaded = lib.loadPrompts();
  assert.equal(reloaded.length, 1, 'prompt reloaded from storage');
  assert.equal(reloaded[0].body, '用 {{产品}} 写一段介绍');
  assert.ok(reloaded[0].at > 0, 'timestamp stored');
  storage.data['dsic.prompts.v1'] = '{not-json';
  assert.deepEqual(lib.loadPrompts(), [], 'corrupt storage tolerated');
  const examples = lib.promptExamples((key) => `example:${key}`);
  assert.equal(examples.length, 4, 'four example prompts');
  assert.ok(examples.every((entry) => entry.name.startsWith('example:')), 'example names translated');
  assert.deepEqual(factory(undefined).loadPrompts(), [], 'no localStorage → empty library');
});

/* ---------------------------------------------------------------- *
 * 4e. frame helpers: containment + recursive frame members (group move)
 * ---------------------------------------------------------------- */
await check('frame helpers: containment and recursive descendants', async () => {
  const source = await readFile(join(bundle, 'client.js'), 'utf8');
  const start = source.indexOf('// #region frame-helpers');
  const end = source.indexOf('// #endregion frame-helpers');
  assert.ok(start > 0 && end > start, 'frame helpers region present');
  const factory = new Function(`${source.slice(start, end)}\nreturn { frameContainingPoint, frameDescendants };`);
  const { frameContainingPoint, frameDescendants } = factory();
  const items = {
    f1: { id: 'f1', type: 'frame', x: 0, y: 0, w: 800, h: 600 },
    f2: { id: 'f2', type: 'frame', x: 100, y: 100, w: 300, h: 200, frameId: 'f1' },
    n1: { id: 'n1', type: 'note', x: 200, y: 150, w: 240, h: 168, frameId: 'f2' },
    n2: { id: 'n2', type: 'note', x: 500, y: 400, w: 240, h: 168, frameId: 'f1' },
    e1: { id: 'e1', type: 'edge', from: 'n1', to: 'n2' },
  };
  assert.equal(frameContainingPoint(items, { x: 220, y: 170 }).id, 'f2', 'innermost frame wins');
  assert.equal(frameContainingPoint(items, { x: 700, y: 500 }).id, 'f1', 'outer frame detected');
  assert.equal(frameContainingPoint(items, { x: 2000, y: 2000 }), null, 'outside any frame → null');
  assert.equal(frameContainingPoint(items, { x: 220, y: 170 }, new Set(['f2'])).id, 'f1', 'excluded frame ignored');
  const descendants = frameDescendants(items, new Set(['f1']));
  assert.deepEqual([...descendants.keys()].sort(), ['f2', 'n1', 'n2'], 'recursive descendants collected');
  const directOnly = frameDescendants(items, new Set(['f2']));
  assert.deepEqual([...directOnly.keys()].sort(), ['n1'], 'nested frame members resolved');
});

/* ---------------------------------------------------------------- *
 * 4f. canvas skins: presets, custom background and local persistence
 * ---------------------------------------------------------------- */
await check('canvas skins: presets, custom background and persistence', async () => {
  const source = await readFile(join(bundle, 'client.js'), 'utf8');
  const start = source.indexOf('// #region skins');
  const end = source.indexOf('// #endregion skins');
  assert.ok(start > 0 && end > start, 'skins region present');
  const storage = {
    data: {},
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : null;
    },
    setItem(key, value) {
      this.data[key] = String(value);
    },
  };
  const factory = new Function('localStorage', `${source.slice(start, end)}\nreturn { SKIN_PRESETS, skinBackground, buildSkinStyle, normalizeSkin, loadSkin, persistSkin, skinOverlays };`);
  const skins = factory(storage);
  assert.ok(skins.SKIN_PRESETS.length >= 3, 'at least three built-in skins');
  for (const preset of skins.SKIN_PRESETS) {
    const style = skins.buildSkinStyle({ kind: 'preset', presetId: preset.id }, { zoom: 0.5, ox: 40, oy: 20, gridSize: 24 });
    assert.ok(String(style.backgroundImage).length > 10, `${preset.id} has background layers`);
    assert.ok(String(style.backgroundSize).length > 0, `${preset.id} has background sizing`);
  }
  const fallback = skins.buildSkinStyle({ kind: 'preset', presetId: 'nope' }, { zoom: 0.5, ox: 0, oy: 0, gridSize: 24 });
  assert.ok(String(fallback.backgroundImage).includes('rgba(255,255,255,.55)'), 'unknown preset falls back to the starry skin');
  const custom = skins.buildSkinStyle({ kind: 'custom', src: 'data:image/jpeg;base64,AAAA', w: 800, h: 600 }, { zoom: 0.5, ox: 10, oy: 20, gridSize: 24 });
  assert.ok(String(custom.backgroundImage).includes('url("data:image/jpeg'), 'custom background uses the uploaded image');
  assert.equal(custom.backgroundSize, '400px 300px', 'custom background scales with zoom');
  assert.equal(skins.normalizeSkin(null).presetId, 'starry', 'invalid skin → default');
  assert.equal(skins.normalizeSkin({ kind: 'custom', src: 'javascript:alert(1)' }).kind, 'preset', 'non-image custom source rejected');
  const customSkin = skins.normalizeSkin({ kind: 'custom', src: 'data:image/png;base64,AA', w: 99999, h: 1 });
  assert.equal(customSkin.kind, 'custom');
  assert.equal(customSkin.w, 6000, 'custom width clamped');
  assert.equal(customSkin.h, 32, 'custom height clamped');
  assert.equal(skins.skinOverlays(customSkin).hud, true, 'custom skin keeps the HUD frame');
  skins.persistSkin({ kind: 'preset', presetId: 'neon' });
  assert.equal(skins.loadSkin().presetId, 'neon', 'skin persisted and reloaded');
  storage.data['dsic.skin.v1'] = '{oops';
  assert.equal(skins.loadSkin().presetId, 'starry', 'corrupt skin storage tolerated');
  assert.equal(factory(undefined).loadSkin().presetId, 'starry', 'no localStorage → default skin');
});

/* ---------------------------------------------------------------- *
 * 5. Host plugin: registration + browser API + agent tools end to end
 * ---------------------------------------------------------------- */
await check('host: index.js parses and wires API + tools + prompt', async () => {
  assert.equal(typeof Request, 'function', 'Node must provide fetch primitives');
  const temporaryHome = join(here, '..', '.verify-home-host');
  await rm(temporaryHome, { recursive: true, force: true });
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = temporaryHome;
  try {
    const host = await import(pathToFileURL(join(bundle, 'index.js')).href);
    assert.equal(typeof host.apply, 'function');
    assert.ok(Array.isArray(host.inject) && host.inject.includes('connection'));
    const tools = new Map();
    const sections = [];
    let route = null;
    const aiMessages = [];
    const llmRequests = [];
    let nextPlan = {};
    let nextDocument = '';
    let nextProjects = {
      projects: [
        { name: '品牌官网', task: '设计品牌官网的页面结构和文案' },
        { name: '小程序', task: '设计小程序的核心流程' },
        { name: '数据看板', task: '设计数据看板的指标和布局' },
      ],
    };
    let llmEnabled = true;
    const agentStub = {
      session: { id: 'session-smoke', header: { updatedAt: '2026-10-21T15:00:00.000Z' } },
      followup: async (message) => {
        aiMessages.push(message);
      },
    };
    const ctxStub = {
      effect: (factory) => {
        const disposer = factory();
        return typeof disposer === 'function' ? disposer : () => {};
      },
      get: (name) => {
        if (name === 'agents') return { roots: () => [agentStub], get: () => agentStub };
        if (name === 'sessionController') {
          return {
            modelCatalog: async () => ({
              default: { provider: 'test-provider', model: 'test-model' },
              routableProviders: ['test-provider', 'alt-provider'],
              groups: [
                {
                  id: 'test-provider',
                  name: 'Test Provider',
                  models: [{ id: 'test-model', name: 'Test Model' }, { id: 'test-model-2', name: 'Test Model 2' }],
                },
                { id: 'alt-provider', name: 'Alt Provider', models: [{ id: 'alt-model', name: 'Alt Model' }] },
              ],
              failures: [],
            }),
          };
        }
        if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) };
        if (name === 'llm') {
          if (!llmEnabled) return undefined;
          return {
            stream: (options) => {
              llmRequests.push(options);
              const wantsDocument = String(options.system).includes('文档生成器');
              const wantsProjects = String(options.system).includes('协调者');
              const body = wantsProjects
                ? JSON.stringify(nextProjects)
                : wantsDocument
                  ? nextDocument
                  : `\`\`\`json\n${JSON.stringify(nextPlan)}\n\`\`\``;
              return (async function* () {
                yield { type: 'text-delta', index: 0, text: body };
                yield { type: 'finish', reason: { kind: 'stop' } };
              })();
            },
          };
        }
        return undefined;
      },
      inject: (_deps, callback) => {
        const child = {
          tools: {
            register: (definition) => {
              if (tools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`);
              tools.set(definition.name, definition);
              return () => {};
            },
          },
          systemPrompt: {
            section: (section) => {
              sections.push(section);
              return () => {};
            },
          },
        };
        callback(child);
        return () => {};
      },
      connection: {
        fetch: {
          register: (definition) => {
            route = definition;
            return () => {};
          },
        },
      },
    };
    host.apply(ctxStub, {});

    const hostSource = await readFile(join(bundle, 'index.js'), 'utf8');
    assert.ok(hostSource.includes("action === 'delegate'"), 'delegate browser action is routed');
    assert.ok(hostSource.includes('MAX_CHILD_AGENTS = 6'), 'per-coordinator child cap of six');
    assert.ok(
      hostSource.includes('buildPlanUserPrompt(prompt, scope, selectedItems, anchor, contextIds)'),
      'project context ids threaded into the plan prompt',
    );
    assert.ok(hostSource.includes('parentId') && hostSource.includes('project'), 'child agent fields supported');
    assert.ok(hostSource.includes("action === 'open-path'"), 'open-path browser action is routed');
    assert.ok(hostSource.includes("spawn(command, [resolved]"), 'local paths are opened with the OS handler');

    assert.ok(route, 'browser API route registered');
    assert.equal(route.path, '/api/canvas.doc');
    assert.ok(route.methods.includes('POST'));
    assert.equal(route.requestBody, 'buffered');
    assert.equal(typeof route.fetch, 'function');
    assert.deepEqual(
      Array.from(tools.keys()).sort(),
      ['canvas_connect', 'canvas_create', 'canvas_delete', 'canvas_focus', 'canvas_read', 'canvas_update'],
    );
    for (const [name, definition] of tools) {
      assert.equal(typeof definition.description, 'string', `${name} description`);
      assert.ok(definition.description.length > 30, `${name} description length`);
      assert.equal(definition.parameters.type, 'object', `${name} parameters root`);
      assert.equal(typeof definition.output.render, 'function', `${name} render`);
      assert.equal(definition.output.schema.type, 'object', `${name} output schema root`);
      assert.equal(typeof definition.execute, 'function', `${name} execute`);
      const blocks = definition.output.render({}, { text: 'hello', revision: 1 });
      assert.ok(Array.isArray(blocks) && blocks[0].type === 'text' && blocks[0].text === 'hello');
    }
    assert.equal(sections.length, 1, 'one system prompt section');
    assert.equal(sections[0].name, 'canvas:infinite-canvas');
    assert.equal(sections[0].order, 3200);
    assert.equal(typeof sections[0].text, 'function');
    assert.ok(sections[0].text().includes('canvas_read'));

    const api = async (action, payload) => {
      const request = new Request('http://127.0.0.1:56311/api/canvas.doc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, payload }),
      });
      const response = await route.fetch(request);
      assert.equal(response.status, 200, `${action} status`);
      assert.match(response.headers.get('content-type') || '', /application\/json/);
      return response.json();
    };
    const runTool = async (name, args = {}) => {
      const definition = tools.get(name);
      return definition.execute(args, { signal: new AbortController().signal });
    };

    const initial = await api('state', {});
    assert.equal(initial.ok, true, 'state ok');
    assert.equal(initial.value.full, true, 'first state is full');
    assert.deepEqual(initial.value.items, {});

    const created = await runTool('canvas_create', { items: [{ type: 'note', text: '想法 A' }, { type: 'note', text: '想法 B' }] });
    assert.equal(created.revision, 1, 'create bumps revision');
    assert.match(created.text, /Created 2 node/);
    assert.match(created.text, /n_|note/);

    const afterCreate = await api('state', {});
    assert.equal(afterCreate.value.full, true);
    const createdItems = Object.values(afterCreate.value.items);
    assert.equal(createdItems.length, 2);
    assert.equal(createdItems[0].by, 'ai', 'agent writes are attributed');

    const read = await runTool('canvas_read', { include: 'full' });
    const parsed = JSON.parse(read.text);
    assert.equal(parsed.total, 2);
    assert.equal(parsed.items.length, 2);
    const [firstId, secondId] = parsed.items.map((item) => item.id);
    assert.ok(firstId && secondId);

    const updated = await runTool('canvas_update', { items: [{ id: firstId, text: '改名了', color: 'blue' }] });
    assert.equal(updated.revision, 2);
    const afterUpdate = await api('state', {});
    assert.equal(afterUpdate.value.items[firstId].text, '改名了');
    assert.equal(afterUpdate.value.items[firstId].color, 'blue');
    assert.equal(afterUpdate.value.items[firstId].by, 'ai', 'agent writes stay attributed after update');

    const connected = await runTool('canvas_connect', { edges: [{ from: firstId, to: secondId, label: '然后' }] });
    assert.match(connected.text, /Connected 1 edge/);

    const focused = await runTool('canvas_focus', { ids: [firstId, secondId] });
    assert.equal(focused.revision, 4);
    const afterFocus = await api('state', {});
    assert.ok(afterFocus.value.focus && typeof afterFocus.value.focus.at === 'number', 'focus request recorded');

    // AI generation: direct LLM route (no conversation involved)
    nextPlan = {
      title: 'AI 生成的流程',
      nodes: [
        { ref: 'a', type: 'note', text: '目标', color: 'yellow' },
        { ref: 'b', type: 'note', text: '方案', color: 'blue' },
        { ref: 'c', type: 'note', text: '结果', color: 'green' },
      ],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c', label: '然后' },
      ],
      focus: ['a'],
    };
    llmEnabled = true;
    const generated = await api('generate', { prompt: '画一个三步流程', scope: 'canvas' });
    assert.equal(generated.ok, true, 'direct generate accepted');
    assert.equal(generated.value.mode, 'direct', 'direct LLM route used');
    assert.ok(generated.value.created >= 5, 'notes and edges created directly on the canvas');
    assert.ok(generated.value.revision > 0, 'revision returned');
    assert.equal(llmRequests.length, 1, 'llm stream called once');
    const llmRequest = llmRequests[0];
    assert.equal(llmRequest.provider, 'test-provider');
    assert.equal(llmRequest.model, 'test-model');
    assert.ok(String(llmRequest.system).includes('JSON'), 'plan system prompt sent');
    const requestText = llmRequest.messages[0].content[0].text;
    assert.ok(requestText.includes('画一个三步流程'), 'prompt forwarded to the model');
    assert.ok(requestText.includes('生成范围'), 'scope explained to the model');
    const afterDirect = await api('state', {});
    const directItems = Object.values(afterDirect.value.items);
    assert.ok(directItems.some((item) => item.text === '目标'), 'generated note landed on the canvas');
    assert.ok(directItems.filter((item) => item.type === 'edge').length >= 2, 'generated edges landed on the canvas');
    assert.ok(afterDirect.value.focus && typeof afterDirect.value.focus.at === 'number', 'focus applied after generation');
    assert.ok(aiMessages.length === 0, 'direct route does not post a chat message');

    // selection scope: answer-type requests must be written back into the selected node
    await runTool('canvas_update', { items: [{ id: firstId, text: '1+1 等于多少？' }] });
    const titleBefore = (await api('state', {})).value.title;
    nextPlan = {
      title: '不应生效的标题',
      updates: [
        { id: firstId, text: '1+1 等于多少？\n答：2' },
        { id: 'not-selected-id', text: 'x' },
      ],
    };
    const selectionGenerate = await api('generate', { prompt: '回答这张便签里的问题', scope: 'selection', selection: [firstId] });
    assert.equal(selectionGenerate.ok, true, 'selection generate accepted');
    assert.equal(selectionGenerate.value.updated, 1, 'only the selected node updated');
    const selectionRequest = llmRequests[1].messages[0].content[0].text;
    assert.ok(selectionRequest.includes('只输出 updates'), 'answer-mode directive sent to the model');
    assert.ok(selectionRequest.includes('答：'), 'answer format explained');
    assert.ok(selectionRequest.includes('1+1 等于多少？'), 'selected node text forwarded');
    const afterSelection = await api('state', {});
    assert.equal(afterSelection.value.items[firstId].text, '1+1 等于多少？\n答：2');
    assert.equal(afterSelection.value.title, titleBefore, 'selection scope must not change the canvas title');
    assert.ok(
      selectionGenerate.value.warnings.some((warning) => warning.includes('not-selected-id')),
      'update outside the selection ignored',
    );

    // ask mode: preview first, nothing written until the caller confirms
    nextPlan = { nodes: [{ ref: 'p', type: 'note', text: '预览便签', color: 'blue' }] };
    const itemCountBeforeAsk = Object.keys((await api('state', {})).value.items).length;
    const preview = await api('generate', { prompt: '加一张便签', scope: 'canvas', mode: 'ask' });
    assert.equal(preview.ok, true, 'ask mode accepted');
    assert.equal(preview.value.mode, 'plan', 'ask mode returns a plan preview');
    assert.ok(typeof preview.value.planId === 'string' && preview.value.planId.length > 0, 'plan id returned');
    assert.ok(preview.value.nodeTexts.includes('预览便签'), 'preview lists the planned node text');
    const itemCountAfterAsk = Object.keys((await api('state', {})).value.items).length;
    assert.equal(itemCountAfterAsk, itemCountBeforeAsk, 'ask mode writes nothing before confirmation');
    const appliedPlan = await api('generate-apply', { planId: preview.value.planId });
    assert.equal(appliedPlan.ok, true, 'plan applied');
    assert.equal(appliedPlan.value.mode, 'direct');
    assert.ok(appliedPlan.value.created >= 1, 'plan writes nodes after confirmation');
    const afterPlanItems = Object.values((await api('state', {})).value.items);
    assert.ok(afterPlanItems.some((item) => item.text === '预览便签'), 'planned node landed on the canvas');
    const reusedPlan = await api('generate-apply', { planId: preview.value.planId });
    assert.equal(reusedPlan.ok, false, 'a plan cannot be applied twice');

    // anchored generation (agent card): created nodes get edges from the anchor
    nextPlan = {
      nodes: [
        { ref: 'a', type: 'note', text: '锚点结果一', color: 'green' },
        { ref: 'b', type: 'note', text: '锚点结果二', color: 'green' },
      ],
    };
    const anchored = await api('generate', {
      prompt: '围绕我生成两张便签',
      scope: 'canvas',
      mode: 'auto',
      anchor: { x: 0, y: 0 },
      anchorId: firstId,
    });
    assert.equal(anchored.ok, true, 'anchored generation accepted');
    const afterAnchorItems = Object.values((await api('state', {})).value.items);
    const anchorEdges = afterAnchorItems.filter((item) => item.type === 'edge' && item.from === firstId);
    assert.ok(anchorEdges.length >= 2, 'generated nodes are connected back to the anchor card');

    // role persona + document output: long-form Markdown becomes frame + text cards
    nextDocument = '# 访谈提纲\n\n## 一、产品假设复述\n这是一个访谈文档正文。\n\n## 二、待验证假设\n- H1：用户确实有痛点\n';
    const docResult = await api('generate', {
      prompt: '设计用户访谈提纲',
      scope: 'canvas',
      output: 'document',
      persona: '# 角色\n你是一位用户研究员',
      anchor: { x: 100, y: 100 },
      anchorId: firstId,
    });
    assert.equal(docResult.ok, true, 'document generation accepted');
    assert.equal(docResult.value.mode, 'document');
    assert.ok(docResult.value.created >= 2, 'frame plus text cards created');
    assert.ok(docResult.value.characters > 0, 'document length reported');
    const docItems = Object.values((await api('state', {})).value.items);
    const docFrame = docItems.find((item) => item.type === 'frame');
    assert.ok(docFrame, 'document frame created');
    const docCard = docItems.find((item) => item.type === 'text' && String(item.text).includes('访谈提纲'));
    assert.ok(docCard, 'document text card created');
    assert.ok(
      docItems.some((item) => item.type === 'edge' && item.from === firstId && item.to === docFrame.id),
      'document frame linked back to the agent card',
    );
    const docRequest = llmRequests[llmRequests.length - 1];
    assert.ok(String(docRequest.system).includes('文档生成器'), 'document system prompt used');
    assert.ok(String(docRequest.messages[0].content[0].text).includes('你是一位用户研究员'), 'persona forwarded to the document prompt');

    // persona is also honoured on the structured plan route
    nextPlan = { nodes: [{ ref: 'x', type: 'note', text: '角色化便签', color: 'blue' }] };
    const personaPlan = await api('generate', { prompt: '生成一张便签', scope: 'canvas', persona: '你是一位严谨的产品经理' });
    assert.equal(personaPlan.ok, true, 'persona plan generation accepted');
    assert.ok(
      String(llmRequests[llmRequests.length - 1].system).includes('你是一位严谨的产品经理'),
      'persona appended to the plan system prompt',
    );

    // ---- A+B: coordinator delegates projects to child Agents (one frame each) ----
    const coordinatorCreate = await api('apply', {
      ops: [
        {
          op: 'upsert',
          item: {
            id: 'coord-agent',
            type: 'agent',
            text: '协调者',
            task: '把新产品拆成三个项目：品牌官网、小程序、数据看板',
            x: -600,
            y: 1200,
            w: 360,
            h: 280,
            status: 'idle',
          },
        },
      ],
    });
    assert.equal(coordinatorCreate.ok, true, 'coordinator card created');
    const delegation = await api('delegate', { parentId: 'coord-agent', prompt: '品牌官网、小程序、数据看板' });
    assert.equal(delegation.ok, true, 'delegate action accepted');
    assert.equal(delegation.value.children.length, 3, 'three child Agents created from the model plan');
    const projectSplitRequest = llmRequests[llmRequests.length - 1];
    assert.ok(
      String(projectSplitRequest.messages[0].content[0].text).includes('品牌官网') ||
        String(projectSplitRequest.messages[0].content[0].text).includes('协调者的任务'),
      'delegation prompt forwarded to the model',
    );
    const afterDelegate = (await api('state', {})).value;
    const childAgents = Object.values(afterDelegate.items).filter(
      (item) => item.type === 'agent' && item.parentId === 'coord-agent',
    );
    assert.equal(childAgents.length, 3, 'children stored with parentId');
    assert.ok(
      childAgents.every((item) => typeof item.project === 'string' && item.project !== ''),
      'each child owns a project name',
    );
    assert.ok(
      childAgents.every((item) => item.frameId && afterDelegate.items[item.frameId]?.type === 'frame'),
      'each child sits inside a project frame',
    );
    const projectFrames = childAgents
      .map((item) => afterDelegate.items[item.frameId])
      .filter((item) => item && item.type === 'frame');
    assert.equal(projectFrames.length, 3, 'one project frame per child');
    assert.ok(
      projectFrames.every((item) => item.meta && item.meta.kind === 'project'),
      'delegated project frames are marked as projects',
    );
    assert.ok(
      projectFrames.some((item) => item.text === '品牌官网'),
      'frame carries the project name',
    );
    const parentEdges = Object.values(afterDelegate.items).filter(
      (item) => item.type === 'edge' && item.from === 'coord-agent',
    );
    assert.equal(parentEdges.length, 3, 'coordinator linked to each child Agent');

    // depth guard: a child cannot delegate further (max two levels)
    const tooDeep = await api('delegate', { parentId: childAgents[0].id });
    assert.equal(tooDeep.ok, false, 'child delegation rejected');
    assert.equal(tooDeep.error.code, 'canvas/depth', 'depth error code returned');

    // per-coordinator cap: never more than six children on one card
    const secondDelegation = await api('delegate', {
      parentId: 'coord-agent',
      projects: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
    });
    assert.equal(secondDelegation.ok, true, 'second delegation accepted within the cap');
    assert.equal(secondDelegation.value.children.length, 3, 'room limited to the remaining child slots');
    const cappedAgain = await api('delegate', { parentId: 'coord-agent', projects: ['x'] });
    assert.equal(cappedAgain.ok, false, 'child limit enforced');
    assert.equal(cappedAgain.error.code, 'canvas/agent-cap');

    // project isolation: the child Agent only sees its own project context
    nextPlan = { nodes: [{ ref: 'z', type: 'note', text: '小程序页面一', color: 'blue' }] };
    const childRun = await api('generate', {
      prompt: '做小程序首页',
      scope: 'canvas',
      anchorId: childAgents[1].id,
      anchor: { x: childAgents[1].x + 40, y: childAgents[1].y + 40 },
      contextIds: [childAgents[1].id, childAgents[1].frameId],
    });
    assert.equal(childRun.ok, true, 'child Agent generation accepted');
    const childRequest = llmRequests[llmRequests.length - 1].messages[0].content[0].text;
    assert.ok(childRequest.includes('上下文范围'), 'child run adds the project scope to the prompt');
    assert.ok(childRequest.includes(childAgents[1].id), 'child prompt lists its own node');
    assert.ok(!childRequest.includes('coord-agent'), 'project context excludes the coordinator node');

    // model picker: catalog endpoint + per-request model override
    const catalog = await api('models', {});
    assert.equal(catalog.ok, true, 'model catalog endpoint ok');
    assert.ok(Array.isArray(catalog.value.providers) && catalog.value.providers.length >= 2, 'providers listed');
    assert.ok(
      catalog.value.providers.some((provider) => Array.isArray(provider.models) && provider.models.length >= 2),
      'provider lists its models',
    );
    nextPlan = { nodes: [{ ref: 'm', type: 'note', text: '指定模型生成', color: 'blue' }] };
    const overrideGenerate = await api('generate', {
      prompt: '用指定模型生成',
      scope: 'canvas',
      model: { provider: 'alt-provider', model: 'alt-model' },
    });
    assert.equal(overrideGenerate.ok, true, 'generation with model override accepted');
    const overrideRequest = llmRequests[llmRequests.length - 1];
    assert.equal(overrideRequest.provider, 'alt-provider', 'override provider used for the call');
    assert.equal(overrideRequest.model, 'alt-model', 'override model used for the call');

    // linked local path: a missing path is reported, nothing is spawned
    const missingPath = await api('open-path', { path: join(temporaryHome, 'definitely-missing-folder') });
    assert.equal(missingPath.ok, false, 'missing local path rejected');
    assert.equal(missingPath.error.code, 'canvas/path-missing', 'missing path error code');
    const emptyPath = await api('open-path', { path: '   ' });
    assert.equal(emptyPath.ok, false, 'empty local path rejected');

    // an unusable plan is reported instead of silently doing nothing
    nextPlan = {};
    const emptyPlan = await api('generate', { prompt: '什么也不做', scope: 'canvas' });
    assert.equal(emptyPlan.ok, false);
    assert.equal(emptyPlan.error.code, 'canvas/empty-plan');

    // fallback to the conversation route when this deployment has no LLM route
    llmEnabled = false;
    const fallback = await api('generate', { prompt: '用会话生成', scope: 'canvas' });
    assert.equal(fallback.ok, true);
    assert.equal(fallback.value.mode, 'session');
    assert.equal(aiMessages.length, 1, 'session fallback queued one chat message');
    llmEnabled = true;

    const missingSelection = await api('generate', { prompt: 'x', scope: 'selection' });
    assert.equal(missingSelection.ok, false, 'selection scope without selection rejected');
    const emptyPrompt = await api('generate', { prompt: '   ' });
    assert.equal(emptyPrompt.ok, false, 'empty prompt rejected');

    // browser-style write, exactly as the panel sends it
    const browserWrite = await api('apply', {
      ops: [{ op: 'upsert', item: { type: 'text', text: '用户写的', x: 0, y: 420, w: 320, h: 90 } }],
    });
    assert.equal(browserWrite.ok, true);
    assert.equal(browserWrite.value.errors.length, 0);
    const browserRevision = browserWrite.value.revision;

    const delta = await api('state', { since: browserRevision - 1 });
    assert.equal(delta.value.full, false, 'delta sync uses the op log');
    assert.ok(Array.isArray(delta.value.ops) && delta.value.ops.length >= 1);

    const viewport = await api('viewport', { viewport: { cx: 5, cy: 6, zoom: 2, vw: 800, vh: 600 } });
    assert.equal(viewport.ok, true);
    const afterViewport = await api('state', { since: browserRevision });
    assert.equal(afterViewport.value.viewport.cx, 5);
    assert.equal(afterViewport.value.viewport.zoom, 2);

    await assert.rejects(() => runTool('canvas_update', { items: [{ id: 'missing', text: 'x' }] }), /no node/);
    await assert.rejects(() => runTool('canvas_create', { items: [] }), /non-empty/);
    await assert.rejects(() => runTool('canvas_create', { items: [{ id: 'hijack', text: 'x' }] }), /omit id/);
    await assert.rejects(() => runTool('canvas_create', { items: [{ type: 'image', text: 'x' }] }), /needs src/);

    const deleted = await runTool('canvas_delete', { ids: [firstId] });
    assert.match(deleted.text, /Deleted/);
    const cleared = await runTool('canvas_delete', { all: true });
    assert.match(cleared.text, /0 nodes remain/);

    const finalState = await api('state', {});
    assert.equal(Object.keys(finalState.value.items).length, 0);

    // persisted file exists under the temporary DSH_HOME
    const persisted = JSON.parse(await readFile(join(temporaryHome, 'canvas', 'scene.json'), 'utf8'));
    assert.equal(persisted.schema, 1);
    assert.equal(typeof persisted.rev, 'number');
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await rm(temporaryHome, { recursive: true, force: true });
  }
});

/* ---------------------------------------------------------------- *
 * report
 * ---------------------------------------------------------------- */
const failed = results.filter((entry) => entry.status === 'FAIL');
for (const entry of results) {
  console.log(`${entry.status === 'PASS' ? '  ok  ' : ' FAIL '} ${entry.name}`);
  if (entry.error) console.log(entry.error.split('\n').map((line) => `        ${line}`).join('\n'));
}
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exitCode = failed.length === 0 ? 0 : 1;
