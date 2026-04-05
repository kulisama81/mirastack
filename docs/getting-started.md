# Getting Started

This guide walks you through installing MiraStack in an existing project.

## Prerequisites

- [Claude Code](https://claude.ai/code) CLI installed and authenticated
- [tkt](https://github.com/lawrips/tkt) installed (`go install github.com/lawrips/tkt@latest`)
- Node.js 18+ (for scripts)
- A project with a CLAUDE.md file

## Step 1: Copy Agents

Copy the agent definitions into your project's `.claude/agents/` directory:

```bash
mkdir -p .claude/agents
cp /path/to/mirastack/agents/*.md .claude/agents/
```

The agents are now available as `@planner`, `@creator`, `@validator`, `@reviewer`, `@ux-reviewer`, and `@autoresearch`.

## Step 2: Configure

Create your workflow config:

```bash
cp /path/to/mirastack/templates/workflow-config.json .claude/workflow-config.json
```

Edit the file to match your project. At minimum, set:

- `validator.buildCommand` — how to build your project
- `validator.contentDir` — where your content files live
- `uxReviewer.devCommand` — how to start your dev server

## Step 3: Copy Scripts

```bash
mkdir -p scripts
cp /path/to/mirastack/scripts/*.mjs scripts/
```

The scripts read all configuration from `workflow-config.json`, so no hardcoded values need changing.

**Dependencies:** The UX review script requires Puppeteer:

```bash
npm install puppeteer
```

The analytics script (optional) requires:

```bash
npm install @google-analytics/data googleapis
```

## Step 4: Set Up Hooks

The hook pipeline is what makes MiraStack autonomous — it chains agents automatically after each step completes.

Copy the hooks from `hooks/pipeline.json` into your `.claude/settings.json`:

```json
{
  "hooks": {
    "SubagentStop": [
      // ... paste from hooks/pipeline.json
    ],
    "PreToolUse": [
      // ... paste from hooks/pipeline.json
    ]
  }
}
```

If you already have hooks in settings.json, merge the arrays.

## Step 5: Initialize tkt

```bash
tkt init
```

Add tkt as an MCP server:

```bash
# .mcp.json
{
  "mcpServers": {
    "tkt": {
      "command": "tkt",
      "args": ["mcp"]
    }
  }
}
```

## Step 6: Write Your CLAUDE.md

The agents don't have hardcoded domain knowledge — they read your CLAUDE.md. See `templates/CLAUDE.md.example` for a template.

Key sections:
- **Project Overview** — what the project does
- **Commands** — how to build, test, run
- **Content Structure** — where files live
- **Content Conventions** — formatting rules the creator follows
- **Domain Knowledge** — what "correct" means for the reviewer

## Step 7: Create Your First Ticket

```bash
tkt create "Add homepage hero section" --type feature --priority 2
```

Then run the planner:

```bash
claude --agent planner
```

The planner will pick the ticket, spawn the creator, and the hook pipeline handles the rest.

## Step 8: (Optional) Set Up Cron

For fully autonomous operation, add cron jobs. See `templates/crontab.example`.

## Next Steps

- [Agents](agents.md) — detailed docs for each agent
- [Customization](customization.md) — extending checks, adding custom validation
- [Cron Setup](cron-setup.md) — autonomous scheduling
