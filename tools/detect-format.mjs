// Sets clips.json `format` ("vertical" | "horizontal") for every YouTube clip, keyless and metadata only:
// a clip is vertical when its oEmbed is taller than wide, or when https://www.youtube.com/shorts/<id> answers 200
// (a regular video 303-redirects to /watch). Nothing is downloaded. Usage (from funnier/): node tools/detect-format.mjs [--all]
import fs from 'node:fs'
const UA = { 'user-agent': 'Mozilla/5.0 (compatible; FunnierBot/1.0; +https://www.funnier.si/)' }
export async function isVertical(id) {
  try { const r = await fetch(`https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v=${id}`, { headers: UA }); if (r.ok) { const j = await r.json(); if (j.width && j.height && j.height > j.width) return true } } catch {}
  try { const r = await fetch(`https://www.youtube.com/shorts/${id}`, { headers: UA, redirect: 'manual' }); return r.status === 200 } catch { return null }
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const clips = JSON.parse(fs.readFileSync('clips.json', 'utf8')), all = process.argv.includes('--all')
  let n = 0
  for (const c of clips) {
    if (c.media !== 'youtube' || (!all && (c.format === 'vertical' || c.format === 'horizontal'))) continue
    const v = await isVertical(c.id); if (v == null) continue
    c.format = v ? 'vertical' : 'horizontal'; n++
    console.log(c.id, c.format, '|', c.comic, '|', c.title)
  }
  fs.writeFileSync('clips.json', JSON.stringify(clips, null, 1) + '\n')
  console.log(`${n} clips classified`)
}
