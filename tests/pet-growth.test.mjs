import test from 'node:test';
import assert from 'node:assert/strict';

const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:4191';

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

test('student pet growth loop supports adoption, repeatable interactions, and task rewards', async () => {
  const playAnimation = await fetch(`${base}/assets/pets/actions/rabbit-play.mp4`);
  assert.equal(playAnimation.status, 200);
  assert.match(playAnimation.headers.get('content-type') || '', /^video\/mp4/);
  assert.equal(Buffer.from(await playAnimation.arrayBuffer()).subarray(4, 8).toString(), 'ftyp', 'play interaction uses a valid MP4 asset');

  const adminLogin = await login('admin', 'admin@2026');
  assert.equal(adminLogin.response.status, 200);
  const admin = adminLogin.cookie;
  const suffix = Date.now();
  const studentResult = await request('/api/parent/students', { cookie: admin, method: 'POST', body: JSON.stringify({ displayName: '萌宠测试学生', username: `pet_${suffix}`, password: 'Student2026A', grade: '三年级', parentIds: [] }) });
  assert.equal(studentResult.response.status, 201);
  const studentId = studentResult.body.student.id;
  const enabled = await request(`/api/parent/students/${studentId}/pet-settings`, { cookie: admin, method: 'PUT', body: JSON.stringify({ enabled: true, dailyMinutes: 10 }) });
  assert.equal(enabled.response.status, 200);
  assert.equal(enabled.body.pet.enabled, true);

  const studentLogin = await login(`pet_${suffix}`, 'Student2026A', 'student');
  assert.equal(studentLogin.response.status, 200);
  const adoption = await request('/api/student/pets/adoption', { cookie: studentLogin.cookie });
  assert.equal(adoption.body.enabled, true);
  assert.equal(adoption.body.species.length, 3);
  const adopted = await request('/api/student/pets/adopt', { cookie: studentLogin.cookie, method: 'POST', body: JSON.stringify({ speciesCode: adoption.body.species[0].code, nickname: '小星' }) });
  assert.equal(adopted.response.status, 201);
  assert.equal(adopted.body.pet.pet.nickname, '小星');

  const firstInteraction = await request('/api/student/pet/interactions', { cookie: studentLogin.cookie, method: 'POST', body: JSON.stringify({ type: 'pet', requestId: `pet-${suffix}` }) });
  assert.equal(firstInteraction.response.status, 200);
  assert.equal(firstInteraction.body.alreadyDone, false);
  assert.equal(firstInteraction.body.pet.pet.totalExp, 1);
  const duplicateInteraction = await request('/api/student/pet/interactions', { cookie: studentLogin.cookie, method: 'POST', body: JSON.stringify({ type: 'pet', requestId: `pet-duplicate-${suffix}` }) });
  assert.equal(duplicateInteraction.response.status, 200);
  assert.equal(duplicateInteraction.body.alreadyDone, false);
  assert.equal(duplicateInteraction.body.applied, true);
  assert.equal(duplicateInteraction.body.pet.pet.totalExp, 2);
  for (let index = 0; index < 2; index += 1) {
    const repeated = await request('/api/student/pet/interactions', { cookie: studentLogin.cookie, method: 'POST', body: JSON.stringify({ type: 'pet', requestId: `pet-repeat-${suffix}-${index}` }) });
    assert.equal(repeated.response.status, 200);
    assert.equal(repeated.body.applied, true);
  }
  assert.equal((await request('/api/student/pet/growth', { cookie: studentLogin.cookie })).body.pet.pet.daily.mood, 100);
  const cappedInteraction = await request('/api/student/pet/interactions', { cookie: studentLogin.cookie, method: 'POST', body: JSON.stringify({ type: 'pet', requestId: `pet-capped-${suffix}` }) });
  assert.equal(cappedInteraction.response.status, 200);
  assert.equal(cappedInteraction.body.applied, false);
  assert.equal(cappedInteraction.body.pet.pet.daily.mood, 100);

  const categories = await request('/api/parent/categories', { cookie: admin });
  const dashboard = await request('/api/parent/dashboard', { cookie: admin });
  const date = dashboard.body.period.today;
  const task = await request('/api/parent/tasks', { cookie: admin, method: 'POST', body: JSON.stringify({ studentIds: [studentId], title: '萌宠经验任务', detail: '完成即可获得经验', categoryId: categories.body.categories[0].id, duration: 10, stars: 1, feedbackType: 'none', needsReview: false, startDate: date, endDate: date }) });
  assert.equal(task.response.status, 201);
  const completed = await request(`/api/student/tasks/${task.body.taskIds[0]}/submit`, { cookie: studentLogin.cookie, method: 'POST', body: '{}' });
  assert.equal(completed.response.status, 200);
  const growth = await request('/api/student/pet/growth', { cookie: studentLogin.cookie });
  assert.equal(growth.body.pet.pet.totalExp, 29, '重复互动经验加上任务完成经验和当天完成度里程碑经验');
  assert.ok(growth.body.pet.ledger.some(item => item.sourceType === 'task_complete'));
});
