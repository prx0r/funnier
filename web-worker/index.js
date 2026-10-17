// Serves www.funnier.si from GitHub Pages (prx0r.github.io/characters). Apex redirects to www.
// /c/<id>: a character's page (same shell). /u/<username>/humour.json: the public Humour Passport.
// /u/<username>: the app shell (index.html with <base href="/">, so its relative assets load) plus per-profile link-preview
// tags; the app turns the path into its #u/<username> route. /u/<username>/og.png: the owner's card from the API
// (api.funnier.si/og/u/<name>.png), falling back to the site card when there is none or the profile isn't public.
import { skinnable, skinResponse } from './funnier-skin.js';
const ORIGIN = 'https://prx0r.github.io/characters';
const API = 'https://api.funnier.si';
const USER = /^\/u\/([A-Za-z0-9_]{3,20})\/?$/, OG = /^\/u\/([A-Za-z0-9_]{3,20})\/og\.png$/;
const HUMOUR = /^\/u\/([A-Za-z0-9_]{3,20})\/humour\.json$/, CHAR = /^\/c\/(c[a-z0-9]{8,16})\/?$/;
// Freak Town party game on party.funnier.si: /party (-> /play), /party/*, /play, /join/* are proxied whole (method, body,
// headers, streaming body for the SSE /party/<code>/stream), never cached. GET text/html responses get the Funnier skin
// (funnier-skin.js, a port of the box's funnier_skin.py; ?skin=0 turns it off); everything else streams through untouched.
// /icon-512.png, /icon-192.png: the box's icons (the /perform pages and party pages reference them; GitHub Pages has none).
const PARTY = 'https://party.funnier.si', PARTY_PATH = /^\/(party(\/.*)?|play\/?|join\/.*)$/, BOX_ASSET = /^\/icon-(512|192)\.png$/;
async function party(req, url) {
  const path = url.pathname === '/party' || url.pathname === '/party/' ? '/play' : url.pathname;
  const h = new Headers(req.headers); h.delete('host');
  const init = { method: req.method, headers: h, redirect: 'manual', cache: 'no-store' };
  if (req.method !== 'GET' && req.method !== 'HEAD') init.body = req.body;
  let res;
  try { res = await fetch(PARTY + path + url.search, init); } catch { return new Response('Freak Town is offline', { status: 502 }); }
  const out = new Headers(res.headers);
  const loc = out.get('Location'); if (loc) out.set('Location', loc.replace(/^https?:\/\/party\.funnier\.si/, 'https://www.funnier.si'));
  // live room state (/view, /stream?once=1, JSON) must never be browser-cached: the zone's 4h browser TTL froze polling
  if (!/^image\//.test(out.get('content-type') || '') || req.method !== 'GET') out.set('cache-control', 'no-store');
  if (skinnable(req, res, url.pathname) && url.searchParams.get('skin') !== '0') return skinResponse(new Response(res.body, { status: res.status, headers: out }), url.pathname, boxHotfix);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
}
// Box bug (party.py stage template, also on freaktown main): the deck buttons' JS string has unescaped double quotes
// (`onclick="hostCmd('start','quip-"+d+"')"` – the Python `\"` collapses), a SyntaxError that kills the whole stage
// script (no polling, no host buttons). Re-escape it here until the box ships the fix.
const boxHotfix = (html) => html.split(`onclick="hostCmd('start','quip-"+d+"')">"`).join(`onclick=\\"hostCmd('start','quip-"+d+"')\\">"`);
async function boxAsset(req, path) {
  try {
    const r = await fetch(PARTY + path, { cf: { cacheTtl: 86400, cacheEverything: true } });
    const h = new Headers(r.headers); h.set('cache-control', r.ok ? 'public, max-age=86400' : 'no-store');
    return new Response(r.body, { status: r.status, headers: h });
  } catch { return new Response('', { status: 502 }); }
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const up = (path, req) => fetch(ORIGIN + path, { headers: { 'User-Agent': req.headers.get('User-Agent') || 'funnier-web' }, redirect: 'manual', cf: { cacheTtl: 60 } });

async function profileShell(req, name) {
  const res = await up('/', req);
  if (!res.ok) return res;
  let html = await res.text();
  let line = 'Their humour chart, Four Favourites and specials diary on Funnier.', status = 200;
  try { // the public chart line, when the profile is public (short timeout: previews must not hang)
    const r = await fetch(`${API}/u/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(1500) });
    if (r.status === 404) status = 404; // unknown name: the shell still renders the app's empty state, but as a real 404 (not indexed)
    if (r.ok) { const j = await r.json(); if (j?.chart?.line) line = j.chart.line.replace(/^You like /, `${j.user?.username || name} likes `); if (j?.user?.username) name = j.user.username; }
  } catch {}
  const url = `https://www.funnier.si/u/${name}`, img = `${url}/og.png`, title = `${name}'s sense of humour · Funnier`;
  const meta = `<base href="/"><link rel="canonical" href="${esc(url)}"><meta property="og:type" content="profile"><meta property="og:site_name" content="Funnier">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(line)}"><meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${esc(img)}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(line)}"><meta name="twitter:image" content="${esc(img)}">`;
  html = html.replace(/<meta (property="og:[^"]*"|name="twitter:[^"]*")[^>]*>/g, '') // the site-wide preview tags give way to the profile's
  html = html.replace('<head>', '<head>' + meta).replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`);
  if (status === 404) html = html.replace('<head>', '<head><meta name="robots" content="noindex">');
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=60' } });
}
// /c/<id>: the app shell (the app turns the path into #c/<id>) with the character's name in the preview tags when public
async function charShell(req, id) {
  const res = await up('/', req);
  if (!res.ok) return res;
  let html = await res.text(), title = 'A Funnier character', desc = 'A comic with its own trained sense of humour, on Funnier.';
  try { const r = await fetch(`${API}/c/${id}`, { signal: AbortSignal.timeout(1500) }); if (r.ok) { const j = await r.json(); if (j?.character?.name) { title = `${j.character.name} · Funnier character`; desc = (j.character.bio || desc) + (j.character.passport?.type?.full ? ` (${j.character.passport.type.full})` : ''); } } } catch {}
  const url = `https://www.funnier.si/c/${id}`;
  const meta = `<base href="/"><link rel="canonical" href="${esc(url)}"><meta property="og:type" content="profile"><meta property="og:site_name" content="Funnier"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${esc(url)}"><meta name="twitter:card" content="summary">`;
  html = html.replace(/<meta (property="og:[^"]*"|name="twitter:[^"]*")[^>]*>/g, '').replace('<head>', '<head>' + meta).replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`);
  return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=60' } });
}
// /u/<name>/humour.json: the public Humour Passport, proxied from the API (any origin)
async function humourJSON(name) {
  try {
    const r = await fetch(`${API}/u/${encodeURIComponent(name)}/humour.json`, { signal: AbortSignal.timeout(3000) });
    return new Response(r.body, { status: r.status, headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=60' } });
  } catch { return new Response('{"error":"unavailable"}', { status: 503, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } }); }
}
async function ogImage(req, name) {
  try {
    const r = await fetch(`${API}/og/u/${encodeURIComponent(name)}.png`, { signal: AbortSignal.timeout(3000) });
    if (r.ok) return new Response(r.body, { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=600' } });
  } catch {}
  const d = await up('/img/og-default.png', req);
  return new Response(d.body, { status: d.ok ? 200 : 404, headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=600' } });
}

export default {
  async fetch(req) {
    const url = new URL(req.url);
    if (url.hostname === 'funnier.si') { url.hostname = 'www.funnier.si'; return Response.redirect(url.toString(), 301); }
    let path = url.pathname, m;
    if (PARTY_PATH.test(path)) return party(req, url);
    if (BOX_ASSET.test(path)) return boxAsset(req, path);
    if ((m = path.match(OG))) return ogImage(req, m[1]);
    if ((m = path.match(HUMOUR))) return humourJSON(m[1]);
    if ((m = path.match(CHAR))) return charShell(req, m[1]);
    if ((m = path.match(USER))) return profileShell(req, m[1]);
    let res = await up(path + url.search, req);
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('Location') || '';
      const fixed = loc.replace(/^https?:\/\/prx0r\.github\.io\/characters/, 'https://www.funnier.si');
      return Response.redirect(fixed.startsWith('/characters') ? 'https://www.funnier.si' + fixed.slice(11) : fixed, res.status);
    }
    const h = new Headers(res.headers);
    h.delete('x-github-request-id');
    return new Response(res.body, { status: res.status, headers: h });
  }
};
