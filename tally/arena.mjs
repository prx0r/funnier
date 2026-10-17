// Funnier arena votes in funnygraph's ballot shape (funnygraph ARENA_BALLOT.md: rankings/arena.json
// {a, b, a_wins, b_wins, n} per comedian pair). Built by the tally from the merged, de-duplicated votes (AT Protocol
// records + the anonymised D1 /export/votes), published at https://www.funnier.si/data/arena.json. funnygraph pulls it;
// Funnier never pushes to funnygraph. No voter identifiers leave here: only per-pair counts.
import fs from 'node:fs'
import path from 'node:path'

const slug = (n) => String(n).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

// comic name -> funnygraph comedian_id: the published comics.json (fgId, written by tools/sync-funnygraph.mjs) wins,
// then fg-map.json, then site/comics.json slug, then the slugified name. Returns null for an unknown comic only when
// a roster is given and the id is not in it.
export function fgResolver({ outDir, srcDir }) {
  const read = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null } }
  const pub = read(path.join(outDir, 'comics.json'))?.comics || {}
  const owned = read(path.join(srcDir, 'site', 'comics.json'))?.comics || {}
  const map = read(path.join(srcDir, 'fg-map.json'))?.map || {}
  const roster = read(path.join(outDir, 'data', 'funnygraph', 'roster.json'))?.comedians || null
  return (name) => {
    const id = pub[name]?.fgId || map[name] || owned[name]?.slug || slug(name)
    return !roster || roster[id] ? id : null
  }
}

// votes: [{a, b, winner, voter: 'human'|'agent', did}], byId: clip id -> {comic}. Humans only; same-comic votes
// (never served, hard rule) are skipped defensively.
export function arenaPairs(votes, byId, fgOf) {
  const P = new Map(), unmapped = new Set(), voters = new Set()
  let used = 0
  for (const v of votes) {
    if (!v || v.voter === 'agent') continue
    const A = byId[v.a]?.comic, B = byId[v.b]?.comic, W = byId[v.winner]?.comic
    if (!A || !B || !W || A === B || (v.winner !== v.a && v.winner !== v.b)) continue
    const fa = fgOf(A), fb = fgOf(B)
    if (!fa) unmapped.add(A); if (!fb) unmapped.add(B)
    if (!fa || !fb || fa === fb) continue
    const [a, b] = fa < fb ? [fa, fb] : [fb, fa], fw = W === A ? fa : fb
    const k = a + '|' + b, r = P.get(k) || { a, b, a_wins: 0, b_wins: 0, n: 0 }
    if (fw === a) r.a_wins++; else r.b_wins++
    r.n++; P.set(k, r); used++; if (v.did) voters.add(v.did)
  }
  const pairs = [...P.values()].sort((x, y) => y.n - x.n || (x.a + x.b < y.a + y.b ? -1 : 1))
  return { pairs, votes: used, voters: voters.size, unmapped: [...unmapped].sort() }
}

export function arenaDoc(res, { updated, synthetic = false, fgSha7 = null } = {}) {
  return {
    schema: 'funnygraph.arena/v1',
    note: 'Blind A/B clip votes from Funnier (www.funnier.si), aggregated per comedian pair. a < b alphabetically; ids are funnygraph comedian_id. Humans only (agent votes excluded); one vote per voter per clip pair (latest wins); a clash is always two different comics. No voter identifiers. Apply your own n threshold (ARENA_BALLOT.md: n >= 30).',
    updated, source: 'https://www.funnier.si/data/arena.json', roster: fgSha7 ? `prx0r/funnygraph@${fgSha7}` : null,
    ...(synthetic ? { synthetic: true } : {}),
    votes: res.votes, voters: res.voters, pairs: res.pairs, unmapped: res.unmapped,
  }
}
