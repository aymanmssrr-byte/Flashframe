import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import archiver from 'archiver';

import { FLASH_MS, capabilities, encode, flashFrames, probe } from './ffmpeg.js';
import {
  MAX_IMAGES,
  MAX_IMAGE_BYTES,
  addImage,
  deleteImage,
  findImage,
  initLibrary,
  listImages,
  pickRandom,
  thumbPath,
} from './library.js';
import {
  createJob,
  destroyJob,
  emit,
  ensureRoot,
  getJob,
  startSweeper,
  subscribe,
  touch,
} from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MAX_VIDEO_BYTES = Number(process.env.MAX_FILE_BYTES || 500 * 1024 * 1024);
const MAX_VIDEOS = Number(process.env.MAX_BATCH || 20);

// Reglages figes : l utilisateur n a rien a decider.
// Le flash dure FLASH_MS, converti en frames selon la cadence de chaque video.
// La frame 0 reste toujours intacte : c est elle qu Instagram utilise comme
// vignette du Reel.
const FLASH_ON_COVER = false;

// Code d'acces a la bibliotheque d'images. Non defini = tout le monde peut
// ajouter et supprimer. Defini = seul le proprietaire gere ses visuels, les
// autres ne peuvent que deposer des videos.
const ADMIN_CODE = String(process.env.ADMIN_CODE || '').trim();

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL || 'info' },
  bodyLimit: 1024 * 1024,
});

await app.register(multipart, {
  limits: { fileSize: MAX_VIDEO_BYTES, files: Math.max(MAX_VIDEOS, MAX_IMAGES), fields: 10 },
});

const INDEX_HTML = await readFile(path.join(__dirname, 'index.html'), 'utf8');

function sendPage(reply) {
  reply.header('Content-Type', 'text/html; charset=utf-8');
  reply.header('Cache-Control', 'no-cache');
  return reply.send(INDEX_HTML);
}

// `/` ne montre qu'une chose : depose ta video. `/admin` est la porte de
// service, celle ou le proprietaire gere ses visuels.
app.get('/', async (req, reply) => sendPage(reply));
app.get('/admin', async (req, reply) => sendPage(reply));

app.get('/api/health', async () => ({
  ok: true,
  flashMs: FLASH_MS,
  adminRequired: Boolean(ADMIN_CODE),
  images: (await listImages()).length,
  caps: await capabilities(),
}));

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function safeName(name, fallback) {
  const base = path.basename(String(name || '')).replace(/[\u0000-\u001f\u007f]/g, '');
  const cleaned = base.replace(/[^\w.\- ()À-ɏ]/g, '_').trim();
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned.slice(0, 120) : fallback;
}

function outputName(sourceName) {
  const ext = path.extname(sourceName);
  const stem = ext ? sourceName.slice(0, -ext.length) : sourceName;
  return `${stem || 'video'}_flash.mp4`;
}

/** Leve une 401 si un code est configure et que celui presente ne correspond pas */
function requireAdmin(req) {
  if (!ADMIN_CODE) return;
  const given = String(req.headers['x-admin-code'] || '').trim();
  if (given !== ADMIN_CODE) {
    throw Object.assign(new Error('Code incorrect'), { status: 401 });
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function fail(reply, err, log) {
  const status = err.status || (err.code === 'FST_REQ_FILE_TOO_LARGE' ? 413 : 400);
  log?.error({ err }, 'requete en echec');
  return reply.code(status).send({ error: err.message || 'Requete impossible' });
}

/** Ecrit chaque fichier du multipart dans `dir`, renvoie la liste */
async function saveFiles(req, dir, { max, prefix }) {
  const saved = [];
  for await (const part of req.parts()) {
    if (part.type === 'field') continue;
    if (saved.length >= max) {
      part.file.resume();
      continue;
    }
    const original = safeName(part.filename, `${prefix}_${saved.length + 1}`);
    const dest = path.join(dir, `${prefix}_${saved.length}${path.extname(original) || ''}`);
    await pipeline(part.file, createWriteStream(dest));
    if (part.file.truncated) {
      throw new HttpError(413, `${original} est trop volumineux`);
    }
    saved.push({ path: dest, original });
  }
  return saved;
}

// ---------------------------------------------------------------------------
// bibliotheque d images
// ---------------------------------------------------------------------------

app.get('/api/library', async () => {
  const images = await listImages();
  return {
    max: MAX_IMAGES,
    images: images.map((i) => ({ id: i.id, url: `/api/library/${i.id}/thumb` })),
  };
});

app.post('/api/library', async (req, reply) => {
  try {
    requireAdmin(req);
  } catch (err) {
    return fail(reply, err, req.log);
  }
  const job = await createJob('upload-images');
  try {
    const files = await saveFiles(req, job.dir, { max: MAX_IMAGES, prefix: 'img' });
    if (!files.length) throw new HttpError(400, 'Aucune image recue');

    const added = [];
    const rejected = [];
    for (const f of files) {
      const st = await stat(f.path).catch(() => null);
      if (st && st.size > MAX_IMAGE_BYTES) {
        rejected.push(f.original);
        continue;
      }
      try {
        added.push(await addImage(f.path, f.original));
      } catch {
        rejected.push(f.original);
      }
    }
    if (!added.length) throw new HttpError(400, 'Aucune de ces images n a pu etre ajoutee');

    const images = await listImages();
    return {
      added: added.length,
      rejected,
      images: images.map((i) => ({ id: i.id, url: `/api/library/${i.id}/thumb` })),
    };
  } catch (err) {
    return fail(reply, err, req.log);
  } finally {
    await destroyJob(job.id);
  }
});

app.post('/api/admin/check', async (req, reply) => {
  try {
    requireAdmin(req);
    return { ok: true };
  } catch (err) {
    return fail(reply, err, req.log);
  }
});

app.get('/api/library/:id/thumb', async (req, reply) => {
  const img = await findImage(req.params.id);
  if (!img) return reply.code(404).send({ error: 'Image inconnue' });
  const thumb = thumbPath(img.id);
  const file = (await stat(thumb).catch(() => null)) ? thumb : img.file;
  reply.header('Content-Type', 'image/jpeg');
  reply.header('Cache-Control', 'public, max-age=86400');
  return reply.send(createReadStream(file));
});

app.delete('/api/library/:id', async (req, reply) => {
  try {
    requireAdmin(req);
  } catch (err) {
    return fail(reply, err, req.log);
  }
  const ok = await deleteImage(req.params.id);
  if (!ok) return reply.code(404).send({ error: 'Image inconnue' });
  return { ok: true };
});

// ---------------------------------------------------------------------------
// traitement : videos in, fichier out
// ---------------------------------------------------------------------------

app.post('/api/jobs', async (req, reply) => {
  const job = await createJob('videos');
  try {
    const library = await listImages();
    if (!library.length) {
      throw new HttpError(400, 'Ajoute au moins une image dans « Mes images » avant de lancer une video');
    }

    const files = await saveFiles(req, job.dir, { max: MAX_VIDEOS, prefix: 'src' });
    if (!files.length) throw new HttpError(400, 'Aucune video recue');

    const picks = pickRandom(library, files.length);
    job.items = [];
    for (let i = 0; i < files.length; i += 1) {
      const meta = await probe(files[i].path);
      job.items.push({ ...files[i], meta, image: picks[i] });
    }

    job.status = 'processing';
    job.progress = 0;
    job.events.length = 0;
    job.outputs = [];
    touch(job);

    process.nextTick(() => runJob(job));

    return { jobId: job.id, count: job.items.length };
  } catch (err) {
    await destroyJob(job.id);
    return fail(reply, err, req.log);
  }
});

/** Encodage strictement sequentiel : ffmpeg sature deja le CPU sur un fichier */
async function runJob(job) {
  const total = job.items.length;
  try {
    for (let i = 0; i < total; i += 1) {
      const item = job.items[i];
      const out = path.join(job.dir, `out_${i}.mp4`);
      job.current = { index: i, name: item.original };
      emit(job, 'item', { index: i, total, name: item.original });

      try {
        await encode({
          input: item.path,
          image: item.image.file,
          output: out,
          meta: item.meta,
          frames: flashFrames(item.meta),
          cover: FLASH_ON_COVER,
          onProgress: (p) => {
            job.progress = (i + p) / total;
            touch(job);
            emit(job, 'progress', { progress: job.progress, index: i, total });
          },
        });
        job.outputs.push({ file: out, name: outputName(item.original) });
        emit(job, 'itemDone', { index: i, total, name: item.original, ok: true });
      } catch (err) {
        app.log.error({ err, file: item.original }, 'echec encodage');
        emit(job, 'itemDone', { index: i, total, name: item.original, ok: false });
      }
    }

    if (!job.outputs.length) throw new Error('aucun fichier encode');

    if (job.outputs.length === 1) {
      job.result = { ...job.outputs[0], type: 'video/mp4' };
    } else {
      const zipPath = path.join(job.dir, 'flashframe.zip');
      await makeZip(job.outputs, zipPath);
      job.result = { file: zipPath, name: 'mes-videos-flash.zip', type: 'application/zip' };
    }

    job.status = 'done';
    job.progress = 1;
    emit(job, 'done', {
      jobId: job.id,
      name: job.result.name,
      url: `/api/download/${job.id}`,
      failed: total - job.outputs.length,
      total,
    });
  } catch (err) {
    app.log.error({ err }, 'echec du job');
    job.status = 'error';
    job.error = 'Aucune video n a pu etre traitee. Formats non supportes ?';
    emit(job, 'failed', { error: job.error });
  }
}

function makeZip(outputs, zipPath) {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 0 } }); // du mp4, deja compresse
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    const used = new Map();
    for (const o of outputs) {
      let name = o.name;
      if (used.has(name)) {
        const k = used.get(name) + 1;
        used.set(name, k);
        const ext = path.extname(name);
        name = `${name.slice(0, -ext.length)}_${k}${ext}`;
      } else {
        used.set(name, 1);
      }
      archive.file(o.file, { name });
    }
    archive.finalize();
  });
}

app.get('/api/progress/:id', async (req, reply) => {
  const job = getJob(req.params.id);
  if (!job) return reply.code(404).send({ error: 'Job inconnu ou expire' });

  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const stream = subscribe(job, reply);
  stream.write('state', {
    status: job.status,
    progress: job.progress,
    total: job.items.length,
    error: job.error,
  });
  // rejeu : un telephone qui se verrouille coupe le flux, on ne doit rien perdre
  for (const e of job.events) stream.write(e.event, e.data);

  const ping = setInterval(() => {
    try {
      reply.raw.write(': ping\n\n');
    } catch {
      clearInterval(ping);
    }
  }, 15000);
  reply.raw.on('close', () => clearInterval(ping));
  return reply;
});

app.get('/api/download/:id', async (req, reply) => {
  const job = getJob(req.params.id);
  if (!job || !job.result) return reply.code(404).send({ error: 'Fichier indisponible' });
  const st = await stat(job.result.file).catch(() => null);
  if (!st) return reply.code(404).send({ error: 'Fichier indisponible' });

  reply.header('Content-Type', job.result.type);
  reply.header('Content-Length', st.size);
  reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(job.result.name)}"`);

  const stream = createReadStream(job.result.file);
  // delai avant purge : Safari iOS peut reemettre une requete Range
  stream.on('close', () => setTimeout(() => destroyJob(job.id).catch(() => {}), 60000));
  return reply.send(stream);
});

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

await ensureRoot();
await initLibrary(app.log);
startSweeper(app.log);

const caps = await capabilities();
app.log.info(
  { autorotate: caps.autorotate, zscale: caps.zscale, flashMs: FLASH_MS, adminCode: Boolean(ADMIN_CODE) },
  caps.autorotate
    ? 'ffmpeg applique la rotation au decodage : pas de transpose manuel'
    : 'ffmpeg n applique PAS la rotation : transpose conditionnel actif',
);

const port = Number(process.env.PORT || 3000);
await app.listen({ port, host: '0.0.0.0' });
