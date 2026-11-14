// Page loads while the server stop is ACTIVE → hydration must activate the
// local gate fail-closed BEFORE any tool can execute.
await page.goto('http://127.0.0.1:3000/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(6000);
const tmp = 'C:/Users/Expert/AppData/Local/Temp/krisha-stop-test/deleteme2.txt';
const input = page.getByPlaceholder('Type in English, Hindi, or ask Krisha...');
await input.click();
await input.fill('delete the file ' + tmp);
await page.getByRole('button', { name: 'Send message' }).click();
await page.waitForTimeout(8000);
const tasksRaw = await page.evaluate(() => localStorage.getItem('krisha_agent_tasks_v1'));
const tasks = JSON.parse(tasksRaw ?? '[]');
const t = tasks[0]
  ? { status: tasks[0].status, error: (tasks[0].error || '').slice(0, 260) }
  : null;
await page.screenshot({ path: 't5d_hydrated_block.png' });
return { hydratedTask: t, blockedByStop: /emergency stop/i.test(t?.error ?? '') };
