// Offline trainer for the screening program (src/screening.js). GATED: it only ever writes apply: true when there are
// >= 500 logged sessions with a known policy AND the learned parameters beat the current ones on held-out data
// (self-normalised IPS, the last 30% of sessions by time). Until then it writes a dry-run report and the defaults.
//
// A session = one screening that reached a decision: a counted vote, a pass, or a skip, with the policy that chose the
// pair logged on it (signals.policy: {m: mode, pm: mode probability x1000, pp: within-mode pick probability x1e6,
// f / z: the chosen pair's and the candidate set's weight features x1000, q: the model's predicted pick x1000, v: params version}).
// Reward (engagement + information): voted 1, finished both clips 0.5, came back the next day 0.5, informativeness of the
// vote 0.5 x (1 - |2q - 1|). What it can learn from logs alone: the pair weights and the mode mix (they vary per pick).
// Vote multipliers and timings never varied in the logs, so they are reported as not identifiable (they need
// randomised exploration first) and stay at their defaults whatever the gate says.
//
// CLI: node tally/train-screening.mjs [--remote | --local | --file sessions.json] [--out site/data/screening-params.json]
// Library: buildSessions(votes, events), trainScreening(sessions) -> the params file object.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DEFAULTS, PARAMS, THETA, MIN_SESSIONS, SCREEN_VERSION, bound, snips, train } from '../src/screening.js'

const DAY = 86400e3
// votes: [{user, a, b, at, signals}], events: [{user, kind: pass|skip, a, b, at, signals}]
export function buildSessions(votes = [], events = []) {
  // feeds (src/feeds.js): only the For You feed runs the learned mode mix; Trending / Underdog / Vibes / category rounds are
  // separate arms (signals.policy.fd) and never enter the mix's propensities
  const rows = [...votes.map((v) => ({ ...v, voted: true })), ...events.map((e) => ({ ...e, voted: false }))].filter((r) => r && r.signals?.policy?.m && Date.parse(r.at) && (!r.signals.policy.fd || r.signals.policy.fd === 'foryou'))
  const byUser = {}
  for (const r of [...votes, ...events]) if (r?.user && Date.parse(r.at)) (byUser[r.user] = byUser[r.user] || []).push(Date.parse(r.at))
  for (const u of Object.keys(byUser)) byUser[u].sort((x, y) => x - y)
  return rows.map((r) => {
    const P = r.signals.policy, t = Date.parse(r.at), sg = r.signals
    const later = (byUser[r.user] || []).some((x) => x - t >= 12 * 3600e3 && x - t <= 2 * DAY)
    const pm = Number.isFinite(P.pm) ? P.pm / 1000 : null, pp = Number.isFinite(P.pp) ? P.pp / 1e6 : null
    return {
      t, user: r.user, mode: P.m, mu: pm != null ? pm * (pp != null ? pp : 1) : null, pp: pp ?? undefined,
      f: Array.isArray(P.f) ? P.f.map((x) => x / 1000) : null, z: Array.isArray(P.z) ? P.z.map((x) => x / 1000) : null,
      voted: !!r.voted, finishedBoth: !!r.voted && !sg.leftSkipped && !sg.rightSkipped && (sg.rightPct == null || sg.rightPct >= 80),
      returnedNextDay: later, info: Number.isFinite(P.q) ? 1 - Math.abs(2 * P.q / 1000 - 1) : undefined,
    }
  }).filter((s) => s.mu != null && s.mu > 0).sort((x, y) => x.t - y.t)
}
const r4 = (x) => Math.round(x * 1e4) / 1e4
export function trainScreening(sessions, { minSessions = MIN_SESSIONS, margin = 0.01, minEss = 50 } = {}) {
  const n = sessions.length, cut = Math.floor(n * 0.7), tr = sessions.slice(0, cut), ho = sessions.slice(cut)
  const report = { sessions: n, train: tr.length, heldout: ho.length, modes: {} }
  for (const s of sessions) report.modes[s.mode] = (report.modes[s.mode] || 0) + 1
  let learned = { ...DEFAULTS }, base = null, lv = null
  if (tr.length >= 20 && ho.length >= 10) {
    learned = train(tr, { start: DEFAULTS })
    base = snips(DEFAULTS, ho); lv = snips(learned, ho)
  }
  const passed = n >= minSessions && !!base && !!lv && lv.v > base.v + margin && lv.ess >= minEss
  const why = n < minSessions ? `only ${n} logged sessions with a known policy (need ${minSessions})` : !base ? 'not enough data to split' : lv.v <= base.v + margin ? `learned ${r4(lv.v)} does not beat the baseline ${r4(base.v)} on held-out data by ${margin}` : lv.ess < minEss ? `held-out effective sample size ${r4(lv.ess)} < ${minEss}` : 'passed'
  const out = bound({ ...DEFAULTS, ...(passed ? Object.fromEntries(THETA.map((k) => [k, learned[k]])) : {}) })
  return {
    version: SCREEN_VERSION + (passed ? '-learned-' + new Date().toISOString().slice(0, 10) : '-default'), generated: new Date().toISOString(),
    apply: passed, gate: { passed, required: minSessions, sessions: n, reason: why, heldout: base ? { baseline: r4(base.v), learned: r4(lv.v), ess: r4(lv.ess) } : null },
    params: out, defaults: DEFAULTS, bounds: Object.fromEntries(Object.entries(PARAMS).map(([k, v]) => [k, [v[1], v[2]]])),
    proposal: Object.fromEntries(THETA.map((k) => [k, r4(learned[k])])), // what training found (applied only when the gate passed)
    report: { ...report, notIdentifiable: ['snapMult', 'slowMult', 'strongMult', 'skipLoss', 'clipSkipLoss', 'snapMs', 'slowMs', 'sim*', 'watchGateSec', 'watchGateFrac', 'capMobileSec', 'capDesktopSec', 'minWindowSec', 'introMs', 'ballotMs', 'ballotResumeMs'], note: 'These never varied in the logs; they stay at their defaults until a randomised exploration policy logs variation.' },
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null }
  const outPath = arg('--out') || 'site/data/screening-params.json'
  let votes = [], events = []
  if (arg('--file')) ({ votes = [], events = [] } = JSON.parse(fs.readFileSync(arg('--file'), 'utf8')))
  else {
    const where = process.argv.includes('--local') ? '--local' : '--remote'
    const d1 = (sql) => JSON.parse(execFileSync('npx', ['wrangler', 'd1', 'execute', 'funnier', where, '--json', '--command', sql], { cwd: 'api', encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 28 }))[0].results
    const parse = (s) => { try { return JSON.parse(s) } catch { return null } }
    votes = d1('SELECT user_id AS user, a, b, created_at AS at, signals FROM votes WHERE signals IS NOT NULL').map((r) => ({ ...r, signals: parse(r.signals) }))
    events = d1('SELECT user_id AS user, kind, a, b, created_at AS at, signals FROM watch_events WHERE signals IS NOT NULL').map((r) => ({ ...r, signals: parse(r.signals) }))
  }
  const sessions = buildSessions(votes, events), res = trainScreening(sessions)
  fs.mkdirSync(path.dirname(outPath), { recursive: true }); fs.writeFileSync(outPath, JSON.stringify(res, null, 1))
  console.log(`${sessions.length} sessions with a logged policy; gate ${res.gate.passed ? 'PASSED' : 'closed'}: ${res.gate.reason}${res.gate.heldout ? ` (held-out baseline ${res.gate.heldout.baseline}, learned ${res.gate.heldout.learned})` : ''}`)
  console.log(res.apply ? 'params applied -> ' + outPath : 'dry run -> ' + outPath + ' (defaults; proposal recorded)')
}
