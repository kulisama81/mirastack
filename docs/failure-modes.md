# Failure Modes

Eight failure modes observed in production deployments of the MiraStack pipeline. Each was discovered through real autonomous runs and has a corresponding mitigation built into the agents or hooks.

## 1. Premature Ticket Closure

**What happens:** The planner closes a ticket based on the creator's summary ("done!") without verifying the actual file content matches the acceptance criteria.

**Why it matters:** The creator may have made partial changes, encountered an error mid-task, or misunderstood the requirements. A summary is not verification.

**Mitigation:** The planner's "Acceptance Criteria Verification" section requires structured verification with concrete commands. The `[pass]`/`[fail]` format in ticket notes makes skipped verification visible. The pre-close checklist requires `git status --porcelain` to confirm no uncommitted changes remain.

## 2. Agent Domain Blindness

**What happens:** An agent applies generic patterns without reading the project's CLAUDE.md, producing output that is technically valid but domain-inappropriate. For example, a creator writes content in the wrong format, or a reviewer misses domain-specific errors because it did not load the project's definition of "correct."

**Why it matters:** The entire pipeline relies on CLAUDE.md as the single source of domain truth. If an agent skips reading it, every downstream check is compromised.

**Mitigation:** Every agent's instructions begin with "Read CLAUDE.md" as step 1. The creator is explicitly told "Do NOT hardcode domain knowledge." The reviewer is told "Do NOT rely on hardcoded domain knowledge. The project's CLAUDE.md defines what 'correct' means."

## 3. Phantom Fix Claims

**What happens:** The planner says "this was already fixed by commit abc1234" and closes the ticket -- but the fix was never actually committed, or was committed to a different file, or was reverted.

**Why it matters:** Tickets silently close without the underlying issue being resolved. The next user to hit the bug finds a closed ticket with a false resolution.

**Mitigation:** The planner's "Never claim 'already fixed by X'" section requires three verification steps: (1) confirm the commit exists via `git log`, (2) read the actual file content, (3) run the relevant validation check. Commit message text alone is never sufficient.

## 4. Stale Companion Materials

**What happens:** A creator updates a guide but does not update the corresponding flashcard deck, practice questions, PDF, or other derived assets. The companion materials become stale.

**Why it matters:** Users see outdated supplementary materials that do not match the content they just read. Trust erodes.

**Mitigation:** The creator's "Companion Materials Checklist" requires checking and updating all companion materials after modifying content. The post-write summary must explicitly state the status of each companion material. The validator's `companion-sync` check flags decks that are out of date.

## 5. Orphaned Content Categories

**What happens:** A creator adds a new content directory (e.g., a new subject, a new section) but forgets to wire it into the site's navigation, routes, CSS variables, or index pages. The content exists but users cannot find it.

**Why it matters:** Content that is not discoverable is wasted effort. It also breaks the site's internal consistency.

**Mitigation:** The creator's "New Content Category Checklist" lists every file that must be updated when adding a new category. The validator's `connected-categories` check verifies all content directories are wired to site infrastructure.

## 6. Placeholder Content Shipping

**What happens:** A creator writes "coming soon" or "TBD" in a section that should have real content, intending to fill it in later. The placeholder ships to production.

**Why it matters:** Users see unfinished content and lose trust. Placeholders also tend to persist indefinitely once shipped.

**Mitigation:** The creator's "No Placeholder Content Rule" bans specific phrases. Both the content validator (`no-placeholder` check) and the UX reviewer (`placeholder-text` check) flag these phrases. The ban covers both source files and rendered output.

## 7. Pipeline Bypass via Tag-less Closure

**What happens:** The planner closes a ticket without running the full pipeline (creator -> validator -> reviewer -> ux-reviewer). This can happen when the planner decides a ticket is "trivial" or "already done."

**Why it matters:** The quality gates exist for a reason. Even small changes can introduce rendering bugs or factual errors.

**Mitigation:** The PreToolUse hook on `mcp__tkt__edit` blocks ticket closure unless a recent clean UX review report exists. A tag-based bypass allows non-content tickets (tagged `tooling`, `seo`, `analytics`, etc.) to close without a UX review, since they do not affect rendered content.

## 8. Language Orthographic Drift

**What happens:** Content in a foreign language (e.g., French, Spanish) gradually loses proper diacritical marks as agents add or modify text. "francais" appears instead of "francais" (with cedilla), "education" instead of "education" (with accent).

**Why it matters:** Missing accents are factual errors in language content. In some cases they change meaning ("ou" = "or" vs "ou" with accent = "where").

**Mitigation:** The validator's `language-conventions` check uses per-subject rules defined in workflow-config.json (`validator.languageRules`). It flags common unaccented errors as high-severity issues and checks that required accent characters appear in the content.
