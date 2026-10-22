// Terminal emulator (VT100 subset) written in the expression DSL.
//
// State M = [row, col, esc, p1, p0] ++ screen, where screen holds ROWS*COLS
// character codes (32 = blank), row/col are 0-based, col may equal COLS
// (pending wrap), esc is 0 normal / 1 after ESC / 2 inside CSI, p1 is the
// CSI parameter being parsed and p0 the previous one (-1 if none).
'use strict';
const D = require('./dsl');
const { add, sub, mul, div, mod, floor, max, min, length, join, eq, lt, gt, le, ge, pw, list, range, idx, slice, call } = D;

const ROWS = 24, COLS = 80, NH = 5;

function buildTerm(P) {
  const NC = ROWS * COLS;
  const fl = (name, ps, body) => { const d = P.func(name, ps.map(p => [p, p.length === 1 && p === p.toUpperCase() ? 'l' : 'n']), null, body); d.ret = 'l'; return d; };
  const Ic = P.global('I_c', 'l', range(1, NC));
  const BL = P.global('B_l', 'l', mul(0, range(1, COLS)));
  const sgn = x => D.fn('sign', x);
  // 1 where lo <= I <= hi (I integer), else 0
  const inRange = (I, lo, hi) => mul(div(add(sgn(sub(add(I, 0.5), lo)), 1), 2), div(add(sgn(sub(add(hi, 0.5), I)), 1), 2));
  const delta = (I, q) => sub(1, sgn(D.fn('abs', sub(I, q))));

  // Screen ops: optional scroll (k=1), then optional put of ch at 1-based
  // index pos (pos=0: none), then optional blanking of [lo, hi] (lo>hi: none).
  const Fsc = fl('F_tz', ['C', 'k', 'p', 'h', 'l', 'u'], (C, k, pos, ch, lo, hi) => {
    const s1 = pw([eq(k, 1), join(slice(C, COLS + 1), add(BL, 32))], C);
    return call(Fsc2, s1, pos, ch, lo, hi);
  });
  const Fsc2 = fl('F_ty', ['C', 'p', 'h', 'l', 'u'], (C, pos, ch, lo, hi) => {
    const s2 = pw([gt(pos, 0), add(C, mul(delta(Ic, pos), sub(ch, C)))], C);
    return pw([le(lo, hi), add(s2, mul(inRange(Ic, lo, hi), sub(32, s2)))], s2);
  });

  // One character x applied to terminal state M.
  const Ftc = fl('F_tc', ['M', 'x'], (M, x) => call(Ftc2, slice(M, NH + 1), idx(M, 1), idx(M, 2), idx(M, 3), idx(M, 4), idx(M, 5), x));
  const Ftc2 = fl('F_tb', ['C', 'r', 'c', 'e', 'p', 'q', 'x'], (C, r, c, e, p1, p0, x) => {
    const last = ROWS - 1;
    const pr = pw([ge(x, 32), pw([le(x, 126), 1], 0)], 0); // printable
    const n1 = max(p1, 1);
    // ---- normal state
    const wrap = pw([eq(pr, 1), pw([ge(c, COLS), 1], 0)], 0);
    const rw = add(r, wrap); // row after a pending wrap
    const nlRow = pw([eq(x, 10), add(r, 1)], rw);
    const scroll = pw([gt(nlRow, last), 1], 0);
    const r0 = min(nlRow, last);
    const c0 = pw([eq(x, 13), 0], [eq(x, 8), max(sub(min(c, COLS - 1), 1), 0)],
      [eq(x, 9), min(add(mul(floor(div(c, 8)), 8), 8), COLS - 1)],
      [eq(pr, 1), add(pw([eq(wrap, 1), 0], c), 1)], c);
    const putPos = pw([eq(pr, 1), add(add(mul(r0, COLS), pw([eq(wrap, 1), 0], c)), 1)], 0);
    const st0 = join(list([r0, c0, pw([eq(x, 27), 1], 0), 0, -1]), call(Fsc, C, scroll, putPos, x, 1, 0));
    // ---- after ESC
    const st1 = join(list([r, c, pw([eq(x, 91), 2], 0), 0, -1]), C);
    // ---- inside CSI
    const isDigit = pw([ge(x, 48), pw([le(x, 57), 1], 0)], 0);
    const fin = pw([ge(x, 64), pw([le(x, 126), 1], 0)], 0);
    const cc = min(c, COLS - 1);
    const cur = add(mul(r, COLS), cc); // 0-based cursor index
    const hr = pw([ge(p0, 0), sub(max(p0, 1), 1)], sub(n1, 1));
    const hc = pw([ge(p0, 0), sub(n1, 1)], 0);
    const nr = pw([eq(x, 65), max(sub(r, n1), 0)], [eq(x, 66), min(add(r, n1), last)],
      [eq(x, 72), min(hr, last)], [eq(x, 102), min(hr, last)], r);
    const nc = pw([eq(x, 67), min(add(cc, n1), COLS - 1)], [eq(x, 68), max(sub(cc, n1), 0)],
      [eq(x, 72), min(hc, COLS - 1)], [eq(x, 102), min(hc, COLS - 1)], c);
    // erase range (1-based, inclusive)
    const lo = pw([eq(x, 74), pw([eq(p1, 2), 1], [eq(p1, 0), add(cur, 1)], 1)],
      [eq(x, 75), pw([eq(p1, 1), add(mul(r, COLS), 1)], [eq(p1, 2), add(mul(r, COLS), 1)], add(cur, 1))], 1);
    const hi = pw([eq(x, 74), pw([eq(p1, 2), NC], [eq(p1, 0), NC], 0)],
      [eq(x, 75), pw([eq(p1, 1), add(cur, 1)], mul(add(r, 1), COLS))], 0);
    const st2 = pw(
      [eq(isDigit, 1), join(list([r, c, 2, add(mul(p1, 10), sub(x, 48)), p0]), C)],
      [eq(x, 59), join(list([r, c, 2, 0, p1]), C)],
      [eq(fin, 1), join(list([nr, nc, 0, 0, -1]), call(Fsc, C, 0, 0, 0, lo, hi))],
      join(list([r, c, 2, p1, p0]), C));
    return pw([eq(e, 0), st0], [eq(e, 1), st1], st2);
  });
  // Apply output chars O[k...] (O[1] is a dummy) to M. Self tail recursion.
  const Ftm = fl('F_tm', ['k', 'M', 'O'], (k, M, O) =>
    pw([gt(k, length(O)), M], call(Ftm, add(k, 1), call(Ftc, M, idx(O, k)), O)));
  return { Ftm, Ftc, ROWS, COLS, NH };
}

module.exports = { buildTerm, ROWS, COLS, NH };
