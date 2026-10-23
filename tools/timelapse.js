// Assemble screenshots from tools/record.js into a time-lapse video: one frame per tick (the last
// screenshot taken during that tick, so the graph has finished drawing it), with the final frame
// held for a few seconds. Usage: node tools/timelapse.js <frames dir> <out.mp4> [fps] [ffmpeg]
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const [dir, out, fps = 30, ffmpeg = 'ffmpeg'] = process.argv.slice(2);
const recs = fs.readFileSync(path.join(dir, 'frames.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  .filter(r => Number.isFinite(r.k));
const byTick = new Map(); for (const r of recs) byTick.set(r.k, r.f); // later screenshots win
const ticks = [...byTick.keys()].sort((a, b) => a - b);
const lines = ticks.map(k => `file '${path.resolve(dir, byTick.get(k))}'\nduration ${1 / fps}`);
lines.push(`file '${path.resolve(dir, byTick.get(ticks[ticks.length - 1]))}'\nduration 3`, lines[lines.length - 1].split('\n')[0]);
const list = path.join(dir, 'concat.txt');
fs.writeFileSync(list, lines.join('\n') + '\n');
execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-fps_mode', 'cfr', '-r', String(fps),
  '-vf', 'format=yuv420p', '-c:v', 'libx264', '-crf', '20', '-preset', 'slow', '-movflags', '+faststart', out], { stdio: 'inherit' });
console.log(`${out}: ticks ${ticks[0]}..${ticks[ticks.length - 1]}, ${ticks.length} frames at ${fps} fps`);
