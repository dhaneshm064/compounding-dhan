/**
 * The 3-criteria "buy (and hold) at all-time high" signal — adapted from a
 * momentum-investing framework for this tool's existing tracked holdings.
 * Checked on demand via the stock page's Analyze button, not cached, since
 * it's an infrequent manual check rather than something rendered on every
 * page load.
 *
 * The three checks:
 *  1. Price touched its all-time high (within the ~3 years of history this tool
 *     has stored — not a literal lifetime high) sometime in the trailing month.
 *     A stock merely sitting near an old high from long ago doesn't count —
 *     the high itself has to have been set recently, i.e. a fresh move.
 *  2. Profit is "at a recent high" — best-available proxy computed in
 *     fundamentals.js (Yahoo's free API only returns 4 quarters, so this checks
 *     whether the most recent quarter is the highest of those 4, not a genuine
 *     all-time record).
 *  3. Outperforming both Nifty 500 and the stock's sector index (where a sector
 *     index mapping exists — see SECTOR_INDEX_TICKERS in prices.js) over the
 *     trailing 1 year.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

// Finds the highest close across all of `rows` (our full stored window, ~3
// years), then checks whether that high was actually touched within the
// trailing `days` (default 30 — "this month"). A stock sitting near an old
// high from 6 months ago does NOT count as met: the high itself has to be a
// recent event, not just a level the price happens to still be close to.
export function computeAllTimeHighSignal(rows, days = 30) {
  if (!rows.length) return { hitWithinWindow: false, daysSinceHigh: null, observedHigh: null, pctOffHigh: null };

  let highRow = rows[0];
  for (const r of rows) {
    if (r.close > highRow.close) highRow = r;
  }
  const latest = rows[rows.length - 1];
  const pctOffHigh = highRow.close === 0 ? null : round2(((latest.close - highRow.close) / highRow.close) * 100);
  const daysSinceHigh = Math.round((new Date(latest.price_date).getTime() - new Date(highRow.price_date).getTime()) / DAY_MS);
  const hitWithinWindow = daysSinceHigh <= days;

  return { hitWithinWindow, daysSinceHigh, observedHigh: round2(highRow.close), pctOffHigh };
}

// Return over the trailing `days`: latest close vs. whichever stored close sits
// closest to that many days before it. Returns null if the closest match is more
// than a third of the window away — not enough history for a fair comparison.
export function computeReturnOverDays(rows, days) {
  if (rows.length < 2) return null;
  const latest = rows[rows.length - 1];
  const targetTime = new Date(latest.price_date).getTime() - days * DAY_MS;
  const tolerance = Math.max(days / 3, 5) * DAY_MS;

  let closest = rows[0];
  let closestDiff = Infinity;
  for (const r of rows) {
    const diff = Math.abs(new Date(r.price_date).getTime() - targetTime);
    if (diff < closestDiff) {
      closestDiff = diff;
      closest = r;
    }
  }
  if (closestDiff > tolerance || closest.close === 0) return null;

  return round2(((latest.close - closest.close) / closest.close) * 100);
}

// Generalizes the video's "3/3 hold & add, 2/3 hold, ≤1/3 exit & replace" rule
// to however many of the 3 checks are actually applicable for a given stock
// (some holdings have no sector-index mapping, see prices.js). Labels are
// deliberately measured rather than commands — this is a signal to think about,
// not an instruction to act on.
export function verdictFor(metCount, applicableCount) {
  if (applicableCount === 0) return 'Insufficient data';
  if (metCount === applicableCount) return 'Hold & add';
  if (metCount === applicableCount - 1 && applicableCount >= 2) return 'Hold';
  return 'Worth a review';
}

function round2(n) {
  return n == null ? null : Math.round(n * 100) / 100;
}
