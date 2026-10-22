#!/usr/bin/env node
// Differential test: run the Desmos CPU (via the DSL's JS backend, which has
// Desmos semantics) side by side with the reference machine, tick by tick,
// and report the first divergence.
//
//   node --stack-size=60000 tools/difftest.js <image.json | --tiny> [--ticks N] [--outer K] [--chain C]
'use strict';
const path = require('path');
const D = require('../desmos/dsl');
const CPU = require('../desmos/cpu');
const { initialState } = require('../desmos/graph');
const { Machine, RAM_BASE } = require('../emu/machine');
const { loadMachine } = require('../emu/boot');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}

// Set up the reference machine and matching Desmos-side state.
function setup() {
  const imagePath = process.argv[2];
  let m, desc;
  if (imagePath === '--tiny') {
    m = new Machine({ ramSize: 64 << 10, logMax: 256, outMax: 64, pageWords: 1024, dirtySets: 4, dirtyWays: 2 });
    m.mem[0] = 0x00150513; m.mem[1] = 0xffdff06f;
    desc = { params: { pageWords: 1024, logMax: 256, outMax: 64 }, ramSize: 64 << 10 };
  } else {
    ({ m, desc } = loadMachine(imagePath));
  }
  const params = desc.params || {};
  const cfg = {
    ramSize: m.ramSize, pageWords: params.pageWords || 4096, logMax: m.logMax, outMax: m.outMax,
    chain: Number(arg('--chain', params.chain || 2000)), outer: Number(arg('--outer', params.outer || 2)),
    dirtySets: m.dirtySets, dirtyWays: m.dirtyWays,
  };
  return { m, cfg };
}

function main() {
  const { m, cfg } = setup();
  const cpu = CPU.build(cfg);
  const PS = cfg.pageWords;
  const pages = [];
  for (let j = 0; j < cpu.NP; j++) pages.push(Array.from(m.mem.subarray(j * PS, (j + 1) * PS)));
  const G = { Q: [] };
  pages.forEach((p, j) => { G['P_' + j] = p; });
  const js = D.compileJS(cpu.prog)(G);
  const F = name => js.get[name]();

  let S = initialState({ pc: m.pc, a0: m.x[10], a1: m.x[11] });
  let T = new Array(CPU.NT).fill(-1), U = new Array(CPU.NT + 1).fill(0);
  const { oS, oT, oE, oA } = cpu.layout;
  const ticks = Number(arg('--ticks', 50));
  const stepsPerTick = cfg.chain * cfg.outer;
  let totalSteps = 0;
  let out = '';
  for (let t = 0; t < ticks; t++) {
    // --- Desmos side: one tick = F_ol(outer, pack) then commit.
    const X = F('F_ol')(cfg.outer, F('F_pk')(S, T, U, [-1], [0], [-1], [-1]));
    const m1 = X[0], k1 = X[1], y1 = X[2];
    const S2 = X.slice(oS - 1, oT - 1), T2 = X.slice(oT - 1, oE - 1), U2 = X.slice(oE - 1, oA - 1);
    const Cl = X.slice(oA - 1, oA - 1 + m1), O = X.slice(oA - 1 + m1, oA - 1 + m1 + k1);
    const Y = X.slice(oA - 1 + m1 + k1, oA - 1 + m1 + k1 + y1);
    const A = F('F_xa')(Cl, Y), V = F('F_xv')(Cl);
    const dirty = Y.slice(1);
    const dirtyFromLog = [...new Set(A.slice(1).map(a => Math.floor(a / PS)))];
    if (dirtyFromLog.length !== dirty.length || dirtyFromLog.some(j => !dirty.includes(j))) throw new Error('dirty page list mismatch ' + JSON.stringify([dirty, dirtyFromLog]));
    for (const j of dirty) {
      const merged = F('F_mp')(pages[j], j, A, V);
      if (merged.length !== PS) throw new Error(`merge produced ${merged.length} words for page ${j}`);
      pages[j] = merged; js.set['P_' + j](merged);
    }
    S = S2.slice(); if (S[CPU.S.STOPF - 1] !== 6) S[CPU.S.STOPF - 1] = 0;
    S[CPU.S.FI - 1] = 0;
    T = T2; U = U2;
    // --- reference side
    const n = m.runBatch(stepsPerTick, PS);
    totalSteps += n;
    const refOut = m.out.splice(0);
    // --- compare
    const errs = [];
    const refS = refState(m);
    for (let i = 0; i < refS.length; i++) {
      if (i === CPU.S.STOPF - 1 || i === CPU.S.FI - 1) continue;
      if (refS[i] !== S[i] && !(Number.isNaN(refS[i]) && Number.isNaN(S[i]))) errs.push(`S[${i + 1}] desmos=${S[i]} ref=${refS[i]}`);
    }
    for (let i = 0; i < CPU.NT; i++) {
      if (T[i] !== m.tlbV[i]) errs.push(`TLB vpn[${i}] desmos=${T[i]} ref=${m.tlbV[i]}`);
      if (T[i] !== -1 && U[i] !== m.tlbE[i]) errs.push(`TLB ent[${i}] desmos=${U[i]} ref=${m.tlbE[i]}`);
    }
    if (U[CPU.NT] !== m.tlbP) errs.push(`TLB ptr desmos=${U[CPU.NT]} ref=${m.tlbP}`);
    const dOut = O.slice(1);
    if (dOut.join(',') !== refOut.join(',')) errs.push(`output desmos=${JSON.stringify(dOut)} ref=${JSON.stringify(refOut)}`);
    for (const j of dirty) {
      for (let i = 0; i < PS; i++) if (pages[j][i] !== m.mem[j * PS + i]) { errs.push(`mem word ${j * PS + i} desmos=${pages[j][i]} ref=${m.mem[j * PS + i]}`); break; }
    }
    out += Buffer.from(refOut).toString('latin1');
    if (errs.length) {
      console.log(`DIVERGED in tick ${t} (ref ran ${n} steps, total ${totalSteps}):\n  ` + errs.slice(0, 20).join('\n  '));
      console.log('ref pc', m.pc.toString(16), 'desmos pc', S[CPU.S.PC - 1].toString(16));
      process.exit(1);
    }
    if (m.halted) break;
  }
  console.log(`OK: ${ticks} ticks, ${totalSteps} steps match.`);
  if (out) console.log('console output:\n' + out);
}

// Reference machine state in the Desmos layout.
function refState(m) {
  const s = new Array(CPU.NS).fill(0);
  const S = CPU.S;
  for (let r = 0; r < 32; r++) s[r] = m.x[r];
  s[S.PC - 1] = m.pc; s[S.PRIV - 1] = m.priv; s[S.SSTATUS - 1] = m.sstatus; s[S.SIE - 1] = m.sie;
  s[S.SSIP - 1] = m.ssip; s[S.STVEC - 1] = m.stvec; s[S.SSCRATCH - 1] = m.sscratch; s[S.SEPC - 1] = m.sepc;
  s[S.SCAUSE - 1] = m.scause; s[S.STVAL - 1] = m.stval; s[S.SATP - 1] = m.satp; s[S.TIME - 1] = m.time;
  s[S.TIMECMP - 1] = m.timecmp; s[S.INSTRET - 1] = m.instret; s[S.RESV - 1] = m.resv; s[S.QI - 1] = m.inputPos;
  s[S.SCOUNTEREN - 1] = m.scounteren; s[S.WK - 1] = m.wk; s[S.WVA - 1] = m.wva; s[S.FI - 1] = m.fi;
  return s;
}

main();
