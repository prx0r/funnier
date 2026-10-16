// Humour Passport: "port your sense of humour". A versioned, open schema (funnier.humour/v1) for one person's humour
// model: interpretable weights per named feature (with their uncertainty), the chart axes with confidence, the humour
// type, favourite comics and clips, how many votes it rests on, and the model version. No raw vote history unless the
// owner opts in. Pure (no DOM, no storage, no engine import): bundled into site/app.js, imported by the Worker
// (api/src/index.js, cleanPassport) and the tests. Schema: lexicons/funnier.humour.v1.schema.json (JSON) and
// lexicons/io.github.prx0r.funnier.humour.json (the AT Protocol record, integers only).
export const SCHEMA = 'funnier.humour/v1'
export const PASSPORT_SCHEMA_URL = 'https://www.funnier.si/schema/funnier.humour.v1.json'
// the nine humour types, one per chart axis, in their order around the circle (the enneagram-style figure)
export const TYPES = [
  { k: 'absurd', name: 'The Surrealist', short: 'Surrealist', line: 'Logic is optional. The weirder the turn, the bigger your laugh.', hue: 268 },
  { k: 'deadpan', name: 'The Straight Face', short: 'Straight Face', line: 'You laugh hardest when nobody on stage does.', hue: 205 },
  { k: 'observational', name: 'The Noticer', short: 'Noticer', line: 'The thing everyone saw and nobody said.', hue: 168 },
  { k: 'dark', name: 'The Gallows Crowd', short: 'Gallows', line: 'Nothing is off-limits if the joke earns it.', hue: 345 },
  { k: 'story', name: 'The Long-Game Listener', short: 'Long Game', line: 'Five minutes for one perfect payoff? Gladly.', hue: 32 },
  { k: 'wordplay', name: 'The Punchline Purist', short: 'Purist', line: 'Setup, punch, next. No wasted words.', hue: 52 },
  { k: 'rant', name: 'The Choir', short: 'Choir', line: 'A comic with a righteous head of steam and you are in.', hue: 12 },
  { k: 'selfdep', name: 'The Confessor', short: 'Confessor', line: 'You trust a comic who makes themselves the target.', hue: 300 },
  { k: 'crowd', name: 'The Front Row', short: 'Front Row', line: 'You live for the moment the comic turns to the room.', hue: 135 },
]
const TK = TYPES.map((t) => t.k)
const clamp = (x, a, b) => Math.max(a, Math.min(b, x))
const r3 = (x) => Math.round(x * 1000) / 1000
const arr = (x) => (Array.isArray(x) ? x : [])
const str = (x, n) => (typeof x === 'string' ? x.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n) : '')
export function fnv(s) { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0 } return h >>> 0 }
export const hex8 = (n) => (n >>> 0).toString(16).padStart(8, '0')

// dominant type + wing (the stronger neighbour on the circle), from axis values 0..100
export function humourType(axes, n = 0) {
  const v = (k) => (Number.isFinite(axes?.[k]?.v) ? axes[k].v : Number.isFinite(axes?.[k]) ? axes[k] : 50)
  const i = TK.map((k, j) => [v(k), j]).sort((a, b) => b[0] - a[0] || a[1] - b[1])[0][1]
  const L = (i + TK.length - 1) % TK.length, Rr = (i + 1) % TK.length, w = v(TK[L]) >= v(TK[Rr]) ? L : Rr
  const t = TYPES[i], wing = TYPES[w], settled = v(t.k) >= 55 && n > 0
  return { k: t.k, index: i + 1, name: settled ? t.name : 'The Open Book', wing: wing.k, wingIndex: w + 1, wingName: wing.short,
    full: settled ? `${t.name}, ${wing.short} wing` : 'The Open Book (still reading you)', line: settled ? t.line : 'Nothing has won you over yet. A few more votes and your type appears.', code: settled ? `${i + 1}w${w + 1}` : '0' }
}

// readout (src/engine.js) + context -> passport. features: [{k, label, group}] (engine FEATURES)
export function makePassport({ readout, features, model, n = 0, skips = 0, favs = [], topComics = [], topClips = [], user = null, line = null, votes = null, created = null }) {
  const F = {}
  for (const f of features) { const e = readout?.f?.[f.k]; if (e) F[f.k] = { w: r3(e.w), sd: r3(e.sd), n: Math.round(e.n * 10) / 10, label: f.label, group: f.group } }
  const axes = {}
  for (const t of TYPES) { const e = readout?.f?.['ax_' + t.k]; if (e) axes[t.k] = { v: e.v, lo: e.lo, hi: e.hi, conf: e.conf, n: Math.round(e.n * 10) / 10 } }
  const type = humourType(axes, n + arr(favs).length)
  const p = {
    $schema: PASSPORT_SCHEMA_URL, schema: SCHEMA, model: String(model || ''), created: created || new Date().toISOString(),
    source: 'https://www.funnier.si', ...(user ? { user: String(user) } : {}),
    n: { votes: n, skips, favs: arr(favs).length },
    type: { k: type.k, code: type.code, name: type.name, wing: type.wing, full: type.full },
    axes, features: F, heads: readout?.heads || {},
    favs: arr(favs).slice(0, 4), topComics: arr(topComics).slice(0, 5), topClips: arr(topClips).slice(0, 6).map((c) => ({ id: c.id, title: str(c.title, 120), comic: c.comic })),
    ...(line ? { line: str(line, 200) } : {}),
  }
  if (Array.isArray(votes) && votes.length) p.votes = votes.slice(-500).map((v) => ({ a: v.a, b: v.b, winner: v.winner, ...(v.createdAt ? { at: v.createdAt } : {}) }))
  p.hash = passportHash(p)
  return p
}
// version hash: the model id + the weights (what the passport says about you), so a snapshot can be cited
export function passportHash(p) {
  const ks = Object.keys(p?.features || {}).sort()
  return hex8(fnv(String(p?.model || '') + '|' + ks.map((k) => k + ':' + r3(+p.features[k].w || 0)).join(',')))
}

// plain language for an assistant ("Copy for ChatGPT / Claude")
const strength = (v) => (v >= 75 ? 'strongly' : v >= 62 ? 'clearly' : 'a little')
export function passportPrompt(p) {
  const axes = Object.entries(p?.axes || {}).map(([k, a]) => ({ k, ...a, label: p.features?.['ax_' + k]?.label || k }))
  const love = axes.filter((a) => a.v >= 57).sort((x, y) => y.v - x.v), cold = axes.filter((a) => a.v <= 43).sort((x, y) => x.v - y.v)
  const F = p?.features || {}, sty = (k, hi, lo) => { const f = F[k]; if (!f || f.n < 1.5) return null; const v = 50 + 50 * Math.tanh(f.w); return v >= 58 ? hi : v <= 42 ? lo : null }
  const delivery = [sty('energy', 'high-energy delivery', 'low-key delivery'), sty('hold', 'long pauses before the punchline', 'quick-fire pacing'), sty('pace', 'short, punchy sentences', 'wordier build-ups')].filter(Boolean)
  const ops = Object.entries(F).filter(([k, f]) => k.startsWith('op_') && f.n >= 0.6 && f.w > 0.15).sort((x, y) => y[1].w - x[1].w).slice(0, 3).map(([, f]) => f.label)
  const unsure = axes.filter((a) => a.conf === 'low').map((a) => a.label)
  const L = []
  L.push(`My sense of humour (a Funnier Humour Passport, ${SCHEMA}, model ${p?.model || '?'}, built from ${p?.n?.votes ?? 0} of my head-to-head votes between stand-up clips${p?.n?.skips ? ` and ${p.n.skips} skips` : ''}):`)
  if (p?.type?.full) L.push(`- My humour type: ${p.type.full}.`)
  L.push(love.length ? `- I love: ${love.map((a) => `${a.label} (${strength(a.v)})`).join(', ')}.` : '- No strong loves yet: I am open to most styles.')
  if (cold.length) L.push(`- I am cold on: ${cold.map((a) => a.label).join(', ')}.`)
  if (ops.length) L.push(`- Comic moves that work on me: ${ops.join(', ')}.`)
  if (delivery.length) L.push(`- Delivery I prefer: ${delivery.join(', ')}.`)
  if (arr(p?.favs).length) L.push(`- Favourite comedians: ${p.favs.join(', ')}.`)
  if (arr(p?.topClips).length) L.push(`- Clips that got me: ${p.topClips.slice(0, 3).map((c) => `"${c.title}" (${c.comic})`).join('; ')}.`)
  if (unsure.length) L.push(`- Still uncertain about: ${unsure.join(', ')} (few votes), so treat those as open.`)
  L.push('Tell me jokes and recommend comedy (comedians, specials, clips) accordingly: lean into what I love, avoid what I am cold on, and say in a few words which of my traits each pick matches.')
  return L.join('\n')
}

// ---------- validation (client import, Worker storage) ----------
const KEY = /^[a-z][a-z0-9_]{1,39}$/, CLIPID = /^[A-Za-z0-9_:-]{3,64}$/, COMICN = /^[\p{L}\p{N} .'&-]{2,60}$/u
const num = (x, a, b) => (Number.isFinite(Number(x)) ? clamp(Number(x), a, b) : null)
export function cleanPassport(x, { allowVotes = true } = {}) {
  if (!x || typeof x !== 'object' || Array.isArray(x) || x.schema !== SCHEMA) return null
  const o = { $schema: PASSPORT_SCHEMA_URL, schema: SCHEMA, model: str(x.model, 40) || 'unknown', created: !isNaN(Date.parse(x.created)) ? new Date(Date.parse(x.created)).toISOString() : new Date().toISOString(), source: 'https://www.funnier.si' }
  if (typeof x.user === 'string' && /^[A-Za-z0-9_]{3,20}$/.test(x.user)) o.user = x.user
  o.n = { votes: Math.round(num(x.n?.votes, 0, 1e6) ?? 0), skips: Math.round(num(x.n?.skips, 0, 1e6) ?? 0), favs: Math.round(num(x.n?.favs, 0, 4) ?? 0) }
  o.features = {}
  for (const [k, f] of Object.entries(x.features || {}).slice(0, 64)) {
    if (!KEY.test(k) || !f || typeof f !== 'object') continue
    const w = num(f.w, -4, 4); if (w == null) continue
    o.features[k] = { w: r3(w), sd: r3(num(f.sd, 0, 10) ?? 1), n: Math.round(10 * (num(f.n, 0, 1e6) ?? 0)) / 10, label: str(f.label, 40) || k, group: ['axis', 'op', 'sty', 'meta'].includes(f.group) ? f.group : 'meta' }
  }
  if (Object.keys(o.features).length < 3) return null
  o.axes = {}
  for (const k of TK) { const a = x.axes?.[k]; if (!a) continue; const v = num(a.v, 0, 100); if (v == null) continue
    o.axes[k] = { v: Math.round(v), lo: Math.round(num(a.lo, 0, 100) ?? v), hi: Math.round(num(a.hi, 0, 100) ?? v), conf: ['low', 'medium', 'high'].includes(a.conf) ? a.conf : 'low', n: Math.round(10 * (num(a.n, 0, 1e6) ?? 0)) / 10 } }
  const t = humourType(o.axes, o.n.votes + o.n.favs)
  o.type = { k: t.k, code: t.code, name: t.name, wing: t.wing, full: t.full }
  o.heads = {}
  for (const [k, v] of Object.entries(x.heads || {}).slice(0, 12)) if (KEY.test(k) || /^[a-zA-Z]{1,8}$/.test(k)) { const n = num(v, -10, 10); if (n != null) o.heads[k] = r3(n) }
  o.favs = arr(x.favs).filter((s) => typeof s === 'string' && COMICN.test(s)).slice(0, 4)
  o.topComics = arr(x.topComics).filter((c) => c && COMICN.test(String(c.comic || ''))).slice(0, 5).map((c) => ({ comic: c.comic, ...(Number.isFinite(+c.score) ? { score: Math.round(clamp(+c.score, -5000, 5000)) } : {}) }))
  o.topClips = arr(x.topClips).filter((c) => c && CLIPID.test(String(c.id || ''))).slice(0, 6).map((c) => ({ id: c.id, title: str(c.title, 120), comic: str(c.comic, 60) }))
  const line = str(x.line, 200); if (line) o.line = line
  if (allowVotes && Array.isArray(x.votes)) { const vs = x.votes.slice(-500).filter((v) => v && CLIPID.test(String(v.a)) && CLIPID.test(String(v.b)) && (v.winner === v.a || v.winner === v.b)).map((v) => ({ a: v.a, b: v.b, winner: v.winner, ...(typeof v.at === 'string' && !isNaN(Date.parse(v.at)) ? { at: v.at } : {}) })); if (vs.length) o.votes = vs }
  o.hash = passportHash(o)
  return o
}
// passport -> what an import merges into the prior: weights + their sd
export function passportPrior(p) {
  const weights = {}, sd = {}
  for (const [k, f] of Object.entries(p?.features || {})) { weights[k] = f.w; sd[k] = f.sd }
  return { weights, sd, from: { hash: p.hash, created: p.created, votes: p.n?.votes || 0, model: p.model } }
}
// the AT Protocol record (io.github.prx0r.funnier.humour, rkey "self"): integers only (weights x1000, evidence x10)
export function passportRecord(p) {
  return {
    $type: 'io.github.prx0r.funnier.humour', schema: SCHEMA, model: p.model, hash: p.hash, createdAt: p.created,
    votes: p.n?.votes || 0, typeCode: p.type?.code || '0', typeName: str(p.type?.full, 80),
    features: Object.entries(p.features || {}).map(([k, f]) => ({ k, w1000: Math.round(f.w * 1000), sd1000: Math.round(f.sd * 1000), n10: Math.round(f.n * 10) })),
    axes: Object.entries(p.axes || {}).map(([k, a]) => ({ k, v: a.v, lo: a.lo, hi: a.hi, conf: a.conf })),
    favs: p.favs || [], topClips: (p.topClips || []).map((c) => c.id),
    ...(Array.isArray(p.votes) ? { history: p.votes.map((v) => ({ a: v.a, b: v.b, winner: v.winner })) } : {}),
  }
}
