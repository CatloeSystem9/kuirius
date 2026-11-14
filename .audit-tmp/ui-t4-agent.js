const repo = 'C:/Users/Expert/OneDrive/Documents/GitHub/Krisha-AI';
const input = page.getByPlaceholder('Type in English, Hindi, or ask Krisha...');
await input.click();
await input.fill('list the files in ' + repo + ' and then read the file ' + repo + '/metadata.json');
const chatCaller = page.waitForRequest((r) => r.url().includes('/api/chat'), { timeout: 12000 }).then(() => 'chat-called').catch(() => 'no-chat-call');
await page.getByRole('button', { name: 'Send message' }).click();
const chatResult = await chatCaller;
// Agent task runs client-side; wait for the honest summary to render.
await page.waitForTimeout(15000);
const body = await page.locator('body').innerText();
await page.screenshot({ path: 't4_agent_summary.png' });
const tasksRaw = await page.evaluate(() => localStorage.getItem('krisha_agent_tasks_v1'));
let lastTask = null;
if (tasksRaw) {
  const tasks = JSON.parse(tasksRaw);
  lastTask = tasks[0]
    ? { status: tasks[0].status, steps: (tasks[0].plan?.steps ?? []).map((s) => s.toolName + ':' + s.status), verification: tasks[0].verification?.outcome, summary: (tasks[0].summary || '').slice(0, 300) }
    : null;
}
return { chatResult, summaryShown: /steps completed|stopped because|All .* steps/i.test(body), lastTask, bodySample: body.slice(0, 700) };
