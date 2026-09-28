import { createServer } from 'node:http';
import { mkdirSync, existsSync, readFileSync, createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';
import { connect as tlsConnect } from 'node:tls';
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
const RECOVERY_CODE_TTL_MS = 1000 * 60 * 5;
const RECOVERY_CODE_LIMIT_WINDOW_MS = 1000 * 60 * 60;
const RECOVERY_CODE_LIMIT = 5;
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
function recoveryCodeLimitReached(email) {
  const since = new Date(unix() - RECOVERY_CODE_LIMIT_WINDOW_MS).toISOString();
  const row = db.prepare('SELECT COUNT(*) AS count FROM recovery_codes WHERE target_hash = ? AND created_at > ?').get(hashToken(email), since);
  return Number(row?.count || 0) >= RECOVERY_CODE_LIMIT;
}
const recoveryKey = createHash('sha256').update(process.env.RECOVERY_EMAIL_KEY || 'learning-planet-recovery-email-change-in-production').digest();
function encryptRecoveryEmail(email) { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', recoveryKey, iv); const data = Buffer.concat([cipher.update(email, 'utf8'), cipher.final()]); return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${data.toString('base64url')}`; }
function decryptRecoveryEmail(value) { try { const [iv, tag, data] = String(value).split('.').map(part => Buffer.from(part, 'base64url')); const decipher = createDecipheriv('aes-256-gcm', recoveryKey, iv); decipher.setAuthTag(tag); return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8'); } catch { return ''; } }
function hashToken(value) { return createHash('sha256').update(value).digest('hex'); }
function maskedEmail(email) { const [name, domain] = String(email).split('@'); return name ? `${name.slice(0, 2)}***@${domain || ''}` : ''; }
function smtpResponse(socket, timeout = 10000) { return new Promise((resolve, reject) => { let buffer = ''; const timer = setTimeout(() => { cleanup(); reject(new Error('SMTP 响应超时')); }, timeout); const onData = chunk => { buffer += chunk.toString(); const lines = buffer.split(/\r?\n/); buffer = lines.pop() || ''; const complete = lines.find(line => /^\d{3} /.test(line)); if (complete) { cleanup(); resolve({ code: Number(complete.slice(0, 3)), text: lines.join('\n') }); } }; const onError = error => { cleanup(); reject(error); }; const cleanup = () => { clearTimeout(timer); socket.off('data', onData); socket.off('error', onError); }; socket.on('data', onData); socket.on('error', onError); }); }
async function smtpCommand(socket, command, expected) { if (command) socket.write(`${command}\r\n`); const response = await smtpResponse(socket); if (!expected.includes(response.code)) throw new Error(`SMTP 返回 ${response.code}`); return response; }
async function sendSmtpEmail(to, code) {
  const host = process.env.SMTP_HOST; const port = Number(process.env.SMTP_PORT || 465); const user = process.env.SMTP_USER; const pass = process.env.SMTP_PASS; const from = process.env.SMTP_FROM || user;
  if (!host || !user || !pass || !from) throw new Error('SMTP 配置不完整');
  const socket = tlsConnect({ host, port, servername: host, rejectUnauthorized: true });
  try {
    await smtpResponse(socket); await smtpCommand(socket, `EHLO learning-planet`, [250]);
    await smtpCommand(socket, 'AUTH LOGIN', [334]); await smtpCommand(socket, Buffer.from(user).toString('base64'), [334]); await smtpCommand(socket, Buffer.from(pass).toString('base64'), [235]);
    await smtpCommand(socket, `MAIL FROM:<${from}>`, [250]); await smtpCommand(socket, `RCPT TO:<${to}>`, [250, 251]); await smtpCommand(socket, 'DATA', [354]);
    socket.write(`From: 学习星球 <${from}>\r\nTo: ${to}\r\nSubject: =?UTF-8?B?${Buffer.from('学习星球账号安全验证码').toString('base64')}?=\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n您的验证码是 ${code}，5 分钟内有效。\r\n.\r\n`);
    await smtpResponse(socket); await smtpCommand(socket, 'QUIT', [221]);
  } finally { socket.end(); }
}
async function sendRecoveryCode(email, code) { const webhook = process.env.EMAIL_WEBHOOK_URL; if (webhook) { const response = await fetch(webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: email, subject: '学习星球账号安全验证码', text: `您的验证码是 ${code}，5 分钟内有效。` }) }); if (!response.ok) throw new Error('验证码发送失败'); return; } if (process.env.SMTP_HOST) { await sendSmtpEmail(email, code); return; } if (isProduction) throw new Error('未配置邮箱发送服务'); console.info(`[recovery-code] ${email}: ${code}`); }
function businessDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: process.env.APP_TIMEZONE || 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function addDateStr(dateStr, days) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
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
function csv(res, filename, content) {
  res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${filename}"`, 'cache-control': 'no-store' });
  res.end(`\ufeff${content}`);
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
function requestIsSecure(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return forwardedProto === 'https' || Boolean(req.socket.encrypted);
}
function secureCookie(req, name, value, maxAge = 0) {
  const settings = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
  if (isProduction && requestIsSecure(req)) settings.push('Secure');
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
    CREATE TABLE IF NOT EXISTS recovery_emails (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      email_cipher TEXT NOT NULL, email_hash TEXT NOT NULL,
      verified_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS recovery_codes (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      purpose TEXT NOT NULL, code_hash TEXT NOT NULL, expires_at TEXT NOT NULL,
      used_at TEXT, request_ip TEXT NOT NULL, target_hash TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, used_at TEXT,
      request_ip TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS security_logs (
      id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL, request_ip TEXT NOT NULL, created_at TEXT NOT NULL
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
    CREATE TABLE IF NOT EXISTS assessment_resource_libraries (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, subject TEXT NOT NULL CHECK(subject IN ('语文','数学','英语')),
      resource_type TEXT NOT NULL, grade TEXT NOT NULL DEFAULT '', term_unit TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '', visibility TEXT NOT NULL DEFAULT 'private' CHECK(visibility IN ('private','public')),
      status TEXT NOT NULL DEFAULT 'enabled' CHECK(status IN ('draft','enabled','archived')),
      creator_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS assessment_resource_items (
      id INTEGER PRIMARY KEY, library_id INTEGER NOT NULL REFERENCES assessment_resource_libraries(id) ON DELETE CASCADE,
      content TEXT NOT NULL, extra_json TEXT NOT NULL DEFAULT '{}', tags TEXT NOT NULL DEFAULT '',
      difficulty TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', sort_order INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'enabled' CHECK(status IN ('enabled','archived')), version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS assessment_questions (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL DEFAULT '', subject TEXT NOT NULL CHECK(subject IN ('语文','数学','英语')),
      grade TEXT NOT NULL DEFAULT '', difficulty TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '',
      question_type TEXT NOT NULL, answer_mode TEXT NOT NULL, prompt_json TEXT NOT NULL DEFAULT '{}',
      answer_json TEXT NOT NULL DEFAULT '{}', explanation TEXT NOT NULL DEFAULT '', score INTEGER NOT NULL DEFAULT 1,
      grading_mode TEXT NOT NULL DEFAULT 'auto', grading_rules_json TEXT NOT NULL DEFAULT '{}',
      source_snapshot_json TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','archived')),
      current_version INTEGER NOT NULL DEFAULT 1, creator_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS assessment_question_versions (
      id INTEGER PRIMARY KEY, question_id INTEGER NOT NULL REFERENCES assessment_questions(id) ON DELETE CASCADE,
      version INTEGER NOT NULL, snapshot_json TEXT NOT NULL, change_note TEXT NOT NULL DEFAULT '',
      creator_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL,
      UNIQUE(question_id, version)
    );
    CREATE TABLE IF NOT EXISTS assessment_papers (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, subject TEXT NOT NULL CHECK(subject IN ('语文','数学','英语')),
      grade TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', duration_minutes INTEGER,
      pass_score INTEGER, explanation_timing TEXT NOT NULL DEFAULT 'after_review', allow_retry INTEGER NOT NULL DEFAULT 0,
      retry_limit INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','archived')),
      current_version INTEGER NOT NULL DEFAULT 1, creator_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS assessment_paper_items (
      id INTEGER PRIMARY KEY, paper_id INTEGER NOT NULL REFERENCES assessment_papers(id) ON DELETE CASCADE,
      question_id INTEGER NOT NULL REFERENCES assessment_questions(id) ON DELETE RESTRICT, question_version INTEGER NOT NULL,
      sort_order INTEGER NOT NULL, score INTEGER NOT NULL, snapshot_json TEXT NOT NULL,
      UNIQUE(paper_id, sort_order)
    );
    CREATE TABLE IF NOT EXISTS assessment_assignments (
      id INTEGER PRIMARY KEY, student_task_id INTEGER NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
      student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, paper_id INTEGER REFERENCES assessment_papers(id) ON DELETE SET NULL,
      paper_version INTEGER, source_type TEXT NOT NULL CHECK(source_type IN ('direct','paper')), name TEXT NOT NULL,
      subject TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', due_date TEXT NOT NULL, deadline TEXT NOT NULL DEFAULT '',
      duration_minutes INTEGER, stars INTEGER NOT NULL DEFAULT 1, pet_exp_weight INTEGER NOT NULL DEFAULT 1,
      needs_review INTEGER NOT NULL DEFAULT 0, explanation_timing TEXT NOT NULL DEFAULT 'after_review',
      allow_retry INTEGER NOT NULL DEFAULT 0, retry_limit INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active',
      created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS assessment_assignment_questions (
      id INTEGER PRIMARY KEY, assignment_id INTEGER NOT NULL REFERENCES assessment_assignments(id) ON DELETE CASCADE,
      question_id INTEGER NOT NULL, question_version INTEGER NOT NULL, sort_order INTEGER NOT NULL, score INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL, UNIQUE(assignment_id, sort_order)
    );
    CREATE TABLE IF NOT EXISTS assessment_attempts (
      id INTEGER PRIMARY KEY, assignment_id INTEGER NOT NULL REFERENCES assessment_assignments(id) ON DELETE CASCADE,
      version INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','submitted','auto_graded','pending_review','returned','finalized')),
      started_at TEXT, submitted_at TEXT, auto_score INTEGER, manual_score INTEGER, final_score INTEGER, total_score INTEGER NOT NULL DEFAULT 0,
      is_valid INTEGER NOT NULL DEFAULT 1, submit_request_id TEXT UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(assignment_id, version)
    );
    CREATE TABLE IF NOT EXISTS assessment_answers (
      id INTEGER PRIMARY KEY, attempt_id INTEGER NOT NULL REFERENCES assessment_attempts(id) ON DELETE CASCADE,
      assignment_question_id INTEGER NOT NULL REFERENCES assessment_assignment_questions(id) ON DELETE CASCADE,
      answer_json TEXT NOT NULL DEFAULT '{}', attachment_json TEXT NOT NULL DEFAULT '[]', auto_result TEXT NOT NULL DEFAULT 'ungraded',
      auto_score INTEGER, manual_score INTEGER, final_score INTEGER, comment TEXT NOT NULL DEFAULT '', answered_at TEXT NOT NULL,
      UNIQUE(attempt_id, assignment_question_id)
    );
    CREATE TABLE IF NOT EXISTS assessment_reviews (
      id INTEGER PRIMARY KEY, attempt_id INTEGER NOT NULL REFERENCES assessment_attempts(id) ON DELETE CASCADE,
      action TEXT NOT NULL, reviewer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_assessment_library_owner ON assessment_resource_libraries(creator_id, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_assessment_items_library ON assessment_resource_items(library_id, status, sort_order);
    CREATE INDEX IF NOT EXISTS idx_assessment_questions_owner ON assessment_questions(creator_id, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_assessment_assignments_student ON assessment_assignments(student_id, due_date, status);
    CREATE INDEX IF NOT EXISTS idx_assessment_attempts_status ON assessment_attempts(status, updated_at DESC);
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
    CREATE TABLE IF NOT EXISTS reward_applications (
      id INTEGER PRIMARY KEY, student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category_id INTEGER REFERENCES task_categories(id) ON DELETE SET NULL, category_name TEXT NOT NULL,
      category_icon TEXT NOT NULL DEFAULT '', content TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
      completed_at TEXT NOT NULL, requested_stars INTEGER NOT NULL, awarded_stars INTEGER,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
      parent_message TEXT NOT NULL DEFAULT '', reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reviewed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reward_application_resources (
      application_id INTEGER NOT NULL REFERENCES reward_applications(id) ON DELETE CASCADE,
      resource_id INTEGER NOT NULL REFERENCES task_resources(id) ON DELETE CASCADE,
      sort_order INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(application_id, resource_id)
    );
    CREATE TABLE IF NOT EXISTS reading_books (
      id INTEGER PRIMARY KEY, creator_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL, author TEXT NOT NULL DEFAULT '', cover_url TEXT NOT NULL DEFAULT '',
      total_pages INTEGER NOT NULL, publisher TEXT NOT NULL DEFAULT '', isbn TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reading_plans (
      id INTEGER PRIMARY KEY, book_id INTEGER NOT NULL REFERENCES reading_books(id) ON DELETE CASCADE,
      student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      creator_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      start_date TEXT NOT NULL, end_date TEXT NOT NULL DEFAULT '', start_page INTEGER NOT NULL DEFAULT 1,
      target_pages INTEGER, target_minutes INTEGER, frequency TEXT NOT NULL DEFAULT 'daily',
      weekdays TEXT NOT NULL DEFAULT '', needs_review INTEGER NOT NULL DEFAULT 1,
      stars INTEGER NOT NULL DEFAULT 1, feedback_type TEXT NOT NULL DEFAULT 'optional_photo_or_video',
      current_page INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','awaiting_confirmation','completed','archived')),
      completed_by INTEGER REFERENCES users(id) ON DELETE SET NULL, completed_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reading_checkins (
      id INTEGER PRIMARY KEY, plan_id INTEGER NOT NULL REFERENCES reading_plans(id) ON DELETE CASCADE,
      student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      checkin_date TEXT NOT NULL, start_page INTEGER NOT NULL, end_page INTEGER NOT NULL,
      pages_read INTEGER NOT NULL, reflection TEXT NOT NULL DEFAULT '',
      feedback_kind TEXT NOT NULL DEFAULT '', feedback_url TEXT NOT NULL DEFAULT '', feedback_name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending_review' CHECK(status IN ('pending_review','needs_more','completed')),
      submitted_at TEXT, reviewed_at TEXT, reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      parent_message TEXT NOT NULL DEFAULT '', original_end_page INTEGER, adjusted_end_page INTEGER,
      adjustment_reason TEXT NOT NULL DEFAULT '', awarded_stars INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      checkin_order INTEGER NOT NULL DEFAULT 1,
      UNIQUE(plan_id, checkin_date, checkin_order)
    );
    CREATE TABLE IF NOT EXISTS pet_species (
      id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      personality TEXT NOT NULL DEFAULT '', personality_line TEXT NOT NULL DEFAULT '',
      asset_url TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active',
      sort_order INTEGER NOT NULL DEFAULT 0, version TEXT NOT NULL DEFAULT 'v1', created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS student_pet_settings (
      student_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 0, enabled_at TEXT, daily_minutes INTEGER NOT NULL DEFAULT 10,
      quiz_count INTEGER NOT NULL DEFAULT 3, subjects TEXT NOT NULL DEFAULT 'chinese,math,english',
      sound_enabled INTEGER NOT NULL DEFAULT 1, reduced_motion INTEGER NOT NULL DEFAULT 0,
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS student_pets (
      id INTEGER PRIMARY KEY, student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      species_id INTEGER NOT NULL REFERENCES pet_species(id), nickname TEXT NOT NULL,
      level INTEGER NOT NULL DEFAULT 1, total_exp INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'active', adopted_at TEXT NOT NULL,
      UNIQUE(student_id, active)
    );
    CREATE TABLE IF NOT EXISTS pet_daily_states (
      student_pet_id INTEGER NOT NULL REFERENCES student_pets(id) ON DELETE CASCADE,
      business_date TEXT NOT NULL, mood INTEGER NOT NULL DEFAULT 60, satiety INTEGER NOT NULL DEFAULT 60,
      cleanliness INTEGER NOT NULL DEFAULT 60, earned_exp INTEGER NOT NULL DEFAULT 0,
      food_earned INTEGER NOT NULL DEFAULT 0, active_seconds INTEGER NOT NULL DEFAULT 0,
      last_decay_at TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(student_pet_id, business_date)
    );
    CREATE TABLE IF NOT EXISTS pet_exp_ledger (
      id INTEGER PRIMARY KEY, student_pet_id INTEGER NOT NULL REFERENCES student_pets(id) ON DELETE CASCADE,
      business_date TEXT NOT NULL, source_type TEXT NOT NULL, source_id TEXT NOT NULL,
      rule_version TEXT NOT NULL, requested_delta INTEGER NOT NULL DEFAULT 0, delta INTEGER NOT NULL,
      balance_after INTEGER NOT NULL DEFAULT 0, reason TEXT NOT NULL DEFAULT '', rule_snapshot TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      UNIQUE(student_pet_id, source_type, source_id, rule_version)
    );
    CREATE TABLE IF NOT EXISTS pet_interactions (
      id INTEGER PRIMARY KEY, student_pet_id INTEGER NOT NULL REFERENCES student_pets(id) ON DELETE CASCADE,
      business_date TEXT NOT NULL, type TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE,
      exp_delta INTEGER NOT NULL DEFAULT 0, inventory_delta INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
      UNIQUE(student_pet_id, business_date, type)
    );
    CREATE TABLE IF NOT EXISTS pet_inventory (
      student_pet_id INTEGER NOT NULL REFERENCES student_pets(id) ON DELETE CASCADE,
      item_code TEXT NOT NULL, quantity INTEGER NOT NULL DEFAULT 0 CHECK(quantity >= 0), updated_at TEXT NOT NULL,
      PRIMARY KEY(student_pet_id, item_code)
    );
    CREATE TABLE IF NOT EXISTS pet_unlocks (
      id INTEGER PRIMARY KEY, student_pet_id INTEGER NOT NULL REFERENCES student_pets(id) ON DELETE CASCADE,
      content_type TEXT NOT NULL, content_code TEXT NOT NULL, condition_snapshot TEXT NOT NULL DEFAULT '{}', unlocked_at TEXT NOT NULL,
      UNIQUE(student_pet_id, content_type, content_code)
    );
    CREATE TABLE IF NOT EXISTS pet_pending_events (
      id INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, event_type TEXT NOT NULL,
      source_id TEXT NOT NULL, student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      pet_id INTEGER REFERENCES student_pets(id) ON DELETE SET NULL, business_date TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, processed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pet_ledger_student_date ON pet_exp_ledger(student_pet_id, business_date, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_pet_pending_status ON pet_pending_events(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_student_date ON tasks(student_id, task_date);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_student_status_date ON tasks(student_id, status, task_date);
    CREATE INDEX IF NOT EXISTS idx_parent_students_student_parent ON parent_students(student_id, parent_id);
    CREATE INDEX IF NOT EXISTS idx_rewards_student_created ON rewards(student_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_reward_applications_student_status ON reward_applications(student_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_task_templates_creator ON task_templates(creator_id);
    CREATE INDEX IF NOT EXISTS idx_task_templates_public ON task_templates(is_public);
    CREATE INDEX IF NOT EXISTS idx_task_templates_category_updated ON task_templates(category_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_task_resource_links_resource ON task_resource_links(resource_id);
    CREATE INDEX IF NOT EXISTS idx_template_resource_links_resource ON template_resource_links(resource_id);
    CREATE INDEX IF NOT EXISTS idx_reading_books_creator ON reading_books(creator_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_reading_plans_student_status ON reading_plans(student_id, status, start_date);
    CREATE INDEX IF NOT EXISTS idx_reading_plans_book_student ON reading_plans(book_id, student_id, status);
    CREATE INDEX IF NOT EXISTS idx_reading_checkins_plan_date ON reading_checkins(plan_id, checkin_date);
    CREATE INDEX IF NOT EXISTS idx_reading_checkins_student_status ON reading_checkins(student_id, status, checkin_date DESC);
  `);
  try { db.exec("ALTER TABLE tasks ADD COLUMN task_type TEXT NOT NULL DEFAULT 'standard'"); } catch (error) {
    if (!/duplicate column name/i.test(error.message)) throw error;
  }
  try { db.exec("ALTER TABLE pet_daily_states ADD COLUMN last_decay_at TEXT NOT NULL DEFAULT ''"); } catch (error) {
    if (!/duplicate column name/i.test(error.message)) throw error;
  }
  const petInteractionSchema = String(db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pet_interactions'").get()?.sql || '');
  if (/UNIQUE\s*\(\s*student_pet_id\s*,\s*business_date\s*,\s*type\s*\)/i.test(petInteractionSchema)) {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN;
      CREATE TABLE pet_interactions_next (
        id INTEGER PRIMARY KEY, student_pet_id INTEGER NOT NULL REFERENCES student_pets(id) ON DELETE CASCADE,
        business_date TEXT NOT NULL, type TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE,
        exp_delta INTEGER NOT NULL DEFAULT 0, inventory_delta INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
      );
      INSERT INTO pet_interactions_next (id,student_pet_id,business_date,type,request_id,exp_delta,inventory_delta,created_at)
        SELECT id,student_pet_id,business_date,type,request_id,exp_delta,inventory_delta,created_at FROM pet_interactions;
      DROP TABLE pet_interactions;
      ALTER TABLE pet_interactions_next RENAME TO pet_interactions;
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
  }
  const taskColumns = new Set(db.prepare('PRAGMA table_info(tasks)').all().map(column => column.name));
  const recoveryCodeColumns = new Set(db.prepare('PRAGMA table_info(recovery_codes)').all().map(column => column.name));
  const recoveryEmailSchema = String(db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'recovery_emails'").get()?.sql || '');
  if (/email_hash\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(recoveryEmailSchema)) {
    db.exec(`
      BEGIN;
      CREATE TABLE recovery_emails_next (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        email_cipher TEXT NOT NULL, email_hash TEXT NOT NULL,
        verified_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO recovery_emails_next (user_id, email_cipher, email_hash, verified_at, created_at, updated_at)
        SELECT user_id, email_cipher, email_hash, verified_at, created_at, updated_at FROM recovery_emails;
      DROP TABLE recovery_emails;
      ALTER TABLE recovery_emails_next RENAME TO recovery_emails;
      COMMIT;
    `);
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_recovery_emails_email_hash ON recovery_emails(email_hash)');
  if (!recoveryCodeColumns.has('target_hash')) db.exec("ALTER TABLE recovery_codes ADD COLUMN target_hash TEXT NOT NULL DEFAULT ''");
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
  if (!taskColumns.has('pet_exp_weight_snapshot')) db.exec('ALTER TABLE tasks ADD COLUMN pet_exp_weight_snapshot INTEGER');
  if (!taskColumns.has('submitted_active_pet_id')) db.exec('ALTER TABLE tasks ADD COLUMN submitted_active_pet_id INTEGER REFERENCES student_pets(id) ON DELETE SET NULL');
  if (!taskColumns.has('pet_business_date')) db.exec('ALTER TABLE tasks ADD COLUMN pet_business_date TEXT');
  const templateColumns = new Set(db.prepare('PRAGMA table_info(task_templates)').all().map(column => column.name));
  if (!templateColumns.has('pet_exp_weight')) db.exec('ALTER TABLE task_templates ADD COLUMN pet_exp_weight INTEGER NOT NULL DEFAULT 1');
  const resourceColumns = new Set(db.prepare('PRAGMA table_info(task_resources)').all().map(column => column.name));
  const rewardColumns = new Set(db.prepare('PRAGMA table_info(rewards)').all().map(column => column.name));
  if (!rewardColumns.has('reading_checkin_id')) db.exec('ALTER TABLE rewards ADD COLUMN reading_checkin_id INTEGER REFERENCES reading_checkins(id) ON DELETE SET NULL');
  const readingCheckinColumns = new Set(db.prepare('PRAGMA table_info(reading_checkins)').all().map(column => column.name));
  if (!readingCheckinColumns.has('awarded_stars')) db.exec('ALTER TABLE reading_checkins ADD COLUMN awarded_stars INTEGER');
  if (!readingCheckinColumns.has('checkin_order')) {
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.exec(`
        CREATE TABLE reading_checkins_next (
          id INTEGER PRIMARY KEY, plan_id INTEGER NOT NULL REFERENCES reading_plans(id) ON DELETE CASCADE,
          student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          checkin_date TEXT NOT NULL, start_page INTEGER NOT NULL, end_page INTEGER NOT NULL,
          pages_read INTEGER NOT NULL, reflection TEXT NOT NULL DEFAULT '',
          feedback_kind TEXT NOT NULL DEFAULT '', feedback_url TEXT NOT NULL DEFAULT '', feedback_name TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'pending_review' CHECK(status IN ('pending_review','needs_more','completed')),
          submitted_at TEXT, reviewed_at TEXT, reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          parent_message TEXT NOT NULL DEFAULT '', original_end_page INTEGER, adjusted_end_page INTEGER,
          adjustment_reason TEXT NOT NULL DEFAULT '', awarded_stars INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          checkin_order INTEGER NOT NULL DEFAULT 1,
          UNIQUE(plan_id, checkin_date, checkin_order)
        );
        INSERT INTO reading_checkins_next (id,plan_id,student_id,checkin_date,start_page,end_page,pages_read,reflection,feedback_kind,feedback_url,feedback_name,status,submitted_at,reviewed_at,reviewed_by,parent_message,original_end_page,adjusted_end_page,adjustment_reason,awarded_stars,created_at,updated_at,checkin_order)
          SELECT id,plan_id,student_id,checkin_date,start_page,end_page,pages_read,reflection,feedback_kind,feedback_url,feedback_name,status,submitted_at,reviewed_at,reviewed_by,parent_message,original_end_page,adjusted_end_page,adjustment_reason,awarded_stars,created_at,updated_at,1 FROM reading_checkins;
        DROP TABLE reading_checkins;
        ALTER TABLE reading_checkins_next RENAME TO reading_checkins;
        CREATE INDEX IF NOT EXISTS idx_reading_checkins_plan_date ON reading_checkins(plan_id, checkin_date);
        CREATE INDEX IF NOT EXISTS idx_reading_checkins_student_status ON reading_checkins(student_id, status, checkin_date DESC);
      `);
    } finally { db.exec('PRAGMA foreign_keys = ON'); }
  }
  if (!resourceColumns.has('url')) db.exec("ALTER TABLE task_resources ADD COLUMN url TEXT NOT NULL DEFAULT ''");
  if (!readingCheckinColumns.has('submitted_active_pet_id')) db.exec('ALTER TABLE reading_checkins ADD COLUMN submitted_active_pet_id INTEGER REFERENCES student_pets(id) ON DELETE SET NULL');
  if (!readingCheckinColumns.has('pet_business_date')) db.exec('ALTER TABLE reading_checkins ADD COLUMN pet_business_date TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_series ON tasks(series_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_recovery_codes_target_created ON recovery_codes(target_hash, created_at)');
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

function ensurePetSpecies() {
  const species = [
    ['star_ring_bunny', '星环兔', '元气、勇敢、探索', '今天也一起向前跳一小步吧！', 'assets/pets/concepts/star-ring-bunny-concept.png', 1],
    ['cloud_cat', '云朵猫', '好奇、温柔、阅读', '我发现书里藏着好多星光。', 'assets/pets/concepts/cloud-cat-concept.png', 2],
    ['warm_sun_red_panda', '暖阳小熊猫', '温暖、认真、陪伴', '慢慢来，认真完成每一件事。', 'assets/pets/concepts/warm-sun-red-panda-concept.png', 3]
  ];
  const insert = db.prepare("INSERT OR IGNORE INTO pet_species (code,name,personality,personality_line,asset_url,status,sort_order,version,created_at) VALUES (?,?,?,?,?,'active',?,?,?)");
  for (const item of species) insert.run(...item, 'v1', now());
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
function linkRewardResources(applicationId, resourceIds) {
  const insert = db.prepare('INSERT OR IGNORE INTO reward_application_resources (application_id, resource_id, sort_order) VALUES (?, ?, ?)');
  resourceIds.forEach((resourceId, index) => insert.run(applicationId, resourceId, index));
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
const taskStatusOrderSql = `CASE tasks.status
  WHEN 'not_started' THEN 0
  WHEN 'in_progress' THEN 0
  WHEN 'needs_more' THEN 0
  WHEN 'pending_review' THEN 1
  WHEN 'completed' THEN 2
  ELSE 3 END`;
function taskJson(task, includeFeedback = false, includeResource = false) {
  const hasSummary = !includeResource && task.resource_count !== undefined;
  const resources = hasSummary
    ? Number(task.resource_count) > 0 ? [{ name: task.resource_name, mime: task.resource_mime, kind: task.resource_kind }] : []
    : linkedResources('task', task.id, task.resource_id, includeResource);
  const resource = resources[0];
  const resourceCount = hasSummary ? Number(task.resource_count) : resources.length;
  const repeatWeekdays = String(task.repeat_weekdays || '').split(',').map(Number).filter(day => day >= 1 && day <= 7);
  const scheduleType = task.series_id ? 'repeat' : task.schedule_type || 'single';
  const result = { id: task.id, studentId: task.student_id, title: task.title, category: task.category, icon: task.icon, color: task.category_color, detail: task.detail, date: task.task_date, duration: task.duration_minutes, stars: task.stars, taskType: task.task_type || 'standard', isAssessment: (task.task_type || 'standard') === 'assessment', feedbackType: task.feedback_type || 'photo_or_video', petExpWeight: Number(task.pet_exp_weight_snapshot ?? task.pet_exp_weight ?? 1), needsReview: Boolean(task.needs_review), status: task.status, startedAt: task.started_at, draftUpdatedAt: task.draft_updated_at, submittedAt: task.submitted_at, encouragement: task.encouragement, studentName: task.student_name, studentAvatar: signStoredUrl(task.student_avatar), feedbackKind: task.feedback_kind || '', feedbackName: task.feedback_name || '', feedbackNote: task.feedback_note || '', hasFeedback: Boolean(task.feedback_url || task.feedback_data || task.feedback_note), hasResource: resourceCount > 0, resourceCount, resourceName: resource?.name || '', resourceMime: resource?.mime || '', resourceKind: resource?.kind || '', resources, scheduleType, isDateRange: scheduleType === 'range', availableStartDate: task.available_start_date || task.task_date, availableEndDate: task.available_end_date || task.task_date, isRecurring: Boolean(task.series_id), seriesId: task.series_id || '', repeatPattern: task.repeat_pattern || '', repeatWeekdays, seriesStartDate: task.series_start_date || '', seriesEndDate: task.series_end_date || '' };
  if (includeFeedback) result.feedbackData = signStoredUrl(task.feedback_url || task.feedback_data || '');
  if (includeResource) result.resourceData = resource?.data || '';
  return result;
}
const PET_RULE_VERSION = 'pet-exp-v1';
const PET_DAILY_EXP_LIMIT = 80;
const PET_DAILY_FOOD_LIMIT = 5;
const PET_INTERACTION_EXP = { pet: 1, feed: 2, clean: 1, play: 1 };
const AVAILABLE_PET_SPECIES = new Set(['star_ring_bunny']);
const PET_STAGES = [
  { code: 'hatchling', name: '幼崽期', minLevel: 1, maxLevel: 9, requirement: 'LV1-LV9', description: '熟悉陪伴日常，使用基础形象、表情和动作。' },
  { code: 'companion', name: '伙伴期', minLevel: 10, maxLevel: 29, requirement: 'LV10-LV29', description: '解锁新动作、基础服装，星星小屋完整开放。' },
  { code: 'explorer', name: '探索期', minLevel: 30, maxLevel: 59, requirement: 'LV30-LV59', description: '逐步呈现外观成长，解锁阅读树屋和探索动作。' },
  { code: 'shining', name: '闪耀期', minLevel: 60, maxLevel: 89, requirement: 'LV60-LV89', description: '获得专属纹理与光效，开放月光花园高级区域。' },
  { code: 'guardian', name: '星球守护者', minLevel: 90, maxLevel: 100, requirement: 'LV90-LV100', description: '解锁纪念饰品、守护者动作和专属完成场景。' }
];
function petLevelForExp(totalExp) {
  let level = 1; let remaining = Math.max(0, Number(totalExp) || 0);
  while (level < 100) { const required = 100 + 20 * Math.floor((level - 1) / 10); if (remaining < required) break; remaining -= required; level += 1; }
  return level;
}
function petStageForLevel(level) {
  const normalizedLevel = Math.max(1, Math.min(100, Number(level) || 1));
  return PET_STAGES.find(stage => normalizedLevel >= stage.minLevel && normalizedLevel <= stage.maxLevel) || PET_STAGES[0];
}
function petStageJson(stage) {
  return { code: stage.code, name: stage.name, minLevel: stage.minLevel, maxLevel: stage.maxLevel, requirement: stage.requirement, description: stage.description };
}
function normalizePetNickname(value) {
  const nickname = clean(value, 12);
  return nickname && Array.from(nickname).length <= 12 && !/https?:\/\//i.test(nickname) ? nickname : '';
}
function petSpeciesJson(species) { return species ? { code: species.code, name: species.name, personality: species.personality, personalityLine: species.personality_line, assetUrl: signStoredUrl(species.asset_url), sortOrder: Number(species.sort_order) } : null; }
function settlePetStateDecay(petId, date, timestamp = now()) {
  const daily = db.prepare('SELECT * FROM pet_daily_states WHERE student_pet_id = ? AND business_date = ?').get(petId, date);
  if (!daily) return null;
  const currentMs = Date.parse(timestamp);
  const lastMs = Date.parse(daily.last_decay_at || '');
  if (!Number.isFinite(currentMs)) return daily;
  if (!Number.isFinite(lastMs)) {
    db.prepare('UPDATE pet_daily_states SET last_decay_at = ? WHERE student_pet_id = ? AND business_date = ?').run(timestamp, petId, date);
    return { ...daily, last_decay_at: timestamp };
  }
  if (currentMs <= lastMs) return daily;
  const intervals = Math.floor((currentMs - lastMs) / (2 * 60 * 60 * 1000));
  if (!intervals) return daily;
  const settledAt = new Date(lastMs + intervals * 2 * 60 * 60 * 1000).toISOString();
  const decrease = intervals * 10;
  db.prepare('UPDATE pet_daily_states SET mood = MAX(0, mood - ?), satiety = MAX(0, satiety - ?), cleanliness = MAX(0, cleanliness - ?), last_decay_at = ? WHERE student_pet_id = ? AND business_date = ?').run(decrease, decrease, decrease, settledAt, petId, date);
  return db.prepare('SELECT * FROM pet_daily_states WHERE student_pet_id = ? AND business_date = ?').get(petId, date);
}
function ensurePetDailyState(petId, date) {
  const timestamp = now();
  db.prepare('INSERT OR IGNORE INTO pet_daily_states (student_pet_id,business_date,last_decay_at) VALUES (?,?,?)').run(petId, date, timestamp);
  return settlePetStateDecay(petId, date, timestamp);
}
function activePetForStudent(studentId) { return db.prepare(`SELECT student_pets.*, pet_species.code AS species_code, pet_species.name AS species_name, pet_species.personality, pet_species.personality_line, pet_species.asset_url
  FROM student_pets JOIN pet_species ON pet_species.id = student_pets.species_id
  WHERE student_pets.student_id = ? AND student_pets.active = 1 AND student_pets.status = 'active' LIMIT 1`).get(studentId); }
function petOverview(studentId, includeLedger = false) {
  const settings = db.prepare('SELECT * FROM student_pet_settings WHERE student_id = ?').get(studentId) || { student_id: studentId, enabled: 0, daily_minutes: 10, quiz_count: 3, subjects: 'chinese,math,english', sound_enabled: 1, reduced_motion: 0 };
  const pet = activePetForStudent(studentId);
  const date = businessDate();
  const daily = pet ? ensurePetDailyState(pet.id, date) : null;
  const ledger = includeLedger && pet ? db.prepare('SELECT id, business_date, source_type, source_id, requested_delta, delta, balance_after, reason, rule_snapshot, created_at FROM pet_exp_ledger WHERE student_pet_id = ? ORDER BY id DESC LIMIT 50').all(pet.id) : [];
  const level = pet ? Number(pet.level) : 1;
  return { enabled: Boolean(settings.enabled), enabledAt: settings.enabled_at || null, settings: { dailyMinutes: Number(settings.daily_minutes || 10), soundEnabled: Boolean(settings.sound_enabled), reducedMotion: Boolean(settings.reduced_motion) }, stages: PET_STAGES.map(petStageJson), pet: pet ? { id: pet.id, nickname: pet.nickname, level, totalExp: Number(pet.total_exp), stage: petStageJson(petStageForLevel(level)), species: petSpeciesJson({ code: pet.species_code, name: pet.species_name, personality: pet.personality, personality_line: pet.personality_line, asset_url: pet.asset_url, sort_order: 0 }), daily: { mood: Number(daily.mood), satiety: Number(daily.satiety), cleanliness: Number(daily.cleanliness), earnedExp: Number(daily.earned_exp), foodEarned: Number(daily.food_earned), activeSeconds: Number(daily.active_seconds) }, inventory: { basicFood: Number(db.prepare("SELECT quantity FROM pet_inventory WHERE student_pet_id = ? AND item_code = 'basic_food'").get(pet.id)?.quantity || 0) } } : null, ledger: ledger.map(item => ({ id: item.id, businessDate: item.business_date, sourceType: item.source_type, sourceId: item.source_id, requestedDelta: Number(item.requested_delta), delta: Number(item.delta), balanceAfter: Number(item.balance_after), reason: item.reason, ruleSnapshot: item.rule_snapshot, createdAt: item.created_at })) };
}
function unlockPetLevels(petId, level, timestamp) {
  const insert = db.prepare('INSERT OR IGNORE INTO pet_unlocks (student_pet_id,content_type,content_code,condition_snapshot,unlocked_at) VALUES (?,?,?,?,?)');
  for (let unlockLevel = 5; unlockLevel <= level; unlockLevel += 5) insert.run(petId, 'level_reward', `level-${unlockLevel}`, JSON.stringify({ level: unlockLevel, ruleVersion: PET_RULE_VERSION }), timestamp);
}
function settlePetEvent(event) {
  const pet = event.petId ? db.prepare("SELECT * FROM student_pets WHERE id = ? AND student_id = ? AND status = 'active'").get(event.petId, event.studentId) : null;
  const settings = db.prepare('SELECT enabled, enabled_at FROM student_pet_settings WHERE student_id = ?').get(event.studentId);
  if (!pet || !settings?.enabled || (settings.enabled_at && event.occurredAt < settings.enabled_at)) return { delta: 0, inserted: false, skipped: true };
  const sourceType = event.sourceType;
  const existing = db.prepare('SELECT delta FROM pet_exp_ledger WHERE student_pet_id = ? AND source_type = ? AND source_id = ? AND rule_version = ?').get(pet.id, sourceType, event.sourceId, PET_RULE_VERSION);
  if (existing) return { delta: Number(existing.delta), inserted: false, skipped: false };
  const date = event.businessDate || businessDate();
  ensurePetDailyState(pet.id, date);
  const sourceCap = sourceType === 'task_complete' ? 50 : sourceType === 'reading_complete' ? 5 : sourceType === 'daily_completion' ? 15 : PET_DAILY_EXP_LIMIT;
  const sourceUsed = Number(db.prepare('SELECT COALESCE(SUM(delta),0) AS total FROM pet_exp_ledger WHERE student_pet_id = ? AND business_date = ? AND source_type = ?').get(pet.id, date, sourceType)?.total || 0);
  const studentDayUsed = Number(db.prepare(`SELECT COALESCE(SUM(pet_exp_ledger.delta),0) AS total FROM pet_exp_ledger JOIN student_pets ON student_pets.id = pet_exp_ledger.student_pet_id WHERE student_pets.student_id = ? AND pet_exp_ledger.business_date = ?`).get(event.studentId, date)?.total || 0);
  const requested = Math.max(0, Number(event.requestedDelta) || 0);
  const delta = Math.max(0, Math.min(requested, Math.max(0, sourceCap - sourceUsed), Math.max(0, PET_DAILY_EXP_LIMIT - studentDayUsed)));
  const timestamp = event.occurredAt || now();
  const balanceAfter = Number(pet.total_exp || 0) + delta;
  const snapshot = JSON.stringify({ theoretical: requested, sourceCap, sourceUsed, studentDayUsed, final: delta, ruleVersion: PET_RULE_VERSION });
  db.prepare('INSERT INTO pet_exp_ledger (student_pet_id,business_date,source_type,source_id,rule_version,requested_delta,delta,balance_after,reason,rule_snapshot,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(pet.id, date, sourceType, event.sourceId, PET_RULE_VERSION, requested, delta, balanceAfter, delta < requested ? '已达到当日成长能量上限' : (event.reason || ''), snapshot, timestamp);
  const level = petLevelForExp(balanceAfter);
  db.prepare('UPDATE student_pets SET total_exp = ?, level = ? WHERE id = ?').run(balanceAfter, level, pet.id);
  db.prepare('UPDATE pet_daily_states SET earned_exp = earned_exp + ? WHERE student_pet_id = ? AND business_date = ?').run(delta, pet.id, date);
  unlockPetLevels(pet.id, level, timestamp);
  return { delta, inserted: true, skipped: false };
}
function grantPetFood(petId, date, timestamp) {
  const daily = ensurePetDailyState(petId, date);
  if (Number(daily.food_earned || 0) >= PET_DAILY_FOOD_LIMIT) return false;
  db.prepare('UPDATE pet_daily_states SET food_earned = food_earned + 1 WHERE student_pet_id = ? AND business_date = ?').run(petId, date);
  db.prepare("INSERT INTO pet_inventory (student_pet_id,item_code,quantity,updated_at) VALUES (?, 'basic_food', 1, ?) ON CONFLICT(student_pet_id,item_code) DO UPDATE SET quantity = quantity + 1, updated_at = excluded.updated_at").run(petId, timestamp);
  return true;
}
function publishPetEvent(event) {
  if (!event?.studentId || !event?.sourceId) return;
  const eventId = event.eventId || hashToken(`${event.eventType}:${event.studentId}:${event.sourceId}`);
  const timestamp = event.occurredAt || now();
  db.prepare('INSERT OR IGNORE INTO pet_pending_events (event_id,event_type,source_id,student_id,pet_id,business_date,payload,created_at) VALUES (?,?,?,?,?,?,?,?)').run(eventId, event.eventType, event.sourceId, event.studentId, event.petId || null, event.businessDate || businessDate(), JSON.stringify(event), timestamp);
  const pending = db.prepare('SELECT * FROM pet_pending_events WHERE event_id = ?').get(eventId);
  if (!pending || pending.status === 'done') return;
  try {
    db.exec('BEGIN');
    const result = settlePetEvent({ ...event, eventId, occurredAt: timestamp });
    if (event.eventType === 'TASK_COMPLETED' && event.petId) grantPetFood(event.petId, event.businessDate || businessDate(), timestamp);
    if (event.eventType === 'INTERACTION' && event.interactionId) db.prepare('UPDATE pet_interactions SET exp_delta = ? WHERE id = ?').run(result.delta, event.interactionId);
    db.prepare("UPDATE pet_pending_events SET status='done', attempts=attempts+1, last_error='', processed_at=? WHERE event_id=?").run(timestamp, eventId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    db.prepare("UPDATE pet_pending_events SET status='failed', attempts=attempts+1, last_error=? WHERE event_id=?").run(error.message, eventId);
    console.error('萌宠经验结算失败：', error.message);
  }
}
function reconcileDailyPetCompletion(studentId, date) {
  const rows = db.prepare(`SELECT status, COALESCE(pet_exp_weight_snapshot, 1) AS weight FROM tasks
    WHERE student_id = ? AND is_demo = 0 AND ((schedule_type = 'range' AND available_start_date <= ? AND available_end_date >= ?) OR (schedule_type <> 'range' AND task_date = ?))`).all(studentId, date, date, date);
  const totalWeight = rows.reduce((sum, task) => sum + Math.max(0, Number(task.weight) || 0), 0);
  const completedWeight = rows.filter(task => task.status === 'completed').reduce((sum, task) => sum + Math.max(0, Number(task.weight) || 0), 0);
  if (!totalWeight) return;
  const pet = activePetForStudent(studentId);
  if (!pet) return;
  for (const threshold of [50, 80, 100]) {
    if (completedWeight * 100 < totalWeight * threshold) continue;
    publishPetEvent({ eventType: 'DAILY_COMPLETION', sourceType: 'daily_completion', sourceId: `${date}:${threshold}`, studentId, petId: pet.id, businessDate: date, requestedDelta: 5, occurredAt: now(), reason: `当日任务完成度达到 ${threshold}%` });
  }
}
function taskVisibleOn(task, date) {
  return task.isDateRange ? task.availableStartDate <= date && task.availableEndDate >= date : task.date === date;
}
function overdueUnfinishedTaskDates(weekTasks, currentDate = businessDate()) {
  return Object.entries(weekTasks).filter(([date, dayTasks]) => dayTasks.some(task => {
    if (!['not_started', 'in_progress', 'needs_more'].includes(task.status)) return false;
    // A continuous task is overdue only after its deadline, and its reminder belongs on that deadline.
    if (task.isDateRange) return date === task.availableEndDate && task.availableEndDate < currentDate;
    // Repeated tasks are separate daily records, so only elapsed occurrences are overdue.
    return date < currentDate;
  })).map(([date]) => date);
}
function taskIsCompleted(task) {
  return String(task?.status || '').toLowerCase() === 'completed';
}
function taskScheduleType(task) {
  return task?.isDateRange || task?.scheduleType === 'range' || task?.schedule_type === 'range' ? 'range' : 'single';
}
function taskDateStatusMarker(task, date, currentDate = businessDate()) {
  const status = String(task?.status || '').toLowerCase();
  const isRange = taskScheduleType(task) === 'range';
  const endDate = task?.availableEndDate || task?.available_end_date || task?.endDate || task?.task_date || task?.date;

  if (status === 'completed') return 'completed';
  if (status === 'pending_review') return 'pending';

  if (isRange) {
    // Keep the whole continuous-task period visible. After expiry only the
    // deadline turns red; earlier dates remain blue task markers.
    if (endDate < currentDate) return date === endDate ? 'overdue' : 'active';
    return 'active';
  }
  return date < currentDate ? 'overdue' : 'active';
}
function taskIsOverdueOn(task, date, currentDate = businessDate()) {
  return taskDateStatusMarker(task, date, currentDate) === 'overdue';
}
function taskDateMarkMap(weekTasks, currentDate = businessDate()) {
  return Object.fromEntries(Object.entries(weekTasks).flatMap(([date, dayTasks]) => {
    if (!dayTasks.length) return [];
    const markers = new Set(dayTasks.map(task => taskDateStatusMarker(task, date, currentDate)).filter(Boolean));
    // A date can contain multiple independent assignments. Surface the state that
    // needs attention first, while retaining a visible marker for every task day.
    const marker = ['overdue', 'pending', 'active', 'completed'].find(value => markers.has(value));
    return marker ? [[date, marker]] : [];
  }));
}
function taskTemplateJson(template, includeResource = false) {
  const resources = linkedResources('template', template.id, template.resource_id, includeResource);
  const resource = resources[0];
  const result = {
    id: template.id, creatorId: template.creator_id, creatorName: template.creator_name,
    title: template.title, categoryId: template.category_id, category: template.category_name,
    icon: template.category_icon, color: template.category_color, detail: template.detail,
    duration: template.duration_minutes, stars: template.stars, feedbackType: template.feedback_type,
    needsReview: Boolean(template.needs_review), petExpWeight: Number(template.pet_exp_weight ?? 1), isPublic: Boolean(template.is_public),
    isOwner: Boolean(template.is_owner), hasResource: resources.length > 0, resourceCount: resources.length,
    resourceName: resource?.name || '', resourceMime: resource?.mime || '',
    resourceKind: resource?.kind || '', resources, createdAt: template.created_at, updatedAt: template.updated_at
  };
  if (includeResource) result.resourceData = resource?.data || '';
  return result;
}
function rewardApplicationJson(application, includeData = false) {
  const resources = db.prepare(`SELECT task_resources.id, task_resources.name, task_resources.mime, task_resources.kind${includeData ? ', task_resources.url, task_resources.data' : ''}
    FROM reward_application_resources JOIN task_resources ON task_resources.id = reward_application_resources.resource_id
    WHERE reward_application_resources.application_id = ? ORDER BY reward_application_resources.sort_order, task_resources.id`).all(application.id)
    .map(resource => ({ id: resource.id, name: resource.name, mime: resource.mime, kind: storedResourceKind(resource), ...(includeData ? { data: signStoredUrl(resource.url || resource.data) } : {}) }));
  return { id: application.id, studentId: application.student_id, studentName: application.student_name || '', studentAvatar: signStoredUrl(application.student_avatar || ''),
    categoryId: application.category_id, category: application.category_name, icon: application.category_icon, content: application.content,
    detail: application.detail || '', completedAt: application.completed_at, requestedStars: application.requested_stars,
    awardedStars: application.awarded_stars, status: application.status, parentMessage: application.parent_message || '',
    reviewedAt: application.reviewed_at, createdAt: application.created_at, updatedAt: application.updated_at,
    resources, resourceCount: resources.length, hasResource: resources.length > 0 };
}
function readingBookJson(book) {
  return { id: book.id, creatorId: book.creator_id, creatorName: book.creator_name || '', title: book.title,
    author: book.author || '', coverUrl: signStoredUrl(book.cover_url || ''), totalPages: Number(book.total_pages),
    publisher: book.publisher || '', isbn: book.isbn || '', planCount: Number(book.plan_count || 0),
    activePlanCount: Number(book.active_plan_count || 0), canEdit: true,
    canDelete: !Number(book.plan_count || 0), createdAt: book.created_at, updatedAt: book.updated_at };
}
function readingPlanJson(plan) {
  return { id: plan.id, bookId: plan.book_id, studentId: plan.student_id, creatorId: plan.creator_id,
    studentName: plan.student_name || '', studentAvatar: signStoredUrl(plan.student_avatar || ''),
    title: plan.book_title, author: plan.book_author || '', coverUrl: signStoredUrl(plan.book_cover_url || ''),
    totalPages: Number(plan.total_pages), startDate: plan.start_date, endDate: plan.end_date || '',
    startPage: Number(plan.start_page), targetPages: Number(plan.target_pages || 0), targetMinutes: Number(plan.target_minutes || 0),
    frequency: plan.frequency, weekdays: String(plan.weekdays || '').split(',').map(Number).filter(Number.isInteger),
    needsReview: Boolean(plan.needs_review), stars: Number(plan.stars), feedbackType: plan.feedback_type,
    currentPage: Number(plan.current_page || 0), status: plan.status, completedAt: plan.completed_at,
    createdAt: plan.created_at, updatedAt: plan.updated_at };
}
function readingCheckinJson(checkin, includeFeedback = false) {
  return { id: checkin.id, planId: checkin.plan_id, studentId: checkin.student_id, studentName: checkin.student_name || '',
    studentAvatar: signStoredUrl(checkin.student_avatar || ''), bookTitle: checkin.book_title || '', bookAuthor: checkin.book_author || '',
    bookCoverUrl: signStoredUrl(checkin.book_cover_url || ''), totalPages: Number(checkin.total_pages || 0),
    checkinDate: checkin.checkin_date, startPage: Number(checkin.start_page), endPage: Number(checkin.end_page),
    pagesRead: Number(checkin.pages_read), reflection: checkin.reflection || '', feedbackKind: checkin.feedback_kind || '',
    feedbackName: checkin.feedback_name || '', status: checkin.status, submittedAt: checkin.submitted_at,
    reviewedAt: checkin.reviewed_at, parentMessage: checkin.parent_message || '', originalEndPage: checkin.original_end_page,
    adjustedEndPage: checkin.adjusted_end_page, adjustmentReason: checkin.adjustment_reason || '',
    stars: Number(checkin.plan_stars || checkin.stars || 0), awardedStars: checkin.awarded_stars === null || checkin.awarded_stars === undefined ? null : Number(checkin.awarded_stars), needsReview: Boolean(checkin.needs_review),
    createdAt: checkin.created_at, updatedAt: checkin.updated_at,
    ...(includeFeedback ? { feedbackUrl: signStoredUrl(checkin.feedback_url || '') } : {}) };
}
const readingPlanSelectSql = `SELECT reading_plans.*, reading_books.title AS book_title, reading_books.author AS book_author,
  reading_books.cover_url AS book_cover_url, reading_books.total_pages, users.display_name AS student_name, users.avatar AS student_avatar
  FROM reading_plans JOIN reading_books ON reading_books.id = reading_plans.book_id
  JOIN users ON users.id = reading_plans.student_id`;
const readingCheckinSelectSql = `SELECT reading_checkins.*, reading_plans.stars AS plan_stars, reading_plans.needs_review,
  reading_books.title AS book_title, reading_books.author AS book_author, reading_books.cover_url AS book_cover_url,
  reading_books.total_pages, users.display_name AS student_name, users.avatar AS student_avatar
  FROM reading_checkins JOIN reading_plans ON reading_plans.id = reading_checkins.plan_id
  JOIN reading_books ON reading_books.id = reading_plans.book_id JOIN users ON users.id = reading_checkins.student_id`;
function readingDueOn(plan, date) {
  if (date < plan.start_date || (plan.end_date && date > plan.end_date)) return false;
  if (plan.frequency === 'daily') return true;
  const weekday = ((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
  return String(plan.weekdays || '').split(',').map(Number).includes(weekday);
}
function approvedReadingEndPage(planId, beforeDate = '') {
  const condition = beforeDate ? 'AND checkin_date < ?' : '';
  const row = db.prepare(`SELECT MAX(end_page) AS page FROM reading_checkins WHERE plan_id = ? AND status = 'completed' ${condition}`).get(planId, ...(beforeDate ? [beforeDate] : []));
  return Number(row?.page || 0);
}
async function readingCoverValue(value, current, title) {
  if (!value) return { url: current || '', uploadedUrl: '' };
  if (isStoredFileUrl(value) && stripUrlQuery(value) === current) return { url: current, uploadedUrl: '' };
  const feedback = normalizeTaskFeedback(value);
  if (!feedback || feedback.kind !== 'image') return null;
  const url = await storeDataUrl(feedback.data, { dataDir, folder: 'reading-covers', name: title || '书籍封面' });
  return { url, uploadedUrl: url };
}
async function readingFeedbackValue(value, current, name) {
  if (!value) return { url: current || '', kind: '', uploadedUrl: '' };
  if (isStoredFileUrl(value) && stripUrlQuery(value) === current) return { url: current, kind: '', uploadedUrl: '' };
  const feedback = normalizeTaskFeedback(value);
  if (!feedback) return null;
  const url = await storeDataUrl(feedback.data, { dataDir, folder: 'reading-feedback', name: name || '阅读反馈' });
  return { url, kind: feedback.kind, uploadedUrl: url };
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
  const usedByRewardLink = db.prepare('SELECT 1 FROM reward_application_resources WHERE resource_id = ? LIMIT 1').get(resourceId);
  if (!usedByTask && !usedByTemplate && !usedByTaskLink && !usedByTemplateLink && !usedByRewardLink) {
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

const ASSESSMENT_SUBJECTS = new Set(['语文', '数学', '英语']);
const ASSESSMENT_TYPES = new Set(['single_choice', 'multiple_choice', 'true_false', 'fill_blank', 'short_text', 'dictation', 'ordering', 'image_writing', 'audio_speaking']);
const ASSESSMENT_MODES = new Set(['choice', 'text', 'multi_text', 'ordering', 'image', 'audio']);
const IMPORTABLE_ASSESSMENT_TYPES = new Map([['单选题', 'single_choice'], ['多选题', 'multiple_choice'], ['判断题', 'true_false'], ['填空题', 'fill_blank'], ['简答题', 'short_text']]);
const IMPORTABLE_ASSESSMENT_TYPE_LABELS = Object.fromEntries([...IMPORTABLE_ASSESSMENT_TYPES].map(([label, type]) => [type, label]));
function parseJson(value, fallback = {}) { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }
function csvCells(text) {
  const rows = []; let row = []; let cell = ''; let quoted = false;
  for (let index = 0; index < String(text || '').length; index += 1) {
    const char = text[index]; const next = text[index + 1];
    if (char === '"' && quoted && next === '"') { cell += '"'; index += 1; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (char === ',' && !quoted) { row.push(cell); cell = ''; continue; }
    if ((char === '\n' || char === '\r') && !quoted) { if (char === '\r' && next === '\n') index += 1; row.push(cell); if (row.some(value => value.trim())) rows.push(row); row = []; cell = ''; continue; }
    cell += char;
  }
  row.push(cell); if (row.some(value => value.trim())) rows.push(row); return rows;
}
function csvEscape(value) { const text = String(value ?? ''); return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }
function assessmentQuestionImportTemplate() {
  return [
    ['题目名称', '科目', '题型', '题干内容', '选项（用｜分隔）', '正确答案（多选用｜分隔）', '参考答案/评分要点', '答案解析', '分值', '允许学生上传附件（是/否）', '发布状态（草稿/启用）'],
    ['词义选择示例', '语文', '单选题', '“津津有味”最接近下面哪个意思？', '很有兴趣｜很伤心｜很害怕', '很有兴趣', '', '津津有味表示很有兴趣的样子。', '1', '否', '草稿'],
    ['英语多选示例', '英语', '多选题', '请选择表示水果的单词。', 'apple｜book｜banana', 'apple｜banana', '', 'apple 和 banana 都表示水果。', '2', '否', '草稿'],
    ['判断示例', '数学', '判断题', '3 × 4 = 12。', '', '正确', '', '3 个 4 相加等于 12。', '1', '否', '草稿'],
    ['填空示例', '语文', '填空题', '请填写：春眠不觉____。', '', '晓', '', '诗句是“春眠不觉晓”。', '1', '否', '草稿'],
    ['简答示例', '语文', '简答题', '请说说故事中你最喜欢的人物和原因。', '', '', '围绕人物特点和故事内容说明理由', '说清人物和理由即可。', '5', '是', '草稿']
  ].map(row => row.map(csvEscape).join(',')).join('\r\n');
}
function assessmentImportRows(text) {
  const [headerRow, ...dataRows] = csvCells(text); const headers = (headerRow || []).map(value => value.replace(/^\ufeff/, '').trim());
  const required = ['题目名称', '科目', '题型', '题干内容', '分值'];
  if (!required.every(name => headers.includes(name))) throw new Error(`模板缺少必填列：${required.filter(name => !headers.includes(name)).join('、')}`);
  return dataRows.map((cells, index) => Object.fromEntries(headers.map((header, column) => [header, String(cells[column] || '').trim()]).filter(([header]) => header))).filter(row => Object.values(row).some(Boolean)).map((row, index) => ({ row, rowNumber: index + 2 }));
}
function assessmentImportPayload(row) {
  const questionType = IMPORTABLE_ASSESSMENT_TYPES.get(row['题型']);
  const options = String(row['选项（用｜分隔）'] || '').split('｜').map(value => clean(value, 300)).filter(Boolean);
  const answers = String(row['正确答案（多选用｜分隔）'] || '').split('｜').map(value => clean(value, 300)).filter(Boolean);
  const shortText = questionType === 'short_text';
  // A single-choice option can itself represent a paired fill-in answer, such as
  // “sells,is read”. Accept the template's delimiter between the two blanks too.
  const pairedSingleChoice = questionType === 'single_choice' && answers.length > 1
    ? options.find(option => option.replace(/，/g, ',').replace(/\s+/g, '') === answers.join(',').replace(/，/g, ',').replace(/\s+/g, ''))
    : '';
  return {
    name: clean(row.题目名称, 160), subject: clean(row.科目, 12), questionType,
    promptText: clean(row.题干内容, 3000), options: questionType === 'true_false' ? ['正确', '错误'] : options,
    correctAnswer: questionType === 'multiple_choice' ? answers : (pairedSingleChoice || answers[0] || (shortText ? clean(row['参考答案/评分要点'], 2000) : '')),
    explanation: clean(row.答案解析, 2000), score: Number(row.分值),
    allowAttachment: ['是', 'yes', 'true', '1'].includes(String(row['允许学生上传附件（是/否）'] || '').trim().toLowerCase()),
    status: ['启用', '已发布', 'published'].includes(String(row['发布状态（草稿/启用）'] || '').trim()) ? 'published' : 'draft',
    gradingMode: shortText ? 'manual' : 'auto'
  };
}
function validateAssessmentImportRow(row, rowNumber) {
  const errors = []; const payload = assessmentImportPayload(row); const label = `第 ${rowNumber} 行`;
  if (!payload.name) errors.push(`${label}：题目名称不能为空`);
  if (!ASSESSMENT_SUBJECTS.has(payload.subject)) errors.push(`${label}：科目仅支持语文、数学、英语`);
  if (!payload.questionType) errors.push(`${label}：题型仅支持单选题、多选题、判断题、填空题、简答题`);
  if (!Number.isSafeInteger(payload.score) || payload.score < 1 || payload.score > 100) errors.push(`${label}：分值需为 1 至 100 的整数`);
  if (['single_choice', 'multiple_choice'].includes(payload.questionType) && payload.options.length < 2) errors.push(`${label}：${row.题型}至少需要两个选项`);
  if (payload.questionType === 'true_false' && !['正确', '错误'].includes(payload.correctAnswer)) errors.push(`${label}：判断题正确答案只能填写“正确”或“错误”`);
  const selectedAnswers = Array.isArray(payload.correctAnswer) ? payload.correctAnswer : [payload.correctAnswer].filter(Boolean);
  if (['single_choice', 'multiple_choice'].includes(payload.questionType) && !selectedAnswers.length) errors.push(`${label}：请选择正确答案`);
  if (['single_choice', 'multiple_choice'].includes(payload.questionType) && selectedAnswers.some(answer => !payload.options.includes(answer))) errors.push(`${label}：正确答案必须来自选项内容`);
  if (payload.questionType !== 'short_text' && !selectedAnswers.length) errors.push(`${label}：请填写正确答案`);
  return { payload, errors };
}
function assessmentPagination(url, defaultPageSize = 10) {
  const requestedPage = Number.parseInt(url.searchParams.get('page') || '1', 10);
  const requestedPageSize = Number.parseInt(url.searchParams.get('pageSize') || String(defaultPageSize), 10);
  const pageSize = Math.min(50, Math.max(1, Number.isFinite(requestedPageSize) ? requestedPageSize : defaultPageSize));
  const page = Math.max(1, Number.isFinite(requestedPage) ? requestedPage : 1);
  return { page, pageSize, offset: (page - 1) * pageSize };
}
function assessmentPaginationMeta(total, { page, pageSize }) {
  return { page, pageSize, total: Number(total || 0), totalPages: Math.max(1, Math.ceil(Number(total || 0) / pageSize)) };
}
function assessmentSnapshot(row) { return { name: row.name, subject: row.subject, grade: row.grade, difficulty: row.difficulty, tags: row.tags ? row.tags.split(',').filter(Boolean) : [], questionType: row.question_type, answerMode: row.answer_mode, prompt: parseJson(row.prompt_json), answer: parseJson(row.answer_json), explanation: row.explanation, score: Number(row.score), gradingMode: row.grading_mode, gradingRules: parseJson(row.grading_rules_json), source: parseJson(row.source_snapshot_json), version: Number(row.current_version || 1) }; }
function assessmentPaperItemSnapshot(row, score) { return { ...assessmentSnapshot(row), score: Number(score) }; }
function assessmentQuestionJson(row, reveal = true) { const item = assessmentSnapshot(row); if (!reveal) delete item.answer; return { id: row.id, ...item, status: row.status, creatorId: row.creator_id, createdAt: row.created_at, updatedAt: row.updated_at }; }
function assessmentQuestionSummaryJson(row) { const question = assessmentQuestionJson(row, true); const attachments = question.source?.attachments; if (Array.isArray(attachments)) question.source = { ...question.source, attachments: attachments.map(({ name, mime, kind }) => ({ name, mime, kind })) }; return question; }
function assessmentPaperJson(row, includeItems = true) { const result = { id: row.id, name: row.name, subject: row.subject, grade: row.grade, description: row.description, duration: row.duration_minutes, passScore: row.pass_score, explanationTiming: row.explanation_timing, allowRetry: Boolean(row.allow_retry), retryLimit: Number(row.retry_limit || 0), status: row.status, version: Number(row.current_version || 1), creatorId: row.creator_id, createdAt: row.created_at, updatedAt: row.updated_at, totalScore: 0, questionCount: 0, requiresReview: false }; if (includeItems) { result.questions = db.prepare('SELECT * FROM assessment_paper_items WHERE paper_id = ? ORDER BY sort_order').all(row.id).map(item => { const snapshot = parseJson(item.snapshot_json); const score = Number(item.score || snapshot.score || 0); result.totalScore += score; result.questionCount += 1; result.requiresReview ||= snapshot.gradingMode === 'manual'; return { ...snapshot, id: item.question_id, version: item.question_version, score }; }); } return result; }
function assessmentPaperSummaryJson(row) {
  const paper = assessmentPaperJson(row, false);
  const summary = db.prepare(`SELECT COUNT(*) AS question_count, COALESCE(SUM(score), 0) AS total_score,
    MAX(CASE WHEN snapshot_json LIKE '%"gradingMode":"manual"%' THEN 1 ELSE 0 END) AS requires_review
    FROM assessment_paper_items WHERE paper_id = ?`).get(row.id);
  paper.questionCount = Number(summary?.question_count || 0);
  paper.totalScore = Number(summary?.total_score || 0);
  paper.requiresReview = Boolean(summary?.requires_review);
  return paper;
}
function assessmentPaperItemSpecs(body = {}, fallback = []) { const source = Array.isArray(body.items) ? body.items : Array.isArray(body.questionIds) ? body.questionIds.map(questionId => ({ questionId })) : fallback; const itemScores = body.itemScores && typeof body.itemScores === 'object' ? body.itemScores : {}; const used = new Set(); return source.map(item => { const questionId = Number(item?.questionId ?? item?.id ?? item); const suppliedScore = item?.score === undefined ? itemScores[questionId] : item.score; return { questionId, score: suppliedScore === '' || suppliedScore === undefined ? null : Number(suppliedScore) }; }).filter(item => Number.isSafeInteger(item.questionId) && item.questionId > 0 && !used.has(item.questionId) && (used.add(item.questionId) || true)).slice(0, 50); }
function assessmentLibraryAccess(user, libraryId, write = false) { const row = db.prepare('SELECT * FROM assessment_resource_libraries WHERE id = ?').get(libraryId); if (!row) return null; if (user.role === 'admin' || (!write && row.visibility === 'public') || Number(row.creator_id) === Number(user.id)) return row; return null; }
function assessmentQuestionAccess(user, questionId, write = false) { const row = db.prepare('SELECT * FROM assessment_questions WHERE id = ?').get(questionId); if (!row) return null; if (user.role === 'admin' || Number(row.creator_id) === Number(user.id) || (!write && row.status === 'published')) return row; return null; }
function assessmentPaperAccess(user, paperId, write = false) { const row = db.prepare('SELECT * FROM assessment_papers WHERE id = ?').get(paperId); if (!row) return null; if (user.role === 'admin' || Number(row.creator_id) === Number(user.id)) return row; return null; }
function assessmentQuestionInput(body = {}, current = null) {
  const existing = current ? assessmentSnapshot(current) : {};
  const source = current ? { ...existing, ...body, prompt: body.prompt ?? existing.prompt, answer: body.answer ?? existing.answer } : body;
  const subject = clean(source.subject, 12); const questionType = clean(source.questionType || source.type, 30); const answerMode = clean(source.answerMode || source.answer_mode, 30) || ({ single_choice: 'choice', multiple_choice: 'choice', true_false: 'choice', fill_blank: 'multi_text', ordering: 'ordering', image_writing: 'image', audio_speaking: 'audio' }[questionType] || 'text');
  const promptText = clean(source.promptText || (typeof source.prompt === 'object' ? source.prompt?.text : source.prompt) || source.question || source.stem || source.text, 3000);
  const options = Array.isArray(source.options) ? source.options.slice(0, 8).map((option, index) => ({ id: clean(option?.id, 24) || String(index + 1), text: clean(option?.text ?? option, 300) })) : (source.prompt?.options || []);
  const correct = source.correctAnswer ?? source.answer?.correct ?? source.answer ?? source.standardAnswer ?? '';
  const acceptable = source.acceptableAnswers ?? source.answer?.acceptable ?? [];
  const blanks = source.blanks ?? source.answer?.blanks ?? (Array.isArray(correct) ? correct : [correct]);
  const order = source.order ?? source.answer?.order ?? correct;
  const score = Number(source.score ?? 1); const gradingMode = clean(source.gradingMode || source.grading_mode, 24) || (['image_writing', 'audio_speaking'].includes(questionType) ? 'manual' : 'auto');
  return { subject, questionType, answerMode, promptJson: JSON.stringify({ text: promptText, options, allowAttachment: source.allowAttachment === true || source.prompt?.allowAttachment === true }), answerJson: JSON.stringify({ correct, acceptable: Array.isArray(acceptable) ? acceptable : [acceptable], blanks: Array.isArray(blanks) ? blanks : [blanks], order }), explanation: clean(source.explanation, 2000), score, gradingMode, gradingRulesJson: JSON.stringify(source.gradingRules || {}), grade: clean(source.grade, 30), difficulty: clean(source.difficulty, 20), tags: Array.isArray(source.tags) ? source.tags.map(tag => clean(tag, 30)).filter(Boolean).join(',') : clean(source.tags, 300), sourceSnapshotJson: JSON.stringify(source.source || {}) };
}
function assessmentAnswerValue(value) { return typeof value === 'string' ? value.trim().replace(/[\u3000]/g, ' ').replace(/\s+/g, ' ') : value; }
function assessmentAnswersEqual(expected, actual, mode = 'text') { if (Array.isArray(expected) || Array.isArray(actual)) { const a = (Array.isArray(actual) ? actual : [actual]).map(assessmentAnswerValue); const e = (Array.isArray(expected) ? expected : [expected]).map(assessmentAnswerValue); return mode === 'choice' ? a.length === e.length && a.every(item => e.includes(item)) : a.length === e.length && a.every((item, index) => item === e[index]); } return assessmentAnswerValue(expected) === assessmentAnswerValue(actual); }
function gradeAssessmentQuestion(question, answer) { const expected = question.answer || {}; const value = answer?.value ?? answer; if (question.gradingMode !== 'auto') return { result: 'manual', score: null }; if (question.questionType === 'multiple_choice') { const correct = assessmentAnswersEqual(expected.correct, value, 'choice'); return { result: correct ? 'correct' : 'wrong', score: correct ? question.score : 0 }; } if (question.questionType === 'ordering') { const correct = assessmentAnswersEqual(expected.order, value); return { result: correct ? 'correct' : 'wrong', score: correct ? question.score : 0 }; } const accepted = [expected.correct, ...(expected.acceptable || [])].filter(item => item !== '' && item !== null); const correct = accepted.some(item => assessmentAnswersEqual(item, value, question.answerMode === 'choice' ? 'choice' : 'text')); return { result: correct ? 'correct' : 'wrong', score: correct ? question.score : 0 }; }
function assessmentCanRetry(row, attempt) {
  const passScore = row.paper_id ? Number(db.prepare('SELECT pass_score FROM assessment_papers WHERE id = ?').get(row.paper_id)?.pass_score || 0) : 0;
  const attemptScore = Number(attempt?.final_score ?? attempt?.auto_score ?? 0);
  return Boolean(row.allow_retry) && passScore > 0 && attempt && ['auto_graded', 'finalized'].includes(attempt.status) && attemptScore < passScore && Number(attempt.version) <= Number(row.retry_limit || 0);
}
function studentAssessmentAnswersRevealed(row) {
  const attempt = db.prepare('SELECT * FROM assessment_attempts WHERE assignment_id = ? ORDER BY version DESC LIMIT 1').get(row.id);
  return row.task_status === 'completed' && !assessmentCanRetry(row, attempt);
}
function assessmentAssignmentJson(row, includeQuestions = false, reveal = false) { const attempt = db.prepare('SELECT * FROM assessment_attempts WHERE assignment_id = ? ORDER BY version DESC LIMIT 1').get(row.id); const review = attempt ? db.prepare("SELECT message FROM assessment_reviews WHERE attempt_id = ? AND action = 'approve' ORDER BY id DESC LIMIT 1").get(attempt.id) : null; const passScore = row.paper_id ? Number(db.prepare('SELECT pass_score FROM assessment_papers WHERE id = ?').get(row.paper_id)?.pass_score || 0) : 0; const canRetry = assessmentCanRetry(row, attempt); const canWithdraw = ['not_started', 'in_progress'].includes(row.task_status) && !attempt?.submitted_at; const result = { id: row.id, taskId: row.student_task_id, studentId: row.student_id, name: row.name, subject: row.subject, description: row.description, dueDate: row.due_date, deadline: row.deadline, duration: row.duration_minutes, stars: Number(row.stars), petExpWeight: Number(row.pet_exp_weight || 0), needsReview: Boolean(row.needs_review), explanationTiming: row.explanation_timing, allowRetry: Boolean(row.allow_retry), retryLimit: Number(row.retry_limit || 0), canRetry, canWithdraw, reviewMessage: review?.message || '', sourceType: row.source_type, paperId: row.paper_id, paperVersion: row.paper_version, passScore, taskStatus: row.task_status, questionCount: Number(db.prepare('SELECT COUNT(*) AS total FROM assessment_assignment_questions WHERE assignment_id = ?').get(row.id).total || 0), attempt: attempt ? { id: attempt.id, version: attempt.version, status: attempt.status, autoScore: attempt.auto_score, manualScore: attempt.manual_score, finalScore: attempt.final_score, totalScore: attempt.total_score, startedAt: attempt.started_at, submittedAt: attempt.submitted_at } : null }; if (includeQuestions) result.questions = db.prepare('SELECT * FROM assessment_assignment_questions WHERE assignment_id = ? ORDER BY sort_order').all(row.id).map(question => { const snapshot = parseJson(question.snapshot_json); if (!reveal) { delete snapshot.answer; delete snapshot.explanation; } const answer = attempt && db.prepare('SELECT * FROM assessment_answers WHERE attempt_id = ? AND assignment_question_id = ?').get(attempt.id, question.id); return { ...snapshot, id: question.id, questionId: question.question_id, sortOrder: question.sort_order, score: Number(question.score), ...(reveal ? { correctAnswer: snapshot.answer || null } : {}), savedAnswer: answer ? parseJson(answer.answer_json) : null, savedAttachments: answer ? parseJson(answer.attachment_json, []) : [], autoResult: answer?.auto_result || 'ungraded', autoScore: answer?.auto_score ?? null, finalScore: answer?.final_score ?? null }; }); return result; }
function assessmentAssignmentRow(id) { return db.prepare(`SELECT assessment_assignments.*, tasks.status AS task_status FROM assessment_assignments JOIN tasks ON tasks.id = assessment_assignments.student_task_id WHERE assessment_assignments.id = ?`).get(id); }
function assessmentTaskRow(taskId) { return db.prepare(`SELECT assessment_assignments.*, tasks.status AS task_status FROM assessment_assignments JOIN tasks ON tasks.id = assessment_assignments.student_task_id WHERE tasks.id = ?`).get(taskId); }
function assessmentVisibleToStudent(user, assignment) { return assignment && Number(assignment.student_id) === Number(user.id); }
function assessmentVisibleToParent(user, studentId) { return canManageStudent(user, Number(studentId)); }

function parentList() {
  const parents = db.prepare("SELECT id, username, display_name, avatar, active, created_at FROM users WHERE role = 'parent' ORDER BY id DESC").all();
  const linkedStudents = db.prepare(`SELECT users.id, users.display_name, users.avatar, users.active
    FROM parent_students JOIN users ON users.id = parent_students.student_id
    WHERE parent_students.parent_id = ? ORDER BY users.display_name`);
  return parents.map(parent => ({ id: parent.id, username: parent.username, displayName: parent.display_name, avatar: signStoredUrl(parent.avatar), active: Boolean(parent.active), createdAt: parent.created_at, students: linkedStudents.all(parent.id).map(student => ({ id: student.id, displayName: student.display_name, avatar: signStoredUrl(student.avatar), active: Boolean(student.active) })) }));
}

migrate();
seed();
ensurePetSpecies();
ensureBuiltInAdmin();

const mimeTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.weba': 'audio/webm', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.pdf': 'application/pdf', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8' };
function serveStatic(req, res, pathname) {
  const uploaded = localUploadPath(dataDir, pathname);
  if (uploaded) {
    if (storageDriver() !== 'local' || !existsSync(uploaded)) { res.writeHead(404); res.end('Not found'); return; }
    serveLocalFile(req, res, uploaded, mimeTypes[extname(uploaded)] || 'application/octet-stream'); return;
  }
  const requested = pathname === '/' ? '/index.html' : pathname;
  const file = normalize(join(root, requested));
  if (!file.startsWith(root) || !existsSync(file)) { res.writeHead(404); res.end('Not found'); return; }
  serveLocalFile(req, res, file, mimeTypes[extname(file)] || 'application/octet-stream', requested.includes('/assets/') ? 'public, max-age=86400' : 'no-cache');
}
function serveLocalFile(req, res, file, contentType, cacheControl = 'public, max-age=31536000, immutable') {
  const size = statSync(file).size;
  const range = req.headers.range;
  const baseHeaders = { 'content-type': contentType, 'accept-ranges': 'bytes', 'x-content-type-options': 'nosniff', 'cache-control': cacheControl };
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
    if (req.method === 'GET' && url.pathname === '/api/auth/recovery-email') {
      const user = requireUser(req, res); if (!user) return;
      const record = db.prepare('SELECT email_cipher, verified_at FROM recovery_emails WHERE user_id = ?').get(user.id);
      json(res, 200, { email: record ? maskedEmail(decryptRecoveryEmail(record.email_cipher)) : '', verified: Boolean(record?.verified_at) }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/recovery-email/request') {
      const user = requireUser(req, res); if (!user) return;
      if (!['parent', 'admin'].includes(user.role)) { bad(res, 403, '学生账号不能绑定找回邮箱'); return; }
      const body = await readBody(req); const email = clean(body.email, 160).toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { bad(res, 400, '请输入有效邮箱地址'); return; }
      const currentEmail = db.prepare('SELECT email_hash FROM recovery_emails WHERE user_id = ? AND verified_at IS NOT NULL').get(user.id);
      if (currentEmail?.email_hash === hashToken(email)) { bad(res, 409, '该邮箱已绑定，无需重复验证'); return; }
      if (recoveryCodeLimitReached(email)) { bad(res, 429, '该邮箱 1 小时内验证码发送次数已达上限，请联系管理员'); return; }
      const code = String(randomInt(100000, 1000000));
      db.prepare("DELETE FROM recovery_codes WHERE user_id = ? AND purpose = 'bind_email'").run(user.id);
      db.prepare('INSERT INTO recovery_codes (user_id,purpose,code_hash,expires_at,request_ip,target_hash,created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(user.id, 'bind_email', hashToken(code), new Date(unix() + RECOVERY_CODE_TTL_MS).toISOString(), ip, hashToken(email), now());
      try { await sendRecoveryCode(email, code); } catch { bad(res, 503, '验证码发送失败，请稍后重试'); return; }
      json(res, 200, { ok: true, maskedEmail: maskedEmail(email) }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/recovery-email/verify') {
      const user = requireUser(req, res); if (!user) return;
      const body = await readBody(req); const email = clean(body.email, 160).toLowerCase(); const code = clean(body.code, 12);
      const record = db.prepare("SELECT * FROM recovery_codes WHERE user_id = ? AND purpose = 'bind_email' AND used_at IS NULL AND expires_at > ? ORDER BY id DESC LIMIT 1").get(user.id, now());
      if (!record || record.code_hash !== hashToken(code)) { bad(res, 400, '验证码不正确或已过期'); return; }
      db.prepare('UPDATE recovery_codes SET used_at = ? WHERE id = ?').run(now(), record.id);
      const timestamp = now();
      db.prepare(`INSERT INTO recovery_emails (user_id,email_cipher,email_hash,verified_at,created_at,updated_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET email_cipher = excluded.email_cipher, email_hash = excluded.email_hash, verified_at = excluded.verified_at, updated_at = excluded.updated_at`).run(user.id, encryptRecoveryEmail(email), hashToken(email), timestamp, timestamp, timestamp);
      db.prepare('INSERT INTO security_logs (user_id,action,request_ip,created_at) VALUES (?, ?, ?, ?)').run(user.id, 'bind_recovery_email', ip, timestamp);
      json(res, 200, { ok: true, email: maskedEmail(email) }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/recovery/request') {
      const body = await readBody(req); const username = clean(body.username, 48); const email = clean(body.email, 160).toLowerCase();
      if (!username) { bad(res, 400, '请输入用户名'); return; }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { bad(res, 400, '请输入有效邮箱地址'); return; }
      const user = db.prepare("SELECT users.id, users.role FROM users JOIN recovery_emails ON recovery_emails.user_id = users.id WHERE users.username = ? AND users.active = 1 AND users.role IN ('parent','admin') AND recovery_emails.email_hash = ?").get(username, hashToken(email));
      if (user) {
        if (recoveryCodeLimitReached(email)) { bad(res, 429, '该邮箱 1 小时内验证码发送次数已达上限，请联系管理员'); return; }
        const code = String(randomInt(100000, 1000000));
        try { await sendRecoveryCode(email, code); } catch (error) { console.error('找回密码验证码发送失败：', error.message); bad(res, 503, '验证码暂时无法发送，请稍后重试或联系管理员'); return; }
        db.prepare("DELETE FROM recovery_codes WHERE user_id = ? AND purpose = 'reset_password'").run(user.id);
        db.prepare('INSERT INTO recovery_codes (user_id,purpose,code_hash,expires_at,request_ip,target_hash,created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(user.id, 'reset_password', hashToken(code), new Date(unix() + RECOVERY_CODE_TTL_MS).toISOString(), ip, hashToken(email), now());
        json(res, 200, { ok: true, sent: true, maskedEmail: maskedEmail(email), message: '验证码已发送，请检查邮箱。' }); return;
      }
      bad(res, 400, '账号和已绑定邮箱不匹配，请检查后重试'); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/recovery/reset') {
      const body = await readBody(req); const username = clean(body.username, 48); const email = clean(body.email, 160).toLowerCase(); const code = clean(body.code, 12); const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
      if (newPassword.length < 10 || !/[A-Za-z]/.test(newPassword) || !/\d/.test(newPassword)) { bad(res, 400, '新密码至少 10 位，并包含字母和数字'); return; }
      const user = db.prepare("SELECT users.id FROM users JOIN recovery_emails ON recovery_emails.user_id = users.id WHERE users.username = ? AND users.active = 1 AND users.role IN ('parent','admin') AND recovery_emails.email_hash = ?").get(username, hashToken(email));
      const record = user && db.prepare("SELECT * FROM recovery_codes WHERE user_id = ? AND purpose = 'reset_password' AND used_at IS NULL AND expires_at > ? ORDER BY id DESC LIMIT 1").get(user.id, now());
      if (!user || !record || record.code_hash !== hashToken(code)) { bad(res, 400, '验证码不正确或已过期'); return; }
      db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hashPassword(newPassword), user.id);
      db.prepare('UPDATE recovery_codes SET used_at = ? WHERE id = ?').run(now(), record.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
      db.prepare('INSERT INTO security_logs (user_id,action,request_ip,created_at) VALUES (?, ?, ?, ?)').run(user.id, 'reset_password', ip, now());
      json(res, 200, { ok: true }); return;
    }
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
      json(res, 200, { user: publicUser(user) }, { 'set-cookie': secureCookie(req, 'lp_session', token, sessionTtl) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
      const token = cookieValue(req, 'lp_session');
      if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(createHash('sha256').update(token).digest('hex'));
      json(res, 204, {}, { 'set-cookie': secureCookie(req, 'lp_session', '', -1) });
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
    if (req.method === 'GET' && url.pathname === '/api/student/pet') {
      const user = requireUser(req, res); if (!user || user.role !== 'student') return;
      json(res, 200, { pet: petOverview(user.id, false) }); return;
    }
    if (req.method === 'PATCH' && url.pathname === '/api/student/pet') {
      const user = requireUser(req, res); if (!user || user.role !== 'student') return;
      const pet = activePetForStudent(user.id); if (!pet) { bad(res, 404, '尚未领养萌宠'); return; }
      const body = await readBody(req); const nickname = normalizePetNickname(body.nickname);
      if (!nickname) { bad(res, 400, '萌宠名字需为 1 至 12 个字符'); return; }
      db.prepare('UPDATE student_pets SET nickname = ? WHERE id = ? AND student_id = ?').run(nickname, pet.id, user.id);
      json(res, 200, { pet: petOverview(user.id, false) }); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/student/pets/adoption') {
      const user = requireUser(req, res); if (!user || user.role !== 'student') return;
      const settings = db.prepare('SELECT enabled FROM student_pet_settings WHERE student_id = ?').get(user.id);
      const current = activePetForStudent(user.id);
      const species = db.prepare("SELECT * FROM pet_species WHERE status = 'active' ORDER BY sort_order, id").all().map(item => ({ ...petSpeciesJson(item), available: AVAILABLE_PET_SPECIES.has(item.code) }));
      json(res, 200, { enabled: Boolean(settings?.enabled), adopted: Boolean(current), species }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/student/pets/adopt') {
      const user = requireUser(req, res); if (!user || user.role !== 'student') return;
      const settings = db.prepare('SELECT enabled FROM student_pet_settings WHERE student_id = ?').get(user.id);
      if (!settings?.enabled) { bad(res, 409, '请先让家长开启萌宠模块'); return; }
      if (activePetForStudent(user.id)) { bad(res, 409, '你已经领养过萌宠了'); return; }
      const body = await readBody(req); const speciesCode = clean(body.speciesCode, 40); const nickname = clean(body.nickname, 12);
      const species = db.prepare("SELECT * FROM pet_species WHERE code = ? AND status = 'active'").get(speciesCode);
      if (!species) { bad(res, 400, '请选择有效的萌宠'); return; }
      if (!AVAILABLE_PET_SPECIES.has(speciesCode)) { bad(res, 409, '该萌宠暂未开放，敬请期待'); return; }
      if (!nickname || Array.from(nickname).length < 1 || Array.from(nickname).length > 12 || /https?:\/\//i.test(nickname)) { bad(res, 400, '昵称需为 1 至 12 个字符'); return; }
      const timestamp = now(); db.exec('BEGIN');
      try {
        const result = db.prepare('INSERT INTO student_pets (student_id,species_id,nickname,level,total_exp,active,status,adopted_at) VALUES (?,?,?,1,0,1,\'active\',?)').run(user.id, species.id, nickname, timestamp);
        const petId = Number(result.lastInsertRowid);
        ensurePetDailyState(petId, businessDate());
        db.prepare("INSERT INTO pet_inventory (student_pet_id,item_code,quantity,updated_at) VALUES (?, 'basic_food', 0, ?)").run(petId, timestamp);
        db.prepare('INSERT OR IGNORE INTO pet_unlocks (student_pet_id,content_type,content_code,condition_snapshot,unlocked_at) VALUES (?, \'scene\', \'star-home\', ?, ?)').run(petId, JSON.stringify({ condition: 'adoption' }), timestamp);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      json(res, 201, { pet: petOverview(user.id, false) }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/student/pet/interactions') {
      const user = requireUser(req, res); if (!user || user.role !== 'student') return;
      const overview = petOverview(user.id, false); const pet = activePetForStudent(user.id);
      if (!overview.enabled || !pet) { bad(res, 409, '请先开启并领养萌宠'); return; }
      const body = await readBody(req); const type = clean(body.type, 12); const requestId = clean(body.requestId, 100); const supported = Object.keys(PET_INTERACTION_EXP);
      if (!supported.includes(type) || !requestId) { bad(res, 400, '互动参数不正确'); return; }
      const date = businessDate(); const daily = ensurePetDailyState(pet.id, date);
      const changes = { pet: ['mood', 10], feed: ['satiety', 20], clean: ['cleanliness', 20], play: ['mood', 20] }[type];
      const stateAtLimit = Number(daily[changes[0]] || 0) >= 100;
      if (type !== 'feed' && stateAtLimit) { json(res, 200, { alreadyDone: false, applied: false, earnedExp: 0, message: '该状态已达到 100，上限后不会继续增加经验', pet: petOverview(user.id, false) }); return; }
      if (type === 'feed' && Number(db.prepare("SELECT quantity FROM pet_inventory WHERE student_pet_id = ? AND item_code = 'basic_food'").get(pet.id)?.quantity || 0) < 1) { bad(res, 409, '今天没有可用的基础食物'); return; }
      const timestamp = now(); db.exec('BEGIN'); let interactionId;
      try {
        db.prepare(`UPDATE pet_daily_states SET ${changes[0]} = MIN(100, ${changes[0]} + ?) WHERE student_pet_id = ? AND business_date = ?`).run(changes[1], pet.id, date);
        if (type === 'feed') db.prepare("UPDATE pet_inventory SET quantity = quantity - 1, updated_at = ? WHERE student_pet_id = ? AND item_code = 'basic_food' AND quantity > 0").run(timestamp, pet.id);
        interactionId = Number(db.prepare('INSERT INTO pet_interactions (student_pet_id,business_date,type,request_id,exp_delta,inventory_delta,created_at) VALUES (?,?,?,?,?,?,?)').run(pet.id, date, type, requestId, 0, type === 'feed' ? -1 : 0, timestamp).lastInsertRowid);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      const requestedDelta = stateAtLimit ? 0 : PET_INTERACTION_EXP[type];
      publishPetEvent({ eventType: 'INTERACTION', sourceType: 'interaction', sourceId: `${date}:${type}:${interactionId}`, interactionId, studentId: user.id, petId: pet.id, businessDate: date, requestedDelta, occurredAt: timestamp, reason: `完成${type === 'pet' ? '摸摸' : type === 'feed' ? '喂食' : type === 'clean' ? '清洁' : '玩耍'}` });
      json(res, 200, { alreadyDone: false, applied: true, earnedExp: requestedDelta, message: stateAtLimit ? '饱足已达到 100，已完成喂食但不增加经验' : '', pet: petOverview(user.id, false) }); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/student/pet/growth') {
      const user = requireUser(req, res); if (!user || user.role !== 'student') return;
      json(res, 200, { pet: petOverview(user.id, true) }); return;
    }
    if (req.method === 'GET' && /^\/api\/parent\/students\/\d+\/pet$/.test(url.pathname)) {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return;
      const studentId = Number(url.pathname.split('/')[4]); if (!canManageStudent(user, studentId)) { bad(res, 403, '无权查看该学生萌宠'); return; }
      json(res, 200, { pet: petOverview(studentId, false) }); return;
    }
    if (req.method === 'PATCH' && /^\/api\/parent\/students\/\d+\/pet$/.test(url.pathname)) {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return;
      const studentId = Number(url.pathname.split('/')[4]); if (!canManageStudent(user, studentId)) { bad(res, 403, '无权修改该学生萌宠'); return; }
      const pet = activePetForStudent(studentId); if (!pet) { bad(res, 404, '该学生尚未领养萌宠'); return; }
      const body = await readBody(req); const nickname = normalizePetNickname(body.nickname);
      if (!nickname) { bad(res, 400, '萌宠名字需为 1 至 12 个字符'); return; }
      db.prepare('UPDATE student_pets SET nickname = ? WHERE id = ? AND student_id = ?').run(nickname, pet.id, studentId);
      json(res, 200, { pet: petOverview(studentId, false) }); return;
    }
    if (req.method === 'PUT' && /^\/api\/parent\/students\/\d+\/pet-settings$/.test(url.pathname)) {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return;
      const studentId = Number(url.pathname.split('/')[4]); if (!canManageStudent(user, studentId)) { bad(res, 403, '无权设置该学生萌宠'); return; }
      const body = await readBody(req); if (typeof body.enabled !== 'boolean') { bad(res, 400, '萌宠模块状态参数不正确'); return; }
      const dailyMinutes = Number(body.dailyMinutes ?? 10); if (![0, 5, 10, 15].includes(dailyMinutes)) { bad(res, 400, '互动时长设置不正确'); return; }
      const nickname = body.nickname === undefined ? null : normalizePetNickname(body.nickname);
      if (body.nickname !== undefined && !nickname) { bad(res, 400, '萌宠名字需为 1 至 12 个字符'); return; }
      const current = db.prepare('SELECT enabled_at FROM student_pet_settings WHERE student_id = ?').get(studentId); const timestamp = now();
      db.prepare(`INSERT INTO student_pet_settings (student_id,enabled,enabled_at,daily_minutes,sound_enabled,reduced_motion,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(student_id) DO UPDATE SET enabled=excluded.enabled, enabled_at=CASE WHEN excluded.enabled=1 AND student_pet_settings.enabled_at IS NULL THEN excluded.enabled_at ELSE student_pet_settings.enabled_at END, daily_minutes=excluded.daily_minutes, sound_enabled=excluded.sound_enabled, reduced_motion=excluded.reduced_motion, updated_by=excluded.updated_by, updated_at=excluded.updated_at`).run(studentId, body.enabled ? 1 : 0, body.enabled && !current?.enabled_at ? timestamp : current?.enabled_at || null, dailyMinutes, body.soundEnabled === false ? 0 : 1, body.reducedMotion === true ? 1 : 0, user.id, timestamp);
      if (nickname !== null) {
        const pet = activePetForStudent(studentId);
        if (!pet) { bad(res, 404, '该学生尚未领养萌宠'); return; }
        db.prepare('UPDATE student_pets SET nickname = ? WHERE id = ? AND student_id = ?').run(nickname, pet.id, studentId);
      }
      json(res, 200, { pet: petOverview(studentId, false) }); return;
    }
    if (req.method === 'GET' && /^\/api\/parent\/students\/\d+\/pet-ledger$/.test(url.pathname)) {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return;
      const studentId = Number(url.pathname.split('/')[4]); if (!canManageStudent(user, studentId)) { bad(res, 403, '无权查看该学生成长流水'); return; }
      const pet = activePetForStudent(studentId); if (!pet) { json(res, 200, { ledger: [] }); return; }
      const sourceType = clean(url.searchParams.get('sourceType'), 30); const conditions = ['student_pet_id = ?']; const params = [pet.id];
      if (sourceType) { conditions.push('source_type = ?'); params.push(sourceType); }
      const ledger = db.prepare(`SELECT id,business_date,source_type,source_id,requested_delta,delta,balance_after,reason,rule_snapshot,created_at FROM pet_exp_ledger WHERE ${conditions.join(' AND ')} ORDER BY id DESC LIMIT 100`).all(...params);
      json(res, 200, { ledger: ledger.map(item => ({ id: item.id, businessDate: item.business_date, sourceType: item.source_type, sourceId: item.source_id, requestedDelta: Number(item.requested_delta), delta: Number(item.delta), balanceAfter: Number(item.balance_after), reason: item.reason, ruleSnapshot: item.rule_snapshot, createdAt: item.created_at })) }); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/student/assessments') {
      const user = requireUser(req, res); if (!user || user.role !== 'student') return;
      const paging = assessmentPagination(url); const where = 'assessment_assignments.student_id = ? AND tasks.is_demo = 0';
      const total = Number(db.prepare(`SELECT COUNT(*) AS total FROM assessment_assignments JOIN tasks ON tasks.id = assessment_assignments.student_task_id WHERE ${where}`).get(user.id).total || 0);
      const pendingCount = Number(db.prepare(`SELECT COUNT(*) AS total FROM assessment_assignments JOIN tasks ON tasks.id = assessment_assignments.student_task_id WHERE ${where} AND tasks.status IN ('not_started','in_progress','needs_more')`).get(user.id).total || 0);
      const rows = db.prepare(`SELECT assessment_assignments.*, tasks.status AS task_status FROM assessment_assignments JOIN tasks ON tasks.id = assessment_assignments.student_task_id WHERE ${where} ORDER BY CASE tasks.status WHEN 'not_started' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'needs_more' THEN 2 WHEN 'pending_review' THEN 3 WHEN 'completed' THEN 4 ELSE 5 END, assessment_assignments.due_date DESC, assessment_assignments.id DESC LIMIT ? OFFSET ?`).all(user.id, paging.pageSize, paging.offset);
      json(res, 200, { assessments: rows.map(row => assessmentAssignmentJson(row)), pendingCount, pagination: assessmentPaginationMeta(total, paging) }); return;
    }
    if (req.method === 'GET' && /^\/api\/student\/assessments\/\d+$/.test(url.pathname)) {
      const user = requireUser(req, res); if (!user || user.role !== 'student') return;
      const taskId = Number(url.pathname.split('/').pop()); const row = assessmentTaskRow(taskId);
      if (!assessmentVisibleToStudent(user, row)) { bad(res, 404, '评测不存在'); return; }
      json(res, 200, { assessment: assessmentAssignmentJson(row, true, studentAssessmentAnswersRevealed(row)) }); return;
    }
    if (req.method === 'POST' && /^\/api\/student\/assessments\/\d+\/start$/.test(url.pathname)) {
      const user = requireUser(req, res); if (!user || user.role !== 'student') return;
      const taskId = Number(url.pathname.split('/')[4]); const row = assessmentTaskRow(taskId); if (!assessmentVisibleToStudent(user, row)) { bad(res, 404, '评测不存在'); return; }
      if (['completed', 'pending_review'].includes(row.task_status)) { bad(res, 409, '该评测已经提交，请查看最新状态'); return; }
      let attempt = db.prepare('SELECT * FROM assessment_attempts WHERE assignment_id = ? AND status IN (\'draft\',\'returned\') ORDER BY version DESC LIMIT 1').get(row.id);
      const timestamp = now();
      if (!attempt) { const version = Number(db.prepare('SELECT COALESCE(MAX(version),0) AS version FROM assessment_attempts WHERE assignment_id = ?').get(row.id).version || 0) + 1; const total = Number(db.prepare('SELECT COALESCE(SUM(score),0) AS total FROM assessment_assignment_questions WHERE assignment_id = ?').get(row.id).total || 0); const result = db.prepare('INSERT INTO assessment_attempts (assignment_id,version,status,started_at,total_score,created_at,updated_at) VALUES (?, ?, \'draft\', ?, ?, ?, ?)').run(row.id, version, timestamp, total, timestamp, timestamp); attempt = db.prepare('SELECT * FROM assessment_attempts WHERE id = ?').get(Number(result.lastInsertRowid)); }
      db.prepare("UPDATE tasks SET status='in_progress', started_at=COALESCE(started_at, ?), draft_updated_at=? WHERE id=?").run(timestamp, timestamp, taskId);
      json(res, 200, { assessment: assessmentAssignmentJson({ ...row, task_status: 'in_progress' }, true, false) }); return;
    }
    if (req.method === 'PUT' && /^\/api\/student\/assessments\/\d+\/answers\/\d+$/.test(url.pathname)) {
      const user = requireUser(req, res); if (!user || user.role !== 'student') return;
      const parts = url.pathname.split('/'); const taskId = Number(parts[4]); const questionId = Number(parts[6]); const row = assessmentTaskRow(taskId);
      if (!assessmentVisibleToStudent(user, row)) { bad(res, 404, '评测不存在'); return; }
      let attempt = db.prepare('SELECT * FROM assessment_attempts WHERE assignment_id = ? AND status IN (\'draft\',\'returned\') ORDER BY version DESC LIMIT 1').get(row.id);
      if (!attempt) { bad(res, 409, '请先开始评测'); return; }
      const question = db.prepare('SELECT * FROM assessment_assignment_questions WHERE id = ? AND assignment_id = ?').get(questionId, row.id); if (!question) { bad(res, 404, '题目不存在'); return; }
      const body = await readBody(req, 10 * 1024 * 1024); const value = Object.hasOwn(body, 'answer') ? body.answer : body.value; const attachment = Array.isArray(body.attachments) ? body.attachments.slice(0, 3) : [];
      const timestamp = now(); db.prepare(`INSERT INTO assessment_answers (attempt_id,assignment_question_id,answer_json,attachment_json,auto_result,answered_at) VALUES (?,?,?,?,?,?) ON CONFLICT(attempt_id,assignment_question_id) DO UPDATE SET answer_json=excluded.answer_json, attachment_json=excluded.attachment_json, answered_at=excluded.answered_at`).run(attempt.id, question.id, JSON.stringify({ value }), JSON.stringify(attachment), 'ungraded', timestamp);
      db.prepare('UPDATE assessment_attempts SET updated_at=? WHERE id=?').run(timestamp, attempt.id); db.prepare('UPDATE tasks SET draft_updated_at=? WHERE id=?').run(timestamp, taskId);
      json(res, 200, { ok: true, saved: true }); return;
    }
    if (req.method === 'POST' && /^\/api\/student\/assessments\/\d+\/submit$/.test(url.pathname)) {
      const user = requireUser(req, res); if (!user || user.role !== 'student') return;
      const taskId = Number(url.pathname.split('/')[4]); const row = assessmentTaskRow(taskId); if (!assessmentVisibleToStudent(user, row)) { bad(res, 404, '评测不存在'); return; }
      const body = await readBody(req, 256 * 1024); const requestId = clean(body.requestId, 120) || hashToken(`${user.id}:${taskId}:${Date.now()}`);
      const prior = db.prepare('SELECT * FROM assessment_attempts WHERE submit_request_id = ? LIMIT 1').get(requestId); if (prior) { json(res, 200, { assessment: assessmentAssignmentJson(assessmentTaskRow(taskId), true, false) }); return; }
      let attempt = db.prepare('SELECT * FROM assessment_attempts WHERE assignment_id = ? AND status IN (\'draft\',\'returned\') ORDER BY version DESC LIMIT 1').get(row.id); if (!attempt) { bad(res, 409, '请先开始评测'); return; }
      if (attempt.submit_request_id) { json(res, 200, { assessment: assessmentAssignmentJson(row, true, false) }); return; }
      const questions = db.prepare('SELECT * FROM assessment_assignment_questions WHERE assignment_id = ? ORDER BY sort_order').all(row.id); const answers = db.prepare('SELECT * FROM assessment_answers WHERE attempt_id = ?').all(attempt.id); const answerMap = new Map(answers.map(answer => [answer.assignment_question_id, answer]));
      const missing = []; let autoScore = 0; let hasManual = false;
      for (const question of questions) { const snapshot = parseJson(question.snapshot_json); const answer = answerMap.get(question.id); const answerValue = parseJson(answer?.answer_json, {}).value; const attachment = parseJson(answer?.attachment_json, []); const hasValue = (Array.isArray(answerValue) ? answerValue.length > 0 : String(answerValue ?? '').trim() !== '') || attachment.length > 0; if (!hasValue) missing.push(question.sort_order); const graded = gradeAssessmentQuestion({ ...snapshot, score: Number(question.score) }, { value: answerValue }); if (graded.result === 'manual') hasManual = true; else { autoScore += Number(graded.score || 0); if (answer) db.prepare('UPDATE assessment_answers SET auto_result=?, auto_score=?, final_score=? WHERE id=?').run(graded.result, graded.score, graded.score, answer.id); } }
      if (missing.length) { bad(res, 400, `还有 ${missing.length} 道题没有完成，再检查一下吧（第 ${missing.join('、')} 题）`); return; }
      const needsReview = Boolean(row.needs_review) || hasManual; const status = needsReview ? 'pending_review' : 'auto_graded'; const finalScore = needsReview ? null : autoScore; const timestamp = now(); db.prepare('UPDATE assessment_attempts SET status=?, submitted_at=?, auto_score=?, final_score=?, submit_request_id=?, updated_at=? WHERE id=?').run(status, timestamp, autoScore, finalScore, requestId, timestamp, attempt.id); db.prepare("UPDATE tasks SET status=?, submitted_at=?, draft_updated_at=? WHERE id=?").run(needsReview ? 'pending_review' : 'completed', timestamp, timestamp, taskId);
      if (!needsReview) { db.prepare('DELETE FROM rewards WHERE task_id = ?').run(taskId); db.prepare('INSERT INTO rewards (student_id,task_id,stars,message,created_at) VALUES (?,?,?,?,?)').run(user.id, taskId, row.stars, '评测完成，做得很棒！', timestamp); const pet = activePetForStudent(user.id); publishPetEvent({ eventType: 'ASSESSMENT_FINALIZED', sourceType: 'assessment_complete', sourceId: String(taskId), studentId: user.id, petId: pet?.id || null, businessDate: row.due_date, requestedDelta: 10 * Math.max(0, Number(row.pet_exp_weight) || 0), occurredAt: timestamp, reason: `完成评测：${row.name}` }); }
      const latest = assessmentTaskRow(taskId); json(res, 200, { assessment: assessmentAssignmentJson(latest, true, studentAssessmentAnswersRevealed(latest)) }); return;
    }
    if (req.method === 'GET' && /^\/api\/student\/assessments\/\d+\/result$/.test(url.pathname)) {
      const user = requireUser(req, res); if (!user || user.role !== 'student') return;
      const taskId = Number(url.pathname.split('/')[4]); const row = assessmentTaskRow(taskId); if (!assessmentVisibleToStudent(user, row)) { bad(res, 404, '评测不存在'); return; }
      const attempt = db.prepare("SELECT * FROM assessment_attempts WHERE assignment_id = ? AND status IN ('auto_graded','finalized') ORDER BY version DESC LIMIT 1").get(row.id); if (!attempt) { bad(res, 409, '评测结果尚未生成'); return; }
      json(res, 200, { assessment: assessmentAssignmentJson(row, true, studentAssessmentAnswersRevealed(row)) }); return;
    }
    if (req.method === 'POST' && /^\/api\/student\/assessments\/\d+\/retry$/.test(url.pathname)) {
      const user = requireUser(req, res); if (!user || user.role !== 'student') return;
      const taskId = Number(url.pathname.split('/')[4]); const row = assessmentTaskRow(taskId); if (!assessmentVisibleToStudent(user, row)) { bad(res, 404, '评测不存在'); return; }
      const latest = db.prepare('SELECT * FROM assessment_attempts WHERE assignment_id = ? ORDER BY version DESC LIMIT 1').get(row.id); const passScore = row.paper_id ? Number(db.prepare('SELECT pass_score FROM assessment_papers WHERE id = ?').get(row.paper_id)?.pass_score || 0) : 0; const latestScore = Number(latest?.final_score ?? latest?.auto_score ?? 0); if (!row.allow_retry || !latest || !['auto_graded', 'finalized'].includes(latest.status) || passScore <= 0 || latestScore >= passScore || Number(latest.version) > Number(row.retry_limit || 0)) { bad(res, 409, '当前评测不允许重新作答'); return; }
      const timestamp = now(); const version = Number(latest.version) + 1; const total = Number(db.prepare('SELECT COALESCE(SUM(score),0) AS total FROM assessment_assignment_questions WHERE assignment_id=?').get(row.id).total || 0); const result = db.prepare('INSERT INTO assessment_attempts (assignment_id,version,status,started_at,total_score,created_at,updated_at) VALUES (?, ?, \'draft\', ?, ?, ?, ?)').run(row.id, version, timestamp, total, timestamp, timestamp); db.prepare("UPDATE tasks SET status='in_progress', started_at=COALESCE(started_at,?), draft_updated_at=? WHERE id=?").run(timestamp, timestamp, taskId); json(res, 200, { attemptId: Number(result.lastInsertRowid), assessment: assessmentAssignmentJson({ ...row, task_status: 'in_progress' }, true, false) }); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/parent/assessment-resource-libraries') {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return; const conditions = user.role === 'admin' ? [] : ['(creator_id = ? OR visibility = \'public\')']; const params = user.role === 'admin' ? [] : [user.id]; const subject = clean(url.searchParams.get('subject'), 12); const status = clean(url.searchParams.get('status'), 12); const q = clean(url.searchParams.get('q'), 120); const paging = assessmentPagination(url); if (subject) { conditions.push('subject = ?'); params.push(subject); } if (status) { conditions.push('status = ?'); params.push(status); } if (q) { conditions.push('(name LIKE ? OR description LIKE ?)'); params.push(`%${q}%`, `%${q}%`); } const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''; const total = Number(db.prepare(`SELECT COUNT(*) AS total FROM assessment_resource_libraries ${where}`).get(...params).total || 0); const rows = db.prepare(`SELECT * FROM assessment_resource_libraries ${where} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`).all(...params, paging.pageSize, paging.offset); json(res, 200, { libraries: rows.map(row => ({ id: row.id, name: row.name, subject: row.subject, resourceType: row.resource_type, grade: row.grade, termUnit: row.term_unit, description: row.description, visibility: row.visibility, status: row.status, version: row.version, creatorId: row.creator_id, itemCount: Number(db.prepare('SELECT COUNT(*) AS total FROM assessment_resource_items WHERE library_id = ? AND status = \'enabled\'').get(row.id).total || 0), createdAt: row.created_at, updatedAt: row.updated_at })), pagination: assessmentPaginationMeta(total, paging) }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/parent/assessment-resource-libraries') {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return; const body = await readBody(req); const name = clean(body.name, 120); const subject = clean(body.subject, 12); const resourceType = clean(body.resourceType || body.type, 30); if (!name || !ASSESSMENT_SUBJECTS.has(subject) || !resourceType) { bad(res, 400, '请填写资源库名称、科目和资源类型'); return; } const visibility = user.role === 'admin' && body.visibility === 'public' ? 'public' : 'private'; const timestamp = now(); const result = db.prepare('INSERT INTO assessment_resource_libraries (name,subject,resource_type,grade,term_unit,description,visibility,status,creator_id,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,\'enabled\',?,1,?,?)').run(name, subject, resourceType, clean(body.grade, 30), clean(body.termUnit || body.term, 80), clean(body.description, 600), visibility, user.id, timestamp, timestamp); const row = db.prepare('SELECT * FROM assessment_resource_libraries WHERE id=?').get(Number(result.lastInsertRowid)); json(res, 201, { library: { id: row.id, name: row.name, subject: row.subject, resourceType: row.resource_type, grade: row.grade, termUnit: row.term_unit, description: row.description, visibility: row.visibility, status: row.status, version: row.version } }); return;
    }
    if (req.method === 'PATCH' && /^\/api\/parent\/assessment-resource-libraries\/\d+$/.test(url.pathname)) {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return; const id = Number(url.pathname.split('/').pop()); const current = assessmentLibraryAccess(user, id, true); if (!current) { bad(res, 404, '资源库不存在或无权修改'); return; } const body = await readBody(req); const name = clean(body.name ?? current.name, 120); const subject = clean(body.subject ?? current.subject, 12); const resourceType = clean(body.resourceType ?? current.resource_type, 30); const description = clean(body.description ?? current.description, 600); const grade = clean(body.grade ?? current.grade, 30); const termUnit = clean(body.termUnit ?? current.term_unit, 80); const status = ['draft', 'enabled', 'archived'].includes(body.status) ? body.status : current.status; if (!name || !ASSESSMENT_SUBJECTS.has(subject) || !resourceType) { bad(res, 400, '请填写资源库名称、科目和资源类型'); return; } db.prepare('UPDATE assessment_resource_libraries SET name=?,subject=?,resource_type=?,description=?,grade=?,term_unit=?,status=?,version=version+1,updated_at=? WHERE id=?').run(name, subject, resourceType, description, grade, termUnit, status, now(), id); const row = db.prepare('SELECT * FROM assessment_resource_libraries WHERE id=?').get(id); json(res, 200, { library: { id: row.id, name: row.name, subject: row.subject, resourceType: row.resource_type, grade: row.grade, termUnit: row.term_unit, description: row.description, visibility: row.visibility, status: row.status, version: row.version } }); return;
    }
    if (req.method === 'DELETE' && /^\/api\/parent\/assessment-resource-libraries\/\d+$/.test(url.pathname)) {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return; const id = Number(url.pathname.split('/').pop()); const library = assessmentLibraryAccess(user, id, true); if (!library) { bad(res, 404, '资源库不存在或无权删除'); return; } db.prepare('DELETE FROM assessment_resource_libraries WHERE id=?').run(id); json(res, 200, { deleted: true, id }); return;
    }
    if (req.method === 'GET' && /^\/api\/parent\/assessment-resource-libraries\/\d+\/items$/.test(url.pathname)) {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return; const id = Number(url.pathname.split('/')[4]); if (!assessmentLibraryAccess(user, id)) { bad(res, 404, '资源库不存在或无权查看'); return; }
      const q = clean(url.searchParams.get('q'), 120); const category = clean(url.searchParams.get('category'), 30); const conditions = ["library_id = ?", "status <> 'archived'"]; const params = [id]; if (q) { conditions.push('(content LIKE ? OR tags LIKE ? OR note LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); } if (category) { conditions.push('tags LIKE ?'); params.push(`%${category}%`); } const rows = db.prepare(`SELECT * FROM assessment_resource_items WHERE ${conditions.join(' AND ')} ORDER BY sort_order, id`).all(...params); json(res, 200, { items: rows.map(item => ({ id: item.id, libraryId: item.library_id, content: item.content, extra: parseJson(item.extra_json), tags: item.tags.split(',').filter(Boolean), difficulty: item.difficulty, note: item.note, sortOrder: item.sort_order, status: item.status, version: item.version })) }); return;
    }
    if (req.method === 'DELETE' && /^\/api\/parent\/assessment-resource-libraries\/\d+\/items$/.test(url.pathname)) {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return; const libraryId = Number(url.pathname.split('/')[4]); const library = assessmentLibraryAccess(user, libraryId, true); if (!library) { bad(res, 404, '资源库不存在或无权删除'); return; } const body = await readBody(req); const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map(Number).filter(Number.isInteger))]; if (!ids.length) { bad(res, 400, '请选择要删除的资源内容'); return; } const placeholders = ids.map(() => '?').join(','); const existing = db.prepare(`SELECT COUNT(*) AS total FROM assessment_resource_items WHERE library_id=? AND id IN (${placeholders})`).get(libraryId, ...ids); if (Number(existing.total) !== ids.length) { bad(res, 404, '部分资源内容不存在或无权删除'); return; } db.exec('BEGIN'); try { db.prepare(`DELETE FROM assessment_resource_items WHERE library_id=? AND id IN (${placeholders})`).run(libraryId, ...ids); db.prepare('UPDATE assessment_resource_libraries SET version=version+1,updated_at=? WHERE id=?').run(now(), libraryId); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; } json(res, 200, { deleted: ids.length, ids }); return;
    }
    if (req.method === 'PATCH' && /^\/api\/parent\/assessment-resource-libraries\/\d+\/items\/\d+$/.test(url.pathname)) {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return; const parts = url.pathname.split('/'); const libraryId = Number(parts[4]); const itemId = Number(parts[6]); const library = assessmentLibraryAccess(user, libraryId, true); const current = db.prepare('SELECT * FROM assessment_resource_items WHERE id=? AND library_id=?').get(itemId, libraryId); if (!library || !current) { bad(res, 404, '资源不存在或无权修改'); return; } const body = await readBody(req, 128 * 1024); const content = clean(body.content ?? current.content, 1000); if (!content) { bad(res, 400, '资源内容不能为空'); return; } const status = ['enabled', 'archived'].includes(body.status) ? body.status : current.status; const timestamp = now(); db.prepare('UPDATE assessment_resource_items SET content=?,extra_json=?,tags=?,difficulty=?,note=?,status=?,version=version+1,updated_at=? WHERE id=?').run(content, JSON.stringify(body.extra ?? parseJson(current.extra_json)), Array.isArray(body.tags) ? body.tags.map(tag => clean(tag, 30)).filter(Boolean).join(',') : clean(body.tags ?? current.tags, 300), clean(body.difficulty ?? current.difficulty, 20), clean(body.note ?? current.note, 500), status, timestamp, itemId); db.prepare('UPDATE assessment_resource_libraries SET version=version+1,updated_at=? WHERE id=?').run(timestamp, libraryId); const item = db.prepare('SELECT * FROM assessment_resource_items WHERE id=?').get(itemId); json(res, 200, { item: { id: item.id, libraryId: item.library_id, content: item.content, extra: parseJson(item.extra_json), tags: item.tags.split(',').filter(Boolean), difficulty: item.difficulty, note: item.note, sortOrder: item.sort_order, status: item.status, version: item.version } }); return;
    }
    if (req.method === 'POST' && /^\/api\/parent\/assessment-resource-libraries\/\d+\/items$/.test(url.pathname)) {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return; const libraryId = Number(url.pathname.split('/')[4]); const library = assessmentLibraryAccess(user, libraryId, true); if (!library || library.status === 'archived') { bad(res, 404, '资源库不存在或不可编辑'); return; }
      const body = await readBody(req, 512 * 1024); const supplied = Array.isArray(body.items) ? body.items : [body]; if (!supplied.length || supplied.length > 500) { bad(res, 400, '一次最多录入 500 条资源'); return; }
      const existing = new Set(db.prepare("SELECT lower(content) AS content FROM assessment_resource_items WHERE library_id = ? AND status = 'enabled'").all(libraryId).map(item => item.content)); const invalid = []; const accepted = []; supplied.forEach((item, index) => { const content = clean(item.content || item.text || item.word || item.sentence, 1000); const key = content.toLowerCase(); if (!content || existing.has(key)) invalid.push({ row: index + 1, reason: !content ? '主内容不能为空' : '主内容重复' }); else { existing.add(key); accepted.push({ content, extra: item.extra || item.fields || {}, tags: Array.isArray(item.tags) ? item.tags.map(tag => clean(tag, 30)).filter(Boolean).join(',') : clean(item.tags, 300), difficulty: clean(item.difficulty, 20), note: clean(item.note, 500) }); } });
      if (body.validateOnly === true) { json(res, 200, { valid: invalid.length === 0, accepted: accepted.length, errors: invalid }); return; }
      const timestamp = now(); const insert = db.prepare('INSERT INTO assessment_resource_items (library_id,content,extra_json,tags,difficulty,note,sort_order,status,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,\'enabled\',1,?,?)'); const baseOrder = Number(db.prepare('SELECT COALESCE(MAX(sort_order),0) AS value FROM assessment_resource_items WHERE library_id=?').get(libraryId).value || 0); db.exec('BEGIN'); try { accepted.forEach((item, index) => insert.run(libraryId, item.content, JSON.stringify(item.extra || {}), item.tags, item.difficulty, item.note, baseOrder + index + 1, timestamp, timestamp)); db.prepare('UPDATE assessment_resource_libraries SET version=version+1,updated_at=? WHERE id=?').run(timestamp, libraryId); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; } json(res, 201, { inserted: accepted.length, skipped: invalid.length, errors: invalid }); return;
    }
    if (req.method === 'POST' && /^\/api\/parent\/assessment-resource-libraries\/\d+\/import$/.test(url.pathname)) {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return; const libraryId = Number(url.pathname.split('/')[4]); const library = assessmentLibraryAccess(user, libraryId, true); if (!library || library.status === 'archived') { bad(res, 404, '资源库不存在或不可编辑'); return; }
      const body = await readBody(req, 2 * 1024 * 1024); const text = String(body.text || body.csv || '').trim(); const lines = text ? text.split(/\r?\n/).map(line => line.trim()).filter(Boolean) : []; const supplied = Array.isArray(body.items) ? body.items : lines.map(line => { const columns = line.split(/[\t,，]/).map(item => item.trim()); return { content: columns[0], extra: columns.length > 1 ? { translation: columns[1] } : {} }; }); if (!supplied.length || supplied.length > 500) { bad(res, 400, '导入内容不能为空且一次最多 500 条'); return; }
      const existing = new Set(db.prepare("SELECT lower(content) AS content FROM assessment_resource_items WHERE library_id = ? AND status = 'enabled'").all(libraryId).map(item => item.content)); const invalid = []; const accepted = []; supplied.forEach((item, index) => { const content = clean(item.content || item.text || item.word || item.sentence, 1000); const key = content.toLowerCase(); if (!content || existing.has(key)) invalid.push({ row: index + 1, reason: !content ? '主内容不能为空' : '主内容重复' }); else { existing.add(key); accepted.push({ content, extra: item.extra || {}, tags: clean(item.tags, 300), difficulty: clean(item.difficulty, 20), note: clean(item.note, 500) }); } }); if (body.validateOnly === true) { json(res, 200, { valid: invalid.length === 0, accepted: accepted.length, errors: invalid }); return; }
      const timestamp = now(); const insert = db.prepare('INSERT INTO assessment_resource_items (library_id,content,extra_json,tags,difficulty,note,sort_order,status,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,\'enabled\',1,?,?)'); const baseOrder = Number(db.prepare('SELECT COALESCE(MAX(sort_order),0) AS value FROM assessment_resource_items WHERE library_id=?').get(libraryId).value || 0); db.exec('BEGIN'); try { accepted.forEach((item, index) => insert.run(libraryId, item.content, JSON.stringify(item.extra), item.tags, item.difficulty, item.note, baseOrder + index + 1, timestamp, timestamp)); db.prepare('UPDATE assessment_resource_libraries SET version=version+1,updated_at=? WHERE id=?').run(timestamp, libraryId); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; } json(res, 201, { inserted: accepted.length, skipped: invalid.length, errors: invalid }); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/parent/assessment-questions/import-template') {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return;
      csv(res, 'learning-planet-question-import-template.csv', assessmentQuestionImportTemplate()); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/parent/assessment-questions/export') {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return;
      const subject = clean(url.searchParams.get('subject'), 12); const conditions = [user.role === 'admin' ? '1=1' : 'creator_id = ?']; const params = user.role === 'admin' ? [] : [user.id];
      if (subject) { conditions.push('subject = ?'); params.push(subject); }
      const rows = db.prepare(`SELECT * FROM assessment_questions WHERE ${conditions.join(' AND ')} ORDER BY updated_at DESC, id DESC`).all(...params);
      const header = ['题目名称', '科目', '题型', '题干内容', '选项（用｜分隔）', '正确答案（多选用｜分隔）', '参考答案/评分要点', '答案解析', '分值', '允许学生上传附件（是/否）', '发布状态（草稿/启用）'];
      const records = rows.map(row => { const question = assessmentQuestionJson(row, true); const options = (question.prompt?.options || []).map(option => typeof option === 'object' ? option.text : option).join('｜'); const answer = question.answer?.correct; const answerText = Array.isArray(answer) ? answer.join('｜') : String(answer || ''); const isShortText = question.questionType === 'short_text'; return [question.name, question.subject, IMPORTABLE_ASSESSMENT_TYPE_LABELS[question.questionType] || question.questionType, question.prompt?.text || '', options, isShortText ? '' : answerText, isShortText ? answerText : '', question.explanation || '', question.score, question.prompt?.allowAttachment ? '是' : '否', question.status === 'published' ? '启用' : '草稿']; });
      csv(res, 'learning-planet-questions-export.csv', [header, ...records].map(record => record.map(csvEscape).join(',')).join('\r\n')); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/parent/assessment-questions/import') {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return; const body = await readBody(req, 2 * 1024 * 1024); const text = String(body.csvText || '');
      let rows; try { rows = assessmentImportRows(text); } catch (error) { bad(res, 400, error.message); return; }
      if (!rows.length || rows.length > 200) { bad(res, 400, '导入题目不能为空，且一次最多 200 道'); return; }
      const prepared = rows.map(({ row, rowNumber }) => validateAssessmentImportRow(row, rowNumber)); const errors = prepared.flatMap(item => item.errors);
      if (body.dryRun !== false) { json(res, 200, { valid: errors.length === 0, total: rows.length, validCount: prepared.filter(item => !item.errors.length).length, errors }); return; }
      if (errors.length) { bad(res, 400, errors.join('；')); return; }
      const timestamp = now(); const insert = db.prepare('INSERT INTO assessment_questions (name,subject,grade,difficulty,tags,question_type,answer_mode,prompt_json,answer_json,explanation,score,grading_mode,grading_rules_json,source_snapshot_json,status,current_version,creator_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)'); const insertVersion = db.prepare('INSERT INTO assessment_question_versions (question_id,version,snapshot_json,change_note,creator_id,created_at) VALUES (?,?,?,?,?,?)'); const created = [];
      db.exec('BEGIN'); try { prepared.forEach(({ payload }) => { const input = assessmentQuestionInput(payload); const result = insert.run(payload.name, input.subject, input.grade, input.difficulty, input.tags, input.questionType, input.answerMode, input.promptJson, input.answerJson, input.explanation, input.score, input.gradingMode, input.gradingRulesJson, input.sourceSnapshotJson, payload.status, user.id, timestamp, timestamp); const id = Number(result.lastInsertRowid); insertVersion.run(id, 1, JSON.stringify({ ...input, name: payload.name }), '模板导入', user.id, timestamp); created.push(id); }); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; }
      json(res, 201, { imported: created.length, ids: created }); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/parent/assessment-questions') {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return; const conditions = user.role === 'admin' ? [] : ['(creator_id = ? OR status = \'published\')']; const params = user.role === 'admin' ? [] : [user.id]; const subject = clean(url.searchParams.get('subject'), 12); const status = clean(url.searchParams.get('status'), 12); const q = clean(url.searchParams.get('q'), 120); const paging = assessmentPagination(url); if (subject) { conditions.push('subject = ?'); params.push(subject); } if (status) { conditions.push('status = ?'); params.push(status); } if (q) { conditions.push('(name LIKE ? OR prompt_json LIKE ? OR tags LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); } const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''; const total = Number(db.prepare(`SELECT COUNT(*) AS total FROM assessment_questions ${where}`).get(...params).total || 0); const rows = db.prepare(`SELECT * FROM assessment_questions ${where} ORDER BY updated_at DESC,id DESC LIMIT ? OFFSET ?`).all(...params, paging.pageSize, paging.offset); json(res, 200, { questions: rows.map(assessmentQuestionSummaryJson), pagination: assessmentPaginationMeta(total, paging) }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/parent/assessment-questions') {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return; const body = await readBody(req, 9 * 1024 * 1024); const input = assessmentQuestionInput(body); if (!ASSESSMENT_SUBJECTS.has(input.subject) || !ASSESSMENT_TYPES.has(input.questionType) || !ASSESSMENT_MODES.has(input.answerMode)) { bad(res, 400, '请填写有效的科目、题型和作答方式'); return; } if (!Number.isSafeInteger(input.score) || input.score < 1 || input.score > 100) { bad(res, 400, '分值需为 1 至 100 的整数'); return; } const status = body.status === 'published' ? 'published' : 'draft'; const timestamp = now(); const name = clean(body.name, 160); const result = db.prepare('INSERT INTO assessment_questions (name,subject,grade,difficulty,tags,question_type,answer_mode,prompt_json,answer_json,explanation,score,grading_mode,grading_rules_json,source_snapshot_json,status,current_version,creator_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)').run(name, input.subject, input.grade, input.difficulty, input.tags, input.questionType, input.answerMode, input.promptJson, input.answerJson, input.explanation, input.score, input.gradingMode, input.gradingRulesJson, input.sourceSnapshotJson, status, user.id, timestamp, timestamp); const id = Number(result.lastInsertRowid); db.prepare('INSERT INTO assessment_question_versions (question_id,version,snapshot_json,change_note,creator_id,created_at) VALUES (?,?,?,?,?,?)').run(id, 1, JSON.stringify({ ...input, name }), '初始版本', user.id, timestamp); const row = db.prepare('SELECT * FROM assessment_questions WHERE id=?').get(id); json(res, 201, { question: assessmentQuestionSummaryJson(row) }); return;
    }
    if (req.method === 'GET' && /^\/api\/parent\/assessment-questions\/\d+$/.test(url.pathname)) {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return; const id = Number(url.pathname.split('/').pop()); const row = assessmentQuestionAccess(user, id); if (!row) { bad(res, 404, '题目不存在或无权查看'); return; } json(res, 200, { question: assessmentQuestionJson(row, true), versions: db.prepare('SELECT version,change_note,created_at FROM assessment_question_versions WHERE question_id=? ORDER BY version DESC').all(id) }); return;
    }
    if (req.method === 'PATCH' && /^\/api\/parent\/assessment-questions\/\d+$/.test(url.pathname)) {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return; const id = Number(url.pathname.split('/').pop()); const current = assessmentQuestionAccess(user, id, true); if (!current) { bad(res, 404, '题目不存在或无权修改'); return; } const body = await readBody(req, 9 * 1024 * 1024); const input = assessmentQuestionInput(body, current); if (!ASSESSMENT_SUBJECTS.has(input.subject) || !ASSESSMENT_TYPES.has(input.questionType) || !ASSESSMENT_MODES.has(input.answerMode)) { bad(res, 400, '题目内容不完整'); return; } const version = Number(current.current_version || 1) + 1; const timestamp = now(); const name = clean(body.name ?? current.name, 160); db.prepare('UPDATE assessment_questions SET name=?,subject=?,grade=?,difficulty=?,tags=?,question_type=?,answer_mode=?,prompt_json=?,answer_json=?,explanation=?,score=?,grading_mode=?,grading_rules_json=?,source_snapshot_json=?,status=?,current_version=?,updated_at=? WHERE id=?').run(name, input.subject, input.grade, input.difficulty, input.tags, input.questionType, input.answerMode, input.promptJson, input.answerJson, input.explanation, input.score, input.gradingMode, input.gradingRulesJson, input.sourceSnapshotJson, ['draft','published','archived'].includes(body.status) ? body.status : current.status, version, timestamp, id); db.prepare('INSERT INTO assessment_question_versions (question_id,version,snapshot_json,change_note,creator_id,created_at) VALUES (?,?,?,?,?,?)').run(id, version, JSON.stringify({ ...input, name }), clean(body.changeNote, 200), user.id, timestamp); const row = db.prepare('SELECT * FROM assessment_questions WHERE id=?').get(id); json(res, 200, { question: assessmentQuestionSummaryJson(row) }); return;
    }
    if (req.method === 'DELETE' && /^\/api\/parent\/assessment-questions\/\d+$/.test(url.pathname)) {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return;
      const id = Number(url.pathname.split('/').pop()); const current = assessmentQuestionAccess(user, id, true);
      if (!current) { bad(res, 404, '题目不存在或无权删除'); return; }
      const used = db.prepare('SELECT COUNT(*) AS total FROM assessment_paper_items WHERE question_id = ?').get(id);
      if (Number(used.total || 0) > 0) { bad(res, 409, '该题目已被题单使用，不能删除；可先禁用题目'); return; }
      db.prepare('DELETE FROM assessment_questions WHERE id = ?').run(id);
      json(res, 200, { deleted: true, id }); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/parent/assessment-papers') {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return; const conditions = user.role === 'admin' ? [] : ['creator_id = ?']; const params = user.role === 'admin' ? [] : [user.id]; const status = clean(url.searchParams.get('status'), 12); const subject = clean(url.searchParams.get('subject'), 12); const paging = assessmentPagination(url); if (status) { conditions.push('status = ?'); params.push(status); } if (subject) { conditions.push('subject = ?'); params.push(subject); } const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''; const total = Number(db.prepare(`SELECT COUNT(*) AS total FROM assessment_papers ${where}`).get(...params).total || 0); const rows = db.prepare(`SELECT * FROM assessment_papers ${where} ORDER BY updated_at DESC,id DESC LIMIT ? OFFSET ?`).all(...params, paging.pageSize, paging.offset); json(res, 200, { papers: rows.map(assessmentPaperSummaryJson), pagination: assessmentPaginationMeta(total, paging) }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/parent/assessment-papers') {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return;
      const body = await readBody(req, 512 * 1024); const name = clean(body.name, 160); const subject = clean(body.subject, 12);
      const specs = assessmentPaperItemSpecs(body); const ids = specs.map(item => item.questionId);
      if (!name || !ASSESSMENT_SUBJECTS.has(subject) || !ids.length || ids.length > 50) { bad(res, 400, '题单需要名称、科目和 1 至 50 道题目'); return; }
      const questions = ids.map(id => assessmentQuestionAccess(user, id)).filter(Boolean);
      if (questions.length !== ids.length || questions.some(question => question.subject !== subject || question.status !== 'published')) { bad(res, 400, '题单只能包含同一科目的已发布题目'); return; }
      if (specs.some(item => item.score !== null && (!Number.isSafeInteger(item.score) || item.score < 1 || item.score > 100))) { bad(res, 400, '题目分值需为 1 至 100 的整数'); return; }
      const timestamp = now(); const status = body.status === 'draft' ? 'draft' : 'published';
      const result = db.prepare('INSERT INTO assessment_papers (name,subject,grade,description,duration_minutes,pass_score,explanation_timing,allow_retry,retry_limit,status,current_version,creator_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?,?)').run(name, subject, clean(body.grade, 30), clean(body.description, 600), Number(body.duration || 0) || null, Number(body.passScore || 0) || null, ['after_submit','after_review','never'].includes(body.explanationTiming) ? body.explanationTiming : 'after_review', body.allowRetry === true ? 1 : 0, body.allowRetry === true ? Math.min(1, Number(body.retryLimit || 1)) : 0, status, user.id, timestamp, timestamp);
      const paperId = Number(result.lastInsertRowid); const insert = db.prepare('INSERT INTO assessment_paper_items (paper_id,question_id,question_version,sort_order,score,snapshot_json) VALUES (?,?,?,?,?,?)');
      questions.forEach((question, index) => { const score = specs[index].score ?? Number(question.score); insert.run(paperId, question.id, question.current_version, index + 1, score, JSON.stringify(assessmentPaperItemSnapshot(question, score))); });
      const row = db.prepare('SELECT * FROM assessment_papers WHERE id=?').get(paperId); json(res, 201, { paper: assessmentPaperSummaryJson(row) }); return;
    }
    if (req.method === 'GET' && /^\/api\/parent\/assessment-papers\/\d+$/.test(url.pathname)) {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return; const id = Number(url.pathname.split('/').pop()); const row = assessmentPaperAccess(user, id); if (!row) { bad(res, 404, '题单不存在或无权查看'); return; } json(res, 200, { paper: assessmentPaperJson(row, true) }); return;
    }
    if (req.method === 'PATCH' && /^\/api\/parent\/assessment-papers\/\d+$/.test(url.pathname)) {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return;
      const id = Number(url.pathname.split('/').pop()); const current = assessmentPaperAccess(user, id, true); if (!current) { bad(res, 404, '题单不存在或无权修改'); return; }
      const body = await readBody(req, 512 * 1024); const fallback = db.prepare('SELECT question_id,score FROM assessment_paper_items WHERE paper_id=? ORDER BY sort_order').all(id).map(item => ({ questionId: item.question_id, score: Number(item.score) })); const specs = assessmentPaperItemSpecs(body, fallback); const ids = specs.map(item => item.questionId);
      const subject = current.subject; if (!ASSESSMENT_SUBJECTS.has(subject) || !ids.length || ids.length > 50) { bad(res, 400, '题单需要有效科目和 1 至 50 道题目'); return; }
      const questions = ids.map(questionId => assessmentQuestionAccess(user, questionId)).filter(Boolean); if (questions.length !== ids.length || questions.some(question => question.subject !== subject || question.status !== 'published')) { bad(res, 400, '题单只能包含同一科目的已发布题目'); return; }
      if (specs.some(item => item.score !== null && (!Number.isSafeInteger(item.score) || item.score < 1 || item.score > 100))) { bad(res, 400, '题目分值需为 1 至 100 的整数'); return; }
      const timestamp = now(); const version = Number(current.current_version || 1) + 1; const status = ['draft','published','archived'].includes(body.status) ? body.status : current.status;
      db.prepare('UPDATE assessment_papers SET name=?,subject=?,grade=?,description=?,duration_minutes=?,pass_score=?,explanation_timing=?,allow_retry=?,retry_limit=?,status=?,current_version=?,updated_at=? WHERE id=?').run(clean(body.name ?? current.name, 160), subject, clean(body.grade ?? current.grade, 30), clean(body.description ?? current.description, 600), Number(body.duration ?? current.duration_minutes) || null, Number(body.passScore ?? current.pass_score) || null, ['after_submit','after_review','never'].includes(body.explanationTiming) ? body.explanationTiming : current.explanation_timing, body.allowRetry === true ? 1 : body.allowRetry === false ? 0 : Number(current.allow_retry), body.allowRetry === true ? Math.min(1, Number(body.retryLimit || 1)) : body.allowRetry === false ? 0 : Number(current.retry_limit || 0), status, version, timestamp, id);
      db.prepare('DELETE FROM assessment_paper_items WHERE paper_id=?').run(id); const insert = db.prepare('INSERT INTO assessment_paper_items (paper_id,question_id,question_version,sort_order,score,snapshot_json) VALUES (?,?,?,?,?,?)'); questions.forEach((question, index) => { const score = specs[index].score ?? Number(question.score); insert.run(id, question.id, question.current_version, index + 1, score, JSON.stringify(assessmentPaperItemSnapshot(question, score))); });
      const row = db.prepare('SELECT * FROM assessment_papers WHERE id=?').get(id); json(res, 200, { paper: assessmentPaperSummaryJson(row) }); return;
    }
    if (req.method === 'DELETE' && /^\/api\/parent\/assessment-papers\/\d+$/.test(url.pathname)) {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return; const id = Number(url.pathname.split('/').pop()); const paper = assessmentPaperAccess(user, id, true); if (!paper) { bad(res, 404, '题单不存在或无权删除'); return; }
      db.prepare('DELETE FROM assessment_papers WHERE id=?').run(id); json(res, 200, { deleted: true, id }); return;
    }
    if (req.method === 'GET' && /^\/api\/parent\/assessment-papers\/\d+\/publish-records$/.test(url.pathname)) {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return; const id = Number(url.pathname.split('/')[4]); const paper = assessmentPaperAccess(user, id); if (!paper) { bad(res, 404, '题单不存在或无权查看'); return; }
      const rows = db.prepare('SELECT assessment_assignments.*, tasks.status AS task_status, users.display_name AS student_name, users.avatar AS student_avatar FROM assessment_assignments JOIN tasks ON tasks.id=assessment_assignments.student_task_id JOIN users ON users.id=assessment_assignments.student_id WHERE assessment_assignments.paper_id=? ORDER BY assessment_assignments.created_at DESC,assessment_assignments.id DESC').all(id); json(res, 200, { records: rows.map(row => ({ ...assessmentAssignmentJson(row), studentName: row.student_name, studentAvatar: signStoredUrl(row.student_avatar || ''), publishedAt: row.created_at })) }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/parent/assessment-assignments') {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return; const body = await readBody(req, 512 * 1024); const studentIds = [...new Set((Array.isArray(body.studentIds) ? body.studentIds : [body.studentId]).map(Number).filter(Number.isSafeInteger))]; const dueDate = clean(body.dueDate || body.taskDate, 10) || businessDate(); const sourceType = body.paperId ? 'paper' : 'direct'; let sourceQuestions = []; let paper = null; if (sourceType === 'paper') { paper = assessmentPaperAccess(user, Number(body.paperId)); if (!paper || paper.status !== 'published') { bad(res, 400, '请选择已发布题单'); return; } sourceQuestions = db.prepare('SELECT * FROM assessment_paper_items WHERE paper_id=? ORDER BY sort_order').all(paper.id).map(item => ({ ...parseJson(item.snapshot_json), id: item.question_id, version: item.question_version, score: Number(item.score) })); } else { const ids = [...new Set((Array.isArray(body.questionIds) ? body.questionIds : []).map(Number).filter(Number.isSafeInteger))]; if (!ids.length || ids.length > 50) { bad(res, 400, '请选择 1 至 50 道已发布题目'); return; } const rows = ids.map(id => assessmentQuestionAccess(user, id)).filter(row => row && row.status === 'published'); if (rows.length !== ids.length || new Set(rows.map(row => row.subject)).size !== 1) { bad(res, 400, '评测题目必须属于同一科目'); return; } sourceQuestions = rows.map(row => ({ ...assessmentSnapshot(row), id: row.id, version: row.current_version, score: Number(row.score) })); }
      if (!studentIds.length || studentIds.some(studentId => !assessmentVisibleToParent(user, studentId))) { bad(res, 403, '请选择已绑定的学生'); return; } sourceQuestions = sourceQuestions.map(question => ({ ...question, score: Number(question.score) })); const subject = sourceQuestions[0]?.subject; if (!subject) { bad(res, 400, '评测题目不能为空'); return; } const title = clean(body.name || body.title || (paper?.name || '学习评测'), 160); const category = db.prepare('SELECT id,name,icon,color FROM task_categories WHERE name = ? LIMIT 1').get(subject === '英语' ? '英语角' : subject === '数学' ? '数学乐园' : '语文小屋') || db.prepare('SELECT id,name,icon,color FROM task_categories WHERE active=1 ORDER BY id LIMIT 1').get(); const timestamp = now(); const created = []; db.exec('BEGIN'); try { for (const studentId of studentIds) { const taskResult = db.prepare('INSERT INTO tasks (student_id,title,category,icon,category_color,detail,task_date,duration_minutes,stars,feedback_type,needs_review,pet_exp_weight_snapshot,resource_id,status,created_at,task_type) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,\'assessment\')').run(studentId, title, category.name, category.icon, category.color, clean(body.description || body.detail || '完成这份小测验，按题目要求作答。', 1000), dueDate, Number(body.duration || paper?.duration_minutes || 0) || null, Math.max(1, Number(body.stars || 1)), 'none', body.needsReview === true || sourceQuestions.some(question => question.gradingMode === 'manual') ? 1 : 0, Math.max(0, Number(body.petExpWeight ?? 1) || 0), null, 'not_started', timestamp); const taskId = Number(taskResult.lastInsertRowid); const assignmentResult = db.prepare('INSERT INTO assessment_assignments (student_task_id,student_id,paper_id,paper_version,source_type,name,subject,description,due_date,deadline,duration_minutes,stars,pet_exp_weight,needs_review,explanation_timing,allow_retry,retry_limit,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(taskId, studentId, paper?.id || null, paper?.current_version || null, sourceType, title, subject, clean(body.description || body.detail || '', 1000), dueDate, clean(body.deadline, 30), Number(body.duration || paper?.duration_minutes || 0) || null, Math.max(1, Number(body.stars || 1)), Math.max(0, Number(body.petExpWeight ?? 1) || 0), body.needsReview === true || sourceQuestions.some(question => question.gradingMode === 'manual') ? 1 : 0, ['after_submit','after_review','never'].includes(body.explanationTiming) ? body.explanationTiming : paper?.explanation_timing || 'after_review', (body.allowRetry === true || Boolean(paper?.allow_retry)) ? 1 : 0, body.allowRetry === true ? Math.min(1, Number(body.retryLimit || 1)) : Number(paper?.retry_limit || 0), user.id, timestamp, timestamp); const assignmentId = Number(assignmentResult.lastInsertRowid); const insert = db.prepare('INSERT INTO assessment_assignment_questions (assignment_id,question_id,question_version,sort_order,score,snapshot_json) VALUES (?,?,?,?,?,?)'); sourceQuestions.forEach((question, index) => insert.run(assignmentId, question.id, question.version, index + 1, question.score, JSON.stringify(question))); created.push(assignmentId); } db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; } json(res, 201, { count: created.length, assignmentIds: created }); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/parent/assessment-results') {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return; const students = studentListFor(user).map(student => student.id); const paging = assessmentPagination(url); if (!students.length) { json(res, 200, { results: [], summary: { total: 0, completed: 0, pending: 0 }, pagination: assessmentPaginationMeta(0, paging) }); return; } const conditions = [`assessment_assignments.student_id IN (${students.map(() => '?').join(',')})`]; const params = [...students]; const studentId = Number(url.searchParams.get('studentId')); if (Number.isSafeInteger(studentId) && studentId > 0) { conditions.push('assessment_assignments.student_id = ?'); params.push(studentId); } const subject = clean(url.searchParams.get('subject'), 12); if (subject) { conditions.push('assessment_assignments.subject = ?'); params.push(subject); } const status = clean(url.searchParams.get('status'), 20); if (status) { conditions.push('tasks.status = ?'); params.push(status); } const where = `WHERE ${conditions.join(' AND ')}`; const summary = db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN tasks.status = 'completed' THEN 1 ELSE 0 END) AS completed, SUM(CASE WHEN tasks.status = 'pending_review' THEN 1 ELSE 0 END) AS pending FROM assessment_assignments JOIN tasks ON tasks.id = assessment_assignments.student_task_id ${where}`).get(...params); const rows = db.prepare(`SELECT assessment_assignments.*, tasks.status AS task_status, users.display_name AS student_name, users.avatar AS student_avatar FROM assessment_assignments JOIN tasks ON tasks.id = assessment_assignments.student_task_id JOIN users ON users.id = assessment_assignments.student_id ${where} ORDER BY assessment_assignments.due_date DESC, assessment_assignments.id DESC LIMIT ? OFFSET ?`).all(...params, paging.pageSize, paging.offset); const results = rows.map(row => ({ ...assessmentAssignmentJson(row), studentName: row.student_name, studentAvatar: signStoredUrl(row.student_avatar || '') })); json(res, 200, { results, summary: { total: Number(summary.total || 0), completed: Number(summary.completed || 0), pending: Number(summary.pending || 0) }, pagination: assessmentPaginationMeta(summary.total, paging) }); return;
    }
    if (req.method === 'GET' && /^\/api\/parent\/assessment-results\/\d+$/.test(url.pathname)) {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return;
      const id = Number(url.pathname.split('/').pop()); const row = assessmentAssignmentRow(id);
      if (!row || !assessmentVisibleToParent(user, row.student_id)) { bad(res, 404, '评测不存在或无权查看'); return; }
      const student = db.prepare('SELECT display_name FROM users WHERE id=?').get(row.student_id);
      json(res, 200, { assessment: { ...assessmentAssignmentJson(row, true, true), studentName: student?.display_name || '' } }); return;
    }
    if (req.method === 'DELETE' && /^\/api\/parent\/assessment-results\/\d+$/.test(url.pathname)) {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return;
      const id = Number(url.pathname.split('/').pop()); const row = assessmentAssignmentRow(id);
      if (!row || !assessmentVisibleToParent(user, row.student_id)) { bad(res, 404, '评测不存在或无权撤回'); return; }
      const attempt = db.prepare('SELECT submitted_at FROM assessment_attempts WHERE assignment_id = ? ORDER BY version DESC LIMIT 1').get(id);
      if (!['not_started', 'in_progress'].includes(row.task_status) || attempt?.submitted_at) { bad(res, 409, '学生已提交或评测已结束，无法撤回'); return; }
      // Deleting the assessment task cascades to its assignment, attempts, and draft answers.
      db.prepare('DELETE FROM tasks WHERE id = ?').run(row.student_task_id);
      json(res, 200, { withdrawn: true, id }); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/parent/assessment-wrong-questions') {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return; const students = studentListFor(user).map(student => student.id); if (!students.length) { json(res, 200, { questions: [] }); return; } const rows = db.prepare(`SELECT assessment_answers.*, assessment_assignment_questions.snapshot_json, assessment_assignments.name AS assignment_name, assessment_assignments.subject, assessment_assignments.student_id, users.display_name AS student_name FROM assessment_answers JOIN assessment_attempts ON assessment_attempts.id = assessment_answers.attempt_id JOIN assessment_assignment_questions ON assessment_assignment_questions.id = assessment_answers.assignment_question_id JOIN assessment_assignments ON assessment_assignments.id = assessment_attempts.assignment_id JOIN users ON users.id = assessment_assignments.student_id WHERE assessment_assignments.student_id IN (${students.map(() => '?').join(',')}) AND assessment_attempts.status = 'finalized' AND assessment_answers.final_score < assessment_assignment_questions.score ORDER BY assessment_attempts.updated_at DESC`).all(...students); json(res, 200, { questions: rows.map(row => ({ assignmentName: row.assignment_name, subject: row.subject, studentId: row.student_id, studentName: row.student_name, ...parseJson(row.snapshot_json), answer: parseJson(row.answer_json), score: Number(row.final_score || 0), maxScore: Number(parseJson(row.snapshot_json).score || 0) })) }); return;
    }
    if (req.method === 'POST' && /^\/api\/parent\/assessment-results\/\d+\/review$/.test(url.pathname)) {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return; const id = Number(url.pathname.split('/')[4]); const row = assessmentAssignmentRow(id); if (!row || !assessmentVisibleToParent(user, row.student_id)) { bad(res, 404, '评测不存在或无权审核'); return; } const attempt = db.prepare("SELECT * FROM assessment_attempts WHERE assignment_id=? AND status='pending_review' ORDER BY version DESC LIMIT 1").get(id); if (!attempt) { bad(res, 409, '该评测当前不在待审核状态'); return; } const body = await readBody(req, 256 * 1024); const action = clean(body.action, 20) || 'approve'; const message = clean(body.message, 500); const scores = new Map((Array.isArray(body.answers) ? body.answers : []).map(item => [Number(item.questionId), Math.max(0, Number(item.score) || 0)])); const answers = db.prepare('SELECT * FROM assessment_answers WHERE attempt_id=?').all(attempt.id); const questions = db.prepare('SELECT * FROM assessment_assignment_questions WHERE assignment_id=?').all(id); const timestamp = now(); if (action === 'needs_more' || action === 'return') { db.prepare("UPDATE assessment_attempts SET status='returned', updated_at=? WHERE id=?").run(timestamp, attempt.id); db.prepare("UPDATE tasks SET status='needs_more' WHERE id=?").run(row.student_task_id); db.prepare('INSERT INTO assessment_reviews (attempt_id,action,reviewer_id,message,created_at) VALUES (?,?,?,?,?)').run(attempt.id, 'needs_more', user.id, message, timestamp); json(res, 200, { ok: true, status: 'needs_more' }); return; } let manualScore = 0; answers.forEach(answer => { const question = questions.find(item => item.id === answer.assignment_question_id); const score = scores.has(answer.assignment_question_id) ? Math.min(Number(question?.score || 0), scores.get(answer.assignment_question_id)) : Number(answer.auto_score || 0); manualScore += score; db.prepare('UPDATE assessment_answers SET manual_score=?,final_score=? WHERE id=?').run(score, score, answer.id); }); const requestedFinal = Number(body.finalScore); const finalScore = Number.isFinite(requestedFinal) ? Math.min(Number(attempt.total_score || 0), Math.max(0, requestedFinal)) : manualScore; const stars = Math.max(0, Math.min(999, Number(body.stars ?? row.stars) || 0)); const petExpWeight = Math.max(0, Math.min(3, Number(body.petExpWeight ?? row.pet_exp_weight) || 0)); db.prepare('UPDATE assessment_assignments SET stars=?,pet_exp_weight=?,updated_at=? WHERE id=?').run(stars, petExpWeight, timestamp, id); db.prepare("UPDATE assessment_attempts SET status='finalized',manual_score=?,final_score=?,updated_at=? WHERE id=?").run(manualScore, finalScore, timestamp, attempt.id); db.prepare("UPDATE tasks SET status='completed',stars=?,pet_exp_weight_snapshot=?,reviewed_at=?,reviewed_by=?,encouragement=? WHERE id=?").run(stars, petExpWeight, timestamp, user.id, message, row.student_task_id); db.prepare('INSERT INTO assessment_reviews (attempt_id,action,reviewer_id,message,created_at) VALUES (?,?,?,?,?)').run(attempt.id, 'approve', user.id, message, timestamp); if (!db.prepare('SELECT 1 FROM rewards WHERE task_id=? LIMIT 1').get(row.student_task_id)) db.prepare('INSERT INTO rewards (student_id,task_id,stars,message,created_at) VALUES (?,?,?,?,?)').run(row.student_id, row.student_task_id, stars, message || '评测完成，做得很棒！', timestamp); const pet = activePetForStudent(row.student_id); publishPetEvent({ eventType: 'ASSESSMENT_FINALIZED', sourceType: 'assessment_complete', sourceId: String(row.student_task_id), studentId: row.student_id, petId: pet?.id || null, businessDate: row.due_date, requestedDelta: 10 * petExpWeight, occurredAt: timestamp, reason: `审核完成评测：${row.name}` }); json(res, 200, { ok: true, status: 'completed', finalScore }); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/student/dashboard') {
      const user = requireUser(req, res); if (!user) return; if (user.role !== 'student') { bad(res, 403, '学生账号专属接口'); return; }
      const date = clean(url.searchParams.get('date') || businessDate(), 10);
      const currentDate = businessDate();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { bad(res, 400, '日期格式不正确'); return; }
      const week = weekRange(date);
      const weekRows = db.prepare(`SELECT tasks.*, ${taskResourceSummarySql} FROM tasks WHERE student_id = ? AND task_type <> 'assessment' AND ((schedule_type = 'range' AND available_start_date <= ? AND available_end_date >= ?) OR (schedule_type <> 'range' AND task_date BETWEEN ? AND ?)) AND is_demo = 0 ORDER BY ${taskStatusOrderSql}, tasks.created_at DESC, tasks.id DESC`).all(user.id, week.end, week.start, week.start, week.end).map(taskJson);
      const weekTasks = Object.fromEntries(dateRange(week.start, week.end).map(day => [day, weekRows.filter(task => taskVisibleOn(task, day))]));
      const tasks = weekTasks[date] || [];
      const taskDates = Object.entries(weekTasks).filter(([, dayTasks]) => dayTasks.length).map(([day]) => day);
      const incompleteTaskDates = overdueUnfinishedTaskDates(weekTasks);
      const taskDateMarkers = taskDateMarkMap(weekTasks);
      const previousWeekDate = new Date(`${week.start}T12:00:00Z`); previousWeekDate.setUTCDate(previousWeekDate.getUTCDate() - 7);
      const previousWeek = weekRange(previousWeekDate.toISOString().slice(0, 10));
      const previousWeekRows = db.prepare(`SELECT tasks.* FROM tasks WHERE student_id = ? AND task_type <> 'assessment' AND ((schedule_type = 'range' AND available_start_date <= ? AND available_end_date >= ?) OR (schedule_type <> 'range' AND task_date BETWEEN ? AND ?)) AND is_demo = 0`).all(user.id, previousWeek.end, previousWeek.start, previousWeek.start, previousWeek.end);
      const previousWeekUnfinishedCount = previousWeekRows.filter(task => {
        if (!['not_started', 'in_progress', 'needs_more'].includes(task.status)) return false;
        return task.schedule_type === 'range'
          ? task.available_end_date >= previousWeek.start && task.available_end_date <= previousWeek.end && task.available_end_date < businessDate()
          : task.task_date < businessDate();
      }).length;
      const rewards = db.prepare('SELECT rewards.*, tasks.title FROM rewards LEFT JOIN tasks ON tasks.id = rewards.task_id WHERE rewards.student_id = ? AND (rewards.task_id IS NULL OR tasks.is_demo = 0) ORDER BY rewards.id DESC LIMIT 10').all(user.id);
      const totalStars = db.prepare('SELECT COALESCE(SUM(stars),0) AS total FROM rewards WHERE student_id = ? AND (task_id IS NULL OR task_id IN (SELECT id FROM tasks WHERE is_demo = 0))').get(user.id).total;
      json(res, 200, { date, currentDate, student: publicUser(user), tasks, taskDates, incompleteTaskDates, taskDateMarkers, previousWeekUnfinishedCount, weekTasks, rewards, growth: rewardBreakdown(totalStars) });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/student/tasks') {
      const user = requireUser(req, res); if (!user) return; if (user.role !== 'student') { bad(res, 403, '学生账号专属接口'); return; }
      const filter = clean(url.searchParams.get('filter') || 'overdue', 24);
      const currentDate = businessDate();
      const week = weekRange(currentDate);
      const filters = {
        overdue: { sql: "((schedule_type = 'range' AND available_end_date BETWEEN ? AND ? AND available_end_date < ?) OR (schedule_type <> 'range' AND task_date BETWEEN ? AND ? AND task_date < ?)) AND status IN ('not_started','in_progress','needs_more')", args: [week.start, week.end, currentDate, week.start, week.end, currentDate] },
        todo: { sql: "((schedule_type = 'range' AND available_start_date <= ? AND available_end_date >= ?) OR (schedule_type <> 'range' AND task_date = ?)) AND status IN ('not_started','in_progress','needs_more')", args: [currentDate, currentDate, currentDate] },
        future: { sql: "((schedule_type = 'range' AND available_start_date > ?) OR (schedule_type <> 'range' AND task_date > ?)) AND status IN ('not_started','in_progress','needs_more')", args: [currentDate, currentDate] },
        pending_review: { sql: "status = 'pending_review'", args: [] },
        completed: { sql: "status = 'completed'", args: [] }
      };
      const selected = filters[filter];
      if (!selected) { bad(res, 400, '任务筛选条件不正确'); return; }
      const order = `${taskStatusOrderSql}, tasks.created_at DESC, tasks.id DESC`;
      const tasks = db.prepare(`SELECT tasks.*, ${taskResourceSummarySql} FROM tasks WHERE student_id = ? AND task_type <> 'assessment' AND is_demo = 0 AND ${selected.sql} ORDER BY ${order}`).all(user.id, ...selected.args).map(taskJson);
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
    if (req.method === 'GET' && url.pathname === '/api/student/categories') {
      const user = requireUser(req, res); if (!user || user.role !== 'student') return;
      json(res, 200, { categories: db.prepare('SELECT id, name, icon, color FROM task_categories WHERE active = 1 ORDER BY id').all() }); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/student/reward-applications') {
      const user = requireUser(req, res); if (!user || user.role !== 'student') return;
      const rows = db.prepare(`SELECT reward_applications.*, users.display_name AS student_name, users.avatar AS student_avatar
        FROM reward_applications JOIN users ON users.id = reward_applications.student_id WHERE student_id = ? ORDER BY created_at DESC, id DESC`).all(user.id);
      json(res, 200, { applications: rows.map(row => rewardApplicationJson(row)) }); return;
    }
    if (req.method === 'GET' && /^\/api\/student\/reward-applications\/\d+$/.test(url.pathname)) {
      const user = requireUser(req, res); if (!user || user.role !== 'student') return;
      const id = Number(url.pathname.split('/').pop());
      const row = db.prepare(`SELECT reward_applications.*, users.display_name AS student_name, users.avatar AS student_avatar FROM reward_applications JOIN users ON users.id = reward_applications.student_id WHERE reward_applications.id = ? AND student_id = ?`).get(id, user.id);
      if (!row) { bad(res, 404, '奖励申请不存在'); return; } json(res, 200, { application: rewardApplicationJson(row, true) }); return;
    }
    if ((req.method === 'POST' && url.pathname === '/api/student/reward-applications') || (req.method === 'PATCH' && /^\/api\/student\/reward-applications\/\d+$/.test(url.pathname))) {
      const user = requireUser(req, res); if (!user || user.role !== 'student') return;
      const editing = req.method === 'PATCH'; const id = editing ? Number(url.pathname.split('/').pop()) : null;
      const current = editing ? db.prepare('SELECT * FROM reward_applications WHERE id = ? AND student_id = ?').get(id, user.id) : null;
      if (editing && !current) { bad(res, 404, '奖励申请不存在'); return; }
      if (editing && !['pending', 'rejected'].includes(current.status)) { bad(res, 409, '审核中的申请不可修改'); return; }
      const body = await readBody(req, 45 * 1024 * 1024);
      const categoryId = Number(body.categoryId); const category = db.prepare('SELECT id, name, icon FROM task_categories WHERE id = ? AND active = 1').get(categoryId);
      const content = clean(body.content, 160); const detail = clean(body.detail, 600); const completedAt = clean(body.completedAt, 10) || businessDate(); const requestedStars = Number(body.requestedStars);
      const existingResourceIds = normalizeExistingResourceIds(body);
      const replaceResources = Object.hasOwn(body, 'resources') || Object.hasOwn(body, 'existingResourceIds');
      const resources = replaceResources && Array.isArray(body.resources) ? body.resources.map(item => normalizeTaskResource(item?.data, item?.name)).filter(Boolean) : [];
      if (!category) { bad(res, 400, '请选择有效的任务分类'); return; }
      if (!content) { bad(res, 400, '请填写完成内容'); return; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(completedAt)) { bad(res, 400, '完成时间格式不正确'); return; }
      if (!Number.isSafeInteger(requestedStars) || requestedStars < 1) { bad(res, 400, '希望获得的星星数需为正整数'); return; }
      if (!existingResourceIds || (replaceResources && resources.length !== (Array.isArray(body.resources) ? body.resources.length : 0)) || existingResourceIds.length + resources.length > 5 || resources.some(resource => resource.kind !== 'image')) { bad(res, 400, '奖励申请最多上传 5 张图片'); return; }
      if (!editing && existingResourceIds.length) { bad(res, 400, '新建奖励申请不能引用已有图片'); return; }
      if (editing && existingResourceIds.some(resourceId => !db.prepare('SELECT 1 FROM reward_application_resources WHERE application_id = ? AND resource_id = ?').get(id, resourceId))) { bad(res, 403, '无权引用该完成图片'); return; }
      const stored = await storeResources(resources, 'reward-applications'); const timestamp = now();
      try {
        db.exec('BEGIN'); let applicationId = id;
        if (editing) {
          const oldIds = replaceResources ? db.prepare('SELECT resource_id FROM reward_application_resources WHERE application_id = ?').all(id).map(item => item.resource_id) : [];
          if (replaceResources) db.prepare('DELETE FROM reward_application_resources WHERE application_id = ?').run(id);
          db.prepare(`UPDATE reward_applications SET category_id=?, category_name=?, category_icon=?, content=?, detail=?, completed_at=?, requested_stars=?, status='pending', parent_message='', reviewed_by=NULL, reviewed_at=NULL, updated_at=? WHERE id=?`).run(category.id, category.name, category.icon, content, detail, completedAt, requestedStars, timestamp, id);
          if (replaceResources) { const resourceIds = [...existingResourceIds, ...insertResources(stored, user.id)]; linkRewardResources(id, resourceIds); } db.exec('COMMIT'); oldIds.forEach(deleteUnusedResource); applicationId = id;
        } else {
          const result = db.prepare(`INSERT INTO reward_applications (student_id,category_id,category_name,category_icon,content,detail,completed_at,requested_stars,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?, 'pending', ?, ?)`).run(user.id, category.id, category.name, category.icon, content, detail, completedAt, requestedStars, timestamp, timestamp);
          applicationId = Number(result.lastInsertRowid); linkRewardResources(applicationId, insertResources(stored, user.id)); db.exec('COMMIT');
        }
        const row = db.prepare(`SELECT reward_applications.*, users.display_name AS student_name, users.avatar AS student_avatar FROM reward_applications JOIN users ON users.id = reward_applications.student_id WHERE reward_applications.id = ?`).get(applicationId);
        json(res, editing ? 200 : 201, { application: rewardApplicationJson(row, true) });
      } catch (error) { db.exec('ROLLBACK'); await Promise.allSettled(stored.map(resource => deleteStoredUrl(resource.url, { dataDir }))); throw error; }
      return;
    }
    if (req.method === 'DELETE' && /^\/api\/student\/reward-applications\/\d+$/.test(url.pathname)) {
      const user = requireUser(req, res); if (!user || user.role !== 'student') return; const id = Number(url.pathname.split('/').pop());
      const row = db.prepare('SELECT * FROM reward_applications WHERE id = ? AND student_id = ?').get(id, user.id); if (!row) { bad(res, 404, '奖励申请不存在'); return; }
      if (!['pending', 'rejected'].includes(row.status)) { bad(res, 409, '审核中的申请不可删除'); return; }
      const ids = db.prepare('SELECT resource_id FROM reward_application_resources WHERE application_id = ?').all(id).map(item => item.resource_id); db.prepare('DELETE FROM reward_applications WHERE id = ?').run(id); ids.forEach(deleteUnusedResource); json(res, 204, {}); return;
    }
    if (req.method === 'PATCH' && /^\/api\/student\/tasks\/\d+\/draft$/.test(url.pathname)) {
      const user = requireUser(req, res); if (!user) return; if (user.role !== 'student') { bad(res, 403, '学生账号专属接口'); return; }
      const taskId = Number(url.pathname.split('/')[4]);
      const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND student_id = ? AND is_demo = 0').get(taskId, user.id);
      if (!task) { bad(res, 404, '任务不存在'); return; }
      if (['completed', 'pending_review'].includes(task.status)) { bad(res, 409, task.status === 'completed' ? '任务已完成' : '任务正在等待审核'); return; }
      // Overdue tasks remain available for students to register a late completion.
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
      const body = await readBody(req, 6 * 1024 * 1024);
      const feedbackName = clean(body.feedbackName, 120);
      const feedback = await feedbackValue(body.feedbackData, task, feedbackName);
      const feedbackNote = clean(body.feedbackNote, 300);
      const submissionPet = activePetForStudent(user.id);
      const petId = task.submitted_active_pet_id || submissionPet?.id || null;
      const petDate = task.pet_business_date || businessDate();
      if (body.feedbackData && !feedback) { bad(res, 400, '反馈文件格式不正确或超过 4 MB'); return; }
      if (!['none', 'optional_photo_or_video'].includes(task.feedback_type)) {
        if (!feedback) { bad(res, 400, '请按任务要求上传学习反馈，文件最大 4 MB'); return; }
        if (task.feedback_type === 'photo' && feedback.kind !== 'image') { bad(res, 400, '该任务需要上传图片反馈'); return; }
        if (task.feedback_type === 'video' && feedback.kind !== 'video') { bad(res, 400, '该任务需要上传视频反馈'); return; }
      }
      try {
        db.prepare("UPDATE tasks SET status = ?, submitted_at = ?, feedback_kind = ?, feedback_data = '', feedback_url = ?, feedback_name = ?, feedback_note = ?, submitted_active_pet_id = COALESCE(submitted_active_pet_id, ?), pet_business_date = COALESCE(pet_business_date, ?) WHERE id = ?").run(task.needs_review ? 'pending_review' : 'completed', now(), feedback?.kind || '', feedback?.url || '', feedbackName, feedbackNote, petId, petDate, task.id);
      } catch (error) {
        if (feedback?.uploadedUrl) await deleteStoredUrl(feedback.uploadedUrl, { dataDir }).catch(() => {});
        throw error;
      }
      if (task.feedback_url && task.feedback_url !== feedback?.url) deleteStoredUrl(task.feedback_url, { dataDir }).catch(error => console.error('清理旧反馈文件失败：', error.message));
      if (!task.needs_review) {
        db.prepare('INSERT INTO rewards (student_id, task_id, stars, message, created_at) VALUES (?, ?, ?, ?, ?)').run(user.id, task.id, task.stars, '完成得很棒！', now());
        publishPetEvent({ eventType: 'TASK_COMPLETED', sourceType: 'task_complete', sourceId: String(task.id), studentId: user.id, petId, businessDate: petDate, requestedDelta: 10 * Math.max(0, Number(task.pet_exp_weight_snapshot ?? 1) || 0), occurredAt: now(), reason: `完成任务：${task.title}` });
        reconcileDailyPetCompletion(user.id, petDate);
      }
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
        json(res, 200, { students: [], selectedStudentId: null, period: { today: currentDate, weekStart: week.start, weekEnd: week.end }, growth: rewardBreakdown(0), summary: { weekCompleted: 0, weekTotal: 0, weekOverdue: 0, pending: 0, todayCompleted: 0, todayTotal: 0, weekStars: 0, totalStars: 0, readingActiveBookCount: 0, readingCompletedBookCount: 0, readingBookCount: 0 }, pending: [] });
        return;
      }
      const studentId = Number(url.searchParams.get('studentId') || students[0]?.id);
      if (!students.some(student => student.id === studentId)) { bad(res, 403, '无权查看该学生'); return; }
      const pendingTasks = db.prepare(`SELECT tasks.*, users.display_name AS student_name, users.avatar AS student_avatar, ${taskResourceSummarySql} FROM tasks JOIN users ON users.id = tasks.student_id WHERE tasks.student_id = ? AND tasks.status = 'pending_review' AND tasks.task_type <> 'assessment' AND tasks.is_demo = 0 ORDER BY tasks.submitted_at`).all(studentId).map(taskJson);
      const pendingRewards = db.prepare(`SELECT reward_applications.*, users.display_name AS student_name, users.avatar AS student_avatar FROM reward_applications JOIN users ON users.id = reward_applications.student_id WHERE reward_applications.student_id = ? AND reward_applications.status = 'pending' ORDER BY reward_applications.created_at DESC`).all(studentId).map(row => rewardApplicationJson(row));
      const pendingReadings = db.prepare(`${readingCheckinSelectSql} WHERE reading_checkins.student_id = ? AND reading_checkins.status = 'pending_review' ORDER BY reading_checkins.submitted_at DESC, reading_checkins.id DESC`).all(studentId).map(row => readingCheckinJson(row));
      const pendingAssessments = db.prepare("SELECT assessment_assignments.*, tasks.status AS task_status, users.display_name AS student_name, users.avatar AS student_avatar FROM assessment_assignments JOIN tasks ON tasks.id = assessment_assignments.student_task_id JOIN users ON users.id = assessment_assignments.student_id WHERE assessment_assignments.student_id = ? AND tasks.status = 'pending_review' ORDER BY assessment_assignments.updated_at DESC, assessment_assignments.id DESC").all(studentId).map(row => ({ ...assessmentAssignmentJson(row), studentName: row.student_name, studentAvatar: signStoredUrl(row.student_avatar || '') }));
      const pending = [
        ...pendingTasks.map(value => ({ type: 'task', value, submittedAt: value.submittedAt })),
        ...pendingRewards.map(value => ({ type: 'reward', value, submittedAt: value.createdAt })),
        ...pendingReadings.map(value => ({ type: 'reading', value, submittedAt: value.submittedAt })),
        ...pendingAssessments.map(value => ({ type: 'assessment', value, submittedAt: value.attempt?.submittedAt || value.updatedAt }))
      ].sort((left, right) => String(right.submittedAt || '').localeCompare(String(left.submittedAt || '')));
      const currentDate = businessDate();
      const week = weekRange(currentDate);
      const todayTasks = db.prepare("SELECT status FROM tasks WHERE student_id = ? AND task_type <> 'assessment' AND ((schedule_type = 'range' AND available_start_date <= ? AND available_end_date >= ?) OR (schedule_type <> 'range' AND task_date = ?)) AND is_demo = 0").all(studentId, currentDate, currentDate, currentDate);
      const weekTasks = db.prepare("SELECT status, task_date FROM tasks WHERE student_id = ? AND task_type <> 'assessment' AND ((schedule_type = 'range' AND available_start_date <= ? AND available_end_date >= ?) OR (schedule_type <> 'range' AND task_date BETWEEN ? AND ?)) AND is_demo = 0").all(studentId, week.end, week.start, week.start, week.end);
      const weekStars = Number(db.prepare('SELECT COALESCE(SUM(stars),0) AS total FROM rewards WHERE student_id = ? AND substr(created_at, 1, 10) BETWEEN ? AND ? AND (task_id IS NULL OR task_id IN (SELECT id FROM tasks WHERE is_demo = 0))').get(studentId, week.start, week.end).total);
      const totalStars = Number(db.prepare('SELECT COALESCE(SUM(stars),0) AS total FROM rewards WHERE student_id = ? AND (task_id IS NULL OR task_id IN (SELECT id FROM tasks WHERE is_demo = 0))').get(studentId).total);
      const readingActiveBookCount = Number(db.prepare("SELECT COUNT(DISTINCT book_id) AS total FROM reading_plans WHERE student_id = ? AND status IN ('active','paused','awaiting_confirmation')").get(studentId).total || 0);
      const readingCompletedBookCount = Number(db.prepare("SELECT COUNT(DISTINCT book_id) AS total FROM reading_plans WHERE student_id = ? AND status = 'completed'").get(studentId).total || 0);
      const readingBookCount = Number(db.prepare("SELECT COUNT(DISTINCT book_id) AS total FROM reading_plans WHERE student_id = ? AND status IN ('active','paused','awaiting_confirmation','completed')").get(studentId).total || 0);
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
          readingPending: pendingReadings.length,
          todayCompleted: todayTasks.filter(task => task.status === 'completed').length,
          todayTotal: todayTasks.length,
          weekStars,
          totalStars,
          readingActiveBookCount,
          readingCompletedBookCount,
          readingBookCount
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
    if (req.method === 'GET' && url.pathname === '/api/parent/reading/books') {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return;
      const fields = `reading_books.*, users.display_name AS creator_name,
        (SELECT COUNT(*) FROM reading_plans WHERE reading_plans.book_id = reading_books.id) AS plan_count,
        (SELECT COUNT(*) FROM reading_plans WHERE reading_plans.book_id = reading_books.id AND reading_plans.status IN ('active','paused','awaiting_confirmation')) AS active_plan_count`;
      const rows = db.prepare(`SELECT ${fields} FROM reading_books JOIN users ON users.id = reading_books.creator_id WHERE reading_books.creator_id = ? ORDER BY reading_books.updated_at DESC, reading_books.id DESC`).all(user.id);
      json(res, 200, { books: rows.map(readingBookJson) }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/parent/reading/books') {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return;
      const body = await readBody(req, 6 * 1024 * 1024); const title = clean(body.title, 100); const author = clean(body.author, 80);
      const totalPages = Number(body.totalPages); const publisher = clean(body.publisher, 100); const isbn = clean(body.isbn, 32);
      if (title.length < 1 || !Number.isSafeInteger(totalPages) || totalPages < 1 || totalPages > 100000) { bad(res, 400, '请填写书名和有效的总页数'); return; }
      const cover = await readingCoverValue(body.coverData, '', title); if (!cover) { bad(res, 400, '封面仅支持 JPG、PNG 或 WebP 图片'); return; }
      const createdAt = now(); let result;
      try { result = db.prepare('INSERT INTO reading_books (creator_id, title, author, cover_url, total_pages, publisher, isbn, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(user.id, title, author, cover.url, totalPages, publisher, isbn, createdAt, createdAt); }
      catch (error) { if (cover.uploadedUrl) await deleteStoredUrl(cover.uploadedUrl, { dataDir }).catch(() => {}); throw error; }
      const book = db.prepare(`SELECT reading_books.*, users.display_name AS creator_name FROM reading_books JOIN users ON users.id = reading_books.creator_id WHERE reading_books.id = ?`).get(result.lastInsertRowid);
      json(res, 201, { book: readingBookJson(book) }); return;
    }
    if (req.method === 'PATCH' && /^\/api\/parent\/reading\/books\/\d+$/.test(url.pathname)) {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return; const id = Number(url.pathname.split('/').pop());
      const book = db.prepare('SELECT * FROM reading_books WHERE id = ?').get(id);
      if (!book || Number(book.creator_id) !== Number(user.id)) { bad(res, 404, '书籍不存在或无权修改'); return; }
      const body = await readBody(req, 6 * 1024 * 1024); const title = clean(body.title, 100); const author = clean(body.author, 80);
      const totalPages = Number(body.totalPages); const publisher = clean(body.publisher, 100); const isbn = clean(body.isbn, 32);
      if (!title || !Number.isSafeInteger(totalPages) || totalPages < 1 || totalPages > 100000) { bad(res, 400, '请填写书名和有效的总页数'); return; }
      const pageBounds = db.prepare(`SELECT MAX(reading_plans.start_page) AS start_page, MAX(reading_plans.current_page) AS current_page,
        MAX(reading_checkins.end_page) AS checked_page
        FROM reading_plans LEFT JOIN reading_checkins ON reading_checkins.plan_id = reading_plans.id
        WHERE reading_plans.book_id = ?`).get(id);
      const minimumPages = Math.max(Number(pageBounds?.start_page || 0), Number(pageBounds?.current_page || 0), Number(pageBounds?.checked_page || 0));
      if (totalPages < minimumPages) { bad(res, 409, `总页数不能小于已有阅读进度（第 ${minimumPages} 页）`); return; }
      const cover = await readingCoverValue(body.coverData, book.cover_url, title); if (!cover) { bad(res, 400, '封面仅支持 JPG、PNG 或 WebP 图片'); return; }
      try { db.prepare('UPDATE reading_books SET title=?, author=?, cover_url=?, total_pages=?, publisher=?, isbn=?, updated_at=? WHERE id=?').run(title, author, cover.url, totalPages, publisher, isbn, now(), id); }
      catch (error) { if (cover.uploadedUrl) await deleteStoredUrl(cover.uploadedUrl, { dataDir }).catch(() => {}); throw error; }
      if (cover.url !== book.cover_url && book.cover_url) await deleteStoredUrl(book.cover_url, { dataDir }).catch(() => {});
      const updated = db.prepare(`SELECT reading_books.*, users.display_name AS creator_name,
        (SELECT COUNT(*) FROM reading_plans WHERE reading_plans.book_id = reading_books.id) AS plan_count,
        (SELECT COUNT(*) FROM reading_plans WHERE reading_plans.book_id = reading_books.id AND reading_plans.status IN ('active','paused','awaiting_confirmation')) AS active_plan_count
        FROM reading_books JOIN users ON users.id = reading_books.creator_id WHERE reading_books.id = ?`).get(id);
      json(res, 200, { book: readingBookJson(updated) }); return;
    }
    if (req.method === 'DELETE' && /^\/api\/parent\/reading\/books\/\d+$/.test(url.pathname)) {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return; const id = Number(url.pathname.split('/').pop());
      const book = db.prepare('SELECT * FROM reading_books WHERE id = ?').get(id);
      if (!book || Number(book.creator_id) !== Number(user.id)) { bad(res, 404, '书籍不存在或无权删除'); return; }
      const planCount = Number(db.prepare('SELECT COUNT(*) AS total FROM reading_plans WHERE book_id = ?').get(id).total || 0);
      if (planCount) { bad(res, 409, '该书籍已有阅读计划或历史记录，不能删除'); return; }
      db.prepare('DELETE FROM reading_books WHERE id = ?').run(id);
      if (book.cover_url) await deleteStoredUrl(book.cover_url, { dataDir }).catch(() => {});
      json(res, 204, {}); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/parent/reading/plans') {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return;
      const allowedIds = studentListFor(user).map(student => Number(student.id)); if (!allowedIds.length) { json(res, 200, { plans: [] }); return; }
      const requestedStudent = Number(url.searchParams.get('studentId')); const studentId = requestedStudent || null;
      if (studentId && !allowedIds.includes(studentId)) { bad(res, 403, '无权查看该学生的阅读计划'); return; }
      const conditions = [`reading_plans.student_id IN (${allowedIds.map(() => '?').join(',')})`]; const params = [...allowedIds];
      if (studentId) { conditions.push('reading_plans.student_id = ?'); params.push(studentId); }
      const rows = db.prepare(`${readingPlanSelectSql} WHERE ${conditions.join(' AND ')} ORDER BY reading_plans.updated_at DESC, reading_plans.id DESC`).all(...params);
      json(res, 200, { plans: rows.map(readingPlanJson) }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/parent/reading/plans') {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return;
      const body = await readBody(req); const bookId = Number(body.bookId); const startDate = clean(body.startDate, 10); const endDate = clean(body.endDate, 10);
      const startPage = Number(body.startPage || 1); const targetPages = Number(body.targetPages || 0); const targetMinutes = Number(body.targetMinutes || 0);
      const frequency = clean(body.frequency, 12) || 'daily'; const weekdays = [...new Set((Array.isArray(body.weekdays) ? body.weekdays : []).map(Number).filter(day => Number.isInteger(day) && day >= 1 && day <= 7))].sort((a, b) => a - b);
      const stars = Number(body.stars); const feedbackType = clean(body.feedbackType, 32) || 'optional_photo_or_video'; const studentIds = [...new Set((Array.isArray(body.studentIds) ? body.studentIds : [body.studentId]).map(Number).filter(Number.isSafeInteger))];
      const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && dateRange(value, value).length === 1;
      if (!Number.isSafeInteger(bookId) || !studentIds.length || !validDate(startDate) || (endDate && (!validDate(endDate) || endDate < startDate)) || !Number.isSafeInteger(startPage) || startPage < 1 || !['daily', 'weekly'].includes(frequency) || (frequency === 'weekly' && !weekdays.length) || (!Number.isSafeInteger(targetPages) && !Number.isSafeInteger(targetMinutes)) || (targetPages < 1 && targetMinutes < 1) || !Number.isSafeInteger(stars) || stars < 0 || !['none', 'photo', 'video', 'photo_or_video', 'optional_photo_or_video'].includes(feedbackType)) { bad(res, 400, '请完整填写阅读计划信息'); return; }
      const book = db.prepare('SELECT * FROM reading_books WHERE id = ?').get(bookId); if (!book || Number(book.creator_id) !== Number(user.id)) { bad(res, 404, '书籍不存在或无权使用'); return; }
      if (startPage > book.total_pages) { bad(res, 400, '起始页不能超过书籍总页数'); return; }
      if (studentIds.some(studentId => !canManageStudent(user, studentId))) { bad(res, 403, '只能给已关联学生创建阅读计划'); return; }
      const overlap = db.prepare("SELECT 1 FROM reading_plans WHERE book_id = ? AND student_id = ? AND status IN ('active','paused','awaiting_confirmation') LIMIT 1");
      if (studentIds.some(studentId => overlap.get(bookId, studentId))) { bad(res, 409, '同一学生与书籍当前已有未结束的阅读计划'); return; }
      const createdAt = now(); const insert = db.prepare(`INSERT INTO reading_plans (book_id, student_id, creator_id, start_date, end_date, start_page, target_pages, target_minutes, frequency, weekdays, needs_review, stars, feedback_type, current_page, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`);
      db.exec('BEGIN'); let ids = []; try { ids = studentIds.map(studentId => Number(insert.run(bookId, studentId, user.id, startDate, endDate, startPage, targetPages || null, targetMinutes || null, frequency, weekdays.join(','), body.needsReview === false ? 0 : 1, stars, feedbackType, startPage - 1, createdAt, createdAt).lastInsertRowid)); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; }
      const marks = ids.map(() => '?').join(','); const plans = db.prepare(`${readingPlanSelectSql} WHERE reading_plans.id IN (${marks}) ORDER BY reading_plans.id`).all(...ids).map(readingPlanJson);
      json(res, 201, { plans }); return;
    }
    if (req.method === 'PATCH' && /^\/api\/parent\/reading\/plans\/\d+$/.test(url.pathname)) {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return; const id = Number(url.pathname.split('/').pop());
      const plan = db.prepare(`${readingPlanSelectSql} WHERE reading_plans.id = ?`).get(id); if (!plan || !canManageStudent(user, plan.student_id)) { bad(res, 404, '阅读计划不存在'); return; }
      if (!['active', 'paused'].includes(plan.status)) { bad(res, 409, '已完成或待确认的计划不能再修改'); return; }
      const body = await readBody(req); const startDate = clean(body.startDate, 10) || plan.start_date; const endDate = Object.hasOwn(body, 'endDate') ? clean(body.endDate, 10) : plan.end_date;
      const targetPages = Object.hasOwn(body, 'targetPages') ? Number(body.targetPages || 0) : plan.target_pages; const targetMinutes = Object.hasOwn(body, 'targetMinutes') ? Number(body.targetMinutes || 0) : plan.target_minutes;
      const frequency = clean(body.frequency, 12) || plan.frequency; const weekdays = [...new Set((Array.isArray(body.weekdays) ? body.weekdays : String(plan.weekdays || '').split(',')).map(Number).filter(day => Number.isInteger(day) && day >= 1 && day <= 7))].sort((a, b) => a - b);
      const stars = Object.hasOwn(body, 'stars') ? Number(body.stars) : Number(plan.stars); const feedbackType = clean(body.feedbackType, 32) || plan.feedback_type;
      const needsReview = Object.hasOwn(body, 'needsReview') ? (body.needsReview === false ? 0 : 1) : Number(plan.needs_review);
      const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && dateRange(value, value).length === 1;
      const dateBounds = db.prepare('SELECT MIN(checkin_date) AS first_date, MAX(checkin_date) AS last_date FROM reading_checkins WHERE plan_id = ?').get(id);
      if (!validDate(startDate) || (endDate && (!validDate(endDate) || endDate < startDate)) || (Number(targetPages || 0) < 1 && Number(targetMinutes || 0) < 1) || !['daily', 'weekly'].includes(frequency) || (frequency === 'weekly' && !weekdays.length) || !Number.isSafeInteger(stars) || stars < 0 || !['none', 'photo', 'video', 'photo_or_video', 'optional_photo_or_video'].includes(feedbackType)) { bad(res, 400, '请完整填写有效的计划信息'); return; }
      if (dateBounds.first_date && startDate > dateBounds.first_date) { bad(res, 409, '开始日期不能晚于已有打卡记录'); return; }
      if (dateBounds.last_date && endDate && endDate < dateBounds.last_date) { bad(res, 409, '结束日期不能早于已有打卡记录'); return; }
      db.prepare('UPDATE reading_plans SET start_date=?, end_date=?, target_pages=?, target_minutes=?, frequency=?, weekdays=?, needs_review=?, stars=?, feedback_type=?, updated_at=? WHERE id=?').run(startDate, endDate, targetPages || null, targetMinutes || null, frequency, weekdays.join(','), needsReview, stars, feedbackType, now(), id);
      const updated = db.prepare(`${readingPlanSelectSql} WHERE reading_plans.id = ?`).get(id); json(res, 200, { plan: readingPlanJson(updated) }); return;
    }
    if (req.method === 'DELETE' && /^\/api\/parent\/reading\/plans\/\d+$/.test(url.pathname)) {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return; const id = Number(url.pathname.split('/').pop());
      const plan = db.prepare(`${readingPlanSelectSql} WHERE reading_plans.id = ?`).get(id); if (!plan || !canManageStudent(user, plan.student_id)) { bad(res, 404, '阅读计划不存在'); return; }
      if (!['active', 'paused'].includes(plan.status)) { bad(res, 409, '已完成、待确认或已删除的计划不能再次删除'); return; }
      db.prepare("UPDATE reading_plans SET status='archived', updated_at=? WHERE id=?").run(now(), id);
      json(res, 204, {}); return;
    }
    if (req.method === 'POST' && /^\/api\/parent\/reading\/plans\/\d+\/confirm-completion$/.test(url.pathname)) {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return; const id = Number(url.pathname.split('/')[5]);
      const plan = db.prepare(`${readingPlanSelectSql} WHERE reading_plans.id = ?`).get(id); if (!plan || !canManageStudent(user, plan.student_id)) { bad(res, 404, '阅读计划不存在'); return; }
      if (plan.status !== 'awaiting_confirmation' || Number(plan.current_page) < Number(plan.total_pages)) { bad(res, 409, '当前计划尚未满足完成确认条件'); return; }
      const completedAt = now(); db.prepare("UPDATE reading_plans SET status='completed', completed_by=?, completed_at=?, updated_at=? WHERE id=?").run(user.id, completedAt, completedAt, id);
      const updated = db.prepare(`${readingPlanSelectSql} WHERE reading_plans.id = ?`).get(id); json(res, 200, { plan: readingPlanJson(updated) }); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/student/reading') {
      const user = requireUser(req, res); if (!user) return; if (user.role !== 'student') { bad(res, 403, '学生账号专属接口'); return; }
      const currentDate = businessDate(); const month = clean(url.searchParams.get('month'), 7) || currentDate.slice(0, 7);
      const queryDate = clean(url.searchParams.get('date'), 10) || currentDate;
      const earliestMakeup = addDateStr(currentDate, -3);
      if (queryDate > currentDate || queryDate < earliestMakeup) { bad(res, 400, '只能查看当天或过去 3 天内的打卡'); return; }
      if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)) { bad(res, 400, '月份格式不正确'); return; }
      const calendar = monthRange(`${month}-01`);
      const plans = db.prepare(`${readingPlanSelectSql} WHERE reading_plans.student_id = ? AND reading_plans.status = 'active' ORDER BY reading_plans.created_at DESC, reading_plans.id DESC`).all(user.id);
      const monthChecks = db.prepare(`${readingCheckinSelectSql} WHERE reading_checkins.student_id = ? AND reading_checkins.checkin_date BETWEEN ? AND ? ORDER BY reading_checkins.checkin_date DESC, reading_checkins.id DESC`).all(user.id, calendar.start, calendar.end);
      const dateChecks = db.prepare(`${readingCheckinSelectSql} WHERE reading_checkins.student_id = ? AND reading_checkins.checkin_date = ? ORDER BY reading_checkins.id DESC`).all(user.id, queryDate);
      const dateChecksByPlan = new Map(plans.map(plan => [plan.id, dateChecks.filter(check => check.plan_id === plan.id)]));
      const cards = plans.map(plan => {
        const planChecks = dateChecksByPlan.get(plan.id) || []; const existing = planChecks.find(check => check.status === 'needs_more') || planChecks[0];
        const startPage = existing?.status === 'needs_more' ? Number(existing.start_page) : Math.max(Number(plan.start_page), approvedReadingEndPage(plan.id) + 1);
        const dueOnDate = readingDueOn(plan, queryDate);
        const hasPending = planChecks.some(check => check.status === 'pending_review'); const remaining = Math.max(0, 3 - planChecks.length);
        const isToday = queryDate === currentDate;
        const canCheckin = Boolean(dueOnDate && startPage <= Number(plan.total_pages) && !hasPending && (existing?.status === 'needs_more' || remaining > 0));
        const unavailableReason = hasPending ? '有打卡待审核' : !dueOnDate ? (isToday ? '今日不安排' : '该日不安排') : startPage > Number(plan.total_pages) ? '已读完，等待确认' : remaining === 0 ? '本书当日已达 3 次' : '';
        return { plan: readingPlanJson(plan), checkin: existing ? readingCheckinJson(existing, true) : null, todayCheckins: planChecks.map(check => readingCheckinJson(check, true)), todayCount: planChecks.length, dailyLimit: { max: 3, remaining, hasPending }, expectedStartPage: startPage, canCheckin, unavailableReason, checkinDate: queryDate };
      });
      const readingDays = Number(db.prepare('SELECT COUNT(DISTINCT checkin_date) AS total FROM reading_checkins WHERE student_id = ?').get(user.id).total || 0);
      const activeBookCount = Number(db.prepare("SELECT COUNT(DISTINCT book_id) AS total FROM reading_plans WHERE student_id = ? AND status = 'active'").get(user.id).total || 0);
      const awardedStars = Number(db.prepare('SELECT COALESCE(SUM(stars), 0) AS total FROM rewards WHERE student_id = ? AND reading_checkin_id IS NOT NULL').get(user.id).total || 0);
      const completedBooks = db.prepare(`SELECT reading_books.id, reading_books.title, reading_books.cover_url, COUNT(*) AS completed_count, MAX(reading_plans.completed_at) AS completed_at
        FROM reading_plans JOIN reading_books ON reading_books.id = reading_plans.book_id
        WHERE reading_plans.student_id = ? AND reading_plans.status = 'completed'
        GROUP BY reading_books.id, reading_books.title, reading_books.cover_url
        ORDER BY completed_at DESC, reading_books.id DESC`).all(user.id).map(book => ({ id: book.id, title: book.title, coverUrl: signStoredUrl(book.cover_url || ''), completedCount: Number(book.completed_count), completedAt: book.completed_at }));
      const checkinDates = [...new Set(monthChecks.map(check => check.checkin_date))];
      json(res, 200, { month, calendar, today: currentDate, selectedDate: queryDate, cards, checkinDates, summary: { readingDays, activeBookCount, awardedStars, growth: rewardBreakdown(awardedStars), completedBookCount: completedBooks.length, completedBookTimes: completedBooks.reduce((total, book) => total + book.completedCount, 0) }, achievements: { completedBooks } }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/student/reading/checkins') {
      const user = requireUser(req, res); if (!user) return; if (user.role !== 'student') { bad(res, 403, '学生账号专属接口'); return; }
      const body = await readBody(req, 6 * 1024 * 1024); const planId = Number(body.planId); const checkinDate = clean(body.checkinDate, 10) || businessDate(); const endPage = Number(body.endPage); const reflection = clean(body.reflection, 600);
      const plan = db.prepare(`${readingPlanSelectSql} WHERE reading_plans.id = ? AND reading_plans.student_id = ?`).get(planId, user.id);
      if (!plan || plan.status !== 'active') { bad(res, 404, '阅读计划不存在或已结束'); return; }
      if (!readingDueOn(plan, checkinDate) || checkinDate > businessDate()) { bad(res, 400, '只能在计划阅读日提交当天或历史打卡'); return; }
      const todayDate = businessDate();
      const earliestMakeup = addDateStr(todayDate, -3);
      if (checkinDate < earliestMakeup) { bad(res, 400, '最多补打卡过去 3 天内的日期'); return; }
      const dailyChecks = db.prepare('SELECT * FROM reading_checkins WHERE plan_id = ? AND checkin_date = ? ORDER BY id DESC').all(planId, checkinDate);
      const existing = dailyChecks.find(check => check.status === 'needs_more');
      if (dailyChecks.some(check => check.status === 'pending_review')) { bad(res, 409, '本书当天已有打卡待审核，请等待家长审核后再提交'); return; }
      if (!existing && dailyChecks.length >= 3) { bad(res, 409, '同一本书每天最多提交 3 次阅读打卡'); return; }
      const startPage = existing ? existing.start_page : Math.max(Number(plan.start_page), approvedReadingEndPage(planId) + 1);
      if (!Number.isSafeInteger(endPage) || endPage < startPage || endPage > Number(plan.total_pages)) { bad(res, 400, `结束页应为 ${startPage} 至 ${plan.total_pages} 的整数`); return; }
      const feedbackRequired = !['none', 'optional_photo_or_video'].includes(plan.feedback_type); const feedback = await readingFeedbackValue(body.feedbackData, existing?.feedback_url || '', body.feedbackName || '阅读打卡反馈');
      if (!feedback || (feedbackRequired && !feedback.url)) { bad(res, 400, feedback ? '请按阅读计划要求上传反馈' : '反馈文件仅支持图片或视频，且不超过 4 MB'); return; }
      if (plan.feedback_type === 'photo' && feedback.kind && feedback.kind !== 'image') { bad(res, 400, '该计划仅支持图片反馈'); return; }
      if (plan.feedback_type === 'video' && feedback.kind && feedback.kind !== 'video') { bad(res, 400, '该计划仅支持视频反馈'); return; }
      const submittedAt = now(); const status = plan.needs_review ? 'pending_review' : 'completed';
      const submissionPet = activePetForStudent(user.id); const petId = existing?.submitted_active_pet_id || submissionPet?.id || null;
      db.exec('BEGIN'); let id; try {
        if (existing) { db.prepare('UPDATE reading_checkins SET start_page=?, end_page=?, pages_read=?, reflection=?, feedback_kind=?, feedback_url=?, feedback_name=?, status=?, submitted_at=?, parent_message=\'\', awarded_stars=?, submitted_active_pet_id=COALESCE(submitted_active_pet_id, ?), pet_business_date=COALESCE(pet_business_date, ?), updated_at=? WHERE id=?').run(startPage, endPage, endPage - startPage + 1, reflection, feedback.kind, feedback.url, clean(body.feedbackName, 120), status, submittedAt, plan.needs_review ? null : plan.stars, petId, checkinDate, submittedAt, existing.id); id = existing.id; }
        else { id = Number(db.prepare('INSERT INTO reading_checkins (plan_id, student_id, checkin_date, start_page, end_page, pages_read, reflection, feedback_kind, feedback_url, feedback_name, status, submitted_at, awarded_stars, submitted_active_pet_id, pet_business_date, created_at, updated_at, checkin_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(planId, user.id, checkinDate, startPage, endPage, endPage - startPage + 1, reflection, feedback.kind, feedback.url, clean(body.feedbackName, 120), status, submittedAt, plan.needs_review ? null : plan.stars, petId, checkinDate, submittedAt, submittedAt, dailyChecks.length + 1).lastInsertRowid); }
        if (!plan.needs_review) { db.prepare('UPDATE reading_plans SET current_page = MAX(current_page, ?), status = CASE WHEN MAX(current_page, ?) >= ? THEN \'awaiting_confirmation\' ELSE status END, updated_at=? WHERE id=?').run(endPage, endPage, plan.total_pages, submittedAt, planId); if (plan.stars > 0) db.prepare('INSERT INTO rewards (student_id, task_id, reading_checkin_id, stars, message, created_at) VALUES (?, NULL, ?, ?, ?, ?)').run(user.id, id, plan.stars, `阅读打卡：${plan.book_title}`, submittedAt); }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); if (feedback.uploadedUrl) await deleteStoredUrl(feedback.uploadedUrl, { dataDir }).catch(() => {}); throw error; }
      if (!plan.needs_review) publishPetEvent({ eventType: 'READING_COMPLETED', sourceType: 'reading_complete', sourceId: String(id), studentId: user.id, petId, businessDate: checkinDate, requestedDelta: 5, occurredAt: submittedAt, reason: `完成阅读打卡：${plan.book_title}` });
      const checkin = db.prepare(`${readingCheckinSelectSql} WHERE reading_checkins.id = ?`).get(id); json(res, 201, { checkin: readingCheckinJson(checkin, true) }); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/parent/reading/checkins') {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return; const allowedIds = studentListFor(user).map(student => Number(student.id)); if (!allowedIds.length) { json(res, 200, { checkins: [] }); return; }
      const status = clean(url.searchParams.get('status'), 20) || 'pending_review'; const valid = ['pending_review', 'needs_more', 'completed', 'all']; if (!valid.includes(status)) { bad(res, 400, '状态不正确'); return; }
      const conditions = [`reading_checkins.student_id IN (${allowedIds.map(() => '?').join(',')})`]; const params = [...allowedIds]; if (status !== 'all') { conditions.push('reading_checkins.status = ?'); params.push(status); }
      const rows = db.prepare(`${readingCheckinSelectSql} WHERE ${conditions.join(' AND ')} ORDER BY reading_checkins.submitted_at DESC, reading_checkins.id DESC`).all(...params);
      json(res, 200, { checkins: rows.map(row => readingCheckinJson(row)) }); return;
    }
    if (req.method === 'GET' && /^\/api\/parent\/reading\/checkins\/\d+$/.test(url.pathname)) {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return; const id = Number(url.pathname.split('/').pop());
      const row = db.prepare(`${readingCheckinSelectSql} WHERE reading_checkins.id = ?`).get(id); if (!row || !canManageStudent(user, row.student_id)) { bad(res, 404, '阅读打卡不存在'); return; }
      json(res, 200, { checkin: readingCheckinJson(row, true) }); return;
    }
    if (req.method === 'POST' && /^\/api\/parent\/reading\/checkins\/\d+\/review$/.test(url.pathname)) {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return; const id = Number(url.pathname.split('/')[5]); const body = await readBody(req);
      const checkin = db.prepare(`${readingCheckinSelectSql} WHERE reading_checkins.id = ?`).get(id); if (!checkin || !canManageStudent(user, checkin.student_id)) { bad(res, 404, '阅读打卡不存在'); return; }
      if (checkin.status !== 'pending_review') { bad(res, 409, '该阅读打卡已经处理'); return; }
      const action = clean(body.action, 16); const message = clean(body.message, 300); const adjustedEndPage = Object.hasOwn(body, 'endPage') ? Number(body.endPage) : Number(checkin.end_page);
      const awardedStars = Object.hasOwn(body, 'stars') ? Number(body.stars) : Number(checkin.plan_stars);
      if (!['approve', 'needs_more'].includes(action) || !Number.isSafeInteger(adjustedEndPage) || adjustedEndPage < checkin.start_page || adjustedEndPage > checkin.total_pages || (action === 'approve' && (!Number.isSafeInteger(awardedStars) || awardedStars < 0))) { bad(res, 400, '审核信息不正确'); return; }
      const reason = clean(body.adjustmentReason, 300); if (action === 'approve' && adjustedEndPage !== Number(checkin.end_page) && !reason) { bad(res, 400, '调整阅读结束页时请填写调整原因'); return; }
      const reviewedAt = now(); db.exec('BEGIN'); try {
        if (action === 'needs_more') db.prepare("UPDATE reading_checkins SET status='needs_more', parent_message=?, reviewed_by=?, reviewed_at=?, updated_at=? WHERE id=?").run(message, user.id, reviewedAt, reviewedAt, id);
        else { db.prepare("UPDATE reading_checkins SET status='completed', end_page=?, pages_read=?, parent_message=?, reviewed_by=?, reviewed_at=?, original_end_page=COALESCE(original_end_page, end_page), adjusted_end_page=?, adjustment_reason=?, awarded_stars=?, updated_at=? WHERE id=?").run(adjustedEndPage, adjustedEndPage - checkin.start_page + 1, message, user.id, reviewedAt, adjustedEndPage, reason, awardedStars, reviewedAt, id); db.prepare("UPDATE reading_plans SET current_page=MAX(current_page, ?), status=CASE WHEN MAX(current_page, ?) >= ? THEN 'awaiting_confirmation' ELSE status END, updated_at=? WHERE id=?").run(adjustedEndPage, adjustedEndPage, checkin.total_pages, reviewedAt, checkin.plan_id); if (awardedStars > 0) db.prepare('INSERT INTO rewards (student_id, task_id, reading_checkin_id, stars, message, created_at) VALUES (?, NULL, ?, ?, ?, ?)').run(checkin.student_id, id, awardedStars, message || `阅读打卡：${checkin.book_title}`, reviewedAt); }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      if (action === 'approve') publishPetEvent({ eventType: 'READING_COMPLETED', sourceType: 'reading_complete', sourceId: String(id), studentId: checkin.student_id, petId: checkin.submitted_active_pet_id, businessDate: checkin.pet_business_date || checkin.checkin_date, requestedDelta: 5, occurredAt: reviewedAt, reason: `审核通过阅读打卡：${checkin.book_title}` });
      const updated = db.prepare(`${readingCheckinSelectSql} WHERE reading_checkins.id = ?`).get(id); json(res, 200, { checkin: readingCheckinJson(updated, true) }); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/parent/reviews') {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return;
      const students = studentListFor(user);
      const allowedIds = students.map(student => Number(student.id));
      if (!allowedIds.length) { json(res, 200, { reviews: [] }); return; }
      const requestedStudent = url.searchParams.get('studentId');
      const studentId = requestedStudent && requestedStudent !== 'all' ? Number(requestedStudent) : null;
      if (studentId && !allowedIds.includes(studentId)) { bad(res, 403, '无权查看该学生的审核任务'); return; }
      const conditions = ["tasks.status = 'pending_review'", "tasks.task_type <> 'assessment'", 'tasks.is_demo = 0', `tasks.student_id IN (${allowedIds.map(() => '?').join(',')})`];
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
    if (req.method === 'GET' && url.pathname === '/api/parent/reward-applications') {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return;
      const allowedIds = studentListFor(user).map(student => Number(student.id)); if (!allowedIds.length) { json(res, 200, { applications: [] }); return; }
      const status = clean(url.searchParams.get('status'), 12) || 'pending'; const valid = ['pending', 'approved', 'rejected', 'all']; if (!valid.includes(status)) { bad(res, 400, '状态不正确'); return; }
      const conditions = [`student_id IN (${allowedIds.map(() => '?').join(',')})`]; const params = [...allowedIds]; if (status !== 'all') { conditions.push('reward_applications.status = ?'); params.push(status); }
      const rows = db.prepare(`SELECT reward_applications.*, users.display_name AS student_name, users.avatar AS student_avatar FROM reward_applications JOIN users ON users.id = reward_applications.student_id WHERE ${conditions.join(' AND ')} ORDER BY users.display_name, created_at DESC, id DESC`).all(...params);
      json(res, 200, { applications: rows.map(row => rewardApplicationJson(row)) }); return;
    }
    if (req.method === 'GET' && /^\/api\/parent\/reward-applications\/\d+$/.test(url.pathname)) {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return; const id = Number(url.pathname.split('/').pop());
      const row = db.prepare(`SELECT reward_applications.*, users.display_name AS student_name, users.avatar AS student_avatar FROM reward_applications JOIN users ON users.id = reward_applications.student_id WHERE reward_applications.id = ?`).get(id);
      if (!row || !canManageStudent(user, row.student_id)) { bad(res, 404, '奖励申请不存在'); return; } json(res, 200, { application: rewardApplicationJson(row, true) }); return;
    }
    if (req.method === 'POST' && /^\/api\/parent\/reward-applications\/\d+\/review$/.test(url.pathname)) {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return; const id = Number(url.pathname.split('/')[4]);
      const row = db.prepare('SELECT * FROM reward_applications WHERE id = ?').get(id); if (!row || !canManageStudent(user, row.student_id)) { bad(res, 404, '奖励申请不存在'); return; }
      if (row.status !== 'pending') { bad(res, 409, '该申请已经审核'); return; }
      const body = await readBody(req); const action = clean(body.action, 12); const message = clean(body.message, 300); const reviewedAt = now();
      if (!['approve', 'reject'].includes(action)) { bad(res, 400, '审核操作不正确'); return; }
      const stars = Number(body.stars); if (action === 'approve' && (!Number.isSafeInteger(stars) || stars < 0)) { bad(res, 400, '实际奖励星星数不正确'); return; }
      db.exec('BEGIN'); try {
        db.prepare('UPDATE reward_applications SET status=?, awarded_stars=?, parent_message=?, reviewed_by=?, reviewed_at=?, updated_at=? WHERE id=?').run(action === 'approve' ? 'approved' : 'rejected', action === 'approve' ? stars : null, message, user.id, reviewedAt, reviewedAt, id);
        if (action === 'approve' && stars > 0) db.prepare('INSERT INTO rewards (student_id, task_id, stars, message, created_at) VALUES (?, NULL, ?, ?, ?)').run(row.student_id, stars, message || `奖励申请：${row.content}`, reviewedAt);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      const updated = db.prepare(`SELECT reward_applications.*, users.display_name AS student_name, users.avatar AS student_avatar FROM reward_applications JOIN users ON users.id = reward_applications.student_id WHERE reward_applications.id = ?`).get(id);
      json(res, 200, { application: rewardApplicationJson(updated, true) }); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/parent/statistics') {
      const user = requireUser(req, res); if (!user || !requireParent(user, res)) return;
      const period = clean(url.searchParams.get('period'), 16) || 'week';
      const range = statsRange(period, clean(url.searchParams.get('startDate'), 10), clean(url.searchParams.get('endDate'), 10));
      if (!range) { bad(res, 400, '请选择有效的统计日期范围'); return; }
      const students = studentListFor(user);
      const taskStats = db.prepare(`SELECT COUNT(*) AS total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN status = 'completed' AND submitted_at IS NOT NULL AND substr(submitted_at, 1, 10) <= CASE WHEN schedule_type = 'range' THEN available_end_date ELSE task_date END THEN 1 ELSE 0 END) AS on_time
        FROM tasks
        WHERE student_id = ? AND is_demo = 0
          AND ((schedule_type = 'range' AND available_start_date <= ? AND available_end_date >= ?)
            OR (schedule_type <> 'range' AND task_date BETWEEN ? AND ?))`);
      const rewardStats = db.prepare('SELECT COALESCE(SUM(stars), 0) AS stars FROM rewards WHERE student_id = ? AND substr(created_at, 1, 10) BETWEEN ? AND ? AND (task_id IS NULL OR task_id IN (SELECT id FROM tasks WHERE is_demo = 0))');
      const readingStats = db.prepare(`SELECT COALESCE(SUM(CASE WHEN reading_checkins.status = 'completed' THEN reading_checkins.pages_read ELSE 0 END), 0) AS pages,
        SUM(CASE WHEN reading_checkins.status = 'completed' THEN 1 ELSE 0 END) AS checkins,
        SUM(CASE WHEN reading_checkins.status = 'pending_review' THEN 1 ELSE 0 END) AS pending
        FROM reading_checkins WHERE reading_checkins.student_id = ? AND reading_checkins.checkin_date BETWEEN ? AND ?`);
      const completedBooks = db.prepare("SELECT COUNT(*) AS total FROM reading_plans WHERE student_id = ? AND status = 'completed' AND substr(completed_at, 1, 10) BETWEEN ? AND ?");
      const rows = students.map(student => {
        const tasks = taskStats.get(student.id, range.end, range.start, range.start, range.end);
        const stars = Number(rewardStats.get(student.id, range.start, range.end).stars || 0);
        const reading = readingStats.get(student.id, range.start, range.end);
        const total = Number(tasks.total || 0); const completed = Number(tasks.completed || 0); const onTime = Number(tasks.on_time || 0);
        return { studentId: student.id, studentName: student.display_name, studentAvatar: signStoredUrl(student.avatar), active: Boolean(student.active), stars, growth: rewardBreakdown(stars), total, completed, onTime, readingPages: Number(reading.pages || 0), readingCheckins: Number(reading.checkins || 0), readingPending: Number(reading.pending || 0), completedBooks: Number(completedBooks.get(student.id, range.start, range.end).total || 0), completionRate: total ? Math.round(completed / total * 100) : null, onTimeRate: total ? Math.round(onTime / total * 100) : null };
      }).sort((a, b) => b.stars - a.stars || (b.completionRate ?? -1) - (a.completionRate ?? -1) || a.studentName.localeCompare(b.studentName, 'zh-CN'));
      const summary = rows.reduce((total, row) => ({ stars: total.stars + row.stars, tasks: total.tasks + row.total, completed: total.completed + row.completed, onTime: total.onTime + row.onTime, readingPages: total.readingPages + row.readingPages, readingCheckins: total.readingCheckins + row.readingCheckins, completedBooks: total.completedBooks + row.completedBooks }), { stars: 0, tasks: 0, completed: 0, onTime: 0, readingPages: 0, readingCheckins: 0, completedBooks: 0 });
      summary.completionRate = summary.tasks ? Math.round(summary.completed / summary.tasks * 100) : null;
      summary.onTimeRate = summary.tasks ? Math.round(summary.onTime / summary.tasks * 100) : null;
      summary.growth = rewardBreakdown(summary.stars);
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
        ORDER BY task_templates.created_at DESC, task_templates.id DESC`).all(user.id);
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
      const petExpWeight = Number(body.petExpWeight ?? copySource?.pet_exp_weight ?? 1);
      if (title.length < 1) { bad(res, 400, '任务模板标题不能为空'); return; }
      if (!category) { bad(res, 400, '请选择有效的任务分类'); return; }
      if (!['photo_or_video', 'optional_photo_or_video', 'photo', 'video', 'none'].includes(feedbackType)) { bad(res, 400, '请选择有效的反馈要求'); return; }
      if (!resources) { bad(res, 400, taskResourceValidationMessage(body)); return; }
      if (!Number.isInteger(duration) || duration < 1 || duration > 240) { bad(res, 400, '预计时长需为 1 至 240 分钟'); return; }
      if (!Number.isSafeInteger(stars) || stars < 1) { bad(res, 400, '奖励星星需为正整数'); return; }
      if (![0, 1, 2, 3].includes(petExpWeight)) { bad(res, 400, '萌宠经验权重需为 0、1、2 或 3'); return; }
      if (body.copyFromTemplateId && !copySource) { bad(res, 403, '只能复制自己创建的任务模板'); return; }
      const sourceResourceIds = copySource ? linkedResources('template', copySource.id, copySource.resource_id).map(resource => resource.id) : [];
      const copyReplacesResources = Boolean(copySource && (body.removeResource === true || Array.isArray(body.existingResourceIds) || Array.isArray(body.resources) || body.resourceData));
      const existingCopyResourceIds = copyReplacesResources ? normalizeExistingResourceIds(body) : sourceResourceIds;
      if (!existingCopyResourceIds || existingCopyResourceIds.some(id => !sourceResourceIds.includes(id)) || existingCopyResourceIds.length + resources.length > 5) { bad(res, 400, '任务资料选择无效或超过 5 个文件'); return; }
      const storedResources = copySource && !copyReplacesResources ? [] : await storeResources(resources, 'task-templates');
      db.exec('BEGIN');
      try {
        const resourceIds = copySource ? [...existingCopyResourceIds, ...insertResources(storedResources, user.id)] : insertResources(storedResources, user.id);
        const resourceId = resourceIds[0] || null;
        const createdAt = now();
        const result = db.prepare(`INSERT INTO task_templates (creator_id,title,category_id,detail,duration_minutes,stars,feedback_type,needs_review,pet_exp_weight,resource_id,is_public,created_at,updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(user.id, title, categoryId, detail || '请按照任务要求认真完成。', duration, stars, feedbackType, body.needsReview === false ? 0 : 1, petExpWeight, resourceId, body.isPublic === true ? 1 : 0, createdAt, createdAt);
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
      const petExpWeight = Number(body.petExpWeight ?? current.pet_exp_weight ?? 1);
      const feedbackType = clean(body.feedbackType, 30) || 'photo_or_video';
      const resources = normalizeTaskResources(body);
      const existingResourceIds = normalizeExistingResourceIds(body);
      const replaceResources = Array.isArray(body.resources) || Array.isArray(body.existingResourceIds) || Boolean(body.resourceData) || body.removeResource === true;
      if (title.length < 1) { bad(res, 400, '任务模板标题不能为空'); return; }
      if (!category) { bad(res, 400, '请选择有效的任务分类'); return; }
      if (!['photo_or_video', 'optional_photo_or_video', 'photo', 'video', 'none'].includes(feedbackType)) { bad(res, 400, '请选择有效的反馈要求'); return; }
      if (!resources) { bad(res, 400, taskResourceValidationMessage(body)); return; }
      if (!existingResourceIds || existingResourceIds.length + resources.length > 5) { bad(res, 400, '任务资料选择无效或超过 5 个文件'); return; }
      const allowedResourceIds = new Set(linkedResources('template', templateId, current.resource_id).map(resource => resource.id));
      if (existingResourceIds.some(id => !allowedResourceIds.has(id))) { bad(res, 403, '无权引用该任务资料'); return; }
      if (!Number.isInteger(duration) || duration < 1 || duration > 240) { bad(res, 400, '预计时长需为 1 至 240 分钟'); return; }
      if (!Number.isSafeInteger(stars) || stars < 1) { bad(res, 400, '奖励星星需为正整数'); return; }
      if (![0, 1, 2, 3].includes(petExpWeight)) { bad(res, 400, '萌宠经验权重需为 0、1、2 或 3'); return; }
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
        db.prepare(`UPDATE task_templates SET title = ?, category_id = ?, detail = ?, duration_minutes = ?, stars = ?, feedback_type = ?, needs_review = ?, pet_exp_weight = ?, resource_id = ?, is_public = ?, updated_at = ? WHERE id = ?`)
          .run(title, categoryId, detail || '请按照任务要求认真完成。', duration, stars, feedbackType, body.needsReview === false ? 0 : 1, petExpWeight, resourceId, body.isPublic === true ? 1 : 0, now(), templateId);
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
      const insert = db.prepare(`INSERT INTO tasks (student_id,title,category,icon,category_color,detail,task_date,duration_minutes,stars,feedback_type,needs_review,pet_exp_weight_snapshot,resource_id,status,created_at,series_id,repeat_pattern,repeat_weekdays,series_start_date,series_end_date,schedule_type,available_start_date,available_end_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const taskIds = [];
      db.exec('BEGIN');
      try {
        for (const template of templates) for (const studentId of studentIds) {
          const seriesId = schedule.scheduleType === 'repeat' ? randomBytes(12).toString('hex') : '';
          for (const date of schedule.dates) {
            const taskId = Number(insert.run(studentId, template.title, template.category_name, template.category_icon, template.category_color, template.detail, date, template.duration_minutes, template.stars, template.feedback_type, template.needs_review, Number(template.pet_exp_weight ?? 1), template.resource_id, 'not_started', now(), seriesId, schedule.repeatPattern, schedule.weekdays.join(','), schedule.startDate, schedule.endDate, schedule.scheduleType, schedule.scheduleType === 'range' ? schedule.startDate : date, schedule.scheduleType === 'range' ? schedule.endDate : date).lastInsertRowid);
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
      const currentDate = businessDate();
      const requestedStudent = url.searchParams.get('studentId');
      const studentId = requestedStudent && requestedStudent !== 'all' ? Number(requestedStudent) : null;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { bad(res, 400, '日期格式不正确'); return; }
      if (studentId && !allowedIds.includes(studentId)) { bad(res, 403, '无权查看该学生任务'); return; }
      if (!allowedIds.length) { json(res, 200, { tasks: [] }); return; }
      const week = weekRange(date);
      const baseSql = `SELECT tasks.*, users.display_name AS student_name, users.avatar AS student_avatar, ${taskResourceSummarySql} FROM tasks JOIN users ON users.id = tasks.student_id WHERE tasks.task_type <> 'assessment' AND ((tasks.schedule_type = 'range' AND tasks.available_start_date <= ? AND tasks.available_end_date >= ?) OR (tasks.schedule_type <> 'range' AND tasks.task_date BETWEEN ? AND ?)) AND tasks.is_demo = 0`;
      const weekRows = studentId
        ? db.prepare(`${baseSql} AND tasks.student_id = ? ORDER BY ${taskStatusOrderSql}, tasks.created_at DESC, tasks.id DESC`).all(week.end, week.start, week.start, week.end, studentId)
        : db.prepare(`${baseSql} AND tasks.student_id IN (${allowedIds.map(() => '?').join(',')}) ORDER BY ${taskStatusOrderSql}, tasks.created_at DESC, tasks.id DESC`).all(week.end, week.start, week.start, week.end, ...allowedIds);
      const serialized = weekRows.map(taskJson);
      const weekTasks = Object.fromEntries(dateRange(week.start, week.end).map(day => [day, serialized.filter(task => taskVisibleOn(task, day))]));
      const taskDates = Object.entries(weekTasks).filter(([, dayTasks]) => dayTasks.length).map(([day]) => day);
      const incompleteTaskDates = overdueUnfinishedTaskDates(weekTasks);
      const taskDateMarkers = taskDateMarkMap(weekTasks);
      json(res, 200, { tasks: weekTasks[date] || [], taskDates, incompleteTaskDates, taskDateMarkers, weekTasks, currentDate });
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
      const petExpWeight = Number(body.petExpWeight ?? 1);
      const feedbackType = clean(body.feedbackType, 30) || 'photo_or_video';
      const resources = normalizeTaskResources(body);
      if (title.length < 1 || !schedule) { bad(res, 400, '请填写任务标题和有效日期；持续日期和重复日期都必须填写有效的结束日期'); return; }
      if (!category) { bad(res, 400, '请选择有效的任务分类'); return; }
      if (!['photo_or_video', 'optional_photo_or_video', 'photo', 'video', 'none'].includes(feedbackType)) { bad(res, 400, '请选择有效的反馈要求'); return; }
      if (!resources) { bad(res, 400, taskResourceValidationMessage(body)); return; }
      if (!Number.isInteger(duration) || duration < 1 || duration > 240) { bad(res, 400, '预计时长需为 1 至 240 分钟'); return; }
      if (!Number.isSafeInteger(stars) || stars < 1) { bad(res, 400, '奖励星星需为正整数'); return; }
      if (![0, 1, 2, 3].includes(petExpWeight)) { bad(res, 400, '萌宠经验权重需为 0、1、2 或 3'); return; }
      const storedResources = await storeResources(resources, 'task-resources');
      const insert = db.prepare(`INSERT INTO tasks (student_id,title,category,icon,category_color,detail,task_date,duration_minutes,stars,feedback_type,needs_review,pet_exp_weight_snapshot,resource_id,status,created_at,series_id,repeat_pattern,repeat_weekdays,series_start_date,series_end_date,schedule_type,available_start_date,available_end_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const taskIds = [];
      db.exec('BEGIN');
      try {
        const resourceIds = insertResources(storedResources, user.id);
        const resourceId = resourceIds[0] || null;
        for (const studentId of studentIds) {
          const seriesId = schedule.scheduleType === 'repeat' ? randomBytes(12).toString('hex') : '';
          for (const date of schedule.dates) {
            const taskId = Number(insert.run(studentId, title, category.name, category.icon, category.color, detail || '请按照任务要求认真完成。', date, duration, stars, feedbackType, body.needsReview === false ? 0 : 1, petExpWeight, resourceId, 'not_started', now(), seriesId, schedule.repeatPattern, schedule.weekdays.join(','), schedule.startDate, schedule.endDate, schedule.scheduleType, schedule.scheduleType === 'range' ? schedule.startDate : date, schedule.scheduleType === 'range' ? schedule.endDate : date).lastInsertRowid);
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
      const petExpWeight = Number(body.petExpWeight ?? task.pet_exp_weight_snapshot ?? 1);
      const feedbackType = clean(body.feedbackType, 30) || 'photo_or_video';
      const resources = normalizeTaskResources(body);
      const existingResourceIds = normalizeExistingResourceIds(body);
      const replaceResources = Array.isArray(body.resources) || Array.isArray(body.existingResourceIds) || Boolean(body.resourceData) || body.removeResource === true;
      if (!allowedIds.includes(studentId)) { bad(res, 403, '请选择有权限的正常学生账号'); return; }
      if (scopeSeries && studentId !== task.student_id) { bad(res, 400, '重复任务系列不能更换学生'); return; }
      if (title.length < 1 || (!scopeSeries && !schedule)) { bad(res, 400, '请填写任务标题和有效日期范围'); return; }
      if (!category) { bad(res, 400, '请选择有效的任务分类'); return; }
      if (!['photo_or_video', 'optional_photo_or_video', 'photo', 'video', 'none'].includes(feedbackType)) { bad(res, 400, '请选择有效的反馈要求'); return; }
      if (!resources) { bad(res, 400, taskResourceValidationMessage(body)); return; }
      if (!existingResourceIds || existingResourceIds.length + resources.length > 5) { bad(res, 400, '任务资料选择无效或超过 5 个文件'); return; }
      const allowedResourceIds = new Set(linkedResources('task', task.id, task.resource_id).map(resource => resource.id));
      if (existingResourceIds.some(id => !allowedResourceIds.has(id))) { bad(res, 403, '无权引用该任务资料'); return; }
      if (!Number.isInteger(duration) || duration < 1 || duration > 240) { bad(res, 400, '预计时长需为 1 至 240 分钟'); return; }
      if (!Number.isSafeInteger(stars) || stars < 1) { bad(res, 400, '奖励星星需为正整数'); return; }
      if (![0, 1, 2, 3].includes(petExpWeight)) { bad(res, 400, '萌宠经验权重需为 0、1、2 或 3'); return; }
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
        if (scopeSeries) db.prepare(`UPDATE tasks SET title = ?, category = ?, icon = ?, category_color = ?, detail = ?, duration_minutes = ?, stars = ?, feedback_type = ?, needs_review = ?, pet_exp_weight_snapshot = ? WHERE id IN (${placeholders})`).run(title, category.name, category.icon, category.color, detail || '请按照任务要求认真完成。', duration, stars, feedbackType, body.needsReview === false ? 0 : 1, petExpWeight, ...targetIds);
        else db.prepare('UPDATE tasks SET student_id = ?, title = ?, category = ?, icon = ?, category_color = ?, detail = ?, task_date = ?, duration_minutes = ?, stars = ?, feedback_type = ?, needs_review = ?, pet_exp_weight_snapshot = ?, schedule_type = ?, available_start_date = ?, available_end_date = ? WHERE id = ?').run(studentId, title, category.name, category.icon, category.color, detail || '请按照任务要求认真完成。', schedule.taskDate, duration, stars, feedbackType, body.needsReview === false ? 0 : 1, petExpWeight, schedule.scheduleType, schedule.startDate, schedule.endDate, taskId);
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
        const petDate = task.pet_business_date || task.task_date || businessDate();
        publishPetEvent({ eventType: 'TASK_COMPLETED', sourceType: 'task_complete', sourceId: String(task.id), studentId: task.student_id, petId: task.submitted_active_pet_id, businessDate: petDate, requestedDelta: 10 * Math.max(0, Number(task.pet_exp_weight_snapshot ?? 1) || 0), occurredAt: now(), reason: `审核通过任务：${task.title}` });
        reconcileDailyPetCompletion(task.student_id, petDate);
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
