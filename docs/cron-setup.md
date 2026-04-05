# Cron Setup

Running MiraStack agents on a cron schedule enables fully autonomous operation. The planner picks tickets and ships work while you're away.

## Prerequisites

- Claude Code CLI installed and authenticated (`claude` command available)
- Your project is in a stable state (committed, no conflicts)
- tkt has tickets in the backlog

## Recommended Schedule

| Job | Schedule | Why |
|---|---|---|
| `pull-analytics.mjs` | Daily, 1 AM | Refresh traffic data before agents run |
| `@planner` | Twice daily, 2 AM + 2 PM | Ship 2-3 tickets per session |
| `@autoresearch` | Weekly, Monday 3 AM | Discover new opportunities |
| `daily-digest.mjs` | Daily, 8 AM | Morning summary email |
| `sync-feedback.mjs` | Every 30 min | Keep issue-to-ticket sync fresh |

## Setup

### 1. Copy the template

```bash
cp /path/to/mirastack/templates/crontab.example /tmp/mirastack-cron
```

### 2. Edit paths

Replace `/path/to/your/project` with your actual project path:

```bash
sed -i '' 's|/path/to/your/project|/Users/you/myproject|g' /tmp/mirastack-cron
```

### 3. Install

```bash
crontab /tmp/mirastack-cron
```

Or merge with existing crontab:

```bash
crontab -l > /tmp/existing-cron
cat /tmp/mirastack-cron >> /tmp/existing-cron
crontab /tmp/existing-cron
```

### 4. Verify

```bash
crontab -l
```

## Monitoring

### Log files

Each cron job appends to a log file in `.claude/`:

- `.claude/planner-cron.log`
- `.claude/autoresearch-cron.log`
- `.claude/analytics-cron.log`
- `.claude/digest-cron.log`
- `.claude/feedback-sync-cron.log`

### Daily digest

The daily digest email includes planner and autoresearch activity from the logs, giving you a single place to review what happened.

### Checking planner activity

```bash
# See recent planner sessions
cat .claude/planner-log.json | jq '.sessions[-3:]'

# Or run the planner's report command
claude --agent planner "what did you do?"
```

## Safety

### The planner never pushes

By default, the planner commits but never pushes. This means:
- All autonomous work stays local until you review it
- Run `git log origin/main..HEAD` to see what agents did
- Push when you're satisfied: `git push`

### Auto-push (optional)

If you trust the pipeline for content changes, you can modify the planner agent to auto-push low-risk changes. See the guardrails section in `agents/planner.md`.

### Token budget

The planner stops after 2-3 tickets or ~1 hour, whichever comes first. This prevents runaway token spend on cron.

### Conflict prevention

If you're actively working in the project, the planner may encounter merge conflicts. To avoid this:
- Run the planner cron during hours you're not working
- Or pause the cron when doing active development: `crontab -r` (removes all) or comment out the planner line

## Troubleshooting

### Cron not running

1. Check cron is enabled: `crontab -l`
2. Check Claude CLI is in cron's PATH — cron has a minimal environment. Use full paths:
   ```
   0 2 * * * PATH=/usr/local/bin:/usr/bin:$HOME/.local/bin cd /path/to/project && claude ...
   ```
3. Check logs: `tail -50 .claude/planner-cron.log`

### Agent errors

If an agent fails, it leaves the ticket open with notes explaining what went wrong. Check:

```bash
tkt list --status in_progress
tkt show <id>  # read the notes
```
