# Customization

MiraStack is designed to be extended. All project-specific behavior is configured through `workflow-config.json` and CLAUDE.md.

## Adding Custom Validation Checks

The content validator (`bin/content-validate.mjs`) runs checks based on the `validator.checks` array in workflow-config.json.

### Built-in checks

| Check | What it does |
|---|---|
| `build` | Runs the build command and fails on error |
| `frontmatter` | Validates required frontmatter fields |
| `heading-hierarchy` | Ensures h2 -> h3 -> h4 order isn't broken |
| `katex` | Checks for unbalanced braces in `$...$` and `$$...$$` |
| `svg-blank-lines` | Detects blank lines inside SVG blocks in .md files |
| `html-comments` | Flags `<!-- -->` in .mdx files (should be `{/* */}`) |
| `video-embeds` | Validates iframe src attributes and flags placeholder video IDs |
| `internal-links` | Checks that internal links resolve to real files |
| `no-placeholder` | Flags "coming soon", "TBD", "TODO", and similar phrases in content |
| `empty-sections` | Finds headings with no content before the next heading |
| `duplicate-content` | Detects verbatim paragraphs shared across files in the same category |
| `content-length` | Advisory warning for files exceeding a configurable line threshold |
| `companion-sync` | Checks that companion materials (flashcard decks, data files) are up to date |
| `connected-categories` | Verifies all content categories are wired to site infrastructure |
| `language-conventions` | Per-subject spelling and orthographic rules for foreign-language content |
| `hardcoded-consistency` | Flags hardcoded counts (e.g., "4 subjects") that drift from actual content |

Enable or disable by editing the `validator.checks` array:

```json
{
  "validator": {
    "checks": ["build", "frontmatter", "katex", "no-placeholder"]
  }
}
```

### Configuring placeholder detection

Customize which phrases are flagged:

```json
{
  "validator": {
    "placeholderPhrases": ["coming soon", "TBD", "TODO", "work in progress"]
  }
}
```

### Configuring language rules

Add per-subject spelling rules for foreign-language content:

```json
{
  "validator": {
    "languageRules": {
      "ap-french": {
        "language": "French",
        "requiredChars": ["e", "a", "c"],
        "commonErrors": {
          "francais": "fran\u00e7ais",
          "reponse": "r\u00e9ponse"
        }
      }
    }
  }
}
```

The key (e.g., `ap-french`) is matched against content file paths. Files whose path or category contains the key will be checked against these rules.

### Configuring companion sync

Enable checking that companion materials stay up to date with content:

```json
{
  "validator": {
    "companionSync": {
      "enabled": true,
      "supplementaryDir": "public/data",
      "supplementaryPattern": "{category}.json"
    }
  }
}
```

### Adding a new check

To add a project-specific check, edit `bin/content-validate.mjs`:

1. Add a check function following the pattern of existing checks
2. Add a key for it in the `enabledChecks` logic
3. Add the key to your `validator.checks` config

Each check function receives `(file, content)` and returns an array of issues:

```js
function checkMyThing(file, content) {
  const issues = [];
  // ... your logic ...
  issues.push({
    type: 'my-check',
    severity: 'high',  // 'critical', 'high', 'medium', 'low'
    line: 42,
    detail: 'Description of the problem',
  });
  return issues;
}
```

## Customizing UX Review Checks

The UX review script (`bin/ux-review.mjs`) runs Puppeteer checks based on `uxReviewer.checks`.

### Built-in checks

| Check | What it does |
|---|---|
| `console-errors` | Always on — captures JS console errors |
| `broken-images` | Always on — finds images with naturalWidth === 0 |
| `layout-overflow` | Always on — detects horizontal overflow |
| `katex` | Finds `.katex-error` elements |
| `mermaid` | Finds `.mermaid` elements without rendered SVGs |
| `placeholder-text` | Finds placeholder phrases rendered in page text |
| `grid-stretch` | Detects unequal card widths in grid layouts (configurable selectors) |
| `raw-svg-text` | Finds SVG attribute strings rendered as visible text |
| `iframe-issues` | Finds iframes with empty src or zero dimensions |

### Configuring grid stretch selectors

```json
{
  "uxReviewer": {
    "gridSelectors": [".card-grid", ".features-row", ".product-grid"]
  }
}
```

### Configuring ignored request patterns

URLs matching these patterns won't be flagged as failed requests:

```json
{
  "uxReviewer": {
    "ignoredRequestPatterns": [
      "google-analytics.com",
      "googletagmanager.com",
      "/pagefind/",
      "fonts.googleapis.com"
    ]
  }
}
```

### Adding a custom check

Edit `bin/ux-review.mjs` and add your check to the `reviewPage` function:

```js
if (checks.includes('my-check')) {
  const results = await page.$$eval('.my-selector', els =>
    els.filter(el => /* condition */).map(el => ({ detail: el.textContent }))
  );
  for (const r of results) {
    issues.push({ type: 'my-check', severity: 'high', detail: r.detail });
  }
}
```

## Customizing the Ticket Closure Gate

The PreToolUse hook on `mcp__tkt__edit` blocks ticket closure unless a recent clean UX review exists. Tickets with certain tags bypass this gate:

**Default bypass tags:** `tooling`, `seo`, `analytics`, `autoresearch`, `growth`, `ordering`, `dx`, `infrastructure`, `ux`, `agent`, `validation`

To customize, edit the `grep -qiE` pattern in `hooks/hooks.json`.

## Customizing Agent Behavior

Agents read CLAUDE.md for all domain knowledge. To change agent behavior:

1. **Change what the creator produces** — update the "Content Conventions" section of CLAUDE.md
2. **Change what the reviewer checks** — update the "Domain Knowledge" section of CLAUDE.md
3. **Change prioritization** — edit `research.md` focus areas for autoresearch, or modify the planner's tier system in `agents/planner.md`

## Extending the Pipeline

### Adding a new agent

1. Create `.claude/agents/my-agent.md` with frontmatter (name, description, tools, model)
2. Add a SubagentStop hook in `.claude/settings.json` to chain it into the pipeline
3. Update the planner's pipeline documentation

### Changing the pipeline order

Edit the SubagentStop hooks in `.claude/settings.json`. The `matcher` field determines which agent's completion triggers the next step.

### Removing an agent from the pipeline

Remove its SubagentStop hook entry. The previous agent's hook will need to be updated to point to the next agent in the chain.

## Environment Variables

| Variable | Used by | Purpose |
|---|---|---|
| `GITHUB_TOKEN` | sync-feedback.mjs | GitHub API access for issue sync |
| `GITHUB_REPO` | sync-feedback.mjs | Override repo (default: from config) |
| `RESEND_API_KEY` | daily-digest.mjs | Email sending via Resend |
| `GA4_PROPERTY_ID` | pull-analytics.mjs | Override GA4 property (default: from config) |
| `GSC_SITE_URL` | pull-analytics.mjs | Override Search Console site (default: from config) |
| `TKT_PATH` | sync-feedback.mjs | Override tkt binary path |
