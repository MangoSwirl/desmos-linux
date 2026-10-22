// Vector font for the terminal, from the Hershey "simplex" font
// (assets/font/futural.jhf; Hershey fonts are free to use, see assets/font/README).
//
// Each printable ASCII glyph (32..126) becomes up to K points; pen-ups and
// padding are NaN (undefined in Desmos), which breaks a connected point list.
// Coordinates are in cell units: x in [0, 1] (cell width 1), y in [0, 2]
// (cell height 2, y up).
'use strict';
const fs = require('fs');
const path = require('path');

function parseJhf(file) {
  const glyphs = [];
  for (const line of fs.readFileSync(file, 'latin1').split('\n')) {
    if (/^\s*\d+\s*\d+/.test(line.slice(0, 8)) && line.length >= 10) glyphs.push(line);
    else if (glyphs.length && line.length) glyphs[glyphs.length - 1] += line;
  }
  return glyphs.map(g => {
    const body = g.slice(8);
    const L = body.charCodeAt(0) - 82, R = body.charCodeAt(1) - 82;
    const strokes = [[]];
    for (let k = 2; k + 1 < body.length; k += 2) {
      if (body.slice(k, k + 2) === ' R') { strokes.push([]); continue; }
      strokes[strokes.length - 1].push([body.charCodeAt(k) - 82, body.charCodeAt(k + 1) - 82]);
    }
    return { L, R, strokes: strokes.filter(s => s.length) };
  });
}

// Douglas-Peucker polyline simplification.
function simplify(pts, eps) {
  if (pts.length < 3) return pts;
  const [p0, pn] = [pts[0], pts[pts.length - 1]];
  if (p0[0] === pn[0] && p0[1] === pn[1]) { // closed loop: split at the farthest point
    let far = 1, fd = -1;
    for (let i = 1; i < pts.length - 1; i++) {
      const d = Math.hypot(pts[i][0] - p0[0], pts[i][1] - p0[1]);
      if (d > fd) { fd = d; far = i; }
    }
    return [...simplify(pts.slice(0, far + 1), eps).slice(0, -1), ...simplify(pts.slice(far), eps)];
  }
  const [a, b] = [pts[0], pts[pts.length - 1]];
  const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
  let best = -1, bi = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs(dy * (pts[i][0] - a[0]) - dx * (pts[i][1] - a[1])) / len;
    if (d > best) { best = d; bi = i; }
  }
  if (best <= eps) return [a, b];
  return [...simplify(pts.slice(0, bi + 1), eps).slice(0, -1), ...simplify(pts.slice(bi), eps)];
}

function buildFont({ eps = 0.8 } = {}) {
  const glyphs = parseJhf(path.join(__dirname, '../assets/font/futural.jhf'));
  const out = glyphs.map((g, i) => {
    const cx = (g.L + g.R) / 2;
    const pts = [];
    const tail = i === ','.charCodeAt(0) - 32 || i === ';'.charCodeAt(0) - 32; // too short to see at screen size
    for (const s of g.strokes) {
      const sp = simplify(s, eps);
      sp.forEach(([x, y], k) => {
        const ty = tail && k === sp.length - 1 && y > 4 ? y + (y - 4) * 0.8 : y;
        pts.push([(x - cx) / 26 + 0.5, 1.0 - ty * 0.05]);
      });
      pts.push(null);
    }
    return pts;
  });
  const K = Math.max(...out.map(p => p.length));
  const FX = [], FY = [];
  for (const pts of out) {
    for (let k = 0; k < K; k++) {
      const p = pts[k];
      FX.push(p ? +p[0].toFixed(3) : NaN);
      FY.push(p ? +p[1].toFixed(3) : NaN);
    }
  }
  return { K, FX, FY, count: out.length };
}

module.exports = { buildFont };

if (require.main === module) {
  const f = buildFont();
  console.log('K =', f.K, 'glyphs =', f.count, 'points =', f.FX.length);
}
