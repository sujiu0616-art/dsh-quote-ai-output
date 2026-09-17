// dsh-quote-ai-output — browser half.
//
// 引用 AI 回复内容：
//   1. 选中文本 → 浮动工具栏 → 点击「引用」
//   2. 引用存入模块数组，输入框上方显示 [引用内容] 预览
//   3. 发送时自动将引用文本注入消息
//
// 适配 DSH 0.1.5-rc.1：
//   - 新版产品 DOM 不再有 chatFlowKey/chatFlowKind 标识、输入框由 textarea 改为
//     Lexical contentEditable → 来源识别改用会话快照宽松匹配；发送注入改用
//     官方 inputActions（Enter 捕获 → setDraft → 下一 tick submit）。

window.__ModuleLoader__.load({
  id: 'dsh-quote-ai-output',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require('react');
    const inject = ['slots', 'sessions', 'inputTriggers', 'timer'];
    const SOURCE = 'quote';

    /* ================= 纯函数 ================= */

    function summarize(text, max) {
      const flat = text.replace(/\s+/g, ' ').trim();
      return flat.length > max ? flat.slice(0, max) + '…' : flat;
    }

    function expandText(text, turn, timestamp, sessionTitle, kind) {
      const speaker = kind === 'user' ? '用户消息' : (turn != null ? `第 ${turn} 轮回复` : 'AI 回复');
      const time = timestamp ? formatTime(timestamp) : '';
      const session = sessionTitle ? `来自「${sessionTitle}」` : '';
      const parts = [speaker, time, session].filter(Boolean);
      return `【${parts.join(' · ')}】${text}`;
    }

    function labelOf(text) {
      return summarize(text, 30) || '引用';
    }

    function formatTime(ts) {
      const d = new Date(ts);
      const pad = n => String(n).padStart(2, '0');
      return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    }

    // 折叠空白，用于选区文本与消息原文的宽松比对（忽略 markdown 渲染差异）
    function normalize(text) {
      return String(text).replace(/\s+/g, ' ').trim();
    }

    // 消息原文：正文 + 思考块按序拼接
    function messageTextOf(node) {
      return (node.blocks || [])
        .filter((b) => b.kind === 'text' || b.kind === 'reasoning')
        .map((b) => b.text).join('\n');
    }

    /* ================= 模块级状态 ================= */

    // 由 QuoteDock 每次渲染刷新：模块级逻辑（浮动工具栏 / Enter 注入）读取
    let _runtime = null;
    let floatingEl = null, floatingData = null;
    const pendingQuotes = []; // { id, text, label, turn, timestamp, sessionTitle, kind }
    const dockListeners = new Set();

    function notifyDock() {
      dockListeners.forEach(fn => { try { fn(); } catch {} });
    }

    // 用户消息原文（content 是 ContentBlock[]，取文本块）
    function userTextOf(node) {
      return (node.content || [])
        .filter((b) => b && b.type === 'text')
        .map((b) => b.text).join('\n');
    }

    // 用会话快照宽松匹配选区文本，定位来源消息（新版无 DOM 标识可用）
    function resolveSource(text) {
      try {
        const rt = _runtime;
        const nodes = (rt && rt.nodes) || [];
        const needle = normalize(text);
        if (!needle) return null;
        for (const node of nodes) {
          if (node.kind === 'assistant') {
            const full = messageTextOf(node);
            if (full && normalize(full).indexOf(needle) >= 0) {
              return { kind: 'assistant', turn: node.turn, seq: node.seq, messageId: node.messageId };
            }
          } else if (node.kind === 'user') {
            const full = userTextOf(node);
            if (full && normalize(full).indexOf(needle) >= 0) {
              return { kind: 'user', turn: null, seq: node.seq, messageId: null };
            }
          }
        }
      } catch {}
      return null;
    }

    function addQuote(text) {
      const src = resolveSource(text);
      const ts = Date.now();
      // 当前会话标题（尽力而为；拿不到则省略来源标注）
      let sessionTitle = '';
      try {
        const rt = _runtime;
        const snap = rt && rt.sessionsSnap;
        const id = rt && rt.sessionId;
        if (snap && snap.byId && id && snap.byId[id]) {
          sessionTitle = snap.byId[id].title || snap.byId[id].displayTitle || '';
        }
      } catch {}
      const q = {
        id: ts + '_' + Math.random().toString(36).slice(2, 6),
        text, label: labelOf(text),
        turn: src ? src.turn : null,
        seq: src ? src.seq : null,
        timestamp: ts, sessionTitle, kind: src ? src.kind : 'assistant',
      };
      pendingQuotes.push(q);
      notifyDock();
    }

    function removeQuote(id) {
      const idx = pendingQuotes.findIndex(q => q.id === id);
      if (idx >= 0) { pendingQuotes.splice(idx, 1); notifyDock(); }
    }

    function clearQuotes() {
      pendingQuotes.length = 0;
      notifyDock();
    }

    function getQuotesText() {
      if (pendingQuotes.length === 0) return '';
      return pendingQuotes.map(q => expandText(q.text, q.turn, q.timestamp, q.sessionTitle, q.kind)).join('\n');
    }

    /* ================= 浮动工具栏 ================= */

    function hideFloating() {
      if (floatingEl) floatingEl.style.display = 'none';
      floatingData = null;
    }

    function setupFloatingToolbar() {
      floatingEl = document.createElement('div');
      floatingEl.className = 'dsh-quote-floating';
      floatingEl.style.display = 'none';

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'dsh-quote-floating-btn';
      btn.textContent = '引用';
      floatingEl.appendChild(btn);
      document.body.appendChild(floatingEl);

      btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        if (floatingData) {
          addQuote(floatingData.text);
          hideFloating();
          try { window.getSelection()?.removeAllRanges(); } catch {}
        }
      });

      document.addEventListener('mouseup', () => setTimeout(checkSelection, 10));
      document.addEventListener('mousedown', (e) => {
        if (floatingEl && !floatingEl.contains(e.target)) hideFloating();
      });
      document.addEventListener('scroll', hideFloating, true);
    }

    function checkSelection() {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !String(sel).trim()) return;
      const anchor = sel.anchorNode;
      const el = anchor && anchor.nodeType === 3 ? anchor.parentElement : anchor;
      // 输入框内的选区不触发引用工具栏
      if (el && el.closest && el.closest('[data-composer-card]')) return;
      const range = sel.getRangeAt(0);
      const rects = range.getClientRects();
      if (rects.length === 0) return;
      // 取最后一行的矩形
      const lastRect = rects[rects.length - 1];
      floatingEl.style.display = 'flex';
      floatingEl.style.left = Math.min(lastRect.right + 28, window.innerWidth - 100) + 'px';
      floatingEl.style.top = Math.max(8, lastRect.bottom + 4) + 'px';
      floatingData = { text: String(sel) };
    }

    /* ================= Dock 组件 ================= */

    function QuoteDock(props) {
      const [, forceUpdate] = React.useState(0);
      const { useChat, useSessions, useInput, inputActions, sessionId } = props;

      // 消息节点：新版由 useChat 提供（ChatSnapshot.legacy.nodes）
      const chat = useChat === undefined ? undefined : useChat((s) => s);
      const sessionsSnap = useSessions === undefined ? undefined : useSessions((s) => s);
      const input = useInput((s) => s);
      const nodes = (chat && chat.legacy && chat.legacy.nodes) || [];

      // 模块级逻辑（浮动工具栏 / Enter 注入）在 React 之外运行，需要最新引用
      React.useEffect(() => {
        _runtime = { nodes, sessionsSnap, input, inputActions, sessionId };
      });

      React.useEffect(() => {
        const listener = () => forceUpdate(n => n + 1);
        dockListeners.add(listener);
        return () => dockListeners.delete(listener);
      }, []);

      if (pendingQuotes.length === 0) return null;

      return React.createElement('div', { className: 'dsh-quote-dock' },
        pendingQuotes.map((q) =>
          React.createElement('div', { key: q.id, className: 'dsh-quote-preview' },
            React.createElement('span', { className: 'dsh-quote-preview-text', title: q.text }, q.text),
            React.createElement('button', {
              type: 'button', className: 'dsh-quote-preview-del', title: '移除',
              onClick: () => removeQuote(q.id),
            }, '✕')
          )
        )
      );
    }

    /* ================= 注册层 ================= */

    function injectStyles(css) {
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-quote-ai-output';
      tag.textContent = css;
      document.head.append(tag);
    }

    function apply(ctx) {
      const slots = ctx.get('slots');
      const sessions = ctx.get('sessions');
      const inputTriggers = ctx.get('inputTriggers');
      if (!slots || !sessions || !inputTriggers) return;

      // 发送时序列化：引用条目在提交时展开为模型可见文本
      ctx.effect(() => inputTriggers.registerSource({
        trigger: '@',
        name: SOURCE,
        order: 99,
        showGroupTitle: false,
        candidates: async () => [],
        onPick: () => undefined,
        codec: {
          clipboardText: () => '@引用',
          serialize: (ref) => Promise.resolve(expandText(ref, null, null, '', 'assistant')),
        },
      }), 'quote: codec source');

      // Dock：输入框上方的引用预览（引用在此管理，发送时注入）
      slots.inject('conversation.input.dock', () => slots.register({
        name: 'conversation.input.dock',
        id: 'quote-dock',
        order: 5,
        label: () => '引用',
      }, QuoteDock));

      // 浮动工具栏
      setupFloatingToolbar();

      // 发送前注入引用：捕获 Enter → 官方 setDraft 写入引用块 → 下一 tick 提交
      // （新版输入框是 Lexical contentEditable，无法再靠 DOM 取 textarea 值）
      ctx.effect(() => {
        const handler = (e) => {
          if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
          if (pendingQuotes.length === 0) return;
          const rt = _runtime;
          if (!rt || !rt.inputActions || !rt.input) return;
          e.preventDefault();
          e.stopPropagation();
          const quoteText = getQuotesText();
          const current = rt.input.draft || '';
          rt.inputActions.setDraft(current ? quoteText + '\n\n' + current : quoteText);
          clearQuotes();
          // 等编辑器同步完成再提交，确保引用随消息一起发出
          ctx.timeout(() => { try { rt.inputActions.submit(); } catch {} }, 30);
        };
        document.addEventListener('keydown', handler, true);
        return () => document.removeEventListener('keydown', handler, true);
      }, 'quote: enter injector');

      // 样式
      injectStyles(`
.dsh-quote-floating{position:fixed;z-index:10000;transform:translateX(-50%);display:flex;align-items:center;pointer-events:auto}
.dsh-quote-floating-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.09));background:var(--dsw-alias-bg-overlay,#fff);color:var(--dsw-alias-label-primary,#18181b);border-radius:10px;padding:7px 18px;font-size:13px;font-weight:500;cursor:pointer;white-space:nowrap;line-height:1.4;box-shadow:0 1px 4px rgba(0,0,0,.08),0 2px 8px rgba(0,0,0,.04)}
.dsh-quote-floating-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.12))}
.dsh-quote-dock{box-sizing:border-box;width:100%;max-width:var(--dsh-composer-card-max-width,680px);margin:0 auto 8px;padding:0;border:0;display:flex;flex-direction:column;gap:0;position:relative;overflow:hidden;border-radius:12px;border-left:3px solid var(--dsw-alias-state-business-primary,#3b82f6);background:var(--dsw-alias-bg-layer-2,rgba(39,39,42,.55))}
.dsh-quote-preview{display:flex;align-items:flex-start;gap:10px;padding:10px 14px 10px 14px;position:relative}
.dsh-quote-preview+.dsh-quote-preview{border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.06))}
.dsh-quote-preview-content{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.dsh-quote-preview-label{font-size:11px;color:var(--dsw-alias-label-tertiary,#71717a);line-height:1.3;font-weight:500;letter-spacing:.01em}
.dsh-quote-preview-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-dimmed,#a1a1aa);font-size:13px;line-height:1.5}
.dsh-quote-preview-del{appearance:none;border:none;background:transparent;color:var(--dsw-alias-label-tertiary,#71717a);opacity:0;cursor:pointer;font-size:11px;padding:4px 6px;border-radius:4px;line-height:1;transition:opacity .15s;flex:none;align-self:center}
.dsh-quote-preview:hover .dsh-quote-preview-del{opacity:.7}
.dsh-quote-preview-del:hover{opacity:1;color:var(--dsw-alias-label-primary,#fafafa)}
`);
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
