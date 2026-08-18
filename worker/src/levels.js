/**
 * Technical "levels to observe" for a single stock, computed purely from daily
 * close price history. All price-derived — fine to expose publicly (see the
 * amount-vs-price distinction documented in portfolio.js).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export function computeLevels(priceRows, currentPrice) {
  const rows = [...priceRows].sort((a, b) => a.price_date.localeCompare(b.price_date));
  if (rows.length === 0) return { week52High: null, week52Low: null, dma50: null, dma200: null, support: [], resistance: [] };

  const latestDate = new Date(rows[rows.length - 1].price_date).getTime();
  const week52Rows = rows.filter((r) => latestDate - new Date(r.price_date).getTime() <= 365 * DAY_MS);

  const week52High = week52Rows.length ? round2(Math.max(...week52Rows.map((r) => r.close))) : null;
  const week52Low = week52Rows.length ? round2(Math.min(...week52Rows.map((r) => r.close))) : null;

  const dma50 = dmaOf(rows, 50);
  const dma200 = dmaOf(rows, 200);
  const dma50Series = dmaSeries(rows, 50);
  const dma200Series = dmaSeries(rows, 200);

  const { support, resistance } = volumeProfileLevels(rows, currentPrice, week52High, week52Low);
  const crossover = goldenCross(rows);
  const recentBreak = computeRecentBreak(rows, currentPrice);

  return { week52High, week52Low, dma50, dma200, dma50Series, dma200Series, support, resistance, crossover, recentBreak };
}

function dmaOf(rows, n) {
  if (rows.length < n) return null;
  const slice = rows.slice(-n);
  return round2(slice.reduce((sum, r) => sum + r.close, 0) / n);
}

// Full rolling DMA history (not just the latest value) so the chart can plot it
// as a line alongside the candles, e.g. to see a golden/death cross visually
// instead of a one-line text badge.
function dmaSeries(rows, n) {
  if (rows.length < n) return [];
  const out = [];
  let sum = rows.slice(0, n).reduce((s, r) => s + r.close, 0);
  out.push({ time: rows[n - 1].price_date, value: round2(sum / n) });
  for (let i = n; i < rows.length; i++) {
    sum += rows[i].close - rows[i - n].close;
    out.push({ time: rows[i].price_date, value: round2(sum / n) });
  }
  return out;
}

/**
 * Golden cross (50-day DMA above the 200-day, bullish) vs death cross (below,
 * bearish) — not just today's state, but when the two lines actually crossed.
 * Rolls both DMAs forward day-by-day over the last ~2 years and finds the most
 * recent sign change in (dma50 - dma200); a crossover older than that window
 * still yields the current state, just without a specific date attached.
 */
function goldenCross(rows) {
  if (rows.length < 200) return { state: null, crossoverDate: null, daysSinceCrossover: null };

  const lookback = rows.slice(-500); // ~2 years of daily bars to search for a recent cross in
  const diffs = [];
  for (let i = 200; i <= lookback.length; i++) {
    const dma200 = lookback.slice(i - 200, i).reduce((s, r) => s + r.close, 0) / 200;
    const dma50 = lookback.slice(i - 50, i).reduce((s, r) => s + r.close, 0) / 50;
    diffs.push({ date: lookback[i - 1].price_date, diff: dma50 - dma200 });
  }
  if (diffs.length === 0) return { state: null, crossoverDate: null, daysSinceCrossover: null };

  const latest = diffs[diffs.length - 1];
  const state = latest.diff > 0 ? 'golden' : latest.diff < 0 ? 'death' : null;

  let crossoverDate = null;
  for (let i = diffs.length - 1; i > 0; i--) {
    const prevSign = Math.sign(diffs[i - 1].diff);
    const currSign = Math.sign(diffs[i].diff);
    if (prevSign !== 0 && currSign !== 0 && prevSign !== currSign) {
      crossoverDate = diffs[i].date;
      break;
    }
  }

  const daysSinceCrossover = crossoverDate
    ? Math.round((new Date(latest.date).getTime() - new Date(crossoverDate).getTime()) / DAY_MS)
    : null;

  return { state, crossoverDate, daysSinceCrossover };
}

/**
 * Support/resistance via a volume profile: bin the traded price range and weight
 * each bin by how much volume traded there, instead of naive local peak/trough
 * detection. A price level lots of shares actually changed hands at is a much
 * more meaningful support/resistance zone than a bar that merely happened to be
 * a local high — that's the "weighted by volume" upgrade over the old fractal method.
 *
 * Each day's volume is spread evenly across the bins its [low, high] range
 * touches (a standard simplification — real intraday volume distribution isn't
 * known from daily bars, so this treats trading as uniform across the day's range).
 * Only bins that are local peaks in volume AND above a minimum significance
 * threshold count as candidate levels — that filters out noise bins so nearly-empty
 * ones don't get returned as "resistance" just for being technically a local max.
 *
 * Volume is recency-weighted with a ~90-day half-life exponential decay. Without
 * this, a stock that's rallied hard (e.g. 3x in 2 years) ends up with "support"
 * levels clustered way back at its old, much-lower price range — technically the
 * highest-volume zone historically, but not a meaningful level relative to where
 * the stock trades today. Recent trading activity should dominate the profile.
 */
function volumeProfileLevels(rows, currentPrice, week52High, week52Low, binCount = 40) {
  const withVolume = rows.filter((r) => r.high != null && r.low != null && r.volume != null && r.volume > 0);
  const candidates = [];

  if (currentPrice != null && withVolume.length >= 20) {
    const recent = withVolume.slice(-500); // ~2 years — richer than a single year now that 3y is stored
    const minPrice = Math.min(...recent.map((r) => r.low));
    const maxPrice = Math.max(...recent.map((r) => r.high));

    if (maxPrice > minPrice) {
      const binSize = (maxPrice - minPrice) / binCount;
      const bins = new Array(binCount).fill(0);
      const latestTime = new Date(recent[recent.length - 1].price_date).getTime();
      const halfLifeDecay = Math.pow(0.5, 1 / 90); // per day; volume from 90 days ago counts half as much

      for (const r of recent) {
        const daysAgo = (latestTime - new Date(r.price_date).getTime()) / DAY_MS;
        const weightedVolume = r.volume * Math.pow(halfLifeDecay, daysAgo);
        const startBin = Math.min(binCount - 1, Math.floor((r.low - minPrice) / binSize));
        const endBin = Math.min(binCount - 1, Math.floor((r.high - minPrice) / binSize));
        const spanBins = endBin - startBin + 1;
        const volumePerBin = weightedVolume / spanBins;
        for (let b = startBin; b <= endBin; b++) bins[b] += volumePerBin;
      }

      const maxBinVolume = Math.max(...bins);
      const threshold = maxBinVolume * 0.25; // only "meaningfully traded" zones count

      for (let i = 0; i < binCount; i++) {
        const prevVol = i > 0 ? bins[i - 1] : -Infinity;
        const nextVol = i < binCount - 1 ? bins[i + 1] : -Infinity;
        if (bins[i] >= prevVol && bins[i] >= nextVol && bins[i] >= threshold) {
          candidates.push(minPrice + (i + 0.5) * binSize);
        }
      }
    }
  }

  // Always-known reference levels, regardless of whether the volume profile found anything.
  if (week52High != null) candidates.push(week52High);
  if (week52Low != null) candidates.push(week52Low);

  const support = currentPrice == null
    ? []
    : [...new Set(candidates.filter((p) => p < currentPrice))].sort((a, b) => b - a).slice(0, 3).map(round2);
  const resistance = currentPrice == null
    ? []
    : [...new Set(candidates.filter((p) => p > currentPrice))].sort((a, b) => a - b).slice(0, 3).map(round2);

  return { support, resistance };
}

const RECENT_BREAK_LOOKBACK_DAYS = 10;
// The level has to have actually held for this many trading days right before
// the lookback window — otherwise a steadily trending stock trivially "breaks"
// whatever level happened to be nearest a few days ago, every single day,
// since that reference price is always close behind wherever price has
// drifted to since. Requiring the level to have been respected first is what
// separates a real breakout from routine drift.
const RECENT_BREAK_ESTABLISH_DAYS = 20;

/**
 * Did the price break through a level that genuinely acted as support or
 * resistance — held for RECENT_BREAK_ESTABLISH_DAYS right before the lookback
 * window — at any point during that window, not just where price happens to
 * sit today? A stock that fell through support and has since partly recovered
 * still broke it; checking only today's close would miss that. Recomputes the
 * volume-profile levels as they stood `lookbackDays` ago (using only data up
 * to that point, and that day's own close as the reference price — matching
 * how support/resistance are always computed relative to "current" price),
 * confirms the establish period actually respected the nearest one, then
 * scans every close since for the most recent crossing: bearish (↓) through
 * support, bullish (↑) through resistance. `stillBroken` says whether today's
 * close is still on the far side of that level, or has recovered back across
 * it. Needs enough history for volumeProfileLevels' own 20-row minimum plus
 * the establish period to mean something — short of that, no signal at all.
 */
function computeRecentBreak(rows, currentPrice, lookbackDays = RECENT_BREAK_LOOKBACK_DAYS) {
  const establishDays = RECENT_BREAK_ESTABLISH_DAYS;
  if (currentPrice == null || rows.length <= lookbackDays + establishDays + 40) {
    return { broke: null, level: null, stillBroken: false, daysAgo: null };
  }

  const priorRows = rows.slice(0, rows.length - lookbackDays);
  const windowRows = rows.slice(rows.length - lookbackDays);
  const establishRows = priorRows.slice(-establishDays);
  const priorPrice = priorRows[priorRows.length - 1].close;
  const priorLatestDate = new Date(priorRows[priorRows.length - 1].price_date).getTime();
  const prior52wRows = priorRows.filter((r) => priorLatestDate - new Date(r.price_date).getTime() <= 365 * DAY_MS);
  const prior52wHigh = prior52wRows.length ? round2(Math.max(...prior52wRows.map((r) => r.close))) : null;
  const prior52wLow = prior52wRows.length ? round2(Math.min(...prior52wRows.map((r) => r.close))) : null;

  const { support: priorSupport, resistance: priorResistance } = volumeProfileLevels(
    priorRows,
    priorPrice,
    prior52wHigh,
    prior52wLow
  );

  const nearestSupport = priorSupport[0] ?? null;
  const nearestResistance = priorResistance[0] ?? null;
  const supportHeld = nearestSupport != null && establishRows.every((r) => r.close >= nearestSupport);
  const resistanceHeld = nearestResistance != null && establishRows.every((r) => r.close <= nearestResistance);
  const latestIdx = windowRows.length - 1;

  if (supportHeld) {
    for (let i = latestIdx; i >= 0; i--) {
      if (windowRows[i].close < nearestSupport) {
        return { broke: 'support', level: nearestSupport, stillBroken: currentPrice < nearestSupport, daysAgo: latestIdx - i };
      }
    }
  }
  if (resistanceHeld) {
    for (let i = latestIdx; i >= 0; i--) {
      if (windowRows[i].close > nearestResistance) {
        return { broke: 'resistance', level: nearestResistance, stillBroken: currentPrice > nearestResistance, daysAgo: latestIdx - i };
      }
    }
  }
  return { broke: null, level: null, stillBroken: false, daysAgo: null };
}

function round2(n) {
  return n == null ? null : Math.round(n * 100) / 100;
}
