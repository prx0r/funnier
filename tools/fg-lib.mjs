// Shared funnygraph helpers (live data contract). funnygraph (github.com/prx0r/funnygraph) owns comic identity,
// region, tier, persona style and every ranking board; Funnier owns photos, verified specials links and clips.
// Nothing here is committed to master: tools/sync-funnygraph.mjs writes the latest boards into the published site
// (gh-pages data/funnygraph/) on every deploy, keeping the last good copy when funnygraph is unreachable or invalid.
export const FG_REPO = 'prx0r/funnygraph'
export const FG_BRANCH = 'main'
export const rawUrl = (ref, path) => `https://raw.githubusercontent.com/${FG_REPO}/${ref}/${path}`

// funnygraph humour types / modes -> Funnier's style vocabulary (src/engine.js AXES tags). Types with no honest
// Funnier equivalent (meta, character, roast, provocateur, unclassified) map to nothing rather than to a guess.
export const TYPE_TAGS = {
  'dark-confessional': ['dark', 'self-deprecating'],
  observational: ['observational'],
  'crowd-improv': ['crowd-work'],
  'clean-everyman': ['clean', 'observational'],
  storytelling: ['storytelling'],
  rant: ['rant'],
  absurdist: ['absurd'],
  surreal: ['absurd'],
  'one-liner': ['one-liners'],
}
export const ARCH_TAGS = { suspension_deadpan: ['deadpan'], sincere_storyteller: ['storytelling'], prophet_curmudgeon: ['rant'], rage_apologist: ['rant'], controlled_confessor: ['self-deprecating'], confessional_assassin: ['dark'] }

export const REGION_LABEL = {
  us: 'United States', uk: 'UK', ireland: 'Ireland', canada: 'Canada', australia: 'Australia', 'new-zealand': 'New Zealand',
  nigeria: 'Nigeria', 'south-africa': 'South Africa', india: 'India', china: 'China', japan: 'Japan', malaysia: 'Malaysia',
  lebanon: 'Lebanon', spain: 'Spain', germany: 'Germany', france: 'France', netherlands: 'Netherlands', mexico: 'Mexico',
  brazil: 'Brazil', argentina: 'Argentina', colombia: 'Colombia',
}
export const CONTINENT_LABEL = { 'north-america': 'North America', europe: 'Europe', asia: 'Asia', africa: 'Africa', oceania: 'Oceania', 'south-america': 'Latin America' }
const REGION_CONTINENT = { us: 'north-america', canada: 'north-america', mexico: 'north-america', uk: 'europe', ireland: 'europe', spain: 'europe', germany: 'europe', france: 'europe', netherlands: 'europe', china: 'asia', india: 'asia', japan: 'asia', malaysia: 'asia', lebanon: 'asia', nigeria: 'africa', 'south-africa': 'africa', australia: 'oceania', 'new-zealand': 'oceania', brazil: 'south-america', argentina: 'south-america', colombia: 'south-america' }

const str = (x, n = 400) => (typeof x === 'string' && x.trim() ? x.trim().slice(0, n) : null)
const num = (x) => (typeof x === 'number' && isFinite(x) ? x : null)

// persona style tags for a comic, from its graph (modes repertoire > humor_type > style_tags.humor_type) + engine archetype
export function personaTags(g) {
  const out = []
  const rep = g?.modes?.repertoire && typeof g.modes.repertoire === 'object' ? Object.entries(g.modes.repertoire).filter(([, v]) => typeof v === 'number').sort((a, b) => b[1] - a[1]) : []
  const types = rep.length ? rep.filter(([, v], i) => i === 0 || v >= 0.25).map(([k]) => k) : [g?.humor_type?.primary || g?.style_tags?.humor_type].filter(Boolean)
  for (const t of types) for (const tag of TYPE_TAGS[t] || []) if (!out.includes(tag)) out.push(tag)
  for (const tag of ARCH_TAGS[g?.engine?.delivery_archetype] || []) if (!out.includes(tag)) out.push(tag)
  return out.slice(0, 3)
}

// one comedian-graph.json -> the slim, public roster record Funnier uses (identity, region, tier, persona, channels).
// No transcripts, sets, bit text or essays are carried.
export function slimGraph(g) {
  if (!g || typeof g !== 'object' || typeof g.comedian_id !== 'string' || typeof g.name !== 'string') return null
  const region = str(g.region, 40), continent = str(g.continent, 40) || (region && REGION_CONTINENT[region]) || null
  const bio = g.bio && typeof g.bio === 'object' ? g.bio : {}
  const chans = (Array.isArray(g.youtube_channel) ? g.youtube_channel : g.youtube_channel ? [g.youtube_channel] : []).filter((c) => c && typeof c.id === 'string' && /^UC[\w-]{22}$/.test(c.id))
    .map((c) => ({ id: c.id, handle: str(c.handle, 80), title: str(c.title, 120), status: str(c.status, 20), subs: num(c.subs), clips: num(c.clips), confidence: str(c.confidence, 120) }))
  return {
    id: g.comedian_id, name: g.name.trim(), tier: g.tier === 'king' || g.tier === 'indie' ? g.tier : null,
    synthetic: !!g.synthetic || region === 'synthetic',
    region: region === 'synthetic' ? null : region, continent: continent === 'synthetic' ? null : continent,
    generation: g.generation && typeof g.generation === 'object' ? { id: str(g.generation.id, 40), label: str(g.generation.label, 80) } : null,
    humor: str(g.humor_type?.primary, 40), signature: str(g.modes?.signature_title, 60),
    tags: personaTags(g),
    // auto/indie drafts carry machine placeholders ('Stand-up voice with N words...'), never shown as a card line
    deal: /draft/.test(String(g.identity?.archetype || '')) ? null : str(g.identity?.deal, 300), premise: /draft/.test(String(g.identity?.archetype || '')) ? null : str(g.identity?.premise, 300),
    bio: { dob: str(bio.dob, 10), dod: str(bio.dod, 10), birthplace: str(bio.birthplace, 80), citizenship: str(bio.citizenship, 80),
      occupations: (Array.isArray(bio.occupations) ? bio.occupations : []).map((o) => str(o, 40)).filter(Boolean).slice(0, 6), source: /wikidata/i.test(String(bio.source || '')) ? 'wikidata' : null },
    specials: ratedSpecials(g),
    website: str(g.website?.url, 200),
    channels: chans,
  }
}

// IMDb-rated specials from the graph (specials_rated), metadata only: title, year, rating, votes, standout. No transcript
// paths. funnygraph's IMDb matcher also attached unrelated titles ('RED', '$', 'Nö'), so a row is kept only when its
// title names the comic (surname, or the whole name for one-word names).
export function namesComic(title, name) {
  const parts = String(name || '').trim().toLowerCase().split(/\s+/).filter(Boolean)
  const sur = parts.length > 1 ? parts[parts.length - 1].replace(/[^a-z0-9]/g, '') : String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  if (!sur || sur.length < 2) return false
  const t = String(title || '').toLowerCase()
  return t.replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).includes(sur) || t.replace(/[^a-z0-9]/g, '').includes(String(name).toLowerCase().replace(/[^a-z0-9]/g, ''))
}
export function ratedSpecials(g) {
  const name = String(g?.name || '').trim()
  const seen = new Set()
  return (Array.isArray(g?.specials_rated) ? g.specials_rated : []).map((r) => {
    const raw = str(r?.title || r?.special, 160); if (!raw || num(r.imdb_rating ?? r.rating) == null) return null // IMDb-matched rows only
    if (!namesComic(raw, name)) return null
    const t = specialTitle(raw, name); if (!t || !/[a-z]/i.test(t.title)) return null
    const year = Number.isInteger(r.year) && r.year > 1940 && r.year < 2100 ? r.year : t.year
    const k = normTitle(t.title); if (seen.has(k)) return null; seen.add(k)
    return { t: t.title, y: year || null, r: num(r.imdb_rating ?? r.rating), v: num(r.imdb_votes ?? r.votes), st: r.standout ? 1 : 0 }
  }).filter(Boolean).slice(0, 20)
}
export const normTitle = (t) => String(t).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '')
const smartCase = (t) => (/[a-z]/.test(t) ? t : t.toLowerCase().replace(/(^|[\s(\-\u2013:/"\u201c])([a-z])/g, (m, a, b) => a + b.toUpperCase()))
// 'JIM JEFFERIES: INTOLERANT (2020) \u2013 FULL TRANSCRIPT' -> { title: 'Intolerant', year: 2020 }. Null for anything that
// is not '<Name>: <Title> (<year>)' shaped (scenes, monologues, episodes, translations): those are not specials.
export function specialTitle(raw, name, needPrefix = false) {
  let s = String(raw || '').replace(/\s+/g, ' ').trim()
  if (!s || /testo|traduc|transcri[cç][aã]o|scene\b|episode|monologue/i.test(s.replace(/\b(full )?transcript\b/gi, ''))) return null
  s = s.replace(/\s*[\u2013\u2014|-]\s*(full\s+)?transcript\s*$/i, '').replace(/\s*\|\s*transcript\s*$/i, '').replace(/\s+transcript\s*$/i, '').trim()
  const m = s.match(/^(.*?):\s*(.+)$/)
  const nm = normTitle(name)
  let head = null, body = s
  const sur = normTitle(String(name).trim().split(/\s+/).pop() || '')
  if (m && normTitle(m[1]).length && ((sur.length >= 2 && normTitle(m[1]).includes(sur)) || nm.includes(normTitle(m[1])))) { head = m[1]; body = m[2] }
  if (needPrefix && !head) return null
  const y = body.match(/\s*\((\d{4})\)\s*$/)
  const year = y ? +y[1] : null
  body = body.replace(/\s*\((\d{4})\)\s*$/, '').trim()
  if (needPrefix && !year) return null
  if (!body || body.length > 90 || normTitle(body) === nm) return head && year ? { title: smartCase(body || head), year } : null
  return { title: smartCase(body), year }
}
// data/r2/site_manifest.json carries transcript links and word counts; Funnier keeps only each special's title + year
export function slimManifest(d) {
  const out = {}
  for (const [id, v] of Object.entries(d?.comedians || {})) {
    if (!/^[a-z0-9-]+$/.test(id) || !Array.isArray(v?.specials)) continue
    const name = str(v.name, 120) || id, seen = new Set(), sp = []
    for (const s of v.specials) {
      const t = specialTitle(s?.title, name, true); if (!t) continue
      const k = normTitle(t.title); if (seen.has(k)) continue; seen.add(k); sp.push([t.title, t.year])
    }
    if (sp.length) out[id] = sp.slice(0, 20)
  }
  return { comedians: out }
}

// ---- schema checks (shape only; values are funnygraph's to change) ----
const rowsOf = (d) => (Array.isArray(d) ? d : Array.isArray(d?.rows) ? d.rows : null)
const idRows = (rows, min = 1) => Array.isArray(rows) && rows.length >= min && rows.every((r) => r && typeof r.comedian_id === 'string' && typeof r.name === 'string')
export const VALIDATE = {
  'rankings/ratings.json': (d) => idRows(rowsOf(d), 20) && rowsOf(d).every((r) => r.boards && typeof r.boards === 'object'),
  'rankings/house.json': (d) => idRows(rowsOf(d), 5) && rowsOf(d).every((r) => r.rank == null || typeof r.rank === 'number'),
  'rankings/consensus.json': (d) => idRows(rowsOf(d), 5) && rowsOf(d).every((r) => typeof r.rank === 'number'),
  'rankings/canon.json': (d) => idRows(rowsOf(d), 5) && rowsOf(d).every((r) => typeof r.rank === 'number'),
  'rankings/peoples.json': (d) => idRows(rowsOf(d), 5) && rowsOf(d).every((r) => typeof r.rank === 'number'),
  'rankings/by_type.json': (d) => d && typeof d === 'object' && !Array.isArray(d) && Object.values(d).every((v) => idRows(v, 0)),
  'rankings/by_continent.json': (d) => d && typeof d === 'object' && !Array.isArray(d) && Object.values(d).every((v) => idRows(v, 0)),
  'rankings/specials.json': (d) => Array.isArray(d) && d.every((r) => r && typeof r.special === 'string' && typeof r.comedian_id === 'string'),
  'rankings/bits.json': (d) => Array.isArray(d) && d.every((r) => r && typeof r.bit === 'string' && typeof r.comedian_id === 'string'),
  'rankings/neighbors.json': (d) => d && typeof d === 'object' && !Array.isArray(d) && Object.values(d).every((v) => Array.isArray(v)),
  'rankings/spotlight.json': (d) => d && typeof d === 'object' && !Array.isArray(d),
  'rankings/metrics.json': (d) => idRows(rowsOf(d), 20) && rowsOf(d).every((r) => r.gap_value == null || typeof r.gap_value === 'number'),
  'rankings/by_generation.json': (d) => d && typeof d === 'object' && !Array.isArray(d) && Object.values(d).every((v) => idRows(v, 0)),
  'data/r2/site_manifest.json': (d) => d && typeof d === 'object' && d.comedians && typeof d.comedians === 'object' && !Array.isArray(d.comedians),
}
// files published in a slimmed form (no prose, no transcript links)
export const SLIM = { 'rankings/bits.json': (d) => slimBits(d), 'data/r2/site_manifest.json': (d) => slimManifest(d) }
export const REQUIRED = ['rankings/ratings.json']
export const validGraph = (g) => !!slimGraph(g)

// bits.json carries only metadata: the bit's name, theory operators and rank. No "why" prose, no lines.
export const slimBits = (d) => d.map((b) => ({ bit: String(b.bit).slice(0, 120), comedian_id: b.comedian_id, theories: Array.isArray(b.theories) ? b.theories.filter((t) => typeof t === 'string').slice(0, 6) : [], bit_rank: num(b.bit_rank), score: num(b.score) }))
