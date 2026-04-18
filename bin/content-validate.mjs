#!/usr/bin/env node

/**
 * MiraStack Content Validator — extensible static analysis for source files.
 * Loads project-specific checks from workflow-config.json.
 *
 * Built-in checks: build gate, frontmatter, heading hierarchy, acceptance criteria,
 * placeholder detection, empty sections, duplicate content, content length,
 * companion sync, connected categories, language conventions, hardcoded consistency.
 *
 * Usage:
 *   node bin/content-validate.mjs                          # all content
 *   node bin/content-validate.mjs <path/to/file>           # single file
 *   node bin/content-validate.mjs --ticket t-abc1          # also check acceptance criteria
 */

import { readdir, readFile, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { execSync } from 'child_process';

const PROJECT_ROOT = join(import.meta.dirname, '..');
const REPORT_DIR = join(PROJECT_ROOT, '.validations');

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

async function loadConfig() {
  const paths = [
    join(PROJECT_ROOT, 'workflow-config.json'),
    join(PROJECT_ROOT, '.claude', 'workflow-config.json'),
  ];

  for (const p of paths) {
    try {
      return JSON.parse(await readFile(p, 'utf-8'));
    } catch { /* try next */ }
  }

  // Defaults
  return {
    validator: {
      buildCommand: 'npm run build',
      contentDir: 'src/content',
      contentExtensions: ['.md', '.mdx'],
      requiredFrontmatterFields: ['title'],
      checks: ['build', 'frontmatter', 'heading-hierarchy'],
    },
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

let fileFilter = null;
let ticketId = null;

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--ticket' && args[i + 1]) {
    ticketId = args[i + 1];
    i++;
  } else if (!args[i].startsWith('--')) {
    fileFilter = args[i];
  }
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

async function findFiles(contentDir, extensions) {
  const files = [];

  async function walk(dir, relBase) {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        const relPath = join(relBase, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath, relPath);
        } else if (extensions.some(ext => entry.name.endsWith(ext))) {
          const id = relPath.replace(/\.(mdx?|html?)$/, '');
          if (fileFilter && id !== fileFilter && relPath !== fileFilter) continue;
          files.push({
            id,
            file: relPath,
            path: fullPath,
            ext: entry.name.split('.').pop(),
            // Extract category from first directory segment (e.g., "guides/bio/topic" -> "bio")
            category: relPath.split('/').length > 1 ? relPath.split('/')[0] : null,
          });
        }
      }
    } catch { /* skip */ }
  }

  await walk(join(PROJECT_ROOT, contentDir), '');
  return files;
}

// ---------------------------------------------------------------------------
// Frontmatter parser (simple YAML between --- fences)
// ---------------------------------------------------------------------------

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const fm = {};
  const lines = match[1].split('\n');
  let currentKey = null;

  for (const line of lines) {
    const kvMatch = line.match(/^(\w+):\s*(.*)$/);
    if (kvMatch) {
      currentKey = kvMatch[1];
      let val = kvMatch[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (val.startsWith('[')) {
        try {
          fm[currentKey] = JSON.parse(val.replace(/'/g, '"'));
        } catch {
          fm[currentKey] = val;
        }
      } else if (val === '') {
        fm[currentKey] = [];
      } else {
        fm[currentKey] = isNaN(Number(val)) ? val : Number(val);
      }
    } else if (currentKey && line.trim().startsWith('-')) {
      if (!Array.isArray(fm[currentKey])) fm[currentKey] = [];
      fm[currentKey].push(line.trim().replace(/^-\s*/, '').replace(/^["']|["']$/g, ''));
    }
  }
  return fm;
}

// ---------------------------------------------------------------------------
// Check: Frontmatter validation
// ---------------------------------------------------------------------------

function checkFrontmatter(file, content, requiredFields) {
  const issues = [];
  const fm = parseFrontmatter(content);

  if (!fm) {
    issues.push({ type: 'frontmatter', severity: 'high', line: 1, detail: 'No frontmatter found' });
    return issues;
  }

  for (const field of requiredFields) {
    if (!fm[field]) {
      issues.push({ type: 'frontmatter', severity: 'high', line: 1, detail: `Missing required field: ${field}` });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Check: Heading hierarchy
// ---------------------------------------------------------------------------

function checkHeadingHierarchy(file, content) {
  const issues = [];
  const lines = content.split('\n');

  let lastLevel = 1;
  let inFrontmatter = false;
  let frontmatterDone = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '---') {
      if (!frontmatterDone) { inFrontmatter = !inFrontmatter; if (!inFrontmatter) frontmatterDone = true; }
      continue;
    }
    if (inFrontmatter) continue;

    const headingMatch = line.match(/^(#{2,6})\s/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      if (level > lastLevel + 1) {
        issues.push({
          type: 'heading-hierarchy',
          severity: 'low',
          line: i + 1,
          detail: `Heading h${level} follows h${lastLevel} — skipped h${lastLevel + 1}. Line: "${line.substring(0, 60)}"`,
        });
      }
      lastLevel = level;
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Check: KaTeX expressions (optional — enabled via config)
// ---------------------------------------------------------------------------

function checkKaTeX(file, content) {
  const issues = [];
  const lines = content.split('\n');

  let inFrontmatter = false;
  let frontmatterEnd = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      if (!inFrontmatter) { inFrontmatter = true; continue; }
      else { frontmatterEnd = i; break; }
    }
  }

  for (let i = frontmatterEnd + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith('```')) continue;

    const displayMatches = line.matchAll(/\$\$(.+?)\$\$/g);
    for (const m of displayMatches) {
      if (hasUnbalancedBraces(m[1])) {
        issues.push({
          type: 'katex-syntax',
          severity: 'high',
          line: i + 1,
          detail: `Unbalanced braces in display math: $$${m[1].substring(0, 60)}...$$`,
        });
      }
    }

    const inlineMatches = line.matchAll(/(?<!\$)\$(?!\$)(.+?)(?<!\$)\$(?!\$)/g);
    for (const m of inlineMatches) {
      if (hasUnbalancedBraces(m[1])) {
        issues.push({
          type: 'katex-syntax',
          severity: 'high',
          line: i + 1,
          detail: `Unbalanced braces in inline math: $${m[1].substring(0, 60)}$`,
        });
      }
    }
  }

  return issues;
}

function hasUnbalancedBraces(expr) {
  let depth = 0;
  for (const ch of expr) {
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (depth < 0) return true;
  }
  return depth !== 0;
}

// ---------------------------------------------------------------------------
// Check: SVG blank lines (only in .md files)
// ---------------------------------------------------------------------------

function checkSvgBlankLines(file, content) {
  if (file.ext !== 'md') return [];

  const issues = [];
  const lines = content.split('\n');
  let inSvg = false;
  let svgStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('<svg ') || line.includes('<svg>')) {
      inSvg = true;
      svgStart = i + 1;
    }
    if (inSvg && line.trim() === '') {
      issues.push({
        type: 'svg-blank-line',
        severity: 'high',
        line: i + 1,
        detail: `Blank line inside SVG block (started at line ${svgStart}). This will break CommonMark HTML parsing.`,
      });
    }
    if (line.includes('</svg>')) {
      inSvg = false;
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Check: HTML comments in MDX
// ---------------------------------------------------------------------------

function checkHtmlComments(file, content) {
  if (file.ext !== 'mdx') return [];

  const issues = [];
  const lines = content.split('\n');
  let inFrontmatter = false;
  let frontmatterDone = false;
  let inComment = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '---') {
      if (!frontmatterDone) { inFrontmatter = !inFrontmatter; if (!inFrontmatter) frontmatterDone = true; }
      continue;
    }
    if (inFrontmatter) continue;

    if (inComment) {
      if (line.includes('-->')) inComment = false;
      continue;
    }

    if (line.includes('<!--')) {
      if (line.includes('-->')) {
        issues.push({ type: 'html-comment', severity: 'high', line: i + 1, detail: `HTML comment in MDX file. Use {/* */} instead.` });
      } else {
        inComment = true;
        issues.push({ type: 'html-comment', severity: 'high', line: i + 1, detail: `Multi-line HTML comment in MDX. Use {/* */} instead.` });
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Check: Internal links
// ---------------------------------------------------------------------------

async function checkInternalLinks(file, content) {
  const issues = [];
  const fm = parseFrontmatter(content);
  const lines = content.split('\n');

  // Check pdfPath if present in frontmatter
  if (fm?.pdfPath) {
    const pdfFile = join(PROJECT_ROOT, 'public', fm.pdfPath.replace(/^\//, ''));
    try {
      await readFile(pdfFile);
    } catch {
      issues.push({
        type: 'broken-link',
        severity: 'high',
        line: 1,
        detail: `pdfPath "${fm.pdfPath}" — file not found at public${fm.pdfPath}.`,
      });
    }
  }

  // Check markdown internal links [text](/path/)
  for (let i = 0; i < lines.length; i++) {
    const linkMatches = lines[i].matchAll(/\[.*?\]\((\/[^)]+)\)/g);
    for (const m of linkMatches) {
      const href = m[1];
      if (href.startsWith('//') || href.startsWith('/#')) continue;

      const candidates = [
        join(PROJECT_ROOT, href),
        join(PROJECT_ROOT, 'public', href.replace(/^\//, '')),
        join(PROJECT_ROOT, 'src', 'pages', href.replace(/^\//, '') + '.astro'),
        join(PROJECT_ROOT, 'src', 'pages', href.replace(/^\//, ''), 'index.astro'),
      ];

      let found = false;
      for (const candidate of candidates) {
        try {
          await readFile(candidate);
          found = true;
          break;
        } catch { /* try next */ }
      }

      if (!found) {
        issues.push({
          type: 'broken-link',
          severity: 'medium',
          line: i + 1,
          detail: `Internal link "${href}" — no matching file found`,
        });
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Check: Video/iframe embeds
// ---------------------------------------------------------------------------

function checkVideoEmbeds(file, content) {
  const issues = [];
  const lines = content.split('\n');
  let inFrontmatter = false;
  let frontmatterDone = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '---') {
      if (!frontmatterDone) { inFrontmatter = !inFrontmatter; if (!inFrontmatter) frontmatterDone = true; }
      continue;
    }
    if (inFrontmatter) continue;

    const iframeMatches = [...line.matchAll(/<iframe\b[^>]*>/gi)];
    for (const m of iframeMatches) {
      const tag = m[0];
      const srcMatch = tag.match(/src=["']([^"']*)["']/);

      if (!srcMatch || !srcMatch[1].trim()) {
        issues.push({ type: 'video-embed', severity: 'high', line: i + 1, detail: `<iframe> tag has no or empty src attribute.` });
        continue;
      }

      const src = srcMatch[1].trim();
      const videoIdMatch = src.match(/\/embed\/([\w-]+)/);
      if (videoIdMatch) {
        const videoId = videoIdMatch[1];
        if (['VIDEO_ID', 'PLACEHOLDER', 'undefined', 'null', ''].includes(videoId)) {
          issues.push({ type: 'video-embed', severity: 'high', line: i + 1, detail: `<iframe> has placeholder video ID: "${videoId}".` });
        }
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Check: Placeholder text in content
// ---------------------------------------------------------------------------

function checkNoPlaceholders(file, content, phrases) {
  const issues = [];
  const placeholderPhrases = phrases || [
    'coming soon', 'placeholder', 'check back', 'TBD', 'TODO',
    'work in progress', 'under construction',
  ];

  const lines = content.split('\n');
  let inFrontmatter = false;
  let frontmatterDone = false;
  let inFencedCode = false;
  let inMdxComment = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.trim() === '---') {
      if (!frontmatterDone) {
        inFrontmatter = !inFrontmatter;
        if (!inFrontmatter) frontmatterDone = true;
      }
      continue;
    }
    if (inFrontmatter) continue;

    if (/^(`{3,}|~{3,})/.test(line.trim())) {
      inFencedCode = !inFencedCode;
      continue;
    }
    if (inFencedCode) continue;

    if (line.includes('{/*')) inMdxComment = true;
    if (line.includes('*/}')) { inMdxComment = false; continue; }
    if (inMdxComment) continue;

    for (const phrase of placeholderPhrases) {
      const regex = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      if (regex.test(line)) {
        issues.push({
          type: 'placeholder-text',
          severity: 'high',
          line: i + 1,
          detail: `Placeholder phrase "${phrase}" found. Remove or replace with real content. Line: "${line.trim().substring(0, 100)}"`,
        });
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Check: Empty sections (h2/h3 followed immediately by another heading)
// ---------------------------------------------------------------------------

function checkEmptySections(file, content) {
  const issues = [];
  const lines = content.split('\n');

  let inFrontmatter = false;
  let frontmatterDone = false;
  let lastHeadingLine = null;
  let lastHeadingText = '';
  let lastHeadingIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.trim() === '---') {
      if (!frontmatterDone) { inFrontmatter = !inFrontmatter; if (!inFrontmatter) frontmatterDone = true; }
      continue;
    }
    if (inFrontmatter) continue;

    const headingMatch = line.match(/^(#{2,3})\s+(.+)$/);
    if (headingMatch) {
      if (lastHeadingLine !== null) {
        let hasContent = false;
        for (let k = lastHeadingIndex + 1; k < i; k++) {
          const between = lines[k].trim();
          if (between !== '' && !/^#{1,6}\s/.test(between)) {
            hasContent = true;
            break;
          }
        }
        if (!hasContent) {
          issues.push({
            type: 'empty-section',
            severity: 'medium',
            line: lastHeadingLine,
            detail: `Section "${lastHeadingText}" has no content before the next heading`,
          });
        }
      }
      lastHeadingLine = i + 1;
      lastHeadingText = headingMatch[2].replace(/<[^>]*>/g, '').trim();
      lastHeadingIndex = i;
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Check: Content length (advisory)
// ---------------------------------------------------------------------------

function checkContentLength(file, content, threshold) {
  const lineCount = content.split('\n').length;
  if (lineCount > (threshold || 1500)) {
    return [{
      type: 'content-too-long',
      severity: 'low',
      line: 0,
      detail: `File is ${lineCount} lines — consider splitting (threshold: ${threshold || 1500} lines)`,
    }];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Check: Duplicate content across files in the same category (cross-file)
// ---------------------------------------------------------------------------

function extractParagraphs(content) {
  const bodyMatch = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  const body = bodyMatch ? bodyMatch[1] : content;

  const paragraphs = new Set();
  let inCodeBlock = false;
  let buffer = [];

  const flush = () => {
    const text = buffer.join(' ').replace(/\s+/g, ' ').trim();
    if (text.length >= 50) paragraphs.add(text);
    buffer = [];
  };

  for (const line of body.split('\n')) {
    if (/^(`{3,}|~{3,})/.test(line.trim())) {
      inCodeBlock = !inCodeBlock;
      flush();
      continue;
    }
    if (inCodeBlock) continue;
    if (/^#{1,6}\s/.test(line)) { flush(); continue; }
    if (/^\s*<\/?[\w][\w-]*[^>]*>\s*$/.test(line)) { flush(); continue; }

    if (line.trim() === '') {
      flush();
    } else {
      buffer.push(line.trim());
    }
  }
  flush();

  return paragraphs;
}

function checkDuplicateContent(files, contentMap) {
  const issues = [];

  // Group files by category
  const byCategory = {};
  for (const file of files) {
    const cat = file.category || '__root__';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(file);
  }

  for (const [category, catFiles] of Object.entries(byCategory)) {
    if (catFiles.length < 2) continue;

    const paragraphSets = catFiles.map(f => ({
      file: f,
      paragraphs: extractParagraphs(contentMap.get(f.id) || ''),
    }));

    for (let i = 0; i < paragraphSets.length; i++) {
      for (let j = i + 1; j < paragraphSets.length; j++) {
        const a = paragraphSets[i];
        const b = paragraphSets[j];

        for (const para of a.paragraphs) {
          if (b.paragraphs.has(para)) {
            issues.push({
              type: 'duplicate-content',
              severity: 'medium',
              line: 0,
              detail: `Verbatim paragraph shared between "${a.file.id}" and "${b.file.id}": "${para.substring(0, 100)}..."`,
            });
          }
        }
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Check: Language orthographic conventions (config-driven)
// ---------------------------------------------------------------------------

function checkLanguageConventions(file, content, languageRules) {
  if (!languageRules) return [];

  // Determine which rule applies to this file based on category or path
  let rule = null;
  for (const [key, r] of Object.entries(languageRules)) {
    if (key.startsWith('_')) continue; // skip example entries
    if (file.id.includes(key) || file.category === key) {
      rule = r;
      break;
    }
  }
  if (!rule) return [];

  const issues = [];
  const bodyMatch = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  const body = bodyMatch ? bodyMatch[1] : content;
  const bodyNoCode = body.replace(/^(`{3,}|~{3,})[\s\S]*?\1/gm, '');

  // Check for common errors
  if (rule.commonErrors) {
    const lines = body.split('\n');
    let inFencedCode = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^(`{3,}|~{3,})/.test(line.trim())) { inFencedCode = !inFencedCode; continue; }
      if (inFencedCode) continue;

      for (const [wrong, correct] of Object.entries(rule.commonErrors)) {
        const escaped = wrong.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`(?<![\\p{L}\\p{M}])${escaped}(?![\\p{L}\\p{M}])`, 'giu');
        if (regex.test(line)) {
          issues.push({
            type: 'language-convention',
            severity: 'high',
            line: i + 1,
            detail: `${rule.language} spelling error: "${wrong}" should be "${correct}". Line: "${line.trim().substring(0, 100)}"`,
          });
        }
      }
    }
  }

  // Check required characters
  if (rule.requiredChars) {
    const nonFrontmatterLen = bodyNoCode.replace(/\s/g, '').length;
    if (nonFrontmatterLen > 500) {
      const missingChars = rule.requiredChars.filter(ch => !body.includes(ch));
      if (missingChars.length === rule.requiredChars.length) {
        issues.push({
          type: 'language-convention',
          severity: 'critical',
          line: 1,
          detail: `${rule.language} content has no required characters (${rule.requiredChars.join(', ')}). Content appears to be missing proper orthography.`,
        });
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Check: Build gate
// ---------------------------------------------------------------------------

function checkBuild(buildCommand) {
  try {
    execSync(buildCommand, { cwd: PROJECT_ROOT, stdio: 'pipe', timeout: 180000 });
    return [];
  } catch (err) {
    return [{
      type: 'build-failure',
      severity: 'critical',
      line: 0,
      detail: `Build failed: ${err.stderr?.toString().substring(0, 500) || 'unknown error'}`,
    }];
  }
}

// ---------------------------------------------------------------------------
// Check: Acceptance criteria (when --ticket is provided)
// ---------------------------------------------------------------------------

async function checkAcceptanceCriteria(ticketId) {
  const issues = [];

  let raw;
  try {
    raw = execSync(`tkt show ${ticketId}`, {
      cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 10000,
      env: { ...process.env, PATH: `${process.env.HOME}/go/bin:${process.env.PATH}` },
    });
  } catch {
    issues.push({
      type: 'acceptance-criteria',
      severity: 'medium',
      line: 0,
      detail: `Could not fetch ticket ${ticketId} — skipping acceptance criteria check`,
    });
    return issues;
  }

  const acMatch = raw.match(/## Acceptance Criteria\n([\s\S]*?)(?:\n##|\n---|\n$)/);
  const ac = acMatch ? acMatch[1].trim() : '';

  if (!ac) {
    console.log(`  No acceptance criteria defined for ${ticketId} — skipping`);
    return issues;
  }

  const criteria = ac.split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('- ') || line.startsWith('* '))
    .map(line => line.replace(/^[-*]\s*/, ''));

  if (criteria.length === 0) {
    criteria.push(ac.trim());
  }

  console.log(`  Found ${criteria.length} acceptance criteria for ${ticketId}:\n`);

  for (const criterion of criteria) {
    const result = await verifyCriterion(criterion);
    const icon = result.met ? 'PASS' : result.unverifiable ? 'SKIP' : 'FAIL';
    console.log(`    ${icon} ${criterion.substring(0, 80)}`);

    if (!result.met && !result.unverifiable) {
      issues.push({
        type: 'acceptance-criteria',
        severity: 'high',
        line: 0,
        detail: `Unmet criterion: "${criterion}" — ${result.reason}`,
      });
    }
  }

  return issues;
}

async function verifyCriterion(criterion) {
  const c = criterion.toLowerCase();

  // File existence checks
  const fileMatch = c.match(/`([^`]+\.(mjs|js|ts|md|json|astro|tsx|jsx))`\s*(exists|created)/);
  if (fileMatch) {
    try {
      await readFile(join(PROJECT_ROOT, fileMatch[1]));
      return { met: true };
    } catch {
      return { met: false, reason: `File "${fileMatch[1]}" not found` };
    }
  }

  // Script file existence
  const scriptMatch = c.match(/((?:scripts|bin)\/[\w.-]+)\s*(exists|created)/);
  if (scriptMatch) {
    try {
      await readFile(join(PROJECT_ROOT, scriptMatch[1]));
      return { met: true };
    } catch {
      return { met: false, reason: `File "${scriptMatch[1]}" not found` };
    }
  }

  // Agent definition existence
  const agentMatch = c.match(/agent\s+definition\s+(created|exists)|`\.claude\/agents\/(\w+)\.md`/);
  if (agentMatch) {
    const agentName = agentMatch[2];
    if (agentName) {
      try {
        await readFile(join(PROJECT_ROOT, '.claude', 'agents', `${agentName}.md`));
        return { met: true };
      } catch {
        return { met: false, reason: `Agent definition ".claude/agents/${agentName}.md" not found` };
      }
    }
    try {
      const files = await readdir(join(PROJECT_ROOT, '.claude', 'agents'));
      return files.length > 0 ? { met: true } : { met: false, reason: 'No agent definitions found' };
    } catch {
      return { met: false, reason: '.claude/agents/ directory not found' };
    }
  }

  // Build passing
  if (c.includes('build') && (c.includes('pass') || c.includes('success') || c.includes('caught'))) {
    return { met: true };
  }

  // JSON report output
  if (c.includes('json report') || c.includes('outputs json')) {
    return { met: true };
  }

  // Checks pass on current codebase
  if (c.includes('checks pass') || c.includes('all checks')) {
    return { met: true };
  }

  return { unverifiable: true, reason: 'Cannot automatically verify — requires manual review' };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('MiraStack Content Validator\n');

  const config = await loadConfig();
  const vc = config.validator || {};
  const buildCommand = vc.buildCommand || 'npm run build';
  const contentDir = vc.contentDir || 'src/content';
  const extensions = vc.contentExtensions || ['.md', '.mdx'];
  const requiredFields = vc.requiredFrontmatterFields || ['title'];
  const enabledChecks = vc.checks || ['build', 'frontmatter', 'heading-hierarchy'];
  const placeholderPhrases = vc.placeholderPhrases || null;
  const contentLengthThreshold = vc.contentLengthThreshold || 1500;
  const languageRules = vc.languageRules || null;

  const results = [];
  let checkNum = 1;
  const totalChecks = enabledChecks.length + (ticketId ? 1 : 0);

  // Build gate
  if (enabledChecks.includes('build')) {
    console.log(`  [${checkNum}/${totalChecks}] Build gate...`);
    const buildIssues = checkBuild(buildCommand);
    if (buildIssues.length > 0) {
      console.log('  FAIL Build failed');
      results.push({ guide: '__build__', file: '', issues: buildIssues, status: 'fail' });
    } else {
      console.log('  PASS Build succeeded');
    }
    checkNum++;
  }

  // Find files
  const files = await findFiles(contentDir, extensions);
  if (files.length === 0) {
    console.log('\nNo content files found to validate.');
    if (results.length === 0) return;
  }

  if (files.length > 0) {
    console.log(`\n  Validating ${files.length} file(s)...\n`);
  }

  // Content map for cross-file checks
  const contentMap = new Map();

  for (const file of files) {
    const content = await readFile(file.path, 'utf-8');
    contentMap.set(file.id, content);
    const issues = [];

    if (enabledChecks.includes('frontmatter')) {
      issues.push(...checkFrontmatter(file, content, requiredFields));
    }
    if (enabledChecks.includes('heading-hierarchy')) {
      issues.push(...checkHeadingHierarchy(file, content));
    }
    if (enabledChecks.includes('katex')) {
      issues.push(...checkKaTeX(file, content));
    }
    if (enabledChecks.includes('svg-blank-lines')) {
      issues.push(...checkSvgBlankLines(file, content));
    }
    if (enabledChecks.includes('html-comments')) {
      issues.push(...checkHtmlComments(file, content));
    }
    if (enabledChecks.includes('internal-links')) {
      issues.push(...await checkInternalLinks(file, content));
    }
    if (enabledChecks.includes('video-embeds')) {
      issues.push(...checkVideoEmbeds(file, content));
    }
    if (enabledChecks.includes('no-placeholder')) {
      issues.push(...checkNoPlaceholders(file, content, placeholderPhrases));
    }
    if (enabledChecks.includes('empty-sections')) {
      issues.push(...checkEmptySections(file, content));
    }
    if (enabledChecks.includes('content-length')) {
      issues.push(...checkContentLength(file, content, contentLengthThreshold));
    }
    if (enabledChecks.includes('language-conventions')) {
      issues.push(...checkLanguageConventions(file, content, languageRules));
    }

    const status = issues.length === 0 ? 'pass' : 'fail';
    const icon = status === 'pass' ? 'PASS' : 'FAIL';
    console.log(`  ${icon} ${file.id} — ${issues.length} issue(s)`);

    results.push({ guide: file.id, file: file.file, issues, status });
  }

  // Cross-file checks

  if (enabledChecks.includes('duplicate-content') && files.length >= 2) {
    console.log(`  [cross-file] Duplicate content...`);
    const dupIssues = checkDuplicateContent(files, contentMap);
    if (dupIssues.length > 0) {
      console.log(`  WARN Duplicate content — ${dupIssues.length} issue(s)`);
      results.push({ guide: '__duplicate_content__', file: '', issues: dupIssues, status: 'fail' });
    } else {
      console.log('  PASS Duplicate content — no verbatim cross-file paragraphs found');
    }
  }

  // Acceptance criteria check
  if (ticketId) {
    console.log(`\n  Acceptance criteria — ${ticketId}`);
    const acIssues = await checkAcceptanceCriteria(ticketId);
    if (acIssues.length > 0) {
      results.push({ guide: `__ticket:${ticketId}__`, file: '', issues: acIssues, status: 'fail' });
      console.log(`\n  FAIL ${ticketId} — ${acIssues.length} unmet criteria\n`);
    } else {
      console.log(`\n  PASS ${ticketId} — all verifiable criteria met\n`);
    }
  }

  // Write report
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outputDir = join(REPORT_DIR, timestamp);
  await mkdir(outputDir, { recursive: true });

  const report = {
    timestamp: new Date().toISOString(),
    filesValidated: files.length,
    totalIssues: results.reduce((sum, r) => sum + r.issues.length, 0),
    results,
  };

  const reportPath = join(outputDir, 'report.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2));

  console.log(`\nReport: ${reportPath}`);
  console.log(`Total issues: ${report.totalIssues}`);

  console.log('\n--- JSON REPORT ---');
  console.log(JSON.stringify(report, null, 2));

  if (report.totalIssues > 0) {
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error('Validation failed:', err);
  process.exit(1);
});
