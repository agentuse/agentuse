import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import type { SuiteResult } from '../types.js';
import {
  generateReportData,
  formatDuration,
  formatCost,
  GLOSSARY_ITEMS,
} from './shared.js';

/**
 * Generate HTML report from suite results
 */
export function generateHtmlReport(result: SuiteResult): string {
  const data = generateReportData(result);
  const dataJson = JSON.stringify(data, null, 2);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(result.suiteName)} - Benchmark Results</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    :root {
      --bg-primary: #0d0d0d;
      --bg-secondary: #161616;
      --bg-tertiary: #1a1a1a;
      --bg-hover: #222222;
      --border: #2a2a2a;
      --border-light: #333333;
      --text-primary: #e5e5e5;
      --text-secondary: #a3a3a3;
      --text-muted: #6b6b6b;
      --accent: #00d4aa;
      --accent-dim: rgba(0, 212, 170, 0.15);
      --success: #22c55e;
      --warning: #eab308;
      --error: #ef4444;
      --chart-1: #00d4aa;
      --chart-2: #3b82f6;
      --chart-3: #a855f7;
      --chart-4: #f97316;
      --chart-5: #ec4899;
      --chart-6: #06b6d4;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: 'IBM Plex Sans', -apple-system, sans-serif;
      background: var(--bg-primary);
      color: var(--text-primary);
      line-height: 1.5;
      min-height: 100vh;
    }

    .mono {
      font-family: 'JetBrains Mono', 'SF Mono', monospace;
    }

    .container {
      max-width: 1400px;
      margin: 0 auto;
      padding: 0 24px;
    }

    /* Header */
    header {
      border-bottom: 1px solid var(--border);
      padding: 32px 0;
    }

    .header-content {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 24px;
      flex-wrap: wrap;
    }

    .header-title {
      font-family: 'JetBrains Mono', monospace;
      font-size: 20px;
      font-weight: 600;
      color: var(--text-primary);
      letter-spacing: -0.02em;
    }

    .header-meta {
      display: flex;
      gap: 24px;
      font-size: 13px;
      color: var(--text-muted);
      font-family: 'JetBrains Mono', monospace;
    }

    .header-meta span {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .run-id {
      color: var(--accent);
      background: var(--accent-dim);
      padding: 2px 8px;
      border-radius: 3px;
    }

    /* Summary Stats */
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 1px;
      background: var(--border);
      border: 1px solid var(--border);
      margin: 32px 0;
    }

    @media (max-width: 768px) {
      .stats-grid { grid-template-columns: repeat(2, 1fr); }
    }

    .stat-card {
      background: var(--bg-secondary);
      padding: 20px 24px;
    }

    .stat-label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--text-muted);
      margin-bottom: 8px;
    }

    .stat-value {
      font-family: 'JetBrains Mono', monospace;
      font-size: 28px;
      font-weight: 600;
      color: var(--text-primary);
    }

    /* Section */
    .section {
      margin: 40px 0;
    }

    .section-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--border);
    }

    .section-title {
      font-family: 'JetBrains Mono', monospace;
      font-size: 14px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-secondary);
    }

    /* Table */
    .table-wrapper {
      border: 1px solid var(--border);
      overflow-x: auto;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }

    thead {
      background: var(--bg-tertiary);
    }

    th {
      padding: 12px 16px;
      text-align: left;
      font-size: 11px;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--text-muted);
      border-bottom: 1px solid var(--border);
      white-space: nowrap;
    }

    th.sortable {
      cursor: pointer;
      user-select: none;
      transition: color 0.15s;
    }

    th.sortable:hover {
      color: var(--text-secondary);
    }

    th.sort-asc::after { content: ' ↑'; color: var(--accent); }
    th.sort-desc::after { content: ' ↓'; color: var(--accent); }

    td {
      padding: 14px 16px;
      border-bottom: 1px solid var(--border);
      color: var(--text-secondary);
    }

    tr:hover td {
      background: var(--bg-hover);
    }

    tr:last-child td {
      border-bottom: none;
    }

    .cell-rank {
      font-family: 'JetBrains Mono', monospace;
      font-weight: 600;
      color: var(--text-muted);
      width: 60px;
    }

    .cell-model {
      min-width: 180px;
    }

    .model-name {
      font-weight: 500;
      color: var(--text-primary);
    }

    .model-provider {
      font-size: 11px;
      color: var(--text-muted);
      margin-top: 2px;
    }

    .cell-score {
      font-family: 'JetBrains Mono', monospace;
      font-weight: 600;
    }

    .cell-metric {
      font-family: 'JetBrains Mono', monospace;
      text-align: right;
    }

    .score-badge {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 3px;
      font-size: 13px;
      font-weight: 600;
    }

    .score-high { color: var(--success); background: rgba(34, 197, 94, 0.12); }
    .score-mid { color: var(--warning); background: rgba(234, 179, 8, 0.12); }
    .score-low { color: var(--error); background: rgba(239, 68, 68, 0.12); }

    /* Status indicators */
    .status {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      font-weight: 500;
    }

    .status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
    }

    .status-pass { color: var(--success); }
    .status-pass .status-dot { background: var(--success); }
    .status-partial { color: var(--warning); }
    .status-partial .status-dot { background: var(--warning); }
    .status-fail { color: var(--error); }
    .status-fail .status-dot { background: var(--error); }

    /* Charts */
    .charts-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 24px;
    }

    @media (max-width: 900px) {
      .charts-grid { grid-template-columns: 1fr; }
    }

    .chart-card {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      padding: 24px;
    }

    .chart-title {
      font-size: 12px;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
      margin-bottom: 20px;
    }

    .chart-container {
      position: relative;
      height: 220px;
    }

    /* Model Details */
    .model-card {
      border: 1px solid var(--border);
      margin-bottom: 8px;
    }

    .model-card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16px 20px;
      background: var(--bg-secondary);
      cursor: pointer;
      transition: background 0.15s;
    }

    .model-card-header:hover {
      background: var(--bg-hover);
    }

    .model-card-left {
      display: flex;
      align-items: center;
      gap: 16px;
    }

    .model-card-name {
      font-weight: 500;
      color: var(--text-primary);
    }

    .model-card-provider {
      font-size: 12px;
      color: var(--text-muted);
    }

    .chevron {
      width: 16px;
      height: 16px;
      color: var(--text-muted);
      transition: transform 0.2s;
    }

    .model-card.expanded .chevron {
      transform: rotate(180deg);
    }

    .model-card-content {
      display: none;
      padding: 20px;
      background: var(--bg-tertiary);
      border-top: 1px solid var(--border);
    }

    .model-card.expanded .model-card-content {
      display: block;
    }

    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 20px;
    }

    @media (max-width: 768px) {
      .metrics-grid { grid-template-columns: repeat(2, 1fr); }
    }

    .metric-item {
      padding: 12px 0;
    }

    .metric-label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--text-muted);
      margin-bottom: 6px;
    }

    .metric-value {
      font-family: 'JetBrains Mono', monospace;
      font-size: 18px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .errors-panel {
      margin-top: 20px;
      padding: 16px;
      background: rgba(239, 68, 68, 0.08);
      border: 1px solid rgba(239, 68, 68, 0.2);
    }

    .errors-title {
      font-size: 12px;
      font-weight: 500;
      color: var(--error);
      margin-bottom: 12px;
    }

    .error-tags {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .error-tag {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      padding: 4px 8px;
      background: rgba(239, 68, 68, 0.12);
      color: var(--error);
    }

    .error-details-list {
      margin-top: 12px;
      border-top: 1px solid rgba(239, 68, 68, 0.15);
      padding-top: 12px;
    }

    .error-detail-item {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 8px 0;
      border-bottom: 1px solid rgba(239, 68, 68, 0.1);
      font-size: 11px;
    }

    .error-detail-item:last-child {
      border-bottom: none;
    }

    .error-detail-scenario {
      font-family: 'JetBrains Mono', monospace;
      color: var(--text-secondary);
      white-space: nowrap;
      flex-shrink: 0;
    }

    .error-detail-type {
      font-family: 'JetBrains Mono', monospace;
      padding: 2px 6px;
      background: rgba(239, 68, 68, 0.12);
      color: var(--error);
      font-size: 10px;
      flex-shrink: 0;
    }

    .error-detail-message {
      font-family: 'JetBrains Mono', monospace;
      color: var(--text-muted);
      flex: 1;
      min-width: 0;
      word-break: break-word;
    }

    /* Difficulty badges */
    .difficulty {
      font-family: 'JetBrains Mono', monospace;
      font-size: 10px;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: 3px 8px;
      margin-top: 4px;
      display: inline-block;
    }

    .difficulty-easy { color: var(--success); background: rgba(34, 197, 94, 0.1); }
    .difficulty-medium { color: var(--warning); background: rgba(234, 179, 8, 0.1); }
    .difficulty-hard { color: var(--error); background: rgba(239, 68, 68, 0.1); }

    /* Footer */
    footer {
      margin-top: 60px;
      padding: 24px 0;
      border-top: 1px solid var(--border);
    }

    .footer-text {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      color: var(--text-muted);
      text-align: center;
    }

    .footer-text strong {
      color: var(--text-secondary);
    }

    /* Glossary */
    .glossary {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      padding: 24px 28px;
    }

    .glossary-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 16px 32px;
    }

    @media (max-width: 768px) {
      .glossary-grid { grid-template-columns: 1fr; }
    }

    .glossary-item {
      display: flex;
      gap: 12px;
      padding: 8px 0;
      border-bottom: 1px solid var(--border);
    }

    .glossary-item:last-child {
      border-bottom: none;
    }

    .glossary-term {
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
      font-weight: 600;
      color: var(--accent);
      white-space: nowrap;
      min-width: 120px;
      flex-shrink: 0;
    }

    .glossary-def {
      font-size: 12px;
      color: var(--text-secondary);
      line-height: 1.5;
    }
  </style>
</head>
<body>
  <script>
    const DATA = ${dataJson};
  </script>

  <header>
    <div class="container">
      <div class="header-content">
        <h1 class="header-title">${escapeHtml(result.suiteName)}</h1>
        <div class="header-meta">
          <span><span class="run-id">${escapeHtml(result.runId)}</span></span>
          <span>${new Date(result.timestamp).toISOString().slice(0, 19).replace('T', ' ')}</span>
          <span>${formatDuration(result.durationMs)}</span>
        </div>
      </div>
    </div>
  </header>

  <main class="container">
    <!-- Summary Stats -->
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Models</div>
        <div class="stat-value">${data.summary.totalModels}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Scenarios</div>
        <div class="stat-value">${data.summary.totalScenarios}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Trials</div>
        <div class="stat-value">${data.summary.totalTrials}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total Cost</div>
        <div class="stat-value">${formatCost(data.summary.totalCostUsd)}</div>
      </div>
    </div>

    <!-- Model Ranking -->
    <section class="section">
      <div class="section-header">
        <h2 class="section-title">Model Ranking</h2>
      </div>
      <div class="table-wrapper">
        <table id="ranking-table">
          <thead id="ranking-header"></thead>
          <tbody id="ranking-body"></tbody>
        </table>
      </div>
    </section>

    <!-- Charts -->
    <section class="section">
      <div class="section-header">
        <h2 class="section-title">Performance Overview</h2>
      </div>
      <div class="charts-grid">
        <div class="chart-card">
          <h3 class="chart-title">Overall Scores</h3>
          <div class="chart-container">
            <canvas id="scores-chart"></canvas>
          </div>
        </div>
        <div class="chart-card">
          <h3 class="chart-title">Multi-Metric Comparison</h3>
          <div class="chart-container">
            <canvas id="radar-chart"></canvas>
          </div>
        </div>
      </div>
    </section>

    <!-- Model Details -->
    <section class="section">
      <div class="section-header">
        <h2 class="section-title">Model Details</h2>
      </div>
      <div id="model-details"></div>
    </section>

    <!-- Scenarios -->
    <section class="section">
      <div class="section-header">
        <h2 class="section-title">Scenarios Breakdown</h2>
      </div>
      <div class="table-wrapper">
        <table>
          <thead id="scenarios-header"></thead>
          <tbody id="scenarios-body"></tbody>
        </table>
      </div>
    </section>

    <!-- Glossary -->
    <section class="section">
      <div class="section-header">
        <h2 class="section-title">Glossary</h2>
      </div>
      <div class="glossary">
        <div class="glossary-grid">
          ${GLOSSARY_ITEMS.map(item => `
          <div class="glossary-item">
            <span class="glossary-term">${escapeHtml(item.term)}</span>
            <span class="glossary-def">${escapeHtml(item.definition)}</span>
          </div>`).join('')}
        </div>
      </div>
    </section>
  </main>

  <footer>
    <div class="container">
      <p class="footer-text">Generated by <strong>AgentUse Benchmark</strong> · ${new Date().toISOString()}</p>
    </div>
  </footer>

  <script>
    function formatPercent(value) {
      return (value * 100).toFixed(1) + '%';
    }

    function formatDuration(ms) {
      if (ms < 1000) return ms + 'ms';
      if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
      const minutes = Math.floor(ms / 60000);
      const seconds = ((ms % 60000) / 1000).toFixed(0);
      return minutes + 'm ' + seconds + 's';
    }

    function formatCost(usd) {
      if (usd === undefined || usd === null) return '—';
      if (usd < 0.01) return '$' + usd.toFixed(4);
      if (usd < 1) return '$' + usd.toFixed(3);
      return '$' + usd.toFixed(2);
    }

    function formatTokens(count) {
      if (count === undefined || count === null) return '—';
      if (count >= 1000000) return (count / 1000000).toFixed(1) + 'M';
      if (count >= 1000) return (count / 1000).toFixed(1) + 'K';
      return count.toString();
    }

    function getScoreClass(score) {
      if (score >= 90) return 'score-high';  // Green: excellent
      if (score >= 80) return 'score-mid';   // Yellow: good
      return 'score-low';                     // Red: needs improvement
    }

    // Check if any model has goals
    const hasGoals = DATA.models.some(m => m.goals);
    // Check if weighted scores are available (must be non-null number)
    const hasWeightedScores = DATA.models.some(m => m.scores.weighted != null);
    // Hide consistency when runs=1 (always 100%)
    const showConsistency = DATA.runs > 1;

    // Ranking table
    function renderRankingHeader() {
      const thead = document.getElementById('ranking-header');
      if (hasGoals) {
        let headers = '<tr>';
        headers += '<th class="sortable" data-sort="rank">Rank</th>';
        headers += '<th class="sortable" data-sort="name">Model</th>';
        headers += '<th class="sortable" data-sort="score">Score</th>';
        if (hasWeightedScores) headers += '<th class="sortable" data-sort="unweighted">Unweighted</th>';
        headers += '<th class="sortable cell-metric" data-sort="passK">Pass^k</th>';
        headers += '<th class="sortable cell-metric" data-sort="efficiency">Efficiency</th>';
        headers += '<th class="sortable cell-metric" data-sort="avgAttempts">Tools/Goal</th>';
        headers += '<th class="sortable cell-metric" data-sort="toolFailure">Tool Failure</th>';
        headers += '<th class="sortable cell-metric" data-sort="toolEfficiency">Tool Efficiency</th>';
        headers += '<th class="sortable cell-metric" data-sort="latency">P95 Latency</th>';
        headers += '<th class="sortable cell-metric" data-sort="cost">Avg Cost</th>';
        headers += '</tr>';
        thead.innerHTML = headers;
      } else {
        let headers = '<tr>';
        headers += '<th class="sortable" data-sort="rank">Rank</th>';
        headers += '<th class="sortable" data-sort="name">Model</th>';
        headers += '<th class="sortable" data-sort="score">Score</th>';
        if (hasWeightedScores) headers += '<th class="sortable" data-sort="unweighted">Unweighted</th>';
        headers += '<th class="sortable cell-metric" data-sort="completion">Completion</th>';
        headers += '<th class="sortable cell-metric" data-sort="passK">Pass^k</th>';
        if (showConsistency) headers += '<th class="sortable cell-metric" data-sort="consistency">Consistency</th>';
        headers += '<th class="sortable cell-metric" data-sort="latency">P95 Latency</th>';
        headers += '<th class="sortable cell-metric" data-sort="cost">Avg Cost</th>';
        headers += '</tr>';
        thead.innerHTML = headers;
      }
    }

    function renderRankingTable(sortKey = 'rank', sortDir = 'asc') {
      const tbody = document.getElementById('ranking-body');
      const models = [...DATA.models];

      models.sort((a, b) => {
        let valA, valB;
        switch (sortKey) {
          case 'rank':
            valA = DATA.ranking.find(r => r.model === a.id)?.rank || 999;
            valB = DATA.ranking.find(r => r.model === b.id)?.rank || 999;
            break;
          case 'name': valA = a.name; valB = b.name; break;
          // Score = weighted if available and valid, else overall (unweighted)
          case 'score': valA = (a.scores.weighted != null) ? a.scores.weighted : (a.scores.overall ?? 0); valB = (b.scores.weighted != null) ? b.scores.weighted : (b.scores.overall ?? 0); break;
          case 'unweighted': valA = a.scores.overall; valB = b.scores.overall; break;
          case 'completion': valA = a.scores.completion; valB = b.scores.completion; break;
          case 'passK': valA = a.scores.passK; valB = b.scores.passK; break;
          case 'consistency': valA = a.scores.consistency; valB = b.scores.consistency; break;
          case 'efficiency': valA = a.scores.efficiency; valB = b.scores.efficiency; break;
          case 'avgAttempts': valA = a.goals?.avgAttempts || 999; valB = b.goals?.avgAttempts || 999; break;
          case 'toolFailure': valA = a.goals?.toolCallFailureRate || 0; valB = b.goals?.toolCallFailureRate || 0; break;
          case 'toolEfficiency': valA = a.goals?.toolCallEfficiency || 0; valB = b.goals?.toolCallEfficiency || 0; break;
          case 'latency': valA = a.latency.p95Ms; valB = b.latency.p95Ms; break;
          case 'cost': valA = a.cost.perFullRun; valB = b.cost.perFullRun; break;
          default: valA = a.scores.overall; valB = b.scores.overall;
        }
        return sortDir === 'asc' ? (valA > valB ? 1 : -1) : (valA < valB ? 1 : -1);
      });

      tbody.innerHTML = models.map(m => {
        const rank = DATA.ranking.find(r => r.model === m.id)?.rank || '-';
        // Score = weighted if available and valid, else overall (unweighted)
        const primaryScore = (m.scores.weighted != null) ? m.scores.weighted : (m.scores.overall ?? 0);
        // Unweighted cell only shown when weighted scores exist
        const unweightedCell = hasWeightedScores
          ? '<td class="cell-metric mono">' + (m.scores.overall?.toFixed(1) ?? '—') + '</td>'
          : '';

        if (hasGoals) {
          const failureRate = m.goals?.toolCallFailureRate;
          const failureRateStr = (failureRate != null && !isNaN(failureRate)) ? formatPercent(failureRate) : '—';
          const toolEfficiency = m.goals?.toolCallEfficiency;
          const toolEfficiencyStr = (toolEfficiency != null && !isNaN(toolEfficiency)) ? formatPercent(toolEfficiency) : '—';
          return \`
            <tr>
              <td class="cell-rank">#\${rank}</td>
              <td class="cell-model">
                <div class="model-name">\${m.name}</div>
                <div class="model-provider">\${m.provider}</div>
              </td>
              <td class="cell-score">
                <span class="score-badge \${getScoreClass(primaryScore)}">\${primaryScore.toFixed(1)}</span>
              </td>
              \${unweightedCell}
              <td class="cell-metric mono">\${formatPercent(m.scores.passK)}</td>
              <td class="cell-metric mono">\${formatPercent(m.scores.efficiency)}</td>
              <td class="cell-metric mono">\${m.goals ? m.goals.avgAttempts.toFixed(1) : '—'}</td>
              <td class="cell-metric mono">\${failureRateStr}</td>
              <td class="cell-metric mono">\${toolEfficiencyStr}</td>
              <td class="cell-metric mono">\${formatDuration(m.latency.p95Ms)}</td>
              <td class="cell-metric mono">\${formatCost(m.cost.perFullRun)}</td>
            </tr>
          \`;
        } else {
          const consistencyCell = showConsistency
            ? '<td class="cell-metric mono">' + formatPercent(m.scores.consistency) + '</td>'
            : '';
          return \`
            <tr>
              <td class="cell-rank">#\${rank}</td>
              <td class="cell-model">
                <div class="model-name">\${m.name}</div>
                <div class="model-provider">\${m.provider}</div>
              </td>
              <td class="cell-score">
                <span class="score-badge \${getScoreClass(primaryScore)}">\${primaryScore.toFixed(1)}</span>
              </td>
              \${unweightedCell}
              <td class="cell-metric mono">\${formatPercent(m.scores.completion)}</td>
              <td class="cell-metric mono">\${formatPercent(m.scores.passK)}</td>
              \${consistencyCell}
              <td class="cell-metric mono">\${formatDuration(m.latency.p95Ms)}</td>
              <td class="cell-metric mono">\${formatCost(m.cost.perFullRun)}</td>
            </tr>
          \`;
        }
      }).join('');
    }

    // Sortable headers
    let currentSort = { key: 'rank', dir: 'asc' };
    function initSortableHeaders() {
      document.querySelectorAll('.sortable').forEach(header => {
        header.addEventListener('click', () => {
          const sortKey = header.dataset.sort;
          if (currentSort.key === sortKey) {
            currentSort.dir = currentSort.dir === 'asc' ? 'desc' : 'asc';
          } else {
            currentSort.key = sortKey;
            currentSort.dir = (sortKey === 'latency' || sortKey === 'cost' || sortKey === 'avgAttempts' || sortKey === 'toolFailure') ? 'asc' : 'desc';
          }
          document.querySelectorAll('.sortable').forEach(h => h.classList.remove('sort-asc', 'sort-desc'));
          header.classList.add(currentSort.dir === 'asc' ? 'sort-asc' : 'sort-desc');
          renderRankingTable(currentSort.key, currentSort.dir);
        });
      });
    }

    // Model details
    function renderModelDetails() {
      const container = document.getElementById('model-details');
      container.innerHTML = DATA.models.map((m, idx) => {
        const errors = m.errors || {};
        const totalErrors = Object.values(errors).reduce((sum, v) => sum + v, 0);
        // When weighted exists and is valid, show primary score (weighted)
        const primaryDetailScore = (m.scores.weighted != null) ? m.scores.weighted : (m.scores.overall ?? 0);
        const consistencyItem = showConsistency ? \`
                <div class="metric-item">
                  <div class="metric-label">Consistency</div>
                  <div class="metric-value">\${formatPercent(m.scores.consistency)}</div>
                </div>\` : '';
        const unweightedScoreItem = (m.scores.weighted != null) ? \`
                <div class="metric-item">
                  <div class="metric-label">Unweighted Score</div>
                  <div class="metric-value">\${m.scores.overall?.toFixed(1) ?? '—'}</div>
                </div>\` : '';

        return \`
          <div class="model-card" id="model-card-\${idx}">
            <div class="model-card-header" onclick="toggleModel(\${idx})">
              <div class="model-card-left">
                <span class="model-card-name">\${m.name}</span>
                <span class="model-card-provider">\${m.provider}</span>
                <span class="score-badge \${getScoreClass(primaryDetailScore)}">\${primaryDetailScore.toFixed(1)}</span>
              </div>
              <svg class="chevron" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>
              </svg>
            </div>
            <div class="model-card-content">
              <div class="metrics-grid">
                <div class="metric-item">
                  <div class="metric-label">Completion</div>
                  <div class="metric-value">\${formatPercent(m.scores.completion)}</div>
                </div>
                <div class="metric-item">
                  <div class="metric-label">Pass^k</div>
                  <div class="metric-value">\${formatPercent(m.scores.passK)}</div>
                </div>
                \${consistencyItem}
                <div class="metric-item">
                  <div class="metric-label">Efficiency</div>
                  <div class="metric-value">\${formatPercent(m.scores.efficiency)}</div>
                </div>
                \${unweightedScoreItem}
                <div class="metric-item">
                  <div class="metric-label">Mean Latency</div>
                  <div class="metric-value">\${formatDuration(m.latency.meanMs)}</div>
                </div>
                <div class="metric-item">
                  <div class="metric-label">P95 Latency</div>
                  <div class="metric-value">\${formatDuration(m.latency.p95Ms)}</div>
                </div>
                <div class="metric-item">
                  <div class="metric-label">Avg Cost</div>
                  <div class="metric-value">\${formatCost(m.cost.perFullRun)}</div>
                </div>
                <div class="metric-item">
                  <div class="metric-label">Cost/Success</div>
                  <div class="metric-value">\${m.cost.perSuccess ? formatCost(m.cost.perSuccess) : '—'}</div>
                </div>
              </div>
              \${totalErrors > 0 ? \`
                <div class="errors-panel">
                  <div class="errors-title">\${totalErrors} Error\${totalErrors > 1 ? 's' : ''}</div>
                  <div class="error-tags">
                    \${errors.timeout ? \`<span class="error-tag">timeout: \${errors.timeout}</span>\` : ''}
                    \${errors.runtime_error ? \`<span class="error-tag">runtime: \${errors.runtime_error}</span>\` : ''}
                    \${errors.validation_failure ? \`<span class="error-tag">validation: \${errors.validation_failure}</span>\` : ''}
                    \${errors.tool_error ? \`<span class="error-tag">tool: \${errors.tool_error}</span>\` : ''}
                    \${errors.unknown ? \`<span class="error-tag">unknown: \${errors.unknown}</span>\` : ''}
                  </div>
                  \${m.errorDetails && m.errorDetails.length > 0 ? \`
                    <div class="error-details-list">
                      \${m.errorDetails.map(e => \`
                        <div class="error-detail-item">
                          <span class="error-detail-scenario">\${e.scenario} #\${e.trial}</span>
                          <span class="error-detail-type">\${e.type}</span>
                          <span class="error-detail-message">\${e.message}</span>
                        </div>
                      \`).join('')}
                    </div>
                  \` : ''}
                </div>
              \` : ''}
            </div>
          </div>
        \`;
      }).join('');
    }

    function toggleModel(idx) {
      document.getElementById('model-card-' + idx).classList.toggle('expanded');
    }

    // Scenarios table
    function renderScenariosTable() {
      const thead = document.getElementById('scenarios-header');
      const tbody = document.getElementById('scenarios-body');
      const hasGoals = DATA.scenarios.some(s => Object.values(s.results).some(r => r.goals));

      const thBase = 'padding: 12px 16px; text-align: left; font-size: 11px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); border-bottom: 1px solid var(--border);';

      if (hasGoals) {
        thead.innerHTML = \`<tr>
          <th style="\${thBase}">Scenario</th>
          <th style="\${thBase}">Model</th>
          <th style="\${thBase} text-align: center;">Status</th>
          <th style="\${thBase} text-align: right;">Goals</th>
          <th style="\${thBase} text-align: right;">Tools/Goal</th>
          <th style="\${thBase} text-align: right;">Tool Failure</th>
          <th style="\${thBase} text-align: right;">Tool Efficiency</th>
          <th style="\${thBase} text-align: right;">Recovery</th>
          <th style="\${thBase} text-align: right;">Input Tokens</th>
          <th style="\${thBase} text-align: right;">Output Tokens</th>
          <th style="\${thBase} text-align: right;">Latency</th>
          <th style="\${thBase} text-align: right;">Avg Cost</th>
        </tr>\`;
      } else {
        thead.innerHTML = \`<tr>
          <th style="\${thBase}">Scenario</th>
          <th style="\${thBase}">Model</th>
          <th style="\${thBase} text-align: center;">Status</th>
          <th style="\${thBase} text-align: right;">Completion</th>
          <th style="\${thBase} text-align: right;">Pass^k</th>
          <th style="\${thBase} text-align: right;">Consistency</th>
          <th style="\${thBase} text-align: right;">Input Tokens</th>
          <th style="\${thBase} text-align: right;">Output Tokens</th>
          <th style="\${thBase} text-align: right;">Latency</th>
          <th style="\${thBase} text-align: right;">Avg Cost</th>
        </tr>\`;
      }

      const rows = [];
      for (const scenario of DATA.scenarios) {
        const diffClass = {
          easy: 'difficulty-easy',
          medium: 'difficulty-medium',
          hard: 'difficulty-hard'
        }[scenario.difficulty] || '';

        let isFirst = true;
        for (const model of DATA.models) {
          const result = scenario.results[model.id];
          if (!result) continue;

          const statusClass = result.completionRate === 1 ? 'status-pass' : result.completionRate > 0 ? 'status-partial' : 'status-fail';
          const statusText = result.completionRate === 1 ? 'pass' : result.completionRate > 0 ? 'partial' : 'fail';

          let metricCells = '';
          if (hasGoals && result.goals) {
            const failureRate = result.goals.toolCallFailureRate;
            const failureRateStr = (failureRate != null && !isNaN(failureRate)) ? formatPercent(failureRate) : '—';
            const efficiencyStr = (result.goals.toolCallEfficiency != null && !isNaN(result.goals.toolCallEfficiency)) ? formatPercent(result.goals.toolCallEfficiency) : '—';
            metricCells = \`
              <td class="cell-metric mono">\${result.goals.completed}/\${result.goals.total}</td>
              <td class="cell-metric mono">\${result.goals.avgAttempts.toFixed(1)}</td>
              <td class="cell-metric mono">\${failureRateStr}</td>
              <td class="cell-metric mono">\${efficiencyStr}</td>
              <td class="cell-metric mono">\${formatPercent(result.goals.recoveryRate)}</td>
              <td class="cell-metric mono">\${formatTokens(result.inputTokens)}</td>
              <td class="cell-metric mono">\${formatTokens(result.outputTokens)}</td>
            \`;
          } else if (hasGoals) {
            metricCells = \`<td class="cell-metric">—</td><td class="cell-metric">—</td><td class="cell-metric">—</td><td class="cell-metric">—</td><td class="cell-metric">—</td><td class="cell-metric">—</td><td class="cell-metric">—</td>\`;
          } else {
            metricCells = \`
              <td class="cell-metric mono">\${formatPercent(result.completionRate)}</td>
              <td class="cell-metric mono">\${formatPercent(result.passK)}</td>
              <td class="cell-metric mono">\${formatPercent(result.consistency)}</td>
              <td class="cell-metric mono">\${formatTokens(result.inputTokens)}</td>
              <td class="cell-metric mono">\${formatTokens(result.outputTokens)}</td>
            \`;
          }

          rows.push(\`
            <tr>
              \${isFirst ? \`
                <td rowspan="\${DATA.models.length}" style="vertical-align: top; padding: 14px 16px; border-bottom: 1px solid var(--border);">
                  <div class="model-name">\${scenario.name}</div>
                  \${scenario.difficulty ? \`<span class="difficulty \${diffClass}">\${scenario.difficulty}</span>\` : ''}
                </td>
              \` : ''}
              <td class="cell-model">
                <div class="model-name">\${model.name}</div>
                <div class="model-provider">\${model.provider}</div>
              </td>
              <td style="text-align: center;">
                <span class="status \${statusClass}">
                  <span class="status-dot"></span>
                  \${statusText}
                </span>
              </td>
              \${metricCells}
              <td class="cell-metric mono">\${formatDuration(result.latencyMs)}</td>
              <td class="cell-metric mono">\${formatCost(result.costUsd)}</td>
            </tr>
          \`);
          isFirst = false;
        }
      }
      tbody.innerHTML = rows.join('');
    }

    // Charts
    function initCharts() {
      const colors = ['#00d4aa', '#3b82f6', '#a855f7', '#f97316', '#ec4899', '#06b6d4'];

      Chart.defaults.color = '#6b6b6b';
      Chart.defaults.borderColor = '#2a2a2a';
      Chart.defaults.font.family = "'JetBrains Mono', monospace";

      new Chart(document.getElementById('scores-chart').getContext('2d'), {
        type: 'bar',
        data: {
          labels: DATA.models.map(m => m.name),
          datasets: [{
            label: 'Score',
            data: DATA.models.map(m => m.scores.overall),
            backgroundColor: DATA.models.map((_, i) => colors[i % colors.length]),
            borderRadius: 2,
            borderSkipped: false
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            y: { beginAtZero: true, max: 100, grid: { color: '#1a1a1a' } },
            x: { grid: { display: false } }
          }
        }
      });

      // Build radar chart labels and data based on whether consistency should be shown
      const radarLabels = showConsistency
        ? ['Completion', 'Pass^k', 'Consistency', 'Efficiency']
        : ['Completion', 'Pass^k', 'Efficiency'];

      new Chart(document.getElementById('radar-chart').getContext('2d'), {
        type: 'radar',
        data: {
          labels: radarLabels,
          datasets: DATA.models.map((m, i) => ({
            label: m.name,
            data: showConsistency
              ? [m.scores.completion * 100, m.scores.passK * 100, m.scores.consistency * 100, m.scores.efficiency * 100]
              : [m.scores.completion * 100, m.scores.passK * 100, m.scores.efficiency * 100],
            backgroundColor: colors[i % colors.length] + '20',
            borderColor: colors[i % colors.length],
            pointBackgroundColor: colors[i % colors.length],
            pointRadius: 3,
            borderWidth: 2
          }))
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, padding: 16 } } },
          scales: {
            r: {
              beginAtZero: true,
              max: 100,
              grid: { color: '#2a2a2a' },
              angleLines: { color: '#2a2a2a' },
              pointLabels: { color: '#a3a3a3', font: { size: 11 } }
            }
          }
        }
      });
    }

    // Initialize
    document.addEventListener('DOMContentLoaded', () => {
      renderRankingHeader();
      renderRankingTable();
      initSortableHeaders();
      renderModelDetails();
      renderScenariosTable();
      initCharts();
      document.querySelector('[data-sort="rank"]').classList.add('sort-asc');
    });
  </script>
</body>
</html>`;
}

/**
 * Escape HTML special characters
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Save HTML report to file
 */
export async function saveHtmlReport(
  result: SuiteResult,
  outputDir: string
): Promise<string> {
  await mkdir(outputDir, { recursive: true });

  const filename = `${result.suiteId}-${result.runId}.html`;
  const filepath = join(outputDir, filename);

  await writeFile(filepath, generateHtmlReport(result), 'utf-8');

  return filepath;
}
