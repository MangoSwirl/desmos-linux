// A tiny expression DSL that compiles to two targets:
//   * Desmos LaTeX (what ends up in the graph), and
//   * JavaScript with Desmos semantics (used to test the graph logic offline).
//
// Every node carries a static type: 'n' (number) or 'l' (list). Arithmetic on
// lists broadcasts element-wise like Desmos does. Booleans don't exist in
// Desmos outside of piecewise conditions and list filters, so conditions are a
// separate node kind ('cmp') that may only appear in those two places.
'use strict';

let uid = 0;
const node = (t, type, props) => ({ t, type, id: uid++, ...props });

// ------------------------------------------------------------------ builders
const N = v => node('num', 'n', { v });
const lift = v => (typeof v === 'number' ? N(v) : v);

const ops = {};
for (const [name, op] of [['add', '+'], ['sub', '-'], ['mul', '*'], ['div', '/']]) {
  ops[name] = (a, b) => {
    a = lift(a); b = lift(b);
    return node('op', a.type === 'l' || b.type === 'l' ? 'l' : 'n', { op, a, b });
  };
}
const { add, sub, mul, div } = ops;
const neg = a => sub(0, a);

// Built-in Desmos functions.
const fnType = {
  mod: args => (args.some(a => a.type === 'l') ? 'l' : 'n'),
  floor: args => args[0].type,
  abs: args => args[0].type,
  sign: args => args[0].type,
  min: () => 'n', max: () => 'n', // only scalar 2-arg use
  length: () => 'n', total: () => 'n',
  join: () => 'l', sort: () => 'l', unique: () => 'l',
};
const fn = (name, ...args) => {
  args = args.map(lift);
  return node('fn', fnType[name](args), { name, args });
};
const mod = (a, b) => fn('mod', a, b);
const floor = a => fn('floor', a);
const min = (a, b) => fn('min', a, b);
const max = (a, b) => fn('max', a, b);
const length = l => fn('length', l);
const total = l => fn('total', l);
const join = (...ls) => fn('join', ...ls);
const sort = (l, k) => (k ? fn('sort', l, k) : fn('sort', l));
const unique = l => fn('unique', l);
const pow = (b, e) => { b = lift(b); e = lift(e); return node('pow', b.type === 'l' || e.type === 'l' ? 'l' : 'n', { b, e }); };

// Conditions.
const cmp = (op, a, b) => { a = lift(a); b = lift(b); return node('cmp', a.type === 'l' || b.type === 'l' ? 'l' : 'n', { op, a, b }); };
const eq = (a, b) => cmp('=', a, b);
const lt = (a, b) => cmp('<', a, b);
const gt = (a, b) => cmp('>', a, b);
const le = (a, b) => cmp('<=', a, b);
const ge = (a, b) => cmp('>=', a, b);

// Piecewise: pw([cond, val], [cond, val], ..., elseVal)
const pw = (...parts) => {
  const branches = [];
  let els = null;
  for (const p of parts) {
    if (Array.isArray(p)) branches.push([p[0], lift(p[1])]);
    else els = lift(p);
  }
  const isList = branches.some(([c, v]) => c.type === 'l' || v.type === 'l') || (els && els.type === 'l');
  return node('pw', isList ? 'l' : 'n', { branches, els });
};

const list = items => node('list', 'l', { items: items.map(lift) });
const range = (a, b) => node('range', 'l', { a: lift(a), b: lift(b) });
const idx = (l, i) => node('idx', 'n', { l, i: lift(i) });
const lidx = (l, k) => node('lidx', 'l', { l, k }); // index a list by a list of indices
const slice = (l, a, b) => node('slice', 'l', { l, a: lift(a), b: b === undefined ? null : lift(b) });
const filter = (l, c) => node('filter', 'l', { l, c });
const comp = (expr, v, over) => node('comp', 'l', { expr: lift(expr), v, over });

// Local bindings: body with name1 = value1, name2 = value2 (independent).
// Desmos compiles each bound value once, however often body references it.
const withB = (binds, body) => node('with', body.type, { binds, body });

// Variables and function calls refer to definitions by name.
const V = (name, type = 'n') => node('var', type, { name });
const call = (f, ...args) => node('call', f.ret, { f, args: args.map(lift) });

// --------------------------------------------------------------- program
class Program {
  constructor() { this.defs = []; this.byName = new Map(); }
  // Define a function. `params` is [[name, type], ...]. body is (paramVars...) => node.
  func(name, params, ret, body) {
    const def = { kind: 'func', name, params, ret, body: null };
    this.byName.set(name, def);
    this.defs.push(def);
    def.vars = params.map(([p, t]) => V(p, t));
    def.build = () => { def.body = lift(body(...def.vars)); };
    return def;
  }
  // Global variable definition (constant or updatable state).
  global(name, type, value) {
    const def = { kind: 'global', name, type, value };
    this.byName.set(name, def);
    this.defs.push(def);
    return V(name, type);
  }
  finish() { for (const d of this.defs) if (d.kind === 'func' && !d.body) d.build(); }

  // let-binding as a single-use helper function: name(bindings..., free...) =
  // body. Every value bound here appears once in the output, however often
  // body uses it. Free variables of body (parameters of the enclosing
  // function) are passed through automatically.
  let(name, bindings, bodyFn) {
    const vars = bindings.map(([p, x]) => V(p, lift(x).type));
    const body = lift(bodyFn(...vars));
    const bound = new Set(bindings.map(([p]) => p));
    const free = new Map();
    const seen = new Set();
    const walk = n => {
      if (!n || typeof n !== 'object' || seen.has(n)) return;
      seen.add(n);
      if (n.t === 'var') {
        if (!bound.has(n.name) && !(this.byName.has(n.name) && this.byName.get(n.name).kind === 'global')) free.set(n.name, n.type);
        return;
      }
      for (const k of Object.keys(n)) {
        const v = n[k];
        if (k === 'f') continue;
        if (Array.isArray(v)) v.forEach(x => (Array.isArray(x) ? x.forEach(walk) : walk(x)));
        else if (v && typeof v === 'object' && v.t) walk(v);
      }
    };
    walk(body);
    const params = [...bindings.map(([p, x]) => [p, lift(x).type]), ...free.entries()];
    const def = { kind: 'func', name, params, ret: body.type, body };
    def.build = () => {};
    this.byName.set(name, def);
    this.defs.push(def);
    return call(def, ...bindings.map(([, x]) => x), ...[...free.keys()].map(k => V(k, free.get(k))));
  }
}

// ------------------------------------------------------------------ latex
// Names like "F_step" become "F_{step}".
// Single letters that Desmos reserves (constants, graph variables, complex i).
const RESERVED = new Set(['e', 'i', 'x', 'y', 'r', 't', 'd', 'E']);
const texName = n => {
  if (RESERVED.has(n)) return `${n}_{v}`;
  const m = /^([A-Za-z])(?:_(\w+))?$/.exec(n);
  if (!m) throw new Error('bad Desmos name ' + n);
  return m[2] ? `${m[1]}_{${m[2]}}` : m[1];
};

function texNum(v) {
  if (!Number.isFinite(v)) throw new Error('non-finite literal');
  if (v < 0) return '-' + texNum(-v);
  if (Number.isInteger(v)) return String(v);
  return String(v);
}

const PREC = { '+': 1, '-': 1, '*': 2, '/': 3 };
function tex(n, ctx = 0) {
  switch (n.t) {
    case 'num': return n.v < 0 && ctx > 0 ? `\\left(${texNum(n.v)}\\right)` : texNum(n.v);
    case 'var': return texName(n.name);
    case 'op': {
      if (n.op === '/') return `\\frac{${tex(n.a)}}{${tex(n.b)}}`;
      const p = PREC[n.op];
      const l = tex(n.a, p);
      const r = tex(n.b, n.op === '-' ? p + 0.5 : p);
      const s = n.op === '*' ? `${l}\\cdot ${r}` : `${l}${n.op}${r}`;
      return ctx > p ? `\\left(${s}\\right)` : s;
    }
    case 'pow': return `${texAtom(n.b)}^{${tex(n.e)}}`;
    case 'fn': {
      const a = n.args.map(x => tex(x)).join(',');
      if (n.name === 'min' || n.name === 'max') return `\\${n.name}\\left(${a}\\right)`;
      if (n.name === 'abs') return `\\left|${a}\\right|`;
      return `\\operatorname{${n.name}}\\left(${a}\\right)`;
    }
    case 'cmp': {
      const o = { '=': '=', '<': '<', '>': '>', '<=': '\\le ', '>=': '\\ge ' }[n.op];
      return `${tex(n.a)}${o}${tex(n.b)}`;
    }
    case 'pw': {
      const parts = n.branches.map(([c, v]) => `${tex(c)}:${tex(v)}`);
      if (n.els) parts.push(tex(n.els));
      return `\\left\\{${parts.join(',')}\\right\\}`;
    }
    case 'list': return `\\left[${n.items.map(x => tex(x)).join(',')}\\right]`;
    case 'range': return `\\left[${tex(n.a)}...${tex(n.b)}\\right]`;
    case 'idx': return `${texAtom(n.l)}\\left[${tex(n.i)}\\right]`;
    case 'lidx': return `${texAtom(n.l)}\\left[${tex(n.k)}\\right]`;
    case 'slice': return `${texAtom(n.l)}\\left[${tex(n.a)}...${n.b ? tex(n.b) : ''}\\right]`;
    case 'filter': return `${texAtom(n.l)}\\left[${tex(n.c)}\\right]`;
    case 'comp': return `\\left[${tex(n.expr)}\\operatorname{for}${texName(n.v.name)}=${tex(n.over)}\\right]`;
    case 'call': return `${texName(n.f.name)}\\left(${n.args.map(x => tex(x)).join(',')}\\right)`;
    case 'with': {
      const b = `${tex(n.body)}\\operatorname{with}${n.binds.map(([v, x]) => `${texName(v.name)}=${tex(x)}`).join(',')}`;
      return ctx > 0 ? `\\left(${b}\\right)` : b;
    }
  }
  throw new Error('tex: ' + n.t);
}
function texAtom(n) {
  const s = tex(n, 9);
  if (n.t === 'var' || n.t === 'num' && n.v >= 0 || n.t === 'list' || n.t === 'range' || n.t === 'call' || n.t === 'fn' || n.t === 'idx' || n.t === 'lidx' || n.t === 'slice' || n.t === 'filter') return s;
  return `\\left(${s}\\right)`;
}

function defLatex(def) {
  if (def.kind === 'func') {
    return `${texName(def.name)}\\left(${def.params.map(([p]) => texName(p)).join(',')}\\right)=${tex(def.body)}`;
  }
  return `${texName(def.name)}=${typeof def.value === 'string' ? def.value : tex(lift(def.value))}`;
}

// --------------------------------------------------------------------- JS
// Desmos semantics helpers for the JS target.
const RT = {
  bc(f, a, b) {
    const al = Array.isArray(a), bl = Array.isArray(b);
    if (!al && !bl) return f(a, b);
    const n = al && bl ? Math.min(a.length, b.length) : al ? a.length : b.length;
    const r = new Array(n);
    for (let i = 0; i < n; i++) r[i] = f(al ? a[i] : a, bl ? b[i] : b);
    return r;
  },
  mod: (a, b) => RT.bc((x, y) => ((x % y) + y) % y, a, b),
  floor: a => (Array.isArray(a) ? a.map(Math.floor) : Math.floor(a)),
  abs: a => (Array.isArray(a) ? a.map(Math.abs) : Math.abs(a)),
  pow: (a, b) => RT.bc((x, y) => Math.pow(x, y), a, b),
  idx(l, i) { return i >= 1 && i <= l.length && Number.isInteger(i) ? l[i - 1] : NaN; },
  slice(l, a, b) {
    if (b === undefined) b = l.length;
    if (b < a) { // Desmos ranges count downwards
      const r = []; for (let i = a; i >= b; i--) r.push(RT.idx(l, i)); return r;
    }
    const r = []; for (let i = a; i <= b; i++) r.push(RT.idx(l, i)); return r;
  },
  range(a, b) {
    const r = [];
    if (b >= a) for (let i = a; i <= b; i++) r.push(i); else for (let i = a; i >= b; i--) r.push(i);
    return r;
  },
  join(...xs) { const r = []; for (const x of xs) { if (Array.isArray(x)) for (const v of x) r.push(v); else r.push(x); } return r; },
  total(l) { let s = 0; for (const v of l) s += v; return s; },
  sort(l, k) {
    const ix = l.map((_, i) => i);
    const key = k || l;
    ix.sort((i, j) => key[i] - key[j] || i - j);
    return ix.map(i => l[i]);
  },
  unique(l) { const seen = new Set(); const r = []; for (const v of l) if (!seen.has(v)) { seen.add(v); r.push(v); } return r; },
};

function js(n) {
  switch (n.t) {
    case 'num': return `(${n.v})`;
    case 'var': return `$${n.name}`;
    case 'op':
      if (n.type === 'n') return `(${js(n.a)}${n.op}${js(n.b)})`;
      return `RT.bc((x,y)=>x${n.op}y,${js(n.a)},${js(n.b)})`;
    case 'pow': return n.type === 'n' ? `Math.pow(${js(n.b)},${js(n.e)})` : `RT.pow(${js(n.b)},${js(n.e)})`;
    case 'fn':
      switch (n.name) {
        case 'mod': return n.type === 'n' ? `((x,y)=>((x%y)+y)%y)(${js(n.args[0])},${js(n.args[1])})` : `RT.mod(${js(n.args[0])},${js(n.args[1])})`;
        case 'floor': return n.type === 'n' ? `Math.floor(${js(n.args[0])})` : `RT.floor(${js(n.args[0])})`;
        case 'abs': return n.type === 'n' ? `Math.abs(${js(n.args[0])})` : `RT.abs(${js(n.args[0])})`;
        case 'sign': return n.type === 'n' ? `Math.sign(${js(n.args[0])})` : `(${js(n.args[0])}).map(Math.sign)`;
        case 'min': return `Math.min(${js(n.args[0])},${js(n.args[1])})`;
        case 'max': return `Math.max(${js(n.args[0])},${js(n.args[1])})`;
        case 'length': return `(${js(n.args[0])}).length`;
        case 'total': return `RT.total(${js(n.args[0])})`;
        case 'join': return `RT.join(${n.args.map(js).join(',')})`;
        case 'sort': return `RT.sort(${n.args.map(js).join(',')})`;
        case 'unique': return `RT.unique(${js(n.args[0])})`;
      }
      break;
    case 'cmp': {
      const o = { '=': '===', '<': '<', '>': '>', '<=': '<=', '>=': '>=' }[n.op];
      if (n.type === 'n') return `(${js(n.a)}${o}${js(n.b)})`;
      return `RT.bc((x,y)=>x${o}y,${js(n.a)},${js(n.b)})`;
    }
    case 'pw': {
      if (n.branches.every(([c]) => c.type === 'n')) { // scalar conditions select lazily
        let s = n.els ? js(n.els) : 'NaN';
        for (let i = n.branches.length - 1; i >= 0; i--) s = `(${js(n.branches[i][0])}?${js(n.branches[i][1])}:${s})`;
        return s;
      }
      // element-wise piecewise: evaluate everything, then select per element
      const cs = n.branches.map(([c]) => js(c)), vs = n.branches.map(([, v]) => js(v));
      const e = n.els ? js(n.els) : 'NaN';
      return `((cs,vs,e)=>{let len=Infinity;for(const x of [...cs,...vs,e])if(Array.isArray(x))len=Math.min(len,x.length);` +
        `const r=new Array(len);for(let i=0;i<len;i++){let v=Array.isArray(e)?e[i]:e;` +
        `for(let k=0;k<cs.length;k++){const c=Array.isArray(cs[k])?cs[k][i]:cs[k];if(c){v=Array.isArray(vs[k])?vs[k][i]:vs[k];break;}}r[i]=v;}return r;})` +
        `([${cs.join(',')}],[${vs.join(',')}],${e})`;
    }
    case 'list': return `[${n.items.map(js).join(',')}]`;
    case 'range': return `RT.range(${js(n.a)},${js(n.b)})`;
    case 'idx': return `RT.idx(${js(n.l)},${js(n.i)})`;
    case 'lidx': return `((l,k)=>k.map(i=>RT.idx(l,i)))(${js(n.l)},${js(n.k)})`;
    case 'slice': return `RT.slice(${js(n.l)},${js(n.a)}${n.b ? ',' + js(n.b) : ''})`;
    case 'filter': return `((l,c)=>l.filter((_,i)=>c[i]))(${js(n.l)},${js(n.c)})`;
    case 'comp': return `(${js(n.over)}).map($${n.v.name}=>${js(n.expr)})`;
    case 'call': return `$${n.f.name}(${n.args.map(js).join(',')})`;
    case 'with': return `((${n.binds.map(([v]) => '$' + v.name).join(',')})=>${js(n.body)})(${n.binds.map(([, x]) => js(x)).join(',')})`;
  }
  throw new Error('js: ' + n.t);
}

// Compile a program to a JS module object exposing every definition.
// `globals` provides values for globals defined with a string value.
function compileJS(prog) {
  const lines = [];
  for (const d of prog.defs) {
    if (d.kind === 'func') {
      lines.push(`function $${d.name}(${d.params.map(([p]) => '$' + p).join(',')}){return ${js(d.body)};}`);
    } else if (typeof d.value !== 'string') {
      lines.push(`var $${d.name}=${js(lift(d.value))};`);
    } else {
      lines.push(`var $${d.name}=G[${JSON.stringify(d.name)}];`);
    }
  }
  const names = prog.defs.map(d => `${JSON.stringify(d.name)}:()=>$${d.name}`);
  const setters = prog.defs.filter(d => d.kind === 'global').map(d => `${JSON.stringify(d.name)}:v=>{$${d.name}=v;}`);
  const src = `${lines.join('\n')}\nreturn {get:{${names.join(',')}},set:{${setters.join(',')}}};`;
  return G => new Function('RT', 'G', src)(RT, G);
}

module.exports = {
  N, lift, add, sub, mul, div, neg, mod, floor, min, max, length, total, join, sort, unique, pow, fn,
  eq, lt, gt, le, ge, pw, list, range, idx, lidx, slice, filter, comp, V, call,
  Program, tex, defLatex, texName, compileJS, RT, withB,
};

// Estimate the size of a definition after Desmos inlines every non-recursive
// call (each call site gets its own copy of the callee). Shared AST nodes are
// counted once per occurrence, like the LaTeX we emit.
function inlinedSize(def, memo = new Map(), stack = new Set()) {
  if (memo.has(def.name)) return memo.get(def.name);
  if (stack.has(def.name)) return 1; // recursive call: not inlined
  stack.add(def.name);
  const walk = n => {
    switch (n.t) {
      case 'num': case 'var': return 1;
      case 'call': return 1 + n.args.reduce((s, a) => s + walk(a), 0) + (n.f.kind === 'func' ? inlinedSize(n.f, memo, stack) : 0);
      default: {
        let s = 1;
        for (const k of ['a', 'b', 'e', 'l', 'i', 'k', 'c', 'expr', 'over', 'els']) if (n[k] && typeof n[k] === 'object' && n[k].t) s += walk(n[k]);
        if (n.args) for (const a of n.args) s += walk(a);
        if (n.items) for (const a of n.items) s += walk(a);
        if (n.branches) for (const [c, v] of n.branches) s += walk(c) + walk(v);
        if (n.binds) for (const [, x] of n.binds) s += walk(x);
        if (n.body) s += walk(n.body);
        return s;
      }
    }
  };
  const size = walk(def.body);
  stack.delete(def.name);
  memo.set(def.name, size);
  return size;
}
module.exports.inlinedSize = inlinedSize;
