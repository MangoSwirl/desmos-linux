#!/usr/bin/env node
// Static file server used to push generated graphs into a desmos.com tab
// during development (fetch from the page, then Calc.setState).
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const root = path.resolve(process.argv[2] || '.');
const port = Number(process.argv[3] || 8765);
http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.end(); return; }
  const p = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  if (!p.startsWith(root)) { res.statusCode = 403; res.end(); return; }
  if (req.method === 'POST') { // uploads land in <root>/uploads/
    const dest = path.join(root, 'uploads', path.basename(p));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => { fs.writeFileSync(dest, Buffer.concat(chunks)); res.end('ok ' + dest); });
    return;
  }
  fs.readFile(p, (err, data) => {
    if (err) { res.statusCode = 404; res.end('not found'); return; }
    res.setHeader('Content-Type', p.endsWith('.json') ? 'application/json' : 'text/plain');
    res.end(data);
  });
}).listen(port, '127.0.0.1', () => console.log(`serving ${root} on http://127.0.0.1:${port}`));
