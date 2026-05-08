const puppeteer = require('puppeteer');

(async () => {
    const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-web-security'] });
    const page1 = await browser.newPage();
    const page2 = await browser.newPage();

    page1.on('console', msg => {
        if (msg.text().includes('[P2P]')) console.log('PAGE 1:', msg.text());
    });
    page2.on('console', msg => {
        if (msg.text().includes('[P2P]')) console.log('PAGE 2:', msg.text());
    });

    console.log("Loading Page 1...");
    await page1.goto('http://localhost:3000', { waitUntil: 'networkidle2' });
    await page1.waitForTimeout(4000);
    
    console.log("Loading Page 2...");
    await page2.goto('http://localhost:3000', { waitUntil: 'networkidle2' });
    await page2.waitForTimeout(5000);
    
    console.log("Closing browser.");
    await browser.close();
})();
