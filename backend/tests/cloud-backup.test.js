/** Облачная копия DATA_DIR (Upstash REST): восстановление при запуске и отправка изменений. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createCloudBackup } from '../src/cloud-backup.js';

function fakeUpstash(initial = {}) {
  const hash = new Map(Object.entries(initial));
  const fetchImpl = async (url, init) => {
    const [cmd, , ...args] = JSON.parse(init.body);
    let result = null;
    if (cmd === 'HGETALL') result = [...hash].flat();
    if (cmd === 'HSET') { hash.set(args[0], args[1]); result = 1; }
    return { ok: true, status: 200, json: async () => ({ result }) };
  };
  return { hash, fetchImpl };
}

test('restore скачивает файлы, flush отправляет изменённые, мусор игнорируется', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'neptun-backup-'));
  const cloud = fakeUpstash({ 'accounts.json': '{"users":[1]}', '../evil.json': 'x' });
  const backup = createCloudBackup({ url: 'https://x.upstash.io', token: 't' }, dir, { fetchImpl: cloud.fetchImpl, log: { error() {} } });

  assert.equal(await backup.restore(), 1);
  assert.equal(await readFile(path.join(dir, 'accounts.json'), 'utf8'), '{"users":[1]}');

  backup.watch();
  await writeFile(path.join(dir, 'orders.json'), '{"orders":[]}');
  await new Promise((r) => setTimeout(r, 100)); // fs.watch успевает заметить
  await backup.flush();
  assert.equal(cloud.hash.get('orders.json'), '{"orders":[]}');
  await rm(dir, { recursive: true, force: true });
});

test('без переменных копия выключена', () => {
  assert.equal(createCloudBackup({}, '/tmp').enabled, false);
});
