/** Le code d'acces protege-t-il vraiment l'ajout et la suppression d'images ? */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../src/ffmpeg.js';

const DIR = '/tmp/admin-test';
const PORT = 3995;
const BASE = `http://127.0.0.1:${PORT}`;
const CODE = 'mael2026';
let failures = 0;

async function test(name, fn) {
  process.stdout.write(`• ${name} ... `);
  try { await fn(); console.log('OK'); }
  catch (e) { failures++; console.log('ECHEC'); console.error('   ' + e.message.split('\n')[0]); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

await rm(DIR, { recursive: true, force: true });
await mkdir(DIR, { recursive: true });
const img = path.join(DIR, 'v.png');
await run('ffmpeg', ['-v','error','-y','-f','lavfi','-i','color=c=0xed1c24:s=800x800','-frames:v','1', img]);
const imgBuf = await readFile(img);

const server = spawn(process.execPath, [new URL('../src/server.js', import.meta.url).pathname], {
  env: { ...process.env, PORT: String(PORT), WORK_DIR: DIR + '/work', LIBRARY_DIR: DIR + '/lib',
         ADMIN_CODE: CODE, LOG_LEVEL: 'error' },
  stdio: 'ignore',
});
for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {} await sleep(400); }

function form() {
  const fd = new FormData();
  fd.append('images', new Blob([imgBuf], { type: 'image/png' }), 'v.png');
  return fd;
}

try {
  await test('health annonce qu un code est exige', async () => {
    const h = await (await fetch(`${BASE}/api/health`)).json();
    assert.equal(h.adminRequired, true);
  });
  await test('ajouter une image sans code : refuse (401)', async () => {
    const r = await fetch(`${BASE}/api/library`, { method: 'POST', body: form() });
    assert.equal(r.status, 401);
  });
  await test('ajouter avec un mauvais code : refuse (401)', async () => {
    const r = await fetch(`${BASE}/api/library`, { method: 'POST', body: form(), headers: { 'x-admin-code': 'nope' } });
    assert.equal(r.status, 401);
  });
  await test('ajouter avec le bon code : accepte', async () => {
    const r = await fetch(`${BASE}/api/library`, { method: 'POST', body: form(), headers: { 'x-admin-code': CODE } });
    const b = await r.json();
    assert.equal(r.status, 200, JSON.stringify(b));
    assert.equal(b.added, 1);
    globalThis.__id = b.images[0].id;
  });
  await test('verification du code : 401 si faux, 200 si bon', async () => {
    assert.equal((await fetch(`${BASE}/api/admin/check`, { method: 'POST', headers: { 'x-admin-code': 'x' } })).status, 401);
    assert.equal((await fetch(`${BASE}/api/admin/check`, { method: 'POST', headers: { 'x-admin-code': CODE } })).status, 200);
  });
  await test('supprimer sans code : refuse, l image reste', async () => {
    const r = await fetch(`${BASE}/api/library/${globalThis.__id}`, { method: 'DELETE' });
    assert.equal(r.status, 401);
    const list = await (await fetch(`${BASE}/api/library`)).json();
    assert.equal(list.images.length, 1, 'image toujours la');
  });
  await test('supprimer avec le bon code : accepte', async () => {
    const r = await fetch(`${BASE}/api/library/${globalThis.__id}`, { method: 'DELETE', headers: { 'x-admin-code': CODE } });
    assert.equal(r.status, 200);
  });
  await test('deposer une video reste libre pour tout le monde', async () => {
    // bibliotheque vide -> 400 « ajoute une image », surtout pas 401
    const fd = new FormData();
    fd.append('videos', new Blob([imgBuf], { type: 'video/mp4' }), 'x.mp4');
    const r = await fetch(`${BASE}/api/jobs`, { method: 'POST', body: fd });
    assert.equal(r.status, 400, 'le depot de video ne doit jamais demander de code');
  });
} finally {
  server.kill('SIGKILL');
  await rm(DIR, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} echec(s)` : '\nTous les tests passent');
process.exit(failures ? 1 : 0);
