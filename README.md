# MiraStack

A drop-in autonomous agent pipeline for any [Claude Code](https://claude.ai/code) project.

Six agents that pick tickets, implement changes, validate, review, and ship — while you sleep.

## What's Included

| Agent | Role |
|---|---|
| **@planner** | TPM — picks highest-impact ticket, orchestrates the pipeline |
| **@creator** | Implements changes following your project's CLAUDE.md conventions |
| **@validator** | Static analysis, build gate, acceptance criteria checks |
| **@reviewer** | Domain accuracy review (reads CLAUDE.md for context) |
| **@ux-reviewer** | Headless browser rendering checks (Puppeteer) |
| **@autoresearch** | Discovers growth opportunities, creates tickets |

Plus:
- **Hook pipeline** — automatic chaining: creator → simplify → validator → reviewer → ux-reviewer
- **Ticket closure gate** — can't close tickets without a clean UX review
- **Feedback sync** — GitHub Issues → tkt tickets automatically
- **Analytics integration** (optional) — GA4 + Search Console data for agents
- **Daily digest** (optional) — email summary via Resend

## How It Works

```
tkt ticket backlog
      ↓
  @planner picks highest-impact ticket
      ↓
  @creator implements (follows CLAUDE.md)
      ↓  [hook: SubagentStop]
  /simplify reviews code quality
      ↓
  @validator runs build + static checks
      ↓  [hook: SubagentStop]
  @reviewer checks domain accuracy
      ↓  [hook: SubagentStop]
  @ux-reviewer renders in headless browser
      ↓
  ticket closed, commit created
```

Hooks chain the pipeline automatically. The planner only needs to spawn `@creator` — the rest flows.

## Quick Start

### Option A: Install as a Claude Code Plugin (recommended)

```bash
claude plugin install kulisama81/mirastack
```

This loads all 6 agents, hooks, and scripts automatically. Then:

1. Copy and edit the workflow config: `cp templates/workflow-config.json .claude/workflow-config.json`
2. Set up [tkt](https://github.com/lawrips/tkt): `go install github.com/lawrips/tkt@latest && tkt init`
3. Add tkt as an MCP server in `.mcp.json`
4. Write your CLAUDE.md (see `templates/CLAUDE.md.example`)
5. Set up cron for autonomous operation (see step 7 below)

### Option B: Manual install

### 1. Copy agents into your project

```bash
# From your project root:
cp -r /path/to/mirastack/agents/ .claude/agents/
```

### 2. Copy and configure workflow config

```bash
cp /path/to/mirastack/templates/workflow-config.json .claude/workflow-config.json
```

Edit `.claude/workflow-config.json` to match your project:
- Set `validator.buildCommand` to your build command
- Set `validator.contentDir` to where your content lives
- Set `uxReviewer.devCommand` to your dev server command
- Configure optional integrations (analytics, digest, feedback sync)

### 3. Merge hooks into your settings

Copy the hooks from `hooks/hooks.json` into your `.claude/settings.json`. If you already have hooks, merge the arrays.

### 4. Copy scripts

```bash
cp -r /path/to/mirastack/bin/ bin/
```

Scripts read configuration from `workflow-config.json` — no hardcoded values to change.

### 5. Set up tkt

Install [tkt](https://github.com/lawrips/tkt) for ticket management:

```bash
go install github.com/lawrips/tkt@latest
tkt init
```

Add tkt as an MCP server in `.mcp.json`:
```json
{
  "mcpServers": {
    "tkt": {
      "command": "tkt",
      "args": ["mcp"]
    }
  }
}
```

### 6. Write your CLAUDE.md

See `templates/CLAUDE.md.example` for a template. The agents read CLAUDE.md for:
- Project conventions (coding standards, file structure)
- Domain knowledge (what "correct" means for your content)
- Content patterns (markup, components, formatting rules)

### 7. Set up cron for autonomous operation

This is what makes MiraStack autonomous — agents run on a schedule, pick tickets, and ship while you're away.

Copy and edit the crontab template:

```bash
cp /path/to/mirastack/templates/crontab.example /tmp/mirastack-cron
# Edit /tmp/mirastack-cron — replace /path/to/your/project with your actual path
crontab /tmp/mirastack-cron
```

Recommended schedule:

| Job | Schedule | What it does |
|---|---|---|
| `pull-analytics.mjs` | Daily 1 AM | Refreshes traffic data so agents prioritize by real usage |
| `@planner` | Twice daily, 2 AM + 2 PM | Picks 2-3 tickets, runs the full pipeline, commits |
| `@autoresearch` | Weekly, Monday 3 AM | Discovers content gaps, SEO issues, competitor features |
| `daily-digest.mjs` | Daily 8 AM | Emails you a summary of traffic + agent activity |
| `sync-feedback.mjs` | Every 30 min | Pulls GitHub Issues into tkt tickets |

The planner commits but never pushes — you review with `git log origin/main..HEAD` and push when satisfied. See [docs/cron-setup.md](docs/cron-setup.md) for full details.

## Configuration

All project-specific values live in `workflow-config.json`:

```json
{
  "validator": {
    "buildCommand": "npm run build",
    "contentDir": "src/content",
    "checks": ["build", "frontmatter", "heading-hierarchy", "katex"]
  },
  "uxReviewer": {
    "devCommand": "npx astro dev",
    "checks": ["console-errors", "broken-images", "layout-overflow"]
  },
  "feedbackSync": {
    "repo": "owner/repo",
    "label": "user-submitted"
  },
  "analytics": {
    "propertyId": "YOUR_GA4_PROPERTY_ID",
    "gscSiteUrl": "sc-domain:yourdomain.com"
  },
  "digest": {
    "toEmail": ["you@example.com"],
    "fromEmail": "digest@yourdomain.com",
    "projectName": "My Project"
  }
}
```

## Optional Integrations

### GA4 Analytics
Feeds real traffic data to @planner and @autoresearch for data-driven prioritization.

1. Create a GA4 service account and download credentials
2. Save as `.ga-credentials.json` (gitignored)
3. Set `analytics.propertyId` in workflow-config.json
4. Run `node bin/pull-analytics.mjs`

### Google Search Console
Adds search query data (impressions, clicks, CTR, position) to the analytics report.

1. Add the same service account to Search Console
2. Set `analytics.gscSiteUrl` in workflow-config.json

### Daily Digest Email
Sends a daily summary of traffic, content health, pipeline activity, and unpushed commits.

1. Sign up for [Resend](https://resend.com) and verify your domain
2. Set `RESEND_API_KEY` in your `.env`
3. Configure `digest.toEmail`, `digest.fromEmail`, `digest.projectName`
4. Add to cron: `0 8 * * * cd /path/to/project && node bin/daily-digest.mjs`

### GitHub Issues → tkt Sync
Automatically creates tkt tickets from GitHub Issues with a specific label.

1. Set `GITHUB_TOKEN` in your `.env`
2. Configure `feedbackSync.repo` and `feedbackSync.label`
3. Runs automatically on SessionStart (via hook) or on cron

## Showcase

**[AP IB Study Guides](https://apibstudyguide.com)** — The project where MiraStack was born. 30+ study guides across 4 IB subjects, created and maintained autonomously by this pipeline.

## Philosophy

- **Agents read CLAUDE.md, not hardcoded knowledge** — the same agents work for a study guide site, an API, or a blog
- **Ticket-driven** — all work flows through tkt tickets, creating an auditable trail
- **Hook-enforced pipeline** — the quality chain runs automatically, not by convention
- **Data-driven prioritization** — agents use real analytics to decide what matters most
- **Human-in-the-loop where it counts** — agents commit but never push structural changes

## License

MIT — kulisama81
