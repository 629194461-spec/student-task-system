import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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
  const assign = async (studentId, title, date, needsReview = true, resources = []) => request('/api/parent/tasks', {
    cookie: admin,
    method: 'POST',
    body: JSON.stringify({ studentIds: [studentId], title, detail: '真实接口测试', categoryId, duration: 10, stars: 2, feedbackType: 'none', needsReview, startDate: date, endDate: date, resources })
  });

  const parentFile = { name: '家长学习资料.txt', data: 'data:text/plain;base64,5rWL6K+V' };
  const draftTask = await assign(firstId, '草稿任务', currentDate, true, [parentFile]);
  const completedTask = await assign(firstId, '直接完成任务', currentDate, false);
  const futureTask = await assign(firstId, '未来任务', addDays(currentDate, 1));
  const otherTask = await assign(secondId, '另一学生任务', currentDate);
  for (const result of [draftTask, completedTask, futureTask, otherTask]) assert.equal(result.response.status, 201);

  const firstLogin = await login(`task_a_${suffix}`, 'Student2026A', 'student');
  const secondLogin = await login(`task_b_${suffix}`, 'Student2026A', 'student');
  assert.equal(firstLogin.response.status, 200);
  assert.equal(secondLogin.response.status, 200);

  const studentWeek = await request(`/api/student/dashboard?date=${currentDate}`, { cookie: firstLogin.cookie });
  assert.equal(Object.keys(studentWeek.body.weekTasks).length, 7);
  assert.ok(studentWeek.body.weekTasks[currentDate].some(task => task.title === '草稿任务'));
  assert.ok(studentWeek.body.weekTasks[addDays(currentDate, 1)].some(task => task.title === '未来任务'));
  assert.ok(!studentWeek.body.incompleteTaskDates.includes(currentDate), 'today\'s unfinished tasks are not overdue reminders');
  assert.ok(!studentWeek.body.incompleteTaskDates.includes(addDays(currentDate, 1)), 'future tasks are not overdue reminders');
  const parentWeek = await request(`/api/parent/tasks?date=${currentDate}&studentId=${firstId}`, { cookie: admin });
  assert.equal(Object.keys(parentWeek.body.weekTasks).length, 7);
  assert.ok(parentWeek.body.weekTasks[currentDate].some(task => task.title === '草稿任务'));
  assert.ok(parentWeek.body.weekTasks[addDays(currentDate, 1)].some(task => task.title === '未来任务'));
  assert.ok(!parentWeek.body.incompleteTaskDates.includes(currentDate), 'parent date controls only receive overdue task markers');

  const draftId = draftTask.body.taskIds[0];
  const studentDetailBeforeStart = await request(`/api/student/tasks/${draftId}`, { cookie: firstLogin.cookie });
  assert.equal(studentDetailBeforeStart.response.status, 200);
  assert.equal(studentDetailBeforeStart.body.task.status, 'not_started', 'viewing details must not start a task');
  assert.equal(studentDetailBeforeStart.body.task.resources[0].name, parentFile.name);
  const parentFileUrl = studentDetailBeforeStart.body.task.resources[0].data;
  assert.match(parentFileUrl, /^\/uploads\//, 'student detail must include a storage URL, not Base64');
  const parentFileDownload = await fetch(`${base}${parentFileUrl}`);
  assert.equal(parentFileDownload.status, 200);
  assert.equal(Buffer.from(await parentFileDownload.arrayBuffer()).toString('base64'), parentFile.data.split(',')[1]);
  const parentDetail = await request(`/api/parent/tasks/${draftId}`, { cookie: admin });
  assert.equal(parentDetail.response.status, 200);
  assert.equal(parentDetail.body.task.id, draftId);
  assert.equal(parentDetail.body.task.studentName, '测试学生甲');
  const parentEditMetadata = await request(`/api/parent/tasks/${draftId}?includeData=0`, { cookie: admin });
  assert.equal(parentEditMetadata.response.status, 200);
  assert.equal(parentEditMetadata.body.task.resources[0].id > 0, true);
  assert.equal(Object.hasOwn(parentEditMetadata.body.task.resources[0], 'data'), false, 'edit metadata must not download attachment bodies');
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
  const movedSingleDate = addDays(currentDate, 2);
  const edited = await request(`/api/parent/tasks/${draftId}`, { cookie: admin, method: 'PATCH', body: JSON.stringify({ studentId: firstId, title: '修改后的草稿任务', detail: '家长已调整要求', categoryId, duration: 20, stars: 3, feedbackType: 'none', needsReview: true, date: movedSingleDate }) });
  assert.equal(edited.response.status, 200);
  assert.equal(edited.body.task.title, '修改后的草稿任务');
  assert.equal(edited.body.task.duration, 20);
  assert.equal(edited.body.task.stars, 3);
  assert.equal(edited.body.task.status, 'in_progress');
  assert.equal(edited.body.task.date, movedSingleDate, 'a parent can move an unfinished single-date task');
  const detail = await request(`/api/student/tasks/${draftId}`, { cookie: firstLogin.cookie });
  assert.equal(detail.body.task.feedbackNote, '已经完成一半');
  assert.equal(detail.body.task.resources[0].data, parentFileUrl, 'editing task fields must preserve unchanged attachment URLs');

  const pending = await request(`/api/student/tasks/${draftId}/submit`, { cookie: firstLogin.cookie, method: 'POST', body: JSON.stringify({ feedbackData: avatar, feedbackName: '学习成果.png', feedbackNote: '已完成' }) });
  assert.equal(pending.body.task.status, 'pending_review');
  const submittedDetail = await request(`/api/parent/tasks/${draftId}`, { cookie: admin });
  assert.equal(submittedDetail.body.task.feedbackName, '学习成果.png');
  assert.match(submittedDetail.body.task.feedbackData, /^\/uploads\//, 'parent detail must include a stored student feedback URL');
  assert.equal((await fetch(`${base}${submittedDetail.body.task.feedbackData}`)).status, 200);
  const editPending = await request(`/api/parent/tasks/${draftId}`, { cookie: admin, method: 'PATCH', body: JSON.stringify({ studentId: firstId, title: '不应保存', categoryId, duration: 10, stars: 1, feedbackType: 'none', needsReview: true, date: currentDate }) });
  assert.equal(editPending.response.status, 409);
  const completedId = completedTask.body.taskIds[0];
  const completed = await request(`/api/student/tasks/${completedId}/submit`, { cookie: firstLogin.cookie, method: 'POST', body: '{}' });
  assert.equal(completed.body.task.status, 'completed');
  const editCompleted = await request(`/api/parent/tasks/${completedId}`, { cookie: admin, method: 'PATCH', body: JSON.stringify({ studentId: firstId, title: '不应保存', categoryId, duration: 10, stars: 1, feedbackType: 'none', needsReview: false, date: currentDate }) });
  assert.equal(editCompleted.response.status, 409);
  const otherId = otherTask.body.taskIds[0];
  await request(`/api/student/tasks/${otherId}/submit`, { cookie: secondLogin.cookie, method: 'POST', body: '{}' });

  const sortNotStartedOlder = await assign(firstId, '排序-未开始-较早创建', currentDate, true);
  const sortNotStartedNewer = await assign(firstId, '排序-未开始-较晚创建', currentDate, true);
  const sortPending = await assign(firstId, '排序-待审核', currentDate, true);
  const sortCompleted = await assign(firstId, '排序-已完成', currentDate, false);
  for (const result of [sortNotStartedOlder, sortNotStartedNewer, sortPending, sortCompleted]) assert.equal(result.response.status, 201);
  assert.equal((await request(`/api/student/tasks/${sortPending.body.taskIds[0]}/submit`, { cookie: firstLogin.cookie, method: 'POST', body: '{}' })).body.task.status, 'pending_review');
  assert.equal((await request(`/api/student/tasks/${sortCompleted.body.taskIds[0]}/submit`, { cookie: firstLogin.cookie, method: 'POST', body: '{}' })).body.task.status, 'completed');
  const expectedSortIds = [sortNotStartedNewer, sortNotStartedOlder, sortPending, sortCompleted].map(result => result.body.taskIds[0]);
  const sortedStudentDashboard = await request(`/api/student/dashboard?date=${currentDate}`, { cookie: firstLogin.cookie });
  assert.deepEqual(sortedStudentDashboard.body.tasks.filter(task => expectedSortIds.includes(task.id)).map(task => task.id), expectedSortIds, 'student dashboard orders active tasks first, then pending review, then completed');
  const sortedParentTasks = await request(`/api/parent/tasks?date=${currentDate}&studentId=${firstId}`, { cookie: admin });
  assert.deepEqual(sortedParentTasks.body.tasks.filter(task => expectedSortIds.includes(task.id)).map(task => task.id), expectedSortIds, 'parent task assignment uses the same status and creation order');
  const sortedStudentTodo = await request('/api/student/tasks?filter=todo', { cookie: firstLogin.cookie });
  assert.deepEqual(sortedStudentTodo.body.tasks.filter(task => [sortNotStartedNewer.body.taskIds[0], sortNotStartedOlder.body.taskIds[0]].includes(task.id)).map(task => task.id), expectedSortIds.slice(0, 2), 'tasks in the same active state are newest first');

  const pendingList = await request('/api/student/tasks?filter=pending_review', { cookie: firstLogin.cookie });
  const completedList = await request('/api/student/tasks?filter=completed', { cookie: firstLogin.cookie });
  const futureList = await request('/api/student/tasks?filter=future', { cookie: firstLogin.cookie });
  const pendingDraft = pendingList.body.tasks.find(task => task.id === draftId);
  assert.ok(pendingDraft);
  assert.equal(pendingDraft.resourceName, parentFile.name);
  assert.equal(pendingDraft.resourceCount, 1);
  assert.ok(completedList.body.tasks.some(task => task.id === completedId));
  assert.ok(futureList.body.tasks.some(task => task.id === futureTask.body.taskIds[0]));

  const firstDashboard = await request(`/api/parent/dashboard?studentId=${firstId}`, { cookie: admin });
  const secondDashboard = await request(`/api/parent/dashboard?studentId=${secondId}`, { cookie: admin });
  assert.equal(firstDashboard.body.summary.pending, 2);
  assert.ok(firstDashboard.body.pending.every(task => task.studentId === firstId));
  assert.equal(firstDashboard.body.pending.find(task => task.id === draftId).resourceName, parentFile.name);
  assert.equal(secondDashboard.body.summary.pending, 1);
  assert.ok(secondDashboard.body.pending.every(task => task.studentId === secondId));
  const reviewList = await request('/api/parent/reviews?studentId=all&period=all', { cookie: admin });
  const draftReview = reviewList.body.reviews.find(task => task.id === draftId);
  assert.equal(draftReview.resourceName, parentFile.name);
  assert.equal(draftReview.resourceCount, 1);

  const recurring = await request('/api/parent/tasks', {
    cookie: admin,
    method: 'POST',
    body: JSON.stringify({ studentIds: [firstId], title: '每日阅读', detail: '重复任务测试', categoryId, duration: 15, stars: 1, feedbackType: 'none', needsReview: true, scheduleType: 'repeat', repeatPattern: 'daily', startDate: currentDate, endDate: addDays(currentDate, 2) })
  });
  assert.equal(recurring.response.status, 201);
  assert.equal(recurring.body.taskIds.length, 3);
  const recurringDetails = [];
  for (const id of recurring.body.taskIds) recurringDetails.push((await request(`/api/parent/tasks/${id}`, { cookie: admin })).body.task);
  assert.ok(recurringDetails.every(task => task.isRecurring && task.repeatPattern === 'daily'));
  assert.equal(new Set(recurringDetails.map(task => task.seriesId)).size, 1);

  const lockedRecurringId = recurring.body.taskIds[0];
  assert.equal((await request(`/api/student/tasks/${lockedRecurringId}/submit`, { cookie: firstLogin.cookie, method: 'POST', body: '{}' })).body.task.status, 'pending_review');
  const editableRecurringId = recurring.body.taskIds[1];
  const seriesUpdated = await request(`/api/parent/tasks/${editableRecurringId}`, {
    cookie: admin,
    method: 'PATCH',
    body: JSON.stringify({ studentId: firstId, title: '每日阅读已调整', detail: '系列修改', categoryId, duration: 18, stars: 4, feedbackType: 'none', needsReview: true, date: addDays(currentDate, 1), scope: 'series' })
  });
  assert.equal(seriesUpdated.response.status, 200);
  assert.equal(seriesUpdated.body.updatedCount, 2);
  assert.equal(seriesUpdated.body.skippedCount, 1);
  assert.equal((await request(`/api/parent/tasks/${lockedRecurringId}`, { cookie: admin })).body.task.title, '每日阅读');
  assert.equal((await request(`/api/parent/tasks/${editableRecurringId}`, { cookie: admin })).body.task.title, '每日阅读已调整');

  const seriesDeleted = await request(`/api/parent/tasks/${editableRecurringId}?scope=series`, { cookie: admin, method: 'DELETE' });
  assert.equal(seriesDeleted.response.status, 200);
  assert.equal(seriesDeleted.body.deletedCount, 2);
  assert.equal(seriesDeleted.body.skippedCount, 1);
  assert.equal((await request(`/api/parent/tasks/${lockedRecurringId}`, { cookie: admin })).response.status, 200, 'pending review occurrence must be preserved');
  assert.equal((await request(`/api/parent/tasks/${editableRecurringId}`, { cookie: admin })).response.status, 404);

  const rangeStart = addDays(currentDate, -2);
  const rangeEnd = addDays(currentDate, 2);
  const rangeTask = await request('/api/parent/tasks', {
    cookie: admin,
    method: 'POST',
    body: JSON.stringify({ studentIds: [secondId], title: '跨天作文', detail: '在期限内完成作文', categoryId, duration: 40, stars: 6, feedbackType: 'none', needsReview: false, scheduleType: 'range', startDate: rangeStart, endDate: rangeEnd })
  });
  assert.equal(rangeTask.response.status, 201);
  assert.equal(rangeTask.body.count, 1, 'a date range creates one task record per student');
  const rangeId = rangeTask.body.taskIds[0];
  const rangeDetail = await request(`/api/parent/tasks/${rangeId}`, { cookie: admin });
  assert.equal(rangeDetail.body.task.isDateRange, true);
  assert.equal(rangeDetail.body.task.scheduleType, 'range');
  assert.equal(rangeDetail.body.task.availableStartDate, rangeStart);
  assert.equal(rangeDetail.body.task.availableEndDate, rangeEnd);
  assert.equal(rangeDetail.body.task.date, rangeEnd, 'the range end is the due date');
  for (const date of [rangeStart, addDays(rangeStart, 2), rangeEnd]) {
    const day = await request(`/api/parent/tasks?studentId=${secondId}&date=${date}`, { cookie: admin });
    assert.ok(day.body.tasks.some(task => task.id === rangeId), `range task must be visible on ${date}`);
  }
  const beforeRange = await request(`/api/parent/tasks?studentId=${secondId}&date=${addDays(rangeStart, -1)}`, { cookie: admin });
  assert.ok(!beforeRange.body.tasks.some(task => task.id === rangeId));
  const studentRangeDay = await request(`/api/student/dashboard?date=${addDays(rangeStart, 2)}`, { cookie: secondLogin.cookie });
  assert.ok(studentRangeDay.body.tasks.some(task => task.id === rangeId), 'student can operate the same range task on any day in the range');

  const editedRangeEnd = addDays(rangeEnd, 2);
  const editedRange = await request(`/api/parent/tasks/${rangeId}`, {
    cookie: admin,
    method: 'PATCH',
    body: JSON.stringify({ studentId: secondId, title: '跨天作文已调整', detail: '调整后的作文要求', categoryId, duration: 45, stars: 7, feedbackType: 'none', needsReview: false, scheduleType: 'range', startDate: rangeStart, endDate: editedRangeEnd })
  });
  assert.equal(editedRange.response.status, 200);
  assert.equal((await request(`/api/parent/tasks/${rangeId}`, { cookie: admin })).body.task.availableEndDate, editedRangeEnd);
  const deletedRange = await request(`/api/parent/tasks/${rangeId}`, { cookie: admin, method: 'DELETE' });
  assert.equal(deletedRange.response.status, 200);
  for (const date of [rangeStart, addDays(rangeStart, 2), editedRangeEnd]) {
    const day = await request(`/api/parent/tasks?studentId=${secondId}&date=${date}`, { cookie: admin });
    assert.ok(!day.body.tasks.some(task => task.id === rangeId), `deleted range task must disappear from ${date}`);
  }
  const completableRange = await request('/api/parent/tasks', {
    cookie: admin,
    method: 'POST',
    body: JSON.stringify({ studentIds: [secondId], title: '跨天阅读报告', detail: '期限内任意一天提交', categoryId, duration: 30, stars: 5, feedbackType: 'none', needsReview: false, scheduleType: 'range', startDate: rangeStart, endDate: rangeEnd })
  });
  const completableRangeId = completableRange.body.taskIds[0];
  const completedInRange = await request(`/api/student/tasks/${completableRangeId}/submit`, { cookie: secondLogin.cookie, method: 'POST', body: '{}' });
  assert.equal(completedInRange.body.task.status, 'completed');
  for (const date of [rangeStart, rangeEnd]) {
    const day = await request(`/api/student/dashboard?date=${date}`, { cookie: secondLogin.cookie });
    assert.equal(day.body.tasks.find(task => task.id === completableRangeId)?.status, 'completed', 'one completion updates the shared task across its whole date range');
  }

  const earlyRangeStart = addDays(currentDate, 2);
  const earlyRangeEnd = addDays(currentDate, 5);
  const earlyRange = await request('/api/parent/tasks', {
    cookie: admin,
    method: 'POST',
    body: JSON.stringify({ studentIds: [secondId], title: '可提前完成的持续任务', detail: '学生可以提前开始', categoryId, duration: 20, stars: 3, feedbackType: 'none', needsReview: false, scheduleType: 'range', startDate: earlyRangeStart, endDate: earlyRangeEnd })
  });
  assert.equal(earlyRange.response.status, 201);
  const earlyRangeId = earlyRange.body.taskIds[0];
  const futureRanges = await request('/api/student/tasks?filter=future', { cookie: secondLogin.cookie });
  assert.ok(futureRanges.body.tasks.some(task => task.id === earlyRangeId), 'future continuous-date tasks are available from the task list');
  const earlyStarted = await request(`/api/student/tasks/${earlyRangeId}/draft`, { cookie: secondLogin.cookie, method: 'PATCH', body: JSON.stringify({ feedbackNote: '提前开始学习' }) });
  assert.equal(earlyStarted.response.status, 200);
  assert.equal(earlyStarted.body.task.status, 'in_progress', 'students may begin a continuous-date task before its start date');
  const earlyCompleted = await request(`/api/student/tasks/${earlyRangeId}/submit`, { cookie: secondLogin.cookie, method: 'POST', body: JSON.stringify({}) });
  assert.equal(earlyCompleted.response.status, 200);
  assert.equal(earlyCompleted.body.task.status, 'completed');

  const optionalFeedbackWithoutFile = await request('/api/parent/tasks', {
    cookie: admin,
    method: 'POST',
    body: JSON.stringify({ studentIds: [secondId], title: '选填反馈任务', detail: '可按需上传学习成果', categoryId, duration: 10, stars: 2, feedbackType: 'optional_photo_or_video', needsReview: false, date: currentDate })
  });
  assert.equal(optionalFeedbackWithoutFile.response.status, 201);
  const optionalNoFileSubmit = await request(`/api/student/tasks/${optionalFeedbackWithoutFile.body.taskIds[0]}/submit`, { cookie: secondLogin.cookie, method: 'POST', body: JSON.stringify({}) });
  assert.equal(optionalNoFileSubmit.response.status, 200);
  assert.equal(optionalNoFileSubmit.body.task.status, 'completed', 'optional feedback does not require an attachment');

  const optionalFeedbackWithFile = await request('/api/parent/tasks', {
    cookie: admin,
    method: 'POST',
    body: JSON.stringify({ studentIds: [secondId], title: '选填反馈上传任务', detail: '可以自愿上传图片', categoryId, duration: 10, stars: 2, feedbackType: 'optional_photo_or_video', needsReview: false, date: currentDate })
  });
  assert.equal(optionalFeedbackWithFile.response.status, 201);
  const optionalFileSubmit = await request(`/api/student/tasks/${optionalFeedbackWithFile.body.taskIds[0]}/submit`, { cookie: secondLogin.cookie, method: 'POST', body: JSON.stringify({ feedbackData: avatar, feedbackName: '自愿上传.png' }) });
  assert.equal(optionalFileSubmit.response.status, 200);
  assert.equal(optionalFileSubmit.body.task.feedbackKind, 'image', 'optional feedback accepts a voluntarily uploaded image');

  const largeImageBytes = Buffer.alloc(Math.floor(3.2 * 1024 * 1024), 0x61);
  largeImageBytes.set([0xff, 0xd8, 0xff], 0);
  const largeImageTask = await assign(secondId, '大图片资料测试', addDays(currentDate, 3), true, [{ name: '3MB学习图片.jpg', data: `data:image/jpeg;base64,${largeImageBytes.toString('base64')}` }]);
  assert.equal(largeImageTask.response.status, 201, 'a single image under 6 MB must upload successfully');
  const largeImageDetail = await request(`/api/parent/tasks/${largeImageTask.body.taskIds[0]}`, { cookie: admin });
  assert.equal(largeImageDetail.body.task.resourceCount, 1);
  assert.equal(largeImageDetail.body.task.resources[0].name, '3MB学习图片.jpg');

  const genericFileTask = await assign(secondId, '通用文件资料测试', addDays(currentDate, 4), true, [{ name: '练习资料.bin', data: 'data:application/octet-stream;base64,AQID' }]);
  assert.equal(genericFileTask.response.status, 201, 'generic files under 6 MB are accepted as downloadable resources');

  const audioTask = await assign(secondId, '语音资料测试', addDays(currentDate, 5), true, [{ name: '词汇朗读.mp3', mime: 'audio/mpeg', kind: 'audio', data: 'data:audio/mpeg;base64,SUQzAwAAAAA=' }]);
  assert.equal(audioTask.response.status, 201, 'audio resources are accepted');
  const audioDetail = await request(`/api/parent/tasks/${audioTask.body.taskIds[0]}`, { cookie: admin });
  assert.equal(audioDetail.body.task.resources[0].kind, 'audio');
  assert.equal(audioDetail.body.task.resources[0].mime, 'audio/mpeg');
  const audioUrl = audioDetail.body.task.resources[0].data;
  const audioRange = await fetch(`${base}${audioUrl}`, { headers: { range: 'bytes=0-2' } });
  assert.equal(audioRange.status, 206, 'local audio resources support range requests');
  assert.equal(audioRange.headers.get('accept-ranges'), 'bytes');
  assert.equal(audioRange.headers.get('content-type'), 'audio/mpeg');
  assert.equal(Buffer.from(await audioRange.arrayBuffer()).length, 3);

  const database = new DatabaseSync(join(process.env.TEST_DATA_DIR, 'learning-planet.db'), { readOnly: true });
  try {
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM task_resources WHERE data LIKE 'data:%;base64,%'").get().count, 0, 'resource binary data must not remain in SQLite');
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM tasks WHERE feedback_data LIKE 'data:%;base64,%'").get().count, 0, 'feedback binary data must not remain in SQLite');
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM users WHERE avatar LIKE 'data:image/%;base64,%'").get().count, 0, 'avatar binary data must not remain in SQLite');
    assert.ok(database.prepare("SELECT COUNT(*) AS count FROM task_resources WHERE url LIKE '/uploads/%'").get().count >= 4);
  } finally { database.close(); }
});
