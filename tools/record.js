// Record a boot of the graph in desmos.com/calculator as real browser screenshots. Drives a Chrome
// started with --remote-debugging-port over CDP: loads the graph with the ticker playing, saves a
// screenshot of the page every few seconds to <out>/NNNNNN.png with its tick and time in
// <out>/frames.jsonl, and once bash prints a prompt, types each command on the graph's on-screen
// keyboard with mouse clicks. Exits a few ticks after the prompt that follows the last command.
// --type <keys> types right away ('\b' is Backspace).
// --attach resumes on a desmos.com tab that is already running the graph, appending to <out dir>.
// Usage: node tools/record.js <graph.json> <out dir> [--port 9333] [--every 2000] [--attach] [--cmd 'uname -a'] ...
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf(k); return i < 0 ? d : args[i + 1]; };
const graphPath = args[0], out = args[1], port = +opt('--port', 9333), every = +opt('--every', 2000);
const attach = args.includes('--attach'), cmds = args.flatMap((a, i) => a === '--cmd' ? [args[i + 1]] : []);
const W = 1600, H = 1000, NH = 5, COLS = 80, PROMPT = 'root@desmos:~#';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(out, { recursive: true });

(async () => {
  const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let nextId = 1; const pend = new Map();
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const id = nextId++; pend.set(id, { res, rej, method }); ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id) { const p = pend.get(m.id); pend.delete(m.id); if (p) m.error ? p.rej(new Error(p.method + ': ' + m.error.message)) : p.res(m.result); }
    else if (/crash|detached/i.test(m.method)) log('EVENT', m.method, JSON.stringify(m.params || {}).slice(0, 200));
  };
  ws.onclose = () => { log('BROWSER WS CLOSED'); process.exit(2); };

  const targetId = attach ? (await send('Target.getTargets')).targetInfos.find(t => t.type === 'page' && t.url.includes('desmos.com/calculator')).targetId
    : (await send('Target.createTarget', { url: 'about:blank' })).targetId;
  const { sessionId: S } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, S); await send('Inspector.enable', {}, S); await send('Page.enable', {}, S);
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false }, S);
  if (!attach) await send('Page.navigate', { url: 'https://www.desmos.com/calculator' }, S);
  const ev = async (expression, awaitPromise = false) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true }, S);
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result.value;
  };
  for (let i = 0; i < 90 && !(await ev('typeof Calc !== "undefined" && !!Calc.setState').catch(() => false)); i++) await sleep(1000);
  log('Calc ready');

  if (!attach) {
    const g = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
    g.expressions.ticker.playing = true;
    await ev(`window.__G = ${JSON.stringify(JSON.stringify(g))}; 0`);
    await ev('Calc.setState(JSON.parse(window.__G)); delete window.__G; 0');
  }
  await ev(`(() => {
    const h = Calc.HelperExpression({ latex: 'M_{t}' }), hk = Calc.HelperExpression({ latex: 't_{k}' });
    window.__st = () => ({ k: hk.numericValue, M: h.listValue }); return 0; })()`);
  log(attach ? 'attached' : 'graph loaded, ticker playing');

  // key centres in page pixels, from the graph's own key layout lists
  const keyPos = () => ev(`(async () => {
    const get = l => new Promise(r => { const h = Calc.HelperExpression({ latex: l }); const f = () => { if (h.listValue) { r(h.listValue); h.unobserve('listValue'); } }; h.observe('listValue', f); f(); });
    const [X, Y, W, N] = await Promise.all(['K_{x}', 'K_{y}', 'K_{w}', 'K_{n}'].map(get));
    const rr = document.querySelector('.dcg-graph-outer, #graph-container').getBoundingClientRect();
    return N.map((n, i) => { const p = Calc.mathToPixels({ x: X[i] + W[i] / 2, y: Y[i] + 2 }); return { n, x: rr.left + p.x, y: rr.top + p.y }; });
  })()`, true);
  async function type(text) {
    const keys = await keyPos(), find = ch => keys.find(k => k.n === (ch === '\n' ? -5 : ch === ' ' ? -7 : ch === '\b' ? -2 : ch.charCodeAt(0)));
    for (const ch of text) {
      const k = find(ch); if (!k) { log('no key for', JSON.stringify(ch)); continue; }
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: k.x, y: k.y }, S);
      for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: k.x, y: k.y, button: 'left', clickCount: 1 }, S);
      await sleep(600);
    }
  }

  const enter = (await keyPos()).find(k => k.n === -5);
  log('Enter key at', Math.round(enter.x), Math.round(enter.y));
  if (opt('--type')) await type(opt('--type').replace(/\\b/g, '\b'));

  const jl = fs.openSync(path.join(out, 'frames.jsonl'), 'a');
  let n = fs.readdirSync(out).filter(f => f.endsWith('.png')).length, cmd = 0, echoed = true, promptAt = null, lastK = -1;
  for (;;) {
    const t1 = Date.now();
    let st = null;
    try { st = await ev('JSON.stringify(window.__st())'); st = JSON.parse(st); } catch (e) { log('STATE FAILED', e.message); }
    try {
      const { data } = await send('Page.captureScreenshot', { format: 'png' }, S);
      const name = String(n++).padStart(6, '0') + '.png';
      fs.writeFileSync(path.join(out, name), Buffer.from(data, 'base64'));
      fs.writeSync(jl, JSON.stringify({ f: name, t: t1, k: st && st.k }) + '\n');
    } catch (e) { log('SCREENSHOT FAILED', e.message); }
    if (st && st.M && Number.isFinite(st.k)) {
      const k = st.k, M = st.M;
      if (k !== lastK && k % 25 === 0) log('tick', k, 'frames', n);
      lastK = k;
      let row = ''; for (let b = 0; b < COLS; b++) row += String.fromCharCode(M[NH + COLS * M[0] + b]);
      const bare = row.trimEnd() === PROMPT && M[1] === PROMPT.length + 1;
      if (!bare) echoed = true;
      const atPrompt = bare && echoed;
      if (atPrompt && promptAt === null) { promptAt = k; log('prompt at tick', k); }
      if (!atPrompt) promptAt = null;
      if (promptAt !== null && k >= promptAt + 4) {
        if (cmd === cmds.length) { log('done at tick', k, 'frames', n); process.exit(0); }
        log('typing', JSON.stringify(cmds[cmd]), 'at tick', k);
        await type(cmds[cmd++] + '\n'); echoed = false; promptAt = null;
      }
    }
    await sleep(Math.max(0, every - (Date.now() - t1)));
  }
})().catch(e => { log('DRIVER ERROR', e.stack); process.exit(1); });
