#!/usr/bin/env node

/**
 * MiraStack Daily Digest — site health, agent activity, and growth signals via email.
 * Sends via Resend API on a cron schedule.
 *
 * Usage: node bin/daily-digest.mjs
 *
 * Requires: RESEND_API_KEY env var
 *
 * Configuration (workflow-config.json):
 *   digest.toEmail — recipient(s), string or array
 *   digest.fromEmail — sender address (must be verified in Resend)
 *   digest.projectName — name shown in email subject/footer
 *   digest.analyticsPath — path to analytics report JSON
 *   digest.historyPath — path to digest history JSON (for trends)
 *   digest.contentDir — where content files live
 */

import { execSync } from 'child_process';
import { readFile, writeFile, readdir, mkdir } from 'fs/promises';
import { join } from 'path';

const PROJECT_ROOT = join(import.meta.dirname, '..');
const TKT = `${process.env.HOME}/go/bin/tkt`;
const RESEND_API_KEY = process.env.RESEND_API_KEY;

async function loadConfig() {
  const paths = [
    join(PROJECT_ROOT, 'workflow-config.json'),
    join(PROJECT_ROOT, '.claude', 'workflow-config.json'),
  ];
  for (const p of paths) {
    try { return JSON.parse(await readFile(p, 'utf-8')); } catch { /* next */ }
  }
  return {};
}

const config = await loadConfig();
const dc = config.digest || {};

const TO_EMAIL = dc.toEmail || [];
const FROM_EMAIL = dc.fromEmail || '';
const PROJECT_NAME = dc.projectName || 'MiraStack Project';
const ANALYTICS_PATH = join(PROJECT_ROOT, dc.analyticsPath || 'src/data/analytics-report.json');
const HISTORY_PATH = join(PROJECT_ROOT, dc.historyPath || 'src/data/digest-history.json');
const CONTENT_DIR = join(PROJECT_ROOT, dc.contentDir || (config.validator || {}).contentDir || 'src/content');

if (!RESEND_API_KEY) {
  console.error('daily-digest: RESEND_API_KEY not set, skipping.');
  process.exit(0);
}

if (!FROM_EMAIL || (Array.isArray(TO_EMAIL) ? TO_EMAIL.length === 0 : !TO_EMAIL)) {
  console.error('daily-digest: No email addresses configured. Set digest.toEmail and digest.fromEmail in workflow-config.json.');
  process.exit(0);
}

function run(cmd) {
  try {
    return execSync(cmd, { cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 15000 }).trim();
  } catch {
    return '';
  }
}

async function loadJson(path) {
  try { return JSON.parse(await readFile(path, 'utf-8')); } catch { return null; }
}

async function countContentFiles() {
  let files = 0;
  try {
    async function walk(dir) {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) await walk(join(dir, entry.name));
        else if (entry.name.endsWith('.md') || entry.name.endsWith('.mdx')) files++;
      }
    }
    await walk(CONTENT_DIR);
  } catch { /* skip */ }
  return files;
}

async function loadHistory() {
  try { return JSON.parse(await readFile(HISTORY_PATH, 'utf-8')); } catch { return []; }
}

async function saveHistory(history) {
  const dir = HISTORY_PATH.substring(0, HISTORY_PATH.lastIndexOf('/'));
  await mkdir(dir, { recursive: true });
  await writeFile(HISTORY_PATH, JSON.stringify(history, null, 2));
}

function trend(current, previous) {
  if (previous == null || previous === 0) return '';
  const diff = current - previous;
  const pct = ((diff / previous) * 100).toFixed(0);
  const arrow = diff > 0 ? '&#9650;' : diff < 0 ? '&#9660;' : '&#9644;';
  const color = diff > 0 ? '#2E7D32' : diff < 0 ? '#C62828' : '#888';
  return `<span style="color:${color};font-size:11px;">${arrow} ${diff > 0 ? '+' : ''}${pct}%</span>`;
}

function metricBox(value, label, color, trendHtml = '') {
  return `
    <td style="padding:8px 12px;background:${color};border-radius:6px;text-align:center;">
      <strong style="font-size:22px;color:#333;">${value}</strong> ${trendHtml}<br>
      <span style="font-size:11px;color:#666;">${label}</span>
    </td>
    <td style="width:6px;"></td>
  `;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function main() {
  const today = new Date();
  const dateStr = today.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const dateKey = today.toISOString().slice(0, 10);

  const recentCommits = run('git log --since="24 hours ago" --oneline --no-merges');
  const commitCount = recentCommits ? recentCommits.split('\n').filter(Boolean).length : 0;

  const unpushed = run('git log --oneline origin/main..HEAD');
  const unpushedCount = unpushed ? unpushed.split('\n').filter(Boolean).length : 0;

  const openCount = run(`${TKT} list --status open 2>/dev/null`).split('\n').filter(l => l.includes('t-')).length;
  const inProgressCount = run(`${TKT} list --status in_progress 2>/dev/null`).split('\n').filter(l => l.includes('t-')).length;

  const analytics = await loadJson(ANALYTICS_PATH);
  const contentCount = await countContentFiles();

  const history = await loadHistory();
  const lastEntry = history.length > 0 ? history[history.length - 1] : null;

  const todaySnapshot = {
    date: dateKey,
    pageViews: analytics?.summary?.totalPageViews || 0,
    sessions: analytics?.summary?.totalSessions || 0,
    contentFiles: contentCount,
    openTickets: openCount,
    commits: commitCount,
  };
  history.push(todaySnapshot);
  if (history.length > 90) history.splice(0, history.length - 90);
  await saveHistory(history);

  // --- Build email ---
  const s = [];

  s.push(`<h2 style="margin:0 0 16px;color:#1a1a2e;">Daily Digest — ${dateStr}</h2>`);

  if (analytics) {
    const pv = analytics.summary?.totalPageViews || 0;
    const sess = analytics.summary?.totalSessions || 0;
    const mobile = analytics.summary?.mobileShare || '-';
    s.push(`<h3 style="margin:16px 0 8px;color:#1a1a2e;">Traffic</h3>`);
    s.push(`<table style="width:100%;border-collapse:collapse;margin-bottom:12px;"><tr>`);
    s.push(metricBox(pv, 'page views', '#f2f7ee', trend(pv, lastEntry?.pageViews)));
    s.push(metricBox(sess, 'sessions', '#eef0fa', trend(sess, lastEntry?.sessions)));
    s.push(metricBox(mobile, 'mobile', '#fceef5'));
    s.push(`</tr></table>`);
  } else {
    s.push(`<p style="color:#999;font-style:italic;">No analytics data — run bin/pull-analytics.mjs</p>`);
  }

  s.push(`<h3 style="margin:16px 0 8px;color:#1a1a2e;">Content</h3>`);
  s.push(`<table style="width:100%;border-collapse:collapse;margin-bottom:12px;"><tr>`);
  s.push(metricBox(contentCount, 'content files', '#f2f7ee', trend(contentCount, lastEntry?.contentFiles)));
  s.push(`</tr></table>`);

  s.push(`<h3 style="margin:16px 0 8px;color:#1a1a2e;">Pipeline</h3>`);
  s.push(`<table style="width:100%;border-collapse:collapse;margin-bottom:12px;"><tr>`);
  s.push(metricBox(commitCount, 'commits (24h)', '#f2f7ee'));
  s.push(metricBox(openCount, 'open tickets', '#eef0fa', trend(openCount, lastEntry?.openTickets)));
  s.push(metricBox(inProgressCount, 'in progress', '#fceef5'));
  s.push(`</tr></table>`);

  if (unpushedCount > 0) {
    s.push(`
      <div style="padding:10px 16px;background:#FFF3E0;border-left:4px solid #E65100;border-radius:0 6px 6px 0;margin-bottom:12px;font-size:13px;">
        <strong>${unpushedCount} unpushed commit${unpushedCount > 1 ? 's' : ''}</strong> — review and push when ready
      </div>
    `);
  }

  if (recentCommits) {
    const commitLines = recentCommits.split('\n').filter(Boolean).slice(0, 8).map(c => {
      const [hash, ...msg] = c.split(' ');
      return `<code style="color:#888;">${hash}</code> ${msg.join(' ')}`;
    }).join('<br>');
    s.push(`
      <h3 style="margin:16px 0 8px;color:#333;">Recent Commits</h3>
      <div style="padding:10px;background:#f8f8f8;border-radius:6px;font-size:12px;line-height:1.8;">
        ${commitLines}
      </div>
    `);
  }

  s.push(`
    <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
    <p style="font-size:11px;color:#999;text-align:center;">${PROJECT_NAME} — powered by MiraStack</p>
  `);

  const html = `<div style="max-width:600px;margin:0 auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#333;line-height:1.6;">${s.join('\n')}</div>`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: Array.isArray(TO_EMAIL) ? TO_EMAIL : [TO_EMAIL],
      subject: `${PROJECT_NAME} — Daily Digest (${dateStr})`,
      html,
    }),
  });

  if (res.ok) {
    const data = await res.json();
    console.log(`daily-digest: Email sent (${data.id})`);
  } else {
    const err = await res.text();
    console.error(`daily-digest: Failed to send — ${res.status}: ${err}`);
  }
}

main().catch(err => {
  console.error('daily-digest: Fatal error:', err);
  process.exit(1);
});
