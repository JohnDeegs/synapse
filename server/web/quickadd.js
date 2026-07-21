/* quickadd.js — Todoist-style natural language task parsing.
 * Requires the global `chrono` (see vendor/chrono.min.js) to be loaded first.
 * Identical copy lives in extension/quickadd.js (no build step, no shared module system).
 */

/**
 * Parse free text like "Submit invoice every Friday at 9am #Finance @Work p1"
 * into structured task fields.
 *
 * @param {string} input
 * @param {{ tagNames?: string[], projectNames?: string[], now?: Date }} [opts]
 * @returns {{
 *   title: string,
 *   priority: 'P0'|'P1'|'P2'|'P3'|'P4'|null,
 *   dueDate: string|null,      // 'YYYY-MM-DD'
 *   dueTimeMs: number|null,    // absolute ms timestamp, only set when a specific time was parsed
 *   tags: string[],
 *   project: string|null,
 * }}
 */
function parseQuickAdd(input, opts = {}) {
  const now = opts.now || new Date();
  let text = String(input || '');

  // 1. Recurrence normalization — chrono-node has no concept of "every".
  //    "every 2 weeks" -> "in 2 weeks" (chrono understands durations).
  //    "every Friday"  -> "Friday" (chrono + forwardDate resolves to the next one).
  text = text.replace(/\b(every|each)\s+(\d+)\s+(day|days|week|weeks|month|months)\b/gi, 'in $2 $3');
  text = text.replace(/\b(every|each)\s+/gi, '');

  // 2. Priority: first standalone p0-p4 token.
  let priority = null;
  const priorityMatch = text.match(/\bp([0-4])\b/i);
  if (priorityMatch) {
    priority = `P${priorityMatch[1]}`;
    text = text.slice(0, priorityMatch.index) + text.slice(priorityMatch.index + priorityMatch[0].length);
  }

  // 3. Tags: all #word tokens.
  const tags = [];
  text = text.replace(/#([A-Za-z0-9_-]+)/g, (m, name) => {
    tags.push(name);
    return '';
  });

  // 4. Project: all @word tokens, last one wins.
  let project = null;
  text = text.replace(/@([A-Za-z0-9_-]+)/g, (m, name) => {
    project = name;
    return '';
  });

  // 5. Date/time via chrono.
  let dueDate = null;
  let dueTimeMs = null;
  if (typeof chrono !== 'undefined') {
    const results = chrono.parse(text, now, { forwardDate: true });
    if (results.length) {
      const result = results[0];
      const parsedDate = result.start.date();
      dueDate = formatLocalDate(parsedDate);
      if (result.start.isCertain('hour')) {
        dueTimeMs = parsedDate.getTime();
      }
      text = text.slice(0, result.index) + text.slice(result.index + result.text.length);
    }
  }

  // 6. Whatever's left, cleaned up, is the title.
  const title = text.replace(/\s+/g, ' ').replace(/^[\s,.-]+|[\s,.-]+$/g, '').trim();

  return {
    title,
    priority,
    dueDate,
    dueTimeMs,
    tags: dedupeCaseInsensitive(tags),
    project,
  };
}

function formatLocalDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function dedupeCaseInsensitive(names) {
  const seen = new Set();
  const out = [];
  for (const name of names) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}
