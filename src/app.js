import { BrowserOAuthClient } from '@atproto/oauth-client-browser'
import { renderAvatar, PALETTES } from 'mascot-avatars' // MIT, (c) 2026 s1dashu / Ato Augustine — see site/credits.html
import { structSim } from './structsim.js' // shared with tally/tally.mjs (characters2 §4a)
import { computeChart, chartSVG, tasteMatch, STY, dimLabel, dimShort, dimPhrase, shortName, CHART_COLORS } from './humour.js' // the humour chart
import { drawCard, toBlob, TEMPLATES } from './cards.js' // share cards (PNG)
import { createEngine, basePrior, mergePrior, readout, deltas, deltaText, FEATURES, ENGINE_MODEL } from './engine.js' // humour engine v2 (handwired)

// www.funnier.si/u/<username> (served by funnier-web with <base href="/">) -> the in-app route #u/<username>
if (typeof location !== 'undefined' && typeof history !== 'undefined') { const m = location.pathname.match(/^(.*\/)u\/([A-Za-z0-9_]{3,20})\/?$/); if (m) history.replaceState(null, '', m[1] + '#u/' + m[2] + location.search) }

// Laugh button, crowd-laugh particles and the "Crowd laughs" toggle are switched OFF for now. The code (and the
// /laughs API + the laugh terms in the taste model) stays in place; nothing laugh-related renders or calls the API
// while this is false.
const LAUGHS_ENABLED = false
const COLLECTION = 'io.github.prx0r.funnier.vote'
const BASE = new URL('.', location.href).href.replace(/#.*$/, '')
const IS_LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname)
const $ = (s) => document.querySelector(s)
const LS = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem('funnier.' + k)) ?? d } catch { return d } },
  set: (k, v) => localStorage.setItem('funnier.' + k, JSON.stringify(v)),
}

let CROWD_TASTE = null // data/engine-prior.json (tally): the crowd's taste weights = everyone's starting prior
let CLIPS = [], BYID = {}, BOARD = null, PAIRS = [], COMICS = {}, PUBVOTES = [], DAILY = [], DAILYRES = null, THEORY = {}
let LANE = LS.get('lane', 'human'), BOARDKIND = 'all'
// ---------- device-aware clips (tunable) ----------
// mobile = coarse pointer in portrait, or a narrow viewport. Each device prefers one clip format (clips.json `format`:
// vertical = YouTube Shorts, horizontal = everything else; tools/detect-format.mjs sets it) for `share` of its rounds,
// as long as at least `minPool` clips of that format exist in the lane; otherwise it uses everything. `maxSec` caps how
// much of a long clip we screen (the duration-fairness rule below still applies on top).
const FORMAT_PREFS = {
  mobile: { prefer: 'vertical', share: 0.8, minPool: 6, maxSec: 75 },
  desktop: { prefer: 'horizontal', share: 0.9, minPool: 6, maxSec: 150 },
}
const mm = (q) => typeof matchMedia === 'function' && matchMedia(q).matches
const isMobile = () => (mm('(pointer: coarse)') && mm('(orientation: portrait)')) || (typeof innerWidth === 'number' && innerWidth > 0 && innerWidth < 700)
const devPrefs = () => FORMAT_PREFS[isMobile() ? 'mobile' : 'desktop']
const fmtOf = (c) => (c?.format === 'vertical' ? 'vertical' : 'horizontal')
let SHORT_MAX = 75 // seconds of each clip we screen when the clip is longer (set from FORMAT_PREFS at start)
// ---------- clip length fairness ----------
// Each clip is screened for a window = editorial start..end, else min(duration, SHORT_MAX) from `start` (default 0).
// Two clips only meet when their windows are within FAIR_RATIO of each other, and both then play the SAME length:
// the shorter window (at least MIN_WIN, never past a clip's own window). Clips over LONG_SEC without an editorial
// `start` are flagged needsCut and only paired when nothing else is left.
const MIN_WIN = 30, FAIR_RATIO = 1.5, LONG_SEC = 180
let PAIR_LEVEL = 0 // 0: fair + no needsCut, 1: fair (needsCut allowed), 2: anything (equal windows still apply)
function clipWin(c, liveDur) {
  const s = Number(c?.start) || 0
  if (c?.end != null && Number(c.end) > s) return Number(c.end) - s
  const d = Number(liveDur) > 0 ? Number(liveDur) : Number(c?.dur) || Number(c?.sec) || 0
  return d > 0 ? Math.max(1, Math.min(d - s, SHORT_MAX)) : SHORT_MAX // unknown length: assume a full window until the player tells us
}
const fairPair = (A, B) => { const a = clipWin(A), b = clipWin(B); return Math.max(a, b) <= FAIR_RATIO * Math.min(a, b) + 0.01 }
const sharedWin = (a, b) => Math.min(Math.max(a, b), Math.max(MIN_WIN, Math.min(a, b))) // both clips play this long
function deriveCuts() { for (const c of CLIPS) if (!c.needsCut && Number(c.dur) > LONG_SEC && c.start == null && c.end == null) c.needsCut = true }
function mergeDurs(m) { // learned lengths never override clips.json
  for (const [id, d] of Object.entries(m && typeof m === 'object' ? m : {})) { const c = BYID[id]; if (c && !(Number(c.dur) > 0) && Number(d) > 0) c.dur = Math.round(Number(d) * 10) / 10 }
  deriveCuts()
}
// a random id for anonymous laughs and sound feedback (no account needed); never linked to anything else
function deviceId() {
  let d = LS.get('device', '')
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(d)) { d = 'd' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36); LS.set('device', d) }
  return d
}
let client = null, agent = null, me = null
let current = null

// ---------- data ----------
async function loadData() {
  CLIPS = (await (await fetch('clips.json', { cache: 'no-cache' })).json()).filter((c) => c.status !== 'removed')
  BYID = Object.fromEntries(CLIPS.map((c) => [c.id, c]))
  mergeDurs(LS.get('durs', {}))
  try { BOARD = await (await fetch('data/leaderboard.json', { cache: 'no-cache' })).json() } catch { BOARD = null }
  try { COMICS = (await (await fetch('comics.json', { cache: 'no-cache' })).json()).comics || {} } catch { COMICS = {} }
  try { PUBVOTES = (await (await fetch('data/votes.json', { cache: 'no-cache' })).json()).votes || [] } catch { PUBVOTES = [] }
  try { PAIRS = (await (await fetch('data/pairs.json', { cache: 'no-cache' })).json()).pairs || [] } catch { PAIRS = [] }
  try { THEORY = (await (await fetch('theory.json', { cache: 'no-cache' })).json()) || {} } catch { THEORY = {} }
  try { const d = await (await fetch('daily.json', { cache: 'no-cache' })).json(); DAILY = Array.isArray(d) ? d : [] } catch { DAILY = [] }
  try { const r = await fetch('data/engine-prior.json', { cache: 'no-cache' }); const j = r && r.ok !== false ? await r.json() : null; CROWD_TASTE = j && j.weights && typeof j.weights === 'object' ? j : null } catch { CROWD_TASTE = null }
  await loadDailyResults()
}
// learned durations + crowd loudness from the API (both public, cached); applied silently
let CROWD_AUD = { clips: {}, default_offset: 0 }
async function loadClipMeta() {
  if (!CFG.apiBase) return
  await Promise.all([
    api('/clips/durations').then((r) => { if (r.ok && r.j?.durs) mergeDurs(r.j.durs) }).catch(() => {}),
    api('/clips/audio').then((r) => { if (r.ok && r.j?.clips) CROWD_AUD = { clips: r.j.clips, default_offset: Number(r.j.default_offset) || 0 } }).catch(() => {}),
  ])
}
async function loadDailyResults() {
  try { const r = await fetch('data/daily.json', { cache: 'no-cache' }); const d = r && r.ok !== false ? await r.json() : null; DAILYRES = d && typeof d === 'object' ? d : null } catch { DAILYRES = null }
}

// ---------- auth (AT Protocol OAuth) ----------
async function initAuth() {
  try {
    client = await BrowserOAuthClient.load({
      clientId: IS_LOCAL ? undefined : BASE + 'client-metadata.json',
      handleResolver: 'https://bsky.social',
    })
    const r = await client.init()
    if (r?.session) {
      agent = r.session
      me = { did: r.session.sub, handle: r.session.sub }
      try {
        const p = await (await fetch('https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=' + me.did)).json()
        if (p.handle) me.handle = p.handle
      } catch {}
      await flushQueue()
    }
  } catch (e) { console.warn('auth init', e) }
  paintAuth()
}

// Bluesky publishing is an advanced, opt-in extra that lives inside the account menu (hidden by default)
function bskyHTML() {
  if (me) return `<p class="um-note">Publishing picks to Bluesky as <b>@${esc(me.handle)}</b>.</p><button type="button" class="um-link" id="bskyout">Stop publishing to Bluesky</button>`
  return `<form id="bskyin" class="um-bsky"><input id="handle" placeholder="you.bsky.social" autocomplete="username" required aria-label="Bluesky handle"><button>Connect</button></form><p class="um-note">Also writes each pick as a public record in your own Bluesky account.</p>`
}
function bindBsky(root) {
  const o = root.querySelector('#bskyout')
  if (o) o.onclick = async () => { try { await client.revoke(me.did) } catch {} me = null; agent = null; paintAuth() }
  const f = root.querySelector('#bskyin')
  if (f) f.onsubmit = async (e) => {
    e.preventDefault()
    const h = root.querySelector('#handle').value.trim().replace(/^@/, '')
    if (!h || !client) return
    try { await client.signIn(h, { scope: 'atproto transition:generic' }) }
    catch (err) { toast('Bluesky sign-in failed: ' + (err.message || err)) }
  }
}
function paintAuth() { paintUser() }

function paintBanner() {
  const b = $('#banner'); if (!b) return
  const q = LS.get('queue', [])
  b.textContent = me && q.length ? `Publishing ${q.length} pick(s) to Bluesky…` : ''
}

async function publish(v) {
  const res = await agent.fetchHandler('/xrpc/com.atproto.repo.createRecord', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repo: me.did, collection: COLLECTION,
      record: { $type: COLLECTION, a: v.a, b: v.b, winner: v.winner, voter: 'human', basis: v.basis || 'watched', ...(v.why ? { why: v.why } : {}), ...(Number.isInteger(v.decisionMs) ? { ms: v.decisionMs } : {}), ...dailyFields(v), ...(sigPayload(v) ? { signals: sigPayload(v) } : {}), createdAt: v.createdAt } }),
  })
  if (!res.ok) throw new Error('createRecord ' + res.status + ' ' + (await res.text()))
}

async function flushQueue() {
  let q = LS.get('queue', [])
  while (q.length && agent) {
    try { await publish(q[0]); q.shift(); LS.set('queue', q) } catch (e) { console.warn(e); break }
  }
  paintBanner()
}

// ---------- shared ----------
function pairKey(a, b) { return [a, b].sort().join('|') }
const sig = (x) => 1 / (1 + Math.exp(-x))
const SCALE = 400 / Math.LN10
const LATE_NIGHT = /coco|letterman|tonight|late/i
function bumpSeen(...ids) { const s = LS.get('seen', {}); ids.forEach((i) => (s[i] = (s[i] || 0) + 1)); LS.set('seen', s) }

// ---------- implicit signals -> confidence weight per pick ----------
// decisionMs runs from the moment the Funnier buttons appear to the click.
// <1.5s = snap pick (x1.25), >12s = hesitant (x0.7), otherwise x1.0.
// Picking clip ONE in under 3s while less than 60% of clip TWO was watched = strong (x1.4): you didn't need the rest.
// Old picks without signals keep weight 1.
const SNAP_MS = 1500, SLOW_MS = 12000, LS_WIN_W = 1.2, LS_LOSE_W = 0.6
function timingWeight(v) {
  const ms = v && v.decisionMs
  if (!Number.isFinite(ms)) return 1
  let w = ms < SNAP_MS ? 1.25 : ms > SLOW_MS ? 0.7 : 1
  if (v.winner === v.a && ms < 3000 && Number.isFinite(v.rightFrac) && v.rightFrac < 0.6) w = Math.max(w, 1.4)
  return w
}
function voteWeight(v) {
  let w = timingWeight(v)
  // "Not funny -> next" on clip ONE, then a vote: picking clip TWO confirms it (x1.2), picking ONE anyway is a soft pick (x0.6).
  // Skipping clip TWO to the ballot is the mirror image.
  if (v && v.leftSkipped && !v.rightSkipped) w = v.winner === v.b ? Math.max(w, LS_WIN_W) : Math.min(w, LS_LOSE_W)
  else if (v && v.rightSkipped && !v.leftSkipped) w = v.winner === v.a ? Math.max(w, LS_WIN_W) : Math.min(w, LS_LOSE_W)
  return w
}

// Skips: leaving during a comic's clip = weak negative (SKIP_W = 0.3 of a pick) for that clip, its comic and its style tags.
// Skips during the intro or the ballot, and 3-second passes, are stored but never penalise anyone.
// "Not funny -> next" (stage left-skip / right-skip: ends that clip but stays in the clash) = CLIPSKIP_W = 0.4 of a loss.
const SKIP_W = 0.3, CLIPSKIP_W = 0.4
const PENAL = { left: SKIP_W, right: SKIP_W, 'left-skip': CLIPSKIP_W, 'right-skip': CLIPSKIP_W }
const skipW = (k) => PENAL[k?.stage] || 0
function clipSkips() { const a = LS.get('skips', []); return (Array.isArray(a) ? a : []).filter((k) => k && skipW(k) > 0 && BYID[k.clip]) }

// ---------- your model: personal hierarchical Bradley-Terry, prior = crowd chart ----------
function fitLocal() {
  const votes = LS.get('votes', []).filter((v) => BYID[v.a] && BYID[v.b])
  const g = {}
  for (const c of BOARD?.boards?.all?.comics || []) if (c.bouts) g[c.comic] = (c.elo - 1500) / SCALE
  const comics = [...new Set(CLIPS.map((c) => c.comic))]
  const r = Object.fromEntries(comics.map((k) => [k, g[k] || 0]))
  const o = Object.fromEntries(CLIPS.map((c) => [c.id, 0]))
  const skips = clipSkips(), laughW = laughWeights()
  const bouts = {}
  for (const v of votes) { bouts[v.a] = (bouts[v.a] || 0) + 1; bouts[v.b] = (bouts[v.b] || 0) + 1 }
  for (let t = 0; t < 250; t++) {
    const gr = Object.fromEntries(comics.map((k) => [k, -0.5 * (r[k] - (g[k] || 0))]))
    const go = Object.fromEntries(CLIPS.map((c) => [c.id, -1.0 * o[c.id]]))
    for (const v of votes) {
      const A = BYID[v.a], B = BYID[v.b]
      const W = v.winner === v.a ? A : B, L = W === A ? B : A
      const p = voteWeight(v) * sig((r[L.comic] + o[L.id]) - (r[W.comic] + o[W.id]))
      gr[W.comic] += p; gr[L.comic] -= p; go[W.id] += p; go[L.id] -= p
    }
    for (const sk of skips) { // skipped mid-clip: a weak loss (0.3 / 0.4 of a pick) for that clip vs an average clip
      const C = BYID[sk.clip]; if (!C) continue
      const p = skipW(sk) * sig(r[C.comic] + o[C.id])
      gr[C.comic] -= p; go[C.id] -= p
    }
    for (const lw of laughW) { // laughed during it: a weak win (0.15 per laugh, max 1.0 per viewing) vs an average clip
      const C = BYID[lw.clip]; if (!C) continue
      const p = lw.w * sig(-(r[C.comic] + o[C.id]))
      gr[C.comic] += p; go[C.id] += p
    }
    for (const k of comics) r[k] += 0.08 * gr[k]
    for (const c of CLIPS) o[c.id] += 0.08 * go[c.id]
  }
  return { r, o, bouts, n: votes.length, score: (id) => r[BYID[id].comic] + o[id] }
}
let MODEL = null
const STYLES = ['deadpan', 'absurd', 'dark', 'observational', 'storytelling', 'rant', 'one-liners', 'self-deprecating', 'clean']
const TYPES = {
  deadpan: ['The Straight Face', 'You laugh hardest when nobody on stage does.'],
  absurd: ['The Surrealist', 'Logic is optional. The weirder the turn, the bigger your laugh.'],
  dark: ['The Gallows Crowd', 'Nothing is off-limits if the joke earns it.'],
  observational: ['The Noticer', 'You love comics who say the thing everyone saw and nobody said.'],
  storytelling: ['The Long-Game Listener', 'You will happily wait five minutes for one perfect payoff.'],
  rant: ['The Choir', 'Give you a comic with a righteous head of steam and you are in.'],
  'one-liners': ['The Punchline Purist', 'Setup, punch, next. No wasted words.'],
  'self-deprecating': ['The Confessor', 'You trust a comic who makes themselves the target.'],
  clean: ['The Craft Fan', 'You prize precision over shock.'],
}
function fitTraits() {
  // pairwise logistic regression on style differences: P(A beats B) = sig(w . (xA - xB)), L2-regularised
  const votes = LS.get('votes', []).filter((v) => BYID[v.a] && BYID[v.b])
  const w = Object.fromEntries(STYLES.map((t) => [t, 0])), n = {}
  const x = (c) => Object.fromEntries(STYLES.map((t) => [t, (c.style || []).includes(t) ? 1 : 0]))
  const data = votes.map((v) => { const A = x(BYID[v.a]), B = x(BYID[v.b]); const d = {}; STYLES.forEach((t) => { d[t] = A[t] - B[t]; if (d[t]) n[t] = (n[t] || 0) + 1 }); return { d, y: v.winner === v.a ? 1 : 0, k: voteWeight(v) } })
  for (const sk of clipSkips()) { const X = x(BYID[sk.clip]); if (STYLES.some((t) => X[t])) data.push({ d: X, y: 0, k: skipW(sk) }) }
  for (const lw of laughWeights()) { const X = x(BYID[lw.clip]); if (STYLES.some((t) => X[t])) data.push({ d: X, y: 1, k: lw.w }) }
  for (let it = 0; it < 300; it++) {
    const g = Object.fromEntries(STYLES.map((t) => [t, -0.6 * w[t]]))
    for (const { d, y, k } of data) { const p = sig(STYLES.reduce((s, t) => s + w[t] * d[t], 0)); STYLES.forEach((t) => (g[t] += k * (y - p) * d[t])) }
    STYLES.forEach((t) => (w[t] += 0.1 * g[t]))
  }
  return { w, n }
}
let TRAITS = { w: {}, n: {} }
const traitScore = (c) => (c.style || []).reduce((s, t) => s + (TRAITS.w[t] || 0), 0)
function humourType() {
  const top = Object.entries(TRAITS.w).filter(([t]) => (TRAITS.n[t] || 0) >= 2).sort((a, b) => b[1] - a[1])
  if (!top.length || top[0][1] < 0.15) return null
  return { key: top[0][0], name: TYPES[top[0][0]][0], line: TYPES[top[0][0]][1], also: top[1] && top[1][1] > 0.15 ? top[1][0] : null }
}

// ---------- humour engine v2 (src/engine.js): an interpretable model of YOUR sense of humour ----------
// One handwired program: clip -> named features (operator mix, style tags, energy, punchline hold, pace, setting, format,
// length) -> your taste weights -> P(you pick A over B), P(you rewind it), P(you finish it), P(you skip it). Trained on
// this device after every vote and clip skip (MAP, warm start, the crowd's weights as the prior), so every pick
// visibly moves your profile. Each update stores what it changed and why (funnier.engineLog).
let ENGINE = null, ENG = null
const ENGINE_MAX_VOTES = 300
function crowdLogit(id) { // the public board's clip strength, in logits (0 when the clip has no bouts yet)
  const k = BOARD?.boards?.all?.clips?.find?.((x) => x.id === id)
  if (k && k.bouts) return (k.elo - 1500) / SCALE
  const c = BOARD?.boards?.all?.comics?.find?.((x) => x.comic === BYID[id]?.comic && x.bouts)
  return c ? (c.elo - 1500) / SCALE : 0
}
function engineOn() { if (!ENGINE && CLIPS.length) ENGINE = createEngine({ clips: CLIPS, theory: THEORY, crowd: crowdLogit }); return ENGINE }
function enginePrior() {
  let P = basePrior(CROWD_TASTE?.weights || null)
  const imp = LS.get('enginePrior', null) // an imported Humour Passport: merged in as a prior, never as votes
  if (imp && imp.weights && typeof imp.weights === 'object') P = mergePrior(P, imp.weights, imp.sd || {})
  return P
}
function engineData() {
  const votes = LS.get('votes', []).filter((v) => v && BYID[v.a] && BYID[v.b]).slice(-ENGINE_MAX_VOTES)
    .map((v) => ({ a: v.a, b: v.b, winner: v.winner, w: Number.isFinite(v.weight) ? v.weight : voteWeight(v), signals: v }))
  return { votes, skips: clipSkips().slice(-300).map((k) => ({ clip: k.clip, w: skipW(k) })), favs: favsLocal() }
}
const r4 = (x) => Math.round(x * 1e4) / 1e4
function engineSaved() {
  const s = LS.get('engine', null), NT = FEATURES.length + 7
  return s && s.model === ENGINE_MODEL && Array.isArray(s.theta) && s.theta.length === NT ? s : null
}
function engineFit(iters = 4, fresh = false) {
  const E = engineOn(); if (!E) return null
  const st = fresh ? null : (ENG || engineSaved()), data = engineData()
  const r = E.fit(E.samples(data), enginePrior(), st ? Float64Array.from(st.theta) : null, { iters })
  ENG = { model: ENGINE_MODEL, theta: Array.from(r.theta, r4), sd: r.sd.map(r4), support: r.support.map((x) => Math.round(x * 10) / 10), n: data.votes.length, at: new Date().toISOString() }
  try { LS.set('engine', ENG) } catch {}
  return ENG
}
function engineReadout() {
  const s = ENG || (ENG = engineSaved()) || engineFit(8, true)
  return s ? { ...readout(s.theta, s.sd, s.support), model: ENGINE_MODEL, n: s.n } : null
}
function enginePredict(a, b) { const E = engineOn(), s = ENG || engineSaved(); return E && s ? E.predict(a, b, Float64Array.from(s.theta)) : null }
const possessive = (comic) => { const n = shortName(comic, COMICS); return n + (/s$/i.test(n) ? '\u2019' : '\u2019s') }
function engineWhy(ev) {
  const E = engineOn(), d = (id) => (E ? E.describe(id) : 'clip')
  if (ev.kind === 'vote') {
    const W = BYID[ev.winner], L = BYID[ev.winner === ev.a ? ev.b : ev.a]; if (!W || !L) return ''
    const rew = ev.rewound ? ` and rewound ${possessive(BYID[ev.rewound]?.comic)}` : ''
    return `because you picked ${possessive(W.comic)} ${d(W.id)} over ${possessive(L.comic)} ${d(L.id)}${rew}`
  }
  const C = BYID[ev.clip]; if (!C) return ''
  return `because you skipped ${possessive(C.comic)} ${d(C.id)}${Number.isFinite(ev.at) ? ` ${ev.at}s in` : ''}`
}
// after a vote or a clip skip: refit (warm start), store the delta + the reason. Deferred so the ballot never waits.
let learnQ = []
function engineLearn(ev) {
  learnQ.push(ev)
  setTimeout(() => {
    const evs = learnQ; learnQ = []; if (!evs.length) return
    try {
      const before = engineReadout(); if (!before) return
      const s = engineFit(4), after = s ? readout(s.theta, s.sd, s.support) : null; if (!after) return
      const ds = deltas(before, after, { min: 0.5, top: 3 }), ev0 = evs[evs.length - 1]
      const log = LS.get('engineLog', [])
      log.push({ at: new Date().toISOString(), kind: ev0.kind, a: ev0.a, b: ev0.b, w: ev0.winner, clip: ev0.clip, p: ev0.p, hit: ev0.hit, d: ds.map((x) => ({ k: x.k, d: x.d })), why: engineWhy(ev0), n: s.n })
      LS.set('engineLog', log.slice(-200))
      chartChanged()
      if (!$('#v-you')?.hidden) paintYou()
      if (!$('#v-profile')?.hidden && profRoute().kind === 'me') paintProfilePage()
    } catch (e) { console.warn('engine', e) }
  }, 40)
}
const featLabel = (k) => FEATURES.find((f) => f.k === k)?.label || k
function deltaPhrase(e) {
  const ds = Array.isArray(e?.d) ? e.d.map((x) => ({ ...x, label: featLabel(x.k) })) : []
  const verb = e.kind === 'vote' ? 'This vote' : 'This skip'
  return ds.length ? `${verb}: ${deltaText(ds)}` : `${verb}: nothing moved much (your model expected it)`
}
const agoStr = (t) => { const s = (Date.now() - Date.parse(t)) / 1000; if (!(s >= 0)) return ''; if (s < 90) return 'just now'; if (s < 3600) return Math.round(s / 60) + 'm ago'; if (s < 86400) return Math.round(s / 3600) + 'h ago'; return Math.round(s / 86400) + 'd ago' }
// "How each clip changed you": latest first, subtle
function timelineHTML(limit = 8) {
  const log = LS.get('engineLog', []).filter((e) => e && e.at).slice().reverse()
  if (!log.length) return ''
  const li = (e) => `<li><span class="tl-d">${esc(deltaPhrase(e))}</span>${e.why ? `<span class="tl-why">${esc(e.why)}</span>` : ''}<time>${esc(agoStr(e.at))}${e.kind === 'vote' && typeof e.hit === 'boolean' ? (e.hit ? ' · model called it' : ' · model guessed the other one') : ''}</time></li>`
  return `<details class="tl"${limit > 8 ? ' open' : ''}><summary>How each clip changed you <span class="muted">${log.length} update${log.length === 1 ? '' : 's'}</span></summary><ol class="tl-list">${log.slice(0, limit).map(li).join('')}</ol></details>`
}
const confText = (cl, n) => `${cl || 'low'} confidence, ${Math.round(n || 0)} vote${Math.round(n || 0) === 1 ? '' : 's'}`

// ---------- choosing the next double feature ----------
function openPair(a, b) {
  const done = new Set(LS.get('votes', []).map((v) => pairKey(v.a, v.b)))
  const skipped = new Set(LS.get('skipped', []))
  const A = BYID[a], B = BYID[b]
  if (!A || !B || a === b || done.has(pairKey(a, b)) || skipped.has(pairKey(a, b))) return false
  if (A.comic === B.comic) return false // hard rule at every level: a clash is always two different comics
  if (PAIR_LEVEL < 2 && !fairPair(A, B)) return false
  if (PAIR_LEVEL < 1 && (A.needsCut || B.needsCut)) return false
  if (LANE === 'mixed') return A.kind !== B.kind || Math.random() < 0.25
  return A.kind === LANE && B.kind === LANE
}
let ROUND_FMT = null // the format this round is drawn from (null = any)
function pool() { const P = CLIPS.filter((c) => LANE === 'mixed' || c.kind === LANE); return ROUND_FMT ? P.filter((c) => fmtOf(c) === ROUND_FMT) : P }
function roundFormat() { // the device's preferred format for this round, when the lane has enough of it
  const pr = devPrefs(); ROUND_FMT = null
  const P = CLIPS.filter((c) => (LANE === 'mixed' || c.kind === LANE) && fmtOf(c) === pr.prefer)
  // enough of that format, from at least two comics (a clash is always two different comics)
  if (P.length >= pr.minPool && new Set(P.map((c) => c.comic)).size >= 2 && Math.random() < pr.share) ROUND_FMT = pr.prefer
}
const shuffle = (a) => a.map((x) => [Math.random(), x]).sort((p, q) => p[0] - q[0]).map((p) => p[1])

const pairSim = (a, b) => structSim(a, b, THEORY, { pairing: true })
// §4b: the clips you rated highest (winners, summed pick confidence), at most 8
function likedClips() {
  const w = {}
  for (const v of LS.get('votes', [])) if (v && BYID[v.winner]) w[v.winner] = (w[v.winner] || 0) + (Number.isFinite(v.weight) ? v.weight : voteWeight(v))
  return Object.entries(w).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([id, k]) => ({ c: BYID[id], k }))
}
// contentSim(c) = weighted mean struct_sim(c, x) over your liked clips (c itself excluded; same-comic kinship counts here):
// kindred clips rise before you have voted on them
function contentSim(c, liked) {
  let s = 0, n = 0
  for (const { c: x, k } of liked) if (x.id !== c.id) { s += k * structSim(c, x, THEORY); n += k }
  return n ? s / n : 0
}
if (typeof window !== 'undefined') window.__funnierTest = { pickPair: () => pickPair(), openPair: (a, b) => openPair(a, b), contentSim: (id) => contentSim(BYID[id], likedClips()), pickForYou: () => pickForYou() } // smoke tests sample rounds
function pickForYou() {
  // your model's favourite unseen matchup: its top clip vs the clip it knows least about
  const P = pool(); if (P.length < 2) return null
  const liked = likedClips()
  const fy = (c) => MODEL.score(c.id) + traitScore(c) + contentSim(c, liked) + 0.3 * Math.random()
  const top = [...P].sort((x, y) => fy(y) - fy(x))
  for (const a of top.slice(0, 6)) {
    // its opponent: structurally kindred (same kind of funny) and still little-known to your model
    const os = (b) => pairSim(a, b) - 0.08 * (MODEL.bouts[b.id] || 0) + 0.2 * Math.random()
    const opp = P.filter((b) => b.comic !== a.comic && openPair(a.id, b.id)).map((b) => [os(b), b]).sort((x, y) => y[0] - x[0]).map((x) => x[1])
    if (opp.length) return [a, opp[0]]
  }
  return null
}
function pickTraining() {
  // the pairs the crowd chart is least sure about (computed by the tally)
  const ranked = PAIRS.filter((p) => openPair(p.a, p.b)).slice(0, 40)
  if (!ranked.length) return null
  let x = Math.random() * ranked.reduce((s, p) => s + p.w, 0)
  for (const p of ranked) { x -= p.w; if (x <= 0) return [BYID[p.a], BYID[p.b]] }
  return [BYID[ranked[0].a], BYID[ranked[0].b]]
}
function pickExplore() {
  const seen = LS.get('seen', {}), P = shuffle(pool()).sort((x, y) => (seen[x.id] || 0) - (seen[y.id] || 0))
  for (const a of P) {
    const opts = P.filter((b) => openPair(a.id, b.id))
    if (!opts.length) continue
    // least-seen clip vs a kindred opponent from another comic (openPair already rules out the same comic)
    return [a, opts.map((b) => [pairSim(a, b) + 0.35 * Math.random(), b]).sort((x, y) => y[0] - x[0])[0][1]]
  }
  return null
}
const MODES = {
  foryou: ['Picked for you', pickForYou],
  training: ['Training the crowd chart', pickTraining],
  explore: ['Exploring something new', pickExplore],
  shared: ['A friend shared this clash', () => null],
  daily: ['Daily clash', () => null],
  rewatch: ['Rewatching from your history', () => null],
}
function pickPair() {
  const n = LS.get('votes', []).length
  const w = n < 6 ? { training: 0.55, explore: 0.45, foryou: 0 } : { foryou: 0.4, training: 0.4, explore: 0.2 }
  let x = Math.random(), mode = 'explore'
  for (const k of Object.keys(w)) { x -= w[k]; if (x <= 0) { mode = k; break } }
  const order = [mode, ...Object.keys(MODES).filter((k) => k !== mode)]
  roundFormat()
  try {
    for (const fmt of ROUND_FMT ? [ROUND_FMT, null] : [null]) { // the preferred format first, then any (too few left)
      ROUND_FMT = fmt
      for (PAIR_LEVEL = 0; PAIR_LEVEL < 3; PAIR_LEVEL++) for (const m of order) {
        const p = MODES[m][1]()
        if (p) { const pair = Math.random() < 0.5 ? p : [p[1], p[0]]; pair.mode = m; return pair }
      }
    }
  } finally { PAIR_LEVEL = 0; ROUND_FMT = null }
  return null
}

// ---------- players ----------
let ytReady = null
function loadYT() {
  if (ytReady) return ytReady
  ytReady = new Promise((res) => {
    window.onYouTubeIframeAPIReady = () => res(window.YT)
    const t = document.createElement('script'); t.src = 'https://www.youtube.com/iframe_api'; document.head.appendChild(t)
  })
  return ytReady
}
// ---------- volume: YouTube's setVolume can only attenuate (0-100), so loud clips get turned down, never quiet ones up past 100 ----------
// effective = clamp(clip.vol (editorial, default 100) + your local offset from "Too loud"/"Too quiet") x your volume slider
const AUD_STEP = 15
const FADE_IN_MS = 1200, FADE_OUT_MS = 400, FADE_STEP_MS = 40
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x))
function userVol() { return 100 } // no master slider: per-clip editorial vol + your too-loud/quiet offsets only
function audioMap() { const m = LS.get('audio', {}); return m && typeof m === 'object' && !Array.isArray(m) ? m : {} }
// crowd offset (GET /clips/audio): -40..0, normalised to the quietest clip, so it only ever attenuates
function crowdOff(c) { const x = CROWD_AUD.clips?.[c?.id]; return clamp(Number(x ? x.offset : CROWD_AUD.default_offset) || 0, -40, 0) }
function clipVol(c) {
  const base = c?.vol != null && c.vol !== '' && Number.isFinite(Number(c.vol)) ? clamp(Number(c.vol), 0, 100) : 100
  const off = Number(audioMap()[c?.id]?.off) || 0
  return Math.round(clamp((base * (100 + crowdOff(c))) / 100 + off, 0, 100) * userVol() / 100)
}
function audioFeedback(clip, kind) {
  if (!clip || (kind !== 'loud' && kind !== 'quiet')) return
  const m = audioMap(), r = m[clip.id] && typeof m[clip.id] === 'object' ? m[clip.id] : { off: 0, loud: 0, quiet: 0 }
  r[kind] = (Number(r[kind]) || 0) + 1
  r.off = clamp((Number(r.off) || 0) + (kind === 'loud' ? -AUD_STEP : AUD_STEP), -60, 30)
  r.at = new Date().toISOString(); m[clip.id] = r; LS.set('audio', m)
  if (CFG.apiBase) api('/clips/audio', { method: 'POST', body: { clip: clip.id, dir: kind, device: deviceId() } }).catch(() => {}) // crowd loudness
  toast(kind === 'loud' ? `Noted. ${clip.comic} plays ${AUD_STEP}% quieter next time.` : `Noted. ${clip.comic} plays a little louder next time (up to full volume).`)
}
// ---------- sound: autoplay WITH sound, never a prompt ----------
// Every clip tries to play unmuted first (Chrome allows it for returning visitors / installed apps, and after any
// interaction). If the browser refuses (the player isn't playing ~500ms later), it plays muted instead, silently.
// The first interaction anywhere (pointer, touch, key, wheel, scroll, a vote, a swipe) then unmutes the playing clip
// with the usual fade, primes the clip waiting next (a silent play + pause, so iOS lets it start with sound later) and
// stores funnier.sound = 'on'; every later clip starts unmuted. The small speaker in the theatre chrome (or M) is the
// only control: muting there stores funnier.sound = 'off', which is respected until the viewer unmutes again.
let soundOK = false, justUnmuted = 0
const soundPref = () => { const v = LS.get('sound', null); return v === 'on' || v === 'off' ? v : null }
const liveScreen = () => (stage === 'left' ? screens.L : stage === 'right' ? screens.R : null)
const isMutedNow = (s) => { try { return s ? (s.a ? s.a.muted : !!s.p?.isMuted?.()) : false } catch { return false } }
function soundOn() { // explicit unmute (speaker icon, M, or a tap on a muted clip)
  soundOK = true; LS.set('interacted', true); LS.set('sound', 'on')
  liveScreen()?.unmute(); paintSnd()
}
function soundOff() { // explicit mute: respected on every later clip and visit
  LS.set('sound', 'off')
  const s = liveScreen(); try { if (s?.a) s.a.muted = true; else s?.p?.mute?.() } catch {}
  paintSnd()
}
function toggleSound() { if (now() - justUnmuted < 500) return; const s = liveScreen(); if (soundPref() === 'off' || isMutedNow(s)) soundOn(); else soundOff() }
function firstGesture() { // capture phase, before any other handler sees the interaction
  if (soundPref() === 'off') return
  soundOK = true
  if (soundPref() !== 'on') LS.set('sound', 'on')
  const s = liveScreen()
  if (s && s.started && (isMutedNow(s) || (s.wantPlay && !s.playing()))) { justUnmuted = now(); s.unmute(); paintSnd() }
  for (const sc of [screens.L, screens.R]) if (sc && sc !== s && !sc.started) sc.prime()
}
const SND_ON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/></svg>'
const SND_OFF = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M17 9.5l5 5M22 9.5l-5 5"/></svg>'
function sndBtnHTML() { return '<button type="button" class="vsnd" aria-label="Mute (M)" title="Mute (M)" aria-pressed="false">' + SND_ON + '</button>' }
function paintSnd() {
  const off = soundPref() === 'off' || isMutedNow(liveScreen())
  document.querySelectorAll('.vsnd').forEach((b) => { b.innerHTML = off ? SND_OFF : SND_ON; b.setAttribute('aria-pressed', String(off)); const l = off ? 'Unmute (M)' : 'Mute (M)'; b.setAttribute('aria-label', l); b.title = l })
}
class Screen {
  constructor(side, clip, hostId) { this.side = side; this.clip = clip; this.hostId = hostId; this.started = false; this.view = Date.now().toString(36) + side + Math.random().toString(36).slice(2, 6); this.ready = new Promise((res) => (this._ready = res)) }
  async mount() {
    const c = this.clip, host = document.getElementById(this.hostId)
    this.start = c.start || 0
    if (!host) return
    if (c.media === 'audio') {
      host.innerHTML = `<audio preload="auto" controls src="${esc(c.src)}"></audio>`
      this.a = host.querySelector('audio')
      this.a.onloadedmetadata = () => { this.setVol(0); this._ready() }
      this.a.onended = () => (this.ended = true)
      return
    }
    const YT = await loadYT()
    if (this.dead || !document.getElementById(this.hostId)) return
    const res = this._ready
    this.p = new YT.Player(this.hostId, {
      host: 'https://www.youtube-nocookie.com', videoId: c.id,
      // our own chrome (thin progress line, name overlay, tap to pause, F for fullscreen) replaces YouTube's control bar
      playerVars: { rel: 0, playsinline: 1, start: this.start, controls: 0, modestbranding: 1, iv_load_policy: 3, fs: 0, disablekb: 1 },
      events: { onReady: () => { this.setVol(this.started && this.fadeT == null ? clipVol(this.clip) : 0); res() }, onStateChange: (e) => { if (e.data === 0) this.ended = true } },
    })
  }
  // ---- volume: every clip fades in from 0 to its level (editorial vol x crowd offset x your offset) over FADE_IN_MS
  // and out over FADE_OUT_MS on skip / clip change, with player.setVolume steps (the iframe's audio can't be measured)
  setVol(v) { this.vol = clamp(Number(v) || 0, 0, 100); try { if (this.a) this.a.volume = this.vol / 100; else this.p?.setVolume?.(Math.round(this.vol)) } catch {} }
  fadeTo(to, ms, done) {
    clearInterval(this.fadeT); this.fadeT = null
    const from = this.vol ?? 0, t0 = now()
    if (!(ms > 0) || Math.abs(to - from) < 0.5) { this.setVol(to); done?.(); return }
    this.fadeT = setInterval(() => {
      const k = Math.min(1, (now() - t0) / ms), e = k * k * (3 - 2 * k) // smoothstep
      this.setVol(from + (to - from) * e)
      if (k >= 1) { clearInterval(this.fadeT); this.fadeT = null; done?.() }
    }, FADE_STEP_MS)
  }
  fadeIn() { this.setVol(0); this.fadeTo(clipVol(this.clip), FADE_IN_MS) }
  fadeOut(done) { this.fadeTo(0, FADE_OUT_MS, done) }
  // fade in once playback has really begun (YouTube may buffer first); gives up quietly after a few seconds
  armFade() {
    clearInterval(this.armT); this.setVol(0)
    const t0 = now()
    const go = () => { if (this.dead || !this.wantPlay) { clearInterval(this.armT); this.armT = null; return true } if (this.playing() || now() - t0 > 4000) { clearInterval(this.armT); this.armT = null; this.fadeIn(); return true } return false }
    if (!go()) this.armT = setInterval(go, 80)
  }
  applyVol() { if (this.fadeT == null && this.armT == null) this.setVol(this.started ? clipVol(this.clip) : 0) }
  dur() { let d = 0; try { d = this.a ? this.a.duration : this.p?.getDuration?.() } catch {} return (Number.isFinite(d) && d > 0 ? d : 0) || Number(this.clip.dur) || this.clip.sec || 0 }
  win() { let d = 0; try { d = this.a ? this.a.duration : this.p?.getDuration?.() } catch {} return clipWin(this.clip, Number.isFinite(d) ? d : 0) }
  // both clips in a clash play the same length window: the shorter of the two (at least MIN_WIN)
  end() { const w = this.win(); return this.start + (this.mate ? Math.min(w, sharedWin(w, this.mate.win())) : w) }
  seek(to, ahead = true) {
    const s = this.start, e = this.end(), t = clamp(Number(to) || 0, s, Math.max(s, e - 1)), from = this.t()
    if (t > from + 1) this.jumped = true // seeking forward = skippedAhead, same as before
    if (t < from) this.ended = false
    // the bar shows the target at once and holds it until the player reports a time near it (getCurrentTime lags a seek)
    const n = now(); this.hold = { to: t, until: n + 2500 }; this.shown = t; this.rawV = t; this.rawAt = n
    try { if (this.a) this.a.currentTime = t; else this.p?.seekTo?.(t, ahead) } catch {}
    return t
  }
  seekBy(dt) { return this.seek(this.t() + dt) }
  t() { return this.a ? this.a.currentTime : this.p?.getCurrentTime?.() || 0 }
  playing() { return this.a ? !this.a.paused : this.p?.getPlayerState?.() === 1 }
  progress() { const s = this.start, e = this.end(); return Math.max(0, Math.min(1, (this.shownT() - s) / Math.max(1, e - s))) }
  // smooth + monotonic position for the progress bar: the player's time, extrapolated between its (steppy) reports
  // while playing, never stepping back for sub-second jitter, holding a seek target until the player catches up, and
  // ignoring the 0 YouTube reports while (re)loading. A real jump back (seek, replay) still resets it.
  shownT() {
    const n = now(), st = this.playing()
    let raw = Number(this.t())
    if (!Number.isFinite(raw)) raw = this.rawV ?? this.start
    if (this.hold) { if (Math.abs(raw - this.hold.to) < 1.2 || n > this.hold.until) this.hold = null; else raw = this.hold.to }
    if (!this.hold && raw <= 0.05 && (this.shown ?? 0) > this.start + 1.5) raw = this.rawV ?? this.shown // loading blip
    if (raw !== this.rawV) { this.rawV = raw; this.rawAt = n }
    const est = raw + (st && !this.hold ? Math.min(0.6, (n - (this.rawAt || n)) / 1000) : 0)
    const prev = this.shown
    if (prev == null || est >= prev || prev - est > 1.5) this.shown = est
    return this.shown
  }
  done() { return this.ended || (this.started && this.t() >= this.end() - 0.3) }
  async play() {
    await this.ready; if (this.dead) return
    if (!this.started) { this.shown = this.start; this.rawV = null; this.hold = null }
    this.started = true; this.wantPlay = true; this.setVol(0)
    const muted = soundPref() === 'off' // otherwise always try with sound first
    if (this.a) {
      this.a.muted = muted
      try { await this.a.play() } catch { this.a.muted = true; try { await this.a.play() } catch {} }
      this.armFade(); paintSnd()
      return
    }
    try { muted ? this.p.mute() : this.p.unMute() } catch {}
    this.p.playVideo()
    this.armFade()
    paintSnd()
    if (muted) return
    // sound refused -> play muted, silently (the next interaction unmutes). Checked ~500ms in; a player still loading
    // (unstarted/cued/buffering) gets a few more looks before we decide.
    const check = (k) => {
      if (this.dead || !this.wantPlay) return // paused or skipped since: don't restart it behind the next clip
      let st = -1; try { st = this.p?.getPlayerState?.() } catch {}
      if (st === 1) { paintSnd(); return }
      if ((st === -1 || st === 5 || st === 3) && k < 8) { setTimeout(() => check(k + 1), 500); return }
      try { this.p.mute(); this.p.playVideo() } catch {}
      paintSnd()
    }
    setTimeout(() => check(0), 500)
  }
  // inside a user gesture: play this not-yet-started clip silently for a moment and pause it again, so the browser
  // lets it start with sound later without another tap (iOS treats each player separately)
  prime() {
    if (this.primed || this.started || this.dead) return
    this.primed = true
    try {
      if (this.a) { const v = this.a.volume; this.a.volume = 0; this.a.muted = false; this.a.play().then(() => { if (!this.started) { this.a.pause(); this.a.currentTime = this.start } this.a.volume = v }).catch(() => {}); return }
      if (!this.p?.playVideo) { this.primed = false; return }
      this.p.setVolume?.(0); this.p.unMute?.(); this.p.playVideo()
      setTimeout(() => { if (this.started || this.dead) return; try { this.p.pauseVideo(); this.p.seekTo?.(this.start, true) } catch {} }, 450)
    } catch {}
  }
  unmute() {
    try {
      if (this.a) { this.setVol(0); this.a.muted = false; if (this.a.paused && this.wantPlay) this.a.play().catch(() => {}) }
      else { this.setVol(0); this.p?.unMute?.(); if (this.wantPlay && !this.playing()) this.p?.playVideo?.() }
      if (this.armT == null) this.fadeIn() // sound arrives with the same gentle fade (unless the start fade is still waiting)
    } catch {}
  }
  toggle() { // tap on the gesture layer: unmute, play/pause
    if (this.a) { if (now() - justUnmuted < 500) return; if (this.a.muted) { soundOn(); return } if (this.a.paused) { this.wantPlay = true; this.a.play().catch(() => {}) } else this.pause(); return }
    if (now() - justUnmuted < 500) return // this tap just turned the sound on; it is not a pause
    try { if (this.p?.isMuted?.()) { soundOn(); return } } catch {}
    if (this.playing()) this.pause(); else { this.wantPlay = true; this.p?.playVideo?.() }
  }
  // called every tick: accumulates real seconds watched, notices seeks back (replay) and jumps ahead (skip)
  track() {
    this.watched = this.watched || 0; this.replays = this.replays || 0
    if (!this.started) return // a primed (silently pre-started) clip isn't being watched yet
    let t = 0, on = false
    try { t = this.t(); on = this.playing() } catch { return }
    if (!Number.isFinite(t)) return
    if (this.lastT == null) { if (on) this.lastT = t; return } // start tracking at first real playback
    const d = t - this.lastT
    if (on && d > 0 && d < 2) this.watched += d
    if (d < -2) { // a jump back = rewatching something: keep where they jumped to (and from), the laugh label (§3b)
      this.replays++
      if ((this.seekT = this.seekT || []).length < 20) { this.seekT.push(Math.round(t)); (this.seekF = this.seekF || []).push(Math.round(this.lastT)) }
    }
    if (d > 5) this.jumped = true
    this.lastT = t
    if (!this.durSent) { const dd = this.a ? this.a.duration : this.p?.getDuration?.(); if (Number.isFinite(dd) && dd > 0) { this.durSent = true; learnDur(this.clip, dd) } }
  }
  screened() { return Math.max(1, this.end() - this.start) }
  // the watch minimum: min(30s, 80% of what we screen), or the clip played to its end
  enough() { return this.ended || (this.watched || 0) >= Math.min(30, 0.8 * this.screened()) - 0.5 || (this.started && this.t() >= this.end() - 0.3 && (this.watched || 0) > 3 && !this.jumped) }
  pause() { this.wantPlay = false; clearInterval(this.armT); this.armT = null; try { this.a ? this.a.pause() : this.p?.pauseVideo?.() } catch {} }
  // skip / clip change: stop wanting playback now, fade out over FADE_OUT_MS, then pause
  fadePause() { if (this.wantPlay === false && this.fadeT == null) return this.pause(); this.wantPlay = false; clearInterval(this.armT); this.armT = null; this.fadeOut(() => { if (!this.wantPlay) this.pause() }) }
  destroy() { if (this.gone) return; this.gone = true; this.dead = true; clearInterval(this.fadeT); clearInterval(this.armT); this.fadeT = this.armT = null; try { this.a?.pause() } catch {} try { this.p?.destroy?.() } catch {} }
  // leaving the clash: fade out, then tear the player down (the slide is removed ~520ms later)
  retire() {
    if (this.dead) return
    const live = this.wantPlay && this.playing()
    this.dead = true; this.wantPlay = false; clearInterval(this.armT); this.armT = null
    if (!live) { this.destroy(); return }
    this.fadeOut(() => this.destroy())
    setTimeout(() => this.destroy(), FADE_OUT_MS + 200) // belt and braces
  }
}

// ---------- durations learned from the official player (getDuration), shared via the API so everyone benefits ----------
let durQ = {}, durT = null
function learnDur(c, d) {
  d = Math.round(d * 10) / 10; if (!c || !(d > 0)) return
  const m = LS.get('durs', {}); if (Math.abs((Number(m[c.id]) || 0) - d) > 1) { m[c.id] = d; LS.set('durs', m) }
  if (!(Number(c.dur) > 0)) { c.dur = d; deriveCuts() }
  if (CFG.apiBase && !LS.get('durSent', {})[c.id]) { durQ[c.id] = d; clearTimeout(durT); durT = setTimeout(flushDurs, 1200) }
}
function flushDurs() {
  const q = durQ; durQ = {}
  if (!Object.keys(q).length || !CFG.apiBase) return
  api('/clips/durations', { method: 'POST', body: { durs: q } }).then((r) => {
    if (!r.ok) return
    const s = LS.get('durSent', {}); for (const k of Object.keys(q)) s[k] = 1; LS.set('durSent', s)
  }).catch(() => {})
}

// ---------- laughs: tap while watching. Your laughs train your model; everyone's float up as particles (visual only) ----------
const LAUGH_GAP = 700, LAUGH_W = 0.15, LAUGH_CAP = 1
const LAUGH_SVG = `<svg class="lsvg" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="30" fill="#e8102e"/><ellipse cx="24" cy="15" rx="13" ry="6" fill="#fff" opacity=".13"/><path d="M16.5 25.5q4.5-6 9 0M38.5 25.5q4.5-6 9 0" fill="none" stroke="#fff6ee" stroke-width="3.4" stroke-linecap="round"/><path d="M15 33.5h34c0 9.6-7.6 16.5-17 16.5s-17-6.9-17-16.5z" fill="#fff6ee"/><path d="M21.5 42.5c2.8 3.3 6.3 5 10.5 5s7.7-1.7 10.5-5c-3-1.6-6.5-2.4-10.5-2.4s-7.5.8-10.5 2.4z" fill="#ff8d9b"/><path d="M9.5 27c-2.6 4.2-3 7.4-1 9 2 1.4 4.6-.4 4.4-3.6-.1-1.8-1.3-3.6-3.4-5.4zM54.5 27c2.6 4.2 3 7.4 1 9-2 1.4-4.6-.4-4.4-3.6.1-1.8 1.3-3.6 3.4-5.4z" fill="#9fe6ff"/></svg>`
const LAUGH_MINI = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="#e8102e"/><path d="M6.5 9.5q1.6-2.2 3.3 0M14.2 9.5q1.6-2.2 3.3 0" fill="none" stroke="#fff6ee" stroke-width="1.5" stroke-linecap="round"/><path d="M6 12.6h12c0 3.5-2.7 6-6 6s-6-2.5-6-6z" fill="#fff6ee"/></svg>`
let lastLaughAt = 0, laughDirty = false
function laughsAll() { const a = LS.get('laughs', []); return Array.isArray(a) ? a.filter((l) => l && typeof l.clip === 'string') : [] }
const crowdLaughsOn = () => LS.get('crowdLaughs', true) !== false
// each laugh on a clip = +0.15 of a vote for that clip, its comic and its styles; at most 1.0 per clip per viewing
function laughWeights() {
  const by = {}
  for (const l of laughsAll()) { if (!BYID[l.clip]) continue; const k = l.clip + '|' + (l.view || l.at); by[k] = by[k] || { clip: l.clip, n: 0 }; by[k].n++ }
  return Object.values(by).map((x) => ({ clip: x.clip, w: Math.min(LAUGH_CAP, LAUGH_W * x.n) }))
}
function laugh() {
  if (!LAUGHS_ENABLED) return false
  if (!(stage === 'left' || stage === 'right')) return false
  const sc = screens[stage === 'left' ? 'L' : 'R']; if (!sc?.clip) return false
  const n = now(); if (n - lastLaughAt < LAUGH_GAP) return false // one per 0.7s (the API enforces the same)
  lastLaughAt = n
  const t = Math.max(0, Math.round(sc.t() * 10) / 10)
  LS.set('laughs', [...laughsAll(), { clip: sc.clip.id, comic: sc.clip.comic, t, view: sc.view, at: new Date().toISOString() }].slice(-3000))
  laughDirty = true
  laughBurst()
  if (CFG.apiBase) api('/laughs', { method: 'POST', body: { clip: sc.clip.id, t, device: deviceId() } }).catch(() => {})
  return true
}
function lfx() { return cur?.el?.querySelector('.lfx') || null }
function particle(kind, delay = 0) {
  // Instagram Live style: every laugh (yours and the crowd's) floats up from the laugh button on the right edge
  const L = lfx(); if (!L || L.childElementCount > 48) return
  const b = cur?.el?.querySelector('.laughbtn'); const lr = L.getBoundingClientRect()
  const br = b ? b.getBoundingClientRect() : { left: lr.right - 50, top: lr.top + lr.height / 2, width: 44, height: 44 }
  const p = document.createElement('span')
  p.className = 'lp ' + kind; p.innerHTML = LAUGH_MINI
  const r = Math.random()
  const x = br.left - lr.left + br.width / 2, y = br.top - lr.top + br.height * 0.2
  p.style.cssText = `left:${x.toFixed(0)}px;top:${y.toFixed(0)}px;--dx:${Math.round(-10 - r * 46)}px;--w:${Math.round(8 + Math.random() * 14)}px;--s:${(kind === 'mine' ? 1 : 0.7) + Math.random() * 0.45};--d:${(2.4 + Math.random() * 1.2).toFixed(2)}s;animation-delay:${delay}ms`
  L.appendChild(p); setTimeout(() => p.remove(), 4200 + delay)
}
function laughBurst() {
  const b = q('.laughbtn'); if (b) { b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop'); setTimeout(() => b.classList.remove('pop'), 450) }
  if (reduced()) return
  for (let i = 0; i < 3; i++) particle('mine', i * 70)
}
// other viewers' laughs: GET /laughs/:clip (1-second bins), minus your own, replayed as particles at those moments
function prefetchLaughs(sc) {
  if (!LAUGHS_ENABLED || !sc || sc.histP || !CFG.apiBase || sc.clip.media !== 'youtube') return
  sc.histP = api('/laughs/' + encodeURIComponent(sc.clip.id)).then((r) => {
    if (!r.ok || !Array.isArray(r.j?.bins)) return
    const bins = r.j.bins.map((x) => Number(x) || 0)
    for (const l of laughsAll()) if (l.clip === sc.clip.id) { const k = Math.floor(l.t); if (bins[k] > 0) bins[k]-- }
    sc.hist = bins; sc.histMax = Math.max(1, bins.reduce((m, x) => Math.max(m, x), 0))
  }).catch(() => {})
}
function crowdTick(sc) {
  if (!LAUGHS_ENABLED || !sc?.hist || !crowdLaughsOn() || reduced() || !sc.playing()) { if (sc) sc.lastSec = null; return }
  const s = Math.floor(sc.t())
  if (sc.lastSec == null || s < sc.lastSec || s - sc.lastSec > 3) sc.lastSec = s - 1
  for (let k = sc.lastSec + 1; k <= s; k++) {
    const c = sc.hist[k] || 0; if (!c) continue
    const n = Math.min(6, Math.max(1, Math.round((6 * c) / sc.histMax)))
    for (let i = 0; i < n; i++) particle('crowd', Math.round((i * 900) / n))
  }
  sc.lastSec = s
}
function paintCrowdBtn() {
  if (!LAUGHS_ENABLED) return
  const b = $('#crowdbtn'); if (!b) return
  const on = crowdLaughsOn()
  b.setAttribute('aria-pressed', String(on)); b.classList.toggle('off', !on)
  b.title = on ? 'Crowd laughs on' : 'Crowd laughs off'; b.setAttribute('aria-label', on ? 'Crowd laughs: on (tap to hide)' : 'Crowd laughs: off (tap to show)')
}
function toggleCrowd() {
  if (!LAUGHS_ENABLED) return
  LS.set('crowdLaughs', !crowdLaughsOn()); paintCrowdBtn()
  if (!crowdLaughsOn()) document.querySelectorAll('.lp.crowd').forEach((x) => x.remove())
  toast(crowdLaughsOn() ? 'Crowd laughs on.' : 'Crowd laughs off.'); showChrome()
}

// ---------- the screening: intro face-off -> clip ONE full screen -> clip TWO -> 3s ballot ----------
// stages: intro | left | right | vote | done
const VOTE_MS = 7000, INTRO_MS = 2500, VOTE_RESUME_MIN = 2500
let screens = {}, stage = 'idle', tick = null, armed = false, armedAt = 0, prediction = null
let cur = null, nScreen = 0, timers = [], userStarted = false, moving = false
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
const later = (f, ms) => { const t = setTimeout(f, ms); timers.push(t); return t }
const clearTimers = () => { timers.forEach(clearTimeout); timers = [] }
const q = (sel) => cur?.el?.querySelector(sel) || null
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
function signals() {
  // what the screening tells us about this pick, without asking
  const L = screens.L, R = screens.R, out = {}
  if (!L || !R) return out
  const r1 = (x) => Math.round(x * 10) / 10
  out.leftWatchedSec = r1(L.watched || 0); out.rightWatchedSec = r1(R.watched || 0)
  try { out.rightFrac = Math.round(100 * Math.min(1, (R.watched || 0) / R.screened())) / 100 } catch {}
  out.replayed = (L.replays || 0) + (R.replays || 0) > 0
  out.replays = (L.replays || 0) + (R.replays || 0)
  out.skippedAhead = !!(L.jumped || R.jumped)
  if (L.skipped) out.leftSkipped = true
  if (R.skipped) out.rightSkipped = true
  for (const [k, S] of [['left', L], ['right', R]]) {
    if (S.seekT?.length) { out[k + 'SeekTargets'] = [...S.seekT]; out[k + 'SeekFrom'] = [...(S.seekF || [])] }
    if (Number.isFinite(S.skippedAt)) out[k + 'SkippedAt'] = S.skippedAt
  }
  return out
}
// the watch signals as sent to the API and the AT Protocol record (lexicon `signals`): whole seconds, all optional
const SIG_INT = ['leftWatchedSec', 'rightWatchedSec', 'replays', 'leftSkippedAt', 'rightSkippedAt']
const SIG_ARR = ['leftSeekTargets', 'leftSeekFrom', 'rightSeekTargets', 'rightSeekFrom']
const SIG_BOOL = ['skippedAhead', 'leftSkipped', 'rightSkipped']
function sigPayload(v) {
  if (!v || typeof v !== 'object') return undefined
  const o = {}
  for (const k of SIG_INT) if (Number.isFinite(v[k]) && v[k] >= 0) o[k] = Math.min(36000, Math.round(v[k]))
  if (Number.isFinite(v.rightFrac)) o.rightPct = clamp(Math.round(100 * v.rightFrac), 0, 100)
  for (const k of SIG_ARR) if (Array.isArray(v[k]) && v[k].length) o[k] = v[k].slice(0, 20).map((x) => Math.max(0, Math.min(36000, Math.round(Number(x) || 0))))
  for (const k of SIG_BOOL) if (v[k]) o[k] = true
  return Object.keys(o).length ? o : undefined
}
function chip(c) { return c.kind === 'ai' ? '<span class="chip ai">AI</span>' : '' }
function crowdOf(comic) { const c = BOARD?.boards?.all?.comics?.find((x) => x.comic === comic && x.bouts); return c ? Math.round(c.elo) : null }
// the face-off card: the clip's own thumbnail is the main event (authentic: it's the set you're about to see).
// Caption sits BELOW the picture; nothing is laid over it. YouTube's 16:9 hq720 still (no letterbox bars), falling back
// to hqdefault (4:3 with bars, zoomed to hide them). Only non-YouTube clips use the comic's comics.json photo, if any.
function faceCard(c, side) {
  const P = COMICS[c.comic] || {}, r = crowdOf(c.comic)
  const photo = photoOf(P)
  const img = c.media === 'youtube'
    ? `<img class="fimg still" src="https://i.ytimg.com/vi/${esc(c.id)}/hq720.jpg" alt="${esc(c.comic)}: ${esc(c.title || '')}" decoding="async" onerror="this.onerror=null;this.classList.add('lb');this.src='${thumb(esc(c.id))}'">`
    : photo ? `<img class="fimg portrait" src="${esc(photo)}" alt="${esc(c.comic)}" decoding="async">`
      : `<span class="fimg none">${esc(c.comic)}</span>`
  return `<div class="face ${side}"><div class="fpic">${img}</div>
    <div class="ftext"><b>${esc(c.comic)}${chip(c)}</b><span>${esc(P.tagline || c.title || '')}</span><em>${r ? r + ' crowd rating' : 'Unrated'}</em></div></div>`
}
// the only label above the cards: who challenged you (shared links). Everything else stays quiet.
function introLine() {
  if (current?.mode !== 'shared') return ''
  const inv = sharedRound?.invite
  if (inv?.inviter?.username && !inv.self) return `<span class="challenge">${avatarHTML(inv.inviter)}<span><b>${esc(inv.inviter.username)}</b> challenged you</span></span>`
  return `<span class="challenge">${sharedRound?.pick ? 'A friend challenged you. Do you agree?' : 'A friend sent you this clash'}</span>`
}
function slideHTML(a, b, n, first) {
  const shot = (c, side) => `<button class="pick ${side}" data-side="${side}" aria-label="${esc(c.comic)} was funnier">
      <span class="pimg" ${c.media === 'youtube' ? `style="background-image:url(${thumb(c.id)})"` : ''}></span>
      <span class="pname">${esc(c.comic)}</span><span class="logo">FUNNIER</span></button>`
  // the clip fills the screen (16:9, letterboxed only where the aspect needs it). Name/title overlay the bottom-left in a
  // gradient that fades with the chrome; the progress bar is a thin line on the video's bottom edge (24px hit area).
  const scr = (c, side) => `<div class="screen ${side} small${fmtOf(c) === 'vertical' ? ' vert' : ''}" data-side="${side}">
      <div class="frame"><div class="yt" id="p${side}${n}"></div><div class="shield" aria-hidden="true"></div>
      <div class="label"><span class="side">${side === 'L' ? '1' : '2'}</span><div class="meta"><h3>${esc(c.comic)}${chip(c)}</h3><p>${esc(c.title)}${c.channel ? ' · ' + esc(c.channel) : ''}</p></div></div>
      <div class="prog" role="slider" tabindex="0" data-side="${side}" aria-label="Seek clip ${side === 'L' ? '1' : '2'}" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0" aria-valuetext="0:00"><span class="ptrack"><i></i></span><b class="pknob"></b></div>${sndBtnHTML()}${fsBtnHTML()}</div></div>`
  return `<div class="slide" data-n="${n}">
    <div class="intro">
      <div class="introbar">${introLine()}</div>
      <div class="faceoff">${faceCard(a, 'L')}<span class="vsx">VS</span>${faceCard(b, 'R')}</div>
      <div class="introfoot"></div>
    </div>
    <div class="theatre">${scr(a, 'L')}${scr(b, 'R')}${LAUGHS_ENABLED ? `<div class="lfx" aria-hidden="true"></div><button type="button" class="laughbtn" aria-label="Laugh (tap whenever it's funny)" title="Laugh">${LAUGH_SVG}</button>` : '' /* laugh button + particles: off */}<div class="peek" aria-hidden="true"><span class="pkimg" ${b.media === 'youtube' ? `style="background-image:url(${thumb(b.id)})"` : ''}></span><span class="pkcap"><b>#2</b> ${esc(b.comic)}</span></div></div>
    <div class="ballot"><p class="bq">Which was funnier?</p><div class="picks">${shot(a, 'L')}${shot(b, 'R')}</div>
      <div class="audiofb" role="group" aria-label="Sound level feedback"><span>Sound off?</span>${[['L', '#1'], ['R', '#2']].map(([sd, n]) => `<button type="button" data-aud="${sd}" data-k="loud">${n} too loud</button><button type="button" data-aud="${sd}" data-k="quiet">${n} too quiet</button>`).join('')}</div>
      <div class="vcount"><svg class="ring" viewBox="0 0 36 36" aria-hidden="true"><circle class="rbg" cx="18" cy="18" r="15.5"/><circle class="rfg" cx="18" cy="18" r="15.5" pathLength="100"/></svg><p class="hint">Tap one, or ← / →. No pick = pass.</p></div>
      <p class="friendres" aria-live="polite"></p></div>
  </div>`
}

function laneSelect() {
  const box = $('#lanebox'); if (!box) return
  box.innerHTML = `<select id="lane" aria-label="Lineup">${[['human', 'Human comics'], ['ai', 'AI comics'], ['mixed', 'Human vs AI']].map(([k, l]) => `<option value="${k}" ${LANE === k ? 'selected' : ''}>${l}</option>`).join('')}</select>`
  $('#lane').onchange = (e) => { LANE = e.target.value; LS.set('lane', LANE); goNext(null) }
}

function setStage(s) {
  stage = s
  if (cur?.el) cur.el.dataset.stage = s
  document.body.classList.toggle('in-theatre', s === 'left' || s === 'right')
  if (s === 'right') { // the peek now previews the ballot, not clip two
    const pk = q('.peek'); if (pk) pk.innerHTML = '<span class="pkimg pkvote">Which was funnier?</span><span class="pkcap"><b>Vote</b></span>'
  }
  paintRail()
  updateChrome()
}
function stopScreening() {
  clearInterval(tick); tick = null; clearTimers(); clearTimeout(advT); advT = null
  cancelAnimationFrame?.(progRaf); progRaf = 0
  Object.values(screens).forEach((s) => s.retire()); screens = {}; armed = false; armedAt = 0
  document.body.classList.remove('in-theatre')
}

// builds the next screening; when `old` is given, the old one slides up and away (TikTok-style)
function newRound(first) { mountScreening(first, null) }
function mountScreening(first, oldEl) {
  current = takeClash() || pickPair()
  if (current?.mode !== 'shared') sharedRound = null
  const host = $('#stage')
  if (!host) return
  if (!current) {
    const msg = LANE === 'ai' ? 'The AI comics are still in rehearsal. Their first sets premiere here soon.' : LANE === 'mixed' ? 'Human vs AI opens when the first AI sets premiere.' : "You've seen every clash on the bill. New shorts arrive daily."
    host.querySelectorAll('.slide').forEach((x) => x !== oldEl && x.remove())
    host.insertAdjacentHTML('beforeend', `<div class="slide empty-slide"><p class="empty">${msg}</p></div>`)
    finishSlide(host, oldEl); cur = { el: host.lastElementChild, n: ++nScreen }; setStage('done'); updateChrome()
    return
  }
  const [a, b] = current, n = ++nScreen
  let pE = null; try { pE = enginePredict(a.id, b.id) } catch {}
  const pL = pE != null ? pE : MODEL ? sig(MODEL.score(a.id) + traitScore(a) - MODEL.score(b.id) - traitScore(b)) : 0.5
  prediction = { p: pL, side: pL >= 0.5 ? 'L' : 'R', model: pE != null ? 'engine' : 'bt' }
  host.insertAdjacentHTML('beforeend', slideHTML(a, b, n, first))
  const el = host.lastElementChild
  cur = { el, n, a, b }
  finishSlide(host, oldEl)
  screens = { L: new Screen('L', a, 'pL' + n), R: new Screen('R', b, 'pR' + n) }
  screens.L.mate = screens.R; screens.R.mate = screens.L
  screens.L.mount(); screens.R.mount()
  prefetchLaughs(screens.L); prefetchLaughs(screens.R)
  setStage('intro')
  bindSlide(el)
  // the face-off: title card, then ONE flashes in, then TWO
  el.classList.add('show-title')
  later(() => el.classList.add('show-L'), reduced() ? 0 : 500)
  later(() => el.classList.add('show-R'), reduced() ? 0 : 1200)
  later(() => stage === 'intro' && cur?.el === el && startClip('L'), INTRO_MS) // never wait for a tap
  paintDaily()
}
function finishSlide(host, oldEl) {
  const el = host.lastElementChild
  if (!oldEl) { host.querySelectorAll('.slide').forEach((x) => x !== el && x.remove()); return }
  if (reduced()) { oldEl.remove(); return }
  el.classList.add('enter'); void el.offsetWidth
  const th = oldEl.querySelector('.theatre')
  if (th && (oldEl.dataset.stage === 'left' || oldEl.dataset.stage === 'right')) {
    th.style.transition = 'transform .45s cubic-bezier(.2,.8,.2,1),opacity .45s'
    th.style.transform = `translate3d(0,${-innerHeight}px,0)`; th.style.opacity = '0'
    oldEl.dataset.stage = 'leaving'; oldEl.classList.add('leave-fade')
  } else oldEl.classList.add('leave')
  el.classList.remove('enter')
  setTimeout(() => oldEl.remove(), 520)
}
function bindSlide(el) {
  el.querySelector('.intro').onclick = () => { if (stage === 'intro') { userStarted = true; startClip('L') } }
  el.querySelectorAll('.pick').forEach((x) => { // pointerup counts at once (touch, pen, mouse), click is the fallback (keyboard, a11y)
    let downAt = 0
    x.addEventListener('pointerdown', (e) => { downAt = now(); e.stopPropagation() })
    x.addEventListener('pointerup', (e) => { if (!downAt || now() - downAt > 1500) return; downAt = 0; e.stopPropagation(); vote(x.dataset.side) })
    x.addEventListener('pointercancel', () => (downAt = 0))
    x.onclick = (e) => { e.stopPropagation(); vote(x.dataset.side) }
  })
  const bal = el.querySelector('.ballot')
  if (bal) { // hover / touch on the ballot holds the countdown
    bal.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') { voteHover = true; holdCountdown() } })
    bal.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') { voteHover = false; resumeCountdown() } })
    bal.addEventListener('touchstart', () => { voteHover = true; holdCountdown() }, { passive: true })
    const lift = () => { voteHover = false; setTimeout(resumeCountdown, 600) }
    bal.addEventListener('touchend', lift, { passive: true }); bal.addEventListener('touchcancel', lift, { passive: true })
  }
  el.querySelectorAll('.shield').forEach((sh) => (sh.onclick = () => {
    if (now() - dragEndAt < 400) return // the tail of a swipe, not a tap
    if (tapRevealed) { tapRevealed = false; return } // chrome was hidden: this tap only brings it back
    screens[sh.closest('.screen').dataset.side]?.toggle()
  }))
  el.querySelectorAll('.prog').forEach(bindScrub)
  el.querySelectorAll('.vsnd').forEach((b) => {
    b.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true })
    b.addEventListener('pointerdown', (e) => e.stopPropagation())
    b.onclick = (e) => { e.stopPropagation(); e.preventDefault(); toggleSound() }
  })
  el.querySelectorAll('.vfs').forEach((b) => {
    b.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true }) // a tap on the toggle is never a swipe
    b.addEventListener('pointerdown', (e) => e.stopPropagation())
    b.onclick = (e) => { e.stopPropagation(); e.preventDefault(); toggleFullscreen() }
  })
  const lb = LAUGHS_ENABLED ? el.querySelector('.laughbtn') : null
  if (lb) {
    lb.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true }) // a laugh is never a swipe
    lb.addEventListener('pointerdown', (e) => e.stopPropagation())
    lb.onclick = (e) => { e.stopPropagation(); e.preventDefault(); laugh() }
  }
  el.querySelectorAll('[data-aud]').forEach((bt) => (bt.onclick = (e) => {
    e.stopPropagation()
    pauseBallot('Countdown paused. Pick when you\u2019re ready.')
    const sd = bt.dataset.aud, clip = sd === 'L' ? cur?.a : cur?.b
    audioFeedback(clip, bt.dataset.k)
    bt.parentElement?.querySelectorAll(`[data-aud="${sd}"]`).forEach((x) => (x.disabled = true)); bt.classList.add('on')
  }))
}
// ---------- progress bar: the screening window (start..end). One rAF loop paints the live clip's bar from its smoothed,
// monotonic clock (Screen.shownT); no CSS transition on the fill, so seeks/scrubs never animate backwards. Tap/drag to seek.
const mmss = (s) => { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + pad2(s % 60) }
let progRaf = 0
function progLoop() {
  if (progRaf) cancelAnimationFrame(progRaf)
  progRaf = 0
  if (typeof requestAnimationFrame !== 'function') return
  const el = cur?.el
  const step = () => {
    progRaf = 0
    if (!cur || cur.el !== el || !(stage === 'left' || stage === 'right')) return
    const side = stage === 'left' ? 'L' : 'R', pg = q(`.screen.${side} .prog`)
    if (pg && !pg.classList.contains('scrub')) paintProg(side)
    progRaf = requestAnimationFrame(step)
  }
  progRaf = requestAnimationFrame(step)
}
function paintProg(side, frac) {
  const sc = screens[side], pg = q(`.screen.${side} .prog`); if (!pg) return
  const f = clamp(frac != null ? frac : sc?.started ? sc.progress() : 0, 0, 1)
  const i = pg.querySelector('i'), k = pg.querySelector('.pknob')
  if (i) i.style.transform = `scaleX(${f.toFixed(4)})`
  if (k) k.style.left = (100 * f).toFixed(2) + '%'
  if (sc) {
    const w = Math.max(1, sc.end() - sc.start), key = Math.round(w) + '|' + Math.round(f * w)
    if (pg.dataset.aria !== key) { pg.dataset.aria = key; pg.setAttribute('aria-valuemax', String(Math.round(w))); pg.setAttribute('aria-valuenow', String(Math.round(f * w))); pg.setAttribute('aria-valuetext', mmss(f * w) + ' of ' + mmss(w)) }
  }
}
function bindScrub(pg) {
  const side = pg.dataset.side
  let drag = false, f = 0, lastSeek = 0
  const frac = (x) => { const r = pg.getBoundingClientRect(); return clamp((x - r.left) / Math.max(1, r.width), 0, 1) }
  const at = (fr) => { const sc = screens[side]; return sc ? sc.start + fr * (sc.end() - sc.start) : 0 }
  const down = (e) => {
    if (!screens[side] || (e.button != null && e.button > 0)) return
    e.stopPropagation(); if (e.cancelable) e.preventDefault()
    drag = true; pg.classList.add('scrub'); try { pg.setPointerCapture?.(e.pointerId) } catch {}
    f = frac(e.clientX); paintProg(side, f); showChrome()
  }
  const move = (e) => {
    if (!drag) return
    if (e.cancelable) e.preventDefault()
    f = frac(e.clientX); paintProg(side, f)
    if (now() - lastSeek > 250) { lastSeek = now(); screens[side]?.seek(at(f), false) }
  }
  const up = () => { if (!drag) return; drag = false; dragEndAt = now(); screens[side]?.seek(at(f), true); paintProg(side, f); setTimeout(() => pg.classList.remove('scrub'), 60) }
  pg.addEventListener('pointerdown', down); pg.addEventListener('pointermove', move)
  pg.addEventListener('pointerup', up); pg.addEventListener('pointercancel', up); pg.addEventListener('lostpointercapture', up)
  pg.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true }) // horizontal drag here is a scrub, never swipe-left
  pg.addEventListener('click', (e) => e.stopPropagation())
  pg.addEventListener('keydown', (e) => {
    const d = e.key === 'ArrowLeft' ? -5 : e.key === 'ArrowRight' ? 5 : 0; if (!d) return
    e.preventDefault(); e.stopPropagation(); screens[side]?.seekBy(d)
  })
}
// a tap on the ballot that isn't a pick (share, sound feedback) pauses the 3s countdown; that pick gets no timing signal
function pauseBallot(msg) {
  if (!(stage === 'vote' && armed)) return
  sharedDuringBallot = true; clearTimers(); voteHeld = true; holdCountdown()
  const h = q('.ballot .hint'); if (h) h.textContent = msg
}
// "Not funny -> next": ends the clip on screen but stays in the clash. Clip ONE -> clip TWO; clip TWO -> the ballot.
// Logged in funnier.skips as stage 'left-skip' / 'right-skip' and counted as 0.4 of a loss for that clip, its comic and styles.
function skipClip() {
  if (!current || !cur || moving || (stage !== 'left' && stage !== 'right')) return false
  const side = stage === 'left' ? 'L' : 'R', sc = screens[side]; if (!sc) return false
  sc.track(); sc.skipped = true; try { sc.skippedAt = Math.round(sc.t()) } catch {} sc.fadePause()
  const c = sc.clip, [a, b] = current
  const rec = { a: a.id, b: b.id, stage: side === 'L' ? 'left-skip' : 'right-skip', comics: [c.comic], comic: c.comic, clip: c.id, ...(current.daily ? { daily: current.daily } : {}),
    style: Array.isArray(c.style) ? c.style : [], watchedSec: Math.round(10 * (sc.watched || 0)) / 10, ...signals(), at: new Date().toISOString() }
  LS.set('skips', [...LS.get('skips', []), rec].slice(-500)); queueEvents()
  try { MODEL = fitLocal(); TRAITS = fitTraits() } catch {}
  engineLearn({ kind: 'skip', clip: c.id, a: a.id, b: b.id, at: rec.skippedAt ?? rec.leftSkippedAt ?? rec.rightSkippedAt })
  if (side === 'L') { toast('Skipped to #2. Noted against that clip.'); startClip('R') } else startVote()
  return true
}

function startClip(side) {
  if (!cur || !screens[side]) return
  clearTimers()
  setStage(side === 'L' ? 'left' : 'right')
  bumpShown(screens[side].clip.comic)
  for (const s of ['L', 'R']) {
    const sc = cur.el.querySelector(`.screen.${s}`)
    sc?.classList.toggle('big', s === side); sc?.classList.toggle('small', s !== side)
    sc?.classList.toggle('gone', side === 'R' && s === 'L')
  }
  if (side === 'R') screens.L.fadePause()
  screens[side].play()
  runTick()
}
function runTick() {
  progLoop()
  clearInterval(tick)
  tick = setInterval(() => {
    const L = screens.L, R = screens.R; if (!L || !R || !cur) return
    for (const s of ['L', 'R']) {
      const sc = screens[s]; sc.track()
      const live = (stage === 'left' && s === 'L') || (stage === 'right' && s === 'R')
      if (!live && !cur.el.querySelector(`.screen.${s} .prog`)?.classList.contains('scrub')) paintProg(s)
    }
    crowdTick(stage === 'left' ? L : stage === 'right' ? R : null)
    // keyboard focus gets swallowed by the YouTube iframe: take it back
    const ae = document.activeElement
    if (ae && ae.tagName === 'IFRAME') { try { ae.blur() } catch {} $('#stage')?.focus?.({ preventScroll: true }) }
    if (stage === 'left' && L.done()) { L.fadePause(); startClip('R') }
    else if (stage === 'right' && R.done()) { R.fadePause(); startVote() }
  }, 250)
}
function startVote() {
  clearInterval(tick); tick = null; cancelAnimationFrame?.(progRaf); progRaf = 0
  setStage('vote')
  markDailyDone() // watched it through to the ballot
  armed = true; armedAt = now(); sharedDuringBallot = false // decision time runs from the moment the FUNNIER logos appear
  voteLeft = VOTE_MS; voteHeld = false; voteHover = false
  runCountdown()
}
// the ballot countdown: a thin ring that drains over VOTE_MS. It holds while the pointer or a finger is on the ballot
// (or after a sound-feedback tap) and resumes with at least VOTE_RESUME_MIN left. No pick when it empties = a pass.
let voteLeft = 0, voteT0 = 0, voteT = null, voteHeld = false, voteHover = false
function ringEl() { return q('.ballot .ring .rfg') }
function runCountdown() {
  clearTimeout(voteT); voteT0 = now()
  const r = ringEl(), frac = voteLeft / VOTE_MS
  if (r) { r.style.transition = 'none'; r.style.strokeDashoffset = String(100 * (1 - frac)); void r.getBoundingClientRect?.(); r.style.transition = `stroke-dashoffset ${voteLeft}ms linear`; r.style.strokeDashoffset = '100' }
  voteT = setTimeout(() => { voteT = null; if (stage === 'vote' && armed) pass() }, voteLeft + 60)
}
function holdCountdown() {
  if (!(stage === 'vote' && armed) || voteT == null) return
  clearTimeout(voteT); voteT = null
  voteLeft = Math.max(0, voteLeft - (now() - voteT0))
  const r = ringEl(); if (r) { r.style.transition = 'none'; r.style.strokeDashoffset = String(100 * (1 - voteLeft / VOTE_MS)) }
  q('.ballot')?.classList.add('held')
}
function resumeCountdown() {
  if (!(stage === 'vote' && armed) || voteT != null || voteHeld || voteHover) return
  voteLeft = Math.max(voteLeft, VOTE_RESUME_MIN); q('.ballot')?.classList.remove('held'); runCountdown()
}
function pass() {
  if (!current) return
  const [a, b] = current
  armed = false
  LS.set('passes', [...LS.get('passes', []), { a: a.id, b: b.id, ...signals(), ...(current.daily ? { daily: current.daily } : {}), at: new Date().toISOString() }].slice(-300)); queueEvents()
  LS.set('skipped', [...LS.get('skipped', []), pairKey(a.id, b.id)].slice(-500)); bumpSeen(a.id, b.id)
  toast('No pick, so it\u2019s a pass. Neither comic loses anything.')
  goNext(null); paintHistory()
}

// swipe up / wheel / ArrowUp / PageDown / S / the rail's Skip: leave this screening at any stage
function skipClash() {
  if (!current || moving || stage === 'done' || stage === 'idle') return goNext(null)
  const [a, b] = current
  const on = stage === 'left' ? [a] : stage === 'right' ? [b] : stage === 'vote' ? [a, b] : []
  const sc = stage === 'left' ? screens.L : stage === 'right' ? screens.R : null
  if (sc) { try { sc.track(); sc.skippedAt = Math.round(sc.t()) } catch {} }
  const sg = signals()
  const rec = { a: a.id, b: b.id, stage, comics: on.map((c) => c.comic), clip: sc ? sc.clip.id : null,
    watchedSec: sc ? Math.round(10 * (sc.watched || 0)) / 10 : 0, ...sg, ...(current.daily ? { daily: current.daily } : {}), at: new Date().toISOString() }
  if (stage === 'vote' && armedAt) rec.decisionMs = Math.round(now() - armedAt)
  LS.set('skips', [...LS.get('skips', []), rec].slice(-500)); queueEvents()
  LS.set('skipped', [...LS.get('skipped', []), pairKey(a.id, b.id)].slice(-500)); bumpSeen(a.id, b.id)
  if (sc) { MODEL = fitLocal(); TRAITS = fitTraits(); paintYou(); if (skipW(rec) > 0) engineLearn({ kind: 'skip', clip: sc.clip.id, a: a.id, b: b.id, at: sc.skippedAt }) }
  goNext(null); paintHistory()
}
function goNext() {
  if (moving) return
  moving = true; setTimeout(() => (moving = false), 650)
  if (laughDirty) { laughDirty = false; try { MODEL = fitLocal(); TRAITS = fitTraits(); paintYou() } catch {} }
  const oldEl = cur?.el || null
  stopScreening()
  mountScreening(false, oldEl)
}
function bumpShown(comic) { const s = LS.get('shown', {}); s[comic] = (s[comic] || 0) + 1; LS.set('shown', s) }

async function vote(side) {
  if (!current || !armed || stage !== 'vote') return
  armed = false; setStage('done'); markDailyDone()
  const [a, b] = current
  const decisionMs = armedAt && !sharedDuringBallot ? Math.max(0, Math.round(now() - armedAt)) : undefined
  const sg = signals()
  const v = { a: a.id, b: b.id, winner: side === 'L' ? a.id : b.id, voter: 'human', basis: 'watched', mode: current.mode, decisionMs, ...sg, createdAt: new Date().toISOString() }
  if (current.mode === 'daily' && DAY_RE.test(String(current.daily || ''))) v.daily = current.daily
  v.weight = voteWeight(v)
  q(`.pick.${side}`)?.classList.add('won')
  bumpSeen(a.id, b.id)
  const fl = friendLine(a, b, v.winner)
  if (fl) { v.friend = fl.agree ? 'agree' : 'disagree'; const fe = q('.friendres'); if (fe) { fe.textContent = fl.text; fe.classList.add('on', fl.agree ? 'agree' : 'disagree') } }
  if (v.daily) loadDailyResults().then(() => { paintDaily(); const w = $('#why .rcworld'); const D = dailyFor(v.daily); if (w && D) w.innerHTML = worldLine(D) }).catch(() => {})
  // the watch minimum still applies: both clips at least ~30s (or to the end)
  const okL = screens.L?.skipped || screens.L?.enough(), okR = screens.R?.skipped || screens.R?.enough()
  if (!(okL && okR) || (screens.L?.skipped && screens.R?.skipped)) {
    LS.set('partials', [...LS.get('partials', []), v].slice(-300))
    toast('It only counts when both clips were watched for 30s or to the end.')
    askWhy(v, true, fl)
    scheduleAdvance(fl ? 2400 : v.daily ? 1600 : 700)
    paintDaily(); paintHistory()
    return
  }
  // latest pick per pair counts (same rule as the public tally), so a rewatch replaces the old pick
  LS.set('votes', [...LS.get('votes', []).filter((x) => !x || pairKey(x.a, x.b) !== pairKey(a.id, b.id)), v])
  const preds = LS.get('preds', []); preds.push({ p: prediction.p, hit: prediction.side === side, m: prediction.model }); LS.set('preds', preds.slice(-200))
  engineLearn({ kind: 'vote', a: a.id, b: b.id, winner: v.winner, p: Math.round(1000 * (side === 'L' ? prediction.p : 1 - prediction.p)) / 1000, hit: prediction.side === side,
    rewound: (side === 'L' ? v.leftSeekTargets : v.rightSeekTargets)?.length ? v.winner : null })
  const dur = LS.get('dur', {}); dur[a.id] = screens.L.dur(); dur[b.id] = screens.R.dur(); LS.set('dur', dur)
  const guess = MODEL && MODEL.n >= 3 ? (prediction.side === side ? ' Your model called it.' : ' Your model guessed the other one.') : ''
  scheduleAdvance(fl ? 2400 : v.daily ? 1600 : reduced() ? 300 : 900)
  askWhy(v, false, fl, guess.trim())
  if (agent) {
    try { await publish(v) }
    catch { LS.set('queue', [...LS.get('queue', []), v]); toast('Saved. It\u2019ll publish when Bluesky responds.') }
  } else LS.set('queue', [...LS.get('queue', []), v].slice(-300))
  MODEL = fitLocal(); TRAITS = fitTraits(); chartChanged()
  paintBanner(); paintYou(); paintDaily(); paintHistory()
}
const arenaOn = () => !$('#v-arena')?.hidden
document.addEventListener('keydown', (e) => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) || !arenaOn()) return
  if (e.metaKey || e.ctrlKey || e.altKey) return
  if ((stage === 'left' || stage === 'right') && [',', '.', 'j', 'J', 'l', 'L'].includes(e.key)) { // -10s / +10s inside the window
    e.preventDefault(); const sc = screens[stage === 'left' ? 'L' : 'R']; sc?.seekBy(e.key === '.' || e.key === 'l' || e.key === 'L' ? 10 : -10); paintProg(sc?.side); showChrome(); return
  }
  if ((e.key === 'ArrowRight' || e.key === 'n' || e.key === 'N') && (stage === 'left' || stage === 'right')) { e.preventDefault(); skipClip() }
  else if (e.key === 'ArrowLeft') vote('L')
  else if (e.key === 'ArrowRight') vote('R')
  else if (e.key === 'ArrowUp' || e.key === 'PageDown' || e.key === 's' || e.key === 'S') { e.preventDefault(); skipClash() }
  else if (e.key === 'f' || e.key === 'F') { e.preventDefault(); toggleFullscreen() }
  else if ((e.key === 'm' || e.key === 'M') && (stage === 'left' || stage === 'right')) { e.preventDefault(); toggleSound() }
  else if ((e.key === ' ' || e.key === 'Enter') && stage === 'intro' && e.target === document.body) { e.preventDefault(); userStarted = true; startClip('L') }
})
// ---------- gestures: drag up = next clash, drag left = the opponent. The stage follows the finger (transforms only). ----------
let dragEndAt = 0, committing = false
const isClip = () => stage === 'left' || stage === 'right'
function dragLayer() { // what moves under the finger on a vertical drag
  if (!cur?.el) return null
  return cur.el.querySelector(isClip() ? '.theatre' : stage === 'intro' ? '.intro' : '.ballot') || cur.el
}
function setPull(p, armedUp) { // the next face-off card rising from the bottom
  const pn = $('#pullnext'); if (!pn) return
  clearTimeout(pn._hideT)
  if (p == null) { // springs back below the edge, then is hidden outright (never a sliver left on the bottom edge)
    pn.style.transition = 'transform .35s cubic-bezier(.2,.9,.3,1),opacity .3s'; pn.style.transform = ''; pn.style.opacity = ''; pn.classList.remove('armed')
    pn._hideT = setTimeout(() => { pn.style.visibility = '' }, 380); return
  }
  pn.style.visibility = 'visible'; pn.style.transition = 'none'
  pn.style.transform = `translate3d(-50%,${Math.round((1 - Math.min(1, p)) * 100)}%,0)`
  pn.style.opacity = String(Math.min(1, p * 1.6)); pn.classList.toggle('armed', !!armedUp)
}
function bindGestures() {
  const stageEl = $('#stage'); if (!stageEl) return
  let x0 = 0, y0 = 0, t0 = 0, lx = 0, ly = 0, lt = 0, vx = 0, vy = 0, axis = null, active = false, raf = 0, dx = 0, dy = 0
  let tgt = null, scr = null, peek = null
  const H = () => innerHeight || 800, W = () => innerWidth || 800
  const rubber = (d, lim) => (d * 0.9) / (1 + Math.abs(d) / (lim * 1.4)) // more resistance the further you pull
  const clear = (els) => els.forEach((x) => { if (x) { x.style.transition = ''; x.style.transform = ''; x.style.opacity = '' } })
  const spring = (els) => {
    els.forEach((x) => { if (x) { x.style.transition = 'transform .38s cubic-bezier(.2,.9,.3,1.15),opacity .3s'; x.style.transform = ''; x.style.opacity = '' } })
    setTimeout(() => els.forEach((x) => x && (x.style.transition = '')), 420)
  }
  const paint = () => {
    raf = 0
    if (axis === 'y' && tgt) {
      const up = Math.min(0, dy), off = rubber(up, H())
      tgt.style.transform = `translate3d(0,${off}px,0)`
      setPull(-up / (H() * 0.25), -up > H() * 0.25)
    } else if (axis === 'x' && scr) {
      const l = Math.min(0, dx), off = rubber(l, W())
      scr.style.transform = `translate3d(${off}px,0,0)`
      if (peek) peek.style.transform = `translate3d(${Math.max(-peek.offsetWidth - 24, off * 0.7)}px,-50%,0)`
    }
  }
  const begin = (t) => { x0 = lx = t.clientX; y0 = ly = t.clientY; t0 = lt = now(); vx = vy = 0; axis = null; active = true; dx = dy = 0 }
  stageEl.addEventListener('touchstart', (e) => {
    if (!arenaOn() || !screeningActive() || committing || moving || e.touches.length > 1) { active = false; return }
    if (e.target?.closest?.('.prog, .laughbtn, .vfs, .ballot button, .pick, .why')) { active = false; return } // scrub / laugh / a button, not a swipe
    begin(e.touches[0])
  }, { passive: true })
  stageEl.addEventListener('touchmove', (e) => {
    if (!active) return
    const t = e.touches[0]; if (!t) return
    const n = now(), dt = Math.max(1, n - lt)
    vx = 0.7 * vx + 0.3 * ((t.clientX - lx) / dt); vy = 0.7 * vy + 0.3 * ((t.clientY - ly) / dt); lx = t.clientX; ly = t.clientY; lt = n
    dx = t.clientX - x0; dy = t.clientY - y0
    if (!axis) {
      if (Math.hypot(dx, dy) < 10) return
      if (dy < 0 && -dy > 1.2 * Math.abs(dx)) axis = 'y'
      else if (dx < 0 && -dx > 1.2 * Math.abs(dy) && isClip()) axis = 'x'
      else { axis = 'none'; return }
      if (!reduced()) {
        if (axis === 'y') { tgt = dragLayer(); if (tgt) tgt.style.transition = 'none' }
        else { scr = cur?.el?.querySelector('.screen.big'); peek = cur?.el?.querySelector('.peek'); [scr, peek].forEach((x) => x && (x.style.transition = 'none')) }
      }
    }
    if (axis === 'none') return
    if (e.cancelable) e.preventDefault()
    if (!reduced() && !raf) raf = requestAnimationFrame(paint)
  }, { passive: false })
  const end = () => {
    if (!active) return
    active = false
    if (raf) { cancelAnimationFrame(raf); raf = 0 }
    if (!axis || axis === 'none') return
    dragEndAt = now(); tapRevealed = false
    const fast = (v, d) => v < -0.55 && d < -40
    if (axis === 'y') {
      const go = -dy > H() * 0.25 || fast(vy, dy)
      const el = tgt; tgt = null
      if (go) {
        setPull(null)
        // the layer keeps its offset; the leaving slide (or theatre) carries on from there
        skipClash()
      } else { spring([el]); setPull(null) }
    } else if (axis === 'x') {
      const go = -dx > W() * 0.25 || fast(vx, dx)
      const s1 = scr, pk = peek; scr = peek = null
      if (!go) { spring([s1, pk]); return }
      if (reduced() || !s1) { clear([s1, pk]); skipClip(); return }
      committing = true
      s1.style.transition = 'transform .28s cubic-bezier(.3,.7,.2,1)'; s1.style.transform = `translate3d(${-W()}px,0,0)`
      if (pk) { pk.style.transition = 'transform .28s cubic-bezier(.3,.7,.2,1),opacity .28s'; pk.style.transform = `translate3d(${-(W() + pk.offsetWidth) / 2}px,-50%,0)` }
      setTimeout(() => {
        committing = false
        skipClip()
        if (pk) pk.style.opacity = '0'
        requestAnimationFrame(() => { clear([s1]); setTimeout(() => clear([pk]), 320) })
      }, 270)
    }
  }
  stageEl.addEventListener('touchend', end, { passive: true })
  stageEl.addEventListener('touchcancel', () => { if (!active) return; active = false; spring([tgt, scr, peek]); setPull(null); tgt = scr = peek = null }, { passive: true })
  // wheel (mouse or trackpad, either direction, as before): one notch-burst = one skip
  let acc = 0, accT = 0
  stageEl.addEventListener('wheel', (e) => {
    if (!arenaOn() || !screeningActive()) return
    e.preventDefault()
    if (now() - accT > 400) acc = 0
    acc += Math.abs(e.deltaY); accT = now()
    if (acc > 120) { acc = -1e9; skipClash(); setTimeout(() => (acc = 0), 900) }
  }, { passive: false })
  const gs = $('#gskip'); if (gs) gs.onclick = (e) => { e.stopPropagation(); skipClash() }
  const go = $('#gopp'); if (go) go.onclick = (e) => { e.stopPropagation(); skipClip() }
}
// the right-edge rail: faint glyphs. One gentle pulse on the very first screening ever, then near-invisible unless the mouse moves.
let railT = null
function paintRail() {
  const r = $('#gest'); if (!r) return
  r.dataset.stage = stage
  const o = $('#gopp')
  if (o) {
    o.hidden = !isClip()
    o.setAttribute('aria-label', stage === 'right' ? 'Skip to the vote (swipe left, N)' : 'Watch the opponent (swipe left, N)')
    o.title = stage === 'right' ? 'To the vote (swipe left)' : 'Opponent (swipe left)'
  }
  if (stage === 'left' && !LS.get('gestHinted', false)) {
    LS.set('gestHinted', true)
    if (!reduced()) { r.classList.add('pulse'); clearTimeout(railT); railT = setTimeout(() => r.classList.remove('pulse'), 3200) }
  }
}

// ---------- fullscreen: the whole screening (intro, both clips, ballot) in the Fullscreen API; CSS pseudo-fullscreen on iPhone ----------
let fsPseudo = false, escBusy = false
const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement || null
const fsNative = () => { const de = document.documentElement; return !!(document.fullscreenEnabled || document.webkitFullscreenEnabled) && !!(de.requestFullscreen || de.webkitRequestFullscreen) }
const fsOn = () => !!fsEl() || fsPseudo
const FS_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>'
const FS_EXIT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>'
// the toggle lives in the theatre, bottom-right of the video (YouTube-style), one per screen; it fades with the chrome
function fsBtnHTML() {
  const on = fsOn(), l = on ? 'Exit fullscreen (F)' : 'Fullscreen (F)'
  return `<button type="button" class="vfs" aria-pressed="${on}" aria-label="${l}" title="${l}">${on ? FS_EXIT : FS_ICON}</button>`
}
function paintFs() {
  const on = fsOn()
  document.body.classList.toggle('fs', on); document.body.classList.toggle('fs-pseudo', fsPseudo && !fsEl())
  document.querySelectorAll('.vfs').forEach((b) => {
    b.innerHTML = on ? FS_EXIT : FS_ICON; b.setAttribute('aria-pressed', String(on))
    b.setAttribute('aria-label', on ? 'Exit fullscreen (F)' : 'Fullscreen (F)'); b.title = on ? 'Exit fullscreen (F)' : 'Fullscreen (F)'
  })
}
async function enterNative() {
  const de = document.documentElement
  try { await (de.requestFullscreen ? de.requestFullscreen({ navigationUI: 'hide' }) : de.webkitRequestFullscreen()); fsPseudo = false; return true } catch { return false }
}
function fsTip() {
  if (LS.get('fsTip', false) || (typeof navigator !== 'undefined' && navigator.standalone)) return
  LS.set('fsTip', true); toast('Tip: Share → Add to Home Screen gives Funnier the whole screen.')
}
async function setFullscreen(on) {
  LS.set('fs', !!on)
  if (on) {
    if (fsNative()) { if (!fsEl() && !(await enterNative())) fsPseudo = true }
    else { fsPseudo = true; fsTip() }
  } else {
    fsPseudo = false
    if (fsEl()) { try { await (document.exitFullscreen ? document.exitFullscreen() : document.webkitExitFullscreen()) } catch {} }
  }
  paintFs(); showChrome()
}
function toggleFullscreen() { return setFullscreen(!fsOn()) }
function bindFullscreen() {
  const onChange = () => { if (!fsEl() && !fsPseudo) LS.set('fs', false); paintFs() } // Esc out of real fullscreen = preference off
  document.addEventListener('fullscreenchange', onChange); document.addEventListener('webkitfullscreenchange', onChange)
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') escBusy = menuOpen() || !($('#sheet')?.hidden ?? true) }, { capture: true })
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && fsPseudo && !fsEl() && !escBusy) setFullscreen(false) })
  if (LS.get('fs', false)) { // remembered: lay out fullscreen now; real fullscreen needs a gesture, so take the first one
    fsPseudo = true; paintFs()
    if (fsNative()) {
      const up = () => { removeEventListener('pointerdown', up, true); removeEventListener('keydown', up, true); if (LS.get('fs', false) && !fsEl()) enterNative().then(paintFs) }
      addEventListener('pointerdown', up, true); addEventListener('keydown', up, true)
    }
  } else paintFs()
}

// ---------- charts ----------
const thumb = (id) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`
function clipTile(c, i, extra) {
  const k = BYID[c.id] || c
  const img = k.media === 'youtube' ? `<img loading="lazy" src="${thumb(k.id)}" alt="">` : `<div class="comicposter" style="aspect-ratio:16/9"><b>${esc(k.comic)}</b></div>`
  const href = k.media === 'youtube' ? `https://www.youtube.com/watch?v=${k.id}` : '#'
  return `<a class="tile" href="${href}" target="_blank" rel="noopener">${i != null ? `<span class="num">${i + 1}</span>` : ''}
    <div class="poster">${img}<div class="cap"><b>${esc(k.title)}</b><span>${esc(k.comic)}${extra ? ' · ' + extra : ''}</span></div></div></a>`
}
function comicTile(c, i, extra) {
  const first = CLIPS.find((k) => k.comic === c.comic && k.media === 'youtube')
  const bg = first ? `style="background-image:linear-gradient(180deg,rgba(7,7,10,.1),rgba(7,7,10,.95) 75%),url(${thumb(first.id)})"` : ''
  return `<div class="tile"><span class="num">${i + 1}</span><div class="poster comicposter" ${bg}><b>${esc(c.comic)}</b><span class="rating">${extra}</span></div></div>`
}
function paintBoards() {
  const metas = document.querySelectorAll('.boardmeta')
  const sel = `<div class="lanes">${[['all', 'Everyone'], ['human', 'Humans'], ['agent', 'Agents']].map(([k, l]) => `<button data-board="${k}" class="${BOARDKIND === k ? 'on' : ''}">${l}</button>`).join('')}</div>`
  document.querySelectorAll('.boardsel').forEach((x) => (x.innerHTML = sel))
  document.querySelectorAll('[data-board]').forEach((x) => (x.onclick = () => { BOARDKIND = x.dataset.board; paintBoards() }))
  const bd = BOARD?.boards?.[BOARDKIND]
  if (!bd || !bd.votes) {
    metas.forEach((m) => (m.textContent = BOARDKIND === 'agent' ? 'No agent picks yet. Agents vote through the AT Protocol API.' : 'The chart opens with the first published picks. Until then, here is everything in rotation.'))
    const comics = [...new Set(CLIPS.map((c) => c.comic))]
    $('#comics').innerHTML = comics.map((k, i) => comicTile({ comic: k }, i, CLIPS.filter((c) => c.comic === k).length + ' shorts')).join('')
    $('#clips').innerHTML = CLIPS.map((c) => clipTile(c, null, c.channel)).join('')
    return
  }
  const ago = Math.max(0, Math.round((Date.now() - Date.parse(BOARD.updated)) / 60000))
  metas.forEach((m) => (m.textContent = `${bd.votes} picks from ${bd.voters} account${bd.voters === 1 ? '' : 's'} · Bradley-Terry ratings with 95% ranges · updated ${isNaN(ago) ? 'recently' : ago + ' min ago'}`))
  const rng = (r) => (r.lo != null ? ` (${Math.round(r.lo)}–${Math.round(r.hi)})` : '')
  $('#comics').innerHTML = bd.comics.filter((c) => c.bouts).map((c, i) => comicTile(c, i, Math.round(c.elo) + rng(c))).join('')
  $('#clips').innerHTML = bd.clips.filter((c) => c.bouts && BYID[c.id]).slice(0, 10).map((c, i) => clipTile(c, i, Math.round(c.elo))).join('')
}

// ---------- comics ----------
// rights-cleared portraits (Wikimedia Commons, CC BY / BY-SA / CC0 / PD) committed under site/img, with attribution
const photoOf = (P) => (typeof P?.photo === 'string' && (/^https:\/\//.test(P.photo) || /^img\/[a-z0-9-]+\.(jpe?g|png|webp)$/.test(P.photo)) ? P.photo : '')
function photoCredit(P) {
  if (!photoOf(P) || !P.photoCredit) return ''
  const lic = P.photoLicense ? (P.photoLicenseUrl ? ` / <a href="${esc(P.photoLicenseUrl)}" target="_blank" rel="noopener license">${esc(P.photoLicense)}</a>` : ' / ' + esc(P.photoLicense)) : ''
  const who = P.photoSource ? `<a href="${esc(P.photoSource)}" target="_blank" rel="noopener">${esc(P.photoCredit)}</a>` : esc(P.photoCredit)
  return `<p class="pcredit">Photo: ${who}${lic}${P.photoNote && P.photoNote !== 'unmodified' ? ', ' + esc(P.photoNote) : ''}</p>`
}
const slugOf = (name) => COMICS[name]?.slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
function comicStats(name) {
  const bd = BOARD?.boards?.all, crowd = bd?.comics?.find((c) => c.comic === name && c.bouts)
  const mine = MODEL ? Math.round(1500 + SCALE * (MODEL.r[name] || 0)) : null
  const clips = CLIPS.filter((c) => c.comic === name)
  const rated = clips.map((c) => ({ c, r: bd?.clips?.find((x) => x.id === c.id && x.bouts) })).sort((a, b) => (b.r?.elo || 0) - (a.r?.elo || 0))
  const styles = {}; clips.forEach((c) => (c.style || []).forEach((t) => (styles[t] = (styles[t] || 0) + 1)))
  // head-to-head from published + local picks
  const h2h = {}
  for (const v of [...PUBVOTES, ...LS.get('votes', [])]) {
    const A = BYID[v.a]?.comic, B = BYID[v.b]?.comic; if (!A || !B || A === B || (A !== name && B !== name)) continue
    const opp = A === name ? B : A, won = BYID[v.winner]?.comic === name
    h2h[opp] = h2h[opp] || { w: 0, n: 0 }; h2h[opp].n++; if (won) h2h[opp].w++
  }
  return { crowd, mine, clips, rated, styles: Object.entries(styles).sort((a, b) => b[1] - a[1]).map((x) => x[0]), h2h }
}
function paintComics() {
  const el = $('#comicsview'), route = location.hash.match(/^#comic\/(.+)$/)
  const names = [...new Set(CLIPS.map((c) => c.comic))]
  if (route) {
    const name = names.find((n) => slugOf(n) === route[1])
    if (name) return paintProfile(el, name)
  }
  el.innerHTML = `<div class="head"><h2>Comics</h2></div><p class="muted">Tap a comic for their profile, best-rated shorts and head-to-heads.</p>
    <div class="grid">${names.map((n) => { const st = comicStats(n), first = st.clips.find((k) => k.media === 'youtube')
      const ph = photoOf(COMICS[n]), fb = first ? thumb(first.id) : ''
      return `<a class="ccard" href="#comic/${slugOf(n)}"><div class="cimg">${ph || fb ? `<img class="cphoto${ph ? '' : ' yt'}" src="${esc(ph || fb)}" alt="${esc(n)}" loading="lazy" decoding="async"${ph && fb ? ` onerror="this.onerror=null;this.classList.add('yt');this.src='${esc(fb)}'"` : ''}>` : ''}</div>
        <div class="ctext"><b>${esc(n)}</b><span>${esc(COMICS[n]?.tagline || '')}</span><em>${st.crowd ? Math.round(st.crowd.elo) + ' crowd rating' : st.clips.length + ' shorts'}</em></div></a>` }).join('')}
      <div class="ccard soon"><div class="cimg ai"></div><div class="ctext"><b>AI comedians</b><span>In rehearsal. Soon you'll train your own and premiere them here.</span><em>Coming soon</em></div></div>
    </div>`
}
function paintProfile(el, name) {
  const P = COMICS[name] || {}, st = comicStats(name), first = st.clips.find((k) => k.media === 'youtube')
  const rng = st.crowd?.lo != null ? ` <small>${Math.round(st.crowd.lo)}–${Math.round(st.crowd.hi)}</small>` : ''
  el.innerHTML = `<a class="back" href="#comics">← All comics</a>
    ${(() => { const ph = photoOf(P), fb = first ? thumb(first.id) : ''; return `<section class="hero${ph ? ' hasphoto' : ''}">${ph || fb ? `<img class="heroimg${ph ? '' : ' yt'}" src="${esc(ph || fb)}" alt="" decoding="async"${ph && fb ? ` onerror="this.onerror=null;this.classList.add('yt');this.src='${esc(fb)}'"` : ''}>` : ''}` })()}
      <div class="hinner"><span class="eyebrow">Comedian</span><h1>${esc(name)}</h1><p class="tag">${esc(P.tagline || '')}</p>
      <div class="facts">${(P.facts || []).map((f) => `<span>${esc(f)}</span>`).join('')}</div>
      <div class="stats"><div><b>${st.crowd ? Math.round(st.crowd.elo) + rng : '—'}</b><span>Crowd rating</span></div><div><b>${st.mine ?? '—'}</b><span>Your model</span></div><div><b>${st.clips.length}</b><span>Shorts</span></div></div>
      <div class="styles">${st.styles.map((t) => `<span class="chip">${t}</span>`).join('')}</div></div></section>${photoCredit(P)}
    <div class="cols"><div><h3>About</h3><p class="${P.bio ? '' : 'muted'}">${P.bio ? esc(P.bio) : 'Profile coming soon. Bio, influences and specials will live here.'}</p>
      ${Object.entries(P.links || {}).map(([k, u]) => `<a class="btn ghost" href="${esc(u)}" target="_blank" rel="noopener">${esc(k)}</a>`).join(' ')}</div>
      <div><h3>Head-to-head</h3>${Object.keys(st.h2h).length ? `<div class="bars">${Object.entries(st.h2h).map(([o, r]) => `<div class="barrow"><span>vs ${esc(o)}</span><div class="track"><i style="left:0;width:${(100 * r.w) / r.n}%"></i></div><span class="v">${Math.round((100 * r.w) / r.n)}% · ${r.n}</span></div>`).join('')}</div>` : '<p class="muted">No matchups yet. Every pick involving this comic shows up here.</p>'}</div></div>
    ${specialsHTML(P.specials)}
    <h3 class="shelf">Best-rated shorts</h3><div class="rail">${st.rated.map(({ c, r }, i) => clipTile(c, r ? i : null, r ? Math.round(r.elo) : c.channel)).join('')}</div>`
  bindSpecials(el)
  scrollTo({ top: 0 })
}

// ---------- specials: Letterboxd-style log, kept on this device ----------
const SPK = 'specials'
const spGet = () => { const x = LS.get(SPK, {}); return x && typeof x === 'object' ? x : {} }
const spMine = (id) => spGet()[id] || {}
function spSet(id, patch) {
  const all = spGet(), cur = { ...(all[id] || {}), ...patch, at: new Date().toISOString() }
  if (!cur.seen && !cur.stars && !cur.note) delete all[id]; else all[id] = cur
  LS.set(SPK, all)
  queueSpecialPush(id, cur) // signed in: the diary publishes (newest edit wins)
}
function allSpecials() { return Object.entries(COMICS).flatMap(([comic, p]) => (Array.isArray(p?.specials) ? p.specials : []).map((s) => ({ ...s, comic }))) }
function specialsSeen() { const ids = new Set(allSpecials().map((s) => s.id)), m = spGet(); return Object.keys(m).filter((id) => ids.has(id) && m[id].seen).length }
const hue = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7)
function starsHTML(n) {
  return `<div class="stars" role="radiogroup" aria-label="Your rating">${[1, 2, 3, 4, 5].map((i) => {
    const f = n >= i ? 'full' : n >= i - 0.5 ? 'half' : ''
    return `<button class="st ${f}" data-star="${i}" aria-label="${i} star${i > 1 ? 's' : ''}">★</button>` }).join('')}</div>`
}
function specialCard(s) {
  const m = spMine(s.id), h = hue(s.id)
  return `<article class="sp${m.seen ? ' seen' : ''}" data-sp="${esc(s.id)}">
    <div class="spart" style="background:linear-gradient(160deg,hsl(${h} 70% 22%) 0%,#0b0b0e 75%)">
      <span class="spyear">${esc(s.year)}</span>
      <b>${esc(s.title)}</b>
      <span class="spdist">${esc(s.distributor || '')}${s.runtimeMin ? ' · ' + s.runtimeMin + ' min' : ''}</span>
      ${m.stars ? `<span class="spmine">★ ${m.stars}</span>` : ''}
    </div>
    <div class="spact">
      <button class="seenbtn${m.seen ? ' on' : ''}" data-act="seen" aria-pressed="${!!m.seen}">${m.seen ? '✓ Seen' : '+ Seen'}</button>
      ${starsHTML(m.stars || 0)}
      <button class="notebtn${m.note ? ' on' : ''}" data-act="note" aria-label="Note">✎</button>
    </div>
    <div class="spnote" ${m.note ? '' : 'hidden'}><textarea maxlength="280" rows="2" placeholder="A line for future you…">${esc(m.note || '')}</textarea></div>
    <div class="splinks">${(s.where || []).map((w) => `<a href="${esc(w.url)}" target="_blank" rel="noopener">${esc(w.name)}</a>`).join('')}</div>
  </article>`
}
function specialsHTML(list) {
  if (!Array.isArray(list) || !list.length) return ''
  const sorted = [...list].sort((a, b) => (a.year || 0) - (b.year || 0))
  return `<div class="sphead"><h3 class="shelf">Specials</h3><span class="muted" id="spsum">${spSummary(list)}</span></div>
    <div class="spgrid">${sorted.map(specialCard).join('')}</div>
    <p class="muted small">Your log stays on this device. Availability varies by country, so "Where to watch" opens a search.</p>`
}
function spSummary(list) {
  const m = spGet(), seen = list.filter((s) => m[s.id]?.seen).length, rated = list.map((s) => m[s.id]?.stars).filter((x) => x > 0)
  const avg = rated.length ? (rated.reduce((a, b) => a + b, 0) / rated.length).toFixed(1) : null
  return `${seen}/${list.length} seen${avg ? ` · your avg ★ ${avg}` : ''}`
}
function bindSpecials(root) {
  const grid = root.querySelector('.spgrid'); if (!grid) return
  const list = () => [...grid.querySelectorAll('.sp')].map((x) => allSpecials().find((s) => s.id === x.dataset.sp)).filter(Boolean)
  const repaint = (id, focusNote) => {
    const s = allSpecials().find((x) => x.id === id), old = grid.querySelector(`.sp[data-sp="${CSS.escape(id)}"]`)
    if (!s || !old) return
    old.outerHTML = specialCard(s)
    const sum = root.querySelector('#spsum'); if (sum) sum.textContent = spSummary(list())
    if (focusNote) grid.querySelector(`.sp[data-sp="${CSS.escape(id)}"] textarea`)?.focus()
    paintYou()
  }
  grid.onclick = (e) => {
    const card = e.target.closest('.sp'); if (!card) return
    const id = card.dataset.sp, m = spMine(id), star = e.target.closest('[data-star]'), act = e.target.closest('[data-act]')?.dataset.act
    if (star) {
      const i = +star.dataset.star, r = star.getBoundingClientRect()
      let n = e.clientX && e.clientX < r.left + r.width / 2 ? i - 0.5 : i // tap the left half for a half star
      if (n === m.stars) n = 0 // tap your rating again to clear it
      spSet(id, { stars: n, seen: n > 0 ? true : m.seen }); return repaint(id)
    }
    if (act === 'seen') { spSet(id, { seen: !m.seen, ...(m.seen ? { stars: 0 } : {}) }); return repaint(id) }
    if (act === 'note') { const box = card.querySelector('.spnote'); box.hidden = !box.hidden; if (!box.hidden) box.querySelector('textarea').focus() }
  }
  let nt
  grid.oninput = (e) => {
    if (e.target.tagName !== 'TEXTAREA') return
    const id = e.target.closest('.sp').dataset.sp, val = e.target.value.slice(0, 280)
    clearTimeout(nt); nt = setTimeout(() => { spSet(id, { note: val }); e.target.closest('.sp').querySelector('.notebtn')?.classList.toggle('on', !!val) }, 300)
  }
}

// ---------- your model ----------
function paintYou() {
  const el = $('#you'), votes = LS.get('votes', [])
  if (!votes.length) {
    const ns = specialsSeen()
    const nl = LAUGHS_ENABLED ? laughsAll().length : 0
    el.innerHTML = `<h2>Your model</h2><p class="empty">Every pick trains a small model of your sense of humour, right here on your device.<br>Watch a double feature to start it.</p>${nl ? `<p class="sure"><b>${nl}</b> your laughs</p>` : ''}${ns ? `<p class="sure">${ns} special${ns === 1 ? '' : 's'} seen · <a href="#comics">log more in Comics</a></p>` : ''}`
    return
  }
  MODEL = MODEL || fitLocal()
  const preds = LS.get('preds', []).slice(3), last = preds.slice(-30)
  const acc = last.length ? Math.round((100 * last.filter((p) => p.hit).length) / last.length) : null
  const comics = Object.entries(MODEL.r).map(([k, x]) => ({ k, elo: Math.round(1500 + SCALE * x) })).sort((a, b) => b.elo - a.elo)
  const lo = Math.min(...comics.map((c) => c.elo)) - 40, hi = Math.max(...comics.map((c) => c.elo)) + 40
  const bars = comics.map((c) => `<div class="barrow"><span>${esc(c.k)}</span><div class="track"><i style="left:0;width:${(100 * (c.elo - lo)) / (hi - lo)}%"></i></div><span class="v">${c.elo}</span></div>`).join('')
  // learned traits
  const dur = LS.get('dur', {})
  let longW = 0, longN = 0, lnW = 0, lnN = 0
  for (const v of votes) {
    const A = BYID[v.a], B = BYID[v.b]; if (!A || !B) continue
    const da = dur[v.a], db = dur[v.b]
    if (da && db && Math.abs(da - db) > 20) { longN++; if ((da > db ? v.a : v.b) === v.winner) longW++ }
    const la = LATE_NIGHT.test(A.channel || ''), lb = LATE_NIGHT.test(B.channel || '')
    if (la !== lb) { lnN++; if ((la ? v.a : v.b) === v.winner) lnW++ }
  }
  const trait = (label, w, n, a, b) => {
    if (n < 2) return `<div class="barrow"><span>${label}</span><div class="track center"></div><span class="v">learning</span></div>`
    const p = w / n, left = Math.min(50, 100 * p), width = Math.abs(100 * p - 50)
    return `<div class="barrow"><span>${label}</span><div class="track center"><i style="left:${p >= 0.5 ? 50 : left}%;width:${width}%"></i></div><span class="v">${Math.round(100 * p)}% ${p >= 0.5 ? a : b}</span></div>`
  }
  const best = Object.keys(MODEL.o).filter((id) => MODEL.bouts[id]).sort((x, y) => MODEL.score(y) - MODEL.score(x)).slice(0, 5)
  el.innerHTML = `<h2>Your model</h2>
    <div class="kpis${LAUGHS_ENABLED ? ' k5' : ''}">
      <div class="kpi"><b>${votes.length}</b><span>picks trained on</span></div>
      <div class="kpi"><b>${acc == null ? '—' : acc + '%'}</b><span>how often it predicts you${last.length ? ` (last ${last.length})` : ''}</span></div>
      <div class="kpi"><b>${esc(comics[0].k.split(' ').slice(-1)[0])}</b><span>your top comic so far</span></div>
      <div class="kpi"><b>${new Set(votes.flatMap((v) => [v.a, v.b])).size}</b><span>shorts seen</span></div>
      ${LAUGHS_ENABLED ? `<div class="kpi laughs"><b>${laughsAll().length}</b><span>your laughs</span></div>` : ''}
    </div>
    ${sureLine(votes)}
    <p class="sure"><a class="tolink" href="#profile">Your humour chart, Four Favourites and share cards →</a></p>
    ${(() => { const h = humourType(); return h ? `<div class="type"><span class="eyebrow">Your humour type</span><b>${h.name}</b><p>${h.line}${h.also ? ` With a streak of <i>${h.also}</i>.` : ''}</p></div>` : `<div class="type"><span class="eyebrow">Your humour type</span><b>Still reading you…</b><p>A few more picks across different styles and it will name your type.</p></div>` })()}
    ${engineYouHTML()}
    ${skipLists()}
    <h3>Comics, as your model sees them</h3><p class="muted">It starts from the crowd chart and moves toward your picks.</p><div class="bars">${bars}</div>
    <h3>What it's learning about you</h3><div class="bars">
      ${trait('Longer bits', longW, longN, 'longer', 'shorter')}
      ${trait('Late-night TV', lnW, lnN, 'late-night', 'specials')}
    </div>
    ${best.length ? `<h3>Your funniest so far</h3><div class="rail">${best.map((id, i) => clipTile({ id }, i)).join('')}</div>` : ''}
    <div id="youglobal"></div>
    <h3>Why this matters</h3>
    <p class="note">Your model is a portable critic. When we build the AI comedians, it can <b>judge their drafts for you</b>, tune a comic to <b>your</b> sense of humour, or sit on a panel next to other people's models. <button class="btn" id="export" style="margin-left:6px">Download my model</button></p>`
  $('#export').onclick = () => {
    const blob = new Blob([JSON.stringify({ kind: 'funnier.taste-model', version: 1, created: new Date().toISOString(), picks: votes.length, accuracy: acc, comics, clips: Object.fromEntries(Object.entries(MODEL.o).filter(([id]) => MODEL.bouts[id]).map(([id, x]) => [id, Math.round(SCALE * (MODEL.r[BYID[id].comic] + x))])) }, null, 2)], { type: 'application/json' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'funnier-taste-model.json'; a.click()
  }
  if (me) fetch('data/taste/' + me.did.replace(/[^a-z0-9]/gi, '_') + '.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).then((t) => {
    if (!t) return
    $('#youglobal').innerHTML = `<h3>You vs the crowd</h3><p class="muted">From your ${t.votes} published picks.</p><div class="bars">${t.comics.map((c) => `<div class="barrow"><span>${esc(c.comic)}</span><div class="track center"><i style="left:${c.vsCrowd >= 0 ? 50 : 50 + Math.max(-50, c.vsCrowd / 4)}%;width:${Math.min(50, Math.abs(c.vsCrowd) / 4)}%"></i></div><span class="v">${c.vsCrowd > 0 ? '+' : ''}${c.vsCrowd}</span></div>`).join('')}</div>`
  }).catch(() => {})
}

// Your model: the engine's strongest leans (both directions), each with its confidence, then the per-vote timeline
function engineYouHTML() {
  let ro = null; try { ro = engineReadout() } catch {}
  if (!ro) return ''
  const rows = FEATURES.map((f) => ({ f, e: ro.f[f.k] })).filter((x) => x.e && x.e.n >= 0.5).sort((x, y) => Math.abs(y.e.v - 50) - Math.abs(x.e.v - 50)).slice(0, 8)
  const row = ({ f, e }) => { const d = e.v - 50, lo = Math.max(0, e.lo), hi = Math.min(100, e.hi)
    return `<div class="barrow eng"><span>${esc(f.label)}<small class="up-conf c-${esc(e.conf)}">${esc(confText(e.conf, e.n))}</small></span><div class="track center"><s class="up-band" style="left:${lo}%;width:${Math.max(1, hi - lo)}%"></s><i style="left:${d >= 0 ? 50 : 50 + d}%;width:${Math.abs(d)}%"></i></div><span class="v">${e.v}</span></div>` }
  return `<h3>Your humour model</h3><p class="muted">Every vote retrains it here on your device. 50 = neutral; the shade is how unsure it still is.</p>
    <div class="bars">${rows.length ? rows.map(row).join('') : '<p class="muted">Still at the crowd\u2019s taste. A few votes and it starts to lean.</p>'}</div>${timelineHTML(20)}`
}
function skipLists() {
  const shown = LS.get('shown', {}) || {}, sk = {}
  for (const k of clipSkips()) { const c = BYID[k.clip].comic; sk[c] = (sk[c] || 0) + 1 }
  const comics = Object.keys(shown).filter((c) => shown[c] > 0)
  if (!comics.length) return ''
  const most = comics.filter((c) => sk[c]).map((c) => ({ c, r: Math.min(1, sk[c] / shown[c]), n: sk[c] })).sort((a, b) => b.r - a.r || b.n - a.n).slice(0, 3)
  const never = comics.filter((c) => !sk[c] && shown[c] >= 2).sort((a, b) => shown[b] - shown[a]).slice(0, 3)
  if (!most.length && !never.length) return ''
  const li = (arr) => arr.length ? arr.join('') : '<li class="muted">Nobody yet</li>'
  return `<div class="skipcols"><div><h3>Most skipped</h3><ul>${li(most.map((m) => `<li><b>${esc(m.c)}</b><span>${m.n} skip${m.n === 1 ? '' : 's'} · ${Math.round(100 * m.r)}% of their clips</span></li>`))}</ul></div>
    <div><h3>Never skip</h3><ul>${li(never.map((c) => `<li><b>${esc(c)}</b><span>watched ${shown[c]} times, never skipped</span></li>`))}</ul></div></div>`
}
function sureLine(votes) {
  const ms = votes.map((v) => v.decisionMs).filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b)
  const ns = specialsSeen()
  const sp = `<span>${ns} special${ns === 1 ? '' : 's'} seen</span>`
  if (!ms.length) return `<p class="sure"><b>How sure you were</b><span>timing starts with your next pick</span>${sp}</p>`
  const med = ms.length % 2 ? ms[(ms.length - 1) / 2] : (ms[ms.length / 2 - 1] + ms[ms.length / 2]) / 2
  const snap = Math.round((100 * ms.filter((x) => x < SNAP_MS).length) / ms.length)
  return `<p class="sure"><b>How sure you were</b><span>median ${(med / 1000).toFixed(1)}s to decide</span><span>${snap}% snap picks (under ${SNAP_MS / 1000}s)</span>${sp}</p>`
}

// ---------- chrome: the menu fades away during a screening, the logo never does ----------
let showTab = () => {}, chromeT = null, chromeHidden = false, nearTop = false, tapRevealed = false
const HIDE_FIRST_MS = 1500, HIDE_AFTER_MS = 2500, TOP_ZONE = 80
function screeningActive() { return !!current && arenaOn() && ['intro', 'left', 'right', 'vote', 'done'].includes(stage) }
function setChromeHidden(h) { chromeHidden = h; document.body.classList.toggle('chrome-hidden', h) }
function scheduleHide(ms) {
  clearTimeout(chromeT)
  chromeT = setTimeout(function hide() {
    if (!screeningActive()) return setChromeHidden(false)
    const hdr = $('#chrome'), focused = hdr && hdr.querySelector(':focus-visible')
    if (nearTop || focused || menuOpen()) { chromeT = setTimeout(hide, 600); return }
    setChromeHidden(true)
  }, ms)
}
function showChrome(ms = HIDE_AFTER_MS) {
  if (chromeHidden) setChromeHidden(false)
  if (screeningActive()) scheduleHide(ms); else clearTimeout(chromeT)
}
let wasActive = false, railWakeT = null
function wakeRail() { document.body.classList.add('rail-on'); clearTimeout(railWakeT); railWakeT = setTimeout(() => document.body.classList.remove('rail-on'), HIDE_AFTER_MS) }
function updateChrome() {
  const sb = $('#sharebtn'); if (sb) sb.hidden = !current || !arenaOn()
  const act = screeningActive()
  if (act && !wasActive) scheduleHide(HIDE_FIRST_MS)
  if (!act) { clearTimeout(chromeT); setChromeHidden(false) }
  document.body.classList.toggle('screening', act)
  wasActive = act
}
function bindChrome() {
  addEventListener('pointermove', (e) => {
    if (e.pointerType && e.pointerType !== 'mouse') return
    nearTop = e.clientY <= TOP_ZONE
    if (screeningActive()) { showChrome(); wakeRail() }
  }, { passive: true })
  document.addEventListener('mouseleave', () => (nearTop = false))
  // touch/pen: the first tap while the menu is hidden only reveals it (the shield then skips play/pause)
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') { tapRevealed = false; return }
    tapRevealed = chromeHidden && !!e.target.closest?.('.shield')
    if (screeningActive()) showChrome()
  }, { capture: true, passive: true })
  document.addEventListener('focusin', (e) => { if (e.target.closest?.('#chrome, #brand')) showChrome() })
  document.addEventListener('keydown', (e) => { if (e.key === 'Tab') showChrome() })
  const sb = $('#sharebtn'); if (sb) sb.onclick = (e) => { e.stopPropagation(); shareCurrent() }
  for (const ev of ['pointerdown', 'touchstart', 'keydown', 'wheel', 'scroll']) document.addEventListener(ev, firstGesture, { capture: true, passive: true })
  if (LAUGHS_ENABLED) { const cb = $('#crowdbtn'); if (cb) cb.onclick = (e) => { e.stopPropagation(); toggleCrowd() }; paintCrowdBtn() }
  bindUser()
}

// ---------- share a clash: #clash/<clipA>/<clipB>&pick=a|b, no backend ----------
const SHARE_BASE = 'https://www.funnier.si/' // fallback; site/config.json shareBase wins
let pendingClash = null, sharedRound = null, sharedDuringBallot = false
function parseClash(h) {
  const m = String(h || '').match(/^#clash\/([^/&?]+)\/([^/&?]+)(?:[&?]pick=([ab]))?/)
  if (!m) return null
  const d = (x) => { try { return decodeURIComponent(x) } catch { return x } }
  const rewatch = /[&?]from=history\b/.test(String(h))
  return { a: d(m[1]), b: d(m[2]), pick: rewatch ? null : m[3] || null, rewatch }
}
function takeClash() {
  const sh = pendingClash; pendingClash = null
  if (!sh) return null
  const A = BYID[sh.a], B = BYID[sh.b]
  if (!A || !B || sh.a === sh.b) { setTimeout(() => toast('That clash is no longer on the bill, so here is tonight\u2019s instead.'), 400); return null }
  const pair = [A, B]
  if (sh.daily) { pair.mode = 'daily'; pair.daily = sh.daily; sharedRound = null; return pair }
  if (sh.rewatch) { pair.mode = 'rewatch'; sharedRound = null; return pair }
  pair.mode = 'shared'
  sharedRound = { ...sh, key: pairKey(sh.a, sh.b) }
  if (sh.invite) sharedRound.invite = sh.invite
  return pair
}
function friendLine(a, b, winner) {
  if (!sharedRound?.pick || sharedRound.key !== pairKey(a.id, b.id)) return null
  const fw = BYID[sharedRound.pick === 'a' ? sharedRound.a : sharedRound.b]
  if (!fw) return null
  const agree = fw.id === winner, who = sharedRound.invite?.inviter?.username
  if (who) return { agree, text: agree ? `You agree with ${who}: ${fw.comic}.` : `${who} picked ${fw.comic}.` }
  return { agree, text: agree ? `You agreed with your friend: ${fw.comic}.` : `You disagreed. Your friend picked ${fw.comic}.` }
}
function clashURL(a, b, pick) {
  const base = IS_LOCAL ? BASE : CFG.shareBase || SHARE_BASE
  return `${base}#clash/${encodeURIComponent(a.id)}/${encodeURIComponent(b.id)}${pick === 'a' || pick === 'b' ? '&pick=' + pick : ''}`
}
function myPick(a, b) {
  const v = [...LS.get('votes', []), ...LS.get('partials', [])].filter((x) => x && pairKey(x.a, x.b) === pairKey(a.id, b.id)).pop()
  return v ? (v.winner === a.id ? 'a' : v.winner === b.id ? 'b' : null) : null
}
function shareCurrent() {
  if (!current || !current[0] || !current[1]) return toast('Nothing on screen to share yet.')
  pauseBallot('Countdown paused. Pick when you\u2019re ready.') // sharing mid-ballot pauses the 3s countdown
  const [a, b] = current
  shareClash(a, b, myPick(a, b))
}
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true } catch {}
  try {
    const ta = document.createElement('textarea'); ta.value = t; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;opacity:0;top:0'
    document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove(); return ok
  } catch { return false }
}
const inviteCache = {}
async function shareLink(a, b, pick) {
  const k = [a.id, b.id, pick || ''].join('|')
  if (signedIn()) {
    if (!inviteCache[k]) inviteCache[k] = api('/invites', { method: 'POST', body: { a: a.id, b: b.id, pick: pick || null } })
      .then((r) => (r.ok && r.j?.code ? (CFG.shareBase || SHARE_BASE) + '#i/' + r.j.code : null)).catch(() => null)
    const u = await inviteCache[k]; if (u) return u
    delete inviteCache[k]
  }
  return clashURL(a, b, pick)
}
const shareText = (a, b, pick) => (pick ? `I picked my winner. ${a.comic} vs ${b.comic}: which is funnier?` : `${a.comic} vs ${b.comic}: which is funnier?`)
const waURL = (text, url) => 'https://wa.me/?text=' + encodeURIComponent(text + ' ' + url)
async function shareClash(a, b, pick) {
  if (!a || !b) return
  const url = await shareLink(a, b, pick), text = shareText(a, b, pick)
  if (navigator.share) {
    try { await navigator.share({ title: 'Funnier: settle this clash', text, url }); return }
    catch (e) { if (e && e.name === 'AbortError') return }
  }
  if (await copyText(url)) toast(pick ? 'Link copied. Your friend sees your pick only after they vote.' : 'Link copied. Send it to a friend.')
  else toast('Copy this link: ' + url)
}

// ---------- daily clash: site/daily.json editorial schedule, deterministic topic-matched fallback ----------
// The fallback MUST match tally/tally.mjs (same clip order, same hash) so results line up with what people saw.
const pad2 = (n) => String(n).padStart(2, '0')
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
function dayStr(d = new Date()) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` }
function hashStr(s) { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0 } return h >>> 0 }
function topicPairs() {
  const cs = [...CLIPS].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)), out = []
  for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) {
    const A = cs[i], B = cs[j]
    if (A.kind !== B.kind || A.comic === B.comic) continue // daily fallback: two different comics
    const tb = Array.isArray(B.topics) ? B.topics : []
    const shared = (Array.isArray(A.topics) ? A.topics : []).filter((t) => tb.includes(t)).sort()
    if (shared.length) out.push({ a: A.id, b: B.id, topic: shared[0] })
  }
  return out
}
function dailyFor(date) {
  if (!DAY_RE.test(String(date || ''))) return null
  const e = DAILY.find((x) => x && x.date === date && BYID[x.a] && BYID[x.b] && x.a !== x.b)
  if (e) return { date, title: e.title || '', blurb: e.blurb || '', a: e.a, b: e.b, topic: e.topic || '', editorial: true }
  const P = topicPairs(); if (!P.length) return null
  const p = P[hashStr(date) % P.length]
  return { date, title: '', blurb: `Two takes on ${p.topic}. Which one lands?`, a: p.a, b: p.b, topic: p.topic, editorial: false }
}
function dailyFields(v) {
  if (!v || !DAY_RE.test(String(v.daily || ''))) return {}
  const cc = ccOn()
  return { daily: v.daily, ...(cc ? { cc } : {}) } // country only with daily-clash picks, only when opted in (checked at publish time)
}
function dailyMine(date) { return [...LS.get('votes', []), ...LS.get('partials', [])].filter((v) => v && v.daily === date).sort((x, y) => Date.parse(x.createdAt) - Date.parse(y.createdAt)).pop() || null }
function untilNext() {
  const n = new Date(), next = new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1)
  const m = Math.max(0, Math.round((next - n) / 60000)), h = Math.floor(m / 60)
  return h ? `${h}h ${pad2(m % 60)}m` : `${m}m`
}
// "The world says X% / Y%" (+ your country's split when it has enough votes), from data/daily.json
function worldLine(D) {
  const day = DAILYRES?.days?.[D.date]
  if (!day || !(day.total > 0)) return 'The world\u2019s split appears soon. Results update every 15 min.'
  const flip = day.a !== D.a
  const pa = flip ? day.pctB : day.pctA, pb = flip ? day.pctA : day.pctB
  const A = BYID[D.a], B = BYID[D.b]
  let s = `The world says ${esc(A?.comic || 'one')} ${pa}% / ${esc(B?.comic || 'two')} ${pb}% (${day.total} vote${day.total === 1 ? '' : 's'}).`
  const cc = ccOn(), row = cc && Array.isArray(day.countries) ? day.countries.find((c) => c.cc === cc) : null
  if (row) s += ` ${esc(ccName(cc))}: ${flip ? row.pctB : row.pctA}% / ${flip ? row.pctA : row.pctB}%.`
  else if (cc) s += ` ${esc(ccName(cc))} shows once it has 5 votes.`
  return s
}
function playDaily() {
  const D = dailyFor(dayStr()); if (!D) return
  pendingClash = { a: D.a, b: D.b, pick: null, daily: D.date }
  userStarted = true
  showTab('arena'); moving = false; goNext(null)
}
let dailyTimer = null, dailyDay = null
// the daily clash lives in ONE place: the banner above the screening. Tap it to play. Once you've watched it (reached
// its ballot) or voted on it, the banner is gone for the rest of the day (localStorage funnier.dailyDone = date).
function dailyDone(date) { return !!date && (LS.get('dailyDone', '') === date || !!dailyMine(date)) }
function markDailyDone() { if (current?.mode === 'daily' && DAY_RE.test(String(current.daily || ''))) { LS.set('dailyDone', current.daily); paintDaily() } }
function paintDaily() {
  const el = $('#daily'); if (!el) return
  const D = dailyFor(dayStr()); dailyDay = D?.date || dayStr()
  const playing = !!D && current?.mode === 'daily' && current.daily === D.date && ['intro', 'left', 'right', 'vote', 'done'].includes(stage)
  if (!D || dailyDone(D.date) || playing) { el.hidden = true; el.innerHTML = '' }
  else {
    const A = BYID[D.a], B = BYID[D.b]
    el.hidden = false
    el.innerHTML = `<button type="button" class="dhinner" data-dh="play" aria-label="Play today's Daily Clash${D.title ? ': ' + esc(D.title) : ''}" title="${esc(A.comic)} vs ${esc(B.comic)}${D.blurb ? ' · ' + esc(D.blurb) : ''}">
    <i class="dot" aria-hidden="true"></i><b class="dhtitle">Daily Clash${D.title ? `<span>: ${esc(D.title)}</span>` : ''}</b>
    <span class="dhcount" aria-label="Next daily clash in">${untilNext()}</span><span class="dhbtn" aria-hidden="true">Play</span></button>`
    el.querySelector('[data-dh="play"]').onclick = (e) => { e.stopPropagation(); playDaily() }
  }
  if (!dailyTimer) dailyTimer = setInterval(() => {
    if (dayStr() !== dailyDay) return paintDaily() // midnight: a new clash
    const c = document.querySelector('#daily .dhcount'); if (c) c.textContent = untilNext()
  }, 30000)
}

// ---------- country (opt-in only; preselected from navigator.language's region, never geo-IP) ----------
const CC_LIST = 'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' ')
let ccNames = null
function ccName(c) {
  try { ccNames = ccNames || new Intl.DisplayNames([navigator.language || 'en', 'en'], { type: 'region' }); return ccNames.of(c) || c } catch { return c }
}
function ccPref() { const x = LS.get('cc', null); return x && typeof x === 'object' && CC_LIST.includes(x.code) ? x : null }
function ccOn() { const p = ccPref(); return p && p.on ? p.code : null }
function ccGuess() { const m = String(navigator.language || '').match(/[-_]([A-Za-z]{2})(?:$|[-_])/); const c = m?.[1]?.toUpperCase(); return c && CC_LIST.includes(c) ? c : '' }
function ccOptions(sel) {
  return `<option value="">Choose a country</option>` + CC_LIST.map((c) => [c, ccName(c)]).sort((x, y) => x[1].localeCompare(y[1]))
    .map(([c, n]) => `<option value="${c}" ${c === sel ? 'selected' : ''}>${esc(n)}</option>`).join('')
}
function ccAskHTML() {
  return `<div class="ccask" role="group" aria-label="Daily clash map"><span>Add your country to the daily clash map?</span>
    <select class="ccsel" aria-label="Your country">${ccOptions(ccGuess())}</select>
    <button type="button" class="dhbtn small" data-cc="yes">Add</button><button type="button" class="dhghost small" data-cc="no">No thanks</button>
    <small>Sent only with your daily-clash picks. Remove it any time in Your model → History.</small></div>`
}
function bindCcAsk(root) {
  root.querySelectorAll('[data-cc]').forEach((b) => (b.onclick = (e) => {
    e.stopPropagation()
    LS.set('ccAsked', true)
    if (b.dataset.cc === 'yes') {
      const code = root.querySelector('.ccsel')?.value
      if (!code) { LS.set('ccAsked', false); return toast('Pick a country first, or tap No thanks.') }
      LS.set('cc', { code, on: true, at: new Date().toISOString() }); toast(`Added ${ccName(code)}. Your daily picks now count on the map.`)
    } else toast('No problem. Your country stays off.')
    paintDaily(); paintHistory()
  }))
}

// ---------- share without losing your place: auto-advance / intro / playback wait while the share sheet is open ----------
let advT = null
function scheduleAdvance(ms) { clearTimeout(advT); advT = setTimeout(() => { advT = null; goNext(null) }, ms) }
async function holdWhile(fn) {
  const h = { adv: false, intro: false, play: null, el: cur?.el }
  if (advT) { clearTimeout(advT); advT = null; h.adv = true }
  else if (stage === 'intro') { clearTimers(); h.intro = true }
  else if (stage === 'left' || stage === 'right') { const s = screens[stage === 'left' ? 'L' : 'R']; if (s?.playing?.()) { s.pause(); h.play = s } }
  else if (stage === 'vote' && armed) pauseBallot('Countdown paused. Pick when you\u2019re ready.')
  try { await fn() } catch {} finally {
    if (h.adv && cur?.el === h.el) scheduleAdvance(500)
    else if (h.intro && stage === 'intro' && cur?.el === h.el) later(() => stage === 'intro' && cur?.el === h.el && startClip('L'), 900)
    else if (h.play && !h.play.dead) h.play.play()
  }
}

// ---------- after-vote result card: result, world split (daily), "Send to a friend", why-chips ----------
const WHY = ['Smarter', 'Weirder', 'Darker', 'Better delivery', 'More relatable', 'Better payoff']
let whyT
function askWhy(v, shareOnly, fl, guess) {
  const box = $('#why'); if (!box) return
  const A = BYID[v.a], B = BYID[v.b], W = BYID[v.winner]
  const D = v.daily ? dailyFor(v.daily) : null
  const pick = v.winner === v.a ? 'a' : 'b', inv = sharedRound?.invite && sharedRound.key === pairKey(v.a, v.b) ? sharedRound.invite : null
  const text = shareText(A, B, pick)
  box.innerHTML = `<p class="rchead"><b>${shareOnly ? 'Noted, but it didn\u2019t count' : esc(W?.comic || '') + ' takes it.'}</b>${!shareOnly && guess ? `<span class="muted">${esc(guess)}</span>` : ''}${fl ? `<span class="${fl.agree ? 'agree' : 'disagree'}">${esc(fl.text)}</span>` : ''}</p>
    <div class="rcsplit" aria-live="polite">${D ? `<p class="rcworld">${worldLine(D)}</p>` : ''}</div>
    <div class="rcfriends" hidden></div>
    <div class="rcshare"><button type="button" class="rcsend" data-sh="native">Share ↗</button><a class="rcalt" data-sh="wa" href="${esc(waURL(text, clashURL(A, B, pick)))}" target="_blank" rel="noopener">WhatsApp</a><button type="button" class="rcalt" data-sh="copy">Copy link</button></div>
    ${inv && !inv.self && !inv.friends && inv.inviter?.username ? `<button type="button" class="rcadd" data-sh="add">${avatarHTML(inv.inviter)}Add ${esc(inv.inviter.username)} as a friend</button>` : ''}
    ${shareOnly ? '' : `<div class="rcwhy"><span>Why was it funnier?</span>${WHY.map((w) => `<button type="button" data-why>${w}</button>`).join('')}</div>`}
    ${!shareOnly && LS.get('votes', []).length >= 5 ? '<button type="button" class="rctaste" data-sh="taste">Share your taste ↗</button>' : ''}`
  let sharing = false
  const hideIn = (ms) => { clearTimeout(whyT); whyT = setTimeout(() => { if (!sharing) box.classList.remove('on') }, ms) }
  box.classList.add('on'); hideIn(signedIn() ? 7000 : 5000)
  box.onpointerenter = () => clearTimeout(whyT); box.onpointerleave = () => hideIn(2500)
  box.onfocusin = () => clearTimeout(whyT)
  const linkP = shareLink(A, B, pick)
  const wa = box.querySelector('[data-sh="wa"]')
  linkP.then((u) => { if (wa) wa.href = waURL(text, u) })
  const hold = async (fn) => { sharing = true; clearTimeout(whyT); await holdWhile(fn); sharing = false; hideIn(1500) }
  box.querySelector('[data-sh="native"]').onclick = (e) => { e.stopPropagation(); hold(() => shareClash(A, B, pick)) }
  box.querySelector('[data-sh="copy"]').onclick = async (e) => { e.stopPropagation(); const u = await linkP; toast((await copyText(u)) ? 'Link copied. Your friend sees your pick only after they vote.' : 'Copy this link: ' + u) }
  if (wa) wa.onclick = (e) => { e.stopPropagation(); clearTimeout(advT); advT = null }
  const add = box.querySelector('[data-sh="add"]')
  if (add) add.onclick = (e) => { e.stopPropagation(); clearTimeout(advT); advT = null; addFriend(inv, add) }
  const tst = box.querySelector('[data-sh="taste"]')
  if (tst) tst.onclick = (e) => { e.stopPropagation(); hold(() => openShareStudio('chart')) }
  box.querySelectorAll('button[data-why]').forEach((b) => (b.onclick = (e) => {
    e.stopPropagation()
    const votes = LS.get('votes', []); const last = votes.find((x) => x.createdAt === v.createdAt)
    if (last) { last.why = b.textContent; LS.set('votes', votes); if (signedIn()) api('/votes', { method: 'POST', body: { votes: [apiVote(last)] } }).catch(() => {}) }
    const q2 = LS.get('queue', []); const lq = q2.find((x) => x.createdAt === v.createdAt); if (lq) { lq.why = b.textContent; LS.set('queue', q2) }
    box.classList.remove('on'); toast('Noted. Your model will use that.'); paintHistory()
  }))
  // invite bookkeeping: this open voted; signed-out friends get added when they sign in
  if (inv && !inv.self) {
    if (inv.open_id != null) api(`/invites/${encodeURIComponent(inv.code)}/voted`, { method: 'POST', body: { open_id: inv.open_id } }).catch(() => {})
    if (!signedIn() && !inv.friends) LS.set('pendingAccept', { code: inv.code, open_id: inv.open_id, username: inv.inviter?.username || '' })
  }
  paintResult(box, v, D, shareOnly)
}
// global split flashes in, then friends' faces on the side they picked
async function paintResult(box, v, D, shareOnly) {
  const A = BYID[v.a], B = BYID[v.b], el = box.querySelector('.rcsplit'), fr = box.querySelector('.rcfriends')
  let pa = null, n = 0
  if (CFG.apiBase) {
    try { if (signedIn() && !shareOnly) await syncVotes() } catch {}
    try { const r = await api(`/stats/clash/${encodeURIComponent(v.a)}/${encodeURIComponent(v.b)}`); if (r.ok && r.j?.total > 0) { pa = r.j.pctA; n = r.j.total } } catch {}
  }
  if (pa == null) { // fall back to the published (Bluesky) tally
    const vs = PUBVOTES.filter((x) => x && pairKey(x.a, x.b) === pairKey(v.a, v.b))
    if (vs.length) { n = vs.length; pa = Math.round((100 * vs.filter((x) => x.winner === v.a).length) / n) }
  }
  if (!box.contains(el)) return
  if (pa != null) el.innerHTML = `<div class="split${v.winner === v.a ? ' l' : ' r'}"><span>${esc(A.comic)} <b>${pa}%</b></span><i style="--p:${pa}%"></i><span><b>${100 - pa}%</b> ${esc(B.comic)}</span></div><small class="muted">${n} pick${n === 1 ? '' : 's'} so far</small>`
  else if (!D) el.innerHTML = `<p class="rcworld">You\u2019re the first to call this one.</p>`
  requestAnimationFrame?.(() => el.querySelector('.split')?.classList.add('on'))
  if (!signedIn() || !fr) return
  try {
    const r = await api(`/clash/${encodeURIComponent(v.a)}/${encodeURIComponent(v.b)}/friends`)
    const fs = r.ok ? r.j?.friends || [] : []
    if (!fs.length || !box.contains(fr)) return
    const side = (id) => fs.filter((f) => f.winner === id).map((f) => `<span class="fa" title="${esc(f.username || '')}">${avatarHTML(f)}</span>`).join('')
    fr.innerHTML = `<p>See what your friends think</p><div class="fsides"><div>${side(v.a) || '<span class="muted small">nobody</span>'}<small>${esc(A.comic)}</small></div><div>${side(v.b) || '<span class="muted small">nobody</span>'}<small>${esc(B.comic)}</small></div></div>`
    fr.hidden = false
  } catch {}
}

// ---------- history: everything you did, from this device's own logs ----------
let HFILTER = 'all', YOUSUB = 'model'
const arr = (x) => (Array.isArray(x) ? x : [])
function historyEntries() {
  const E = [], ok = (v) => v && typeof v.a === 'string' && typeof v.b === 'string'
  for (const v of arr(LS.get('votes', []))) if (ok(v)) E.push({ kind: 'pick', t: v.createdAt, v, counted: true })
  for (const v of arr(LS.get('partials', []))) if (ok(v)) E.push({ kind: 'pick', t: v.createdAt, v, counted: false })
  for (const p of arr(LS.get('passes', []))) if (ok(p)) E.push({ kind: 'skip', sub: 'pass', t: p.at, v: p })
  const nf = []
  for (const s of arr(LS.get('skips', []))) { if (!ok(s)) continue; if (s.stage === 'left-skip' || s.stage === 'right-skip') nf.push(s); else E.push({ kind: 'skip', sub: 'clash', t: s.at, v: s }) }
  for (const s of nf) { // a "Not funny" skip belongs to the clash it happened in (the pick, pass or skip that followed)
    const k = pairKey(s.a, s.b), ts = Date.parse(s.at)
    const host = E.filter((e) => e.v && pairKey(e.v.a, e.v.b) === k && Date.parse(e.t) >= ts && Date.parse(e.t) - ts < 20 * 60e3).sort((x, y) => Date.parse(x.t) - Date.parse(y.t))[0]
    if (host) (host.nf = host.nf || []).push(s); else E.push({ kind: 'skip', sub: 'notfunny', t: s.at, v: s, nf: [s] })
  }
  const specs = allSpecials()
  for (const [id, m] of Object.entries(spGet())) { const s = specs.find((x) => x.id === id); if (s && m && (m.seen || m.stars || m.note)) E.push({ kind: 'special', t: m.at, s, m }) }
  return E.filter((e) => e.t && !isNaN(Date.parse(e.t))).sort((x, y) => Date.parse(y.t) - Date.parse(x.t))
}
function dayLabel(t) {
  const d = new Date(t), k = dayStr(d), today = dayStr(), y = new Date(); y.setDate(y.getDate() - 1)
  if (k === today) return 'Today'
  if (k === dayStr(y)) return 'Yesterday'
  try { return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }) } catch { return k }
}
const secs = (x) => (Number.isFinite(x) && x > 0 ? `${Math.round(x)}s` : '0s')
const hhmm = (t) => { try { return new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) } catch { return '' } }
function clashRow(e, i) {
  const v = e.v, A = BYID[v.a], B = BYID[v.b], win = e.kind === 'pick' ? v.winner : null
  const ws = { L: v.leftWatchedSec, R: v.rightWatchedSec }
  if (e.sub === 'clash' || e.sub === 'notfunny') { if (v.clip === v.a && ws.L == null) ws.L = v.watchedSec; if (v.clip === v.b && ws.R == null) ws.R = v.watchedSec }
  const th = (c, id, side) => `<span class="hth${win === id ? ' won' : ''}${win && win !== id ? ' lost' : ''}"><span class="hpic">${!c || c.media === 'youtube' ? `<img loading="lazy" decoding="async" src="${thumb(esc(id))}" alt="">` : ''}</span>
    <b>${esc(c?.comic || 'Retired clip')}</b><small>${ws[side] != null ? 'watched ' + secs(ws[side]) : '&nbsp;'}</small></span>`
  const stg = { intro: 'Skipped at the intro', left: 'Skipped during #1', right: 'Skipped during #2', vote: 'Skipped the ballot', done: 'Moved on' }
  const W = BYID[win]
  const what = e.kind === 'pick' ? `Picked <b>${esc(W?.comic || '?')}</b>${e.counted ? '' : ' <span class="hmuted">· didn\u2019t count (under 30s)</span>'}`
    : e.sub === 'pass' ? 'Pass <span class="hmuted">· no pick in 3s</span>'
      : e.sub === 'notfunny' ? '\u201cNot funny\u201d skip' : (stg[v.stage] || 'Skipped')
  const chips = []
  if (v.daily) chips.push(`<span class="hchip daily">Daily clash</span>`)
  if (v.why) chips.push(`<span class="hchip">${esc(v.why)}</span>`)
  if (Number.isFinite(v.decisionMs)) chips.push(`<span class="hchip">decided in ${(v.decisionMs / 1000).toFixed(1)}s</span>`)
  if (v.friend) chips.push(`<span class="hchip ${v.friend === 'agree' ? 'agree' : 'disagree'}">${v.friend === 'agree' ? 'Agreed with your friend' : 'Disagreed with your friend'}</span>`)
  for (const s of e.nf || []) chips.push(`<span class="hchip nf">\u201cNot funny\u201d on #${s.stage === 'left-skip' ? 1 : 2}${s.comic ? ' · ' + esc(s.comic) : ''}</span>`)
  const live = A && B
  return `<li class="hrow"><div class="hpair">${th(A, v.a, 'L')}<i>vs</i>${th(B, v.b, 'R')}</div>
    <div class="hmeta"><p class="hwhat">${what}<span class="htime">${hhmm(e.t)}</span></p>${chips.length ? `<p class="hchips">${chips.join('')}</p>` : ''}
    ${live ? `<p class="hacts"><a class="hbtn" href="#clash/${encodeURIComponent(v.a)}/${encodeURIComponent(v.b)}&from=history">Rewatch</a><button type="button" class="hbtn send" data-hshare="${i}" title="Send to a friend — see if they agree">Share ↗</button></p>` : ''}</div></li>`
}
function specialRow(e) {
  const { s, m } = e
  return `<li class="hrow sprow"><span class="hsp" style="background:linear-gradient(160deg,hsl(${hue(s.id)} 70% 22%) 0%,#0b0b0e 75%)">${esc(String(s.year || ''))}</span>
    <div class="hmeta"><p class="hwhat"><a href="#comic/${esc(slugOf(e.s.comic))}"><b>${esc(s.title)}</b></a> <span class="hmuted">· ${esc(s.comic)}</span><span class="htime">${hhmm(e.t)}</span></p>
    <p class="hchips">${m.seen ? '<span class="hchip">Seen</span>' : ''}${m.stars ? `<span class="hchip gold">★ ${m.stars}</span>` : ''}${m.note ? `<span class="hchip">“${esc(String(m.note).slice(0, 60))}”</span>` : ''}</p></div></li>`
}
function paintHistory() {
  const el = $('#hist'); if (!el) return
  const all = historyEntries()
  const F = { all: () => true, picks: (e) => e.kind === 'pick', skips: (e) => e.kind === 'skip', specials: (e) => e.kind === 'special' }
  const list = all.filter(F[HFILTER] || F.all)
  const n = (k) => all.filter(F[k]).length
  let html = `<div class="head"><h2>History</h2></div>
    <div class="lanes hfilters" role="group" aria-label="Filter history">${[['all', 'All'], ['picks', 'Picks'], ['skips', 'Skips'], ['specials', 'Specials']].map(([k, l]) => `<button type="button" data-hf="${k}" class="${HFILTER === k ? 'on' : ''}" aria-pressed="${HFILTER === k}">${l} <small>${n(k)}</small></button>`).join('')}</div>`
  if (!list.length) html += `<p class="empty">${all.length ? 'Nothing here under this filter yet.' : 'Your screenings, picks, skips and specials show up here, newest first. Everything stays on this device.'}</p>`
  else {
    let day = null
    html += '<div class="hdays">'
    list.forEach((e, i) => {
      const d = dayLabel(e.t)
      if (d !== day) { html += `${day ? '</ul>' : ''}<h3 class="hday">${esc(d)}</h3><ul class="hlist">`; day = d }
      html += e.kind === 'special' ? specialRow(e) : clashRow(e, i)
    })
    html += '</ul></div>'
  }
  const p = ccPref()
  html += `<div class="hsettings"><h3>Your data</h3>
    <label class="cctoggle"><input type="checkbox" id="ccon" ${p?.on ? 'checked' : ''}> Add my country to daily clash picks</label>
    <select id="ccpick" aria-label="Your country" ${p?.on ? '' : 'disabled'}>${ccOptions(p?.code || ccGuess())}</select>
    <p class="muted small">Off unless you turn it on. When on, only your daily-clash picks carry a two-letter country code. Nothing is detected from your location.</p>
    <p class="hdata"><button type="button" class="btn" id="hexport">Export my data</button><button type="button" class="btn danger" id="hclear">Clear history</button></p>
    <p class="muted small">History lives only in this browser. Clearing it resets your taste model here; picks already published to Bluesky stay published.</p></div>`
  el.innerHTML = html
  el.querySelectorAll('[data-hf]').forEach((b) => (b.onclick = () => { HFILTER = b.dataset.hf; paintHistory() }))
  el.querySelectorAll('[data-hshare]').forEach((b) => (b.onclick = () => {
    const e = list[+b.dataset.hshare]; if (!e) return
    const A = BYID[e.v.a], B = BYID[e.v.b], pick = e.kind === 'pick' ? (e.v.winner === e.v.a ? 'a' : e.v.winner === e.v.b ? 'b' : null) : null
    shareClash(A, B, pick)
  }))
  const cb = el.querySelector('#ccon'), cs = el.querySelector('#ccpick')
  if (cb) cb.onchange = () => {
    LS.set('ccAsked', true)
    if (cb.checked) { if (!cs.value) { cs.disabled = false; cb.checked = false; return toast('Choose your country, then tick the box.') } LS.set('cc', { code: cs.value, on: true, at: new Date().toISOString() }) }
    else { try { localStorage.removeItem('funnier.cc') } catch {} toast('Country removed. Future picks won\u2019t include it.') }
    paintHistory(); paintDaily()
  }
  if (cs) { cs.disabled = false; cs.onchange = () => { if (ccPref()?.on && cs.value) LS.set('cc', { code: cs.value, on: true, at: new Date().toISOString() }); else if (cs.value && !cb.checked) { cb.checked = true; cb.onchange() } } }
  el.querySelector('#hexport').onclick = exportData
  el.querySelector('#hclear').onclick = clearHistory
}
function exportData() {
  const data = {}
  try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith('funnier.')) { try { data[k.slice(8)] = JSON.parse(localStorage.getItem(k)) } catch { data[k.slice(8)] = localStorage.getItem(k) } } } } catch {}
  const blob = new Blob([JSON.stringify({ kind: 'funnier.local-data', version: 1, exported: new Date().toISOString(), data }, null, 2)], { type: 'application/json' })
  try { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `funnier-data-${dayStr()}.json`; document.body.appendChild(a); a.click(); a.remove() } catch { toast('Download blocked by the browser.') }
}
const HISTORY_KEYS = ['votes', 'partials', 'passes', 'skips', 'skipped', 'seen', 'shown', 'preds', 'dur', 'specials', 'dailyAuto', 'dailyDone', 'engine', 'engineLog']
function clearHistory() {
  let ok = false
  try { ok = window.confirm('Clear your Funnier history on this device?\n\nThis removes your picks, passes, skips and specials log, and resets your taste model here. Picks already published to Bluesky stay published.') } catch { ok = false }
  if (!ok) return
  for (const k of HISTORY_KEYS) { try { localStorage.removeItem('funnier.' + k) } catch {} }
  MODEL = fitLocal(); TRAITS = fitTraits(); ENG = null; chartChanged()
  paintHistory(); paintYou(); paintDaily(); toast('History cleared.')
}
function youSub(k) {
  YOUSUB = k === 'history' ? 'history' : 'model'
  document.querySelectorAll('[data-sub]').forEach((b) => { const on = b.dataset.sub === YOUSUB; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)) })
  const y = $('#you'), h = $('#hist'); if (y) y.hidden = YOUSUB !== 'model'; if (h) h.hidden = YOUSUB !== 'history'
  if (YOUSUB === 'history') paintHistory()
}

// ---------- accounts: Google sign-in via funnier-api (Cloudflare Worker + D1) ----------
let CFG = { apiBase: '', googleClientId: '', shareBase: SHARE_BASE }, USER = null
const signedIn = () => !!(USER && CFG.apiBase)
async function loadConfig() {
  try { const r = await fetch('config.json', { cache: 'no-cache' }); if (r.ok) CFG = { ...CFG, ...(await r.json()) } } catch {}
  if (IS_LOCAL && !CFG.apiBase && CFG.localApi) CFG.apiBase = CFG.localApi
}
async function api(path, { method = 'GET', body } = {}) {
  if (!CFG.apiBase) throw new Error('no api')
  const t = LS.get('session', null)
  const r = await fetch(CFG.apiBase + path, { method, credentials: 'include',
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(t ? { authorization: 'Bearer ' + t } : {}) },
    body: body ? JSON.stringify(body) : undefined })
  let j = null; try { j = await r.json() } catch {}
  if (r.status === 401 && t && !path.startsWith('/auth/')) { LS.set('session', null); USER = null; paintUser() }
  return { ok: !!r.ok, status: r.status, j }
}
const apiVote = (v) => ({ a: v.a, b: v.b, winner: v.winner, ...(v.why ? { why: v.why } : {}), ...(Number.isInteger(v.decisionMs) ? { ms: v.decisionMs } : {}), ...(v.daily ? { daily: v.daily } : {}), ...(sigPayload(v) ? { signals: sigPayload(v) } : {}), createdAt: v.createdAt })
// skips ("Not funny", swipe away) and passes (no pick) are watch events: synced so the swipe labels reach the humour model
const apiEvent = (k, e) => ({ kind: k, a: e.a, b: e.b, stage: e.stage || null, clip: e.clip || null, ...(Number.isFinite(e.watchedSec) ? { watchedSec: Math.round(e.watchedSec) } : {}),
  ...(Number.isInteger(e.decisionMs) ? { ms: e.decisionMs } : {}), ...(e.daily ? { daily: e.daily } : {}), ...(sigPayload(e) ? { signals: sigPayload(e) } : {}), createdAt: e.at })
let syncingEv = null, evT = null
function syncEvents() {
  if (!signedIn()) return Promise.resolve()
  if (syncingEv) return syncingEv
  syncingEv = (async () => {
    const key = 'u:' + USER.id, since = LS.get('evSyncedUser', '') === key ? LS.get('evSyncedAt', '') : ''
    const ok = (e) => e && typeof e.a === 'string' && typeof e.b === 'string' && typeof e.at === 'string' && e.at > since
    const all = [...LS.get('skips', []).filter(ok).map((e) => apiEvent('skip', e)), ...LS.get('passes', []).filter(ok).map((e) => apiEvent('pass', e))]
      .sort((x, y) => (x.createdAt < y.createdAt ? -1 : 1))
    for (let i = 0; i < all.length; i += 200) {
      const chunk = all.slice(i, i + 200), r = await api('/events', { method: 'POST', body: { events: chunk } })
      if (!r.ok) return
      LS.set('evSyncedAt', chunk[chunk.length - 1].createdAt); LS.set('evSyncedUser', key)
    }
  })().catch(() => {}).finally(() => (syncingEv = null))
  return syncingEv
}
function queueEvents() { if (!signedIn()) return; clearTimeout(evT); evT = setTimeout(() => syncEvents(), 1500) }
let syncing = null
function syncVotes() {
  if (!signedIn()) return Promise.resolve()
  if (syncing) return syncing
  syncing = (async () => {
    const since = LS.get('syncedAt', ''), key = 'u:' + USER.id
    const all = LS.get('votes', []).filter((v) => v && v.a && v.b && v.winner && (LS.get('syncedUser', '') !== key || String(v.createdAt) > since))
    for (let i = 0; i < all.length; i += 500) {
      const chunk = all.slice(i, i + 500), r = await api('/votes', { method: 'POST', body: { votes: chunk.map(apiVote) } })
      if (!r.ok) return
      LS.set('syncedAt', chunk.map((v) => String(v.createdAt)).sort().pop()); LS.set('syncedUser', key)
    }
  })().finally(() => (syncing = null))
  return syncing
}
async function initAccount() {
  if (!CFG.apiBase || !LS.get('session', null)) { paintUser(); return }
  try { const r = await api('/me'); if (r.ok) { USER = r.j.user; afterSignIn(r.j.needsProfile, false) } } catch {}
  paintUser()
}
async function afterSignIn(needs, fresh) {
  paintUser(); paintProfilePage()
  syncVotes().catch(() => {}); syncEvents(); syncProfile().catch(() => {})
  const pa = LS.get('pendingAccept', null)
  if (pa?.code) {
    try { const r = await api(`/invites/${encodeURIComponent(pa.code)}/accept`, { method: 'POST', body: { open_id: pa.open_id } }); if (r.ok) toast(`You and ${r.j.friend?.username || pa.username} are now friends.`) } catch {}
    LS.set('pendingAccept', null)
  }
  if (needs && (fresh || !LS.get('onboardSeen', false))) openOnboarding()
  else if (fresh) toast(`Signed in as ${USER.username || USER.name || 'you'}.`)
}
async function onGoogleCredential(resp) {
  try {
    const r = await api('/auth/google', { method: 'POST', body: { credential: resp.credential } })
    if (!r.ok || !r.j?.token) return toast(r.status === 503 ? 'Google sign-in is coming soon.' : 'Sign-in didn\u2019t work. Please try again.')
    LS.set('session', r.j.token); USER = r.j.user; setMenu(false)
    afterSignIn(r.j.needsProfile, true)
  } catch { toast('Sign-in didn\u2019t work. Please try again.') }
}
let gisP = null
function loadGIS() {
  if (gisP) return gisP
  gisP = new Promise((res, rej) => {
    if (window.google?.accounts?.id) return res(window.google)
    const t = document.createElement('script'); t.src = 'https://accounts.google.com/gsi/client'; t.async = true
    t.onload = () => res(window.google); t.onerror = () => { gisP = null; rej(new Error('gis')) }
    document.head.appendChild(t)
  }).then((g) => { g.accounts.id.initialize({ client_id: CFG.googleClientId, callback: onGoogleCredential, auto_select: false, itp_support: true, use_fedcm_for_prompt: true }); return g })
  return gisP
}
function renderGoogleButton(host) {
  if (!host || !CFG.googleClientId || !CFG.apiBase) return
  loadGIS().then((g) => { if (document.body.contains(host)) { host.innerHTML = ''; g.accounts.id.renderButton(host, { type: 'standard', theme: 'filled_black', size: 'large', shape: 'pill', text: 'signin_with', logo_alignment: 'left', width: 256 }) } })
    .catch(() => { host.innerHTML = '<p class="um-note">Couldn\u2019t reach Google. Check your connection and try again.</p>' })
}
async function signOut() {
  try { await api('/auth/logout', { method: 'POST' }) } catch {}
  try { window.google?.accounts?.id?.disableAutoSelect() } catch {}
  LS.set('session', null); USER = null; SERVER_HUMOUR = null; CHART = null; setMenu(false); paintUser(); toast('Signed out. Your picks stay on this device.')
  if (!$('#v-profile')?.hidden) paintProfilePage()
}
async function deleteAccount() {
  let ok = false
  try { ok = window.confirm('Delete your Funnier account?\n\nThis permanently removes your profile, synced picks, friends and invites from our servers. Your history on this device stays until you clear it.') } catch {}
  if (!ok) return
  const r = await api('/me', { method: 'DELETE' }).catch(() => null)
  if (!r?.ok) return toast('Couldn\u2019t delete right now. Please try again.')
  LS.set('session', null); LS.set('syncedAt', ''); USER = null; setMenu(false); paintUser(); showTab('arena'); toast('Your account and its data are deleted.')
}
async function addFriend(inv, btn) {
  if (!inv?.code) return
  if (!signedIn()) {
    LS.set('pendingAccept', { code: inv.code, open_id: inv.open_id, username: inv.inviter?.username || '' })
    toast(`Sign in and you and ${inv.inviter?.username || 'your friend'} become friends.`); setMenu(true); return
  }
  const r = await api(`/invites/${encodeURIComponent(inv.code)}/accept`, { method: 'POST', body: { open_id: inv.open_id } }).catch(() => null)
  if (r?.ok) { inv.friends = true; if (btn) { btn.disabled = true; btn.innerHTML = `${avatarHTML(inv.inviter)}Friends with ${esc(inv.inviter.username)} ✓` } toast(`You and ${inv.inviter.username} are now friends.`) }
  else toast('Couldn\u2019t add them right now.')
}
// opening https://…/#i/<code>: "<username> challenged you", their clash plays next
const parseInvite = (h) => { const m = String(h || '').match(/^#i\/([A-Za-z0-9]{4,16})/); return m ? m[1] : null }
async function openInvite(code) {
  if (!CFG.apiBase) return false
  try {
    const r = await api('/invites/' + encodeURIComponent(code))
    if (!r.ok || !r.j?.a) { toast('That invite has expired, so here is tonight\u2019s screening.'); return false }
    pendingClash = { a: r.j.a, b: r.j.b, pick: r.j.pick || null, invite: { code, inviter: r.j.inviter, open_id: r.j.open_id, self: !!r.j.self, friends: !!r.j.friends } }
    return true
  } catch { return false }
}

// ---------- avatars: one seed -> one mascot (mascot-avatars, bundled, MIT) ----------
// The seed is all we store (users.avatar_seed). Species + palette are derived from it here so the same
// seed always draws the same animal; v1 preset ids map to the seed 'preset-<id>'.
const AV_SPECIES = ['cat', 'bear', 'bunny', 'bird', 'dog', 'frog', 'penguin', 'mouse']
const AV_NAMES = { cat: 'Cat', bear: 'Bear', bunny: 'Bunny', bird: 'Bird', dog: 'Dog', frog: 'Frog', penguin: 'Penguin', mouse: 'Mouse' }
const AV_PALETTES = PALETTES.filter((p) => p.name !== 'Slate').map((p) => p.name) // no grey-on-grey: comedy wants colour
const AV_LEGACY = ['grin', 'deadpan', 'wink', 'shock', 'smirk', 'cool', 'nerd', 'tash', 'sleepy', 'tongue', 'monocle', 'clown']
const SEED_RE = /^[A-Za-z0-9_-]{1,40}$/
function avHash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) } h ^= h >>> 15; h = Math.imul(h, 2246822507); return (h ^ (h >>> 13)) >>> 0 }
const avLook = (seed) => { const h = avHash(String(seed)); return { species: AV_SPECIES[h % AV_SPECIES.length], palette: AV_PALETTES[Math.floor(h / AV_SPECIES.length) % AV_PALETTES.length] } }
const seedOf = (u) => (u?.avatar_seed && SEED_RE.test(u.avatar_seed) ? u.avatar_seed : u?.avatar_id && AV_LEGACY.includes(u.avatar_id) ? 'preset-' + u.avatar_id : null)
const AV_CACHE = new Map()
function seedSVG(seed) {
  if (!seed || !SEED_RE.test(seed)) return SILHOUETTE
  let svg = AV_CACHE.get(seed)
  if (!svg) {
    svg = renderAvatar({ seed, ...avLook(seed) }).replace(/<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"([^>]*?) width="\d+" height="\d+">/, '<svg xmlns="http://www.w3.org/2000/svg"$1 class="avsvg" aria-hidden="true" focusable="false">')
    if (AV_CACHE.size > 300) AV_CACHE.clear()
    AV_CACHE.set(seed, svg)
  }
  return svg
}
// a fresh seed whose look (species + palette) differs from the last few rolls, so every reroll visibly changes
const AV_RECENT = []
function newSeed() {
  const abc = 'abcdefghijkmnopqrstuvwxyz23456789'
  for (let tries = 0; ; tries++) {
    const r = crypto.getRandomValues(new Uint8Array(10)), seed = [...r].map((x) => abc[x % abc.length]).join('')
    const l = avLook(seed), key = l.species + '/' + l.palette, last = AV_RECENT[AV_RECENT.length - 1] || ''
    if (tries < 40 && (AV_RECENT.includes(key) || last.split('/')[0] === l.species)) continue
    AV_RECENT.push(key); if (AV_RECENT.length > 12) AV_RECENT.shift()
    return seed
  }
}
// every visitor gets their own mascot from the first visit: a random seed kept on this device (funnier.avatarSeed).
// A signed-in user's saved avatar_seed overrides it; onboarding preselects it so the same mascot carries over.
function deviceSeed() {
  let s = null
  try { s = LS.get('avatarSeed', null) } catch {}
  if (typeof s === 'string' && SEED_RE.test(s)) return s
  s = newSeed()
  try { LS.set('avatarSeed', s) } catch {}
  return s
}
const mySeed = () => seedOf(USER) || deviceSeed()
const meHTML = () => (seedOf(USER) || !(USER?.google_avatar && /^https:\/\//.test(USER.google_avatar)) ? `<span class="av">${seedSVG(mySeed())}</span>` : avatarHTML(USER))
function avatarHTML(u) {
  const seed = seedOf(u)
  if (seed) return `<span class="av">${seedSVG(seed)}</span>`
  if (u?.google_avatar && /^https:\/\//.test(u.google_avatar)) return `<span class="av"><img src="${esc(u.google_avatar)}" alt="" referrerpolicy="no-referrer" loading="lazy"></span>`
  return `<span class="av sil">${SILHOUETTE}</span>`
}
const DICE = '<svg viewBox="0 0 24 24" aria-hidden="true" class="dicesvg"><rect x="3.5" y="3.5" width="17" height="17" rx="4.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="8.5" cy="8.5" r="1.6" fill="currentColor"/><circle cx="15.5" cy="8.5" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="8.5" cy="15.5" r="1.6" fill="currentColor"/><circle cx="15.5" cy="15.5" r="1.6" fill="currentColor"/></svg>'
// the reroller: one big avatar + a Reroll button; returns { get seed() } and wires itself into `root`
function avatarRoller(root, start) {
  let seed = start && SEED_RE.test(start) ? start : newSeed(), busy = 0
  const big = root.querySelector('.avbig'), cap = root.querySelector('.avcap'), btn = root.querySelector('[data-av="reroll"]')
  const paint = () => { big.innerHTML = seedSVG(seed); if (cap) cap.textContent = AV_NAMES[avLook(seed).species] || '' ; big.setAttribute('aria-label', `Your avatar: ${AV_NAMES[avLook(seed).species] || 'mascot'}`) }
  paint()
  btn.onclick = () => {
    seed = newSeed()
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
    clearTimeout(busy)
    if (still) { paint(); return }
    big.classList.remove('roll'); void big.offsetWidth; big.classList.add('roll')
    btn.classList.remove('spin'); void btn.offsetWidth; btn.classList.add('spin')
    busy = setTimeout(paint, 170) // swap at the squash, mid-spin
  }
  return { get seed() { return seed } }
}
const rollerHTML = (label = 'Reroll') => `<div class="avroll"><div class="avbig" role="img"></div><div class="avside"><span class="avcap"></span><button type="button" class="avbtn" data-av="reroll">${DICE}<span>${label}</span></button><small class="muted">Every roll is a new one-off.</small></div></div>`

const ADJ = ['Deadpan', 'Punchy', 'Snarky', 'Giggly', 'Sly', 'Witty', 'Cheeky', 'Zany', 'Dry', 'Absurd', 'Silly', 'Smug', 'Wry', 'Goofy']
const ANI = ['Duck', 'Panda', 'Otter', 'Llama', 'Badger', 'Moose', 'Gecko', 'Walrus', 'Ferret', 'Toucan', 'Yak', 'Heron', 'Lemur', 'Puffin']
const pickR = (a) => a[Math.floor(Math.random() * a.length)]
const funnyName = () => pickR(ADJ) + pickR(ANI) + (10 + Math.floor(Math.random() * 90))

// ---------- onboarding / edit profile sheet ----------
function openOnboarding() {
  const sh = $('#sheet'); if (!sh || !USER) return
  LS.set('onboardSeen', true)
  const u = USER, maxY = new Date().getFullYear() - 13, first = !u.username
  const sex = u.sex_at_birth || ''
  sh.innerHTML = `<div class="sheetcard" role="dialog" aria-modal="true" aria-labelledby="obh">
    <button type="button" class="sheetx" data-ob="close" aria-label="Close">×</button>
    <h2 id="obh">${first ? 'Make it yours' : 'Your profile'}</h2>
    <p class="muted">${first ? 'Your Four Favourites, a name and a mascot. That\u2019s what friends see.' : 'Your name and mascot are what friends see.'}</p>
    <form id="obform" novalidate>
      <fieldset class="obl obfavset"><legend>Four favourite comics</legend><div class="obfavs"></div><small class="muted">Pick up to four, in order. They lead your profile; change them any time.</small></fieldset>
      <label class="obl">Username<span class="obrow"><input id="obuser" maxlength="20" autocomplete="off" spellcheck="false" value="${esc(u.username || funnyName())}"><button type="button" class="obdice" data-ob="dice" aria-label="Reroll name" title="Reroll name">${DICE}</button></span><small class="oberr" data-err="username"></small></label>
      <fieldset class="obl"><legend>Avatar</legend>${rollerHTML()}<small class="oberr" data-err="avatar_seed"></small></fieldset>
      <div class="obstats"><p class="obwhy"><b>Unlock your stats.</b> These power country and age splits (“58% of 25–34s in the UK picked Seinfeld”). They are never shown on your profile or to anyone else.</p>
        <label class="obl">Country<select id="obcc">${ccOptions(u.country || ccGuess())}</select><small class="oberr" data-err="country"></small></label>
        <label class="obl">Year of birth<input id="obyear" inputmode="numeric" pattern="[0-9]*" maxlength="4" placeholder="e.g. 1994" value="${u.birth_year || ''}"><small class="oberr" data-err="birth_year"></small></label>
        <fieldset class="obl"><legend>Sex at birth</legend><div class="obseg">${[['male', 'Male'], ['female', 'Female'], ['skip', 'Prefer not to say']].map(([k, l]) => `<label><input type="radio" name="obsex" value="${k}" ${sex === k ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div><small class="oberr" data-err="sex_at_birth"></small></fieldset></div>
      <p class="oberr big" data-err="form"></p>
      <div class="obact"><button type="submit" class="dhbtn">${first ? 'Save and start' : 'Save'}</button><button type="button" class="dhghost" data-ob="close">${first ? 'Later' : 'Cancel'}</button></div>
      <p class="muted small">See our <a href="privacy.html" target="_blank" rel="noopener">privacy policy</a>. You can delete your account any time from the account menu.</p>
    </form></div>`
  sh.hidden = false
  // Four Favourites first: chips in tap order (kept on this device, published with the profile)
  let obFavs = favsLocal().slice()
  const favBox = sh.querySelector('.obfavs')
  const paintObFavs = () => { favBox.innerHTML = comicNames().map((n) => { const i = obFavs.indexOf(n), p = comicPic(n)
    return `<button type="button" class="obfav${i >= 0 ? ' on' : ''}" data-obfav="${esc(n)}" aria-pressed="${i >= 0}">${p.photo ? `<img src="${esc(p.photo)}" alt="" loading="lazy">` : `<span class="obfi">${esc(n.slice(0, 1))}</span>`}<span>${esc(n)}</span>${i >= 0 ? `<i>${i + 1}</i>` : ''}</button>` }).join('') }
  paintObFavs()
  favBox.onclick = (e) => { const b = e.target.closest('[data-obfav]'); if (!b) return; const n = b.dataset.obfav, i = obFavs.indexOf(n); if (i >= 0) obFavs.splice(i, 1); else if (obFavs.length < 4) obFavs.push(n); else return toast('Four is the limit. Tap one to take it out first.'); paintObFavs() }
  const keepFavs = () => { if (JSON.stringify(obFavs) !== JSON.stringify(favsLocal())) saveFavs(obFavs) }
  const close = () => { keepFavs(); sh.hidden = true; sh.innerHTML = '' }
  const form = sh.querySelector('#obform')
  let roller = null
  // bind submit FIRST: if anything below throws, the form must never fall back to a native GET submit (a silent page reload)
  form.onsubmit = (e) => { e.preventDefault(); saveProfile().catch((err) => { console.error('profile save', err); obFail('Something went wrong on this page. Please reload and try again.') }) }
  const errEl = (k) => sh.querySelector(`[data-err="${k}"]`)
  const LABEL = { username: 'Username', avatar_seed: 'Avatar', country: 'Country', birth_year: 'Year of birth', sex_at_birth: 'Sex at birth' }
  const FIELD = { username: '#obuser', country: '#obcc', birth_year: '#obyear' }
  // every failure says so next to the Save button (where the click happened), and the first bad field scrolls into view
  function obFail(msg, fields = {}) {
    let first = null
    for (const [k, m] of Object.entries(fields)) { const el = errEl(k); if (el) el.textContent = m; if (!first) first = k }
    const sum = Object.entries(fields).map(([k, m]) => `${LABEL[k] || k}: ${m}`).join(' ')
    const f = errEl('form'); if (f) { f.textContent = msg || sum || 'Couldn\u2019t save. Please try again.'; f.setAttribute('role', 'alert') }
    const inp = first && FIELD[first] ? sh.querySelector(FIELD[first]) : null
    if (inp) { try { inp.scrollIntoView({ block: 'center', behavior: 'smooth' }) } catch {} try { inp.focus({ preventScroll: true }) } catch {} }
    else { try { f?.scrollIntoView({ block: 'nearest' }) } catch {} }
  }
  const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/
  const nameHint = (v) => USERNAME_RE.test(v) ? '' : v.length < 3 ? 'At least 3 characters.' : v.length > 20 ? 'At most 20 characters.' : 'Only letters, numbers and _ (no spaces or symbols).'
  async function saveProfile() {
    sh.querySelectorAll('.oberr').forEach((x) => { x.textContent = ''; x.removeAttribute('role') })
    const val = (q) => sh.querySelector(q)?.value?.trim() || ''
    const errs = {}
    const name = val('#obuser'), nh = nameHint(name); if (nh) errs.username = nh
    const seed = roller?.seed || seedOf(u) || deviceSeed()
    const body = { username: name, avatar_seed: seed }
    const cc = val('#obcc'), yr = val('#obyear'), sx = sh.querySelector('input[name=obsex]:checked')?.value
    if (cc) body.country = cc
    if (yr) { const y = Number(yr); if (!/^\d{4}$/.test(yr) || y < 1900 || y > new Date().getFullYear()) errs.birth_year = 'Enter a four-digit year, like 1994.'; else body.birth_year = y }
    if (sx) body.sex_at_birth = sx
    if (Object.keys(errs).length) return obFail('', errs)
    const btn = sh.querySelector('button[type=submit]'), label = btn.textContent; btn.disabled = true; btn.textContent = 'Saving\u2026'
    let r = null
    try { r = await api('/me/profile', { method: 'PUT', body }) } catch (err) { console.warn('profile save', err) }
    if (!sh.contains(btn)) return // sheet closed meanwhile
    btn.disabled = false; btn.textContent = label
    if (!r) return obFail('Couldn\u2019t reach Funnier. Check your connection and press Save again.')
    if (r.j?.error === 'too_young') {
      await api('/me', { method: 'DELETE' }).catch(() => {})
      LS.set('session', null); USER = null; paintUser()
      sh.querySelector('.sheetcard').innerHTML = `<h2>Sorry</h2><p>Funnier accounts are for people aged 13 and over, so we didn\u2019t keep this sign-in. You can keep watching and voting on this device without an account.</p><div class="obact"><button type="button" class="dhbtn" data-ob="close">OK</button></div>`
      sh.querySelector('[data-ob="close"]').onclick = close
      return
    }
    if (r.status === 401) { // session gone (signed out elsewhere, cleared storage, or a different site address): say so and offer sign-in
      obFail('Your sign-in has expired, so this couldn\u2019t be saved. Sign in with Google again, then press Save.')
      const f = errEl('form'); if (f && !f.querySelector('button')) { const b = document.createElement('button'); b.type = 'button'; b.className = 'dhghost obsignin'; b.textContent = 'Sign in again'; b.onclick = () => { close(); setMenu(true) }; f.append(' ', b) }
      return
    }
    if (!r.ok) {
      const f = { ...(r.j?.fields || {}) }
      if (f.username && /taken/.test(f.username)) f.username = 'That name\u2019s taken. Reroll or try another.'
      return obFail(Object.keys(f).length ? '' : `Couldn\u2019t save right now${r.status ? ' (error ' + r.status + ')' : ''}. Please try again in a moment.`, f)
    }
    if (!r.j?.user) return obFail('Couldn\u2019t save right now. Please try again in a moment.')
    if (seedOf(r.j.user)) LS.set('avatarSeed', seedOf(r.j.user)) // this device keeps the mascot they chose
    USER = r.j.user; close(); paintUser(); paintProfilePage(); toast(first ? `Welcome, ${USER.username}.` : 'Profile saved.')
  }
  sh.onclick = (e) => { if (e.target === sh) close() }
  sh.querySelectorAll('[data-ob="close"]').forEach((b) => (b.onclick = close))
  const userIn = sh.querySelector('#obuser')
  sh.querySelector('[data-ob="dice"]').onclick = () => { userIn.value = funnyName(); errEl('username').textContent = '' }
  userIn.addEventListener('input', () => { const v = userIn.value.trim(); errEl('username').textContent = v ? nameHint(v) : '' })
  try { roller = avatarRoller(sh.querySelector('.avroll'), seedOf(u) || deviceSeed()) } catch (err) { console.error('avatar roller', err) }
}

// ---------- change avatar: the same reroller on its own ----------
function openAvatarSheet() {
  const sh = $('#sheet'); if (!sh || !USER) return
  sh.innerHTML = `<div class="sheetcard avsheet" role="dialog" aria-modal="true" aria-labelledby="avh">
    <button type="button" class="sheetx" data-ob="close" aria-label="Close">×</button>
    <h2 id="avh">Change avatar</h2><p class="muted">Roll until one feels like you.</p>
    ${rollerHTML()}<p class="oberr big" data-err="form"></p>
    <div class="obact"><button type="button" class="dhbtn" data-ob="save">Keep this one</button><button type="button" class="dhghost" data-ob="close">Cancel</button></div></div>`
  sh.hidden = false
  const close = () => { sh.hidden = true; sh.innerHTML = '' }
  sh.onclick = (e) => { if (e.target === sh) close() }
  sh.querySelectorAll('[data-ob="close"]').forEach((b) => (b.onclick = close))
  const roller = avatarRoller(sh.querySelector('.avroll'), mySeed())
  sh.querySelector('[data-ob="save"]').onclick = async (e) => {
    const btn = e.currentTarget; btn.disabled = true
    const r = await api('/me/profile', { method: 'PUT', body: { avatar_seed: roller.seed } }).catch(() => null); btn.disabled = false
    if (!r?.ok) { sh.querySelector('[data-err=form]').textContent = !r ? 'Couldn\u2019t reach Funnier. Check your connection and try again.' : r.status === 401 ? 'Your sign-in has expired. Sign in with Google again from the account menu.' : `Couldn\u2019t save right now (error ${r.status}). Please try again.`; return }
    if (seedOf(r.j.user)) LS.set('avatarSeed', seedOf(r.j.user)) // this device keeps the mascot they chose
    USER = r.j.user; close(); paintUser(); paintProfilePage(); toast('New look saved.')
  }
}

// ---------- profiles: the "Letterboxd for comedy" identity layer ----------
// Four Favourites, pinned clips, the humour chart, the specials diary and (later) AI sets. Everything lives on this device
// first (funnier.favs / funnier.pins / funnier.specials) and publishes to the API once signed in
// (PUT /me/profile-data, PUT /me/specials); public at www.funnier.si/u/<username> (#u/<username>).
const PROFILE_HOST = 'funnier.si/u/'
const favsLocal = () => arr(LS.get('favs', [])).filter((n) => typeof n === 'string').slice(0, 4)
const pinsLocal = () => arr(LS.get('pins', [])).filter((id) => typeof id === 'string').slice(0, 6)
const visLocal = () => ({ profile: 'public', diary: 'friends', ...(LS.get('vis', null) || {}) })
const profileURL = (name) => (CFG.shareBase || SHARE_BASE).replace(/#.*$/, '').replace(/\/?$/, '/') + 'u/' + encodeURIComponent(name)
let CHART = null, SERVER_HUMOUR = null
function comicNames() { return [...new Set([...Object.keys(COMICS), ...CLIPS.map((c) => c.comic)])].filter((n) => CLIPS.some((c) => c.comic === n) || COMICS[n]) }
function comicPic(name) { // { name, photo, credit, license } for cards and tiles (Commons portraits only)
  const P = COMICS[name] || {}, ph = photoOf(P)
  return { name, photo: ph || '', credit: ph ? P.photoCredit || '' : '', license: ph ? P.photoLicense || '' : '' }
}
function myChart() {
  if (CHART) return CHART
  MODEL = MODEL || fitLocal()
  const votes = LS.get('votes', []).filter((v) => v && BYID[v.a] && BYID[v.b]).map((v) => ({ a: v.a, b: v.b, winner: v.winner, w: Number.isFinite(v.weight) ? v.weight : voteWeight(v) }))
  const skips = clipSkips().map((s) => ({ clip: s.clip, w: skipW(s) }))
  let engine = null; try { engine = engineReadout() } catch (e) { console.warn('engine', e) }
  CHART = computeChart({ votes, skips, favs: favsLocal(), clips: BYID, theory: THEORY, comics: COMICS, score: (id) => MODEL.score(id), server: SERVER_HUMOUR, engine })
  return CHART
}
const chartSnap = (c) => ({ n: c.n, model: c.model, band: c.band, cl: c.cl, conf: c.conf, dims: c.dims, ops: c.ops, sty: c.sty, top: c.top, line: c.line, mml: c.mml, serverLine: c.serverLine || undefined, adjacent: c.adjacent || undefined, funniest: c.funniest || undefined })
const chartKey = (c) => JSON.stringify([c.dims, c.line, c.mml, c.funniest?.id || ''])
function chartChanged() { CHART = null; queueChartPush() }
function saveFavs(a) { LS.set('favs', a.slice(0, 4)); LS.set('profAt', new Date().toISOString()); queueProfilePush({ favs: a.slice(0, 4) }); try { engineFit(4) } catch {} chartChanged() }
function savePins(a) { LS.set('pins', a.slice(0, 6)); LS.set('profAt', new Date().toISOString()); queueProfilePush({ pins: a.slice(0, 6) }) }

// ---- sync ----
let pushT = null, pushBody = {}
function queueProfilePush(patch) { if (!signedIn()) return; Object.assign(pushBody, patch); clearTimeout(pushT); pushT = setTimeout(flushProfilePush, 700) }
async function flushProfilePush() {
  const b = pushBody; pushBody = {}
  if (!Object.keys(b).length || !signedIn()) return
  const r = await api('/me/profile-data', { method: 'PUT', body: b }).catch(() => null)
  if (r?.ok) { if (b.chart) LS.set('chartPushed', chartKey(b.chart)); LS.set('vis', { profile: r.j.vis_profile, diary: r.j.vis_diary }) }
}
function queueChartPush() {
  if (!signedIn()) return
  const c = myChart(); if (!c.n && !c.favs.length) return
  if (LS.get('chartPushed', '') !== chartKey(c)) queueProfilePush({ chart: chartSnap(c) })
}
let spQ = {}, spT = null
function queueSpecialPush(id, e) {
  if (!signedIn()) return
  spQ[id] = { seen: !!e.seen, stars: e.stars || 0, note: e.note || '', at: e.at || new Date().toISOString() }
  clearTimeout(spT); spT = setTimeout(() => { const log = spQ; spQ = {}; api('/me/specials', { method: 'PUT', body: { log } }).catch(() => {}) }, 800)
}
async function syncProfile() {
  if (!signedIn()) return
  const r = await api('/me/profile-data').catch(() => null)
  if (!r?.ok || !r.j) return
  const S = r.j, localAt = LS.get('profAt', ''), srvAt = S.updated_at || '', lf = favsLocal(), lp = pinsLocal(), patch = {}
  const srvEmpty = !arr(S.favs).length && !arr(S.pins).length
  if ((lf.length || lp.length) && (srvEmpty || !srvAt || localAt > srvAt)) { if (lf.length) patch.favs = lf; if (lp.length) patch.pins = lp }
  else { if (arr(S.favs).length) LS.set('favs', S.favs); if (arr(S.pins).length) LS.set('pins', S.pins) }
  LS.set('vis', { profile: S.vis_profile || 'public', diary: S.vis_diary || 'friends' })
  // specials diary: the newest edit wins, both ways
  const loc = spGet(), srv = S.specials || {}, up = {}
  let changed = false
  for (const [id, e] of Object.entries(loc)) if (e && (!srv[id] || String(e.at || '') > String(srv[id].at || ''))) up[id] = { seen: !!e.seen, stars: e.stars || 0, note: e.note || '', at: e.at || new Date().toISOString() }
  for (const [id, e] of Object.entries(srv)) if (!up[id] && (!loc[id] || String(e.at) > String(loc[id].at || ''))) { loc[id] = { seen: !!e.seen, stars: e.stars || 0, note: e.note || '', at: e.at }; changed = true }
  if (changed) LS.set(SPK, loc)
  if (Object.keys(up).length) api('/me/specials', { method: 'PUT', body: { log: up } }).catch(() => {})
  if (Object.keys(patch).length) queueProfilePush(patch)
  try { const h = await api('/me/humour'); SERVER_HUMOUR = h.ok ? h.j?.humour || null : null } catch {}
  chartChanged()
  if (!$('#v-profile')?.hidden) paintProfilePage()
}
// the link preview (og:image) for funnier.si/u/<name>: drawn here from the owner's chart, uploaded when it changes
let ogBusy = false
async function maybeUploadOG() {
  if (ogBusy || !signedIn() || !USER?.username || visLocal().profile !== 'public' || typeof document === 'undefined') return
  const c = myChart(); if (!c.n && !c.favs.length) return
  const key = chartKey(c) + '|' + USER.username + '|' + mySeed()
  if (LS.get('ogPushed', '') === key) return
  ogBusy = true
  try {
    const cv = document.createElement('canvas')
    if (!(await drawCard(cv, 'og', cardData(), 'og'))) return
    const blob = await toBlob(cv); if (!blob) return
    const t = LS.get('session', null)
    const r = await fetch(CFG.apiBase + '/me/og', { method: 'POST', credentials: 'include', headers: { 'content-type': 'image/png', ...(t ? { authorization: 'Bearer ' + t } : {}) }, body: blob })
    if (r.ok) LS.set('ogPushed', key)
  } catch {} finally { ogBusy = false }
}

// ---- rendering ----
const DIM_HINT_V2 = 'Each number is your model\u2019s weight on that kind of comedy (50 = neutral), the shaded band is how unsure it still is. It starts at the crowd\u2019s taste and every vote moves it.'
const DIM_HINT = 'Each number is how often that kind of comedy wins your pick when it\u2019s on screen (50 = neutral; it starts at 50 and moves with every vote).'
function favTile(name, i, own) {
  if (!name) return own ? `<button type="button" class="up-fav empty" data-act="favs" aria-label="Pick a favourite comic"><span>+</span></button>` : '<div class="up-fav empty"></div>'
  const p = comicPic(name), first = CLIPS.find((k) => k.comic === name && k.media === 'youtube'), src = p.photo || (first ? thumb(first.id) : '')
  return `<a class="up-fav" href="#comic/${esc(slugOf(name))}">${src ? `<img src="${esc(src)}" alt="" loading="lazy" decoding="async"${p.photo ? '' : ' class="yt"'}>` : ''}<i>${i + 1}</i><b>${esc(name)}</b></a>`
}
function fourHTML(favs, own) {
  if (!own && !favs.length) return ''
  return `<section class="up-sec"><div class="up-sh"><h3>Four favourites</h3>${own ? `<button type="button" class="up-edit" data-act="favs">${favs.length ? 'Edit' : 'Pick'}</button>` : ''}</div>
    <div class="up-four">${[0, 1, 2, 3].map((i) => favTile(favs[i], i, own)).join('')}</div></section>`
}
function dimRows(c) {
  return Object.keys(c.dims).sort((x, y) => c.dims[y] - c.dims[x]).map((k) => { const v = c.dims[k], d = v - 50, bd = c.band?.[k], cl = c.cl?.[k]
    const band = Array.isArray(bd) ? `<s class="up-band" style="left:${Math.max(0, bd[0])}%;width:${Math.max(1, Math.min(100, bd[1]) - Math.max(0, bd[0]))}%"></s>` : ''
    return `<div class="up-dim"${cl ? ` title="${esc(confText(cl, c.conf?.[k]))}"` : ''}><span>${esc(dimLabel(k))}${cl ? `<small class="up-conf c-${esc(cl)}">${esc(confText(cl, c.conf?.[k]))}</small>` : ''}</span><i class="up-bar">${band}<b style="${d >= 0 ? `left:50%;width:${d}%` : `left:${50 + d}%;width:${-d}%`}" class="${d >= 0 ? 'pos' : 'neg'}"></b></i><em>${v}</em></div>` }).join('')
}
function chartHTML(c, own, who) {
  if (!c?.dims) return `<section class="up-sec"><div class="up-sh"><h3>Sense of humour</h3></div><p class="muted">${own ? 'Vote on a few clashes (or pick your Four Favourites) and your chart draws itself.' : 'No chart yet.'}</p></section>`
  const sty = STY.filter((s) => c.sty?.[s.k] != null)
  return `<section class="up-sec"><div class="up-sh"><h3>Sense of humour</h3>${own ? '<button type="button" class="up-edit" data-act="share" data-kind="chart">Share chart ↗</button>' : ''}</div>
    <div class="up-chart"><div class="up-radar">${chartSVG([{ dims: c.dims, band: c.band, color: CHART_COLORS[0] }], { size: 400, title: (who || 'Your') + ' humour chart' })}</div>
    <div class="up-legend">${c.adjacent ? `<p class="up-adj"><b>${c.adjacent.pct}%</b> ${esc(c.adjacent.short)}-adjacent</p>` : ''}
      <div class="up-dims">${dimRows(c)}</div>
      ${c.funniest ? `<p class="up-fun"><span class="eyebrow">Funniest to ${own ? 'you' : 'them'}</span><a href="https://www.youtube.com/watch?v=${esc(c.funniest.id)}" target="_blank" rel="noopener">\u201c${esc(c.funniest.title)}\u201d</a> <span class="muted">${esc(c.funniest.comic)}</span></p>` : ''}
      ${arr(c.ops).length ? `<div class="up-ops"><span class="eyebrow">Favourite moves</span>${c.ops.slice(0, 4).map((o) => `<span class="chip">${esc(o.label)} <b>${o.v}</b></span>`).join('')}</div>` : ''}
      ${sty.length ? `<div class="up-stys">${sty.map((s) => `<div class="up-sty"><span>${s.lo}</span><i><b style="left:${c.sty[s.k]}%"></b></i><span>${s.hi}</span></div>`).join('')}</div>` : ''}
      ${c.serverLine ? `<p class="muted small">From ${own ? 'your' : 'their'} rewinds: ${esc(c.serverLine)}</p>` : ''}
      <p class="muted small up-hint">${c.band && Object.keys(c.band).length ? DIM_HINT_V2 : DIM_HINT}${c.n ? ` Built from ${c.n} pick${c.n === 1 ? '' : 's'}.` : ''}</p>
      ${own ? timelineHTML(8) : ''}</div></div></section>`
}
function pinsHTML(pins, own) {
  const ok = pins.filter((id) => BYID[id])
  if (!own && !ok.length) return ''
  return `<section class="up-sec"><div class="up-sh"><h3>Pinned clips</h3>${own ? `<button type="button" class="up-edit" data-act="pins">${ok.length ? 'Edit' : 'Pin clips'}</button>` : ''}</div>
    ${ok.length ? `<div class="rail up-pins">${ok.map((id) => clipTile({ id })).join('')}</div>` : '<p class="muted">Pin up to six clips you\u2019d show a friend first.</p>'}</section>`
}
function diaryHTML(specials, own, hiddenNote) {
  const specs = allSpecials()
  const rows = Object.entries(specials || {}).map(([id, m]) => ({ s: specs.find((x) => x.id === id), m })).filter((x) => x.s && x.m && (x.m.seen || x.m.stars || x.m.note))
    .sort((x, y) => String(y.m.at || '').localeCompare(String(x.m.at || '')))
  const head = `<div class="up-sh"><h3>Specials diary</h3>${own ? '<a class="up-edit" href="#comics">Log a special</a>' : ''}</div>`
  if (hiddenNote) return `<section class="up-sec">${head}<p class="muted">${hiddenNote}</p></section>`
  if (!rows.length) return own ? `<section class="up-sec">${head}<p class="muted">Mark specials seen, rate them and add a line in Comics. They land here, newest first.</p></section>` : ''
  const date = (t) => { try { const d = new Date(t); return `<b>${d.getDate()}</b>${d.toLocaleDateString(undefined, { month: 'short' })}` } catch { return '' } }
  return `<section class="up-sec">${head}<ol class="up-diary">${rows.slice(0, 30).map(({ s, m }) => `<li><span class="up-dd">${m.at ? date(m.at) : ''}</span>
    <span class="up-dt"><a href="#comic/${esc(slugOf(s.comic))}"><b>${esc(s.title)}</b></a><small>${esc(s.comic)} · ${esc(String(s.year || ''))}</small>${m.note ? `<em>\u201c${esc(String(m.note))}\u201d</em>` : ''}</span>
    <span class="up-st">${m.stars ? '★'.repeat(Math.floor(m.stars)) + (m.stars % 1 ? '½' : '') : m.seen ? '<small>seen</small>' : ''}</span></li>`).join('')}</ol></section>`
}
function setsHTML(sets, own) {
  return `<section class="up-sec"><div class="up-sh"><h3>${own ? 'My sets' : 'Sets'}</h3></div>
    ${arr(sets).length ? `<div class="up-sets">${sets.map((s) => `<div class="up-set"><b>${esc(s.title || 'Untitled set')}</b><span>${s.kind === 'ai' ? 'AI set' : ''}</span></div>`).join('')}</div>`
      : `<div class="up-sets"><div class="up-set soon"><span class="eyebrow">AI sets coming soon</span><b>Write a set with an AI comic, tuned to this chart.</b><span class="muted small">Premieres here first.</span></div></div>`}</section>`
}
function heroHTML(P) {
  const own = P.own, u = P.user || {}, name = u.username || null, c = P.chart
  const av = own ? (signedIn() ? `<button type="button" class="pfav up-avbtn" data-act="avatar" aria-label="Change avatar" title="Change avatar">${meHTML()}<span class="pfavdice">${DICE}</span></button>` : `<span class="up-avbtn">${meHTML()}</span>`) : avatarHTML(u)
  const acts = own
    ? (signedIn() && name ? `<button type="button" class="dhbtn" data-act="share" data-kind="chart">Share my taste ↗</button><button type="button" class="dhghost" data-act="copy">Copy profile link</button><button type="button" class="dhghost" data-act="edit">Edit profile</button>`
      : signedIn() ? `<button type="button" class="dhbtn" data-act="edit">Pick a username</button><button type="button" class="dhghost" data-act="share" data-kind="chart">Share my taste ↗</button>`
        : `<button type="button" class="dhbtn" data-act="share" data-kind="chart">Share my taste ↗</button><button type="button" class="dhghost" data-act="signin">Sign in to publish it</button>`)
    : `<button type="button" class="dhbtn" data-act="compare" data-name="${esc(name || '')}">Compare with me</button><button type="button" class="dhghost" data-act="copy" data-name="${esc(name || '')}">Copy link</button>`
  return `<section class="up-hero"><div class="up-av">${av}</div><div class="up-id">
    <span class="eyebrow">${own ? (signedIn() ? 'Your profile' : 'Your profile · on this device') : 'Sense of humour'}</span>
    <h1>${esc(name || (own ? 'You' : ''))}</h1>${name ? `<p class="up-url">${esc(PROFILE_HOST + name)}</p>` : ''}
    ${c?.line ? `<p class="up-line">${esc(c.line)}</p>` : ''}${c?.mml ? `<p class="up-mml"><span>Make me laugh by\u2026</span> ${esc(c.mml)}</p>` : ''}
    <div class="up-acts">${acts}</div></div></section>`
}
function profileHTML(P) {
  if (P.hidden) return `${heroHTML({ ...P, chart: null })}<p class="muted up-private">${P.vis_profile === 'friends' ? 'This profile is for friends only.' : 'This profile is private.'}</p>`
  return heroHTML(P) + fourHTML(arr(P.favs), P.own) + chartHTML(P.chart, P.own, P.own ? 'Your' : (P.user?.username || 'Their') + '\u2019s') + pinsHTML(arr(P.pins), P.own)
    + diaryHTML(P.specials, P.own, P.diaryNote) + setsHTML(P.sets, P.own)
}
function bindProfile(el, P) {
  el.onclick = (e) => {
    const b = e.target.closest('[data-act]'); if (!b || !el.contains(b)) return
    const k = b.dataset.act
    if (k === 'favs') openFavsSheet()
    else if (k === 'pins') openPinsSheet()
    else if (k === 'share') openShareStudio(b.dataset.kind || 'chart')
    else if (k === 'copy') { const n = b.dataset.name || USER?.username; if (n) copyText(profileURL(n)).then((ok) => toast(ok ? 'Profile link copied.' : 'Copy this link: ' + profileURL(n))) }
    else if (k === 'compare') location.hash = 'vs/' + encodeURIComponent(b.dataset.name)
    else if (k === 'signin') setMenu(true)
    else if (k === 'edit') openOnboarding()
    else if (k === 'avatar') openAvatarSheet()
    else if (k === 'delete') deleteAccount()
  }
}
const profRoute = () => {
  const h = location.hash, m = h.match(/^#u\/([A-Za-z0-9_]{3,20})/), v = h.match(/^#vs\/([A-Za-z0-9_,]+)/)
  if (v) return { kind: 'vs', names: v[1].split(',').filter((x) => /^[A-Za-z0-9_]{3,20}$/.test(x)).slice(0, 3) }
  if (m && m[1].toLowerCase() !== 'me' && !(signedIn() && USER?.username && USER.username.toLowerCase() === m[1].toLowerCase())) return { kind: 'public', name: m[1] }
  return { kind: 'me' }
}
function goProfile(h = 'profile') { if (location.hash === '#' + h) { showTab('profile'); paintProfilePage() } else location.hash = h }
async function paintProfilePage() {
  const el = $('#profileview'); if (!el || $('#v-profile')?.hidden) return
  const r = profRoute()
  if (r.kind === 'vs') return paintVs(el, r.names)
  if (r.kind === 'public') return paintPublic(el, r.name)
  return paintMine(el)
}
async function paintMine(el) {
  const P = { own: true, user: signedIn() ? USER : null, favs: favsLocal(), pins: pinsLocal(), chart: myChart(), specials: spGet(), sets: [] }
  const vis = visLocal(), VIS = [['public', 'Everyone'], ['friends', 'Friends'], ['private', 'Only me']]
  const sel = (id, v) => `<select id="${id}">${VIS.map(([k, l]) => `<option value="${k}"${v === k ? ' selected' : ''}>${l}</option>`).join('')}</select>`
  const extra = signedIn() ? `<section class="up-sec"><div class="up-sh"><h3>Friends</h3></div>
      <div class="kpis pfk"><div class="kpi"><b id="pk-sent">–</b><span>clashes shared</span></div><div class="kpi"><b id="pk-open">–</b><span>opened by friends</span></div><div class="kpi"><b id="pk-voted">–</b><span>friends voted</span></div><div class="kpi"><b id="pk-fr">–</b><span>friends</span></div></div>
      <h3 class="up-h4">Taste match</h3><div id="pftaste" class="pflist"><p class="muted">Loading…</p></div>
      <h3 class="up-h4">Invites you sent</h3><div id="pfinv" class="pflist"><p class="muted">Loading…</p></div></section>
    <section class="up-sec pfpriv"><div class="up-sh"><h3>Privacy</h3></div>
      <div class="up-vis"><label>Profile, Four Favourites, pins and chart ${sel('visprof', vis.profile)}</label><label>Specials diary and notes ${sel('visdiary', vis.diary)}</label></div>
      <p class="muted small">Only you see this: ${[USER.birth_year ? 'born ' + USER.birth_year : null, USER.country ? ccName(USER.country) : null, { male: 'male', female: 'female', skip: 'prefer not to say' }[USER.sex_at_birth] || null].filter(Boolean).map(esc).join(' · ') || 'no stats details yet (Edit profile to add them).'} ${esc(USER.email || '')}</p>
      <p class="hdata"><a class="btn ghost" href="privacy.html" target="_blank" rel="noopener">Privacy</a><button type="button" class="btn danger" data-act="delete">Delete my account</button></p></section>`
    : `<section class="up-sec"><p class="muted">This profile lives on this device. Sign in with Google from the account menu to publish it at ${esc(PROFILE_HOST)}<i>you</i>, add friends and overlay your charts.</p></section>`
  el.innerHTML = `<div class="up">${profileHTML(P)}${extra}</div>`
  bindProfile(el, P)
  if (!signedIn()) return
  const vp = el.querySelector('#visprof'), vd = el.querySelector('#visdiary')
  vp.onchange = () => { LS.set('vis', { ...visLocal(), profile: vp.value }); queueProfilePush({ vis_profile: vp.value }); toast(vp.value === 'public' ? 'Your profile is public.' : vp.value === 'friends' ? 'Only friends see your profile now.' : 'Your profile is private now.') }
  vd.onchange = () => { LS.set('vis', { ...visLocal(), diary: vd.value }); queueProfilePush({ vis_diary: vd.value }); toast('Diary visibility saved.') }
  setTimeout(() => maybeUploadOG(), 1200)
  const [inv, taste] = await Promise.all([api('/me/invites').catch(() => null), api('/me/taste').catch(() => null)])
  if (!document.body.contains(el) || !el.querySelector('#pftaste')) return
  const t = inv?.j?.totals, fr = taste?.j?.friends || []
  if (t) { $('#pk-sent').textContent = t.sent; $('#pk-open').textContent = t.opened; $('#pk-voted').textContent = t.voted }
  $('#pk-fr').textContent = fr.length
  $('#pftaste').innerHTML = fr.length ? fr.map((f) => `<div class="pfrow">${avatarHTML(f)}<b>${f.username ? `<a href="#u/${esc(f.username)}">${esc(f.username)}</a>` : 'Friend'}</b><span class="pfm">${f.match == null ? `<small class="muted">${f.shared}/3 shared picks</small>` : `<i style="--p:${f.match}%"></i>${f.match}% match`}</span>${f.username ? `<a class="dhghost up-cmp" href="#vs/${esc(f.username)}">Overlay charts</a>` : ''}</div>`).join('')
    : '<p class="muted">No friends yet. Share a clash after you vote; when a friend opens it and taps \u201cAdd as a friend\u201d, you\u2019ll see how often you agree.</p>'
  const list = inv?.j?.invites || []
  $('#pfinv').innerHTML = list.length ? list.slice(0, 20).map((x) => `<div class="pfrow"><span class="pfclash">${esc(BYID[x.a]?.comic || 'Retired clip')} <i>vs</i> ${esc(BYID[x.b]?.comic || 'Retired clip')}</span><span class="pfppl">${(x.people || []).slice(0, 6).map((p) => `<span class="fa" title="${esc(p.username || '')}${p.voted ? ' voted' : ' opened'}">${avatarHTML(p)}</span>`).join('')}</span><small class="muted">${x.opens} open${x.opens === 1 ? '' : 's'} · ${x.voted} voted</small></div>`).join('')
    : '<p class="muted">Nothing shared yet.</p>'
}
const PUBCACHE = new Map()
async function fetchPublic(name) {
  const k = name.toLowerCase(), hit = PUBCACHE.get(k)
  if (hit && Date.now() - hit.t < 60e3) return hit.v
  let v = null
  if (CFG.apiBase) { const r = await api('/u/' + encodeURIComponent(name)).catch(() => null); v = r ? { status: r.status, j: r.j } : null }
  if (v && v.status === 200) PUBCACHE.set(k, { t: Date.now(), v })
  return v
}
async function paintPublic(el, name) {
  el.innerHTML = `<div class="up"><p class="muted up-loading">Loading ${esc(name)}\u2026</p></div>`
  const r = await fetchPublic(name)
  if (profRoute().name !== name) return
  if (!r || r.status !== 200 || !r.j?.user) { el.innerHTML = `<div class="up"><section class="up-hero"><div class="up-id"><span class="eyebrow">Profile</span><h1>${esc(name)}</h1><p class="muted">${r?.status === 404 ? 'Nobody goes by that name on Funnier (yet).' : 'Couldn\u2019t load this profile. Check your connection.'}</p><div class="up-acts"><a class="dhbtn" href="#">Watch tonight\u2019s screening</a></div></div></section></div>`; return }
  const j = r.j
  const P = { own: false, user: j.user, favs: j.favs, pins: j.pins, chart: j.chart, specials: j.specials, sets: j.sets, hidden: j.hidden, vis_profile: j.vis_profile,
    diaryNote: j.specials ? null : j.vis_diary === 'friends' ? 'Their diary is for friends only.' : j.vis_diary === 'private' ? 'Their diary is private.' : null }
  el.innerHTML = `<div class="up">${profileHTML(P)}<section class="up-sec up-cta"><p>What\u2019s <i>your</i> sense of humour? Every pick in tonight\u2019s screening draws your own chart.</p><a class="dhbtn" href="#">Start watching</a></section></div>`
  bindProfile(el, P)
}

// ---- friends overlay: your chart over one to three friends' charts ----
const VS_FRIENDS = { t: 0, list: [] }
async function friendList() {
  if (!signedIn()) return []
  if (Date.now() - VS_FRIENDS.t < 60e3) return VS_FRIENDS.list
  const r = await api('/me/taste').catch(() => null)
  VS_FRIENDS.list = (r?.ok && r.j?.friends) || []; VS_FRIENDS.t = Date.now()
  return VS_FRIENDS.list
}
function vsLines(mine, them, name, theirFavs, agree) {
  const tm = tasteMatch(mine, them)
  const pct = tm.pct == null ? agree : agree != null ? Math.round((tm.pct + agree) / 2) : tm.pct
  const both = tm.both.slice(0, 2).map(dimPhrase)
  const sharedFavs = favsLocal().filter((f) => arr(theirFavs).includes(f))
  const bothLine = both.length ? `You both love ${both.join(' and ')}.` : sharedFavs.length ? `You both put ${sharedFavs.slice(0, 2).map((f) => shortName(f, COMICS)).join(' and ')} in your Four.` : 'No shared obsession yet.'
  const dis = tm.disagree.slice(0, 2).map((k) => `${dimShort(k).toLowerCase()} (you ${mine.dims[k]}, ${name} ${them.dims[k]})`)
  const disLine = dis.length ? `You disagree on ${dis.join(' and ')}.` : 'You barely disagree on anything.'
  return { pct, bothLine, disLine, sharedFavs }
}
async function paintVs(el, names) {
  const mine = myChart()
  el.innerHTML = `<div class="up"><p class="muted up-loading">Lining up the charts\u2026</p></div>`
  const [friends, ...pubs] = await Promise.all([friendList(), ...names.map((n) => fetchPublic(n))])
  if (profRoute().kind !== 'vs') return
  const others = names.map((n, i) => ({ name: pubs[i]?.j?.user?.username || n, r: pubs[i] })).filter((o) => o.r?.status === 200 && o.r.j?.chart?.dims)
  const series = [{ dims: mine.dims, color: CHART_COLORS[0] }, ...others.map((o, i) => ({ dims: o.r.j.chart.dims, color: CHART_COLORS[i + 1] }))]
  const fmap = Object.fromEntries(friends.map((f) => [String(f.username || '').toLowerCase(), f]))
  const cards = others.map((o, i) => {
    const f = fmap[o.name.toLowerCase()], L = vsLines(mine, o.r.j.chart, o.name, o.r.j.favs, f?.match ?? null)
    o.L = L
    return `<div class="vs-card" style="--c:${CHART_COLORS[i + 1]}"><div class="vs-who">${avatarHTML(o.r.j.user)}<b><a href="#u/${esc(o.name)}">${esc(o.name)}</a></b><span class="vs-pct">${L.pct ?? '–'}%<small>taste match</small></span></div>
      <p>${esc(L.bothLine)}</p><p class="muted">${esc(L.disLine)}</p>${f?.match != null ? `<p class="muted small">You picked the same clip in ${f.agree} of ${f.shared} shared clashes.</p>` : ''}
      <button type="button" class="dhghost" data-vsshare="${i}">Share me vs ${esc(o.name)} ↗</button></div>`
  }).join('')
  const missing = names.filter((n) => !others.some((o) => o.name.toLowerCase() === n.toLowerCase()))
  const chips = friends.filter((f) => f.username).map((f) => { const on = names.some((n) => n.toLowerCase() === f.username.toLowerCase())
    const next = on ? names.filter((n) => n.toLowerCase() !== f.username.toLowerCase()) : [...names, f.username].slice(-3)
    return `<a class="vs-chip${on ? ' on' : ''}" href="#vs/${esc(next.join(',') || f.username)}">${avatarHTML(f)}${esc(f.username)}</a>` }).join('')
  el.innerHTML = `<div class="up vs"><a class="back" href="#profile">← Your profile</a>
    <section class="up-sec"><span class="eyebrow">Overlay</span><h1 class="vs-h">You${others.map((o, i) => ` <i>vs</i> <span style="color:${CHART_COLORS[i + 1]}">${esc(o.name)}</span>`).join('')}</h1>
      ${chips ? `<div class="vs-chips">${chips}</div>` : signedIn() ? '<p class="muted small">Add friends by sharing a clash after you vote; they show up here.</p>' : '<p class="muted small">Sign in to overlay your friends\u2019 charts.</p>'}
      ${missing.length ? `<p class="muted small">${missing.map(esc).join(', ')}: no public chart to overlay yet.</p>` : ''}</section>
    <div class="up-chart vs-chart"><div class="up-radar">${chartSVG(series, { size: 420, values: others.length === 0, title: 'Humour charts overlaid' })}
      <div class="vs-legend"><span style="--c:${CHART_COLORS[0]}">You</span>${others.map((o, i) => `<span style="--c:${CHART_COLORS[i + 1]}">${esc(o.name)}</span>`).join('')}</div></div>
      <div class="up-legend">${cards || '<p class="muted">Pick a friend above to overlay their chart on yours.</p>'}</div></div></div>`
  el.querySelectorAll('[data-vsshare]').forEach((b) => (b.onclick = () => {
    const o = others[+b.dataset.vsshare]
    openShareStudio('vs', { friend: { username: o.name, avatarSVG: seedSVG(o.r.j.user.avatar_seed) , chart: o.r.j.chart, match: o.L.pct, both: o.L.bothLine, disagree: o.L.disLine } })
  }))
}

// ---- pickers ----
function openFavsSheet(after) {
  const sh = $('#sheet'); if (!sh) return
  let sel = favsLocal().slice()
  const names = comicNames()
  const paint = () => {
    sh.querySelector('.fv-grid').innerHTML = names.map((n) => { const i = sel.indexOf(n), p = comicPic(n), first = CLIPS.find((k) => k.comic === n && k.media === 'youtube'), src = p.photo || (first ? thumb(first.id) : '')
      return `<button type="button" class="fv${i >= 0 ? ' on' : ''}" data-fv="${esc(n)}" aria-pressed="${i >= 0}">${src ? `<img src="${esc(src)}" alt="" loading="lazy">` : ''}${i >= 0 ? `<i>${i + 1}</i>` : ''}<b>${esc(n)}</b></button>` }).join('')
    sh.querySelector('.fv-n').textContent = `${sel.length}/4`
  }
  sh.innerHTML = `<div class="sheetcard fvsheet" role="dialog" aria-modal="true" aria-labelledby="fvh"><button type="button" class="sheetx" data-ob="close" aria-label="Close">×</button>
    <h2 id="fvh">Four favourites</h2><p class="muted">The four comics that say the most about your sense of humour. Tap in order. <span class="fv-n"></span></p>
    <div class="fv-grid"></div><div class="obact"><button type="button" class="dhbtn" data-ob="save">Save</button><button type="button" class="dhghost" data-ob="close">Cancel</button></div></div>`
  sh.hidden = false; paint()
  const close = () => { sh.hidden = true; sh.innerHTML = '' }
  sh.onclick = (e) => {
    if (e.target === sh) return close()
    const b = e.target.closest('[data-fv]'); if (!b) return
    const n = b.dataset.fv, i = sel.indexOf(n)
    if (i >= 0) sel.splice(i, 1); else if (sel.length < 4) sel.push(n); else return toast('Four is the limit. Tap one to take it out first.')
    paint()
  }
  sh.querySelectorAll('[data-ob="close"]').forEach((b) => (b.onclick = close))
  sh.querySelector('[data-ob="save"]').onclick = () => { saveFavs(sel); close(); paintProfilePage(); toast(sel.length ? 'Four Favourites saved.' : 'Favourites cleared.'); after?.() }
}
function openPinsSheet() {
  const sh = $('#sheet'); if (!sh) return
  let sel = pinsLocal().filter((id) => BYID[id])
  const seenSet = new Set([...LS.get('votes', []).flatMap((v) => [v?.a, v?.b]), ...Object.keys(LS.get('seen', {}) || {})].filter((id) => BYID[id]))
  const seen = [...seenSet].map((id) => BYID[id]), rest = CLIPS.filter((c) => !seenSet.has(c.id) && c.media === 'youtube').slice(0, 60)
  const row = (c) => { const i = sel.indexOf(c.id); return `<button type="button" class="pn${i >= 0 ? ' on' : ''}" data-pn="${esc(c.id)}" aria-pressed="${i >= 0}"><img src="${thumb(esc(c.id))}" alt="" loading="lazy"><span><b>${esc(c.title)}</b><small>${esc(c.comic)}</small></span>${i >= 0 ? `<i>${i + 1}</i>` : ''}</button>` }
  const paint = () => {
    sh.querySelector('.pn-list').innerHTML = (seen.length ? `<p class="eyebrow">Clips you\u2019ve seen</p>${seen.map(row).join('')}` : '') + (rest.length ? `<p class="eyebrow">${seen.length ? 'More clips' : 'Clips'}</p>${rest.map(row).join('')}` : '')
    sh.querySelector('.fv-n').textContent = `${sel.length}/6`
  }
  sh.innerHTML = `<div class="sheetcard pnsheet" role="dialog" aria-modal="true" aria-labelledby="pnh"><button type="button" class="sheetx" data-ob="close" aria-label="Close">×</button>
    <h2 id="pnh">Pinned clips</h2><p class="muted">Up to six clips you\u2019d show someone first. <span class="fv-n"></span></p>
    <div class="pn-list"></div><div class="obact"><button type="button" class="dhbtn" data-ob="save">Save</button><button type="button" class="dhghost" data-ob="close">Cancel</button></div></div>`
  sh.hidden = false; paint()
  const close = () => { sh.hidden = true; sh.innerHTML = '' }
  sh.onclick = (e) => {
    if (e.target === sh) return close()
    const b = e.target.closest('[data-pn]'); if (!b) return
    const id = b.dataset.pn, i = sel.indexOf(id)
    if (i >= 0) sel.splice(i, 1); else if (sel.length < 6) sel.push(id); else return toast('Six pins max. Unpin one first.')
    paint()
  }
  sh.querySelectorAll('[data-ob="close"]').forEach((b) => (b.onclick = close))
  sh.querySelector('[data-ob="save"]').onclick = () => { savePins(sel); close(); paintProfilePage(); toast(sel.length ? 'Pins saved.' : 'Pins cleared.') }
}

// ---- share studio: PNG cards (Web Share on phones, download on desktop) ----
function memeOptions() {
  MODEL = MODEL || fitLocal()
  const c = myChart(), n = MODEL.n
  const comics = comicNames(), favs = favsLocal()
  const rank = n ? [...comics].sort((a, b) => (MODEL.r[b] || 0) - (MODEL.r[a] || 0)) : [...favs, ...comics.filter((x) => !favs.includes(x))]
  const asComic = (name) => ({ ...comicPic(name), sub: COMICS[name]?.tagline || '' })
  const funny = [], notFunny = []
  if (c.funniest) funny.push({ ...comicPic(c.funniest.comic), name: `\u201c${c.funniest.title}\u201d`, sub: c.funniest.comic, comic: c.funniest.comic })
  for (const x of rank) funny.push({ ...asComic(x), comic: x })
  for (const x of [...rank].reverse()) if (!favs.includes(x) || !n) notFunny.push({ ...asComic(x), comic: x })
  return { funny, notFunny }
}
function cardData(extra = {}) {
  const c = myChart(), name = signedIn() ? USER?.username : null
  return { username: name || 'me', avatarSVG: seedSVG(mySeed()), chart: c, mml: c.mml, url: name ? PROFILE_HOST + name : 'funnier.si', favs: favsLocal().map(comicPic), ...extra }
}
function openShareStudio(kind = 'chart', opts = {}) {
  const sh = $('#sheet'); if (!sh) return Promise.resolve()
  return new Promise((done) => {
    let size = 'feed', mi = 0
    const M = memeOptions()
    const tpls = TEMPLATES.filter((t) => t.needs !== 'friend' || opts.friend)
    if (!tpls.some((t) => t.k === kind)) kind = 'chart'
    sh.innerHTML = `<div class="sheetcard ss" role="dialog" aria-modal="true" aria-labelledby="ssh"><button type="button" class="sheetx" data-ob="close" aria-label="Close">×</button>
      <h2 id="ssh">Share your taste</h2>
      <div class="ss-tabs" role="tablist">${tpls.map((t) => `<button type="button" role="tab" data-tpl="${t.k}">${esc(t.label)}</button>`).join('')}</div>
      <div class="ss-stage"><canvas class="ss-cv" aria-label="Card preview"></canvas><p class="muted ss-none" hidden>This browser can\u2019t draw the card. Try a recent Chrome, Safari or Firefox.</p></div>
      <div class="ss-row"><div class="ss-size"><button type="button" data-size="feed">Feed 4:5</button><button type="button" data-size="story">Story 9:16</button></div><button type="button" class="dhghost ss-shuffle" data-ob="shuffle" hidden>Shuffle</button></div>
      <div class="obact"><button type="button" class="dhbtn" data-ob="share">${isMobile() ? 'Share ↗' : 'Download PNG'}</button>${isMobile() ? '<button type="button" class="dhghost" data-ob="dl">Save image</button>' : ''}<button type="button" class="dhghost" data-ob="link">Copy profile link</button></div>
      <p class="muted small">Cards use our mascots, type and Commons photos (credited on the card), never clips or meme images.</p></div>`
    sh.hidden = false
    const cv = sh.querySelector('.ss-cv')
    const close = () => { sh.hidden = true; sh.innerHTML = ''; done() }
    const data = () => {
      const f = M.funny[mi % Math.max(1, M.funny.length)] || null
      const nf = M.notFunny.filter((x) => x.comic !== f?.comic)[mi % Math.max(1, M.notFunny.length - 1)] || null
      return cardData({ funny: f, notFunny: nf, friend: opts.friend || null })
    }
    let seq = 0
    const render = async () => {
      sh.querySelectorAll('[data-tpl]').forEach((b) => b.classList.toggle('on', b.dataset.tpl === kind))
      sh.querySelectorAll('[data-size]').forEach((b) => b.classList.toggle('on', b.dataset.size === size))
      sh.querySelector('.ss-shuffle').hidden = kind !== 'funny'
      cv.classList.toggle('story', size === 'story')
      const my = ++seq
      let okc = null
      try { okc = await drawCard(cv, kind, data(), size, () => my === seq) } catch (err) { console.warn('card', err) }
      if (my !== seq) return
      sh.querySelector('.ss-none').hidden = !!okc; cv.hidden = !okc
    }
    const file = async () => { const b = await toBlob(cv); return b ? new File([b], `funnier-${kind}-${size}${USER?.username ? '-' + USER.username : ''}.png`, { type: 'image/png' }) : null }
    const download = (f) => { const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove() }, 1500) }
    sh.onclick = async (e) => {
      if (e.target === sh) return close()
      const t = e.target.closest('[data-tpl]'), s = e.target.closest('[data-size]'), ob = e.target.closest('[data-ob]')?.dataset.ob
      if (t) { kind = t.dataset.tpl; return render() }
      if (s) { size = s.dataset.size; return render() }
      if (ob === 'close') return close()
      if (ob === 'shuffle') { mi++; return render() }
      if (ob === 'link') { const n = signedIn() && USER?.username; if (!n) return toast('Sign in and pick a username to get your own profile link.'); return toast((await copyText(profileURL(n))) ? 'Profile link copied.' : 'Copy this link: ' + profileURL(n)) }
      if (ob === 'share' || ob === 'dl') {
        const f = await file(); if (!f) return toast('Couldn\u2019t make the image on this browser.')
        const n = signedIn() && USER?.username, url = n ? profileURL(n) : CFG.shareBase || SHARE_BASE
        if (ob === 'share' && isMobile() && navigator.canShare?.({ files: [f] })) {
          try { await navigator.share({ files: [f], text: `${myChart().line} ${url}` }) } catch (err) { if (err?.name !== 'AbortError') download(f) }
        } else { download(f); toast('Saved. Post it anywhere.') }
      }
    }
    render()
  })
}

// ---------- account menu: one round icon top-right ----------
const SILHOUETTE = '<svg viewBox="0 0 24 24" aria-hidden="true" class="silsvg"><circle cx="12" cy="9" r="4.2" fill="currentColor"/><path d="M3.8 21c.9-4.4 4.2-6.6 8.2-6.6s7.3 2.2 8.2 6.6" fill="currentColor"/></svg>'
const menuOpen = () => !!$('#usermenu') && !$('#usermenu').hidden
function setMenu(open) {
  const m = $('#usermenu'), b = $('#userbtn'); if (!m || !b) return
  m.hidden = !open; b.setAttribute('aria-expanded', String(open))
  if (open) { paintMenu(); showChrome() }
}
function paintUser() {
  const b = $('#userbtn'); if (!b) return
  b.innerHTML = signedIn() ? meHTML() : `<span class="av">${seedSVG(deviceSeed())}</span>`
  b.classList.add('in')
  b.setAttribute('aria-label', signedIn() ? `Account: ${USER.username || USER.name || 'you'}` : 'Sign in')
  if (menuOpen()) paintMenu()
}
function paintMenu() {
  const m = $('#usermenu'); if (!m) return
  const lane = `<div class="um-sec um-row"><span>Lineup</span><span id="lanebox"></span></div>`
  const adv = `<details class="um-adv"><summary>Advanced</summary><div class="um-sec">${bskyHTML()}</div></details>`
  const legal = `<p class="um-legal"><a href="privacy.html" target="_blank" rel="noopener">Privacy</a> · <a href="terms.html" target="_blank" rel="noopener">Terms</a> · <a href="credits.html" target="_blank" rel="noopener">Credits</a></p>`
  if (signedIn()) {
    m.innerHTML = `<div class="um-sec um-me">${meHTML()}<div><b>${esc(USER.username || USER.name || 'You')}</b><small>${esc(USER.email || '')}</small></div></div>
      <div class="um-sec"><button type="button" class="um-item" data-um="profile">My profile</button><button type="button" class="um-item" data-um="history">History</button><button type="button" class="um-item" data-um="avatar">Change avatar</button>${USER.username ? '' : '<button type="button" class="um-item gold" data-um="edit">Finish your profile</button>'}</div>
      ${lane}<div class="um-sec"><button type="button" class="um-item" data-um="signout">Sign out</button></div>${adv}
      <div class="um-sec"><button type="button" class="um-del" data-um="delete">Delete my account</button>${legal}</div>`
  } else {
    const can = CFG.googleClientId && CFG.apiBase
    m.innerHTML = `<div class="um-sec">${can ? '<div id="gsibtn" class="gsibtn"><button type="button" class="um-google" disabled>Sign in with Google</button></div>' : '<button type="button" class="um-google" disabled>Sign in with Google <small>coming soon</small></button>'}
      <p class="um-note">Sync your picks, add friends and see how your taste matches theirs.</p></div>
      ${lane}<div class="um-sec"><button type="button" class="um-item" data-um="profile">My profile</button><button type="button" class="um-item" data-um="history">History</button></div>${adv}<div class="um-sec">${legal}</div>`
    if (can) renderGoogleButton(m.querySelector('#gsibtn'))
  }
  laneSelect(); bindBsky(m)
  m.querySelectorAll('[data-um]').forEach((x) => (x.onclick = () => {
    const k = x.dataset.um; setMenu(false)
    if (k === 'history') { showTab('you'); youSub('history') }
    else if (k === 'profile') goProfile('profile')
    else if (k === 'edit') openOnboarding()
    else if (k === 'avatar') openAvatarSheet()
    else if (k === 'signout') signOut()
    else if (k === 'delete') deleteAccount()
  }))
}
function bindUser() {
  const b = $('#userbtn'); if (!b) return
  b.onclick = (e) => { e.stopPropagation(); setMenu(!menuOpen()) }
  document.addEventListener('click', (e) => { if (menuOpen() && !e.target.closest?.('.usr')) setMenu(false) })
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (menuOpen()) { setMenu(false); b.focus() } const sh = $('#sheet'); if (sh && !sh.hidden) { sh.hidden = true; sh.innerHTML = '' } } })
  paintUser()
}

// ---------- utils ----------
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) }
let tt
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('on'); clearTimeout(tt); tt = setTimeout(() => t.classList.remove('on'), 3200) }
function tabs() {
  const show = (id) => {
    document.querySelectorAll('nav [data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === id))
    document.querySelectorAll('section.view').forEach((s) => (s.hidden = s.id !== 'v-' + id))
    if (id !== 'arena') Object.values(screens).forEach((s) => s.pause())
    document.body.classList.toggle('in-theatre', id === 'arena' && (stage === 'left' || stage === 'right'))
    scrollTo({ top: 0 })
    updateChrome()
  }
  showTab = show
  const brand = $('#brand')
  if (brand) brand.onclick = (e) => { // the logo always brings you back to the screening
    e.preventDefault()
    const wasAway = !arenaOn()
    if (location.hash) history.replaceState(null, '', location.pathname + location.search)
    show('arena'); showChrome(2500)
    if (wasAway && (stage === 'left' || stage === 'right')) screens[stage === 'left' ? 'L' : 'R']?.play()
  }
  document.querySelectorAll('[data-sub]').forEach((b) => (b.onclick = () => youSub(b.dataset.sub)))
  document.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = (e) => { e.preventDefault(); if (b.dataset.tab === 'comics') location.hash = 'comics'; show(b.dataset.tab) }))
  const route = () => {
    const ic = parseInvite(location.hash)
    if (ic) { history.replaceState(null, '', location.pathname + location.search); show('arena'); openInvite(ic).then((ok) => { if (ok && CLIPS.length) { moving = false; goNext(null) } }); return }
    if (/^#(profile|u\/|vs\/)/.test(location.hash)) { show('profile'); paintProfilePage(); return }
    const sh = parseClash(location.hash)
    if (sh) { pendingClash = sh; if (sh.rewatch) userStarted = true; history.replaceState(null, '', location.pathname + location.search); show('arena'); if (CLIPS.length) { moving = false; goNext(null) } return }
    if (/^#comic/.test(location.hash)) { show('comics'); paintComics() }
    if (/^#history/.test(location.hash)) { show('you'); youSub('history') }
  }
  addEventListener('hashchange', route)
  show('arena'); window._route = route
}

;(async () => {
  tabs()
  SHORT_MAX = devPrefs().maxSec
  await Promise.all([loadData(), loadConfig()])
  await Promise.race([loadClipMeta(), new Promise((r) => setTimeout(r, 1500))]) // durations + crowd loudness; never block the show for long
  MODEL = fitLocal(); TRAITS = fitTraits()
  try { engineReadout() } catch (e) { console.warn('engine', e) } // the state before the next vote (its delta is measured from here)
  const sh = parseClash(location.hash), ic = parseInvite(location.hash)
  if (ic) { history.replaceState(null, '', location.pathname + location.search); await Promise.race([openInvite(ic), new Promise((r) => setTimeout(r, 4000))]) }
  else if (sh) { pendingClash = sh; history.replaceState(null, '', location.pathname + location.search) }
  // (no auto-inserted daily round: the daily clash is only ever the banner at the top; tapping it plays it)
  bindGestures(); bindChrome(); bindFullscreen(); newRound(true); paintBoards(); paintYou(); paintComics(); paintBanner(); paintDaily(); window._route()
  initAuth(); initAccount()
})()
