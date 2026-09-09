import test from 'node:test';
import assert from 'node:assert/strict';

const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:4182';
const avatar = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

async function request(path, { cookie, ...options } = {}) {
  const response = await fetch(`${base}${path}`, { ...options, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(options.headers || {}) } });
  const body = response.status === 204 ? {} : await response.json();
  return { response, body, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}

async function login(username, password, role = 'parent') {
  const captcha = await request('/api/auth/captcha');
  const answer = [...captcha.body.svg.matchAll(/<text[^>]*>([^<]+)<\/text>/g)].map(match => match[1]).join('');
  return request('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password, role, captchaId: captcha.body.id, captcha: answer }) });
}

function addDays(value, days) {
  const date = new Date(`${value}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10);
}

test('student tasks and parent dashboard use persisted scoped data', async () => {
  const adminLogin = await login('admin', 'admin@2026');
  assert.equal(adminLogin.response.status, 200);
  const admin = adminLogin.cookie;

  const initialStudents = await request('/api/parent/students', { cookie: admin });
  assert.equal(initialStudents.body.students.length, 0, 'fresh installations must not contain demo students');

  const suffix = Date.now();
  const createStudent = async (displayName, username) => request('/api/parent/students', {
    cookie: admin,
    method: 'POST',
    body: JSON.stringify({ displayName, username, password: 'Student2026A', avatar, grade: '三年级', parentIds: [] })
  });
  const first = await createStudent('测试学生甲', `task_a_${suffix}`);
  const second = await createStudent('测试学生乙', `task_b_${suffix}`);
  assert.equal(first.response.status, 201);
  assert.equal(second.response.status, 201);
  const firstId = first.body.student.id;
  const secondId = second.body.student.id;

  const categories = await request('/api/parent/categories', { cookie: admin });
  const categoryId = categories.body.categories[0].id;
  const dashboard = await request('/api/parent/dashboard', { cookie: admin, method: 'GET' });
  const currentDate = dashboard.body.period.today;
  const assign = async (studentId, title, date, needsReview = true) => request('/api/parent/tasks', {
    cookie: admin,
    method: 'POST',
    body: JSON.stringify({ studentIds: [studentId], title, detail: '真实接口测试', categoryId, duration: 10, stars: 2, feedbackType: 'none', needsReview, startDate: date, endDate: date })
  });

  const draftTask = await assign(firstId, '草稿任务', currentDate);
  const completedTask = await assign(firstId, '直接完成任务', currentDate, false);
  const futureTask = await assign(firstId, '未来任务', addDays(currentDate, 1));
  const otherTask = await assign(secondId, '另一学生任务', currentDate);
  for (const result of [draftTask, completedTask, futureTask, otherTask]) assert.equal(result.response.status, 201);

  const firstLogin = await login(`task_a_${suffix}`, 'Student2026A', 'student');
  const secondLogin = await login(`task_b_${suffix}`, 'Student2026A', 'student');
  assert.equal(firstLogin.response.status, 200);
  assert.equal(secondLogin.response.status, 200);

  const draftId = draftTask.body.taskIds[0];
  const studentDetailBeforeStart = await request(`/api/student/tasks/${draftId}`, { cookie: firstLogin.cookie });
  assert.equal(studentDetailBeforeStart.response.status, 200);
  assert.equal(studentDetailBeforeStart.body.task.status, 'not_started', 'viewing details must not start a task');
  const parentDetail = await request(`/api/parent/tasks/${draftId}`, { cookie: admin });
  assert.equal(parentDetail.response.status, 200);
  assert.equal(parentDetail.body.task.id, draftId);
  assert.equal(parentDetail.body.task.studentName, '测试学生甲');
  const detailParentName = `detail_parent_${suffix}`;
  const detailParent = await request('/api/admin/parents', { cookie: admin, method: 'POST', body: JSON.stringify({ displayName: '详情测试家长', username: detailParentName, password: 'Parent2026A' }) });
  assert.equal(detailParent.response.status, 201);
  assert.equal((await request(`/api/admin/students/${firstId}/parents`, { cookie: admin, method: 'POST', body: JSON.stringify({ parentId: detailParent.body.parent.id }) })).response.status, 200);
  const detailParentLogin = await login(detailParentName, 'Parent2026A');
  assert.equal((await request(`/api/parent/tasks/${draftId}`, { cookie: detailParentLogin.cookie })).response.status, 200);
  assert.equal((await request(`/api/parent/tasks/${otherTask.body.taskIds[0]}`, { cookie: detailParentLogin.cookie })).response.status, 403);
  const started = await request(`/api/student/tasks/${draftId}/draft`, { cookie: firstLogin.cookie, method: 'PATCH', body: JSON.stringify({ feedbackNote: '已经完成一半' }) });
  assert.equal(started.response.status, 200);
  assert.equal(started.body.task.status, 'in_progress');
  assert.equal(started.body.task.feedbackNote, '已经完成一半');
  assert.ok(started.body.task.startedAt);
  const edited = await request(`/api/parent/tasks/${draftId}`, { cookie: admin, method: 'PATCH', body: JSON.stringify({ studentId: firstId, title: '修改后的草稿任务', detail: '家长已调整要求', categoryId, duration: 20, stars: 3, feedbackType: 'none', needsReview: true, date: currentDate }) });
  assert.equal(edited.response.status, 200);
  assert.equal(edited.body.task.title, '修改后的草稿任务');
  assert.equal(edited.body.task.duration, 20);
  assert.equal(edited.body.task.stars, 3);
  assert.equal(edited.body.task.status, 'in_progress');
  const detail = await request(`/api/student/tasks/${draftId}`, { cookie: firstLogin.cookie });
  assert.equal(detail.body.task.feedbackNote, '已经完成一半');

  const pending = await request(`/api/student/tasks/${draftId}/submit`, { cookie: firstLogin.cookie, method: 'POST', body: JSON.stringify({ feedbackNote: '已完成' }) });
  assert.equal(pending.body.task.status, 'pending_review');
  const editPending = await request(`/api/parent/tasks/${draftId}`, { cookie: admin, method: 'PATCH', body: JSON.stringify({ studentId: firstId, title: '不应保存', categoryId, duration: 10, stars: 1, feedbackType: 'none', needsReview: true, date: currentDate }) });
  assert.equal(editPending.response.status, 409);
  const completedId = completedTask.body.taskIds[0];
  const completed = await request(`/api/student/tasks/${completedId}/submit`, { cookie: firstLogin.cookie, method: 'POST', body: '{}' });
  assert.equal(completed.body.task.status, 'completed');
  const editCompleted = await request(`/api/parent/tasks/${completedId}`, { cookie: admin, method: 'PATCH', body: JSON.stringify({ studentId: firstId, title: '不应保存', categoryId, duration: 10, stars: 1, feedbackType: 'none', needsReview: false, date: currentDate }) });
  assert.equal(editCompleted.response.status, 409);
  const otherId = otherTask.body.taskIds[0];
  await request(`/api/student/tasks/${otherId}/submit`, { cookie: secondLogin.cookie, method: 'POST', body: '{}' });

  const pendingList = await request('/api/student/tasks?filter=pending_review', { cookie: firstLogin.cookie });
  const completedList = await request('/api/student/tasks?filter=completed', { cookie: firstLogin.cookie });
  const futureList = await request('/api/student/tasks?filter=future', { cookie: firstLogin.cookie });
  assert.deepEqual(pendingList.body.tasks.map(task => task.id), [draftId]);
  assert.ok(completedList.body.tasks.some(task => task.id === completedId));
  assert.ok(futureList.body.tasks.some(task => task.id === futureTask.body.taskIds[0]));

  const firstDashboard = await request(`/api/parent/dashboard?studentId=${firstId}`, { cookie: admin });
  const secondDashboard = await request(`/api/parent/dashboard?studentId=${secondId}`, { cookie: admin });
  assert.equal(firstDashboard.body.summary.pending, 1);
  assert.ok(firstDashboard.body.pending.every(task => task.studentId === firstId));
  assert.equal(secondDashboard.body.summary.pending, 1);
  assert.ok(secondDashboard.body.pending.every(task => task.studentId === secondId));
});
