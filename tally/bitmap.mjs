// clip -> special -> bit time map (characters2 docs/FUNNIER-INTEGRATION.md §3c). Pure functions, no I/O.
// A clip matched to a characters2 special carries special_id (+ t_start when its title anchors it, see tools/import-theory.mjs).
// special time = clip.t_start + video time; pos = special time / special duration (site/theory.json specials[].durSec);
// the bits whose pos_in_special falls in that window are the ones that were on screen.
// Bits (with their text) live only in the characters2 clone and are read offline; the site never ships them.
export function posAt(clip, special, t) {
  if (!clip || clip.t_start == null || !special?.durSec) return null
  return Math.max(0, Math.min(1, (clip.t_start + Math.max(0, t)) / special.durSec))
}
export function bitAt(clip, special, bits, t) {
  const p = posAt(clip, special, t); if (p == null || !bits?.length) return null
  let best = null
  for (const b of bits) if (b.feat && b.feat.pos_in_special <= p + 1e-9 && (!best || b.feat.pos_in_special > best.feat.pos_in_special)) best = b
  return best || bits[0]
}
export function bitsInWindow(clip, special, bits, t0, t1) {
  const p0 = posAt(clip, special, Math.min(t0, t1)), p1 = posAt(clip, special, Math.max(t0, t1))
  if (p0 == null || !bits?.length) return []
  const inWin = bits.filter((b) => b.feat && b.feat.pos_in_special >= p0 && b.feat.pos_in_special <= p1)
  if (inWin.length) return inWin
  const b = bitAt(clip, special, bits, Math.max(t0, t1)) // a window shorter than one bit: the bit that was playing
  return b ? [b] : []
}
