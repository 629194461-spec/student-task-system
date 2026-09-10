import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const DATA_URL_PATTERN = /^data:([a-zA-Z0-9][a-zA-Z0-9.+-]*\/[a-zA-Z0-9][a-zA-Z0-9.+-]*);base64,([A-Za-z0-9+/]+={0,2})$/;
const extensionByMime = new Map([
  ['image/png', '.png'], ['image/jpeg', '.jpg'], ['image/jpg', '.jpg'], ['image/webp', '.webp'],
  ['image/gif', '.gif'], ['image/avif', '.avif'], ['video/mp4', '.mp4'], ['video/webm', '.webm'],
  ['application/pdf', '.pdf'], ['text/plain', '.txt'], ['application/zip', '.zip'],
  ['application/msword', '.doc'], ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
  ['application/vnd.ms-excel', '.xls'], ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'],
  ['application/vnd.ms-powerpoint', '.ppt'], ['application/vnd.openxmlformats-officedocument.presentationml.presentation', '.pptx']
]);

function encodeObjectKey(key) { return key.split('/').map(encodeURIComponent).join('/'); }
function sha1(value) { return createHash('sha1').update(value).digest('hex'); }
function hmacSha1(key, value) { return createHmac('sha1', key).update(value).digest('hex'); }
function safeExtension(_name, mime) { return extensionByMime.get(mime) || '.bin'; }
function objectKey(folder, name, mime) {
  const date = new Date();
  const prefix = String(process.env.COS_PATH_PREFIX || 'learning-planet').replace(/^\/+|\/+$/g, '');
  return [prefix, folder, String(date.getUTCFullYear()), String(date.getUTCMonth() + 1).padStart(2, '0'), `${randomBytes(18).toString('hex')}${safeExtension(name, mime)}`].filter(Boolean).join('/');
}
function cosSettings() {
  const bucket = process.env.COS_BUCKET || '';
  const region = process.env.COS_REGION || '';
  const secretId = process.env.COS_SECRET_ID || '';
  const secretKey = process.env.COS_SECRET_KEY || '';
  const endpoint = bucket && region ? `https://${bucket}.cos.${region}.myqcloud.com` : '';
  const publicBase = (process.env.COS_PUBLIC_BASE_URL || endpoint).replace(/\/$/, '');
  return { bucket, region, secretId, secretKey, endpoint, publicBase };
}
function cosAuthorization(method, pathname, host, secretId, secretKey, expiresIn = 3600) {
  const start = Math.floor(Date.now() / 1000) - 60;
  const keyTime = `${start};${start + expiresIn}`;
  const signKey = hmacSha1(secretKey, keyTime);
  const httpString = `${method.toLowerCase()}\n${pathname}\n\nhost=${host.toLowerCase()}\n`;
  const stringToSign = `sha1\n${keyTime}\n${sha1(httpString)}\n`;
  const signature = hmacSha1(signKey, stringToSign);
  return `q-sign-algorithm=sha1&q-ak=${encodeURIComponent(secretId)}&q-sign-time=${keyTime}&q-key-time=${keyTime}&q-header-list=host&q-url-param-list=&q-signature=${signature}`;
}

const COS_SIGN_TTL_MS = () => Math.max(60_000, Number(process.env.COS_SIGN_TTL_MS) || 3_600_000);

// 将存储的 COS URL 转换为带时效的签名 GET URL（私有桶读取）。
// 本地 /uploads/ 与非本桶 URL 原样返回；签名有效期默认 1 小时，可用 COS_SIGN_TTL_MS 调整。
export function signStoredUrl(value) {
  if (typeof value !== 'string' || !value) return value || '';
  const cleanUrl = value.split('?')[0];
  if (cleanUrl.startsWith('/uploads/')) return cleanUrl;
  const settings = cosSettings();
  if (!settings.publicBase || !cleanUrl.startsWith(`${settings.publicBase}/`)) return cleanUrl;
  try {
    if (new URL(settings.publicBase).host !== new URL(settings.endpoint).host) return cleanUrl;
  } catch { return cleanUrl; }
  const encodedKey = encodeObjectKey(decodeURIComponent(cleanUrl.slice(settings.publicBase.length + 1)));
  const host = new URL(settings.endpoint).host;
  return `${settings.publicBase}/${encodedKey}?${cosAuthorization('GET', `/${encodedKey}`, host, settings.secretId, settings.secretKey, Math.ceil(COS_SIGN_TTL_MS() / 1000) + 60)}`;
}

export function storageDriver() {
  return process.env.STORAGE_DRIVER || (process.env.NODE_ENV === 'production' ? 'cos' : 'local');
}

export function validateStorageConfiguration() {
  const driver = storageDriver();
  if (!['local', 'cos'].includes(driver)) throw new Error('STORAGE_DRIVER 仅支持 local 或 cos');
  if (driver === 'cos') {
    const settings = cosSettings();
    const missing = Object.entries(settings).filter(([key, value]) => ['bucket', 'region', 'secretId', 'secretKey'].includes(key) && !value).map(([key]) => key);
    if (missing.length) throw new Error(`腾讯云 COS 配置不完整：${missing.join(', ')}`);
  }
  return driver;
}

export function parseDataUrl(value) {
  const match = typeof value === 'string' ? DATA_URL_PATTERN.exec(value) : null;
  if (!match) return null;
  return { mime: match[1].toLowerCase(), bytes: Buffer.from(match[2], 'base64') };
}

async function cosRequest(method, key, body, contentType) {
  const settings = cosSettings();
  const encodedKey = encodeObjectKey(key);
  const pathname = `/${encodedKey}`;
  const host = new URL(settings.endpoint).host;
  const response = await fetch(`${settings.endpoint}${pathname}`, {
    method,
    headers: {
      host,
      authorization: cosAuthorization(method, pathname, host, settings.secretId, settings.secretKey),
      ...(contentType ? { 'content-type': contentType } : {})
    },
    ...(body ? { body } : {})
  });
  if (!response.ok) {
    const detail = (await response.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240);
    throw new Error(`COS ${method} 失败（${response.status}）${detail ? `：${detail}` : ''}`);
  }
  return `${settings.publicBase}/${encodedKey}`;
}

export async function storeDataUrl(dataUrl, { dataDir, folder, name = '' }) {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed?.bytes.length) throw new Error('上传文件内容无效');
  const key = objectKey(folder, name, parsed.mime);
  if (storageDriver() === 'cos') return cosRequest('PUT', key, parsed.bytes, parsed.mime);
  const relativeKey = key.replace(/^learning-planet\//, '');
  const target = resolve(dataDir, 'uploads', relativeKey);
  const uploadRoot = resolve(dataDir, 'uploads');
  if (!target.startsWith(`${uploadRoot}/`)) throw new Error('上传文件路径无效');
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, parsed.bytes, { flag: 'wx' });
  return `/uploads/${encodeObjectKey(relativeKey)}`;
}

export function localUploadPath(dataDir, pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith('/uploads/')) return null;
  const uploadRoot = resolve(dataDir, 'uploads');
  const relative = pathname.slice('/uploads/'.length).split('/').map(segment => decodeURIComponent(segment)).join('/');
  const target = resolve(uploadRoot, relative);
  return target.startsWith(`${uploadRoot}/`) ? target : null;
}

export async function deleteStoredUrl(url, { dataDir }) {
  const key = keyFromStoredUrl(url);
  if (!key) return false;
  if (url.startsWith('/uploads/')) {
    const target = localUploadPath(dataDir, url);
    if (!target) return false;
    await unlink(target).catch(error => { if (error.code !== 'ENOENT') throw error; });
    return true;
  }
  await cosRequest('DELETE', key);
  return true;
}

function keyFromStoredUrl(url) {
  if (!url || typeof url !== 'string') return null;
  if (url.startsWith('/uploads/')) return decodeURIComponent(url.slice('/uploads/'.length));
  const settings = cosSettings();
  if (!settings.publicBase || !url.startsWith(`${settings.publicBase}/`)) return null;
  return decodeURIComponent(url.slice(settings.publicBase.length + 1));
}
