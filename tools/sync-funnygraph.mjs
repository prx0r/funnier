// Live funnygraph sync. Node 22+, no deps. Runs in .github/workflows/funnier.yml on every deploy (every 15 min).
// funnygraph is the source of truth for rankings and comic identity; nothing it owns is committed to master. This
// script fetches the latest boards pinned to one funnygraph commit, validates their shape, and writes them into the
// published site (gh-pages): <out>/data/funnygraph/{meta,boards,roster}.json + rankings/*.json, then generates
// <out>/comics.json by merging funnygraph identity onto Funnier's own fields (site/comics.json: photos, verified
// specials, links, card line). Fail soft: an unreachable or invalid file keeps the last good copy already in <out>;
// the script never exits non-zero, so a funnygraph outage can't stop a deploy.
// Usage (from the repo root in CI):  node funnier/tools/sync-funnygraph.mjs funnier pub
//        (locally, from funnier/):   node tools/sync-funnygraph.mjs . /tmp/pub
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { FG_REPO, FG_BRANCH, rawUrl, VALIDATE, REQUIRED, slimGraph, slimBits, REGION_LABEL, CONTINENT_LABEL } from './fg-lib.mjs'

const [, , SRC = '.', OUT = 'pub'] = process.argv
const FGDIR = path.join(OUT, 'data', 'funnygraph')
const UA = { 'user-agent': 'FunnierSync/1.0 (+https://www.funnier.si/)' }
const GH = { ...UA, accept: 'application/vnd.github+json', ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) }
const readJSON = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return d } }
const writeJSON = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v)) }
const log = (...a) => console.log('[fg-sync]', ...a)
const errors = []

async function getJSON(url, headers = UA, tries = 2) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(20000) })
      if (r.ok) return await r.json()
      if (r.status === 404) return null
    } catch {}
    await new Promise((s) => setTimeout(s, 800 * (i + 1)))
  }
  return null
}
async function pool(items, n, fn) { const out = []; let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k) } })); return out }

async function headSha() {
  if (process.env.FG_SYNC_OFFLINE) return null // tests: simulate funnygraph being unreachable
  const j = await getJSON(`https://api.github.com/repos/${FG_REPO}/commits/${FG_BRANCH}`, GH)
  if (j && /^[0-9a-f]{40}$/.test(j.sha)) return { sha: j.sha, date: j.commit?.committer?.date || null }
  try { // no API (rate limit / outage): ask git directly
    const o = execFileSync('git', ['ls-remote', `https://github.com/${FG_REPO}`, `refs/heads/${FG_BRANCH}`], { timeout: 20000 }).toString()
    const m = o.match(/^([0-9a-f]{40})/); if (m) return { sha: m[1], date: null }
  } catch {}
  return null
}

async function main() {
  const prevMeta = readJSON(path.join(FGDIR, 'meta.json'), {})
  const head = await headSha()
  const meta = { repo: FG_REPO, branch: FG_BRANCH, sha: prevMeta.sha || null, commitDate: prevMeta.commitDate || null, syncedAt: new Date().toISOString(), lastGoodAt: prevMeta.lastGoodAt || null, files: prevMeta.files || {}, ok: false, errors }
  if (!head) errors.push('could not resolve funnygraph head; keeping last good copy')
  const ref = head?.sha
  // ---- boards ----
  let changed = false
  if (ref && ref !== prevMeta.sha) {
    for (const [file, ok] of Object.entries(VALIDATE)) {
      const d = await getJSON(rawUrl(ref, file))
      if (d == null || !ok(d)) { errors.push(`${file}: ${d == null ? 'unreachable' : 'schema check failed'}; kept last good`); continue }
      writeJSON(path.join(FGDIR, file), file === 'rankings/bits.json' ? slimBits(d) : d)
      meta.files[file] = { sha: ref.slice(0, 7) }; changed = true
    }
  }
  // ---- roster: one comedian-graph per comic, refetched only when its blob changed ----
  // ROSTER_V: bump when slimGraph's output changes, so every cached record is rebuilt once
  const ROSTER_V = 2
  let roster = readJSON(path.join(FGDIR, 'roster.json'), null)
  const stale = !roster || roster.v !== ROSTER_V
  if (stale) roster = { v: ROSTER_V, blobs: {}, comedians: roster?.comedians || {} }
  if (ref && (ref !== prevMeta.sha || stale)) {
    const tree = await getJSON(`https://api.github.com/repos/${FG_REPO}/git/trees/${ref}?recursive=1`, GH)
    const graphs = (tree?.tree || []).filter((t) => t.type === 'blob' && /^comedians\/[a-z0-9-]+\/comedian-graph\.json$/.test(t.path))
    if (graphs.length) {
      const live = new Set(graphs.map((t) => t.path.split('/')[1]))
      const todo = graphs.filter((t) => roster.blobs[t.path.split('/')[1]] !== t.sha)
      let bad = 0
      await pool(todo, 16, async (t) => {
        const id = t.path.split('/')[1], g = await getJSON(rawUrl(ref, t.path)), s = slimGraph(g)
        if (!s || s.id !== id) { bad++; return }
        roster.comedians[id] = s; roster.blobs[id] = t.sha
      })
      for (const id of Object.keys(roster.comedians)) if (!live.has(id)) { delete roster.comedians[id]; delete roster.blobs[id] }
      if (bad) errors.push(`${bad} comedian graphs failed validation; kept their last good record`)
      roster.sha = ref; changed = true
      log(`roster ${Object.keys(roster.comedians).length} comics (${todo.length - bad} refreshed)`)
    } else errors.push('comedians tree unavailable; kept last good roster')
  }
  const haveRequired = REQUIRED.every((f) => fs.existsSync(path.join(FGDIR, f)))
  if (changed && haveRequired) { meta.sha = ref; meta.commitDate = head.date; meta.lastGoodAt = meta.syncedAt; writeJSON(path.join(FGDIR, 'roster.json'), roster) }
  meta.ok = haveRequired && !!meta.sha && !errors.length
  // ---- client bundle (always rebuilt from whatever last good files exist) ----
  const bundle = haveRequired ? buildBundle(meta, roster) : null
  if (bundle) writeJSON(path.join(FGDIR, 'boards.json'), bundle)
  // ---- comics.json: Funnier-owned fields + funnygraph identity ----
  const owned = readJSON(path.join(SRC, 'site', 'comics.json'), { comics: {} })
  const map = readJSON(path.join(SRC, 'fg-map.json'), { map: {} })
  const clips = readJSON(path.join(SRC, 'clips.json'), [])
  const merged = mergeComics(owned, map.map || {}, roster.comedians || {}, bundle, clips, meta)
  writeJSON(path.join(OUT, 'comics.json'), merged)
  writeJSON(path.join(FGDIR, 'meta.json'), meta)
  log(`sha ${meta.sha ? meta.sha.slice(0, 7) : 'none'} ${changed ? 'updated' : 'unchanged'}; ${Object.keys(merged.comics).length} comics in comics.json; ${errors.length ? 'errors: ' + errors.join(' | ') : 'ok'}`)
}

// The slim bundle the site reads: every board's order (rank + display value), a per-comic index for profiles and
// the region filter, and the week's spotlight. Values are copied as funnygraph publishes them, never recomputed.
export function buildBundle(meta, roster, dir = FGDIR) {
  const R = (f) => readJSON(path.join(dir, f))
  const rowsOf = (d) => (Array.isArray(d) ? d : d?.rows || [])
  const ratings = rowsOf(R('rankings/ratings.json')), house = R('rankings/house.json'), consensus = rowsOf(R('rankings/consensus.json'))
  const nbs = R('rankings/neighbors.json') || {}
  const canon = R('rankings/canon.json'), peoples = R('rankings/peoples.json'), byType = R('rankings/by_type.json') || {}, spotlight = R('rankings/spotlight.json') || {}
  const C = roster.comedians || {}
  const people = {}
  for (const r of ratings) {
    const g = C[r.comedian_id] || {}
    if (g.synthetic) continue // AI personas stay out of the human boards on Funnier
    const b = r.boards || {}
    people[r.comedian_id] = { n: r.name, t: r.tier || g.tier || null, r: g.region || null, c: g.continent || null, cov: r.coverage || null, h: typeof r.headline === 'number' ? r.headline : null, prov: r.provisional || null,
      house: b.house?.rank ?? null, pct: b.house?.pct ?? null, cons: b.consensus?.rank ?? null, canon: b.canon?.rank ?? null, peop: b.peoples?.rank ?? null, era: b.era?.rank ?? null,
      lo: r.interval?.lo ?? null, hi: r.interval?.hi ?? null, sig: g.signature || null, tags: g.tags || [],
      // feeds (src/feeds.js): funnygraph popularity lens (0..100) for the Underdog tier gap, top vibe neighbours [id, sim]
      pop: typeof r.lenses?.popularity === 'number' ? Math.round(r.lenses.popularity) : null,
      nb: (Array.isArray(nbs[r.comedian_id]) ? nbs[r.comedian_id] : []).filter((x) => x && typeof x.comedian_id === 'string' && typeof x.sim === 'number').slice(0, 8).map((x) => [x.comedian_id, +x.sim.toFixed(3)]) }
  }
  const order = (rows, val) => rows.filter((x) => people[x.comedian_id] && typeof x.rank === 'number').sort((a, b) => a.rank - b.rank).map((x) => [x.comedian_id, x.rank, val(x)])
  const regions = {}
  for (const p of Object.values(people)) { const k = p.r || 'unknown'; regions[k] = (regions[k] || 0) + 1 }
  return {
    source: { repo: meta.repo, sha: meta.sha, sha7: meta.sha ? meta.sha.slice(0, 7) : null, commitDate: meta.commitDate, url: meta.sha ? `https://github.com/${meta.repo}/tree/${meta.sha}/rankings` : null, syncedAt: meta.syncedAt, lastGoodAt: meta.lastGoodAt },
    boards: {
      house: { label: 'House board', blurb: 'funnygraph\u2019s own election: measured joke quality and theory depth.', rows: order(rowsOf(house), (x) => (x.house_pct != null ? Math.round(x.house_pct) : null)) },
      consensus: { label: 'Consensus', blurb: 'Critics, audiences and awards, as funnygraph publishes them (reference).', rows: order(consensus, (x) => (typeof x.score === 'number' ? +x.score.toFixed(2) : null)) },
      canon: { label: 'All-time canon', blurb: 'Critics and awards (reference).', rows: order(rowsOf(canon), (x) => (typeof x.score === 'number' ? +x.score.toFixed(2) : null)) },
      peoples: { label: 'People\u2019s choice', blurb: 'Audience ratings of each comic\u2019s standout special (reference).', rows: order(rowsOf(peoples), (x) => (typeof x.wr === 'number' ? +x.wr.toFixed(2) : null)) },
    },
    byType: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, (Array.isArray(v) ? v : []).filter((x) => people[x.comedian_id]).slice(0, 10).map((x) => x.comedian_id)])),
    spotlight: { week: spotlight.week || null, comedianOfWeek: (spotlight.comedian_of_week || [])[0]?.comedian_id || null, newComicOfWeek: spotlight.new_comic_of_week?.comedian_id || null },
    regions, regionLabel: REGION_LABEL, continentLabel: CONTINENT_LABEL,
    people,
  }
}

// funnygraph's persona 'deal' is a paragraph; the card wants its head noun phrase ('Language prophet', 'The clean machine')
export function cardLine(deal) {
  const first = String(deal).split(/(?<=[.!?])\s/)[0]
  const cut = first.split(/:|\s\u2014\s|\s-\s| who | that | whose |,/)[0].trim()
  const out = cut.length >= 8 ? cut : first
  return out.length > 90 ? out.slice(0, 87).replace(/\s+\S*$/, '') + '\u2026' : out
}
const YEARS_RE = /^(born \d{4}|\d{4}\s*[–-]\s*\d{4})$/i
export function mergeComics(owned, map, C, bundle, clips, meta) {
  const ownedComics = owned?.comics && typeof owned.comics === 'object' ? owned.comics : {}
  const names = [...new Set([...Object.keys(ownedComics), ...clips.filter((c) => c && c.status !== 'removed' && typeof c.comic === 'string').map((c) => c.comic)])]
  const slug = (n) => n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const clipFg = {} // clips found from funnygraph carry its comedian_id (tools/discover-fg-clips.mjs)
  for (const c of clips) if (c && typeof c.fg === 'string' && typeof c.comic === 'string' && !clipFg[c.comic]) clipFg[c.comic] = c.fg
  const out = {}
  for (const name of names) {
    const P = { ...(ownedComics[name] || {}) }
    const fgId = map[name] || P.slug || clipFg[name] || slug(name)
    const g = C[fgId], b = bundle?.people?.[fgId]
    const rec = { ...P, slug: P.slug || fgId }
    if (g && !g.synthetic) {
      rec.fgId = fgId
      rec.tier = g.tier; rec.region = g.region; rec.continent = g.continent
      rec.regionLabel = (g.region && REGION_LABEL[g.region]) || (g.continent && CONTINENT_LABEL[g.continent]) || null
      if (!rec.tagline && g.deal) rec.tagline = cardLine(g.deal)
      const y = g.bio?.dob ? (g.bio.dod ? `${g.bio.dob.slice(0, 4)}\u2013${g.bio.dod.slice(0, 4)}` : `Born ${g.bio.dob.slice(0, 4)}`) : null
      rec.facts = [y, rec.regionLabel, g.generation?.label, ...(Array.isArray(P.facts) ? P.facts.filter((f) => !YEARS_RE.test(f) && f !== rec.regionLabel) : [])].filter(Boolean)
      rec.styleTags = g.tags || []
      if (g.signature) rec.signature = g.signature
      if (g.website && !Object.values(rec.links || {}).includes(g.website)) rec.links = { ...(rec.links || {}), Website: g.website }
      if (b) rec.fg = { headline: b.h, coverage: b.cov, provisional: b.prov, house: b.house, pct: b.pct, lo: b.lo, hi: b.hi, consensus: b.cons, canon: b.canon, peoples: b.peop, era: b.era }
    }
    out[name] = rec
  }
  return { _note: 'Generated on deploy by tools/sync-funnygraph.mjs: Funnier-owned fields (site/comics.json) + funnygraph identity, region, tier and boards. Do not edit the published copy.', source: { repo: meta.repo, sha7: meta.sha ? meta.sha.slice(0, 7) : null }, comics: out, ai: owned?.ai || [] }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.log('[fg-sync] failed soft:', e?.message || e) }).finally(() => process.exit(0))
}
