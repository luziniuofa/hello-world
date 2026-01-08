// ==UserScript==
// @name         Bilibili 关注动态导出 Markdown V2
// @namespace    https://example.com/bili-md-export-v2
// @version      2.0.0
// @description  基于精准 DOM 选择器的 B 站动态导出工具，支持作者链接与结构化视频信息
// @author       AI Agent
// @match        https://t.bilibili.com/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  let running = false;

  /* ========== 工具函数 ========== */
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const text = el => el ? el.innerText.trim().replace(/\s+/g, ' ') : '';
  const attr = (el, name) => el ? el.getAttribute(name) : '';
  const mdText = s => s ? String(s).replace(/\|/g, '｜').replace(/\n/g, '<br>') : '';

  function allCards() {
    return Array.from(
      document.querySelectorAll('[data-testid="dyn-item"], .bili-dyn-item')
    );
  }

  function getTime(card) {
    return text(card.querySelector('time')) ||
           text(card.querySelector('.bili-dyn-time'));
  }

  /* ========== 时间判断 ========== */
  const isToday = t => /分钟前|小时前|刚刚/.test(t);
  const isYesterday = t => /^昨天\s+\d{1,2}:\d{2}/.test(t);
  const isTwoDaysAgo = t => /^2\s*天前$/.test(t);

  /* ========== 核心解析 (V2 DOM-based) ========== */
  
  /**
   * 解析作者信息
   */
  function parseAuthor(card) {
    const authorEl = card.querySelector('.bili-dyn-title__text') || card.querySelector('.bili-dyn-author__name');
    if (!authorEl) return { name: '未知作者', space: '' };
    
    let space = attr(authorEl, 'href') || '';
    if (space && space.startsWith('//')) space = 'https:' + space;
    
    return {
      name: text(authorEl),
      space: space
    };
  }

  /**
   * 解析视频卡片信息
   */
  function parseVideo(card) {
    const videoContainer = card.querySelector('.bili-dyn-card-video');
    if (!videoContainer) return null;

    const titleEl = videoContainer.querySelector('.bili-dyn-card-video__title');
    let title = text(titleEl);
    let duration = text(videoContainer.querySelector('.bili-dyn-card-video__duration'));
    const statItems = videoContainer.querySelectorAll('.bili-dyn-card-video__stat-item');
    
    let playCount = statItems.length > 0 ? text(statItems[0]) : '';
    let danmakuCount = statItems.length > 1 ? text(statItems[1]) : '';
    
    const fullText = text(videoContainer);

    // 容错与精化
    if (!duration || !playCount) {
      // 提取时长 (仅匹配 00:00 这种格式，排除 2025-01-08)
      const durMatch = fullText.match(/(?<!\d)\d{1,2}:\d{2}(?::\d{2})?(?!\d)/);
      if (!duration && durMatch) duration = durMatch[0];
      
      // 提取统计数据 (末尾的 播放量 弹幕数)
      const statMatch = fullText.match(/(\d+(\.\d+)?万?)\s+(\d+(\.\d+)?万?)$/);
      if (statMatch) {
        if (!playCount) playCount = statMatch[1];
        if (!danmakuCount) danmakuCount = statMatch[3];
      }
    }

    // 清洗标题：如果标题开头重复包含了时长，剔除它
    if (duration && title.startsWith(duration)) {
      title = title.slice(duration.length).trim();
    }
    
    // 链接：优先取卡片内的第一个视频链接，通常是封面或标题
    const linkEl = videoContainer.closest('a') || videoContainer.querySelector('a') || card.querySelector('a[href*="/video/"]');
    let link = attr(linkEl, 'href') || '';
    if (link && link.startsWith('//')) link = 'https:' + link;
    if (link && link.includes('?')) link = link.split('?')[0]; // 去掉追踪参数

    return {
      title,
      duration,
      playCount,
      danmakuCount,
      link,
      description: '' 
    };
  }

  /**
   * 解析转发信息
   */
  function parseForward(card) {
    const origContainer = card.querySelector('.bili-dyn-item__orig');
    if (!origContainer) return null;

    const origAuthorEl = origContainer.querySelector('.bili-dyn-orig-author__name');
    const origContentEl = origContainer.querySelector('.bili-dyn-content__orig__text') || origContainer.querySelector('.bili-dyn-card-text');

    return {
      origAuthor: text(origAuthorEl),
      origContent: text(origContentEl)
    };
  }

  /* ========== 采集逻辑 ========== */
  function collect(mode) {
    return allCards().map(card => {
      const time = getTime(card);
      if (!time) return null;

      if (
        (mode === 'today' && !isToday(time)) ||
        (mode === 'yesterday' && !isYesterday(time))
      ) return null;

      const authorInfo = parseAuthor(card);
      const videoInfo = parseVideo(card);
      const forwardInfo = parseForward(card);
      
      const contentEl = card.querySelector('.bili-dyn-content__text') || card.querySelector('.bili-dyn-card-text');
      const dynamicText = text(contentEl);

      // 类型判断
      let type = '动态';
      if (videoInfo) type = '视频';
      else if (forwardInfo) type = '转发';

      return {
        type,
        author: authorInfo.name,
        authorSpace: authorInfo.space,
        time,
        text: dynamicText,
        video: videoInfo,
        forward: forwardInfo,
        debugRaw: {
          authorRaw: text(card.querySelector('.bili-dyn-title__text')) || text(card.querySelector('.bili-dyn-author__name')),
          contentRaw: text(card.querySelector('.bili-dyn-content')) || text(card.querySelector('.bili-dyn-card-text')),
          videoRaw: videoInfo ? text(card.querySelector('.bili-dyn-card-video')) : null
        }
      };
    }).filter(Boolean);
  }

  /* ========== 滚动 (复用 V1 逻辑) ========== */
  async function scrollYesterday(debug) {
    let stable = 0;
    let lastCount = 0;
    let seenTwoDaysAgo = false;

    for (let round = 1; round <= 60; round++) {
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(1500);

      let yesterdayCount = 0;

      allCards().forEach(card => {
        const t = getTime(card);
        if (isYesterday(t)) yesterdayCount++;
        if (isTwoDaysAgo(t)) seenTwoDaysAgo = true;
      });

      if (seenTwoDaysAgo) {
        if (yesterdayCount === lastCount) stable++;
        else stable = 0;

        if (stable >= 3) {
          debug.scrollRounds = round;
          debug.stopReason = '昨天数量稳定 + 已出现 2天前';
          break;
        }
      }

      lastCount = yesterdayCount;
    }

    await sleep(2000);
  }

  /* ========== 导出 (增强 V2) ========== */
  function exportMD(items, debug) {
    const groups = { 视频: [], 动态: [], 转发: [] };
    items.forEach(i => groups[i.type].push(i));

    let md = '# Bilibili 关注动态 (V2)\n\n';

    // 视频表格
    if (groups.视频.length) {
      md += '## 📺 视频\n';
      md += '| UP主 | 标题 | 时长 | 播放 | 弹幕 | 链接 |\n';
      md += '| ---- | ---- | ---- | ---- | ---- | ---- |\n';
      groups.视频.forEach(i => {
        const authorDisplay = mdText(i.author);
        const authorLink = i.authorSpace ? `[${authorDisplay}](${i.authorSpace})` : authorDisplay;
        md += `| ${authorLink} | ${mdText(i.video.title)} | ${mdText(i.video.duration)} | ${mdText(i.video.playCount)} | ${mdText(i.video.danmakuCount)} | ${i.video.link} |\n`;
      });
      md += '\n';
    }

    // 动态表格
    if (groups.动态.length) {
      md += '## 📝 动态\n';
      md += '| UP主 | 内容 | 时间 | 链接 |\n';
      md += '| ---- | ---- | ---- | ---- |\n';
      groups.动态.forEach(i => {
        const authorDisplay = mdText(i.author);
        const authorLink = i.authorSpace ? `[${authorDisplay}](${i.authorSpace})` : authorDisplay;
        md += `| ${authorLink} | ${mdText(i.text)} | ${mdText(i.time)} | - |\n`;
      });
      md += '\n';
    }

    // 转发表格
    if (groups.转发.length) {
      md += '## 🔁 转发\n';
      md += '| UP主 | 转发理由 | 原作者 | 原内容 |\n';
      md += '| ---- | ---- | ---- | ---- |\n';
      groups.转发.forEach(i => {
        const authorDisplay = mdText(i.author);
        const authorLink = i.authorSpace ? `[${authorDisplay}](${i.authorSpace})` : authorDisplay;
        md += `| ${authorLink} | ${mdText(i.text)} | ${mdText(i.forward.origAuthor)} | ${mdText(i.forward.origContent)} |\n`;
      });
      md += '\n';
    }

    md += '\n---\n## Debug 信息\n```json\n';
    md += JSON.stringify({
      ...debug,
      items: items.map(i => ({
        type: i.type,
        author: i.author,
        title: i.type === '视频' ? i.video.title : (i.type === '转发' ? i.forward.origContent : i.text),
        debugRaw: i.debugRaw
      }))
    }, null, 2);
    md += '\n```\n';

    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    
    // 计算日期：如果是收集昨天，文件名应该显示昨天的日期
    const fileDate = new Date();
    fileDate.setDate(fileDate.getDate() - 1); 
    const dateStr = fileDate.toISOString().slice(0, 10);
    
    a.href = URL.createObjectURL(blob);
    a.download = `bilibili_v2_${dateStr}.md`;
    a.click();
  }

  /* ========== 主流程 ========== */
  async function startYesterday() {
    if (running) return;
    running = true;

    const debug = {
      mode: 'yesterday',
      startTime: new Date().toISOString(),
      version: '2.0.0'
    };

    try {
      await scrollYesterday(debug);
      const items = collect('yesterday');
      debug.totalCollected = items.length;

      const ok = confirm(`V2 收集完成：${items.length} 条\n\n确定：导出 Markdown\nESC：取消`);
      if (ok) exportMD(items, debug);
    } finally {
      running = false;
    }
  }

  /* ========== UI (V2) ========== */
  const panel = document.createElement('div');
  panel.style.cssText = `
    position: fixed;
    right: 16px;
    bottom: 16px;
    z-index: 99999;
    background: #fff;
    border: 1px solid #00aeec;
    border-radius: 8px;
    padding: 10px;
    box-shadow: 0 4px 12px rgba(0,0,0,.15);
  `;

  panel.innerHTML = `
    <div style="margin-bottom: 8px; font-weight: bold; color: #00aeec; font-size: 12px;">Bili Export V2</div>
    <button id="bili-yesterday-v2" style="cursor: pointer; background: #00aeec; color: #fff; border: none; padding: 6px 12px; border-radius: 4px;">收集昨天</button>
  `;
  document.body.appendChild(panel);
  document.getElementById('bili-yesterday-v2').onclick = startYesterday;

})();
