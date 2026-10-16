// Checks the characters2 import: theory.json is compact and text-free; the clip->special join and the time map behave.
// Usage (from funnier/): node tools/test-theory.mjs [--c2 ../../characters2]
import fs from 'node:fs'
import path from 'node:path'
import { bitAt, bitsInWindow, posAt } from '../tally/bitmap.mjs'
import { structSim, structParts } from '../src/structsim.js'
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null }
const C2 = path.resolve(arg('--c2') || process.env.CHARACTERS2 || '../../characters2')
const fails = [], ok = (c, m) => { if (!c) fails.push(m); console.log((c ? 'PASS ' : 'FAIL ') + m) }
const raw = fs.readFileSync('site/theory.json', 'utf8'), T = JSON.parse(raw), clips = JSON.parse(fs.readFileSync('clips.json', 'utf8'))
ok(raw.length < 40000, `theory.json is compact (${(raw.length / 1024).toFixed(1)} KB)`)
ok(!/"(text|setup|punch_candidate|bit_id)"/.test(raw), 'theory.json carries no bit text or bit rows')
const comicsInClips = [...new Set(clips.map((c) => c.comic))]
const COMICS = JSON.parse(fs.readFileSync('site/comics.json', 'utf8')).comics
const c2has = (name) => fs.existsSync(path.join(C2, 'theory/transcripts/bits_annotated', COMICS[name]?.slug || '-'))
ok(comicsInClips.filter(c2has).every((c) => T.comics[c]?.ops && T.comics[c]?.sty), 'every comic characters2 covers has operator priors + stylometry')
const bare = comicsInClips.filter((c) => !T.comics[c])
if (bare.length) { // no theory data (e.g. Mark Normand): struct_sim degrades to tags, never throws, never NaN
  const x = clips.find((c) => c.comic === bare[0]), y = clips.find((c) => c.comic !== bare[0] && T.comics[c.comic])
  const v = structSim(x, y, T, { pairing: true }), p = structParts(x, y, T)
  ok(Number.isFinite(v) && v >= 0 && v <= 1 && p.ops == null && p.arch == null && p.style != null, `no theory data for ${bare.join(', ')}: struct_sim falls back to tags (${v})`)
}
ok(clips.every((c) => 'special_id' in c), 'every clip has special_id (null when the title names no known special)')
ok(clips.filter((c) => c.special_id).every((c) => T.specials[c.special_id]?.durSec > 0), 'every matched special has a duration')
ok(clips.filter((c) => /outtake/i.test(c.title)).every((c) => c.special_id === null), 'outtakes are never mapped into a special')
const norm = clips.find((c) => c.id === 'gN02rRbOlUE')
ok(norm?.special_id === 'norm-macdonald-nothing-special-transcript', 'Nothing Special clip -> norm-macdonald-nothing-special-transcript')
const bp = path.join(C2, 'theory/transcripts/bits_annotated/norm-macdonald/norm-macdonald-nothing-special-transcript.bits.json')
if (fs.existsSync(bp) && norm?.t_start != null) {
  const bits = JSON.parse(fs.readFileSync(bp, 'utf8')).bits, sp = T.specials[norm.special_id]
  const b = bitAt(norm, sp, bits, 20)
  ok(b && /opinion/i.test(bits.slice(bits.indexOf(b) - 3, bits.indexOf(b) + 4).map((x) => x.text).join(' ')), 'time map: 20s into the clip lands on the opinions bit')
  const w = bitsInWindow(norm, sp, bits, 10, 40)
  ok(w.length >= 1 && w.every((x) => x.feat.pos_in_special >= posAt(norm, sp, 10) && x.feat.pos_in_special <= posAt(norm, sp, 40)), `time map: a 30s window maps to ${w.length} bits inside it`)
  ok(bitsInWindow(norm, sp, bits, 12, 12).length === 1, 'time map: a zero-length window gives the bit that was playing')
  ok(bitsInWindow({ ...norm, t_start: null }, sp, bits, 0, 30).length === 0, 'time map: no t_start -> no bits (falls back to special level)')
} else console.log('SKIP time-map checks (no characters2 clone or no t_start)')
// struct_sim (§4a)
{
  const H = clips.filter((c) => c.kind === 'human'), all = []
  for (let i = 0; i < H.length; i++) for (let j = i + 1; j < H.length; j++) { const x = structSim(H[i], H[j], T), y = structSim(H[j], H[i], T); all.push(x); if (Math.abs(x - y) > 1e-9) { ok(false, 'struct_sim symmetric'); break } }
  ok(all.every((x) => x >= 0 && x <= 1), `struct_sim in [0,1] over ${all.length} pairs (min ${Math.min(...all)}, max ${Math.max(...all)})`)
  const [n1, n2] = H.filter((c) => c.comic === 'Norm Macdonald')
  const pp = structParts(n1, n2, T, { pairing: true })
  ok(pp.arch == null && pp.ops == null && pp.sty == null, 'pairing: same-comic pairs drop comic-level traits (identical by construction)')
  ok(structParts(n1, n2, T).ops === 1, 'recommendation: same comic keeps comic-level operator match')
  const L = H.find((c) => c.comic === 'Louis C.K.' && !c.special_id), R = H.find((c) => c.comic === 'Chris Rock' && !c.special_id), J = H.find((c) => c.comic === 'Jerry Seinfeld' && !c.special_id)
  ok(structParts(L, J, T).ops > structParts(L, R, T).ops, 'operator lift tells comics apart (Louis~Seinfeld closer than Louis~Rock on ops)')
  ok(structSim({ comic: 'X', style: ['dark'] }, { comic: 'Y', style: ['dark'] }, {}) === 1 && structSim({ comic: 'X' }, { comic: 'Y' }, {}) === 0, 'no theory: falls back to tags; nothing known -> 0')
}
console.log(fails.length ? `${fails.length} FAILED` : 'ALL PASS'); process.exit(fails.length ? 1 : 0)
