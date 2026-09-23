import { chromium } from 'playwright';
const G = 'http://127.0.0.1:18080';
const login = async (page, path) => {
  await page.goto(`${G}${path}`);
  await page.waitForTimeout(1500);
};
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const out = '/mnt/user-data/outputs/shots'; await import('node:fs').then(fs => fs.mkdirSync(out, { recursive: true }));
// create project via API
const tok = await (await fetch(`${G}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'demo', password: 'demo1234' }) })).json();
const cp = await fetch(`${G}/api/projects/create-project`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok.token}` }, body: JSON.stringify({ path: '${process.env.LOCAL_PLATFORM_DIR ?? '/home/claude/aidev-local'}/home/workspace/demo-project' }) });
console.log('create project', cp.status, (await cp.text()).slice(0, 200));
for (const [name, viewport, path, ua] of [
  ['desktop', { width: 1440, height: 900 }, '/', undefined],
  ['tablet', { width: 1024, height: 768 }, '/', undefined],
  ['mobile', { width: 390, height: 844 }, '/m/', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'],
]) {
  const ctx = await browser.newContext({ viewport, userAgent: ua, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${name}] pageerror`, e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[${name}] console`, m.text().slice(0, 160)); });
  await login(page, path);
  // login form
  const user = page.locator('input[type="text"], input[autocomplete="username"], input[placeholder*="아이디"], input[name="username"]').first();
  if (await user.count()) { await user.fill('demo'); await page.locator('input[type="password"]').first().fill('demo1234'); await page.locator('button[type="submit"]').first().click(); await page.waitForTimeout(3000); }
  await page.screenshot({ path: `${out}/${name}-1.png` });
  console.log(name, page.url());
  if (name !== 'mobile') {
    // open the demo project if listed
    const proj = page.getByText('demo-project').first();
    if (await proj.count()) { await proj.click(); await page.waitForTimeout(2500); await page.screenshot({ path: `${out}/${name}-2.png` }); }
  } else {
    const plus = page.locator('a[aria-label="새 대화"]');
    if (await plus.count()) { await plus.click(); await page.waitForTimeout(1500); await page.screenshot({ path: `${out}/${name}-2.png` }); }
  }
  await ctx.close();
}
await browser.close();
