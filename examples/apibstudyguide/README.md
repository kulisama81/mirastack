# Example: AP IB Study Guides

**Live site:** [apibstudyguide.com](https://apibstudyguide.com)
**Repo:** [kulisama81/apibstudyguide](https://github.com/kulisama81/apibstudyguide)

The project where MiraStack was born. A static site (Astro + MDX) serving study guides for IB and AP students across Biology, Math, Chemistry, and History.

## How MiraStack is used

- **@planner** runs twice daily on cron, shipping 2-3 content tickets per session
- **@autoresearch** runs weekly, discovering content gaps by comparing syllabus coverage and competitor sites
- **@creator** writes MDX study guides following IB conventions from CLAUDE.md
- **@validator** checks KaTeX math expressions, SVG rendering, frontmatter, and build integrity
- **@reviewer** verifies IB syllabus accuracy — balanced equations, correct ATP yields, proper syllabus references
- **@ux-reviewer** catches rendering issues in headless Chrome — KaTeX errors, broken Mermaid diagrams, layout overflow
- **Analytics integration** feeds GA4 + Search Console data to agents for traffic-based prioritization
- **Daily digest** emails a morning summary of traffic, commits, and agent activity
- **Feedback sync** pulls student-submitted GitHub Issues into tkt tickets automatically

## Custom validation checks

The apibstudyguide project adds these checks on top of MiraStack's built-in ones:

- KaTeX expression parsing (unbalanced braces, unicode mu)
- SVG blank line detection (.md files)
- HTML comment detection (.mdx files)
- Curly-brace heading ID detection
- Summary tag blank line detection
- Video embed validation
- Hardcoded value consistency (guide counts, subject counts vs actual content)

## workflow-config.json

```json
{
  "validator": {
    "buildCommand": "npm run build",
    "contentDir": "src/content/guides",
    "contentExtensions": [".md", ".mdx"],
    "requiredFrontmatterFields": ["title", "subject", "level", "program"],
    "checks": [
      "build", "frontmatter", "heading-hierarchy", "katex",
      "svg-blank-lines", "html-comments", "video-embeds"
    ]
  },
  "uxReviewer": {
    "devCommand": "npx astro dev",
    "port": 4322,
    "checks": ["console-errors", "broken-images", "layout-overflow", "katex", "mermaid"]
  },
  "feedbackSync": {
    "repo": "kulisama81/apibstudyguide",
    "label": "student-submitted"
  },
  "analytics": {
    "propertyId": "529455610",
    "gscSiteUrl": "sc-domain:apibstudyguide.com"
  },
  "digest": {
    "toEmail": ["loic.deniel@gmail.com"],
    "fromEmail": "digest@apibstudyguide.com",
    "projectName": "AP IB Study Guides"
  }
}
```

## Results

- 30+ study guides across 4 IB subjects
- Autonomous shipping with human review (agents commit, human pushes)
- Zero factual errors in production (reviewer + validator catch issues before they ship)
- Daily traffic insights drive content prioritization
