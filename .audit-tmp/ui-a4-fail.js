const input = page.getByPlaceholder(/Type in English|Krisha is thinking/);
await input.click();
await input.fill('delete the file C:/Users/Expert/AppData/Local/Temp/definitely-missing-xyz.txt');
await page.getByRole('button', { name: 'Send message' }).click();
// 7s later: past the 5s fade — the task-failure error must STILL be visible (sticky).
await page.waitForTimeout(7000);
await page.screenshot({ path: 'a4_sticky_error.png' });
const body1 = await page.locator('body').innerText();
const errorVisible = /Task failed:/.test(body1);
// Dismiss it via the X button on the sticky entry.
const dismissBtn = page.locator('button[title="Dismiss"]');
const dismissCount = await dismissBtn.count();
if (dismissCount > 0) {
  await dismissBtn.first().click();
  await page.waitForTimeout(700);
}
const body2 = await page.locator('body').innerText();
return {
  errorVisibleAfter7s: errorVisible,
  dismissButtonCount: dismissCount,
  errorGoneAfterDismiss: !/Task failed:/.test(body2),
};
