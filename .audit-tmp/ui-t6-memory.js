await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);
// Any visible stop/status indicator after hydration? (defect #3 evidence)
const bodyAfterReload = await page.locator('body').innerText();
await page.screenshot({ path: 't6_after_reload.png' });
// Open the Memory panel.
const memBtn = page.getByRole('button', { name: 'Memory' });
const memCount = await memBtn.count();
if (memCount === 1) {
  await memBtn.click();
  await page.waitForTimeout(2500);
}
const bodyMem = await page.locator('body').innerText();
await page.screenshot({ path: 't6_memory_panel.png' });
return {
  stopIndicatorAfterReload: /emergency|stop active|stopped/i.test(bodyAfterReload),
  memoryPanelOpened: memCount === 1,
  memoryPanelSample: bodyMem.slice(0, 900),
};
