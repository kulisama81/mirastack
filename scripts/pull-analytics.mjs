#!/usr/bin/env node

/**
 * MiraStack Analytics — pull GA4 + Google Search Console data into a JSON report.
 * Agents (@planner, @autoresearch) read this report to prioritize by real traffic.
 *
 * Usage:
 *   node scripts/pull-analytics.mjs                # last 28 days (default)
 *   node scripts/pull-analytics.mjs --days 7       # last 7 days
 *
 * Requires:
 *   - .ga-credentials.json (service account key, gitignored)
 *   - npm install @google-analytics/data googleapis
 *
 * Configuration (workflow-config.json):
 *   analytics.propertyId — GA4 property ID
 *   analytics.gscSiteUrl — Google Search Console site URL (e.g., "sc-domain:example.com")
 *   analytics.credentialsPath — path to service account key (default: ".ga-credentials.json")
 *   analytics.outputPath — where to write the report (default: "src/data/analytics-report.json")
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

const PROJECT_ROOT = join(import.meta.dirname, '..');

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
const ac = config.analytics || {};

const CREDENTIALS_PATH = join(PROJECT_ROOT, ac.credentialsPath || '.ga-credentials.json');
const OUTPUT_PATH = join(PROJECT_ROOT, ac.outputPath || 'src/data/analytics-report.json');
const PROPERTY_ID = ac.propertyId || process.env.GA4_PROPERTY_ID || '';
const GSC_SITE_URL = ac.gscSiteUrl || process.env.GSC_SITE_URL || '';

// Parse CLI args
const args = process.argv.slice(2);
let days = 28;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--days' && args[i + 1]) {
    days = parseInt(args[i + 1], 10);
    i++;
  }
}

if (!PROPERTY_ID) {
  console.error('pull-analytics: No GA4 property ID configured.');
  console.error('Set analytics.propertyId in workflow-config.json or GA4_PROPERTY_ID env var.');
  process.exit(1);
}

async function main() {
  console.log(`Pulling GA4 analytics (last ${days} days)...\n`);

  let credentials;
  try {
    credentials = JSON.parse(await readFile(CREDENTIALS_PATH, 'utf-8'));
  } catch {
    console.error(`Missing credentials at ${CREDENTIALS_PATH}`);
    process.exit(1);
  }

  // Dynamic imports — these are optional dependencies
  const { BetaAnalyticsDataClient } = await import('@google-analytics/data');
  const { google } = await import('googleapis');

  const client = new BetaAnalyticsDataClient({ credentials });
  const startDate = `${days}daysAgo`;
  const endDate = 'today';

  // --- Report 1: Page views by page ---
  console.log('  Fetching page views by page...');
  const [pageViews] = await client.runReport({
    property: `properties/${PROPERTY_ID}`,
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: 'pagePath' }],
    metrics: [
      { name: 'screenPageViews' },
      { name: 'averageSessionDuration' },
      { name: 'bounceRate' },
    ],
    orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
    limit: 50,
  });

  // --- Report 2: Device breakdown ---
  console.log('  Fetching device breakdown...');
  const [devices] = await client.runReport({
    property: `properties/${PROPERTY_ID}`,
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: 'deviceCategory' }],
    metrics: [{ name: 'sessions' }, { name: 'screenPageViews' }],
  });

  // --- Report 3: Top landing pages ---
  console.log('  Fetching top landing pages...');
  const [landings] = await client.runReport({
    property: `properties/${PROPERTY_ID}`,
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: 'landingPagePlusQueryString' }],
    metrics: [{ name: 'sessions' }, { name: 'bounceRate' }],
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    limit: 20,
  });

  // --- Report 4: Geography ---
  console.log('  Fetching geography...');
  const [geo] = await client.runReport({
    property: `properties/${PROPERTY_ID}`,
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: 'country' }],
    metrics: [{ name: 'sessions' }],
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    limit: 15,
  });

  // --- Report 5: Search terms ---
  console.log('  Fetching search terms...');
  const [searches] = await client.runReport({
    property: `properties/${PROPERTY_ID}`,
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: 'searchTerm' }],
    metrics: [{ name: 'eventCount' }],
    orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
    limit: 30,
  });

  // --- Report 6: Traffic sources ---
  console.log('  Fetching traffic sources...');
  const [sources] = await client.runReport({
    property: `properties/${PROPERTY_ID}`,
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: 'sessionDefaultChannelGroup' }],
    metrics: [{ name: 'sessions' }, { name: 'screenPageViews' }],
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
  });

  // --- Google Search Console (optional) ---
  let searchConsole = null;
  if (GSC_SITE_URL) {
    console.log('  Fetching Search Console data...');
    try {
      const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
      });
      const searchconsole = google.searchconsole({ version: 'v1', auth });

      const gscEnd = new Date();
      gscEnd.setDate(gscEnd.getDate() - 3);
      const gscStart = new Date(gscEnd);
      gscStart.setDate(gscStart.getDate() - days);
      const gscStartDate = gscStart.toISOString().split('T')[0];
      const gscEndDate = gscEnd.toISOString().split('T')[0];

      const queriesRes = await searchconsole.searchanalytics.query({
        siteUrl: GSC_SITE_URL,
        requestBody: { startDate: gscStartDate, endDate: gscEndDate, dimensions: ['query'], rowLimit: 30, type: 'web' },
      });

      const searchQueries = (queriesRes.data.rows || []).map(row => ({
        query: row.keys[0],
        clicks: row.clicks,
        impressions: row.impressions,
        ctr: (row.ctr * 100).toFixed(1) + '%',
        position: row.position.toFixed(1),
      }));

      const pagesRes = await searchconsole.searchanalytics.query({
        siteUrl: GSC_SITE_URL,
        requestBody: { startDate: gscStartDate, endDate: gscEndDate, dimensions: ['page'], rowLimit: 30, type: 'web' },
      });

      const topPages = (pagesRes.data.rows || []).map(row => ({
        page: row.keys[0],
        clicks: row.clicks,
        impressions: row.impressions,
        ctr: (row.ctr * 100).toFixed(1) + '%',
        position: row.position.toFixed(1),
      }));

      searchConsole = { period: `${gscStartDate} to ${gscEndDate}`, searchQueries, topPages };
      console.log(`    GSC: ${searchQueries.length} queries, ${topPages.length} pages`);
    } catch (gscErr) {
      console.log(`  Search Console fetch failed: ${gscErr.message}`);
      searchConsole = { error: gscErr.message };
    }
  }

  // --- Build report ---
  const report = {
    generated: new Date().toISOString(),
    period: `last ${days} days`,
    propertyId: PROPERTY_ID,

    pageViews: (pageViews.rows || []).map(row => ({
      page: row.dimensionValues[0].value,
      views: parseInt(row.metricValues[0].value, 10),
      avgSessionDuration: parseFloat(row.metricValues[1].value).toFixed(1),
      bounceRate: (parseFloat(row.metricValues[2].value) * 100).toFixed(1) + '%',
    })),

    devices: (devices.rows || []).map(row => ({
      device: row.dimensionValues[0].value,
      sessions: parseInt(row.metricValues[0].value, 10),
      pageViews: parseInt(row.metricValues[1].value, 10),
    })),

    topLandingPages: (landings.rows || []).map(row => ({
      page: row.dimensionValues[0].value,
      sessions: parseInt(row.metricValues[0].value, 10),
      bounceRate: (parseFloat(row.metricValues[1].value) * 100).toFixed(1) + '%',
    })),

    geography: (geo.rows || []).map(row => ({
      country: row.dimensionValues[0].value,
      sessions: parseInt(row.metricValues[0].value, 10),
    })),

    searchTerms: (searches.rows || []).map(row => ({
      term: row.dimensionValues[0].value,
      count: parseInt(row.metricValues[0].value, 10),
    })),

    trafficSources: (sources.rows || []).map(row => ({
      channel: row.dimensionValues[0].value,
      sessions: parseInt(row.metricValues[0].value, 10),
      pageViews: parseInt(row.metricValues[1].value, 10),
    })),

    searchConsole,
  };

  // --- Summary stats ---
  const totalViews = report.pageViews.reduce((sum, p) => sum + p.views, 0);
  const totalSessions = report.devices.reduce((sum, d) => sum + d.sessions, 0);
  report.summary = {
    totalPageViews: totalViews,
    totalSessions: totalSessions,
    topPage: report.pageViews[0]?.page || 'none',
    mobileShare: (() => {
      const mobile = report.devices.find(d => d.device === 'mobile');
      return mobile ? ((mobile.sessions / totalSessions) * 100).toFixed(1) + '%' : '0%';
    })(),
    topCountry: report.geography[0]?.country || 'unknown',
  };

  // --- Write report ---
  const outputDir = OUTPUT_PATH.substring(0, OUTPUT_PATH.lastIndexOf('/'));
  await mkdir(outputDir, { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(report, null, 2));

  console.log(`\n  Report written to ${OUTPUT_PATH}`);
  console.log(`  Total page views: ${totalViews}`);
  console.log(`  Total sessions: ${totalSessions}`);
  console.log(`  Top page: ${report.summary.topPage}`);
  console.log(`  Mobile share: ${report.summary.mobileShare}`);
}

main().catch(err => {
  console.error('Analytics pull failed:', err.message);
  process.exit(1);
});
