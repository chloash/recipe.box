// Reads a recipe web page and returns its details (most recipe sites publish schema.org "Recipe" data).
// Also proxies the recipe's photo so the app can save it (mode=img).

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', frac12: '½', frac14: '¼', frac34: '¾', deg: '°', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…' };
const clean = s => String(s ?? '')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&([a-z]+\d*);/gi, (m, n) => ENT[n.toLowerCase()] ?? m)
  .replace(/\s+/g, ' ').trim();

const isType = (o, t) => o && typeof o === 'object' && [].concat(o['@type'] || []).some(x => String(x).toLowerCase() === t);

function findRecipe(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return null;
  if (Array.isArray(node)) { for (const n of node) { const r = findRecipe(n, depth + 1); if (r) return r; } return null; }
  if (isType(node, 'recipe')) return node;
  for (const k of ['@graph', 'mainEntity', 'mainEntityOfPage', 'itemListElement', 'item']) {
    const r = findRecipe(node[k], depth + 1); if (r) return r;
  }
  return null;
}

function steps(ins) {
  if (!ins) return [];
  if (typeof ins === 'string') return clean(ins.replace(/<\/(p|li)>|<br\s*\/?>/gi, '\n')).split(/\n|(?<=\.)\s{2,}/).map(s => s.trim()).filter(Boolean);
  if (Array.isArray(ins)) return ins.flatMap(steps);
  if (typeof ins === 'object') {
    if (ins.itemListElement) return steps(ins.itemListElement);
    return [clean(ins.text || ins.name || '')].filter(Boolean);
  }
  return [];
}

function minutes(iso) {
  const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/i.exec(String(iso || ''));
  if (!m) return '';
  const t = (+(m[1] || 0)) * 1440 + (+(m[2] || 0)) * 60 + (+(m[3] || 0));
  return t ? String(t) : '';
}

function imageOf(img) {
  if (!img) return '';
  if (typeof img === 'string') return img;
  if (Array.isArray(img)) return imageOf(img[img.length > 1 && typeof img[0] === 'string' ? img.length - 1 : 0]);
  return img.url || img.contentUrl || '';
}

const meta = (html, prop) => {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*>`, 'i');
  const tag = re.exec(html)?.[0]; if (!tag) return '';
  return clean(/content=["']([^"']*)["']/i.exec(tag)?.[1] || '');
};

function safeTarget(raw) {
  let u; try { u = new URL(raw); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1|\[?f[cd])/.test(h)) return null;
  return u;
}

export function parseRecipe(html, pageUrl) {
  let recipe = null;
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while (!recipe && (m = re.exec(html))) {
    try { recipe = findRecipe(JSON.parse(m[1].trim())); } catch { /* skip broken blocks */ }
  }
  const host = new URL(pageUrl).hostname.replace(/^www\./, '');
  const out = {
    title: clean(recipe?.name) || meta(html, 'og:title') || clean(/<title>([^<]*)/i.exec(html)?.[1] || ''),
    source: meta(html, 'og:site_name') || host,
    ingredients: [].concat(recipe?.recipeIngredient || recipe?.ingredients || []).map(clean).filter(Boolean),
    method: steps(recipe?.recipeInstructions),
    time: minutes(recipe?.totalTime) || (() => { const a = +minutes(recipe?.prepTime) || 0, b = +minutes(recipe?.cookTime) || 0; return a + b ? String(a + b) : ''; })(),
    serves: clean([].concat(recipe?.recipeYield || [])[0] || '').replace(/^serves\s*/i, ''),
    image: imageOf(recipe?.image) || meta(html, 'og:image')
  };
  if (out.image) { try { out.image = new URL(out.image, pageUrl).href; } catch { out.image = ''; } }
  return out;
}

export default async (req) => {
  const params = new URL(req.url).searchParams;
  const target = safeTarget(params.get('url') || '');
  if (!target) return json({ error: 'That link does not look right.' }, 400);
  let res;
  try {
    res = await fetch(target, { headers: { 'user-agent': UA, 'accept-language': 'en-GB,en;q=0.9', accept: params.get('mode') === 'img' ? 'image/*' : 'text/html,*/*' }, redirect: 'follow', signal: AbortSignal.timeout(9000) });
  } catch { return json({ error: 'Could not reach that site.' }, 502); }
  if (!res.ok) return json({ error: `That site said ${res.status}.` }, 502);

  if (params.get('mode') === 'img') {
    const type = res.headers.get('content-type') || '';
    if (!type.startsWith('image/')) return json({ error: 'Not an image.' }, 415);
    const buf = await res.arrayBuffer();
    if (buf.byteLength > 8 * 1024 * 1024) return json({ error: 'Image too large.' }, 413);
    return new Response(buf, { headers: { 'content-type': type, 'cache-control': 'no-store' } });
  }

  const html = (await res.text()).slice(0, 4_000_000);
  return json(parseRecipe(html, res.url || target.href));
};

export const config = { path: '/api/import' };
