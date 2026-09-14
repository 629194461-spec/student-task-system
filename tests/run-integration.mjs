import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';

const root = resolve(import.meta.dirname, '..');
const port = Number(process.env.TEST_PORT || 4191);
const base = `http://127.0.0.1:${port}`;
const dataDir = await mkdtemp(join(tmpdir(), 'learning-planet-test-'));

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', ...options });
    child.once('error', rejectRun);
    child.once('exit', code => code === 0 ? resolveRun() : rejectRun(new Error(`${command} exited with code ${code}`)));
  });
}

async function waitForServer() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const listening = await new Promise(resolveConnection => {
      const socket = createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => { socket.destroy(); resolveConnection(true); });
      socket.once('error', () => resolveConnection(false));
    });
    if (listening) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error(`测试服务未能在 ${base} 启动`);
}

const server = spawn(process.execPath, ['server.mjs'], {
  cwd: root,
  env: { ...process.env, NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port), DATA_DIR: dataDir },
  stdio: 'inherit'
});

try {
  await waitForServer();
  await run(process.execPath, ['--test', 'tests/task-workflow.test.mjs'], { env: { ...process.env, TEST_BASE_URL: base, TEST_DATA_DIR: dataDir } });
  await run(process.execPath, ['--test', 'tests/task-templates.test.mjs', 'tests/account-system.test.mjs', 'tests/storage-migration.test.mjs', 'tests/reading-checkin.test.mjs'], { env: { ...process.env, TEST_BASE_URL: base } });
} finally {
  if (server.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise(resolveExit => server.once('exit', resolveExit));
  }
  await rm(dataDir, { recursive: true, force: true });
}
