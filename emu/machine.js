// Reference model of the RV32IMA + Sv32 machine that the Desmos graph implements.
//
// This is NOT a general-purpose emulator: it mirrors the Desmos implementation
// exactly, including its quirks, so the two can be diffed state-for-state:
//   * execution happens in batches ("ticks"); stores inside a batch go to an
//     append-only write log that is flushed to RAM when the batch ends,
//   * instruction fetch reads committed RAM only (the log is invisible to it;
//     fence.i ends the batch so modified code becomes visible),
//   * a small round-robin TLB caches translations,
//   * M-mode does not exist: S-mode `ecall` is serviced natively as a legacy
//     (v0.1) SBI call (set_timer, console_putchar, console_getchar, shutdown).
'use strict';

const U32 = 4294967296;
const RAM_BASE = 0x80000000;

// Stop reasons (also used by the Desmos graph).
const MISS = -1000; // translate(): TLB miss, start a page walk
const SET_CONFLICT = new Error('dirty page set conflict');
const STOP = { NONE: 0, LIMIT: 1, WFI: 3, LOGFULL: 4, OUTFULL: 5, HALT: 6, DIRTY: 7 };

const CSR = {
  SSTATUS: 0x100, SIE: 0x104, STVEC: 0x105, SCOUNTEREN: 0x106, SENVCFG: 0x10a,
  SSCRATCH: 0x140, SEPC: 0x141, SCAUSE: 0x142, STVAL: 0x143, SIP: 0x144, SATP: 0x180,
  CYCLE: 0xc00, TIME: 0xc01, INSTRET: 0xc02, CYCLEH: 0xc80, TIMEH: 0xc81, INSTRETH: 0xc82,
};
const SSTATUS_MASK = (1 << 1) | (1 << 5) | (1 << 8) | (1 << 18) | (1 << 19);

class Machine {
  constructor({ ramSize, logMax = 1024, outMax = 256, tlbSize = 16, pageWords = 4096, dirtySets = 32, dirtyWays = 2 }) {
    this.ramSize = ramSize;
    this.ramWords = ramSize >>> 2;
    this.mem = new Uint32Array(this.ramWords);
    this.logMax = logMax;
    this.outMax = outMax;
    this.tlbSize = tlbSize;
    this.pageWords = pageWords;
    // Pages written in a batch are committed through dirtySets * dirtyWays
    // slots: page p may only use the slots of set p mod dirtySets. A batch ends
    // before a store to a new page whose set is full.
    this.dirtySets = dirtySets; this.dirtyWays = dirtyWays;
    this.dirty = new Set();
    this.x = new Array(32).fill(0);
    this.pc = RAM_BASE;
    this.priv = 1; // 1 = S, 0 = U
    this.sstatus = 0; this.sie = 0; this.ssip = 0; this.stvec = 0; this.scounteren = 0;
    this.sscratch = 0; this.sepc = 0; this.scause = 0; this.stval = 0; this.satp = 0;
    this.time = 0; this.timecmp = 2 ** 52; this.instret = 0;
    this.wk = 0; this.wva = 0; // page walk in progress (see walkStep)
    this.fi = 0; // fence.i seen in this batch
    this.resv = -1;
    this.tlbV = new Array(tlbSize).fill(-1);
    this.tlbE = new Array(tlbSize).fill(0);
    this.tlbP = 0;
    // batch state
    this.logAddr = []; this.logVal = []; this.logMap = new Map();
    this.out = [];
    this.stop = STOP.NONE;
    this.halted = false;
    // console input
    this.input = []; this.inputPos = 0;
    // stats
    this.stats = { batches: 0, dirtyPages: 0 };
  }

  // ---------------------------------------------------------------- memory
  inRam(pa) { return pa >= RAM_BASE && pa < RAM_BASE + this.ramSize; }
  // word index helpers take physical byte addresses
  readWord(pa) { // data read: sees the batch's write log
    const wi = (pa - RAM_BASE) >>> 2;
    const v = this.logMap.get(wi);
    return v === undefined ? this.mem[wi] : v;
  }
  // Instruction fetch reads committed RAM, except after a fence.i in this
  // batch, when it reads through the write log.
  fetchWord(pa) { return this.fi ? this.readWord(pa) : this.mem[(pa - RAM_BASE) >>> 2]; }
  writeWord(pa, v) {
    const wi = (pa - RAM_BASE) >>> 2;
    const pg = Math.floor(wi / this.pageWords);
    if (!this.dirty.has(pg)) {
      let n = 0;
      for (const q of this.dirty) if (q % this.dirtySets === pg % this.dirtySets) n++;
      if (n >= this.dirtyWays) throw SET_CONFLICT;
    }
    this.logAddr.push(wi); this.logVal.push(v >>> 0); this.logMap.set(wi, v >>> 0);
    this.dirty.add(Math.floor(wi / this.pageWords));
  }
  flush(pageWords) {
    const dirty = new Set();
    for (let i = 0; i < this.logAddr.length; i++) {
      this.mem[this.logAddr[i]] = this.logVal[i];
      if (pageWords) dirty.add(Math.floor(this.logAddr[i] / pageWords));
    }
    this.stats.dirtyPages += dirty.size;
    this.logAddr = []; this.logVal = []; this.logMap.clear();
  }

  // ------------------------------------------------------------ translation
  // acc: 0 fetch, 1 load, 2 store. Returns physical address, or -cause-1 on fault.
  permOk(e, acc) {
    const R = e & 2, W = e & 4, X = e & 8, Uu = e & 16, A = e & 64, D = e & 128;
    if (!A) return false;
    if (this.priv === 0) { if (!Uu) return false; }
    else if (Uu) { if (acc === 0 || !(this.sstatus & (1 << 18))) return false; }
    if (acc === 0) return !!X;
    if (acc === 1) return !!(R || ((this.sstatus & (1 << 19)) && X));
    return !!(W && D);
  }
  // TLB lookup. Returns the physical address on a hit with permission, or
  // MISS, in which case the caller starts a page walk (see walkStep).
  translate(va, acc) {
    if (!(this.satp & 0x80000000)) return va;
    const vpn = va >>> 12, off = va & 0xfff;
    for (let i = 0; i < this.tlbSize; i++) {
      if (this.tlbV[i] === vpn) {
        if (this.permOk(this.tlbE[i], acc)) return (this.tlbE[i] >>> 10) * 4096 + off;
        break;
      }
    }
    return MISS;
  }
  // Begin a walk for (va, acc): this step only checks the level-1 PTE address.
  startWalk(va, acc) {
    const a1 = (this.satp & 0x3fffff) * 4096 + (va >>> 22) * 4;
    if (!this.inRam(a1)) return this.trap([1, 5, 7][acc], va);
    this.wk = 1 + 4 * acc + 16 * a1;
    this.wva = va;
  }
  // One page-walk micro-step: read one PTE.
  walkStep() {
    const lvl = this.wk % 4, acc = Math.floor(this.wk / 4) % 4, a = Math.floor(this.wk / 16);
    const va = this.wva, vpn = va >>> 12, vpn0 = vpn & 0x3ff;
    const pf = [12, 13, 15][acc], af = [1, 5, 7][acc];
    const p = this.readWord(a);
    if (!(p & 1) || ((p >>> 1) & 3) === 2) return this.trap(pf, va);
    const leaf = (p & 2) || (p & 8);
    let e;
    if (!leaf) {
      if (lvl === 2) return this.trap(pf, va);
      const a2 = (p >>> 10) * 4096 + vpn0 * 4;
      if (!this.inRam(a2)) return this.trap(af, va);
      this.wk = 2 + 4 * acc + 16 * a2;
      return;
    }
    if (lvl === 1) {
      if ((p >>> 10) & 0x3ff) return this.trap(pf, va);
      e = ((p >>> 20) * 1024 + vpn0) * 1024 + (p & 0xff);
    } else {
      e = (p >>> 10) * 1024 + (p & 0xff);
    }
    if (!this.permOk(e, acc)) return this.trap(pf, va);
    let hit = -1;
    for (let i = 0; i < this.tlbSize; i++) if (this.tlbV[i] === vpn) { hit = i; break; }
    const slot = hit >= 0 ? hit : this.tlbP;
    if (hit < 0) this.tlbP = (this.tlbP + 1) % this.tlbSize;
    this.tlbV[slot] = vpn; this.tlbE[slot] = e;
    this.wk = 0;
  }
  tlbFlush() { this.tlbV.fill(-1); this.tlbE.fill(0); this.tlbP = 0; }

  // ------------------------------------------------------------------ traps
  trap(cause, tval) {
    const intr = cause >= 0x80000000;
    this.wk = 0;
    this.sepc = this.pc;
    this.scause = cause;
    this.stval = tval >>> 0;
    const sie = (this.sstatus >>> 1) & 1;
    this.sstatus = (this.sstatus & ~((1 << 5) | (1 << 8) | (1 << 1))) | (sie << 5) | (this.priv << 8);
    this.sstatus >>>= 0;
    this.priv = 1;
    const base = this.stvec & ~3;
    this.pc = ((this.stvec & 1) && intr) ? (base + 4 * (cause - 0x80000000)) >>> 0 : base >>> 0;
  }

  sipValue() { return (this.time >= this.timecmp ? 32 : 0) | this.ssip; }

  csrRead(n) {
    switch (n) {
      case CSR.SSTATUS: return this.sstatus;
      case CSR.SIE: return this.sie;
      case CSR.STVEC: return this.stvec;
      case CSR.SCOUNTEREN: return this.scounteren;
      case CSR.SENVCFG: return 0;
      case CSR.SSCRATCH: return this.sscratch;
      case CSR.SEPC: return this.sepc;
      case CSR.SCAUSE: return this.scause;
      case CSR.STVAL: return this.stval;
      case CSR.SIP: return this.sipValue();
      case CSR.SATP: return this.satp;
      case CSR.CYCLE: case CSR.INSTRET: return this.instret % U32;
      case CSR.CYCLEH: case CSR.INSTRETH: return Math.floor(this.instret / U32);
      case CSR.TIME: return this.time % U32;
      case CSR.TIMEH: return Math.floor(this.time / U32);
    }
    return undefined;
  }
  csrWrite(n, v) {
    v >>>= 0;
    switch (n) {
      case CSR.SSTATUS: this.sstatus = v & SSTATUS_MASK; break;
      case CSR.SIE: this.sie = v & 0x222; break;
      case CSR.STVEC: this.stvec = (v & ~2) >>> 0; break;
      case CSR.SCOUNTEREN: this.scounteren = v; break;
      case CSR.SENVCFG: break;
      case CSR.SSCRATCH: this.sscratch = v; break;
      case CSR.SEPC: this.sepc = (v & ~3) >>> 0; break;
      case CSR.SCAUSE: this.scause = v; break;
      case CSR.STVAL: this.stval = v; break;
      case CSR.SIP: this.ssip = v & 2; break;
      case CSR.SATP: this.satp = (v & 0x803fffff) >>> 0; this.tlbFlush(); break;
    }
  }

  // ------------------------------------------------------------------- step
  setRd(rd, v) { if (rd) this.x[rd] = v >>> 0; }

  step() {
    this.time += 1; this.instret += 1;
    if (this.wk > 0) return this.walkStep();
    // interrupts
    const pend = this.sipValue() & this.sie;
    if (pend && (this.priv === 0 || (this.sstatus & 2))) {
      const code = (pend & 0x200) ? 9 : (pend & 2) ? 1 : 5;
      this.trap(0x80000000 + code, 0);
      return;
    }
    const pc = this.pc;
    const fpa = this.translate(pc, 0);
    if (fpa === MISS) return this.startWalk(pc, 0);
    if (!this.inRam(fpa)) return this.trap(1, pc);
    const ins = this.fetchWord(fpa);
    const op = ins & 0x7f, rd = (ins >>> 7) & 31, f3 = (ins >>> 12) & 7;
    const rs1 = (ins >>> 15) & 31, rs2 = (ins >>> 20) & 31, f7 = ins >>> 25;
    const a = this.x[rs1], b = this.x[rs2];
    const immI = ins >> 20;
    let npc = (pc + 4) >>> 0;
    const ill = () => this.trap(2, ins);
    switch (op) {
      case 0x37: this.setRd(rd, ins & 0xfffff000); break;
      case 0x17: this.setRd(rd, pc + (ins & 0xfffff000)); break;
      case 0x6f: {
        const imm = ((ins >> 31) << 20) | (((ins >>> 12) & 0xff) << 12) | (((ins >>> 20) & 1) << 11) | (((ins >>> 21) & 0x3ff) << 1);
        const t = (pc + imm) >>> 0;
        if (t & 3) return this.trap(0, t);
        this.setRd(rd, npc); npc = t; break;
      }
      case 0x67: {
        if (f3 !== 0) return ill();
        const t = ((a + immI) & ~1) >>> 0;
        if (t & 3) return this.trap(0, t);
        this.setRd(rd, npc); npc = t; break;
      }
      case 0x63: {
        const imm = ((ins >> 31) << 12) | (((ins >>> 7) & 1) << 11) | (((ins >>> 25) & 0x3f) << 5) | (((ins >>> 8) & 0xf) << 1);
        let c;
        switch (f3) {
          case 0: c = a === b; break; case 1: c = a !== b; break;
          case 4: c = (a | 0) < (b | 0); break; case 5: c = (a | 0) >= (b | 0); break;
          case 6: c = a < b; break; case 7: c = a >= b; break;
          default: return ill();
        }
        if (c) { const t = (pc + imm) >>> 0; if (t & 3) return this.trap(0, t); npc = t; }
        break;
      }
      case 0x03: {
        const va = (a + immI) >>> 0;
        if (f3 === 3 || f3 > 5) return ill();
        const size = f3 & 3;
        if ((size === 1 && (va & 1)) || (size === 2 && (va & 3))) return this.trap(4, va);
        const pa = this.translate(va, 1);
        if (pa === MISS) return this.startWalk(va, 1);
        if (!this.inRam(pa)) return this.trap(5, va);
        const w = this.readWord(pa & ~3);
        const sh = (pa & 3) * 8;
        let v;
        switch (f3) {
          case 0: v = ((w >>> sh) << 24) >> 24; break;
          case 1: v = ((w >>> sh) << 16) >> 16; break;
          case 2: v = w; break;
          case 4: v = (w >>> sh) & 0xff; break;
          case 5: v = (w >>> sh) & 0xffff; break;
        }
        this.setRd(rd, v); break;
      }
      case 0x23: {
        const imm = ((ins >> 25) << 5) | ((ins >>> 7) & 31);
        const va = (a + imm) >>> 0;
        if (f3 > 2) return ill();
        if ((f3 === 1 && (va & 1)) || (f3 === 2 && (va & 3))) return this.trap(6, va);
        const pa = this.translate(va, 2);
        if (pa === MISS) return this.startWalk(va, 2);
        if (!this.inRam(pa)) return this.trap(7, va);
        const wa = (pa & ~3) >>> 0;
        let v;
        if (f3 === 2) v = b;
        else {
          const sh = (pa & 3) * 8, m = (f3 === 0 ? 0xff : 0xffff) << sh;
          v = (this.readWord(wa) & ~m) | ((b << sh) & m);
        }
        this.writeWord(wa, v);
        if (this.logAddr.length >= this.logMax) this.stop = STOP.LOGFULL;
        break;
      }
      case 0x13: {
        let v;
        const sh = rs2;
        switch (f3) {
          case 0: v = a + immI; break;
          case 1: if (f7 !== 0) return ill(); v = a << sh; break;
          case 2: v = (a | 0) < immI ? 1 : 0; break;
          case 3: v = a < (immI >>> 0) ? 1 : 0; break;
          case 4: v = a ^ immI; break;
          case 5: if (f7 === 0) v = a >>> sh; else if (f7 === 0x20) v = (a | 0) >> sh; else return ill(); break;
          case 6: v = a | immI; break;
          case 7: v = a & immI; break;
        }
        this.setRd(rd, v); break;
      }
      case 0x33: {
        let v;
        if (f7 === 1) {
          const sa = a | 0, sb = b | 0;
          switch (f3) {
            case 0: v = Math.imul(a, b); break;
            case 1: v = Number((BigInt(sa) * BigInt(sb)) >> 32n); break;
            case 2: v = Number((BigInt(sa) * BigInt(b)) >> 32n); break;
            case 3: v = Number((BigInt(a) * BigInt(b)) >> 32n); break;
            case 4: v = b === 0 ? -1 : (sa === -2147483648 && sb === -1) ? sa : (sa / sb) | 0; break;
            case 5: v = b === 0 ? 0xffffffff : Math.floor(a / b); break;
            case 6: v = b === 0 ? sa : (sa === -2147483648 && sb === -1) ? 0 : sa % sb; break;
            case 7: v = b === 0 ? a : a % b; break;
          }
        } else if (f7 === 0 || (f7 === 0x20 && (f3 === 0 || f3 === 5))) {
          const sh = b & 31;
          switch (f3) {
            case 0: v = f7 ? a - b : a + b; break;
            case 1: v = a << sh; break;
            case 2: v = (a | 0) < (b | 0) ? 1 : 0; break;
            case 3: v = a < b ? 1 : 0; break;
            case 4: v = a ^ b; break;
            case 5: v = f7 ? (a | 0) >> sh : a >>> sh; break;
            case 6: v = a | b; break;
            case 7: v = a & b; break;
          }
        } else return ill();
        this.setRd(rd, v); break;
      }
      case 0x0f:
        if (f3 === 1) this.fi = 1;
        else if (f3 !== 0) return ill();
        break;
      case 0x2f: {
        if (f3 !== 2) return ill();
        const f5 = ins >>> 27;
        if (![0, 1, 2, 3, 4, 8, 12, 16, 20, 24, 28].includes(f5)) return ill();
        if (f5 === 2 && rs2 !== 0) return ill();
        const va = a;
        if (va & 3) return this.trap(f5 === 2 ? 4 : 6, va);
        if (f5 === 2) { // LR.W
          const pa = this.translate(va, 1);
          if (pa === MISS) return this.startWalk(va, 1);
          if (!this.inRam(pa)) return this.trap(5, va);
          this.setRd(rd, this.readWord(pa));
          this.resv = pa;
          break;
        }
        const pa = this.translate(va, 2);
        if (pa === MISS) return this.startWalk(va, 2);
        if (!this.inRam(pa)) return this.trap(7, va);
        if (f5 === 3) { // SC.W
          if (this.resv === pa) { this.writeWord(pa, b); this.setRd(rd, 0); }
          else this.setRd(rd, 1);
          this.resv = -1;
        } else {
          const old = this.readWord(pa);
          let v;
          switch (f5) {
            case 0x01: v = b; break;
            case 0x00: v = old + b; break;
            case 0x04: v = old ^ b; break;
            case 0x0c: v = old & b; break;
            case 0x08: v = old | b; break;
            case 0x10: v = (old | 0) < (b | 0) ? old : b; break;
            case 0x14: v = (old | 0) > (b | 0) ? old : b; break;
            case 0x18: v = old < b ? old : b; break;
            case 0x1c: v = old > b ? old : b; break;
            default: return ill();
          }
          this.writeWord(pa, v);
          this.setRd(rd, old);
        }
        if (this.logAddr.length >= this.logMax) this.stop = STOP.LOGFULL;
        break;
      }
      case 0x73: {
        if (f3 === 0) {
          if (ins === 0x00000073) { // ecall
            if (this.priv === 0) return this.trap(8, 0);
            this.sbi();
          } else if (ins === 0x00100073) return this.trap(3, pc);
          else if (ins === 0x10200073) { // sret
            if (this.priv === 0) return ill();
            const spie = (this.sstatus >>> 5) & 1;
            this.priv = (this.sstatus >>> 8) & 1;
            this.sstatus = ((this.sstatus & ~((1 << 1) | (1 << 8))) | (spie << 1) | (1 << 5)) >>> 0;
            npc = this.sepc;
          } else if (ins === 0x10500073) { // wfi
            if (this.priv === 0) return ill();
            if (!(this.sipValue() & this.sie) && this.timecmp < this.time + 2 ** 40) {
              this.time = Math.max(this.time, this.timecmp);
            }
            this.stop = STOP.WFI;
          } else if ((ins & 0xfe007fff) === 0x12000073) { // sfence.vma
            if (this.priv === 0) return ill();
            this.tlbFlush();
          } else return ill();
          break;
        }
        if (f3 === 4) return ill();
        const csr = ins >>> 20;
        const old = this.csrRead(csr);
        if (old === undefined) return ill();
        if (this.priv === 0 && (csr & 0x300)) return ill();
        const src = f3 & 4 ? rs1 : a;
        const op2 = f3 & 3;
        const writes = op2 === 1 || rs1 !== 0;
        if (writes && (csr >>> 10) === 3) return ill();
        if (writes) {
          const nv = op2 === 1 ? src : op2 === 2 ? (old | src) : (old & ~src);
          this.csrWrite(csr, nv);
        }
        this.setRd(rd, old);
        break;
      }
      default: return ill();
    }
    this.pc = npc;
  }

  sbi() {
    const eid = this.x[17];
    const a0 = this.x[10];
    switch (eid) {
      case 0: // set_timer; "never" (e.g. -1) is clamped to 2^52 so the value stays an exact double
        this.timecmp = Math.min(this.x[11] * U32 + a0, 2 ** 52); this.x[10] = 0; break;
      case 1:
        this.out.push(a0 & 0xff); this.x[10] = 0;
        if (this.out.length >= this.outMax) this.stop = STOP.OUTFULL;
        break;
      case 2:
        if (this.inputPos < this.input.length) this.x[10] = this.input[this.inputPos++];
        else this.x[10] = 0xffffffff;
        break;
      case 3: case 4: case 5: case 6: case 7: this.x[10] = 0; break;
      case 8: this.halted = true; this.stop = STOP.HALT; this.x[10] = 0; break;
      default: this.x[10] = 0xfffffffe; this.x[11] = 0; break;
    }
  }

  // Run one batch of at most `limit` steps. Returns the number of steps run.
  runBatch(limit, pageWords) {
    let n = 0;
    this.stop = STOP.NONE;
    this.fi = 0;
    this.dirty.clear();
    while (n < limit && this.stop === STOP.NONE && !this.halted) {
      try {
        this.step();
      } catch (e) {
        if (e !== SET_CONFLICT) throw e;
        // nothing but the counters changes before a store: undo them
        this.time -= 1; this.instret -= 1;
        this.stop = STOP.DIRTY; break;
      }
      n++;
    }
    this.flush(pageWords);
    this.stats.batches++;
    return n;
  }
}

module.exports = { Machine, STOP, RAM_BASE, U32 };
