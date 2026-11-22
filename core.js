const SR = 22050;
const TUNING = [40, 45, 50, 55, 59, 64];
const PCN = ['C','C#','D','Eb','E','F','F#','G','Ab','A','Bb','B'];
const PCF = ['Do','Do#','Ré','Mib','Mi','Fa','Fa#','Sol','Lab','La','Sib','Si'];
const QUAL = [['', [0,4,7]], ['m', [0,3,7]], ['7', [0,4,7,10]], ['m7', [0,3,7,10]]];
const tick = () => new Promise(r => setTimeout(r, 0));

const hannCache = {};
function hann(n) {
  if (!hannCache[n]) { const w = new Float32Array(n); for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n); hannCache[n] = w; }
  return hannCache[n];
}
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang), h = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < h; k++) {
        const a = i + k, b = a + h, tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}
function mag(x, start, n, out) {
  const w = hann(n), re = new Float32Array(n), im = new Float32Array(n);
  for (let i = 0; i < n; i++) re[i] = (x[start + i] || 0) * w[i];
  fft(re, im);
  for (let k = 0; k < n / 2; k++) out[k] = Math.hypot(re[k], im[k]);
  return out;
}
function pct(arr, p) { const a = Array.from(arr).sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : 0; }

// ---- onset envelope (spectral flux) ----
async function onsetEnv(x) {
  const N = 1024, H = 256, nF = Math.max(1, Math.floor((x.length - N) / H) + 1), kMax = Math.floor(8000 / SR * N);
  const env = new Float32Array(nF); let prev = new Float32Array(N / 2), cur = new Float32Array(N / 2);
  for (let f = 0; f < nF; f++) {
    mag(x, f * H, N, cur); let s = 0;
    for (let k = 1; k < kMax; k++) { const v = Math.log(1 + 10 * cur[k]); const d = v - prev[k]; if (d > 0) s += d; prev[k] = v; }
    env[f] = s;
    if (f % 2000 === 0) await tick();
  }
  const W = Math.round(0.4 * SR / H), out = new Float32Array(nF);
  let acc = 0; const q = [];
  for (let f = 0; f < nF; f++) {
    acc += env[f]; q.push(env[f]); if (q.length > W) acc -= q.shift();
    out[f] = Math.max(0, env[f] - acc / q.length);
  }
  const m = pct(out, 0.98) || 1; for (let f = 0; f < nF; f++) out[f] = Math.min(1.5, out[f] / m);
  return { env: out, dt: H / SR };
}

// ---- tempo + beats (Ellis DP) ----
function tempo(env, dt) {
  let best = 0, bp = 0;
  const sc = l => { let s = 0; for (let i = l; i < env.length; i++) s += env[i] * env[i - l]; return s; };
  for (let bpm = 60; bpm <= 180; bpm += 0.5) {
    const l = 60 / bpm / dt, l0 = Math.floor(l), fr = l - l0;
    const v = ((1 - fr) * sc(l0) + fr * sc(l0 + 1)) * Math.exp(-0.5 * (Math.log2(bpm / 110) / 0.8) ** 2);
    if (v > best) { best = v; bp = bpm; }
  }
  return bp;
}
function beatTrack(env, dt, bpm) {
  const p = 60 / bpm / dt, n = env.length, score = new Float32Array(n), back = new Int32Array(n).fill(-1);
  for (let t = 0; t < n; t++) {
    let bs = 0, bi = -1;
    for (let pr = Math.round(t - 2 * p); pr <= Math.round(t - p / 2); pr++) {
      if (pr < 0) continue;
      const v = score[pr] - 6 * Math.log((t - pr) / p) ** 2;
      if (bi < 0 || v > bs) { bs = v; bi = pr; }
    }
    score[t] = env[t] + (bi >= 0 ? Math.max(0, bs) : 0); back[t] = bs > 0 ? bi : -1;
  }
  let t = 0, m = -1;
  for (let i = Math.max(0, Math.floor(n - p)); i < n; i++) if (score[i] > m) { m = score[i]; t = i; }
  const beats = [];
  while (t >= 0) { beats.push(t * dt); t = back[t]; }
  beats.reverse();
  while (beats.length && beats[0] - 60 / bpm > 0) beats.unshift(beats[0] - 60 / bpm);
  if (beats[0] < 0) beats.shift();
  return beats;
}

// ---- chroma + chords ----
async function chroma(x) {
  const N = 4096, H = 2048, nF = Math.max(1, Math.floor((x.length - N) / H) + 1);
  const C = [], B = [], E = [], cur = new Float32Array(N / 2), kLo = Math.floor(55 * N / SR), kHi = Math.ceil(2100 * N / SR);
  for (let f = 0; f < nF; f++) {
    mag(x, f * H, N, cur);
    const c = new Float32Array(12), b = new Float32Array(12); let e = 0, mx = 0, low = false;
    for (let k = kLo; k < kHi; k++) if (cur[k] > mx) mx = cur[k];
    for (let k = kLo; k < kHi; k++) {
      const a = cur[k - 1], v = cur[k], n = cur[k + 1];
      if (!(v > a && v >= n) || v < mx * 0.02) continue;
      const den = a - 2 * v + n, kk = k + (den ? 0.5 * (a - n) / den : 0), fq = kk * SR / N;
      const pc = ((Math.round(12 * Math.log2(fq / 440)) + 69) % 12 + 12) % 12;
      c[pc] += v; e += v;
      if (!low && v > mx * 0.15 && fq < 330) { b[pc] += v; low = true; }
    }
    C.push(c); B.push(b); E.push(e);
    if (f % 300 === 0) await tick();
  }
  return { C, B, E, dt: H / SR, off: N / 2 / SR };
}
let BASSW = 0.25;
const TPL = [];
for (let r = 0; r < 12; r++) QUAL.forEach(([q, iv], qi) => {
  const v = new Float32Array(12);
  iv.forEach((s, i) => { const w = i === 3 ? 0.8 : 1; [[0, 1], [12, 0.6], [19, 0.36], [24, 0.22], [28, 0.13]].forEach(([h, g]) => v[(r + s + h) % 12] += w * g); });
  let n = 0; v.forEach(a => n += a * a); n = Math.sqrt(n); TPL.push({ r, q, v: v.map(a => a / n), pen: qi > 1 ? 0.87 : 1 });
});
function chordsByBeat(ch, beats, penAt) {
  const nb = beats.length, scores = [], eB = [];
  for (let i = 0; i < nb; i++) {
    const a = beats[i], b = i + 1 < nb ? beats[i + 1] : a + (a - (beats[i - 1] || 0));
    const c = new Float32Array(12), bs = new Float32Array(12); let e = 0, cnt = 0;
    ch.C.forEach((v, f) => { const t = f * ch.dt + ch.off; if (t >= a && t < b) { for (let k = 0; k < 12; k++) { c[k] += v[k]; bs[k] += ch.B[f][k]; } e += ch.E[f]; cnt++; } });
    eB.push(cnt ? e / cnt : 0);
    let n = 0; c.forEach(v => n += v * v); n = Math.sqrt(n) || 1;
    const bm = Math.max(...bs) || 1;
    scores.push(TPL.map(t => { let s = 0; for (let k = 0; k < 12; k++) s += t.v[k] * c[k] / n; return s * t.pen + BASSW * bs[t.r] / bm; }));
  }
  const raw = scores.map(a => a.slice());
  for (let i = 0; i < nb; i++) for (let s = 0; s < raw[i].length; s++) scores[i][s] = (raw[i][s] + 0.5 * ((raw[i - 1] || raw[i])[s] + (raw[i + 1] || raw[i])[s])) / 2;
  const eq = pct(eB, 0.5) * 0.12;
  // Viterbi with change penalty
  const S = TPL.length; let dp = scores[0] ? scores[0].slice() : [], bk = [];
  for (let i = 1; i < nb; i++) {
    const pen = penAt ? penAt(i) : 0.25;
    const mx = Math.max(...dp), am = dp.indexOf(mx), nd = new Array(S), bb = new Int16Array(S);
    for (let s = 0; s < S; s++) { if (dp[s] >= mx - pen) { nd[s] = dp[s] + scores[i][s]; bb[s] = s; } else { nd[s] = mx - pen + scores[i][s]; bb[s] = am; } }
    dp = nd; bk.push(bb);
  }
  let s = dp.indexOf(Math.max(...dp)); const lab = new Array(nb);
  for (let i = nb - 1; i >= 0; i--) { lab[i] = s; if (i > 0) s = bk[i - 1][s]; }
  return lab.map((s, i) => eB[i] < eq ? null : { r: TPL[s].r, q: TPL[s].q });
}
const same = (a, b) => (!a && !b) || (a && b && a.r === b.r && a.q === b.q);

// ---- bars + strumming ----
function structure(beats, chords, env, dt, meter) {
  const cnt = new Array(meter).fill(0);
  for (let i = 1; i < chords.length; i++) if (!same(chords[i], chords[i - 1])) cnt[i % meter]++;
  const ph = cnt.indexOf(Math.max(...cnt)), period = (beats[beats.length - 1] - beats[0]) / Math.max(1, beats.length - 1);
  const bt = i => i < beats.length ? beats[i] : beats[beats.length - 1] + (i - beats.length + 1) * period;
  const peak = t => { const c = Math.round(t / dt), w = Math.max(1, Math.round(period / 8 / dt)); let m = 0; for (let f = c - w; f <= c + w; f++) if (env[f] > m) m = env[f]; return m; };
  const bars = [];
  for (let i = ph - meter; i < beats.length; i += meter) {
    const idx = []; for (let k = 0; k < meter; k++) if (i + k >= 0 && i + k < beats.length) idx.push(i + k);
    if (!idx.length) continue;
    const slots = [];
    for (let k = 0; k < meter; k++) for (let h = 0; h < 2; h++) {
      const j = i + k; slots.push(j < 0 || j >= beats.length ? 0 : peak(bt(j) + h * (bt(j + 1) - bt(j)) / 2));
    }
    bars.push({ start: bt(Math.max(0, i)), end: bt(i + meter), chords: idx.map(j => chords[j]), slots });
  }
  const all = bars.flatMap(b => b.slots).filter(v => v > 0), thr = 0.4 * pct(all, 0.9);
  const tally = {};
  bars.forEach(b => {
    const hits = b.slots.map(v => v > thr), hv = b.slots.filter((v, k) => hits[k]), mean = hv.reduce((a, c) => a + c, 0) / (hv.length || 1);
    b.pat = b.slots.map((v, k) => !hits[k] ? '-' : (k % 2 ? 'U' : 'D') + (v > 1.3 * mean ? '!' : ''));
    if (hv.length >= 2) { const key = b.pat.map(p => p[0]).join(''); tally[key] = (tally[key] || 0) + 1; }
  });
  const ranked = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  const mainKey = ranked.length ? ranked[0][0] : 'D-D-D-D-'.slice(0, meter * 2);
  while (bars.length && bars[bars.length - 1].chords.every(c => !c)) bars.pop();
  const fullBars = bars.filter(b => b.pat.some(p => p !== '-')).length || 1;
  return { bars, pattern: mainKey.split(''), share: ranked.length ? ranked[0][1] / fullBars : 0, alt: ranked.slice(1, 3).map(r => r[0]) };
}

// ---- melody (YIN) ----
async function melody(x, maxSec) {
  const sr = SR / 2, len = Math.min(Math.floor(x.length / 2), Math.floor(maxSec * sr)), y = new Float32Array(len);
  for (let i = 0; i < len; i++) y[i] = 0.5 * (x[2 * i] + (x[2 * i + 1] || 0));
  const W = 512, H = 256, tMin = 11, tMax = 150, nF = Math.max(0, Math.floor((len - W - tMax) / H));
  const d = new Float32Array(tMax + 1), fr = [];
  for (let f = 0; f < nF; f++) {
    const o = f * H; let rms = 0; for (let j = 0; j < W; j++) rms += y[o + j] ** 2; rms = Math.sqrt(rms / W);
    for (let t = 1; t <= tMax; t++) { let s = 0; for (let j = 0; j < W; j++) { const q = y[o + j] - y[o + j + t]; s += q * q; } d[t] = s; }
    let run = 0, tau = -1;
    for (let t = 1; t <= tMax; t++) { run += d[t]; d[t] = d[t] * t / (run || 1); }
    for (let t = tMin; t < tMax; t++) if (d[t] < 0.15) { while (t + 1 < tMax && d[t + 1] < d[t]) t++; tau = t; break; }
    let midi = null;
    if (tau > 0) { const a = d[tau - 1], b = d[tau], c = d[tau + 1], den = a - 2 * b + c, tt = tau + (den ? 0.5 * (a - c) / den : 0); midi = 69 + 12 * Math.log2(sr / tt / 440); }
    fr.push({ t: o / sr, rms, midi });
    if (f % 400 === 0) await tick();
  }
  const gate = 0.15 * pct(fr.map(f => f.rms), 0.95);
  const m = fr.map(f => f.rms > gate ? f.midi : null);
  const med = m.map((v, i) => { if (v == null) return null; const w = m.slice(Math.max(0, i - 2), i + 3).filter(a => a != null).sort((a, b) => a - b); return w[w.length >> 1]; });
  const notes = []; let cur = null;
  const close = () => { if (cur && cur.v.length >= 3) { const s = cur.v.slice().sort((a, b) => a - b); notes.push({ t: cur.t, end: cur.end, p: Math.round(s[s.length >> 1]) }); } cur = null; };
  med.forEach((v, i) => {
    const t = fr[i].t;
    if (v == null) { close(); return; }
    if (cur && Math.abs(v - cur.ref) <= 0.7) { cur.v.push(v); cur.end = t + H / sr; if (cur.v.length < 4) cur.ref = cur.v.reduce((a, b) => a + b) / cur.v.length; }
    else { close(); cur = { t, end: t + H / sr, v: [v], ref: v }; }
  });
  close();
  const merged = [];
  notes.forEach(n => { const l = merged[merged.length - 1]; if (l && l.p === n.p && n.t - l.end < 0.05) l.end = n.end; else merged.push(n); });
  const md = merged.map(n => n.p).sort((a, b) => a - b)[merged.length >> 1];
  return { notes: merged.filter(n => n.end - n.t >= 0.1 && Math.abs(n.p - md) <= 14), cut: x.length / SR > maxSec };
}
function tabPositions(notes, shift) {
  const st = notes.map(n => {
    let p = n.p + shift; while (p < 40) p += 12; while (p > 88) p -= 12;
    const o = []; TUNING.forEach((b, s) => { const f = p - b; if (f >= 0 && f <= 17) o.push({ s, f, c: 0.06 * f + (f > 12 ? 0.6 : 0) + (f === 0 ? -0.2 : 0) }); });
    return o;
  });
  if (!st.length) return [];
  let cost = st[0].map(o => o.c); const bk = [];
  for (let i = 1; i < st.length; i++) {
    const nc = [], nb = [];
    st[i].forEach(o => {
      let bc = Infinity, bi = 0;
      st[i - 1].forEach((q, j) => {
        const df = (o.f === 0 || q.f === 0) ? 0 : Math.abs(o.f - q.f), v = cost[j] + 0.25 * df + Math.max(0, df - 4) + 0.15 * Math.abs(o.s - q.s);
        if (v < bc) { bc = v; bi = j; }
      });
      nc.push(bc + o.c); nb.push(bi);
    });
    cost = nc; bk.push(nb);
  }
  let k = cost.indexOf(Math.min(...cost)); const res = new Array(st.length);
  for (let i = st.length - 1; i >= 0; i--) { res[i] = st[i][k]; if (i > 0) k = bk[i - 1][k]; }
  return res;
}
function tabText(notes, pos, barTimes, perLine) {
  const names = ['e', 'B', 'G', 'D', 'A', 'E'], out = [];
  let lines = names.map(n => n + '|'), count = 0, bi = 0;
  const flush = () => { if (count) out.push(lines.map(l => l + '|').join('\n')); lines = names.map(n => n + '|'); count = 0; };
  notes.forEach((n, i) => {
    let bar = false; while (bi < barTimes.length && barTimes[bi] <= n.t) { bi++; bar = true; }
    if (bar && count) lines = lines.map(l => l + '|');
    const p = pos[i], w = String(p.f).length;
    lines = lines.map((l, r) => l + '-' + (5 - r === p.s ? String(p.f) : '-'.repeat(w)));
    count++;
    if (count >= perLine) flush();
  });
  flush();
  return out.join('\n\n');
}

// ---- chord shapes ----
const OPEN = { 'C': [-1,3,2,0,1,0], 'D': [-1,-1,0,2,3,2], 'E': [0,2,2,1,0,0], 'G': [3,2,0,0,0,3], 'A': [-1,0,2,2,2,0], 'Am': [-1,0,2,2,1,0], 'Em': [0,2,2,0,0,0], 'Dm': [-1,-1,0,2,3,1], 'E7': [0,2,0,1,0,0], 'A7': [-1,0,2,0,2,0], 'D7': [-1,-1,0,2,1,2], 'G7': [3,2,0,0,0,1], 'C7': [-1,3,2,3,1,0], 'B7': [-1,2,1,2,0,2], 'Am7': [-1,0,2,0,1,0], 'Em7': [0,2,0,0,0,0], 'Dm7': [-1,-1,0,2,1,1] };
function shape(r, q) {
  const k = PCN[r] + q; if (OPEN[k]) return OPEN[k];
  const e = ((r - 4) % 12 + 12) % 12 || 12, a = ((r - 9) % 12 + 12) % 12 || 12;
  if (e <= a) { const f = e; return { '': [0,2,2,1,0,0], 'm': [0,2,2,0,0,0], '7': [0,2,0,1,0,0], 'm7': [0,2,0,0,0,0] }[q].map(v => v + f); }
  return { '': [-1,0,2,2,2,0], 'm': [-1,0,2,2,1,0], '7': [-1,0,2,0,2,0], 'm7': [-1,0,2,0,1,0] }[q].map(v => v < 0 ? v : v + a);
}
function shapesAll(r, q) {
  const out = [], k = PCN[r] + q;
  if (OPEN[k]) out.push(OPEN[k]);
  const e = ((r - 4) % 12 + 12) % 12 || 12, a = ((r - 9) % 12 + 12) % 12 || 12;
  out.push({ '': [0,2,2,1,0,0], 'm': [0,2,2,0,0,0], '7': [0,2,0,1,0,0], 'm7': [0,2,0,0,0,0] }[q].map(v => v + e));
  out.push({ '': [-1,0,2,2,2,0], 'm': [-1,0,2,2,1,0], '7': [-1,0,2,0,2,0], 'm7': [-1,0,2,0,1,0] }[q].map(v => v < 0 ? v : v + a));
  const seen = new Set();
  return out.filter(s => { const key = s.join(); if (seen.has(key)) return false; seen.add(key); return true; });
}
function capoAdvice(chords) {
  const sc = c => chords.filter(ch => ch && OPEN[PCN[(ch.r - c + 12) % 12] + ch.q]).length;
  const s0 = sc(0), n = chords.filter(Boolean).length; let best = 0, bs = s0;
  for (let c = 1; c <= 7; c++) { const s = sc(c); if (s > bs && s >= s0 + Math.max(2, 0.1 * n)) { best = c; bs = s; } }
  return best;
}

// ---- demo synth (Karplus-Strong) ----
function synthDemo() {
  const bpm = 96, beat = 60 / bpm, prog = [['G', ''], ['D', ''], ['E', 'm'], ['C', '']], pat = [1, 0, 1, 1, 0, 1, 1, 1];
  const bars = 8, len = Math.ceil((bars * 4 * beat + 2) * SR), out = new Float32Array(len);
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5;
  const pluck = (midi, t0, amp) => {
    const f = 440 * 2 ** ((midi - 69) / 12), n = Math.round(SR / f), buf = new Float32Array(n);
    for (let i = 0; i < n; i++) buf[i] = rnd() * amp;
    const s0 = Math.round(t0 * SR), dur = Math.min(len - s0, Math.round(beat * 1.2 * SR));
    for (let i = 0; i < dur; i++) { const a = i % n, b = (i + 1) % n; const v = buf[a]; buf[a] = 0.497 * (buf[a] + buf[b]); out[s0 + i] += v * Math.min(1, (dur - i) / 400); }
  };
  for (let b = 0; b < bars; b++) {
    const [root, q] = prog[b % 4], sh = shape(PCN.indexOf(root), q);
    for (let k = 0; k < 8; k++) if (pat[k]) {
      const t = 0.5 + b * 4 * beat + k * beat / 2, down = k % 2 === 0, order = down ? [0,1,2,3,4,5] : [5,4,3,2];
      order.forEach((s, i) => { if (sh[s] >= 0) pluck(TUNING[s] + sh[s], t + i * 0.012, down ? 0.5 : 0.3); });
    }
  }
  const mel = [67, 71, 74, 71, 69, 66, 62, 66, 71, 67, 64, 67, 72, 67, 64, 60];
  let mx0 = 0; for (const v of out) mx0 = Math.max(mx0, Math.abs(v));
  for (let b = 0; b < bars; b++) for (let k = 0; k < 4; k++) {
    const p = mel[(b % 4) * 4 + k], f = 440 * 2 ** ((p - 69) / 12), s0 = Math.round((0.5 + (b * 4 + k) * beat) * SR), d = Math.round(beat * 0.9 * SR);
    for (let i = 0; i < d; i++) { const e = Math.min(1, i / 300, (d - i) / 600), ph = 2 * Math.PI * f * i / SR; out[s0 + i] += mx0 * 0.6 * e * (Math.sin(ph) + 0.35 * Math.sin(2 * ph) + 0.15 * Math.sin(3 * ph)); }
  }
  let m = 0; for (const v of out) m = Math.max(m, Math.abs(v)); for (let i = 0; i < len; i++) out[i] /= m * 1.1;
  return out;
}

async function analyse(x, meter, progress) {
  progress('Détection des attaques…'); const { env, dt } = await onsetEnv(x);
  progress('Recherche du tempo…'); await tick(); const bpm = tempo(env, dt); const beats = beatTrack(env, dt, bpm);
  progress('Reconnaissance des accords…'); const ch = await chroma(x); let chords = chordsByBeat(ch, beats);
  const cnt = new Array(meter).fill(0);
  for (let i = 1; i < chords.length; i++) if (!same(chords[i], chords[i - 1])) cnt[i % meter]++;
  const ph = cnt.indexOf(Math.max(...cnt));
  chords = chordsByBeat(ch, beats, i => { const p = ((i - ph) % meter + meter) % meter; return p === 0 ? 0.12 : (meter === 4 && p === 2) ? 0.24 : 0.45; });
  progress('Rythme de grattage…'); await tick();
  const st = structure(beats, chords, env, dt, meter);
  const realBpm = beats.length > 1 ? 60 * (beats.length - 1) / (beats[beats.length - 1] - beats[0]) : bpm;
  const L = 0.025; st.bars.forEach(b => { b.start += L; b.end += L; });
  return { bpm: realBpm, beats: beats.map(b => b + L), chords, ...st, capo: capoAdvice(chords) };
}
