// Reload while stop ACTIVE → server-authoritative hydration → pill shows ACTIVE.
await page.goto('http://127.0.0.1:3000/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(6000);
const bodyHydrated = await page.locator('body').innerText();
await page.screenshot({ path: 't8c_pill_hydrated.png' });
const hydratedActive = /Emergency Stop Active/i.test(bodyHydrated);
return { hydratedActive, sample: bodyHydrated.slice(0, 220) };
