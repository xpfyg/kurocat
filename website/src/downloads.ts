const STATS_URL =
  'https://raw.githubusercontent.com/xpfyg/minicat/main/website/data/download-stats.json';
const CACHE_KEY = 'minicat.download-stats.v2';
const CACHE_TTL = 30 * 60 * 1000;
const SVG_NS = 'http://www.w3.org/2000/svg';

interface Snapshot {
  date: string;
  total: number;
}

interface ReleaseStat {
  tag: string;
  date: string;
  downloads: number;
}

interface StatsFile {
  updated_at: string;
  total: number;
  win: number;
  mac: number;
  linux: number;
  releases: ReleaseStat[];
  history: Snapshot[];
}

interface ChartPoint {
  label: string;
  date: string;
  total: number;
}

function readCache(): StatsFile | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw) as StatsFile & { ts?: number };
    if (!cached || typeof cached.total !== 'number' || !Array.isArray(cached.releases)) return null;
    if (Date.now() - (cached.ts || 0) > CACHE_TTL) return null;
    return cached;
  } catch {
    return null;
  }
}

function writeCache(stats: StatsFile): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ...stats, ts: Date.now() }));
  } catch {
    // 隐私模式下 localStorage 不可写，忽略即可。
  }
}

function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

function formatCompact(value: number): string {
  if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`;
  return String(value);
}

function animateTotal(el: HTMLElement, target: number): void {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduceMotion || target <= 0) {
    el.textContent = formatCount(target);
    return;
  }
  const duration = 900;
  const start = performance.now();
  const tick = (now: number) => {
    const progress = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    el.textContent = formatCount(Math.round(target * eased));
    if (progress < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

function releasePoints(releases: ReleaseStat[]): ChartPoint[] {
  const sorted = releases
    .filter((release) => release.downloads > 0)
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  let running = 0;
  return sorted.map((release) => {
    running += release.downloads;
    return { label: release.tag, date: release.date, total: running };
  });
}

function historyPoints(history: Snapshot[]): ChartPoint[] {
  return history
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((entry) => ({ label: entry.date.slice(5), date: entry.date, total: entry.total }));
}

function renderChart(svg: SVGSVGElement, points: ChartPoint[]): boolean {
  svg.replaceChildren();
  if (points.length < 2) {
    svg.style.display = 'none';
    return false;
  }
  svg.style.display = '';

  const width = 640;
  const height = 190;
  const pad = { left: 46, right: 14, top: 14, bottom: 30 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const max = Math.max(points[points.length - 1].total, 1);

  const xAt = (index: number) => pad.left + (plotW * index) / (points.length - 1);
  const yAt = (value: number) => pad.top + plotH - (plotH * value) / max;

  for (let i = 0; i <= 3; i += 1) {
    const value = (max * i) / 3;
    const y = yAt(value);
    svg.appendChild(
      svgEl('line', {
        x1: pad.left,
        x2: width - pad.right,
        y1: y,
        y2: y,
        stroke: 'rgba(23, 19, 15, 0.14)',
        'stroke-width': 1,
        'stroke-dasharray': i === 0 ? '0' : '3 4',
      }),
    );
    const label = svgEl('text', {
      x: pad.left - 8,
      y: y + 3,
      'text-anchor': 'end',
      class: 'dl-chart-axis',
    });
    label.textContent = formatCompact(Math.round(value));
    svg.appendChild(label);
  }

  const linePoints = points.map((point, index) => `${xAt(index)},${yAt(point.total)}`);
  const areaPath = `M ${pad.left},${pad.top + plotH} L ${linePoints.join(' L ')} L ${xAt(points.length - 1)},${pad.top + plotH} Z`;
  svg.appendChild(svgEl('path', { d: areaPath, fill: 'rgba(36, 92, 76, 0.12)', stroke: 'none' }));
  svg.appendChild(
    svgEl('polyline', {
      points: linePoints.join(' '),
      fill: 'none',
      stroke: '#e2402b',
      'stroke-width': 2,
      'stroke-linejoin': 'round',
      'stroke-linecap': 'round',
    }),
  );

  points.forEach((point, index) => {
    const isLast = index === points.length - 1;
    svg.appendChild(
      svgEl('circle', {
        cx: xAt(index),
        cy: yAt(point.total),
        r: isLast ? 4.5 : 2.4,
        fill: isLast ? '#e2402b' : '#faf4e7',
        stroke: '#17130f',
        'stroke-width': isLast ? 1.5 : 1,
      }),
    );
  });

  const labelIndexes = Array.from(
    new Set([0, Math.floor((points.length - 1) / 2), points.length - 1]),
  );
  for (const index of labelIndexes) {
    const point = points[index];
    const label = svgEl('text', {
      x: xAt(index),
      y: height - 10,
      'text-anchor': index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle',
      class: 'dl-chart-axis',
    });
    label.textContent = point.label;
    svg.appendChild(label);
  }
  return true;
}

function render(stats: StatsFile): void {
  const card = document.getElementById('dl-stats');
  const totalEl = document.getElementById('dl-total');
  const splitEl = document.getElementById('dl-split');
  const chart = document.getElementById('dl-chart');
  const metaEl = document.getElementById('dl-stats-meta');
  if (!card || !totalEl || !splitEl || !(chart instanceof SVGSVGElement)) return;

  animateTotal(totalEl, stats.total);

  const rows: Array<[string, number]> = [
    ['Windows', stats.win],
    ['macOS', stats.mac],
    ['Linux', stats.linux],
  ];
  splitEl.replaceChildren(
    ...rows.map(([label, value]) => {
      const item = document.createElement('div');
      item.className = 'dl-split-item';
      const name = document.createElement('span');
      name.className = 'dl-split-name';
      name.textContent = label;
      const count = document.createElement('span');
      count.className = 'dl-split-count';
      count.textContent = formatCount(value);
      item.append(name, count);
      return item;
    }),
  );

  const daily = historyPoints(stats.history || []);
  const useDaily = daily.length >= 2;
  const points = useDaily ? daily : releasePoints(stats.releases || []);
  const drawn = renderChart(chart, points);

  if (metaEl) {
    if (useDaily) metaEl.textContent = `按天累计 · 每日自动快照 · 更新于 ${stats.updated_at.slice(0, 10)}`;
    else if (drawn) metaEl.textContent = '按发布版本累计 · 每日快照积累 2 天后切换为按天曲线';
    else metaEl.textContent = '每日自动快照中 · 积累 2 天后展示增长曲线';
  }

  chart.setAttribute('aria-label', `累计下载增长曲线，共 ${stats.total} 次下载`);
  card.hidden = false;
  card.classList.add('is-ready');
}

async function fetchStats(): Promise<StatsFile | null> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(STATS_URL, { signal: controller.signal });
    if (!res.ok) return null;
    const data = (await res.json()) as StatsFile;
    if (!data || typeof data.total !== 'number' || !Array.isArray(data.releases)) return null;
    writeCache(data);
    return data;
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

async function initDownloadStats(): Promise<void> {
  if (!document.getElementById('dl-stats')) return;
  const cached = readCache();
  if (cached) {
    render(cached);
    return;
  }
  const stats = await fetchStats();
  if (stats) render(stats);
}

export { initDownloadStats };
