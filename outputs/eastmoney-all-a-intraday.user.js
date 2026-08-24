// ==UserScript==
// @name         牛熊风向标 - 成交额图叠加全A分时
// @namespace    https://emrnweb.eastmoney.com/
// @version      3.0.0
// @description  在东方财富“牛熊风向标”的成交额图中叠加全A指数或A股平均股价分时线。
// @match        https://emrnweb.eastmoney.com/nxfxb/home*
// @grant        GM_xmlhttpRequest
// @connect      push2.eastmoney.com
// @connect      push2his.eastmoney.com
// @connect      push2delay.eastmoney.com
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const OVERLAY_ID = 'ema-market-index-overlay';
  const SWITCH_ID = 'ema-market-index-switch';
  const ACTIVE_REFRESH_MS = 15_000;
  const IDLE_REFRESH_MS = 300_000;
  const MOUNT_RETRY_MS = 500;
  const API_HOSTS = [
    'push2.eastmoney.com',
    'push2his.eastmoney.com',
    'push2delay.eastmoney.com',
  ];
  const INDEXES = {
    allA: {
      label: '全A指数',
      shortLabel: '全A',
      secid: '47.800000',
      color: '#7657e8',
      lineAlpha: 'rgba(118,87,232,.55)',
      fillTop: 'rgba(118,87,232,.13)',
    },
    average: {
      label: '平均股价',
      shortLabel: '平均股价',
      secid: '47.800005',
      color: '#078f89',
      lineAlpha: 'rgba(7,143,137,.55)',
      fillTop: 'rgba(7,143,137,.13)',
    },
  };

  let activeKey = 'allA';
  const dataByKey = {};
  const loadingKeys = new Set();
  const statusByKey = {};
  let targetCanvas = null;
  let overlayCanvas = null;
  let switchPanel = null;
  let quoteElement = null;
  let resizeObserver = null;
  let pointerContainer = null;
  let hoverSlot = null;
  let mountTimer = null;
  let refreshTimer = null;

  function requestJson(url) {
    if (window.__EMA_MARKET_INDEX_MOCKS__) {
      const secid = new URL(url).searchParams.get('secid');
      return Promise.resolve(window.__EMA_MARKET_INDEX_MOCKS__[secid]);
    }

    if (typeof GM_xmlhttpRequest === 'function') {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'GET',
          url,
          timeout: 6_000,
          onload: (response) => {
            try {
              resolve(JSON.parse(response.responseText));
            } catch (error) {
              reject(error);
            }
          },
          onerror: () => reject(new Error('行情请求失败')),
          ontimeout: () => reject(new Error('行情请求超时')),
        });
      });
    }

    return fetch(url).then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    });
  }

  function apiUrl(hostname, secid) {
    const params = new URLSearchParams({
      secid,
      fields1: 'f1,f2,f5,f8',
      fields2: 'f51,f53',
      iscr: '0',
      ndays: '1',
    });
    return `https://${hostname}/api/qt/stock/trends2/get?${params}`;
  }

  async function fetchMarketData(config) {
    let lastError;
    for (const hostname of API_HOSTS) {
      try {
        const response = await requestJson(apiUrl(hostname, config.secid));
        if (response?.data?.trends?.length && Number.isFinite(Number(response.data.preClose))) {
          return response.data;
        }
        lastError = new Error('接口没有返回完整分时数据');
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('无法获取分时数据');
  }

  function minuteSlot(time) {
    const [hour, minute] = time.split(':').map(Number);
    const total = hour * 60 + minute;
    if (total <= 11 * 60 + 30) {
      return Math.max(0, Math.min(120, total - (9 * 60 + 30)));
    }
    if (total <= 13 * 60) return 120;
    return Math.max(121, Math.min(240, 121 + total - (13 * 60 + 1)));
  }

  function parseMarketData(data) {
    const points = data.trends.map((row) => {
      const fields = row.split(',');
      const time = fields[0].slice(-5);
      return {
        time,
        slot: minuteSlot(time),
        price: Number(fields[1]),
      };
    }).filter((point) => Number.isFinite(point.price));

    return {
      name: data.name,
      preClose: Number(data.preClose),
      points,
    };
  }

  function activeData() {
    return dataByKey[activeKey];
  }

  function findTextElement(text) {
    if (!document.body) return null;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeValue?.trim() === text) return node.parentElement;
    }
    return null;
  }

  function findTargetCanvas() {
    const anchor = findTextElement('今日两市成交') || findTextElement('今日三市成交');
    if (!anchor) return null;

    for (let element = anchor; element && element.parentElement; element = element.parentElement) {
      const canvases = [...element.querySelectorAll('canvas')]
        .filter((canvas) => {
          if (canvas.id === OVERLAY_ID) return false;
          const rect = canvas.getBoundingClientRect();
          return rect.width > 280 && rect.height > 180;
        })
        .sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          return br.width * br.height - ar.width * ar.height;
        });
      if (canvases.length) return canvases[0];
      if (element.id === 'root') break;
    }
    return null;
  }

  function prepareCanvas() {
    const rect = targetCanvas.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    overlayCanvas.width = Math.round(width * dpr);
    overlayCanvas.height = Math.round(height * dpr);
    overlayCanvas.style.width = `${width}px`;
    overlayCanvas.style.height = `${height}px`;
    const ctx = overlayCanvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    return { ctx, width, height };
  }

  function styleSwitchButtons() {
    if (!switchPanel) return;
    switchPanel.querySelectorAll('button').forEach((button) => {
      const selected = button.dataset.key === activeKey;
      const color = INDEXES[button.dataset.key].color;
      button.style.background = selected ? color : 'transparent';
      button.style.color = selected ? '#fff' : '#606672';
      button.style.fontWeight = selected ? '650' : '500';
    });
  }

  function showStatus(text) {
    if (!quoteElement) return;
    quoteElement.textContent = text;
    quoteElement.style.color = statusByKey[activeKey]?.error ? '#d84b4b' : INDEXES[activeKey].color;
  }

  function updateQuote(point, percent, hovered) {
    if (!quoteElement) return;
    const time = hovered ? `${point.time} ` : '';
    quoteElement.textContent = `${time}${point.price.toFixed(2)} ${percent >= 0 ? '+' : ''}${percent.toFixed(2)}%`;
    quoteElement.style.color = INDEXES[activeKey].color;
  }

  function drawStatus(text) {
    if (overlayCanvas && targetCanvas) prepareCanvas();
    showStatus(text);
  }

  function drawOverlay() {
    const chartData = activeData();
    if (!overlayCanvas || !targetCanvas || !chartData?.points.length) return;

    const config = INDEXES[activeKey];
    const { ctx, width, height } = prepareCanvas();
    const left = width * 0.04;
    const right = width * 0.04;
    const top = height * (20 / 468);
    const bottom = height * ((20 + 324) / 468);
    const plotWidth = width - left - right;
    const plotHeight = bottom - top;
    const preClose = chartData.preClose;
    const percents = chartData.points.map((point) => (point.price / preClose - 1) * 100);
    const maxObserved = Math.max(...percents.map(Math.abs), 0.15);
    const limit = Math.ceil(maxObserved * 10) / 10;
    const xForSlot = (slot) => left + slot / 240 * plotWidth;
    const yForPercent = (percent) => top + (limit - percent) / (limit * 2) * plotHeight;

    const baselineY = yForPercent(0);
    ctx.strokeStyle = config.lineAlpha;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(left, baselineY);
    ctx.lineTo(width - right, baselineY);
    ctx.stroke();
    ctx.setLineDash([]);

    const gradient = ctx.createLinearGradient(0, top, 0, bottom);
    gradient.addColorStop(0, config.fillTop);
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.beginPath();
    chartData.points.forEach((point, index) => {
      const x = xForSlot(point.slot);
      const y = yForPercent(percents[index]);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.lineTo(xForSlot(chartData.points.at(-1).slot), baselineY);
    ctx.lineTo(xForSlot(chartData.points[0].slot), baselineY);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    ctx.beginPath();
    chartData.points.forEach((point, index) => {
      const x = xForSlot(point.slot);
      const y = yForPercent(percents[index]);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = config.color;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();

    const latest = chartData.points.at(-1);
    const hovered = hoverSlot === null || hoverSlot > latest.slot
      ? null
      : chartData.points.reduce((closest, point) => (
        Math.abs(point.slot - hoverSlot) < Math.abs(closest.slot - hoverSlot) ? point : closest
      ));
    const focus = hovered || latest;
    const focusPercent = (focus.price / preClose - 1) * 100;
    const focusX = xForSlot(focus.slot);
    const focusY = yForPercent(focusPercent);
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(focusX, focusY, hovered ? 4 : 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = config.color;
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    [limit, 0, -limit].forEach((percent) => {
      const label = `${percent > 0 ? '+' : ''}${percent.toFixed(1)}%`;
      const labelWidth = ctx.measureText(label).width + 5;
      const y = yForPercent(percent);
      ctx.fillStyle = 'rgba(255,255,255,.80)';
      ctx.fillRect(width - right - labelWidth, y - 7, labelWidth, 14);
      ctx.fillStyle = config.color;
      ctx.fillText(label, width - right - 2, y);
    });

    updateQuote(focus, focusPercent, Boolean(hovered));
    const priceChange = focus.price - preClose;
    overlayCanvas.title = `${config.label} ${focus.time} ${focus.price.toFixed(2)}，${priceChange >= 0 ? '上涨' : '下跌'} ${Math.abs(priceChange).toFixed(2)}，涨跌幅 ${focusPercent.toFixed(2)}%`;
  }

  function handlePointerMove(event) {
    const chartData = activeData();
    if (!targetCanvas || !chartData?.points.length) return;
    const rect = targetCanvas.getBoundingClientRect();
    const left = rect.width * 0.04;
    const right = rect.width * 0.04;
    const top = rect.height * (20 / 468);
    const bottom = rect.height * ((20 + 324) / 468);
    const localX = event.clientX - rect.left;
    const localY = event.clientY - rect.top;
    if (localX < left || localX > rect.width - right || localY < top || localY > bottom) {
      clearHover();
      return;
    }
    const nextSlot = Math.round((localX - left) / (rect.width - left - right) * 240);
    if (nextSlot !== hoverSlot) {
      hoverSlot = nextSlot;
      drawOverlay();
    }
  }

  function clearHover() {
    if (hoverSlot === null) return;
    hoverSlot = null;
    drawOverlay();
  }

  function switchIndex(nextKey) {
    if (!INDEXES[nextKey] || nextKey === activeKey) return;
    activeKey = nextKey;
    hoverSlot = null;
    styleSwitchButtons();
    const data = activeData();
    if (data) drawOverlay();
    else drawStatus(statusByKey[activeKey]?.text || '加载中…');
    refreshData(activeKey);
    scheduleRefresh();
  }

  function createSwitchPanel(container) {
    switchPanel = document.createElement('div');
    switchPanel.id = SWITCH_ID;
    switchPanel.style.cssText = [
      'position:absolute',
      'top:4px',
      'left:50%',
      'transform:translateX(-50%)',
      'z-index:21',
      'display:flex',
      'align-items:center',
      'gap:2px',
      'height:28px',
      'padding:2px',
      'border:1px solid rgba(118,87,232,.22)',
      'border-radius:7px',
      'background:rgba(255,255,255,.94)',
      'box-shadow:0 2px 8px rgba(31,42,63,.08)',
      'font-family:system-ui,-apple-system,"PingFang SC",sans-serif',
      'white-space:nowrap',
      'pointer-events:auto',
    ].join(';');

    Object.entries(INDEXES).forEach(([key, config]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.key = key;
      button.textContent = config.shortLabel;
      button.style.cssText = 'height:22px;padding:0 7px;border:0;border-radius:5px;font-size:11px;line-height:22px;cursor:pointer;font-family:inherit;';
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        switchIndex(key);
      });
      switchPanel.appendChild(button);
    });

    quoteElement = document.createElement('span');
    quoteElement.style.cssText = 'padding:0 5px 0 4px;font-size:10px;font-weight:600;line-height:22px;';
    quoteElement.textContent = statusByKey[activeKey]?.text || '加载中…';
    switchPanel.appendChild(quoteElement);
    container.appendChild(switchPanel);
    styleSwitchButtons();
  }

  function attachOverlay() {
    const found = findTargetCanvas();
    if (!found) return false;
    if (targetCanvas === found && overlayCanvas?.isConnected && switchPanel?.isConnected) return true;

    resizeObserver?.disconnect();
    overlayCanvas?.remove();
    switchPanel?.remove();
    if (pointerContainer) {
      pointerContainer.removeEventListener('pointermove', handlePointerMove, true);
      pointerContainer.removeEventListener('pointerleave', clearHover, true);
    }

    targetCanvas = found;
    const container = targetCanvas.parentElement;
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    overlayCanvas = document.createElement('canvas');
    overlayCanvas.id = OVERLAY_ID;
    overlayCanvas.setAttribute('aria-label', '叠加在成交额图上的市场指数分时线');
    overlayCanvas.style.cssText = 'position:absolute;inset:0;z-index:20;pointer-events:none;display:block;';
    container.appendChild(overlayCanvas);
    createSwitchPanel(container);

    pointerContainer = container;
    pointerContainer.addEventListener('pointermove', handlePointerMove, { capture: true, passive: true });
    pointerContainer.addEventListener('pointerleave', clearHover, { capture: true, passive: true });
    resizeObserver = new ResizeObserver(() => {
      if (activeData()) drawOverlay();
    });
    resizeObserver.observe(targetCanvas);
    if (activeData()) drawOverlay();
    else drawStatus(statusByKey[activeKey]?.text || '加载中…');
    return true;
  }

  async function refreshData(key = activeKey) {
    if (!INDEXES[key] || loadingKeys.has(key)) return;
    loadingKeys.add(key);
    statusByKey[key] = { text: '加载中…', error: false };
    if (key === activeKey && !dataByKey[key]) drawStatus('加载中…');
    try {
      dataByKey[key] = parseMarketData(await fetchMarketData(INDEXES[key]));
      statusByKey[key] = { text: '', error: false };
      if (key === activeKey) drawOverlay();
    } catch (error) {
      statusByKey[key] = { text: '加载失败', error: true };
      if (key === activeKey && !dataByKey[key]) drawStatus('加载失败');
    } finally {
      loadingKeys.delete(key);
    }
  }

  function isTradingWindow() {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Shanghai',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date()).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
    if (!['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(parts.weekday)) return false;
    const minutes = Number(parts.hour) * 60 + Number(parts.minute);
    return (minutes >= 9 * 60 + 25 && minutes <= 11 * 60 + 35)
      || (minutes >= 12 * 60 + 55 && minutes <= 15 * 60 + 5);
  }

  function nextRefreshDelay() {
    return !activeData() || isTradingWindow() ? ACTIVE_REFRESH_MS : IDLE_REFRESH_MS;
  }

  function scheduleRefresh(delay = nextRefreshDelay()) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      if (!document.hidden) await refreshData(activeKey);
      scheduleRefresh();
    }, delay);
  }

  function startMounting() {
    if (!document.documentElement) {
      setTimeout(startMounting, 20);
      return;
    }
    const observer = new MutationObserver(() => {
      if (!overlayCanvas?.isConnected || !targetCanvas?.isConnected || !switchPanel?.isConnected) {
        attachOverlay();
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    if (!attachOverlay()) {
      mountTimer = setInterval(() => {
        if (attachOverlay()) {
          clearInterval(mountTimer);
          mountTimer = null;
        }
      }, MOUNT_RETRY_MS);
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      attachOverlay();
      refreshData(activeKey);
      scheduleRefresh();
    }
  });

  startMounting();
  refreshData(activeKey);
  scheduleRefresh();
})();
