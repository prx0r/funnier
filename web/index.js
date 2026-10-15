// Serves www.funnier.si from GitHub Pages (prx0r.github.io/characters). Apex redirects to www.
const ORIGIN = 'https://prx0r.github.io/characters';
export default {
  async fetch(req) {
    const url = new URL(req.url);
    if (url.hostname === 'funnier.si') { url.hostname = 'www.funnier.si'; return Response.redirect(url.toString(), 301); }
    let path = url.pathname;
    const upstream = ORIGIN + path + url.search;
    let res = await fetch(upstream, { headers: { 'User-Agent': req.headers.get('User-Agent') || 'funnier-web' }, redirect: 'manual', cf: { cacheTtl: 60 } });
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
