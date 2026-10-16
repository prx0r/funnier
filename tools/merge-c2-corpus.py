# One-off import of characters2 corpus/clips.json into clips.json (2026-10-16, characters2@953dddc). Needs /tmp/merge2/check.json from an oEmbed pass; kept for audit.
import json, re, collections
F = '/tmp/chars-corpus/funnier/'
W = '/workspace/projects/f9a7b7ba-e7fb-456e-891e-78ec1c0ab3dc/work/'
C2C = '/workspace/projects/f9a7b7ba-e7fb-456e-891e-78ec1c0ab3dc/characters2/corpus/clips.json'
clips = json.load(open(F + 'clips.json'))
have = {c['id'] for c in clips}
corpus = json.load(open(C2C))
chk = json.load(open('/tmp/merge2/check.json'))
COMICS = json.load(open(F + 'site/comics.json'))['comics']

# ---- editorial drops (non-standup), reviewed by title ----
D = {
 'interview/podcast': 'TMFQA8cKl9o WGT8LwVGtNA ZttpymC3Ado cM5z03cCGvQ 7to2FMP7-Dg lRO8U3Efxn8 0lU9I005nEk pbF_C-i-0Lk CYPu160SBc8 tqxzFJXqTD0 _yjB6c16gyw SS362IR-fIo 9jJImPosW9o euCLDBMMQPE ySJu91nJOMA QPHpCOl0UtI 8ThIoSh6Sdg sJ189M8qEDw ANQmZdfDawI Zki9FzjqMYc Mmoc9knfudY',
 'panel (Talking Funny), not a set': 'lRc5kH8ahLw _3CW35YPvSo LX7Aji8kcm4',
 'news segment / coverage': '1vQtNxCtUds Xn3p286RNK8 _qV8zMsla4w Bq3hJtYCNbw gp01qiBKE2c ql54DPd44TQ y_vDkB_Q_yI 1ojTfSn6cAY Qx-f3gl6WPE S_3Zm5n6XoQ 3ItDlIvSJzk 2boX_JVGwaU y_LfaHshORU gsC4ALN4hrE GJl04uKjQOo c5hJsbremcU Bp3DQNNK1ow c0ZM5KCqddg X-iG4CNA5Iw BxDqQaAMQ4Y iipEcv1JuAo yT4ZIy8TjA0',
 'commentary / reaction / review': 'o-RywcrhpKg 5s1H-DhGnak Qqogdy436ig R1oIH3DlUfE xxCe39jVEtQ tyY2upwoU6Q Cq2bAdwteyY bFtEHZUqoOY UtYWf3ga1k4 A9pLzz_cQNI vVuc9xHJ_4Q NL2Tz0FBaZE QYKJe4ecXW4 tfk16g5ux44 _ojqKstN884 Nv31jD-XA0k',
 'Oscars slap incident, not a set': 'Z8LtP1GsoeA hlXlMQc_22o QY34dpW7KMg',
 'trailer / tour promo / theme / remix / music': 'ttPhRKh-PRs F982evQdPYg x8eS_3Y17pE FPs4HKPb4JU SBybGMhB0jo hMVbnRRAvRM j9yBPcn8IqU',
 'sitcom scene (Seinfeld/Curb), not stand-up': 'QRh1CMC3OVw ICwf98n2CiY qvSOgB-JPy0 B9W4p51F_88 bDABzGe94GU oHRucRyLCms iFTnSJCqBpE JcQsXGXAv9s 4Jw6mKmozjM',
 'acceptance speech, not a set': 'c0gSpEfMNIc',
 'someone else telling a story about the comic': 'dfWcT9-_S6U',
}
WHY = {i: w for w, ids in D.items() for i in ids.split()}
TALK = set('YVysr9LIzPk -LlydlYTcsI grm3YUKmmhs KcC0FJQSMsI MEYbL1-62Zk OtpJzZJ-BNM Pt9F1ADNfsg ywica8-Z7kc p21sXizj4u0 PdFB7q89_3U 6Amxd6UVWQI Fv67QgVSqkk'.split())
AWARDS = set('caObUaz7oOc 8ljkuu02bRQ v_fX7IE6vYc SzpVE5ixAG8 qApUEH0oe_U R37zkizucPU sePS8-J0zaM'.split())

LIC = re.compile(r'^(netflix|netflix is a joke|comedy central|comedy central stand-up|just for laughs|jfl|hbo|team coco|the tonight show.*|late show.*|the late show.*|late night.*|jimmy kimmel live|the late late show.*|letterman|saturday night live|snl|kill tony)$', re.I)
def carrier(c):
    ch = (c.get('channel') or '').strip()
    own = c['comic']
    if ch.lower() in {own.lower(), own.lower().replace('.', ''), own.lower() + ' - topic'} or (c['comic'] == 'Mark Normand' and ch.lower() == 'mark normand'):
        return 'own'
    if LIC.match(ch): return 'licensed'
    return 'unofficial'
RANK = {'own': 0, 'licensed': 1, 'unofficial': 2}

# special_ref from special_id: our comics.json special whose title tokens all appear in the characters2 slug
def nrm(s): return re.sub(r'[^a-z0-9]+', ' ', s.lower().replace("'", '').replace('&', ' ')).split()
def sref_of(comic, sid):
    if not sid: return None
    sl = set(nrm(sid)); best = None
    for s in COMICS.get(comic, {}).get('specials', []):
        t = [w for w in nrm(s['title']) if w not in set(nrm(comic)) and w not in {'the', 'a', 'and', 'to', 'at', 'for', 'live'}]
        if t and not all(w.isdigit() for w in t) and all(w in sl for w in t) and (not best or len(t) > best[1]): best = (s['id'], len(t))
    return best[0] if best else None

dropped, new, exact = [], [], 0
for x in corpus:
    if x['id'] in have: exact += 1; continue
    if x['id'] in WHY: dropped.append({'id': x['id'], 'comic': x['comic'], 'title': x['title'], 'channel': x['channel'], 'why': WHY[x['id']], 'batch': 'characters2@953dddc'}); continue
    k = chk[x['id']]
    assert k['ok']
    sec = int(x['sec']); t = x['title']
    c = {'id': x['id'], 'comic': x['comic'], 'title': t, 'channel': x['channel'].strip(), 'kind': 'human', 'media': 'youtube',
         'sec': sec, 'dur': sec, 'checked': '2026-10-16', 'style': [], 'topics': [],
         'tagsSource': 'draft-auto', 'draftTags': x.get('topics') or [],
         'special_id': x.get('special_id'), 'special_ref': sref_of(x['comic'], x.get('special_id')),
         'setting': 'talk-show' if x['id'] in TALK else 'awards-show' if x['id'] in AWARDS else 'stand-up',
         'format': 'vertical' if k['vertical'] else 'horizontal'}
    if x.get('year'): c['year'] = int(x['year'])
    if x.get('transcript_offset'): c['transcript_offset'] = x['transcript_offset']
    if sec > 180: c['needsCut'] = True
    new.append(c)

allc = clips + new
for c in allc: c['carrier'] = carrier(c)

# ---- dedup ----
def better(a, b):  # True if a should be kept over b
    return (RANK[a['carrier']], -(a.get('sec') or 0)) < (RANK[b['carrier']], -(b.get('sec') or 0))
STOPW = {'full', 'hd', 'standup', 'stand', 'up', 'comedy', 'special', 'the', 'clip', 'netflix', 'official', 'shorts'}
def ntitle(c):
    t = c['title'].lower()
    for w in nrm(c['comic']) + ['louis ck', 'louis c k', 'norm mac donald', 'seinfeld']: t = t.replace(w, ' ')
    t = re.sub(r'#\w+', ' ', t); t = re.sub(r'\b(19|20)\d\d\b', ' ', t)
    return ''.join(w for w in re.sub(r'[^a-z0-9]+', ' ', t).split() if w not in STOPW and w != 'and')
dup_of = {}
def root(i):
    while i in dup_of: i = dup_of[i]
    return i
newids = {c['id'] for c in new}
byid = {c['id']: c for c in allc}
def mark(a, b, why):
    ra, rb = root(a['id']), root(b['id'])
    if ra == rb: return
    A, B = byid[ra], byid[rb]
    if ra not in newids and rb not in newids: return  # never dedupe two pre-existing clips here
    keep, drop = (A, B) if better(A, B) else (B, A)
    if drop['id'] not in newids: keep, drop = drop, keep  # an already-live clip (votes, dailies) always stays
    dup_of[drop['id']] = keep['id']; drop['_dupwhy'] = why
L = [c for c in allc if c.get('special_id') and c.get('transcript_offset')]
for i, a in enumerate(L):
    for b in L[i + 1:]:
        if a['special_id'] == b['special_id'] and abs(a['transcript_offset']['frac_through'] - b['transcript_offset']['frac_through']) <= 0.03:
            mark(a, b, 'same special_id, transcript_offset frac_through within 0.03')
for i, a in enumerate(allc):
    na = ntitle(a)
    if not na or not a.get('sec'): continue
    for b in allc[i + 1:]:
        if a['comic'] == b['comic'] and b.get('sec') and abs(a['sec'] - b['sec']) <= 5 and ntitle(b) == na:
            mark(a, b, 'normalised title + duration within 5s')
dupes = []
for c in allc:
    if c['id'] in dup_of:
        c['dup_of'] = root(c['id']); c['active'] = False; c['dup_reason'] = c.pop('_dupwhy'); dupes.append(c)
active = [c for c in allc if c['id'] not in dup_of]
assert all(c['id'] in newids for c in dupes), [c['id'] for c in dupes if c['id'] not in newids]

s = json.dumps(active, indent=1, ensure_ascii=False) + '\n'
open(F + 'clips.json', 'w').write(s); open(F + 'site/clips.json', 'w').write(s)
json.dump({'_note': 'Clips found to duplicate an active clip (same special bit by transcript offset, or same normalised title and duration). Excluded from clips.json so they never enter pairing; kept here with dup_of for audit.', 'dupes': dupes}, open(F + 'tools/dupes.json', 'w'), indent=1, ensure_ascii=False)
prev = json.load(open(W + 'c2-corpus-dropped.json'))
prev = [p for p in prev if p.get('batch') != 'characters2@953dddc'] + dropped
json.dump(prev, open(W + 'c2-corpus-dropped.json', 'w'), indent=1, ensure_ascii=False)
print('corpus', len(corpus), 'exact-id dup', exact, 'editorial drop', len(dropped), 'new', len(new), 'dupes', len(dupes), 'active total', len(active))
print(collections.Counter(d['why'] for d in dropped))
for d in dupes: print('DUPE', d['id'], d['carrier'], d['sec'], d['title'][:60], '->', d['dup_of'], byid[d['dup_of']]['carrier'], byid[d['dup_of']].get('sec'), byid[d['dup_of']]['title'][:50], '|', d['dup_reason'][:20])
print(collections.Counter(c['comic'] for c in active))
print(collections.Counter((c['comic'], c['format']) for c in active))
print(collections.Counter(c['carrier'] for c in active), collections.Counter(c['setting'] for c in new))
print('special_ref new', collections.Counter((c['special_id'], c['special_ref']) for c in new if c['special_id']))
