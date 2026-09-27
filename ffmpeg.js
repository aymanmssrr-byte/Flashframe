import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const OUT_W = 1080;
export const OUT_H = 1920;

// Duree du flash. On compte en frames pour ffmpeg, mais la cible est une duree.
export const FLASH_MS = Number(process.env.FLASH_MS || 133);

// Moment ou le flash apparait, depuis le debut de la video. Assez tard pour que
// le spectateur ait pose les yeux sur l'image, assez tot pour qu'il n'ait pas
// encore decide de passer au Reel suivant.
export const FLASH_AT_MS = Number(process.env.FLASH_AT_MS || 1000);

/**
 * Cadence de sortie. Une source filmee en 60 fps perd visiblement en fluidite
 * si on la ramene a 30 : on garde donc 60 quand elle y est, 30 sinon.
 */
export function targetFps(meta) {
  return (meta && meta.fps > 45) ? 60 : 30;
}

/** Nombre de frames de flash pour tenir FLASH_MS a cette cadence, 3 minimum */
export function flashFrames(meta) {
  const fps = targetFps(meta);
  return Math.max(3, Math.round((FLASH_MS * fps) / 1000));
}

/**
 * Index de la premiere frame flashee.
 *
 * Vise FLASH_AT_MS, mais recule si la video est trop courte pour que le flash
 * y tienne en entier — sinon il tomberait apres la fin et ne servirait a rien.
 * Ne descend jamais sous la frame 1 : la frame 0 reste intacte, c'est elle
 * qu'Instagram utilise comme vignette du Reel.
 */
export function flashStartFrame(meta) {
  const fps = targetFps(meta);
  const frames = flashFrames(meta);
  const total = Math.round((meta && meta.duration ? meta.duration : 0) * fps);
  const wanted = Math.round((FLASH_AT_MS * fps) / 1000);
  // une frame de marge apres le flash, pour ne pas finir pile sur la derniere
  const latest = total > 0 ? total - frames - 1 : wanted;
  return Math.max(1, Math.min(wanted, latest));
}

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

// ---------------------------------------------------------------------------
// petit wrapper process
// ---------------------------------------------------------------------------

function run(bin, args, { onStderr, timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timer = null;

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`${bin}: timeout apres ${timeoutMs}ms`));
      }, timeoutMs);
    }

    child.stdout.on('data', (c) => {
      stdout += c.toString();
    });
    child.stderr.on('data', (c) => {
      const s = c.toString();
      // on garde une fenetre bornee : ffmpeg peut cracher des Mo de logs
      stderr = (stderr + s).slice(-16384);
      if (onStderr) onStderr(s);
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(`${bin} a quitte avec le code ${code}\n${stderr}`), { code, stderr }));
    });
  });
}

export function spawnFfmpeg(args, { onStderr } = {}) {
  const child = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (c) => {
    const s = c.toString();
    stderr = (stderr + s).slice(-16384);
    if (onStderr) onStderr(s);
  });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) return resolve({ stderr });
      // code null + signal = process tue de l'exterieur, presque toujours le
      // noyau qui reclame la memoire. Ce n'est pas un probleme de format.
      const killed = code === null || signal === 'SIGKILL';
      reject(Object.assign(
        new Error(`ffmpeg ${killed ? `tue par ${signal || 'le systeme'}` : `code ${code}`}\n${stderr}`),
        { code, signal, killed, stderr },
      ));
    });
  });
  return { child, done };
}

// ---------------------------------------------------------------------------
// capacites du binaire ffmpeg present, detectees au boot
// ---------------------------------------------------------------------------

let capsPromise = null;

export function capabilities() {
  if (!capsPromise) capsPromise = detectCapabilities();
  return capsPromise;
}

async function detectCapabilities() {
  const caps = { autorotate: true, zscale: false, tonemap: false, version: 'inconnue' };

  try {
    const { stdout } = await run(FFMPEG, ['-hide_banner', '-filters'], { timeoutMs: 20000 });
    caps.zscale = /\szscale\s/.test(stdout);
    caps.tonemap = /\stonemap\s/.test(stdout);
  } catch {
    /* on garde les defauts */
  }

  try {
    const { stdout } = await run(FFMPEG, ['-version'], { timeoutMs: 10000 });
    caps.version = (stdout.split('\n')[0] || '').trim();
  } catch {
    /* ignore */
  }

  caps.autorotate = await detectAutorotate().catch(() => true);
  return caps;
}

/**
 * ffmpeg applique-t-il la matrice de rotation au decodage ?
 * C'est le defaut depuis longtemps (-autorotate), mais on ne le suppose pas :
 * si on se trompe, toutes les videos portrait iPhone sortent couchees.
 * On fabrique une video 64x32 avec une rotation de 90 deg, on decode une frame,
 * et on regarde la taille obtenue.
 */
async function detectAutorotate() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ff-caps-'));
  try {
    const flat = path.join(dir, 'flat.mp4');
    const src = path.join(dir, 'rot.mp4');
    const png = path.join(dir, 'frame.png');

    await run(FFMPEG, [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=64x32:rate=10:duration=0.5',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast',
      flat,
    ], { timeoutMs: 30000 });

    // -metadata rotate= est ignore par les muxers recents : on ecrit la vraie
    // matrice d affichage, comme le fait un iPhone.
    await run(FFMPEG, [
      '-v', 'error', '-y', '-display_rotation', '90', '-i', flat, '-c', 'copy', src,
    ], { timeoutMs: 30000 });

    // si le muxer n'a pas ecrit la matrice, le test ne prouve rien -> defaut
    const probed = await probe(src, { skipRotationNormalisation: true });
    if (!probed.rotation) return true;

    await run(FFMPEG, ['-v', 'error', '-y', '-i', src, '-frames:v', '1', png], { timeoutMs: 30000 });
    const frame = await probe(png, { skipRotationNormalisation: true });
    return frame.width === 32 && frame.height === 64;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// ffprobe
// ---------------------------------------------------------------------------

function parseFraction(str, fallback = 30) {
  if (!str) return fallback;
  const [a, b] = String(str).split('/');
  const num = Number(a);
  const den = b === undefined ? 1 : Number(b);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0 || num === 0) return fallback;
  return num / den;
}

export async function probe(file, { skipRotationNormalisation = false } = {}) {
  const { stdout } = await run(FFPROBE, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_streams',
    '-show_format',
    file,
  ], { timeoutMs: 60000 });

  const data = JSON.parse(stdout);
  const streams = data.streams || [];
  const video = streams.find((s) => s.codec_type === 'video');
  if (!video) throw new Error('Aucune piste video dans le fichier');
  const audio = streams.find((s) => s.codec_type === 'audio');

  // rotation : tag legacy `rotate` (sens horaire d'affichage) ou display matrix
  // dans side_data_list (angle signe inverse). Les deux existent selon le muxer.
  let rotation = 0;
  const tagRotate = video.tags && (video.tags.rotate ?? video.tags.Rotate);
  if (tagRotate !== undefined && tagRotate !== null && tagRotate !== '') {
    rotation = Number(tagRotate) || 0;
  } else {
    const side = (video.side_data_list || []).find((s) => s.rotation !== undefined);
    if (side) rotation = -Number(side.rotation) || 0;
  }
  if (!skipRotationNormalisation) rotation = ((Math.round(rotation) % 360) + 360) % 360;

  const width = Number(video.width) || 0;
  const height = Number(video.height) || 0;
  const swapped = rotation === 90 || rotation === 270;

  const fps = parseFraction(video.r_frame_rate, parseFraction(video.avg_frame_rate, 30));
  const duration = Number(video.duration || (data.format && data.format.duration) || 0) || 0;

  const colorTransfer = video.color_transfer || '';
  const isHdr = colorTransfer === 'arib-std-b67' || colorTransfer === 'smpte2084';

  return {
    width,
    height,
    displayWidth: swapped ? height : width,
    displayHeight: swapped ? width : height,
    rotation,
    fps,
    duration,
    colorTransfer,
    colorPrimaries: video.color_primaries || '',
    isHdr,
    codec: video.codec_name || '',
    pixFmt: video.pix_fmt || '',
    hasAudio: Boolean(audio),
    nbFrames: Number(video.nb_frames) || (duration ? Math.round(duration * fps) : 0),
    sizeBytes: Number(data.format && data.format.size) || 0,
  };
}

// ---------------------------------------------------------------------------
// construction du filtre
// ---------------------------------------------------------------------------

const FIT = `scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${OUT_W}:${OUT_H},setsar=1`;

/**
 * `rotation` est l angle horaire a appliquer pour l affichage (convention du
 * tag legacy `rotate`), soit l oppose de la valeur de la display matrix.
 * Correspondances verifiees contre le comportement d autorotation de ffmpeg :
 *   display matrix +90  -> rotation 270 -> transpose=2
 *   display matrix -90  -> rotation 90  -> transpose=1   (cas iPhone portrait)
 */
function transposeChain(rotation) {
  if (rotation === 90) return 'transpose=1';
  if (rotation === 180) return 'hflip,vflip';
  if (rotation === 270) return 'transpose=2';
  return null;
}

function tonemapChain(caps) {
  if (caps.zscale && caps.tonemap) {
    return [
      'zscale=t=linear:npl=100',
      'format=gbrpf32le',
      'zscale=p=bt709',
      'tonemap=tonemap=hable:desat=0',
      'zscale=t=bt709:m=bt709:r=tv',
      'format=yuv420p',
    ].join(',');
  }
  // repli grossier : au moins on ne sort pas du 10 bits vers un h264 8 bits sans conversion
  return 'format=yuv420p';
}

/**
 * `enable` compte en frames (n), jamais en secondes : c'est plus precis, et
 * c'est le nombre de frames qui decide si le flash survit au reencodage.
 * between(n, debut, debut + N - 1) -> N frames consecutives a partir de `debut`.
 */
export function enableExpr(startFrame, frames) {
  const start = Math.max(0, Math.round(startFrame));
  const end = start + Math.max(1, Math.round(frames)) - 1;
  return `between(n,${start},${end})`;
}

export function buildFilterComplex({ meta, frames, startFrame, caps }) {
  const parts = [`fps=${targetFps(meta)}`];

  // ffmpeg applique deja la rotation au decodage dans la quasi-totalite des
  // builds ; on ne transpose que si la detection au boot dit le contraire.
  if (!caps.autorotate) {
    const t = transposeChain(meta.rotation);
    if (t) parts.push(t);
  }

  // Le redimensionnement vient AVANT le tonemap, jamais l'inverse : converti en
  // flottant 32 bits, une frame 4K pese 100 Mo contre 25 Mo en 1080x1920. Sur un
  // serveur a 1 Go, l'ordre inverse fait tuer ffmpeg par le noyau.
  parts.push(FIT);

  if (meta.isHdr) parts.push(tonemapChain(caps));

  const base = `[0:v]${parts.join(',')}[base]`;
  const img = `[1:v]${FIT}[img]`;
  const start = startFrame === undefined ? flashStartFrame(meta) : startFrame;
  const ov = `[base][img]overlay=0:0:enable='${enableExpr(start, frames)}'[v]`;
  return `${base};${img};${ov}`;
}

export function buildEncodeArgs({ input, image, output, meta, frames, startFrame, caps }) {
  const fps = targetFps(meta);
  // marge de debit large : Instagram reencode par-dessus, mieux vaut lui donner
  // une source propre plutot qu'une source deja compressee deux fois
  const maxrate = fps >= 60 ? '12M' : '8M';
  const bufsize = fps >= 60 ? '24M' : '16M';
  return [
    '-hide_banner',
    '-nostdin',
    '-y',
    // Bride la parallelisation : chaque thread de decodage et de filtrage
    // duplique les tampons d'image. Sur un conteneur a 1 Go c'est la difference
    // entre un encodage qui aboutit et un processus tue par le noyau.
    '-threads', '1',
    '-filter_complex_threads', '1',
    '-filter_threads', '1',
    // si on transpose nous-memes, on coupe explicitement l autorotation pour
    // ne pas tourner deux fois
    ...(caps.autorotate ? [] : ['-noautorotate']),
    '-i', input,
    '-i', image,
    '-filter_complex', buildFilterComplex({ meta, frames, startFrame, caps }),
    '-map', '[v]',
    '-map', '0:a?',
    '-r', String(fps),
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-threads', '2',
    '-crf', '19',
    '-maxrate', maxrate,
    '-bufsize', bufsize,
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'high',
    '-level', '4.2',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ar', '44100',
    '-ac', '2',
    '-movflags', '+faststart',
    output,
  ];
}

// ---------------------------------------------------------------------------
// encodage avec progression
// ---------------------------------------------------------------------------

const FRAME_RE = /frame=\s*(\d+)/g;

export async function encode({ input, image, output, meta, frames, startFrame, onProgress, caps: capsOverride }) {
  const caps = capsOverride || (await capabilities());
  const args = buildEncodeArgs({ input, image, output, meta, frames, startFrame, caps });

  const totalFrames = Math.max(1, Math.round((meta.duration || 0) * targetFps(meta)));
  let last = -1;

  const { child, done } = spawnFfmpeg(args, {
    onStderr: (chunk) => {
      if (!onProgress) return;
      let m;
      FRAME_RE.lastIndex = 0;
      while ((m = FRAME_RE.exec(chunk)) !== null) {
        const n = Number(m[1]);
        if (n > last) {
          last = n;
          onProgress(Math.min(0.99, n / totalFrames), n, totalFrames);
        }
      }
    },
  });

  await done;
  if (onProgress) onProgress(1, totalFrames, totalFrames);
  return { child };
}

// ---------------------------------------------------------------------------
// strip de preview : frames 0..N+2 telles qu'elles sortiront
// ---------------------------------------------------------------------------

export async function previewStrip({ input, image, meta, frames, startFrame, count, outDir, caps: capsOverride }) {
  const caps = capsOverride || (await capabilities());
  const n = count ?? frames + 3; // frames 0 .. N+2
  await run(FFMPEG, [
    '-hide_banner', '-nostdin', '-y',
    ...(caps.autorotate ? [] : ['-noautorotate']),
    '-i', input,
    '-i', image,
    '-filter_complex', `${buildFilterComplex({ meta, frames, startFrame, caps })};[v]scale=162:288[out]`,
    '-map', '[out]',
    '-frames:v', String(n),
    '-q:v', '4',
    path.join(outDir, 'thumb_%03d.jpg'),
  ], { timeoutMs: 120000 });

  const files = (await readdir(outDir)).filter((f) => f.startsWith('thumb_')).sort();
  return files;
}

export { run };
