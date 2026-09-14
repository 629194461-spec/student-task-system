const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];
const state = { user: null, role: 'student', captchaId: null, student: null, parent: null, parents: [], students: [], tasks: [], studentListTasks: [], studentTaskFilter: 'overdue', rewardApplicationFilter: 'all', studentTaskListCache: new Map(), studentDate: '', studentDashboardCache: new Map(), studentLoadController: null, parentTaskCache: new Map(), parentTaskLoadController: null, pageLoads: new Map(), pageLoadedAt: new Map(), categories: [], templates: [], templateCategoryFilter: 'all', templateSearch: '', templatePickerCategoryId: null, editingTemplateId: null, copyingTemplateId: null, templateResources: [], removeTemplateResource: false, selectedTemplateIds: [], templateDateMode: 'single', pendingTemplateId: null, reviews: [], rewardApplications: [], readingReviews: [], readingData: null, readingDate: '', readingBooks: [], readingPlans: [], readingParentTab: 'plans', readingFrequency: 'daily', readingCoverData: '', readingCoverName: '', readingCoverExisting: false, readingFeedbackData: '', readingFeedbackName: '', pendingReadingDelete: null, statsPeriod: 'week', dashboardStudentId: null, activeStudentId: null, activeParentId: null, studentAvatar: '', parentAvatar: '', taskFeedbackData: '', taskFeedbackName: '', taskResources: [], removeTaskResource: false, editingTaskId: null, editingTask: null, pendingTaskUpdate: null, activeTaskDetail: null, pendingStudentStatus: null, pendingParentStatus: null, pendingUnlinkParentId: null, taskDate: '', taskStudentId: null, parentTasks: [], taskDates: [], assignmentDateMode: 'single', selectedCategoryIcon: '', pendingTaskId: null, pendingDeleteTask: null, pendingCategoryId: null };
const statusMeta = { not_started: ['waiting', '等待开始', '开始任务'], in_progress: ['draft', '进行中', '继续任务'], pending_review: ['waiting', '待审核', '等待审核'], completed: ['done', '已完成', '已完成'], needs_more: ['draft', '待补充', '补充反馈'] };
const categoryClass = { '语文小屋': 'cat-chinese', '数学乐园': 'cat-math', '阅读时光': 'cat-reading', '生活小能手': 'cat-life' };
const categoryIcons = [
  ['assets/category-icons/chinese-book.png', '语文学习'],
  ['assets/category-icons/math-blocks.png', '数学思维'],
  ['assets/category-icons/english-bubble.png', '英语学习'],
  ['assets/category-icons/reading-book.png', '阅读时光'],
  ['assets/category-icons/sport-shoe.png', '健康运动'],
  ['assets/category-icons/science-flask.png', '科学探索'],
  ['assets/category-icons/art-palette.png', '创意美术'],
  ['assets/category-icons/music-note.png', '音乐艺术'],
  ['assets/category-icons/health-apple.png', '健康生活'],
  ['assets/category-icons/school-backpack.png', '学习习惯']
];

let activeRequests = 0;
let loaderTimer = null;
let recoveryEmailTimer = null;
let recoveryEmailCooldownUntil = 0;
function renderRecoveryEmailTimer() {
  const button = $('#send-recovery-email');
  if (!button) return;
  const remaining = Math.ceil((recoveryEmailCooldownUntil - Date.now()) / 1000);
  if (remaining > 0) { button.disabled = true; button.textContent = `重新发送（${remaining}s）`; return; }
  recoveryEmailCooldownUntil = 0;
  button.disabled = false;
  button.textContent = '发送验证邮件';
}
function clearRecoveryEmailTimer() {
  if (recoveryEmailTimer) { clearInterval(recoveryEmailTimer); recoveryEmailTimer = null; }
  recoveryEmailCooldownUntil = 0;
  renderRecoveryEmailTimer();
}
function restoreRecoveryEmailTimer() {
  if (recoveryEmailTimer) clearInterval(recoveryEmailTimer);
  recoveryEmailTimer = null;
  renderRecoveryEmailTimer();
  if (recoveryEmailCooldownUntil > Date.now()) recoveryEmailTimer = setInterval(renderRecoveryEmailTimer, 1000);
}
function startRecoveryEmailTimer() {
  if (recoveryEmailTimer) clearInterval(recoveryEmailTimer);
  recoveryEmailCooldownUntil = Date.now() + 60000;
  renderRecoveryEmailTimer();
  recoveryEmailTimer = setInterval(() => { renderRecoveryEmailTimer(); if (!recoveryEmailCooldownUntil) { clearInterval(recoveryEmailTimer); recoveryEmailTimer = null; } }, 1000);
}
function enhancePasswordInputs() {
  $$('input[type="password"]').forEach(input => {
    if (input.dataset.passwordToggleReady) return;
    input.dataset.passwordToggleReady = 'true';
    const wrapper = document.createElement('span');
    wrapper.className = 'password-input-wrap';
    input.parentNode.insertBefore(wrapper, input);
    wrapper.appendChild(input);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'password-toggle';
    button.dataset.passwordToggle = 'true';
    button.setAttribute('aria-label', '显示密码');
    button.title = '显示密码';
    button.innerHTML = icon('eye');
    wrapper.appendChild(button);
  });
}
function resetPasswordVisibility(root = document) {
  $$("input[data-password-toggle-ready]", root).forEach(input => {
    input.type = 'password';
    const button = input.closest('.password-input-wrap')?.querySelector('[data-password-toggle]');
    if (button) {
      button.innerHTML = icon('eye');
      button.setAttribute('aria-label', '显示密码');
      button.title = '显示密码';
    }
  });
}
function beginLoading(delay = 180) {
  activeRequests += 1;
  if (activeRequests !== 1) return;
  loaderTimer = setTimeout(() => { const loader = $('#global-loader'); if (loader) loader.hidden = false; }, delay);
}
function endLoading() {
  activeRequests = Math.max(0, activeRequests - 1);
  if (activeRequests) return;
  clearTimeout(loaderTimer);
  const loader = $('#global-loader');
  if (loader) loader.hidden = true;
}
async function api(path, options = {}) {
  const { silent = false, ...fetchOptions } = options;
  if (!silent) beginLoading(fetchOptions.method && fetchOptions.method !== 'GET' ? 0 : 180);
  try {
    const response = await fetch(path, { credentials: 'same-origin', headers: { 'content-type': 'application/json', ...(fetchOptions.headers || {}) }, ...fetchOptions });
    const body = response.status === 204 ? {} : await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || '请求失败，请稍后重试');
    return body;
  } finally { if (!silent) endLoading(); }
}
function today() { return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
function parseDate(value) { return new Date(`${value}T12:00:00Z`); }
function addDays(value, days) { const date = parseDate(value); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); }
function addMonths(value, months) { const [year, month] = String(value).slice(0, 7).split('-').map(Number); const date = new Date(Date.UTC(year, month - 1 + months, 1, 12)); return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`; }
function startOfWeek(value) { const date = parseDate(value); return addDays(value, -((date.getUTCDay() + 6) % 7)); }
function shortDate(value) { const date = parseDate(value); return `${date.getUTCMonth() + 1}月${date.getUTCDate()}日`; }
function weekdayDate(value) { return new Intl.DateTimeFormat('zh-CN', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(parseDate(value)); }
function dateSpanDays(start, end) { return Math.floor((parseDate(end) - parseDate(start)) / 86400000) + 1; }
function formatDateTime(value) { if (!value) return '暂无时间'; return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value)); }
function formatUpdatedAt(value) { return value ? formatDateTime(value) : '暂无时间'; }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
function multilineText(value, fallback = '') { return escapeHtml(value || fallback).replace(/\r?\n/g, '<br>'); }
function icon(name, className = '') { return `<i data-lucide="${escapeHtml(name)}"${className ? ` class="${escapeHtml(className)}"` : ''}></i>`; }
function refreshIcons() { window.lucide?.createIcons({ attrs: { 'aria-hidden': 'true' } }); }
function emptyState(iconName, title, description) { return `<div class="record-empty"><span class="empty-icon">${icon(iconName)}</span><h2>${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p></div>`; }
function isImageAvatar(value) { return /^(?:data:image\/(?:png|jpeg|webp);base64,|\/uploads\/|https:\/\/)/.test(value || ''); }
function isCategoryIcon(value) { return categoryIcons.some(([path]) => path === value); }
function categoryIconMarkup(value) { return isCategoryIcon(value) ? `<img src="${escapeHtml(value)}" alt="" />` : escapeHtml(value || '✦'); }
function avatarMarkup(value, fallback = '学') { return isImageAvatar(value) ? `<img src="${value}" alt="" />` : escapeHtml(value || fallback); }
function setAvatar(element, value, fallback = '学') { element.innerHTML = avatarMarkup(value, fallback); }
function lastCharacter(value, fallback = '家') { return Array.from(String(value || '').trim()).at(-1) || fallback; }
function growthRewardsHtml(growth, compact = false) {
  const rewards = [
    { icon: '☀️', label: '太阳', value: growth?.suns || 0 },
    { icon: '🌙', label: '月亮', value: growth?.moons || 0 },
    { icon: '⭐', label: '星星', value: growth?.stars || 0 }
  ].filter(reward => reward.value > 0);
  const visible = rewards.length ? rewards : [{ icon: '⭐', label: '星星', value: 0 }];
  return visible.map(reward => `<span class="growth-reward${compact ? ' compact' : ''}" aria-label="${reward.label} ${reward.value}"><i>${reward.icon}</i><strong>${reward.value}</strong></span>`).join('');
}
async function prepareAvatar(file) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('请上传 JPG、PNG 或 WebP 图片');
  if (file.size > 2 * 1024 * 1024) throw new Error('头像图片不能超过 2 MB');
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 256;
  canvas.getContext('2d').drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 256, 256);
  bitmap.close();
  return canvas.toDataURL('image/jpeg', 0.84);
}
async function prepareTaskFeedback(file) {
  const allowed = ['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm'];
  if (!allowed.includes(file.type)) throw new Error('请上传 JPG、PNG、WebP、MP4 或 WebM 文件');
  if (file.size > 4 * 1024 * 1024) throw new Error('反馈文件不能超过 4 MB');
  if (file.type.startsWith('video/')) return await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('视频读取失败')); reader.readAsDataURL(file); });
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas'); canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
  const data = canvas.toDataURL('image/jpeg', 0.82);
  if (data.length > 5.4 * 1024 * 1024) throw new Error('图片处理后仍过大，请选择较小的图片');
  return data;
}
async function prepareTaskResource(file) {
  if (file.size > 6 * 1024 * 1024) throw new Error('任务资料不能超过 6 MB');
  if (!file.size) throw new Error('不能上传空文件');
  const mime = (file.type || 'application/octet-stream').toLowerCase();
  if (['image/svg+xml', 'text/html', 'application/xhtml+xml', 'application/javascript', 'text/javascript'].includes(mime)) throw new Error('出于安全考虑，不支持网页或脚本类文件');
  const source = file.type ? file : file.slice(0, file.size, mime);
  return await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('任务资料读取失败')); reader.readAsDataURL(source); });
}
async function prepareRewardApplicationImage(file) {
  const supported = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'];
  if (!supported.includes((file.type || '').toLowerCase())) throw new Error('完成图片仅支持 JPG、PNG、WebP、GIF 或 AVIF 格式');
  if (!file.size) throw new Error('不能上传空图片');
  if (file.size > 6 * 1024 * 1024) throw new Error('单张完成图片不能超过 6 MB');
  return await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('完成图片读取失败')); reader.readAsDataURL(file); });
}
function taskResourceKind(file) {
  const mime = (file.type || '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  const extension = file.name.toLowerCase().split('.').pop();
  return ['mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'weba', 'flac'].includes(extension) ? 'audio' : 'file';
}
function resourceKindOf(resource) {
  const mime = (resource?.mime || '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  const extension = (resource?.name || '').toLowerCase().split('.').pop();
  if (['mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'weba', 'flac'].includes(extension)) return 'audio';
  return resource?.kind || 'file';
}
function showToast(message) { const toast = $('#toast'); toast.textContent = message; toast.classList.add('show'); clearTimeout(showToast.timer); showToast.timer = setTimeout(() => toast.classList.remove('show'), 3000); }
function resourceSummary(item) {
  if (!item?.hasResource) return '';
  const count = item.resourceCount || item.resources?.length || 1;
  const name = item.resourceName || item.resources?.[0]?.name || '任务资料';
  return `${name}${count > 1 ? `（共 ${count} 个文件）` : ''}`;
}
function resourceBadge(item) { return item?.hasResource ? `<span class="resource-badge">${icon('paperclip')}<b>${escapeHtml(resourceSummary(item))}</b></span>` : ''; }
const weekdayNames = ['', '一', '二', '三', '四', '五', '六', '日'];
function recurringLabel(task) {
  if (!task?.isRecurring) return '';
  if (task.repeatPattern === 'daily') return '每天重复';
  const days = (task.repeatWeekdays || []).map(day => weekdayNames[day]).filter(Boolean).join('、');
  return days ? `每周${days}重复` : '每周重复';
}
function recurringBadge(task) { const label = recurringLabel(task); return label ? `<span class="recurring-badge">${icon('repeat-2')} ${escapeHtml(label)}</span>` : ''; }
function rangeLabel(task) { return task?.isDateRange ? `${shortDate(task.availableStartDate)} 至 ${shortDate(task.availableEndDate)}内完成` : ''; }
function rangeCanBeWorkedOn(task) { return !task?.isDateRange || today() <= task.availableEndDate; }
function scheduleBadge(task) {
  if (task?.isDateRange) return `<span class="date-range-badge">${icon('calendar-range')} ${escapeHtml(rangeLabel(task))}</span>`;
  return recurringBadge(task);
}
function prependRequiredMark(element) {
  if (!element || element.querySelector(':scope > .required-mark')) return;
  const marker = document.createElement('span'); marker.className = 'required-mark'; marker.textContent = '*'; marker.setAttribute('aria-hidden', 'true');
  element.prepend(marker);
}
function decorateRequiredFields(root = document) {
  $$('label,legend', root).forEach(label => {
    const legacy = [...label.children].find(child => child.tagName === 'SPAN' && /^(必填|必选)/.test(child.textContent.trim()));
    const required = Boolean(label.querySelector('input[required],select[required],textarea[required]')) || Boolean(legacy);
    if (!required || label.querySelector(':scope > .required-mark')) return;
    if (legacy) {
      const note = legacy.textContent.trim().replace(/^(必填|必选)[，,]?\s*/, '');
      if (note) legacy.textContent = note; else legacy.remove();
    }
    prependRequiredMark(label);
  });
  ['#assignment-students', '#template-assignment-students'].forEach(selector => prependRequiredMark($(selector, root)?.closest('section')?.querySelector('h2')));
}
function dropZoneFromEvent(event) { return event.target.closest?.('.file-drop-zone, .avatar-upload-control, .task-feedback-upload'); }
function dropZoneInput(zone) { return document.getElementById(zone?.dataset.fileDropTarget || '') || zone?.querySelector('input[type="file"]'); }
function ensurePageData(key, loader, maxAge = 30000) {
  if (Date.now() - (state.pageLoadedAt.get(key) || 0) < maxAge) return Promise.resolve();
  if (state.pageLoads.has(key)) return state.pageLoads.get(key);
  const request = Promise.resolve().then(loader).then(result => { state.pageLoadedAt.set(key, Date.now()); return result; }).finally(() => state.pageLoads.delete(key));
  state.pageLoads.set(key, request);
  return request;
}
function loadInBackground(key, loader, maxAge = 30000) { ensurePageData(key, loader, maxAge).catch(error => showToast(error.message)); }
function clearActivePages() { $$('.page').forEach(page => { page.classList.remove('active'); page.hidden = true; }); }
function setStudentPage(id) { clearActivePages(); const page = document.getElementById(id === 'reading' ? 'student-reading' : id); page.hidden = false; page.classList.add('active'); $$('[data-page]').forEach(button => button.classList.toggle('active', button.dataset.page === id)); window.scrollTo(0, 0); }
function setParentPage(id) { clearActivePages(); const page = document.getElementById(id === 'reading' ? 'parent-reading' : id); page.hidden = false; page.classList.add('active'); $$('[data-parent-page]').forEach(button => button.classList.toggle('active', button.dataset.parentPage === id)); window.scrollTo(0, 0); }
function closeParentMobileMenu() { $('#app-shell').classList.remove('mobile-menu-open'); $('#parent-mobile-menu-button').setAttribute('aria-expanded', 'false'); $('#parent-sidebar-backdrop').hidden = true; }
function displayApp() { $('#login-screen').hidden = true; $('#app-shell').hidden = false; setAvatar($('.avatar-button .avatar'), state.user.avatar, state.user.displayName?.slice(0, 1)); $('.avatar-name').textContent = state.user.displayName; $('.avatar-button').setAttribute('aria-label', `${state.user.displayName}的个人资料`); $('.avatar-button').title = `当前账号：${state.user.displayName}`; refreshIcons(); }
function displayLogin() { $('#app-shell').hidden = true; $('#login-screen').hidden = false; clearActivePages(); }

async function refreshCaptcha() {
  const captcha = await api('/api/auth/captcha');
  state.captchaId = captcha.id;
  $('#captcha-image').src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(captcha.svg)}`;
  $('#captcha').value = '';
}
function setLoginRole(role) {
  state.role = role;
  $$('.login-role').forEach(button => button.classList.toggle('active', button.dataset.loginRole === role));
  $('#login-title').textContent = role === 'student' ? '开始今天的学习吧' : '查看孩子的学习情况';
  $('#login-submit-label').textContent = role === 'student' ? '进入我的任务' : '进入家长首页';
  $('#open-recovery').hidden = role !== 'parent';
  $('#login-error').textContent = '';
}
function taskCard(task, compact = false) {
  const [klass, label, action] = statusMeta[task.status] || statusMeta.not_started;
  const actionClass = ['in_progress', 'needs_more'].includes(task.status) ? 'continue-task' : task.status === 'not_started' ? 'start-task' : 'pending-task';
  const actionControl = task.status === 'completed'
    ? `<span class="task-complete-icon" aria-label="已完成" title="已完成">${icon('check')}</span>`
    : `<button class="${actionClass}" ${task.status === 'pending_review' || !rangeCanBeWorkedOn(task) ? 'disabled' : `data-start-task="${task.id}"`}>${!rangeCanBeWorkedOn(task) ? '已截止' : action}</button>`;
  return `<article class="task-card task-detail-row" data-task="${task.id}" role="button" tabindex="0" aria-label="查看${escapeHtml(task.title)}详情"><span class="category-icon ${categoryClass[task.category] || 'cat-math'}">${categoryIconMarkup(task.icon)}</span><div class="task-main"><h3>${escapeHtml(task.title)}</h3>${scheduleBadge(task)}<p class="task-description">${escapeHtml(task.detail || '暂无任务说明')}</p><div class="task-meta"><p>${icon('clock-3')} ${task.duration || 15} 分钟</p>${resourceBadge(task)}<span class="status ${klass}">${label}</span></div></div>${compact ? '' : `<div class="task-action"><span class="stars">⭐ ${task.stars} 颗星星</span>${actionControl}</div>`}</article>`;
}
function renderStudentWeek(data) {
  const labels = ['一', '二', '三', '四', '五', '六', '日'];
  const start = startOfWeek(state.studentDate);
  const incompleteDates = new Set(data.incompleteTaskDates || []);
  $('#student-week').innerHTML = labels.map((label, index) => {
    const date = addDays(start, index);
    const hasUnfinished = incompleteDates.has(date);
    return `<button type="button" data-student-date="${date}" class="${date === state.studentDate ? 'selected' : ''} ${date === today() ? 'today' : ''}"><small>${label}</small><strong>${parseDate(date).getUTCDate()}</strong>${data.taskDates?.includes(date) ? `<i class="${hasUnfinished ? 'unfinished' : ''}" aria-label="${hasUnfinished ? '有未完成任务' : '有任务'}"></i>` : ''}</button>`;
  }).join('');
}
function studentTaskListRow(task) {
  const [klass, label] = statusMeta[task.status] || statusMeta.not_started;
  return `<article class="student-task-row task-detail-row" data-task="${task.id}" role="button" tabindex="0" aria-label="查看${escapeHtml(task.title)}详情"><span class="category-icon" style="background:${escapeHtml(task.color)}1f">${categoryIconMarkup(task.icon)}</span><div><h3>${escapeHtml(task.title)}</h3>${scheduleBadge(task)}<p class="task-description">${escapeHtml(task.detail || '暂无任务说明')}</p><p>${escapeHtml(task.isDateRange ? rangeLabel(task) : shortDate(task.date))} · ${escapeHtml(task.category)} · ${task.duration || 0} 分钟</p>${resourceBadge(task)}</div><span class="stars">⭐ ${task.stars}</span><span class="status ${klass}">${escapeHtml(label)}</span></article>`;
}
function renderStudent(data) {
  state.student = data; state.tasks = data.tasks; state.studentDate = data.date;
  const completed = data.tasks.filter(task => task.status === 'completed').length;
  const current = data.date === today();
  $('#student-list-date-label').textContent = current ? '今天' : shortDate(data.date);
  $('#task-list').innerHTML = data.tasks.map(task => taskCard(task)).join('') || emptyState('calendar-days', `${current ? '今天' : shortDate(data.date)}没有安排任务`, '可以轻松安排自己的时间。');
  $('#task-count').textContent = data.tasks.length;
  $('#progress-label').textContent = data.tasks.length ? `${completed} / ${data.tasks.length} 件完成` : '暂无任务';
  $('#progress-bar').style.width = `${data.tasks.length ? completed / data.tasks.length * 100 : 0}%`;
  renderStudentWeek(data);
  $('.reward-timeline').innerHTML = data.rewards.map(reward => `<article><span class="reward-dot">★</span><div><h3>${reward.title || '学习任务'}</h3><p>${reward.message || '每一次认真完成都值得奖励。'}</p></div><strong>+${reward.stars}</strong></article>`).join('') || `<div class="reward-empty" role="status"><span class="reward-empty-icon">${icon('gift')}</span><div><h3>暂时没有收到家长奖励</h3><p>完成任务并通过审核后，奖励会显示在这里。</p></div></div>`;
  $$('.reward-numbers strong')[0].textContent = data.growth.stars;
  $$('.reward-numbers strong')[1].textContent = data.growth.moons;
  $$('.reward-numbers strong')[2].textContent = data.growth.suns;
  $('.next-reward h2').textContent = `还差 ${100 - data.growth.stars} 颗星星`;
  $('.next-reward .progress-track span').style.width = `${data.growth.stars}%`;
  refreshIcons();
}
function renderStudentTaskList() {
  $$('.student-task-tabs [data-student-task-filter]').forEach(button => button.classList.toggle('active', button.dataset.studentTaskFilter === state.studentTaskFilter));
  $('#student-task-list').innerHTML = state.studentListTasks.map(studentTaskListRow).join('') || emptyState('circle-check', '当前没有任务', '该分类下暂无任务记录。');
  refreshIcons();
}
async function loadStudentTaskList(filter = state.studentTaskFilter, { force = false, silent = false, activate = true } = {}) {
  if (activate) state.studentTaskFilter = filter;
  const cached = state.studentTaskListCache.get(filter);
  if (!force && cached && Date.now() - cached.cachedAt < 300000) {
    if (state.studentTaskFilter === filter) { state.studentListTasks = cached.tasks; renderStudentTaskList(); }
    return cached.tasks;
  }
  const data = await api(`/api/student/tasks?filter=${encodeURIComponent(filter)}`, { silent });
  state.studentTaskListCache.set(filter, { tasks: data.tasks, cachedAt: Date.now() });
  if (state.studentTaskFilter === filter) { state.studentListTasks = data.tasks; renderStudentTaskList(); }
  return data.tasks;
}
function reviewRow(task) { return `<article class="review-row task-detail-row" data-parent-task="${task.id}" role="button" tabindex="0" aria-label="查看${escapeHtml(task.title)}详情"><span class="feedback-preview">${categoryIconMarkup(task.icon)}</span><div><h3>${escapeHtml(task.title)}</h3>${scheduleBadge(task)}<p>${escapeHtml(task.category)} · ${task.submittedAt ? formatDateTime(task.submittedAt) : '等待提交'} · ⭐ ${task.stars} 颗</p>${resourceBadge(task)}</div><button data-review="${task.id}">去审核</button></article>`; }
function renderParent(data) {
  state.parent = data; state.dashboardStudentId = data.selectedStudentId;
  const child = data.students.find(student => student.id === data.selectedStudentId) || data.students[0];
  const weekPercent = data.summary.weekTotal ? Math.round((data.summary.weekCompleted / data.summary.weekTotal) * 100) : null;
  const todayPercent = data.summary.todayTotal ? Math.round((data.summary.todayCompleted / data.summary.todayTotal) * 100) : null;
  setAvatar($('.child-switch .avatar'), child?.avatar, child?.display_name?.slice(0, 1));
  $('.child-switch b').textContent = child?.display_name || '暂无学生';
  $('.child-switch small').textContent = child?.grade || '';
  $('#dashboard-student-select').innerHTML = data.students.map(student => `<option value="${student.id}" ${student.id === data.selectedStudentId ? 'selected' : ''}>${escapeHtml(student.display_name)}</option>`).join('');
  $('#dashboard-student-select').disabled = data.students.length < 2;
  $('#overview-date').textContent = weekdayDate(data.period.today);
  $('#overview-greeting').textContent = child ? `下午好，${child.display_name}家长` : '下午好，家长';
  $('.week-complete-card strong').textContent = data.summary.weekTotal ? `${data.summary.weekCompleted} / ${data.summary.weekTotal}` : '--';
  $('.week-complete-card p').textContent = weekPercent === null ? '本周暂无任务' : `本周完成进度 ${weekPercent}%`;
  $('.week-overdue-card strong').textContent = data.summary.weekOverdue;
  $('.week-overdue-card p').textContent = data.summary.weekOverdue ? '需要关注任务进度' : '任务均在计划内';
  $('.review-card strong').textContent = data.summary.pending;
  $('.review-card p').textContent = data.summary.pending ? '点击进入审核中心' : '暂时无需处理';
  $('.today-complete-card strong').textContent = data.summary.todayTotal ? `${data.summary.todayCompleted} / ${data.summary.todayTotal}` : '--';
  $('.today-complete-card p').textContent = todayPercent === null ? '今日暂无任务' : `今日完成进度 ${todayPercent}%`;
  $('.week-star-card strong').textContent = data.summary.weekStars;
  $('.week-star-card p').textContent = data.summary.weekStars ? '来自本周完成的任务' : '完成任务后获得';
  $('.reading-book-total-card strong').textContent = data.summary.readingBookCount || 0;
  $('.reading-book-total-card p').textContent = `在读新书 ${data.summary.readingActiveBookCount || 0} 本 · 已读 ${data.summary.readingCompletedBookCount || 0} 本`;
  $('#compact-review-list').innerHTML = data.pending.map(reviewRow).join('') || '<p class="empty-inline">当前学生的反馈都已审核完成。</p>';
  $('#parent-growth-rewards').innerHTML = growthRewardsHtml(data.growth);
  $('#parent-growth-title').textContent = child ? `${child.display_name}的成长` : '学生成长';
  $('#parent-growth-next').textContent = `再收集 ${100 - data.growth.stars} 颗星星，得到新月亮`;
  $('.growth-inline .progress-track span').style.width = `${data.growth.stars}%`;
  refreshIcons();
}
function invalidateStudentDashboardCache() { state.studentDashboardCache.clear(); state.studentTaskListCache.clear(); state.parentTaskCache.clear(); }
async function loadStudent(date = state.studentDate || today(), { force = false, silent = false } = {}) {
  const selectedDate = date;
  state.studentDate = selectedDate;
  if (state.student) renderStudentWeek({ taskDates: state.student.taskDates || [], incompleteTaskDates: state.student.incompleteTaskDates || [] });
  const cached = state.studentDashboardCache.get(selectedDate);
  if (!force && cached && Date.now() - cached.cachedAt < 300000) { renderStudent(cached.data); return; }
  state.studentLoadController?.abort();
  const controller = new AbortController();
  state.studentLoadController = controller;
  $('#task-list')?.classList.add('is-loading');
  try {
    const data = await api(`/api/student/dashboard?date=${encodeURIComponent(selectedDate)}`, { signal: controller.signal, silent });
    const cachedAt = Date.now();
    if (data.weekTasks) Object.entries(data.weekTasks).forEach(([day, tasks]) => state.studentDashboardCache.set(day, { data: { ...data, date: day, tasks }, cachedAt }));
    else state.studentDashboardCache.set(selectedDate, { data, cachedAt });
    if (state.studentDate === selectedDate) renderStudent(data);
  } catch (error) {
    if (error.name !== 'AbortError') throw error;
  } finally {
    if (state.studentLoadController === controller) { state.studentLoadController = null; $('#task-list')?.classList.remove('is-loading'); }
  }
}
async function loadParent(studentId = state.dashboardStudentId) { renderParent(await api(`/api/parent/dashboard${studentId ? `?studentId=${encodeURIComponent(studentId)}` : ''}`)); }
function renderStudentCards() {
  const cards = state.students.map(student => {
    const links = student.parents?.length ? student.parents.map(parent => `<span class="parent-link"><span>${avatarMarkup(parent.avatar, parent.displayName?.slice(-1))}</span><span class="parent-link-copy"><b>${escapeHtml(parent.displayName)}</b><small>用户名：${escapeHtml(parent.username)}</small></span>${state.user.role === 'admin' || state.user.id === parent.id ? `<button data-unlink-parent="${parent.id}" data-unlink-student="${student.id}" aria-label="解除 ${escapeHtml(parent.displayName)} 与 ${escapeHtml(student.display_name)} 的关联" title="解除关联">×</button>` : ''}</span>`).join('') : '<span class="unlinked-label">暂未关联家长</span>';
    return `<article class="student-card"><span class="student-avatar student-card-avatar">${avatarMarkup(student.avatar, student.display_name?.slice(-1))}</span><div class="student-card-info"><div class="student-card-title"><h2>${escapeHtml(student.display_name)}</h2><span class="account-status ${student.active ? 'active' : 'disabled'}">${student.active ? '正常' : '禁用'}</span></div><p class="student-username">用户名：${escapeHtml(student.username)}</p><p>${escapeHtml(student.grade)} · ${escapeHtml(student.note || '学习星球成员')}</p></div><section class="student-parent-section"><small>关联家长</small><div class="student-parent-links">${links}</div></section><div class="student-card-stats"><span><b>${student.total ? `${student.completed || 0} / ${student.total}` : '--'}</b>今日完成</span><span><b>${student.pending || 0}</b>待审核</span><span class="student-growth-stat"><b class="student-growth-rewards">${growthRewardsHtml(student.growth, true)}</b>成长记录</span></div><button class="icon-button student-more-button" data-student-actions="${student.id}" aria-label="${escapeHtml(student.display_name)} 的更多操作" aria-haspopup="menu" aria-expanded="false">${icon('ellipsis')}</button></article>`;
  }).join('');
  $('#student-cards').innerHTML = cards || emptyState('graduation-cap', '还没有学生', '点击右上角“新增学生”创建学生账号。');
  refreshIcons();
}
async function loadStudents() { const data = await api('/api/parent/students'); state.students = data.students; renderStudentCards(); }
function renderParents() {
  $('#parent-account-list').innerHTML = state.parents.map(parent => `<article class="parent-account-row"><span class="student-avatar">${avatarMarkup(parent.avatar, parent.displayName?.slice(-1))}</span><div><div class="student-card-title"><h2>${escapeHtml(parent.displayName)}</h2><span class="account-status ${parent.active ? 'active' : 'disabled'}">${parent.active ? '正常' : '禁用'}</span></div><p>用户名：${escapeHtml(parent.username)} · 已关联 ${parent.students.length} 名学生</p><div class="linked-student-names">${parent.students.map(student => `<span>${escapeHtml(student.displayName)}</span>`).join('') || '<small>暂无关联学生</small>'}</div></div><div class="parent-row-actions"><button class="secondary-button" data-edit-parent="${parent.id}">修改</button><button class="secondary-button" data-reset-parent="${parent.id}">重置密码</button><button class="${parent.active ? 'danger-outline' : 'secondary-button'}" data-toggle-parent="${parent.id}">${parent.active ? '禁用' : '启用'}</button></div></article>`).join('') || emptyState('users-round', '暂无家长账号', '点击右上角“新增家长”创建账号。');
  refreshIcons();
}
async function loadParents() { if (state.user?.role !== 'admin') return; const data = await api('/api/admin/parents'); state.parents = data.parents; renderParents(); }
function reviewListRow(task) {
  const feedbackLabel = task.feedbackType === 'none'
    ? '无需反馈'
    : task.hasFeedback
      ? '已提交反馈'
      : task.feedbackType === 'optional_photo_or_video'
        ? '未上传附件（选填）'
        : '未上传附件';
  return `<article class="review-list-row task-detail-row" data-parent-task="${task.id}" role="button" tabindex="0" aria-label="查看${escapeHtml(task.title)}详情"><span class="student-avatar">${avatarMarkup(task.studentAvatar, task.studentName?.slice(0, 1))}</span><span class="category-icon" style="background:${escapeHtml(task.color)}1f">${categoryIconMarkup(task.icon)}</span><div><h3>${escapeHtml(task.title)} <span class="review-type-badge task">任务</span></h3>${scheduleBadge(task)}<p>${escapeHtml(task.studentName)} · ${escapeHtml(task.category)} · ${feedbackLabel} · 提交于 ${formatDateTime(task.submittedAt)}</p>${resourceBadge(task)}</div><span class="stars">⭐ ${task.stars}</span><button class="primary-button" data-review="${task.id}">审核</button></article>`;
}
function rewardReviewListRow(item) { const attachment = item.resourceCount ? `<span class="resource-badge">${icon('paperclip')}<b>${escapeHtml(item.resources?.[0]?.name || '完成图片')}${item.resourceCount > 1 ? `（共 ${item.resourceCount} 张）` : ''}</b></span>` : ''; return `<article class="review-list-row task-detail-row" data-reward-review="${item.id}" role="button" tabindex="0" aria-label="查看${escapeHtml(item.content)}奖励申请"><span class="student-avatar">${avatarMarkup(item.studentAvatar, item.studentName?.slice(0, 1))}</span><span class="category-icon">${categoryIconMarkup(item.icon)}</span><div><h3>${escapeHtml(item.content)} <span class="review-type-badge reward">奖励申请</span></h3><p>${escapeHtml(item.studentName)} · ${escapeHtml(item.category)} · 完成于 ${item.completedAt} · 提交于 ${formatDateTime(item.createdAt)}</p>${attachment}</div><span class="stars">⭐ ${item.requestedStars}</span><button class="primary-button" data-reward-review-action="${item.id}">审核</button></article>`; }
function renderReviews() {
  const totalPending = state.reviews.length + state.rewardApplications.length + state.readingReviews.length;
  $('#review-count').textContent = `${totalPending} 项待审核`;
  const badge = $('.parent-sidebar [data-parent-page="review"] em'); badge.textContent = totalPending; badge.hidden = totalPending === 0;
  const items = [...state.reviews.map(task => ({ type: 'task', value: task, time: task.submittedAt })), ...state.rewardApplications.map(item => ({ type: 'reward', value: item, time: item.createdAt })), ...state.readingReviews.map(item => ({ type: 'reading', value: item, time: item.submittedAt }))].sort((a, b) => String(b.time || '').localeCompare(String(a.time || '')));
  $('#review-list').innerHTML = items.length ? `<section class="review-student-group"><div>${items.map(item => item.type === 'task' ? reviewListRow(item.value) : item.type === 'reward' ? rewardReviewListRow(item.value) : readingReviewRow(item.value)).join('')}</div></section>` : emptyState('badge-check', '暂时没有待审核事项', '学生提交任务、奖励申请或阅读打卡后会显示在这里。');
  refreshIcons();
}
async function loadReviews() {
  const [data, rewardData, readingData] = await Promise.all([api('/api/parent/reviews?studentId=all&period=all'), api('/api/parent/reward-applications?status=pending'), api('/api/parent/reading/checkins?status=pending_review')]); state.reviews = data.reviews; state.rewardApplications = rewardData.applications; state.readingReviews = readingData.checkins; renderReviews(); renderRewardReviews();
}
function rewardApplicationRow(item, parent = false) { const status = { pending: '待审核', approved: '已通过', rejected: '已驳回' }[item.status] || item.status; return `<article class="review-list-row task-detail-row" data-reward-${parent ? 'review' : 'detail'}="${item.id}" role="button" tabindex="0"><span class="category-icon">${categoryIconMarkup(item.icon)}</span><div><h3>${escapeHtml(item.content)}</h3><p>${escapeHtml(item.category)} · ${item.completedAt} · ⭐ ${item.requestedStars} 颗 · ${status}</p>${item.resourceCount ? `<p class="resource-badge">📎 ${escapeHtml(item.resources?.[0]?.name || '图片')} ${item.resourceCount > 1 ? `（共 ${item.resourceCount} 张）` : ''}</p>` : ''}</div>${parent && item.status === 'pending' ? '<button class="primary-button" data-reward-review-action="'+item.id+'">审核</button>' : ''}</article>`; }
function rewardApplicationStatus(item) { return { pending: ['waiting', '待审核'], approved: ['done', '已通过'], rejected: ['draft', '已驳回'] }[item.status] || ['waiting', item.status]; }
function studentRewardApplicationRow(item) { const [klass, label] = rewardApplicationStatus(item); const fileHint = item.resourceCount ? `<span class="resource-badge">${icon('paperclip')}<b>${escapeHtml(item.resources?.[0]?.name || '完成图片')}${item.resourceCount > 1 ? `（共 ${item.resourceCount} 张）` : ''}</b></span>` : ''; const detail = item.detail ? `<p class="task-description">${escapeHtml(item.detail)}</p>` : ''; const actual = item.status === 'approved' ? ` · 实际奖励 ⭐ ${item.awardedStars ?? 0}` : ''; return `<article class="student-task-row task-detail-row reward-application-row" data-reward-detail="${item.id}" role="button" tabindex="0" aria-label="查看${escapeHtml(item.content)}奖励申请详情"><span class="category-icon">${categoryIconMarkup(item.icon)}</span><div><h3>${escapeHtml(item.content)}</h3>${detail}<p>${escapeHtml(item.category)} · 完成于 ${item.completedAt} · 申请 ⭐ ${item.requestedStars}${actual}</p>${fileHint}</div><span class="stars">⭐ ${item.requestedStars}</span><span class="status ${klass}">${label}</span></article>`; }
function renderRewardApplications() { const filtered = state.rewardApplicationFilter === 'all' ? state.rewardApplications : state.rewardApplications.filter(item => item.status === state.rewardApplicationFilter); $$('[data-reward-application-filter]').forEach(button => button.classList.toggle('active', button.dataset.rewardApplicationFilter === state.rewardApplicationFilter)); $('#reward-application-list').innerHTML = filtered.map(studentRewardApplicationRow).join('') || emptyState('gift', '当前没有奖励申请', '可以新建奖励申请，记录每一次努力。'); refreshIcons(); }
function renderRewardReviews() { const host = $('#reward-review-groups'); if (!host) return; host.innerHTML = state.rewardApplications.map(item => rewardApplicationRow(item, true)).join('') || '<p class="empty-inline">暂无待审核奖励申请。</p>'; refreshIcons(); }
async function loadRewardApplications() { const data = await api('/api/student/reward-applications'); state.rewardApplications = data.applications; renderRewardApplications(); }
function readingStatusMeta(status) { return ({ pending_review: ['waiting', '待审核'], needs_more: ['draft', '待补充'], completed: ['done', '已完成'], not_started: ['waiting', '待打卡'] })[status] || ['waiting', '待打卡']; }
function readingCover(url) { return url ? `<img src="${escapeHtml(url)}" alt="书籍封面" />` : icon('book-open'); }
function readingFeedbackMarkup(checkin) {
  if (!checkin?.feedbackUrl) return '';
  const media = checkin.feedbackKind === 'video' ? `<video src="${escapeHtml(checkin.feedbackUrl)}" controls preload="metadata"></video>` : `<img src="${escapeHtml(checkin.feedbackUrl)}" alt="阅读打卡反馈" />`;
  return `<section class="task-resource-section"><h3>阅读反馈 <small>1 个文件</small></h3><div class="task-resource-list"><article class="task-resource-card">${media}<span class="task-resource-copy"><b>${escapeHtml(checkin.feedbackName || '阅读反馈')}</b><small>${checkin.feedbackKind === 'video' ? '视频反馈·可播放' : '图片反馈'}</small></span><span class="task-resource-actions"><a class="resource-action-button resource-download-button" href="${escapeHtml(checkin.feedbackUrl)}" download="${escapeHtml(checkin.feedbackName || '阅读反馈')}">${icon('download')}<span>下载</span></a></span></article></div></section>`;
}
function readingCard(card) {
  const checkin = card.checkin; const plan = card.plan;
  const progress = `${Math.max(plan.currentPage, plan.startPage - 1)} / ${plan.totalPages} 页`;
  const remaining = Number(card.dailyLimit?.remaining || 0); const hasPending = Boolean(card.dailyLimit?.hasPending);
  const [klass, label] = hasPending ? ['waiting', '审核中'] : checkin?.status === 'needs_more' ? readingStatusMeta(checkin.status) : card.canCheckin && Number(card.todayCount || 0) > 0 ? ['draft', '可继续打卡'] : readingStatusMeta(checkin?.status || 'not_started');
  const action = hasPending ? '<span class="status waiting">审核中</span>' : card.canCheckin ? `<button class="start-task" data-reading-checkin="${plan.id}">${checkin?.status === 'needs_more' ? '补充打卡' : '提交打卡'}</button>` : remaining === 0 ? '' : `<span class="status waiting">${escapeHtml(card.unavailableReason || label)}</span>`;
  return `<article class="task-card reading-card${checkin ? ' task-detail-row' : ''}" ${checkin ? `data-reading-detail="${plan.id}" role="button" tabindex="0"` : ''}><span class="category-icon reading-cover">${readingCover(plan.coverUrl)}</span><div class="task-main"><h3>${escapeHtml(plan.title)}</h3><p class="task-description">${plan.targetPages ? `本次目标 ${plan.targetPages} 页` : ''}${plan.targetPages && plan.targetMinutes ? ' · ' : ''}${plan.targetMinutes ? `约 ${plan.targetMinutes} 分钟` : ''}</p><div class="task-meta"><p>${icon('book-open-check')} 已读 ${progress} · 今日 ${card.todayCount || 0} / 3 次</p><span class="status ${klass}">${label}</span></div></div><div class="task-action"><span class="stars">⭐ ${plan.stars} 颗星星</span>${action}</div></article>`;
}
function readingMonthDays(month) { const first = parseDate(`${month}-01`); const offset = (first.getUTCDay() + 6) % 7; const dayCount = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate(); return { offset, dayCount }; }
function renderReadingMonth(data) {
  const { offset, dayCount } = readingMonthDays(data.month); const checkedDates = new Set(data.checkinDates || []);
  $('#reading-month-title').textContent = `${Number(data.month.slice(0, 4))} 年 ${Number(data.month.slice(5, 7))} 月`;
  $('#reading-month').innerHTML = `${'<span class="reading-month-blank" aria-hidden="true"></span>'.repeat(offset)}${Array.from({ length: dayCount }, (_, index) => { const date = `${data.month}-${String(index + 1).padStart(2, '0')}`; const checked = checkedDates.has(date); return `<span class="reading-month-day${checked ? ' checked' : ''}${date === data.today ? ' today' : ''}"><b>${index + 1}</b>${checked ? `<i>${icon('check')}</i>` : ''}</span>`; }).join('')}`;
}
function renderReadingSummary(data) {
  const summary = data.summary || {};
  $('#reading-summary').innerHTML = `<article class="reading-summary-card summary-active"><div class="reading-summary-card-head"><span class="reading-summary-icon">${icon('book-open')}</span><small>在读书籍</small></div><div class="reading-summary-value"><strong>${summary.activeBookCount || 0}</strong><span>本</span></div></article><article class="reading-summary-card summary-completed"><div class="reading-summary-card-head"><span class="reading-summary-icon">${icon('library-big')}</span><small>已读书籍</small></div><div class="reading-summary-value"><strong>${summary.completedBookCount || 0}</strong><span>本</span></div><button class="reading-completed-link" type="button" data-open-completed-books>查看全部</button></article><article class="reading-summary-card summary-days"><div class="reading-summary-card-head"><span class="reading-summary-icon">${icon('calendar-check-2')}</span><small>阅读天数</small></div><div class="reading-summary-value"><strong>${summary.readingDays || 0}</strong><span>天</span></div></article><article class="reading-summary-card reading-reward-summary summary-rewards"><div class="reading-summary-card-head"><span class="reading-summary-icon">${icon('sparkles')}</span><small>打卡奖励</small></div><div class="growth-rewards">${growthRewardsHtml(summary.growth, true)}</div></article>`;
}
function renderStudentReading(data) {
  state.readingData = data; state.readingDate = data.month;
  renderReadingMonth(data); renderReadingSummary(data);
  $('#reading-checkin-list').innerHTML = data.cards.map(readingCard).join('') || emptyState('book-open-check', '当前没有阅读计划', '家长布置阅读计划后，会在这里显示。'); refreshIcons();
}
function openCompletedReadingBooks() {
  const books = state.readingData?.achievements?.completedBooks || []; const summary = state.readingData?.summary || {};
  $('#reading-completed-books-content').innerHTML = `<div class="modal-content"><p class="eyebrow">阅读成就</p><h2>已读书籍</h2><p class="reading-drawer-summary">已完成 ${summary.completedBookCount || 0} 本书，共完成 ${summary.completedBookTimes || 0} 次阅读。</p><div class="reading-completed-book-list">${books.map(book => `<article><span class="reading-cover">${readingCover(book.coverUrl)}</span><div><h3>${escapeHtml(book.title)}</h3><p>已完成阅读 ${book.completedCount} 次${book.completedAt ? ` · 最近完成于 ${shortDate(book.completedAt.slice(0, 10))}` : ''}</p></div></article>`).join('') || '<div class="empty-state compact-empty"><p>暂时还没有读完的书籍</p></div>'}</div></div>`;
  $('#reading-completed-books-dialog').showModal(); refreshIcons();
}
async function loadStudentReading(month = state.readingDate || today().slice(0, 7)) { const data = await api(`/api/student/reading?month=${encodeURIComponent(month)}`); renderStudentReading(data); }
function renderReadingBooks() { $('#reading-book-list').innerHTML = state.readingBooks.map(book => { const edit = `<button type="button" data-edit-reading-book="${book.id}">${icon('pencil')}编辑</button>`; const remove = book.canDelete ? `<button type="button" class="danger" data-delete-reading-book="${book.id}">${icon('trash-2')}删除</button>` : ''; return `<article class="reading-book-card"><span class="reading-cover">${readingCover(book.coverUrl)}</span><div><h3>${escapeHtml(book.title)}</h3><p>${escapeHtml(book.author || '作者未填写')} · ${book.totalPages} 页</p><small>${escapeHtml(book.publisher || '')}</small></div><details class="reading-book-actions"><summary class="icon-button" aria-label="${escapeHtml(book.title)} 更多操作">${icon('ellipsis')}</summary><div>${edit}${remove}</div></details></article>`; }).join('') || emptyState('library-big', '书架还是空的', '先录入要阅读的书籍，再为孩子布置计划。'); }
function readingPlanRow(plan) { const status = { active: '进行中', paused: '已暂停', awaiting_confirmation: '等待确认读完', completed: '已完成', archived: '已归档' }[plan.status] || plan.status; const editable = ['active', 'paused'].includes(plan.status); const actions = `${plan.status === 'awaiting_confirmation' ? `<button class="primary-button" data-confirm-reading-plan="${plan.id}">确认读完</button>` : ''}${editable ? `<button class="icon-button edit-task-button" data-edit-reading-plan="${plan.id}" aria-label="修改阅读计划" title="修改阅读计划">${icon('pencil')}</button><button class="icon-button delete-task-button" data-delete-reading-plan="${plan.id}" aria-label="删除阅读计划">${icon('trash-2')}</button>` : ''}`; return `<article class="parent-task-row reading-plan-row"><span class="category-icon reading-cover">${readingCover(plan.coverUrl)}</span><div class="parent-task-main"><div><h3>${escapeHtml(plan.title)}</h3><span class="status ${plan.status === 'completed' ? 'done' : plan.status === 'awaiting_confirmation' ? 'waiting' : 'draft'}">${status}</span></div><p>${escapeHtml(plan.studentName)} · ${plan.startDate}${plan.endDate ? ` 至 ${plan.endDate}` : ' 起'} · 已读 ${plan.currentPage} / ${plan.totalPages} 页</p><p>${plan.frequency === 'daily' ? '每天阅读' : `每周${plan.weekdays.join('、')}`} · ${plan.targetPages ? `每次 ${plan.targetPages} 页` : ''}${plan.targetMinutes ? ` ${plan.targetMinutes} 分钟` : ''} · ⭐ ${plan.stars}</p></div><div class="reading-plan-actions">${actions}</div></article>`; }
function setParentReadingTab(tab = state.readingParentTab) { state.readingParentTab = tab; $$('[data-reading-parent-tab]').forEach(button => button.classList.toggle('active', button.dataset.readingParentTab === tab)); $('#reading-plan-panel').hidden = tab !== 'plans'; $('#reading-book-panel').hidden = tab !== 'books'; $('#add-reading-plan').hidden = tab !== 'plans'; $('#add-reading-book').hidden = tab !== 'books'; }
function renderParentReading() { renderReadingBooks(); $('#reading-plan-list').innerHTML = state.readingPlans.map(readingPlanRow).join('') || emptyState('book-open-check', '暂无阅读计划', '选择书籍和学生后即可布置阅读计划。'); setParentReadingTab(); refreshIcons(); }
async function loadParentReading() { const [bookData, planData, studentsData] = await Promise.all([api('/api/parent/reading/books'), api('/api/parent/reading/plans'), api('/api/parent/students')]); state.readingBooks = bookData.books; state.readingPlans = planData.plans; state.students = studentsData.students; renderParentReading(); }
function renderReadingBookCoverPreview() { const preview = $('#reading-book-cover-preview'); const hasCover = Boolean(state.readingCoverData); preview.hidden = !hasCover; preview.innerHTML = hasCover ? `<article class="resource-preview-row"><img src="${escapeHtml(state.readingCoverData)}" alt="书籍封面预览" /><div><b>${escapeHtml(state.readingCoverName || '书籍封面')}</b><small>${state.readingCoverExisting ? '当前封面' : '待上传'}</small></div><button type="button" class="icon-button" data-remove-reading-book-cover aria-label="移除封面">${icon('x')}</button></article>` : ''; refreshIcons(); }
function openReadingBookForm(book = null) { $('#reading-book-form').reset(); $('#reading-book-id').value = book?.id || ''; $('#reading-book-dialog-title').textContent = book ? '修改书籍' : '录入书籍'; $('#save-reading-book').textContent = book ? '保存修改' : '保存书籍'; $('#reading-book-title').value = book?.title || ''; $('#reading-book-author').value = book?.author || ''; $('#reading-book-pages').value = book?.totalPages || ''; $('#reading-book-publisher').value = book?.publisher || ''; $('#reading-book-isbn').value = book?.isbn || ''; state.readingCoverData = book?.coverUrl || ''; state.readingCoverName = book?.coverUrl ? '当前书籍封面' : ''; state.readingCoverExisting = Boolean(book?.coverUrl); $('#reading-book-cover').value = ''; renderReadingBookCoverPreview(); $('#reading-book-error').textContent = ''; $('#reading-book-dialog').showModal(); decorateRequiredFields($('#reading-book-dialog')); }
function setReadingFrequency(frequency) { state.readingFrequency = frequency; $$('[data-reading-frequency]').forEach(button => button.classList.toggle('selected', button.dataset.readingFrequency === frequency)); $('#reading-plan-weekdays').hidden = frequency !== 'weekly'; }
async function openReadingPlanForm(plan = null) { if (!state.readingBooks.length) { await loadParentReading(); if (!state.readingBooks.length) { showToast('请先录入书籍'); return; } } $('#reading-plan-form').reset(); $('#reading-plan-id').value = plan?.id || ''; $('#reading-plan-dialog-title').textContent = plan ? '修改阅读计划' : '布置阅读计划'; $('#save-reading-plan').textContent = plan ? '保存修改' : '保存计划'; $('#reading-plan-book').innerHTML = state.readingBooks.map(book => `<option value="${book.id}" ${Number(book.id) === Number(plan?.bookId) ? 'selected' : ''}>${escapeHtml(book.title)}（${book.totalPages} 页）</option>`).join(''); $('#reading-plan-book').disabled = Boolean(plan); $('#reading-plan-students').innerHTML = state.students.filter(student => student.active).map(student => `<label><input type="checkbox" value="${student.id}" ${Number(student.id) === Number(plan?.studentId) ? 'checked' : ''} ${plan ? 'disabled' : ''}/>${escapeHtml(student.display_name)}</label>`).join(''); $('#reading-plan-start').value = plan?.startDate || today(); $('#reading-plan-end').value = plan?.endDate || ''; $('#reading-plan-start-page').value = plan?.startPage || 1; $('#reading-plan-start-page').readOnly = Boolean(plan); $('#reading-plan-target-pages').value = plan?.targetPages || ''; $('#reading-plan-target-minutes').value = plan?.targetMinutes || ''; $('#reading-plan-stars').value = plan?.stars ?? 1; $('#reading-plan-feedback').value = plan?.feedbackType || 'optional_photo_or_video'; $('#reading-plan-review').checked = plan ? plan.needsReview : true; setReadingFrequency(plan?.frequency || 'daily'); $$('#reading-plan-weekdays input').forEach(input => { input.checked = plan?.weekdays?.includes(Number(input.value)) || false; }); $('#reading-plan-error').textContent = ''; $('#reading-plan-dialog').showModal(); decorateRequiredFields($('#reading-plan-dialog')); }
function openReadingCheckin(card) { const plan = card.plan; const checkin = card.checkin; const optionalFeedback = ['none', 'optional_photo_or_video'].includes(plan.feedbackType); $('#reading-checkin-plan-id').value = plan.id; $('#reading-checkin-date').value = state.readingData?.today || today(); $('#reading-checkin-book').textContent = plan.title; $('#reading-checkin-range').textContent = `本次从第 ${card.expectedStartPage} 页开始，最多读至第 ${plan.totalPages} 页。`; $('#reading-checkin-end-page').min = card.expectedStartPage; $('#reading-checkin-end-page').max = plan.totalPages; $('#reading-checkin-end-page').value = checkin?.endPage || card.expectedStartPage; $('#reading-checkin-reflection').value = checkin?.reflection || ''; $('#reading-checkin-feedback').value = ''; state.readingFeedbackData = ''; state.readingFeedbackName = ''; $('#reading-checkin-feedback-required').hidden = optionalFeedback; $('#reading-checkin-feedback-note').textContent = optionalFeedback ? '（选填）' : ''; $('#reading-checkin-feedback-preview').innerHTML = '<span>尚未选择反馈文件</span>'; $('#reading-checkin-error').textContent = ''; $('#reading-checkin-dialog').showModal(); decorateRequiredFields($('#reading-checkin-dialog')); refreshIcons(); }
function openReadingDetail(card) { const checkin = card.checkin; if (!checkin) return; const [, label] = readingStatusMeta(checkin.status); const rewards = `<p class="reading-detail-rewards"><b>阅读奖励</b>计划奖励 ${checkin.stars} 颗${checkin.awardedStars !== null ? ` · 实际奖励 ${checkin.awardedStars} 颗` : ''}</p>`; $('#task-detail-modal-content').innerHTML = `<div class="modal-content"><p class="eyebrow">${escapeHtml(card.plan.title)} · ${checkin.checkinDate}</p><h2>阅读打卡详情</h2><div class="review-task-details"><p><b>阅读页码</b>第 ${checkin.startPage} 至 ${checkin.endPage} 页，共 ${checkin.pagesRead} 页</p><p><b>当前状态</b>${label}</p><p><b>阅读感受</b>${multilineText(checkin.reflection, '未填写')}</p>${rewards}${checkin.parentMessage ? `<p><b>家长说明</b>${multilineText(checkin.parentMessage)}</p>` : ''}</div>${readingFeedbackMarkup(checkin)}<div class="modal-actions">${checkin.status === 'needs_more' ? `<button class="primary-button" data-reading-checkin="${card.plan.id}">补充打卡</button>` : ''}</div></div>`; $('#task-detail-dialog').showModal(); refreshIcons(); }
function readingReviewRow(item) { return `<article class="review-list-row" data-reading-review="${item.id}" role="button" tabindex="0"><span class="category-icon reading-cover">${readingCover(item.bookCoverUrl)}</span><div><h3>${escapeHtml(item.bookTitle)} <span class="review-type-badge reward">阅读打卡</span></h3><p>${escapeHtml(item.studentName)} · 第 ${item.startPage}-${item.endPage} 页 · ${item.checkinDate}</p></div><span class="stars">⭐ ${item.stars}</span><button class="primary-button" data-reading-review-action="${item.id}">审核</button></article>`; }
function openReadingReview(item) { $('#reading-review-content').innerHTML = `<div class="modal-content review-modal"><p class="eyebrow">${escapeHtml(item.studentName)} · ${escapeHtml(item.bookTitle)}</p><h2>阅读打卡审核</h2><div class="review-task-details"><p><b>阅读日期</b>${item.checkinDate}</p><p><b>阅读页码</b>第 ${item.startPage} 至 ${item.endPage} 页，共 ${item.pagesRead} 页</p><p><b>阅读感受</b>${multilineText(item.reflection, '未填写')}</p><p><b>原计划奖励</b>${item.stars} 颗</p></div>${readingFeedbackMarkup(item)}<div class="review-reward-form"><label>实际奖励星星<span class="number-with-unit"><input id="reading-review-stars" type="number" min="0" step="1" value="${item.stars}" /><b>颗</b></span></label><label>阅读结束页<span class="number-with-unit"><input id="reading-review-end-page" type="number" min="${item.startPage}" max="${item.totalPages}" value="${item.endPage}" /><b>页</b></span></label><label>调整原因<textarea id="reading-review-adjustment" maxlength="300" placeholder="若调整结束页，请说明原因"></textarea></label><label>审核说明<textarea id="reading-review-message" maxlength="300" placeholder="填写鼓励或补充说明"></textarea></label></div><p class="login-error" id="reading-review-error"></p><div class="review-actions"><button class="supplement" data-reading-needs-more="${item.id}">需要补充</button><button class="primary-button" data-reading-approve="${item.id}">通过并奖励</button></div></div>`; $('#reading-review-dialog').showModal(); decorateRequiredFields($('#reading-review-dialog')); refreshIcons(); }
function renderRewardApplicationResources() { const preview = $('#reward-application-file-list'); preview.hidden = state.rewardApplicationResources.length === 0; preview.innerHTML = resourcePreviewRows(state.rewardApplicationResources, 'data-remove-reward-application-resource'); refreshIcons(); }
async function openRewardApplicationForm(item = null) { const categoryData = await api('/api/student/categories', { silent: true }); state.categories = categoryData.categories || []; $('#reward-application-id').value = item?.id || ''; $('#reward-application-category').innerHTML = state.categories.map(c => `<option value="${c.id}" ${Number(c.id) === Number(item?.categoryId || state.categories[0]?.id) ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join(''); $('#reward-application-content').value = item?.content || ''; $('#reward-application-detail').value = item?.detail || ''; $('#reward-application-date').value = item?.completedAt || today(); $('#reward-application-stars').value = item?.requestedStars || 1; state.rewardApplicationResources = (item?.resources || []).map(resource => ({ ...resource, existing: true })); state.rewardApplicationResourcesChanged = false; $('#reward-application-files').value = ''; renderRewardApplicationResources(); $('#reward-application-error').textContent = ''; $('#reward-application-dialog').showModal(); decorateRequiredFields($('#reward-application-dialog')); }
function openRewardApplicationDetail(item) { state.activeTaskDetail = item; $('#reward-application-detail-content').innerHTML = `<div class="modal-content"><p class="eyebrow">${escapeHtml(item.category)} · ${item.completedAt}</p><h2>${escapeHtml(item.content)}</h2><div class="review-task-details"><p><b>说明</b>${multilineText(item.detail, '暂无说明')}</p><p><b>希望星星</b>${item.requestedStars} 颗</p><p><b>状态</b>${item.status === 'pending' ? '待审核' : item.status === 'approved' ? `已通过，实际奖励 ${item.awardedStars} 颗` : '已驳回'}</p>${item.parentMessage ? `<p><b>家长反馈</b>${multilineText(item.parentMessage)}</p>` : ''}</div>${taskResourceMarkup(item, '完成图片')}<div class="modal-actions">${['pending','rejected'].includes(item.status) ? `<button class="primary-button" data-edit-reward="${item.id}">修改</button><button class="primary-button danger-button" data-delete-reward="${item.id}">删除</button>` : ''}</div></div>`; $('#reward-application-detail-dialog').showModal(); }
function openRewardReview(item) { state.activeTaskDetail = item; $('#reward-review-content').innerHTML = `<div class="modal-content review-modal"><p class="eyebrow">${escapeHtml(item.studentName)} · ${escapeHtml(item.category)}</p><h2>${escapeHtml(item.content)}</h2><div class="review-task-details reward-review-details"><p><b>完成时间</b>${item.completedAt}</p><p><b>完成分类</b>${escapeHtml(item.category)}</p><p class="reward-review-description"><b>完成说明</b>${multilineText(item.detail, '暂无说明')}</p><p><b>原申请星星</b>${item.requestedStars} 颗</p><p><b>提交时间</b>${formatDateTime(item.createdAt)}</p></div>${taskResourceMarkup(item, '完成图片')}<div class="review-reward-form"><label>实际奖励星星<span class="number-with-unit"><input id="reward-review-stars" type="number" min="0" step="1" value="${item.requestedStars}" /><b>颗</b></span></label><label>审核说明<textarea id="reward-review-message" maxlength="300" placeholder="填写审核说明（选填）"></textarea></label></div><p class="login-error" id="reward-review-error"></p><div class="review-actions"><button class="supplement" data-reward-reject="${item.id}">驳回</button><button class="primary-button" data-reward-approve="${item.id}">通过并奖励</button></div></div>`; $('#reward-review-dialog').showModal(); decorateRequiredFields($('#reward-review-dialog')); refreshIcons(); }
function renderStatistics(data) {
  $('#stats-range-label').textContent = data.period.key === 'all' ? '全部时间' : `${data.period.start} 至 ${data.period.end}`;
  $('#ranking-title').textContent = `学生${data.period.label}`;
  $('#ranking-list').innerHTML = data.students.map((student, index) => `<article class="ranking-row${student.total ? '' : ' no-task'}"><span class="rank-number ${index < 3 ? `top-${index + 1}` : ''}">${index + 1}</span><span class="student-avatar">${avatarMarkup(student.studentAvatar, student.studentName?.slice(0, 1))}</span><div><h3>${escapeHtml(student.studentName)}${student.active ? '' : '<small>已禁用</small>'}</h3><p>${student.total ? `${student.completed} / ${student.total} 项任务完成` : '该时间范围内没有任务'} · 阅读 ${student.readingPages || 0} 页 · 完成书籍 ${student.completedBooks || 0} 本</p></div><strong>⭐ ${student.stars}</strong><span><b>${student.completionRate === null ? '--' : `${student.completionRate}%`}</b>完成率</span><span><b>${student.onTimeRate === null ? '--' : `${student.onTimeRate}%`}</b>按时率</span></article>`).join('') || emptyState('chart-no-axes-combined', '暂无学生数据', '创建学生并分配任务后会显示统计结果。');
  refreshIcons();
}
async function loadStatistics(period = state.statsPeriod) {
  state.statsPeriod = period; const query = new URLSearchParams({ period });
  if (period === 'custom') { query.set('startDate', $('#stats-start-date').value); query.set('endDate', $('#stats-end-date').value); }
  const data = await api(`/api/parent/statistics?${query}`); renderStatistics(data);
  $$('[data-stats-period]').forEach(button => button.classList.toggle('selected', button.dataset.statsPeriod === period));
}
function activeStudents() { return state.students.filter(student => student.active); }
function renderTaskFilters() {
  const students = activeStudents();
  if (!state.taskStudentId || (state.taskStudentId !== 'all' && !students.some(student => student.id === Number(state.taskStudentId)))) state.taskStudentId = state.parent?.selectedStudentId || students[0]?.id || 'all';
  $('#task-student-filter').innerHTML = `<option value="all">全部学生</option>${students.map(student => `<option value="${student.id}">${escapeHtml(student.display_name)}</option>`).join('')}`;
  $('#task-student-filter').value = String(state.taskStudentId);
}
function renderTaskWeek() {
  const labels = ['一', '二', '三', '四', '五', '六', '日'];
  const start = startOfWeek(state.taskDate);
  const incompleteDates = new Set(state.incompleteTaskDates || []);
  $('#task-week').innerHTML = labels.map((label, index) => { const date = addDays(start, index); const hasUnfinished = incompleteDates.has(date); return `<button type="button" data-task-date="${date}" class="${date === state.taskDate ? 'selected' : ''} ${date === today() ? 'today' : ''}"><small>周${label}</small><strong>${parseDate(date).getUTCDate()}</strong>${state.taskDates.includes(date) ? `<i class="${hasUnfinished ? 'unfinished' : ''}" aria-label="${hasUnfinished ? '有未完成任务' : '有任务'}"></i>` : ''}</button>`; }).join('');
  $('#task-list-date-label').textContent = `${shortDate(state.taskDate)}${state.taskDate === today() ? ' · 今日' : ''}`;
}
function parentTaskRow(task) {
  const [, statusLabel] = statusMeta[task.status] || statusMeta.not_started;
  const canManage = !['pending_review', 'completed'].includes(task.status);
  const actions = canManage ? `<div class="parent-task-actions"><button class="icon-button edit-task-button" data-edit-parent-task="${task.id}" aria-label="修改${escapeHtml(task.title)}" title="修改任务">${icon('pencil')}</button><button class="icon-button delete-task-button" data-delete-parent-task="${task.id}" aria-label="删除${escapeHtml(task.title)}" title="${task.isDateRange ? '删除范围任务' : '删除当天任务'}">${icon('trash')}</button></div>` : '<span class="task-actions-placeholder" aria-hidden="true"></span>';
  return `<article class="parent-task-row task-detail-row" data-parent-task="${task.id}" role="button" tabindex="0" aria-label="查看${escapeHtml(task.title)}详情"><span class="category-icon" style="background:${escapeHtml(task.color)}1f">${categoryIconMarkup(task.icon)}</span><div class="parent-task-main"><div><h3>${escapeHtml(task.title)}</h3>${scheduleBadge(task)}<span class="status ${statusMeta[task.status]?.[0] || 'waiting'}">${escapeHtml(statusLabel)}</span></div><p class="task-description">${escapeHtml(task.detail || '暂无任务说明')}</p><p>${escapeHtml(task.studentName || '')} · ${escapeHtml(task.category)} · ${task.duration || 0} 分钟 · ⭐ ${task.stars}</p>${resourceBadge(task)}</div>${actions}</article>`;
}
function parentTaskCacheKey(date = state.taskDate) { return `${state.taskStudentId || 'all'}:${date}`; }
function renderParentTasks(data) {
  state.parentTasks = data.tasks;
  state.taskDates = data.taskDates || [];
  state.incompleteTaskDates = data.incompleteTaskDates || [];
  renderTaskWeek();
  $('#parent-task-list').innerHTML = data.tasks.map(parentTaskRow).join('') || emptyState('clipboard-list', '这一天还没有任务', '可以新建任务，或从模板批量分配。');
  refreshIcons();
}
async function loadParentTasks({ force = false, silent = false } = {}) {
  const selectedDate = state.taskDate;
  const key = parentTaskCacheKey(selectedDate);
  const cached = state.parentTaskCache.get(key);
  if (!force && cached && Date.now() - cached.cachedAt < 300000) { renderParentTasks(cached.data); return; }
  state.parentTaskLoadController?.abort();
  const controller = new AbortController();
  state.parentTaskLoadController = controller;
  try {
    const data = await api(`/api/parent/tasks?date=${encodeURIComponent(selectedDate)}&studentId=${encodeURIComponent(state.taskStudentId || 'all')}`, { signal: controller.signal, silent });
    const cachedAt = Date.now();
    if (data.weekTasks) Object.entries(data.weekTasks).forEach(([day, tasks]) => state.parentTaskCache.set(parentTaskCacheKey(day), { data: { ...data, tasks }, cachedAt }));
    else state.parentTaskCache.set(key, { data, cachedAt });
    if (state.taskDate === selectedDate) renderParentTasks(data);
  } catch (error) {
    if (error.name !== 'AbortError') throw error;
  } finally {
    if (state.parentTaskLoadController === controller) state.parentTaskLoadController = null;
  }
}
async function prepareTaskManager() {
  state.taskDate ||= today();
  renderTaskFilters();
  renderTaskWeek();
  await loadParentTasks();
}
function renderCategories() {
  $('#assignment-category').innerHTML = state.categories.map(category => `<option value="${category.id}">${escapeHtml(category.name)}</option>`).join('');
  renderAssignmentCategoryIcon();
  $('#category-list').innerHTML = state.categories.map(category => `<article class="category-row"><span style="background:${escapeHtml(category.color)}1f">${categoryIconMarkup(category.icon)}</span><strong>${escapeHtml(category.name)}</strong><div><button class="text-button" data-edit-category="${category.id}">修改</button><button class="text-button danger-text" data-delete-category="${category.id}">删除</button></div></article>`).join('') || emptyState('tags', '暂无任务分类', '点击“新增分类”创建第一个分类。');
  refreshIcons();
}
async function loadCategories() { const data = await api('/api/parent/categories'); state.categories = data.categories; renderCategories(); }
function renderAssignmentCategoryIcon() { const category = state.categories.find(item => item.id === Number($('#assignment-category').value)) || state.categories[0]; $('#assignment-category-icon').innerHTML = category ? categoryIconMarkup(category.icon) : ''; }
function templateVisibility(template) { return template.isPublic ? '公开模板' : '私有模板'; }
function templateVisibilityBadge(template) {
  return `<span class="template-visibility ${template.isPublic ? 'public' : 'private'}">${template.isPublic ? icon('globe-2') : icon('lock-keyhole')} ${templateVisibility(template)}</span>`;
}
function taskTemplateCard(template, selectable = false) {
  const resource = resourceBadge(template);
  if (selectable) return `<article class="template-picker-card"><label class="template-select-zone"><input type="checkbox" value="${template.id}" ${state.selectedTemplateIds.includes(template.id) ? 'checked' : ''}/><span class="category-icon" style="background:${escapeHtml(template.color)}1f">${categoryIconMarkup(template.icon)}</span><span class="template-picker-copy"><b>${escapeHtml(template.title)}</b><small>创建人：${escapeHtml(template.creatorName)} · ${template.duration} 分钟 · ⭐ ${template.stars}</small>${templateVisibilityBadge(template)}${resource}</span></label><button type="button" class="template-view-button" data-view-template="${template.id}">${icon('eye')} 查看详情</button></article>`;
  const actions = `<div class="template-card-actions"><button class="icon-button" data-view-template="${template.id}" aria-label="查看${escapeHtml(template.title)}详情" title="查看详情">${icon('eye')}</button>${template.isOwner ? `<button class="icon-button" data-copy-template="${template.id}" aria-label="复制${escapeHtml(template.title)}" title="复制模板">${icon('copy')}</button><button class="icon-button" data-edit-template="${template.id}" aria-label="修改${escapeHtml(template.title)}" title="修改模板">${icon('pencil')}</button><button class="icon-button danger-text" data-delete-template="${template.id}" aria-label="删除${escapeHtml(template.title)}" title="删除模板">${icon('trash')}</button>` : ''}</div>`;
  return `<article class="template-card"><span class="category-icon" style="background:${escapeHtml(template.color)}1f">${categoryIconMarkup(template.icon)}</span><div class="template-card-main"><div class="template-card-title"><h3>${escapeHtml(template.title)}</h3>${templateVisibilityBadge(template)}</div><p>${escapeHtml(template.detail)}</p><div class="template-card-meta"><span>${icon('clock-3')} ${template.duration} 分钟</span><span>⭐ ${template.stars} 颗</span><span>${template.needsReview ? '需要审核' : '无需审核'}</span><span>创建人：${escapeHtml(template.creatorName)}</span><span>${icon('refresh-cw')} 更新于 ${escapeHtml(formatUpdatedAt(template.updatedAt || template.createdAt))}</span>${resource}</div></div>${actions}</article>`;
}
function groupTemplates(templates) {
  return state.categories.map(category => ({ category, templates: templates.filter(template => template.categoryId === category.id) })).filter(group => group.templates.length);
}
function renderTemplateGroups() {
  const keyword = state.templateSearch.trim().toLowerCase();
  const categoryFiltered = state.templateCategoryFilter === 'all' ? state.templates : state.templates.filter(template => template.categoryId === Number(state.templateCategoryFilter));
  const filtered = keyword ? categoryFiltered.filter(template => [template.title, template.detail, template.creatorName, template.category].some(value => String(value || '').toLowerCase().includes(keyword))) : categoryFiltered;
  $('#template-count').textContent = `共 ${filtered.length} 个模板`;
  $('#template-library-tabs').innerHTML = `<button type="button" role="tab" data-template-category-filter="all" aria-selected="${state.templateCategoryFilter === 'all'}" class="${state.templateCategoryFilter === 'all' ? 'selected' : ''}">全部 <small>${state.templates.length}</small></button>${state.categories.map(category => { const count = state.templates.filter(template => template.categoryId === category.id).length; return `<button type="button" role="tab" data-template-category-filter="${category.id}" aria-selected="${String(category.id) === state.templateCategoryFilter}" class="${String(category.id) === state.templateCategoryFilter ? 'selected' : ''}">${categoryIconMarkup(category.icon)}<span>${escapeHtml(category.name)}</span><small>${count}</small></button>`; }).join('')}`;
  $('#template-groups').innerHTML = filtered.length ? `<div class="template-list template-library-list">${filtered.map(template => taskTemplateCard(template)).join('')}</div>` : emptyState('notebook-tabs', '暂无任务模板', '点击“新增模板”创建常用任务。');
  refreshIcons();
}
async function loadTaskTemplates() { const data = await api('/api/parent/task-templates'); state.templates = data.templates; renderTemplateGroups(); }
function renderTemplateCategoryIcon() { const category = state.categories.find(item => item.id === Number($('#template-category').value)) || state.categories[0]; $('#template-category-icon').innerHTML = category ? categoryIconMarkup(category.icon) : ''; }
function resourcePreviewRows(resources, removeAttribute) {
  return resources.map((resource, index) => { const kind = resourceKindOf(resource); return `<div class="resource-preview-row">${kind === 'image' && resource.data ? `<img src="${resource.data}" alt="" />` : kind === 'video' && resource.data ? `<video src="${resource.data}" controls preload="metadata"></video>` : kind === 'audio' && resource.data ? `<audio src="${resource.data}" controls preload="metadata"></audio>` : `<span class="resource-file-icon">${icon(kind === 'audio' ? 'volume-2' : 'file')}</span>`}<div><b>${escapeHtml(resource.name)}</b><small>${resource.existing ? '已保存的资料' : '待上传'}</small></div><button type="button" class="icon-button" ${removeAttribute}="${index}" aria-label="移除${escapeHtml(resource.name)}" title="移除">${icon('x')}</button></div>`; }).join('');
}
function renderTemplateResourcePreview() {
  const preview = $('#template-resource-preview');
  preview.hidden = state.templateResources.length === 0;
  preview.innerHTML = resourcePreviewRows(state.templateResources, 'data-remove-template-resource');
  refreshIcons();
}
function openTemplateEditor(template = null) {
  state.editingTemplateId = template?.copyMode ? null : (template?.id || null);
  state.copyingTemplateId = template?.copyMode ? template.sourceTemplateId : null;
  $('#template-form').reset();
  $('#template-editor-title').textContent = template?.copyMode ? '复制任务模板' : template ? '修改模板' : '新增模板';
  $('#template-submit').textContent = template?.copyMode ? '保存模板' : template ? '保存修改' : '保存模板';
  $('#template-title').value = template?.title || '';
  $('#template-detail').value = template?.detail || '';
  $('#template-duration').value = template?.duration || 15;
  $('#template-stars').value = template?.stars || 1;
  $('#template-feedback').value = template?.feedbackType || 'photo_or_video';
  $('#template-review').checked = template ? template.needsReview : true;
  $('#template-public').checked = template ? template.isPublic : false;
  $('#template-category').innerHTML = state.categories.map(category => `<option value="${category.id}">${escapeHtml(category.name)}</option>`).join('');
  const selectedCategoryId = template?.categoryId || (state.templateCategoryFilter !== 'all' ? Number(state.templateCategoryFilter) : state.categories[0]?.id);
  $('#template-category').value = String(selectedCategoryId || state.categories[0]?.id || '');
  state.templateResources = (template?.resources || []).map(resource => ({ ...resource, existing: true })); state.removeTemplateResource = false;
  $('#template-resource-file').value = ''; $('#template-error').textContent = ''; renderTemplateResourcePreview(); renderTemplateCategoryIcon(); setParentPage('template-editor'); refreshIcons();
}
function renderTemplatePicker() {
  const groups = state.categories.map(category => ({ category, templates: state.templates.filter(template => template.categoryId === category.id) }));
  if (!groups.some(group => group.category.id === state.templatePickerCategoryId)) state.templatePickerCategoryId = groups[0]?.category.id || null;
  $('#template-category-tabs').innerHTML = groups.map(group => `<button type="button" role="tab" aria-selected="${group.category.id === state.templatePickerCategoryId}" class="${group.category.id === state.templatePickerCategoryId ? 'selected' : ''}" data-template-picker-category="${group.category.id}">${categoryIconMarkup(group.category.icon)}<span>${escapeHtml(group.category.name)}</span><small>${group.templates.length}</small></button>`).join('');
  const activeGroup = groups.find(group => group.category.id === state.templatePickerCategoryId);
  $('#template-picker-groups').innerHTML = activeGroup?.templates.length ? `<section class="template-picker-group"><div class="template-picker-list">${activeGroup.templates.map(template => taskTemplateCard(template, true)).join('')}</div></section>` : emptyState('notebook-tabs', '该分类暂无模板', '可以切换其他任务分类继续选择。');
  $('#selected-template-summary').textContent = state.selectedTemplateIds.length ? `已选择 ${state.selectedTemplateIds.length} 个模板` : '尚未选择模板';
  refreshIcons();
}
function setTemplateDateMode(mode) {
  state.templateDateMode = mode;
  $$('[data-template-date-mode]').forEach(button => button.classList.toggle('selected', button.dataset.templateDateMode === mode));
  $('#template-single-date-wrap').hidden = mode !== 'single'; $('#template-single-date').required = mode === 'single';
  $('#template-range-fields').hidden = mode !== 'range'; $('#template-range-start-date').required = mode === 'range'; $('#template-range-end-date').required = mode === 'range';
  $('#template-repeat-fields').hidden = mode !== 'repeat'; $('#template-end-date').required = mode === 'repeat';
  if (mode === 'repeat') syncRepeatDateLimit('template');
  decorateRequiredFields($('#template-assign-form'));
}
function repeatPattern(prefix) { return $(`input[name="${prefix}-repeat-pattern"]:checked`)?.value || 'daily'; }
function selectedRepeatWeekdays(prefix) { return $$(`#${prefix}-weekday-picker input:checked`).map(input => Number(input.value)); }
function setRepeatPattern(prefix, pattern = 'daily') {
  const input = $(`input[name="${prefix}-repeat-pattern"][value="${pattern}"]`); if (input) input.checked = true;
  $(`#${prefix}-weekday-picker`).hidden = pattern !== 'weekly';
}
function syncRepeatDateLimit(prefix) {
  const start = $(`#${prefix}-start-date`).value || today();
  const end = $(`#${prefix}-end-date`);
  end.min = start; end.max = addDays(start, 29);
  if (end.value && (end.value < start || end.value > end.max)) end.value = start;
}
function schedulePayload(prefix, mode) {
  if (mode === 'single') { const date = $(`#${prefix}-single-date`).value; return { scheduleType: 'single', date, startDate: date, endDate: date }; }
  if (mode === 'range') {
    const startDate = $(`#${prefix}-range-start-date`).value;
    const endDate = $(`#${prefix}-range-end-date`).value;
    if (!startDate || !endDate) throw new Error('请填写持续日期的开始和结束日期');
    if (endDate < startDate) throw new Error('结束日期不能早于开始日期');
    return { scheduleType: 'range', startDate, endDate };
  }
  const startDate = $(`#${prefix}-start-date`).value;
  const endDate = $(`#${prefix}-end-date`).value;
  const pattern = repeatPattern(prefix);
  const weekdays = selectedRepeatWeekdays(prefix);
  const effectiveStart = startDate || today();
  if (!endDate) throw new Error('请填写重复任务的结束日期');
  if (endDate < effectiveStart) throw new Error('结束日期不能早于开始日期');
  if (dateSpanDays(effectiveStart, endDate) > 30) throw new Error('重复日期范围最多 30 天');
  if (pattern === 'weekly' && !weekdays.length) throw new Error('请至少选择一个重复星期');
  return { scheduleType: 'repeat', repeatPattern: pattern, weekdays, startDate, endDate };
}
function showTemplateAssignmentStep(step) {
  $('#template-assign-step-one').hidden = step !== 1; $('#template-assign-form').hidden = step !== 2;
  if (step === 2) {
    const selected = state.templates.filter(template => state.selectedTemplateIds.includes(template.id));
    $('#template-assignment-selection').textContent = `已选择 ${selected.length} 个模板：${selected.map(template => template.title).join('、')}`;
    $('#template-assignment-students').innerHTML = activeStudents().map(student => `<label class="student-choice"><input type="checkbox" value="${student.id}" ${String(student.id) === String(state.taskStudentId) || activeStudents().length === 1 ? 'checked' : ''}/><span class="student-avatar">${avatarMarkup(student.avatar, student.display_name?.slice(0, 1))}</span><b>${escapeHtml(student.display_name)}</b></label>`).join('');
    const date = state.taskDate || today(); $('#template-single-date').value = date; $('#template-range-start-date').value = date; $('#template-range-end-date').value = date; $('#template-start-date').value = ''; $('#template-end-date').value = date; setRepeatPattern('template', 'daily');
    $$('#template-weekday-picker input').forEach(input => { input.checked = Number(input.value) === (((parseDate(date).getUTCDay() + 6) % 7) + 1); });
    syncRepeatDateLimit('template'); setTemplateDateMode('single');
  }
  refreshIcons();
}
async function openTemplateAssignment() {
  setParentPage('template-assign');
  await Promise.all([ensurePageData('categories', loadCategories), ensurePageData('students', loadStudents)]);
  await ensurePageData('templates', loadTaskTemplates);
  state.selectedTemplateIds = []; state.templatePickerCategoryId = null; $('#template-assignment-error').textContent = ''; renderTemplatePicker(); showTemplateAssignmentStep(1); setParentPage('template-assign');
}
function setAssignmentDateMode(mode) {
  state.assignmentDateMode = mode;
  $$('[data-assignment-date-mode]').forEach(button => button.classList.toggle('selected', button.dataset.assignmentDateMode === mode));
  $('#assignment-single-date-wrap').hidden = mode !== 'single';
  $('#assignment-single-date').required = mode === 'single';
  $('#assignment-range-fields').hidden = mode !== 'range';
  $('#assignment-range-start-date').required = mode === 'range';
  $('#assignment-range-end-date').required = mode === 'range';
  $('#assignment-repeat-fields').hidden = mode !== 'repeat';
  $('#assignment-end-date').required = mode === 'repeat';
  if (mode === 'repeat') syncRepeatDateLimit('assignment');
  decorateRequiredFields($('#assignment-form'));
}
function renderAssignmentResourcePreview(task = null) {
  const preview = $('#assignment-resource-preview');
  preview.hidden = state.taskResources.length === 0;
  preview.innerHTML = resourcePreviewRows(state.taskResources, 'data-remove-task-resource');
  refreshIcons();
}
function openAssignmentEditor(task = null) {
  const students = activeStudents();
  state.editingTaskId = task?.id || null; state.editingTask = task;
  $('#assignment-form').reset();
  const selectedStudentId = task?.studentId || state.taskStudentId;
  $('#assignment-students').innerHTML = students.map(student => `<label class="student-choice"><input type="checkbox" value="${student.id}" ${String(student.id) === String(selectedStudentId) ? 'checked' : ''}/><span class="student-avatar">${avatarMarkup(student.avatar, student.display_name?.slice(0, 1))}</span><b>${escapeHtml(student.display_name)}</b></label>`).join('');
  if (!$('#assignment-students input:checked') && students[0]) $('#assignment-students input').checked = true;
  if (task?.isRecurring) $$('#assignment-students input').forEach(input => { input.disabled = String(input.value) !== String(selectedStudentId); });
  $('#assignment-editor-eyebrow').textContent = task ? '调整学习安排' : '创建学习安排';
  $('#assignment-editor-title').textContent = task ? '修改任务' : '分配任务';
  $('#assignment-submit').textContent = task ? '保存修改' : '确认分配';
  $('#assignment-date-mode-control').hidden = Boolean(task);
  $('#assignment-title').value = task?.title || '';
  $('#assignment-detail').value = task?.detail || '';
  $('#assignment-duration').value = task?.duration || 15;
  $('#assignment-stars').value = task?.stars || 1;
  $('#assignment-feedback').value = task?.feedbackType || 'photo_or_video';
  $('#assignment-review').checked = task ? task.needsReview : true;
  const assignmentDate = task?.date || state.taskDate;
  $('#assignment-single-date').value = assignmentDate;
  $('#assignment-range-start-date').value = task?.availableStartDate || assignmentDate;
  $('#assignment-range-end-date').value = task?.availableEndDate || assignmentDate;
  $('#assignment-start-date').value = '';
  $('#assignment-end-date').value = assignmentDate;
  setRepeatPattern('assignment', 'daily');
  $$('#assignment-weekday-picker input').forEach(input => { input.checked = Number(input.value) === (((parseDate(assignmentDate).getUTCDay() + 6) % 7) + 1); });
  const category = task ? state.categories.find(item => item.name === task.category) : state.categories[0];
  if (category) $('#assignment-category').value = String(category.id);
  syncRepeatDateLimit('assignment');
  $('#assignment-error').textContent = '';
  state.taskResources = (task?.resources || []).map(resource => ({ ...resource, existing: true })); state.removeTaskResource = false; $('#assignment-resource-file').value = ''; renderAssignmentResourcePreview(task);
  renderAssignmentCategoryIcon();
  setAssignmentDateMode(task?.isDateRange ? 'range' : 'single');
  const seriesNote = $('#assignment-series-edit-note');
  if (task?.isRecurring) {
    seriesNote.style.cssText = '';
    $('#assignment-single-date-wrap').hidden = true; $('#assignment-single-date').required = false; $('#assignment-range-fields').hidden = true; $('#assignment-range-start-date').required = false; $('#assignment-range-end-date').required = false; $('#assignment-repeat-fields').hidden = true; $('#assignment-end-date').required = false;
    seriesNote.hidden = false; seriesNote.innerHTML = `${icon('repeat-2')}<div><b>${escapeHtml(recurringLabel(task))}</b><span>${escapeHtml(task.seriesStartDate)} 至 ${escapeHtml(task.seriesEndDate)}；保存时默认修改整个系列。</span></div>`;
  } else {
    seriesNote.style.cssText = task ? 'display:block;margin-top:8px;padding:0;border:0;border-radius:0;background:transparent;color:var(--muted);font-size:12px;line-height:1.5' : '';
    seriesNote.hidden = !task;
    if (task) {
      const dateRule = task.isDateRange
        ? '可调整起止日期，学生可提前开始。'
        : '可调整任务日期，不影响学习进度和资料。';
      seriesNote.textContent = dateRule;
    }
  }
  setParentPage('assignment-editor');
  refreshIcons();
}
function openCategoryForm(category = null) {
  $('#category-id').value = category?.id || '';
  $('#category-name').value = category?.name || '';
  state.selectedCategoryIcon = isCategoryIcon(category?.icon) ? category.icon : categoryIcons[0][0];
  $('#category-icon-options').innerHTML = categoryIcons.map(([path, label]) => `<button type="button" class="icon-option ${path === state.selectedCategoryIcon ? 'selected' : ''}" data-category-icon="${path}" title="${label}" aria-label="${label}" aria-pressed="${path === state.selectedCategoryIcon}"><img src="${path}" alt="" /></button>`).join('');
  $('#category-dialog-title').textContent = category ? '修改分类' : '新增分类';
  $('#category-submit').textContent = category ? '保存修改' : '创建分类';
  $('#category-error').textContent = '';
  $('#category-dialog').showModal();
}
async function loadParentPageData(page) {
  if (page === 'overview') return ensurePageData(`overview:${state.dashboardStudentId || 'default'}`, () => loadParent(), 15000);
  if (page === 'parents' && state.user?.role === 'admin') return ensurePageData('parents', loadParents);
  if (page === 'students') return ensurePageData('students', loadStudents);
  if (page === 'assign') {
    await Promise.all([ensurePageData('students', loadStudents), ensurePageData('categories', loadCategories)]);
    state.taskDate ||= today();
    renderTaskFilters(); renderTaskWeek();
    return ensurePageData(`parent-tasks:${state.taskDate}:${state.taskStudentId || 'all'}`, loadParentTasks, 10000);
  }
  if (page === 'templates') {
    await ensurePageData('categories', loadCategories);
    return ensurePageData('templates', loadTaskTemplates);
  }
  if (page === 'reading') return ensurePageData('parent-reading', loadParentReading, 15000);
  if (page === 'categories' && state.user?.role === 'admin') return ensurePageData('categories', loadCategories);
  if (page === 'review') return ensurePageData('reviews', loadReviews, 15000);
  if (page === 'reward-applications') return ensurePageData('reward-applications', loadRewardApplications, 5000);
  if (page === 'stats') {
    $('#stats-start-date').value ||= startOfWeek(today()); $('#stats-end-date').value ||= today();
    const range = state.statsPeriod === 'custom' ? `${$('#stats-start-date').value}:${$('#stats-end-date').value}` : state.statsPeriod;
    return ensurePageData(`stats:${range}`, () => loadStatistics(state.statsPeriod), 15000);
  }
}
async function startSession(user) {
  state.user = user; state.studentDate = today(); state.dashboardStudentId = null; state.studentDashboardCache.clear(); state.studentTaskListCache.clear(); state.parentTaskCache.clear(); state.pageLoads.clear(); state.pageLoadedAt.clear(); state.studentLoadController?.abort(); state.studentLoadController = null; state.parentTaskLoadController?.abort(); state.parentTaskLoadController = null; displayApp();
  const student = user.role === 'student';
  $('#app-shell').classList.toggle('student-mode', student);
  $('#app-shell').classList.toggle('parent-mode', !student);
  $('.student-sidebar').classList.toggle('hidden', !student); $('.parent-sidebar').classList.toggle('hidden', student);
  $$('.admin-only').forEach(element => element.classList.toggle('hidden', user.role !== 'admin'));
  $('#students-page-title').textContent = user.role === 'admin' ? '全部学生' : '我的孩子';
  $('#stats .eyebrow').textContent = user.role === 'admin' ? '全部学生' : '我的孩子';
  $('#session-role').innerHTML = `${icon(student ? 'graduation-cap' : user.role === 'admin' ? 'shield-check' : 'users-round')}<span class="role-label">${student ? '学生端' : user.role === 'admin' ? '管理员端' : '家长端'}</span>`;
  $('.main-content').style.marginLeft = student && innerWidth >= 768 ? '96px' : !student && innerWidth >= 768 ? '216px' : '0';
  $('.bottom-nav').style.display = student && innerWidth < 768 ? 'grid' : 'none';
  if (student) {
    try { state.categories = (await api('/api/student/categories', { silent: true })).categories || []; } catch {}
    setStudentPage('today');
    await loadStudent();
    state.pageLoadedAt.set(`student-dashboard:${state.studentDate}`, Date.now());
    loadInBackground(`student-tasks:${state.studentTaskFilter}`, () => loadStudentTaskList(state.studentTaskFilter, { silent: true }));
    ['todo', 'future', 'pending_review', 'completed'].filter(filter => filter !== state.studentTaskFilter).forEach(filter => {
      loadInBackground(`student-tasks:${filter}`, () => loadStudentTaskList(filter, { silent: true, activate: false }), 300000);
    });
  } else {
    setParentPage('overview');
    await loadParent();
    state.pageLoadedAt.set('overview:default', Date.now());
    state.taskDate = today(); state.taskStudentId = state.parent?.selectedStudentId || 'all';
    loadInBackground('students', loadStudents);
    loadInBackground('categories', loadCategories);
    loadInBackground('reviews', loadReviews, 15000);
    if (user.role === 'admin') loadInBackground('parents', loadParents);
    ensurePageData('categories', loadCategories).then(() => loadInBackground('templates', loadTaskTemplates)).catch(error => showToast(error.message));
  }
  refreshIcons();
  if (user.mustChangePassword) $('#password-dialog').showModal();
}
function taskResourceMarkup(task, title = '任务资料') {
  if (!task.hasResource) return '';
  const resources = task.resources?.length ? task.resources : [{ name: task.resourceName, kind: task.resourceKind, data: task.resourceData }];
  return `<section class="task-resource-section"><h3>${escapeHtml(title)} <small>${resources.length} 个文件</small></h3><div class="task-resource-list">${resources.map((resource, index) => {
    const kind = resourceKindOf(resource);
    const name = resource.name || (kind === 'video' ? '任务视频' : kind === 'audio' ? '任务语音' : kind === 'image' ? '任务图片' : '任务文件');
    const media = kind === 'image' ? `<img src="${escapeHtml(resource.data)}" alt="${escapeHtml(name)}预览" />` : kind === 'audio' ? `<audio src="${escapeHtml(resource.data)}" controls preload="metadata" aria-label="${escapeHtml(name)}"></audio>` : kind === 'video' ? `<video src="${escapeHtml(resource.data)}" controls preload="metadata" aria-label="${escapeHtml(name)}"></video>` : `<span class="resource-file-icon">${icon('file')}</span>`;
    const preview = kind === 'file' ? '' : `<button type="button" class="resource-action-button" data-preview-task-resource="${index}">${icon('eye')}<span>预览</span></button>`;
    const download = resource.data ? `<a class="resource-action-button resource-download-button" href="${escapeHtml(resource.data)}" download="${escapeHtml(name)}">${icon('download')}<span>下载</span></a>` : '';
    return `<article class="task-resource-card">${media}<span class="task-resource-copy"><b>${escapeHtml(name)}</b><small>${kind === 'video' ? '视频资料·可播放' : kind === 'audio' ? '语音资料·可播放' : kind === 'image' ? '图片资料' : '学习文件'}</small></span><span class="task-resource-actions">${preview}${download}</span></article>`;
  }).join('')}</div></section>`;
}
function syncStudentTask(task) {
  const dayIndex = state.tasks.findIndex(item => item.id === task.id); if (dayIndex >= 0) state.tasks[dayIndex] = task;
  const listIndex = state.studentListTasks.findIndex(item => item.id === task.id); if (listIndex >= 0) state.studentListTasks[listIndex] = task;
  if (dayIndex >= 0) renderStudent({ ...state.student, tasks: state.tasks });
  if (listIndex >= 0) renderStudentTaskList();
}
function taskDetailStatus(task) { return (statusMeta[task.status] || statusMeta.not_started)[1]; }
function feedbackTypeLabel(type) { return ({ photo_or_video: '图片或视频', optional_photo_or_video: '图片或视频（选填）', photo: '仅图片', video: '仅视频', none: '无需反馈' })[type] || '图片或视频'; }
function taskDetailFacts(task, includeStudent = false) {
  const schedule = task.isRecurring ? `<p class="task-schedule-fact"><b>重复规则</b>${escapeHtml(recurringLabel(task))} · ${escapeHtml(task.seriesStartDate)} 至 ${escapeHtml(task.seriesEndDate)}</p>` : task.isDateRange ? `<p class="task-schedule-fact"><b>完成期限</b>${escapeHtml(task.availableStartDate)} 至 ${escapeHtml(task.availableEndDate)}，可提前开始，需在结束日期前完成</p>` : '';
  return `<div class="review-task-details task-detail-facts">${includeStudent ? `<p><b>学生</b>${escapeHtml(task.studentName || '未知学生')}</p>` : ''}<p><b>${task.isDateRange ? '截止日期' : '任务日期'}</b>${escapeHtml(task.date)}</p><p><b>当前状态</b>${escapeHtml(taskDetailStatus(task))}</p><p><b>预计时长</b>${task.duration || 0} 分钟</p><p><b>奖励星星</b>${task.stars || 0} 颗</p><p class="task-detail-feedback-fact"><b>反馈与审核</b>${feedbackTypeLabel(task.feedbackType)} · ${task.needsReview ? '需要家长审核' : '无需审核'}</p>${schedule}<p class="task-detail-description"><b>任务说明</b>${multilineText(task.detail, '暂无任务说明')}</p></div>`;
}
function taskFeedbackEvidence(task) {
  if (!task.hasFeedback) return '';
  const name = task.feedbackName || (task.feedbackKind === 'video' ? '学生提交的视频' : '学生提交的图片');
  const media = task.feedbackData ? `<div class="review-evidence">${task.feedbackKind === 'video' ? '<span class="video-placeholder">▶</span>' : `<img src="${escapeHtml(task.feedbackData)}" alt="学生上传的任务反馈" />`}<span class="review-evidence-copy"><b>${escapeHtml(name)}</b><small>学生提交的学习反馈</small></span><span class="review-evidence-actions"><button type="button" class="resource-action-button" data-preview-parent-feedback>${icon('eye')}<span>预览</span></button><a class="resource-action-button resource-download-button" href="${escapeHtml(task.feedbackData)}" download="${escapeHtml(name)}">${icon('download')}<span>下载</span></a></span></div>` : '';
  return `<section class="task-detail-feedback"><h3>学生反馈</h3>${media}${task.feedbackNote ? `<p class="feedback-note">${escapeHtml(task.feedbackNote)}</p>` : ''}</section>`;
}
function showDetailLoading(title = '正在读取详情') {
  $('#task-detail-modal-content').innerHTML = `<div class="modal-content"><h2>${escapeHtml(title)}</h2><div class="detail-loading" role="status"><div class="loader-orbit"><span class="loader-star">★</span><i></i><i></i><i></i></div><p>正在整理完整信息…</p></div></div>`;
  if (!$('#task-detail-dialog').open) $('#task-detail-dialog').showModal();
}
async function openStudentTaskDetail(taskId) {
  const summary = state.tasks.find(task => task.id === taskId) || state.studentListTasks.find(task => task.id === taskId);
  showDetailLoading(summary?.title);
  try {
    const task = (await api(`/api/student/tasks/${taskId}`, { silent: true })).task;
    syncStudentTask(task); state.activeTaskDetail = task;
    const canWork = ['not_started', 'in_progress', 'needs_more'].includes(task.status) && rangeCanBeWorkedOn(task);
    const [, , action] = statusMeta[task.status] || statusMeta.not_started;
    const resultNote = task.status === 'completed' && task.encouragement ? `<p class="feedback-note"><b>家长鼓励</b>${escapeHtml(task.encouragement)}</p>` : '';
    $('#task-detail-modal-content').innerHTML = `<div class="modal-content"><p class="eyebrow task-dialog-category">${categoryIconMarkup(task.icon)} ${escapeHtml(task.category)}</p><h2>${escapeHtml(task.title)}</h2>${taskDetailFacts(task)}${taskResourceMarkup(task)}${resultNote}${canWork ? `<div class="modal-actions"><button class="primary-button" data-start-task="${task.id}">${action}</button></div>` : ''}</div>`;
    refreshIcons();
  } catch (err) { $('#task-detail-dialog').close(); showToast(err.message); }
}
async function openParentTaskDetail(taskId) {
  const summary = state.parentTasks.find(task => task.id === taskId) || state.reviews.find(task => task.id === taskId);
  showDetailLoading(summary?.title);
  try {
    const task = (await api(`/api/parent/tasks/${taskId}`, { silent: true })).task;
    state.activeTaskDetail = task;
    const resultNote = task.encouragement ? `<p class="feedback-note"><b>家长反馈</b>${escapeHtml(task.encouragement)}</p>` : '';
    $('#task-detail-modal-content').innerHTML = `<div class="modal-content"><p class="eyebrow task-dialog-category">${categoryIconMarkup(task.icon)} ${escapeHtml(task.category)}</p><h2>${escapeHtml(task.title)}</h2>${taskDetailFacts(task, true)}${taskResourceMarkup(task)}${taskFeedbackEvidence(task)}${resultNote}${task.status === 'pending_review' ? `<div class="modal-actions"><button class="primary-button" data-review="${task.id}">进入审核</button></div>` : ''}</div>`;
    refreshIcons();
  } catch (err) { $('#task-detail-dialog').close(); showToast(err.message); }
}
async function openTemplateDetail(templateId, { readOnly = false } = {}) {
  showDetailLoading(state.templates.find(template => template.id === templateId)?.title);
  try {
    const template = (await api(`/api/parent/task-templates/${templateId}`, { silent: true })).template;
    state.activeTaskDetail = template;
    const actions = template.isOwner && !readOnly ? `<button class="secondary-button" data-edit-template="${template.id}">${icon('pencil')} 编辑</button><button class="primary-button danger-button" data-delete-template="${template.id}">${icon('trash')} 删除</button>` : '';
    $('#task-detail-modal-content').innerHTML = `<div class="modal-content"><p class="eyebrow task-dialog-category">${categoryIconMarkup(template.icon)} ${escapeHtml(template.category)}</p><h2>${escapeHtml(template.title)}</h2><div class="review-task-details task-detail-facts template-detail-facts"><p><b>创建人</b>${escapeHtml(template.creatorName)}</p><p><b>开放范围</b>${escapeHtml(templateVisibility(template))}</p><p><b>预计时长</b>${template.duration} 分钟</p><p><b>奖励星星</b>${template.stars} 颗</p><p><b>反馈与审核</b>${feedbackTypeLabel(template.feedbackType)} · ${template.needsReview ? '需要审核' : '无需审核'}</p><p><b>任务说明</b>${multilineText(template.detail, '暂无任务说明')}</p></div>${taskResourceMarkup(template)}${actions ? `<div class="modal-actions">${actions}</div>` : ''}</div>`;
    refreshIcons();
  } catch (err) { $('#task-detail-dialog').close(); showToast(err.message); }
}
async function openTask(task) {
  try {
    if (task.status === 'not_started') task = (await api(`/api/student/tasks/${task.id}/draft`, { method: 'PATCH', body: '{}' })).task;
    else task = (await api(`/api/student/tasks/${task.id}`)).task;
    syncStudentTask(task);
  } catch (err) { showToast(err.message); return; }
  state.activeTaskDetail = task;
  const [, , action] = statusMeta[task.status] || statusMeta.not_started;
  state.taskFeedbackData = task.feedbackData || ''; state.taskFeedbackName = task.feedbackName || '';
  const readonly = ['completed', 'pending_review'].includes(task.status);
  const accept = task.feedbackType === 'photo' ? 'image/*' : task.feedbackType === 'video' ? 'video/mp4,video/webm' : 'image/*,video/mp4,video/webm';
  const savedPreview = task.feedbackData ? (task.feedbackKind === 'video' ? `<video src="${task.feedbackData}" controls></video><b>${escapeHtml(task.feedbackName || '已保存的视频')}</b>` : `<img src="${task.feedbackData}" alt="已保存的反馈图片" /><b>${escapeHtml(task.feedbackName || '已保存的图片')}</b>`) : '<span>尚未选择反馈文件</span>';
  const optionalFeedback = task.feedbackType === 'optional_photo_or_video';
  const feedback = task.feedbackType === 'none' ? `<div class="no-feedback-note">此任务不需要上传反馈，完成后直接提交即可。</div><label class="task-note-label">补充说明<textarea id="task-feedback-note" maxlength="300" placeholder="可以写下完成过程或心得（选填）">${escapeHtml(task.feedbackNote)}</textarea></label>` : `<div class="task-feedback-upload file-drop-zone" data-file-drop-target="task-feedback-file"><input id="task-feedback-file" type="file" accept="${accept}" hidden /><div class="feedback-drop-copy">${icon('upload-cloud')}<span>${optionalFeedback ? '' : '<b class="required-mark" aria-hidden="true">*</b>'}拖拽图片或视频到这里${optionalFeedback ? '（选填）' : ''}</span></div><button type="button" class="secondary-button" id="pick-task-feedback">选择图片或视频</button><div id="task-feedback-preview">${savedPreview}</div><label>补充说明<textarea id="task-feedback-note" maxlength="300" placeholder="可以写下完成过程或心得（选填）">${escapeHtml(task.feedbackNote)}</textarea></label></div>`;
  $('#task-modal-content').innerHTML = `<div class="modal-content"><p class="eyebrow task-dialog-category">${categoryIconMarkup(task.icon)} ${escapeHtml(task.category)}</p><h2>${escapeHtml(task.title)}</h2><p class="task-detail-description">${multilineText(task.detail, '暂无任务说明')}</p>${taskResourceMarkup(task)}<div class="modal-summary"><p>预计 ${task.duration || 15} 分钟</p><p>完成后可获得 ⭐ ${task.stars} 颗星星</p><p>${task.feedbackType === 'none' ? '不需要提交反馈' : optionalFeedback ? '可选提交学习反馈' : '需要提交学习反馈'}</p></div>${readonly ? `<div class="no-feedback-note">${task.status === 'completed' ? '该任务已经完成。' : '反馈已提交，正在等待家长审核。'}</div>` : `${feedback}<p class="login-error" id="task-submit-error"></p><div class="modal-actions"><button class="secondary-button" id="save-draft">保存草稿</button><button class="primary-button" data-submit-task="${task.id}">${action === '补充反馈' ? '确认补充' : '确认提交'}</button></div>`}</div>`;
  $('#task-detail-dialog').close(); $('#task-dialog').showModal();
  decorateRequiredFields($('#task-dialog'));
  refreshIcons();
}
function openReview(task) {
  const feedbackName = task.feedbackName || (task.feedbackKind === 'video' ? '学生提交的视频' : '学生提交的图片');
  const feedback = task.feedbackData
    ? `<div class="review-evidence">${task.feedbackKind === 'video' ? '<span class="video-placeholder">▶</span>' : `<img src="${escapeHtml(task.feedbackData)}" alt="学生上传的任务反馈" />`}<span class="review-evidence-copy"><b>${escapeHtml(feedbackName)}</b><small>学生提交的学习反馈</small></span><span class="review-evidence-actions"><button type="button" class="resource-action-button" data-preview-feedback="${task.id}">${icon('eye')}<span>预览</span></button><a class="resource-action-button resource-download-button" href="${escapeHtml(task.feedbackData)}" download="${escapeHtml(feedbackName)}">${icon('download')}<span>下载</span></a></span></div>`
    : `<div class="no-feedback-note">${task.feedbackType === 'none' ? '此任务不需要提交图片或视频反馈。' : task.feedbackType === 'optional_photo_or_video' ? '学生未提交图片或视频反馈。' : '当前没有可预览的附件，可以要求学生补充反馈。'}</div>`;
  $('#review-modal-content').innerHTML = `<div class="modal-content review-modal"><p class="eyebrow">${escapeHtml(task.studentName)} · ${escapeHtml(task.category)}</p><h2>${escapeHtml(task.title)}</h2><div class="review-task-details"><p><b>${task.isDateRange ? '完成期限' : '任务日期'}</b>${escapeHtml(task.isDateRange ? `${task.availableStartDate} 至 ${task.availableEndDate}` : task.date)}</p><p><b>预计时长</b>${task.duration || 0} 分钟</p><p><b>任务要求</b>${multilineText(task.detail, '暂无任务说明')}</p><p><b>提交时间</b>${formatDateTime(task.submittedAt)}</p></div>${taskResourceMarkup(task)}${feedback}${task.feedbackNote ? `<p class="feedback-note"><b>学生说明</b>${multilineText(task.feedbackNote)}</p>` : ''}<div class="review-reward-form"><label>奖励星星<span class="number-with-unit"><input id="review-stars" type="number" min="1" step="1" value="${task.stars}" required /><b>颗</b></span></label><label>鼓励或补充说明<textarea id="review-message" maxlength="180" placeholder="写一句鼓励，或说明需要补充的内容">完成得很棒！</textarea></label></div><p class="login-error" id="review-error"></p><div class="review-actions"><button class="supplement" data-more="${task.id}">需要补充</button><button class="primary-button" data-approve="${task.id}">✓ 通过并奖励</button></div></div>`;
  $('#review-dialog').showModal();
  decorateRequiredFields($('#review-dialog'));
  refreshIcons();
}
function closeDialogs() { $$('dialog[open]').forEach(dialog => dialog.close()); }
function openStudentForm(student = null) {
  state.activeStudentId = student?.id || null;
  $('#student-form-eyebrow').textContent = student ? '编辑学生资料' : '学生管理';
  $('#student-form-title').textContent = student ? '编辑学生' : '新增学生';
  $('#student-submit').textContent = student ? '保存修改' : '创建学生';
  $('#student-id').value = student?.id || '';
  $('#student-name').value = student?.display_name || '';
  state.studentAvatar = student?.avatar || '';
  $('#student-avatar').value = '';
  $('#student-avatar').required = false;
  setAvatar($('#student-avatar-preview'), state.studentAvatar, lastCharacter(student?.display_name, '学'));
  $('#student-grade').value = student?.grade || '三年级';
  $('#student-note').value = student?.note || '';
  $('#student-username').value = student?.username || '';
  $('#student-initial-password').value = '';
  $('#student-account-fields').hidden = false;
  $('#student-username').readOnly = Boolean(student);
  $('#student-username-note').textContent = student ? '账号创建后不可修改' : '必填，创建后不可修改';
  $('#student-username').required = true;
  $('#student-password-field').hidden = Boolean(student);
  $('#student-parent-picker').hidden = Boolean(student) || state.user.role !== 'admin';
  $('#student-initial-password').required = !student;
  $('#student-parent-options').innerHTML = state.parents.map(parent => `<label class="parent-choice"><input type="checkbox" value="${parent.id}" /><span class="student-avatar">${avatarMarkup(parent.avatar, lastCharacter(parent.displayName))}</span><span><b>${escapeHtml(parent.displayName)}</b><small>用户名：${escapeHtml(parent.username)}${parent.active ? '' : ' · 已禁用'}</small></span></label>`).join('') || '<p class="parent-picker-empty">暂无家长账号，可稍后关联。</p>';
  $('#student-form-error').textContent = '';
  $('#student-dialog').showModal();
}
function openParentForm(parent = null) {
  state.activeParentId = parent?.id || null;
  $('#parent-dialog-title').textContent = parent ? '修改家长信息' : '新增家长';
  $('#parent-submit').textContent = parent ? '保存修改' : '创建家长';
  $('#parent-id').value = parent?.id || '';
  $('#parent-name').value = parent?.displayName || '';
  $('#parent-username').value = parent?.username || '';
  $('#parent-username').readOnly = Boolean(parent);
  $('#parent-username-note').textContent = parent ? '账号创建后不可修改' : '必填，创建后不可修改';
  state.parentAvatar = parent?.avatar || '';
  $('#parent-avatar').value = '';
  $('#parent-avatar').required = false;
  setAvatar($('#parent-avatar-preview'), state.parentAvatar, lastCharacter(parent?.displayName));
  $('#parent-password-field').hidden = Boolean(parent);
  $('#parent-password').required = !parent;
  $('#parent-password').value = '';
  $('#parent-form-error').textContent = '';
  $('#parent-dialog').showModal();
}
function fillParentSelect(select, student) {
  const linked = new Set(student.parents?.map(parent => parent.id) || []);
  select.innerHTML = state.parents.filter(parent => !linked.has(parent.id)).map(parent => `<option value="${parent.id}">${escapeHtml(parent.displayName)} (@${escapeHtml(parent.username)})${parent.active ? '' : '（已禁用）'}</option>`).join('');
}
function closeStudentActionMenu() {
  const menu = $('#student-action-menu');
  menu.hidden = true;
  $$('[data-student-actions]').forEach(button => button.setAttribute('aria-expanded', 'false'));
}
function openStudentActions(student, anchor) {
  state.activeStudentId = student.id;
  const menu = $('#student-action-menu');
  menu.dataset.studentId = String(student.id);
  const toggle = $('#toggle-student-status-action');
  toggle.classList.toggle('danger', student.active);
  toggle.querySelector('svg, i').outerHTML = icon(student.active ? 'user-round-x' : 'user-round-check');
  toggle.querySelector('b').textContent = student.active ? '禁用用户' : '启用用户';
  menu.hidden = false;
  anchor.setAttribute('aria-expanded', 'true');
  const rect = anchor.getBoundingClientRect();
  const left = Math.min(window.innerWidth - menu.offsetWidth - 12, Math.max(12, rect.right - menu.offsetWidth));
  const below = rect.bottom + 6;
  menu.style.left = `${left}px`;
  menu.style.top = `${below + menu.offsetHeight <= window.innerHeight - 12 ? below : rect.top - menu.offsetHeight - 6}px`;
  refreshIcons();
}

['#student-grade', '#template-feedback', '#assignment-feedback'].forEach(selector => { const field = $(selector); if (field) field.required = true; });
decorateRequiredFields();
enhancePasswordInputs();
$$('dialog').forEach(dialog => dialog.addEventListener('close', () => resetPasswordVisibility(dialog)));
document.addEventListener('dragover', event => {
  const zone = dropZoneFromEvent(event); if (!zone || !dropZoneInput(zone)) return;
  event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; zone.classList.add('is-dragging');
});
document.addEventListener('dragleave', event => {
  const zone = dropZoneFromEvent(event); if (!zone || zone.contains(event.relatedTarget)) return;
  zone.classList.remove('is-dragging');
});
document.addEventListener('drop', event => {
  const zone = dropZoneFromEvent(event); const input = dropZoneInput(zone); if (!zone || !input) return;
  event.preventDefault(); zone.classList.remove('is-dragging');
  const files = [...event.dataTransfer.files]; if (!files.length) return;
  const transfer = new DataTransfer(); files.forEach(file => transfer.items.add(file)); input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
});

$('#login-form').addEventListener('submit', async event => {
  event.preventDefault(); const error = $('#login-error'); error.textContent = '';
  const submit = $('.login-submit'); submit.disabled = true; submit.textContent = '正在验证…';
  try { const result = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ role: state.role, username: $('#username').value, password: $('#password').value, captchaId: state.captchaId, captcha: $('#captcha').value, rememberMe: matchMedia('(min-width: 768px)').matches }) }); await startSession(result.user); }
  catch (err) { error.textContent = err.message; await refreshCaptcha(); }
  finally { submit.disabled = false; submit.innerHTML = `<span id="login-submit-label">${state.role === 'student' ? '进入我的任务' : '进入家长首页'}</span> <b>→</b>`; }
});
document.addEventListener('click', async event => {
  const passwordToggle = event.target.closest('[data-password-toggle]');
  if (passwordToggle) {
    const input = passwordToggle.closest('.password-input-wrap')?.querySelector('input');
    if (input) {
      const visible = input.type === 'text';
      input.type = visible ? 'password' : 'text';
      passwordToggle.innerHTML = icon(visible ? 'eye' : 'eye-off');
      passwordToggle.setAttribute('aria-label', visible ? '显示密码' : '隐藏密码');
      passwordToggle.title = visible ? '显示密码' : '隐藏密码';
      refreshIcons();
    }
    return;
  }
  if (!event.target.closest('#account-menu') && !event.target.closest('#account-security-button')) $('#account-menu').hidden = true;
  if (!$('#student-action-menu').hidden && !event.target.closest('#student-action-menu') && !event.target.closest('[data-student-actions]')) closeStudentActionMenu();
  if (event.target.closest('#parent-mobile-menu-button')) { const open = !$('#app-shell').classList.contains('mobile-menu-open'); $('#app-shell').classList.toggle('mobile-menu-open', open); $('#parent-mobile-menu-button').setAttribute('aria-expanded', String(open)); $('#parent-sidebar-backdrop').hidden = !open; return; }
  if (event.target.closest('#parent-sidebar-backdrop')) { closeParentMobileMenu(); return; }
  const loginRole = event.target.closest('[data-login-role]'); if (loginRole) { setLoginRole(loginRole.dataset.loginRole); return; }
  if (event.target.closest('#refresh-captcha')) { await refreshCaptcha(); return; }
  if (event.target.closest('#open-recovery')) { $('#recovery-form').reset(); $('#recovery-reset-fields').hidden = true; $('#recovery-error').textContent = ''; $('#recovery-dialog').showModal(); return; }
  if (event.target.closest('#account-security-button')) { const menu = $('#account-menu'); menu.hidden = !menu.hidden; refreshIcons(); return; }
  if (event.target.id === 'open-account-password') { $('#account-menu').hidden = true; $('#account-password-form').reset(); $('#account-password-error').textContent = ''; $('#account-security-dialog').showModal(); return; }
  if (event.target.id === 'open-account-email') { $('#account-menu').hidden = true; restoreRecoveryEmailTimer(); $('#recovery-email-form').reset(); $('#recovery-email-form').hidden = false; $('#recovery-email-code-wrap').hidden = true; $('#recovery-email-message').textContent = ''; try { const data = await api('/api/auth/recovery-email', { silent: true }); $('#bound-email-status').textContent = data.email ? `当前已绑定：${data.email}` : '尚未绑定找回邮箱'; } catch (err) { $('#bound-email-status').textContent = err.message; } $('#email-settings-dialog').showModal(); return; }
  if (event.target.closest('#logout-button')) { $('#logout-dialog').showModal(); return; }
  if (event.target.id === 'confirm-logout') { try { await api('/api/auth/logout', { method: 'POST' }); } finally { closeDialogs(); closeStudentActionMenu(); state.user = null; $('#username').value = ''; $('#password').value = ''; setLoginRole('student'); displayLogin(); await refreshCaptcha(); } return; }
  const dialogClose = event.target.closest('.modal-close, .dialog-cancel'); if (dialogClose) { dialogClose.closest('dialog')?.close(); return; }
  if (event.target.id === 'modal-close-done') { closeDialogs(); return; }
  if (event.target.closest('.feedback-option')) { $$('.feedback-option').forEach(item => item.classList.remove('selected')); event.target.closest('.feedback-option').classList.add('selected'); return; }
  const studentNav = event.target.closest('[data-page]'); if (studentNav && state.user?.role === 'student') { const page = studentNav.dataset.page; setStudentPage(page); if (page === 'today') loadInBackground(`student-dashboard:${state.studentDate}`, () => loadStudent()); if (page === 'tasks') loadStudentTaskList(state.studentTaskFilter, { silent: true }).catch(error => showToast(error.message)); if (page === 'reading') loadStudentReading(state.readingDate || today().slice(0, 7)).catch(error => showToast(error.message)); if (page === 'reward-applications') loadRewardApplications().catch(error => showToast(error.message)); return; }
  if (event.target.closest('[data-overview-task-link]') && state.user?.role !== 'student') { state.taskDate = today(); state.taskStudentId = state.dashboardStudentId || state.parent?.selectedStudentId || 'all'; setParentPage('assign'); try { await Promise.all([loadStudents(), loadCategories()]); renderTaskFilters(); renderTaskWeek(); await loadParentTasks({ force: true }); } catch (err) { showToast(err.message); } return; }
  const parentNav = event.target.closest('[data-parent-page]'); if (parentNav && state.user && state.user.role !== 'student') { const page = parentNav.dataset.parentPage; if ((page === 'parents' || page === 'categories') && state.user.role !== 'admin') return; setParentPage(page); closeParentMobileMenu(); loadParentPageData(page).catch(error => showToast(error.message)); return; }
  if (event.target.id === 'open-assignment') { openAssignmentEditor(); return; }
  if (event.target.closest('#open-template-assignment')) { await openTemplateAssignment(); return; }
  if (event.target.closest('#add-task-template')) { openTemplateEditor(); return; }
  if (event.target.closest('#add-reward-application')) { try { await openRewardApplicationForm(); } catch (err) { showToast(err.message); } return; }
  if (event.target.closest('#pick-reward-application-files')) { $('#reward-application-files').click(); return; }
  const removeRewardApplicationResource = event.target.closest('[data-remove-reward-application-resource]'); if (removeRewardApplicationResource) { state.rewardApplicationResources.splice(Number(removeRewardApplicationResource.dataset.removeRewardApplicationResource), 1); state.rewardApplicationResourcesChanged = true; $('#reward-application-files').value = ''; renderRewardApplicationResources(); return; }
  const rewardDetail = event.target.closest('[data-reward-detail]'); if (rewardDetail) { const item = state.rewardApplications.find(x => x.id === Number(rewardDetail.dataset.rewardDetail)); if (item) { const data = await api(`/api/student/reward-applications/${item.id}`); openRewardApplicationDetail(data.application); } return; }
  const rewardReview = event.target.closest('[data-reward-review]'); if (rewardReview) { const item = state.rewardApplications.find(x => x.id === Number(rewardReview.dataset.rewardReview)); if (item) { const data = await api(`/api/parent/reward-applications/${item.id}`); openRewardReview(data.application); } return; }
  const rewardReviewAction = event.target.closest('[data-reward-review-action]'); if (rewardReviewAction) { const item = state.rewardApplications.find(x => x.id === Number(rewardReviewAction.dataset.rewardReviewAction)); if (item) { const data = await api(`/api/parent/reward-applications/${item.id}`); openRewardReview(data.application); } return; }
  const editReward = event.target.closest('[data-edit-reward]'); if (editReward) { const item = state.rewardApplications.find(x => x.id === Number(editReward.dataset.editReward)); $('#reward-application-detail-dialog').close(); if (item) { try { const data = await api(`/api/student/reward-applications/${item.id}`); await openRewardApplicationForm(data.application); } catch (err) { showToast(err.message); } } return; }
  const deleteReward = event.target.closest('[data-delete-reward]'); if (deleteReward) { try { await api(`/api/student/reward-applications/${deleteReward.dataset.deleteReward}`, { method: 'DELETE' }); $('#reward-application-detail-dialog').close(); await loadRewardApplications(); showToast('奖励申请已删除'); } catch (err) { showToast(err.message); } return; }
  const rewardApprove = event.target.closest('[data-reward-approve]'); if (rewardApprove) { const error = $('#reward-review-error'); try { await api(`/api/parent/reward-applications/${rewardApprove.dataset.rewardApprove}/review`, { method: 'POST', body: JSON.stringify({ action: 'approve', stars: Number($('#reward-review-stars').value), message: $('#reward-review-message').value }) }); $('#reward-review-dialog').close(); await loadReviews(); showToast('奖励申请已通过'); } catch (err) { error.textContent = err.message; } return; }
  const rewardReject = event.target.closest('[data-reward-reject]'); if (rewardReject) { const error = $('#reward-review-error'); try { await api(`/api/parent/reward-applications/${rewardReject.dataset.rewardReject}/review`, { method: 'POST', body: JSON.stringify({ action: 'reject', message: $('#reward-review-message').value }) }); $('#reward-review-dialog').close(); await loadReviews(); showToast('奖励申请已驳回'); } catch (err) { error.textContent = err.message; } return; }
  if (event.target.closest('#add-reading-book')) { openReadingBookForm(); return; }
  if (event.target.closest('#pick-reading-book-cover')) { $('#reading-book-cover').click(); return; }
  if (event.target.closest('[data-remove-reading-book-cover]')) { state.readingCoverData = ''; state.readingCoverName = ''; state.readingCoverExisting = false; $('#reading-book-cover').value = ''; renderReadingBookCoverPreview(); return; }
  const readingTab = event.target.closest('[data-reading-parent-tab]'); if (readingTab) { setParentReadingTab(readingTab.dataset.readingParentTab); return; }
  const editReadingBook = event.target.closest('[data-edit-reading-book]'); if (editReadingBook) { const book = state.readingBooks.find(item => Number(item.id) === Number(editReadingBook.dataset.editReadingBook)); if (book) openReadingBookForm(book); return; }
  const deleteReadingBook = event.target.closest('[data-delete-reading-book]'); if (deleteReadingBook) { const book = state.readingBooks.find(item => Number(item.id) === Number(deleteReadingBook.dataset.deleteReadingBook)); if (book) { state.pendingReadingDelete = { type: 'book', id: book.id }; $('#reading-delete-title').textContent = '删除书籍'; $('#reading-delete-message').textContent = `确定删除《${book.title}》吗？删除后无法恢复。`; $('#reading-delete-dialog').showModal(); } return; }
  if (event.target.closest('#add-reading-plan')) { try { await openReadingPlanForm(); } catch (err) { showToast(err.message); } return; }
  const editReadingPlan = event.target.closest('[data-edit-reading-plan]'); if (editReadingPlan) { const plan = state.readingPlans.find(item => Number(item.id) === Number(editReadingPlan.dataset.editReadingPlan)); if (plan) openReadingPlanForm(plan); return; }
  const deleteReadingPlan = event.target.closest('[data-delete-reading-plan]'); if (deleteReadingPlan) { const plan = state.readingPlans.find(item => Number(item.id) === Number(deleteReadingPlan.dataset.deleteReadingPlan)); if (plan) { state.pendingReadingDelete = { type: 'plan', id: plan.id }; $('#reading-delete-title').textContent = '删除阅读计划'; $('#reading-delete-message').textContent = '删除后，学生将无法继续对该计划打卡；已提交的打卡与审核记录会保留。'; $('#reading-delete-dialog').showModal(); } return; }
  if (event.target.closest('#confirm-reading-delete')) { const pending = state.pendingReadingDelete; if (!pending) return; try { await api(`/api/parent/reading/${pending.type === 'book' ? 'books' : 'plans'}/${pending.id}`, { method: 'DELETE' }); $('#reading-delete-dialog').close(); state.pendingReadingDelete = null; await loadParentReading(); showToast(pending.type === 'book' ? '书籍已删除' : '阅读计划已删除，历史记录已保留'); } catch (err) { showToast(err.message); } return; }
  const readingFrequency = event.target.closest('[data-reading-frequency]'); if (readingFrequency) { setReadingFrequency(readingFrequency.dataset.readingFrequency); return; }
  const readingArrow = event.target.closest('#reading-month-prev, #reading-month-next'); if (readingArrow) { await loadStudentReading(addMonths(state.readingDate || today().slice(0, 7), readingArrow.id === 'reading-month-prev' ? -1 : 1)); return; }
  if (event.target.closest('#reading-month-today')) { await loadStudentReading(today().slice(0, 7)); return; }
  const readingDetail = event.target.closest('[data-reading-detail]'); if (readingDetail && !event.target.closest('[data-reading-checkin]')) { const card = state.readingData?.cards.find(item => Number(item.plan.id) === Number(readingDetail.dataset.readingDetail)); if (card) openReadingDetail(card); return; }
  if (event.target.closest('[data-open-completed-books]')) { openCompletedReadingBooks(); return; }
  const startReadingCheckin = event.target.closest('[data-reading-checkin]'); if (startReadingCheckin) { const card = state.readingData?.cards.find(item => Number(item.plan.id) === Number(startReadingCheckin.dataset.readingCheckin)); if (card) openReadingCheckin(card); return; }
  const readingReview = event.target.closest('[data-reading-review], [data-reading-review-action]'); if (readingReview) { const id = Number(readingReview.dataset.readingReview || readingReview.dataset.readingReviewAction); try { const data = await api(`/api/parent/reading/checkins/${id}`); openReadingReview(data.checkin); } catch (err) { showToast(err.message); } return; }
  const approveReading = event.target.closest('[data-reading-approve]'); if (approveReading) { const error = $('#reading-review-error'); try { await api(`/api/parent/reading/checkins/${approveReading.dataset.readingApprove}/review`, { method: 'POST', body: JSON.stringify({ action: 'approve', stars: Number($('#reading-review-stars').value), endPage: Number($('#reading-review-end-page').value), adjustmentReason: $('#reading-review-adjustment').value, message: $('#reading-review-message').value }) }); $('#reading-review-dialog').close(); await loadReviews(); showToast('阅读打卡已通过'); } catch (err) { error.textContent = err.message; } return; }
  const needsMoreReading = event.target.closest('[data-reading-needs-more]'); if (needsMoreReading) { const error = $('#reading-review-error'); try { await api(`/api/parent/reading/checkins/${needsMoreReading.dataset.readingNeedsMore}/review`, { method: 'POST', body: JSON.stringify({ action: 'needs_more', endPage: Number($('#reading-review-end-page').value), message: $('#reading-review-message').value }) }); $('#reading-review-dialog').close(); await loadReviews(); showToast('已请学生补充阅读打卡'); } catch (err) { error.textContent = err.message; } return; }
  const confirmReadingPlan = event.target.closest('[data-confirm-reading-plan]'); if (confirmReadingPlan) { try { await api(`/api/parent/reading/plans/${confirmReadingPlan.dataset.confirmReadingPlan}/confirm-completion`, { method: 'POST' }); await loadParentReading(); showToast('已确认读完全书'); } catch (err) { showToast(err.message); } return; }
  const copyTemplate = event.target.closest('[data-copy-template]'); if (copyTemplate) { try { const sourceTemplate = (await api(`/api/parent/task-templates/${Number(copyTemplate.dataset.copyTemplate)}?includeData=0`)).template; if (!sourceTemplate?.isOwner) throw new Error('只能复制自己创建的任务模板'); openTemplateEditor({ ...sourceTemplate, id: null, copyMode: true, sourceTemplateId: sourceTemplate.id, title: `${sourceTemplate.title}（复制）`, isPublic: false }); } catch (err) { showToast(err.message); } return; }
  const templateCategoryFilter = event.target.closest('[data-template-category-filter]'); if (templateCategoryFilter) { state.templateCategoryFilter = templateCategoryFilter.dataset.templateCategoryFilter; renderTemplateGroups(); return; }
  if (event.target.closest('#cancel-template-editor, #cancel-template-form')) { await loadTaskTemplates(); setParentPage('templates'); return; }
  if (event.target.closest('#cancel-template-assignment')) { await prepareTaskManager(); setParentPage('assign'); return; }
  const viewTemplate = event.target.closest('[data-view-template]'); if (viewTemplate) { await openTemplateDetail(Number(viewTemplate.dataset.viewTemplate), { readOnly: $('#template-assign').classList.contains('active') }); return; }
  const editTemplate = event.target.closest('[data-edit-template]'); if (editTemplate) { try { const template = (await api(`/api/parent/task-templates/${Number(editTemplate.dataset.editTemplate)}?includeData=0`)).template; if (template?.isOwner) { $('#task-detail-dialog').close(); openTemplateEditor(template); } } catch (err) { showToast(err.message); } return; }
  const deleteTemplate = event.target.closest('[data-delete-template]'); if (deleteTemplate) { state.pendingTemplateId = Number(deleteTemplate.dataset.deleteTemplate); $('#template-delete-dialog').showModal(); return; }
  if (event.target.id === 'confirm-template-delete') { try { await api(`/api/parent/task-templates/${state.pendingTemplateId}`, { method: 'DELETE' }); $('#template-delete-dialog').close(); $('#task-detail-dialog').close(); await loadTaskTemplates(); showToast('任务模板已删除'); } catch (err) { showToast(err.message); } return; }
  if (event.target.closest('#pick-template-resource')) { $('#template-resource-file').click(); return; }
  const removeTemplateResource = event.target.closest('[data-remove-template-resource]'); if (removeTemplateResource) { state.templateResources.splice(Number(removeTemplateResource.dataset.removeTemplateResource), 1); state.removeTemplateResource = true; $('#template-resource-file').value = ''; renderTemplateResourcePreview(); return; }
  const pickerCategory = event.target.closest('[data-template-picker-category]'); if (pickerCategory) { state.templatePickerCategoryId = Number(pickerCategory.dataset.templatePickerCategory); renderTemplatePicker(); return; }
  const templateDateMode = event.target.closest('[data-template-date-mode]'); if (templateDateMode) { setTemplateDateMode(templateDateMode.dataset.templateDateMode); return; }
  if (event.target.closest('#template-assignment-next')) { if (!state.selectedTemplateIds.length) { showToast('请至少选择一个任务模板'); return; } showTemplateAssignmentStep(2); return; }
  if (event.target.closest('#template-assignment-back')) { showTemplateAssignmentStep(1); return; }
  if (event.target.id === 'pick-assignment-resource') { $('#assignment-resource-file').click(); return; }
  const removeTaskResource = event.target.closest('[data-remove-task-resource]'); if (removeTaskResource) { state.taskResources.splice(Number(removeTaskResource.dataset.removeTaskResource), 1); state.removeTaskResource = true; $('#assignment-resource-file').value = ''; renderAssignmentResourcePreview(); return; }
  if (event.target.id === 'back-to-task-list' || event.target.id === 'cancel-assignment') { await prepareTaskManager(); setParentPage('assign'); return; }
  const taskDate = event.target.closest('[data-task-date]'); if (taskDate) { state.taskDate = taskDate.dataset.taskDate; renderTaskWeek(); await loadParentTasks(); return; }
  const taskWeekArrow = event.target.closest('#task-week-prev, #task-week-next'); if (taskWeekArrow) { state.taskDate = addDays(state.taskDate, taskWeekArrow.id === 'task-week-prev' ? -7 : 7); renderTaskWeek(); await loadParentTasks(); return; }
  if (event.target.closest('#task-week-today')) { state.taskDate = today(); renderTaskWeek(); await loadParentTasks(); return; }
  const studentDate = event.target.closest('[data-student-date]'); if (studentDate) { await loadStudent(studentDate.dataset.studentDate); return; }
  const studentWeekArrow = event.target.closest('#student-week-prev, #student-week-next'); if (studentWeekArrow) { await loadStudent(addDays(state.studentDate, studentWeekArrow.id === 'student-week-prev' ? -7 : 7)); return; }
  if (event.target.closest('#student-week-today')) { await loadStudent(today()); return; }
  const studentTaskFilter = event.target.closest('[data-student-task-filter]'); if (studentTaskFilter) { await loadStudentTaskList(studentTaskFilter.dataset.studentTaskFilter); return; }
  const rewardApplicationFilter = event.target.closest('[data-reward-application-filter]'); if (rewardApplicationFilter) { state.rewardApplicationFilter = rewardApplicationFilter.dataset.rewardApplicationFilter; renderRewardApplications(); return; }
  const dateMode = event.target.closest('[data-assignment-date-mode]'); if (dateMode) { setAssignmentDateMode(dateMode.dataset.assignmentDateMode); return; }
  const statsPeriod = event.target.closest('[data-stats-period]'); if (statsPeriod) { const period = statsPeriod.dataset.statsPeriod; state.statsPeriod = period; $('#custom-stats-range').hidden = period !== 'custom'; if (period !== 'custom') await loadStatistics(period); else $$('[data-stats-period]').forEach(button => button.classList.toggle('selected', button === statsPeriod)); return; }
  const editTask = event.target.closest('[data-edit-parent-task]'); if (editTask) { try { const task = (await api(`/api/parent/tasks/${Number(editTask.dataset.editParentTask)}?includeData=0`)).task; openAssignmentEditor(task); } catch (err) { showToast(err.message); } return; }
  const deleteTask = event.target.closest('[data-delete-parent-task]'); if (deleteTask) {
    state.pendingTaskId = Number(deleteTask.dataset.deleteParentTask); state.pendingDeleteTask = state.parentTasks.find(task => task.id === state.pendingTaskId) || null;
    const recurring = Boolean(state.pendingDeleteTask?.isRecurring); const ranged = Boolean(state.pendingDeleteTask?.isDateRange); $('#task-delete-title').textContent = recurring ? '删除当前任务还是整个系列？' : ranged ? '确认删除整个持续日期任务？' : '确认删除这项任务？';
    $('#task-delete-description').textContent = recurring ? '删除整个系列时，已提交待审核和已完成的任务会保留。' : ranged ? `${rangeLabel(state.pendingDeleteTask)}，删除后这段时间内都不再显示该任务。` : '只会删除当前日期下的这条任务，删除后无法恢复。';
    $('#confirm-task-delete').textContent = ranged ? '删除范围任务' : '删除当前任务';
    $('#confirm-task-series-delete').hidden = !recurring; $('#task-delete-dialog').showModal(); return;
  }
  if (event.target.id === 'confirm-task-delete' || event.target.id === 'confirm-task-series-delete') {
    const scope = event.target.id === 'confirm-task-series-delete' ? 'series' : 'current';
    try { const result = await api(`/api/parent/tasks/${state.pendingTaskId}${scope === 'series' ? '?scope=series' : ''}`, { method: 'DELETE' }); $('#task-delete-dialog').close(); invalidateStudentDashboardCache(); await loadParentTasks({ force: true }); showToast(scope === 'series' ? `已删除系列中的 ${result.deletedCount} 条任务${result.skippedCount ? `，保留 ${result.skippedCount} 条待审核或已完成任务` : ''}` : '已删除当前任务'); } catch (err) { showToast(err.message); } return;
  }
  if (event.target.id === 'confirm-task-series-update') {
    const pending = state.pendingTaskUpdate; if (!pending) return;
    try { $('#task-series-update-dialog').close(); await persistAssignment(pending.payload, pending.focusDate); } catch (err) { $('#assignment-error').textContent = err.message; } return;
  }
  if (event.target.id === 'add-category') { openCategoryForm(); return; }
  const categoryIcon = event.target.closest('[data-category-icon]'); if (categoryIcon) { state.selectedCategoryIcon = categoryIcon.dataset.categoryIcon; $$('#category-icon-options .icon-option').forEach(option => { const selected = option.dataset.categoryIcon === state.selectedCategoryIcon; option.classList.toggle('selected', selected); option.setAttribute('aria-pressed', String(selected)); }); return; }
  const editCategory = event.target.closest('[data-edit-category]'); if (editCategory) { openCategoryForm(state.categories.find(category => category.id === Number(editCategory.dataset.editCategory))); return; }
  const deleteCategory = event.target.closest('[data-delete-category]'); if (deleteCategory) { state.pendingCategoryId = Number(deleteCategory.dataset.deleteCategory); $('#category-delete-dialog').showModal(); return; }
  if (event.target.id === 'confirm-category-delete') { try { await api(`/api/parent/categories/${state.pendingCategoryId}`, { method: 'DELETE' }); $('#category-delete-dialog').close(); await loadCategories(); showToast('任务分类已删除'); } catch (err) { showToast(err.message); } return; }
  if (event.target.id === 'add-student') { openStudentForm(); return; }
  if (event.target.id === 'add-parent') { openParentForm(); return; }
  const editParent = event.target.closest('[data-edit-parent]'); if (editParent) { openParentForm(state.parents.find(parent => parent.id === Number(editParent.dataset.editParent))); return; }
  const resetParent = event.target.closest('[data-reset-parent]'); if (resetParent) { state.activeParentId = Number(resetParent.dataset.resetParent); $('#reset-parent-password').value = ''; $('#reset-parent-password-error').textContent = ''; $('#reset-parent-password-dialog').showModal(); return; }
  const toggleParent = event.target.closest('[data-toggle-parent]'); if (toggleParent) { const parent = state.parents.find(item => item.id === Number(toggleParent.dataset.toggleParent)); if (!parent) return; state.activeParentId = parent.id; state.pendingParentStatus = !parent.active; $('#parent-status-title').textContent = `${state.pendingParentStatus ? '确认启用' : '确认禁用'}${parent.displayName}的账号？`; $('#parent-status-description').textContent = state.pendingParentStatus ? '启用后，该家长可以重新登录系统。' : '禁用后，该家长将立即退出并无法登录系统。'; $('#confirm-parent-status').textContent = state.pendingParentStatus ? '确认启用' : '确认禁用'; $('#confirm-parent-status').classList.toggle('danger-button', !state.pendingParentStatus); $('#parent-status-dialog').showModal(); return; }
  if (event.target.id === 'confirm-parent-status') { try { await api(`/api/admin/parents/${state.activeParentId}/status`, { method: 'PATCH', body: JSON.stringify({ active: state.pendingParentStatus }) }); $('#parent-status-dialog').close(); await loadParents(); showToast(state.pendingParentStatus ? '家长账号已启用' : '家长账号已禁用'); } catch (err) { showToast(err.message); } return; }
  const studentActions = event.target.closest('[data-student-actions]'); if (studentActions) { const student = state.students.find(item => item.id === Number(studentActions.dataset.studentActions)); if (student) { closeStudentActionMenu(); openStudentActions(student, studentActions); } return; }
  if (event.target.closest('#edit-student-action')) { const studentId = Number($('#student-action-menu').dataset.studentId); const student = state.students.find(item => Number(item.id) === studentId); closeStudentActionMenu(); if (student) openStudentForm(student); else showToast('学生信息不存在或已解除关联'); return; }
  if (event.target.closest('#reset-student-password-action')) { closeStudentActionMenu(); $('#reset-student-password').value = ''; $('#reset-student-password-error').textContent = ''; $('#reset-student-password-dialog').showModal(); return; }
  if (event.target.closest('#link-student-parent-action')) { const student = state.students.find(item => item.id === state.activeStudentId); closeStudentActionMenu(); if (!student) return; fillParentSelect($('#link-parent-select'), student); if (!$('#link-parent-select').options.length) { showToast('没有可关联的家长账号'); return; } $('#link-parent-error').textContent = ''; $('#link-parent-dialog').showModal(); return; }
  const unlinkButton = event.target.closest('[data-unlink-parent]');
  if (unlinkButton) { state.activeStudentId = Number(unlinkButton.dataset.unlinkStudent); state.pendingUnlinkParentId = Number(unlinkButton.dataset.unlinkParent); const student = state.students.find(item => item.id === state.activeStudentId); const parent = student?.parents?.find(item => item.id === state.pendingUnlinkParentId); $('#unlink-student-description').textContent = `解除后，${parent?.displayName || '该家长'}将无法再查看${student?.display_name || '这名学生'}。只有超级管理员可以重新关联。`; $('#unlink-student-dialog').showModal(); return; }
  if (event.target.closest('#unlink-student-action')) { const student = state.students.find(item => item.id === state.activeStudentId); closeStudentActionMenu(); if (!student) return; const parentId = state.user.role === 'admin' ? student.parents?.[0]?.id : state.user.id; if (!parentId) { showToast('该学生暂未关联家长'); return; } state.pendingUnlinkParentId = parentId; $('#unlink-student-description').textContent = state.user.role === 'admin' && student.parents.length > 1 ? '请直接点击学生卡片中对应家长后的关闭图标，选择要解除的关联。' : `解除后，当前家长将无法再查看${student.display_name}。只有超级管理员可以重新关联。`; if (state.user.role === 'admin' && student.parents.length > 1) { $('#confirm-unlink-student').hidden = true; } else { $('#confirm-unlink-student').hidden = false; } $('#unlink-student-dialog').showModal(); return; }
  if (event.target.id === 'confirm-unlink-student') { try { await api(`/api/parent/students/${state.activeStudentId}/parents/${state.pendingUnlinkParentId}`, { method: 'DELETE' }); $('#unlink-student-dialog').close(); state.dashboardStudentId = null; await loadStudents(); await loadParent(); showToast('学生与家长已解绑'); } catch (err) { showToast(err.message); } return; }
  if (event.target.closest('#toggle-student-status-action')) { const student = state.students.find(item => item.id === state.activeStudentId); closeStudentActionMenu(); if (!student) return; state.pendingStudentStatus = !student.active; $('#student-status-title').textContent = state.pendingStudentStatus ? `确认启用${student.display_name}的账号？` : `确认禁用${student.display_name}的账号？`; $('#student-status-description').textContent = state.pendingStudentStatus ? '启用后，该学生可以重新登录系统。' : '禁用后，该学生将立即退出并无法登录系统。'; $('#confirm-student-status').textContent = state.pendingStudentStatus ? '确认启用' : '确认禁用'; $('#confirm-student-status').classList.toggle('danger-button', !state.pendingStudentStatus); $('#student-status-dialog').showModal(); return; }
  if (event.target.id === 'confirm-student-status') { const active = state.pendingStudentStatus; try { await api(`/api/parent/students/${state.activeStudentId}/status`, { method: 'PATCH', body: JSON.stringify({ active }) }); $('#student-status-dialog').close(); if (!active && state.dashboardStudentId === state.activeStudentId) state.dashboardStudentId = null; await loadStudents(); await loadParent(); setParentPage('students'); showToast(active ? '学生账号已启用' : '学生账号已禁用'); } catch (err) { showToast(err.message); } return; }
  const startTask = event.target.closest('[data-start-task]'); if (startTask && state.user?.role === 'student') { const taskId = Number(startTask.dataset.startTask); const task = state.tasks.find(item => item.id === taskId) || state.studentListTasks.find(item => item.id === taskId) || { id: taskId, status: 'in_progress' }; await openTask(task); return; }
  const taskElement = event.target.closest('[data-task]'); if (taskElement && state.user?.role === 'student' && !event.target.closest('button,a,input,select,textarea')) { await openStudentTaskDetail(Number(taskElement.dataset.task)); return; }
  const parentTaskElement = event.target.closest('[data-parent-task]'); if (parentTaskElement && state.user && state.user.role !== 'student' && !event.target.closest('button,a,input,select,textarea')) { await openParentTaskDetail(Number(parentTaskElement.dataset.parentTask)); return; }
  const previewTaskResource = event.target.closest('[data-preview-task-resource]'); if (previewTaskResource) { const task = state.activeTaskDetail; const resource = task?.resources?.[Number(previewTaskResource.dataset.previewTaskResource)] || (task?.resourceData ? { data: task.resourceData, kind: task.resourceKind, name: task.resourceName, mime: task.resourceMime } : null); if (!resource?.data) return; const kind = resourceKindOf(resource); $('#feedback-preview-content').innerHTML = kind === 'video' ? `<video src="${resource.data}" controls autoplay></video>` : kind === 'audio' ? `<audio src="${resource.data}" controls autoplay></audio>` : `<img src="${resource.data}" alt="${escapeHtml(resource.name || '任务资料')}" />`; $('#feedback-preview-dialog').showModal(); return; }
  if (event.target.id === 'pick-task-feedback') { $('#task-feedback-file')?.click(); return; }
  if (event.target.closest('#pick-reading-checkin-feedback')) { $('#reading-checkin-feedback')?.click(); return; }
  if (event.target.closest('[data-preview-parent-feedback]')) { const task = state.activeTaskDetail; if (!task?.feedbackData) return; $('#feedback-preview-content').innerHTML = task.feedbackKind === 'video' ? `<video src="${task.feedbackData}" controls autoplay></video>` : `<img src="${task.feedbackData}" alt="学生上传的任务反馈大图" />`; $('#feedback-preview-dialog').showModal(); return; }
  const previewFeedback = event.target.closest('[data-preview-feedback]'); if (previewFeedback) { const task = state.reviews.find(item => item.id === Number(previewFeedback.dataset.previewFeedback)); if (!task?.feedbackData) return; $('#feedback-preview-content').innerHTML = task.feedbackKind === 'video' ? `<video src="${task.feedbackData}" controls autoplay></video>` : `<img src="${task.feedbackData}" alt="学生上传的任务反馈大图" />`; $('#feedback-preview-dialog').showModal(); return; }
  const review = event.target.closest('[data-review]'); if (review) { const taskId = Number(review.dataset.review); let task = state.reviews.find(item => item.id === taskId); try { if (!task || !Object.hasOwn(task, 'feedbackData')) { const data = await api(`/api/parent/tasks/${taskId}/review`); task = data.task; const index = state.reviews.findIndex(item => item.id === taskId); if (index >= 0) state.reviews[index] = task; else state.reviews.push(task); } state.activeTaskDetail = task; $('#task-detail-dialog').close(); openReview(task); } catch (err) { showToast(err.message); } return; }
  const submitTask = event.target.closest('[data-submit-task]'); if (submitTask) { const error = $('#task-submit-error'); if (error) error.textContent = ''; try { const result = await api(`/api/student/tasks/${submitTask.dataset.submitTask}/submit`, { method: 'POST', body: JSON.stringify({ feedbackData: state.taskFeedbackData, feedbackName: state.taskFeedbackName, feedbackNote: $('#task-feedback-note')?.value || '' }) }); invalidateStudentDashboardCache(); syncStudentTask(result.task); closeDialogs(); showToast('任务已提交'); Promise.all([loadStudent(state.studentDate, { force: true, silent: true }), loadStudentTaskList(state.studentTaskFilter, { force: true, silent: true })]).catch(err => showToast(err.message)); } catch (err) { if (error) error.textContent = err.message; else showToast(err.message); } return; }
  const approve = event.target.closest('[data-approve]'); if (approve) { const error = $('#review-error'); try { await api(`/api/parent/tasks/${approve.dataset.approve}/review`, { method: 'POST', body: JSON.stringify({ action: 'approve', stars: Number($('#review-stars').value), message: $('#review-message').value }) }); invalidateStudentDashboardCache(); closeDialogs(); await loadParent(); await loadReviews(); showToast('审核通过，星星已发放'); } catch (err) { error.textContent = err.message; } return; }
  const more = event.target.closest('[data-more]'); if (more) { const error = $('#review-error'); try { await api(`/api/parent/tasks/${more.dataset.more}/review`, { method: 'POST', body: JSON.stringify({ action: 'needs_more', message: $('#review-message').value || '请再补充一点学习反馈。' }) }); invalidateStudentDashboardCache(); closeDialogs(); await loadParent(); await loadReviews(); showToast('已通知学生补充反馈'); } catch (err) { error.textContent = err.message; } return; }
  if (event.target.id === 'save-draft') { const error = $('#task-submit-error'); if (error) error.textContent = ''; try { const result = await api(`/api/student/tasks/${state.activeTaskDetail.id}/draft`, { method: 'PATCH', body: JSON.stringify({ feedbackData: state.taskFeedbackData, feedbackName: state.taskFeedbackName, feedbackNote: $('#task-feedback-note')?.value || '' }) }); invalidateStudentDashboardCache(); syncStudentTask(result.task); closeDialogs(); showToast('草稿已保存，任务状态已更新'); Promise.all([loadStudent(state.studentDate, { force: true, silent: true }), loadStudentTaskList(state.studentTaskFilter, { force: true, silent: true })]).catch(err => showToast(err.message)); } catch (err) { if (error) error.textContent = err.message; else showToast(err.message); } }
});
['account-security-dialog', 'email-settings-dialog'].forEach(id => {
  const dialog = document.getElementById(id);
  if (!dialog) return;
  dialog.addEventListener('click', event => {
    const close = event.target.closest('.modal-close');
    if (close) { dialog.close(); return; }
    event.stopPropagation();
  });
});
document.addEventListener('keydown', event => {
  if (!['Enter', ' '].includes(event.key) || !event.target.matches('[data-task], [data-parent-task]')) return;
  event.preventDefault(); event.target.click();
});
document.addEventListener('change', async event => {
  if (event.target.id === 'dashboard-student-select') { await loadParent(Number(event.target.value)); return; }
  if (event.target.id === 'assignment-category') { renderAssignmentCategoryIcon(); return; }
  if (event.target.id === 'template-category') { renderTemplateCategoryIcon(); return; }
  if (event.target.closest('#template-picker-groups') && event.target.matches('input[type="checkbox"]')) { const id = Number(event.target.value); state.selectedTemplateIds = event.target.checked ? [...new Set([...state.selectedTemplateIds, id])] : state.selectedTemplateIds.filter(item => item !== id); $('#selected-template-summary').textContent = state.selectedTemplateIds.length ? `已选择 ${state.selectedTemplateIds.length} 个模板` : '尚未选择模板'; return; }
  if (event.target.id === 'template-resource-file') {
    const files = [...event.target.files]; if (!files.length) return; const error = $('#template-error'); error.textContent = '';
    if (state.templateResources.length + files.length > 5) { event.target.value = ''; error.textContent = '任务资料最多上传 5 个文件'; return; }
    beginLoading();
    try { for (const file of files) state.templateResources.push({ name: file.name, data: await prepareTaskResource(file), kind: taskResourceKind(file), mime: file.type, existing: false }); state.removeTemplateResource = true; renderTemplateResourcePreview(); }
    catch (err) { error.textContent = err.message; }
    finally { endLoading(); event.target.value = ''; }
    return;
  }
  if (event.target.id === 'assignment-resource-file') {
    const files = [...event.target.files]; if (!files.length) return; const error = $('#assignment-error'); error.textContent = '';
    if (state.taskResources.length + files.length > 5) { event.target.value = ''; error.textContent = '任务资料最多上传 5 个文件'; return; }
    beginLoading();
    try { for (const file of files) state.taskResources.push({ name: file.name, data: await prepareTaskResource(file), kind: taskResourceKind(file), mime: file.type, existing: false }); state.removeTaskResource = true; renderAssignmentResourcePreview(); }
    catch (err) { error.textContent = err.message; }
    finally { endLoading(); event.target.value = ''; }
    return;
  }
  if (event.target.id !== 'task-feedback-file') return;
  const file = event.target.files[0]; if (!file) return;
  const preview = $('#task-feedback-preview'); const error = $('#task-submit-error'); error.textContent = '';
  try {
    state.taskFeedbackData = await prepareTaskFeedback(file); state.taskFeedbackName = file.name;
    preview.innerHTML = file.type.startsWith('video/') ? `<video src="${state.taskFeedbackData}" controls></video><b>${escapeHtml(file.name)}</b>` : `<img src="${state.taskFeedbackData}" alt="反馈图片预览" /><b>${escapeHtml(file.name)}</b>`;
  } catch (err) { state.taskFeedbackData = ''; state.taskFeedbackName = ''; event.target.value = ''; preview.innerHTML = '<span>尚未选择反馈文件</span>'; error.textContent = err.message; }
});
async function persistAssignment(payload, focusDate) {
  const editing = state.editingTaskId;
  const result = await api(editing ? `/api/parent/tasks/${editing}` : '/api/parent/tasks', { method: editing ? 'PATCH' : 'POST', body: JSON.stringify(payload) });
  $('#assignment-form').reset(); state.taskResources = []; state.removeTaskResource = false; state.editingTaskId = null; state.editingTask = null; state.pendingTaskUpdate = null;
  $('#assignment-resource-preview').hidden = true; $('#assignment-resource-preview').innerHTML = ''; state.taskDate = focusDate; state.taskStudentId = payload.studentIds.length === 1 ? payload.studentIds[0] : 'all';
  invalidateStudentDashboardCache(); renderTaskFilters(); renderTaskWeek(); setParentPage('assign');
  if (!editing) showToast(`已创建 ${result.count} 条任务`);
  else if (payload.scope === 'series') showToast(`已更新系列中的 ${result.updatedCount} 条任务${result.skippedCount ? `，保留 ${result.skippedCount} 条已锁定任务` : ''}`);
  else showToast('任务已更新');
  await loadParentTasks({ force: true, silent: true });
  loadInBackground(`overview:refresh:${Date.now()}`, () => loadParent(), 0);
}
$('#assignment-form').addEventListener('submit', async event => {
  event.preventDefault(); const error = $('#assignment-error'); error.textContent = '';
  const form = event.currentTarget;
  const studentIds = $$('#assignment-students input:checked').map(input => Number(input.value));
  if (!studentIds.length) { error.textContent = '请至少选择一名学生'; return; }
  if (state.editingTaskId && studentIds.length !== 1) { error.textContent = '修改任务时只能选择一名学生'; return; }
  try {
    const schedule = state.editingTask?.isRecurring ? { scheduleType: 'single', date: $('#assignment-single-date').value, startDate: $('#assignment-single-date').value, endDate: $('#assignment-single-date').value } : schedulePayload('assignment', state.assignmentDateMode);
    const resourceChanges = state.removeTaskResource ? {
      resources: state.taskResources.filter(resource => !resource.existing).map(({ name, data }) => ({ name, data })),
      existingResourceIds: state.taskResources.filter(resource => resource.existing).map(resource => resource.id),
      removeResource: true
    } : {};
    const payload = { studentIds, studentId: studentIds[0], title: $('#assignment-title').value, detail: $('#assignment-detail').value, categoryId: Number($('#assignment-category').value), duration: Number($('#assignment-duration').value), stars: Number($('#assignment-stars').value), feedbackType: $('#assignment-feedback').value, needsReview: $('#assignment-review').checked, ...schedule, ...resourceChanges };
    const focusDate = schedule.date || schedule.startDate || today();
    if (state.editingTask?.isRecurring) { state.pendingTaskUpdate = { payload: { ...payload, scope: 'series' }, focusDate }; $('#task-series-update-dialog').showModal(); return; }
    await persistAssignment(payload, focusDate);
  } catch (err) { error.textContent = err.message; }
});
$('#template-search-input').addEventListener('input', event => { state.templateSearch = event.target.value; renderTemplateGroups(); });
$('#task-student-filter').addEventListener('change', async event => { state.taskStudentId = event.target.value === 'all' ? 'all' : Number(event.target.value); await loadParentTasks(); });
$('#assignment-students').addEventListener('change', event => { if (!state.editingTaskId || !event.target.matches('input') || !event.target.checked) return; $$('#assignment-students input').forEach(input => { if (input !== event.target) input.checked = false; }); });
$('#assignment-start-date').addEventListener('change', () => syncRepeatDateLimit('assignment'));
$('#template-start-date').addEventListener('change', () => syncRepeatDateLimit('template'));
$$('input[name="assignment-repeat-pattern"]').forEach(input => input.addEventListener('change', () => setRepeatPattern('assignment', repeatPattern('assignment'))));
$$('input[name="template-repeat-pattern"]').forEach(input => input.addEventListener('change', () => setRepeatPattern('template', repeatPattern('template'))));
$('#template-form').addEventListener('submit', async event => {
  event.preventDefault(); const error = $('#template-error'); error.textContent = '';
  const form = event.currentTarget;
  const editing = state.editingTemplateId;
  const resourceChanges = state.removeTemplateResource ? {
    resources: state.templateResources.filter(resource => !resource.existing).map(({ name, data }) => ({ name, data })),
    existingResourceIds: state.templateResources.filter(resource => resource.existing).map(resource => resource.id),
    removeResource: true
  } : {};
  const payload = { title: $('#template-title').value, detail: $('#template-detail').value, categoryId: Number($('#template-category').value), duration: Number($('#template-duration').value), stars: Number($('#template-stars').value), feedbackType: $('#template-feedback').value, needsReview: $('#template-review').checked, isPublic: $('#template-public').checked, ...resourceChanges };
  try {
    await api(editing ? `/api/parent/task-templates/${editing}` : '/api/parent/task-templates', { method: editing ? 'PATCH' : 'POST', body: JSON.stringify({ ...payload, ...(state.copyingTemplateId ? { copyFromTemplateId: state.copyingTemplateId } : {}) }) });
    form.reset(); state.editingTemplateId = null; state.copyingTemplateId = null; state.templateResources = []; state.removeTemplateResource = false; await loadTaskTemplates(); setParentPage('templates'); showToast(editing ? '任务模板已更新' : '任务模板已创建');
  } catch (err) { error.textContent = err.message; }
});
$('#template-assign-form').addEventListener('submit', async event => {
  event.preventDefault(); const error = $('#template-assignment-error'); error.textContent = '';
  const studentIds = $$('#template-assignment-students input:checked').map(input => Number(input.value));
  if (!studentIds.length) { error.textContent = '请至少选择一名学生'; return; }
  try {
    const schedule = schedulePayload('template', state.templateDateMode);
    const result = await api('/api/parent/task-templates/assign', { method: 'POST', body: JSON.stringify({ templateIds: state.selectedTemplateIds, studentIds, ...schedule }) });
    state.taskDate = schedule.date || schedule.startDate || today(); state.taskStudentId = studentIds.length === 1 ? studentIds[0] : 'all'; state.selectedTemplateIds = []; invalidateStudentDashboardCache(); renderTaskFilters(); renderTaskWeek(); setParentPage('assign'); showToast(`已分配 ${result.count} 条任务`); await loadParentTasks({ force: true, silent: true }); loadInBackground(`overview:refresh:${Date.now()}`, () => loadParent(), 0);
  } catch (err) { error.textContent = err.message; }
});
$('#custom-stats-range').addEventListener('submit', async event => { event.preventDefault(); const errorRange = $('#stats-end-date').value < $('#stats-start-date').value; if (errorRange) { showToast('结束日期不能早于开始日期'); return; } await loadStatistics('custom'); });
$('#category-form').addEventListener('submit', async event => {
  event.preventDefault(); const error = $('#category-error'); error.textContent = '';
  const id = Number($('#category-id').value || 0);
  try { await api(id ? `/api/parent/categories/${id}` : '/api/parent/categories', { method: id ? 'PATCH' : 'POST', body: JSON.stringify({ name: $('#category-name').value, icon: state.selectedCategoryIcon }) }); $('#category-dialog').close(); await loadCategories(); showToast(id ? '分类名称和图标已更新' : '任务分类已创建'); }
  catch (err) { error.textContent = err.message; }
});
$('#password-form').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const error = $('#password-error'); error.textContent = '';
  try { await api('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword: $('#current-password').value, newPassword: $('#new-password').value }) }); state.user.mustChangePassword = false; $('#password-dialog').close(); form.reset(); showToast('密码已更新'); }
  catch (err) { error.textContent = err.message; }
});
$('#account-password-form').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const error = $('#account-password-error'); error.textContent = '';
  try { await api('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword: $('#account-current-password').value, newPassword: $('#account-new-password').value }) }); form.reset(); $('#account-security-dialog').close(); showToast('密码已更新'); }
  catch (err) { error.textContent = err.message; }
});
$('#recovery-email-form').addEventListener('submit', async event => {
  event.preventDefault(); const message = $('#recovery-email-message'); message.textContent = '';
  try { await api('/api/auth/recovery-email/request', { method: 'POST', body: JSON.stringify({ email: $('#recovery-email').value }) }); $('#recovery-email-code-wrap').hidden = false; startRecoveryEmailTimer(); message.textContent = '验证码已发送，请检查邮箱。'; }
  catch (err) { message.textContent = err.message; }
});
$('#verify-recovery-email').addEventListener('click', async () => {
  const message = $('#recovery-email-message'); message.textContent = '';
  try { const email = $('#recovery-email').value; await api('/api/auth/recovery-email/verify', { method: 'POST', body: JSON.stringify({ email, code: $('#recovery-email-code').value }) }); clearRecoveryEmailTimer(); $('#bound-email-status').textContent = `当前已绑定：${email}`; $('#recovery-email-form').reset(); $('#recovery-email-form').hidden = true; message.textContent = '邮箱已验证并绑定。'; }
  catch (err) { message.textContent = err.message; }
});
$('#recovery-form').addEventListener('submit', async event => {
  event.preventDefault(); const error = $('#recovery-error'); error.textContent = '';
  try { await api('/api/auth/recovery/request', { method: 'POST', body: JSON.stringify({ username: $('#recovery-username').value, email: $('#recovery-request-email').value }) }); $('#recovery-reset-fields').hidden = false; error.textContent = '如果账号和邮箱匹配，验证码已发送，请检查邮箱。'; }
  catch (err) { error.textContent = err.message; }
});
$('#reset-recovered-password').addEventListener('click', async () => {
  const error = $('#recovery-error'); error.textContent = '';
  try { await api('/api/auth/recovery/reset', { method: 'POST', body: JSON.stringify({ username: $('#recovery-username').value, email: $('#recovery-request-email').value, code: $('#recovery-code').value, newPassword: $('#recovery-new-password').value }) }); $('#recovery-dialog').close(); showToast('密码已重置，请使用新密码登录'); }
  catch (err) { error.textContent = err.message; }
});
$('#student-avatar').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  const error = $('#student-form-error'); error.textContent = '';
  try {
    state.studentAvatar = await prepareAvatar(file);
    setAvatar($('#student-avatar-preview'), state.studentAvatar);
  } catch (err) {
    state.studentAvatar = '';
    event.target.value = '';
    setAvatar($('#student-avatar-preview'), '', lastCharacter($('#student-name').value, '学'));
    error.textContent = err.message;
  }
});
$('#student-name').addEventListener('input', event => {
  if (!isImageAvatar(state.studentAvatar)) setAvatar($('#student-avatar-preview'), '', lastCharacter(event.target.value, '学'));
});
$('#parent-avatar').addEventListener('change', async event => {
  const file = event.target.files[0]; if (!file) return;
  const error = $('#parent-form-error'); error.textContent = '';
  try { state.parentAvatar = await prepareAvatar(file); setAvatar($('#parent-avatar-preview'), state.parentAvatar); }
  catch (err) { state.parentAvatar = ''; event.target.value = ''; setAvatar($('#parent-avatar-preview'), '', '家'); error.textContent = err.message; }
});
$('#parent-name').addEventListener('input', event => {
  if (!isImageAvatar(state.parentAvatar)) setAvatar($('#parent-avatar-preview'), '', lastCharacter(event.target.value));
});
$('#parent-form').addEventListener('submit', async event => {
  event.preventDefault(); const error = $('#parent-form-error'); error.textContent = '';
  const id = Number($('#parent-id').value || 0);
  const payload = { displayName: $('#parent-name').value, avatar: state.parentAvatar };
  if (!id) { payload.username = $('#parent-username').value; payload.password = $('#parent-password').value; }
  try { await api(id ? `/api/admin/parents/${id}` : '/api/admin/parents', { method: id ? 'PATCH' : 'POST', body: JSON.stringify(payload) }); $('#parent-dialog').close(); await loadParents(); showToast(id ? '家长信息已更新' : '家长账号已创建'); }
  catch (err) { error.textContent = err.message; }
});
$('#reset-parent-password-form').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const error = $('#reset-parent-password-error'); error.textContent = '';
  try { await api(`/api/admin/parents/${state.activeParentId}/reset-password`, { method: 'POST', body: JSON.stringify({ password: $('#reset-parent-password').value }) }); $('#reset-parent-password-dialog').close(); form.reset(); showToast('家长密码已重置'); }
  catch (err) { error.textContent = err.message; }
});
$('#link-parent-form').addEventListener('submit', async event => {
  event.preventDefault(); const error = $('#link-parent-error'); error.textContent = '';
  try { await api(`/api/admin/students/${state.activeStudentId}/parents`, { method: 'POST', body: JSON.stringify({ parentId: Number($('#link-parent-select').value) }) }); $('#link-parent-dialog').close(); await loadStudents(); await loadParents(); showToast('学生已关联家长'); }
  catch (err) { error.textContent = err.message; }
});
$('#student-form').addEventListener('submit', async event => {
  event.preventDefault(); const error = $('#student-form-error'); error.textContent = '';
  const id = Number($('#student-id').value || 0);
  const payload = { displayName: $('#student-name').value, avatar: state.studentAvatar, grade: $('#student-grade').value, note: $('#student-note').value };
  if (!id) { payload.username = $('#student-username').value; payload.password = $('#student-initial-password').value; if (state.user.role === 'admin') payload.parentIds = $$('#student-parent-options input:checked').map(input => Number(input.value)); }
  try { await api(id ? `/api/parent/students/${id}` : '/api/parent/students', { method: id ? 'PATCH' : 'POST', body: JSON.stringify(payload) }); $('#student-dialog').close(); await loadStudents(); await loadParent(); setParentPage('students'); showToast(id ? '学生资料已更新' : '学生账号已创建'); }
  catch (err) { error.textContent = err.message; }
});
$('#reset-student-password-form').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const error = $('#reset-student-password-error'); error.textContent = '';
  try { await api(`/api/parent/students/${state.activeStudentId}/reset-password`, { method: 'POST', body: JSON.stringify({ password: $('#reset-student-password').value }) }); $('#reset-student-password-dialog').close(); form.reset(); showToast('学生密码已重置，请通知孩子使用新密码登录'); }
  catch (err) { error.textContent = err.message; }
});
$('#reward-application-files').addEventListener('change', async event => { const files = [...event.target.files]; if (!files.length) return; if (state.rewardApplicationResources.length + files.length > 5) { $('#reward-application-error').textContent = '最多上传 5 张图片'; event.target.value = ''; return; } try { for (const file of files) state.rewardApplicationResources.push({ name: file.name, data: await prepareRewardApplicationImage(file), kind: 'image', mime: file.type, existing: false }); state.rewardApplicationResourcesChanged = true; renderRewardApplicationResources(); } catch (err) { $('#reward-application-error').textContent = err.message; event.target.value = ''; } });
$('#reward-application-form').addEventListener('submit', async event => { event.preventDefault(); const error = $('#reward-application-error'); error.textContent = ''; const id = Number($('#reward-application-id').value || 0); const body = { categoryId: Number($('#reward-application-category').value), content: $('#reward-application-content').value, detail: $('#reward-application-detail').value, completedAt: $('#reward-application-date').value, requestedStars: Number($('#reward-application-stars').value) }; if (state.rewardApplicationResourcesChanged || !id) { body.resources = state.rewardApplicationResources.filter(resource => !resource.existing).map(({ name, data }) => ({ name, data })); body.existingResourceIds = state.rewardApplicationResources.filter(resource => resource.existing).map(resource => resource.id); } try { await api(id ? `/api/student/reward-applications/${id}` : '/api/student/reward-applications', { method: id ? 'PATCH' : 'POST', body: JSON.stringify(body) }); $('#reward-application-dialog').close(); await loadRewardApplications(); showToast(id ? '奖励申请已更新' : '奖励申请已提交'); } catch (err) { error.textContent = err.message; } });
$('#reading-book-cover').addEventListener('change', async event => { const file = event.target.files?.[0]; if (!file) return; try { if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('封面仅支持 JPG、PNG、WebP 图片'); state.readingCoverData = await prepareTaskFeedback(file); state.readingCoverName = file.name; state.readingCoverExisting = false; renderReadingBookCoverPreview(); $('#reading-book-error').textContent = ''; } catch (err) { state.readingCoverData = ''; state.readingCoverName = ''; state.readingCoverExisting = false; event.target.value = ''; renderReadingBookCoverPreview(); $('#reading-book-error').textContent = err.message; } });
$('#reading-book-form').addEventListener('submit', async event => { event.preventDefault(); const error = $('#reading-book-error'); const id = Number($('#reading-book-id').value || 0); error.textContent = ''; try { await api(id ? `/api/parent/reading/books/${id}` : '/api/parent/reading/books', { method: id ? 'PATCH' : 'POST', body: JSON.stringify({ title: $('#reading-book-title').value, author: $('#reading-book-author').value, totalPages: Number($('#reading-book-pages').value), publisher: $('#reading-book-publisher').value, isbn: $('#reading-book-isbn').value, coverData: state.readingCoverData }) }); $('#reading-book-dialog').close(); await loadParentReading(); showToast(id ? '书籍已修改' : '书籍已录入书架'); } catch (err) { error.textContent = err.message; } });
$('#reading-plan-form').addEventListener('submit', async event => { event.preventDefault(); const error = $('#reading-plan-error'); const id = Number($('#reading-plan-id').value || 0); error.textContent = ''; const payload = { startDate: $('#reading-plan-start').value, endDate: $('#reading-plan-end').value, targetPages: Number($('#reading-plan-target-pages').value || 0), targetMinutes: Number($('#reading-plan-target-minutes').value || 0), frequency: state.readingFrequency, weekdays: $$('#reading-plan-weekdays input:checked').map(input => Number(input.value)), stars: Number($('#reading-plan-stars').value), feedbackType: $('#reading-plan-feedback').value, needsReview: $('#reading-plan-review').checked }; if (!id) { payload.bookId = Number($('#reading-plan-book').value); payload.studentIds = $$('#reading-plan-students input:checked').map(input => Number(input.value)); payload.startPage = Number($('#reading-plan-start-page').value); } try { await api(id ? `/api/parent/reading/plans/${id}` : '/api/parent/reading/plans', { method: id ? 'PATCH' : 'POST', body: JSON.stringify(payload) }); $('#reading-plan-dialog').close(); await loadParentReading(); showToast(id ? '阅读计划已修改，已有打卡记录未受影响' : '阅读计划已布置'); } catch (err) { error.textContent = err.message; } });
$('#reading-checkin-feedback').addEventListener('change', async event => { const file = event.target.files?.[0]; const preview = $('#reading-checkin-feedback-preview'); if (!file) return; try { state.readingFeedbackData = await prepareTaskFeedback(file); state.readingFeedbackName = file.name; preview.innerHTML = file.type.startsWith('video/') ? `<video src="${state.readingFeedbackData}" controls></video><b>${escapeHtml(file.name)}</b>` : `<img src="${state.readingFeedbackData}" alt="已选择的反馈图片" /><b>${escapeHtml(file.name)}</b>`; $('#reading-checkin-error').textContent = ''; } catch (err) { state.readingFeedbackData = ''; state.readingFeedbackName = ''; event.target.value = ''; preview.innerHTML = '<span>尚未选择反馈文件</span>'; $('#reading-checkin-error').textContent = err.message; } });
$('#reading-checkin-form').addEventListener('submit', async event => { event.preventDefault(); const error = $('#reading-checkin-error'); error.textContent = ''; try { await api('/api/student/reading/checkins', { method: 'POST', body: JSON.stringify({ planId: Number($('#reading-checkin-plan-id').value), checkinDate: $('#reading-checkin-date').value, endPage: Number($('#reading-checkin-end-page').value), reflection: $('#reading-checkin-reflection').value, feedbackData: state.readingFeedbackData, feedbackName: state.readingFeedbackName }) }); $('#reading-checkin-dialog').close(); await loadStudentReading(state.readingDate || today().slice(0, 7)); showToast('阅读打卡已提交'); } catch (err) { error.textContent = err.message; } });
window.addEventListener('resize', () => { closeStudentActionMenu(); if (innerWidth >= 768) closeParentMobileMenu(); if (!state.user) return; const student = state.user.role === 'student'; $('.main-content').style.marginLeft = student && innerWidth >= 768 ? '96px' : !student && innerWidth >= 768 ? '216px' : '0'; $('.bottom-nav').style.display = student && innerWidth < 768 ? 'grid' : 'none'; });
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeParentMobileMenu(); });
window.addEventListener('scroll', closeStudentActionMenu, true);
(async function boot() { refreshIcons(); displayLogin(); try { const result = await api('/api/auth/me'); await startSession(result.user); } catch { await refreshCaptcha(); } })();
