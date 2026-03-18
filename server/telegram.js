'use strict';

const https  = require('https');
const crypto = require('crypto');
const { stmts } = require('./db');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

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

    // Upsert the link: remove any existing link for this user, then insert
    stmts.deleteTelegramLinkByUserId.run(codeRow.user_id);
    try {
      stmts.createTelegramLink.run(codeRow.user_id, chatId);
    } catch (e) {
      if (e.message && e.message.includes('UNIQUE constraint failed')) {
        return sendMessage(chatId,
          'This Telegram account is already linked to another Synapse account.'
        );
      }
      throw e;
    }

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

  // Placeholder — Phase 12 will wire up LLM here
  return sendMessage(chatId, 'LLM not yet connected. This feature is coming soon!');
}

module.exports = { registerWebhook, sendMessage, handleUpdate, WEBHOOK_SECRET };
