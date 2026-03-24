'use strict';

const https  = require('https');
const crypto = require('crypto');
const { stmts } = require('./db');
const { chat, generateMorningBriefing } = require('./llm');
const { findRelevantTasks } = require('./embeddings');
const { checkRateLimit }    = require('./telegram-rate-limit');
const { getActiveTasks, getBlockedTaskIds } = require('./tasks');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// In-process chat history per chat_id: chatId -> [{role, parts}, ...]
// Limited to last 6 turns (3 user + 3 model). Resets on server restart.
const chatHistories = new Map();
const MAX_HISTORY_TURNS = 6;

// Deterministic webhook secret derived from the bot token — no extra env var needed.
// Changes automatically if the bot token is rotated.
const WEBHOOK_SECRET = BOT_TOKEN
  ? crypto.createHash('sha256').update(BOT_TOKEN).digest('hex').slice(0, 32)
  : null;

// ── Telegram API helpers ──────────────────────────────────────────────────────

function telegramPost(method, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    };
    const req = https.request(options, res => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Register the webhook with Telegram, pointing to <baseUrl>/telegram/webhook.
 * Called once on server startup when TELEGRAM_BOT_TOKEN is set.
 */
async function registerWebhook(baseUrl) {
  const url = `${baseUrl}/telegram/webhook`;
  const result = await telegramPost('setWebhook', {
    url,
    secret_token: WEBHOOK_SECRET,
  });
  console.log('Telegram webhook registered:', JSON.stringify(result));
  return result;
}

/**
 * Send a plain-text message to a chat.
 */
function sendMessage(chatId, text) {
  return telegramPost('sendMessage', { chat_id: chatId, text });
}

/**
 * Route an incoming Telegram update.
 * Handles: /start, /connect <code>, and all other messages.
 */
async function handleUpdate(update) {
  const message = update.message;
  if (!message || !message.text) return;

  const chatId = String(message.chat.id);
  const text   = message.text.trim();

  // /start
  if (text === '/start' || text.startsWith('/start ')) {
    return sendMessage(chatId,
      'Welcome to Synapse!\n\n' +
      'To connect your account:\n' +
      '1. Open the web dashboard\n' +
      '2. Go to Settings \u2192 Telegram\n' +
      '3. Click "Connect Telegram" to get a 6-character code\n' +
      '4. Send /connect <code> to this bot\n\n' +
      'Example: /connect A3X7K2'
    );
  }

  // /connect <code>
  if (text.startsWith('/connect')) {
    const rateResult = checkRateLimit(chatId);
    if (!rateResult.allowed) {
      return sendMessage(chatId,
        `Too many attempts. Please try again ${rateResult.retryAfter}.`
      );
    }

    const parts = text.split(/\s+/);
    const code  = (parts[1] || '').toUpperCase();

    if (!code) {
      return sendMessage(chatId,
        'Usage: /connect <code>\nGet your code from the web dashboard \u2192 Settings \u2192 Telegram.'
      );
    }

    const codeRow = stmts.getTelegramCodeByCode.get(code);
    if (!codeRow) {
      return sendMessage(chatId,
        'Invalid or expired code. Generate a new one from the web dashboard \u2192 Settings \u2192 Telegram.'
      );
    }

    // One-time use: delete the code immediately
    stmts.deleteTelegramCodeById.run(codeRow.id);

    // Upsert the link: clear any existing link for this user OR this chat_id, then insert
    stmts.deleteTelegramLinkByUserId.run(codeRow.user_id);
    stmts.deleteTelegramLinkByChatId.run(chatId);
    stmts.createTelegramLink.run(codeRow.user_id, chatId);

    return sendMessage(chatId, 'Connected! You can now use Synapse from Telegram.');
  }

  // All other messages — check if this chat is linked
  const link = stmts.getTelegramLinkByChatId.get(chatId);
  if (!link) {
    return sendMessage(chatId,
      'Please connect your account first.\n\n' +
      'Open the web dashboard \u2192 Settings \u2192 Telegram and use /connect <code>.'
    );
  }

  // Rate limit check
  const rateResult = checkRateLimit(chatId);
  if (!rateResult.allowed) {
    return sendMessage(chatId,
      `You\u2019re sending messages too fast. Please try again ${rateResult.retryAfter}.`
    );
  }

  // LLM flow: fetch all tasks, find relevant ones, chat, send reply
  const userId = link.user_id;
  const allTasks = stmts.getAllTasks.all(userId);

  let relevantTasks = [];
  try {
    relevantTasks = await findRelevantTasks(text, allTasks);
  } catch (e) {
    console.error('findRelevantTasks error:', e.message);
    // Fall back to most recent active tasks if embeddings unavailable
    relevantTasks = allTasks.filter(t => t.status === 'active').slice(0, 12);
  }

  const history = chatHistories.get(chatId) || [];

  let reply;
  try {
    reply = await chat(text, relevantTasks, history, userId);
  } catch (e) {
    console.error('LLM chat error:', e.message);
    return sendMessage(chatId, 'Sorry, something went wrong. Please try again.');
  }

  // Update in-process history (keep last MAX_HISTORY_TURNS turns)
  history.push(
    { role: 'user',  parts: [{ text }] },
    { role: 'model', parts: [{ text: reply }] }
  );
  if (history.length > MAX_HISTORY_TURNS) {
    history.splice(0, history.length - MAX_HISTORY_TURNS);
  }
  chatHistories.set(chatId, history);

  return sendMessage(chatId, reply);
}

/**
 * Send a morning priority briefing to every linked Telegram user.
 * Called by the daily scheduler in server.js.
 */
async function sendDailyBriefings() {
  if (!BOT_TOKEN) return;

  const links = stmts.getAllTelegramLinks.all();
  for (const link of links) {
    try {
      const tasks = getActiveTasks(link.user_id);
      if (tasks.length === 0) continue;

      let message;
      try {
        message = await generateMorningBriefing(tasks);
      } catch (e) {
        console.error(`Briefing LLM error for user ${link.user_id}:`, e.message);
      }

      if (!message) {
        // Fallback: plain-text summary
        const now = new Date().toISOString();
        const overdue = tasks.filter(t => t.next_reminder < now);
        const top = tasks.slice(0, 5);
        message =
          `Good morning! You have ${tasks.length} active task(s)` +
          (overdue.length ? `, ${overdue.length} overdue` : '') +
          '.\n\nTop priorities:\n' +
          top.map((t, i) => {
            const due = t.due_date ? ` (due ${t.due_date})` : '';
            return `${i + 1}. [${t.priority}] ${t.title}${due}`;
          }).join('\n');
      }

      await sendMessage(link.chat_id, message);
    } catch (e) {
      console.error(`Briefing send error for user ${link.user_id}:`, e.message);
    }
  }
}

/**
 * Send overdue task alerts to each linked Telegram user.
 * Checks for tasks whose next_reminder fell within the last 5 minutes.
 * Called every 5 minutes by the scheduler in server.js.
 */
async function sendOverdueAlerts() {
  if (!BOT_TOKEN) return;

  const links = stmts.getAllTelegramLinks.all();
  const windowStart = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const windowEnd   = new Date().toISOString();

  for (const link of links) {
    try {
      const blockedIds = getBlockedTaskIds();
      const overdue = getActiveTasks(link.user_id)
        .filter(t => t.next_reminder >= windowStart && t.next_reminder <= windowEnd)
        .filter(t => !blockedIds.has(t.id));
      if (overdue.length === 0) continue;

      const lines = overdue.map(t => `• [${t.priority}] ${t.title}`).join('\n');
      const msg = overdue.length === 1
        ? `Overdue reminder:\n${lines}`
        : `${overdue.length} tasks are overdue:\n${lines}`;
      await sendMessage(link.chat_id, msg);
    } catch (e) {
      console.error(`Overdue alert error for user ${link.user_id}:`, e.message);
    }
  }
}

module.exports = { registerWebhook, sendMessage, handleUpdate, sendDailyBriefings, sendOverdueAlerts, WEBHOOK_SECRET };
