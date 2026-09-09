import test from 'node:test';
import assert from 'node:assert/strict';

const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:4181';
const avatar = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

async function request(path, { cookie, ...options } = {}) {
  const response = await fetch(`${base}${path}`, { ...options, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(options.headers || {}) } });
  const body = response.status === 204 ? {} : await response.json();
  return { response, body, cookie: response.headers.get('set-cookie')?.split(';')[0], setCookie: response.headers.get('set-cookie') || '' };
}

async function login(username, password, role = 'parent', rememberMe = false) {
  const captcha = await request('/api/auth/captcha');
  const answer = [...captcha.body.svg.matchAll(/<text[^>]*>([^<]+)<\/text>/g)].map(match => match[1]).join('');
  return request('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password, role, captchaId: captcha.body.id, captcha: answer, rememberMe }) });
}

test('admin manages parent accounts and parent-student visibility', async () => {
  const adminLogin = await login('admin', 'admin@2026', 'parent', true);
  assert.equal(adminLogin.response.status, 200);
  assert.match(adminLogin.setCookie, /Max-Age=2592000/);
  const admin = adminLogin.cookie;

  const suffix = Date.now();
  const categoryCreate = await request('/api/parent/categories', { cookie: admin, method: 'POST', body: JSON.stringify({ name: `测试分类${suffix}`, icon: 'assets/category-icons/science-flask.png' }) });
  assert.equal(categoryCreate.response.status, 201);
  const categoryId = categoryCreate.body.category.id;
  const categoryUpdate = await request(`/api/parent/categories/${categoryId}`, { cookie: admin, method: 'PATCH', body: JSON.stringify({ name: `测试分类新${suffix}`, icon: 'assets/category-icons/art-palette.png' }) });
  assert.equal(categoryUpdate.response.status, 200);

  const p1Name = `p1_${suffix}`; const p2Name = `p2_${suffix}`; const studentName = `s_${suffix}`;
  const p1Create = await request('/api/admin/parents', { cookie: admin, method: 'POST', body: JSON.stringify({ displayName: '测试家长甲', username: p1Name, password: 'Parent2026A' }) });
  assert.equal(p1Create.response.status, 201);
  assert.equal(p1Create.body.parent.avatar, '甲');
  const p1Id = p1Create.body.parent.id;
  const p2Create = await request('/api/admin/parents', { cookie: admin, method: 'POST', body: JSON.stringify({ displayName: '测试家长乙', username: p2Name, password: 'Parent2026B', avatar }) });
  assert.equal(p2Create.response.status, 201);
  const p2Id = p2Create.body.parent.id;

  const immutableUsername = await request(`/api/admin/parents/${p1Id}`, { cookie: admin, method: 'PATCH', body: JSON.stringify({ displayName: '测试家长甲新', username: `changed_${suffix}` }) });
  assert.equal(immutableUsername.response.status, 200);
  assert.equal(immutableUsername.body.parent.username, p1Name);
  assert.equal(immutableUsername.body.parent.avatar, '新');

  const duplicateAcrossRoles = await request('/api/parent/students', { cookie: admin, method: 'POST', body: JSON.stringify({ displayName: '重复账号', username: p1Name, password: 'Student2026A', avatar, grade: '四年级' }) });
  assert.equal(duplicateAcrossRoles.response.status, 409);
  const studentCreate = await request('/api/parent/students', { cookie: admin, method: 'POST', body: JSON.stringify({ displayName: '测试学生', username: studentName, password: 'Student2026A', avatar, grade: '四年级', parentIds: [p1Id, p2Id] }) });
  assert.equal(studentCreate.response.status, 201);
  const studentId = studentCreate.body.student.id;
  assert.deepEqual(new Set(studentCreate.body.student.parents.map(parent => parent.id)), new Set([p1Id, p2Id]));
  const immutableStudentUsername = await request(`/api/parent/students/${studentId}`, { cookie: admin, method: 'PATCH', body: JSON.stringify({ displayName: '测试学生新', username: `changed_student_${suffix}`, avatar, grade: '四年级', note: '' }) });
  assert.equal(immutableStudentUsername.response.status, 200);
  assert.equal(immutableStudentUsername.body.student.username, studentName);

  const p1Login = await login(p1Name, 'Parent2026A');
  assert.equal(p1Login.response.status, 200);
  const forbidden = await request('/api/admin/parents', { cookie: p1Login.cookie });
  assert.equal(forbidden.response.status, 403);
  const p1Students = await request('/api/parent/students', { cookie: p1Login.cookie });
  assert.deepEqual(p1Students.body.students.map(student => student.id), [studentId]);
  const parentCategories = await request('/api/parent/categories', { cookie: p1Login.cookie });
  assert.equal(parentCategories.response.status, 200);
  assert.ok(parentCategories.body.categories.some(category => category.id === categoryId));
  assert.equal((await request('/api/parent/categories', { cookie: p1Login.cookie, method: 'POST', body: JSON.stringify({ name: `越权新增${suffix}`, icon: 'assets/category-icons/music-note.png' }) })).response.status, 403);
  assert.equal((await request(`/api/parent/categories/${categoryId}`, { cookie: p1Login.cookie, method: 'PATCH', body: JSON.stringify({ name: `越权修改${suffix}`, icon: 'assets/category-icons/music-note.png' }) })).response.status, 403);
  assert.equal((await request(`/api/parent/categories/${categoryId}`, { cookie: p1Login.cookie, method: 'DELETE' })).response.status, 403);
  assert.equal((await request(`/api/parent/categories/${categoryId}`, { cookie: admin, method: 'DELETE' })).response.status, 204);

  const unlinked = await request(`/api/parent/students/${studentId}/parents/${p1Id}`, { cookie: p1Login.cookie, method: 'DELETE' });
  assert.equal(unlinked.response.status, 204);
  const afterUnlink = await request('/api/parent/students', { cookie: p1Login.cookie });
  assert.equal(afterUnlink.body.students.length, 0);
  const parentCannotRelink = await request(`/api/admin/students/${studentId}/parents`, { cookie: p1Login.cookie, method: 'POST', body: JSON.stringify({ parentId: p1Id }) });
  assert.equal(parentCannotRelink.response.status, 403);

  const p2Login = await login(p2Name, 'Parent2026B');
  const p2Students = await request('/api/parent/students', { cookie: p2Login.cookie });
  assert.deepEqual(p2Students.body.students.map(student => student.id), [studentId]);
  const p2Stats = await request('/api/parent/statistics?period=week', { cookie: p2Login.cookie });
  assert.deepEqual(p2Stats.body.students.map(student => student.studentId), [studentId]);
  assert.equal(p2Stats.body.students[0].total, 0);
  assert.equal(p2Stats.body.students[0].completionRate, null);
  assert.equal(p2Stats.body.students[0].onTimeRate, null);
  assert.equal(p2Stats.body.summary.completionRate, null);
  const p1Stats = await request('/api/parent/statistics?period=week', { cookie: p1Login.cookie });
  assert.equal(p1Stats.body.students.length, 0);
  const relinked = await request(`/api/admin/students/${studentId}/parents`, { cookie: admin, method: 'POST', body: JSON.stringify({ parentId: p1Id }) });
  assert.equal(relinked.response.status, 200);

  const disabled = await request(`/api/admin/parents/${p2Id}/status`, { cookie: admin, method: 'PATCH', body: JSON.stringify({ active: false }) });
  assert.equal(disabled.response.status, 200);
  assert.equal((await login(p2Name, 'Parent2026B')).response.status, 401);
  await request(`/api/admin/parents/${p2Id}/status`, { cookie: admin, method: 'PATCH', body: JSON.stringify({ active: true }) });
  await request(`/api/admin/parents/${p2Id}/reset-password`, { cookie: admin, method: 'POST', body: JSON.stringify({ password: 'NewParent2026' }) });
  assert.equal((await login(p2Name, 'Parent2026B')).response.status, 401);
  assert.equal((await login(p2Name, 'NewParent2026')).response.status, 200);
});
