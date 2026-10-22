// Assemble the complete Desmos graph: machine state, CPU, RAM, terminal,
// keyboard, display and the ticker action that drives everything.
'use strict';
const D = require('./dsl');
const CPU = require('./cpu');
const { buildTerm, ROWS, COLS, NH } = require('./term');
const { buildFont } = require('./font');

// Initial CPU state list.
function initialState({ pc, a0 = 0, a1 = 0 }) {
  const s = new Array(CPU.NS).fill(0);
  const S = CPU.S;
  s[10] = a0; // x10 lives at 1-based index 11
  s[11] = a1;
  s[S.PC - 1] = pc;
  s[S.PRIV - 1] = 1;
  s[S.TIMECMP - 1] = CPU.TIMECMP_INIT;
  s[S.RESV - 1] = -1;
  return s;
}

const num = v => (Number.isNaN(v) ? '\\frac{0}{0}' : String(v));
const listTex = a => `\\left[${a.map(num).join(',')}\\right]`;
const L = String.raw;

function pageLatex(name, words, j, PS) {
  const chunk = words.subarray(j * PS, (j + 1) * PS);
  let nz = false;
  for (let i = 0; i < chunk.length; i++) if (chunk[i]) { nz = true; break; }
  const body = nz ? listTex(Array.from(chunk)) : `0\\cdot\\left[1...${PS}\\right]`;
  return `${D.texName(name)}=${body}`;
}

// ------------------------------------------------------------------ keyboard
// [legend, normal code, shifted code, width] ; codes < 0 are special keys.
const SPECIAL = { ESC: -1, BKSP: -2, TAB: -3, CTRL: -4, ENTER: -5, SHIFT: -6, SPACE: -7, UP: -8, DOWN: -9, LEFT: -10, RIGHT: -11, CTRLC: -12 };
const ch = (n, s) => [n, n.charCodeAt(0), (s || n).charCodeAt(0), 1];
const KEY_ROWS = [
  [['Esc', SPECIAL.ESC, 0, 1.2], ch('`', '~'), ch('1', '!'), ch('2', '@'), ch('3', '#'), ch('4', '$'), ch('5', '%'), ch('6', '^'), ch('7', '&'), ch('8', '*'), ch('9', '('), ch('0', ')'), ch('-', '_'), ch('=', '+'), ['Bksp', SPECIAL.BKSP, 0, 1.8]],
  [['Tab', SPECIAL.TAB, 0, 1.5], ...'qwertyuiop'.split('').map(c => ch(c, c.toUpperCase())), ch('[', '{'), ch(']', '}'), ch('\\', '|'), ['^C', SPECIAL.CTRLC, 0, 1.5]],
  [['Ctrl', SPECIAL.CTRL, 0, 1.8], ...'asdfghjkl'.split('').map(c => ch(c, c.toUpperCase())), ch(';', ':'), ch("'", '"'), ['Enter', SPECIAL.ENTER, 0, 2.2]],
  [['Shift', SPECIAL.SHIFT, 0, 2.3], ...'zxcvbnm'.split('').map(c => ch(c, c.toUpperCase())), ch(',', '<'), ch('.', '>'), ch('/', '?'), ['Up', SPECIAL.UP, 0, 1.2]],
  [['Space', SPECIAL.SPACE, 0, 9], ['Left', SPECIAL.LEFT, 0, 1.4], ['Down', SPECIAL.DOWN, 0, 1.4], ['Right', SPECIAL.RIGHT, 0, 1.4]],
];

function layoutKeys({ x0, y0, unit, keyH, gap }) {
  const keys = [];
  KEY_ROWS.forEach((row, r) => {
    const total = row.reduce((s, k) => s + k[3], 0) * unit;
    let x = x0 + (80 - total) / 2;
    for (const [legend, normal, shifted, w] of row) {
      keys.push({ legend, normal, shifted, x, y: y0 - r * (keyH + gap), w: w * unit - gap, h: keyH });
      x += w * unit;
    }
  });
  return keys;
}

// Static stroke text (for special-key legends): points with NaN pen-ups.
function strokeText(font, text, x, y, size) {
  const xs = [], ys = [];
  [...text].forEach((c, i) => {
    const g = c.charCodeAt(0) - 32;
    for (let k = 0; k < font.K; k++) {
      const fx = font.FX[g * font.K + k], fy = font.FY[g * font.K + k];
      if (Number.isNaN(fx)) { if (xs.length && !Number.isNaN(xs[xs.length - 1])) { xs.push(NaN); ys.push(NaN); } continue; }
      xs.push(+(x + (i + fx) * size).toFixed(3)); ys.push(+(y + fy * size).toFixed(3));
    }
  });
  return { xs, ys };
}

// ------------------------------------------------------------------- graph
function buildGraph({ cfg, words, boot, title = 'GNU/Linux on Desmos' }) {
  const prog = new D.Program();
  const cpu = CPU.build(cfg, prog);
  const { NP, NS, NT } = cpu;
  const PS = cfg.pageWords;
  const { oS, oT, oE, oA } = cpu.layout;
  const font = buildFont({ eps: 1.0 });
  const K = font.K;

  const ex = [];
  let n = 0;
  const id = p => `${p}${n++}`;
  // Everything outside the Display folder is hidden: Desmos would otherwise
  // plot helper functions of one variable as curves.
  const expr = (latex, more = {}) => {
    const e = { type: 'expression', id: id('e'), latex, ...more };
    if (e.folderId !== fDispId) e.hidden = true;
    ex.push(e); return e;
  };
  let fDispId = null;
  const text = (t, more = {}) => ex.push({ type: 'text', id: id('t'), text: t, ...more });
  const folder = (t, collapsed = true) => { const fid = id('f'); ex.push({ type: 'folder', id: fid, title: t, collapsed }); return fid; };
  const hidden = { hidden: true };

  // --------------------------------------------------------------- intro
  text(`${title}\n\nA RISC-V (RV32IMA, Sv32 MMU) computer built entirely from Desmos expressions, running the Linux kernel ` +
    `with GNU bash, GNU coreutils and the GNU C library.\n\nPress the ▶ play button on the ticker (top of this list) to power on. ` +
    `Booting to a shell prompt takes over an hour; the console shows kernel messages as they arrive. ` +
    `Type with the on-screen keyboard below the terminal (Shift and Ctrl apply to the next key).\n\n` +
    `How it works: each tick, the ticker action A_t runs thousands of CPU steps through a recursive Desmos function. Memory stores ` +
    `go to a write log, which A_t then merges into the RAM page lists (folder "RAM"). The console is an SBI firmware call ` +
    `implemented by the CPU; its output feeds a VT100-style terminal emulator, drawn with a Hershey vector font.`);

  // ------------------------------------------------------------- display
  const fDisp = folder('Display', false);
  fDispId = fDisp;
  // terminal background and cursor
  expr(L`\operatorname{polygon}\left(\left(-1,1\right),\left(81,1\right),\left(81,-49\right),\left(-1,-49\right)\right)`,
    { folderId: fDisp, color: '#111111', fillOpacity: '1', lineOpacity: '0' });
  expr(L`\operatorname{polygon}\left(\left(c_{x},-2r_{y}-1.75\right),\left(c_{x}+1,-2r_{y}-1.75\right),\left(c_{x}+1,-2r_{y}-0.15\right),\left(c_{x},-2r_{y}-0.15\right)\right)`,
    { folderId: fDisp, color: '#38c172', fillOpacity: '0.45', lineOpacity: '0' });
  expr(L`c_{x}=\min\left(M_{t}\left[2\right],79\right)`, { folderId: fDisp });
  expr(L`r_{y}=M_{t}\left[1\right]`, { folderId: fDisp });
  // one point list per terminal row; undefined points lift the pen
  expr(L`R_{w}\left(j\right)=\left[\left(b-1+F_{x}\left[\left(M_{t}\left[${NH}+${COLS}j+b\right]-32\right)\cdot ${K}+a\right],-2j-2+F_{y}\left[\left(M_{t}\left[${NH}+${COLS}j+b\right]-32\right)\cdot ${K}+a\right]\right)\operatorname{for}a=\left[1...${K}\right],b=\left[1...${COLS}\right]\left[M_{t}\left[${NH}+${COLS}j+\left[1...${COLS}\right]\right]>32\right]\right]`, { folderId: fDisp });
  for (let r = 0; r < ROWS; r++) {
    expr(L`R_{w}\left(${r}\right)`, { folderId: fDisp, color: '#5ee08a', lines: true, points: false, lineWidth: '1.6' });
  }
  // keyboard
  const keys = layoutKeys({ x0: 0, y0: -53, unit: 5.2, keyH: 4, gap: 0.5 });
  const kx = keys.map(k => +k.x.toFixed(3)), ky = keys.map(k => +k.y.toFixed(3)), kw = keys.map(k => +k.w.toFixed(3));
  expr(`K_{x}=${listTex(kx)}`, { folderId: fDisp });
  expr(`K_{y}=${listTex(ky)}`, { folderId: fDisp });
  expr(`K_{w}=${listTex(kw)}`, { folderId: fDisp });
  expr(`K_{n}=${listTex(keys.map(k => k.normal))}`, { folderId: fDisp });
  expr(`K_{s}=${listTex(keys.map(k => k.shifted))}`, { folderId: fDisp });
  const keyAction = L`Q\to\operatorname{join}\left(Q,G_{ky}\left(\operatorname{index}\right)\right),s_{h}\to G_{kh}\left(\operatorname{index}\right),c_{t}\to G_{kc}\left(\operatorname{index}\right)`;
  expr(L`\operatorname{polygon}\left(\left(K_{x},K_{y}\right),\left(K_{x}+K_{w},K_{y}\right),\left(K_{x}+K_{w},K_{y}+4\right),\left(K_{x},K_{y}+4\right)\right)`,
    { folderId: fDisp, color: '#4a5568', fillOpacity: '0.35', lineWidth: '1', clickableInfo: { enabled: true, latex: keyAction } });
  // modifier highlight
  expr(L`\operatorname{polygon}\left(\left(K_{x}\left[k_{m}\right],K_{y}\left[k_{m}\right]\right),\left(K_{x}\left[k_{m}\right]+K_{w}\left[k_{m}\right],K_{y}\left[k_{m}\right]\right),\left(K_{x}\left[k_{m}\right]+K_{w}\left[k_{m}\right],K_{y}\left[k_{m}\right]+4\right),\left(K_{x}\left[k_{m}\right],K_{y}\left[k_{m}\right]+4\right)\right)`,
    { folderId: fDisp, color: '#f6ad55', fillOpacity: '0.6', lineOpacity: '0' });
  const shiftIdx = keys.findIndex(k => k.normal === SPECIAL.SHIFT) + 1, ctrlIdx = keys.findIndex(k => k.normal === SPECIAL.CTRL) + 1;
  expr(L`k_{m}=\left[\left\{s_{h}=1:${shiftIdx}\right\},\left\{c_{t}=1:${ctrlIdx}\right\}\right]`, { folderId: fDisp });
  // character legends follow the shift state
  expr(L`K_{l}=\left\{s_{h}=1:K_{s},K_{n}\right\}`, { folderId: fDisp });
  expr(L`\left[\left(K_{x}\left[b\right]+0.5K_{w}\left[b\right]-0.8+1.6F_{x}\left[\left(K_{l}\left[b\right]-32\right)\cdot ${K}+a\right],K_{y}\left[b\right]+0.5+1.6F_{y}\left[\left(K_{l}\left[b\right]-32\right)\cdot ${K}+a\right]\right)\operatorname{for}a=\left[1...${K}\right],b=\left[1...${keys.length}\right]\left[K_{n}>32\right]\right]`,
    { folderId: fDisp, color: '#e2e8f0', lines: true, points: false, lineWidth: '1.5' });
  // special-key legends are static
  const sx = [], sy = [];
  for (const k of keys) {
    if (k.normal >= 0) continue;
    const size = 0.9;
    const t = strokeText(font, k.legend, k.x + k.w / 2 - k.legend.length * size / 2, k.y + 1.1, size);
    sx.push(...t.xs, NaN); sy.push(...t.ys, NaN);
  }
  expr(`\\left(${listTex(sx)},${listTex(sy)}\\right)`, { folderId: fDisp, color: '#e2e8f0', lines: true, points: false, lineWidth: '1.3' });
  // status line (a zero-size point: Desmos doesn't draw labels of points with opacity 0)
  expr(L`\left(-1,2.2\right)`, { folderId: fDisp, color: '#000000', showLabel: true, hidden: false, pointSize: '0', label: `\${n_{m}} million instructions, uptime \${u_{p}} s, \${t_{k}} ticks`, labelOrientation: 'right', labelSize: '1.2' });
  expr(L`n_{m}=\operatorname{round}\left(\frac{S\left[46\right]}{10^{6}},2\right)`, { folderId: fDisp });
  expr(L`u_{p}=\operatorname{round}\left(\frac{S\left[44\right]}{10^{7}},1\right)`, { folderId: fDisp });

  // ------------------------------------------------------------ controls
  const fCtl = folder('Controls', false);
  expr(L`k_{o}=${cfg.outer}`, { folderId: fCtl, slider: { hardMin: true, hardMax: true, min: '1', max: '20', step: '1' } });
  text(`k_o = chains of ${cfg.chain} CPU steps per tick. Raise it for more speed if your computer keeps up; lower it if the page becomes unresponsive.`, { folderId: fCtl });

  // ------------------------------------------------------- machine state
  const fState = folder('Machine state');
  expr(`S=${listTex(initialState(boot))}`, { folderId: fState });
  expr(`T_{v}=${listTex(new Array(NT).fill(-1))}`, { folderId: fState });
  expr(`T_{e}=${listTex(new Array(NT + 1).fill(0))}`, { folderId: fState });
  expr(L`Q=\left[\right]`, { folderId: fState });
  expr(`M_{t}=${listTex([0, 0, 0, 0, -1, ...new Array(ROWS * COLS).fill(32)])}`, { folderId: fState });
  expr(L`s_{h}=0`, { folderId: fState });
  expr(L`c_{t}=0`, { folderId: fState });
  expr(L`t_{k}=0`, { folderId: fState });

  // ---------------------------------------------------- batch + commit
  const fRun = folder('Batch execution and commit');
  // The tick: A_t runs a batch of CPU steps and hands the packed result X to
  // the action function A_u, which commits it. The batch must be referenced by
  // exactly one statement: Desmos constant-folds every statement that uses a
  // batch-valued expression, so each extra consumer would rerun the CPU.
  const xs = (a, b) => `X\\left[${a}...${b}\\right]`;
  expr(L`G_{xm}\left(X\right)=X\left[1\right]`, { folderId: fRun });
  expr(L`G_{xk}\left(X\right)=X\left[2\right]`, { folderId: fRun });
  expr(L`G_{xy}\left(X\right)=X\left[3\right]`, { folderId: fRun });
  // the packed write log (one number per entry, see F_pk) and its decoding
  expr(L`G_{xc}\left(X\right)=\left\{G_{xm}\left(X\right)>0:X\left[${oA}...${oA - 1}+G_{xm}\left(X\right)\right],\left[\right]\right\}`, { folderId: fRun });
  expr(L`G_{la}\left(X\right)=F_{xa}\left(G_{xc}\left(X\right),G_{yd}\left(X\right)\right)`, { folderId: fRun });
  expr(L`G_{lw}\left(X\right)=F_{xv}\left(G_{xc}\left(X\right)\right)`, { folderId: fRun });
  expr(L`G_{or}\left(X\right)=X\left[${oA}+G_{xm}\left(X\right)...${oA - 1}+G_{xm}\left(X\right)+G_{xk}\left(X\right)\right]`, { folderId: fRun });
  // pages written by the batch (entry 1 is a dummy)
  expr(L`G_{yd}\left(X\right)=X\left[${oA}+G_{xm}\left(X\right)+G_{xk}\left(X\right)...${oA - 1}+G_{xm}\left(X\right)+G_{xk}\left(X\right)+G_{xy}\left(X\right)\right]`, { folderId: fRun });
  // new CPU state: clear the stop flag (except "halted", 6) and the fence.i flag
  expr(L`G_{sn}\left(X\right)=G_{sm}\left(${xs(oS, oT - 1)}\right)`, { folderId: fRun });
  expr(L`G_{sm}\left(R\right)=R-\left(1-\operatorname{sign}\left(\left|I_{s}-${CPU.S.STOPF}\right|\right)\right)\cdot\left(R\left[${CPU.S.STOPF}\right]-\left\{R\left[${CPU.S.STOPF}\right]=6:6,0\right\}\right)-\left(1-\operatorname{sign}\left(\left|I_{s}-${CPU.S.FI}\right|\right)\right)\cdot R\left[${CPU.S.FI}\right]`, { folderId: fRun });
  // Dirty pages go through DS * DW slots: page j uses one of the DW slots of
  // set mod(j, DS), in the order the batch first wrote them.
  const DS = cfg.dirtySets, DW = cfg.dirtyWays;
  expr(L`G_{yp}\left(Y\right)=Y\left[Y\ge 0\right]`, { folderId: fRun });
  expr(L`G_{yt}\left(s,Z\right)=Z\left[\operatorname{mod}\left(Z,${DS}\right)=s\right]`, { folderId: fRun });
  // w-th written page of set s, or undefined
  expr(L`G_{ez}\left(w,Z\right)=\left\{\operatorname{length}\left(Z\right)\ge w:Z\left[w\right]\right\}`, { folderId: fRun });
  expr(L`G_{es}\left(w,s,Y\right)=G_{ez}\left(w,G_{yt}\left(s,G_{yp}\left(Y\right)\right)\right)`, { folderId: fRun });
  // The words of page p written by the batch (last write wins), -1 elsewhere.
  // It's computed from the log alone: Desmos constant-folds every slot while
  // analyzing the tick, and looking the page up would copy all RAM pages into
  // every slot's compiled code.
  expr(L`G_{sk}\left(p,A,V\right)=\left\{p\ge 0:F_{mp}\left(0K_{p}-1,p,A,V\right),\left[0\right]\right\}`, { folderId: fRun });
  // apply a slot to a page
  expr(L`G_{ap}\left(P,W\right)=P+\left(W-P\right)\operatorname{sign}\left(W+1\right)`, { folderId: fRun });
  // one action group per set: slot W_w goes to P_j if it is the set's w-th page
  const ways = Array.from({ length: DW }, (_, w) => w + 1);
  const wParams = ways.map(w => `W_{${w}}`).concat(ways.map(w => `e_{${w}}`)).join(',');
  const groupCalls = [], slots = [];
  for (let st = 0; st < DS; st++) {
    const parts = [];
    for (let j = st; j < NP; j += DS) parts.push(`\\left\\{${ways.map(w => `e_{${w}}=${j}:P_{${j}}\\to G_{ap}\\left(P_{${j}},W_{${w}}\\right)`).join(',')}\\right\\}`);
    expr(`A_{q${st}}\\left(${wParams}\\right)=${parts.join(',')}`, { folderId: fRun });
    const sl = ways.map(w => `W_{${st * DW + w}}`), es = ways.map(w => `G_{es}\\left(${w},${st},Y\\right)`);
    groupCalls.push(`A_{q${st}}\\left(${sl.concat(es).join(',')}\\right)`);
    slots.push(...ways.map(w => `G_{sk}\\left(G_{es}\\left(${w},${st},Y\\right),A,V\\right)`));
  }
  // A_v receives every slot once (as arguments: a `with` this long doesn't parse)
  const allW = Array.from({ length: DS * DW }, (_, k) => `W_{${k + 1}}`).join(',');
  expr(`A_{v}\\left(${allW},Y\\right)=${groupCalls.join(',')}`, { folderId: fRun });
  expr(`A_{w}\\left(A,V,Y\\right)=A_{v}\\left(${slots.join(',')},Y\\right)`, { folderId: fRun });
  expr(L`A_{u}\left(X\right)=S\to G_{sn}\left(X\right),T_{v}\to ${xs(oT, oE - 1)},T_{e}\to ${xs(oE, oA - 1)},M_{t}\to F_{tm}\left(2,M_{t},G_{or}\left(X\right)\right),t_{k}\to t_{k}+1,A_{w}\left(G_{la}\left(X\right),G_{lw}\left(X\right),G_{yd}\left(X\right)\right)`, { folderId: fRun });
  expr(L`A_{t}=A_{u}\left(F_{ol}\left(k_{o},F_{pk}\left(S,T_{v},T_{e},\left[-1\right],\left[0\right],\left[-1\right],\left[-1\right]\right)\right)\right)`, { folderId: fRun });

  // keyboard actions
  const fKey = folder('Keyboard');
  // F_ky: codes sent for key i (up to 3; -1 padding is dropped)
  expr(L`G_{ky}\left(i\right)=G_{kp}\left(G_{kz}\left(K_{n}\left[i\right],\left\{s_{h}=1:K_{s}\left[i\right],K_{n}\left[i\right]\right\}\right)\right)`, { folderId: fKey });
  expr(L`G_{kp}\left(C\right)=C\left[C\ge 0\right]`, { folderId: fKey });
  const spec = (code, l) => `k=${code}:\\left[${[...l, -1, -1, -1].slice(0, 3).join(',')}\\right]`;
  expr(L`G_{kz}\left(k,c\right)=\left\{${[
    spec(SPECIAL.ESC, [27]), spec(SPECIAL.BKSP, [127]), spec(SPECIAL.TAB, [9]), spec(SPECIAL.ENTER, [13]),
    spec(SPECIAL.SPACE, [32]), spec(SPECIAL.UP, [27, 91, 65]), spec(SPECIAL.DOWN, [27, 91, 66]),
    spec(SPECIAL.RIGHT, [27, 91, 67]), spec(SPECIAL.LEFT, [27, 91, 68]), spec(SPECIAL.CTRLC, [3]),
    `k<0:\\left[-1,-1,-1\\right]`,
  ].join(',')},\left[\left\{c_{t}=1:\left\{c>63:\operatorname{mod}\left(c,32\right),c\right\},c\right\},-1,-1\right]\right\}`, { folderId: fKey });
  expr(L`G_{kh}\left(i\right)=\left\{K_{n}\left[i\right]=${SPECIAL.SHIFT}:1-s_{h},K_{n}\left[i\right]=${SPECIAL.CTRL}:s_{h},0\right\}`, { folderId: fKey });
  expr(L`G_{kc}\left(i\right)=\left\{K_{n}\left[i\right]=${SPECIAL.CTRL}:1-c_{t},K_{n}\left[i\right]=${SPECIAL.SHIFT}:c_{t},0\right\}`, { folderId: fKey });

  // font
  const fFont = folder('Font (Hershey simplex)');
  expr(`F_{x}=${listTex(font.FX)}`, { folderId: fFont });
  expr(`F_{y}=${listTex(font.FY)}`, { folderId: fFont });

  // CPU + terminal definitions
  buildTerm(prog);
  prog.finish();
  const fCpu = folder('CPU (RV32IMA + Sv32) and terminal emulator');
  for (const d of prog.defs) {
    if (d.kind === 'func') expr(D.defLatex(d), { folderId: fCpu });
    else if (typeof d.value !== 'string') expr(D.defLatex(d), { folderId: fCpu });
  }

  // RAM
  const fRam = folder(`RAM (${NP} pages of ${PS} words)`);
  for (let j = 0; j < NP; j++) expr(pageLatex(`P_${j}`, words, j, PS), { folderId: fRam });

  // Every name must be defined once (Desmos rejects duplicates).
  const seen = new Map();
  for (const e of ex) {
    const m = e.latex && /^([A-Za-z](?:_\{[A-Za-z0-9]+\})?)(?:\\left\([A-Za-z0-9_{},]*\\right\))?=/.exec(e.latex);
    if (!m) continue;
    if (seen.has(m[1])) throw new Error(`duplicate definition of ${m[1]}`);
    seen.set(m[1], e.id);
  }
  const state = {
    version: 11,
    graph: {
      viewport: { xmin: -5, ymin: -78.25, xmax: 85, ymax: 6.75 },
      showGrid: false, showXAxis: false, showYAxis: false, xAxisNumbers: false, yAxisNumbers: false, squareAxes: true,
    },
    expressions: { list: ex, ticker: { handlerLatex: 'A_{t}', minStepLatex: '0', open: true, playing: false } },
  };
  return { state, cpu };
}

module.exports = { buildGraph, initialState };
