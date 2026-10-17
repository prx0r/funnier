// The logged screening policy on each vote / pass / skip (signals.policy): which mode chose the pair and with what
// probability, so tally/train-screening.mjs can learn off-policy with inverse-propensity weights. Integers only (the
// AT Protocol lexicon has no floats). Shared by the client, the Worker (cleanSignals) and the tally.
//   m  mode: foryou | training | explore | shared | daily | rewatch
//   pm P(mode) x1000;  pp P(this pair | mode) x1e6 (Training picks; omitted when the mode picks by argmax + jitter)
//   f  the chosen pair's weight features x1000: [close*unc*seen, fresh*seen, struct_sim*seen]
//   z  the same features summed over the candidate set x1000 (so P(pair) can be recomputed under other weights)
//   q  the model's predicted P(left wins) x1000 at pick time (how informative the vote is)
//   v  the screening params version in force
//   fd the feed the round came from: trending | foryou | underdog | vibes | cat (src/feeds.js), so the trainer separates the arms
//   cat the category slug when fd = cat;  u the underdog clip id when fd = underdog ("underdog beat legend" moments)
//   sc the region scope in force (funnygraph region key or global)
export const POLICY_MODES = ['foryou', 'training', 'explore', 'shared', 'daily', 'rewatch', 'trending', 'underdog', 'vibes', 'category']
export const POLICY_FEEDS = ['trending', 'foryou', 'underdog', 'vibes', 'cat']
const int = (x, a, b) => { const n = Number(x); return Number.isFinite(n) ? Math.max(a, Math.min(b, Math.round(n))) : null }
export function cleanPolicy(p) {
  if (!p || typeof p !== 'object' || !POLICY_MODES.includes(p.m)) return null
  const o = { m: p.m }
  const pm = int(p.pm, 0, 1000); if (pm != null) o.pm = pm
  const pp = int(p.pp, 0, 1e6); if (pp != null) o.pp = pp
  const q = int(p.q, 0, 1000); if (q != null) o.q = q
  for (const k of ['f', 'z']) if (Array.isArray(p[k]) && p[k].length === 3) { const a = p[k].map((x) => int(x, 0, 1e8)); if (a.every((x) => x != null)) o[k] = a }
  if (POLICY_FEEDS.includes(p.fd)) o.fd = p.fd
  if (typeof p.cat === 'string' && /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(p.cat)) o.cat = p.cat
  if (typeof p.u === 'string' && /^[A-Za-z0-9_-]{6,20}$/.test(p.u)) o.u = p.u
  if (typeof p.sc === 'string' && /^[a-z][a-z-]{1,24}$/.test(p.sc)) o.sc = p.sc
  if (typeof p.v === 'string' && /^[a-z0-9.-]{1,40}$/i.test(p.v)) o.v = p.v
  return o
}
