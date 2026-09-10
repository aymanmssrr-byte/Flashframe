/**
 * La bibliotheque d'images flash.
 *
 * C'est la seule chose qui doit survivre a un redemarrage : les videos sont
 * jetables, les images non. Elles vivent dans LIBRARY_DIR, un fichier par
 * image plus sa vignette. Pas de base de donnees : le dossier EST la base.
 */
import { randomUUID } from 'node:crypto';
import { access, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { probe, run } from './ffmpeg.js';

const DEFAULT_DIR = process.env.LIBRARY_DIR || '/data/library';
const FALLBACK_DIR = path.join(process.cwd(), 'data', 'library');

export const MAX_IMAGE_BYTES = Number(process.env.MAX_IMAGE_BYTES || 25 * 1024 * 1024);
export const MAX_IMAGES = Number(process.env.MAX_IMAGES || 500);

const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.bmp']);

let dir = null;

/** Choisit le dossier de stockage : LIBRARY_DIR si accessible en ecriture, sinon ./data/library */
export async function initLibrary(log = console) {
  for (const candidate of [DEFAULT_DIR, FALLBACK_DIR]) {
    try {
      await mkdir(candidate, { recursive: true });
      await access(candidate);
      const probeFile = path.join(candidate, '.write-test');
      await writeFile(probeFile, 'ok');
      await rm(probeFile, { force: true });
      dir = candidate;
      break;
    } catch {
      /* on essaie le suivant */
    }
  }
  if (!dir) throw new Error('aucun dossier de bibliotheque accessible en ecriture');

  if (dir === FALLBACK_DIR && DEFAULT_DIR !== FALLBACK_DIR) {
    log.warn?.(
      { dir },
      `${DEFAULT_DIR} n est pas accessible en ecriture : la bibliotheque est stockee dans ${FALLBACK_DIR}. `
      + 'Sur Railway, monter un volume sur /data pour qu elle survive aux redeploiements.',
    );
  } else {
    log.info?.({ dir }, 'bibliotheque d images');
  }
  return dir;
}

export function libraryDir() {
  if (!dir) throw new Error('bibliotheque non initialisee');
  return dir;
}

function isId(value) {
  return typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value);
}

export function imagePath(id, ext) {
  return path.join(libraryDir(), `${id}${ext}`);
}

export function thumbPath(id) {
  return path.join(libraryDir(), `${id}.thumb.jpg`);
}

/** Liste des images, les plus recentes en premier */
export async function listImages() {
  const entries = await readdir(libraryDir()).catch(() => []);
  const out = [];
  for (const name of entries) {
    if (name.includes('.thumb.')) continue;
    const ext = path.extname(name).toLowerCase();
    const id = name.slice(0, -ext.length);
    if (!isId(id) || !ALLOWED_EXT.has(ext)) continue;
    const st = await stat(path.join(libraryDir(), name)).catch(() => null);
    if (!st) continue;
    out.push({ id, ext, file: path.join(libraryDir(), name), addedAt: st.mtimeMs });
  }
  out.sort((a, b) => b.addedAt - a.addedAt);
  return out;
}

export async function findImage(id) {
  if (!isId(id)) return null;
  const all = await listImages();
  return all.find((i) => i.id === id) || null;
}

/**
 * Enregistre une image deja ecrite sur disque sous un chemin temporaire.
 * Verifie que ffmpeg sait la lire, puis fabrique la vignette.
 */
export async function addImage(tmpFile, originalName) {
  let ext = path.extname(String(originalName || '')).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) ext = '.jpg';

  const meta = await probe(tmpFile).catch(() => null);
  if (!meta || !meta.width || !meta.height) {
    throw Object.assign(new Error('Ce fichier n est pas une image lisible'), { status: 400 });
  }

  const current = await listImages();
  if (current.length >= MAX_IMAGES) {
    throw Object.assign(new Error(`Bibliotheque pleine (${MAX_IMAGES} images maximum)`), { status: 400 });
  }

  const id = randomUUID();
  const dest = imagePath(id, ext);
  const { rename, copyFile } = await import('node:fs/promises');
  try {
    await rename(tmpFile, dest);
  } catch {
    // tmp et bibliotheque peuvent etre sur deux systemes de fichiers
    await copyFile(tmpFile, dest);
    await rm(tmpFile, { force: true });
  }

  // vignette carree pour la grille
  await run('ffmpeg', ['-v', 'error', '-y', '-i', dest,
    '-vf', 'scale=400:400:force_original_aspect_ratio=increase,crop=400:400',
    '-frames:v', '1', '-q:v', '4', thumbPath(id)]).catch(() => {});

  return { id, ext, width: meta.width, height: meta.height };
}

export async function deleteImage(id) {
  const img = await findImage(id);
  if (!img) return false;
  await rm(img.file, { force: true });
  await rm(thumbPath(id), { force: true });
  return true;
}

/**
 * Tire `count` images au hasard, sans repetition tant que la bibliotheque
 * n est pas epuisee. Du pur aleatoire donnerait trois fois la meme image sur
 * cinq videos, ce qui ruine l interet du truc.
 */
export function pickRandom(images, count) {
  if (!images.length) return [];
  const out = [];
  let pool = [];
  for (let i = 0; i < count; i += 1) {
    if (!pool.length) pool = shuffle([...images]);
    out.push(pool.pop());
  }
  return out;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
