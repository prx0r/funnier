// Tally pairing rules: run a synthetic tally, then sample 500 rounds from pairs.json the way the client's
// "Training the crowd chart" does (weighted by w) and check the hard rules. Usage (from funnier/): node tally/test-pairs.mjs
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
const OUT = fs.mkdtempSync('/tmp/funnier-pairs-')
execFileSync('node', ['tally/tally.mjs', 'clips.json', OUT], { env: { ...process.env, SYNTH: '300' }, stdio: 'ignore' })
const clips = Object.fromEntries(JSON.parse(fs.readFileSync('clips.json', 'utf8')).map((c) => [c.id, c]))
const { pairs } = JSON.parse(fs.readFileSync(OUT + '/data/pairs.json', 'utf8'))
const fails = [], ok = (c, m) => { if (!c) fails.push(m); console.log((c ? 'PASS ' : 'FAIL ') + m) }
const band = (c) => (c.sec == null ? null : c.sec < 120 ? 'short' : c.sec < 480 ? 'mid' : 'long')
ok(pairs.length > 0, `pairs.json has ${pairs.length} pairs`)
ok(pairs.every((p) => clips[p.a].comic !== clips[p.b].comic), 'no same-comic pair in pairs.json')
ok(pairs.every((p) => { const x = band(clips[p.a]), y = band(clips[p.b]); return !x || !y || x === y }), 'length band rule holds')
ok(pairs.every((p) => p.s >= 0 && p.s <= 1), 'every pair carries struct_sim s in [0,1]')
const W = pairs.reduce((s, p) => s + p.w, 0); let same = 0
for (let i = 0; i < 500; i++) { let x = Math.random() * W, pick = pairs[0]; for (const p of pairs) { x -= p.w; if (x <= 0) { pick = p; break } } if (clips[pick.a].comic === clips[pick.b].comic) same++ }
ok(same === 0, `500 sampled rounds: ${same} same-comic`)
const daily = JSON.parse(fs.readFileSync(OUT + '/data/daily.json', 'utf8'))
ok(Object.values(daily.days).every((d) => clips[d.a].comic !== clips[d.b].comic), 'daily clashes are two different comics')
fs.rmSync(OUT, { recursive: true, force: true })
console.log(fails.length ? `${fails.length} FAILED` : 'ALL PASS'); process.exit(fails.length ? 1 : 0)
