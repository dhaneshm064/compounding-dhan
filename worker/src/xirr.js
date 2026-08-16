/**
 * XIRR via Newton-Raphson on NPV(rate) = 0.
 *
 * cashflows: [{ date: 'YYYY-MM-DD', amount: number }]
 * Convention: outflows (buys) are negative, inflows (sells, final valuation) are positive.
 * Returns the annualized rate as a fraction (0.18 = 18%), or null if it doesn't converge.
 */
export function xirr(cashflows, guess = 0.1) {
  if (!cashflows || cashflows.length < 2) return null;

  const t0 = new Date(cashflows[0].date).getTime();
  const years = cashflows.map((cf) => (new Date(cf.date).getTime() - t0) / (365 * 24 * 60 * 60 * 1000));

  const npv = (rate) => cashflows.reduce((sum, cf, i) => sum + cf.amount / Math.pow(1 + rate, years[i]), 0);
  const dnpv = (rate) =>
    cashflows.reduce((sum, cf, i) => sum - (years[i] * cf.amount) / Math.pow(1 + rate, years[i] + 1), 0);

  let rate = guess;
  for (let i = 0; i < 200; i++) {
    const f = npv(rate);
    const df = dnpv(rate);
    if (Math.abs(df) < 1e-10) return null;

    let next = rate - f / df;
    if (!Number.isFinite(next)) return null;
    // Newton-Raphson can momentarily overshoot past -100% (where (1+rate) flips
    // sign and NPV blows up) on its very first step — especially with same-day
    // cashflows, which flatten the derivative — while still converging toward a
    // valid negative rate. Clamp instead of bailing, so real losses still resolve.
    if (next <= -1) next = (rate - 1) / 2;

    if (Math.abs(next - rate) < 1e-9) return next;
    rate = next;
  }
  return null;
}
