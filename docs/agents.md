# Agents

MiraStack ships with 6 agents. Each reads your project's CLAUDE.md for domain-specific knowledge.

## @planner

**Role:** TPM/PM — picks tickets, delegates, tracks progress.

**Model:** opus (needs strong reasoning for prioritization)

**What it does:**
1. Reads the ticket backlog via tkt
2. Scores tickets by user impact vs effort using a 4-tier system
3. Spawns @creator with detailed instructions
4. The hook pipeline handles the rest (simplify → validator → reviewer → ux-reviewer)
5. Commits completed work (never pushes)

**Guardrails:**
- Max 2-3 tickets per session
- Max 1 hour per session
- Never pushes structural changes
- Never creates new tickets (works existing backlog only)

**When to use:** Run on cron (e.g., twice daily) or manually when you have tickets ready.

## @creator

**Role:** Implements changes following project conventions.

**Model:** sonnet

**What it does:**
1. Reads the ticket for requirements
2. Reads CLAUDE.md for conventions
3. Creates or modifies files
4. Requests /simplify review on completion

**Key behavior:** The creator has NO hardcoded domain knowledge. It reads CLAUDE.md and existing files to learn your project's patterns. This is what makes it work for any project.

## @validator

**Role:** Static analysis before review.

**Model:** sonnet

**What it does:**
1. Runs `content-validate.mjs` (configurable checks)
2. Verifies build passes
3. Checks acceptance criteria (when `--ticket` is provided)
4. Creates tkt tickets for issues found

**Configurable checks:** build, frontmatter, heading-hierarchy, katex, svg-blank-lines, html-comments, video-embeds, internal-links.

## @reviewer

**Role:** Domain accuracy review.

**Model:** sonnet

**What it does:**
1. Reads CLAUDE.md to understand the project domain
2. Reviews content for factual correctness
3. Creates tkt tickets for issues (confidence >= 80%)

**Key behavior:** The reviewer's domain expertise comes from CLAUDE.md. For a study guide, it checks formulas. For API docs, it checks code examples. Write good domain docs and the reviewer will be good at its job.

## @ux-reviewer

**Role:** Visual quality assurance via headless browser.

**Model:** sonnet

**What it does:**
1. Runs `ux-review.mjs` which launches Puppeteer
2. Checks for console errors, broken images, layout overflow
3. Optionally checks for KaTeX errors, Mermaid rendering failures
4. Verifies acceptance criteria against the rendered page
5. Creates tkt tickets for issues

**The closure gate:** A PreToolUse hook prevents closing tickets without a recent clean UX review report.

## @autoresearch

**Role:** Opportunity discovery — creates tickets, never implements.

**Model:** sonnet

**What it does:**
1. Reviews recent changes (git log since last session)
2. Analyzes content gaps against requirements
3. Audits SEO (meta tags, structured data, search rankings)
4. Compares against competitors
5. Discovers useful resources
6. Creates tkt tickets for findings

**Budget awareness:** Respects limits set in `research.md` (max duration, max web fetches, max tickets).

## Pipeline Flow

```
@planner spawns @creator
    ↓
@creator finishes → SubagentStop hook fires
    ↓
/simplify runs → @validator spawns
    ↓
@validator finishes → SubagentStop hook fires
    ↓
@reviewer spawns
    ↓
@reviewer finishes → SubagentStop hook fires
    ↓
@ux-reviewer spawns
    ↓
@ux-reviewer finishes → planner closes ticket
```

The hooks make this automatic. The planner only needs to spawn @creator.
