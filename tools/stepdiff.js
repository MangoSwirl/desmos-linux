#!/usr/bin/env node
// Find the exact step where the Desmos CPU and the reference machine diverge:
// run both tick-by-tick up to --tick T, then single-step tick T (without
// changing batch semantics) and compare the state after every step.
//
//   node --stack-size=60000 tools/stepdiff.js build/k4/image.json --tick 273
'use strict';
const D = require('../desmos/dsl');
const CPU = require('../desmos/cpu');
const { initialState } = require('../desmos/graph');
const { loadMachine } = require('../emu/boot');

const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const { m, desc } = loadMachine(process.argv[2]);
const p = desc.params;
const cfg = { ramSize: m.ramSize, pageWords: p.pageWords, logMax: m.logMax, outMax: m.outMax, chain: p.chain, outer: p.outer };
const cpu = CPU.build(cfg);
const PS = cfg.pageWords;
const pages = [];
for (let j = 0; j < cpu.NP; j++) pages.push(Array.from(m.mem.subarray(j * PS, (j + 1) * PS)));
const G = { Q: [] };
pages.forEach((pg, j) => { G['P_' + j] = pg; });
const js = D.compileJS(cpu.prog)(G);
const F = n => js.get[n]();
const { oS, oT, oE, oA } = cpu.layout;
const unpack = X => {
  const m1 = X[0], k1 = X[1];
  return { S: X.slice(oS - 1, oT - 1), T: X.slice(oT - 1, oE - 1), U: X.slice(oE - 1, oA - 1),
    A: X.slice(oA - 1, oA - 1 + m1), V: X.slice(oA - 1 + m1, oA - 1 + 2 * m1), O: X.slice(oA - 1 + 2 * m1, oA - 1 + 2 * m1 + k1) };
};
const commit = st => {
  const dirty = [...new Set(st.A.slice(1).map(a => Math.floor(a / PS)))];
  for (const j of dirty) { pages[j] = F('F_mp')(pages[j], j, st.A, st.V); js.set['P_' + j](pages[j]); }
};
function refState() {
  const s = new Array(CPU.NS).fill(0), S = CPU.S;
  for (let r = 0; r < 32; r++) s[r] = m.x[r];
  Object.assign(s, {});
  s[S.PC - 1] = m.pc; s[S.PRIV - 1] = m.priv; s[S.SSTATUS - 1] = m.sstatus; s[S.SIE - 1] = m.sie; s[S.SSIP - 1] = m.ssip;
  s[S.STVEC - 1] = m.stvec; s[S.SSCRATCH - 1] = m.sscratch; s[S.SEPC - 1] = m.sepc; s[S.SCAUSE - 1] = m.scause;
  s[S.STVAL - 1] = m.stval; s[S.SATP - 1] = m.satp; s[S.TIME - 1] = m.time; s[S.TIMECMP - 1] = m.timecmp;
  s[S.INSTRET - 1] = m.instret; s[S.RESV - 1] = m.resv; s[S.QI - 1] = m.inputPos; s[S.SCOUNTEREN - 1] = m.scounteren;
  s[S.WK - 1] = m.wk; s[S.WVA - 1] = m.wva;
  return s;
}
let S = initialState({ pc: m.pc, a0: m.x[10], a1: m.x[11] });
let T = new Array(CPU.NT).fill(-1), U = new Array(CPU.NT + 1).fill(0);
const target = Number(arg('--tick', 0));
for (let t = 0; t < target; t++) {
  const st = unpack(F('F_ol')(cfg.outer, F('F_pk')(S, T, U, [-1], [0], [-1])));
  commit(st);
  S = st.S.slice(); if (S[CPU.S.STOPF - 1] !== 6) S[CPU.S.STOPF - 1] = 0;
  T = st.T; U = st.U;
  m.runBatch(cfg.chain * cfg.outer, PS); m.out = [];
}
console.log('reached tick', target, 'pc', S[32].toString(16), m.pc.toString(16));
// single-step inside one batch
let st = { S, T, U, A: [-1], V: [0], O: [-1] };
m.stop = 0;
for (let k = 0; k < cfg.chain * cfg.outer; k++) {
  const before = refState();
  const ins = m.mem[((m.pc >>> 0) - 0x80000000) >>> 2];
  st = unpack(F('F_g')(1, st.S, st.T, st.U, st.A, st.V, st.O, F('D_n')));
  m.step();
  const r = refState();
  const bad = [];
  for (let i = 0; i < CPU.NS; i++) if (i !== CPU.S.STOPF - 1 && r[i] !== st.S[i]) bad.push(`S[${i + 1}] desmos=${st.S[i]} ref=${r[i]} (before ${before[i]})`);
  if (bad.length) {
    console.log(`step ${k}: pc=${before[32].toString(16)} priv=${before[33]} (word at phys pc ${ins && ins.toString(16)})`);
    console.log('  ' + bad.join('\n  '));
    console.log('  regs a0..a7', before.slice(10, 18).map(x => x.toString(16)).join(' '));
    process.exit(1);
  }
  if (m.stop) break;
}
console.log('no divergence in tick', target);
