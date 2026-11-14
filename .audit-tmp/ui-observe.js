const body = await page.locator('body').innerText();
const tasksRaw = await page.evaluate(() => localStorage.getItem('krisha_agent_tasks_v1'));
const tasks = JSON.parse(tasksRaw ?? '[]');
return {
  bodySample: body.slice(0, 800),
  taskCount: tasks.length,
  latest: tasks[0] ? { status: tasks[0].status, goal: tasks[0].goal?.description?.slice(0, 80), createdAt: new Date(tasks[0].createdAt).toISOString() } : null,
  second: tasks[1] ? { status: tasks[1].status, goal: tasks[1].goal?.description?.slice(0, 80), createdAt: new Date(tasks[1].createdAt).toISOString() } : null,
};
