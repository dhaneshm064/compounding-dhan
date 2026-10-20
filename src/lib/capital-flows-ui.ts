import { CLIENT_TYPES, clientKey, clientType, clientBucket, stockFile, decodeDeal } from './capital-flows.js';

export const escapeHtml = (value: unknown) =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] || char));
export const pct = (value: number | null | undefined) => value == null ? '-' : `${value >= 0 ? '+' : ''}${Number(value).toFixed(2)}%`;
export const date = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '-';
export const crore = (value: number | null | undefined, digits = 1) => value == null ? '-' : `₹${(Number(value) / 10000000).toFixed(digits)} Cr`;
export const qty = (value: number | null | undefined) => value == null ? '-' : Number(value).toLocaleString('en-IN');
export const price = (value: number | null | undefined) => value == null ? '-' : `₹${Number(value).toFixed(2)}`;

export const clientHref = (name: string) => `/capital-flows/client/?${new URLSearchParams({ name })}`;
export const stockHref = (symbol: string) => `/capital-flows/stock/?${new URLSearchParams({ symbol })}`;
export const clientLink = (name: string, label = name) => `<a class="entity-link" href="${clientHref(name)}">${escapeHtml(label)}</a>`;
export const stockLink = (symbol: string) =>
  `<a class="entity-link" href="${stockHref(symbol)}"><strong>${escapeHtml(symbol)}</strong></a><a class="ext-link" href="https://www.screener.in/company/${encodeURIComponent(symbol)}/" target="_blank" rel="noopener noreferrer" title="Open on Screener">↗</a>`;

export type ClientMeta = { aliases: Record<string, string[]>; prop: Set<string> };

let metaPromise: Promise<ClientMeta> | null = null;
/** Spelling variants and prop/HFT desks, rebuilt nightly with the leaderboard. */
export function loadClientMeta(): Promise<ClientMeta> {
  metaPromise ||= fetch('/data/client-meta.json')
    .then((r) => r.ok ? r.json() : { aliases: {}, prop: [] })
    .catch(() => ({ aliases: {}, prop: [] }))
    .then((m) => ({ aliases: m.aliases || {}, prop: new Set<string>(m.prop || []) }));
  return metaPromise;
}

export const typeOf = (name: string, meta: ClientMeta) => clientType(name, meta.prop) as keyof typeof CLIENT_TYPES;
export const typeBadge = (type: string) => `<span class="type-badge type-${escapeHtml(type)}">${escapeHtml((CLIENT_TYPES as Record<string, string>)[type] || type)}</span>`;
/** The most common spelling and every variant, for any spelling of a client. */
export function resolveClient(name: string, meta: ClientMeta) {
  const variants = meta.aliases[clientKey(name)];
  return { display: variants?.[0] || name, variants: variants || [name] };
}

// ---------- Static dataset (public/data/flows, rebuilt nightly; no API calls) ----------

export type Deal = { id?: number; type: string; exchange: string; date: string; symbol: string; clientName: string; side: string; quantity: number; price: number; value: number };
export type FlowsIndex = { maxId: number; deals: number; coverage: Record<string, Record<string, string>>; days: [string, number][] };

const json = async (path: string) => {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
};
const byDate = (list: Deal[]) => list.sort((a, b) => a.date.localeCompare(b.date));
const deal = (code: string, date: string, symbol: string, clientName: string, quantity: number, price: number, id?: number): Deal =>
  ({ id, ...decodeDeal(code), date, symbol, clientName, quantity, price, value: Math.round(quantity * price * 100) / 100 });

let indexPromise: Promise<FlowsIndex> | null = null;
export const loadFlowsIndex = () => (indexPromise ||= json('/data/flows/index.json'));

export async function loadDay(date: string): Promise<Deal[]> {
  const day = await json(`/data/flows/days/${date}.json`);
  return day.rows.map(([id, code, symbol, n, qty, p]: any[]) => deal(code, day.date, symbol, day.names[n], qty, p, id));
}

/** Every deal in one stock, or null when the stock has no disclosures. */
export async function loadStock(symbol: string): Promise<{ name: string | null; trades: Deal[] } | null> {
  const stock = await json(`/data/flows/stocks/${stockFile(symbol)}.json`).catch(() => null);
  if (!stock?.rows) return null;
  return { name: stock.name, trades: byDate(stock.rows.map(([code, date, n, qty, p]: any[]) => deal(code, date, stock.symbol, stock.names[n], qty, p))) };
}

/** Every deal of one client across all spellings, or [] when unknown. */
export async function loadClient(name: string): Promise<Deal[]> {
  const bucket = await json(`/data/flows/clients/${clientBucket(name)}.json`).catch(() => ({}));
  const entry = bucket[clientKey(name)];
  if (!entry) return [];
  return byDate(entry.rows.map(([code, date, symbol, n, qty, p]: any[]) => deal(code, date, symbol, entry.names[n], qty, p)));
}

/** Monthly buy and sell value bars for the last `months` months with activity. */
export function monthlyBars(trades: any[], months = 24) {
  const byMonth = new Map<string, { buy: number; sell: number }>();
  for (const t of trades) {
    const month = String(t.date).slice(0, 7);
    const entry = byMonth.get(month) || { buy: 0, sell: 0 };
    entry[t.side === 'BUY' ? 'buy' : 'sell'] += Number(t.value) || Number(t.quantity) * Number(t.price) || 0;
    byMonth.set(month, entry);
  }
  const keys = [...byMonth.keys()].sort();
  if (!keys.length) return '<p class="empty">No activity to chart.</p>';
  const [y, m] = keys[keys.length - 1].split('-').map(Number);
  const series = Array.from({ length: months }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 - (months - 1 - i), 1));
    return d.toISOString().slice(0, 7);
  });
  const max = Math.max(...series.map((k) => Math.max(byMonth.get(k)?.buy || 0, byMonth.get(k)?.sell || 0)), 1);
  const cols = series.map((k) => {
    const e = byMonth.get(k) || { buy: 0, sell: 0 };
    const title = `${k}: bought ${crore(e.buy)}, sold ${crore(e.sell)}`;
    return `<div class="bar-col" title="${escapeHtml(title)}"><div class="bar buy" style="height:${(e.buy / max) * 50}%"></div><div class="bar sell" style="height:${(e.sell / max) * 50}%"></div></div>`;
  }).join('');
  const axis = series.map((k, i) => `<span>${i % 3 === 0 ? escapeHtml(new Date(`${k}-01`).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' })) : ''}</span>`).join('');
  return `<div class="bars">${cols}</div><div class="bar-axis">${axis}</div><div class="legend"><span><i style="background:var(--leaf)"></i>Bought</span><span><i style="background:#e08a8a"></i>Sold</span><span>Last ${months} months · value by month</span></div>`;
}

/** Sortable table helper: returns header HTML and sorts rows by the active column. */
export function sortableTable<T>(columns: [key: string, label: string, numeric?: boolean][], state: { key: string; dir: 'asc' | 'desc' }, attr: string) {
  const header = columns.map(([key, label, numeric]) => {
    const active = state.key === key;
    const arrow = active ? (state.dir === 'asc' ? '↑' : '↓') : '↕';
    return `<th class="${numeric ? 'number' : ''}" aria-sort="${active ? (state.dir === 'asc' ? 'ascending' : 'descending') : 'none'}"><button class="deal-sort ${numeric ? 'number' : ''}" type="button" data-${attr}="${key}" aria-pressed="${active}">${label}<span class="sort-arrow" aria-hidden="true">${arrow}</span></button></th>`;
  }).join('');
  const sort = (rows: T[], valueFor: (row: T, key: string) => unknown) => [...rows].sort((a, b) => {
    const left = valueFor(a, state.key), right = valueFor(b, state.key);
    if (left == null && right == null) return 0;
    if (left == null) return 1;
    if (right == null) return -1;
    const c = typeof left === 'number' || typeof right === 'number'
      ? Number(left) - Number(right)
      : String(left).localeCompare(String(right), 'en', { numeric: true, sensitivity: 'base' });
    return state.dir === 'asc' ? c : -c;
  });
  return { header, sort };
}

/** Toggles a sort state when one of the table's header buttons is clicked. */
export function handleSortClick(event: Event, attr: string, state: { key: string; dir: 'asc' | 'desc' }) {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>(`[data-${attr}]`);
  const key = button?.dataset[attr.replace(/-([a-z])/g, (_, c) => c.toUpperCase())];
  if (!key) return false;
  state.dir = state.key === key && state.dir === 'desc' ? 'asc' : 'desc';
  state.key = key;
  return true;
}

export function pager(total: number, page: number, size: number, attr: string) {
  const pages = Math.max(1, Math.ceil(total / size));
  return pages <= 1 ? '' : `<button type="button" data-${attr}="${page - 1}" ${page === 1 ? 'disabled' : ''}>Previous</button><span class="flow-meta">Page ${page} of ${pages}</span><button type="button" data-${attr}="${page + 1}" ${page === pages ? 'disabled' : ''}>Next</button>`;
}
