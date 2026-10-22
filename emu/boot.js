#!/usr/bin/env node
// Boot the kernel in the reference machine and stream the console to stdout.
//
//   node emu/boot.js build/image.json [--input "ls\n"] [--max-steps N] [--batch K]
//
// image.json is produced by tools/mkimage.js and describes the RAM layout.
'use strict';
const fs = require('fs');
const path = require('path');
const { Machine, RAM_BASE } = require('./machine');

function parseArgs(argv) {
  const o = { input: '', maxSteps: Infinity, batch: 20000, quiet: false, statsEvery: 0 };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input') o.input = JSON.parse('"' + argv[++i] + '"');
    else if (a === '--max-steps') o.maxSteps = Number(argv[++i]);
    else if (a === '--batch') o.batch = Number(argv[++i]);
    else if (a === '--quiet') o.quiet = true;
    else if (a === '--stats-every') o.statsEvery = Number(argv[++i]);
    else if (a === '--until') o.until = argv[++i];
    else rest.push(a);
  }
  o.image = rest[0];
  return o;
}

function loadMachine(imagePath, params = {}) {
  const desc = JSON.parse(fs.readFileSync(imagePath, 'utf8'));
  const dir = path.dirname(imagePath);
  const m = new Machine({ ramSize: desc.ramSize, ...desc.params, ...params });
  for (const seg of desc.segments) {
    const buf = fs.readFileSync(path.join(dir, seg.file));
    const off = seg.addr - RAM_BASE;
    const padded = Buffer.alloc(Math.ceil(buf.length / 4) * 4);
    buf.copy(padded);
    for (let i = 0; i < padded.length; i += 4) m.mem[(off + i) >>> 2] = padded.readUInt32LE(i);
  }
  m.pc = desc.entry >>> 0;
  m.x[10] = 0; // hart id
  m.x[11] = desc.dtb >>> 0;
  return { m, desc };
}

if (require.main === module) {
  const o = parseArgs(process.argv.slice(2));
  const { m, desc } = loadMachine(o.image);
  const pageWords = desc.params && desc.params.pageWords || 2048;
  m.input = Array.from(Buffer.from(o.input, 'latin1'));
  let steps = 0;
  const t0 = Date.now();
  let text = '';
  let lastStats = 0;
  while (!m.halted && steps < o.maxSteps) {
    steps += m.runBatch(Math.min(o.batch, o.maxSteps - steps), pageWords);
    if (m.out.length) {
      const s = Buffer.from(m.out).toString('latin1');
      if (!o.quiet) process.stdout.write(s);
      text += s;
      m.out = [];
      if (o.until && text.includes(o.until)) break;
    }
    if (o.statsEvery && steps - lastStats >= o.statsEvery) {
      lastStats = steps;
      process.stderr.write(`[${steps} steps, ${m.stats.batches} batches, pc=${m.pc.toString(16)}]\n`);
    }
  }
  const dt = (Date.now() - t0) / 1000;
  process.stderr.write(`\n[steps=${steps} batches=${m.stats.batches} dirtyPages=${m.stats.dirtyPages} ` +
    `time=${dt.toFixed(1)}s (${(steps / dt / 1e6).toFixed(1)} MIPS) pc=${m.pc.toString(16)} halted=${m.halted}]\n`);
}

module.exports = { loadMachine };
