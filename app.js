{
const $ = id => document.getElementById(id);
const S = { song: null, x: null, meter: 4, fr: false, capo: 0, pat: [], shift: 0, mel: null, bpm: 100, loop: null, rate: 1, pos: {} };
try { const p = JSON.parse(localStorage.getItem('cordia') || '{}'); S.fr = !!p.fr; if (p.meter === 3) S.meter = 3; } catch (e) {}
const savePrefs = () => { try { localStorage.setItem('cordia', JSON.stringify({ fr: S.fr, meter: S.meter, last: S.song && S.song.id })); } catch (e) {} };
const lastId = () => { try { return JSON.parse(localStorage.getItem('cordia') || '{}').last; } catch (e) { return null; } };
const status = t => { $('status').textContent = t; };
const tr = r => ((r - S.capo) % 12 + 12) % 12;
const nm = c => c ? (S.fr ? PCF : PCN)[tr(c.r)] + c.q : '–';
const fmt = s => (s < 0 ? '-' : '') + Math.floor(Math.abs(s) / 60) + ':' + String(Math.floor(Math.abs(s) % 60)).padStart(2, '0');
const collapse = arr => arr.filter((c, i) => i === 0 || !same(c, arr[i - 1]));
const dateFr = t => new Date(t).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) + ' ' + new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

// ---------- storage (IndexedDB) ----------
const DB = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((res, rej) => {
      try {
        const r = indexedDB.open('cordia', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('songs', { keyPath: 'id' });
        r.onsuccess = () => { this.db = r.result; res(this.db); };
        r.onerror = () => rej(r.error);
      } catch (e) { rej(e); }
    });
  },
  async run(mode, fn) { const db = await this.open(); return new Promise((res, rej) => { const t = db.transaction('songs', mode), st = t.objectStore('songs'), q = fn(st); t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error); }); },
  put(s) { return s.id === 'demo' ? Promise.resolve() : this.run('readwrite', st => st.put(s)).catch(() => status("Impossible d'enregistrer dans la bibliothèque.")); },
  get(id) { return this.run('readonly', st => st.get(id)).catch(() => null); },
  all() { return this.run('readonly', st => st.getAll()).catch(() => []); },
  del(id) { return this.run('readwrite', st => st.delete(id)); }
};
const persist = () => { if (S.song) { S.song.pat = S.pat.slice(); S.song.bpm = S.bpm; DB.put(S.song); } };

// ---------- audio helpers ----------
const toI16 = x => { const o = new Int16Array(x.length); for (let i = 0; i < x.length; i++) o[i] = Math.max(-1, Math.min(1, x[i])) * 32767; return o; };
const toF32 = a => { const o = new Float32Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] / 32767; return o; };
async function resample(data, rate) {
  const oc = new OfflineAudioContext(1, Math.max(1, Math.ceil(data.length / rate * SR)), SR), b = oc.createBuffer(1, data.length, rate);
  b.getChannelData(0).set(data); const src = oc.createBufferSource(); src.buffer = b; src.connect(oc.destination); src.start();
  return (await oc.startRendering()).getChannelData(0);
}
async function decode(buf) {
  const ac = new OfflineAudioContext(1, 2, 44100), b = await ac.decodeAudioData(buf), dur = Math.min(b.duration, 480);
  const oc = new OfflineAudioContext(1, Math.ceil(dur * SR), SR), src = oc.createBufferSource();
  src.buffer = b; src.connect(oc.destination); src.start();
  return { x: (await oc.startRendering()).getChannelData(0), cut: b.duration > 480 };
}
function wav(x) {
  const n = x.length, b = new DataView(new ArrayBuffer(44 + n * 2)), w = (o, s) => [...s].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); b.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, 1, true);
  b.setUint32(24, SR, true); b.setUint32(28, SR * 2, true); b.setUint16(32, 2, true); b.setUint16(34, 16, true); w(36, 'data'); b.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) b.setInt16(44 + i * 2, Math.max(-1, Math.min(1, x[i])) * 32767, true);
  return new Blob([b], { type: 'audio/wav' });
}
async function getX(song) {
  if (S.x) return S.x;
  if (song.pcm) S.x = toF32(song.pcm);
  else if (song.blob) S.x = (await decode(await song.blob.arrayBuffer())).x;
  return S.x;
}
function shiftRes(res, off) {
  if (!off) return res;
  res.beats = res.beats.map(t => t + off);
  res.bars.forEach(b => { b.start += off; b.end += off; });
  return res;
}
function patternFrom(res) {
  const key = res.pattern.join(''), bars = res.bars.filter(b => b.pat.map(p => p[0]).join('') === key);
  return key.split('').map((d, k) => d === '-' ? '-' : d + (bars.length && bars.filter(b => b.pat[k].endsWith('!')).length / bars.length > 0.4 ? '!' : ''));
}

// ---------- YouTube (official player only) ----------
let ytLoading = null;
function loadYT() {
  if (window.YT && YT.Player) return Promise.resolve();
  if (ytLoading) return ytLoading;
  ytLoading = new Promise((res, rej) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { if (prev) prev(); res(); };
    const s = document.createElement('script'); s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { ytLoading = null; rej(new Error('YouTube injoignable')); };
    document.head.appendChild(s);
    setTimeout(() => rej(new Error('YouTube ne répond pas')), 15000);
  });
  return ytLoading;
}
const ytIdOf = u => { u = (u || '').trim(); const m = u.match(/(?:youtu\.be\/|[?&]v=|shorts\/|embed\/|live\/)([\w-]{11})/); return m ? m[1] : (/^[\w-]{11}$/.test(u) ? u : null); };
async function makeYT(box, id) {
  await loadYT();
  box.innerHTML = '<div></div>';
  return new Promise(res => { const p = new YT.Player(box.firstChild, { videoId: id, width: '100%', height: '100%', playerVars: { playsinline: 1, rel: 0 }, events: { onReady: () => res(p), onStateChange: () => onPlayState() } }); });
}

// ---------- player abstraction ----------
const P = {
  kind: null, yt: null,
  time() { return this.kind === 'yt' ? (this.yt && this.yt.getCurrentTime ? this.yt.getCurrentTime() : 0) : $('audio').currentTime || 0; },
  dur() { return this.kind === 'yt' ? (this.yt && this.yt.getDuration ? this.yt.getDuration() : 0) : ($('audio').duration && isFinite($('audio').duration) ? $('audio').duration : (S.song ? S.song.res.beats[S.song.res.beats.length - 1] || 0 : 0)); },
  paused() { return this.kind === 'yt' ? !(this.yt && this.yt.getPlayerState && this.yt.getPlayerState() === 1) : $('audio').paused; },
  async play() { if (this.kind === 'yt') this.yt && this.yt.playVideo(); else await $('audio').play(); },
  pause() { if (this.kind === 'yt') this.yt && this.yt.pauseVideo(); else $('audio').pause(); },
  seek(t) { if (this.kind === 'yt') this.yt && this.yt.seekTo(t, true); else $('audio').currentTime = Math.max(0, t); },
  rate(r) { if (this.kind === 'yt') this.yt && this.yt.setPlaybackRate(r); else { $('audio').preservesPitch = true; $('audio').playbackRate = r; } }
};
let wake = null;
async function keepAwake(on) { try { if (on && !wake) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => wake = null); } else if (!on && wake) { await wake.release(); wake = null; } } catch (e) {} }
function onPlayState() {
  const paused = P.paused(); keepAwake(!paused || document.body.classList.contains('stage'));
  $('playIco').innerHTML = paused ? '<path d="M6 3l13 8-13 8z" fill="currentColor"/>' : '<path d="M5 3h4v16H5zM13 3h4v16h-4z" fill="currentColor"/>';
  if (!paused) requestAnimationFrame(frame);
}
function frame() { tickUI(); if (!P.paused()) requestAnimationFrame(frame); }

// ---------- diagrams ----------
function posOf(c) { const k = tr(c.r) + c.q, all = shapesAll(tr(c.r), c.q); return { all, i: (S.pos[k] || 0) % all.length, k }; }
function diagram(c) {
  if (!c) return '';
  const { all, i } = posOf(c), sh = all[i], fr = sh.filter(f => f > 0), base = fr.length && Math.max(...fr) > 4 ? Math.min(...fr) : 1;
  const x = s => 18 + s * 17, y = f => 30 + f * 22;
  let g = `<rect x="18" y="30" width="85" height="110" fill="none" stroke="currentColor" stroke-opacity=".35"/>`;
  for (let s = 1; s < 5; s++) g += `<line x1="${x(s)}" y1="30" x2="${x(s)}" y2="140" stroke="currentColor" stroke-opacity=".35"/>`;
  for (let f = 1; f < 5; f++) g += `<line x1="18" y1="${y(f)}" x2="103" y2="${y(f)}" stroke="currentColor" stroke-opacity=".35"/>`;
  if (base === 1) g += `<rect x="16" y="27" width="89" height="4" fill="currentColor"/>`; else g += `<text x="0" y="${y(0.6)}">${base}</text>`;
  sh.forEach((f, s) => {
    if (f < 0) g += `<text x="${x(s) - 4}" y="22">×</text>`;
    else if (f === 0) g += `<circle cx="${x(s)}" cy="17" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5"/>`;
    else g += `<circle cx="${x(s)}" cy="${y(f - base + 0.5)}" r="7" fill="var(--acc)"/>`;
  });
  return g;
}
const cyclePos = c => { if (!c) return; const { all, i, k } = posOf(c); S.pos[k] = (i + 1) % all.length; render(); };

// ---------- song view ----------
const arrow = d => d === 'U' ? '<path d="M17 4 L6 18 h7 v30 h8 v-30 h7 z" fill="currentColor"/>' : d === 'D' ? '<path d="M17 48 L6 34 h7 v-30 h8 v30 h7 z" fill="currentColor"/>' : '<circle cx="17" cy="26" r="3" fill="currentColor" opacity=".4"/>';
function renderStrum(live) {
  renderMini();
  const n = S.pat.length, lbl = []; for (let k = 0; k < n / 2; k++) lbl.push(String(k + 1), 'et');
  $('strum').style.gridTemplateColumns = `repeat(${n},minmax(0,1fr))`;
  $('strum').innerHTML = S.pat.map((p, k) => `<button type="button" class="slot ${p !== '-' ? 'on' : ''} ${p.endsWith('!') ? 'acc' : ''} ${live === k ? 'live' : ''}" data-k="${k}" aria-label="Temps ${lbl[k]} : ${p[0] === 'D' ? 'bas' : p[0] === 'U' ? 'haut' : 'rien'}${p.endsWith('!') ? ', accentué' : ''}"><small>${lbl[k]}</small><svg viewBox="0 0 34 52">${arrow(p[0])}</svg></button>`).join('');
}
function renderMini() {
  const n = S.pat.length;
  $('mini').style.gridTemplateColumns = `repeat(${n},minmax(0,1fr))`;
  $('mini').innerHTML = S.pat.map((p, k) => `<span class="${p.endsWith('!') ? 'acc' : ''}"><svg viewBox="0 0 34 52">${arrow(p[0])}</svg><small>${k % 2 ? 'et' : k / 2 + 1}</small></span>`).join('');
}
function render() {
  $('capo').innerHTML = [0, 1, 2, 3, 4, 5, 7].map(c => `<button type="button" data-v="${c}" aria-pressed="${S.capo === c}">${c || 'Sans'}</button>`).join('');
  const r = S.song && S.song.res;
  if (!r) return;
  $('songTitle').value = S.song.title || '';
  const uniq = []; r.chords.forEach(c => { if (c && !uniq.some(u => same(u, c))) uniq.push(c); });
  $('meta').innerHTML = `<span>Tempo <b>${Math.round(r.bpm)} BPM</b></span><span>Mesure <b>${S.song.meter || S.meter}/4</b></span>` + (r.capo && !S.capo ? `<span>Astuce : <b>capo ${r.capo}</b> pour des accords plus simples</span>` : S.capo ? `<span>Formes jouées avec <b>capo ${S.capo}</b></span>` : '');
  $('grid').innerHTML = r.bars.map((b, i) => `<button type="button" class="cell${S.loop && i >= S.loop.i && i <= S.loop.j ? ' loop' : ''}" data-i="${i}"><span class="n">${i + 1}${b.edited ? ' · corrigé' : ''}</span>${collapse(b.chords.filter(Boolean)).map(nm).join(' ') || '–'}</button>`).join('');
  $('shapes').innerHTML = uniq.map((c, i) => { const p = posOf(c); return `<button type="button" class="shape" data-u="${i}">${nm(c)}<svg viewBox="0 0 120 150">${diagram(c)}</svg><small>${p.all.length > 1 ? `position ${p.i + 1}/${p.all.length}` : ''}</small></button>`; }).join('') || '<p class="empty">Aucun accord reconnu.</p>';
  S.uniq = uniq;
  const fb = r.bars.filter(b => b.pat.some(p => p !== '-')).length;
  $('strumSub').textContent = r.share ? `Motif le plus fréquent : il revient sur ${Math.round(r.share * fb)} mesure${r.share * fb >= 2 ? 's' : ''} sur ${fb}. Touche une case pour la modifier : bas, accentué, haut, accentué, rien.` : 'Pas de grattage net détecté : voici un motif de départ. Touche une case pour le modifier.';
  $('altLbl').textContent = r.alt.length ? 'Autres variantes entendues' : '';
  $('alts').innerHTML = r.alt.map(a => `<button type="button" class="chip" data-p="${a}">${a.split('').map(c => c === 'D' ? '↓' : c === 'U' ? '↑' : '·').join(' ')}</button>`).join('');
  $('tempo').textContent = Math.round(S.bpm) + ' BPM';
  $('loopBtn').textContent = S.loop ? 'Arrêter la boucle' : 'Boucler 2 mesures';
  buildTrack(); renderStrum(); tickUI(true);
}
function buildTrack() {
  const r = S.song.res, starts = new Set();
  r.bars.forEach(b => { let k = 0, d = 1e9; r.beats.forEach((t, i) => { const e = Math.abs(t - b.start); if (e < d) { d = e; k = i; } }); starts.add(k); });
  let bar = 0;
  $('track').innerHTML = r.beats.map((t, i) => {
    const c = r.chords[i], chg = i === 0 || !same(c, r.chords[i - 1]), b1 = starts.has(i);
    if (b1) bar++;
    return `<div class="bt${b1 ? ' b1' : ''}" data-b="${i}">${b1 ? `<small>${bar}</small>` : '<small>&nbsp;</small>'}${chg && c ? nm(c) : '<i></i>'}</div>`;
  }).join('');
  const inBar = []; let p = 0; r.beats.forEach((t, i) => { if (starts.has(i)) p = 0; inBar.push(p++); });
  const first = Math.min(...starts); for (let i = 0; i < first; i++) inBar[i] = (S.song.meter || S.meter) - first + i;
  S.inBar = inBar;
}
let lastBar = -1, lastBeat = -1;
function tickUI(force) {
  const r = S.song && S.song.res; if (!r) return;
  let t = P.time(); const d = P.dur();
  if (S.loop && !P.paused() && t >= S.loop.b) { P.seek(S.loop.a); t = S.loop.a; }
  $('time').textContent = fmt(t) + ' / ' + fmt(d || 0);
  if (!seeking) $('seek').value = d ? Math.round(1000 * t / d) : 0;
  let i = 0; while (i + 1 < r.beats.length && r.beats[i + 1] <= t) i++;
  const nb = r.beats[i + 1] || r.beats[i] + 0.5, fr = Math.max(-2, Math.min(1, (t - r.beats[i]) / ((nb - r.beats[i]) || 0.5)));
  const lane = $('lane'), bw = parseFloat(getComputedStyle(lane).getPropertyValue('--bw')) || 76;
  $('track').style.transform = `translateX(${lane.clientWidth * 0.16 - (i + fr) * bw}px)`;
  const ms = S.inBar ? (S.inBar[i] || 0) * 2 + (fr >= 0.5 ? 1 : 0) : -1, mk = $('mini').children;
  for (let k = 0; k < mk.length; k++) mk[k].classList.toggle('live', !P.paused() && k === ms);
  if (i !== lastBeat) { const o = $('track').children; if (o[lastBeat]) o[lastBeat].classList.remove('on'); if (o[i]) o[i].classList.add('on'); lastBeat = i; }
  const c = r.chords[i] || r.chords.find(Boolean), nx = r.chords.slice(i + 1).find(n => n && !same(n, c));
  $('now').textContent = nm(c); $('dgNow').innerHTML = diagram(c); S.curChord = c;
  $('next').innerHTML = nx ? `Ensuite : <b>${nm(nx)}</b>` : '';
  const bi = r.bars.findIndex(b => t >= b.start && t < b.end);
  if (bi !== lastBar || force) {
    document.querySelectorAll('.cell').forEach((e, k) => e.classList.toggle('cur', k === bi)); lastBar = bi; S.curBar = bi;
    const cell = document.querySelectorAll('.cell')[bi], g = $('grid').getBoundingClientRect();
    if (cell && !force && !P.paused() && !document.body.classList.contains('stage') && g.bottom > 0 && g.top < innerHeight) {
      const cr = cell.getBoundingClientRect(); if (cr.top < 80 || cr.bottom > innerHeight - 90) cell.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }
  }
}

async function openSong(song, go) {
  stopLoop(); P.pause(); S.loop = null; S.x = null; S.mel = null; S.capo = 0; S.rate = 1;
  S.song = song; S.pat = (song.pat && song.pat.length ? song.pat : patternFrom(song.res)).slice(); S.bpm = song.bpm || song.res.bpm;
  $('tab').textContent = 'La tablature apparaîtra ici.'; $('melNote').textContent = '';
  $('speed').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === '1'));
  if (song.source === 'yt' && song.ytId) {
    P.kind = 'yt'; $('ytBox').hidden = false; $('audio').removeAttribute('src');
    try { P.yt = await makeYT($('ytBox'), song.ytId); } catch (e) { status('La vidéo YouTube ne peut pas se charger (connexion ?). Les accords restent consultables.'); }
  } else {
    P.kind = 'audio'; $('ytBox').hidden = true; $('ytBox').innerHTML = '';
    const blob = song.blob || (song.pcm ? wav(toF32(song.pcm)) : null);
    if (blob) $('audio').src = URL.createObjectURL(blob);
  }
  savePrefs(); render();
  if (go) location.hash = '#morceau';
}

async function importFile(file) {
  status('Lecture du fichier…');
  try {
    const { x, cut } = await decode(await file.arrayBuffer());
    const res = await analyse(x, S.meter, status);
    const song = { id: 'f' + Date.now().toString(36), title: file.name.replace(/\.[^.]+$/, ''), source: 'file', blob: file, res, meter: S.meter, bpm: res.bpm, created: Date.now() };
    song.pat = patternFrom(res);
    await DB.put(song); await openSong(song, true); S.x = x;
    status(`« ${song.title} » analysé${cut ? ' (8 premières minutes)' : ''} et rangé dans ta bibliothèque.`);
  } catch (e) { status('Impossible de lire ce fichier. Essaie un MP3, M4A, WAV ou MP4.'); }
}
async function reanalyse(meter) {
  const song = S.song; if (!song || song.id === 'demo' && !song.pcm) return;
  status('Nouvelle analyse…');
  const x = await getX(song), res = shiftRes(await analyse(x, meter, status), song.offset || 0);
  Object.assign(song, { res, meter, bpm: res.bpm, pat: patternFrom(res) });
  await DB.put(song); const keepX = S.x; await openSong(song); S.x = keepX;
  status(`Analyse refaite en ${meter}/4. Les corrections manuelles de ce morceau ont été remises à zéro.`);
}
function demoSong() {
  const x = synthDemo();
  return analyse(x, S.meter, () => {}).then(res => ({ id: 'demo', title: 'Exemple : Sol, Ré, Mim, Do', source: 'live', pcm: toI16(x), res, meter: S.meter, bpm: res.bpm, created: Date.now() }));
}

// ---------- strum loop (plays the current chord) ----------
let ac = null, timer = null;
function audioCtx() { ac = ac || new (window.AudioContext || window.webkitAudioContext)(); ac.resume(); return ac; }
function strumAt(t, c, dir, acc) {
  const { all, i } = posOf(c), sh = all[i], ord = dir === 'D' ? [0, 1, 2, 3, 4, 5] : [5, 4, 3, 2];
  ord.forEach((s, k) => {
    if (sh[s] < 0) return;
    const o = ac.createOscillator(), g = ac.createGain(), tt = t + k * 0.011, amp = (acc ? 0.16 : 0.09) * (dir === 'D' ? 1 : 0.75);
    o.type = 'triangle'; o.frequency.value = 440 * 2 ** ((TUNING[s] + sh[s] + S.capo - 69) / 12);
    g.gain.setValueAtTime(0, tt); g.gain.linearRampToValueAtTime(amp, tt + 0.006); g.gain.exponentialRampToValueAtTime(0.0008, tt + 0.7);
    o.connect(g).connect(ac.destination); o.start(tt); o.stop(tt + 0.75);
  });
}
function stopLoop() { if (timer) clearInterval(timer); timer = null; $('loop').textContent = 'Écouter le motif'; renderStrum(); }
function startLoop() {
  try { audioCtx(); } catch (e) { status("Le son n'est pas disponible ici."); return; }
  const r = S.song.res; let next = ac.currentTime + 0.1, k = 0;
  timer = setInterval(() => {
    while (next < ac.currentTime + 0.15) {
      const t = P.time(); let i = 0; while (i + 1 < r.beats.length && r.beats[i + 1] <= t) i++;
      const c = r.chords[i] || r.chords.find(Boolean) || { r: 7, q: '' }, p = S.pat[k];
      if (p !== '-') strumAt(next, c, p[0], p.endsWith('!'));
      const kk = k; setTimeout(() => timer && renderStrum(kk), Math.max(0, (next - ac.currentTime) * 1000));
      next += 30 / S.bpm; k = (k + 1) % S.pat.length;
    }
  }, 25);
  $('loop').textContent = 'Arrêter';
}

// ---------- chord correction ----------
const QL = [['', 'majeur'], ['m', 'mineur'], ['7', '7'], ['m7', 'm7']];
let edit = null;
function openEdit(bi) {
  const r = S.song.res, bar = r.bars[bi], b0 = r.beats.findIndex(t => Math.abs(t - bar.start) < 0.02);
  const idx = []; for (let k = 0; k < bar.chords.length; k++) idx.push(Math.max(0, b0) + k);
  const segs = []; idx.forEach((j, k) => { const c = bar.chords[k]; if (!segs.length || !same(segs[segs.length - 1].c, c)) segs.push({ c, js: [j], ks: [k] }); else { segs[segs.length - 1].js.push(j); segs[segs.length - 1].ks.push(k); } });
  edit = { bi, segs, s: 0, r: null, q: '' };
  const pickSeg = s => { edit.s = s; const c = segs[s].c; edit.r = c ? tr(c.r) : null; edit.q = c ? c.q : ''; drawEdit(); };
  $('dlgT').textContent = `Corriger la mesure ${bi + 1}`;
  $('dlgSub').textContent = segs.length > 1 ? 'Choisis la partie de la mesure, puis le bon accord.' : 'Choisis le bon accord (forme jouée, capo compris).';
  edit.pickSeg = pickSeg; pickSeg(0); $('dlg').showModal();
}
function drawEdit() {
  $('dlgSegs').innerHTML = edit.segs.length > 1 ? edit.segs.map((g, i) => `<button type="button" data-s="${i}" aria-pressed="${i === edit.s}" class="${i === edit.s ? 'main' : ''}">${nm(g.c)} (${g.ks.length} temps)</button>`).join('') : '';
  $('dlgRoot').innerHTML = (S.fr ? PCF : PCN).map((n, i) => `<button type="button" data-r="${i}" aria-pressed="${edit.r === i}">${n}</button>`).join('');
  $('dlgQual').innerHTML = QL.map(([q, l]) => `<button type="button" data-q="${q}" aria-pressed="${edit.r !== null && edit.q === q}">${l}</button>`).join('') + `<button type="button" data-none="1" aria-pressed="${edit.r === null}">aucun</button>`;
}

// ---------- live listening ----------
const L = { on: false, chunks: [], len: 0, chr: new Float32Array(12), bass: new Float32Array(12), cur: null, cand: null, candN: 0, hist: [], yt: null, ytId: null, ytStart: 0, wake: null };
function liveChroma(lin, sr, N) {
  const kLo = Math.floor(55 * N / sr), kHi = Math.ceil(2100 * N / sr), c = new Float32Array(12), b = new Float32Array(12);
  let mx = 0, e = 0, low = false;
  for (let k = kLo; k < kHi; k++) if (lin[k] > mx) mx = lin[k];
  for (let k = kLo; k < kHi; k++) {
    const a = lin[k - 1], v = lin[k], n = lin[k + 1];
    if (!(v > a && v >= n) || v < mx * 0.02) continue;
    const den = a - 2 * v + n, kk = k + (den ? 0.5 * (a - n) / den : 0), fq = kk * sr / N, pc = ((Math.round(12 * Math.log2(fq / 440)) + 69) % 12 + 12) % 12;
    c[pc] += v; e += v; if (!low && v > mx * 0.15 && fq < 330) { b[pc] += v; low = true; }
  }
  return { c, b, e };
}
function liveTick() {
  const an = L.an, N = an.fftSize, fb = L.fb, td = L.td;
  an.getFloatFrequencyData(fb); an.getFloatTimeDomainData(td);
  let rms = 0; for (let i = 0; i < td.length; i++) rms += td[i] * td[i]; rms = Math.sqrt(rms / td.length);
  $('liveLvl').style.width = Math.min(100, rms * 400) + '%';
  const el = (performance.now() - L.t0) / 1000;
  $('liveTime').textContent = fmt(el);
  if (rms < 0.004) { $('liveInfo').textContent = 'Écoute… (trop calme pour l\'instant)'; return; }
  const lin = L.lin; for (let k = 0; k < fb.length; k++) lin[k] = 10 ** (fb[k] / 20);
  const { c, b } = liveChroma(lin, L.ac.sampleRate, N);
  let sc = 0, sb = 0; c.forEach(v => sc += v); b.forEach(v => sb += v);
  for (let k = 0; k < 12; k++) { L.chr[k] = 0.82 * L.chr[k] + 0.18 * (sc ? c[k] / sc : 0); L.bass[k] = 0.82 * L.bass[k] + 0.18 * (sb ? b[k] / sb : 0); }
  let n = 0; L.chr.forEach(v => n += v * v); n = Math.sqrt(n) || 1; const bm = Math.max(...L.bass) || 1;
  let best = null, bs = -1, curS = -1;
  TPL.forEach(t => { let s = 0; for (let k = 0; k < 12; k++) s += t.v[k] * L.chr[k] / n; s = s * t.pen + BASSW * L.bass[t.r] / bm; if (L.cur && t.r === L.cur.r && t.q === L.cur.q) curS = s; if (s > bs) { bs = s; best = { r: t.r, q: t.q }; } });
  if (L.cur && bs < curS + 0.03) best = L.cur;
  if (L.cand && same(L.cand, best)) L.candN++; else { L.cand = best; L.candN = 1; }
  if (L.candN >= 3 && !same(L.cur, L.cand)) {
    L.cur = L.cand; L.hist.push(L.cur);
    $('liveNow').textContent = nm(L.cur); $('liveDg').innerHTML = diagram(L.cur);
    $('liveHist').innerHTML = L.hist.slice(-16).map(h => `<span>${nm(h)}</span>`).join('');
  }
  $('liveInfo').textContent = 'Écoute en cours… touche « Arrêter » pour tout analyser.';
}
async function liveStart() {
  tunerStop();
  try {
    L.st = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  } catch (e) { status("Le micro est refusé. Autorise-le dans les réglages du site (icône à gauche de l'adresse)."); return; }
  L.ac = new (window.AudioContext || window.webkitAudioContext)(); await L.ac.resume();
  const src = L.ac.createMediaStreamSource(L.st);
  L.an = L.ac.createAnalyser(); L.an.fftSize = 8192; L.an.smoothingTimeConstant = 0; src.connect(L.an);
  L.fb = new Float32Array(L.an.frequencyBinCount); L.td = new Float32Array(L.an.fftSize); L.lin = new Float32Array(L.an.frequencyBinCount);
  L.sp = L.ac.createScriptProcessor(4096, 1, 1); src.connect(L.sp); L.sp.connect(L.ac.destination);
  L.chunks = []; L.len = 0; L.hist = []; L.cur = null; L.cand = null; L.chr.fill(0); L.bass.fill(0);
  const cap = L.ac.sampleRate * 600;
  L.sp.onaudioprocess = e => { e.outputBuffer.getChannelData(0).fill(0); if (L.len < cap) { L.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0))); L.len += 4096; } };
  L.ytStart = L.yt && L.yt.getCurrentTime ? L.yt.getCurrentTime() : 0;
  L.t0 = performance.now(); L.on = true; L.timer = setInterval(liveTick, 100);
  try { L.wake = await navigator.wakeLock.request('screen'); } catch (e) {}
  $('liveBtn').textContent = 'Arrêter et analyser'; $('liveHist').innerHTML = '';
  status(L.yt ? 'Lance la vidéo : Cordia écoute ce qui sort du haut-parleur. Évite de la mettre en pause pendant l\'écoute.' : 'Écoute en cours.');
}
async function liveStop() {
  clearInterval(L.timer); L.on = false; $('liveBtn').textContent = "Commencer l'écoute";
  try { L.sp.disconnect(); L.st.getTracks().forEach(t => t.stop()); } catch (e) {}
  try { L.wake && L.wake.release(); } catch (e) {}
  const rate = L.ac.sampleRate; L.ac.close();
  if (L.len < rate * 5) { $('liveInfo').textContent = 'Trop court pour analyser (au moins 5 secondes).'; return; }
  $('liveInfo').textContent = 'Analyse de l\'enregistrement…';
  const raw = new Float32Array(L.len); let o = 0; L.chunks.forEach(c => { raw.set(c, o); o += c.length; }); L.chunks = [];
  const x = await resample(raw, rate);
  const res = shiftRes(await analyse(x, S.meter, t => $('liveInfo').textContent = t), L.yt ? L.ytStart : 0);
  let title = 'Écoute du ' + dateFr(Date.now());
  try { if (L.yt) title = L.yt.getVideoData().title || title; } catch (e) {}
  const song = { id: 'l' + Date.now().toString(36), title, source: L.yt ? 'yt' : 'live', ytId: L.yt ? L.ytId : null, offset: L.yt ? L.ytStart : 0, pcm: toI16(x), res, meter: S.meter, bpm: res.bpm, created: Date.now() };
  song.pat = patternFrom(res);
  if (L.yt) { try { L.yt.pauseVideo(); } catch (e) {} }
  await DB.put(song); await openSong(song, true); S.x = x;
  status(`« ${title} » analysé et rangé dans ta bibliothèque.`);
  $('liveInfo').textContent = 'Analyse terminée.';
}

// ---------- tuner ----------
const T = { on: false };
const NOTES_FR = ['Do', 'Do#', 'Ré', 'Mib', 'Mi', 'Fa', 'Fa#', 'Sol', 'Lab', 'La', 'Sib', 'Si'];
const STR = [['Mi', 40], ['La', 45], ['Ré', 50], ['Sol', 55], ['Si', 59], ['Mi', 64]];
$('strings').innerHTML = STR.map(([n], i) => `<span data-i="${i}">${n}</span>`).join('');
function yinPitch(buf, sr) {
  const W = 2048, tMax = Math.min(Math.floor(sr / 65), buf.length - W - 1), tMin = Math.floor(sr / 1100), d = new Float32Array(tMax + 1);
  for (let t = 1; t <= tMax; t++) { let s = 0; for (let j = 0; j < W; j++) { const q = buf[j] - buf[j + t]; s += q * q; } d[t] = s; }
  let run = 0; for (let t = 1; t <= tMax; t++) { run += d[t]; d[t] = d[t] * t / (run || 1); }
  for (let t = tMin; t < tMax; t++) if (d[t] < 0.12) { while (t + 1 < tMax && d[t + 1] < d[t]) t++; const a = d[t - 1], b = d[t], c = d[t + 1], den = a - 2 * b + c; return sr / (t + (den ? 0.5 * (a - c) / den : 0)); }
  return 0;
}
function tunerTick() {
  T.an.getFloatTimeDomainData(T.buf);
  let rms = 0; for (const v of T.buf) rms += v * v; rms = Math.sqrt(rms / T.buf.length);
  if (rms < 0.008) return;
  const f = yinPitch(T.buf, T.ac.sampleRate); if (!f) return;
  const m = 69 + 12 * Math.log2(f / 440), r = Math.round(m), cents = Math.round((m - r) * 100);
  let si = 0; STR.forEach(([, p], i) => { if (Math.abs(p - m) < Math.abs(STR[si][1] - m)) si = i; });
  $('tNote').textContent = S.fr ? NOTES_FR[((r % 12) + 12) % 12] : PCN[((r % 12) + 12) % 12].replace('Eb', 'D#').replace('Ab', 'G#').replace('Bb', 'A#');
  $('tCents').textContent = `${f.toFixed(1)} Hz · ${cents > 0 ? '+' : ''}${cents} cents · ${Math.abs(cents) < 5 ? 'juste' : cents < 0 ? 'trop bas, serre' : 'trop haut, desserre'}`;
  $('needle').style.left = (50 + Math.max(-50, Math.min(50, cents)) * 0.9) + '%';
  $('gauge').classList.toggle('ok', Math.abs(cents) < 5);
  document.querySelectorAll('#strings span').forEach((e, i) => e.classList.toggle('on', i === si));
}
async function tunerStart() {
  if (L.on) { status("Arrête d'abord l'écoute en direct."); return; }
  try { T.st = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }); }
  catch (e) { status("Le micro est refusé. Autorise-le dans les réglages du site."); return; }
  T.ac = new (window.AudioContext || window.webkitAudioContext)(); await T.ac.resume();
  T.an = T.ac.createAnalyser(); T.an.fftSize = 4096; T.ac.createMediaStreamSource(T.st).connect(T.an); T.buf = new Float32Array(T.an.fftSize);
  T.timer = setInterval(tunerTick, 100); T.on = true; $('tunerBtn').textContent = "Éteindre l'accordeur";
}
function tunerStop() {
  if (!T.on) return; clearInterval(T.timer); T.on = false;
  try { T.st.getTracks().forEach(t => t.stop()); T.ac.close(); } catch (e) {}
  $('tunerBtn').textContent = "Allumer l'accordeur";
}

// ---------- library ----------
async function renderLib() {
  const all = (await DB.all()).sort((a, b) => b.created - a.created);
  const src = { file: 'Fichier', live: 'Écoute directe', yt: 'YouTube' };
  $('lib').innerHTML = all.length ? all.map(s => `<li><button type="button" class="open" data-id="${s.id}">${s.title.replace(/</g, '&lt;')}<small>${src[s.source] || ''} · ${Math.round(s.bpm || s.res.bpm)} BPM · ${dateFr(s.created)}</small></button><button type="button" data-del="${s.id}" aria-label="Supprimer ${s.title.replace(/"/g, '')}">Supprimer</button></li>`).join('')
    : '<li class="empty">Ta bibliothèque est vide. Importe un morceau ou lance une écoute en direct.</li>';
}

// ---------- routing ----------
function route() {
  const v = (location.hash || '#morceau').slice(1), ok = ['morceau', 'direct', 'biblio', 'accordeur'].includes(v) ? v : 'morceau';
  document.querySelectorAll('.view').forEach(e => e.hidden = e.id !== 'v-' + ok);
  document.body.dataset.view = ok;
  document.querySelectorAll('nav.tabs a').forEach(a => { if (a.getAttribute('href') === '#' + ok) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  if (ok === 'biblio') renderLib();
  if (ok !== 'accordeur') tunerStop();
  if (ok !== 'morceau') stopLoop();
}

// ---------- events ----------
$('file').addEventListener('change', e => { const f = e.target.files[0]; if (f) importFile(f); e.target.value = ''; });
const seg = (id, fn) => $(id).addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; $(id).querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x === b)); fn(b.dataset.v); });
seg('meter', v => { S.meter = +v; savePrefs(); if (S.song) reanalyse(+v); });
seg('nota', v => { S.fr = v === 'fr'; savePrefs(); render(); if (L.cur) $('liveNow').textContent = nm(L.cur); });
seg('capo', v => { S.capo = +v; render(); });
seg('speed', v => { S.rate = +v; P.rate(S.rate); });
$('nota').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', (b.dataset.v === 'fr') === S.fr));
$('meter').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', +b.dataset.v === S.meter));
$('songTitle').addEventListener('change', e => { if (S.song) { S.song.title = e.target.value.trim() || S.song.title; persist(); } });
const cyc = ['-', 'D', 'D!', 'U', 'U!'];
$('strum').addEventListener('click', e => { const b = e.target.closest('.slot'); if (!b) return; const k = +b.dataset.k; S.pat[k] = cyc[(cyc.indexOf(S.pat[k]) + 1) % cyc.length]; renderStrum(); persist(); });
$('alts').addEventListener('click', e => { const b = e.target.closest('.chip'); if (!b) return; S.pat = patternFrom({ pattern: b.dataset.p.split(''), bars: S.song.res.bars }); renderStrum(); persist(); });
$('loop').addEventListener('click', () => { if (!S.song) return; timer ? stopLoop() : startLoop(); });
$('tdown').addEventListener('click', () => { S.bpm = Math.max(40, S.bpm - 4); $('tempo').textContent = Math.round(S.bpm) + ' BPM'; persist(); });
$('tup').addEventListener('click', () => { S.bpm = Math.min(220, S.bpm + 4); $('tempo').textContent = Math.round(S.bpm) + ' BPM'; persist(); });
let press = null, longDone = false;
$('grid').addEventListener('pointerdown', e => { const b = e.target.closest('.cell'); if (!b) return; longDone = false; press = setTimeout(() => { longDone = true; openEdit(+b.dataset.i); }, 550); });
['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => $('grid').addEventListener(ev, () => clearTimeout(press)));
$('grid').addEventListener('contextmenu', e => e.preventDefault());
$('grid').addEventListener('click', e => { const b = e.target.closest('.cell'); if (!b || !S.song || longDone) return; P.seek(S.song.res.bars[+b.dataset.i].start); tickUI(true); });
$('shapes').addEventListener('click', e => { const b = e.target.closest('.shape'); if (b) cyclePos(S.uniq[+b.dataset.u]); });
$('dgNow').addEventListener('click', () => cyclePos(S.curChord));
$('loopBtn').addEventListener('click', () => {
  if (!S.song) return;
  if (S.loop) { S.loop = null; render(); return; }
  const bars = S.song.res.bars, i = Math.max(0, S.curBar), j = Math.min(bars.length - 1, i + 1);
  S.loop = { i, j, a: bars[i].start, b: bars[j].end }; render(); status(`Boucle sur les mesures ${i + 1} et ${j + 1}. Touche une autre mesure puis ce bouton pour changer.`);
});
$('play').addEventListener('click', async () => { try { if (P.paused()) { await P.play(); P.rate(S.rate); } else P.pause(); } catch (e) { status('La lecture a été refusée.'); } onPlayState(); });
$('audio').addEventListener('play', onPlayState); $('audio').addEventListener('pause', onPlayState);
let seeking = false;
$('seek').addEventListener('input', e => { seeking = true; const d = P.dur(); if (d) P.seek(d * e.target.value / 1000); tickUI(true); });
$('seek').addEventListener('change', () => { seeking = false; });
// dialogs
$('dlgSegs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) edit.pickSeg(+b.dataset.s); });
$('dlgRoot').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { edit.r = +b.dataset.r; drawEdit(); } });
$('dlgQual').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.none) edit.r = null; else { edit.q = b.dataset.q; if (edit.r === null) edit.r = 0; } drawEdit(); });
$('dlgCancel').addEventListener('click', () => $('dlg').close());
$('dlgOk').addEventListener('click', () => {
  const r = S.song.res, bar = r.bars[edit.bi], g = edit.segs[edit.s], c = edit.r === null ? null : { r: (edit.r + S.capo) % 12, q: edit.q };
  g.js.forEach(j => { if (j < r.chords.length) r.chords[j] = c; }); g.ks.forEach(k => bar.chords[k] = c);
  bar.edited = true; $('dlg').close(); persist(); render();
});
let delId = null;
$('lib').addEventListener('click', async e => {
  const o = e.target.closest('[data-id]'), d = e.target.closest('[data-del]');
  if (o) { const s = await DB.get(o.dataset.id); if (s) openSong(s, true); }
  if (d) { delId = d.dataset.del; $('cSub').textContent = 'Ce morceau et tes corrections seront effacés de ce téléphone. Ça ne peut pas être annulé.'; $('confirm').showModal(); }
});
$('cNo').addEventListener('click', () => $('confirm').close());
$('cYes').addEventListener('click', async () => { $('confirm').close(); await DB.del(delId); if (S.song && S.song.id === delId) { S.song = null; } renderLib(); });
// live
$('liveBtn').addEventListener('click', () => L.on ? liveStop() : liveStart());
$('ytLoad').addEventListener('click', async () => {
  const id = ytIdOf($('ytUrl').value);
  if (!id) { status("Ce lien YouTube n'est pas reconnu."); return; }
  $('liveYt').hidden = false; status('Chargement de la vidéo…');
  try { L.yt = await makeYT($('liveYt'), id); L.ytId = id; status('Vidéo prête. Touche « Commencer l\'écoute », puis lance la vidéo.'); }
  catch (e) { $('liveYt').hidden = true; L.yt = null; status('La vidéo ne peut pas se charger. Vérifie ta connexion.'); }
});
$('tunerBtn').addEventListener('click', () => T.on ? tunerStop() : tunerStart());
// melody
function renderTab() {
  if (!S.mel) return;
  const n = S.mel.notes;
  if (!n.length) { $('tab').textContent = 'Aucune note nette trouvée. Essaie un enregistrement de voix seule, sans accompagnement.'; return; }
  const off = S.song.offset || 0, nn = n.map(o => ({ ...o, t: o.t + off, end: o.end + off }));
  $('tab').textContent = tabText(nn, tabPositions(nn, S.shift * 12), S.song.res.bars.map(b => b.start), innerWidth < 600 ? 10 : 18);
  $('melNote').textContent = `${n.length} notes${S.mel.cut ? ', sur les 2 premières minutes' : ''}. Accordage standard, octave ${S.shift > 0 ? '+' + S.shift : S.shift}.`;
}
$('melBtn').addEventListener('click', async () => {
  if (!S.song) { status("Ouvre d'abord un morceau."); return; }
  $('tab').textContent = 'Transcription en cours…';
  S.mel = await melody(await getX(S.song), 120); renderTab();
});
$('octDn').addEventListener('click', () => { S.shift--; renderTab(); });
$('octUp').addEventListener('click', () => { S.shift++; renderTab(); });
$('copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('tab').textContent); $('copy').textContent = 'Copié'; setTimeout(() => $('copy').textContent = 'Copier', 1500); } catch (e) { status('Copie impossible : sélectionne le texte à la main.'); } });
async function stage(on) {
  document.body.classList.toggle('stage', on); keepAwake(on || !P.paused());
  try { if (on && !document.fullscreenElement) await document.documentElement.requestFullscreen({ navigationUI: 'hide' }); else if (!on && document.fullscreenElement) await document.exitFullscreen(); } catch (e) {}
  scrollTo(0, 0); tickUI(true);
}
$('stageBtn').addEventListener('click', () => stage(true));
$('stageExit').addEventListener('click', () => stage(false));
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && document.body.classList.contains('stage')) stage(false); });
addEventListener('resize', () => tickUI(true));
document.addEventListener('visibilitychange', () => { if (!document.hidden && (!P.paused() || document.body.classList.contains('stage'))) { wake = null; keepAwake(true); } });
addEventListener('hashchange', route);

// ---------- start ----------
(async () => {
  route(); render();
  if ('serviceWorker' in navigator) { try { await navigator.serviceWorker.register('sw.js'); } catch (e) {} }
  let s = null; const id = lastId();
  if (id) s = await DB.get(id);
  if (!s) { status("Préparation de l'exemple…"); s = await demoSong(); status('Voici un exemple. Importe un morceau ou lance une écoute en direct.'); }
  else status('');
  openSong(s);
})();
}
