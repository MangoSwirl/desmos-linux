// The RV32IMA + Sv32 CPU, written in the expression DSL.
//
// Everything here becomes Desmos function definitions. Semantics must match
// emu/machine.js exactly; tools/difftest.js checks that they do.
//
// Constraints learned from Desmos's compiler, which shape this code:
//  * An expression may compile to at most 32768 IR instructions, and every
//    non-recursive function is inlined at each call site. So expensive pieces
//    (the RAM read tree, translation, the ALU, ...) have exactly one call site
//    per step, and the step is a chain of single-use "let" helpers.
//  * Self tail recursion compiles to a loop; any other recursion is memoized
//    with JSON.stringify of its arguments. So the batch loop F_g calls itself
//    directly and nothing else in the hot path recurses.
//  * One step therefore does at most one data read. A TLB miss becomes a
//    page walk spread over micro-steps (one PTE read each).
'use strict';
const D = require('./dsl');
const { add, sub, mul, div, mod, floor, max, length, total, join, pow, lift,
  eq, lt, gt, le, ge, pw, list, range, idx, slice, filter, call } = D;

const K32 = 4294967296, K31 = 2147483648, RB = 0x80000000;

// Architectural state layout (1-based Desmos list indices). x_r lives at r+1.
const S = {
  PC: 33, PRIV: 34, SSTATUS: 35, SIE: 36, SSIP: 37, STVEC: 38, SSCRATCH: 39, SEPC: 40,
  SCAUSE: 41, STVAL: 42, SATP: 43, TIME: 44, TIMECMP: 45, INSTRET: 46, RESV: 47, QI: 48,
  STOPF: 49, SCOUNTEREN: 50,
  WK: 51,  // page walk in progress: level + 4*acc + 16*(PTE address); 0 = none
  WVA: 52, // virtual address being translated
};
const NS = 52;
const NT = 16; // TLB entries
const TIMECMP_INIT = 2 ** 52;

// Step descriptor layout (1-based).
const DD = {
  ACT: 1,   // 1 if a step was taken
  KIND: 2,  // 0 normal, 1 trap, 2 TLB fill, 3 nothing
  Q1: 3, V1: 4, Q2: 5, V2: 6, // up to two state-field writes (index -1 = none)
  NPC: 7,   // next pc (normal)
  C: 8, TV: 9, // trap cause / tval
  SA: 10, SV: 11, // store (word index, value); SA=-1 none
  OC: 12,   // output char, -1 none
  FL: 13,   // TLB flush
  TS: 14, TVPN: 15, TENT: 16, TNP: 17, // TLB fill slot (1-based), vpn, entry, new pointer
};
const ND = 17;

function build(cfg) {
  const { ramSize, pageWords: PS, logMax: W, outMax: OM, chain } = cfg;
  const NP = Math.ceil(ramSize / 4 / PS);
  const P = new D.Program();
  // Parameter type inference: single upper-case letters are lists.
  const params = ps => ps.map(p => [p, p.length === 1 && p === p.toUpperCase() ? 'l' : 'n']);
  const fl = (name, ps, body) => { const d = P.func(name, params(ps), null, body); d.ret = 'l'; return d; };
  const fn = (name, ps, body) => { const d = P.func(name, params(ps), null, body); d.ret = 'n'; return d; };

  // ---------------------------------------------------------------- globals
  const Is = P.global('I_s', 'l', range(1, NS));
  const It = P.global('I_t', 'l', range(1, NT));
  const Iu = P.global('I_u', 'l', range(1, NT + 1));
  const Bp = P.global('B_p', 'l', pow(2, range(0, 31)));
  const TV0 = P.global('T_z', 'l', list(new Array(NT).fill(-1)));
  const TE0 = P.global('E_z', 'l', list(new Array(NT + 1).fill(0)));
  const Z0 = P.global('D_z', 'l', list([0, 0, -1, 0, -1, 0, 0, 0, 0, -1, 0, -1, 0, 0, 0, 0, 0]));
  // "Nothing to apply, keep going": starts every chain without a step.
  const N0 = P.global('D_n', 'l', list([1, 3, -1, 0, -1, 0, 0, 0, 0, -1, 0, -1, 0, 0, 0, 0, 0]));
  const Q = P.global('Q', 'l', 'string'); // console input queue (keyboard appends)
  const pages = [];
  for (let j = 0; j < NP; j++) pages.push(P.global(`P_${j}`, 'l', 'string'));

  const sx = (s, i) => idx(s, i);
  const bit = (a, k) => mod(floor(div(a, 2 ** k)), 2);
  const flag = c => pw([c, 1], 0);
  // 1 if integers x = k, else 0 (arithmetic, no piecewise)
  const ind = (x, k) => sub(1, D.fn('sign', D.fn('abs', sub(x, k))));
  const u32 = a => mod(a, K32);

  // ------------------------------------------------------------ arithmetic
  const Fand = fn('F_and', ['a', 'b'], (a, b) => total(mul(mul(mod(floor(div(a, Bp)), 2), mod(floor(div(b, Bp)), 2)), Bp)));
  const and = (a, b) => call(Fand, a, b);
  const Fsg = fn('F_sg', ['a'], a => sub(a, mul(K32, floor(div(a, K31)))));
  const sg = a => call(Fsg, a);
  const neg = a => flag(ge(a, K31));

  // ---------------------------------------------------------------- memory
  // Committed RAM read: page p, 1-based offset o (binary search over pages).
  const tree = (p, o, lo, hi) => {
    if (hi - lo === 1) return idx(pages[lo], o);
    const mid = (lo + hi) >> 1;
    return pw([lt(p, mid), tree(p, o, lo, mid)], tree(p, o, mid, hi));
  };
  const Frp = fn('F_rp', ['p', 'o'], (p, o) => tree(p, o, 0, NP));
  const Frd = fn('F_rd', ['w'], w => call(Frp, floor(div(w, PS)), add(mod(w, PS), 1)));
  // Read through the batch write log (last write wins).
  const Flx = fn('F_lx', ['M', 'w'], (M, w) => pw([gt(length(M), 0), idx(M, length(M))], call(Frd, w)));
  const Fld = fn('F_ld', ['w', 'A', 'V'], (w, A, V) => call(Flx, filter(V, eq(A, w)), w));
  const Fram = fn('F_ram', ['a'], a => pw([ge(a, RB), pw([lt(a, RB + ramSize), 1], 0)], 0));
  const ram = a => call(Fram, a);
  const widx = pa => div(sub(pa, RB), 4);

  // ----------------------------------------------------------- translation
  const accSel = (acc, a, b, c) => pw([eq(acc, 0), a], [eq(acc, 1), b], c);
  const pfc = acc => accSel(acc, 12, 13, 15);
  const afc = acc => accSel(acc, 1, 5, 7);
  // Permission check of TLB entry e = ppn*1024 + pte flags; 1 or 0.
  const Fpok = fn('F_pm', ['S', 'g', 'c'], (s, e, acc) => {
    const st = sx(s, S.SSTATUS);
    const U = bit(e, 4);
    const uok = pw([eq(sx(s, S.PRIV), 0), U], [eq(U, 1), pw([eq(acc, 0), 0], bit(st, 18))], 1);
    const aok = accSel(acc, bit(e, 3), max(bit(e, 1), mul(bit(st, 19), bit(e, 3))), mul(bit(e, 2), bit(e, 7)));
    return mul(mul(bit(e, 6), uok), aok);
  });
  const Fhx = fn('F_hx', ['H'], H => pw([gt(length(H), 0), idx(H, 1)], 0));
  const Fhit = fn('F_hi', ['T', 'n'], (tv, vpn) => call(Fhx, filter(It, eq(tv, vpn))));
  const hit = (tv, vpn) => call(Fhit, tv, vpn);
  const Fx3 = fn('F_xc', ['S', 'a', 'c', 'g'], (s, va, acc, e) => pw([eq(call(Fpok, s, e, acc), 1), add(mul(floor(div(e, 1024)), 4096), mod(va, 4096))], -1));
  const Fx2 = fn('F_xb', ['S', 'U', 'a', 'c', 'h'], (s, te, va, acc, h) => pw([eq(h, 0), -1], call(Fx3, s, va, acc, idx(te, h))));
  // Physical address on a TLB hit with permission, else -1 (start a walk).
  const Fxl = fn('F_xl', ['S', 'T', 'U', 'a', 'c'], (s, tv, te, va, acc) =>
    pw([lt(sx(s, S.SATP), K31), va], call(Fx2, s, te, va, acc, hit(tv, floor(div(va, 4096))))));
  const xl = (s, tv, te, va, acc) => call(Fxl, s, tv, te, va, acc);

  // ------------------------------------------------------------- execute
  const Fq = fn('F_q', ['d'], d => pw([eq(d, 0), -1], add(d, 1)));
  const Flv = fn('F_lv', ['f', 'o', 'w'], (f3, o, wd) => {
    const x = floor(div(wd, pow(2, mul(8, o))));
    const b = mod(x, 256), h = mod(x, 65536);
    return pw([eq(f3, 0), add(b, mul(flag(ge(b, 128)), K32 - 256))],
      [eq(f3, 1), add(h, mul(flag(ge(h, 32768)), K32 - 65536))],
      [eq(f3, 2), wd], [eq(f3, 4), b], h);
  });
  const Fmrg = fn('F_mg', ['f', 'b', 'o', 'w'], (f3, b, o, old) => {
    const sh = pow(2, mul(8, o));
    const m = pw([eq(f3, 0), 256], 65536);
    return add(sub(old, mul(mod(floor(div(old, sh)), m), sh)), mul(mod(b, m), sh));
  });

  // Multiply / divide (M extension), f3 selects the operation.
  const Fmh2 = fn('F_mhv', ['p', 'q'], (p, q) => add(floor(div(p, 65536)), floor(div(add(mul(mod(p, 65536), 65536), q), K32))));
  const Fmx2 = fn('F_mz', ['f', 'a', 'b', 'h', 'x', 'y', 'q'], (f3, a, b, mhu, sa, sb, dq) => pw(
    [eq(f3, 0), u32(add(mul(mod(mul(floor(div(a, 65536)), b), 65536), 65536), mul(mod(a, 65536), b)))],
    [eq(f3, 1), u32(sub(sub(mhu, mul(neg(a), b)), mul(neg(b), a)))],
    [eq(f3, 2), u32(sub(mhu, mul(neg(a), b)))],
    [eq(f3, 3), mhu],
    [eq(f3, 4), pw([eq(b, 0), K32 - 1], [eq(a, K31), pw([eq(b, K32 - 1), K31], u32(dq))], u32(dq))],
    [eq(f3, 5), pw([eq(b, 0), K32 - 1], floor(div(a, b)))],
    [eq(f3, 6), pw([eq(b, 0), a], [eq(a, K31), pw([eq(b, K32 - 1), 0], u32(sub(sa, mul(sb, dq))))], u32(sub(sa, mul(sb, dq))))],
    pw([eq(b, 0), a], sub(a, mul(b, floor(div(a, b)))))));
  const Fmx1 = fn('F_my', ['f', 'a', 'b', 'x', 'y'], (f3, a, b, sa, sb) =>
    call(Fmx2, f3, a, b, call(Fmh2, mul(floor(div(a, 65536)), b), mul(mod(a, 65536), b)), sa, sb,
      mul(mul(pw([lt(sa, 0), -1], 1), pw([lt(sb, 0), -1], 1)), floor(div(D.fn('abs', sa), pw([eq(sb, 0), 1], D.fn('abs', sb)))))));
  // ALU for OP / OP-IMM. b is rs2 or the immediate (as u32); ri = 1 for OP-IMM.
  // Returns -1 for an illegal encoding.
  const Falu2 = fn('F_au', ['f', 'g', 'a', 'b', 'k', 'x', 'y', 'n'], (f3, f7, a, b, ri, sa, sb, ab) => {
    const sh = mod(b, 32);
    const legal = pw(
      [eq(ri, 1), pw([eq(f3, 1), flag(eq(f7, 0))], [eq(f3, 5), pw([eq(f7, 0), 1], [eq(f7, 32), 1], 0)], 1)],
      [eq(f7, 0), 1], [eq(f7, 1), 1], [eq(f7, 32), pw([eq(f3, 0), 1], [eq(f3, 5), 1], 0)], 0);
    const base = pw(
      [eq(f3, 0), pw([eq(ri, 0), pw([eq(f7, 32), u32(sub(a, b))], u32(add(a, b)))], u32(add(a, b)))],
      [eq(f3, 1), mul(mod(a, pow(2, sub(32, sh))), pow(2, sh))],
      [eq(f3, 2), flag(lt(sa, sb))],
      [eq(f3, 3), flag(lt(a, b))],
      [eq(f3, 4), sub(add(a, b), mul(2, ab))],
      [eq(f3, 5), pw([eq(f7, 32), u32(floor(div(sa, pow(2, sh))))], floor(div(a, pow(2, sh))))],
      [eq(f3, 6), sub(add(a, b), ab)],
      ab);
    return pw([eq(legal, 0), -1], [eq(ri, 0), pw([eq(f7, 1), call(Fmx1, f3, a, b, sa, sb)], base)], base);
  });
  const Falu = fn('F_al', ['f', 'g', 'a', 'b', 'k'], (f3, f7, a, b, ri) =>
    call(Falu2, f3, f7, a, b, ri, sg(a), sg(b), pw([eq(f3, 4), and(a, b)], [eq(f3, 6), and(a, b)], [eq(f3, 7), and(a, b)], 0)));

  // CSRs.
  const t1 = s => add(sx(s, S.TIME), 1);
  const Fsip = fn('F_ip', ['S'], s => add(mul(flag(ge(t1(s), sx(s, S.TIMECMP))), 32), sx(s, S.SSIP)));
  const Fcr = fn('F_cr', ['S', 'c', 'i', 't'], (s, c, ir, tm) => pw(
    [eq(c, 0x100), sx(s, S.SSTATUS)], [eq(c, 0x104), sx(s, S.SIE)], [eq(c, 0x105), sx(s, S.STVEC)],
    [eq(c, 0x106), sx(s, S.SCOUNTEREN)], [eq(c, 0x10a), 0], [eq(c, 0x140), sx(s, S.SSCRATCH)],
    [eq(c, 0x141), sx(s, S.SEPC)], [eq(c, 0x142), sx(s, S.SCAUSE)], [eq(c, 0x143), sx(s, S.STVAL)],
    [eq(c, 0x144), call(Fsip, s)], [eq(c, 0x180), sx(s, S.SATP)],
    [eq(c, 0xc00), u32(ir)], [eq(c, 0xc02), u32(ir)],
    [eq(c, 0xc80), floor(div(ir, K32))], [eq(c, 0xc82), floor(div(ir, K32))],
    [eq(c, 0xc01), u32(tm)], [eq(c, 0xc81), floor(div(tm, K32))],
    -1));
  const csrIdx = c => pw([eq(c, 0x100), S.SSTATUS], [eq(c, 0x104), S.SIE], [eq(c, 0x105), S.STVEC],
    [eq(c, 0x106), S.SCOUNTEREN], [eq(c, 0x140), S.SSCRATCH], [eq(c, 0x141), S.SEPC], [eq(c, 0x142), S.SCAUSE],
    [eq(c, 0x143), S.STVAL], [eq(c, 0x144), S.SSIP], [eq(c, 0x180), S.SATP], -1);
  const Fcv = fn('F_cv', ['c', 'v'], (c, v) => pw(
    [eq(c, 0x100), add(add(add(mul(bit(v, 1), 2), mul(bit(v, 5), 32)), mul(bit(v, 8), 256)), add(mul(bit(v, 18), 2 ** 18), mul(bit(v, 19), 2 ** 19)))],
    [eq(c, 0x104), add(add(mul(bit(v, 1), 2), mul(bit(v, 5), 32)), mul(bit(v, 9), 512))],
    [eq(c, 0x105), sub(v, mul(bit(v, 1), 2))],
    [eq(c, 0x141), sub(v, mod(v, 4))],
    [eq(c, 0x144), mul(bit(v, 1), 2)],
    [eq(c, 0x180), add(mul(floor(div(v, K31)), K31), mod(v, 2 ** 22))],
    v));
  // ------------------------------------------------------------------ step
  // The step is a chain of single-use helpers ("let" bindings) computing
  // scalars, ending in F_dz which classifies the step into one outcome class
  // and builds the descriptor field by field with scalar piecewise chains.
  // Every intermediate scalar also goes into a "sink" so that Desmos
  // evaluates it eagerly (lazily evaluated shared values cost a closure
  // allocation per step).
  //
  // Outcome classes (X):
  const X = {
    WFAULT: 1, WNEXT: 2, WFILL: 3, IRQ: 4, // page walk micro-steps, interrupt
    SWALK: 5, SWFAULT: 6,                  // start a page walk (fetch or data)
    TRAP: 7,                               // exception (cause tc, tval tt)
    ALU: 10, JUMP: 11, NEXT: 12, LUI: 13, AUIPC: 14,
    LOAD: 15, STORE: 16, LR: 17, SCOK: 18, SCFAIL: 19, AMO: 20,
    SBITIMER: 21, SBIPUT: 22, SBIGET: 23, SBINONE: 24, SBIZERO: 25, SBIHALT: 26, SBIUNSUP: 27,
    SRET: 28, WFI: 29, SFENCE: 30, CSRR: 31, CSRW: 32, FENCEI: 33,
  };
  const Firq = fn('F_iq', ['S'], s => {
    const en = pw([eq(sx(s, S.PRIV), 0), 1], bit(sx(s, S.SSTATUS), 1));
    const sie = sx(s, S.SIE);
    return pw([eq(en, 0), 0], [gt(mul(bit(sie, 1), sx(s, S.SSIP)), 0), 1],
      [eq(bit(sie, 5), 1), pw([ge(t1(s), sx(s, S.TIMECMP)), 5], 0)], 0);
  });
  const Fjr = fn('F_jr', ['x'], x => sub(x, mod(x, 2)));
  // Read a word through the batch log, given its word index w (page p, offset o).
  const Fldp = fn('F_lp', ['M', 'p', 'o'], (M, p, o) => pw([gt(length(M), 0), idx(M, length(M))], call(Frp, p, o)));

  // The step proper. Layer 1: fetch.
  // The step on state (S, T, U) with batch log (A, V) and output O, where the
  // previous step's store (word index n_a, value n_v) and output char (n_o)
  // haven't been appended to A/V/O yet: reads check the pending store first.
  const Fstep = fl('F_st', ['n', 'S', 'T', 'U', 'A', 'V', 'O', 'n_a', 'n_v', 'n_o'], (n, s, tv, te, A, V, O, psa, psv, poc) => {
    const act = pw([le(n, 0), 0], [gt(sx(s, S.STOPF), 0), 0],
      [gt(add(length(A), flag(ge(psa, 0))), W), 0], [gt(add(length(O), flag(ge(poc, 0))), OM), 0], 1);
    const wk = sx(s, S.WK);
    const fpa = pw([gt(wk, 0), 0], xl(s, tv, te, sx(s, S.PC), 0));
    return call(Fd1, act, s, tv, te, A, V, wk, call(Firq, s), fpa, widx(fpa), psa, psv);
  });
  const Fd1 = fl('F_da', ['k', 'S', 'T', 'U', 'A', 'V', 'g', 'q', 'p', 'i', 'n_a', 'n_v'], (act, s, tv, te, A, V, wk, q, fpa, fwi, psa, psv) => {
    // fs = fetch status: 0 ok, 1 no fetch (walk or interrupt), 2 TLB miss, 3 access fault
    const fs = pw([gt(wk, 0), 1], [gt(q, 0), 1], [eq(fpa, -1), 2], [eq(ram(fpa), 0), 3], 0);
    return call(Fd2, act, s, tv, te, A, V, wk, q, fs, floor(div(fwi, PS)), add(mod(fwi, PS), 1), psa, psv);
  });
  const Fd2 = fl('F_db', ['k', 'S', 'T', 'U', 'A', 'V', 'g', 'q', 'z', 'p', 'o', 'n_a', 'n_v'], (act, s, tv, te, A, V, wk, q, fs, fp, fo, psa, psv) =>
    call(Fd3, act, s, tv, te, A, V, wk, q, fs, pw([eq(fs, 0), call(Frp, fp, fo)], 0), psa, psv));
  // Layer 2: decode.
  const Fd3 = fl('F_dc', ['k', 'S', 'T', 'U', 'A', 'V', 'g', 'q', 'z', 'w', 'n_a', 'n_v'], (act, s, tv, te, A, V, wk, q, fs, w, psa, psv) => {
    const op = mod(w, 128), d = mod(floor(div(w, 128)), 32), f3 = mod(floor(div(w, 4096)), 8);
    const r1 = mod(floor(div(w, 32768)), 32), r2 = mod(floor(div(w, 2 ** 20)), 32), f7 = floor(div(w, 2 ** 25));
    const iu = floor(div(w, 2 ** 20));
    // memory op kind: 0 load, 1 store, 2 AMO, -1 none
    const mk = pw([eq(fs, 0), pw([eq(op, 0x03), 0], [eq(op, 0x23), 1], [eq(op, 0x2f), 2], -1)], -1);
    return call(Fd4, act, s, tv, te, A, V, wk, q, fs, w, op, d, f3, r1, r2, f7,
      sx(s, add(r1, 1)), sx(s, add(r2, 1)), mk, sub(iu, mul(4096, flag(ge(iu, 2048)))), floor(div(w, 2 ** 27)), psa, psv);
  });
  // Layer 3: memory operand classification and data translation.
  const amoOk = f5 => pw(...[0, 1, 2, 3, 4, 8, 12, 16, 20, 24, 28].map(v => [eq(f5, v), 1]), 0);
  const Fd4 = fl('F_dd', ['k', 'S', 'T', 'U', 'A', 'V', 'g', 'q', 'z', 'w', 'o', 'd', 'f', 'r', 'j', 'h', 'a', 'b', 'm', 'i', 'c', 'n_a', 'n_v'],
    (act, s, tv, te, A, V, wk, q, fs, w, op, d, f3, r1, r2, f7, a, b, mk, immI, f5, psa, psv) => {
      const immS = sub(add(mul(f7, 32), d), mul(4096, flag(ge(f7, 64))));
      const va = pw([eq(mk, 0), u32(add(a, immI))], [eq(mk, 1), u32(add(a, immS))], a);
      const acc = pw([eq(mk, 0), 1], [eq(mk, 1), 2], [eq(f5, 2), 1], 2);
      const illegal = pw(
        [eq(mk, 0), pw([eq(f3, 3), 1], [gt(f3, 5), 1], 0)],
        [eq(mk, 1), flag(gt(f3, 2))],
        pw([gt(f3, 2), 1], [lt(f3, 2), 1], [eq(amoOk(f5), 0), 1], [eq(f5, 2), flag(gt(r2, 0))], 0));
      const size = pw([eq(mk, 2), 2], mod(f3, 4));
      const mis = pw([eq(size, 1), mod(va, 2)], [eq(size, 2), flag(gt(mod(va, 4), 0))], 0);
      // ms = memory status: 0 none, 1 illegal, 2 misaligned, 3 TLB miss, 4 access fault, 5 ok
      const ms0 = pw([lt(mk, 0), 0], [eq(illegal, 1), 1], [eq(mis, 1), 2], 5);
      return call(Fd5, act, s, tv, te, A, V, wk, q, fs, w, op, d, f3, r1, r2, f7, a, b, mk, immI, f5, va, acc, ms0,
        pw([eq(ms0, 5), xl(s, tv, te, va, acc)], 0), psa, psv);
    });
  const Fd5 = fl('F_de', ['k', 'S', 'T', 'U', 'A', 'V', 'g', 'q', 'z', 'w', 'o', 'd', 'f', 'r', 'j', 'h', 'a', 'b', 'm', 'i', 'c', 'v', 'e', 'x', 'p', 'n_a', 'n_v'],
    (act, s, tv, te, A, V, wk, q, fs, w, op, d, f3, r1, r2, f7, a, b, mk, immI, f5, va, acc, ms0, pa, psa, psv) => {
      const ms = pw([lt(ms0, 5), ms0], [eq(pa, -1), 3], [eq(ram(pa), 0), 4], 5);
      // the single data read: PTE during a walk, else the memory operand
      const rw = pw([gt(wk, 0), widx(floor(div(wk, 16)))], [lt(ms, 5), -1],
        [eq(mk, 1), pw([eq(f3, 2), -1], widx(sub(pa, mod(pa, 4))))], widx(sub(pa, mod(pa, 4))));
      return call(Fd6, act, s, tv, te, wk, q, fs, w, op, d, f3, r1, r2, f7, a, b, mk, immI, f5, va, acc, ms, pa, rw,
        pw([lt(rw, 0), 0], [eq(rw, psa), psv], call(Fldp, filter(V, eq(A, rw)), floor(div(rw, PS)), add(mod(rw, PS), 1))));
    });
  // Layer 4: everything else, as scalars.
  const Fd6 = fl('F_df', ['k', 'S', 'T', 'U', 'g', 'q', 'z', 'w', 'o', 'd', 'f', 'r', 'j', 'h', 'a', 'b', 'm', 'i', 'c', 'v', 'e', 'x', 'p', 'l', 'y'],
    (act, s, tv, te, wk, q, fs, w, op, d, f3, r1, r2, f7, a, b, mk, immI, f5, va, acc, ms, pa, rw, rv) => {
      const pc = sx(s, S.PC), priv = sx(s, S.PRIV), st = sx(s, S.SSTATUS);
      const np = u32(add(pc, 4));
      const qd = call(Fq, d);
      const immB = add(add(sub(mul(mod(d, 2), 2048), mul(4096, flag(ge(f7, 64)))), mul(mod(f7, 64), 32)), mul(floor(div(d, 2)), 2));
      const immJ = add(add(sub(mul(mod(floor(div(w, 4096)), 256), 4096), mul(2 ** 20, flag(ge(w, K31)))),
        mul(mod(floor(div(w, 2 ** 20)), 2), 2048)), mul(mod(floor(div(w, 2 ** 21)), 1024), 2));
      const sa = call(Fsg, a), sb = call(Fsg, b);
      const bc = pw([eq(f3, 0), flag(eq(a, b))], [eq(f3, 1), sub(1, flag(eq(a, b)))],
        [eq(f3, 4), flag(lt(sa, sb))], [eq(f3, 5), flag(ge(sa, sb))],
        [eq(f3, 6), flag(lt(a, b))], flag(ge(a, b)));
      const jt = pw([eq(op, 0x6f), u32(add(pc, immJ))], [eq(op, 0x67), call(Fjr, u32(add(a, immI)))], u32(add(pc, immB)));
      const isAlu = pw([eq(op, 0x13), 1], [eq(op, 0x33), 1], 0);
      const alu = pw([eq(isAlu, 1), call(Falu, f3, f7, a, pw([eq(op, 0x33), b], u32(immI)), flag(eq(op, 0x13)))], 0);
      const csr = floor(div(w, 2 ** 20));
      const tm = t1(s);
      const isSys = flag(eq(op, 0x73));
      const old = pw([eq(isSys, 1), pw([gt(f3, 0), call(Fcr, s, csr, add(sx(s, S.INSTRET), 1), tm)], rv)], rv);
      return call(Fd7, act, s, tv, te, wk, q, fs, w, op, d, f3, r1, r2, f7, a, b, mk, immI, f5, va, acc, ms, pa, rw, rv,
        pc, priv, st, np, qd, bc, jt, isAlu, alu, csr, tm, old);
    });
  const Fd7 = fl('F_dg', ['k', 'S', 'T', 'U', 'g', 'q', 'z', 'w', 'o', 'd', 'f', 'r', 'j', 'h', 'a', 'b', 'm', 'i', 'c', 'v', 'e', 'x', 'p', 'l', 'y',
    'p_c', 'p_v', 's_t', 'n_p', 'q_d', 'b_c', 'j_t', 'i_a', 'a_l', 'c_s', 't_m', 'o_l'],
  (act, s, tv, te, wk, q, fs, w, op, d, f3, r1, r2, f7, a, b, mk, immI, f5, va, acc, ms, pa, rw, rv, pc, priv, st, np, qd, bc, jt, isAlu, alu, csr, tm, old) =>
    // Stage 1: values computed directly from the parameters.
    P.let('F_ha', [
      ['l_v', mod(wk, 4)], ['w_a', mod(floor(div(wk, 4)), 4)], ['w_v', sx(s, S.WVA)],
      ['b_d', pw([eq(mod(rv, 2), 0), 1], [eq(mod(floor(div(rv, 2)), 4), 2), 1], 0)],
      ['l_f', add(bit(rv, 1), bit(rv, 3))],
      ['s_v', pw([eq(fs, 2), pc], va)], ['s_a', pw([eq(fs, 2), 0], acc)],
      ['s_i', call(Fsip, s)], ['e_i', sx(s, 18)], ['a_0', sx(s, 11)], ['q_i', sx(s, S.QI)],
      ['s_r', pw([ge(f3, 4), r1], a)],
      ['w_i', widx(sub(pa, mod(pa, 4)))], ['p_o', mod(pa, 4)],
    ], (lvl, wacc, wva, bad, leaf, sva, sacc, sip, eid, a0, qi, src, wi, po) => P.let('F_hb', [
      ['v_0', mod(floor(div(wva, 4096)), 1024)],
      ['a_1', add(mul(mod(sx(s, S.SATP), 2 ** 22), 4096), mul(floor(div(sva, 2 ** 22)), 4))],
      ['s_s', add(sub(sub(st, mul(bit(st, 1), 2)), mul(bit(st, 8), 256)), add(mul(bit(st, 5), 2), mul(sub(1, bit(st, 5)), 32)))],
      ['p_d', add(mul(bit(sip, 1), bit(sx(s, S.SIE), 1)), mul(bit(sip, 5), bit(sx(s, S.SIE), 5)))],
      ['q_n', pw([lt(qi, length(Q)), idx(Q, add(qi, 1))], K32 - 1)],
      ['w_r', pw([eq(mod(f3, 4), 1), 1], [gt(r1, 0), 1], 0)],
      ['a_v', pw([eq(isSysCsr(op, f3), 1), pw([ge(mod(f3, 4), 2), and(old, src)], 0)], 0)],
      ['c_b', pw([lt(old, 0), 1], [eq(priv, 0), flag(gt(mod(floor(div(csr, 256)), 4), 0))], 0)],
      ['a_b', pw([eq(mk, 2), pw([eq(f5, 4), and(rv, b)], [eq(f5, 12), and(rv, b)], [eq(f5, 8), and(rv, b)], 0)], 0)],
      ['l_d', pw([eq(mk, 0), call(Flv, f3, po, rv)], 0)],
      ['s_w', pw([eq(mk, 1), pw([eq(f3, 2), b], call(Fmrg, f3, b, po, rv))], 0)],
    ], (vpn0, a1, sretSt, pend, qin, writes, andv, cbad, ab, lv, sval) => P.let('F_hc', [
      ['a_2', add(mul(floor(div(rv, 1024)), 4096), mul(vpn0, 4))],
      ['w_e', pw([eq(lvl, 1), add(mul(add(mul(floor(div(rv, 2 ** 20)), 1024), vpn0), 1024), mod(rv, 256))],
        add(mul(floor(div(rv, 1024)), 1024), mod(rv, 256)))],
      ['n_t', pw([gt(pend, 0), tm], [lt(sx(s, S.TIMECMP), add(tm, 2 ** 40)), max(tm, sx(s, S.TIMECMP))], tm)],
      ['c_n', pw([eq(mod(f3, 4), 1), src], [eq(mod(f3, 4), 2), sub(add(old, src), andv)], sub(old, andv))],
      ['a_n', pw(
        [eq(f5, 1), b], [eq(f5, 0), u32(add(rv, b))], [eq(f5, 4), sub(add(rv, b), mul(2, ab))],
        [eq(f5, 12), ab], [eq(f5, 8), sub(add(rv, b), ab)],
        [eq(f5, 16), pw([lt(call(Fsg, rv), call(Fsg, b)), rv], b)], [eq(f5, 20), pw([gt(call(Fsg, rv), call(Fsg, b)), rv], b)],
        [eq(f5, 24), pw([lt(rv, b), rv], b)], pw([gt(rv, b), rv], b))],
      // the execute class: TRAP (cause tc, value tt) or a normal outcome
      ['e_c', pw(
        [eq(fs, 2), X.SWALK], [eq(fs, 3), X.TRAP],
        [eq(isAlu, 1), pw([lt(alu, 0), X.TRAP], X.ALU)],
        [ge(mk, 0), pw([eq(ms, 1), X.TRAP], [eq(ms, 2), X.TRAP], [eq(ms, 3), X.SWALK], [eq(ms, 4), X.TRAP],
          [eq(mk, 0), X.LOAD], [eq(mk, 1), X.STORE], [eq(f5, 2), X.LR],
          [eq(f5, 3), pw([eq(sx(s, S.RESV), pa), X.SCOK], X.SCFAIL)], X.AMO)],
        [eq(op, 0x63), pw([eq(f3, 2), X.TRAP], [eq(f3, 3), X.TRAP], [eq(bc, 1), pw([gt(mod(jt, 4), 0), X.TRAP], X.JUMP)], X.NEXT)],
        [eq(op, 0x6f), pw([gt(mod(jt, 4), 0), X.TRAP], X.JUMP)],
        [eq(op, 0x67), pw([gt(f3, 0), X.TRAP], [gt(mod(jt, 4), 0), X.TRAP], X.JUMP)],
        [eq(op, 0x37), X.LUI], [eq(op, 0x17), X.AUIPC],
        [eq(op, 0x73), pw([eq(f3, 0), pw(
          [eq(w, 0x73), pw([eq(priv, 0), X.TRAP],
            [eq(eid, 0), X.SBITIMER], [eq(eid, 1), X.SBIPUT],
            [eq(eid, 2), pw([lt(qi, length(Q)), X.SBIGET], X.SBINONE)],
            [lt(eid, 8), X.SBIZERO], [eq(eid, 8), X.SBIHALT], X.SBIUNSUP)],
          [eq(w, 0x100073), X.TRAP],
          [eq(priv, 0), X.TRAP],
          [eq(w, 0x10200073), X.SRET],
          [eq(w, 0x10500073), X.WFI],
          [eq(mod(w, 32768), 0x73), pw([eq(f7, 9), X.SFENCE], X.TRAP)], X.TRAP)],
          [eq(f3, 4), X.TRAP],
          pw([eq(cbad, 1), X.TRAP], [eq(writes, 0), X.CSRR], [eq(floor(div(csr, 1024)), 3), X.TRAP], X.CSRW))],
        [eq(op, 0x0f), pw([eq(f3, 1), X.FENCEI], [eq(f3, 0), X.NEXT], X.TRAP)],
        X.TRAP)],
      ['t_c', pw(
        [eq(fs, 3), 1],
        [eq(isAlu, 1), 2],
        [ge(mk, 0), pw([eq(ms, 1), 2], [eq(ms, 2), pw([eq(mk, 0), 4], [eq(mk, 1), 6], [eq(f5, 2), 4], 6)], call(Faf, acc))],
        [eq(op, 0x63), pw([eq(f3, 2), 2], [eq(f3, 3), 2], 0)],
        [eq(op, 0x6f), 0],
        [eq(op, 0x67), pw([gt(f3, 0), 2], 0)],
        [eq(op, 0x73), pw([eq(f3, 0), pw([eq(w, 0x73), 8], [eq(w, 0x100073), 3], 2)], 2)],
        2)],
      ['t_t', pw(
        [eq(fs, 3), pc],
        [eq(isAlu, 1), w],
        [ge(mk, 0), pw([eq(ms, 1), w], va)],
        [eq(op, 0x63), pw([eq(f3, 2), w], [eq(f3, 3), w], jt)],
        [eq(op, 0x6f), jt],
        [eq(op, 0x67), pw([gt(f3, 0), w], jt)],
        [eq(op, 0x73), pw([eq(f3, 0), pw([eq(w, 0x73), 0], [eq(w, 0x100073), pc], w)], w)],
        w)],
    ], (a2, went, nt, cnv, anv, ecls, tc, tt) => P.let('F_hd', [
      ['w_o', pw([gt(wk, 0), call(Fpok, s, went, wacc)], 0)],
    ], wok => P.let('F_he', [
      ['w_c', pw([eq(bad, 1), X.WFAULT],
        [eq(leaf, 0), pw([eq(lvl, 2), X.WFAULT], [eq(ram(a2), 0), X.WFAULT], X.WNEXT)],
        [eq(lvl, 1), pw([gt(mod(floor(div(rv, 1024)), 1024), 0), X.WFAULT], [eq(wok, 1), X.WFILL], X.WFAULT)],
        [eq(wok, 1), X.WFILL], X.WFAULT)],
      // walk fault cause: access fault only when the level-2 PTE address is outside RAM
      ['w_z', pw([eq(bad, 1), call(Fpf, wacc)], [eq(leaf, 0), pw([eq(lvl, 2), call(Fpf, wacc)], call(Faf, wacc))], call(Fpf, wacc))],
    ], (wcls, wcause) => P.let('F_hf', [
      ['c_l', pw([gt(wk, 0), wcls], [gt(q, 0), X.IRQ], [eq(ecls, X.SWALK), pw([eq(ram(a1), 0), X.SWFAULT], X.SWALK)], ecls)],
      ['w_h', pw([gt(wk, 0), pw([eq(wcls, X.WFILL), hit(tv, floor(div(wva, 4096)))], 0)], 0)],
      ['p_r', idx(te, NT + 1)],
    ], (cls, wh, ptr) => {
      const sink = list([act, wk, q, fs, w, op, d, f3, r1, r2, f7, a, b, mk, immI, f5, va, acc, ms, pa, rw, rv,
        pc, priv, st, np, qd, bc, jt, isAlu, alu, csr, tm, old,
        lvl, wacc, wva, bad, leaf, sva, sacc, sip, eid, a0, qi, src, wi, po,
        vpn0, a1, sretSt, pend, qin, writes, andv, cbad, ab, lv, sval,
        a2, went, nt, cnv, anv, ecls, tc, tt, wok, wcls, wcause, cls, wh, ptr]);
      // Field selection by arithmetic (no piecewise: each piecewise level would
      // cost a closure per step). All candidates are finite, so
      // def + sum_k [cls = k] * (v_k - def) is exact.
      const sel = (pairs, def) => pairs.reduce((acc, [k, v]) => add(acc, mul(ind(cls, k), sub(v, def))), lift(def));
      return call(Fdz, act, cls, total(sink),
        // q1, v1, q2, v2, npc, cause, tval, sa, sv, oc, fl, ts, tvpn, tent, tnp
        sel([[X.WNEXT, S.WK], [X.WFILL, S.WK], [X.SWALK, S.WK],
          [X.ALU, qd], [X.JUMP, pw([eq(op, 0x63), -1], qd)], [X.LUI, qd], [X.AUIPC, qd], [X.LOAD, qd], [X.LR, qd], [X.SCOK, qd], [X.SCFAIL, qd], [X.AMO, qd],
          [X.SBITIMER, 11], [X.SBIPUT, 11], [X.SBIGET, 11], [X.SBINONE, 11], [X.SBIZERO, 11], [X.SBIHALT, 11], [X.SBIUNSUP, 11],
          [X.SRET, S.PRIV], [X.WFI, S.TIME], [X.CSRR, qd], [X.CSRW, qd], [X.FENCEI, S.STOPF]], -1),
        sel([[X.WNEXT, add(add(2, mul(4, wacc)), mul(16, a2))], [X.WFILL, 0], [X.SWALK, add(add(1, mul(4, sacc)), mul(16, a1))],
          [X.ALU, alu], [X.JUMP, np], [X.LUI, sub(w, mod(w, 4096))], [X.AUIPC, u32(add(pc, sub(w, mod(w, 4096))))],
          [X.LOAD, lv], [X.LR, rv], [X.SCOK, 0], [X.SCFAIL, 1], [X.AMO, rv],
          [X.SBIGET, qin], [X.SBINONE, K32 - 1], [X.SBIUNSUP, K32 - 2],
          [X.SRET, bit(st, 8)], [X.WFI, nt], [X.CSRR, old], [X.CSRW, old], [X.FENCEI, 2]], 0),
        sel([[X.SWALK, S.WVA], [X.LR, S.RESV], [X.SCOK, S.RESV], [X.SCFAIL, S.RESV], [X.SBITIMER, S.TIMECMP], [X.SBIGET, S.QI],
          [X.SBIHALT, S.STOPF], [X.SBIUNSUP, 12], [X.SRET, S.SSTATUS], [X.WFI, S.STOPF], [X.CSRW, csrIdx(csr)]], -1),
        sel([[X.SWALK, sva], [X.LR, pa], [X.SCOK, -1], [X.SCFAIL, -1], [X.SBITIMER, D.fn('min', add(mul(sx(s, 12), K32), a0), TIMECMP_INIT)], [X.SBIGET, add(qi, 1)],
          [X.SBIHALT, 6], [X.SBIUNSUP, 0], [X.SRET, sretSt], [X.WFI, 3], [X.CSRW, call(Fcv, csr, cnv)]], 0),
        sel([[X.JUMP, jt], [X.SRET, sx(s, S.SEPC)], [X.WNEXT, pc], [X.WFILL, pc], [X.SWALK, pc]], np),
        sel([[X.WFAULT, wcause], [X.IRQ, add(K31, q)], [X.SWFAULT, call(Faf, sacc)]], tc),
        sel([[X.WFAULT, wva], [X.IRQ, 0], [X.SWFAULT, sva]], tt),
        sel([[X.STORE, wi], [X.SCOK, wi], [X.AMO, wi]], -1),
        sel([[X.STORE, sval], [X.SCOK, b], [X.AMO, anv]], 0),
        sel([[X.SBIPUT, mod(a0, 256)]], -1),
        sel([[X.SFENCE, 1], [X.CSRW, flag(eq(csr, 0x180))]], 0),
        sel([[X.WFILL, pw([gt(wh, 0), wh], add(ptr, 1))]], 0),
        sel([[X.WFILL, floor(div(wva, 4096))]], 0),
        sel([[X.WFILL, went]], 0),
        sel([[X.WFILL, pw([gt(wh, 0), ptr], mod(add(ptr, 1), NT))]], 0));
    })))))));
  const isSysCsr = (op, f3) => pw([eq(op, 0x73), pw([gt(f3, 0), 1], 0)], 0);
  const Fpf = fn('F_pf', ['c'], acc => pfc(acc));
  const Faf = fn('F_af', ['c'], acc => afc(acc));
  // Assemble the descriptor list. z = total(sink), added as 0*z so every
  // shared scalar is evaluated eagerly.
  const Fdz = fl('F_dz', ['k', 'x', 'z', ...'abcdefghijlmnop'.split('')],
    (act, cls, z, q1, v1, q2, v2, npc, c, tv, sa, sv, oc, flv, ts, tvpn, tent, tnp) => {
      const isT = [X.WFAULT, X.IRQ, X.SWFAULT, X.TRAP].map(k => ind(cls, k)).reduce((x, y) => add(x, y));
      return call(Fdz2, act, z, isT, add(isT, mul(2, ind(cls, X.WFILL))), q1, v1, q2, v2, npc, c, tv, sa, sv, oc, flv, ts, tvpn, tent, tnp);
    });
  // traps never write registers, store or print: those fields become -1 / 0
  const Fdz2 = fl('F_dy', ['k', 'z', 't', 'u', ...'abcdefghijlmnop'.split('')],
    (act, z, isT, kind, q1, v1, q2, v2, npc, c, tv, sa, sv, oc, flv, ts, tvpn, tent, tnp) => {
      const keep = (x, trapVal) => add(x, mul(isT, sub(trapVal, x)));
      const live = list([1, kind, keep(q1, -1), v1, keep(q2, -1), v2, npc, c, tv,
        keep(sa, -1), sv, keep(oc, -1), keep(flv, 0), ts, tvpn, tent, tnp]);
      return pw([eq(act, 1), add(live, mul(0, z))], Z0);
    });

  // ---------------------------------------------------------- next state
  // List builders are comprehensions over an index list with scalar
  // arithmetic per element: an element-wise piecewise would compile to
  // per-element closures, and arithmetic on several lists makes Desmos
  // recompute their common length on every element.
  const setAt = (x, i, q, v) => mul(ind(i, q), sub(v, x)); // change that sets x = v where i = q
  const Fns2 = fl('F_nr', ['S', 'D', 'a', 't', 'n', 'c', 'z', 'v', 'q', 'h'], (s, Dd, act, isT, isN, c, st, stv, q1, tmv) => {
    const sie = bit(st, 1);
    const st2 = add(sub(sub(sub(st, mul(sie, 2)), mul(bit(st, 5), 32)), mul(bit(st, 8), 256)), add(mul(sie, 32), mul(sx(s, S.PRIV), 256)));
    const base = sub(stv, mod(stv, 4));
    const tgt = pw([eq(mod(stv, 2), 1), pw([ge(c, K31), add(base, mul(4, sub(c, K31)))], base)], base);
    const npc = pw([eq(isT, 1), tgt], [eq(isN, 1), idx(Dd, DD.NPC)], sx(s, S.PC));
    return call(Fns3, s, q1, idx(Dd, DD.V1), idx(Dd, DD.Q2), idx(Dd, DD.V2), mul(S.PC, act), npc, mul(S.TIME, act), tmv,
      mul(S.INSTRET, act), add(sx(s, S.INSTRET), 1), isT, sx(s, S.PC), c, idx(Dd, DD.TV), st2);
  });
  const Fns3 = fl('F_nq', ['S', 'q', 'v', 'r', 'u', 'p', 'n', 'a', 'b', 'c', 'd', 't', 'e', 'f', 'g', 'h'],
    (s, q1, v1, q2, v2, qp, npc, qt, tmv, qi, irv, isT, pc, c, tv, st2) => {
      const i = D.V('i_x', 'n');
      const x = idx(s, i);
      const terms = [setAt(x, i, q1, v1), setAt(x, i, q2, v2), setAt(x, i, qp, npc), setAt(x, i, qt, tmv), setAt(x, i, qi, irv)];
      const trapTerms = [setAt(x, i, S.SEPC, pc), setAt(x, i, S.SCAUSE, c), setAt(x, i, S.STVAL, tv),
        setAt(x, i, S.SSTATUS, st2), setAt(x, i, S.PRIV, 1), setAt(x, i, S.WK, 0)];
      const sum = xs => xs.reduce((acc, y) => add(acc, y));
      return D.comp(add(add(x, sum(terms)), mul(isT, sum(trapTerms))), i, Is);
    });
  // A write to TIME through Q1 (wfi) replaces the usual time+1.
  const Fns = fl('F_ns', ['S', 'D'], (s, Dd) => {
    const q1 = idx(Dd, DD.Q1);
    return call(Fns2, s, Dd, mul(idx(Dd, DD.ACT), flag(lt(idx(Dd, DD.KIND), 3))), flag(eq(idx(Dd, DD.KIND), 1)),
      flag(eq(idx(Dd, DD.KIND), 0)), idx(Dd, DD.C), sx(s, S.SSTATUS), sx(s, S.STVEC),
      pw([eq(q1, S.TIME), -1], q1), pw([eq(q1, S.TIME), idx(Dd, DD.V1)], add(sx(s, S.TIME), 1)));
  });
  const Fnt = fl('F_nt', ['T', 'D'], (tv, Dd) => {
    const i = D.V('i_x', 'n');
    return pw([eq(idx(Dd, DD.FL), 1), TV0], [gt(idx(Dd, DD.TS), 0),
      D.comp(add(idx(tv, i), setAt(idx(tv, i), i, idx(Dd, DD.TS), idx(Dd, DD.TVPN))), i, It)], tv);
  });
  const Fnu = fl('F_nu', ['U', 'D'], (te, Dd) => {
    const i = D.V('i_x', 'n');
    const x = idx(te, i);
    return pw([eq(idx(Dd, DD.FL), 1), TE0], [gt(idx(Dd, DD.TS), 0),
      D.comp(add(add(x, setAt(x, i, idx(Dd, DD.TS), idx(Dd, DD.TENT))), setAt(x, i, NT + 1, idx(Dd, DD.TNP))), i, Iu)], te);
  });
  const Fna = fl('F_na', ['A', 'D'], (A, Dd) => pw([ge(idx(Dd, DD.SA), 0), join(A, list([idx(Dd, DD.SA)]))], A));
  const Fnv = fl('F_nv', ['V', 'D'], (V, Dd) => pw([ge(idx(Dd, DD.SA), 0), join(V, list([idx(Dd, DD.SV)]))], V));
  const Fno = fl('F_no', ['O', 'D'], (O, Dd) => pw([ge(idx(Dd, DD.OC), 0), join(O, list([idx(Dd, DD.OC)]))], O));

  // --------------------------------------------------------- batch loop
  // Packed layout: [len(A), len(O)] ++ S ++ T ++ U ++ A ++ V ++ O.
  const oS = 3, oT = oS + NS, oE = oT + NT, oA = oE + NT + 1;
  const Fpk = fl('F_pk', ['S', 'T', 'U', 'A', 'V', 'O'], (s, tv, te, A, V, O) => join(list([length(A), length(O)]), s, tv, te, A, V, O));
  // The batch loop. D is the descriptor of the step about to be applied to
  // (S, T, U, A, V, O). Each iteration applies it and computes the next one;
  // F_d appears exactly once so the compiled expression stays small.
  // The batch loop. D is the descriptor of the step about to be applied to
  // (S, T, U, A, V, O). F_d applies it to S/T/U and computes the next step;
  // its result is the next descriptor followed by the new S, T and U. The
  // base-case test reads all of it, so Desmos evaluates the step eagerly
  // (computed only in the recursive branch, it would be lazy closures), and
  // `with` keeps the step a single copy in the compiled expression.
  const Fd = fl('F_d', ['n', 'S', 'T', 'U', 'A', 'V', 'O', 'D'], (n, s, tv, te, A, V, O, Dd) =>
    P.let('F_dl', [['s_n', call(Fns, s, Dd)], ['t_n', call(Fnt, tv, Dd)], ['u_n', call(Fnu, te, Dd)]], (s2, t2, u2) =>
      join(call(Fstep, n, s2, t2, u2, A, V, O, idx(Dd, DD.SA), idx(Dd, DD.SV), idx(Dd, DD.OC)), s2, t2, u2)));
  const xS = [ND + 1, ND + NS], xT = [ND + NS + 1, ND + NS + NT], xU = [ND + NS + NT + 1, ND + NS + 2 * NT + 1];
  const Fg = fl('F_g', ['n', 'S', 'T', 'U', 'A', 'V', 'O', 'D'], (n, s, tv, te, A, V, O, Dd) => {
    const [x2, a2, v2, o2] = [['x_2', 'l'], ['a_2', 'l'], ['v_2', 'l'], ['o_2', 'l']].map(([nm, t]) => D.V(nm, t));
    const binds = [[x2, call(Fd, n, s, tv, te, A, V, O, Dd)], [a2, call(Fna, A, Dd)], [v2, call(Fnv, V, Dd)], [o2, call(Fno, O, Dd)]];
    const sl = r => slice(x2, r[0], r[1]);
    return D.withB(binds, pw([eq(add(idx(x2, DD.ACT), mul(0, total(x2))), 0), call(Fpk, sl(xS), sl(xT), sl(xU), a2, v2, o2)],
      call(Fg, sub(n, 1), sl(xS), sl(xT), sl(xU), a2, v2, o2, slice(x2, 1, ND))));
  });
  // Run one chain from a packed state.
  const Flg = fl('F_lg', ['S', 'T', 'U', 'A', 'V', 'O'], (s, tv, te, A, V, O) =>
    call(Fg, chain, s, tv, te, A, V, O, N0));
  const Flf = fl('F_lf', ['X', 'm', 'k'], (X, m, k) => call(Flg,
    slice(X, oS, oT - 1), slice(X, oT, oE - 1), slice(X, oE, oA - 1),
    slice(X, oA, add(oA - 1, m)), slice(X, add(oA, m), add(oA - 1, mul(2, m))), slice(X, add(oA, mul(2, m)), add(add(oA - 1, mul(2, m)), k))));
  // Outer loop: k more chains (stops early when the batch stops).
  const Fol = fl('F_ol', ['k', 'X'], (k, X) => pw(
    [le(k, 0), X], [gt(idx(X, oS - 1 + S.STOPF), 0), X], [gt(idx(X, 1), W), X], [gt(idx(X, 2), OM), X],
    call(Fol, sub(k, 1), call(Flf, X, idx(X, 1), idx(X, 2)))));

  // ------------------------------------------------------ commit helpers
  // Merge the write log (A = word indices, V = values; entry 1 is a dummy)
  // into page j: sort old words and log entries by (offset, log order) and
  // keep the last entry of every offset.
  const Kp = P.global('K_p', 'l', mul(range(0, PS - 1), W + 2));
  const Fmt = fl('F_mt', ['Y', 'Z'], (Y, Z) =>
    filter(Z, gt(join(slice(floor(div(Y, W + 2)), 2), list([PS + 1])), floor(div(Y, W + 2)))));
  const Fms = fl('F_ms', ['Y', 'Z'], (Y, Z) => call(Fmt, D.sort(Y), D.sort(Z, Y)));
  const Fmr = fl('F_mr', ['G', 'j', 'A', 'V', 'K'], (Pg, j, A, V, K) =>
    call(Fms, join(Kp, add(mul(sub(D.lidx(A, K), mul(j, PS)), W + 2), K)), join(Pg, D.lidx(V, K))));
  const Fmp = fl('F_mp', ['G', 'j', 'A', 'V'], (Pg, j, A, V) =>
    call(Fmr, Pg, j, A, V, filter(range(1, length(A)), eq(floor(div(A, PS)), j))));

  P.finish();
  return {
    prog: P, NP, NS, NT, layout: { oS, oT, oE, oA }, S,
    fns: { Fol, Fpk, Flf, Flg, Fg, Frd, Fld, Fmp },
    globals: { Is, It, Iu, Bp, TV0, TE0, Q, pages },
    cfg: { ...cfg, NP },
  };
}

module.exports = { build, S, NS, NT, ND, DD, K32, K31, RB, TIMECMP_INIT };
