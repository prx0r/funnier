// Keyless catalog maintenance. Node 22+, no deps.
// 1) Re-verify every clip in clips.json via YouTube oEmbed; clips that are deleted or no longer embeddable
//    are marked "status":"removed" (the site and tally skip them).
// 2) Read each allowlisted channel's public RSS feed (latest 15 uploads), keep videos whose title names a
//    tracked comic, check embeddability, and add them to candidates.json for human review.
//    Approve a candidate by moving it into clips.json. Nothing is downloaded; only id/title/channel are kept,
//    and the daily re-check keeps stored metadata fresh (YouTube API policy: refresh within 30 days).
// Usage: node tally/ingest.mjs   (run from the funnier/ dir)
import fs from 'node:fs'
import { isVertical } from '../tools/detect-format.mjs'
const UA = { 'user-agent': 'Mozilla/5.0 (compatible; FunnierBot/1.0; +https://prx0r.github.io/characters/)' }
const clips = JSON.parse(fs.readFileSync('clips.json', 'utf8'))
const cfg = JSON.parse(fs.readFileSync('channels.json', 'utf8'))
const candPath = 'candidates.json'
const cands = fs.existsSync(candPath) ? JSON.parse(fs.readFileSync(candPath, 'utf8')) : []
const today = new Date().toISOString().slice(0, 10)

async function oembed(id) {
  const r = await fetch(`https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v=${id}`, { headers: UA })
  if (r.status !== 200) return { ok: false, status: r.status }
  const j = await r.json()
  return { ok: true, title: j.title, author: j.author_name }
}

let removed = 0
for (const c of clips) {
  if (c.media !== 'youtube' || c.status === 'removed') continue
  try {
    const o = await oembed(c.id)
    if (!o.ok && (o.status === 401 || o.status === 403 || o.status === 404)) { c.status = 'removed'; c.removedOn = today; removed++ }
    else if (o.ok) {
      c.checked = today
      // desktop never gets vertical clips: an untagged clip (a Short added by hand) is tagged here
      if (c.format !== 'vertical' && c.format !== 'horizontal') { const v = await isVertical(c.id); if (v != null) { c.format = v ? 'vertical' : 'horizontal'; console.log('format', c.id, c.format) } }
    }
  } catch (e) { console.warn('oembed fail', c.id, e.message) }
}

const known = new Set([...clips.map((c) => c.id), ...cands.map((c) => c.id)])
let added = 0
for (const ch of cfg.channels) {
  try {
    const x = await (await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${ch.id}`, { headers: UA })).text()
    for (const [, id, title, pub] of x.matchAll(/<yt:videoId>([^<]+)<\/yt:videoId>[\s\S]*?<title>([^<]+)<\/title>[\s\S]*?<published>([^<]+)<\/published>/g)) {
      if (known.has(id)) continue
      const t = title.toLowerCase()
      let comic = Object.entries(cfg.comics).find(([, keys]) => keys.some((k) => t.includes(k)))?.[0]
      if (!comic && ch.assume) comic = ch.assume
      if (!comic) continue
      const o = await oembed(id)
      if (!o.ok) continue
      const v = await isVertical(id)
      cands.push({ id, comic, title: o.title, channel: ch.name, kind: 'human', media: 'youtube', ...(v != null ? { format: v ? 'vertical' : 'horizontal' } : {}), published: pub.slice(0, 10), found: today, status: 'pending' })
      known.add(id); added++
    }
  } catch (e) { console.warn('feed fail', ch.name, e.message) }
}
fs.writeFileSync('clips.json', JSON.stringify(clips, null, 1))
fs.writeFileSync(candPath, JSON.stringify(cands, null, 1))
console.log(`verified ${clips.length} clips (${removed} removed); ${added} new candidates (${cands.filter((c) => c.status === 'pending').length} pending review)`)
