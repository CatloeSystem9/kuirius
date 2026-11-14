await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);
const btn = page.getByRole('button', { name: /Read Screen/i }).first();
await btn.click();
await page.waitForTimeout(6000);
const body = await page.locator('body').innerText();
await page.screenshot({ path: 't7_screen_vision.png' });
return { bodySample: body.slice(0, 700), hasVisionFeedback: /screen|vision|observe|unable|error/i.test(body) };
