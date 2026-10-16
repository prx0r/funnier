// characters2 handoff (funnier.character-handoff/v1): what the characters2 agent needs to build a comic from a trained
// character's (or a person's) humour model. Derived only from the passport's weights; no text generation here.
//   operator_priors  p(op) = roster mean(op) * exp(w_op), normalised: the comedy-theory operator mix to write with
//   delivery         energy / hold / pace in 0..1 (0.5 = no preference): sigmoid(2w)
//   archetype        the characters2 delivery archetype whose axis profile best matches the axis weights (+ all scores)
//   style            lean (w > 0.25) and avoid (w < -0.25) style tags; meta-axes (-1..1); format hints (0..1)
import { OPS, ARCH, AXES } from './engine.js'
import { metaAxes, typeName } from './sigil.js'
const sig = (x) => 1 / (1 + Math.exp(-x))
const r3 = (x) => Math.round(x * 1000) / 1000
export function handoff(p, ch = {}, theory = {}) {
  const w = (k) => (Number.isFinite(p?.features?.[k]?.w) ? p.features[k].w : 0)
  const mean = theory?.opsMean || {}
  const raw = OPS.map((op) => [op, Math.max(1e-3, +mean[op] || 1 / OPS.length) * Math.exp(w('op_' + op))]), Z = raw.reduce((s, x) => s + x[1], 0)
  const arch = Object.entries(ARCH).map(([a, prof]) => [a, r3(Object.entries(prof).reduce((s, [ax, v]) => s + v * w('ax_' + ax), 0))]).sort((x, y) => y[1] - x[1])
  const tag = (k) => AXES.find((a) => a.k === k)?.tag
  return {
    schema: 'funnier.character-handoff/v1', created: new Date().toISOString(),
    character: ch.id ? { id: ch.id, name: ch.name, bio: ch.bio || '', avatar_seed: ch.avatar_seed || null, parent_id: ch.parent_id || null, parent_hash: ch.parent_hash || null, url: 'https://www.funnier.si/c/' + ch.id } : null,
    model: { schema: p?.schema, model: p?.model, hash: p?.hash, votes: p?.n?.votes ?? 0, type: typeName(p).name },
    operator_priors: Object.fromEntries(raw.map(([op, v]) => [op, r3(v / Z)])),
    delivery: { energy: r3(sig(2 * w('energy'))), hold: r3(sig(2 * w('hold'))), pace: r3(sig(2 * w('pace'))) },
    archetype: arch[0][1] > 0.05 ? arch[0][0] : null, archetype_scores: Object.fromEntries(arch),
    style: { lean: AXES.filter((a) => w('ax_' + a.k) > 0.25).sort((x, y) => w('ax_' + y.k) - w('ax_' + x.k)).map((a) => tag(a.k)), avoid: AXES.filter((a) => w('ax_' + a.k) < -0.25).map((a) => tag(a.k)) },
    meta: Object.fromEntries(metaAxes(p).filter((m) => m.has).map((m) => [m.k, r3(m.v)])),
    format: { shorts: r3(sig(2 * w('vertical'))), talk_show: r3(sig(2 * w('talkshow'))), longer: r3(sig(2 * w('long'))), clean: r3(sig(2 * w('clean'))) },
    passport: p,
  }
}
