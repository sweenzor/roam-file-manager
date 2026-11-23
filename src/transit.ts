// Just enough Transit (JSON form) to talk to Roam's desktop app the way Roam's own page does: its
// messages to the app's main process are Transit-encoded Clojure data. Keywords and symbols are
// written as strings; maps come back as plain objects keyed by the keyword's text (":ns/name" ->
// "ns/name"). Pure, so it runs under node --test.

/** A keyword in what is sent: kw('roam.files/graph-files'). */
export const kw = (name: string) => `~:${name}`;
/** A symbol in what is sent. */
export const sym = (name: string) => `~$${name}`;
/** A map in what is sent, from keyword names to values. */
export const map = (o: Record<string, unknown>): unknown[] => ['^ ', ...Object.entries(o).flatMap(([k, v]) => [kw(k), v])];
/** A list in what is sent, e.g. a mutation call (sym params). */
export const list = (...items: unknown[]): unknown[] => ['~#list', items];

const CACHE_CODE_DIGITS = 44, BASE = 48;
const cacheIndex = (s: string) => (s.length === 2 ? s.charCodeAt(1) - BASE : (s.charCodeAt(1) - BASE) * CACHE_CODE_DIGITS + (s.charCodeAt(2) - BASE));

/** Reads Transit JSON. Keywords and symbols become their names, maps plain objects (keys as names), lists and sets arrays. */
export function read(text: string): any {
  const cache: string[] = [];
  const str = (s: string, asKey: boolean): string => {
    if (s.length > 1 && s[0] === '^' && s !== '^ ') return cache[cacheIndex(s)];
    if (s.length > 3 && (asKey || s.startsWith('~:') || s.startsWith('~$') || s.startsWith('~#'))) {
      if (cache.length === CACHE_CODE_DIGITS * CACHE_CODE_DIGITS) cache.length = 0;
      cache.push(s);
    }
    return s;
  };
  const scalar = (s: string): any => {
    if (s[0] !== '~') return s;
    const tag = s[1], rest = s.slice(2);
    switch (tag) {
      case '~': case '^': case '`': return s.slice(1);
      case ':': case '$': return rest;
      case 'i': case 'n': return Number(rest);
      case 'd': return Number(rest);
      case 'm': return Number(rest);
      case 't': return Date.parse(rest);
      case '_': return null;
      case '?': return rest === 't';
      default: return rest;
    }
  };
  const val = (v: any, asKey = false): any => {
    if (typeof v === 'string') return scalar(str(v, asKey));
    if (!Array.isArray(v)) {
      if (v && typeof v === 'object') { const o: any = {}; for (const [k, x] of Object.entries(v)) o[scalar(str(k, true))] = val(x); return o; }
      return v;
    }
    if (v[0] === '^ ') {
      const o: any = {};
      for (let i = 1; i < v.length; i += 2) o[String(val(v[i], true))] = val(v[i + 1]);
      return o;
    }
    if (v.length === 2 && typeof v[0] === 'string') {
      const tag = str(v[0], false);
      if (tag.startsWith('~#')) {
        const t = tag.slice(2), x = val(v[1]);
        if (t === 'cmap') { const o: any = {}; for (let i = 0; i < x.length; i += 2) o[String(x[i])] = x[i + 1]; return o; }
        return x; // list, set, and anything else: its value
      }
      return [scalar(tag), val(v[1])];
    }
    return v.map((x) => val(x));
  };
  return val(JSON.parse(text));
}
