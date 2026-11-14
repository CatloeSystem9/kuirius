const pending = page.waitForResponse((r) => r.url().includes('/api/chat'), { timeout: 45000 });
const input = page.getByPlaceholder('Type in English, Hindi, or ask Krisha...');
await input.click();
await input.fill('what is 2+2? answer with just the number');
await page.getByRole('button', { name: 'Send message' }).click();
let resp;
try {
  resp = await pending;
} catch (e) {
  return { chatResponseSeen: false, error: String(e).slice(0, 120) };
}
const body = await page.locator('body').innerText();
await page.screenshot({ path: 't3_chat_reply.png' });
let extract = null;
try {
  const memResp = await page.waitForResponse((r) => r.url().includes('/api/memory/extract'), { timeout: 20000 });
  extract = { url: memResp.url(), status: memResp.status() };
} catch (e) {
  extract = { seen: false };
}
return {
  chatStatus: resp.status(),
  chatResponseSeen: true,
  extract,
  replyContains4: /\b4\b/.test(body),
  bodySample: body.slice(0, 500),
};
