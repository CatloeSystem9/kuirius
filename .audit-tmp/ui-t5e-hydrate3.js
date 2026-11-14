// Hydration proof via a COMPOUND request (agent path) whose first step is a
// confirm-class tool (web.open_website) that the hydrated local stop blocks.
const input = page.getByPlaceholder('Type in English, Hindi, or ask Krisha...');
await input.click();
await input.fill('browser open https://example.com and then open https://example.org');
await page.getByRole('button', { name: 'Send message' }).click();
await page.waitForTimeout(14000);
const tasksRaw = await page.evaluate(() => localStorage.getItem('krisha_agent_tasks_v1'));
const tasks = JSON.parse(tasksRaw ?? '[]');
const t = tasks[0]
  ? { status: tasks[0].status, steps: (tasks[0].plan?.steps ?? []).map((s) => s.toolName + ':' + s.status), error: (tasks[0].error || '').slice(0, 300), summary: (tasks[0].summary || '').slice(0, 300) }
  : null;
await page.screenshot({ path: 't5e_hydrated_stop_block2.png' });
return { hydratedTask: t, blockedByStop: /emergency stop/i.test(t?.error ?? t?.summary ?? '') };
