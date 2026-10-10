'use strict';
// Small Molang subset: enough for block permutation conditions and bone_visibility.
// compile(expr) -> fn(states) where states is the block's state map from the world.

const cache = new Map();

function tokenize(src) {
  const out = [];
  const re = /\s*(?:(\d+\.?\d*|\.\d+)|'([^']*)'|([A-Za-z_][\w.]*)|(\|\||&&|==|!=|<=|>=|[-+*/!<>()?:,]))/y;
  let m;
  re.lastIndex = 0;
  while (re.lastIndex < src.length) {
    const at = re.lastIndex;
    m = re.exec(src);
    if (!m) { if (/^\s*;?\s*$/.test(src.slice(at))) break; throw new Error('Molang: bad token at ' + at); }
    if (m[1] !== undefined) out.push({ t: 'num', v: parseFloat(m[1]) });
    else if (m[2] !== undefined) out.push({ t: 'str', v: m[2] });
    else if (m[3] !== undefined) out.push({ t: 'id', v: m[3].toLowerCase() });
    else out.push({ t: 'op', v: m[4] });
  }
  return out;
}

function parse(tokens) {
  let i = 0;
  const peek = (v) => tokens[i] && tokens[i].t === 'op' && tokens[i].v === v;
  const take = (v) => { if (peek(v)) { i++; return true; } return false; };

  function ternary() {
    const c = or();
    if (take('?')) {
      const a = ternary();
      if (take(':')) { const b = ternary(); return (s) => (truthy(c(s)) ? a(s) : b(s)); }
      return (s) => (truthy(c(s)) ? a(s) : 0);
    }
    return c;
  }
  function or() { let l = and(); while (take('||')) { const a = l, b = and(); l = (s) => (truthy(a(s)) || truthy(b(s)) ? 1 : 0); } return l; }
  function and() { let l = eq(); while (take('&&')) { const a = l, b = eq(); l = (s) => (truthy(a(s)) && truthy(b(s)) ? 1 : 0); } return l; }
  function eq() {
    let l = rel();
    for (;;) {
      if (take('==')) { const a = l, b = rel(); l = (s) => (same(a(s), b(s)) ? 1 : 0); }
      else if (take('!=')) { const a = l, b = rel(); l = (s) => (same(a(s), b(s)) ? 0 : 1); }
      else return l;
    }
  }
  function rel() {
    let l = add();
    for (;;) {
      let op;
      if (take('<=')) op = (x, y) => x <= y; else if (take('>=')) op = (x, y) => x >= y;
      else if (take('<')) op = (x, y) => x < y; else if (take('>')) op = (x, y) => x > y; else return l;
      const a = l, b = add(), f = op; l = (s) => (f(num(a(s)), num(b(s))) ? 1 : 0);
    }
  }
  function add() {
    let l = mul();
    for (;;) {
      if (take('+')) { const a = l, b = mul(); l = (s) => num(a(s)) + num(b(s)); }
      else if (take('-')) { const a = l, b = mul(); l = (s) => num(a(s)) - num(b(s)); }
      else return l;
    }
  }
  function mul() {
    let l = unary();
    for (;;) {
      if (take('*')) { const a = l, b = unary(); l = (s) => num(a(s)) * num(b(s)); }
      else if (take('/')) { const a = l, b = unary(); l = (s) => num(a(s)) / num(b(s)); }
      else return l;
    }
  }
  function unary() {
    if (take('!')) { const a = unary(); return (s) => (truthy(a(s)) ? 0 : 1); }
    if (take('-')) { const a = unary(); return (s) => -num(a(s)); }
    return primary();
  }
  function primary() {
    const t = tokens[i++];
    if (!t) throw new Error('Molang: unexpected end');
    if (t.t === 'num' || t.t === 'str') return () => t.v;
    if (t.t === 'op' && t.v === '(') { const e = ternary(); take(')'); return e; }
    if (t.t === 'id') {
      const args = [];
      if (take('(')) { while (!peek(')') && i < tokens.length) { args.push(ternary()); take(','); } take(')'); }
      if (t.v === 'true') return () => 1;
      if (t.v === 'false') return () => 0;
      if (/^(q|query)\.(block_state|block_property)$/.test(t.v)) {
        const a = args[0] || (() => '');
        return (s) => { const v = s[a(s)]; return v === undefined ? 0 : v; };
      }
      if (/^(q|query)\.has_block_state$/.test(t.v)) { const a = args[0]; return (s) => (a && s[a(s)] !== undefined ? 1 : 0); }
      // entity queries (query.variant, query.is_baby...) come from the "__q" table when given
      const qm = /^(q|query)\.(\w+)$/.exec(t.v);
      if (qm) { const name = qm[2]; return (s) => { const q = s.__q; const v = q ? q[name] : undefined; return v === undefined ? 0 : v; }; }
      if (t.v === 'math.floor' && args[0]) { const a = args[0]; return (s) => Math.floor(num(a(s))); }
      if (t.v === 'math.mod' && args[1]) { const a = args[0], b = args[1]; return (s) => num(a(s)) % num(b(s)); }
      return () => 0; // unknown queries (world state we do not model) evaluate false
    }
    throw new Error('Molang: unexpected ' + t.v);
  }
  return ternary();
}

function num(v) { return typeof v === 'number' ? v : (v === true ? 1 : parseFloat(v) || 0); }
function truthy(v) { return typeof v === 'string' ? v.length > 0 : !!v; }
function same(a, b) {
  if (typeof a === 'string' || typeof b === 'string') return String(a) === String(b);
  return num(a) === num(b);
}

function compile(expr) {
  if (expr === true || expr === false) return () => (expr ? 1 : 0);
  if (typeof expr === 'number') return () => expr;
  let fn = cache.get(expr);
  if (!fn) {
    try { fn = parse(tokenize(String(expr))); } catch (e) { fn = () => 0; }
    cache.set(expr, fn);
  }
  return fn;
}

function test(expr, states) { return truthy(compile(expr)(states)); }

module.exports = { compile, test };
