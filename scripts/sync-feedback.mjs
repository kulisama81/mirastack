#!/usr/bin/env node

/**
 * MiraStack Feedback Sync — GitHub Issues → tkt tickets.
 *
 * Reads open GitHub Issues with a configurable label and creates
 * corresponding tkt tickets (if not already synced).
 *
 * Usage:
 *   node scripts/sync-feedback.mjs
 *
 * Requires:
 *   - GITHUB_TOKEN env var (repo issues scope)
 *   - tkt CLI in PATH (or ~/go/bin)
 *
 * Configuration (workflow-config.json):
 *   feedbackSync.repo — GitHub repo (e.g., "owner/repo")
 *   feedbackSync.label — issue label to sync (default: "user-submitted")
 *   feedbackSync.syncedLabel — label added after sync (default: "synced-to-tkt")
 */

import { readFile } from 'fs/promises';
import { execSync } from 'node:child_process';
import { join } from 'path';

const PROJECT_ROOT = join(import.meta.dirname, '..');

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

const config = await loadConfig();
const feedbackConfig = config.feedbackSync || {};

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPO || feedbackConfig.repo || '';
const LABEL = feedbackConfig.label || 'user-submitted';
const SYNCED_LABEL = feedbackConfig.syncedLabel || 'synced-to-tkt';
const TKT = process.env.TKT_PATH || `${process.env.HOME}/go/bin/tkt`;

if (!GITHUB_TOKEN) {
  console.log('sync-feedback: GITHUB_TOKEN not set, skipping sync.');
  process.exit(0);
}

if (!REPO) {
  console.log('sync-feedback: No repo configured. Set GITHUB_REPO env var or feedbackSync.repo in workflow-config.json.');
  process.exit(0);
}

async function fetchIssues() {
  const url = `https://api.github.com/repos/${REPO}/issues?labels=${encodeURIComponent(LABEL)}&state=open&per_page=50`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) {
    console.error(`sync-feedback: GitHub API returned ${res.status}`);
    return [];
  }
  return res.json();
}

function tkt(args) {
  try {
    return execSync(`${TKT} ${args}`, { encoding: 'utf-8', timeout: 10000 }).trim();
  } catch (e) {
    console.error(`sync-feedback: tkt command failed: ${e.message}`);
    return null;
  }
}

async function addLabelToIssue(issueNumber, label) {
  await fetch(`https://api.github.com/repos/${REPO}/issues/${issueNumber}/labels`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({ labels: [label] }),
  });
}

async function main() {
  const issues = await fetchIssues();
  if (!issues.length) {
    console.log('sync-feedback: No open issues found.');
    return;
  }

  let synced = 0;
  for (const issue of issues) {
    const labels = issue.labels.map((l) => (typeof l === 'string' ? l : l.name));
    if (labels.includes(SYNCED_LABEL)) continue;

    const isCorrection = labels.includes('correction');
    const ticketType = isCorrection ? 'bug' : 'feature';

    const title = issue.title.replace(/^\[(Correction|Feature)\]\s*/, '');
    const result = tkt(
      `create "${title.replace(/"/g, '\\"')}" --type ${ticketType} --tags ${LABEL},needs-triage --external-ref "${issue.html_url}"`
    );

    if (result) {
      const match = result.match(/t-[a-f0-9]+/);
      if (match) {
        const noteBody = (issue.body || '').slice(0, 500).replace(/"/g, '\\"').replace(/\n/g, '\\n');
        tkt(`add-note ${match[0]} "${noteBody}"`);
      }

      await addLabelToIssue(issue.number, SYNCED_LABEL);
      synced++;
      console.log(`sync-feedback: Synced issue #${issue.number} → ${match?.[0] || 'tkt'}`);
    }
  }

  console.log(`sync-feedback: ${synced} issue(s) synced.`);
}

main().catch((err) => {
  console.error('sync-feedback: Fatal error:', err);
  process.exit(1);
});
