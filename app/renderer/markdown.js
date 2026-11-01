'use strict';
// A small, safe Markdown subset for agent messages: everything is escaped
// first, then fences, inline code, bold, italics, headings, lists and links.
(function () {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  function inline(s) {
    return s
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?]|$)/g, '$1<em>$2</em>')
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  }

  function render(src) {
    const parts = String(src || '').split(/```/);
    let html = '';
    parts.forEach((part, i) => {
      if (i % 2 === 1) {
        const body = part.replace(/^[\w+-]*\n/, '');
        html += `<pre><code>${esc(body.replace(/\n$/, ''))}</code></pre>`;
        return;
      }
      const lines = esc(part).split('\n');
      let list = null;
      let para = [];
      const flushPara = () => {
        if (para.length) html += `<p>${inline(para.join('<br>'))}</p>`;
        para = [];
      };
      const flushList = () => {
        if (list) html += `<${list.tag}>${list.items.map((x) => `<li>${inline(x)}</li>`).join('')}</${list.tag}>`;
        list = null;
      };
      for (const line of lines) {
        const h = /^(#{1,4})\s+(.*)$/.exec(line);
        const ul = /^\s*[-*]\s+(.*)$/.exec(line);
        const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
        if (h) {
          flushPara();
          flushList();
          html += `<h${h[1].length + 2}>${inline(h[2])}</h${h[1].length + 2}>`;
        } else if (ul || ol) {
          flushPara();
          const tag = ul ? 'ul' : 'ol';
          if (!list || list.tag !== tag) {
            flushList();
            list = { tag, items: [] };
          }
          list.items.push((ul || ol)[1]);
        } else if (!line.trim()) {
          flushPara();
          flushList();
        } else {
          flushList();
          para.push(line);
        }
      }
      flushPara();
      flushList();
    });
    return html;
  }

  window.md = { render, esc };
})();
