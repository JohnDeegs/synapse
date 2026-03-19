'use strict';

const https = require('https');
const { stmts } = require('./db');
const {
  createTask, getTaskById, checkinTask, completeTask, snoozeTask, getActiveTasks,
} = require('./tasks');
const { updateTaskEmbedding } = require('./embeddings');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const CHAT_MODEL     = 'gemini-2.5-flash';

// ── Tool schema ───────────────────────────────────────────────────────────────

const TOOL_DECLARATIONS = [
  {
    name: 'list_tasks',
    description: 'List the user\'s tasks. Use filter "due_today" for tasks due today, "overdue" for past-due tasks, or "all" for all active tasks.',
    parameters: {
      type: 'OBJECT',
      properties: {
        filter: {
          type: 'STRING',
          enum: ['due_today', 'overdue', 'all'],
          description: 'Which tasks to retrieve',
        },
      },
      required: ['filter'],
    },
  },
  {
    name: 'create_task',
    description: 'Create a new task for the user.',
    parameters: {
      type: 'OBJECT',
      properties: {
        title:       { type: 'STRING', description: 'Task title' },
        priority:    { type: 'STRING', enum: ['P0','P1','P2','P3','P4'], description: 'Task priority: P0=critical(30min), P1=high(2hr), P2=medium(1day), P3=low(3days), P4=someday(1week)' },
        description: { type: 'STRING', description: 'Optional task description' },
      },
      required: ['title', 'priority'],
    },
  },
  {
    name: 'complete_task',
    description: 'Mark a task as completed.',
    parameters: {
      type: 'OBJECT',
      properties: {
        taskId: { type: 'NUMBER', description: 'ID of the task to complete' },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'checkin_task',
    description: 'Check in on a task, optionally recording a status note. Resets and widens the reminder interval.',
    parameters: {
      type: 'OBJECT',
      properties: {
        taskId: { type: 'NUMBER', description: 'ID of the task to check in on' },
        note:   { type: 'STRING', description: 'Optional status update note' },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'snooze_task',
    description: 'Snooze a task for a specified number of minutes.',
    parameters: {
      type: 'OBJECT',
      properties: {
        taskId:  { type: 'NUMBER', description: 'ID of the task to snooze' },
        minutes: { type: 'NUMBER', description: 'Number of minutes to snooze' },
      },
      required: ['taskId', 'minutes'],
    },
  },
  {
    name: 'get_stats',
    description: 'Get task statistics. Returns counts of active, overdue, and completed tasks.',
    parameters: {
      type: 'OBJECT',
      properties: {
        period: { type: 'STRING', enum: ['today', 'week'], description: 'Time period context for the summary' },
      },
      required: ['period'],
    },
  },
];

// ── System prompt ─────────────────────────────────────────────────────────────

function buildSystemPrompt() {
  return `You are Synapse, the user's personal assistant. You live in Telegram and your whole job is to keep their life organised. Think of yourself as a trusted, slightly witty PA who genuinely cares about keeping them on top of things — not a product, not a bot, just someone who's got their back.

Personality:
- Warm but not gushing. You care, but you're not sycophantic.
- You can be lightly playful when the moment calls for it, but you read the room — if they're stressed about a deadline, don't crack jokes.
- You remember context within the conversation and refer back to it naturally.
- You use "you" and "your" freely. You speak TO them, not AT them.
- Never say "Certainly!", "Of course!", "Great!", "Sure thing!" or any hollow filler. Just respond.

You help manage tasks using spaced repetition reminders. When no tool is needed, just chat naturally — a sentence or two is fine.

Priority levels:
- P0 (Critical): reminds every 30 min — drop everything
- P1 (High): every 2 hours — needs doing today
- P2 (Medium): every 24 hours — this week
- P3 (Low): every 72 hours — on the radar
- P4 (Someday): weekly — when you get to it

Mapping language to priorities:
- "critical", "urgent", "ASAP", "right now" → P0
- "important", "today", "high priority" → P1
- "this week", "medium" → P2
- "low priority", "eventually" → P3
- "someday", "nice to have", "maybe" → P4
- Default to P2 if unclear

When listing tasks: numbered list, title first, priority level, then when the next nudge is due. Scannable, not verbose. Never show raw IDs — use them only for tool calls.
Example:
1. Cancel credit card — Medium, reminder tomorrow
2. Review Q2 budget — Critical, reminder in 25 min

When confirming an action: short and natural. "Done, I've marked that off." or "Added — I'll nudge you about it tomorrow."
When there are no tasks: "Nothing on your list right now — enjoy the quiet." or similar.`;
}

// ── Gemini API helper ─────────────────────────────────────────────────────────

function geminiGenerateContent(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${CHAT_MODEL}:generateContent`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'x-goog-api-key': GEMINI_API_KEY,
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

// ── Tool schema validation ────────────────────────────────────────────────────

/**
 * Validate that a function call name and args conform to the tool schema.
 * Returns an error string if invalid, or null if valid.
 */
function validateToolCall(name, args) {
  const decl = TOOL_DECLARATIONS.find(t => t.name === name);
  if (!decl) return `Unknown tool: ${name}`;

  for (const req of (decl.parameters.required || [])) {
    if (args[req] === undefined || args[req] === null) {
      return `Missing required argument "${req}" for tool "${name}"`;
    }
  }

  // Type checks for critical numeric fields
  if (args.taskId !== undefined && typeof args.taskId !== 'number') {
    return `taskId must be a number`;
  }
  if (args.minutes !== undefined && typeof args.minutes !== 'number') {
    return `minutes must be a number`;
  }

  // Enum checks
  if (args.filter && !['due_today','overdue','all'].includes(args.filter)) {
    return `filter must be one of: due_today, overdue, all`;
  }
  if (args.priority && !['P0','P1','P2','P3','P4'].includes(args.priority)) {
    return `priority must be P0–P4`;
  }
  if (args.period && !['today','week'].includes(args.period)) {
    return `period must be "today" or "week"`;
  }

  return null;
}

// ── Tool implementations ──────────────────────────────────────────────────────

function formatRelativeTime(isoStr) {
  const ms = new Date(isoStr) - Date.now();
  if (ms < 0) {
    const overdueMins = Math.round(-ms / 60000);
    if (overdueMins < 60) return `overdue by ${overdueMins} min`;
    const overdueHrs = Math.round(overdueMins / 60);
    if (overdueHrs < 24) return `overdue by ${overdueHrs} hr`;
    return `overdue by ${Math.round(overdueHrs / 24)} day(s)`;
  }
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `in ${mins} min`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `in ${hrs} hr`;
  const days = Math.round(hrs / 24);
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

function executeListTasks(args, userId) {
  const now = new Date().toISOString();
  const tasks = getActiveTasks(userId);

  let filtered;
  if (args.filter === 'overdue') {
    filtered = tasks.filter(t => t.next_reminder < now);
  } else if (args.filter === 'due_today') {
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);
    filtered = tasks.filter(t => t.next_reminder <= endOfDay.toISOString());
  } else {
    filtered = tasks;
  }

  if (filtered.length === 0) return 'No tasks found.';

  return filtered
    .map(t => `[ID:${t.id}] ${t.priority} | ${formatRelativeTime(t.next_reminder)} | ${t.title}`)
    .join('\n');
}

function executeCreateTask(args, userId) {
  const task = createTask({
    userId,
    title:       args.title,
    priority:    args.priority,
    description: args.description || '',
  });
  updateTaskEmbedding(task).catch(() => {}); // fire-and-forget so RAG finds it next time
  const next = formatRelativeTime(task.next_reminder);
  return `Created task: "${task.title}" (${task.priority}). Next reminder ${next}.`;
}

function executeCompleteTask(args, userId) {
  const task = getTaskById(args.taskId);
  if (!task)                  return `Task ${args.taskId} not found.`;
  if (task.user_id !== userId) return `Task ${args.taskId} not found.`;
  if (task.status === 'completed') return `Task "${task.title}" is already completed.`;

  completeTask(task);
  return `Marked "${task.title}" as completed.`;
}

function executeCheckinTask(args, userId) {
  const task = getTaskById(args.taskId);
  if (!task)                  return `Task ${args.taskId} not found.`;
  if (task.user_id !== userId) return `Task ${args.taskId} not found.`;

  const updated = checkinTask(task, args.note || '');
  const next = formatRelativeTime(updated.next_reminder);
  return `Checked in on "${task.title}". Next reminder ${next}.`;
}

function executeSnoozeTask(args, userId) {
  const task = getTaskById(args.taskId);
  if (!task)                  return `Task ${args.taskId} not found.`;
  if (task.user_id !== userId) return `Task ${args.taskId} not found.`;

  const updated = snoozeTask(task, args.minutes);
  const next = formatRelativeTime(updated.next_reminder);
  return `Snoozed "${task.title}". Next reminder ${next}.`;
}

function executeGetStats(args, userId) {
  const all   = stmts.getAllTasks.all(userId);
  const now   = new Date().toISOString();
  const active    = all.filter(t => t.status === 'active');
  const overdue   = active.filter(t => t.next_reminder < now);
  const completed = all.filter(t => t.status === 'completed');

  return `Stats (${args.period}): ${active.length} active, ${overdue.length} overdue, ${completed.length} completed total.`;
}

function executeTool(name, args, userId) {
  switch (name) {
    case 'list_tasks':    return executeListTasks(args, userId);
    case 'create_task':   return executeCreateTask(args, userId);
    case 'complete_task': return executeCompleteTask(args, userId);
    case 'checkin_task':  return executeCheckinTask(args, userId);
    case 'snooze_task':   return executeSnoozeTask(args, userId);
    case 'get_stats':     return executeGetStats(args, userId);
    default:              return `Unknown tool: ${name}`;
  }
}

// ── Main chat function ────────────────────────────────────────────────────────

/**
 * Send a user message to Gemini with tool calling.
 * Executes any tool call and returns the final formatted text.
 *
 * @param {string}   userMessage    - The raw user message
 * @param {object[]} relevantTasks  - Top-N semantically relevant tasks (for context)
 * @param {object[]} chatHistory    - Array of { role, parts } content objects (last 6 turns)
 * @param {number}   userId         - Authenticated user ID (scopes all tool calls)
 * @returns {Promise<string>}       - Final text to send back to the user
 */
async function chat(userMessage, relevantTasks, chatHistory, userId) {
  if (!GEMINI_API_KEY) {
    return 'LLM is not configured. Please set GEMINI_API_KEY.';
  }

  // Build context block from relevant tasks
  let contextBlock = '';
  if (relevantTasks.length > 0) {
    const now = new Date().toISOString();
    const lines = relevantTasks.map(t =>
      `[ID:${t.id}] ${t.priority} | ${t.status} | ${formatRelativeTime(t.next_reminder)} | ${t.title}`
    );
    contextBlock = `\n\n[Context — relevant tasks]\n${lines.join('\n')}`;
  }

  const userContent = {
    role: 'user',
    parts: [{ text: userMessage + contextBlock }],
  };

  const contents = [...chatHistory, userContent];

  const requestBody = {
    system_instruction: { parts: [{ text: buildSystemPrompt() }] },
    contents,
    tools: [{ function_declarations: TOOL_DECLARATIONS }],
  };

  const response = await geminiGenerateContent(requestBody);

  // Extract the first candidate
  const candidate = response.candidates && response.candidates[0];
  if (!candidate) {
    console.error('Gemini unexpected response:', JSON.stringify(response));
    return 'Sorry, I could not process that request.';
  }

  const modelContent = candidate.content;
  const part = modelContent.parts && modelContent.parts[0];
  if (!part) return 'Sorry, I received an empty response.';

  // ── Function calling flow ──────────────────────────────────────────────────
  if (part.functionCall) {
    const { name, args } = part.functionCall;

    // Validate before executing
    const validationError = validateToolCall(name, args);
    if (validationError) {
      console.error('Tool validation failed:', validationError, { name, args });
      return `I encountered an error processing your request: ${validationError}`;
    }

    const toolResult = executeTool(name, args, userId);

    // Send function result back to Gemini for final natural language response
    const contentsWithResult = [
      ...contents,
      { role: 'model', parts: [{ functionCall: { name, args } }] },
      { role: 'user',  parts: [{ functionResponse: { name, response: { output: toolResult } } }] },
    ];

    const finalResponse = await geminiGenerateContent({
      system_instruction: requestBody.system_instruction,
      contents: contentsWithResult,
      tools: requestBody.tools,
    });

    const finalCandidate = finalResponse.candidates && finalResponse.candidates[0];
    const finalText = finalCandidate &&
      finalCandidate.content &&
      finalCandidate.content.parts &&
      finalCandidate.content.parts[0] &&
      finalCandidate.content.parts[0].text;

    return finalText || toolResult;
  }

  // ── Plain text response ────────────────────────────────────────────────────
  if (part.text) return part.text;

  return 'Sorry, I could not process that request.';
}

module.exports = { chat, buildSystemPrompt, TOOL_DECLARATIONS };
