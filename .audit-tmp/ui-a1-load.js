await page.goto('http://127.0.0.1:3000/', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForTimeout(7000);
// Composer glass appearance check (initial state, empty stream).
await page.screenshot({ path: 'a1_glass_composer_idle.png' });
const composer = page.locator('form#main-chat-form, form').first();
const composerBg = await composer.evaluate((el) => getComputedStyle(el).backgroundColor);
const composerBlur = await composer.evaluate((el) => getComputedStyle(el).backdropFilter);
const composerBorder = await composer.evaluate((el) => getComputedStyle(el).borderColor);
return { composerBg, composerBlur, composerBorder };
