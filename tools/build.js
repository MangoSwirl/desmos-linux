#!/usr/bin/env node
// Build the Desmos graph state from a RAM image description.
//   node tools/build.js build/img/image.json build/graph.json
'use strict';
const fs = require('fs');
const path = require('path');
const { buildGraph } = require('../desmos/graph');
const { loadMachine } = require('../emu/boot');

const [imagePath, outPath = 'build/graph.json'] = process.argv.slice(2);
const { m, desc } = loadMachine(imagePath);
const p = desc.params;
const cfg = { ramSize: m.ramSize, pageWords: p.pageWords, logMax: m.logMax, outMax: m.outMax, chain: p.chain, outer: p.outer, dirtySets: m.dirtySets, dirtyWays: m.dirtyWays };
const { state, cpu } = buildGraph({ cfg, words: m.mem, boot: { pc: m.pc, a0: m.x[10], a1: m.x[11] } });
const json = JSON.stringify(state);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, json);
console.log(`${outPath}: ${(json.length / 1e6).toFixed(2)} MB, ${state.expressions.list.length} expressions, ${cpu.NP} RAM pages`);
