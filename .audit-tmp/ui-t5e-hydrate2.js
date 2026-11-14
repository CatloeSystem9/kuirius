// Hydration proof with a default-granted, stop-blocked (confirm-class) tool.
const input = page.getByPlaceholder('Type in English, Hindi, or ask Krisha...');
await input.click();
await input.fill('browser open https://example.com');
await page.getByRole('button', { name: 'Send message' }).click();
await page.waitForTimeout(12000);
const tasksRaw = await page.evaluate(() => localStorage.getItem('krisha_agent_tasks_v1'));
const tasks = JSON.parse(tasksRaw ?? '[]');
const t = tasks[0]
  ? { status: tasks[0].status, error: (tasks[0].error || '').slice(0, 260), summary: (tasks[0].summary || '').slice(0, 260) }
  : null;
await page.screenshot({ path: 't5e_hydrated_stop_block.png' });
return { hydratedTask: t, blockedByStop: /emergency stop/i.test(t?.error ?? t?.summary ?? '') };
