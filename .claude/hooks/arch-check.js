#!/usr/bin/env node
/**
 * PostToolUse hook — architecture mismatch detector.
 * Fires after Edit/Write on monitored src/ files.
 * Reads CLAUDE.md + ARCHITECTURE.md, asks Haiku if the change violates a principle.
 * Outputs a structured warning to stdout (Claude sees this and surfaces it to the user).
 * Never throws or exits non-zero — must never break the workflow.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();

// --- Read stdin ---
let raw = '';
try {
  for await (const chunk of process.stdin) raw += chunk;
} catch {
  process.exit(0);
}

let data;
try {
  data = JSON.parse(raw);
} catch {
  process.exit(0);
}

const { tool_name, tool_input } = data ?? {};
const filePath = tool_input?.file_path ?? '';

// --- Scope: only src/ subdirectories, not tests or generated files ---
const MONITORED_RE = /\/src\/(domain|adapters|workers|db|shared|skills|routes)\//;
if (!MONITORED_RE.test(filePath)) process.exit(0);

// --- Need API key ---
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) process.exit(0);

// --- Build a focused change summary ---
let change = `File: ${filePath}\n`;
if (tool_name === 'Edit') {
  const removed = (tool_input?.old_string ?? '').slice(0, 700);
  const added   = (tool_input?.new_string ?? '').slice(0, 700);
  change += `Removed:\n${removed}\n\nAdded:\n${added}`;
} else if (tool_name === 'Write') {
  change += `Written (first 900 chars):\n${(tool_input?.content ?? '').slice(0, 900)}`;
} else {
  process.exit(0);
}

// --- Load architecture docs ---
function readMd(name, limit = Infinity) {
  try {
    const text = readFileSync(join(ROOT, name), 'utf8');
    return limit < Infinity ? text.slice(0, limit) : text;
  } catch {
    return '';
  }
}

const claudeMd = readMd('CLAUDE.md');                      // ~86 lines, send all
const archMd   = readMd('ARCHITECTURE.md', 5000);          // principles + state machine sections
const devMd    = readMd('DEV_OPERATING_MODEL.md', 2500);

const prompt = `You are an architecture guardian for a software project. A code change was just made.
Your job: decide if it violates any documented invariant or principle.

CHANGE MADE:
${change}

---
CLAUDE.md — Non-Negotiable Principles:
${claudeMd}

---
ARCHITECTURE.md (truncated):
${archMd}

---
DEV_OPERATING_MODEL.md (truncated):
${devMd}

---
Rules for your response:
- If there is NO violation: respond with exactly the word NO_CONFLICT and nothing else.
- If there IS a violation, respond with EXACTLY this two-line format (no extra text):
MISMATCH: <one sentence — what specifically in the change conflicts with what specific documented rule>
CONSEQUENCE: <one sentence — what breaks or becomes inconsistent if this proceeds uncorrected>`;

// --- Call Haiku ---
let text = '';
try {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 220,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const result = await resp.json();
  text = (result.content?.[0]?.text ?? '').trim();
} catch {
  process.exit(0);
}

if (!text || text.startsWith('NO_CONFLICT')) process.exit(0);

// --- Surface the warning (Claude reads stdout and relays to user) ---
process.stdout.write(`
╔══════════════════════════════════════════════════════╗
║          ⚠  ARCHITECTURE MISMATCH DETECTED           ║
╚══════════════════════════════════════════════════════╝

${text}

→ When you are ready to resolve, run /sync-docs.
  Option (a): adjust the planned action to conform with the docs.
  Option (b): update the relevant MD section safely to reflect the new decision.
`);

process.exit(0);
