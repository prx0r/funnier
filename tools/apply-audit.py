#!/usr/bin/env python3
"""Apply tools/standup-audit.json to clips.json (idempotent; safe to re-run on top of other agents' edits).

usage (from funnier/): python3 tools/apply-audit.py [clips.json] [--checked YYYY-MM-DD]
- removed ids  -> dropped from clips.json, recorded in tools/removed-nonstandup.json (shared with talkshow-lane.mjs;
                  discovery treats those ids as known so they are never re-added)
- dupes        -> dropped, archived in tools/dupes.json (dup_of, dup_reason, active:false)
- chat ids     -> setting = "chat" (couch chat / podcast / TV interview; feeds exclude it)
- added rows   -> appended when the id is not already present (and not removed/duped)
"""
import json, os, sys

def dump_clips(clips, path):
    """clips.json layout: indent=1 like the rest of the repo, but each clip's tags object on a single line."""
    out = []
    for c in clips:
        cc = dict(c)
        t = cc.get('tags')
        if t is not None: cc['tags'] = '\u0000TAGS\u0000'
        s = json.dumps(cc, indent=1, ensure_ascii=False)
        if t is not None: s = s.replace(json.dumps('\u0000TAGS\u0000'), json.dumps(t, ensure_ascii=False, separators=(',', ':')))
        out.append('\n'.join(' ' + l for l in s.split('\n')))
    open(path, 'w').write('[\n' + ',\n'.join(out) + '\n]\n')

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
args = sys.argv[1:]
checked = args[args.index('--checked') + 1] if '--checked' in args else None
path = next((a for a in args if a.endswith('.json')), os.path.join(ROOT, 'clips.json'))
A = json.load(open(os.path.join(HERE, 'standup-audit.json')))
clips = json.load(open(path))
rp = os.path.join(HERE, 'removed-nonstandup.json'); dp = os.path.join(HERE, 'dupes.json')
R = json.load(open(rp)) if os.path.exists(rp) else {'note': '', 'removed': []}
Dd = json.load(open(dp)) if os.path.exists(dp) else {'_note': '', 'dupes': []}
have_r = {r['id'] for r in R['removed']}; have_d = {r['id'] for r in Dd['dupes']}
keep, nrm, ndup, nchat = [], 0, 0, 0
for c in clips:
    i = c['id']
    if i in A['removed']:
        if i not in have_r:
            R['removed'].append({'id': i, 'comic': c['comic'], 'title': c['title'], 'channel': c['channel'], 'why': A['removed'][i],
                                 'at': '2026-10-18', 'by': 'standup-audit:' + (A['source'].get(i) or 'rule')}); have_r.add(i)
        nrm += 1; continue
    if i in A['dupes']:
        if i not in have_d:
            r = dict(c); r['dup_of'] = A['dupes'][i]; r['active'] = False; r['dup_reason'] = A['dupe_reason'].get(i, 'same bit')
            Dd['dupes'].append(r); have_d.add(i)
        ndup += 1; continue
    if i in A['chat'] and c.get('setting') != 'chat':
        c['setting'] = 'chat'; nchat += 1
    if checked: c['checked'] = checked
    keep.append(c)
ids = {c['id'] for c in keep} | set(A['removed']) | set(A['dupes'])
nadd = 0
for r in A['added']:
    if r['id'] not in ids:
        keep.append(dict(r)); ids.add(r['id']); nadd += 1
dump_clips(keep, path)
json.dump(R, open(rp, 'w'), indent=1, ensure_ascii=False); open(rp, 'a').write('\n')
json.dump(Dd, open(dp, 'w'), indent=1, ensure_ascii=False)
print(f'removed {nrm}, dupes {ndup}, chat +{nchat}, added {nadd} -> {len(keep)} clips')
