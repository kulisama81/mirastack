#!/usr/bin/env node

/**
 * MiraStack UX Review — headless browser checks for rendered pages.
 * Detects console errors, broken images, layout overflow, and failed requests.
 * Project-specific checks (KaTeX, Mermaid, placeholder text, grid stretch,
 * raw SVG text, iframe issues) are loaded from workflow-config.json.
 *
 * Usage:
 *   node bin/ux-review.mjs                          # all pages
 *   node bin/ux-review.mjs <page-path>              # single page
 *   node bin/ux-review.mjs --url http://localhost:3000  # existing server
 */

import { spawn } from 'child_process';
import puppeteer from 'puppeteer';
import { readdir, readFile, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';

const PROJECT_ROOT = join(import.meta.dirname, '..');
const REVIEW_DIR = join(PROJECT_ROOT, '.ux-reviews');

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

  return {};
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  let url = null;
  let pageFilter = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--url' && args[i + 1]) {
      url = args[i + 1];
      i++;
    } else if (!args[i].startsWith('--')) {
      pageFilter = args[i];
    }
  }

  return { url, pageFilter };
}

// ---------------------------------------------------------------------------
// Page discovery
// ---------------------------------------------------------------------------

async function findPages(baseUrl, contentDir, contentExtensions, pageFilter) {
  const pages = [];
  const fullContentDir = join(PROJECT_ROOT, contentDir);

  async function walk(dir, relBase) {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        const relPath = join(relBase, entry.name);

        if (entry.isDirectory()) {
          await walk(fullPath, relPath);
        } else if (contentExtensions.some(ext => entry.name.endsWith(ext))) {
          const slug = relPath.replace(/\.(mdx?|html?)$/, '');
          const id = slug;

          if (pageFilter && id !== pageFilter) continue;

          pages.push({
            id,
            slug,
            url: `${baseUrl}/${slug}/`,
            file: `${contentDir}/${relPath}`,
          });
        }
      }
    } catch { /* skip */ }
  }

  await walk(fullContentDir, '');
  return pages;
}

// ---------------------------------------------------------------------------
// Dev server lifecycle
// ---------------------------------------------------------------------------

async function startDevServer(devCommand, port) {
  const [cmd, ...cmdArgs] = devCommand.split(' ');
  const allArgs = [...cmdArgs, '--port', String(port)];

  const server = spawn(cmd, allArgs, {
    cwd: PROJECT_ROOT,
    stdio: 'pipe',
    shell: true,
  });

  const baseUrl = `http://localhost:${port}`;
  const maxWait = 20000;
  const interval = 500;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    try {
      await fetch(baseUrl);
      console.log(`  Dev server ready at ${baseUrl}`);
      return { server, baseUrl };
    } catch {
      await new Promise(r => setTimeout(r, interval));
    }
  }

  server.kill();
  throw new Error(`Dev server failed to start within ${maxWait / 1000}s on port ${port}`);
}

// ---------------------------------------------------------------------------
// Per-page review
// ---------------------------------------------------------------------------

async function reviewPage(browser, page_info, screenshotDir, checks, ignoredPatterns) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  const consoleErrors = [];
  const failedRequests = [];

  const defaultIgnored = [
    'google-analytics.com', 'googletagmanager.com', '/g/collect',
    '/pagefind/', 'fonts.googleapis.com', 'fonts.gstatic.com', 'cdn.jsdelivr.net',
  ];
  const ignored = ignoredPatterns || defaultIgnored;

  function isIgnoredUrl(url) {
    return ignored.some(pattern => url.includes(pattern));
  }

  page.on('console', msg => {
    if (msg.type() === 'error') {
      const text = msg.text();
      const url = msg.location()?.url || '';
      if (text.includes('pagefind') || url.includes('pagefind')) return;
      consoleErrors.push({ text, url });
    }
  });
  page.on('pageerror', err => {
    consoleErrors.push({ text: err.message });
  });
  page.on('requestfailed', req => {
    const url = req.url();
    if (isIgnoredUrl(url)) return;
    failedRequests.push({ url, failure: req.failure()?.errorText });
  });
  page.on('response', res => {
    if (res.status() >= 400) {
      const url = res.url();
      if (isIgnoredUrl(url)) return;
      failedRequests.push({ url, status: res.status() });
    }
  });

  await page.goto(page_info.url, { waitUntil: 'networkidle0', timeout: 30000 });
  await new Promise(r => setTimeout(r, 3000));

  // Open all collapsed <details> elements so lazy-loaded content triggers
  await page.$$eval('details', els => els.forEach(el => el.open = true));
  await new Promise(r => setTimeout(r, 2000));

  const issues = [];

  // --- Console errors (always checked) ---
  for (const e of consoleErrors) {
    issues.push({ type: 'console-error', severity: 'high', detail: e.text, url: e.url });
  }
  for (const r of failedRequests) {
    issues.push({ type: 'request-failure', severity: 'high', detail: r.failure || `HTTP ${r.status}`, url: r.url });
  }

  // --- KaTeX errors (if enabled) ---
  if (checks.includes('katex')) {
    const katexErrors = await page.$$eval('.katex-error', els =>
      els.map(el => ({
        expression: el.getAttribute('title') || el.textContent,
        context: el.parentElement?.textContent?.substring(0, 120),
      }))
    ).catch(() => []);

    for (const k of katexErrors) {
      issues.push({ type: 'katex-error', severity: 'high', detail: k.expression, context: k.context });
    }
  }

  // --- Mermaid issues (if enabled) ---
  if (checks.includes('mermaid')) {
    const mermaidIssues = await page.$$eval('.mermaid', els =>
      els.filter(el => !el.querySelector('svg')).map(el => ({
        rawText: el.textContent?.substring(0, 200),
      }))
    ).catch(() => []);

    for (const m of mermaidIssues) {
      issues.push({ type: 'mermaid-unrendered', severity: 'high', detail: m.rawText });
    }
  }

  // --- Broken images (always checked) ---
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await new Promise(r => setTimeout(r, 2000));
  const brokenImages = await page.$$eval('img', imgs =>
    imgs.filter(img => {
      if (img.loading === 'lazy' && !img.complete) return false;
      return img.complete && img.naturalWidth === 0;
    }).map(img => ({ src: img.src, alt: img.alt }))
  ).catch(() => []);

  for (const img of brokenImages) {
    issues.push({ type: 'broken-image', severity: 'medium', detail: img.src, alt: img.alt });
  }

  // --- Empty SVGs ---
  const emptySvgs = await page.$$eval('.diagram-container svg', svgs =>
    svgs.filter(svg => svg.children.length === 0).map((_, i) => ({
      index: i,
      issue: 'SVG element has no children',
    }))
  ).catch(() => []);

  for (const svg of emptySvgs) {
    issues.push({ type: 'empty-svg', severity: 'medium', detail: `SVG #${svg.index} in .diagram-container` });
  }

  // --- Raw SVG code rendered as visible text (if enabled) ---
  if (checks.includes('raw-svg-text')) {
    const rawSvgAsText = await page.evaluate(() => {
      const bodyText = document.body.innerText;
      const svgPatterns = [
        /text-anchor="middle"/,
        /font-family=".*serif"/,
        /stroke-width="\d/,
        /viewBox="\d/,
        /fill="#[0-9A-Fa-f]{3,6}"/,
      ];
      const matches = svgPatterns.filter(p => p.test(bodyText));
      return matches.length >= 2 ? { detected: true, matchCount: matches.length } : { detected: false };
    }).catch(() => ({ detected: false }));

    if (rawSvgAsText.detected) {
      issues.push({ type: 'raw-svg-text', severity: 'high', detail: `SVG attribute strings found in visible page text (${rawSvgAsText.matchCount} patterns matched) — SVGs likely rendering as raw code` });
    }
  }

  // --- Iframe issues (if enabled) ---
  if (checks.includes('iframe-issues')) {
    const iframeIssues = await page.$$eval('iframe', iframes =>
      iframes.map(iframe => {
        const src = iframe.getAttribute('src') || iframe.getAttribute('data-src') || '';
        const rect = iframe.getBoundingClientRect();
        const problems = [];

        if (!src || src === 'about:blank') problems.push('empty-src');
        if (rect.width === 0 || rect.height === 0) problems.push('zero-dimensions');

        return {
          src: src.substring(0, 200),
          width: rect.width,
          height: rect.height,
          problems,
        };
      }).filter(f => f.problems.length > 0)
    ).catch(() => []);

    for (const f of iframeIssues) {
      if (f.problems.includes('empty-src')) {
        issues.push({ type: 'iframe-empty-src', severity: 'high', detail: `iframe has empty or missing src. src="${f.src}"` });
      }
      if (f.problems.includes('zero-dimensions')) {
        issues.push({ type: 'iframe-zero-dimensions', severity: 'medium', detail: `iframe has zero dimensions (${f.width}x${f.height}). src="${f.src}"` });
      }
    }
  }

  // --- Placeholder text rendered in page (if enabled) ---
  if (checks.includes('placeholder-text')) {
    const placeholderTextRendered = await page.evaluate(() => {
      const bodyText = document.body.innerText;
      const phrases = [
        'coming soon', 'placeholder', 'check back', 'TBD', 'TODO',
        'work in progress', 'under construction',
      ];
      return phrases
        .filter(p => bodyText.toLowerCase().includes(p.toLowerCase()))
        .map(p => {
          const idx = bodyText.toLowerCase().indexOf(p.toLowerCase());
          return {
            phrase: p,
            context: bodyText.substring(Math.max(0, idx - 40), idx + p.length + 40).replace(/\n/g, ' '),
          };
        });
    }).catch(() => []);

    for (const p of placeholderTextRendered) {
      issues.push({ type: 'placeholder-text-rendered', severity: 'high', detail: `Placeholder phrase "${p.phrase}" rendered in page text. Context: "...${p.context}..."` });
    }
  }

  // --- Grid stretch regression (if enabled) ---
  if (checks.includes('grid-stretch')) {
    const gridSelectors = checks.gridSelectors || ['.subjects-grid', '.features-row'];
    const selectorString = gridSelectors.join(', ');

    const gridStretchIssues = await page.$$eval(
      selectorString,
      grids => {
        const issues = [];
        for (const grid of grids) {
          const children = Array.from(grid.children).filter(c => {
            const r = c.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          });
          if (children.length < 2) continue;
          const widths = children.map(c => c.getBoundingClientRect().width);
          const minW = Math.min(...widths);
          const maxW = Math.max(...widths);
          if (minW === 0) continue;
          const ratio = maxW / minW;
          if (ratio > 1.5) {
            const cls = grid.className ? '.' + grid.className.split(' ')[0] : grid.tagName.toLowerCase();
            issues.push({
              container: cls,
              childCount: children.length,
              minWidth: Math.round(minW),
              maxWidth: Math.round(maxW),
              ratio: ratio.toFixed(2),
            });
          }
        }
        return issues;
      }
    ).catch(() => []);

    for (const g of gridStretchIssues) {
      issues.push({
        type: 'grid-stretch',
        severity: 'medium',
        detail: `${g.container} has ${g.childCount} children with unequal widths: min=${g.minWidth}px max=${g.maxWidth}px ratio=${g.ratio}. Last row likely stretching to fill.`,
      });
    }
  }

  // --- Layout overflow (always checked) ---
  const overflows = await page.evaluate(() => {
    const issues = [];
    const viewportWidth = window.innerWidth;
    if (document.body.scrollWidth > viewportWidth) {
      issues.push({ element: 'body', scrollWidth: document.body.scrollWidth, viewportWidth });
    }
    document.querySelectorAll('table, pre, .diagram-container, .katex-display').forEach(el => {
      if (el.scrollWidth > el.clientWidth + 2) {
        const overflow = window.getComputedStyle(el).overflowX;
        if (overflow === 'auto' || overflow === 'scroll') return;
        const tag = el.tagName.toLowerCase();
        const cls = el.className ? '.' + el.className.split(' ')[0] : '';
        issues.push({ element: `${tag}${cls}`, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth });
      }
    });
    return issues;
  }).catch(() => []);

  for (const o of overflows) {
    issues.push({ type: 'layout-overflow', severity: 'medium', detail: `${o.element}: scrollWidth=${o.scrollWidth}, clientWidth=${o.clientWidth || o.viewportWidth}` });
  }

  // --- Screenshots ---
  const prefix = page_info.id.replace(/\//g, '--');
  const fullScreenshotPath = join(screenshotDir, `${prefix}--full.png`);
  try {
    await page.screenshot({ path: fullScreenshotPath, fullPage: true });
  } catch (screenshotErr) {
    console.log(`    Warning: Full-page screenshot failed (${screenshotErr.message.substring(0, 60)}), taking viewport screenshot`);
    await page.screenshot({ path: fullScreenshotPath, fullPage: false });
  }

  // Cropped screenshots for KaTeX errors
  if (checks.includes('katex')) {
    const errorEls = await page.$$('.katex-error');
    for (let i = 0; i < errorEls.length; i++) {
      const cropPath = join(screenshotDir, `${prefix}--katex-error-${i}.png`);
      await errorEls[i].screenshot({ path: cropPath });
    }
  }

  await page.close();

  return {
    page: page_info.id,
    url: page_info.url,
    file: page_info.file,
    screenshotPath: fullScreenshotPath,
    issues,
    status: issues.length === 0 ? 'pass' : 'fail',
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { url: userUrl, pageFilter } = parseArgs(process.argv);
  const config = await loadConfig();

  const uxConfig = config.uxReviewer || {};
  const devCommand = uxConfig.devCommand || 'npx astro dev';
  const defaultPort = uxConfig.port || 4322;
  const contentDir = (config.validator || {}).contentDir || 'src/content';
  const contentExtensions = (config.validator || {}).contentExtensions || ['.md', '.mdx'];
  const checks = uxConfig.checks || ['console-errors', 'broken-images', 'layout-overflow'];
  // Attach extra config to checks object for use in reviewPage
  checks.gridSelectors = uxConfig.gridSelectors || ['.subjects-grid', '.features-row'];
  const ignoredPatterns = uxConfig.ignoredRequestPatterns || null;

  let server = null;
  let baseUrl = userUrl || uxConfig.baseUrl || null;

  try {
    if (!baseUrl) {
      console.log(`Starting dev server on port ${defaultPort}...`);
      const result = await startDevServer(devCommand, defaultPort);
      server = result.server;
      baseUrl = result.baseUrl;
    } else {
      console.log(`Using existing server at ${baseUrl}`);
    }

    const pages = await findPages(baseUrl, contentDir, contentExtensions, pageFilter);
    if (pages.length === 0) {
      console.log('No pages found to review.');
      return;
    }

    console.log(`\nReviewing ${pages.length} page(s)...\n`);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outputDir = join(REVIEW_DIR, timestamp);
    const screenshotDir = join(outputDir, 'screenshots');
    await mkdir(screenshotDir, { recursive: true });

    const browser = await puppeteer.launch({ headless: true });
    const results = [];

    for (const pageInfo of pages) {
      console.log(`  Reviewing ${pageInfo.id}...`);
      const result = await reviewPage(browser, pageInfo, screenshotDir, checks, ignoredPatterns);
      results.push(result);

      const issueCount = result.issues.length;
      const icon = issueCount === 0 ? 'PASS' : 'FAIL';
      console.log(`  ${icon} ${pageInfo.id} — ${issueCount} issue(s)`);
    }

    await browser.close();

    const report = {
      timestamp: new Date().toISOString(),
      baseUrl,
      pagesReviewed: pages.length,
      totalIssues: results.reduce((sum, r) => sum + r.issues.length, 0),
      results,
    };

    const reportPath = join(outputDir, 'report.json');
    await writeFile(reportPath, JSON.stringify(report, null, 2));

    console.log(`\nReport: ${reportPath}`);
    console.log(`Screenshots: ${screenshotDir}/`);
    console.log(`Total issues: ${report.totalIssues}`);

    console.log('\n--- JSON REPORT ---');
    console.log(JSON.stringify(report, null, 2));

    if (report.totalIssues > 0) {
      process.exitCode = 1;
    }
  } finally {
    if (server) server.kill();
  }
}

main().catch(err => {
  console.error('UX review failed:', err);
  process.exit(1);
});
