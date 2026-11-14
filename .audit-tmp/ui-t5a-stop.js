const tmp = 'C:/Users/Expert/AppData/Local/Temp/krisha-stop-test/deleteme.txt';
const input = page.getByPlaceholder('Type in English, Hindi, or ask Krisha...');
await input.click();
await input.fill('delete the file ' + tmp);
await page.getByRole('button', { name: 'Send message' }).click();
// The task runs client-side; the server-side stop must refuse /api/fs/delete.
await page.waitForTimeout(18000);
const body = await page.locator('body').innerText();
await page.screenshot({ path: 't5a_stop_blocked.png' });
const tasksRaw = await page.evaluate(() => localStorage.getItem('krisha_agent_tasks_v1'));
const tasks = JSON.parse(tasksRaw ?? '[]');
const t = tasks[0]
  ? { status: tasks[0].status, error: (tasks[0].error || '').slice(0, 220), summary: (tasks[0].summary || '').slice(0, 220) }
  : null;
return { task: t, bodyMentionsStop: /emergency stop/i.test(body), bodySample: body.slice(0, 450) };
