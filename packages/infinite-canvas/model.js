/**
 * Pure canvas document model for the DeepSeek infinite canvas.
 *
 * The Host owns the only document. Both the Client (through RPC) and the agent
 * tools mutate it through the same operation list, so every write path produces
 * the same normalized result and the same incremental sync log.
 *
 * No imports: this module is plain ESM loaded by the Host plugin.
 */

/** @typedef {{ x: number, y: number, w: number, h: number }} Rect */

export const SCHEMA_VERSION = 1;
export const ITEM_TYPES = ['note', 'text', 'shape', 'frame', 'image', 'edge', 'stroke', 'agent'];
export const AGENT_STATUSES = ['idle', 'running', 'done', 'failed'];
export const SHAPES = ['rect', 'ellipse', 'diamond'];
export const PALETTE = ['yellow', 'blue', 'green', 'pink', 'purple', 'orange', 'gray', 'white'];

const MAX_TEXT = 20000;
const MAX_SRC = 3_000_000;
const MAX_INLINE_SRC = 200_000;
const MAX_COORD = 1_000_000;
const MAX_SIZE = 8000;
const MIN_SIZE = 40;
const MAX_TITLE = 120;
const MAX_ITEMS = 2000;
const MAX_LOG = 400;

const DEFAULTS = {
  note: { w: 280, h: 200, color: 'yellow' },
  text: { w: 360, h: 90, color: 'white' },
  shape: { w: 200, h: 140, color: 'blue' },
  frame: { w: 640, h: 420, color: 'gray' },
  image: { w: 320, h: 240, color: 'white' },
  edge: { w: 0, h: 0, color: 'gray' },
  stroke: { w: 1, h: 1, color: 'gray' },
  agent: { w: 440, h: 340, color: 'purple' },
};

const MAX_STROKE_POINTS = 3000;
const MAX_STROKE_WIDTH = 40;
const MAX_INLINE_GIF = 1_200_000;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const toNumber = (value, fallback) => {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  return Number.isFinite(n) ? n : fallback;
};

const round = (value) => Math.round(value);

let idCounter = 0;
/** Short, stable-looking, collision-resistant item id. */
export function newId(type = 'n') {
  idCounter = (idCounter + 1) % 1_000_000;
  const random = Math.random().toString(36).slice(2, 6);
  return `${type}_${Date.now().toString(36).slice(-4)}${idCounter.toString(36)}${random}`;
}

/** Remove control characters and bound the length of a text field. */
export function cleanText(value, limit = MAX_TEXT) {
  if (value === undefined || value === null) return '';
  const text = String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  return text.length > limit ? text.slice(0, limit) : text;
}

function cleanColor(value, type) {
  return PALETTE.includes(value) ? value : DEFAULTS[type]?.color ?? 'yellow';
}

function cleanSrc(value) {
  const src = cleanText(value, MAX_SRC).trim();
  if (src === '') return '';
  // Inline media is rewritten with the whole document on each save; keep it bounded.
  // Animated GIFs (the local video output) get a larger budget than static images.
  if (/^data:image\/gif/i.test(src)) return src.length <= MAX_INLINE_GIF ? src : '';
  if (/^data:image\//i.test(src)) return src.length <= MAX_INLINE_SRC ? src : '';
  if (/^https?:\/\//i.test(src)) return src;
  return '';
}

function nextZ(items) {
  let z = 0;
  for (const key of Object.keys(items)) {
    const item = items[key];
    if (item && typeof item.z === 'number' && item.z > z) z = item.z;
  }
  return z + 1;
}

/** Create an empty document. */
export function createDoc(now = new Date().toISOString()) {
  return {
    schema: SCHEMA_VERSION,
    id: 'default',
    title: '未命名画板',
    rev: 0,
    updatedAt: now,
    viewport: { cx: 0, cy: 0, zoom: 1, vw: 1200, vh: 800 },
    focus: null,
    items: {},
  };
}

/**
 * Coerce whatever the agent or the browser sent into a valid item.
 * Throws a readable error for values a caller must fix (unknown type, bad edge).
 */
export function normalizeItem(input, existing = undefined, items = {}, now = new Date().toISOString()) {
  if (input === null || typeof input !== 'object') throw new Error('item must be an object');
  const type = input.type ?? existing?.type ?? 'note';
  if (!ITEM_TYPES.includes(type)) {
    throw new Error(`unknown item type ${JSON.stringify(type)}; use one of ${ITEM_TYPES.join(', ')}`);
  }
  const defaults = DEFAULTS[type];
  const id = cleanText(input.id ?? existing?.id ?? newId(type === 'edge' ? 'e' : 'n'), 80).trim();
  if (id === '') throw new Error('item id must not be empty');

  const item = {
    id,
    type,
    x: round(clamp(toNumber(input.x, existing?.x ?? 0), -MAX_COORD, MAX_COORD)),
    y: round(clamp(toNumber(input.y, existing?.y ?? 0), -MAX_COORD, MAX_COORD)),
    w: type === 'edge' ? 0 : round(clamp(toNumber(input.w, existing?.w ?? defaults.w), MIN_SIZE, MAX_SIZE)),
    h: type === 'edge' ? 0 : round(clamp(toNumber(input.h, existing?.h ?? defaults.h), MIN_SIZE, MAX_SIZE)),
    z: round(toNumber(input.z, existing?.z ?? nextZ(items))),
    text: cleanText(input.text ?? existing?.text ?? ''),
    color: cleanColor(input.color ?? existing?.color, type),
    by: input.by === 'ai' || existing?.by === 'ai' ? 'ai' : 'user',
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  if (type === 'shape') {
    const shape = input.shape ?? existing?.shape ?? 'rect';
    item.shape = SHAPES.includes(shape) ? shape : 'rect';
  }
  if (type === 'image') item.src = cleanSrc(input.src ?? existing?.src ?? '');
  if (input.frameId === null) item.frameId = null;
  else if (input.frameId !== undefined || existing?.frameId) {
    item.frameId = cleanText(input.frameId ?? existing?.frameId, 80) || null;
  }
  if (type === 'edge') {
    const from = cleanText(input.from ?? existing?.from ?? '', 80).trim();
    const to = cleanText(input.to ?? existing?.to ?? '', 80).trim();
    if (from === '' || to === '') throw new Error('edge requires non-empty "from" and "to" item ids');
    item.from = from;
    item.to = to;
    item.label = cleanText(input.label ?? existing?.label ?? '', 200);
  }
  if (type === 'stroke') {
    const raw = input.points ?? existing?.points ?? [];    if (!Array.isArray(raw) || raw.length === 0) throw new Error('stroke requires a non-empty "points" array');
    const points = [];
    let maxX = 0;
    let maxY = 0;
    for (const point of raw.slice(0, MAX_STROKE_POINTS)) {
      const px = Array.isArray(point) ? Number(point[0]) : Number(point?.x);
      const py = Array.isArray(point) ? Number(point[1]) : Number(point?.y);
      if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
      const relX = round(clamp(px, 0, MAX_SIZE));
      const relY = round(clamp(py, 0, MAX_SIZE));
      points.push([relX, relY]);
      if (relX > maxX) maxX = relX;
      if (relY > maxY) maxY = relY;
    }
    if (points.length === 0) throw new Error('stroke has no valid points');
    item.points = points;
    item.w = Math.max(1, maxX);
    item.h = Math.max(1, maxY);
    item.width = round(clamp(toNumber(input.width, existing?.width ?? 3), 1, MAX_STROKE_WIDTH));
  }
  if (type === 'agent') {
    item.task = cleanText(input.task ?? existing?.task ?? '', 4000);
    item.role = cleanText(input.role ?? existing?.role ?? '', 12000);
    item.output = (input.output ?? existing?.output ?? 'canvas') === 'document' ? 'document' : 'canvas';
    // Project grouping (A) and parent/child delegation (B): a child agent carries
    // the id of its coordinator plus the project name it is responsible for.
    const parentId = cleanText(input.parentId ?? existing?.parentId ?? '', 80).trim();
    item.parentId = parentId === '' ? null : parentId;
    item.project = cleanText(input.project ?? existing?.project ?? '', 60).trim();
    const status = String(input.status ?? existing?.status ?? 'idle');
    item.status = AGENT_STATUSES.includes(status) ? status : 'idle';
    if (input.agentResult !== undefined || existing?.agentResult) {
      item.agentResult = cleanText(input.agentResult ?? existing?.agentResult ?? '', 2000);
    }
  }
  if (input.meta !== undefined && input.meta !== null && typeof input.meta === 'object') {
    try {
      const encoded = JSON.stringify(input.meta);
      if (encoded.length <= 20000) item.meta = JSON.parse(encoded);
    } catch {
      /* ignore unserializable metadata */
    }
  } else if (existing?.meta) {
    item.meta = existing.meta;
  }
  return item;
}

function normalizeViewport(view, previous) {
  const base = previous ?? { cx: 0, cy: 0, zoom: 1, vw: 1200, vh: 800 };
  return {
    cx: round(clamp(toNumber(view?.cx, base.cx), -MAX_COORD, MAX_COORD)),
    cy: round(clamp(toNumber(view?.cy, base.cy), -MAX_COORD, MAX_COORD)),
    zoom: Math.round(clamp(toNumber(view?.zoom, base.zoom), 0.1, 4) * 1000) / 1000,
    vw: round(clamp(toNumber(view?.vw, base.vw), 100, 20000)),
    vh: round(clamp(toNumber(view?.vh, base.vh), 100, 20000)),
  };
}

/**
 * Apply one batch of operations in place-ish (returns a new doc object).
 * @param {object} doc current document
 * @param {Array<object>} ops operations to apply
 * @param {'user'|'ai'} by writer identity recorded on the items
 * @param {string} now ISO timestamp
 * @returns {{ doc: object, applied: Array<object>, changed: string[], errors: string[] }}
 */
export function applyOps(doc, ops, by = 'user', now = new Date().toISOString()) {
  if (!Array.isArray(ops) || ops.length === 0) throw new Error('ops must be a non-empty array');
  const next = {
    ...doc,
    items: { ...doc.items },
    viewport: { ...doc.viewport },
  };
  const applied = [];
  const changed = [];
  const errors = [];
  let touchedContent = false;

  for (const raw of ops) {
    if (raw === null || typeof raw !== 'object') {
      errors.push('operation must be an object');
      continue;
    }
    const kind = String(raw.op ?? '');
    try {
      if (kind === 'upsert') {
        const replacing = raw.item?.id ? next.items[raw.item.id] : undefined;
        if (!replacing && Object.keys(next.items).length >= MAX_ITEMS) {
          throw new Error(`canvas already holds the maximum of ${MAX_ITEMS} items`);
        }
        const item = normalizeItem({ ...raw.item, by }, replacing, next.items, now);
        next.items[item.id] = item;
        applied.push({ op: 'upsert', item });
        changed.push(item.id);
        touchedContent = true;
      } else if (kind === 'patch') {
        const id = cleanText(raw.id, 80).trim();
        const existing = next.items[id];
        if (!existing) throw new Error(`no item with id ${JSON.stringify(id)}`);
        const item = normalizeItem(
          { ...existing, ...(raw.patch ?? {}), id, by, type: raw.patch?.type ?? existing.type },
          existing,
          next.items,
          now,
        );
        next.items[id] = item;
        applied.push({ op: 'upsert', item });
        changed.push(id);
        touchedContent = true;
      } else if (kind === 'delete') {
        const id = cleanText(raw.id, 80).trim();
        if (!next.items[id]) throw new Error(`no item with id ${JSON.stringify(id)}`);
        delete next.items[id];
        applied.push({ op: 'delete', id });
        changed.push(id);
        for (const key of Object.keys(next.items)) {
          const item = next.items[key];
          if (item.type === 'edge' && (item.from === id || item.to === id)) {
            delete next.items[key];
            applied.push({ op: 'delete', id: key });
            changed.push(key);
          }
        }
        touchedContent = true;
      } else if (kind === 'clear') {
        next.items = {};
        applied.push({ op: 'clear' });
        changed.push('*');
        touchedContent = true;
      } else if (kind === 'title') {
        next.title = cleanText(raw.title, MAX_TITLE).trim() || '未命名画板';
        applied.push({ op: 'title', title: next.title });
      } else if (kind === 'viewport') {
        next.viewport = normalizeViewport(raw.viewport, next.viewport);
        applied.push({ op: 'viewport', viewport: next.viewport });
      } else if (kind === 'focus') {
        const viewport = normalizeViewport({ cx: raw.cx, cy: raw.cy, zoom: raw.zoom ?? next.viewport.zoom, vw: next.viewport.vw, vh: next.viewport.vh }, next.viewport);
        next.focus = { cx: viewport.cx, cy: viewport.cy, zoom: viewport.zoom, at: Date.now() };
        applied.push({ op: 'focus', cx: next.focus.cx, cy: next.focus.cy, zoom: next.focus.zoom, at: next.focus.at });
      } else {
        throw new Error(`unknown op ${JSON.stringify(kind)}; use upsert, patch, delete, clear, title, viewport or focus`);
      }
    } catch (error) {
      errors.push(String(error?.message ?? error));
    }
  }

  if (applied.length === 0) return { doc, applied, changed, errors };
  const rev = (doc.rev ?? 0) + 1;
  next.rev = rev;
  next.updatedAt = now;
  if (touchedContent) next.title = next.title || '未命名画板';
  return { doc: next, applied, changed, errors };
}

/** Append one batch to the bounded sync log. */
export function appendLog(log, entry) {
  const next = log.slice();
  next.push(entry);
  while (next.length > MAX_LOG) next.shift();
  return next;
}

/**
 * Build the incremental or full response for a polling client.
 * @param {object} doc current document
 * @param {Array<object>} log bounded op log
 * @param {number|undefined} since last revision the client saw
 */
export function syncPayload(doc, log, since) {
  const base = { rev: doc.rev, title: doc.title, viewport: doc.viewport, focus: doc.focus, updatedAt: doc.updatedAt };
  const numeric = typeof since === 'number' && Number.isFinite(since);
  if (numeric && since === doc.rev) return { ...base, full: false };
  if (numeric && since > doc.rev) return { ...base, full: true, items: doc.items };
  const firstRev = log.length > 0 ? log[0].rev : doc.rev + 1;
  const canDelta = numeric && log.length > 0 && since >= firstRev - 1;
  if (canDelta) {
    return { ...base, full: false, ops: log.filter((entry) => entry.rev > since).flatMap((entry) => entry.ops) };
  }
  return { ...base, full: true, items: doc.items };
}

function textPreview(text, limit) {
  const single = String(text ?? '').replace(/\s+/g, ' ').trim();
  return single.length > limit ? `${single.slice(0, limit)}…` : single;
}

function visibleWorldRect(doc) {
  const { cx, cy, zoom, vw, vh } = doc.viewport;
  const width = vw / zoom;
  const height = vh / zoom;
  return { x: round(cx - width / 2), y: round(cy - height / 2), w: round(width), h: round(height) };
}

/** Item list without internal noise, for the model. */
export function describeItem(item, textLimit = 160) {
  const described = {
    id: item.id,
    type: item.type,
    x: item.x,
    y: item.y,
    w: item.w,
    h: item.h,
    z: item.z,
    by: item.by,
  };
  if (item.text) described.text = textPreview(item.text, textLimit);
  if (item.type !== 'text' && item.type !== 'image') described.color = item.color;
  if (item.type === 'shape') described.shape = item.shape;
  if (item.type === 'image') described.src = item.src ? item.src.slice(0, 120) : '';
  if (item.type === 'edge') {
    described.from = item.from;
    described.to = item.to;
    if (item.label) described.label = item.label;
  }
  if (item.type === 'stroke') {
    described.points = Array.isArray(item.points) ? item.points.length : 0;
    described.width = item.width ?? 3;
  }
  if (item.type === 'agent') {
    described.status = item.status ?? 'idle';
    described.output = item.output ?? 'canvas';
    if (item.task) described.task = textPreview(item.task, 120);
    if (item.role) described.role = textPreview(item.role, 160);
    if (item.agentResult) described.result = textPreview(item.agentResult, 120);
    if (item.project) described.project = item.project;
    if (item.parentId) described.parentId = item.parentId;
  }
  if (item.frameId) described.frameId = item.frameId;
  return described;
}

export function summarizeDoc(doc, options = {}) {
  const include = options.include === 'full' ? 'full' : 'summary';
  const limit = clamp(Math.trunc(toNumber(options.limit, include === 'full' ? 120 : 200)), 1, 2000);
  const cursor = Math.max(0, Math.trunc(toNumber(options.cursor, 0)));
  const textLimit = include === 'full' ? 4000 : 160;
  const all = Object.values(doc.items).sort((a, b) => a.z - b.z || String(a.id).localeCompare(String(b.id)));
  const slice = all.slice(cursor, cursor + limit);
  const counts = {};
  for (const item of all) counts[item.type] = (counts[item.type] ?? 0) + 1;
  const summary = {
    rev: doc.rev,
    title: doc.title,
    counts,
    total: all.length,
    viewport: { ...doc.viewport, visibleWorld: visibleWorldRect(doc) },
    focus: doc.focus,
    items: slice.map((item) => (include === 'full'
      ? { ...describeItem(item, textLimit), meta: item.meta ?? null, createdAt: item.createdAt, updatedAt: item.updatedAt }
      : describeItem(item, textLimit))),
    cursor,
    nextCursor: cursor + slice.length < all.length ? cursor + slice.length : null,
  };
  return summary;
}

/** Bounding box of the requested items, or of the whole canvas. */
export function boundsOf(doc, ids) {
  const wanted = Array.isArray(ids) && ids.length > 0 ? ids.map(String) : null;
  const items = Object.values(doc.items).filter((item) => item.type !== 'edge' && (wanted === null || wanted.includes(item.id)));
  if (items.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const item of items) {
    minX = Math.min(minX, item.x);
    minY = Math.min(minY, item.y);
    maxX = Math.max(maxX, item.x + item.w);
    maxY = Math.max(maxY, item.y + item.h);
  }
  return { x: round(minX), y: round(minY), w: round(maxX - minX), h: round(maxY - minY) };
}

/**
 * Place a batch of new items that did not declare coordinates: continue to the
 * right of existing content in a 4-column grid, or start a fresh row.
 */
export function placeItems(doc, count, cell = { w: 260, h: 180 }) {
  const gap = 40;
  const columns = 4;
  const bounds = boundsOf(doc, []);
  const startX = bounds === null ? 0 : bounds.x + bounds.w + 120;
  const startY = bounds === null ? 0 : bounds.y;
  const positions = [];
  for (let index = 0; index < count; index += 1) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    positions.push({ x: startX + column * (cell.w + gap), y: startY + row * (cell.h + gap) });
  }
  return positions;
}

/** Viewport that centers the requested rect/ids, with optional zoom. */
export function focusViewport(doc, options = {}) {
  let bounds = boundsOf(doc, options.ids);
  if (options.rect && typeof options.rect === 'object') {
    const rect = {
      x: toNumber(options.rect.x, 0),
      y: toNumber(options.rect.y, 0),
      w: Math.max(1, toNumber(options.rect.w, 100)),
      h: Math.max(1, toNumber(options.rect.h, 100)),
    };
    bounds = bounds === null ? rect : {
      x: Math.min(bounds.x, rect.x),
      y: Math.min(bounds.y, rect.y),
      w: Math.max(bounds.x + bounds.w, rect.x + rect.w) - Math.min(bounds.x, rect.x),
      h: Math.max(bounds.y + bounds.h, rect.y + rect.h) - Math.min(bounds.y, rect.y),
    };
  }
  if (bounds === null) return null;
  const padding = 120;
  const vw = doc.viewport.vw || 1200;
  const vh = doc.viewport.vh || 800;
  const fitZoom = Math.min((vw - padding * 2) / Math.max(bounds.w, 1), (vh - padding * 2) / Math.max(bounds.h, 1));
  const zoom = clamp(toNumber(options.zoom, Math.min(1.2, Math.max(0.2, fitZoom))), 0.1, 4);
  return {
    cx: round(bounds.x + bounds.w / 2),
    cy: round(bounds.y + bounds.h / 2),
    zoom: Math.round(zoom * 1000) / 1000,
  };
}

/** Validate ids exist; returns readable errors for the agent. */
export function missingIds(doc, ids) {
  const missing = [];
  for (const id of ids ?? []) {
    if (!doc.items[String(id)]) missing.push(String(id));
  }
  return missing;
}
