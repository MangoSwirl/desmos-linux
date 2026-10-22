// Desmos performance probes (inject into desmos.com/calculator page).
window.sleep = ms => new Promise(r => setTimeout(r, ms));
window.loadState = async (list, ticker) => {
  const C = window.Calc;
  const st = C.getState();
  st.expressions = { list };
  if (ticker) st.expressions.ticker = ticker;
  C.setState(st);
};
window.tickRate = async (handler, warm = 2500, ms = 2500, kid = 'k') => {
  const C = window.Calc;
  let st = C.getState();
  st.expressions.ticker = { handlerLatex: handler, minStepLatex: '0', open: true, playing: true };
  C.setState(st);
  const rk = () => +C.getState().expressions.list.find(e => e.id === kid).latex.split('=')[1];
  await sleep(warm);
  const k1 = rk(), t1 = performance.now();
  await sleep(ms);
  const k2 = rk(), t2 = performance.now();
  st = C.getState(); st.expressions.ticker.playing = false; C.setState(st);
  await sleep(300);
  return Math.round((k2 - k1) / (t2 - t1) * 10000) / 10;
};
window.pages = (NP, PS, comp) => {
  const ex = [{ type: 'folder', id: 'fd', title: 'mem', collapsed: true }];
  for (let j = 0; j < NP; j++) ex.push({ type: 'expression', id: 'p' + j, folderId: 'fd', latex: comp
    ? `P_{${j}}=\\operatorname{mod}([1...${PS}]\\cdot 2654435761+${j * 97},4294967296)`
    : `P_{${j}}=[${Array.from({ length: PS }, (_, i) => (i * 2654435761 + j * 97) % 4294967296).join(',')}]` });
  return ex;
};
window.runBg = (name, fn) => { window.R = window.R || {}; window.R[name] = 'running'; fn().then(v => window.R[name] = v, e => window.R[name] = 'ERR ' + e.message); return 'started'; };
