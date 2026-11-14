const shot = await page.screenshot({ path: 't1_initial.png', fullPage: false });
const snap = await page.locator('body').ariaSnapshot();
return { screenshot: 't1_initial.png', snapshot: snap.slice(0, 4000) };
