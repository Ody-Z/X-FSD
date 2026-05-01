import { getAllReplyEvents } from '../lib/analytics-db.js';
import {
  getReplyTypeLabel,
  getTargetCategoryLabel,
  summarizeAnalytics
} from '../lib/analytics.js';

const elements = {
  rangeSelect: document.getElementById('rangeSelect'),
  statusLine: document.getElementById('statusLine'),
  todayReplies: document.getElementById('todayReplies'),
  totalImpressions: document.getElementById('totalImpressions'),
  totalProfileClicks: document.getElementById('totalProfileClicks'),
  profileIntent: document.getElementById('profileIntent'),
  totalRepliesLabel: document.getElementById('totalRepliesLabel'),
  pendingLabel: document.getElementById('pendingLabel'),
  dailyChart: document.getElementById('dailyChart'),
  replyTypeList: document.getElementById('replyTypeList'),
  targetCategoryList: document.getElementById('targetCategoryList'),
  recentRows: document.getElementById('recentRows')
};

let cachedEvents = [];
let autoSyncInFlight = false;

function formatNumber(value) {
  return new Intl.NumberFormat('en-US').format(value || 0);
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return '-';
  return `${(value * 100).toFixed(value < 0.01 ? 2 : 1)}%`;
}

function formatDate(timestamp) {
  if (!Number.isFinite(timestamp)) return '-';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(timestamp));
}

function shortDate(dayKey) {
  const [, month, day] = String(dayKey).split('-');
  return month && day ? `${month}/${day}` : dayKey;
}

function setStatus(message, type = '') {
  elements.statusLine.textContent = message;
  elements.statusLine.className = `status-line${type ? ` ${type}` : ''}`;
}

function emptyNode(text) {
  const node = document.createElement('div');
  node.className = 'empty';
  node.textContent = text;
  return node;
}

function renderDailyChart(summary) {
  elements.dailyChart.innerHTML = '';
  const maxReplies = Math.max(1, ...summary.daily.map((day) => day.replies));

  for (const day of summary.daily) {
    const row = document.createElement('div');
    row.className = 'day-bar';

    const track = document.createElement('div');
    track.className = 'bar-track';
    const fill = document.createElement('div');
    fill.className = 'bar-fill';
    fill.style.height = `${Math.max(2, (day.replies / maxReplies) * 100)}%`;
    track.appendChild(fill);

    const count = document.createElement('div');
    count.className = 'day-count';
    count.textContent = String(day.replies);

    const label = document.createElement('div');
    label.className = 'day-label';
    label.textContent = shortDate(day.key);

    row.append(track, count, label);
    elements.dailyChart.appendChild(row);
  }
}

function renderRankList(container, rows, options = {}) {
  container.innerHTML = '';
  if (rows.length === 0) {
    container.appendChild(emptyNode('No synced metrics yet.'));
    return;
  }

  const metric = options.metric || 'profileIntent';
  const max = Math.max(1, ...rows.map((row) => metric === 'profileIntent'
    ? (row.profileIntent || 0) * 100
    : row.impressions || 0));

  for (const row of rows.slice(0, 6)) {
    const item = document.createElement('div');
    item.className = 'rank-row';

    const name = document.createElement('div');
    name.className = 'rank-name';
    const label = document.createElement('span');
    label.textContent = row.label;
    const count = document.createElement('span');
    count.textContent = `${row.replies} replies`;
    name.append(label, count);

    const value = document.createElement('div');
    value.className = 'rank-value';
    value.textContent = metric === 'profileIntent' ? formatPercent(row.profileIntent) : formatNumber(row.impressions);

    const meter = document.createElement('div');
    meter.className = 'rank-meter';
    const meterFill = document.createElement('span');
    const rawValue = metric === 'profileIntent' ? (row.profileIntent || 0) * 100 : row.impressions || 0;
    meterFill.style.width = `${Math.max(3, Math.min(100, (rawValue / max) * 100))}%`;
    meter.appendChild(meterFill);

    item.append(name, value, meter);
    container.appendChild(item);
  }
}

function renderRecentRows(summary) {
  elements.recentRows.innerHTML = '';
  if (summary.recentReplies.length === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 7;
    cell.appendChild(emptyNode('No replies recorded yet. Send a reply from X to create the first analytics event.'));
    row.appendChild(cell);
    elements.recentRows.appendChild(row);
    return;
  }

  for (const event of summary.recentReplies.slice(0, 50)) {
    const metrics = event.metricsLatest || {};
    const row = document.createElement('tr');

    const sent = document.createElement('td');
    sent.textContent = formatDate(event.sentAt);

    const target = document.createElement('td');
    target.className = 'target-cell';
    const link = document.createElement('a');
    link.href = event.targetTweetUrl || event.replyTweetUrl || '#';
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = event.targetHandle || 'Target post';
    const text = document.createElement('div');
    text.className = 'target-text';
    text.textContent = event.targetText || event.replyText || '';
    target.append(link, text);

    const type = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = getReplyTypeLabel(event.replyType);
    type.appendChild(badge);

    const impressions = document.createElement('td');
    impressions.textContent = metrics.impressions === null || typeof metrics.impressions === 'undefined'
      ? '-'
      : formatNumber(metrics.impressions);

    const profileClicks = document.createElement('td');
    profileClicks.textContent = metrics.profileClicks === null || typeof metrics.profileClicks === 'undefined'
      ? '-'
      : formatNumber(metrics.profileClicks);

    const intent = document.createElement('td');
    intent.textContent = formatPercent(metrics.profileIntent);

    const status = document.createElement('td');
    status.className = 'metric-muted';
    if (!event.replyPostId) {
      status.textContent = 'Need reply id';
    } else if (!event.metricsLatest) {
      status.textContent = 'Pending';
    } else if (metrics.hasPrivateMetrics) {
      status.textContent = 'Synced';
    } else {
      status.textContent = 'Public only';
    }

    row.append(sent, target, type, impressions, profileClicks, intent, status);
    elements.recentRows.appendChild(row);
  }
}

function render() {
  const days = Number.parseInt(elements.rangeSelect.value, 10) || 14;
  const summary = summarizeAnalytics(cachedEvents, { days });

  elements.todayReplies.textContent = formatNumber(summary.todayReplies);
  elements.totalImpressions.textContent = formatNumber(summary.totalImpressions);
  elements.totalProfileClicks.textContent = formatNumber(summary.totalProfileClicks);
  elements.profileIntent.textContent = formatPercent(summary.profileIntent);
  elements.totalRepliesLabel.textContent = `${formatNumber(summary.totalReplies)} replies`;
  elements.pendingLabel.textContent = `${formatNumber(summary.pendingMetrics)} pending metrics`;

  renderDailyChart(summary);
  renderRankList(elements.replyTypeList, summary.byReplyType, { metric: 'profileIntent' });
  renderRankList(
    elements.targetCategoryList,
    summary.byTargetCategory.map((row) => ({
      ...row,
      label: getTargetCategoryLabel(row.key)
    })),
    { metric: 'impressions' }
  );
  renderRecentRows(summary);

  if (cachedEvents.length === 0) {
    setStatus('No local analytics events yet.');
  } else if (summary.unresolvedReplyIds > 0) {
    setStatus(`${summary.unresolvedReplyIds} replies need an X API sync to resolve their reply IDs.`);
  } else {
    setStatus(`Loaded ${formatNumber(cachedEvents.length)} local reply events.`, 'success');
  }
}

async function loadEvents() {
  cachedEvents = await getAllReplyEvents();
  render();
}

function describeSyncResponse(response) {
  if (response?.authRequired) return response.reason || 'Connect X in the popup Analytics tab to sync metrics.';
  const privateNote = response?.privateMetricsAvailable === false
    ? ' Public metrics only; profile clicks require user-context metrics access.'
    : '';
  const resolved = response?.resolvedReplyIds ? ` Resolved ${response.resolvedReplyIds} reply IDs.` : '';
  return `Metrics updated.${resolved}${privateNote}`;
}

async function syncMetrics({ force = false, quiet = false } = {}) {
  if (autoSyncInFlight) return;
  autoSyncInFlight = true;
  if (!quiet) setStatus('Updating metrics from X API.');
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'SYNC_ANALYTICS_METRICS',
      options: { force, limit: 100 }
    });
    if (!response?.ok) {
      setStatus(describeSyncResponse(response), response?.authRequired ? 'error' : '');
      return;
    }
    await loadEvents();
    if (!quiet || response.synced || response.resolvedReplyIds) {
      setStatus(describeSyncResponse(response), 'success');
    }
  } catch (error) {
    setStatus(error.message || 'Metric sync failed.', 'error');
  } finally {
    autoSyncInFlight = false;
  }
}

elements.rangeSelect.addEventListener('change', render);

loadEvents()
  .then(() => syncMetrics({ force: false, quiet: true }))
  .catch((error) => {
    setStatus(error.message, 'error');
  });

setInterval(() => {
  void syncMetrics({ force: false, quiet: true });
}, 5 * 60 * 1000);
