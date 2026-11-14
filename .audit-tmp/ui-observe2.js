const body = await page.locator('body').innerText();
return { bodySample: body.slice(0, 1000) };
