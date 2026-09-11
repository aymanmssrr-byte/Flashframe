/**
 * Tests du pipeline ffmpeg — les cas qui cassent en vrai :
 *  1. position exacte du flash, comptee en frames, toggle OFF puis ON
 *  2. video portrait iPhone stockee en paysage + metadonnee de rotation
 *  3. video sans piste audio
 *  4. source HDR (HLG et PQ)
 *  5. source a 24 fps : le flash doit toujours faire N frames en sortie
 *
 * Lancer : node test/ffmpeg.test.js
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { capabilities, encode, enableExpr, flashFrames, probe, run, targetFps } from './ffmpeg.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '.tmp');
const RED = [237, 28, 36];
const BLUE = [0, 82, 204];
const GREEN = [0, 170, 90];

let failures = 0;
async function test(name, fn) {
  process.stdout.write(`• ${name} ... `);
  try {
    await fn();
    console.log('OK');
  } catch (err) {
    failures += 1;
    console.log('ECHEC');
    console.error(`   ${err.message.split('\n')[0]}`);
  }
}

function near(actual, expected, tol = 40) {
  return actual.every((v, i) => Math.abs(v - expected[i]) <= tol);
}
function fmt(c) {
  return `rgb(${c.join(',')})`;
}

/** couleur moyenne d'une bande horizontale, frame par frame */
function sampleFrames(file, count, { y = 0, h = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const filters = [];
    if (h > 0) filters.push(`crop=iw:${h}:0:${y}`);
    filters.push('scale=1:1');
    const child = spawn('ffmpeg', [
      '-v', 'error', '-i', file,
      '-vf', filters.join(','),
      '-frames:v', String(count),
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
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

async function makeImage(file, color) {
  await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi',
    '-i', `color=c=0x${color.map((c) => c.toString(16).padStart(2, '0')).join('')}:s=1080x1920`,
    '-frames:v', '1', file]);
}

async function makeVideo(file, { size = '1080x1920', fps = 30, dur = 2, audio = true, extra = [] } = {}) {
  const args = ['-v', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=0x${BLUE.map((c) => c.toString(16).padStart(2, '0')).join('')}:s=${size}:r=${fps}:d=${dur}`];
  if (audio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${dur}`);
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast');
  if (audio) args.push('-c:a', 'aac', '-shortest');
  args.push(...extra, file);
  await run('ffmpeg', args);
}

async function main() {
  await rm(DIR, { recursive: true, force: true });
  await mkdir(DIR, { recursive: true });

  const caps = await capabilities();
  console.log(`ffmpeg : ${caps.version}`);
  console.log(`rotation appliquee au decodage : ${caps.autorotate ? 'oui' : 'non (transpose manuel actif)'}`);
  console.log(`zscale/tonemap : ${caps.zscale ? 'oui' : 'non'} / ${caps.tonemap ? 'oui' : 'non'}\n`);

  const img = path.join(DIR, 'flash.png');
  await makeImage(img, RED);

  // --- 1. expressions -------------------------------------------------------
  await test('enableExpr compte en frames', async () => {
    assert.equal(enableExpr(4, false), 'between(n,1,4)');
    assert.equal(enableExpr(4, true), 'lt(n,4)');
  });

  // --- 2. position du flash, toggle OFF ------------------------------------
  const src = path.join(DIR, 'src.mp4');
  await makeVideo(src);
  const metaSrc = await probe(src);

  await test('toggle OFF : frame 0 intacte, flash sur 1..N', async () => {
    const out = path.join(DIR, 'off.mp4');
    await encode({ input: src, image: img, output: out, meta: metaSrc, frames: 4, cover: false });
    const f = await sampleFrames(out, 8);
    assert.ok(near(f[0], BLUE), `frame 0 devrait rester la source, obtenu ${fmt(f[0])}`);
    for (let i = 1; i <= 4; i += 1) {
      assert.ok(near(f[i], RED), `frame ${i} devrait porter le flash, obtenu ${fmt(f[i])}`);
    }
    assert.ok(near(f[5], BLUE), `frame 5 devrait etre propre, obtenu ${fmt(f[5])}`);
  });

  await test('toggle ON : flash sur 0..N-1, couverture flashee', async () => {
    const out = path.join(DIR, 'on.mp4');
    await encode({ input: src, image: img, output: out, meta: metaSrc, frames: 4, cover: true });
    const f = await sampleFrames(out, 8);
    for (let i = 0; i < 4; i += 1) {
      assert.ok(near(f[i], RED), `frame ${i} devrait porter le flash, obtenu ${fmt(f[i])}`);
    }
    assert.ok(near(f[4], BLUE), `frame 4 devrait etre propre, obtenu ${fmt(f[4])}`);
  });

  await test('minimum 3 frames respecte au niveau du filtre', async () => {
    const out = path.join(DIR, 'min3.mp4');
    await encode({ input: src, image: img, output: out, meta: metaSrc, frames: 3, cover: false });
    const f = await sampleFrames(out, 6);
    assert.ok(near(f[1], RED) && near(f[2], RED) && near(f[3], RED), 'flash sur 1,2,3');
    assert.ok(near(f[4], BLUE), 'frame 4 propre');
  });

  // --- 3. source 24 fps -----------------------------------------------------
  await test('source 24 fps : N frames de flash en sortie a 30 fps', async () => {
    const s24 = path.join(DIR, 'src24.mp4');
    await makeVideo(s24, { fps: 24 });
    const m = await probe(s24);
    const out = path.join(DIR, 'out24.mp4');
    await encode({ input: s24, image: img, output: out, meta: m, frames: 5, cover: false });
    const f = await sampleFrames(out, 9);
    for (let i = 1; i <= 5; i += 1) assert.ok(near(f[i], RED), `frame ${i} flashee`);
    assert.ok(near(f[6], BLUE), 'frame 6 propre');
    const om = await probe(out);
    assert.ok(Math.abs(om.fps - 30) < 0.5, `sortie a ${om.fps} fps`);
  });

  // --- 3 bis. cadence adaptative --------------------------------------------
  await test('source 60 fps : sortie en 60 fps, flash de meme duree', async () => {
    const s60 = path.join(DIR, 'src60.mp4');
    await makeVideo(s60, { fps: 60, dur: 2 });
    const m = await probe(s60);
    assert.equal(targetFps(m), 60, 'cadence cible');
    assert.equal(flashFrames(m), 8, '8 frames a 60 fps = 133 ms');

    const out = path.join(DIR, 'out60.mp4');
    await encode({ input: s60, image: img, output: out, meta: m, frames: flashFrames(m), cover: false });
    const om = await probe(out);
    assert.ok(Math.abs(om.fps - 60) < 1, `sortie a ${om.fps} fps`);

    const f = await sampleFrames(out, 12);
    assert.ok(near(f[0], BLUE), 'frame 0 intacte');
    for (let i = 1; i <= 8; i += 1) assert.ok(near(f[i], RED), `frame ${i} flashee`);
    assert.ok(near(f[9], BLUE), 'frame 9 propre');
  });

  await test('source 30 fps : 4 frames, soit la meme duree qu en 60', async () => {
    const m = await probe(src);
    assert.equal(targetFps(m), 30);
    assert.equal(flashFrames(m), 4);
    const ms30 = (flashFrames(m) / targetFps(m)) * 1000;
    assert.ok(Math.abs(ms30 - 133) < 10, `${ms30} ms au lieu de ~133`);
  });

  // --- 4. portrait iPhone : paysage + matrice de rotation ------------------
  //
  // Cas le plus frequent : la video est stockee en 640x360 avec une display
  // matrix. Contenu stocke : moitie gauche rouge sombre, moitie droite verte.
  // On verifie que la sortie est portrait 1080x1920, sans metadonnee de
  // rotation residuelle, et que le haut/bas correspond a ce que ffmpeg produit
  // lui-meme en autorotation. Le meme controle est rejoue en forcant le chemin
  // de repli (transpose manuel + -noautorotate).
  async function makeRotated(file, displayRotation) {
    const flat = path.join(DIR, `flat_${displayRotation}.mp4`);
    await run('ffmpeg', ['-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=0x7a0000:s=320x360:r=30:d=1.5',
      '-f', 'lavfi', '-i', `color=c=0x${GREEN.map((c) => c.toString(16).padStart(2, '0')).join('')}:s=320x360:r=30:d=1.5`,
      '-filter_complex', '[0:v][1:v]hstack=inputs=2,format=yuv420p[v]',
      '-map', '[v]', '-c:v', 'libx264', '-preset', 'ultrafast', flat]);
    // -metadata rotate= est ignore par les muxers recents : on ecrit la vraie
    // display matrix, exactement comme un iPhone.
    await run('ffmpeg', ['-v', 'error', '-y',
      '-display_rotation', String(displayRotation), '-i', flat, '-c', 'copy', file]);
  }

  async function topBottom(file, frameIndex) {
    const top = (await sampleFrames(file, frameIndex + 1, { y: 60, h: 400 }))[frameIndex];
    const bottom = (await sampleFrames(file, frameIndex + 1, { y: 1460, h: 400 }))[frameIndex];
    return { top, bottom };
  }

  for (const displayRotation of [-90, 90]) {
    // eslint-disable-next-line no-await-in-loop
    await test(`portrait stocke en paysage (display matrix ${displayRotation}) sort a l endroit`, async () => {
      const rot = path.join(DIR, `rot_${displayRotation}.mp4`);
      await makeRotated(rot, displayRotation);

      const m = await probe(rot);
      assert.equal(m.rotation, displayRotation === -90 ? 90 : 270, `rotation lue : ${m.rotation}`);
      assert.equal(m.displayWidth, 360, 'largeur d affichage');
      assert.equal(m.displayHeight, 640, 'hauteur d affichage');

      // reference : ce que ffmpeg produit tout seul avec l autorotation
      const ref = path.join(DIR, `ref_${displayRotation}.mp4`);
      await run('ffmpeg', ['-v', 'error', '-y', '-i', rot,
        '-vf', 'fps=30,scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', ref]);
      const expected = await topBottom(ref, 6);

      const out = path.join(DIR, `rot_out_${displayRotation}.mp4`);
      await encode({ input: rot, image: img, output: out, meta: m, frames: 4, cover: false, caps });

      const om = await probe(out);
      assert.equal(om.width, 1080, 'sortie 1080 de large');
      assert.equal(om.height, 1920, 'sortie 1920 de haut');
      assert.equal(om.rotation, 0, 'plus de metadonnee de rotation en sortie');

      const got = await topBottom(out, 6);
      assert.ok(near(got.top, expected.top, 45),
        `haut ${fmt(got.top)} != reference ${fmt(expected.top)}`);
      assert.ok(near(got.bottom, expected.bottom, 45),
        `bas ${fmt(got.bottom)} != reference ${fmt(expected.bottom)}`);

      // chemin de repli : ffmpeg qui n autorotate pas -> transpose manuel
      const fbOut = path.join(DIR, `rot_fallback_${displayRotation}.mp4`);
      await encode({
        input: rot, image: img, output: fbOut, meta: m, frames: 4, cover: false,
        caps: { ...caps, autorotate: false },
      });
      const fb = await topBottom(fbOut, 6);
      assert.ok(near(fb.top, expected.top, 45),
        `repli transpose : haut ${fmt(fb.top)} != reference ${fmt(expected.top)}`);
      assert.ok(near(fb.bottom, expected.bottom, 45),
        `repli transpose : bas ${fmt(fb.bottom)} != reference ${fmt(expected.bottom)}`);
    });
  }

  // --- 5. sans audio --------------------------------------------------------
  await test('video sans piste audio : -map 0:a? ne plante pas', async () => {
    const mute = path.join(DIR, 'mute.mp4');
    await makeVideo(mute, { audio: false, dur: 1.5 });
    const m = await probe(mute);
    assert.equal(m.hasAudio, false);
    const out = path.join(DIR, 'mute_out.mp4');
    await encode({ input: mute, image: img, output: out, meta: m, frames: 4, cover: false });
    const om = await probe(out);
    assert.equal(om.hasAudio, false, 'pas de piste audio inventee');
    const f = await sampleFrames(out, 3);
    assert.ok(near(f[1], RED), 'flash present');
  });

  // --- 6. audio conserve ----------------------------------------------------
  await test('audio conserve et reencode en aac', async () => {
    const out = path.join(DIR, 'off.mp4');
    const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'a:0',
      '-show_entries', 'stream=codec_name,sample_rate', '-of', 'json', out]);
    const a = JSON.parse(stdout).streams[0];
    assert.ok(a, 'piste audio presente');
    assert.equal(a.codec_name, 'aac');
    assert.equal(a.sample_rate, '44100');
  });

  // --- 7. HDR ---------------------------------------------------------------
  for (const [label, trc] of [['HLG', 'arib-std-b67'], ['PQ', 'smpte2084']]) {
    // eslint-disable-next-line no-await-in-loop
    await test(`source HDR ${label} : tonemap vers bt709, couleurs non delavees`, async () => {
      const hdr = path.join(DIR, `hdr_${trc}.mp4`);
      await run('ffmpeg', ['-v', 'error', '-y',
        '-f', 'lavfi', '-i', 'color=c=0xed1c24:s=540x960:r=30:d=1.5',
        '-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p10le',
        '-color_primaries', 'bt2020', '-colorspace', 'bt2020nc', '-color_trc', trc,
        '-tag:v', 'hvc1', hdr]);

      const m = await probe(hdr);
      assert.equal(m.isHdr, true, `HDR non detecte (color_transfer=${m.colorTransfer})`);

      const out = path.join(DIR, `hdr_${trc}_out.mp4`);
      await encode({ input: hdr, image: img, output: out, meta: m, frames: 4, cover: false });
      const om = await probe(out);
      assert.equal(om.codec, 'h264');
      assert.ok(!om.isHdr, `sortie encore marquee ${om.colorTransfer}`);
      const f = await sampleFrames(out, 7);
      // frame hors flash : le rouge doit rester du rouge, pas un rose delave
      const c = f[6];
      assert.ok(c[0] > 90 && c[0] > c[1] + 40 && c[0] > c[2] + 40,
        `rouge delave apres conversion : ${fmt(c)}`);
    });
  }

  // --- 8. l image couvre tout le cadre, sans bande noire --------------------
  await test('image 1:1 recadree plein cadre, aucune bande noire', async () => {
    const square = path.join(DIR, 'square.png');
    await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi',
      '-i', 'color=c=0xed1c24:s=800x800', '-frames:v', '1', square]);
    const out = path.join(DIR, 'square_out.mp4');
    await encode({ input: src, image: square, output: out, meta: metaSrc, frames: 4, cover: true });
    const top = (await sampleFrames(out, 1, { y: 0, h: 60 }))[0];
    const bottom = (await sampleFrames(out, 1, { y: 1860, h: 60 }))[0];
    assert.ok(near(top, RED), `bande noire en haut : ${fmt(top)}`);
    assert.ok(near(bottom, RED), `bande noire en bas : ${fmt(bottom)}`);
  });

  // --- 9. faststart ---------------------------------------------------------
  await test('moov en tete (+faststart)', async () => {
    const { stdout } = await run('ffprobe', ['-v', 'trace', '-i', path.join(DIR, 'off.mp4')])
      .catch((e) => ({ stdout: e.stderr || '' }));
    void stdout;
    const { stdout: json } = await run('ffprobe', ['-v', 'error', '-show_format', '-of', 'json', path.join(DIR, 'off.mp4')]);
    assert.ok(JSON.parse(json).format.format_name.includes('mp4'));
  });

  console.log(failures ? `\n${failures} test(s) en echec` : '\nTous les tests passent');
  await rm(DIR, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
