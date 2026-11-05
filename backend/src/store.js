/**
 * Хранилище отзывов: JSON Lines (одна запись — одна строка) в DATA_DIR/feedback.jsonl.
 * Без БД и зависимостей; дописывание строки — атомарная операция для записей такого размера.
 * Интерфейс { add, list } позволяет позже заменить файл на SQLite/Postgres.
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export function createFileStore(dataDir) {
  const file = path.join(dataDir, 'feedback.jsonl');
  let ready = null;
  const ensureDir = () => (ready ??= mkdir(dataDir, { recursive: true }));

  return {
    file,

    async add({ name, email, message }) {
      await ensureDir();
      const record = { id: randomUUID(), createdAt: new Date().toISOString(), name, email, message };
      await appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');
      return record;
    },

    /** Последние записи, новые первыми. Битые строки пропускаются. */
    async list({ limit = 200 } = {}) {
      let text;
      try {
        text = await readFile(file, 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT') return { items: [], total: 0 };
        throw error;
      }
      const all = [];
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          all.push(JSON.parse(line));
        } catch {
          // пропускаем повреждённую строку, остальное отдаём
        }
      }
      return { items: all.reverse().slice(0, limit), total: all.length };
    },
  };
}
