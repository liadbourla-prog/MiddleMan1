# Sync Docs

Run this after an architecture mismatch warning has been surfaced. The warning is already in context — use it.

## Arguments: $ARGUMENTS

If the user passed an argument ("a" or "b"), skip directly to the corresponding option. Otherwise, present both options and wait for their choice.

---

## What to do

### Step 1 — Confirm what was flagged

Read the MISMATCH and CONSEQUENCE lines from the hook warning in context. State them back in one sentence so the user can confirm this is the right issue to resolve. Then present the two options:

> **Option (a)** — Adjust the planned action so it conforms to the documented architecture.
> **Option (b)** — Update the relevant section of the MD file to safely reflect a deliberate architectural decision.

Wait for the user to choose (a) or (b) unless $ARGUMENTS already specifies it.

---

### Option (a) — Adjust the action

1. Read the file that was just edited (it's named in the MISMATCH line).
2. Identify what specific change is in conflict.
3. Propose a concrete alternative implementation that achieves the same goal without violating the documented invariant. Show the exact diff.
4. Ask the user to confirm before applying.
5. Apply the change with Edit.

Do not make the change first and explain second. Always propose → confirm → apply.

---

### Option (b) — Update the MD file

This option means the architecture is genuinely evolving. Treat it with precision.

1. Identify which document and which section contains the rule being changed (CLAUDE.md, ARCHITECTURE.md, or DEV_OPERATING_MODEL.md).
2. Read that section in full.
3. Draft the minimal edit — change only the specific rule or invariant that the new decision supersedes. Do not rewrite surrounding text.
4. Show the user the exact before/after diff and explain:
   - What constraint is being relaxed or changed.
   - What the downstream consequences are (other parts of the system this rule protects).
   - Whether any other section of any MD file needs a corresponding update to stay consistent.
5. Ask the user to confirm before writing.
6. Apply with Edit. Never use Write to rewrite a whole file.

Do not update more than what the decision requires. If you're unsure whether a section needs updating, ask rather than guess.

---

## Guardrails

- Never silently update both the code and the docs in one shot without surfacing both changes to the user.
- If the mismatch is ambiguous (the hook may have been overzealous), say so and ask the user whether to proceed.
- If option (b) would cascade into multiple doc changes, list them all before applying any.
