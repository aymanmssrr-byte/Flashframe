import { randomUUID } from 'node:crypto';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

export const WORK_ROOT = process.env.WORK_DIR || '/tmp/flashframe';
export const TTL_MS = Number(process.env.JOB_TTL_MS || 60 * 60 * 1000); // 1 h
const SWEEP_MS = Number(process.env.SWEEP_MS || 5 * 60 * 1000);

/** @type {Map<string, any>} */
const jobs = new Map();

export function newId() {
  return randomUUID();
}

export async function createJob(kind = 'single') {
  const id = newId();
  const dir = path.join(WORK_ROOT, id);
  await mkdir(dir, { recursive: true });
  const job = {
    id,
    kind,
    dir,
    createdAt: Date.now(),
    status: 'created', // created | ready | processing | done | error
    progress: 0,
    error: null,
    items: [],
    result: null,
    events: [], // journal rejoue aux clients qui se connectent en retard
    listeners: new Set(),
    proc: null,
  };
  jobs.set(id, job);
  return job;
}

export function getJob(id) {
  return jobs.get(id);
}

export function touch(job) {
  job.createdAt = Date.now();
}

export async function destroyJob(id) {
  const job = jobs.get(id);
  if (!job) return;
  jobs.delete(id);
  for (const l of job.listeners) {
    try {
      l.end();
    } catch {
      /* ignore */
    }
  }
  job.listeners.clear();
  if (job.proc && !job.proc.killed) {
    try {
      job.proc.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
  await rm(job.dir, { recursive: true, force: true }).catch(() => {});
}

// --- SSE -------------------------------------------------------------------

export function subscribe(job, reply) {
  const stream = {
    write(event, data) {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    end() {
      try {
        reply.raw.end();
      } catch {
        /* ignore */
      }
    },
  };
  job.listeners.add(stream);
  reply.raw.on('close', () => job.listeners.delete(stream));
  return stream;
}

export function emit(job, event, data) {
  // `progress` est trop bavard pour etre journalise : l etat courant est
  // renvoye dans l evenement `state` a la souscription.
  if (event !== 'progress') {
    job.events.push({ event, data });
    if (job.events.length > 500) job.events.shift();
  }
  for (const l of job.listeners) {
    try {
      l.write(event, data);
    } catch {
      job.listeners.delete(l);
    }
  }
}

// --- nettoyage -------------------------------------------------------------

export function startSweeper(log = console) {
  const timer = setInterval(async () => {
    const now = Date.now();
    for (const [id, job] of jobs) {
      if (now - job.createdAt > TTL_MS) {
        log.info?.({ jobId: id }, 'job expire, suppression');
        await destroyJob(id);
      }
    }
    // filet de securite : repertoires orphelins (redemarrage du process)
    try {
      const { readdir } = await import('node:fs/promises');
      const entries = await readdir(WORK_ROOT).catch(() => []);
      for (const name of entries) {
        if (jobs.has(name)) continue;
        const p = path.join(WORK_ROOT, name);
        const st = await stat(p).catch(() => null);
        if (st && now - st.mtimeMs > TTL_MS) await rm(p, { recursive: true, force: true }).catch(() => {});
      }
    } catch {
      /* ignore */
    }
  }, SWEEP_MS);
  timer.unref();
  return timer;
}

export async function ensureRoot() {
  await mkdir(WORK_ROOT, { recursive: true });
}

export function jobCount() {
  return jobs.size;
}
