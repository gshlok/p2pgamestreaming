const { chromium } = require('playwright');

(async () => {
  console.log('Launching browser...');
  const browser = await chromium.launch({ headless: true });

  // Context A (Peer A)
  const contextA = await browser.newContext();
  const pageA = await contextA.newPage();
  
  // Context B (Peer B)
  const contextB = await browser.newContext();
  const pageB = await contextB.newPage();

  console.log('Navigating to http://localhost:3000 in both contexts...');
  await pageA.goto('http://localhost:3000');
  
  // Capture logs from Page B to verify P2P transfer
  pageB.on('console', msg => {
      const text = msg.text();
      if (text.includes('[P2P]') || text.includes('[P2P-Intercept]')) {
          console.log(`[PageB Log]: ${text}`);
      }
  });

  await pageA.waitForTimeout(5000); // Wait for initialization

  console.log('Loading level in Page A...');
  await pageA.evaluate(() => {
    document.getElementById('levelSelect').value = 'Tomb-Raider-1/01-Caves.PHD';
    loadSelectedLevel();
  });

  // Wait for it to load and cache
  await pageA.waitForTimeout(10000);

  const statusA = await pageA.evaluate(() => {
      return {
          connected: window.p2pManager?.isConnected(),
          localAssets: Array.from(window.p2pManager?.localAssets || [])
      };
  });
  console.log('Page A status:', statusA);

  console.log('Loading Page B...');
  await pageB.goto('http://localhost:3000');
  await pageB.waitForTimeout(5000); // Wait for init

  console.log('Loading same level in Page B...');
  await pageB.evaluate(() => {
    document.getElementById('levelSelect').value = 'Tomb-Raider-1/01-Caves.PHD';
    loadSelectedLevel();
  });

  // Wait for P2P transfer
  await pageB.waitForTimeout(10000);

  const statusB = await pageB.evaluate(() => {
      return {
          connected: window.p2pManager?.isConnected(),
          localAssets: Array.from(window.p2pManager?.localAssets || []),
          metrics: window.p2pManager?.metrics
      };
  });
  console.log('Page B status:', JSON.stringify(statusB, null, 2));

  await browser.close();
})();
