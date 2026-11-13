// GipaPlay keep-alive + verificador de enlaces (Savedly)
// - Visita cada URL (para que no caduque) y la "calienta": lee el inicio y el final del archivo.
// - Verifica que sea video de verdad (no una pagina de error), que se pueda adelantar (Range) y que no sea lenta.
// - Escribe estado.json (para GipaPlay) y status.json (detalle).
//
// Uso:  node ping.js                 -> una pasada
//       node ping.js --loop 120      -> repite cada 120 min (PC / VPS)
//       node ping.js --head 2097152 --tail 524288   -> bytes a leer del inicio / final
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i > -1 ? args[i + 1] : d; };
const LOOP_MIN = Number(opt('loop', 0));
const HEAD = Number(opt('head', opt('bytes', 1048576)));   // inicio del archivo (1 MB)
const TAIL = Number(opt('tail', 262144));                  // final del archivo (256 KB, donde suele ir el indice del mp4)
const SLOW_MS = 6000;
const CONFIRMAR = 2;      // fallos seguidos para marcar una URL como caida
const CONCURRENCY = 4;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Fuentes: por defecto tu api-videos en GitHub (Saulcreen/api-videos, rama main).
// Se puede cambiar con VIDEOS_BASE, o ANIMES_URL / PELICULAS_URL por separado.
const BASE = process.env.VIDEOS_BASE || 'https://raw.githubusercontent.com/Saulcreen/api-videos/main/';
const SOURCES = [
  { name: 'animes', remote: process.env.ANIMES_URL || BASE + 'animes.json', local: 'animes.json' },
  { name: 'peliculas', remote: process.env.PELICULAS_URL || BASE + 'peliculas.json', local: 'peliculas.json' },
];

async function loadSource(src) {
  if (src.remote) {
    const res = await fetch(src.remote, { headers: { 'User-Agent': UA, 'Accept': 'application/json' }, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`${src.name}: la API respondio ${res.status}`);
    const data = await res.json();
    return Array.isArray(data) ? data : (data.data || data.items || data.results || []);
  }
  const p = path.join(__dirname, src.local);
  if (!fs.existsSync(p)) { console.warn(`(no existe ${src.local}, se omite)`); return []; }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

async function collect() {
  const items = [];
  for (const src of SOURCES) {
    for (const e of await loadSource(src)) {
      const urls = Array.isArray(e.url) ? e.url : [e.url];
      urls.forEach((u, i) => {
        if (typeof u === 'string' && u.startsWith('http'))
          items.push({ url: u, label: urls.length > 1 ? `${e.titulo} [parte ${i}]` : e.titulo });
      });
    }
  }
  const seen = new Set();
  return items.filter(x => !seen.has(x.url) && seen.add(x.url));
}

async function readBody(res, limit) {
  let got = 0, head = Buffer.alloc(0);
  if (!res.body) return { got, head };
  const reader = res.body.getReader();
  while (got < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    if (head.length < 16) head = Buffer.concat([head, Buffer.from(value.subarray(0, 16 - head.length))]);
    got += value.length;
  }
  await reader.cancel().catch(() => {});
  return { got, head };
}

async function fetchRange(url, range, limit) {
  const t0 = Date.now();
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Range': range, 'Accept': '*/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(45000),
  });
  const ttfb = Date.now() - t0;
  const { got, head } = await readBody(res, limit);
  return { res, ttfb, got, head };
}

function looksLikeVideo(h) {
  if (h.length >= 8 && ['ftyp', 'moov', 'mdat', 'free', 'wide', 'skip'].includes(h.toString('latin1', 4, 8))) return true; // mp4 / mov
  if (h.length >= 4 && h[0] === 0x1A && h[1] === 0x45 && h[2] === 0xDF && h[3] === 0xA3) return true;                     // mkv / webm
  return false;
}

async function checkOnce(item) {
  const r = { url: item.url, label: item.label, ok: false, avisos: [] };
  try {
    const a = await fetchRange(item.url, `bytes=0-${HEAD - 1}`, HEAD);
    const ct = (a.res.headers.get('content-type') || '').toLowerCase();
    const cr = a.res.headers.get('content-range');
    const m = cr && cr.match(/\/(\d+)$/);
    r.status = a.res.status; r.tipo = ct; r.ttfb = a.ttfb;
    r.size = m ? Number(m[1]) : (Number(a.res.headers.get('content-length')) || null);
    r.seekable = a.res.status === 206;
    if (a.res.status !== 200 && a.res.status !== 206) { r.error = `HTTP ${a.res.status}`; return r; }
    if (/^(text\/|application\/json)/.test(ct)) { r.error = `devolvio ${ct.split(';')[0]} en vez de video (enlace vencido?)`; return r; }
    if (!a.got) { r.error = 'respuesta vacia'; return r; }
    if (r.size && r.size < 50000) { r.error = `archivo demasiado pequeno (${r.size} bytes)`; return r; }
    if (!looksLikeVideo(a.head)) r.avisos.push('formato no reconocido');
    if (!r.seekable) r.avisos.push('sin Range: no se podra adelantar');
    if (a.ttfb > SLOW_MS) r.avisos.push(`lento (${a.ttfb} ms)`);
    if (r.seekable && r.size && r.size > HEAD + TAIL) {          // calienta el final del archivo
      const b = await fetchRange(item.url, `bytes=-${TAIL}`, TAIL);
      if (b.res.status !== 206) r.avisos.push(`final respondio ${b.res.status}`);
    }
    r.ok = true;
  } catch (err) {
    r.error = String(err.name === 'TimeoutError' ? 'tiempo agotado' : (err.message || err));
  }
  return r;
}

async function check(item) {
  let r = await checkOnce(item);
  if (!r.ok) { await new Promise(res => setTimeout(res, 3000)); r = await checkOnce(item); }
  return r;
}

function readPrevFallos() {
  try {
    const prev = JSON.parse(fs.readFileSync(path.join(__dirname, 'estado.json'), 'utf8'));
    const map = {};
    for (const x of [...(prev.caidas || []), ...(prev.dudosas || [])]) map[x.url] = x.fallos || 1;
    return map;
  } catch { return {}; }
}

const mb = n => (n / 1048576).toFixed(0) + ' MB';

async function runOnce() {
  const items = await collect();
  const prev = readPrevFallos();
  console.log(`\n[${new Date().toISOString()}] Verificando ${items.length} URLs...`);
  const results = [];
  let next = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < items.length) {
      const r = await check(items[next++]);
      results.push(r);
      const extra = r.ok ? `${r.size ? mb(r.size) : '?'} ${r.ttfb}ms ${r.avisos.length ? '⚠ ' + r.avisos.join(', ') : ''}` : r.error;
      console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${String(r.status || '-').padEnd(3)} ${r.label}  ${extra}`);
      await new Promise(res => setTimeout(res, 300 + Math.random() * 500));
    }
  }));
  results.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  const failed = results.filter(r => !r.ok).map(r => ({ titulo: r.label, url: r.url, motivo: r.error, fallos: (prev[r.url] || 0) + 1 }));
  const caidas = failed.filter(f => f.fallos >= CONFIRMAR);
  const dudosas = failed.filter(f => f.fallos < CONFIRMAR);
  const avisos = results.filter(r => r.ok && r.avisos.length).map(r => ({ titulo: r.label, avisos: r.avisos }));

  // estado.json: compacto, solo cambia cuando cambia algo (la fecha es por dia) -> pocos commits. Lo lee GipaPlay.
  fs.writeFileSync(path.join(__dirname, 'estado.json'), JSON.stringify({
    revisado: new Date().toISOString().slice(0, 10), total: results.length, ok: results.length - failed.length, caidas, dudosas,
  }, null, 2) + '\n');
  // status.json: detalle completo de esta pasada
  fs.writeFileSync(path.join(__dirname, 'status.json'), JSON.stringify({ fecha: new Date().toISOString(), avisos, resultados: results }, null, 2));

  console.log(`Listo: ${results.length - failed.length}/${results.length} OK · ${caidas.length} caidas · ${dudosas.length} dudosas · ${avisos.length} con avisos`);
  return caidas.length;
}

module.exports = { check, runOnce };

if (require.main === module) {
  (async () => {
    if (!LOOP_MIN) process.exit((await runOnce()) ? 1 : 0);
    console.log(`Modo bucle: cada ${LOOP_MIN} min. Ctrl+C para parar.`);
    for (;;) {
      try { await runOnce(); } catch (e) { console.error('Error en la pasada:', e.message); }
      await new Promise(r => setTimeout(r, LOOP_MIN * 60000));
    }
  })();
}
