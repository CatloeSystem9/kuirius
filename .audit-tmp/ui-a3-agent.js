const repo = 'C:/Users/Expert/OneDrive/Documents/GitHub/Krisha-AI';
const input = page.getByPlaceholder(/Type in English|Krisha is thinking/);
await input.click();
await input.fill('list the files in ' + repo + ' and then read the file ' + repo + '/metadata.json');
await page.getByRole('button', { name: 'Send message' }).click();
// Sample the stream every 700ms for 12s to capture the real event sequence.
const seen = [];
for (let i = 0; i < 17; i++) {
  const text = await page.locator('body').innerText();
  const lines = (text.match(/(Working on:[^\n]*|Planned \d+ steps?\.|Done[^\n]*|Task completed\.|Task finished[^\n]*|Resuming[^\n]*)/g) ?? []);
  for (const l of lines) if (!seen.includes(l)) seen.push(l);
  if (i === 3) await page.screenshot({ path: 'a3_midrun.png' });
  await page.waitForTimeout(700);
}
await page.screenshot({ path: 'a3_after.png' });
const runningStillVisible = /Working on:/.test(await page.locator('body').innerText());
return { sequence: seen.slice(0, 12), runningStillVisible };
