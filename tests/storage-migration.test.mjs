import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

test('legacy Base64 media migrates to storage URLs with a database backup', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'learning-planet-migration-'));
  const dbPath = join(dataDir, 'learning-planet.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE task_resources (id INTEGER PRIMARY KEY, name TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, feedback_name TEXT NOT NULL, feedback_data TEXT NOT NULL);
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL, avatar TEXT NOT NULL);
  `);
  db.prepare('INSERT INTO task_resources (name, data) VALUES (?, ?)').run('说明.txt', 'data:text/plain;base64,5rWL6K+V');
  db.prepare('INSERT INTO tasks (feedback_name, feedback_data) VALUES (?, ?)').run('成果.png', png);
  db.prepare('INSERT INTO users (username, avatar) VALUES (?, ?)').run('student', png);
  db.close();

  try {
    await execute(process.execPath, ['scripts/migrate-media-to-storage.mjs'], { cwd: root, env: { ...process.env, NODE_ENV: 'test', STORAGE_DRIVER: 'local', DATA_DIR: dataDir } });
    const migrated = new DatabaseSync(dbPath, { readOnly: true });
    const resource = migrated.prepare('SELECT data, url FROM task_resources').get();
    const feedback = migrated.prepare('SELECT feedback_data, feedback_url FROM tasks').get();
    const user = migrated.prepare('SELECT avatar FROM users').get();
    migrated.close();

    assert.equal(resource.data, '');
    assert.equal(feedback.feedback_data, '');
    for (const url of [resource.url, feedback.feedback_url, user.avatar]) assert.match(url, /^\/uploads\//);
    assert.equal((await readFile(join(dataDir, decodeURIComponent(resource.url)))).toString(), '测试');
    assert.ok((await readdir(dataDir)).some(name => name.startsWith('learning-planet.db.before-media-migration-')));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
