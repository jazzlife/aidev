import { chromium } from 'playwright';
const G = 'http://127.0.0.1:18080';
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile Safari' });
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log('console', m.text().slice(0, 200)); });
await page.goto(`${G}/m/`); await page.waitForTimeout(1200);
if (page.url().includes('/login')) { await page.fill('input[autocomplete="username"]', 'demo'); await page.fill('input[type="password"]', 'demo1234'); await page.click('button[type="submit"]'); await page.waitForTimeout(3000); }
await page.goto(`${G}/m/new`); await page.waitForTimeout(1500);
await page.getByRole('button', { name: '프로젝트', exact: true }).click(); await page.waitForTimeout(1500);
await page.screenshot({ path: '/mnt/user-data/outputs/shots/mobile-picker.png' }); await page.click('text=demo-project'); await page.waitForTimeout(500);
await page.fill('textarea', 'React 컴포넌트에 다크모드 토글 훅을 추가해줘');
await page.click('button[aria-label="보내기"]'); await page.waitForTimeout(6000);
console.log('url', page.url());
await page.screenshot({ path: '/mnt/user-data/outputs/shots/mobile-3.png' });
await page.click('text=/frontend-react|자동 라우팅|판정/'); await page.waitForTimeout(800);
await page.screenshot({ path: '/mnt/user-data/outputs/shots/mobile-4.png' });
await browser.close();
