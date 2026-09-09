import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:4175';
const screenshot = process.env.TEST_SCREENSHOT || '/tmp/learning-account-admin.png';
const avatar = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '家长登录' }).click();
  const captchaSource = await page.locator('#captcha-image').getAttribute('src');
  const svg = decodeURIComponent(captchaSource.split(',').slice(1).join(','));
  const answer = [...svg.matchAll(/<text[^>]*>([^<]+)<\/text>/g)].map(match => match[1]).join('');
  await page.locator('#username').fill('admin');
  await page.locator('#password').fill('admin@2026');
  await page.locator('#captcha').fill(answer);
  await page.locator('#login-form').getByRole('button', { name: /进入家长首页/ }).click();
  await page.locator('#overview.active').waitFor();

  assert.equal(await page.locator('[data-parent-page="parents"]').isVisible(), true);
  await page.locator('[data-parent-page="parents"]').click();
  await page.locator('#parents.active').waitFor();
  assert.equal(await page.getByRole('heading', { name: '家长管理' }).isVisible(), true);
  assert.equal(await page.locator('#add-parent').isVisible(), true);
  await page.screenshot({ path: screenshot.replace('.png', '-parents.png'), fullPage: true });
  await page.locator('#add-parent').click();
  await page.locator('#parent-name').fill('示例家长周');
  assert.equal(await page.locator('#parent-avatar-preview').textContent(), '周');
  assert.equal(await page.locator('#parent-avatar').getAttribute('required'), null);
  await page.locator('#parent-dialog .modal-close').click();
  const firstEdit = page.locator('[data-edit-parent]').first();
  if (await firstEdit.count()) {
    await firstEdit.click();
    assert.equal(await page.locator('#parent-username').isEditable(), false);
    const dialogBox = await page.locator('#parent-dialog').boundingBox();
    assert.ok(dialogBox && dialogBox.x >= 0 && dialogBox.y >= 0 && dialogBox.x + dialogBox.width <= 1440 && dialogBox.y + dialogBox.height <= 900);
    await page.locator('#parent-dialog .modal-close').click();
  }

  await page.locator('[data-parent-page="students"]').click();
  await page.locator('#students.active').waitFor();
  assert.equal(await page.locator('#students-page-title').textContent(), '全部学生');
  assert.match(await page.locator('.student-card').first().textContent(), /用户名：/);
  await page.locator('#add-student').click();
  assert.equal(await page.locator('#student-parent-options').isVisible(), true);
  await page.locator('#student-name').fill('示例学生宇');
  assert.equal(await page.locator('#student-avatar-preview').textContent(), '宇');
  assert.equal(await page.locator('#student-avatar').getAttribute('required'), null);
  await page.locator('#student-dialog .modal-close').click();
  await page.locator('[data-student-actions]').first().click();
  await page.locator('#edit-student-action').click();
  assert.equal(await page.locator('#student-username').isVisible(), true);
  assert.equal(await page.locator('#student-username').isEditable(), false);
  await page.locator('#student-dialog .modal-close').click();
  await page.screenshot({ path: screenshot.replace('.png', '-students.png'), fullPage: true });

  await page.locator('[data-parent-page="stats"]').click();
  await page.locator('#stats.active').waitFor();
  assert.equal(await page.locator('.stats-summary').count(), 0);
  const firstRanking = page.locator('.ranking-row').first();
  if (await firstRanking.count()) {
    assert.match(await firstRanking.textContent(), /完成率/);
    assert.match(await firstRanking.textContent(), /按时率/);
  }
  await page.screenshot({ path: screenshot, fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    openStudentForm();
    document.querySelector('#student-name').value = '手机学生星';
    document.querySelector('#student-name').dispatchEvent(new Event('input', { bubbles: true }));
  });
  assert.equal(await page.locator('#student-avatar-preview').textContent(), '星');
  const mobileStudentDialog = await page.locator('#student-dialog').boundingBox();
  assert.ok(mobileStudentDialog && mobileStudentDialog.x >= 0 && mobileStudentDialog.x + mobileStudentDialog.width <= 390);
  await page.locator('#student-dialog .modal-close').click();

  await page.evaluate(resourceData => {
    const task = { hasResource: true, resources: [{ name: '家庭学习资料.png', kind: 'image', data: resourceData }], hasFeedback: true, feedbackName: '学生学习成果.png', feedbackKind: 'image', feedbackData: resourceData };
    document.querySelector('#task-detail-modal-content').innerHTML = `<div class="modal-content">${taskResourceMarkup(task)}${taskFeedbackEvidence(task)}</div>`;
    document.querySelector('#task-detail-dialog').showModal();
    refreshIcons();
  }, avatar);
  assert.equal(await page.locator('#task-detail-dialog [data-preview-task-resource]').count(), 1);
  assert.equal(await page.locator('#task-detail-dialog [data-preview-parent-feedback]').count(), 1);
  assert.equal(await page.locator('#task-detail-dialog a[download="家庭学习资料.png"]').count(), 1);
  assert.equal(await page.locator('#task-detail-dialog a[download="学生学习成果.png"]').count(), 1);
  const mobileDetailDialog = await page.locator('#task-detail-dialog').boundingBox();
  assert.ok(mobileDetailDialog && mobileDetailDialog.x >= 0 && mobileDetailDialog.x + mobileDetailDialog.width <= 390);
  await page.screenshot({ path: screenshot.replace('.png', '-mobile-downloads.png'), fullPage: true });

} finally {
  await browser.close();
}
