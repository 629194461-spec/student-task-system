import test from 'node:test';
import assert from 'node:assert/strict';

const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:4182';

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

test('reading dashboard tracks monthly check-ins and enforces each book daily limits', async () => {
  const adminLogin = await login('admin', 'admin@2026');
  assert.equal(adminLogin.response.status, 200);
  const admin = adminLogin.cookie;
  const suffix = Date.now();
  const studentResult = await request('/api/parent/students', { cookie: admin, method: 'POST', body: JSON.stringify({ displayName: '阅读测试学生', username: `reading_student_${suffix}`, password: 'Student2026A', grade: '三年级', parentIds: [] }) });
  assert.equal(studentResult.response.status, 201);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const createBook = title => request('/api/parent/reading/books', { cookie: admin, method: 'POST', body: JSON.stringify({ title, totalPages: 20 }) });
  const firstBook = await createBook(`阅读测试书一${suffix}`);
  const secondBook = await createBook(`阅读测试书二${suffix}`);
  const thirdBook = await createBook(`阅读测试书三${suffix}`);
  const unusedBook = await createBook(`阅读测试书架${suffix}`);
  assert.equal(firstBook.response.status, 201);
  assert.equal(secondBook.response.status, 201);
  assert.equal(thirdBook.response.status, 201);
  assert.equal(unusedBook.response.status, 201);
  const otherParentCreate = await request('/api/admin/parents', { cookie: admin, method: 'POST', body: JSON.stringify({ displayName: '书架范围测试家长', username: `reading_parent_${suffix}`, password: 'Parent2026A' }) });
  assert.equal(otherParentCreate.response.status, 201);
  const otherParentLogin = await login(`reading_parent_${suffix}`, 'Parent2026A');
  assert.equal(otherParentLogin.response.status, 200);
  const otherBook = await request('/api/parent/reading/books', { cookie: otherParentLogin.cookie, method: 'POST', body: JSON.stringify({ title: `其他家长书籍${suffix}`, totalPages: 100 }) });
  assert.equal(otherBook.response.status, 201);
  const adminShelf = await request('/api/parent/reading/books', { cookie: admin });
  assert.equal(adminShelf.body.books.some(book => book.id === otherBook.body.book.id), false);
  const otherParentShelf = await request('/api/parent/reading/books', { cookie: otherParentLogin.cookie });
  assert.deepEqual(otherParentShelf.body.books.map(book => book.id), [otherBook.body.book.id]);
  const updatedBook = await request(`/api/parent/reading/books/${unusedBook.body.book.id}`, { cookie: admin, method: 'PATCH', body: JSON.stringify({ title: `阅读测试书架已修改${suffix}`, totalPages: 30 }) });
  assert.equal(updatedBook.response.status, 200);
  assert.equal(updatedBook.body.book.title, `阅读测试书架已修改${suffix}`);
  const deletedBook = await request(`/api/parent/reading/books/${unusedBook.body.book.id}`, { cookie: admin, method: 'DELETE' });
  assert.equal(deletedBook.response.status, 204);
  const createPlan = (bookId, needsReview = true) => request('/api/parent/reading/plans', { cookie: admin, method: 'POST', body: JSON.stringify({ bookId, studentIds: [studentResult.body.student.id], startDate: today, startPage: 1, targetPages: 2, frequency: 'daily', weekdays: [], stars: 2, feedbackType: 'none', needsReview }) });
  const firstPlan = await createPlan(firstBook.body.book.id);
  const secondPlan = await createPlan(secondBook.body.book.id);
  const thirdPlan = await createPlan(thirdBook.body.book.id, false);
  assert.equal(firstPlan.response.status, 201);
  assert.equal(secondPlan.response.status, 201);
  assert.equal(thirdPlan.response.status, 201);
  const updatedActiveBook = await request(`/api/parent/reading/books/${firstBook.body.book.id}`, { cookie: admin, method: 'PATCH', body: JSON.stringify({ title: `阅读测试书一已修改${suffix}`, totalPages: 20 }) });
  assert.equal(updatedActiveBook.response.status, 200);
  assert.equal(updatedActiveBook.body.book.title, `阅读测试书一已修改${suffix}`);
  const protectedBook = await request(`/api/parent/reading/books/${firstBook.body.book.id}`, { cookie: admin, method: 'DELETE' });
  assert.equal(protectedBook.response.status, 409);
  const updatedPlan = await request(`/api/parent/reading/plans/${firstPlan.body.plans[0].id}`, { cookie: admin, method: 'PATCH', body: JSON.stringify({ startDate: today, endDate: '', targetPages: 3, targetMinutes: 0, frequency: 'daily', weekdays: [], stars: 3, feedbackType: 'none', needsReview: true }) });
  assert.equal(updatedPlan.response.status, 200);
  assert.equal(updatedPlan.body.plan.targetPages, 3);
  const studentLogin = await login(`reading_student_${suffix}`, 'Student2026A', 'student');
  assert.equal(studentLogin.response.status, 200);
  const month = today.slice(0, 7);
  const initial = await request(`/api/student/reading?month=${month}`, { cookie: studentLogin.cookie });
  assert.equal(initial.response.status, 200);
  assert.equal(initial.body.month, month);
  assert.equal(initial.body.cards.length, 3);
  assert.ok(initial.body.cards.every(card => card.dailyLimit.remaining === 3));
  const submitted = await request('/api/student/reading/checkins', { cookie: studentLogin.cookie, method: 'POST', body: JSON.stringify({ planId: firstPlan.body.plans[0].id, checkinDate: today, endPage: 2, reflection: '今天读得很开心' }) });
  assert.equal(submitted.response.status, 201);
  const updated = await request(`/api/student/reading?month=${month}`, { cookie: studentLogin.cookie });
  assert.ok(updated.body.checkinDates.includes(today));
  const firstCard = updated.body.cards.find(card => card.plan.id === firstPlan.body.plans[0].id);
  assert.equal(firstCard.dailyLimit.hasPending, true);
  assert.equal(firstCard.dailyLimit.remaining, 2);
  const blocked = await request('/api/student/reading/checkins', { cookie: studentLogin.cookie, method: 'POST', body: JSON.stringify({ planId: firstPlan.body.plans[0].id, checkinDate: today, endPage: 4 }) });
  assert.equal(blocked.response.status, 409);
  assert.match(blocked.body.error, /待审核/);
  const otherBookCheckin = await request('/api/student/reading/checkins', { cookie: studentLogin.cookie, method: 'POST', body: JSON.stringify({ planId: secondPlan.body.plans[0].id, checkinDate: today, endPage: 2 }) });
  assert.equal(otherBookCheckin.response.status, 201, 'pending review for one book does not block another book');
  for (const endPage of [2, 4, 6]) {
    const result = await request('/api/student/reading/checkins', { cookie: studentLogin.cookie, method: 'POST', body: JSON.stringify({ planId: thirdPlan.body.plans[0].id, checkinDate: today, endPage }) });
    assert.equal(result.response.status, 201);
  }
  const overLimit = await request('/api/student/reading/checkins', { cookie: studentLogin.cookie, method: 'POST', body: JSON.stringify({ planId: thirdPlan.body.plans[0].id, checkinDate: today, endPage: 8 }) });
  assert.equal(overLimit.response.status, 409);
  assert.match(overLimit.body.error, /最多提交 3 次/);
  const archivedPlan = await request(`/api/parent/reading/plans/${thirdPlan.body.plans[0].id}`, { cookie: admin, method: 'DELETE' });
  assert.equal(archivedPlan.response.status, 204);
  const afterArchive = await request(`/api/student/reading?month=${month}`, { cookie: studentLogin.cookie });
  assert.equal(afterArchive.body.cards.some(card => card.plan.id === thirdPlan.body.plans[0].id), false);
});
