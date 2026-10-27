// synapse-ai.js — on-device text embeddings and similarity features.
//
// Model: minishlab/potion-base-4M (model2vec static embeddings, MIT licence).
// A text's vector is the mean of its word-piece vectors, L2-normalised. No
// neural network runs; it is a table lookup, so it is fast everywhere.
//
// The model files are downloaded once from Hugging Face at a pinned revision,
// verified against published hashes, and kept in the Cache API. Nothing about
// the user's data is sent anywhere.
//
// The canonical copy lives in server/web/; extension/synapse-ai.js must be an
// identical copy (a test checks this). Works as a classic script in pages and
// service workers (global SynapseAI) and as a CommonJS module in Node.

(function (root) {
  const REVISION = '9b3cff412d30be9ae8603fe10224c224f3401869';
  const MODEL_ID = 'potion-base-4M@' + REVISION.slice(0, 8);
  const BASE_URL = `https://huggingface.co/minishlab/potion-base-4M/resolve/${REVISION}/`;
  const FILES = {
    model: { name: 'model.safetensors', size: 15118424, sha256: '8a7140edd17ffab30ddcff1135eda127df57abfae856203dbd7b3d061295c31a' },
    vocab: { name: 'vocab.txt', size: 219690, gitSha1: '2f988cb392c3cd1152363bf737816e3530179fa1' },
  };
  const CACHE_NAME = 'synapse-model-v1';
  const MAX_TOKENS = 512;

  // Tuning: similarity thresholds for the features below.
  const FOLDER_MIN_SIM = 0.3;   // folder suggestion
  const SEARCH_MIN_SIM = 0.45;  // "related" search results
  const TAG_MIN_SIM = 0.4;      // tag suggestion
  const MOVE_MIN_SIM = 0.5;     // tidy-up: link fits another folder at least this well...
  const MOVE_MARGIN = 0.15;     // ...and this much better than its own folder
  const DUP_MIN_SIM = 0.95;     // tidy-up: near-identical links

  // ── Integrity ───────────────────────────────────────────────────────────────

  const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

  async function verify(spec, buf) {
    if (buf.byteLength !== spec.size) throw new Error(`${spec.name}: unexpected size ${buf.byteLength}`);
    let actual, expected;
    if (spec.sha256) {
      actual = hex(await crypto.subtle.digest('SHA-256', buf));
      expected = spec.sha256;
    } else {
      // Git blob hash: sha1("blob <size>\0" + content), as listed by Hugging Face.
      const header = new TextEncoder().encode(`blob ${buf.byteLength}\0`);
      const all = new Uint8Array(header.length + buf.byteLength);
      all.set(header);
      all.set(new Uint8Array(buf), header.length);
      actual = hex(await crypto.subtle.digest('SHA-1', all));
      expected = spec.gitSha1;
    }
    if (actual !== expected) throw new Error(`${spec.name}: integrity check failed`);
  }

  /** Fetch a model file: Cache API first, else download, verify, then cache. */
  async function fetchVerified(spec) {
    const url = BASE_URL + spec.name;
    const cache = typeof caches !== 'undefined' ? await caches.open(CACHE_NAME) : null;
    const cached = cache && await cache.match(url);
    if (cached) return cached.arrayBuffer();
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${spec.name}: download failed (${res.status})`);
    const buf = await res.arrayBuffer();
    await verify(spec, buf);
    if (cache) await cache.put(url, new Response(buf));
    return buf;
  }

  // ── Model files ─────────────────────────────────────────────────────────────

  function halfToFloat(h) {
    const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
    if (e === 0) return s * Math.pow(2, -14) * (f / 1024);
    if (e === 31) return f ? NaN : s * Infinity;
    return s * Math.pow(2, e - 15) * (1 + f / 1024);
  }

  /** Parse a safetensors file holding one 2-D "embeddings" tensor. */
  function parseSafetensors(buf) {
    const headerLen = Number(new DataView(buf).getBigUint64(0, true));
    const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, headerLen)));
    const t = header.embeddings || Object.values(header).find(v => v && v.shape);
    if (!t || t.shape.length !== 2) throw new Error('model: embeddings tensor not found');
    const [rows, dim] = t.shape;
    const start = 8 + headerLen + t.data_offsets[0];
    const end = 8 + headerLen + t.data_offsets[1];
    let data;
    if (t.dtype === 'F32') {
      data = new Float32Array(buf.slice(start, end));
    } else if (t.dtype === 'F16') {
      const h = new Uint16Array(buf.slice(start, end));
      data = new Float32Array(h.length);
      for (let i = 0; i < h.length; i++) data[i] = halfToFloat(h[i]);
    } else {
      throw new Error(`model: unsupported dtype ${t.dtype}`);
    }
    return { rows, dim, data };
  }

  function buildModel(modelBuf, vocabBuf) {
    const { rows, dim, data } = parseSafetensors(modelBuf);
    const vocab = new Map();
    new TextDecoder().decode(vocabBuf).split(/\r?\n/).forEach((tok, i) => {
      if (tok && i < rows && !vocab.has(tok)) vocab.set(tok, i);
    });
    return { id: MODEL_ID, rows, dim, data, vocab, unk: vocab.get('[UNK]') };
  }

  let loading = null;

  /**
   * Load the model once per page/worker. `fetchFile(spec)` can be injected
   * (tests); by default files come from the cache or Hugging Face.
   */
  function load({ fetchFile = fetchVerified } = {}) {
    if (!loading) {
      loading = Promise.all([fetchFile(FILES.model), fetchFile(FILES.vocab)])
        .then(([m, v]) => buildModel(m, v))
        .catch(e => { loading = null; throw e; });
    }
    return loading;
  }

  // ── Tokenizer (BERT uncased: basic split + WordPiece) ──────────────────────

  function isPunct(ch, cp) {
    return (cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96) ||
      (cp >= 123 && cp <= 126) || /\p{P}/u.test(ch);
  }

  function isCJK(cp) {
    return (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x20000 && cp <= 0x2a6df) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0x2f800 && cp <= 0x2fa1f);
  }

  function basicTokens(text) {
    const norm = String(text || '').toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '');
    const out = [];
    let cur = '';
    const flush = () => { if (cur) { out.push(cur); cur = ''; } };
    for (const ch of norm) {
      const cp = ch.codePointAt(0);
      if (cp === 0 || cp === 0xfffd || /\s/.test(ch) || /\p{Cc}/u.test(ch)) { flush(); continue; }
      if (isPunct(ch, cp) || isCJK(cp)) { flush(); out.push(ch); continue; }
      cur += ch;
    }
    flush();
    return out;
  }

  function wordPiece(word, vocab, unk) {
    if (word.length > 100) return [unk];
    const ids = [];
    let start = 0;
    while (start < word.length) {
      let end = word.length, id;
      while (start < end) {
        const piece = (start > 0 ? '##' : '') + word.slice(start, end);
        id = vocab.get(piece);
        if (id !== undefined) break;
        end--;
      }
      if (id === undefined) return [unk];
      ids.push(id);
      start = end;
    }
    return ids;
  }

  function tokenize(model, text) {
    const ids = [];
    for (const w of basicTokens(text)) {
      for (const id of wordPiece(w, model.vocab, model.unk)) {
        if (id !== undefined && id !== model.unk) ids.push(id);
        if (ids.length >= MAX_TOKENS) return ids;
      }
    }
    return ids;
  }

  // ── Vectors ─────────────────────────────────────────────────────────────────

  function normalize(v) {
    let n = 0;
    for (let i = 0; i < v.length; i++) n += v[i] * v[i];
    n = Math.sqrt(n);
    if (!n) return null;
    for (let i = 0; i < v.length; i++) v[i] /= n;
    return v;
  }

  /** Mean of word-piece vectors, L2-normalised. Null if no known words. */
  function embed(model, text) {
    const ids = tokenize(model, text);
    if (!ids.length) return null;
    const v = new Float32Array(model.dim);
    for (const id of ids) {
      const off = id * model.dim;
      for (let i = 0; i < model.dim; i++) v[i] += model.data[off + i];
    }
    return normalize(v);
  }

  const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

  // Stored as int8 + base64 (~4x smaller than float32). Cosine similarity is
  // scale-invariant, so each vector uses its own scale and none is stored.
  function encode(v) {
    let max = 0;
    for (const x of v) max = Math.max(max, Math.abs(x));
    const bytes = new Uint8Array(v.length);
    for (let i = 0; i < v.length; i++) bytes[i] = (Math.round((v[i] / (max || 1)) * 127) + 256) & 255;
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  }

  function decode(s) {
    const bin = atob(s);
    const v = new Float32Array(bin.length);
    for (let i = 0; i < bin.length; i++) { const b = bin.charCodeAt(i); v[i] = b > 127 ? b - 256 : b; }
    return normalize(v);
  }

  // Readable words from a URL path (SharePoint file and site names), skipping ids.
  function urlWords(item) {
    if (item.type !== 'link' || !/^https?:/i.test(item.url || '') || item.kind === 'gdoc') return '';
    try {
      return decodeURIComponent(new URL(item.url).pathname)
        .split(/[^\p{L}]+/u).filter(w => w.length >= 3 && !/^(sites|teams|personal|shared|documents|layouts|aspx|docx|xlsx|pptx|forms)$/i.test(w))
        .join(' ');
    } catch { return ''; }
  }

  /** The text that represents an item: title, note, tags and URL words. */
  function textFor(item) {
    return [item.title, item.note, (item.tags || []).join(' '), urlWords(item)].filter(Boolean).join('. ');
  }

  const hasCurrent = item => item.embedding && item.embedding.model === MODEL_ID;

  /** Items whose stored vector is missing or from another model version. */
  function missing(items) {
    return items.filter(i => i.parentId !== null && !hasCurrent(i));
  }

  // ── Features ────────────────────────────────────────────────────────────────

  /**
   * Precompute item vectors and folder "fingerprints". A folder's fingerprint
   * is the sum of its own vector and its direct child links' vectors, so a
   * folder means what its name, note and contents mean.
   */
  function buildIndex(items) {
    const byId = new Map(items.map(i => [i.id, i]));
    const vecs = new Map();
    for (const i of items) if (hasCurrent(i)) { const v = decode(i.embedding.v); if (v) vecs.set(i.id, v); }
    const sums = new Map(); // folderId -> { sum, n }
    const addTo = (folderId, v) => {
      const f = byId.get(folderId);
      if (!f || f.type !== 'folder' || f.parentId === null) return;
      const s = sums.get(folderId) || { sum: new Float32Array(v.length), n: 0 };
      for (let k = 0; k < v.length; k++) s.sum[k] += v[k];
      s.n++;
      sums.set(folderId, s);
    };
    for (const [id, v] of vecs) {
      const i = byId.get(id);
      if (i.type === 'folder') addTo(i.id, v);
      else addTo(i.parentId, v);
    }
    return { byId, vecs, sums };
  }

  function simToSum(v, s, minus) {
    const sum = minus ? s.sum.map((x, k) => x - minus[k]) : s.sum;
    let n = 0;
    for (const x of sum) n += x * x;
    return n ? dot(v, sum) / Math.sqrt(n) : 0;
  }

  /** Folders most similar to a vector. Archived folders are skipped. */
  function suggestFolders(index, v, { limit = 3, min = FOLDER_MIN_SIM } = {}) {
    if (!v) return [];
    const out = [];
    for (const [folderId, s] of index.sums) {
      if (index.byId.get(folderId).para === 'archive') continue;
      const sim = simToSum(v, s);
      if (sim >= min) out.push({ folderId, sim });
    }
    return out.sort((a, b) => b.sim - a.sim).slice(0, limit);
  }

  /** Item ids related in meaning to a query vector, best first. */
  function search(index, v, { min = SEARCH_MIN_SIM, limit = 20 } = {}) {
    if (!v) return [];
    const out = [];
    for (const [id, iv] of index.vecs) {
      const sim = dot(v, iv);
      if (sim >= min) out.push({ id, sim });
    }
    return out.sort((a, b) => b.sim - a.sim).slice(0, limit);
  }

  /** Existing tags whose items are similar to a vector, minus ones already applied. */
  function suggestTags(index, v, { exclude = [], limit = 3, min = TAG_MIN_SIM } = {}) {
    if (!v) return [];
    const sums = new Map();
    for (const [id, iv] of index.vecs) {
      for (const t of index.byId.get(id).tags || []) {
        if (exclude.includes(t)) continue;
        const s = sums.get(t) || { sum: new Float32Array(iv.length), n: 0 };
        for (let k = 0; k < iv.length; k++) s.sum[k] += iv[k];
        s.n++;
        sums.set(t, s);
      }
    }
    return [...sums].map(([tag, s]) => ({ tag, sim: simToSum(v, s) }))
      .filter(t => t.sim >= min).sort((a, b) => b.sim - a.sim).slice(0, limit);
  }

  /**
   * Weekly-review hints:
   *   move      — a link fits another folder clearly better than its own
   *               (its own folder is scored without the link itself)
   *   duplicate — two links with near-identical meaning
   */
  function hints(index, { limit = 10 } = {}) {
    const out = [];
    const links = [...index.vecs].filter(([id]) => {
      const i = index.byId.get(id);
      return i.type === 'link' && i.para !== 'archive';
    });
    for (const [id, v] of links) {
      const item = index.byId.get(id);
      const own = index.sums.get(item.parentId);
      const ownSim = own && own.n > 1 ? simToSum(v, own, v) : null;
      let best = null;
      for (const [folderId, s] of index.sums) {
        if (folderId === item.parentId || index.byId.get(folderId).para === 'archive') continue;
        const sim = simToSum(v, s);
        if (!best || sim > best.sim) best = { folderId, sim };
      }
      if (best && ownSim !== null && best.sim >= MOVE_MIN_SIM && best.sim - ownSim >= MOVE_MARGIN) {
        out.push({ type: 'move', itemId: id, toFolderId: best.folderId, sim: best.sim, ownSim });
      }
    }
    for (let a = 0; a < links.length; a++) {
      for (let b = a + 1; b < links.length; b++) {
        const sim = dot(links[a][1], links[b][1]);
        if (sim >= DUP_MIN_SIM) out.push({ type: 'duplicate', itemId: links[a][0], otherId: links[b][0], sim });
      }
    }
    return out.sort((x, y) => y.sim - x.sim).slice(0, limit);
  }

  const api = {
    MODEL_ID, FILES, BASE_URL,
    load, embed, encode, decode, textFor, missing, buildIndex,
    suggestFolders, search, suggestTags, hints,
    _internal: { basicTokens, wordPiece, tokenize, buildModel, verify, parseSafetensors },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SynapseAI = api;
})(typeof self !== 'undefined' ? self : globalThis);
