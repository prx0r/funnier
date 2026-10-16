// §4c humour algorithm on a synthetic viewer: they rewatch every moment where a chosen operator fires and swipe
// away from the rest; the fitted profile must name that operator. Usage (from funnier/): node tally/test-humour.mjs [--c2 ../../characters2]
import fs from 'node:fs'
import path from 'node:path'
import { moments, rows, profile, OP_LABEL } from './humour.mjs'
import { bitsInWindow } from './bitmap.mjs'
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null }
const C2 = path.resolve(arg('--c2') || process.env.CHARACTERS2 || '../../characters2')
const fails = [], ok = (c, m) => { if (!c) fails.push(m); console.log((c ? 'PASS ' : 'FAIL ') + m) }
const J = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
const clips = J('clips.json'), theory = J('site/theory.json'), clipsById = Object.fromEntries(clips.map((c) => [c.id, c]))
const loadBits = (slug, sp) => { const p = path.join(C2, 'theory/transcripts/bits_annotated', slug || '-', sp + '.bits.json'); return fs.existsSync(p) ? J(p).bits : [] }
const anchored = clips.filter((c) => c.special_id && c.t_start != null)
if (!anchored.length || !fs.existsSync(C2)) { console.log('SKIP (no anchored clips or no characters2 clone)'); process.exit(0) }
const windows = [] // every 5s window of the anchored clips' first 2 minutes, with the bits on screen
for (const c of anchored) { const sp = theory.specials[c.special_id], bits = loadBits(theory.comics[c.comic].slug, c.special_id); for (let t = 0; t < 120; t += 5) { const on = bitsInWindow(c, sp, bits, t, t + 5); if (on.length) windows.push({ c, t, ops: new Set(on.flatMap((b) => b.ops || [])) }) } }
const freq = {}; for (const w of windows) for (const o of w.ops) freq[o] = (freq[o] || 0) + 1
const targets = Object.entries(freq).filter(([, n]) => n >= 3 && n <= windows.length * 0.6).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([o]) => o)
ok(targets.length >= 1, `operators on screen in ${windows.length} windows: ${JSON.stringify(freq)}`)
for (const TARGET of targets) {
  const events = windows.map(({ c, t, ops }) => ({ a: c.id, b: 'zzzzzzzzzzz', signals: ops.has(TARGET) ? { leftSeekTargets: [t], leftSeekFrom: [t + 5] } : { leftSkippedAt: t + 5 } }))
  const ms = moments([], events), R = rows(ms, { clipsById, theory, loadBits }), p = profile(ms, R)
  ok(p.ready && p.basis.bit > 0, `${TARGET}: ${p.laughs} laughs / ${p.swipes} swipes, bit-level basis ${p.basis.bit}`)
  ok(p.top[0] === TARGET && p.line?.includes(OP_LABEL[TARGET]), `${TARGET}: profile names it first ("${p.line}")`)
  ok(!/"(text|setup|punch_candidate)"/.test(JSON.stringify(p)), `${TARGET}: profile carries no bit text`)
}
// a viewer with only unmatched clips (no theory data): no profile line, never a crash
{ const mark = clips.find((c) => !theory.comics[c.comic])
  if (mark) { const ms = moments([], [{ a: mark.id, b: 'x', signals: { leftSeekTargets: [5], leftSkippedAt: 30 } }]); const p = profile(ms, rows(ms, { clipsById, theory, loadBits })); ok(p.line === null && !p.ready, `no theory data (${mark.comic}): no profile, no crash`) } }
// votes carry the on-screen order in signals.shown
{ const ms = moments([{ a: 'A', b: 'B', signals: { shown: ['B', 'A'], leftSeekTargets: [3], rightSkippedAt: 9 } }], [])
  ok(ms.length === 2 && ms[0].clip === 'B' && ms[0].y === 1 && ms[1].clip === 'A' && ms[1].y === 0, 'vote signals map left/right through the shown order') }
console.log(fails.length ? `${fails.length} FAILED` : 'ALL PASS'); process.exit(fails.length ? 1 : 0)
