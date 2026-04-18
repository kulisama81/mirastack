# Agents

MiraStack ships with 6 agents. Each reads your project's CLAUDE.md for domain-specific knowledge.

## @planner

**Role:** TPM/PM — picks tickets, delegates, tracks progress, verifies acceptance criteria.

**Model:** opus (needs strong reasoning for prioritization)

**What it does:**
1. Reads the ticket backlog via tkt
2. Scores tickets by user impact vs effort using a 4-tier system
3. Triages user-submitted tickets that lack acceptance criteria
4. Spawns @creator with detailed instructions
5. The hook pipeline handles the rest (simplify -> validator -> reviewer -> ux-reviewer)
6. Verifies each acceptance criterion with concrete commands before closing
7. Commits completed work

**Key improvements from production:**
- **Structured AC verification** — records `[pass]`/`[fail]` for each criterion in ticket notes
- **Pre-close checklist** — requires clean git status, passing build, passing validation, and individual AC verification
- **Forbidden shortcuts** — explicitly bans "assumed done", "already fixed by X" without verification
- **Post-deploy verification** — checks version markers on live site after pushing
- **Differentiated push policy** — content commits push immediately, tooling commits stay local for review

**Guardrails:**
- Max 2-3 tickets per session
- Max 1 hour per session
- Content changes auto-push; structural changes never push
- Never creates new tickets (works existing backlog only)

**When to use:** Run on cron (e.g., twice daily) or manually when you have tickets ready.

## @creator

**Role:** Implements changes following project conventions.

**Model:** sonnet

**What it does:**
1. Reads the ticket for requirements
2. Reads CLAUDE.md for conventions
3. Creates or modifies files
4. Checks and updates companion materials (flashcards, practice questions, derived assets)
5. Requests /simplify review on completion

**Key improvements from production:**
- **Companion materials checklist** — post-write summary must state status of all companion materials
- **No placeholder content rule** — bans "coming soon", "TBD", etc.
- **Target language awareness** — reads language rules from workflow-config.json for foreign-language content
- **New content category checklist** — references CLAUDE.md for all files that must be updated when adding a new category

**Key behavior:** The creator has NO hardcoded domain knowledge. It reads CLAUDE.md and existing files to learn your project's patterns. This is what makes it work for any project.

## @validator

**Role:** Static analysis before review.

**Model:** sonnet

**What it does:**
1. Runs `content-validate.mjs` (configurable checks from workflow-config.json)
2. Verifies build passes
3. Checks acceptance criteria (when `--ticket` is provided)
4. Creates tkt tickets for issues found

**Configurable checks:** build, frontmatter, heading-hierarchy, katex, svg-blank-lines, html-comments, video-embeds, internal-links, no-placeholder, empty-sections, duplicate-content, content-length, companion-sync, connected-categories, language-conventions, hardcoded-consistency.

## @reviewer

**Role:** Domain accuracy review.

**Model:** sonnet

**What it does:**
1. Reads CLAUDE.md to understand the project domain
2. Reviews content for factual correctness
3. Creates tkt tickets for issues (confidence >= 80%)
4. Writes a structured report to `.reviews/<timestamp>/report.json`

**Key improvement from production:** The reviewer now writes a structured report that the pre-commit hook can check. This mechanically enforces the pipeline -- content commits are blocked unless a clean reviewer report covers all staged files.

**Key behavior:** The reviewer's domain expertise comes from CLAUDE.md. For a study guide, it checks formulas. For API docs, it checks code examples. Write good domain docs and the reviewer will be good at its job.

## @ux-reviewer

**Role:** Visual quality assurance via headless browser.

**Model:** sonnet

**What it does:**
1. Runs `ux-review.mjs` which launches Puppeteer
2. Checks for console errors, broken images, layout overflow
3. Runs configurable checks: KaTeX errors, Mermaid rendering, placeholder text, grid stretch, raw SVG text, iframe issues
4. Verifies acceptance criteria against the rendered page
5. Creates tkt tickets for issues

**Key improvements from production:**
- **Placeholder text detection** — finds "coming soon" and similar phrases in rendered output
- **Grid stretch detection** — finds unequal card widths in grid layouts
- **Raw SVG text detection** — catches SVGs rendering as attribute text instead of graphics
- **Iframe validation** — catches empty-src and zero-dimension iframes
- **Deployment version logging** — records the deployed SHA for build correlation

**The closure gate:** A PreToolUse hook prevents closing tickets without a recent clean UX review report. Tag-based bypass for non-content tickets.

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

**Key improvement from production:** Phase 0 (review recent changes) prevents duplicate proposals by scanning git history since last session.

**Budget awareness:** Respects limits set in `research.md` (max duration, max web fetches, max tickets).

## Pipeline Flow

```
@planner spawns @creator
    |
@creator finishes -> SubagentStop hook fires
    |
/simplify runs -> @validator spawns
    |
@validator finishes -> SubagentStop hook fires
    |
@reviewer spawns
    |
@reviewer finishes -> SubagentStop hook fires
    |
@ux-reviewer spawns
    |
@ux-reviewer finishes -> planner verifies AC -> closes ticket
```

The hooks make this automatic. The planner only needs to spawn @creator.
