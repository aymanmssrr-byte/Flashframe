/**
 * Test d'integration HTTP de l'app simplifiee :
 *   bibliotheque d'images (ajout, liste, vignette, suppression, persistance)
 *   puis videos in -> fichier out, avec une image tiree au hasard par video.
 *
 * Lancer : node test/api.test.js
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { probe, run } from './ffmpeg.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(ROOT, '.tmp-api');
const LIB = path.join(DIR, 'library');
const PORT = 3997;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
async function test(name, fn) {
  process.stdout.write(`• ${name} ... `);
  try {
    await fn();
    console.log('OK');
  } catch (err) {
    failures += 1;
    console.log('ECHEC');
    console.error(`   ${err.message.split('\n').slice(0, 3).join('\n   ')}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const blob = (buf, type) => new Blob([buf], { type });

function startServer() {
  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      WORK_DIR: path.join(DIR, 'work'),
      LIBRARY_DIR: LIB,
      LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (c) => { log += c.toString(); });
  server.stderr.on('data', (c) => { log += c.toString(); });
  return { server, getLog: () => log };
}

async function waitForServer() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return r.json();
    } catch { /* pas encore la */ }
    await sleep(500);
  }
  throw new Error('le serveur ne repond pas');
}

async function readSse(url, onEvent) {
  const res = await fetch(url);
  assert.ok(res.ok, `SSE ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) throw new Error('flux SSE ferme sans evenement final');
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const evt = /^event: (.+)$/m.exec(raw);
      const data = /^data: (.+)$/m.exec(raw);
      if (!evt) continue;
      const payload = data ? JSON.parse(data[1]) : {};
      if (onEvent) onEvent(evt[1], payload);
      if (evt[1] === 'done' || evt[1] === 'failed') {
        reader.cancel().catch(() => {});
        return { event: evt[1], payload };
      }
    }
  }
}

async function main() {
  await rm(DIR, { recursive: true, force: true });
  await mkdir(DIR, { recursive: true });

  // fixtures
  const vid = path.join(DIR, 'ma video.mp4');
  const vid2 = path.join(DIR, 'seconde.mp4');
  await run('ffmpeg', ['-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=0x0052cc:s=720x1280:r=30:d=1.5',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.5',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', vid]);
  await run('ffmpeg', ['-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=0x00aa5a:s=720x1280:r=30:d=1.5',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', vid2]);

  const images = [];
  for (const [i, color] of ['0xed1c24', '0xffd400', '0x7b5cff'].entries()) {
    const f = path.join(DIR, `img${i}.png`);
    await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi',
      '-i', `color=c=${color}:s=900x900`, '-frames:v', '1', f]);
    images.push(f);
  }
  const notAnImage = path.join(DIR, 'pas-une-image.png');
  await writeFile(notAnImage, 'ceci est du texte, pas une image');

  let { server, getLog } = startServer();

  try {
    const health = await waitForServer();
    console.log(`serveur pret — flash de ${health.flashMs} ms, ${health.images} image(s) en bibliotheque\n`);

    const vidBuf = await readFile(vid);
    const vid2Buf = await readFile(vid2);

    // --- page ---------------------------------------------------------------
    await test('la page ouvre la galerie et non la camera', async () => {
      const html = await (await fetch(`${BASE}/`)).text();
      assert.ok(html.includes('accept="video/*"'), 'input video');
      assert.ok(!/capture=/.test(html), 'aucun attribut capture');
      assert.ok(!/type="range"/.test(html), 'plus aucun slider a regler');
      assert.ok(!/type="checkbox"/.test(html), 'plus aucune case a cocher');
    });

    await test('/admin sert bien une page, et elle porte l espace images', async () => {
      const r = await fetch(`${BASE}/admin`);
      assert.equal(r.status, 200);
      const html = await r.text();
      assert.ok(html.includes('id="view-admin"'), 'ecran proprietaire present');
      assert.ok(html.includes("endsWith('/admin')"), 'bascule par le chemin');
    });

    // --- bibliotheque vide --------------------------------------------------
    await test('sans image, le traitement est refuse avec un message clair', async () => {
      const fd = new FormData();
      fd.append('videos', blob(vidBuf, 'video/mp4'), 'v.mp4');
      const r = await fetch(`${BASE}/api/jobs`, { method: 'POST', body: fd });
      assert.equal(r.status, 400);
      const b = await r.json();
      assert.match(b.error, /image/i);
    });

    // --- ajout d'images -----------------------------------------------------
    let libIds = [];

    await test('ajout de 3 images en une fois', async () => {
      const fd = new FormData();
      for (const [i, f] of images.entries()) {
        fd.append('images', blob(await readFile(f), 'image/png'), `visuel${i}.png`);
      }
      const r = await fetch(`${BASE}/api/library`, { method: 'POST', body: fd });
      const b = await r.json();
      assert.equal(r.status, 200, JSON.stringify(b));
      assert.equal(b.added, 3);
      assert.equal(b.images.length, 3);
      libIds = b.images.map((i) => i.id);
    });

    await test('un fichier qui n est pas une image est ignore, pas fatal', async () => {
      const fd = new FormData();
      fd.append('images', blob(await readFile(notAnImage), 'image/png'), 'pas-une-image.png');
      fd.append('images', blob(await readFile(images[0]), 'image/png'), 'bonne.png');
      const r = await fetch(`${BASE}/api/library`, { method: 'POST', body: fd });
      const b = await r.json();
      assert.equal(r.status, 200, JSON.stringify(b));
      assert.equal(b.added, 1);
      assert.deepEqual(b.rejected, ['pas-une-image.png']);
      assert.equal(b.images.length, 4);
    });

    await test('formats exotiques acceptes : gif, tiff, bmp, avif, sans extension', async () => {
      const exotic = [];
      const specs = [['gif', 'x.gif'], ['tiff', 'x.tiff'], ['bmp', 'x.bmp'], ['webp', 'x.webp']];
      for (const [fmt, name] of specs) {
        const f = path.join(DIR, name);
        await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi',
          '-i', 'color=c=0x3366ff:s=600x600', '-frames:v', '1', f]);
        exotic.push([f, name]);
      }
      // un png renomme sans extension du tout : seul ffmpeg doit decider
      const noExt = path.join(DIR, 'fichier-sans-extension');
      await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi',
        '-i', 'color=c=0x33ff66:s=600x600', '-frames:v', '1', noExt + '.png']);
      const { copyFile } = await import('node:fs/promises');
      await copyFile(noExt + '.png', noExt);
      exotic.push([noExt, 'sans-extension']);

      const fd = new FormData();
      for (const [f, name] of exotic) {
        fd.append('images', blob(await readFile(f), 'application/octet-stream'), name);
      }
      const r = await fetch(`${BASE}/api/library`, { method: 'POST', body: fd });
      const b = await r.json();
      assert.equal(r.status, 200, JSON.stringify(b));
      assert.equal(b.added, exotic.length, `attendu ${exotic.length}, recu ${b.added} (rejetes: ${b.rejected})`);
    });

    await test('les vignettes sont servies en jpeg', async () => {
      const r = await fetch(`${BASE}/api/library/${libIds[0]}/thumb`);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('content-type'), 'image/jpeg');
      const buf = Buffer.from(await r.arrayBuffer());
      assert.ok(buf.length > 500, 'vignette non vide');
    });

    await test('suppression d une image', async () => {
      const before = (await (await fetch(`${BASE}/api/library`)).json()).images.length;
      const r = await fetch(`${BASE}/api/library/${libIds[0]}`, { method: 'DELETE' });
      assert.equal(r.status, 200);
      const list = await (await fetch(`${BASE}/api/library`)).json();
      assert.equal(list.images.length, before - 1);
      assert.ok(!list.images.some((i) => i.id === libIds[0]), 'image bien retiree');
      // le fichier et sa vignette ont disparu du disque
      const files = await readdir(LIB);
      assert.ok(!files.some((f) => f.startsWith(libIds[0])), 'fichiers supprimes du disque');
    });

    await test('supprimer une image inexistante renvoie 404, pas 500', async () => {
      const r = await fetch(`${BASE}/api/library/00000000-0000-0000-0000-000000000000`, { method: 'DELETE' });
      assert.equal(r.status, 404);
    });

    // --- une video ----------------------------------------------------------
    await test('une video : flash applique, mp4 direct au telechargement', async () => {
      const fd = new FormData();
      fd.append('videos', blob(vidBuf, 'video/mp4'), 'ma video.mp4');
      const r = await fetch(`${BASE}/api/jobs`, { method: 'POST', body: fd });
      const b = await r.json();
      assert.equal(r.status, 200, JSON.stringify(b));
      assert.equal(b.count, 1);

      const seen = [];
      const end = await readSse(`${BASE}/api/progress/${b.jobId}`, (evt, d) => {
        if (evt === 'progress') seen.push(d.progress);
      });
      assert.equal(end.event, 'done', JSON.stringify(end.payload));
      assert.ok(seen.length > 0, 'progression recue');
      assert.equal(end.payload.name, 'ma video_flash.mp4');
      assert.equal(end.payload.failed, 0);

      const dl = await fetch(BASE + end.payload.url);
      assert.equal(dl.status, 200);
      assert.equal(dl.headers.get('content-type'), 'video/mp4');
      const out = path.join(DIR, 'out.mp4');
      await writeFile(out, Buffer.from(await dl.arrayBuffer()));
      const m = await probe(out);
      assert.equal(m.width, 1080);
      assert.equal(m.height, 1920);
      assert.equal(m.hasAudio, true);

      // la frame 0 doit rester la source (bleu), les suivantes portent le flash
      const frames = await sampleFrames(out, 6);
      assert.ok(isBlue(frames[0]), `frame 0 alteree : ${frames[0]}`);
      assert.ok(!isBlue(frames[1]), `frame 1 sans flash : ${frames[1]}`);
      assert.ok(!isBlue(frames[4]), `frame 4 sans flash : ${frames[4]}`);
      assert.ok(isBlue(frames[5]), `frame 5 devrait etre propre : ${frames[5]}`);
    });

    // --- plusieurs videos ---------------------------------------------------
    await test('plusieurs videos : sequentiel, ZIP aux noms d origine', async () => {
      const fd = new FormData();
      fd.append('videos', blob(vidBuf, 'video/mp4'), 'ma video.mp4');
      fd.append('videos', blob(vid2Buf, 'video/mp4'), 'seconde.mp4');
      const r = await fetch(`${BASE}/api/jobs`, { method: 'POST', body: fd });
      const b = await r.json();
      assert.equal(r.status, 200, JSON.stringify(b));

      let running = 0;
      let maxConcurrent = 0;
      const order = [];
      const end = await readSse(`${BASE}/api/progress/${b.jobId}`, (evt, d) => {
        if (evt === 'item') { running += 1; maxConcurrent = Math.max(maxConcurrent, running); order.push(d.index); }
        if (evt === 'itemDone') { running -= 1; assert.ok(d.ok, `${d.name} a echoue`); }
      });
      assert.equal(end.event, 'done', JSON.stringify(end.payload));
      assert.deepEqual(order, [0, 1], 'traitees dans l ordre');
      assert.equal(maxConcurrent, 1, 'jamais deux encodages en parallele');

      const dl = await fetch(BASE + end.payload.url);
      assert.equal(dl.headers.get('content-type'), 'application/zip');
      const text = Buffer.from(await dl.arrayBuffer()).toString('latin1');
      assert.ok(text.includes('ma video_flash.mp4'), 'nom 1 conserve');
      assert.ok(text.includes('seconde_flash.mp4'), 'nom 2 conserve');
    });

    // --- tirage aleatoire ---------------------------------------------------
    await test('sur 3 images et 6 videos, chaque image sort exactement 2 fois', async () => {
      const { pickRandom } = await import('./library.js');
      const lib = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
      const picks = pickRandom(lib, 6).map((p) => p.id);
      const counts = picks.reduce((m, id) => ({ ...m, [id]: (m[id] || 0) + 1 }), {});
      assert.deepEqual(Object.keys(counts).sort(), ['a', 'b', 'c']);
      assert.deepEqual(Object.values(counts), [2, 2, 2],
        `repartition desequilibree : ${JSON.stringify(counts)}`);
    });

    await test('sur 3 images et 2 videos, deux images differentes', async () => {
      const { pickRandom } = await import('./library.js');
      const lib = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
      for (let i = 0; i < 30; i += 1) {
        const picks = pickRandom(lib, 2).map((p) => p.id);
        assert.notEqual(picks[0], picks[1], 'deux fois la meme image d affilee');
      }
    });

    // --- code d'acces -------------------------------------------------------
    await test('sans ADMIN_CODE configure, la bibliotheque reste ouverte', async () => {
      const h = await (await fetch(`${BASE}/api/health`)).json();
      assert.equal(h.adminRequired, false);
    });

    // --- persistance --------------------------------------------------------
    await test('la bibliotheque survit a un redemarrage du serveur', async () => {
      const before = await (await fetch(`${BASE}/api/library`)).json();
      server.kill('SIGKILL');
      await sleep(400);
      ({ server, getLog } = startServer());
      await waitForServer();
      const after = await (await fetch(`${BASE}/api/library`)).json();
      assert.equal(after.images.length, before.images.length, 'meme nombre d images');
      assert.deepEqual(
        after.images.map((i) => i.id).sort(),
        before.images.map((i) => i.id).sort(),
        'memes images',
      );
    });
  } finally {
    server.kill('SIGKILL');
    if (failures) console.log(`\n--- log serveur ---\n${getLog().slice(-2500)}`);
    await rm(DIR, { recursive: true, force: true });
  }

  console.log(failures ? `\n${failures} test(s) en echec` : '\nTous les tests passent');
  process.exit(failures ? 1 : 0);
}

/* helpers couleur : on decode vraiment les frames de sortie */
function sampleFrames(file, count) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-v', 'error', '-i', file, '-vf', 'scale=1:1',
      '-frames:v', String(count), '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let err = '';
    child.stdout.on('data', (c) => chunks.push(c));
    child.stderr.on('data', (c) => { err += c.toString(); });
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(err || `ffmpeg ${code}`));
      const buf = Buffer.concat(chunks);
      const out = [];
      for (let i = 0; i + 3 <= buf.length; i += 3) out.push([buf[i], buf[i + 1], buf[i + 2]]);
      resolve(out);
    });
  });
}
function isBlue(c) {
  return Math.abs(c[0] - 0) < 45 && Math.abs(c[1] - 82) < 45 && Math.abs(c[2] - 204) < 45;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
