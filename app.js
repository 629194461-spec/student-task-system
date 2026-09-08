const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];
const state = { user: null, role: 'student', captchaId: null, student: null, parent: null, parents: [], students: [], tasks: [], studentListTasks: [], studentTaskFilter: 'overdue', studentDate: '', categories: [], reviews: [], statsPeriod: 'week', dashboardStudentId: null, activeStudentId: null, activeParentId: null, studentAvatar: '', parentAvatar: '', taskFeedbackData: '', taskFeedbackName: '', taskResourceData: '', taskResourceName: '', activeTaskDetail: null, pendingStudentStatus: null, pendingParentStatus: null, pendingUnlinkParentId: null, taskDate: '', taskStudentId: null, parentTasks: [], taskDates: [], assignmentDateMode: 'single', selectedCategoryIcon: '', pendingTaskId: null, pendingCategoryId: null };
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

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', headers: { 'content-type': 'application/json', ...(options.headers || {}) }, ...options });
  const body = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || '请求失败，请稍后重试');
  return body;
}
function today() { return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
function parseDate(value) { return new Date(`${value}T12:00:00Z`); }
function addDays(value, days) { const date = parseDate(value); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); }
function startOfWeek(value) { const date = parseDate(value); return addDays(value, -((date.getUTCDay() + 6) % 7)); }
function shortDate(value) { const date = parseDate(value); return `${date.getUTCMonth() + 1}月${date.getUTCDate()}日`; }
function weekdayDate(value) { return new Intl.DateTimeFormat('zh-CN', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(parseDate(value)); }
function dateSpanDays(start, end) { return Math.floor((parseDate(end) - parseDate(start)) / 86400000) + 1; }
function formatDateTime(value) { if (!value) return '暂无时间'; return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value)); }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
function icon(name, className = '') { return `<i data-lucide="${escapeHtml(name)}"${className ? ` class="${escapeHtml(className)}"` : ''}></i>`; }
function refreshIcons() { window.lucide?.createIcons({ attrs: { 'aria-hidden': 'true' } }); }
function emptyState(iconName, title, description) { return `<div class="record-empty"><span class="empty-icon">${icon(iconName)}</span><h2>${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p></div>`; }
function isImageAvatar(value) { return /^data:image\/(png|jpeg|webp);base64,/.test(value || ''); }
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
  const allowed = ['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm', 'application/pdf', 'text/plain', 'application/zip', 'application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'];
  if (!allowed.includes(file.type)) throw new Error('支持图片、MP4/WebM、PDF、Office、TXT 和 ZIP 文件');
  if (file.size > 6 * 1024 * 1024) throw new Error('任务资料不能超过 6 MB');
  return await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('任务资料读取失败')); reader.readAsDataURL(file); });
}
function showToast(message) { const toast = $('#toast'); toast.textContent = message; toast.classList.add('show'); clearTimeout(showToast.timer); showToast.timer = setTimeout(() => toast.classList.remove('show'), 3000); }
function clearActivePages() { $$('.page').forEach(page => { page.classList.remove('active'); page.hidden = true; }); }
function setStudentPage(id) { clearActivePages(); const page = document.getElementById(id); page.hidden = false; page.classList.add('active'); $$('[data-page]').forEach(button => button.classList.toggle('active', button.dataset.page === id)); window.scrollTo(0, 0); }
function setParentPage(id) { clearActivePages(); const page = document.getElementById(id); page.hidden = false; page.classList.add('active'); $$('[data-parent-page]').forEach(button => button.classList.toggle('active', button.dataset.parentPage === id)); window.scrollTo(0, 0); }
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
  $('#login-error').textContent = '';
}
function taskCard(task, compact = false) {
  const [klass, label, action] = statusMeta[task.status] || statusMeta.not_started;
  return `<article class="task-card" data-task="${task.id}"><span class="category-icon ${categoryClass[task.category] || 'cat-math'}">${categoryIconMarkup(task.icon)}</span><div class="task-main"><h3>${escapeHtml(task.title)}</h3><div class="task-meta"><p>${icon('clock-3')} ${task.duration || 15} 分钟${task.hasResource ? ` · ${icon('paperclip')} 有资料` : ''}</p><span class="status ${klass}">${label}</span></div></div>${compact ? '' : `<div class="task-action"><span class="stars">⭐ ${task.stars} 颗星星</span><button class="${task.status === 'completed' ? 'success' : ''}" ${task.status === 'completed' ? 'disabled' : ''}>${action}</button></div>`}</article>`;
}
function renderStudentWeek(data) {
  const labels = ['一', '二', '三', '四', '五', '六', '日'];
  const start = startOfWeek(state.studentDate);
  $('#student-week').innerHTML = labels.map((label, index) => {
    const date = addDays(start, index);
    return `<button type="button" data-student-date="${date}" class="${date === state.studentDate ? 'selected' : ''} ${date === today() ? 'today' : ''}"><small>${label}</small><strong>${parseDate(date).getUTCDate()}</strong>${data.taskDates?.includes(date) ? '<i aria-label="有任务"></i>' : ''}</button>`;
  }).join('');
}
function studentTaskListRow(task) {
  const [klass, label] = statusMeta[task.status] || statusMeta.not_started;
  return `<article class="student-task-row" data-task="${task.id}"><span class="category-icon" style="background:${escapeHtml(task.color)}1f">${categoryIconMarkup(task.icon)}</span><div><h3>${escapeHtml(task.title)}</h3><p>${escapeHtml(shortDate(task.date))} · ${escapeHtml(task.category)} · ${task.duration || 0} 分钟${task.hasResource ? ' · 有资料' : ''}</p></div><span class="stars">⭐ ${task.stars}</span><span class="status ${klass}">${escapeHtml(label)}</span></article>`;
}
function renderStudent(data) {
  state.student = data; state.tasks = data.tasks; state.studentDate = data.date;
  const completed = data.tasks.filter(task => task.status === 'completed').length;
  const current = data.date === today();
  $('#student-today-date').textContent = weekdayDate(data.date);
  $('#student-greeting').textContent = `${data.student?.displayName || state.user.displayName}的任务`;
  $('#student-today-summary').textContent = current ? `今天有 ${data.tasks.length} 项任务` : `${shortDate(data.date)}有 ${data.tasks.length} 项任务`;
  $('#student-list-date-label').textContent = current ? '今天' : shortDate(data.date);
  $('#task-list').innerHTML = data.tasks.map(task => taskCard(task)).join('') || emptyState('calendar-days', `${current ? '今天' : shortDate(data.date)}没有安排任务`, '可以轻松安排自己的时间。');
  $('#task-count').textContent = data.tasks.length;
  $('#progress-label').textContent = data.tasks.length ? `${completed} / ${data.tasks.length} 件完成` : '暂无任务';
  $('#progress-bar').style.width = `${data.tasks.length ? completed / data.tasks.length * 100 : 0}%`;
  renderStudentWeek(data);
  $('.reward-timeline').innerHTML = data.rewards.map(reward => `<article><span class="reward-dot">★</span><div><h3>${reward.title || '学习任务'}</h3><p>${reward.message || '每一次认真完成都值得奖励。'}</p></div><strong>+${reward.stars}</strong></article>`).join('') || '<article><div><p>完成任务后，奖励会出现在这里。</p></div></article>';
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
async function loadStudentTaskList(filter = state.studentTaskFilter) {
  state.studentTaskFilter = filter;
  const data = await api(`/api/student/tasks?filter=${encodeURIComponent(filter)}`);
  state.studentListTasks = data.tasks;
  renderStudentTaskList();
}
function reviewRow(task) { return `<article class="review-row"><span class="feedback-preview">${categoryIconMarkup(task.icon)}</span><div><h3>${escapeHtml(task.title)}</h3><p>${escapeHtml(task.category)} · ${task.submittedAt ? formatDateTime(task.submittedAt) : '等待提交'} · ⭐ ${task.stars} 颗</p></div><button data-review="${task.id}">去审核</button></article>`; }
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
  $('.week-overdue-card p').textContent = data.summary.weekOverdue ? `本周有 ${data.summary.weekOverdue} 个任务已逾期` : '本周没有逾期任务';
  $('.review-card strong').textContent = data.summary.pending;
  $('.review-card p').textContent = `所有任务中有 ${data.summary.pending} 个待审核`;
  $('.today-complete-card strong').textContent = data.summary.todayTotal ? `${data.summary.todayCompleted} / ${data.summary.todayTotal}` : '--';
  $('.today-complete-card p').textContent = todayPercent === null ? '今日暂无任务' : `今日完成进度 ${todayPercent}%`;
  $('.week-star-card strong').textContent = data.summary.weekStars;
  $('.week-star-card p').textContent = `本周已获得 ${data.summary.weekStars} 颗星星`;
  $('#compact-review-list').innerHTML = data.pending.map(reviewRow).join('') || '<p class="empty-inline">当前学生的反馈都已审核完成。</p>';
  $('#parent-growth-rewards').innerHTML = growthRewardsHtml(data.growth);
  $('#parent-growth-title').textContent = child ? `${child.display_name}的成长` : '学生成长';
  $('#parent-growth-next').textContent = `再收集 ${100 - data.growth.stars} 颗星星，得到新月亮`;
  $('.growth-inline .progress-track span').style.width = `${data.growth.stars}%`;
  refreshIcons();
}
async function loadStudent(date = state.studentDate || today()) { renderStudent(await api(`/api/student/dashboard?date=${encodeURIComponent(date)}`)); }
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
  const feedbackLabel = task.feedbackType === 'none' ? '无需反馈' : task.hasFeedback ? '已提交反馈' : '未上传附件';
  return `<article class="review-list-row"><span class="student-avatar">${avatarMarkup(task.studentAvatar, task.studentName?.slice(0, 1))}</span><span class="category-icon" style="background:${escapeHtml(task.color)}1f">${categoryIconMarkup(task.icon)}</span><div><h3>${escapeHtml(task.title)}</h3><p>${escapeHtml(task.category)} · ${feedbackLabel} · 提交于 ${formatDateTime(task.submittedAt)}</p></div><span class="stars">⭐ ${task.stars}</span><button class="primary-button" data-review="${task.id}">审核</button></article>`;
}
function renderReviews() {
  $('#review-count').textContent = `${state.reviews.length} 项待审核`;
  const badge = $('.parent-sidebar [data-parent-page="review"] em'); badge.textContent = state.reviews.length; badge.hidden = state.reviews.length === 0;
  const groups = state.reviews.reduce((result, task) => { (result[task.studentId] ||= { name: task.studentName, tasks: [] }).tasks.push(task); return result; }, {});
  $('#review-list').innerHTML = Object.values(groups).map(group => `<section class="review-student-group"><div class="review-group-heading"><h2>${escapeHtml(group.name)}</h2><span>${group.tasks.length} 项</span></div><div>${group.tasks.map(reviewListRow).join('')}</div></section>`).join('') || emptyState('badge-check', '暂时没有待审核任务', '关联学生提交任务后会显示在这里。');
  refreshIcons();
}
async function loadReviews() {
  const data = await api('/api/parent/reviews?studentId=all&period=all'); state.reviews = data.reviews; renderReviews();
}
function renderStatistics(data) {
  $('#stats-range-label').textContent = data.period.key === 'all' ? '全部时间' : `${data.period.start} 至 ${data.period.end}`;
  $('#ranking-title').textContent = `学生${data.period.label}`;
  $('#ranking-list').innerHTML = data.students.map((student, index) => `<article class="ranking-row${student.total ? '' : ' no-task'}"><span class="rank-number ${index < 3 ? `top-${index + 1}` : ''}">${index + 1}</span><span class="student-avatar">${avatarMarkup(student.studentAvatar, student.studentName?.slice(0, 1))}</span><div><h3>${escapeHtml(student.studentName)}${student.active ? '' : '<small>已禁用</small>'}</h3><p>${student.total ? `${student.completed} / ${student.total} 项任务完成` : '该时间范围内没有任务'}</p></div><strong>⭐ ${student.stars}</strong><span><b>${student.completionRate === null ? '--' : `${student.completionRate}%`}</b>完成率</span><span><b>${student.onTimeRate === null ? '--' : `${student.onTimeRate}%`}</b>按时率</span></article>`).join('') || emptyState('chart-no-axes-combined', '暂无学生数据', '创建学生并分配任务后会显示统计结果。');
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
  $('#task-week').innerHTML = labels.map((label, index) => { const date = addDays(start, index); return `<button type="button" data-task-date="${date}" class="${date === state.taskDate ? 'selected' : ''} ${date === today() ? 'today' : ''}"><small>周${label}</small><strong>${parseDate(date).getUTCDate()}</strong>${state.taskDates.includes(date) ? '<i aria-label="有任务"></i>' : ''}</button>`; }).join('');
  $('#task-list-date-label').textContent = `${shortDate(state.taskDate)}${state.taskDate === today() ? ' · 今日' : ''}`;
}
function parentTaskRow(task) {
  const [, statusLabel] = statusMeta[task.status] || statusMeta.not_started;
  const canDelete = !['pending_review', 'completed'].includes(task.status);
  return `<article class="parent-task-row"><span class="category-icon" style="background:${escapeHtml(task.color)}1f">${categoryIconMarkup(task.icon)}</span><div class="parent-task-main"><div><h3>${escapeHtml(task.title)}</h3><span class="status ${statusMeta[task.status]?.[0] || 'waiting'}">${escapeHtml(statusLabel)}</span></div><p>${escapeHtml(task.studentName || '')} · ${escapeHtml(task.category)} · ${task.duration || 0} 分钟 · ⭐ ${task.stars}${task.hasResource ? ` · ${icon('paperclip')} 有资料` : ''}</p></div>${canDelete ? `<button class="icon-button delete-task-button" data-delete-parent-task="${task.id}" aria-label="删除${escapeHtml(task.title)}" title="删除当天任务">${icon('trash')}</button>` : '<span class="task-delete-placeholder" aria-hidden="true"></span>'}</article>`;
}
async function loadParentTasks() {
  const data = await api(`/api/parent/tasks?date=${encodeURIComponent(state.taskDate)}&studentId=${encodeURIComponent(state.taskStudentId || 'all')}`);
  state.parentTasks = data.tasks;
  state.taskDates = data.taskDates || [];
  renderTaskWeek();
  $('#parent-task-list').innerHTML = data.tasks.map(parentTaskRow).join('') || emptyState('clipboard-list', '这一天还没有任务', '点击右上角“分配任务”创建学习安排。');
  refreshIcons();
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
function setAssignmentDateMode(mode) {
  state.assignmentDateMode = mode;
  $$('[data-assignment-date-mode]').forEach(button => button.classList.toggle('selected', button.dataset.assignmentDateMode === mode));
  $('#assignment-single-date').parentElement.hidden = mode !== 'single';
  $('#assignment-single-date').required = mode === 'single';
  $('#assignment-range-fields').hidden = mode !== 'range';
  $('#assignment-start-date').required = mode === 'range';
  $('#assignment-end-date').required = mode === 'range';
  $('#assignment-date-hint').hidden = mode !== 'range';
}
function syncAssignmentRangeLimit() {
  const start = $('#assignment-start-date').value;
  if (!start) return;
  $('#assignment-end-date').min = start;
  $('#assignment-end-date').max = addDays(start, 29);
  if ($('#assignment-end-date').value < start || $('#assignment-end-date').value > addDays(start, 29)) $('#assignment-end-date').value = start;
}
function openAssignmentEditor() {
  const students = activeStudents();
  $('#assignment-students').innerHTML = students.map(student => `<label class="student-choice"><input type="checkbox" value="${student.id}" ${String(student.id) === String(state.taskStudentId) ? 'checked' : ''}/><span class="student-avatar">${avatarMarkup(student.avatar, student.display_name?.slice(0, 1))}</span><b>${escapeHtml(student.display_name)}</b></label>`).join('');
  if (!$('#assignment-students input:checked') && students[0]) $('#assignment-students input').checked = true;
  $('#assignment-single-date').value = state.taskDate;
  $('#assignment-start-date').value = state.taskDate;
  $('#assignment-end-date').value = state.taskDate;
  syncAssignmentRangeLimit();
  $('#assignment-error').textContent = '';
  state.taskResourceData = ''; state.taskResourceName = ''; $('#assignment-resource-file').value = ''; $('#assignment-resource-preview').hidden = true; $('#assignment-resource-preview').innerHTML = '';
  renderAssignmentCategoryIcon();
  setAssignmentDateMode('single');
  setParentPage('assignment-editor');
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
async function startSession(user) {
  state.user = user; state.studentDate = today(); state.dashboardStudentId = null; displayApp();
  const student = user.role === 'student';
  $('#app-shell').classList.toggle('student-mode', student);
  $('#app-shell').classList.toggle('parent-mode', !student);
  $('.student-sidebar').classList.toggle('hidden', !student); $('.parent-sidebar').classList.toggle('hidden', student);
  $$('.admin-only').forEach(element => element.classList.toggle('hidden', user.role !== 'admin'));
  $('#students-page-title').textContent = user.role === 'admin' ? '全部学生' : '我的孩子';
  $('#stats .eyebrow').textContent = user.role === 'admin' ? '全部学生' : '我的孩子';
  $('#session-role').innerHTML = `${icon(student ? 'graduation-cap' : user.role === 'admin' ? 'shield-check' : 'users-round')}${student ? '学生端' : user.role === 'admin' ? '管理员端' : '家长端'}`;
  $('.main-content').style.marginLeft = student && innerWidth >= 768 ? '96px' : !student && innerWidth >= 768 ? '216px' : '0';
  $('.bottom-nav').style.display = student && innerWidth < 768 ? 'grid' : 'none';
  if (student) { await Promise.all([loadStudent(), loadStudentTaskList()]); setStudentPage('today'); } else { await loadParent(); if (user.role === 'admin') await loadParents(); await loadStudents(); await loadCategories(); await loadReviews(); state.taskDate = today(); state.taskStudentId = state.parent?.selectedStudentId || activeStudents()[0]?.id || 'all'; setParentPage('overview'); }
  refreshIcons();
  if (user.mustChangePassword) $('#password-dialog').showModal();
}
function taskResourceMarkup(task) {
  if (!task.hasResource) return '';
  if (task.resourceKind === 'image') return `<section class="task-resource-section"><h3>任务资料</h3><button class="task-resource-card" data-preview-task-resource><img src="${task.resourceData}" alt="任务资料预览" /><span><b>${escapeHtml(task.resourceName)}</b><small>点击查看大图</small></span></button></section>`;
  if (task.resourceKind === 'video') return `<section class="task-resource-section"><h3>任务资料</h3><button class="task-resource-card" data-preview-task-resource><span class="resource-file-icon">▶</span><span><b>${escapeHtml(task.resourceName)}</b><small>点击播放视频</small></span></button></section>`;
  return `<section class="task-resource-section"><h3>任务资料</h3><a class="task-resource-card" href="${task.resourceData}" download="${escapeHtml(task.resourceName)}"><span class="resource-file-icon">⇩</span><span><b>${escapeHtml(task.resourceName)}</b><small>点击下载并查阅文件</small></span></a></section>`;
}
async function openTask(task) {
  try {
    if (task.status === 'not_started') task = (await api(`/api/student/tasks/${task.id}/draft`, { method: 'PATCH', body: '{}' })).task;
    else task = (await api(`/api/student/tasks/${task.id}`)).task;
    const dayIndex = state.tasks.findIndex(item => item.id === task.id); if (dayIndex >= 0) state.tasks[dayIndex] = task;
    const listIndex = state.studentListTasks.findIndex(item => item.id === task.id); if (listIndex >= 0) state.studentListTasks[listIndex] = task;
    if (dayIndex >= 0) renderStudent({ ...state.student, tasks: state.tasks });
    if (listIndex >= 0) renderStudentTaskList();
  } catch (err) { showToast(err.message); return; }
  state.activeTaskDetail = task;
  const [, , action] = statusMeta[task.status] || statusMeta.not_started;
  state.taskFeedbackData = task.feedbackData || ''; state.taskFeedbackName = task.feedbackName || '';
  const readonly = ['completed', 'pending_review'].includes(task.status);
  const accept = task.feedbackType === 'photo' ? 'image/*' : task.feedbackType === 'video' ? 'video/mp4,video/webm' : 'image/*,video/mp4,video/webm';
  const savedPreview = task.feedbackData ? (task.feedbackKind === 'video' ? `<video src="${task.feedbackData}" controls></video><b>${escapeHtml(task.feedbackName || '已保存的视频')}</b>` : `<img src="${task.feedbackData}" alt="已保存的反馈图片" /><b>${escapeHtml(task.feedbackName || '已保存的图片')}</b>`) : '<span>尚未选择反馈文件</span>';
  const feedback = task.feedbackType === 'none' ? `<div class="no-feedback-note">此任务不需要上传反馈，完成后直接提交即可。</div><label class="task-note-label">补充说明<textarea id="task-feedback-note" maxlength="300" placeholder="可以写下完成过程或心得（选填）">${escapeHtml(task.feedbackNote)}</textarea></label>` : `<div class="task-feedback-upload"><input id="task-feedback-file" type="file" accept="${accept}" hidden /><button type="button" class="secondary-button" id="pick-task-feedback">＋ 选择图片或视频</button><div id="task-feedback-preview">${savedPreview}</div><label>补充说明<textarea id="task-feedback-note" maxlength="300" placeholder="可以写下完成过程或心得（选填）">${escapeHtml(task.feedbackNote)}</textarea></label></div>`;
  $('#task-modal-content').innerHTML = `<div class="modal-content"><p class="eyebrow task-dialog-category">${categoryIconMarkup(task.icon)} ${escapeHtml(task.category)}</p><h2>${escapeHtml(task.title)}</h2><p>${escapeHtml(task.detail)}</p>${taskResourceMarkup(task)}<div class="modal-summary"><p>预计 ${task.duration || 15} 分钟</p><p>完成后可获得 ⭐ ${task.stars} 颗星星</p><p>${task.feedbackType === 'none' ? '不需要提交反馈' : '需要提交学习反馈'}</p></div>${readonly ? `<div class="no-feedback-note">${task.status === 'completed' ? '该任务已经完成。' : '反馈已提交，正在等待家长审核。'}</div><div class="modal-actions"><button class="primary-button" id="modal-close-done">知道啦</button></div>` : `${feedback}<p class="login-error" id="task-submit-error"></p><div class="modal-actions"><button class="secondary-button" id="save-draft">保存草稿</button><button class="primary-button" data-submit-task="${task.id}">${action === '补充反馈' ? '确认补充' : '确认提交'}</button></div>`}</div>`;
  $('#task-dialog').showModal();
}
function openReview(task) {
  const feedback = task.feedbackData
    ? `<button class="review-evidence" data-preview-feedback="${task.id}">${task.feedbackKind === 'video' ? '<span class="video-placeholder">▶</span>' : `<img src="${task.feedbackData}" alt="学生上传的任务反馈" />`}<b>点击查看${task.feedbackKind === 'video' ? '视频' : '图片'}</b></button>`
    : `<div class="no-feedback-note">${task.feedbackType === 'none' ? '此任务不需要提交图片或视频反馈。' : '当前没有可预览的附件，可以要求学生补充反馈。'}</div>`;
  $('#review-modal-content').innerHTML = `<div class="modal-content review-modal"><p class="eyebrow">${escapeHtml(task.studentName)} · ${escapeHtml(task.category)}</p><h2>${escapeHtml(task.title)}</h2><div class="review-task-details"><p><b>任务日期</b>${escapeHtml(task.date)}</p><p><b>预计时长</b>${task.duration || 0} 分钟</p><p><b>任务要求</b>${escapeHtml(task.detail)}</p><p><b>提交时间</b>${formatDateTime(task.submittedAt)}</p></div>${feedback}${task.feedbackNote ? `<p class="feedback-note"><b>学生说明</b>${escapeHtml(task.feedbackNote)}</p>` : ''}<div class="review-reward-form"><label>奖励星星<span class="number-with-unit"><input id="review-stars" type="number" min="1" max="5" value="${task.stars}" /><b>颗</b></span></label><label>鼓励或补充说明<textarea id="review-message" maxlength="180" placeholder="写一句鼓励，或说明需要补充的内容">完成得很棒！</textarea></label></div><p class="login-error" id="review-error"></p><div class="review-actions"><button class="supplement" data-more="${task.id}">需要补充</button><button class="primary-button" data-approve="${task.id}">✓ 通过并奖励</button></div></div>`;
  $('#review-dialog').showModal();
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
  $('#student-avatar').required = !student;
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

$('#login-form').addEventListener('submit', async event => {
  event.preventDefault(); const error = $('#login-error'); error.textContent = '';
  const submit = $('.login-submit'); submit.disabled = true; submit.textContent = '正在验证…';
  try { const result = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ role: state.role, username: $('#username').value, password: $('#password').value, captchaId: state.captchaId, captcha: $('#captcha').value }) }); await startSession(result.user); }
  catch (err) { error.textContent = err.message; await refreshCaptcha(); }
  finally { submit.disabled = false; submit.innerHTML = `<span id="login-submit-label">${state.role === 'student' ? '进入我的任务' : '进入家长首页'}</span> <b>→</b>`; }
});
document.addEventListener('click', async event => {
  if (!$('#student-action-menu').hidden && !event.target.closest('#student-action-menu') && !event.target.closest('[data-student-actions]')) closeStudentActionMenu();
  const loginRole = event.target.closest('[data-login-role]'); if (loginRole) { setLoginRole(loginRole.dataset.loginRole); return; }
  if (event.target.closest('#refresh-captcha')) { await refreshCaptcha(); return; }
  if (event.target.closest('#logout-button')) { $('#logout-dialog').showModal(); return; }
  if (event.target.id === 'confirm-logout') { try { await api('/api/auth/logout', { method: 'POST' }); } finally { closeDialogs(); closeStudentActionMenu(); state.user = null; $('#username').value = ''; $('#password').value = ''; setLoginRole('student'); displayLogin(); await refreshCaptcha(); } return; }
  const dialogClose = event.target.closest('.modal-close, .dialog-cancel'); if (dialogClose) { dialogClose.closest('dialog')?.close(); return; }
  if (event.target.id === 'modal-close-done') { closeDialogs(); return; }
  if (event.target.closest('.feedback-option')) { $$('.feedback-option').forEach(item => item.classList.remove('selected')); event.target.closest('.feedback-option').classList.add('selected'); return; }
  const studentNav = event.target.closest('[data-page]'); if (studentNav && state.user?.role === 'student') { if (studentNav.dataset.page === 'tasks') await loadStudentTaskList(); setStudentPage(studentNav.dataset.page); return; }
  const parentNav = event.target.closest('[data-parent-page]'); if (parentNav && state.user && state.user.role !== 'student') { if (parentNav.dataset.parentPage === 'parents') { if (state.user.role !== 'admin') return; await loadParents(); } if (parentNav.dataset.parentPage === 'students') await loadStudents(); if (parentNav.dataset.parentPage === 'assign') await prepareTaskManager(); if (parentNav.dataset.parentPage === 'categories') await loadCategories(); if (parentNav.dataset.parentPage === 'review') await loadReviews(); if (parentNav.dataset.parentPage === 'stats') { $('#stats-start-date').value ||= startOfWeek(today()); $('#stats-end-date').value ||= today(); await loadStatistics(state.statsPeriod); } setParentPage(parentNav.dataset.parentPage); return; }
  if (event.target.id === 'open-assignment') { openAssignmentEditor(); return; }
  if (event.target.id === 'pick-assignment-resource') { $('#assignment-resource-file').click(); return; }
  if (event.target.id === 'clear-assignment-resource') { state.taskResourceData = ''; state.taskResourceName = ''; $('#assignment-resource-file').value = ''; $('#assignment-resource-preview').hidden = true; $('#assignment-resource-preview').innerHTML = ''; return; }
  if (event.target.id === 'back-to-task-list' || event.target.id === 'cancel-assignment') { await prepareTaskManager(); setParentPage('assign'); return; }
  const taskDate = event.target.closest('[data-task-date]'); if (taskDate) { state.taskDate = taskDate.dataset.taskDate; renderTaskWeek(); await loadParentTasks(); return; }
  if (event.target.id === 'task-week-prev' || event.target.id === 'task-week-next') { state.taskDate = addDays(state.taskDate, event.target.id === 'task-week-prev' ? -7 : 7); renderTaskWeek(); await loadParentTasks(); return; }
  const studentDate = event.target.closest('[data-student-date]'); if (studentDate) { await loadStudent(studentDate.dataset.studentDate); return; }
  if (event.target.id === 'student-week-prev' || event.target.id === 'student-week-next') { await loadStudent(addDays(state.studentDate, event.target.id === 'student-week-prev' ? -7 : 7)); return; }
  const studentTaskFilter = event.target.closest('[data-student-task-filter]'); if (studentTaskFilter) { await loadStudentTaskList(studentTaskFilter.dataset.studentTaskFilter); return; }
  const dateMode = event.target.closest('[data-assignment-date-mode]'); if (dateMode) { setAssignmentDateMode(dateMode.dataset.assignmentDateMode); return; }
  const statsPeriod = event.target.closest('[data-stats-period]'); if (statsPeriod) { const period = statsPeriod.dataset.statsPeriod; state.statsPeriod = period; $('#custom-stats-range').hidden = period !== 'custom'; if (period !== 'custom') await loadStatistics(period); else $$('[data-stats-period]').forEach(button => button.classList.toggle('selected', button === statsPeriod)); return; }
  const deleteTask = event.target.closest('[data-delete-parent-task]'); if (deleteTask) { state.pendingTaskId = Number(deleteTask.dataset.deleteParentTask); $('#task-delete-dialog').showModal(); return; }
  if (event.target.id === 'confirm-task-delete') { try { await api(`/api/parent/tasks/${state.pendingTaskId}`, { method: 'DELETE' }); $('#task-delete-dialog').close(); await loadParentTasks(); showToast('已删除当天任务'); } catch (err) { showToast(err.message); } return; }
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
  const taskElement = event.target.closest('[data-task]'); if (taskElement && state.user?.role === 'student') { const taskId = Number(taskElement.dataset.task); const task = state.tasks.find(item => item.id === taskId) || state.studentListTasks.find(item => item.id === taskId); if (task) await openTask(task); return; }
  if (event.target.closest('[data-preview-task-resource]')) { const task = state.activeTaskDetail; if (!task?.resourceData) return; $('#feedback-preview-content').innerHTML = task.resourceKind === 'video' ? `<video src="${task.resourceData}" controls autoplay></video>` : `<img src="${task.resourceData}" alt="任务资料大图" />`; $('#feedback-preview-dialog').showModal(); return; }
  if (event.target.id === 'pick-task-feedback') { $('#task-feedback-file')?.click(); return; }
  const previewFeedback = event.target.closest('[data-preview-feedback]'); if (previewFeedback) { const task = state.reviews.find(item => item.id === Number(previewFeedback.dataset.previewFeedback)); if (!task?.feedbackData) return; $('#feedback-preview-content').innerHTML = task.feedbackKind === 'video' ? `<video src="${task.feedbackData}" controls autoplay></video>` : `<img src="${task.feedbackData}" alt="学生上传的任务反馈大图" />`; $('#feedback-preview-dialog').showModal(); return; }
  const review = event.target.closest('[data-review]'); if (review) { const taskId = Number(review.dataset.review); let task = state.reviews.find(item => item.id === taskId); try { if (!task || !Object.hasOwn(task, 'feedbackData')) { const data = await api(`/api/parent/tasks/${taskId}/review`); task = data.task; const index = state.reviews.findIndex(item => item.id === taskId); if (index >= 0) state.reviews[index] = task; else state.reviews.push(task); } openReview(task); } catch (err) { showToast(err.message); } return; }
  const submitTask = event.target.closest('[data-submit-task]'); if (submitTask) { const error = $('#task-submit-error'); if (error) error.textContent = ''; try { await api(`/api/student/tasks/${submitTask.dataset.submitTask}/submit`, { method: 'POST', body: JSON.stringify({ feedbackData: state.taskFeedbackData, feedbackName: state.taskFeedbackName, feedbackNote: $('#task-feedback-note')?.value || '' }) }); closeDialogs(); await Promise.all([loadStudent(state.studentDate), loadStudentTaskList()]); showToast('任务已提交'); } catch (err) { if (error) error.textContent = err.message; else showToast(err.message); } return; }
  const approve = event.target.closest('[data-approve]'); if (approve) { const error = $('#review-error'); try { await api(`/api/parent/tasks/${approve.dataset.approve}/review`, { method: 'POST', body: JSON.stringify({ action: 'approve', stars: Number($('#review-stars').value), message: $('#review-message').value }) }); closeDialogs(); await loadParent(); await loadReviews(); showToast('审核通过，星星已发放'); } catch (err) { error.textContent = err.message; } return; }
  const more = event.target.closest('[data-more]'); if (more) { const error = $('#review-error'); try { await api(`/api/parent/tasks/${more.dataset.more}/review`, { method: 'POST', body: JSON.stringify({ action: 'needs_more', message: $('#review-message').value || '请再补充一点学习反馈。' }) }); closeDialogs(); await loadParent(); await loadReviews(); showToast('已通知学生补充反馈'); } catch (err) { error.textContent = err.message; } return; }
  if (event.target.id === 'save-draft') { const error = $('#task-submit-error'); if (error) error.textContent = ''; try { await api(`/api/student/tasks/${state.activeTaskDetail.id}/draft`, { method: 'PATCH', body: JSON.stringify({ feedbackData: state.taskFeedbackData, feedbackName: state.taskFeedbackName, feedbackNote: $('#task-feedback-note')?.value || '' }) }); closeDialogs(); await Promise.all([loadStudent(state.studentDate), loadStudentTaskList()]); showToast('草稿已保存，任务状态已更新'); } catch (err) { if (error) error.textContent = err.message; else showToast(err.message); } }
});
document.addEventListener('change', async event => {
  if (event.target.id === 'dashboard-student-select') { await loadParent(Number(event.target.value)); return; }
  if (event.target.id === 'assignment-category') { renderAssignmentCategoryIcon(); return; }
  if (event.target.id === 'assignment-resource-file') {
    const file = event.target.files[0]; if (!file) return; const preview = $('#assignment-resource-preview'); const error = $('#assignment-error'); error.textContent = '';
    try { state.taskResourceData = await prepareTaskResource(file); state.taskResourceName = file.name; preview.hidden = false; preview.innerHTML = `${file.type.startsWith('image/') ? `<img src="${state.taskResourceData}" alt="任务资料预览" />` : file.type.startsWith('video/') ? `<video src="${state.taskResourceData}" controls></video>` : '<span class="resource-file-icon">▧</span>'}<div><b>${escapeHtml(file.name)}</b><small>${Math.ceil(file.size / 1024)} KB</small></div><button type="button" class="icon-button" id="clear-assignment-resource" aria-label="移除任务资料" title="移除">×</button>`; }
    catch (err) { state.taskResourceData = ''; state.taskResourceName = ''; event.target.value = ''; preview.hidden = true; preview.innerHTML = ''; error.textContent = err.message; }
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
$('#assignment-form').addEventListener('submit', async event => {
  event.preventDefault(); const error = $('#assignment-error'); error.textContent = '';
  const form = event.currentTarget;
  const studentIds = $$('#assignment-students input:checked').map(input => Number(input.value));
  if (!studentIds.length) { error.textContent = '请至少选择一名学生'; return; }
  const startDate = state.assignmentDateMode === 'single' ? $('#assignment-single-date').value : $('#assignment-start-date').value;
  const endDate = state.assignmentDateMode === 'single' ? startDate : $('#assignment-end-date').value;
  if (state.assignmentDateMode === 'range' && dateSpanDays(startDate, endDate) > 30) { error.textContent = '连续日期最多可选择 30 天'; return; }
  try {
    const result = await api('/api/parent/tasks', { method: 'POST', body: JSON.stringify({ studentIds, title: $('#assignment-title').value, detail: $('#assignment-detail').value, categoryId: Number($('#assignment-category').value), duration: Number($('#assignment-duration').value), stars: Number($('#assignment-stars').value), feedbackType: $('#assignment-feedback').value, needsReview: $('#assignment-review').checked, startDate, endDate, resourceData: state.taskResourceData, resourceName: state.taskResourceName }) });
    form.reset(); state.taskResourceData = ''; state.taskResourceName = ''; $('#assignment-resource-preview').hidden = true; $('#assignment-resource-preview').innerHTML = ''; state.taskDate = startDate; state.taskStudentId = studentIds.length === 1 ? studentIds[0] : 'all'; await loadParent(); await prepareTaskManager(); setParentPage('assign'); showToast(`已创建 ${result.count} 条任务`);
  } catch (err) { error.textContent = err.message; }
});
$('#task-student-filter').addEventListener('change', async event => { state.taskStudentId = event.target.value === 'all' ? 'all' : Number(event.target.value); await loadParentTasks(); });
$('#assignment-start-date').addEventListener('change', syncAssignmentRangeLimit);
$('#custom-stats-range').addEventListener('submit', async event => { event.preventDefault(); const errorRange = $('#stats-end-date').value < $('#stats-start-date').value; if (errorRange) { showToast('结束日期不能早于开始日期'); return; } await loadStatistics('custom'); });
$('#category-form').addEventListener('submit', async event => {
  event.preventDefault(); const error = $('#category-error'); error.textContent = '';
  const id = Number($('#category-id').value || 0);
  try { await api(id ? `/api/parent/categories/${id}` : '/api/parent/categories', { method: id ? 'PATCH' : 'POST', body: JSON.stringify({ name: $('#category-name').value, icon: state.selectedCategoryIcon }) }); $('#category-dialog').close(); await loadCategories(); showToast(id ? '分类名称和图标已更新' : '任务分类已创建'); }
  catch (err) { error.textContent = err.message; }
});
$('#password-form').addEventListener('submit', async event => {
  event.preventDefault(); const error = $('#password-error'); error.textContent = '';
  try { await api('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword: $('#current-password').value, newPassword: $('#new-password').value }) }); state.user.mustChangePassword = false; $('#password-dialog').close(); event.currentTarget.reset(); showToast('密码已更新'); }
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
    setAvatar($('#student-avatar-preview'), '', '学');
    error.textContent = err.message;
  }
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
  event.preventDefault(); const error = $('#reset-parent-password-error'); error.textContent = '';
  try { await api(`/api/admin/parents/${state.activeParentId}/reset-password`, { method: 'POST', body: JSON.stringify({ password: $('#reset-parent-password').value }) }); $('#reset-parent-password-dialog').close(); event.currentTarget.reset(); showToast('家长密码已重置'); }
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
  event.preventDefault(); const error = $('#reset-student-password-error'); error.textContent = '';
  try { await api(`/api/parent/students/${state.activeStudentId}/reset-password`, { method: 'POST', body: JSON.stringify({ password: $('#reset-student-password').value }) }); $('#reset-student-password-dialog').close(); event.currentTarget.reset(); showToast('学生密码已重置，请通知孩子使用新密码登录'); }
  catch (err) { error.textContent = err.message; }
});
window.addEventListener('resize', () => { closeStudentActionMenu(); if (!state.user) return; const student = state.user.role === 'student'; $('.main-content').style.marginLeft = student && innerWidth >= 768 ? '96px' : !student && innerWidth >= 768 ? '216px' : '0'; $('.bottom-nav').style.display = student && innerWidth < 768 ? 'grid' : 'none'; });
window.addEventListener('scroll', closeStudentActionMenu, true);
(async function boot() { refreshIcons(); displayLogin(); try { const result = await api('/api/auth/me'); await startSession(result.user); } catch { await refreshCaptcha(); } })();
