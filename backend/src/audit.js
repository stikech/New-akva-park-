/**
 * Журнал аудита: append-only JSONL в DATA_DIR/audit.jsonl.
 *
 * Зачем: платёжные и бронировочные действия требуют следов, по которым
 * можно восстановить события (без карты и паролей — только facts).
 * Пишем одной строкой за событие; append атомарен для записей этого размера.
 * Файл — не единственное доказательство, а инструмент разбора инцидентов.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export function createAudit(dataDir, { now = () => new Date() } = {}) {
  const file = path.join(dataDir, 'audit.jsonl');
  let dirReady = null;
  const ensureDir = () => (dirReady ??= mkdir(dataDir, { recursive: true }));

  /**
   * record(event, fields) — не бросает исключений: журнал не должен
   * ломать основной запрос. Плохая запись лучше отсутствующего ответа.
   */
  async function record(event, fields = {}) {
    const line = `${JSON.stringify({ id: randomUUID(), at: now().toISOString(), event, ...fields })}\n`;
    try {
      await ensureDir();
      await appendFile(file, line, 'utf8');
    } catch {
      // кеш не пишем — аудит подключается к уже работающему API
    }
    return file;
  }

  return { file, record };
}
