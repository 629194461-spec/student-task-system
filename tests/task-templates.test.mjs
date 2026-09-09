import test from 'node:test';
import assert from 'node:assert/strict';

const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:4183';
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

test('task templates enforce visibility, ownership, and batch assignment', async () => {
  const admin = (await login('admin', 'admin@2026')).cookie;
  const suffix = Date.now();
  const parentOneName = `template_p1_${suffix}`;
  const parentTwoName = `template_p2_${suffix}`;
  const parentOne = await request('/api/admin/parents', { cookie: admin, method: 'POST', body: JSON.stringify({ displayName: '模板家长甲', username: parentOneName, password: 'Parent2026A' }) });
  const parentTwo = await request('/api/admin/parents', { cookie: admin, method: 'POST', body: JSON.stringify({ displayName: '模板家长乙', username: parentTwoName, password: 'Parent2026B' }) });
  assert.equal(parentOne.response.status, 201);
  assert.equal(parentTwo.response.status, 201);
  const student = await request('/api/parent/students', { cookie: admin, method: 'POST', body: JSON.stringify({ displayName: '模板测试学生', username: `template_s_${suffix}`, password: 'Student2026A', avatar, grade: '三年级', parentIds: [parentTwo.body.parent.id] }) });
  assert.equal(student.response.status, 201);

  const p1 = (await login(parentOneName, 'Parent2026A')).cookie;
  const p2 = (await login(parentTwoName, 'Parent2026B')).cookie;
  const categoryId = (await request('/api/parent/categories', { cookie: p1 })).body.categories[0].id;
  const createTemplate = (cookie, title, isPublic) => request('/api/parent/task-templates', { cookie, method: 'POST', body: JSON.stringify({ title, detail: `${title}要求`, categoryId, duration: 20, stars: 2, feedbackType: 'none', needsReview: false, isPublic }) });
  const shared = await createTemplate(p1, '公开阅读模板', true);
  const privateTemplate = await createTemplate(p1, '私有阅读模板', false);
  const own = await createTemplate(p2, '乙的私有模板', false);
  assert.equal(shared.response.status, 201);
  assert.equal(privateTemplate.response.status, 201);
  assert.equal(own.response.status, 201);

  const p2Templates = await request('/api/parent/task-templates', { cookie: p2 });
  assert.deepEqual(new Set(p2Templates.body.templates.map(item => item.id)), new Set([shared.body.template.id, own.body.template.id]));
  assert.equal(p2Templates.body.templates.find(item => item.id === shared.body.template.id).isOwner, false);
  assert.equal(p2Templates.body.templates.find(item => item.id === own.body.template.id).isOwner, true);

  const forbiddenEdit = await request(`/api/parent/task-templates/${shared.body.template.id}`, { cookie: p2, method: 'PATCH', body: JSON.stringify({ title: '越权修改', categoryId, duration: 10, stars: 1 }) });
  const forbiddenDelete = await request(`/api/parent/task-templates/${shared.body.template.id}`, { cookie: p2, method: 'DELETE' });
  assert.equal(forbiddenEdit.response.status, 403);
  assert.equal(forbiddenDelete.response.status, 403);
  const ownUpdated = await request(`/api/parent/task-templates/${own.body.template.id}`, { cookie: p2, method: 'PATCH', body: JSON.stringify({ title: '乙的模板更新', detail: '更新后的要求', categoryId, duration: 25, stars: 3, feedbackType: 'none', needsReview: false, isPublic: false }) });
  assert.equal(ownUpdated.response.status, 200);
  assert.equal(ownUpdated.body.template.title, '乙的模板更新');
  const forbiddenUse = await request('/api/parent/task-templates/assign', { cookie: p2, method: 'POST', body: JSON.stringify({ templateIds: [privateTemplate.body.template.id], studentIds: [student.body.student.id], startDate: '2026-09-10', endDate: '2026-09-10' }) });
  assert.equal(forbiddenUse.response.status, 403);

  const startDate = '2026-09-10';
  const endDate = addDays(startDate, 1);
  const assigned = await request('/api/parent/task-templates/assign', { cookie: p2, method: 'POST', body: JSON.stringify({ templateIds: [shared.body.template.id, own.body.template.id], studentIds: [student.body.student.id], startDate, endDate }) });
  assert.equal(assigned.response.status, 201);
  assert.equal(assigned.body.count, 4);
  const dayOne = await request(`/api/parent/tasks?studentId=${student.body.student.id}&date=${startDate}`, { cookie: p2 });
  const dayTwo = await request(`/api/parent/tasks?studentId=${student.body.student.id}&date=${endDate}`, { cookie: p2 });
  assert.deepEqual(new Set(dayOne.body.tasks.map(task => task.title)), new Set(['公开阅读模板', '乙的模板更新']));
  assert.equal(dayTwo.body.tasks.length, 2);
  const ownDeleted = await request(`/api/parent/task-templates/${own.body.template.id}`, { cookie: p2, method: 'DELETE' });
  assert.equal(ownDeleted.response.status, 204);
  const tasksAfterTemplateDelete = await request(`/api/parent/tasks?studentId=${student.body.student.id}&date=${startDate}`, { cookie: p2 });
  assert.equal(tasksAfterTemplateDelete.body.tasks.length, 2, 'deleting a template must not delete assigned tasks');
});
