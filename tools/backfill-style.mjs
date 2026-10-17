// Backfills the comic-level style prior on older clips: a clip with no style tags whose comic has funnygraph persona tags
// gets them (max 3, crowd-work first when the title says so), marked tagsSource "fg-persona" so they read as a comic-level
// prior, not a clip label. Also stamps `fg` (comedian_id) and `region` where funnygraph knows the comic, so feeds and the
// region scope work without the merged comics.json. Never overwrites hand or draft tags. Metadata only.
// Usage (from funnier/): node tools/backfill-style.mjs --roster /tmp/pub/data/funnygraph/roster.json [--dry]
import fs from 'node:fs'
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
const roster = JSON.parse(fs.readFileSync(arg('--roster', '/tmp/pub/data/funnygraph/roster.json'), 'utf8')).comedians
const clips = JSON.parse(fs.readFileSync('clips.json', 'utf8'))
const fgmap = (() => { try { return JSON.parse(fs.readFileSync('fg-map.json', 'utf8')).map || {} } catch { return {} } })()
const owned = (() => { try { return JSON.parse(fs.readFileSync('site/comics.json', 'utf8')).comics || {} } catch { return {} } })()
const slug = (n) => n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
let tagged = 0, fgd = 0, reg = 0
for (const c of clips) {
  if (c.status === 'removed' || c.kind !== 'human') continue
  const id = c.fg || fgmap[c.comic] || owned[c.comic]?.slug || slug(c.comic), g = roster[id]
  if (!g || g.synthetic) continue
  if (!c.fg) { c.fg = id; fgd++ }
  if (!c.region && g.region) { c.region = g.region; reg++ }
  if ((!Array.isArray(c.style) || !c.style.length) && g.tags?.length) {
    const st = [...g.tags]; if (/crowd ?work/i.test(c.title || '') && !st.includes('crowd-work')) st.unshift('crowd-work')
    c.style = st.slice(0, 3); c.tagsSource = 'fg-persona'; tagged++
  }
}
console.log(`style backfilled on ${tagged} clips; fg stamped on ${fgd}; region on ${reg}`)
if (!process.argv.includes('--dry')) fs.writeFileSync('clips.json', JSON.stringify(clips, null, 1) + '\n')
