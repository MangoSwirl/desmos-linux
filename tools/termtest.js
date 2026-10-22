#!/usr/bin/env node
// Check the DSL terminal emulator against a straightforward JS model.
'use strict';
const D = require('../desmos/dsl');
const { buildTerm, ROWS, COLS, NH } = require('../desmos/term');

function model(text) {
  let r = 0, c = 0, e = 0, p1 = 0, p0 = -1;
  const scr = new Array(ROWS * COLS).fill(32);
  const scroll = () => { scr.splice(0, COLS); for (let i = 0; i < COLS; i++) scr.push(32); };
  for (const ch of Buffer.from(text, 'latin1')) {
    if (e === 0) {
      if (ch >= 32 && ch <= 126) {
        if (c >= COLS) { c = 0; r++; if (r >= ROWS) { scroll(); r = ROWS - 1; } }
        scr[r * COLS + c] = ch; c++;
      } else if (ch === 10) { r++; if (r >= ROWS) { scroll(); r = ROWS - 1; } }
      else if (ch === 13) c = 0;
      else if (ch === 8) c = Math.max(Math.min(c, COLS - 1) - 1, 0);
      else if (ch === 9) c = Math.min(Math.floor(c / 8) * 8 + 8, COLS - 1);
      else if (ch === 27) e = 1;
    } else if (e === 1) { e = ch === 91 ? 2 : 0; p1 = 0; p0 = -1; }
    else {
      if (ch >= 48 && ch <= 57) p1 = p1 * 10 + ch - 48;
      else if (ch === 59) { p0 = p1; p1 = 0; }
      else if (ch >= 64 && ch <= 126) {
        const n = Math.max(p1, 1), cc = Math.min(c, COLS - 1), cur = r * COLS + cc;
        const blank = (lo, hi) => { for (let i = lo; i <= hi; i++) scr[i - 1] = 32; };
        switch (ch) {
          case 65: r = Math.max(r - n, 0); break;
          case 66: r = Math.min(r + n, ROWS - 1); break;
          case 67: c = Math.min(cc + n, COLS - 1); break;
          case 68: c = Math.max(cc - n, 0); break;
          case 72: case 102:
            if (p0 >= 0) { r = Math.min(Math.max(p0, 1) - 1, ROWS - 1); c = Math.min(n - 1, COLS - 1); }
            else { r = Math.min(n - 1, ROWS - 1); c = 0; }
            break;
          case 74: if (p1 === 2) blank(1, ROWS * COLS); else if (p1 === 0) blank(cur + 1, ROWS * COLS); break;
          case 75: if (p1 === 1) blank(r * COLS + 1, cur + 1); else if (p1 === 2) blank(r * COLS + 1, (r + 1) * COLS); else blank(cur + 1, (r + 1) * COLS); break;
        }
        e = 0; p1 = 0; p0 = -1;
      }
    }
  }
  return [r, c, e, p1, p0, ...scr];
}

const P = new D.Program();
const t = buildTerm(P);
P.finish();
const js = D.compileJS(P)({});
const init = [0, 0, 0, 0, -1, ...new Array(ROWS * COLS).fill(32)];
const cases = [
  'hello world\r\n',
  'abc\bX\tY\r\n' + 'x'.repeat(85) + '\r\n',
  Array.from({ length: 30 }, (_, i) => `line ${i}\r\n`).join(''),
  'prompt$ ls\r\n\x1b[2J\x1b[Hcleared\x1b[5;10Hat\x1b[K\r\n\x1b[1Aup\x1b[3Cright\x1b[2Dleft\x1b[0mreset',
  'x'.repeat(80) + 'y' + '\x1b[?2004h' + 'z\x1b[1K!',
];
let ok = true;
for (const text of cases) {
  const O = [-1, ...Buffer.from(text, 'latin1')];
  const got = js.get.F_tm()(2, init, O);
  const want = model(text);
  const bad = want.findIndex((v, i) => v !== got[i]);
  if (bad >= 0 || got.length !== want.length) {
    ok = false;
    console.log('MISMATCH for', JSON.stringify(text), 'at', bad, 'got', got[bad], 'want', want[bad], 'lens', got.length, want.length);
  }
}
const show = st => { const s = st.slice(NH); for (let r = 0; r < ROWS; r++) { const line = String.fromCharCode(...s.slice(r * COLS, (r + 1) * COLS)).trimEnd(); if (line) console.log('|' + line); } };
show(js.get.F_tm()(2, init, [-1, ...Buffer.from(cases[3], 'latin1')]));
console.log(ok ? 'terminal OK' : 'terminal FAILED');
