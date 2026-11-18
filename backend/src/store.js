// RecallIQ storage layer.
//
// Two adapters share one small document API:
//   - "json":    one file per collection under DATA_DIR. In-memory cache, every write is
//                serialised through a single queue and written atomically (tmp file + rename),
//                so concurrent requests cannot interleave and a crash cannot leave half a file.
//                Good for local development. NOT durable on most cloud hosts (ephemeral disks).
//   - "mongodb": used when MONGODB_URI is set. Recommended for any deployed instance.
//
// Documents always carry a string `id`; Mongo's `_id` is never exposed.
// Filters are plain equality objects ({ ownerId, id, status }), which both adapters support.
// Patches may use dotted paths ("recipients.3.status") in both adapters.

import fs from "node:fs/promises";
import crypto from "node:crypto";
import dns from "node:dns";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const COLLECTIONS = ["users", "sessions", "customers", "campaigns", "gmailTokens", "oauthStates"];

let adapter = null;

const clone = (value) => (value === undefined ? undefined : structuredClone(value));
const now = () => new Date().toISOString();

function matches(doc, filter = {}) {
  return Object.entries(filter).every(([key, value]) => {
    if (value && typeof value === "object" && Array.isArray(value.$in)) return value.$in.map(String).includes(String(doc[key]));
    return doc[key] === value;
  });
}

function setPath(target, dotted, value) {
  const parts = dotted.split(".");
  let node = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    if (node[key] === undefined || node[key] === null) node[key] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    node = node[key];
  }
  node[parts[parts.length - 1]] = value;
}

// ---------------------------------------------------------------- JSON adapter
function jsonAdapter(dataDir) {
  const cache = {};
  let queue = Promise.resolve();

  const fileFor = (collection) => path.join(dataDir, `${collection}.json`);

  async function load() {
    await fs.mkdir(dataDir, { recursive: true });
    for (const collection of COLLECTIONS) {
      try {
        const raw = await fs.readFile(fileFor(collection), "utf8");
        const parsed = JSON.parse(raw || "[]");
        cache[collection] = Array.isArray(parsed) ? parsed : [];
      } catch (error) {
        if (error.code !== "ENOENT") {
          // Never silently discard a corrupt file: keep a copy for inspection, then start empty.
          const backup = `${fileFor(collection)}.corrupt-${Date.now()}`;
          await fs.copyFile(fileFor(collection), backup).catch(() => {});
          console.error(`[store] ${collection}.json could not be parsed. Saved a copy to ${backup}.`);
        }
        cache[collection] = [];
      }
    }
  }

  function persist(collection) {
    const snapshot = JSON.stringify(cache[collection], null, 2);
    const target = fileFor(collection);
    const tmp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
    queue = queue
      .then(async () => {
        await fs.writeFile(tmp, snapshot);
        await fs.rename(tmp, target);
      })
      .catch((error) => console.error(`[store] failed to write ${collection}`, error));
    return queue;
  }

  return {
    mode: "json",
    load,
    async find(collection, filter) { return cache[collection].filter((d) => matches(d, filter)).map(clone); },
    async findOne(collection, filter) { return clone(cache[collection].find((d) => matches(d, filter)) || null); },
    async insert(collection, doc) {
      const saved = { id: crypto.randomUUID(), createdAt: now(), ...doc, updatedAt: now() };
      cache[collection].push(saved);
      await persist(collection);
      return clone(saved);
    },
    async insertMany(collection, docs) {
      const saved = docs.map((doc) => ({ id: crypto.randomUUID(), createdAt: now(), ...doc, updatedAt: now() }));
      cache[collection].push(...saved);
      await persist(collection);
      return saved.map(clone);
    },
    // Updates the first document matching `filter`. Because the check and the write happen in the
    // same synchronous block, a filter like { id, status: "draft" } works as a compare-and-set.
    async update(collection, filter, patch) {
      const doc = cache[collection].find((d) => matches(d, filter));
      if (!doc) return null;
      for (const [key, value] of Object.entries(patch)) setPath(doc, key, clone(value));
      doc.updatedAt = now();
      await persist(collection);
      return clone(doc);
    },
    async remove(collection, filter) {
      const before = cache[collection].length;
      cache[collection] = cache[collection].filter((d) => !matches(d, filter));
      const removed = before - cache[collection].length;
      if (removed) await persist(collection);
      return removed;
    },
    async flush() { await queue; },
  };
}

// ---------------------------------------------------------------- MongoDB adapter
function mongoAdapter(uri) {
  let db;
  const toMongoFilter = (filter = {}) => Object.fromEntries(Object.entries(filter).map(([k, v]) => [k, v]));
  const projection = { projection: { _id: 0 } };

  return {
    mode: "mongodb",
    async load() {
      // Atlas "mongodb+srv://" URIs need a DNS SRV lookup. Some ISP/Windows resolvers refuse SRV
      // queries (error: querySrv ECONNREFUSED). Setting MONGODB_DNS_SERVERS=8.8.8.8,1.1.1.1 works around it.
      if (process.env.MONGODB_DNS_SERVERS) dns.setServers(process.env.MONGODB_DNS_SERVERS.split(",").map((s) => s.trim()));
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
      db = mongoose.connection.db;
      await Promise.all([
        db.collection("users").createIndex({ email: 1 }, { unique: true }),
        db.collection("users").createIndex({ id: 1 }, { unique: true }),
        db.collection("sessions").createIndex({ tokenHash: 1 }, { unique: true }),
        db.collection("customers").createIndex({ ownerId: 1, id: 1 }),
        db.collection("campaigns").createIndex({ ownerId: 1, id: 1 }),
        db.collection("gmailTokens").createIndex({ id: 1 }, { unique: true }),
        db.collection("oauthStates").createIndex({ id: 1 }, { unique: true }),
      ]);
    },
    async find(collection, filter) { return db.collection(collection).find(toMongoFilter(filter), projection).toArray(); },
    async findOne(collection, filter) { return db.collection(collection).findOne(toMongoFilter(filter), projection); },
    async insert(collection, doc) {
      const saved = { id: crypto.randomUUID(), createdAt: now(), ...doc, updatedAt: now() };
      await db.collection(collection).insertOne({ ...saved });
      return saved;
    },
    async insertMany(collection, docs) {
      const saved = docs.map((doc) => ({ id: crypto.randomUUID(), createdAt: now(), ...doc, updatedAt: now() }));
      if (saved.length) await db.collection(collection).insertMany(saved.map((d) => ({ ...d })));
      return saved;
    },
    async update(collection, filter, patch) {
      return db.collection(collection).findOneAndUpdate(
        toMongoFilter(filter),
        { $set: { ...patch, updatedAt: now() } },
        { returnDocument: "after", ...projection },
      );
    },
    async remove(collection, filter) {
      const result = await db.collection(collection).deleteMany(toMongoFilter(filter));
      return result.deletedCount;
    },
    async flush() {},
  };
}

export async function initStore() {
  if (process.env.MONGODB_URI) {
    adapter = mongoAdapter(process.env.MONGODB_URI);
  } else {
    const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.resolve(__dirname, "../data");
    adapter = jsonAdapter(dataDir);
  }
  await adapter.load();
  return adapter.mode;
}

function ready() {
  if (!adapter) throw new Error("Store not initialised. Call initStore() first.");
  return adapter;
}

export const storageMode = () => adapter?.mode || "uninitialised";
export const find = (c, f) => ready().find(c, f);
export const findOne = (c, f) => ready().findOne(c, f);
export const insert = (c, d) => ready().insert(c, d);
export const insertMany = (c, d) => ready().insertMany(c, d);
export const update = (c, f, p) => ready().update(c, f, p);
export const remove = (c, f) => ready().remove(c, f);
export const flush = () => ready().flush();
