const input = page.getByPlaceholder(/Type in English|Krisha is thinking/);
await input.click();
await input.fill('what is 3+3? answer with just the number');
await page.getByRole('button', { name: 'Send message' }).click();
// Past the 5s fade window: the running line must STILL be visible (sticky).
await page.waitForTimeout(6500);
await page.screenshot({ path: 'a2_running_sticky.png' });
const bodyDuring = await page.locator('body').innerText();
const runningVisible = /Preparing the response/.test(bodyDuring);
// Wait for the reply.
await page.waitForResponse((r) => r.url().includes('/api/chat'), { timeout: 60000 });
await page.waitForTimeout(1200);
await page.screenshot({ path: 'a2_response_ready.png' });
const bodyAfter = await page.locator('body').innerText();
return {
  runningVisibleAfter5s: runningVisible,
  readyShown: /Response ready/.test(bodyAfter),
  replyShown: /\b6\b/.test(bodyAfter),
  streamSample: (bodyAfter.match(/(Preparing the response|Response ready|Learned .*)/g) ?? []).slice(0, 5),
};
