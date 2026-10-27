// Data layer. All persistence goes through this module; nothing else talks to
// Firestore or the data file directly.
//
// Backends:
//   - Firestore (production): used when STORE=firestore. Credentials come from
//     Application Default Credentials (automatic on Cloud Run).
//   - JSON file (local dev / tests): the default. Path from DATA_FILE
//     (default ./synapse-data.json).
//
// Each user's items are cached in memory after the first read and written
// through on every change. This keeps Firestore reads low, and is only correct
// while a single server instance is running (Cloud Run max-instances=1).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function newId() {
  return crypto.randomBytes(10).toString('base64url');
}

function userIdForEmail(email) {
  return crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 32);
}

const clone = obj => JSON.parse(JSON.stringify(obj));

// ── JSON file backend ─────────────────────────────────────────────────────────

function fileBackend(file) {
  const resolved = path.resolve(file);
  let data = { users: {}, items: {} };
  if (fs.existsSync(resolved)) data = JSON.parse(fs.readFileSync(resolved, 'utf8'));

  function save() {
    const tmp = resolved + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, resolved);
  }

  return {
    async getUser(id) {
      return data.users[id] ? clone(data.users[id]) : null;
    },
    async createUser(user) {
      if (data.users[user.id]) return false;
      data.users[user.id] = user;
      save();
      return true;
    },
    async loadItems(userId) {
      return Object.values(data.items[userId] || {}).map(clone);
    },
    async writeItems(userId, puts, deletes) {
      const bucket = data.items[userId] || (data.items[userId] = {});
      for (const item of puts) bucket[item.id] = clone(item);
      for (const id of deletes) delete bucket[id];
      save();
    },
  };
}

// ── Firestore backend ─────────────────────────────────────────────────────────

function firestoreBackend() {
  const { Firestore } = require('@google-cloud/firestore');
  const fsdb = new Firestore({ ignoreUndefinedProperties: true });
  const users = fsdb.collection('users');
  const itemsOf = userId => users.doc(userId).collection('items');

  return {
    async getUser(id) {
      const snap = await users.doc(id).get();
      return snap.exists ? snap.data() : null;
    },
    async createUser(user) {
      try {
        await users.doc(user.id).create(user);
        return true;
      } catch (e) {
        if (e.code === 6) return false; // ALREADY_EXISTS
        throw e;
      }
    },
    async loadItems(userId) {
      const snap = await itemsOf(userId).get();
      return snap.docs.map(d => d.data());
    },
    async writeItems(userId, puts, deletes) {
      const col = itemsOf(userId);
      // Firestore batches are capped at 500 writes.
      const ops = [...puts.map(i => ['set', i]), ...deletes.map(id => ['delete', id])];
      for (let i = 0; i < ops.length; i += 500) {
        const batch = fsdb.batch();
        for (const [op, arg] of ops.slice(i, i + 500)) {
          if (op === 'set') batch.set(col.doc(arg.id), arg);
          else batch.delete(col.doc(arg));
        }
        await batch.commit();
      }
    },
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

const backend = process.env.STORE === 'firestore'
  ? firestoreBackend()
  : fileBackend(process.env.DATA_FILE || './synapse-data.json');

const cache = new Map(); // userId -> Map(itemId -> item)

async function userItems(userId) {
  if (!cache.has(userId)) {
    const items = await backend.loadItems(userId);
    cache.set(userId, new Map(items.map(i => [i.id, i])));
  }
  return cache.get(userId);
}

module.exports = {
  newId,

  async findUserByEmail(email) {
    return backend.getUser(userIdForEmail(email));
  },

  /** Returns the new user, or null if the email is already registered. */
  async createUser(email, passwordHash) {
    const user = {
      id: userIdForEmail(email),
      email: email.trim().toLowerCase(),
      passwordHash,
      createdAt: new Date().toISOString(),
    };
    return (await backend.createUser(user)) ? user : null;
  },

  async listItems(userId) {
    return [...(await userItems(userId)).values()].map(clone);
  },

  async getItem(userId, id) {
    const item = (await userItems(userId)).get(id);
    return item ? clone(item) : null;
  },

  /** Create or replace items and delete ids, as one write. */
  async writeItems(userId, puts = [], deletes = []) {
    const items = await userItems(userId);
    await backend.writeItems(userId, puts, deletes);
    for (const item of puts) items.set(item.id, clone(item));
    for (const id of deletes) items.delete(id);
  },
};
