// Assemble a complete Desmos graph state from the CPU program and a RAM image.
'use strict';
const D = require('./dsl');
const CPU = require('./cpu');

// Initial CPU state list.
function initialState({ pc, a0 = 0, a1 = 0 }) {
  const s = new Array(CPU.NS).fill(0);
  const S = CPU.S;
  s[10 + 0] = a0; // x10 at index 11 (1-based) -> 10 (0-based)
  s[11 + 0] = a1;
  s[S.PC - 1] = pc;
  s[S.PRIV - 1] = 1;
  s[S.TIMECMP - 1] = CPU.TIMECMP_INIT;
  s[S.RESV - 1] = -1;
  return s;
}

const listTex = a => `\\left[${a.join(',')}\\right]`;

// words: Uint32Array of RAM contents (length = ramSize/4).
function pageLatex(name, words, j, PS) {
  const chunk = words.subarray(j * PS, (j + 1) * PS);
  let nz = false;
  for (let i = 0; i < chunk.length; i++) if (chunk[i]) { nz = true; break; }
  const body = nz ? listTex(Array.from(chunk)) : `0\\cdot\\left[1...${PS}\\right]`;
  return `${D.texName(name)}=${body}`;
}

// Build a graph state. Returns { state, cpu }.
function buildGraph({ cfg, words, boot, extra = [] }) {
  const cpu = CPU.build(cfg);
  const { prog, NP, NS, NT } = cpu;
  const PS = cfg.pageWords;
  const ex = [];
  let n = 0;
  const id = p => `${p}${n++}`;
  const expr = (latex, more = {}) => ex.push({ type: 'expression', id: id('e'), latex, ...more });
  const folder = (title, collapsed = true) => { const fid = id('f'); ex.push({ type: 'folder', id: fid, title, collapsed }); return fid; };

  // Machine state.
  const fState = folder('Machine state');
  const s0 = initialState(boot);
  expr(`S=${listTex(s0)}`, { folderId: fState });
  expr(`T_{v}=${listTex(new Array(NT).fill(-1))}`, { folderId: fState });
  expr(`T_{e}=${listTex(new Array(NT + 1).fill(0))}`, { folderId: fState });
  expr(`Q=\\left[\\right]`, { folderId: fState });
  // Batch result: computed from the current state; the ticker commits it.
  expr(`X_{r}=F_{ol}\\left(${cfg.outer},F_{pk}\\left(S,T_{v},T_{e},\\left[-1\\right],\\left[0\\right],\\left[-1\\right]\\right)\\right)`, { folderId: fState });

  // CPU definitions.
  const fCpu = folder('CPU (RV32IMA + Sv32)');
  for (const d of prog.defs) {
    if (d.kind === 'func') expr(D.defLatex(d), { folderId: fCpu });
    else if (typeof d.value !== 'string') expr(D.defLatex(d), { folderId: fCpu });
  }

  // RAM pages.
  const fRam = folder(`RAM (${NP} pages of ${PS} words)`);
  for (let j = 0; j < NP; j++) expr(pageLatex(`P_${j}`, words, j, PS), { folderId: fRam });

  for (const e of extra) ex.push(e);
  const state = {
    version: 11,
    graph: { viewport: { xmin: -10, ymin: -10, xmax: 10, ymax: 10 } },
    expressions: { list: ex },
  };
  return { state, cpu };
}

module.exports = { buildGraph, initialState };
