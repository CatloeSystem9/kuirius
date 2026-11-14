// After operator-CLI recovery, clicking the ACTIVE pill refreshes the status.
const pill = page.getByRole('button', { name: /Emergency Stop Active/i }).first();
const count = await pill.count();
if (count === 1) {
  await pill.click();
  await page.waitForTimeout(2000);
}
const body = await page.locator('body').innerText();
await page.screenshot({ path: 't8d_pill_cleared.png' });
return {
  hadActivePill: count === 1,
  clearedAfterRefresh: !/Emergency Stop Active/i.test(body),
  inactivePillBack: /⏹ Emergency Stop/i.test(body) && !/Emergency Stop Active/i.test(body),
  sample: body.slice(0, 200),
};
