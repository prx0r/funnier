// Funnier skin at the edge: a line-for-line JS port of funnier_skin.py's reskin() (freaktown repo root), so the
// Freak Town box's /perform*, /play, /party*, /join/* pages look like Funnier without a box deploy.
// Canonical copy: prx0r/freaktown edge/perform-worker/funnier-skin.js. Copied verbatim to
// prx0r/characters funnier/web-worker/funnier-skin.js (the funnier-web Worker's party proxy). Edit here, then copy.
//
// String transforms (not HTMLRewriter) on purpose: the palette swap has to reach colour strings inside <script> and
// <style> text and inline style attributes alike, and the rails/poster-grid regroupings are the same regexes as the
// Python, so the output is byte-identical to funnier_skin.reskin(). Only text/html GET responses are buffered;
// everything else (JSON, images, audio, SSE /party/<code>/stream, POSTs) is returned as the original streaming Response.
// Ids, classes, data-* attributes, handlers and scripts are never changed.
export const THEME_URL = 'https://www.funnier.si/theme.css';
const HOME_URL = 'https://www.funnier.si/';
export const SKIN_PATHS = /^\/(perform(\/|$)|play\/?$|party(\/|$)|join\/)/;

const PALETTE = {
  '#ff2fa8': '#e8102e', '#ffb7dc': '#ffd6dc', '#2a0a1e': '#2a0a10', '#7a2f5c': '#7a1020',
  '#00d4ff': '#f5c76b', '#8f8': '#5fd38d',
  '#0a0a0f': '#07070a', '#0c0c12': '#0e0e13', '#111116': '#131319', '#14141c': '#131319',
  '#1a1a2e': '#1a1a22', '#111': '#131319', '#282833': '#23232d', '#333': '#23232d',
  '#eee': '#f3f1ec', '#888': '#8d8b93', '#777': '#8d8b93', '#666': '#6f6d75', '#555': '#5d5b63',
};
const HEX = /#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![0-9a-fA-F])/g;
const FONT = /font-family:\s*monospace/gi;

const USER_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="9" r="4.2" fill="currentColor"/>' +
  '<path d="M3.8 21c.9-4.4 4.2-6.6 8.2-6.6s7.3 2.2 8.2 6.6" fill="currentColor"/></svg>';

// Same sheet as funnier_skin.SKIN_CSS (keep in sync).
export const SKIN_CSS = `
:root{--ft-font:var(--fn-sans,'Inter Tight',system-ui,sans-serif)}
html body{font-family:var(--ft-font)!important;background-color:var(--fn-bg,#07070a)!important;color:var(--fn-text,#f3f1ec)}
body{background-image:radial-gradient(1200px 500px at 50% -10%,rgba(232,16,46,.16),transparent 60%),radial-gradient(900px 400px at 50% 110%,rgba(245,199,107,.06),transparent 60%)!important;background-attachment:fixed!important}
body.ft-skin{padding-top:0!important}
body.ft-skin>:not(.fn-top):not(script):not(style):not([id=entrance]):not([id=crowdbar]):first-of-type{margin-top:0}
.ft-skin h1,.ft-skin h2:not(.fn-shelf){font-family:var(--fn-display,'Anton',Impact,sans-serif)!important;font-weight:400!important;letter-spacing:.01em!important;line-height:1}
.ft-skin h1{font-size:clamp(36px,6vw,64px)!important;margin:10px 0 8px!important}
.ft-skin #popcard h1{font-size:28px!important}
.ft-skin button,.ft-skin input,.ft-skin textarea,.ft-skin select{font-family:var(--ft-font)!important}
.ft-skin button{font-weight:600;transition:transform .15s,box-shadow .2s,border-color .2s,background .2s}
.ft-skin button:active{transform:scale(.97)}
.ft-skin button:hover{border-color:rgba(232,16,46,.7)!important}
.ft-skin input:not([type=range]):not([type=checkbox]):not([type=radio]),.ft-skin textarea,.ft-skin select{background:var(--fn-panel,#131319)!important;border:1px solid var(--fn-line,#23232d)!important;color:var(--fn-text,#f3f1ec)!important;border-radius:8px!important}
.ft-skin input:focus,.ft-skin textarea:focus,.ft-skin select:focus{outline:none!important;border-color:var(--fn-red,#e8102e)!important;box-shadow:0 0 0 3px rgba(232,16,46,.18)!important}
.ft-skin input[type=range]{accent-color:var(--fn-red,#e8102e)}
.ft-skin canvas{border-color:var(--fn-line,#23232d)!important;border-radius:14px!important}
.ft-skin a{color:var(--fn-text,#f3f1ec)}
/* header */
.ft-skin .fn-top.ft-top{text-align:left;margin:0 0 6px}
.ft-skin .fn-top.ft-top .fn-nav a{font-size:14px}
.ft-skin .fn-top.ft-top .fn-nav a.on{color:var(--fn-text)}
.ft-skin .top .logo{display:none}
.ft-skin .top{color:var(--fn-muted,#8d8b93)!important;font-family:var(--fn-mono,monospace)}
/* rails: /play mode cards */
body.ft-index{text-align:left!important;padding:0 0 48px!important}
body.ft-index>:not(.fn-top):not(script):not(style){max-width:1240px;margin-left:auto!important;margin-right:auto!important;padding-left:clamp(16px,4vw,48px);padding-right:clamp(16px,4vw,48px)}
body.ft-index>h1{margin-top:18px!important}
.ft-rails{margin-top:8px}
.ft-rails .fn-shelf{font-family:var(--fn-sans);font-size:20px;font-weight:700;margin:34px 0 14px}
.ft-rails .fn-shelf{display:flex;align-items:baseline;gap:10px}
.ft-rails .fn-shelf span{font-family:var(--fn-mono,monospace);font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--fn-muted,#8d8b93);font-weight:400}
.ft-rails .fn-rail{grid-auto-columns:minmax(240px,280px)}
.ft-mode.fn-card{margin:0!important;max-width:none!important;border:1px solid var(--fn-line,#23232d)!important;border-radius:14px!important;padding:0!important;overflow:hidden;display:flex;flex-direction:column;background:var(--fn-panel,#131319)}
.ft-mode .ft-poster{aspect-ratio:16/9;display:flex;align-items:flex-end;padding:14px 16px;background:linear-gradient(160deg,#2a0a10,#0b0b0e 72%);border-bottom:1px solid var(--fn-line,#23232d)}
.ft-mode .ft-poster b{font-family:var(--fn-display,'Anton',Impact,sans-serif);font-weight:400;font-size:30px;line-height:.95;letter-spacing:.01em;color:#fff}
.ft-mode.quip .ft-poster{background:linear-gradient(160deg,#2b1d06,#0b0b0e 72%)}
.ft-mode>div:not(.ft-poster){padding:12px 16px 0;font-size:14px!important}
.ft-mode p{margin:auto 0 0!important;padding:12px 16px 16px}
.ft-mode button{width:100%;background:var(--fn-red,#e8102e)!important;color:#fff!important;border:0!important;border-radius:8px!important;font-weight:700!important;font-size:14px!important;padding:10px 14px!important;box-shadow:0 12px 40px -14px var(--fn-red,#e8102e)}
.ft-mode button:hover{background:var(--fn-red2,#ff3d55)!important}
/* /perform bill: poster grid */
.ft-bill{display:grid!important;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:18px;margin-top:22px!important;text-align:left}
.ft-bill>a{display:flex!important;flex-direction:column;width:auto!important;margin:0!important;padding:0!important;overflow:hidden;border-radius:12px!important;border:1px solid var(--fn-line,#23232d)!important;background:var(--fn-panel,#131319);transition:transform .25s,border-color .25s,box-shadow .25s}
.ft-bill>a:hover{transform:translateY(-3px);border-color:rgba(232,16,46,.55)!important;box-shadow:0 24px 60px -24px rgba(232,16,46,.35)}
.ft-bill>a img{border-radius:0!important;aspect-ratio:1/1;object-fit:cover;background:linear-gradient(160deg,#2a0a10,#0b0b0e 70%)}
.ft-bill>a>div{padding:0 12px;margin:0!important}
.ft-bill>a>div:nth-of-type(1){font-size:15px!important;font-weight:700;padding-top:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ft-bill>a>div:nth-of-type(2){font-family:var(--fn-mono,monospace);font-size:12px!important;padding-bottom:12px}
.ft-bill>a:first-child{border-color:rgba(245,199,107,.5)!important}
.ft-bill>a:first-child::before{content:'HEADLINER';position:absolute;margin:10px;font-family:var(--fn-mono,monospace);font-size:10px;letter-spacing:.12em;padding:3px 7px;border-radius:4px;background:var(--fn-gold,#f5c76b);color:#0b0b0e}
.ft-bill>a{position:relative}
.ft-bill .ft-ph{display:grid;place-items:center;aspect-ratio:1/1;background:linear-gradient(160deg,#2a0a10,#0b0b0e 72%);font-family:var(--fn-display,'Anton',Impact,sans-serif);font-size:96px;line-height:1;color:rgba(243,241,236,.9);text-shadow:0 0 40px rgba(232,16,46,.45)}
.ft-bill>a:nth-child(3n+2) .ft-ph{background:linear-gradient(160deg,#2b1d06,#0b0b0e 72%)}
.ft-bill>a:nth-child(3n) .ft-ph{background:linear-gradient(160deg,#141a2a,#0b0b0e 72%)}
.ft-skin img[src$="/icon-512.png"]{filter:hue-rotate(28deg) saturate(1.15)}
.ft-skin .fn-top.ft-top{gap:10px;margin-left:calc(50% - 50vw)!important;margin-right:calc(50% - 50vw)!important}
.ft-skin a[href^="/party/lab/"]{display:inline-block;margin-top:4px;text-decoration:none;font-family:var(--fn-mono,monospace);font-size:11px;letter-spacing:.08em;text-transform:uppercase;border:1px solid var(--fn-line,#23232d);border-radius:999px;padding:7px 12px;color:var(--fn-text,#f3f1ec)!important;background:rgba(19,19,25,.85)}
.ft-skin a[href^="/party/lab/"]:hover{border-color:var(--fn-red,#e8102e)}
.ft-skin #code{font-family:var(--fn-display,'Anton',Impact,sans-serif)!important;font-size:64px!important;letter-spacing:.12em!important;color:var(--fn-text,#f3f1ec);text-shadow:0 0 40px rgba(232,16,46,.35)}
.ft-skin #host button,.ft-skin #decks button{background:var(--fn-panel2,#1a1a22);color:var(--fn-text,#f3f1ec);border:1px solid var(--fn-line,#23232d);border-radius:8px;padding:9px 14px;margin:3px;font-size:13px;letter-spacing:.02em;cursor:pointer}
.ft-skin #host>button[onclick*="'start'"]{background:var(--fn-red,#e8102e);border-color:var(--fn-red,#e8102e);color:#fff;box-shadow:0 12px 40px -14px var(--fn-red,#e8102e)}
.ft-skin #cv{max-width:100%;height:auto}
@media (max-width:600px){.ft-skin .fn-top.ft-top{padding:10px 12px}.ft-skin .fn-top.ft-top .fn-nav a{font-size:13px;padding:6px 7px}.ft-skin .fn-top.ft-top .fn-wordmark{font-size:17px;padding:5px 8px 4px}.ft-skin .fn-userbtn{width:32px;height:32px}}
@media (max-width:600px){.ft-bill{grid-template-columns:repeat(2,1fr);gap:12px}.ft-mode .ft-poster b{font-size:26px}}
`;

const palette = (html) => html.replace(HEX, (h) => PALETTE[h.toLowerCase()] || h).replace(FONT, 'font-family:var(--ft-font)');

function header(path) {
  const lab = path.startsWith('/party/lab');
  const on = (yes) => (yes ? ' class=on' : '');
  return `<header class='fn-top ft-top'><a class='fn-wordmark' href='${HOME_URL}' aria-label='Funnier home'>FUNNIER</a>` +
    `<nav class='fn-nav' aria-label='Freak Town'><a href='/perform'${on(path.startsWith('/perform'))}>Tonight&#39;s bill</a>` +
    `<a href='/party'${on(!lab && /^\/(play|party|join)/.test(path))}>Party games</a><a href='/party/lab'${on(lab)}>Tech lab</a></nav>` +
    `<a class='fn-userbtn' href='${HOME_URL}#you' aria-label='Your Funnier account'>${USER_SVG}</a></header>`;
}

const MODE_CARD = /<div style='border:1px solid #23232d;border-radius:12px;padding:16px;margin:10px auto;max-width:520px'><div style='font-size:18px'>(.*?)<\/div>([\s\S]*?<\/p><\/div>)/g;

function modeRails(html) {
  const cards = [...html.matchAll(MODE_CARD)];
  if (!cards.length) return html;
  const games = [], quips = [];
  for (const m of cards) {
    const quip = m[0].includes("data-mode='quip-");
    (quip ? quips : games).push(`<div class='ft-mode fn-card${quip ? ' quip' : ''}'><div class='ft-poster'><b>${m[1]}</b></div>${m[2]}`);
  }
  let rails = "<section class='ft-rails'>";
  if (games.length) rails += `<h2 class='fn-shelf'>Party games <span>${games.length} modes</span></h2><div class='fn-rail'>${games.join('')}</div>`;
  if (quips.length) rails += `<h2 class='fn-shelf'>Quip Clash <span>${quips.length} decks</span></h2><div class='fn-rail'>${quips.join('')}</div>`;
  rails += '</section>';
  const last = cards[cards.length - 1];
  return html.slice(0, cards[0].index) + rails + html.slice(last.index + last[0].length);
}

export const CARD = /<a\b[^>]*href=(["']?)\/(?:perform|f|w)\/([^"'?#/\s>]+)\1[^>]*>[\s\S]*?<\/a>/gi;

function poster(card) { // a bill card without a portrait gets a Funnier monogram poster instead of the pink icon
  const name = card.match(/<\/?(?:img|span)[^>]*>\s*<div[^>]*>([^<]*)<\/div>/);
  const initial = (name ? Array.from(name[1].trim())[0] : '') || '?';
  return card.replace(/<img\b[^>]*src=["']\/icon-512\.png["'][^>]*>/, () => `<span class='ft-ph' aria-hidden='true'>${initial}</span>`);
}

const billGrid = (html) => html.replace(CARD, poster).replace(/<div>(?=<a\b[^>]*href=["']?\/perform\/)/, "<div class='ft-bill'>");

function bodyOpen(attrs, index) {
  const cls = 'ft-skin fn' + (index ? ' ft-index' : '');
  if (/class=/.test(attrs)) return '<body' + attrs.replace(/class=(["'])/, (_, q) => `class=${q}${cls} `) + '>';
  return `<body class='${cls}'${attrs}>`;
}

/** funnier_skin.reskin(html, path): `path` is the public path (www.funnier.si), e.g. /party, /perform/<slug>. */
export function reskin(html, path) {
  html = palette(html);
  const head = `<link rel='stylesheet' href='${THEME_URL}'><style id='funnier-skin'>${SKIN_CSS}</style><meta name='theme-color' content='#07070a'>`;
  html = html.replace(/<meta name="theme-color"[^>]*>/g, '');
  html = html.replace(/<\/head>/i, () => head + '</head>');
  html = html.replace(/<title>([^<]*)Freak Town( Party)?/, (_, a, b) => `<title>${a}Freak Town${b || ''} · Funnier`);
  const p = path.replace(/\/+$/, '');
  const index = ['/play', '/party', '/perform'].includes(p);
  html = html.replace(/<body([^>]*)>/i, (_, attrs) => bodyOpen(attrs, index) + header(path));
  if (p === '/play' || p === '/party') html = modeRails(html);
  if (p === '/perform') html = billGrid(html);
  return html;
}

/** Should this response be skinned? text/html, GET, a skinned path, not a 5xx, not already streamed (SSE). */
export function skinnable(req, res, path) {
  if (req.method !== 'GET' || res.status >= 500 || !SKIN_PATHS.test(path)) return false;
  const ct = res.headers.get('content-type') || '';
  return ct.includes('text/html') && !ct.includes('event-stream');
}

/** Reskin an upstream HTML Response (optionally running `filter` on the HTML first). Returns a new Response. */
export async function skinResponse(res, path, filter) {
  let html = await res.text();
  if (filter) html = filter(html);
  // the box skins its own pages once it runs funnier_skin.py: then pass them through as they are (no double header)
  const already = html.includes("<style id='funnier-skin'>");
  if (!already && html.toLowerCase().includes('<body')) html = reskin(html, path);
  const h = new Headers(res.headers);
  for (const k of ['content-length', 'content-encoding', 'etag', 'last-modified']) h.delete(k);
  h.set('content-type', 'text/html; charset=utf-8');
  h.set('cache-control', 'no-store');
  h.set('x-funnier-skin', already ? 'box' : 'edge');
  return new Response(html, { status: res.status, statusText: res.statusText, headers: h });
}
