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
    bio: { dob: str(bio.dob, 10), dod: str(bio.dod, 10), birthplace: str(bio.birthplace, 80), citizenship: str(bio.citizenship, 80) },
    website: str(g.website?.url, 200),
    channels: chans,
  }
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
}
export const REQUIRED = ['rankings/ratings.json']
export const validGraph = (g) => !!slimGraph(g)

// bits.json carries only metadata: the bit's name, theory operators and rank. No "why" prose, no lines.
export const slimBits = (d) => d.map((b) => ({ bit: String(b.bit).slice(0, 120), comedian_id: b.comedian_id, theories: Array.isArray(b.theories) ? b.theories.filter((t) => typeof t === 'string').slice(0, 6) : [], bit_rank: num(b.bit_rank), score: num(b.score) }))
