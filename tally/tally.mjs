// Funnier tally: discover voters via Jetstream, recount every vote from each voter's own PDS,
// compute Elo + Wilson for clips and comics. Node 22+ (global fetch + WebSocket). No deps.
// Usage: node tally.mjs <clips.json> <outdir>
import fs from 'node:fs'
import path from 'node:path'

const COLLECTION = 'io.github.prx0r.funnier.vote'
const [, , CLIPS_PATH, OUT] = process.argv
const DATA = path.join(OUT, 'data')
fs.mkdirSync(DATA, { recursive: true })
const clips = JSON.parse(fs.readFileSync(CLIPS_PATH, 'utf8')).filter((c) => c.status !== 'removed')
const byId = Object.fromEntries(clips.map((c) => [c.id, c]))
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
// daily clash schedule: <out>/daily.json (published copy), else funnier/site/daily.json next to clips.json. Missing = fallback only.
const DAILY = (() => {
  for (const p of [process.env.DAILY_PATH, path.join(OUT, 'daily.json'), path.join(path.dirname(CLIPS_PATH), 'site', 'daily.json')].filter(Boolean)) {
    try { const d = JSON.parse(fs.readFileSync(p, 'utf8')); if (Array.isArray(d)) return d } catch {}
  }
  return []
})()
// MUST match dailyFor() in src/app.js: same clip order, same FNV-1a hash
function hashStr(s) { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0 } return h >>> 0 }
function topicPairs() {
  const cs = [...clips].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)), out = []
  for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) {
    const A = cs[i], B = cs[j]
    if (A.kind !== B.kind) continue
    const tb = Array.isArray(B.topics) ? B.topics : []
    const shared = (Array.isArray(A.topics) ? A.topics : []).filter((t) => tb.includes(t)).sort()
    if (shared.length) out.push({ a: A.id, b: B.id, topic: shared[0] })
  }
  return out
}
const TOPIC_PAIRS = topicPairs()
function dailyFor(date) {
  const e = DAILY.find((x) => x && x.date === date && byId[x.a] && byId[x.b] && x.a !== x.b)
  if (e) return { date, a: e.a, b: e.b, topic: e.topic || '', title: e.title || 'Daily Clash', editorial: true }
  if (!TOPIC_PAIRS.length) return null
  const p = TOPIC_PAIRS[hashStr(date) % TOPIC_PAIRS.length]
  return { date, a: p.a, b: p.b, topic: p.topic, title: 'Daily Clash', editorial: false }
}
const statePath = path.join(DATA, 'state.json')
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { cursor: null, dids: [] }
const dids = new Set(state.dids)
for (const d of (process.env.EXTRA_DIDS || '').split(',').filter(Boolean)) dids.add(d.trim())

// 1. discover new voters from Jetstream (replay since last cursor)
async function discover() {
  const now = Date.now() * 1000
  const cursor = state.cursor || now - 72 * 3600 * 1e6
  const hosts = ['jetstream2.us-east.bsky.network', 'jetstream1.us-east.bsky.network', 'jetstream1.us-west.bsky.network']
  for (const h of hosts) {
    try {
      const last = await new Promise((resolve, reject) => {
        const ws = new WebSocket(`wss://${h}/subscribe?wantedCollections=${COLLECTION}&cursor=${cursor}`)
        let lastT = cursor, opened = false
        const done = () => { try { ws.close() } catch {} resolve(lastT) }
        const timer = setTimeout(done, 45000)
        ws.onopen = () => { opened = true }
        ws.onmessage = (m) => {
          const e = JSON.parse(typeof m.data === 'string' ? m.data : Buffer.from(m.data).toString())
          if (e.time_us) lastT = e.time_us
          if (e.kind === 'commit' && e.commit?.collection === COLLECTION) dids.add(e.did)
          if (e.time_us && e.time_us >= now) { clearTimeout(timer); done() }
        }
        ws.onerror = (err) => { clearTimeout(timer); opened ? done() : reject(err) }
      })
      // if we saw nothing, Jetstream sends nothing for a filtered collection: advance to "now" minus a safety margin
      state.cursor = Math.max(last, now - 10 * 60 * 1e6)
      console.log('jetstream ok', h, 'dids', dids.size)
      return
    } catch (e) { console.warn('jetstream fail', h, e?.message || e) }
  }
}

// 2. recount from each voter's PDS
async function pdsFor(did) {
  let doc
  if (did.startsWith('did:plc:')) doc = await (await fetch('https://plc.directory/' + did)).json()
  else if (did.startsWith('did:web:')) doc = await (await fetch(`https://${did.slice(8)}/.well-known/did.json`)).json()
  const svc = (doc?.service || []).find((s) => s.id === '#atproto_pds' || s.type === 'AtprotoPersonalDataServer')
  const handle = (doc?.alsoKnownAs || []).find((a) => a.startsWith('at://'))?.slice(5)
  return { pds: svc?.serviceEndpoint, handle }
}

async function recordsFor(did) {
  const { pds, handle } = await pdsFor(did)
  if (!pds) return { handle, recs: [] }
  const recs = []
  let cursor = ''
  for (let i = 0; i < 50; i++) {
    const u = `${pds}/xrpc/com.atproto.repo.listRecords?repo=${did}&collection=${COLLECTION}&limit=100${cursor ? '&cursor=' + cursor : ''}`
    const r = await (await fetch(u)).json()
    recs.push(...(r.records || []))
    if (!r.cursor || !(r.records || []).length) break
    cursor = r.cursor
  }
  return { handle, recs }
}


if (!process.env.SYNTH) await discover()
const votes = []
const voters = []
for (const did of dids) {
  try {
    const { handle, recs } = await recordsFor(did)
    const latest = new Map()
    for (const r of recs) {
      const v = r.value || {}
      if (!byId[v.a] || !byId[v.b] || v.a === v.b || (v.winner !== v.a && v.winner !== v.b)) continue
      const t = Date.parse(v.createdAt)
      if (!t || t > Date.now() + 5 * 60e3) continue
      const k = [v.a, v.b].sort().join('|')
      const prev = latest.get(k)
      if (!prev || t > Date.parse(prev.createdAt)) latest.set(k, { uri: r.uri, did, a: v.a, b: v.b, winner: v.winner, createdAt: v.createdAt, voter: v.voter === 'agent' ? 'agent' : 'human', model: typeof v.model === 'string' ? v.model.slice(0, 80) : undefined, why: typeof v.why === 'string' ? v.why.slice(0, 40) : undefined, ms: Number.isInteger(v.ms) && v.ms >= 0 && v.ms <= 3600000 ? v.ms : undefined, daily: typeof v.daily === 'string' && DAY_RE.test(v.daily) ? v.daily : undefined, cc: typeof v.cc === 'string' && /^[A-Z]{2}$/.test(v.cc) ? v.cc : undefined })
    }
    if (latest.size) {
      const vs = [...latest.values()]
      const isAgent = vs.some((x) => x.voter === 'agent') // once an account declares itself an agent, all its votes count as agent votes
      const model = vs.find((x) => x.model)?.model
      vs.forEach((x) => { x.voter = isAgent ? 'agent' : 'human' })
      voters.push({ did, handle, kind: isAgent ? 'agent' : 'human', model, votes: vs.length }); votes.push(...vs)
    }
  } catch (e) { console.warn('recount fail', did, e?.message || e) }
}
if (process.env.SYNTH) { // test: true strengths Norm>Louis>Rock>Seinfeld
  const tr = { 'Norm Macdonald': 0.8, 'Louis C.K.': 0.4, 'Chris Rock': 0, 'Jerry Seinfeld': -0.4 }
  for (let i = 0; i < +process.env.SYNTH; i++) {
    const a = clips[Math.floor(Math.random() * clips.length)], b = clips[Math.floor(Math.random() * clips.length)]
    if (a.id === b.id) continue
    const p = 1 / (1 + Math.exp(-(tr[a.comic] - tr[b.comic])))
    if (i < 7) voters.push({ did: 'synth' + i, handle: 'synth' + i, kind: i % 3 ? 'human' : 'agent', votes: 0 })
    votes.push({ did: 'synth' + (i % 7), voter: i % 3 ? 'human' : 'agent', a: a.id, b: b.id, winner: Math.random() < p ? a.id : b.id, ms: Math.round(500 + Math.random() * 15000), createdAt: new Date().toISOString() })
  }
  // synthetic daily-clash votes: ~40% of SYNTH, spread over the scheduled days up to today, most with an opt-in country
  const today = new Date(Date.now() + 14 * 3600e3).toISOString().slice(0, 10)
  const days = [...new Set([...DAILY.map((d) => d && d.date).filter((d) => DAY_RE.test(d || '') && d <= today), today])]
  const CCS = ['US', 'US', 'US', 'GB', 'GB', 'KH', 'KH', 'DE', 'IN', 'BR', 'JP', 'FR', undefined, undefined]
  for (let i = 0; i < Math.round(0.4 * +process.env.SYNTH); i++) {
    const D = dailyFor(days[i % days.length]); if (!D) break
    const A = byId[D.a], Bc = byId[D.b], p = 1 / (1 + Math.exp(-((tr[A.comic] || 0) - (tr[Bc.comic] || 0) + 0.3)))
    votes.push({ did: 'synthd' + i, voter: 'human', a: D.a, b: D.b, winner: Math.random() < p ? D.a : D.b, daily: D.date, cc: i % 50 === 7 ? 'IS' : CCS[i % CCS.length], ms: Math.round(500 + Math.random() * 9000), createdAt: new Date().toISOString() })
  }
}
votes.sort((x, y) => Date.parse(x.createdAt) - Date.parse(y.createdAt))

// ---------- Hierarchical Bradley-Terry ----------
// clip strength = comic strength + clip offset (offset shrunk toward 0); P(a beats b) = sigmoid(s_a - s_b).
// Fitted by MAP gradient ascent over ALL votes (order-independent), 95% CIs by bootstrap resampling.
const SCALE = 400 / Math.LN10, BASE = 1500
const comics = [...new Set(clips.map((c) => c.comic))]
const cIdx = Object.fromEntries(comics.map((c, i) => [c, i]))
const kIdx = Object.fromEntries(clips.map((c, i) => [c.id, i]))
const clipComic = clips.map((c) => cIdx[c.comic])
const LAM_OFF = 0.5, LAM_COMIC = 0.05
function fit(vs, init, iters = 400) {
  const u = init ? [...init.u] : comics.map(() => 0)
  const o = init ? [...init.o] : clips.map(() => 0)
  const lr = 0.5 / Math.max(1, Math.sqrt(vs.length))
  for (let t = 0; t < iters; t++) {
    const gu = u.map((x) => -2 * LAM_COMIC * x), go = o.map((x) => -2 * LAM_OFF * x)
    for (const v of vs) {
      const w = kIdx[v.winner], l = kIdx[v.winner === v.a ? v.b : v.a]
      const d = u[clipComic[w]] + o[w] - u[clipComic[l]] - o[l]
      const g = 1 / (1 + Math.exp(d)) // d/dd log sigmoid(d)
      go[w] += g; go[l] -= g; gu[clipComic[w]] += g; gu[clipComic[l]] -= g
    }
    for (let i = 0; i < u.length; i++) u[i] += lr * gu[i]
    for (let i = 0; i < o.length; i++) o[i] += lr * go[i]
  }
  const m = u.reduce((a, b) => a + b, 0) / u.length // anchor: mean comic = 1500
  return { u: u.map((x) => x - m), o }
}
const toElo = (x) => Math.round((BASE + SCALE * x) * 10) / 10
function rank(votes) {
const full = fit(votes, null, 1500)
const B = votes.length ? 200 : 0
const bootC = comics.map(() => []), bootK = clips.map(() => [])
for (let b = 0; b < B; b++) {
  const sample = votes.map(() => votes[Math.floor(Math.random() * votes.length)])
  const f = fit(sample, full, 150)
  f.u.forEach((x, i) => bootC[i].push(x))
  f.o.forEach((x, i) => bootK[i].push(f.u[clipComic[i]] + x))
}
const q = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))] }
const tallyWins = (key) => { const w = {}, n = {}; for (const v of votes) { const A = key(v.a), Bb = key(v.b), W = key(v.winner); if (A === Bb) continue; n[A] = (n[A] || 0) + 1; n[Bb] = (n[Bb] || 0) + 1; w[W] = (w[W] || 0) + 1 } return { w, n } }
const cw = tallyWins((id) => byId[id].comic), kw = tallyWins((id) => id)
const comicRows = comics.map((c, i) => ({
  comic: c, elo: toElo(full.u[i]),
  lo: B ? toElo(q(bootC[i], 0.025)) : null, hi: B ? toElo(q(bootC[i], 0.975)) : null,
  wins: cw.w[c] || 0, bouts: cw.n[c] || 0,
})).sort((a, b) => b.elo - a.elo)
const clipRows = clips.map((c, i) => ({
  id: c.id, comic: c.comic, elo: toElo(full.u[clipComic[i]] + full.o[i]),
  lo: B ? toElo(q(bootK[i], 0.025)) : null, hi: B ? toElo(q(bootK[i], 0.975)) : null,
  wins: kw.w[c.id] || 0, bouts: kw.n[c.id] || 0,
})).sort((a, b) => b.elo - a.elo)
  return { votes: votes.length, voters: new Set(votes.map((v) => v.did)).size, comics: comicRows, clips: clipRows }
}
const board = {
  updated: new Date().toISOString(),
  method: 'hierarchical Bradley-Terry (MAP), 95% bootstrap CI',
  collection: COLLECTION,
  votes: votes.length,
  voters: voters.length,
  boards: { all: rank(votes), human: rank(votes.filter((v) => v.voter === 'human')), agent: rank(votes.filter((v) => v.voter === 'agent')) },
  agents: voters.filter((v) => v.kind === 'agent').map(({ handle, model, votes }) => ({ handle, model, votes })),
}
// ---------- Active sampling: which pairs teach us the most ----------
// score = closeness of ratings x combined uncertainty, plus a floor for under-sampled clips; same length band only.
const band = (c) => (c.sec == null ? null : c.sec < 120 ? 'short' : c.sec < 480 ? 'mid' : 'long')
const allBoard = board.boards.all
const stat = Object.fromEntries(allBoard.clips.map((c) => [c.id, c]))
const pairCount = {}
for (const v of votes) { const k = [v.a, v.b].sort().join('|'); pairCount[k] = (pairCount[k] || 0) + 1 }
const pairs = []
for (let i = 0; i < clips.length; i++) for (let j = i + 1; j < clips.length; j++) {
  const A = clips[i], Bc = clips[j]
  if (A.kind !== Bc.kind) continue // lanes: human vs human, ai vs ai (a "mixed" lane samples across)
  const ba = band(A), bb = band(Bc)
  if (ba && bb && ba !== bb) continue
  const sa = stat[A.id], sb = stat[Bc.id]
  const wa = sa.hi != null ? sa.hi - sa.lo : 400, wb = sb.hi != null ? sb.hi - sb.lo : 400
  const close = Math.exp(-Math.abs(sa.elo - sb.elo) / 200)
  const unc = (wa + wb) / 800
  const fresh = 1 / (1 + Math.min(sa.bouts, sb.bouts) / 10)
  const seen = 1 / (1 + (pairCount[A.id + '|' + Bc.id] || pairCount[Bc.id + '|' + A.id] || 0))
  const cross = A.comic !== Bc.comic ? 1.25 : 1
  pairs.push({ a: A.id, b: Bc.id, kind: A.kind, w: Math.round(1000 * (0.5 * close * unc + 0.5 * fresh) * seen * cross) / 1000 })
}
pairs.sort((x, y) => y.w - x.w)
fs.writeFileSync(path.join(DATA, 'pairs.json'), JSON.stringify({ updated: board.updated, explore: 0.2, pairs }))

// ---------- Personal taste: per-voter comic ratings, shrunk toward the global board ----------
// Empirical-Bayes: start from global comic ratings, take a few gradient steps on the voter's own votes
// with a prior pulling back to global (strength PRIOR). Few votes => looks like the crowd; many => looks like you.
const TASTE_DIR = path.join(DATA, 'taste'); fs.mkdirSync(TASTE_DIR, { recursive: true })
const gComic = Object.fromEntries(allBoard.comics.map((c) => [c.comic, (c.elo - 1500) / (400 / Math.LN10)]))
const PRIOR = 2
const tasteIndex = []
for (const vt of voters) {
  const mine = votes.filter((v) => v.did === vt.did)
  const r = { ...gComic }
  for (let t = 0; t < 300; t++) {
    const g = Object.fromEntries(Object.keys(r).map((k) => [k, -PRIOR * (r[k] - gComic[k])]))
    for (const v of mine) {
      const A = byId[v.a].comic, Bc = byId[v.b].comic
      if (A === Bc) continue
      const W = v.winner === v.a ? A : Bc, L = W === A ? Bc : A
      const p = 1 / (1 + Math.exp(r[W] - r[L]))
      g[W] += p; g[L] -= p
    }
    for (const k in r) r[k] += 0.05 * g[k]
  }
  const prof = Object.entries(r).map(([comic, x]) => ({ comic, elo: Math.round(1500 + (400 / Math.LN10) * x), vsCrowd: Math.round((400 / Math.LN10) * (x - gComic[comic])) }))
    .sort((a, b) => b.elo - a.elo)
  const name = vt.did.replace(/[^a-z0-9]/gi, '_')
  fs.writeFileSync(path.join(TASTE_DIR, name + '.json'), JSON.stringify({ did: vt.did, handle: vt.handle, kind: vt.kind, votes: mine.length, comics: prof }))
  tasteIndex.push({ did: vt.did, handle: vt.handle, kind: vt.kind, votes: mine.length, top: prof[0]?.comic })
}
fs.writeFileSync(path.join(TASTE_DIR, 'index.json'), JSON.stringify(tasteIndex))
// ---------- Daily clash results: totals, % split, per-country splits (>= 5 votes, rest = Other) ----------
const MIN_CC = 5
const pct = (x, n) => (n ? Math.round((1000 * x) / n) / 10 : 0)
const dailyDates = new Set(DAILY.map((d) => d && d.date).filter((d) => DAY_RE.test(d || '')))
for (const v of votes) if (v.daily) dailyDates.add(v.daily)
const nowDay = new Date(Date.now() + 14 * 3600e3).toISOString().slice(0, 10) // latest local date anywhere on Earth
const dailyOut = { updated: board.updated, minCountry: MIN_CC, days: {} }
for (const date of [...dailyDates].filter((d) => d <= nowDay).sort().slice(-90)) {
  const D = dailyFor(date); if (!D) continue
  const k = [D.a, D.b].sort().join('|')
  const vs = votes.filter((v) => v.daily === date && [v.a, v.b].sort().join('|') === k)
  const split = (arr) => { const a = arr.filter((v) => v.winner === D.a).length, n = arr.length; return { total: n, aVotes: a, bVotes: n - a, pctA: pct(a, n), pctB: n ? Math.round((100 - pct(a, n)) * 10) / 10 : 0 } }
  const byCc = {}
  for (const v of vs) if (v.cc) (byCc[v.cc] = byCc[v.cc] || []).push(v)
  const countries = [], rest = []
  for (const [cc, arr] of Object.entries(byCc)) { if (arr.length >= MIN_CC) countries.push({ cc, ...split(arr) }); else rest.push(...arr) }
  countries.sort((x, y) => y.total - x.total || (x.cc < y.cc ? -1 : 1))
  dailyOut.days[date] = { date, a: D.a, b: D.b, topic: D.topic, title: D.title, editorial: D.editorial, ...split(vs), countries, other: split(rest), noCountry: vs.filter((v) => !v.cc).length }
}
fs.writeFileSync(path.join(DATA, 'daily.json'), JSON.stringify(dailyOut))
console.log('daily results', Object.keys(dailyOut.days).length, 'days')
fs.writeFileSync(path.join(DATA, 'leaderboard.json'), JSON.stringify(board, null, 1))
fs.writeFileSync(path.join(DATA, 'votes.json'), JSON.stringify({ updated: board.updated, voters, votes }, null, 1))
state.dids = [...dids]
fs.writeFileSync(statePath, JSON.stringify(state))
console.log(`tallied ${votes.length} votes from ${voters.length} voters`)
