import { createServer } from 'node:http';
import { mkdirSync, existsSync, readFileSync, createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';
import { deleteStoredUrl, localUploadPath, signStoredUrl, storageDriver, storeDataUrl, validateStorageConfiguration } from './storage.mjs';

const root = resolve('.');
const dataDir = resolve(process.env.DATA_DIR || join(root, 'data'));
mkdirSync(dataDir, { recursive: true });

const isProduction = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '127.0.0.1';
const db = new DatabaseSync(join(dataDir, 'learning-planet.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
validateStorageConfiguration();

const captchaStore = new Map();
const loginAttempts = new Map();
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const REMEMBER_SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const CAPTCHA_TTL_MS = 1000 * 60 * 5;
const WINDOW_MS = 1000 * 60 * 15;
const MAX_LOGIN_ATTEMPTS = 8;
const CATEGORY_ICONS = [
  'assets/category-icons/chinese-book.png',
  'assets/category-icons/math-blocks.png',
  'assets/category-icons/english-bubble.png',
  'assets/category-icons/reading-book.png',
  'assets/category-icons/sport-shoe.png',
  'assets/category-icons/science-flask.png',
  'assets/category-icons/art-palette.png',
  'assets/category-icons/music-note.png',
  'assets/category-icons/health-apple.png',
  'assets/category-icons/school-backpack.png'
];

function now() { return new Date().toISOString(); }
function unix() { return Date.now(); }
function businessDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: process.env.APP_TIMEZONE || 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function weekRange(dateString = businessDate()) {
  const date = new Date(`${dateString}T12:00:00Z`);
  const mondayOffset = (date.getUTCDay() + 6) % 7;
  const start = new Date(date); start.setUTCDate(date.getUTCDate() - mondayOffset);
  const end = new Date(start); end.setUTCDate(start.getUTCDate() + 6);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}
function monthRange(dateString = businessDate()) {
  const [year, month] = dateString.split('-').map(Number);
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const end = new Date(Date.UTC(year, month, 0, 12)).toISOString().slice(0, 10);
  return { start, end };
}
function statsRange(period, customStart, customEnd) {
  const current = businessDate();
  if (period === 'week') return { ...weekRange(current), end: current, label: '本周榜' };
  if (period === 'month') return { ...monthRange(current), end: current, label: '本月榜' };
  if (period === 'last_week') { const previous = new Date(`${weekRange(current).start}T12:00:00Z`); previous.setUTCDate(previous.getUTCDate() - 1); return { ...weekRange(previous.toISOString().slice(0, 10)), label: '上周榜' }; }
  if (period === 'last_month') { const first = new Date(`${monthRange(current).start}T12:00:00Z`); first.setUTCDate(0); return { ...monthRange(first.toISOString().slice(0, 10)), label: '上月榜' }; }
  if (period === 'all') return { start: '1970-01-01', end: current, label: '总榜' };
  if (period === 'custom' && /^\d{4}-\d{2}-\d{2}$/.test(customStart) && /^\d{4}-\d{2}-\d{2}$/.test(customEnd) && customEnd >= customStart) return { start: customStart, end: customEnd, label: '自定义统计' };
  return null;
}
function rewardBreakdown(totalStars) {
  const total = Math.max(0, Number(totalStars) || 0);
  return { suns: Math.floor(total / 1000), moons: Math.floor(total / 100) % 10, stars: total % 100, totalStars: total };
}
function dateRange(startDate, endDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) return [];
  const start = new Date(`${startDate}T12:00:00Z`);
  const end = new Date(`${endDate}T12:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return [];
  const dates = [];
  for (const cursor = new Date(start); cursor <= end && dates.length <= 30; cursor.setUTCDate(cursor.getUTCDate() + 1)) dates.push(cursor.toISOString().slice(0, 10));
  return dates.length <= 30 ? dates : [];
}
function taskSchedule(body) {
  const explicitType = clean(body.scheduleType, 12);
  const legacyStart = clean(body.startDate || body.date, 10);
  const legacyEnd = clean(body.endDate, 10);
  const scheduleType = explicitType || (legacyEnd && legacyStart && legacyEnd !== legacyStart ? 'repeat' : 'single');
  if (scheduleType === 'single') {
    const date = clean(body.date || body.startDate, 10) || businessDate();
    return dateRange(date, date).length === 1 ? { scheduleType, dates: [date], taskDate: date, startDate: date, endDate: date, repeatPattern: '', weekdays: [] } : null;
  }
  if (scheduleType === 'range') {
    const startDate = clean(body.startDate, 10) || businessDate();
    const endDate = clean(body.endDate, 10);
    return dateRange(startDate, startDate).length === 1 && dateRange(endDate, endDate).length === 1 && endDate >= startDate
      ? { scheduleType, dates: [endDate], taskDate: endDate, startDate, endDate, repeatPattern: '', weekdays: [] }
      : null;
  }
  if (scheduleType !== 'repeat') return null;
  const startDate = clean(body.startDate, 10) || businessDate();
  const endDate = clean(body.endDate, 10);
  const range = dateRange(startDate, endDate);
  const repeatPattern = clean(body.repeatPattern, 12) || 'daily';
  if (!range.length || !['daily', 'weekly'].includes(repeatPattern)) return null;
  const weekdays = repeatPattern === 'weekly'
    ? [...new Set((Array.isArray(body.weekdays) ? body.weekdays : []).map(Number).filter(day => Number.isInteger(day) && day >= 1 && day <= 7))].sort((a, b) => a - b)
    : [];
  if (repeatPattern === 'weekly' && !weekdays.length) return null;
  const dates = repeatPattern === 'daily' ? range : range.filter(date => weekdays.includes(((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7) + 1));
  return dates.length ? { scheduleType, dates, taskDate: dates[0], startDate, endDate, repeatPattern, weekdays } : null;
}
function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}
function bad(res, status, message) { json(res, status, { error: message }); }
function readBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    let data = '';
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) { reject(new Error('请求内容过大')); req.destroy(); return; }
      data += chunk;
    });
    req.on('end', () => {
      try { resolveBody(data ? JSON.parse(data) : {}); } catch { reject(new Error('请求格式不正确')); }
    });
    req.on('error', reject);
  });
}
function clean(value, max = 128) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
function categoryIcon(value) { const icon = clean(value, 128); return CATEGORY_ICONS.includes(icon) ? icon : ''; }
function normalizeTaskFeedback(value) {
  if (typeof value !== 'string' || !value) return null;
  const match = /^data:(image\/(?:png|jpeg|webp)|video\/(?:mp4|webm));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return null;
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > 4 * 1024 * 1024) return null;
  const mime = match[1];
  const validSignature = mime === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    : mime === 'image/jpeg' ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : mime === 'image/webp' ? bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP'
        : mime === 'video/mp4' ? bytes.subarray(4, 8).toString() === 'ftyp'
          : bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (!validSignature) return null;
  return { data: value, kind: match[1].startsWith('image/') ? 'image' : 'video' };
}
function normalizeTaskResource(value, name) {
  if (typeof value !== 'string' || !value) return null;
  const match = /^data:([a-zA-Z0-9][a-zA-Z0-9.+-]*\/[a-zA-Z0-9][a-zA-Z0-9.+-]*);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return null;
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > 6 * 1024 * 1024) return null;
  const mime = match[1].toLowerCase();
  if (['image/svg+xml', 'text/html', 'application/xhtml+xml', 'application/javascript', 'text/javascript'].includes(mime)) return null;
  const previewImage = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif', 'image/avif'].includes(mime);
  const previewVideo = ['video/mp4', 'video/webm'].includes(mime);
  const previewAudio = mime.startsWith('audio/');
  return { data: value, name: clean(name, 120) || '任务资料', mime, kind: previewImage ? 'image' : previewVideo ? 'video' : previewAudio ? 'audio' : 'file' };
}
function normalizeTaskResources(body) {
  const supplied = Array.isArray(body.resources)
    ? body.resources
    : body.resourceData ? [{ data: body.resourceData, name: body.resourceName }] : [];
  if (supplied.length > 5) return null;
  const resources = supplied.map(item => normalizeTaskResource(item?.data, item?.name));
  return resources.every(Boolean) ? resources : null;
}
function taskResourceValidationMessage(body) {
  const supplied = Array.isArray(body.resources) ? body.resources : body.resourceData ? [body.resourceData] : [];
  return supplied.length > 5 ? '当前任务或模板最多上传 5 个文件' : '存在无法读取的文件，请确认单个文件不超过 6 MB';
}
function normalizeExistingResourceIds(body) {
  if (!Object.hasOwn(body, 'existingResourceIds')) return [];
  if (!Array.isArray(body.existingResourceIds)) return null;
  const ids = [...new Set(body.existingResourceIds.map(Number))];
  return ids.length <= 5 && ids.every(id => Number.isSafeInteger(id) && id > 0) ? ids : null;
}
function normalizeAvatar(value) {
  if (typeof value !== 'string') return '';
  const legacy = value.trim();
  if (legacy.length > 0 && legacy.length <= 2 && !legacy.startsWith('data:')) return legacy;
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return '';
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > 200 * 1024) return '';
  const validSignature = match[1] === 'png'
    ? bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    : match[1] === 'jpeg'
      ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
  return validSignature ? value : '';
}
function isStoredFileUrl(value) { return typeof value === 'string' && (/^\/uploads\//.test(value) || /^https:\/\//.test(value)); }
function stripUrlQuery(value) { return typeof value === 'string' ? value.split('?')[0] : value; }
function isImageAvatar(value) { return /^data:image\/(png|jpeg|webp);base64,/.test(value) || isStoredFileUrl(value); }
function avatarInitial(displayName, fallback = '家') { return Array.from(String(displayName || '').trim()).at(-1) || fallback; }
async function avatarValue(value, current, displayName, fallback = '家') {
  const normalized = normalizeAvatar(value);
  if (/^data:image\//.test(normalized)) {
    const url = await storeDataUrl(normalized, { dataDir, folder: 'avatars', name: `${displayName}.png` });
    return { avatar: url, uploadedUrl: url };
  }
  if (isStoredFileUrl(value) && stripUrlQuery(value) === current) return { avatar: current, uploadedUrl: '' };
  if (/^data:image\//.test(current)) {
    const url = await storeDataUrl(current, { dataDir, folder: 'avatars', name: `${displayName}.png` });
    return { avatar: url, uploadedUrl: url };
  }
  return { avatar: isImageAvatar(current) ? current : avatarInitial(displayName, fallback), uploadedUrl: '' };
}
async function feedbackValue(value, task, name) {
  if (typeof value !== 'string' || !value) return { url: '', kind: '', uploadedUrl: '' };
  if (isStoredFileUrl(value) && stripUrlQuery(value) === task.feedback_url) return { url: task.feedback_url, kind: task.feedback_kind || '', uploadedUrl: '' };
  const feedback = normalizeTaskFeedback(value);
  if (!feedback) return null;
  const url = await storeDataUrl(feedback.data, { dataDir, folder: 'student-feedback', name: name || '学习反馈' });
  return { url, kind: feedback.kind, uploadedUrl: url };
}
function escapeXml(value) { return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]); }
function hashPassword(password, salt = randomBytes(16).toString('hex')) { return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`; }
function verifyPassword(password, stored) {
  const [salt, digest] = String(stored || '').split(':');
  if (!salt || !digest) return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(digest, 'hex');
  return expected.length === candidate.length && timingSafeEqual(expected, candidate);
}
function cookieValue(req, name) {
  const cookies = String(req.headers.cookie || '').split(';').map(value => value.trim());
  const pair = cookies.find(value => value.startsWith(`${name}=`));
  return pair ? decodeURIComponent(pair.slice(name.length + 1)) : null;
}
function secureCookie(name, value, maxAge = 0) {
  const settings = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
  if (isProduction) settings.push('Secure');
  if (maxAge) settings.push(`Max-Age=${Math.floor(maxAge / 1000)}`);
  return settings.join('; ');
}
function createSession(userId, ttlMs = SESSION_TTL_MS) {
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(createHash('sha256').update(token).digest('hex'), userId, new Date(unix() + ttlMs).toISOString(), now());
  return token;
}
function sessionUser(req) {
  const token = cookieValue(req, 'lp_session');
  if (!token) return null;
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const user = db.prepare(`SELECT users.id, users.username, users.role, users.display_name, users.avatar, users.must_change_password
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ? AND users.active = 1`).get(tokenHash, now());
  return user || null;
}
function requireUser(req, res) { const user = sessionUser(req); if (!user) { bad(res, 401, '登录状态已失效，请重新登录'); return null; } return user; }
function requireParent(user, res) { if (!['parent', 'admin'].includes(user.role)) { bad(res, 403, '当前账号没有此操作权限'); return false; } return true; }
function requireAdmin(user, res) { if (user.role !== 'admin') { bad(res, 403, '仅超级管理员可以执行此操作'); return false; } return true; }
function createCaptcha() {
  const id = randomBytes(18).toString('base64url');
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const answer = Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join('');
  const colors = ['#2F80ED', '#36B37E', '#F2994A', '#8B6FE8'];
  const chars = [...answer].map((char, index) => `<text x="${20 + index * 27}" y="36" fill="${colors[index]}" font-family="Arial, sans-serif" font-size="27" font-weight="700" transform="rotate(${randomInt(-12, 13)} ${30 + index * 27} 28)">${char}</text>`).join('');
  const noise = Array.from({ length: 6 }, (_, index) => `<circle cx="${10 + index * 21}" cy="${10 + randomInt(30)}" r="1.4" fill="#9FB3C8"/>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="132" height="48" viewBox="0 0 132 48" role="img" aria-label="验证码"><rect width="132" height="48" rx="8" fill="#F7FAFC"/><path d="M4 ${18 + randomInt(12)} Q 66 ${8 + randomInt(26)} 128 ${18 + randomInt(12)}" fill="none" stroke="#D9E2EC" stroke-width="1.5"/>${noise}${chars}</svg>`;
  captchaStore.set(id, { answer, expires: unix() + CAPTCHA_TTL_MS });
  return { id, svg };
}
function purgeEphemeralState() {
  const time = unix();
  for (const [id, captcha] of captchaStore) if (captcha.expires < time) captchaStore.delete(id);
  for (const [key, entry] of loginAttempts) if (entry.windowEnds < time) loginAttempts.delete(key);
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now());
}
function rateLimit(ip) {
  const record = loginAttempts.get(ip);
  if (!record || record.windowEnds < unix()) return { allowed: true, remaining: MAX_LOGIN_ATTEMPTS };
  return { allowed: record.count < MAX_LOGIN_ATTEMPTS, remaining: Math.max(0, MAX_LOGIN_ATTEMPTS - record.count) };
}
function recordFailedLogin(ip) {
  const record = loginAttempts.get(ip);
  if (!record || record.windowEnds < unix()) loginAttempts.set(ip, { count: 1, windowEnds: unix() + WINDOW_MS });
  else record.count += 1;
}
function clearRateLimit(ip) { loginAttempts.delete(ip); }

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('student','parent','admin')), display_name TEXT NOT NULL,
      avatar TEXT NOT NULL DEFAULT '星', active INTEGER NOT NULL DEFAULT 1,
      must_change_password INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS parent_students (
      parent_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      is_primary INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(parent_id, student_id)
    );
    CREATE TABLE IF NOT EXISTS student_profiles (
      student_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      grade TEXT NOT NULL DEFAULT '三年级', note TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY, student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL, category TEXT NOT NULL, icon TEXT NOT NULL, category_color TEXT NOT NULL,
      detail TEXT NOT NULL, task_date TEXT NOT NULL, duration_minutes INTEGER, stars INTEGER NOT NULL DEFAULT 1,
      feedback_type TEXT NOT NULL DEFAULT 'photo_or_video', needs_review INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'not_started', submitted_at TEXT, reviewed_at TEXT, reviewed_by INTEGER REFERENCES users(id),
      encouragement TEXT, created_at TEXT NOT NULL,
      series_id TEXT NOT NULL DEFAULT '', repeat_pattern TEXT NOT NULL DEFAULT '', repeat_weekdays TEXT NOT NULL DEFAULT '',
      series_start_date TEXT NOT NULL DEFAULT '', series_end_date TEXT NOT NULL DEFAULT '',
      schedule_type TEXT NOT NULL DEFAULT 'single', available_start_date TEXT NOT NULL DEFAULT '', available_end_date TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS task_categories (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, icon TEXT NOT NULL DEFAULT '✦',
      color TEXT NOT NULL DEFAULT '#2F80ED', active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_resources (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, mime TEXT NOT NULL, kind TEXT NOT NULL,
      data TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '', created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_templates (
      id INTEGER PRIMARY KEY, creator_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL, category_id INTEGER NOT NULL REFERENCES task_categories(id), detail TEXT NOT NULL,
      duration_minutes INTEGER NOT NULL, stars INTEGER NOT NULL DEFAULT 1,
      feedback_type TEXT NOT NULL DEFAULT 'photo_or_video', needs_review INTEGER NOT NULL DEFAULT 1,
      resource_id INTEGER REFERENCES task_resources(id) ON DELETE SET NULL, is_public INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_resource_links (
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      resource_id INTEGER NOT NULL REFERENCES task_resources(id) ON DELETE CASCADE,
      sort_order INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(task_id, resource_id)
    );
    CREATE TABLE IF NOT EXISTS template_resource_links (
      template_id INTEGER NOT NULL REFERENCES task_templates(id) ON DELETE CASCADE,
      resource_id INTEGER NOT NULL REFERENCES task_resources(id) ON DELETE CASCADE,
      sort_order INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(template_id, resource_id)
    );
    CREATE TABLE IF NOT EXISTS rewards (
      id INTEGER PRIMARY KEY, student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL, stars INTEGER NOT NULL,
      message TEXT, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_student_date ON tasks(student_id, task_date);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_student_status_date ON tasks(student_id, status, task_date);
    CREATE INDEX IF NOT EXISTS idx_parent_students_student_parent ON parent_students(student_id, parent_id);
    CREATE INDEX IF NOT EXISTS idx_rewards_student_created ON rewards(student_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_task_templates_creator ON task_templates(creator_id);
    CREATE INDEX IF NOT EXISTS idx_task_templates_public ON task_templates(is_public);
    CREATE INDEX IF NOT EXISTS idx_task_templates_category_updated ON task_templates(category_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_task_resource_links_resource ON task_resource_links(resource_id);
    CREATE INDEX IF NOT EXISTS idx_template_resource_links_resource ON template_resource_links(resource_id);
  `);
  const taskColumns = new Set(db.prepare('PRAGMA table_info(tasks)').all().map(column => column.name));
  if (!taskColumns.has('feedback_kind')) db.exec("ALTER TABLE tasks ADD COLUMN feedback_kind TEXT NOT NULL DEFAULT ''");
  if (!taskColumns.has('feedback_data')) db.exec("ALTER TABLE tasks ADD COLUMN feedback_data TEXT NOT NULL DEFAULT ''");
  if (!taskColumns.has('feedback_url')) db.exec("ALTER TABLE tasks ADD COLUMN feedback_url TEXT NOT NULL DEFAULT ''");
  if (!taskColumns.has('feedback_name')) db.exec("ALTER TABLE tasks ADD COLUMN feedback_name TEXT NOT NULL DEFAULT ''");
  if (!taskColumns.has('feedback_note')) db.exec("ALTER TABLE tasks ADD COLUMN feedback_note TEXT NOT NULL DEFAULT ''");
  if (!taskColumns.has('resource_id')) db.exec('ALTER TABLE tasks ADD COLUMN resource_id INTEGER');
  if (!taskColumns.has('started_at')) db.exec('ALTER TABLE tasks ADD COLUMN started_at TEXT');
  if (!taskColumns.has('draft_updated_at')) db.exec('ALTER TABLE tasks ADD COLUMN draft_updated_at TEXT');
  if (!taskColumns.has('is_demo')) db.exec('ALTER TABLE tasks ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0');
  if (!taskColumns.has('series_id')) db.exec("ALTER TABLE tasks ADD COLUMN series_id TEXT NOT NULL DEFAULT ''");
  if (!taskColumns.has('repeat_pattern')) db.exec("ALTER TABLE tasks ADD COLUMN repeat_pattern TEXT NOT NULL DEFAULT ''");
  if (!taskColumns.has('repeat_weekdays')) db.exec("ALTER TABLE tasks ADD COLUMN repeat_weekdays TEXT NOT NULL DEFAULT ''");
  if (!taskColumns.has('series_start_date')) db.exec("ALTER TABLE tasks ADD COLUMN series_start_date TEXT NOT NULL DEFAULT ''");
  if (!taskColumns.has('series_end_date')) db.exec("ALTER TABLE tasks ADD COLUMN series_end_date TEXT NOT NULL DEFAULT ''");
  if (!taskColumns.has('schedule_type')) db.exec("ALTER TABLE tasks ADD COLUMN schedule_type TEXT NOT NULL DEFAULT 'single'");
  if (!taskColumns.has('available_start_date')) db.exec("ALTER TABLE tasks ADD COLUMN available_start_date TEXT NOT NULL DEFAULT ''");
  if (!taskColumns.has('available_end_date')) db.exec("ALTER TABLE tasks ADD COLUMN available_end_date TEXT NOT NULL DEFAULT ''");
  const resourceColumns = new Set(db.prepare('PRAGMA table_info(task_resources)').all().map(column => column.name));
  if (!resourceColumns.has('url')) db.exec("ALTER TABLE task_resources ADD COLUMN url TEXT NOT NULL DEFAULT ''");
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_series ON tasks(series_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_student_availability ON tasks(student_id, schedule_type, available_start_date, available_end_date)');
  db.exec(`
    INSERT OR IGNORE INTO task_resource_links (task_id, resource_id, sort_order)
      SELECT id, resource_id, 0 FROM tasks WHERE resource_id IS NOT NULL;
    INSERT OR IGNORE INTO template_resource_links (template_id, resource_id, sort_order)
      SELECT id, resource_id, 0 FROM task_templates WHERE resource_id IS NOT NULL;
  `);
  db.prepare(`UPDATE tasks SET is_demo = 1 WHERE id BETWEEN 1 AND 4
    AND student_id = (SELECT id FROM users WHERE username = 'xiaoyu' AND role = 'student')
    AND title IN ('朗读《秋天的雨》第 1-2 段','口算练习 30 题','阅读《昆虫记》','整理明天的小书包')`).run();
  db.exec("INSERT OR IGNORE INTO student_profiles (student_id, grade, note) SELECT id, '三年级', '' FROM users WHERE role = 'student'");
  const initialCategories = [
    ['语文小屋', CATEGORY_ICONS[0], '#F2994A'],
    ['数学乐园', CATEGORY_ICONS[1], '#2F80ED'],
    ['英语角', CATEGORY_ICONS[2], '#8B6FE8'],
    ['阅读时光', CATEGORY_ICONS[3], '#36B37E'],
    ['健康运动', CATEGORY_ICONS[4], '#EB5757']
  ];
  const insertCategory = db.prepare('INSERT OR IGNORE INTO task_categories (name, icon, color, created_at) VALUES (?, ?, ?, ?)');
  const refreshInitialIcon = db.prepare("UPDATE task_categories SET icon = ? WHERE name = ? AND active = 1 AND icon NOT LIKE 'assets/category-icons/%'");
  for (const [name, icon, color] of initialCategories) { insertCategory.run(name, icon, color, now()); refreshInitialIcon.run(icon, name); }
  db.exec('UPDATE tasks SET icon = COALESCE((SELECT icon FROM task_categories WHERE task_categories.name = tasks.category), icon)');
}
function seed() {
  const count = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
  if (count) return;
  db.prepare('INSERT INTO users (username, password_hash, role, display_name, avatar, must_change_password, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('admin', hashPassword('admin@2026'), 'admin', '超级管理员', '管', 0, now());
}

function ensureBuiltInAdmin() {
  const migrationKey = 'built_in_admin_2026_v1';
  if (db.prepare('SELECT 1 FROM system_settings WHERE key = ?').get(migrationKey)) return;
  const admin = db.prepare("SELECT id FROM users WHERE username = 'admin'").get();
  if (admin) {
    db.prepare("UPDATE users SET password_hash = ?, role = 'admin', display_name = '超级管理员', active = 1, must_change_password = 0 WHERE id = ?").run(hashPassword('admin@2026'), admin.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(admin.id);
  } else {
    db.prepare("INSERT INTO users (username, password_hash, role, display_name, avatar, active, must_change_password, created_at) VALUES ('admin', ?, 'admin', '超级管理员', '管', 1, 0, ?)").run(hashPassword('admin@2026'), now());
  }
  db.prepare('INSERT INTO system_settings (key, value) VALUES (?, ?)').run(migrationKey, now());
}

function publicUser(user) { return { id: user.id, username: user.username, role: user.role, displayName: user.display_name, avatar: signStoredUrl(user.avatar), mustChangePassword: Boolean(user.must_change_password) }; }
function storedResourceKind(resource) {
  const mime = String(resource?.mime || '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  const extension = String(resource?.name || '').toLowerCase().split('.').pop();
  if (['mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'weba', 'flac'].includes(extension)) return 'audio';
  return resource?.kind || 'file';
}
function linkedResources(ownerType, ownerId, legacyResourceId, includeData = false) {
  const table = ownerType === 'template' ? 'template_resource_links' : 'task_resource_links';
  const key = ownerType === 'template' ? 'template_id' : 'task_id';
  let resources = db.prepare(`SELECT task_resources.id, task_resources.name, task_resources.mime, task_resources.kind${includeData ? ', task_resources.url, task_resources.data' : ''}
    FROM ${table} JOIN task_resources ON task_resources.id = ${table}.resource_id
    WHERE ${table}.${key} = ? ORDER BY ${table}.sort_order, task_resources.id`).all(ownerId);
  if (!resources.length && legacyResourceId) {
    resources = db.prepare(`SELECT id, name, mime, kind${includeData ? ', url, data' : ''} FROM task_resources WHERE id = ?`).all(legacyResourceId);
  }
  return resources.map(resource => ({ id: resource.id, name: resource.name, mime: resource.mime, kind: storedResourceKind(resource), ...(includeData ? { data: signStoredUrl(resource.url || resource.data) } : {}) }));
}
async function storeResources(resources, folder) {
  const stored = [];
  try {
    for (const resource of resources) stored.push({ ...resource, url: await storeDataUrl(resource.data, { dataDir, folder, name: resource.name }) });
    return stored;
  } catch (error) {
    await Promise.allSettled(stored.map(resource => deleteStoredUrl(resource.url, { dataDir })));
    throw error;
  }
}
function insertResources(resources, creatorId) {
  const insert = db.prepare("INSERT INTO task_resources (name, mime, kind, data, url, created_by, created_at) VALUES (?, ?, ?, '', ?, ?, ?)");
  return resources.map(resource => Number(insert.run(resource.name, resource.mime, resource.kind, resource.url, creatorId, now()).lastInsertRowid));
}
function linkResources(ownerType, ownerId, resourceIds) {
  const table = ownerType === 'template' ? 'template_resource_links' : 'task_resource_links';
  const key = ownerType === 'template' ? 'template_id' : 'task_id';
  const insert = db.prepare(`INSERT OR IGNORE INTO ${table} (${key}, resource_id, sort_order) VALUES (?, ?, ?)`);
  resourceIds.forEach((resourceId, index) => insert.run(ownerId, resourceId, index));
}
const taskResourceSummarySql = `
  CASE WHEN EXISTS (SELECT 1 FROM task_resource_links trl WHERE trl.task_id = tasks.id)
    THEN (SELECT COUNT(*) FROM task_resource_links trl WHERE trl.task_id = tasks.id)
    WHEN tasks.resource_id IS NOT NULL THEN 1 ELSE 0 END AS resource_count,
  COALESCE((SELECT tr.name FROM task_resource_links trl JOIN task_resources tr ON tr.id = trl.resource_id WHERE trl.task_id = tasks.id ORDER BY trl.sort_order, tr.id LIMIT 1),
    (SELECT tr.name FROM task_resources tr WHERE tr.id = tasks.resource_id), '') AS resource_name,
  COALESCE((SELECT tr.mime FROM task_resource_links trl JOIN task_resources tr ON tr.id = trl.resource_id WHERE trl.task_id = tasks.id ORDER BY trl.sort_order, tr.id LIMIT 1),
    (SELECT tr.mime FROM task_resources tr WHERE tr.id = tasks.resource_id), '') AS resource_mime,
  COALESCE((SELECT tr.kind FROM task_resource_links trl JOIN task_resources tr ON tr.id = trl.resource_id WHERE trl.task_id = tasks.id ORDER BY trl.sort_order, tr.id LIMIT 1),
    (SELECT tr.kind FROM task_resources tr WHERE tr.id = tasks.resource_id), '') AS resource_kind`;
function taskJson(task, includeFeedback = false, includeResource = false) {
  const hasSummary = !includeResource && task.resource_count !== undefined;
  const resources = hasSummary
    ? Number(task.resource_count) > 0 ? [{ name: task.resource_name, mime: task.resource_mime, kind: task.resource_kind }] : []
    : linkedResources('task', task.id, task.resource_id, includeResource);
  const resource = resources[0];
  const resourceCount = hasSummary ? Number(task.resource_count) : resources.length;
  const repeatWeekdays = String(task.repeat_weekdays || '').split(',').map(Number).filter(day => day >= 1 && day <= 7);
  const scheduleType = task.series_id ? 'repeat' : task.schedule_type || 'single';
  const result = { id: task.id, studentId: task.student_id, title: task.title, category: task.category, icon: task.icon, color: task.category_color, detail: task.detail, date: task.task_date, duration: task.duration_minutes, stars: task.stars, feedbackType: task.feedback_type, needsReview: Boolean(task.needs_review), status: task.status, startedAt: task.started_at, draftUpdatedAt: task.draft_updated_at, submittedAt: task.submitted_at, encouragement: task.encouragement, studentName: task.student_name, studentAvatar: signStoredUrl(task.student_avatar), feedbackKind: task.feedback_kind || '', feedbackName: task.feedback_name || '', feedbackNote: task.feedback_note || '', hasFeedback: Boolean(task.feedback_url || task.feedback_data || task.feedback_note), hasResource: resourceCount > 0, resourceCount, resourceName: resource?.name || '', resourceMime: resource?.mime || '', resourceKind: resource?.kind || '', resources, scheduleType, isDateRange: scheduleType === 'range', availableStartDate: task.available_start_date || task.task_date, availableEndDate: task.available_end_date || task.task_date, isRecurring: Boolean(task.series_id), seriesId: task.series_id || '', repeatPattern: task.repeat_pattern || '', repeatWeekdays, seriesStartDate: task.series_start_date || '', seriesEndDate: task.series_end_date || '' };
  if (includeFeedback) result.feedbackData = signStoredUrl(task.feedback_url || task.feedback_data || '');
  if (includeResource) result.resourceData = resource?.data || '';
  return result;
}
function taskVisibleOn(task, date) {
  return task.isDateRange ? task.availableStartDate <= date && task.availableEndDate >= date : task.date === date;
}
function taskTemplateJson(template, includeResource = false) {
  const resources = linkedResources('template', template.id, template.resource_id, includeResource);
  const resource = resources[0];
  const result = {
    id: template.id, creatorId: template.creator_id, creatorName: template.creator_name,
    title: template.title, categoryId: template.category_id, category: template.category_name,
    icon: template.category_icon, color: template.category_color, detail: template.detail,
    duration: template.duration_minutes, stars: template.stars, feedbackType: template.feedback_type,
    needsReview: Boolean(template.needs_review), isPublic: Boolean(template.is_public),
    isOwner: Boolean(template.is_owner), hasResource: resources.length > 0, resourceCount: resources.length,
    resourceName: resource?.name || '', resourceMime: resource?.mime || '',
    resourceKind: resource?.kind || '', resources, createdAt: template.created_at, updatedAt: template.updated_at
  };
  if (includeResource) result.resourceData = resource?.data || '';
  return result;
}
const templateSelectSql = `SELECT task_templates.*, task_categories.name AS category_name,
  task_categories.icon AS category_icon, task_categories.color AS category_color,
  users.display_name AS creator_name, task_resources.name AS resource_name,
  task_resources.mime AS resource_mime, task_resources.kind AS resource_kind,
  COALESCE(NULLIF(task_resources.url, ''), task_resources.data) AS resource_data
  FROM task_templates
  JOIN task_categories ON task_categories.id = task_templates.category_id AND task_categories.active = 1
  JOIN users ON users.id = task_templates.creator_id
  LEFT JOIN task_resources ON task_resources.id = task_templates.resource_id`;
function deleteUnusedResource(resourceId) {
  if (!resourceId) return;
  const usedByTask = db.prepare('SELECT 1 FROM tasks WHERE resource_id = ? LIMIT 1').get(resourceId);
  const usedByTemplate = db.prepare('SELECT 1 FROM task_templates WHERE resource_id = ? LIMIT 1').get(resourceId);
  const usedByTaskLink = db.prepare('SELECT 1 FROM task_resource_links WHERE resource_id = ? LIMIT 1').get(resourceId);
  const usedByTemplateLink = db.prepare('SELECT 1 FROM template_resource_links WHERE resource_id = ? LIMIT 1').get(resourceId);
  if (!usedByTask && !usedByTemplate && !usedByTaskLink && !usedByTemplateLink) {
    const resource = db.prepare('SELECT url FROM task_resources WHERE id = ?').get(resourceId);
    db.prepare('DELETE FROM task_resources WHERE id = ?').run(resourceId);
    if (resource?.url) deleteStoredUrl(resource.url, { dataDir }).catch(error => console.error('清理存储文件失败：', error.message));
  }
}
function studentsForParent(parentId, includeInactive = false) { return db.prepare(`SELECT users.id, users.display_name, users.avatar, users.active FROM parent_students JOIN users ON users.id = parent_students.student_id WHERE parent_students.parent_id = ? ${includeInactive ? '' : 'AND users.active = 1'}`).all(parentId); }
function canManageStudent(user, studentId) { return user.role === 'admin' || studentsForParent(user.id, true).some(student => student.id === studentId); }
function studentListFor(user) {
  const students = user.role === 'admin'
    ? db.prepare("SELECT id, username, display_name, avatar, active FROM users WHERE role = 'student' ORDER BY id").all()
    : db.prepare(`SELECT users.id, users.username, users.display_name, users.avatar, users.active FROM parent_students JOIN users ON users.id = parent_students.student_id WHERE parent_students.parent_id = ? ORDER BY users.id`).all(user.id);
  const profile = db.prepare('SELECT grade, note FROM student_profiles WHERE student_id = ?');
  const todayTask = db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed, SUM(CASE WHEN status = 'pending_review' THEN 1 ELSE 0 END) AS pending FROM tasks WHERE student_id = ? AND ((schedule_type = 'range' AND available_start_date <= ? AND available_end_date >= ?) OR (schedule_type <> 'range' AND task_date = ?)) AND is_demo = 0");
  const rewardTotal = db.prepare('SELECT COALESCE(SUM(stars), 0) AS total FROM rewards WHERE student_id = ? AND (task_id IS NULL OR task_id IN (SELECT id FROM tasks WHERE is_demo = 0))');
  const linkedParents = db.prepare(`SELECT users.id, users.username, users.display_name, users.avatar, users.active
    FROM parent_students JOIN users ON users.id = parent_students.parent_id
    WHERE parent_students.student_id = ? AND users.role = 'parent' ORDER BY users.display_name`);
  return students.map(student => ({
    ...student,
    avatar: signStoredUrl(student.avatar),
    ...(profile.get(student.id) || { grade: '三年级', note: '' }),
    ...(todayTask.get(student.id, businessDate(), businessDate(), businessDate()) || { total: 0, completed: 0, pending: 0 }),
    growth: rewardBreakdown(rewardTotal.get(student.id).total),
    parents: linkedParents.all(student.id).filter(parent => user.role === 'admin' || parent.id === user.id).map(parent => ({ id: parent.id, username: parent.username, displayName: parent.display_name, avatar: signStoredUrl(parent.avatar), active: Boolean(parent.active) })),
    active: Boolean(student.active)
  }));
}

function parentList() {
  const parents = db.prepare("SELECT id, username, display_name, avatar, active, created_at FROM users WHERE role = 'parent' ORDER BY id DESC").all();
  const linkedStudents = db.prepare(`SELECT users.id, users.display_name, users.avatar, users.active
    FROM parent_students JOIN users ON users.id = parent_students.student_id
    WHERE parent_students.parent_id = ? ORDER BY users.display_name`);
  return parents.map(parent => ({ id: parent.id, username: parent.username, displayName: parent.display_name, avatar: signStoredUrl(parent.avatar), active: Boolean(parent.active), createdAt: parent.created_at, students: linkedStudents.all(parent.id).map(student => ({ id: student.id, displayName: student.display_name, avatar: signStoredUrl(student.avatar), active: Boolean(student.active) })) }));
}

migrate();
seed();
ensureBuiltInAdmin();

const mimeTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.weba': 'audio/webm', '.mp4': 'video/mp4', '.webm': 'video/webm', '.pdf': 'application/pdf', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8' };
function serveStatic(req, res, pathname) {
  const uploaded = localUploadPath(dataDir, pathname);
  if (uploaded) {
    if (storageDriver() !== 'local' || !existsSync(uploaded)) { res.writeHead(404); res.end('Not found'); return; }
    serveLocalFile(req, res, uploaded, mimeTypes[extname(uploaded)] || 'application/octet-stream'); return;
  }
  const requested = pathname === '/' ? '/index.html' : pathname;
  const file = normalize(join(root, requested));
  if (!file.startsWith(root) || !existsSync(file)) { res.writeHead(404); res.end('Not found'); return; }
  res.writeHead(200, { 'content-type': mimeTypes[extname(file)] || 'application/octet-stream', 'x-content-type-options': 'nosniff', 'cache-control': requested.includes('/assets/') ? 'public, max-age=86400' : 'no-cache' });
  createReadStream(file).pipe(res);
}
function serveLocalFile(req, res, file, contentType) {
  const size = statSync(file).size;
  const range = req.headers.range;
  const baseHeaders = { 'content-type': contentType, 'accept-ranges': 'bytes', 'x-content-type-options': 'nosniff', 'cache-control': 'public, max-age=31536000, immutable' };
  if (!range) {
    res.writeHead(200, { ...baseHeaders, 'content-length': size });
    if (req.method !== 'HEAD') createReadStream(file).pipe(res); else res.end();
    return;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || (!match[1] && !match[2])) { res.writeHead(416, { 'content-range': `bytes */${size}` }); res.end(); return; }
  let start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  let end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= size || end < start) { res.writeHead(416, { 'content-range': `bytes */${size}` }); res.end(); return; }
  end = Math.min(end, size - 1);
  res.writeHead(206, { ...baseHeaders, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${size}` });
  if (req.method !== 'HEAD') createReadStream(file, { start, end }).pipe(res); else res.end();
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'same-origin');
  res.setHeader('content-security-policy', "default-src 'self'; img-src 'self' data: https:; media-src 'self' data: https:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'self'; frame-ancestors 'none'");
  try {
    purgeEphemeralState();
    if (!url.pathname.startsWith('/api/')) { serveStatic(req, res, url.pathname); return; }
    if (req.method === 'GET' && url.pathname === '/api/auth/captcha') { json(res, 200, createCaptcha()); return; }
    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      const limit = rateLimit(ip);
      if (!limit.allowed) { bad(res, 429, '尝试次数过多，请 15 分钟后再试'); return; }
      const body = await readBody(req);
      const username = clean(body.username, 48);
      const password = typeof body.password === 'string' ? body.password : '';
      const captchaId = clean(body.captchaId, 80);
      const captchaAnswer = clean(body.captcha, 12).toUpperCase();
      const requestedRole = clean(body.role, 12);
      const captcha = captchaStore.get(captchaId);
      captchaStore.delete(captchaId);
      if (!captcha || captcha.expires < unix() || captcha.answer !== captchaAnswer) { recordFailedLogin(ip); bad(res, 400, '验证码不正确或已过期'); return; }
      const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(username);
      if (!user || !verifyPassword(password, user.password_hash) || (requestedRole === 'student' && user.role !== 'student') || (requestedRole === 'parent' && !['parent', 'admin'].includes(user.role))) {
        recordFailedLogin(ip); bad(res, 401, '用户名或密码不正确'); return;
      }
      clearRateLimit(ip);
      const sessionTtl = body.rememberMe === true ? REMEMBER_SESSION_TTL_MS : SESSION_TTL_MS;
      const token = createSession(user.id, sessionTtl);
      json(res, 200, { user: publicUser(user) }, { 'set-cookie': secureCookie('lp_session', token, sessionTtl) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
      const token = cookieValue(req, 'lp_session');
      if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(createHash('sha256').update(token).digest('hex'));
      json(res, 204, {}, { 'set-cookie': secureCookie('lp_session', '', -1) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/change-password') {
      const user = requireUser(req, res); if (!user) return;
      const body = await readBody(req);
      const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
      const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
      const record = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id);
      if (!record || !verifyPassword(currentPassword, record.password_hash)) { bad(res, 400, '当前密码不正确'); return; }
      if (newPassword.length < 10 || !/[a-zA-Z]/.test(newPassword) || !/\d/.test(newPassword)) { bad(res, 400, '新密码至少 10 位，并包含字母和数字'); return; }
      db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hashPassword(newPassword), user.id);
      json(res, 200, { ok: true });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/auth/me') { const user = requireUser(req, res); if (user) json(res, 200, { user: publicUser(user) }); return; }
    if (req.method === 'GET' && url.pathname === '/api/student/dashboard') {
      const user = requireUser(req, res); if (!user) return; if (user.role !== 'student') { bad(res, 403, '学生账号专属接口'); return; }
      const date = clean(url.searchParams.get('date') || businessDate(), 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { bad(res, 400, '日期格式不正确'); return; }
      const week = weekRange(date);
      const weekRows = db.prepare(`SELECT tasks.*, ${taskResourceSummarySql} FROM tasks WHERE student_id = ? AND ((schedule_type = 'range' AND available_start_date <= ? AND available_end_date >= ?) OR (schedule_type <> 'range' AND task_date BETWEEN ? AND ?)) AND is_demo = 0 ORDER BY task_date, CASE status WHEN 'not_started' THEN 1 WHEN 'in_progress' THEN 2 WHEN 'needs_more' THEN 3 WHEN 'pending_review' THEN 4 ELSE 5 END, id`).all(user.id, week.end, week.start, week.start, week.end).map(taskJson);
      const weekTasks = Object.fromEntries(dateRange(week.start, week.end).map(day => [day, weekRows.filter(task => taskVisibleOn(task, day))]));
      const tasks = weekTasks[date] || [];
      const taskDates = Object.entries(weekTasks).filter(([, dayTasks]) => dayTasks.length).map(([day]) => day);
      const rewards = db.prepare('SELECT rewards.*, tasks.title FROM rewards LEFT JOIN tasks ON tasks.id = rewards.task_id WHERE rewards.student_id = ? AND (rewards.task_id IS NULL OR tasks.is_demo = 0) ORDER BY rewards.id DESC LIMIT 10').all(user.id);
      const totalStars = db.prepare('SELECT COALESCE(SUM(stars),0) AS total FROM rewards WHERE student_id = ? AND (task_id IS NULL OR task_id IN (SELECT id FROM tasks WHERE is_demo = 0))').get(user.id).total;
      json(res, 200, { date, student: publicUser(user), tasks, taskDates, weekTasks, rewards, growth: rewardBreakdown(totalStars) });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/student/tasks') {
      const user = requireUser(req, res); if (!user) return; if (user.role !== 'student') { bad(res, 403, '学生账号专属接口'); return; }
      const filter = clean(url.searchParams.get('filter') || 'overdue', 24);
      const currentDate = businessDate();
      const week = weekRange(currentDate);
      const filters = {
        overdue: { sql: "task_date BETWEEN ? AND ? AND task_date < ? AND status IN ('not_started','in_progress','needs_more')", args: [week.start, week.end, currentDate] },
        todo: { sql: "((schedule_type = 'range' AND available_start_date <= ? AND available_end_date >= ?) OR (schedule_type <> 'range' AND task_date = ?)) AND status IN ('not_started','in_progress','needs_more')", args: [currentDate, currentDate, currentDate] },
        future: { sql: "((schedule_type = 'range' AND available_start_date > ?) OR (schedule_type <> 'range' AND task_date > ?)) AND status IN ('not_started','in_progress','needs_more')", args: [currentDate, currentDate] },
        pending_review: { sql: "status = 'pending_review'", args: [] },
        completed: { sql: "status = 'completed'", args: [] }
      };
      const selected = filters[filter];
      if (!selected) { bad(res, 400, '任务筛选条件不正确'); return; }
      const order = filter === 'completed' ? 'task_date DESC, id DESC' : 'task_date ASC, id ASC';
      const tasks = db.prepare(`SELECT tasks.*, ${taskResourceSummarySql} FROM tasks WHERE student_id = ? AND is_demo = 0 AND ${selected.sql} ORDER BY ${order}`).all(user.id, ...selected.args).map(taskJson);
      json(res, 200, { filter, tasks });
      return;
    }
    if (req.method === 'GET' && /^\/api\/student\/tasks\/\d+$/.test(url.pathname)) {
      const user = requireUser(req, res); if (!user) return; if (user.role !== 'student') { bad(res, 403, '学生账号专属接口'); return; }
      const taskId = Number(url.pathname.split('/')[4]);
      const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND student_id = ? AND is_demo = 0').get(taskId, user.id);
      if (!task) { bad(res, 404, '任务不存在'); return; }
      json(res, 200, { task: taskJson(task, true, true) });
      return;
    }
    if (req.method === 'PATCH' && /^\/api\/student\/tasks\/\d+\/draft$/.test(url.pathname)) {
      const user = requireUser(req, res); if (!user) return; if (user.role !== 'student') { bad(res, 403, '学生账号专属接口'); return; }
      const taskId = Number(url.pathname.split('/')[4]);
      const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND student_id = ? AND is_demo = 0').get(taskId, user.id);
      if (!task) { bad(res, 404, '任务不存在'); return; }
      if (['completed', 'pending_review'].includes(task.status)) { bad(res, 409, task.status === 'completed' ? '任务已完成' : '任务正在等待审核'); return; }
      if (task.schedule_type === 'range' && (businessDate() < task.available_start_date || businessDate() > task.available_end_date)) { bad(res, 409, '当前不在该任务的可完成日期范围内'); return; }
      const body = await readBody(req, 6 * 1024 * 1024);
      const rawFeedback = typeof body.feedbackData === 'string' ? body.feedbackData : task.feedback_url || task.feedback_data;
      const feedbackName = Object.hasOwn(body, 'feedbackName') ? clean(body.feedbackName, 120) : task.feedback_name;
      const feedback = await feedbackValue(rawFeedback, task, feedbackName);
      if (rawFeedback && !feedback) { bad(res, 400, '反馈文件格式不正确或超过 4 MB'); return; }
      const feedbackNote = Object.hasOwn(body, 'feedbackNote') ? clean(body.feedbackNote, 300) : task.feedback_note;
      const time = now();
      try {
        db.prepare("UPDATE tasks SET status = 'in_progress', started_at = COALESCE(started_at, ?), draft_updated_at = ?, feedback_kind = ?, feedback_data = '', feedback_url = ?, feedback_name = ?, feedback_note = ? WHERE id = ?").run(time, time, feedback?.kind || '', feedback?.url || '', feedbackName, feedbackNote, task.id);
      } catch (error) {
        if (feedback?.uploadedUrl) await deleteStoredUrl(feedback.uploadedUrl, { dataDir }).catch(() => {});
        throw error;
      }
      if (task.feedback_url && task.feedback_url !== feedback?.url) deleteStoredUrl(task.feedback_url, { dataDir }).catch(error => console.error('清理旧反馈文件失败：', error.message));
      json(res, 200, { task: taskJson(db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id), true, true) });
      return;
    }
    if (req.method === 'POST' && /^\/api\/student\/tasks\/\d+\/submit$/.test(url.pathname)) {
      const user = requireUser(req, res); if (!user) return; if (user.role !== 'student') { bad(res, 403, '学生账号专属接口'); return; }
      const taskId = Number(url.pathname.split('/')[4]);
      const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND student_id = ? AND is_demo = 0').get(taskId, user.id);
      if (!task) { bad(res, 404, '任务不存在'); return; }
      if (['completed', 'pending_review'].includes(task.status)) { bad(res, 409, task.status === 'completed' ? '任务已完成' : '任务正在等待审核'); return; }
      if (task.schedule_type === 'range' && (businessDate() < task.available_start_date || businessDate() > task.available_end_date)) { bad(res, 409, '当前不在该任务的可完成日期范围内'); return; }
      const body = await readBody(req, 6 * 1024 * 1024);
      const feedbackName = clean(body.feedbackName, 120);
      const feedback = await feedbackValue(body.feedbackData, task, feedbackName);
      const feedbackNote = clean(body.feedbackNote, 300);
      if (task.feedback_type !== 'none') {
        if (!feedback) { bad(res, 400, '请按任务要求上传学习反馈，文件最大 4 MB'); return; }
        if (task.feedback_type === 'photo' && feedback.kind !== 'image') { bad(res, 400, '该任务需要上传图片反馈'); return; }
        if (task.feedback_type === 'video' && feedback.kind !== 'video') { bad(res, 400, '该任务需要上传视频反馈'); return; }
      }
      try {
        db.prepare("UPDATE tasks SET status = ?, submitted_at = ?, feedback_kind = ?, feedback_data = '', feedback_url = ?, feedback_name = ?, feedback_note = ? WHERE id = ?").run(task.needs_review ? 'pending_review' : 'completed', now(), feedback?.kind || '', feedback?.url || '', feedbackName, feedbackNote, task.id);
      } catch (error) {
        if (feedback?.uploadedUrl) await deleteStoredUrl(feedback.uploadedUrl, { dataDir }).catch(() => {});
        throw error;
      }
      if (task.feedback_url && task.feedback_url !== feedback?.url) deleteStoredUrl(task.feedback_url, { dataDir }).catch(error => console.error('清理旧反馈文件失败：', error.message));
      if (!task.needs_review) db.prepare('INSERT INTO rewards (student_id, task_id, stars, message, created_at) VALUES (?, ?, ?, ?, ?)').run(user.id, task.id, task.stars, '完成得很棒！', now());
      json(res, 200, { task: taskJson(db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id)) });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/parent/dashboard') {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return;
      const students = user.role === 'admin'
        ? db.prepare("SELECT users.id, users.display_name, users.avatar, student_profiles.grade FROM users LEFT JOIN student_profiles ON student_profiles.student_id = users.id WHERE users.role = 'student' AND users.active = 1 ORDER BY users.display_name").all()
        : db.prepare("SELECT users.id, users.display_name, users.avatar, student_profiles.grade FROM parent_students JOIN users ON users.id = parent_students.student_id LEFT JOIN student_profiles ON student_profiles.student_id = users.id WHERE parent_students.parent_id = ? AND users.active = 1 ORDER BY users.display_name").all(user.id);
      if (!students.length) {
        const currentDate = businessDate();
        const week = weekRange(currentDate);
        json(res, 200, { students: [], selectedStudentId: null, period: { today: currentDate, weekStart: week.start, weekEnd: week.end }, growth: rewardBreakdown(0), summary: { weekCompleted: 0, weekTotal: 0, weekOverdue: 0, pending: 0, todayCompleted: 0, todayTotal: 0, weekStars: 0, totalStars: 0 }, pending: [] });
        return;
      }
      const studentId = Number(url.searchParams.get('studentId') || students[0]?.id);
      if (!students.some(student => student.id === studentId)) { bad(res, 403, '无权查看该学生'); return; }
      const pending = db.prepare(`SELECT tasks.*, users.display_name AS student_name, users.avatar AS student_avatar, ${taskResourceSummarySql} FROM tasks JOIN users ON users.id = tasks.student_id WHERE tasks.student_id = ? AND tasks.status = 'pending_review' AND tasks.is_demo = 0 ORDER BY tasks.submitted_at`).all(studentId).map(taskJson);
      const currentDate = businessDate();
      const week = weekRange(currentDate);
      const todayTasks = db.prepare("SELECT status FROM tasks WHERE student_id = ? AND ((schedule_type = 'range' AND available_start_date <= ? AND available_end_date >= ?) OR (schedule_type <> 'range' AND task_date = ?)) AND is_demo = 0").all(studentId, currentDate, currentDate, currentDate);
      const weekTasks = db.prepare("SELECT status, task_date FROM tasks WHERE student_id = ? AND ((schedule_type = 'range' AND available_start_date <= ? AND available_end_date >= ?) OR (schedule_type <> 'range' AND task_date BETWEEN ? AND ?)) AND is_demo = 0").all(studentId, week.end, week.start, week.start, week.end);
      const weekStars = Number(db.prepare('SELECT COALESCE(SUM(stars),0) AS total FROM rewards WHERE student_id = ? AND substr(created_at, 1, 10) BETWEEN ? AND ? AND (task_id IS NULL OR task_id IN (SELECT id FROM tasks WHERE is_demo = 0))').get(studentId, week.start, week.end).total);
      const totalStars = Number(db.prepare('SELECT COALESCE(SUM(stars),0) AS total FROM rewards WHERE student_id = ? AND (task_id IS NULL OR task_id IN (SELECT id FROM tasks WHERE is_demo = 0))').get(studentId).total);
      json(res, 200, {
        students: students.map(student => ({ ...student, avatar: signStoredUrl(student.avatar) })),
        selectedStudentId: studentId,
        period: { today: currentDate, weekStart: week.start, weekEnd: week.end },
        growth: rewardBreakdown(totalStars),
        summary: {
          weekCompleted: weekTasks.filter(task => task.status === 'completed').length,
          weekTotal: weekTasks.length,
          weekOverdue: weekTasks.filter(task => task.task_date < currentDate && ['not_started', 'in_progress', 'needs_more'].includes(task.status)).length,
          pending: pending.length,
          todayCompleted: todayTasks.filter(task => task.status === 'completed').length,
          todayTotal: todayTasks.length,
          weekStars,
          totalStars
        },
        pending
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/parent/students') {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return;
      json(res, 200, { students: studentListFor(user) });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/parents') {
      const user = requireUser(req, res); if (!user || !requireAdmin(user, res)) return;
      json(res, 200, { parents: parentList() });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/parents') {
      const user = requireUser(req, res); if (!user || !requireAdmin(user, res)) return;
      const body = await readBody(req, 400 * 1024);
      const displayName = clean(body.displayName, 24);
      const username = clean(body.username, 48);
      const password = typeof body.password === 'string' ? body.password : '';
      if (displayName.length < 2 || username.length < 3 || password.length < 10) { bad(res, 400, '请填写 2 至 24 位昵称、至少 3 位用户名和至少 10 位初始密码'); return; }
      if (!/^[A-Za-z0-9_.-]+$/.test(username)) { bad(res, 400, '用户名只能包含字母、数字、点、下划线和短横线'); return; }
      if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) { bad(res, 400, '密码至少 10 位，并包含字母和数字'); return; }
      if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) { bad(res, 409, '该用户名已被使用'); return; }
      const avatarResult = await avatarValue(body.avatar, '', displayName);
      let result;
      try {
        result = db.prepare("INSERT INTO users (username, password_hash, role, display_name, avatar, active, must_change_password, created_at) VALUES (?, ?, 'parent', ?, ?, 1, 0, ?)").run(username, hashPassword(password), displayName, avatarResult.avatar, now());
      } catch (error) {
        if (avatarResult.uploadedUrl) await deleteStoredUrl(avatarResult.uploadedUrl, { dataDir }).catch(() => {});
        throw error;
      }
      json(res, 201, { parent: parentList().find(parent => parent.id === Number(result.lastInsertRowid)) });
      return;
    }
    if (req.method === 'PATCH' && /^\/api\/admin\/parents\/\d+$/.test(url.pathname)) {
      const user = requireUser(req, res); if (!user || !requireAdmin(user, res)) return;
      const parentId = Number(url.pathname.split('/')[4]);
      const body = await readBody(req, 400 * 1024);
      const displayName = clean(body.displayName, 24);
      const current = db.prepare("SELECT avatar FROM users WHERE id = ? AND role = 'parent'").get(parentId);
      if (!current) { bad(res, 404, '家长账号不存在'); return; }
      if (displayName.length < 2) { bad(res, 400, '家长昵称需为 2 至 24 个字符'); return; }
      const avatarResult = await avatarValue(body.avatar, current.avatar, displayName);
      let result;
      try { result = db.prepare("UPDATE users SET display_name = ?, avatar = ? WHERE id = ? AND role = 'parent'").run(displayName, avatarResult.avatar, parentId); }
      catch (error) { if (avatarResult.uploadedUrl) await deleteStoredUrl(avatarResult.uploadedUrl, { dataDir }).catch(() => {}); throw error; }
      if (!result.changes) { bad(res, 404, '家长账号不存在'); return; }
      if (avatarResult.uploadedUrl && isStoredFileUrl(current.avatar)) deleteStoredUrl(current.avatar, { dataDir }).catch(error => console.error('清理旧头像失败：', error.message));
      json(res, 200, { parent: parentList().find(parent => parent.id === parentId) });
      return;
    }
    if (req.method === 'POST' && /^\/api\/admin\/parents\/\d+\/reset-password$/.test(url.pathname)) {
      const user = requireUser(req, res); if (!user || !requireAdmin(user, res)) return;
      const parentId = Number(url.pathname.split('/')[4]);
      const body = await readBody(req);
      const password = typeof body.password === 'string' ? body.password : '';
      if (password.length < 10 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) { bad(res, 400, '新密码至少 10 位，并包含字母和数字'); return; }
      const result = db.prepare("UPDATE users SET password_hash = ? WHERE id = ? AND role = 'parent'").run(hashPassword(password), parentId);
      if (!result.changes) { bad(res, 404, '家长账号不存在'); return; }
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(parentId);
      json(res, 200, { ok: true });
      return;
    }
    if (req.method === 'PATCH' && /^\/api\/admin\/parents\/\d+\/status$/.test(url.pathname)) {
      const user = requireUser(req, res); if (!user || !requireAdmin(user, res)) return;
      const parentId = Number(url.pathname.split('/')[4]);
      const body = await readBody(req);
      if (typeof body.active !== 'boolean') { bad(res, 400, '账号状态参数不正确'); return; }
      const result = db.prepare("UPDATE users SET active = ? WHERE id = ? AND role = 'parent'").run(body.active ? 1 : 0, parentId);
      if (!result.changes) { bad(res, 404, '家长账号不存在'); return; }
      if (!body.active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(parentId);
      json(res, 200, { parent: parentList().find(parent => parent.id === parentId) });
      return;
    }
    if (req.method === 'POST' && /^\/api\/admin\/students\/\d+\/parents$/.test(url.pathname)) {
      const user = requireUser(req, res); if (!user || !requireAdmin(user, res)) return;
      const studentId = Number(url.pathname.split('/')[4]);
      const body = await readBody(req);
      const parentId = Number(body.parentId);
      if (!db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'student'").get(studentId)) { bad(res, 404, '学生账号不存在'); return; }
      if (!db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'parent'").get(parentId)) { bad(res, 404, '家长账号不存在'); return; }
      db.prepare('INSERT INTO parent_students (parent_id, student_id, is_primary) VALUES (?, ?, 0) ON CONFLICT(parent_id, student_id) DO NOTHING').run(parentId, studentId);
      json(res, 200, { student: studentListFor(user).find(student => student.id === studentId) });
      return;
    }
    if (req.method === 'DELETE' && /^\/api\/parent\/students\/\d+\/parents\/\d+$/.test(url.pathname)) {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return;
      const parts = url.pathname.split('/');
      const studentId = Number(parts[4]); const parentId = Number(parts[6]);
      if (user.role !== 'admin' && user.id !== parentId) { bad(res, 403, '只能解除自己的学生关联'); return; }
      if (user.role !== 'admin' && !canManageStudent(user, studentId)) { bad(res, 403, '无权操作该学生'); return; }
      const result = db.prepare('DELETE FROM parent_students WHERE parent_id = ? AND student_id = ?').run(parentId, studentId);
      if (!result.changes) { bad(res, 404, '学生与家长未建立关联'); return; }
      json(res, 204, {});
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/parent/reviews') {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return;
      const students = studentListFor(user);
      const allowedIds = students.map(student => Number(student.id));
      if (!allowedIds.length) { json(res, 200, { reviews: [] }); return; }
      const requestedStudent = url.searchParams.get('studentId');
      const studentId = requestedStudent && requestedStudent !== 'all' ? Number(requestedStudent) : null;
      if (studentId && !allowedIds.includes(studentId)) { bad(res, 403, '无权查看该学生的审核任务'); return; }
      const conditions = ["tasks.status = 'pending_review'", 'tasks.is_demo = 0', `tasks.student_id IN (${allowedIds.map(() => '?').join(',')})`];
      const params = [...allowedIds];
      if (studentId) { conditions.push('tasks.student_id = ?'); params.push(studentId); }
      const category = clean(url.searchParams.get('category'), 24);
      if (category) { conditions.push('tasks.category = ?'); params.push(category); }
      const period = clean(url.searchParams.get('period'), 12) || 'all';
      if (period === 'today') { conditions.push('substr(tasks.submitted_at, 1, 10) = ?'); params.push(businessDate()); }
      if (period === 'week') { const week = weekRange(); conditions.push('substr(tasks.submitted_at, 1, 10) BETWEEN ? AND ?'); params.push(week.start, week.end); }
      if (period === 'month') { const month = monthRange(); conditions.push('substr(tasks.submitted_at, 1, 10) BETWEEN ? AND ?'); params.push(month.start, month.end); }
      const keyword = clean(url.searchParams.get('keyword'), 40);
      if (keyword) { conditions.push('(tasks.title LIKE ? OR tasks.detail LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`); }
      const rows = db.prepare(`SELECT tasks.*, users.display_name AS student_name, users.avatar AS student_avatar, ${taskResourceSummarySql} FROM tasks JOIN users ON users.id = tasks.student_id WHERE ${conditions.join(' AND ')} ORDER BY users.display_name, tasks.submitted_at DESC`).all(...params);
      json(res, 200, { reviews: rows.map(task => taskJson(task)) });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/parent/statistics') {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return;
      const period = clean(url.searchParams.get('period'), 16) || 'week';
      const range = statsRange(period, clean(url.searchParams.get('startDate'), 10), clean(url.searchParams.get('endDate'), 10));
      if (!range) { bad(res, 400, '请选择有效的统计日期范围'); return; }
      const students = studentListFor(user);
      const taskStats = db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed, SUM(CASE WHEN status = 'completed' AND submitted_at IS NOT NULL AND substr(submitted_at, 1, 10) <= task_date THEN 1 ELSE 0 END) AS on_time FROM tasks WHERE student_id = ? AND task_date BETWEEN ? AND ? AND is_demo = 0`);
      const rewardStats = db.prepare('SELECT COALESCE(SUM(stars), 0) AS stars FROM rewards WHERE student_id = ? AND substr(created_at, 1, 10) BETWEEN ? AND ? AND (task_id IS NULL OR task_id IN (SELECT id FROM tasks WHERE is_demo = 0))');
      const rows = students.map(student => {
        const tasks = taskStats.get(student.id, range.start, range.end);
        const stars = Number(rewardStats.get(student.id, range.start, range.end).stars || 0);
        const total = Number(tasks.total || 0); const completed = Number(tasks.completed || 0); const onTime = Number(tasks.on_time || 0);
        return { studentId: student.id, studentName: student.display_name, studentAvatar: signStoredUrl(student.avatar), active: Boolean(student.active), stars, total, completed, onTime, completionRate: total ? Math.round(completed / total * 100) : null, onTimeRate: total ? Math.round(onTime / total * 100) : null };
      }).sort((a, b) => b.stars - a.stars || (b.completionRate ?? -1) - (a.completionRate ?? -1) || a.studentName.localeCompare(b.studentName, 'zh-CN'));
      const summary = rows.reduce((total, row) => ({ stars: total.stars + row.stars, tasks: total.tasks + row.total, completed: total.completed + row.completed, onTime: total.onTime + row.onTime }), { stars: 0, tasks: 0, completed: 0, onTime: 0 });
      summary.completionRate = summary.tasks ? Math.round(summary.completed / summary.tasks * 100) : null;
      summary.onTimeRate = summary.tasks ? Math.round(summary.onTime / summary.tasks * 100) : null;
      json(res, 200, { period: { key: period, label: range.label, start: range.start, end: range.end }, summary, students: rows });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/parent/students') {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return;
      const body = await readBody(req, 400 * 1024);
      const displayName = clean(body.displayName, 12);
      const username = clean(body.username, 48);
      const password = typeof body.password === 'string' ? body.password : '';
      const grade = clean(body.grade, 12) || '三年级';
      const note = clean(body.note, 160);
      if (displayName.length < 2 || username.length < 3 || password.length < 10) { bad(res, 400, '请填写 2 至 12 位昵称、至少 3 位用户名和至少 10 位初始密码'); return; }
      if (!/^[A-Za-z0-9_.-]+$/.test(username)) { bad(res, 400, '用户名只能包含字母、数字、点、下划线和短横线'); return; }
      if (!['一年级', '二年级', '三年级', '四年级', '五年级', '六年级'].includes(grade)) { bad(res, 400, '请选择有效年级'); return; }
      if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) { bad(res, 409, '该用户名已被使用'); return; }
      const requestedParentIds = user.role === 'admin'
        ? [...new Set((Array.isArray(body.parentIds) ? body.parentIds : body.parentId ? [body.parentId] : []).map(Number).filter(Number.isInteger))]
        : [user.id];
      if (requestedParentIds.some(parentId => !db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'parent'").get(parentId))) { bad(res, 400, '请选择有效的家长账号'); return; }
      const avatarResult = await avatarValue(body.avatar, '', displayName, '学');
      let studentId;
      db.exec('BEGIN');
      try {
        const result = db.prepare('INSERT INTO users (username, password_hash, role, display_name, avatar, created_at) VALUES (?, ?, \'student\', ?, ?, ?)').run(username, hashPassword(password), displayName, avatarResult.avatar, now());
        studentId = Number(result.lastInsertRowid);
        db.prepare('INSERT INTO student_profiles (student_id, grade, note) VALUES (?, ?, ?)').run(studentId, grade, note);
        const link = db.prepare('INSERT INTO parent_students (parent_id, student_id, is_primary) VALUES (?, ?, ?)');
        requestedParentIds.forEach((parentId, index) => link.run(parentId, studentId, index === 0 ? 1 : 0));
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); if (avatarResult.uploadedUrl) await deleteStoredUrl(avatarResult.uploadedUrl, { dataDir }).catch(() => {}); throw error; }
      json(res, 201, { student: studentListFor(user).find(student => student.id === studentId) });
      return;
    }
    if (req.method === 'PATCH' && /^\/api\/parent\/students\/\d+$/.test(url.pathname)) {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return;
      const studentId = Number(url.pathname.split('/')[4]);
      if (!canManageStudent(user, studentId)) { bad(res, 403, '无权编辑该学生'); return; }
      const body = await readBody(req, 400 * 1024);
      const displayName = clean(body.displayName, 12);
      const current = db.prepare("SELECT avatar FROM users WHERE id = ? AND role = 'student'").get(studentId);
      if (!current) { bad(res, 404, '学生账号不存在'); return; }
      const grade = clean(body.grade, 12) || '三年级';
      const note = clean(body.note, 160);
      if (displayName.length < 2) { bad(res, 400, '学生昵称需为 2 至 12 个字符'); return; }
      if (!['一年级', '二年级', '三年级', '四年级', '五年级', '六年级'].includes(grade)) { bad(res, 400, '请选择有效年级'); return; }
      const avatarResult = await avatarValue(body.avatar, current.avatar, displayName, '学');
      db.exec('BEGIN');
      try {
        db.prepare('UPDATE users SET display_name = ?, avatar = ? WHERE id = ? AND role = \'student\'').run(displayName, avatarResult.avatar, studentId);
        db.prepare('INSERT INTO student_profiles (student_id, grade, note) VALUES (?, ?, ?) ON CONFLICT(student_id) DO UPDATE SET grade = excluded.grade, note = excluded.note').run(studentId, grade, note);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); if (avatarResult.uploadedUrl) await deleteStoredUrl(avatarResult.uploadedUrl, { dataDir }).catch(() => {}); throw error; }
      if (avatarResult.uploadedUrl && isStoredFileUrl(current.avatar)) deleteStoredUrl(current.avatar, { dataDir }).catch(error => console.error('清理旧头像失败：', error.message));
      json(res, 200, { student: studentListFor(user).find(student => student.id === studentId) });
      return;
    }
    if (req.method === 'POST' && /^\/api\/parent\/students\/\d+\/reset-password$/.test(url.pathname)) {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return;
      const studentId = Number(url.pathname.split('/')[4]);
      if (!canManageStudent(user, studentId)) { bad(res, 403, '无权重置该学生密码'); return; }
      const body = await readBody(req);
      const password = typeof body.password === 'string' ? body.password : '';
      if (password.length < 10) { bad(res, 400, '新密码至少需要 10 位'); return; }
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ? AND role = \'student\'').run(hashPassword(password), studentId);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(studentId);
      json(res, 200, { ok: true });
      return;
    }
    if (req.method === 'PATCH' && /^\/api\/parent\/students\/\d+\/status$/.test(url.pathname)) {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return;
      const studentId = Number(url.pathname.split('/')[4]);
      if (!canManageStudent(user, studentId)) { bad(res, 403, '无权修改该学生状态'); return; }
      const body = await readBody(req);
      if (typeof body.active !== 'boolean') { bad(res, 400, '账号状态参数不正确'); return; }
      const result = db.prepare("UPDATE users SET active = ? WHERE id = ? AND role = 'student'").run(body.active ? 1 : 0, studentId);
      if (!result.changes) { bad(res, 404, '学生账号不存在'); return; }
      if (!body.active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(studentId);
      json(res, 200, { student: studentListFor(user).find(student => student.id === studentId) });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/parent/categories') {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return;
      const categories = db.prepare('SELECT id, name, icon, color FROM task_categories WHERE active = 1 ORDER BY id').all();
      json(res, 200, { categories });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/parent/task-templates') {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return;
      const templates = db.prepare(`${templateSelectSql}
        WHERE task_templates.creator_id = ? OR task_templates.is_public = 1
        ORDER BY task_categories.name, task_templates.updated_at DESC, task_templates.id DESC`).all(user.id);
      json(res, 200, { templates: templates.map(template => taskTemplateJson({ ...template, is_owner: template.creator_id === user.id })) });
      return;
    }
    if (req.method === 'GET' && /^\/api\/parent\/task-templates\/\d+$/.test(url.pathname)) {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return;
      const templateId = Number(url.pathname.split('/')[4]);
      const template = db.prepare(`${templateSelectSql} WHERE task_templates.id = ? AND (task_templates.creator_id = ? OR task_templates.is_public = 1)`).get(templateId, user.id);
      if (!template) { bad(res, 404, '任务模板不存在或当前账号无权查看'); return; }
      const includeData = url.searchParams.get('includeData') !== '0';
      json(res, 200, { template: taskTemplateJson({ ...template, is_owner: template.creator_id === user.id }, includeData) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/parent/task-templates') {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return;
      const body = await readBody(req, 45 * 1024 * 1024);
      const title = clean(body.title, 80);
      const detail = clean(body.detail, 300);
      const categoryId = Number(body.categoryId);
      const category = db.prepare('SELECT id FROM task_categories WHERE id = ? AND active = 1').get(categoryId);
      const duration = Number(body.duration);
      const stars = Number(body.stars);
      const feedbackType = clean(body.feedbackType, 30) || 'photo_or_video';
      const resources = normalizeTaskResources(body);
      const copyFromTemplateId = Number(body.copyFromTemplateId);
      const copySource = Number.isInteger(copyFromTemplateId) && copyFromTemplateId > 0
        ? db.prepare('SELECT * FROM task_templates WHERE id = ? AND creator_id = ?').get(copyFromTemplateId, user.id)
        : null;
      if (title.length < 2) { bad(res, 400, '任务模板标题需为 2 至 80 个字符'); return; }
      if (!category) { bad(res, 400, '请选择有效的任务分类'); return; }
      if (!['photo_or_video', 'photo', 'video', 'none'].includes(feedbackType)) { bad(res, 400, '请选择有效的反馈要求'); return; }
      if (!resources) { bad(res, 400, taskResourceValidationMessage(body)); return; }
      if (!Number.isInteger(duration) || duration < 1 || duration > 240) { bad(res, 400, '预计时长需为 1 至 240 分钟'); return; }
      if (!Number.isSafeInteger(stars) || stars < 1) { bad(res, 400, '奖励星星需为正整数'); return; }
      if (body.copyFromTemplateId && !copySource) { bad(res, 403, '只能复制自己创建的任务模板'); return; }
      const copiedResourceIds = copySource ? linkedResources('template', copySource.id, copySource.resource_id).map(resource => resource.id) : [];
      const storedResources = copiedResourceIds.length ? [] : await storeResources(resources, 'task-templates');
      db.exec('BEGIN');
      try {
        const resourceIds = copiedResourceIds.length ? copiedResourceIds : insertResources(storedResources, user.id);
        const resourceId = resourceIds[0] || null;
        const createdAt = now();
        const result = db.prepare(`INSERT INTO task_templates (creator_id,title,category_id,detail,duration_minutes,stars,feedback_type,needs_review,resource_id,is_public,created_at,updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(user.id, title, categoryId, detail || '请按照任务要求认真完成。', duration, stars, feedbackType, body.needsReview === false ? 0 : 1, resourceId, body.isPublic === true ? 1 : 0, createdAt, createdAt);
        linkResources('template', Number(result.lastInsertRowid), resourceIds);
        db.exec('COMMIT');
        const template = db.prepare(`${templateSelectSql} WHERE task_templates.id = ?`).get(Number(result.lastInsertRowid));
        json(res, 201, { template: taskTemplateJson({ ...template, is_owner: true }) });
      } catch (error) { db.exec('ROLLBACK'); await Promise.allSettled(storedResources.map(resource => deleteStoredUrl(resource.url, { dataDir }))); throw error; }
      return;
    }
    if (req.method === 'PATCH' && /^\/api\/parent\/task-templates\/\d+$/.test(url.pathname)) {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return;
      const templateId = Number(url.pathname.split('/')[4]);
      const current = db.prepare('SELECT * FROM task_templates WHERE id = ?').get(templateId);
      if (!current) { bad(res, 404, '任务模板不存在'); return; }
      if (current.creator_id !== user.id) { bad(res, 403, '只能修改自己创建的任务模板'); return; }
      const body = await readBody(req, 45 * 1024 * 1024);
      const title = clean(body.title, 80);
      const detail = clean(body.detail, 300);
      const categoryId = Number(body.categoryId);
      const category = db.prepare('SELECT id FROM task_categories WHERE id = ? AND active = 1').get(categoryId);
      const duration = Number(body.duration);
      const stars = Number(body.stars);
      const feedbackType = clean(body.feedbackType, 30) || 'photo_or_video';
      const resources = normalizeTaskResources(body);
      const existingResourceIds = normalizeExistingResourceIds(body);
      const replaceResources = Array.isArray(body.resources) || Array.isArray(body.existingResourceIds) || Boolean(body.resourceData) || body.removeResource === true;
      if (title.length < 2) { bad(res, 400, '任务模板标题需为 2 至 80 个字符'); return; }
      if (!category) { bad(res, 400, '请选择有效的任务分类'); return; }
      if (!['photo_or_video', 'photo', 'video', 'none'].includes(feedbackType)) { bad(res, 400, '请选择有效的反馈要求'); return; }
      if (!resources) { bad(res, 400, taskResourceValidationMessage(body)); return; }
      if (!existingResourceIds || existingResourceIds.length + resources.length > 5) { bad(res, 400, '任务资料选择无效或超过 5 个文件'); return; }
      const allowedResourceIds = new Set(linkedResources('template', templateId, current.resource_id).map(resource => resource.id));
      if (existingResourceIds.some(id => !allowedResourceIds.has(id))) { bad(res, 403, '无权引用该任务资料'); return; }
      if (!Number.isInteger(duration) || duration < 1 || duration > 240) { bad(res, 400, '预计时长需为 1 至 240 分钟'); return; }
      if (!Number.isSafeInteger(stars) || stars < 1) { bad(res, 400, '奖励星星需为正整数'); return; }
      const storedResources = replaceResources ? await storeResources(resources, 'task-templates') : [];
      let resourceId = current.resource_id;
      db.exec('BEGIN');
      try {
        const previousIds = db.prepare('SELECT resource_id FROM template_resource_links WHERE template_id = ?').all(templateId).map(row => row.resource_id);
        if (replaceResources) {
          db.prepare('DELETE FROM template_resource_links WHERE template_id = ?').run(templateId);
          const resourceIds = [...existingResourceIds, ...insertResources(storedResources, user.id)];
          resourceId = resourceIds[0] || null;
          linkResources('template', templateId, resourceIds);
        }
        db.prepare(`UPDATE task_templates SET title = ?, category_id = ?, detail = ?, duration_minutes = ?, stars = ?, feedback_type = ?, needs_review = ?, resource_id = ?, is_public = ?, updated_at = ? WHERE id = ?`)
          .run(title, categoryId, detail || '请按照任务要求认真完成。', duration, stars, feedbackType, body.needsReview === false ? 0 : 1, resourceId, body.isPublic === true ? 1 : 0, now(), templateId);
        if (replaceResources) [...new Set([...previousIds, current.resource_id].filter(Boolean))].forEach(deleteUnusedResource);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); await Promise.allSettled(storedResources.map(resource => deleteStoredUrl(resource.url, { dataDir }))); throw error; }
      const template = db.prepare(`${templateSelectSql} WHERE task_templates.id = ?`).get(templateId);
      json(res, 200, { template: taskTemplateJson({ ...template, is_owner: true }) });
      return;
    }
    if (req.method === 'DELETE' && /^\/api\/parent\/task-templates\/\d+$/.test(url.pathname)) {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return;
      const templateId = Number(url.pathname.split('/')[4]);
      const template = db.prepare('SELECT creator_id, resource_id FROM task_templates WHERE id = ?').get(templateId);
      if (!template) { bad(res, 404, '任务模板不存在'); return; }
      if (template.creator_id !== user.id) { bad(res, 403, '只能删除自己创建的任务模板'); return; }
      const resourceIds = db.prepare('SELECT resource_id FROM template_resource_links WHERE template_id = ?').all(templateId).map(row => row.resource_id);
      db.prepare('DELETE FROM task_templates WHERE id = ?').run(templateId);
      [...new Set([...resourceIds, template.resource_id].filter(Boolean))].forEach(deleteUnusedResource);
      json(res, 204, {});
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/parent/task-templates/assign') {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return;
      const body = await readBody(req);
      const templateIds = [...new Set((Array.isArray(body.templateIds) ? body.templateIds : []).map(Number).filter(Number.isInteger))];
      const studentIds = [...new Set((Array.isArray(body.studentIds) ? body.studentIds : []).map(Number).filter(Number.isInteger))];
      const allowedIds = (user.role === 'admin' ? db.prepare("SELECT id FROM users WHERE role = 'student' AND active = 1").all() : studentsForParent(user.id)).map(student => Number(student.id));
      const schedule = taskSchedule(body);
      if (!templateIds.length || templateIds.length > 30) { bad(res, 400, '请选择 1 至 30 个任务模板'); return; }
      if (!studentIds.length || studentIds.some(id => !allowedIds.includes(id))) { bad(res, 403, '请选择有权限的正常学生账号'); return; }
      if (!schedule) { bad(res, 400, '请设置有效的分配日期；持续日期和重复日期都必须填写有效的结束日期'); return; }
      if (templateIds.length * studentIds.length * schedule.dates.length > 1000) { bad(res, 400, '本次生成任务过多，请减少模板、学生或日期数量'); return; }
      const placeholders = templateIds.map(() => '?').join(',');
      const templates = db.prepare(`${templateSelectSql} WHERE task_templates.id IN (${placeholders}) AND (task_templates.creator_id = ? OR task_templates.is_public = 1)`).all(...templateIds, user.id);
      if (templates.length !== templateIds.length) { bad(res, 403, '所选模板不存在或当前账号无权使用'); return; }
      const insert = db.prepare(`INSERT INTO tasks (student_id,title,category,icon,category_color,detail,task_date,duration_minutes,stars,feedback_type,needs_review,resource_id,status,created_at,series_id,repeat_pattern,repeat_weekdays,series_start_date,series_end_date,schedule_type,available_start_date,available_end_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'not_started', ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const taskIds = [];
      db.exec('BEGIN');
      try {
        for (const template of templates) for (const studentId of studentIds) {
          const seriesId = schedule.scheduleType === 'repeat' ? randomBytes(12).toString('hex') : '';
          for (const date of schedule.dates) {
            const taskId = Number(insert.run(studentId, template.title, template.category_name, template.category_icon, template.category_color, template.detail, date, template.duration_minutes, template.stars, template.feedback_type, template.needs_review, template.resource_id, now(), seriesId, schedule.repeatPattern, schedule.weekdays.join(','), schedule.startDate, schedule.endDate, schedule.scheduleType, schedule.scheduleType === 'range' ? schedule.startDate : date, schedule.scheduleType === 'range' ? schedule.endDate : date).lastInsertRowid);
            const resourceIds = linkedResources('template', template.id, template.resource_id).map(resource => resource.id);
            linkResources('task', taskId, resourceIds);
            taskIds.push(taskId);
          }
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      json(res, 201, { count: taskIds.length, taskIds });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/parent/categories') {
      const user = requireUser(req, res); if (!user || !requireAdmin(user, res)) return;
      const body = await readBody(req);
      const name = clean(body.name, 24);
      const icon = categoryIcon(body.icon);
      if (name.length < 2) { bad(res, 400, '分类名称需为 2 至 24 个字符'); return; }
      if (!icon) { bad(res, 400, '请选择有效的分类图标'); return; }
      const existing = db.prepare('SELECT id, active FROM task_categories WHERE name = ?').get(name);
      if (existing?.active) { bad(res, 409, '该任务分类已经存在'); return; }
      if (existing) db.prepare('UPDATE task_categories SET active = 1, icon = ? WHERE id = ?').run(icon, existing.id);
      else db.prepare("INSERT INTO task_categories (name, icon, color, created_at) VALUES (?, ?, '#2F80ED', ?)").run(name, icon, now());
      json(res, 201, { category: db.prepare('SELECT id, name, icon, color FROM task_categories WHERE name = ?').get(name) });
      return;
    }
    if (req.method === 'PATCH' && /^\/api\/parent\/categories\/\d+$/.test(url.pathname)) {
      const user = requireUser(req, res); if (!user || !requireAdmin(user, res)) return;
      const categoryId = Number(url.pathname.split('/')[4]);
      const body = await readBody(req);
      const name = clean(body.name, 24);
      const icon = categoryIcon(body.icon);
      if (name.length < 2) { bad(res, 400, '分类名称需为 2 至 24 个字符'); return; }
      if (!icon) { bad(res, 400, '请选择有效的分类图标'); return; }
      if (db.prepare('SELECT 1 FROM task_categories WHERE name = ? AND id <> ?').get(name, categoryId)) { bad(res, 409, '该任务分类已经存在'); return; }
      const current = db.prepare('SELECT name FROM task_categories WHERE id = ? AND active = 1').get(categoryId);
      if (!current) { bad(res, 404, '任务分类不存在'); return; }
      db.exec('BEGIN');
      try { db.prepare('UPDATE task_categories SET name = ?, icon = ? WHERE id = ?').run(name, icon, categoryId); db.prepare('UPDATE tasks SET category = ?, icon = ? WHERE category = ?').run(name, icon, current.name); db.exec('COMMIT'); }
      catch (error) { db.exec('ROLLBACK'); throw error; }
      json(res, 200, { category: db.prepare('SELECT id, name, icon, color FROM task_categories WHERE id = ?').get(categoryId) });
      return;
    }
    if (req.method === 'DELETE' && /^\/api\/parent\/categories\/\d+$/.test(url.pathname)) {
      const user = requireUser(req, res); if (!user || !requireAdmin(user, res)) return;
      const categoryId = Number(url.pathname.split('/')[4]);
      const result = db.prepare('UPDATE task_categories SET active = 0 WHERE id = ? AND active = 1').run(categoryId);
      if (!result.changes) { bad(res, 404, '任务分类不存在'); return; }
      json(res, 204, {});
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/parent/tasks') {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return;
      const availableStudents = user.role === 'admin' ? db.prepare("SELECT id FROM users WHERE role = 'student' AND active = 1").all() : studentsForParent(user.id);
      const allowedIds = availableStudents.map(student => Number(student.id));
      const date = clean(url.searchParams.get('date'), 10) || businessDate();
      const requestedStudent = url.searchParams.get('studentId');
      const studentId = requestedStudent && requestedStudent !== 'all' ? Number(requestedStudent) : null;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { bad(res, 400, '日期格式不正确'); return; }
      if (studentId && !allowedIds.includes(studentId)) { bad(res, 403, '无权查看该学生任务'); return; }
      if (!allowedIds.length) { json(res, 200, { tasks: [] }); return; }
      const week = weekRange(date);
      const baseSql = `SELECT tasks.*, users.display_name AS student_name, users.avatar AS student_avatar, ${taskResourceSummarySql} FROM tasks JOIN users ON users.id = tasks.student_id WHERE ((tasks.schedule_type = 'range' AND tasks.available_start_date <= ? AND tasks.available_end_date >= ?) OR (tasks.schedule_type <> 'range' AND tasks.task_date BETWEEN ? AND ?)) AND tasks.is_demo = 0`;
      const weekRows = studentId
        ? db.prepare(`${baseSql} AND tasks.student_id = ? ORDER BY tasks.task_date, tasks.id DESC`).all(week.end, week.start, week.start, week.end, studentId)
        : db.prepare(`${baseSql} AND tasks.student_id IN (${allowedIds.map(() => '?').join(',')}) ORDER BY tasks.task_date, users.display_name, tasks.id DESC`).all(week.end, week.start, week.start, week.end, ...allowedIds);
      const serialized = weekRows.map(taskJson);
      const weekTasks = Object.fromEntries(dateRange(week.start, week.end).map(day => [day, serialized.filter(task => taskVisibleOn(task, day))]));
      const taskDates = Object.entries(weekTasks).filter(([, dayTasks]) => dayTasks.length).map(([day]) => day);
      json(res, 200, { tasks: weekTasks[date] || [], taskDates, weekTasks });
      return;
    }
    if (req.method === 'GET' && /^\/api\/parent\/tasks\/\d+$/.test(url.pathname)) {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return;
      const taskId = Number(url.pathname.split('/')[4]);
      const task = db.prepare('SELECT tasks.*, users.display_name AS student_name, users.avatar AS student_avatar FROM tasks JOIN users ON users.id = tasks.student_id WHERE tasks.id = ? AND tasks.is_demo = 0').get(taskId);
      if (!task) { bad(res, 404, '任务不存在'); return; }
      if (!canManageStudent(user, task.student_id)) { bad(res, 403, '无权查看此任务'); return; }
      const includeData = url.searchParams.get('includeData') !== '0';
      json(res, 200, { task: taskJson(task, includeData, includeData) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/parent/tasks') {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return;
      const body = await readBody(req, 45 * 1024 * 1024);
      const studentIds = [...new Set((Array.isArray(body.studentIds) ? body.studentIds : [body.studentId]).map(Number).filter(Number.isInteger))];
      const allowedIds = (user.role === 'admin' ? db.prepare("SELECT id FROM users WHERE role = 'student' AND active = 1").all() : studentsForParent(user.id)).map(student => Number(student.id));
      if (!studentIds.length || studentIds.some(id => !allowedIds.includes(id))) { bad(res, 403, '请选择有权限的正常学生账号'); return; }
      const schedule = taskSchedule(body);
      const title = clean(body.title, 80);
      const detail = clean(body.detail, 300);
      const category = db.prepare('SELECT name, icon, color FROM task_categories WHERE id = ? AND active = 1').get(Number(body.categoryId));
      const duration = Number(body.duration);
      const stars = Number(body.stars);
      const resources = normalizeTaskResources(body);
      if (title.length < 2 || !schedule) { bad(res, 400, '请填写任务标题和有效日期；持续日期和重复日期都必须填写有效的结束日期'); return; }
      if (!category) { bad(res, 400, '请选择有效的任务分类'); return; }
      if (!resources) { bad(res, 400, taskResourceValidationMessage(body)); return; }
      if (!Number.isInteger(duration) || duration < 1 || duration > 240) { bad(res, 400, '预计时长需为 1 至 240 分钟'); return; }
      if (!Number.isSafeInteger(stars) || stars < 1) { bad(res, 400, '奖励星星需为正整数'); return; }
      const storedResources = await storeResources(resources, 'task-resources');
      const insert = db.prepare(`INSERT INTO tasks (student_id,title,category,icon,category_color,detail,task_date,duration_minutes,stars,feedback_type,needs_review,resource_id,status,created_at,series_id,repeat_pattern,repeat_weekdays,series_start_date,series_end_date,schedule_type,available_start_date,available_end_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'not_started', ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const taskIds = [];
      db.exec('BEGIN');
      try {
        const resourceIds = insertResources(storedResources, user.id);
        const resourceId = resourceIds[0] || null;
        for (const studentId of studentIds) {
          const seriesId = schedule.scheduleType === 'repeat' ? randomBytes(12).toString('hex') : '';
          for (const date of schedule.dates) {
            const taskId = Number(insert.run(studentId, title, category.name, category.icon, category.color, detail || '请按照任务要求认真完成。', date, duration, stars, clean(body.feedbackType, 30) || 'photo_or_video', body.needsReview === false ? 0 : 1, resourceId, now(), seriesId, schedule.repeatPattern, schedule.weekdays.join(','), schedule.startDate, schedule.endDate, schedule.scheduleType, schedule.scheduleType === 'range' ? schedule.startDate : date, schedule.scheduleType === 'range' ? schedule.endDate : date).lastInsertRowid);
            linkResources('task', taskId, resourceIds);
            taskIds.push(taskId);
          }
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); await Promise.allSettled(storedResources.map(resource => deleteStoredUrl(resource.url, { dataDir }))); throw error; }
      json(res, 201, { count: taskIds.length, taskIds });
      return;
    }
    if (req.method === 'GET' && /^\/api\/parent\/tasks\/\d+\/review$/.test(url.pathname)) {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return;
      const taskId = Number(url.pathname.split('/')[4]);
      const task = db.prepare('SELECT tasks.*, users.display_name AS student_name, users.avatar AS student_avatar FROM tasks JOIN users ON users.id = tasks.student_id WHERE tasks.id = ? AND tasks.is_demo = 0').get(taskId);
      if (!task) { bad(res, 404, '任务不存在'); return; }
      if (!canManageStudent(user, task.student_id)) { bad(res, 403, '无权查看此任务'); return; }
      if (task.status !== 'pending_review') { bad(res, 409, '该任务当前不在待审核状态'); return; }
      json(res, 200, { task: taskJson(task, true, true) });
      return;
    }
    if (req.method === 'PATCH' && /^\/api\/parent\/tasks\/\d+$/.test(url.pathname)) {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return;
      const taskId = Number(url.pathname.split('/')[4]);
      const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND is_demo = 0').get(taskId);
      if (!task) { bad(res, 404, '任务不存在'); return; }
      if (!canManageStudent(user, task.student_id)) { bad(res, 403, '无权修改此任务'); return; }
      if (['pending_review', 'completed'].includes(task.status)) { bad(res, 409, '待审核或已完成的任务不能修改'); return; }
      const body = await readBody(req, 45 * 1024 * 1024);
      const studentId = Number(body.studentId);
      const allowedIds = (user.role === 'admin' ? db.prepare("SELECT id FROM users WHERE role = 'student' AND active = 1").all() : studentsForParent(user.id)).map(student => Number(student.id));
      const scopeSeries = Boolean(task.series_id && body.scope === 'series');
      const schedule = scopeSeries ? null : taskSchedule(body);
      const title = clean(body.title, 80);
      const detail = clean(body.detail, 300);
      const category = db.prepare('SELECT name, icon, color FROM task_categories WHERE id = ? AND active = 1').get(Number(body.categoryId));
      const duration = Number(body.duration);
      const stars = Number(body.stars);
      const feedbackType = clean(body.feedbackType, 30) || 'photo_or_video';
      const resources = normalizeTaskResources(body);
      const existingResourceIds = normalizeExistingResourceIds(body);
      const replaceResources = Array.isArray(body.resources) || Array.isArray(body.existingResourceIds) || Boolean(body.resourceData) || body.removeResource === true;
      if (!allowedIds.includes(studentId)) { bad(res, 403, '请选择有权限的正常学生账号'); return; }
      if (scopeSeries && studentId !== task.student_id) { bad(res, 400, '重复任务系列不能更换学生'); return; }
      if (title.length < 2 || (!scopeSeries && !schedule)) { bad(res, 400, '请填写任务标题和有效日期范围'); return; }
      if (!category) { bad(res, 400, '请选择有效的任务分类'); return; }
      if (!['photo_or_video', 'photo', 'video', 'none'].includes(feedbackType)) { bad(res, 400, '请选择有效的反馈要求'); return; }
      if (!resources) { bad(res, 400, taskResourceValidationMessage(body)); return; }
      if (!existingResourceIds || existingResourceIds.length + resources.length > 5) { bad(res, 400, '任务资料选择无效或超过 5 个文件'); return; }
      const allowedResourceIds = new Set(linkedResources('task', task.id, task.resource_id).map(resource => resource.id));
      if (existingResourceIds.some(id => !allowedResourceIds.has(id))) { bad(res, 403, '无权引用该任务资料'); return; }
      if (!Number.isInteger(duration) || duration < 1 || duration > 240) { bad(res, 400, '预计时长需为 1 至 240 分钟'); return; }
      if (!Number.isSafeInteger(stars) || stars < 1) { bad(res, 400, '奖励星星需为正整数'); return; }
      const storedResources = replaceResources ? await storeResources(resources, 'task-resources') : [];
      const targets = scopeSeries
        ? db.prepare("SELECT * FROM tasks WHERE series_id = ? AND student_id = ? AND is_demo = 0 AND status NOT IN ('pending_review','completed') ORDER BY task_date").all(task.series_id, task.student_id)
        : [task];
      if (!targets.length) { bad(res, 409, '该系列没有可以修改的任务'); return; }
      const targetIds = targets.map(item => item.id);
      const placeholders = targetIds.map(() => '?').join(',');
      const seriesTotal = scopeSeries ? db.prepare('SELECT COUNT(*) AS count FROM tasks WHERE series_id = ? AND student_id = ? AND is_demo = 0').get(task.series_id, task.student_id).count : 1;
      db.exec('BEGIN');
      try {
        const previousIds = db.prepare(`SELECT resource_id FROM task_resource_links WHERE task_id IN (${placeholders})`).all(...targetIds).map(row => row.resource_id);
        const legacyIds = targets.map(item => item.resource_id).filter(Boolean);
        if (replaceResources) {
          db.prepare(`DELETE FROM task_resource_links WHERE task_id IN (${placeholders})`).run(...targetIds);
          const resourceIds = [...existingResourceIds, ...insertResources(storedResources, user.id)];
          const resourceId = resourceIds[0] || null;
          targetIds.forEach(id => linkResources('task', id, resourceIds));
          db.prepare(`UPDATE tasks SET resource_id = ? WHERE id IN (${placeholders})`).run(resourceId, ...targetIds);
        }
        if (scopeSeries) db.prepare(`UPDATE tasks SET title = ?, category = ?, icon = ?, category_color = ?, detail = ?, duration_minutes = ?, stars = ?, feedback_type = ?, needs_review = ? WHERE id IN (${placeholders})`).run(title, category.name, category.icon, category.color, detail || '请按照任务要求认真完成。', duration, stars, feedbackType, body.needsReview === false ? 0 : 1, ...targetIds);
        else db.prepare('UPDATE tasks SET student_id = ?, title = ?, category = ?, icon = ?, category_color = ?, detail = ?, task_date = ?, duration_minutes = ?, stars = ?, feedback_type = ?, needs_review = ?, schedule_type = ?, available_start_date = ?, available_end_date = ? WHERE id = ?').run(studentId, title, category.name, category.icon, category.color, detail || '请按照任务要求认真完成。', schedule.taskDate, duration, stars, feedbackType, body.needsReview === false ? 0 : 1, schedule.scheduleType, schedule.startDate, schedule.endDate, taskId);
        if (replaceResources) [...new Set([...previousIds, ...legacyIds])].forEach(deleteUnusedResource);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); await Promise.allSettled(storedResources.map(resource => deleteStoredUrl(resource.url, { dataDir }))); throw error; }
      const updated = db.prepare('SELECT tasks.*, users.display_name AS student_name, users.avatar AS student_avatar FROM tasks JOIN users ON users.id = tasks.student_id WHERE tasks.id = ?').get(taskId);
      json(res, 200, { task: taskJson(updated), updatedCount: targetIds.length, skippedCount: seriesTotal - targetIds.length });
      return;
    }
    if (req.method === 'DELETE' && /^\/api\/parent\/tasks\/\d+$/.test(url.pathname)) {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return;
      const taskId = Number(url.pathname.split('/')[4]);
      const task = db.prepare('SELECT id, student_id, status, resource_id, series_id FROM tasks WHERE id = ? AND is_demo = 0').get(taskId);
      if (!task) { bad(res, 404, '任务不存在'); return; }
      if (!canManageStudent(user, task.student_id)) { bad(res, 403, '无权删除此任务'); return; }
      if (['pending_review', 'completed'].includes(task.status)) { bad(res, 409, '待审核或已完成的任务不能删除'); return; }
      const scopeSeries = task.series_id && url.searchParams.get('scope') === 'series';
      const targets = scopeSeries
        ? db.prepare("SELECT id, resource_id FROM tasks WHERE series_id = ? AND student_id = ? AND is_demo = 0 AND status NOT IN ('pending_review','completed')").all(task.series_id, task.student_id)
        : [task];
      const targetIds = targets.map(item => item.id);
      if (!targetIds.length) { bad(res, 409, '该系列没有可以删除的任务'); return; }
      const placeholders = targetIds.map(() => '?').join(',');
      const total = scopeSeries ? db.prepare('SELECT COUNT(*) AS count FROM tasks WHERE series_id = ? AND student_id = ? AND is_demo = 0').get(task.series_id, task.student_id).count : 1;
      const resourceIds = db.prepare(`SELECT resource_id FROM task_resource_links WHERE task_id IN (${placeholders})`).all(...targetIds).map(row => row.resource_id);
      db.prepare(`DELETE FROM tasks WHERE id IN (${placeholders})`).run(...targetIds);
      [...new Set([...resourceIds, ...targets.map(item => item.resource_id)].filter(Boolean))].forEach(deleteUnusedResource);
      json(res, 200, { deletedCount: targetIds.length, skippedCount: total - targetIds.length });
      return;
    }
    if (req.method === 'POST' && /^\/api\/parent\/tasks\/\d+\/review$/.test(url.pathname)) {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return;
      const taskId = Number(url.pathname.split('/')[4]);
      const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND is_demo = 0').get(taskId);
      if (!task || task.status !== 'pending_review') { bad(res, 409, '该任务当前不能审核'); return; }
      if (user.role !== 'admin' && !studentsForParent(user.id).some(student => student.id === task.student_id)) { bad(res, 403, '无权审核此任务'); return; }
      const body = await readBody(req);
      const action = clean(body.action, 20);
      const message = clean(body.message, 180);
      if (action === 'approve') {
        const stars = Number(body.stars ?? task.stars);
        if (!Number.isSafeInteger(stars) || stars < 1) { bad(res, 400, '奖励星星需为正整数'); return; }
        db.prepare("UPDATE tasks SET status = 'completed', reviewed_at = ?, reviewed_by = ?, encouragement = ? WHERE id = ?").run(now(), user.id, message || '完成得很棒！', task.id);
        db.prepare('INSERT INTO rewards (student_id, task_id, stars, message, created_at) VALUES (?, ?, ?, ?, ?)').run(task.student_id, task.id, stars, message || '完成得很棒！', now());
      } else if (action === 'needs_more') db.prepare("UPDATE tasks SET status = 'needs_more', encouragement = ? WHERE id = ?").run(message || '请再补充一点学习反馈。', task.id);
      else { bad(res, 400, '审核操作不正确'); return; }
      json(res, 200, { ok: true });
      return;
    }
    bad(res, 404, '接口不存在');
  } catch (error) {
    console.error(error);
    bad(res, 500, isProduction ? '服务暂时不可用，请稍后再试' : error.message);
  }
});

server.listen(port, host, () => console.log(`学习星球服务已启动：http://${host}:${port}`));
