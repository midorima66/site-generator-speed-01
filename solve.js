// A fast drop-in for makefun-site 1.0.0: run(input) returns exactly the reference build's output tree for every
// input, computed with a fused single-pass Markdown renderer (range-based inline parsing, no substring copies),
// an ASCII fast path for slugs, per-build slug/word-count caches and an array-buffer template renderer.
//
// The semantics of every rule (front matter, permalinks, Markdown dialect, template dialect, report) are the
// reference's own, reimplemented for speed; where a fast path cannot decide, the code falls back to the exact
// reference algorithm.

const hasOwn = Object.hasOwn;

// ---------------------------------------------------------------- text

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** `text` with & < > " and ' escaped (fast path: returned as-is when it holds none of them). */
function escapeHtml(text) {
  let i = -1;
  for (let k = 0; k < text.length; k++) {
    const c = text.charCodeAt(k);
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) { i = k; break; }
  }
  if (i === -1) return text;
  let out = text.slice(0, i);
  let last = i;
  for (let k = i; k < text.length; k++) {
    const c = text.charCodeAt(k);
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) {
      out += text.slice(last, k) + ESC[text[k]];
      last = k + 1;
    }
  }
  return last === 0 ? out : out + text.slice(last);
}

const SLUG_MAX = 64;

/** The reference slug rule, verbatim (the fallback for non-ASCII text). */
function slugifyRef(text) {
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/**
 * The slug of `text`. Pure-ASCII text takes a fast path: NFKD is the identity on ASCII and ASCII holds no
 * combining marks, so the reference loop reduces to this scan. Anything else uses the reference algorithm.
 */
function slugify(text) {
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  if (!ascii) return slugifyRef(text);
  let out = '';
  let gap = false;
  for (let i = 0; i < text.length; i++) {
    let c = text.charCodeAt(i);
    if (c >= 65 && c <= 90) c += 32;
    if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) {
      if (gap) out += '-';
      gap = false;
      out += String.fromCharCode(c);
    } else {
      gap = out.length > 0;
    }
  }
  if (out.length > SLUG_MAX) {
    out = out.slice(0, SLUG_MAX);
    if (out.charCodeAt(SLUG_MAX - 1) === 45) out = out.slice(0, SLUG_MAX - 1);
  }
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused (the reference's rules, verbatim). */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE_RE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG_RE.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error }. Scans line starts to find the closing "---"
 * (the reference looks for it before it validates any line, so "not closed" outranks every line error), then
 * validates only the front-matter region's lines; the body is a slice, never a split-and-join.
 */
function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  const firstLine = firstNl === -1 ? text : text.slice(0, firstNl);
  if (firstLine !== '---') return { error: 'no front matter' };
  if (firstNl === -1) return { error: 'the front matter is not closed' };
  let closeStart = -1;
  let bodyStart = -1;
  let pos = firstNl + 1;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    if (end - pos === 3 && text.charCodeAt(pos) === 45 && text.charCodeAt(pos + 1) === 45 && text.charCodeAt(pos + 2) === 45) {
      closeStart = pos;
      bodyStart = nl === -1 ? text.length : nl + 1;
      break;
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  let region = text.slice(firstNl + 1, closeStart);
  if (region.endsWith('\n')) region = region.slice(0, -1);
  const lines = region === '' ? [] : region.split('\n');
  const data = {};
  for (let j = 0; j < lines.length; j++) {
    const line = lines[j];
    let blank = true;
    for (let k = 0; k < line.length; k++) {
      const c = line.charCodeAt(k);
      if (c !== 32 && c !== 9) { blank = false; break; }
    }
    if (blank || line.charCodeAt(0) === 35) continue;
    // The "key: value" line shape: a key of a-z and _, a colon, then end-of-line or one space and the value.
    let k = 0;
    while (k < line.length) {
      const c = line.charCodeAt(k);
      if ((c >= 97 && c <= 122) || c === 95) k++;
      else break;
    }
    let raw = null;
    if (k > 0 && line.charCodeAt(k) === 58) {
      if (k === line.length - 1) raw = '';
      else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
    }
    if (raw === null || raw.includes('\u2028') || raw.includes('\u2029')) return { error: `line ${j + 2} is not "key: value"` };
    const key = line.slice(0, k);
    let e = raw.length;
    while (e > 0) {
      const c = raw.charCodeAt(e - 1);
      if (c === 32 || c === 9) e--;
      else break;
    }
    if (e !== raw.length) raw = raw.slice(0, e);
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- templates

class TemplateError extends Error {}

const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

// Node kinds.
const N_TEXT = 0;
const N_VAR = 1;
const N_RAW = 2;
const N_IF = 3;
const N_FOR = 4;
const N_INCLUDE = 5;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it (the reference's tokenizer). */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: N_TEXT, text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t === 'var' ? N_VAR : N_RAW, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: N_FOR, name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: N_IF, not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== N_IF || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        const want = tag === 'endfor' ? N_FOR : N_IF;
        if (top.kind !== want) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === N_FOR ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: N_INCLUDE, name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind === N_FOR ? 'for' : 'if'} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  const head = path[0];
  while (s !== null && !hasOwn(s.vars, head)) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[head];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered in `scope`, appending to `out`. `ctx` holds the parsed templates and the include depth. */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (let idx = 0; idx < nodes.length; idx++) {
    const n = nodes[idx];
    switch (n.kind) {
      case N_TEXT:
        out.push(n.text);
        break;
      case N_VAR:
        out.push(escapeHtml(textOf(lookup(scope, n.path))));
        break;
      case N_RAW:
        out.push(textOf(lookup(scope, n.path)));
        break;
      case N_IF: {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case N_FOR: {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        const len = xs.length;
        for (let k = 0; k < len; k++) {
          const vars = {};
          vars[n.name] = xs[k];
          vars.loop = { index: k + 1, first: k === 0, last: k === len - 1, length: len };
          renderNodes(n.body, { vars, parent: scope }, ctx, depth, out);
        }
        break;
      }
      case N_INCLUDE: {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- markdown

// The characters a backslash escapes, as a code table.
const ESCAPABLE = new Uint8Array(128);
for (const ch of ['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']) ESCAPABLE[ch.charCodeAt(0)] = 1;
const isEscapable = (ch) => ch !== undefined && ch.charCodeAt(0) < 128 && ESCAPABLE[ch.charCodeAt(0)] === 1;

// Inline dispatch table for code < 128: 1 = escape-special (& < > " '), 2 = backslash, 3 = backtick, 4 = star, 5 = '['.
const INLINE_SPECIAL = new Uint8Array(128);
INLINE_SPECIAL[38] = 1; INLINE_SPECIAL[60] = 1; INLINE_SPECIAL[62] = 1; INLINE_SPECIAL[34] = 1; INLINE_SPECIAL[39] = 1;
INLINE_SPECIAL[92] = 2; INLINE_SPECIAL[96] = 3; INLINE_SPECIAL[42] = 4; INLINE_SPECIAL[91] = 5;

const WS_RE = /\s/;

/** Push s[a..b] into `out`, HTML-escaped. */
function escapeRange(s, a, b, out) {
  let last = a;
  for (let k = a; k < b; k++) {
    const c = s.charCodeAt(k);
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) {
      if (k > last) out.push(s.slice(last, k));
      out.push(ESC[s[k]]);
      last = k + 1;
    }
  }
  if (b > last) out.push(s.slice(last, b));
}

/** The first "**" in s[from..hi) outside a backslash escape, or -1 (the reference's findUnescaped for "**"). */
function findDoubleStar(s, from, hi) {
  for (let j = from; j <= hi - 2; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < hi && isEscapable(s[j + 1])) { j++; continue; }
    if (s.charCodeAt(j) === 42 && s.charCodeAt(j + 1) === 42) return j;
  }
  return -1;
}

/** The first "]" in s[from..hi) outside a backslash escape, or -1. */
function findCloseBracket(s, from, hi) {
  for (let j = from; j < hi; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < hi && isEscapable(s[j + 1])) { j++; continue; }
    if (s.charCodeAt(j) === 93) return j;
  }
  return -1;
}

/** The first single * in s[from..hi) (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, hi) {
  for (let j = from; j < hi; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < hi && isEscapable(s[j + 1])) { j++; continue; }
    if (c !== 42) continue;
    if (j + 1 < hi && s.charCodeAt(j + 1) === 42) { j++; continue; }
    return j;
  }
  return -1;
}

/**
 * s[lo..hi) rendered inline into `out`; `env.link(target)` is a link's href. The reference renders substrings;
 * ranges over the same string with every search bounded by `hi` are the same computation without the copies.
 */
function inlineRange(s, lo, hi, env, out) {
  let i = lo;
  while (i < hi) {
    const code = s.charCodeAt(i);
    const special = code < 128 ? INLINE_SPECIAL[code] : 0;
    if (special === 0) {
      let j = i + 1;
      while (j < hi) {
        const cj = s.charCodeAt(j);
        if (cj < 128 && INLINE_SPECIAL[cj] !== 0) break;
        j++;
      }
      out.push(s.slice(i, j));
      i = j;
      continue;
    }
    if (special === 1) {
      out.push(ESC[s[i]]);
      i++;
      continue;
    }
    if (special === 2) {
      if (i + 1 < hi && isEscapable(s[i + 1])) {
        out.push(s[i + 1] === '>' ? '&gt;' : s[i + 1]);
        i += 2;
      } else {
        out.push('\\');
        i++;
      }
      continue;
    }
    if (special === 3) {
      let j = s.indexOf('`', i + 1);
      if (j >= hi) j = -1;
      if (j > i + 1) {
        out.push('<code>');
        escapeRange(s, i + 1, j, out);
        out.push('</code>');
        i = j + 1;
      } else {
        out.push('`');
        i++;
      }
      continue;
    }
    if (special === 4) {
      if (i + 1 < hi && s.charCodeAt(i + 1) === 42) {
        const j = findDoubleStar(s, i + 2, hi);
        if (j > i + 2) {
          out.push('<strong>');
          inlineRange(s, i + 2, j, env, out);
          out.push('</strong>');
          i = j + 2;
        } else {
          out.push('**');
          i += 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1, hi);
      if (j > i + 1) {
        out.push('<em>');
        inlineRange(s, i + 1, j, env, out);
        out.push('</em>');
        i = j + 1;
      } else {
        out.push('*');
        i++;
      }
      continue;
    }
    // special === 5: '['
    const k = findCloseBracket(s, i + 1, hi);
    let m = -1;
    if (k !== -1 && k + 1 < hi && s.charCodeAt(k + 1) === 40) {
      m = s.indexOf(')', k + 2);
      if (m >= hi) m = -1;
    }
    const target = m === -1 ? '' : s.slice(k + 2, m);
    if (target !== '' && !WS_RE.test(target)) {
      out.push('<a href="', escapeHtml(env.link(target)), '">');
      inlineRange(s, i + 1, k, env, out);
      out.push('</a>');
      i = m + 1;
    } else {
      out.push('[');
      i++;
    }
  }
}

function inline(s, env) {
  const out = [];
  inlineRange(s, 0, s.length, env, out);
  return out.join('');
}

/** Whether `line` is blank (spaces and tabs only). */
function isBlank(line) {
  for (let k = 0; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A line trimmed of spaces and tabs at both ends (returned as-is when it has none). */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b) {
    const c = line.charCodeAt(a);
    if (c === 32 || c === 9) a++;
    else break;
  }
  while (b > a) {
    const c = line.charCodeAt(b - 1);
    if (c === 32 || c === 9) b--;
    else break;
  }
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/**
 * A fence-opening line's language, or null: three backticks, a language of [A-Za-z0-9_+-]*, then spaces/tabs.
 * (Three backticks followed by a fourth, or by any other character, is not a fence.)
 */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let k = 3;
  while (k < line.length) {
    const c = line.charCodeAt(k);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) k++;
    else break;
  }
  const lang = line.slice(3, k);
  while (k < line.length) {
    const c = line.charCodeAt(k);
    if (c === 32 || c === 9) k++;
    else return null;
  }
  return lang;
}

/** Whether `line` closes a fence: three backticks, then spaces/tabs only. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let k = 3; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's { depth, text }, or null (the reference's HEADING rule). */
function headingOf(line) {
  if (line.charCodeAt(0) !== 35) return null;
  let depth = 0;
  while (depth < line.length && line.charCodeAt(depth) === 35) depth++;
  if (depth > 6) return null;
  const c = line.charCodeAt(depth);
  if (c !== 32 && c !== 9) return null;
  let a = depth;
  while (a < line.length) {
    const cc = line.charCodeAt(a);
    if (cc === 32 || cc === 9) a++;
    else break;
  }
  let b = line.length;
  while (b > a) {
    const cc = line.charCodeAt(b - 1);
    if (cc === 32 || cc === 9) b--;
    else break;
  }
  if (b === a) return null;
  return { depth, text: line.slice(a, b) };
}

/** Whether `line` is a thematic break: "---" or "***", then spaces/tabs only. */
function isHr(line) {
  const c = line.charCodeAt(0);
  if ((c !== 45 && c !== 42) || line.charCodeAt(1) !== c || line.charCodeAt(2) !== c) return false;
  for (let k = 3; k < line.length; k++) {
    const cc = line.charCodeAt(k);
    if (cc !== 32 && cc !== 9) return false;
  }
  return true;
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  if (line === '') return true;
  const c = line.charCodeAt(0);
  if (c === 96) return fenceLang(line) !== null;
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) {
    if (isHr(line)) return true;
    return isBlank(line);
  }
  if (c === 32 || c === 9) return isBlank(line);
  return false;
}

/** A bullet item's text (after "- " or "* "), or null. */
function bulletText(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered item's { num, text } (after "N. "), or null: 1 to 9 digits, a dot, a space. */
function orderedText(line) {
  let k = 0;
  while (k < line.length) {
    const c = line.charCodeAt(k);
    if (c >= 48 && c <= 57) k++;
    else break;
  }
  if (k === 0 || k > 9) return null;
  if (line.charCodeAt(k) !== 46 || line.charCodeAt(k + 1) !== 32) return null;
  return { num: Number(line.slice(0, k)), text: line.slice(k + 2) };
}

/** Whether `line` continues a list item: two or more spaces then a non-whitespace character. */
function isContinued(line) {
  let k = 0;
  while (k < line.length && line.charCodeAt(k) === 32) k++;
  if (k < 2 || k >= line.length) return false;
  const c = line.charCodeAt(k);
  return !(c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 32 || c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279);
}

/**
 * `src` rendered: its HTML (each block followed by "\n"), its table of contents (every level 2 and 3 heading)
 * and its excerpt (the first paragraph's inline HTML, or ""). Lexing and rendering are fused into one pass.
 */
function renderMarkdown(src, env, slugCached) {
  const lines = src.split('\n');
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    if (c0 === 96) {
      const lang = fenceLang(line);
      if (lang !== null) {
        i++;
        const parts = ['<pre><code', lang === '' ? '' : ` class="language-${lang}"`, '>'];
        while (i < n && !isFenceClose(lines[i])) {
          parts.push(escapeHtml(lines[i]), '\n');
          i++;
        }
        i++;
        parts.push('</code></pre>');
        blocks.push(parts.join(''));
        continue;
      }
    }
    if (c0 === 35) {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugCached(heading.text), ids);
        const html = inline(heading.text, env);
        blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        i++;
        continue;
      }
    }
    if ((c0 === 45 || c0 === 42) && isHr(line)) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (c0 === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let l = lines[i].slice(1);
        if (l.charCodeAt(0) === 32) l = l.slice(1);
        body.push(l);
        i++;
      }
      const kept = [];
      for (const l of body) {
        const t = trimLine(l);
        if (t !== '') kept.push(t);
      }
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(kept.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    }
    const bullet = bulletText(line);
    const ordered = bullet === null ? orderedText(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [];
      while (i < n) {
        const l = lines[i];
        const m = isOrdered ? orderedText(l) : bulletText(l);
        if (m !== null) {
          items.push([trimLine(isOrdered ? m.text : m)]);
          i++;
        } else if (isContinued(l)) {
          items[items.length - 1].push(trimLine(l));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && ordered.num !== 1 ? `<ol start="${ordered.num}">` : `<${tag}>`;
      const parts = [open, '\n'];
      for (const partsOfItem of items) {
        parts.push('<li>', inline(partsOfItem.join('\n'), env), '</li>\n');
      }
      parts.push(`</${tag}>`);
      blocks.push(parts.join(''));
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  let html = '';
  for (const b of blocks) html += b + '\n';
  return { html, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- the build

export const REPORT_FILE = 'build-report.txt';
const RESERVED = ['posts', 'tags', 'page'];

/** The words of a body: its runs of characters other than whitespace (the ECMAScript \s set). */
function wordsOf(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // Fast path: printable ASCII and most of Latin-1 are never whitespace.
    if (c > 32 && c < 160) {
      if (!inWord) {
        inWord = true;
        count++;
      }
      continue;
    }
    const ws = c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279;
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      count++;
    }
  }
  return count;
}

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  if (!rel.includes('.')) {
    // No "." or ".." segment can occur: the reference's walk reduces to joining the non-empty segments.
    let out = dir;
    for (const seg of rel.split('/')) {
      if (seg === '') continue;
      out = out === '' ? seg : `${out}/${seg}`;
    }
    return out;
  }
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** One site's output tree: path -> text. */
export function build(input) {
  // Templates, parsed in code-unit order of name; one that does not parse is reported and left out.
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // Per-build caches (a build is one case: nothing is kept from one case to the next).
  const slugCache = new Map();
  const slugCached = (text) => {
    let s = slugCache.get(text);
    if (s === undefined) {
      s = slugify(text);
      slugCache.set(text, s);
    }
    return s;
  };

  // 1. The sources, in code-unit order of their paths, line ends made "\n"; a source that is not .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter: a refused source is reported and dropped, and so is a draft (the checks in the reference's order).
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Permalinks: each page's slug made unique in its directory, in source order.
  const bySource = new Map();
  {
    const taken = new Map();
    const takenIn = (dir) => {
      let set = taken.get(dir);
      if (set === undefined) {
        set = new Set(dir === '' ? RESERVED : []);
        taken.set(dir, set);
      }
      return set;
    };
    for (const s of kept) {
      const dir = s.post ? 'posts' : dirOf(s.path);
      const slug = uniqueSlug(s.data.slug ?? slugCached(s.data.title), takenIn(dir));
      s.slug = slug;
      s.outDir = dir === '' ? slug : `${dir}/${slug}`;
      s.url = `${base}/${s.outDir}/`;
      bySource.set(s.path, s);
    }
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const broken = new Set();
  {
    const staticPaths = new Set(statics.map((f) => f.path));
    for (const s of kept) {
      const dir = dirOf(s.path);
      const env = {
        link: (target) => {
          if (SCHEME_RE.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
          const hash = target.indexOf('#');
          const rel = hash === -1 ? target : target.slice(0, hash);
          const frag = hash === -1 ? '' : target.slice(hash);
          const path = rel === '' ? null : resolvePath(dir, rel);
          if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
          if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
          broken.add(`broken-link ${s.path} -> ${target}`);
          return target;
        },
      };
      const md = renderMarkdown(s.body, env, slugCached);
      s.html = md.html;
      s.toc = md.toc;
      s.excerpt = md.excerpt;
    }
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const tagsList = (() => {
    const bySlug = new Map();
    const ownTags = (s) => {
      const seen = new Set();
      return (s.data.tags ?? []).filter((name) => {
        const slug = slugCached(name);
        if (seen.has(slug)) return false;
        seen.add(slug);
        return true;
      });
    };
    for (const p of posts) {
      p.tagRefs = [];
      for (const name of ownTags(p)) {
        const slug = slugCached(name);
        let tag = bySlug.get(slug);
        if (tag === undefined) {
          tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
          bySlug.set(slug, tag);
        }
        tag.posts.push(p);
        p.tagRefs.push(tag);
      }
    }
    for (const s of kept) {
      if (!s.post) {
        s.tagRefs = ownTags(s).map((name) => {
          const slug = slugCached(name);
          return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
        });
      }
    }
    return [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
  })();

  // 7. Every page through its layout, the index pages and the tag pages through theirs, then the static files.
  const output = {};
  {
    const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
    const cardOf = (s) => {
      if (s._card !== undefined) return s._card;
      const card = {
        title: s.data.title,
        url: s.url,
        date: s.data.date ?? '',
        date_long: s.data.date === undefined ? '' : longDate(s.data.date),
        summary: s.data.summary ?? '',
        excerpt: s.excerpt,
        reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
        tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
      };
      s._card = card;
      return card;
    };
    const cards = new Map(posts.map((p) => [p, cardOf(p)]));
    const site = { title: input.site.title, base_url: base };
    const allTags = tagsList.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
    const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
    const ctx = { templates };
    // The reference merges { site, tags, recent, ...vars } into one scope per render; a two-link scope chain
    // (the render's own vars in front of the shared base vars) resolves every name to the same value.
    const baseScope = { vars: { site, tags: allTags, recent }, parent: null };
    const render = (name, vars) => {
      const nodes = templates.get(name);
      if (nodes === undefined) return null;
      const out = [];
      renderNodes(nodes, { vars, parent: baseScope }, ctx, 0, out);
      return out.join('');
    };
    for (const s of kept) {
      const page = {
        ...cardOf(s),
        slug: s.slug,
        content: s.html,
        toc: s.toc,
        newer: linkOf(s.newer ?? null),
        older: linkOf(s.older ?? null),
        is_post: s.post,
      };
      output[`${s.outDir}/index.html`] = render(s.layout, { page });
    }
    const per = input.site.per_page;
    const pages = Math.max(1, Math.ceil(posts.length / per));
    const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
    for (let k = 1; k <= pages; k++) {
      const html = render('index', {
        posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
        pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
      });
      if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
    }
    for (const t of tagsList) {
      const tag = { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) };
      const html = render('tag', { tag });
      if (html !== null) output[`tags/${t.slug}/index.html`] = html;
    }
    const tagsHtml = render('tags', {});
    if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
    for (const f of statics) {
      if (hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
      else output[f.path] = f.content;
    }
  }

  // 8. The report: every reported line and each broken link, sorted, then the counts.
  {
    const lines = [...report, ...broken].sort(byCodeUnits);
    const pages = kept.filter((s) => !s.post).length;
    lines.push(`built ${pages} pages, ${posts.length} posts, ${tagsList.length} tags and ${statics.length} static files`);
    output[REPORT_FILE] = `${lines.join('\n')}\n`;
  }
  return output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return build(input);
}
