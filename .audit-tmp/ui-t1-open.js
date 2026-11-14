await page.goto('http://127.0.0.1:3000/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(6000); // React mount + avatar + agent system init
return {
  url: page.url(),
  title: await page.title(),
  textareas: await page.locator('textarea').count(),
  textInputs: await page.locator('input[type="text"]').count(),
  buttons: await page.locator('button').count(),
  bodyChars: (await page.locator('body').innerText()).length,
};
