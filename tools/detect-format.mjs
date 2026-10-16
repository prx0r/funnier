// Sets clips.json `format` ("vertical" | "horizontal") for every YouTube clip, keyless and metadata only. A clip is
// vertical when the oEmbed of its /shorts/<id> URL is taller than wide (the watch-URL oEmbed always reports 16:9, so it
// can't tell), or when https://www.youtube.com/shorts/<id> answers 200 (a regular video 303-redirects to /watch).
// Nothing is downloaded. Desktop never gets a vertical clip (src/app.js servable), so an untagged Short must be caught
// here. Usage (from funnier/): node tools/detect-format.mjs [--all]   (--all re-checks clips that already have a format)
import fs from 'node:fs'
const UA = { 'user-agent': 'Mozilla/5.0 (compatible; FunnierBot/1.0; +https://www.funnier.si/)' }
export async function isVertical(id) {
  try { const r = await fetch(`https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/shorts/${id}`, { headers: UA }); if (r.ok) { const j = await r.json(); if (j.width && j.height) return j.height > j.width } } catch {}
  try { const r = await fetch(`https://www.youtube.com/shorts/${id}`, { headers: UA, redirect: 'manual' }); return r.status === 200 } catch { return null }
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const clips = JSON.parse(fs.readFileSync('clips.json', 'utf8')), all = process.argv.includes('--all')
  let n = 0
  const todo = clips.filter((c) => c.media === 'youtube' && (all || (c.format !== 'vertical' && c.format !== 'horizontal')))
  for (let i = 0; i < todo.length; i += 12) await Promise.all(todo.slice(i, i + 12).map(async (c) => { // 12 at a time
    const v = await isVertical(c.id); if (v == null) return
    const f = v ? 'vertical' : 'horizontal'; if (c.format === f) return
    console.log(c.id, c.format || '(none)', '->', f, '|', c.comic, '|', c.title); c.format = f; n++
  }))
  fs.writeFileSync('clips.json', JSON.stringify(clips, null, 1) + '\n')
  console.log(`${n} clips (re)classified of ${todo.length} checked`)
}
