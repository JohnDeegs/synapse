'use strict';

const https = require('https');
const { stmts } = require('./db');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const EMBEDDING_MODEL = 'gemini-embedding-001';

// ── Gemini Embeddings API ─────────────────────────────────────────────────────

/**
 * Get embedding vector for text using Gemini text-embedding-004.
 * Returns a float array.
 */
function getEmbedding(text) {
  if (!GEMINI_API_KEY) return Promise.reject(new Error('GEMINI_API_KEY not set'));

  const body = JSON.stringify({
    content: { parts: [{ text }] },
  });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${GEMINI_API_KEY}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, res => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(raw);
          if (json.embedding && json.embedding.values) {
            resolve(json.embedding.values);
          } else {
            reject(new Error(`Embedding API error: ${raw}`));
          }
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Math helpers ──────────────────────────────────────────────────────────────

/**
 * Cosine similarity between two float arrays. Returns 0 if either is zero-magnitude.
 */
function cosineSimilarity(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot  += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

// ── RAG helpers ───────────────────────────────────────────────────────────────

/**
 * Find the top N tasks most semantically relevant to userMessage.
 * Tasks without an embedding are excluded from ranking.
 */
async function findRelevantTasks(userMessage, allTasks, topN = 12) {
  const queryEmbedding = await getEmbedding(userMessage);

  return allTasks
    .filter(t => t.embedding)
    .map(t => {
      const vec = JSON.parse(t.embedding);
      return { task: t, score: cosineSimilarity(queryEmbedding, vec) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .map(s => s.task);
}

/**
 * Compute the embedding for a task and persist it to the DB.
 * Safe to call fire-and-forget — errors are logged, never thrown.
 */
async function updateTaskEmbedding(task) {
  if (!GEMINI_API_KEY) return;
  const text = [task.title, task.description].filter(Boolean).join('\n');
  try {
    const vec = await getEmbedding(text);
    stmts.updateTaskEmbedding.run(JSON.stringify(vec), task.id);
  } catch (e) {
    console.error('Failed to update embedding for task', task.id, e.message);
  }
}

/**
 * Backfill embeddings for all tasks that don't have one yet.
 * Called once on server startup. Runs sequentially to avoid rate-limit bursts.
 */
async function backfillEmbeddings() {
  if (!GEMINI_API_KEY) return;
  const tasks = stmts.getTasksWithoutEmbedding.all();
  if (tasks.length === 0) return;
  console.log(`Backfilling embeddings for ${tasks.length} task(s)...`);
  for (const task of tasks) {
    await updateTaskEmbedding(task);
  }
  console.log('Embedding backfill complete.');
}

module.exports = { getEmbedding, cosineSimilarity, findRelevantTasks, updateTaskEmbedding, backfillEmbeddings };
