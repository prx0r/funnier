// Vote sources for the tally: AT Protocol records (Bluesky sign-in, read from each voter's PDS) + the Worker's public,
// anonymised D1 export (Google sign-in: GET <api>/export/votes and /export/events, voter = 'd1:<salted hash>').
// mergeVotes: one canonical voter per person, the latest vote per voter per pair. A person who used both sources is
// detected when a D1 vote is the same pick (pair, winner, createdAt to the ms) as one of their AT records (the client
// sends a vote to both when signed in to both): that D1 voter is aliased to the DID, so the copies collapse into one.
const pk = (a, b) => [a, b].sort().join('|')

export async function fetchExport(base, kind = 'votes', { since = '', maxPages = 200, fetchImpl = fetch } = {}) {
  const out = []
  let cursor = ''
  for (let i = 0; i < maxPages; i++) {
    const u = `${base.replace(/\/$/, '')}/export/${kind}?limit=1000${since ? '&since=' + encodeURIComponent(since) : ''}${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`
    const r = await fetchImpl(u)
    if (!r.ok) throw new Error(`export ${kind} ${r.status}`)
    const j = await r.json()
    out.push(...(Array.isArray(j[kind]) ? j[kind] : []))
    if (!j.next) break
    cursor = j.next
  }
  return out
}

// atVotes: [{did, a, b, winner, createdAt, voter: 'human'|'agent', ...}]  d1Votes: export rows [{voter, a, b, winner, createdAt, ms, daily, signals}]
// byId: clip lookup (unknown clips dropped). Returns { votes, alias, d1Voters }
export function mergeVotes(atVotes, d1Votes, byId, { now = Date.now() } = {}) {
  const atKey = new Map()
  for (const v of atVotes) atKey.set(pk(v.a, v.b) + '|' + v.winner + '|' + Date.parse(v.createdAt), v.did)
  const alias = {}
  const d1 = []
  for (const x of d1Votes || []) {
    if (!x || typeof x.voter !== 'string' || !/^d1:[0-9a-f]{8,64}$/.test(x.voter)) continue
    if (!byId[x.a] || !byId[x.b] || x.a === x.b || (x.winner !== x.a && x.winner !== x.b)) continue
    const t = Date.parse(x.createdAt); if (!t || t > now + 5 * 60e3) continue
    const did = atKey.get(pk(x.a, x.b) + '|' + x.winner + '|' + t)
    if (did) alias[x.voter] = did
    d1.push({ did: x.voter, voter: 'human', source: 'd1', a: x.a, b: x.b, winner: x.winner, createdAt: new Date(t).toISOString(),
      ...(Number.isInteger(x.ms) && x.ms >= 0 && x.ms <= 3600000 ? { ms: x.ms } : {}), ...(typeof x.daily === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x.daily) ? { daily: x.daily } : {}),
      ...(x.signals && typeof x.signals === 'object' ? { signals: x.signals } : {}) })
  }
  const latest = new Map()
  for (const v of [...atVotes.map((v) => ({ ...v, source: v.source || 'atproto' })), ...d1]) {
    const who = alias[v.did] || v.did, k = who + '|' + pk(v.a, v.b), prev = latest.get(k)
    // the latest pick wins; on an exact tie the AT record (public, signed) is kept
    if (!prev || Date.parse(v.createdAt) > Date.parse(prev.createdAt) || (Date.parse(v.createdAt) === Date.parse(prev.createdAt) && prev.source === 'd1' && v.source !== 'd1')) latest.set(k, { ...v, did: who })
  }
  const votes = [...latest.values()]
  const d1Voters = {}
  for (const v of votes) if (v.source === 'd1') d1Voters[v.did] = (d1Voters[v.did] || 0) + 1
  return { votes, alias, d1Voters }
}

// export events -> train-screening sessions input ({user, kind, a, b, at, signals}); aliased like the votes
export function eventsForTraining(d1Events, alias = {}) {
  return (d1Events || []).filter((e) => e && ['pass', 'skip'].includes(e.kind) && typeof e.voter === 'string' && e.a && e.b && Date.parse(e.createdAt))
    .map((e) => ({ user: alias[e.voter] || e.voter, kind: e.kind, a: e.a, b: e.b, at: e.createdAt, signals: e.signals && typeof e.signals === 'object' ? e.signals : {} }))
}
