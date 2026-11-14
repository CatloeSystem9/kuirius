await page.goto('http://127.0.0.1:3000/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(6000);
const body = await page.locator('body').innerText();
await page.screenshot({ path: 't8a_pill_inactive.png' });
const hasInactivePill = /Emergency Stop/i.test(body) && !/Emergency Stop Active/i.test(body);
// Activate via the pill (auto-accept the confirm dialog).
page.on('dialog', (d) => {
  void d.accept();
});
const pill = page.getByRole('button', { name: /⏹ Emergency Stop$/ }).first();
const pillCount = await pill.count();
if (pillCount >= 1) {
  await pill.click();
  await page.waitForTimeout(2500);
}
const bodyAfter = await page.locator('body').innerText();
await page.screenshot({ path: 't8b_pill_active.png' });
return {
  hasInactivePill,
  pillCount,
  activeShown: /Emergency Stop Active/i.test(bodyAfter),
  genShown: /gen \d+/i.test(bodyAfter),
  sample: bodyAfter.slice(0, 260),
};
