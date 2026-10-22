#!/usr/bin/env node
// Lay out a bootable RAM image: kernel Image at the start of RAM, initrd and
// device tree at the end. Writes <out>/image.json plus the segment files.
//
//   node tools/mkimage.js --kernel Image [--initrd initrd.cpio.gz] --ram 8M --out build/img
//        [--page-words 4096] [--log-max 1024] [--out-max 256] [--chain 2000] [--outer 4]
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const RAM_BASE = 0x80000000;
function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}
const size = s => {
  const m = /^(\d+)([KM]?)$/i.exec(s);
  return Number(m[1]) * (m[2].toUpperCase() === 'M' ? 1 << 20 : m[2].toUpperCase() === 'K' ? 1 << 10 : 1);
};

const projectDir = path.resolve(__dirname, '..');
const kernel = path.resolve(arg('--kernel'));
const initrd = arg('--initrd') ? path.resolve(arg('--initrd')) : null;
const ramSize = size(arg('--ram', '8M'));
const out = path.resolve(arg('--out', 'build/img'));
fs.mkdirSync(out, { recursive: true });

const kbytes = fs.readFileSync(kernel);
const ibytes = initrd ? fs.readFileSync(initrd) : Buffer.alloc(0);
const dtbMax = 0x2000;
const dtbAddr = RAM_BASE + ramSize - dtbMax;
const initrdStart = initrd ? Math.floor((dtbAddr - ibytes.length) / 4096) * 4096 : dtbAddr;
const initrdEnd = initrdStart + ibytes.length;
if (initrdStart < RAM_BASE + kbytes.length + (1 << 20)) throw new Error('RAM too small for kernel + initrd');

// Compile the device tree with dtc (inside the build container).
let dts = fs.readFileSync(path.join(projectDir, 'linux/emu.dts'), 'utf8')
  .replace('RAM_SIZE', '0x' + ramSize.toString(16))
  .replace('INITRD_START', '0x' + initrdStart.toString(16))
  .replace('INITRD_END', '0x' + initrdEnd.toString(16));
if (!initrd) dts = dts.replace(/\s*linux,initrd-(start|end) = <[^>]*>;/g, '');
fs.writeFileSync(path.join(out, 'emu.dts'), dts);
execFileSync('docker', ['run', '--rm', '-v', `${out}:/o`, 'rvbuild', 'dtc', '-I', 'dts', '-O', 'dtb', '-o', '/o/emu.dtb', '/o/emu.dts'], { stdio: 'inherit' });
const dtb = fs.readFileSync(path.join(out, 'emu.dtb'));
if (dtb.length > dtbMax) throw new Error('dtb too large');

fs.copyFileSync(kernel, path.join(out, 'Image'));
const segments = [{ file: 'Image', addr: RAM_BASE }, { file: 'emu.dtb', addr: dtbAddr }];
if (initrd) { fs.copyFileSync(initrd, path.join(out, 'initrd')); segments.push({ file: 'initrd', addr: initrdStart }); }

const desc = {
  ramSize,
  entry: RAM_BASE,
  dtb: dtbAddr,
  segments,
  params: {
    pageWords: Number(arg('--page-words', 4096)),
    logMax: Number(arg('--log-max', 1024)),
    outMax: Number(arg('--out-max', 256)),
    chain: Number(arg('--chain', 2000)),
    outer: Number(arg('--outer', 4)),
    dirtySets: Number(arg('--dirty-sets', 32)),
    dirtyWays: Number(arg('--dirty-ways', 2)),
  },
};
fs.writeFileSync(path.join(out, 'image.json'), JSON.stringify(desc, null, 2));
console.log(`kernel ${kbytes.length} B, initrd ${ibytes.length} B @0x${initrdStart.toString(16)}, dtb ${dtb.length} B @0x${dtbAddr.toString(16)}`);
