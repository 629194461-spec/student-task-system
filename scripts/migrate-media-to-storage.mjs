import { copyFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { deleteStoredUrl, storeDataUrl, validateStorageConfiguration } from '../storage.mjs';

const root = resolve('.');
const dataDir = resolve(process.env.DATA_DIR || join(root, 'data'));
const dbPath = join(dataDir, 'learning-planet.db');
await mkdir(dataDir, { recursive: true });
validateStorageConfiguration();

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA wal_checkpoint(TRUNCATE);');

const taskColumns = new Set(db.prepare('PRAGMA table_info(tasks)').all().map(column => column.name));
const resourceColumns = new Set(db.prepare('PRAGMA table_info(task_resources)').all().map(column => column.name));
if (!taskColumns.has('feedback_url')) db.exec("ALTER TABLE tasks ADD COLUMN feedback_url TEXT NOT NULL DEFAULT ''");
if (!resourceColumns.has('url')) db.exec("ALTER TABLE task_resources ADD COLUMN url TEXT NOT NULL DEFAULT ''");

const backupPath = `${dbPath}.before-media-migration-${new Date().toISOString().replace(/[:.]/g, '-')}`;
await copyFile(dbPath, backupPath);
console.log(`数据库备份：${backupPath}`);

let migrated = 0;
async function migrateRows(rows, upload, update) {
  for (const row of rows) {
    const url = await upload(row);
    try {
      update(row, url);
      migrated += 1;
      console.log(`已迁移 ${migrated}：${row.name || row.username || `记录 ${row.id}`}`);
    } catch (error) {
      await deleteStoredUrl(url, { dataDir }).catch(() => {});
      throw error;
    }
  }
}

try {
  const resources = db.prepare("SELECT id, name, data FROM task_resources WHERE data LIKE 'data:%;base64,%' AND COALESCE(url, '') = '' ORDER BY id").all();
  await migrateRows(
    resources,
    row => storeDataUrl(row.data, { dataDir, folder: 'task-resources', name: row.name }),
    (row, url) => db.prepare("UPDATE task_resources SET url = ?, data = '' WHERE id = ?").run(url, row.id)
  );

  const feedback = db.prepare("SELECT id, feedback_name AS name, feedback_data AS data FROM tasks WHERE feedback_data LIKE 'data:%;base64,%' AND COALESCE(feedback_url, '') = '' ORDER BY id").all();
  await migrateRows(
    feedback,
    row => storeDataUrl(row.data, { dataDir, folder: 'student-feedback', name: row.name }),
    (row, url) => db.prepare("UPDATE tasks SET feedback_url = ?, feedback_data = '' WHERE id = ?").run(url, row.id)
  );

  const avatars = db.prepare("SELECT id, username, avatar AS data FROM users WHERE avatar LIKE 'data:image/%;base64,%' ORDER BY id").all();
  await migrateRows(
    avatars,
    row => storeDataUrl(row.data, { dataDir, folder: 'avatars', name: `${row.username}.png` }),
    (row, url) => db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(url, row.id)
  );

  console.log(`迁移完成，共迁移 ${migrated} 个文件。`);
} finally {
  db.close();
}
