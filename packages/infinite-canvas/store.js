/**
 * Durable store for the single global canvas document.
 *
 * Preferred medium: the shipped storage-domain form (`ctx.storageDomain.open`) —
 * validated, atomic, serialized writes, outside the profile directory so plugin
 * reinstalls never touch user data.
 *
 * Fallback: the same debounce/coalescing protocol over `node:fs` with a
 * tmp-file + fsync + rename publication under `$DSH_HOME/canvas/`.
 *
 * No imports from @deepseek-ai/* packages: the spec object below is shape-compatible
 * with the installed domain facility (it only calls `valueSchema.parse` on load).
 */
import { appendFile, mkdir, open, readFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { createDoc, SCHEMA_VERSION } from './model.js';

const DOMAIN = 'infinite_canvas';
const TABLE = 'scenes';
const KEY = 'main';
const DEBOUNCE_MS = 220;

/** Local diagnostics directory (`$DSH_HOME/canvas`), created on demand. */
export function canvasDiagnosticsDir() {
  const home = (process.env.DSH_HOME || '').trim() || join(homedir(), '.dsh');
  return join(home, 'canvas');
}

/** Append one diagnostic line; never throws into the caller. */
export async function appendDiagnostic(name, line) {
  try {
    const directory = canvasDiagnosticsDir();
    await mkdir(directory, { recursive: true });
    await appendFile(join(directory, name), `${new Date().toISOString()} ${line}\n`, 'utf8');
  } catch (error) {
    /* diagnostics must never break the feature */
  }
}

/** Where the fs-fallback puts the document; the storage-domain medium lives in `$DSH_HOME/storages/infinite_canvas.json`. */
export function canvasDataLocation() {
  const home = (process.env.DSH_HOME || '').trim() || join(homedir(), '.dsh');
  return join(home, 'canvas', 'scene.json');
}

function normalizeStored(doc) {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) throw new TypeError('stored canvas is not an object');
  if (typeof doc.schema !== 'number') throw new TypeError('stored canvas has no numeric schema');
  if (doc.schema > SCHEMA_VERSION) throw new Error(`stored canvas schema ${doc.schema} is newer than this plugin`);
  if (doc.items === null || typeof doc.items !== 'object' || Array.isArray(doc.items)) {
    throw new TypeError('stored canvas has no items object');
  }
  if (doc.viewport === null || typeof doc.viewport !== 'object') throw new TypeError('stored canvas has no viewport object');
  return { ...doc, schema: SCHEMA_VERSION };
}

/**
 * Shared write pipeline: coalescing debounce, one write in flight, last snapshot wins.
 * @param {{ location: string, read: () => Promise<object|undefined>, write: (doc: object) => Promise<void>, release?: () => Promise<void> }} medium
 */
function createStore(medium) {
  let pending = null;
  let timer = null;
  let writing = null;
  let waiters = [];
  let closed = false;

  const kick = () => {
    if (writing !== null || pending === null) return writing;
    const snapshot = pending;
    pending = null;
    const batch = waiters;
    waiters = [];
    writing = (async () => {
      try {
        await medium.write(snapshot);
        for (const waiter of batch) waiter.resolve();
      } catch (error) {
        for (const waiter of batch) waiter.reject(error);
      } finally {
        writing = null;
        if (pending !== null && timer === null) kick();
      }
    })();
    return writing;
  };

  return {
    location: medium.location,
    /** Load the stored document, creating and persisting a fresh one when absent. */
    async load() {
      const stored = await medium.read();
      if (stored === undefined || stored === null) {
        const fresh = createDoc();
        await medium.write(fresh);
        return fresh;
      }
      return normalizeStored(structuredClone(stored));
    },
    /** Queue a save; resolves once the snapshot is durable. */
    save(doc) {
      if (closed) return Promise.reject(new Error('canvas store is closed'));
      pending = structuredClone(doc);
      if (timer === null) {
        timer = setTimeout(() => {
          timer = null;
          kick();
        }, DEBOUNCE_MS);
      }
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
    /** Drain the debounce and any in-flight write. */
    async flush() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      while (pending !== null || writing !== null) {
        kick();
        if (writing !== null) await writing.catch(() => {});
      }
    },
    async close() {
      await this.flush();
      closed = true;
      if (typeof medium.release === 'function') await medium.release();
    },
  };
}

function fileMedium(location) {
  const directory = join(location, '..');
  const publish = async (doc) => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(doc, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, location);
    if (process.platform !== 'win32') {
      const dirHandle = await open(directory, 'r');
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close();
      }
    }
  };
  return {
    location,
    async read() {
      try {
        return JSON.parse(await readFile(location, 'utf8'));
      } catch (error) {
        if (error && error.code === 'ENOENT') return undefined;
        throw error;
      }
    },
    write: publish,
  };
}

/**
 * Open the canvas document store.
 *
 * The medium is chosen by service presence, never by an open failure: a failed domain
 * open throws so the caller can run memory-only, because silently switching media would
 * split the user's canvas between two files.
 *
 * @param {object} ctx plugin context
 * @param {(message: string) => void} log diagnostic sink
 */
export async function createCanvasStore(ctx, log) {
  const domain = (() => {
    try {
      return ctx.get('storageDomain');
    } catch (error) {
      return undefined;
    }
  })();

  if (domain && typeof domain.open === 'function') {
    let lastError;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        const handle = await domain.open({
          name: DOMAIN,
          version: 1,
          layout: 'single',
          tables: { [TABLE]: { valueSchema: { parse: (value) => value } } },
        });
        const table = handle.table(TABLE);
        log(`using storage domain "${DOMAIN}"`);
        return createStore({
          location: `storage-domain:${DOMAIN}`,
          async read() {
            return table.get(KEY);
          },
          async write(doc) {
            await table.put(KEY, doc);
          },
          async release() {
            await handle.close();
          },
        });
      } catch (error) {
        lastError = error;
        // A previous activation that has not finished closing yet reserves the domain name.
        if (error?.code === 'already-open' && attempt < 5) {
          await new Promise((resolve) => setTimeout(resolve, 120));
          continue;
        }
        throw error;
      }
    }
    throw lastError;
  }

  const location = canvasDataLocation();
  log(`using canvas file ${location}`);
  return createStore(fileMedium(location));
}
