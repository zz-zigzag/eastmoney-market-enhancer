async page => {
  const results = [];
  const panel = page.locator('#ema-market-index-switch');
  const measure = () => page.evaluate(() => {
    const panel = document.querySelector('#ema-market-index-switch');
    const chart = document.querySelector('#target-chart').getBoundingClientRect();
    const overlay = document.querySelector('#ema-market-index-overlay').getBoundingClientRect();
    const row = document.querySelector('.chart-row').getBoundingClientRect();
    const toolbar = panel.getBoundingClientRect();
    return {
      toolbarHeight: toolbar.height,
      aboveChart: toolbar.bottom <= chart.top,
      fullWidth: Math.abs(chart.width - row.width) < 1,
      beforeTable: chart.bottom <= document.querySelector('.hourly').getBoundingClientRect().top,
      aligned: ['x', 'y', 'width', 'height'].every(key => Math.abs(chart[key] - overlay[key]) < 1),
      buttons: [...panel.querySelectorAll('button')].map(button => button.textContent),
      quote: panel.querySelector('span').textContent,
    };
  });
  const check = (result, label) => {
    if (!result.aboveChart || !result.fullWidth || !result.beforeTable || !result.aligned || result.toolbarHeight > 26) {
      throw new Error(label + ': ' + JSON.stringify(result));
    }
    if (result.buttons.join('/') !== '全A/平均') throw new Error('Incorrect button labels');
    results.push({ label, ...result });
  };
  for (const width of [1000, 375, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('http://127.0.0.1:8765/work/test-page.html');
    await panel.getByRole('button', { name: '平均', exact: true }).click();
    await page.waitForFunction(() => /\d+\.\d+%/.test(document.querySelector('#ema-market-index-switch span').textContent));
    check(await measure(), 'average at ' + width);
    await panel.scrollIntoViewIfNeeded();
    const chart = await page.locator('#target-chart').boundingBox();
    await page.mouse.move(chart.x + chart.width * 0.4, chart.y + chart.height * 0.3);
    const hover = await measure();
    if (!/\d{2}:\d{2}/.test(hover.quote)) throw new Error('Hover quote missing time');
    check(hover, 'hover at ' + width);
    await panel.getByRole('button', { name: '全A', exact: true }).click();
    check(await measure(), 'all-A at ' + width);
  }
  // Simulate the site's chart renderer replacing its canvas.
  await page.evaluate(() => {
    document.querySelector('#ema-market-index-overlay').dataset.stale = 'true';
    const canvas = document.querySelector('#target-chart');
    canvas.replaceWith(canvas.cloneNode());
  });
  await page.waitForFunction(() => {
    const target = document.querySelector('#target-chart');
    const overlay = document.querySelector('#ema-market-index-overlay');
    return overlay && !overlay.dataset.stale && overlay.parentElement === target.parentElement && overlay.width > 0;
  });
  if (await panel.count() !== 1) throw new Error('Duplicate toolbar after remount');
  check(await measure(), 'canvas remount');
  await page.setViewportSize({ width: 1000, height: 1000 });
  await page.goto('http://127.0.0.1:8765/work/test-page.html');
  await panel.getByRole('button', { name: '平均', exact: true }).click();
  await page.locator('#root').screenshot({ path: 'work/layout-preview.png' });
  return results;
}
