// dsh-quote-ai-output — browser half.
//
// 引用 AI 回复内容（持久插件版，逻辑与动态插件 quote-1/pkg-10 定稿一致）：
//   1. 每条定稿 AI 消息的操作条出现 ❝ 按钮（conversation.chat.assistant-actions）
//   2. 划词后点击引用选区片段，直接点击引用整条（onMouseDown preventDefault 保住选区）
//   3. 以官方「引用芯片」插入输入框末尾（conversation.input.for(binding.ctx).insertReference）
//   4. 发送时由 inputTriggers codec 序列化为：【引用 · 第 N 轮回复 · 摘要】原文…【引用结束】
//   5. ≥2 段引用时输入框上方显示管理条（conversation.input.dock，删除/清空）
//
// Hand-written classic-script bundle: the module table answers require()
// for 'react'; everything else is inlined here. No build step.

window.__ModuleLoader__.load({
  id: 'dsh-quote-ai-output',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');

    /** Required services (client runtime). */
    const inject = ['slots', 'sessions', 'inputTriggers'];

    const SOURCE = 'quote';

    /* ================= 纯函数层：文本工具 ================= */

    // 折叠空白并记录 规范化索引 -> 原始索引 映射（-1 表示折叠出的空格）
    function buildNormalized(text) {
      let n = '';
      const map = [];
      let pendingSpace = false;
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (/\s/.test(c)) { pendingSpace = n.length > 0; continue; }
        if (pendingSpace) { n += ' '; map.push(-1); pendingSpace = false; }
        n += c; map.push(i);
      }
      return { n, map };
    }

    // 在原文中宽松查找选区文本（忽略空白差异），返回原始偏移区间；找不到返回 null
    function locateLoose(full, needle) {
      const hay = buildNormalized(full);
      const nee = buildNormalized(needle);
      if (nee.n.length === 0) return null;
      const at = hay.n.indexOf(nee.n);
      if (at < 0) return null;
      let from = at; while (hay.map[from] < 0) from++;
      let to = at + nee.n.length - 1; while (hay.map[to] < 0) to--;
      return { from: hay.map[from], to: hay.map[to] + 1 };
    }

    // 消息原文：正文 + 思考块按序拼接（保留 markdown/代码/公式原始文本）
    function messageTextOf(node) {
      return (node.blocks || [])
        .filter((b) => b.kind === 'text' || b.kind === 'reasoning')
        .map((b) => b.text).join('\n');
    }

    function summarize(text, max) {
      const flat = text.replace(/\s+/g, ' ').trim();
      return flat.length > max ? flat.slice(0, max) + '…' : flat;
    }

    /* ================= 数据模型：ref = JSON 字符串 ================= */

    function makeRef(node, from, to, text) {
      return JSON.stringify({ v: 1, mid: node.messageId, seq: node.seq, turn: node.turn, from, to, text });
    }

    function labelOf(text) {
      const s = summarize(text, 16);
      return s.length === 0 ? '引用' : `引用 · ${s}`;
    }

    // 发送时展开（codec.serialize 输出；也是插入失败时的降级纯文本格式）
    function expandRef(ref) {
      let data;
      try { data = JSON.parse(ref); } catch { return String(ref); }
      const excerpt = summarize(data.text || '', 40);
      // 用 turn 轮次号（而非事件 seq 流水号），对用户更友好
      const where = typeof data.turn === 'number' ? `第 ${data.turn} 轮回复` : 'AI 回复';
      const head = excerpt.length > 0 ? `【引用 · ${where} · ${excerpt}】` : `【引用 · ${where}】`;
      return `${head}\n${data.text}\n【引用结束】`;
    }

    /* ================= 组件层 ================= */

    // 每条定稿 AI 消息操作条上的引用按钮：划词点击引用选区，否则引用整条
    function QuoteAction(props) {
      const { messageId, useSession, useInput, inputActions, insertQuote } = props;
      const session = useSession((s) => s);
      const input = useInput((s) => s);
      const grab = () => {
        const node = (session.nodes || []).find((n) => n.kind === 'assistant' && n.messageId === messageId);
        if (node === undefined) return;
        const full = messageTextOf(node);
        if (full.length === 0) return;
        let text = full, from = 0, to = full.length;
        const selection = window.getSelection ? window.getSelection().toString() : '';
        if (selection !== null && selection.trim().length > 0) {
          const hit = locateLoose(full, selection);
          if (hit !== null) { from = hit.from; to = hit.to; text = full.slice(from, to); }
          else text = selection; // 渲染与原文差异（markdown 符号等）：退化用选区文本
        }
        const reference = { source: SOURCE, ref: makeRef(node, from, to, text), label: labelOf(text), clipboardText: '@引用' };
        const span = { start: input.draft.length, end: input.draft.length, draftRev: input.draftRev };
        const applied = insertQuote(reference, span);
        if (applied !== true) {
          // 兜底：纯文本追加引用块（内容不丢）
          const block = expandRef(reference.ref);
          inputActions.setDraft(input.draft.length === 0 ? block : `${input.draft}\n\n${block}`);
        }
      };
      const onMouseDown = (e) => { e.preventDefault(); grab(); }; // preventDefault 保住选区不被点击清除
      const onKeyDown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); grab(); } };
      return React.createElement('button', {
        type: 'button', className: 'dsh-quote-action', title: '引用此内容', 'aria-label': '引用此内容',
        onMouseDown, onKeyDown,
      }, React.createElement('span', { className: 'dsh-quote-action-icon' }, '❝'));
    }

    // 输入框上方的引用管理器：仅当 draft 含 ≥2 段引用时显示（单条时 chip 直接在输入框里，无需管理条）
    function QuoteDock(props) {
      const { input, inputActions } = props; // InputZone owner 快照（occurrences 已按 offset 排序）
      const quotes = (input.occurrences || []).filter((o) => o.source === SOURCE);
      if (quotes.length < 2) return null; // 单条引用不显示管理条；删除/编辑直接在输入框操作 chip 文本

      const removeOne = (occurrence) => {
        let text = input.draft;
        for (const o of quotes.filter((x) => x.occurrenceId === occurrence.occurrenceId).sort((a, b) => b.offset - a.offset)) {
          text = text.slice(0, o.offset) + text.slice(o.offset + o.length);
        }
        inputActions.setDraft(text);
      };
      const clearAll = () => {
        let text = input.draft;
        for (const o of [...quotes].sort((a, b) => b.offset - a.offset)) {
          text = text.slice(0, o.offset) + text.slice(o.offset + o.length);
        }
        inputActions.setDraft(text);
      };

      const row = (o) => React.createElement('div', { key: o.occurrenceId, className: 'dsh-quote-item' },
        React.createElement('span', { className: 'dsh-quote-item-label', title: o.label }, o.label),
        React.createElement('span', { className: 'dsh-quote-item-actions' },
          React.createElement('button', { type: 'button', className: 'dsh-quote-item-btn', title: '删除', onClick: () => removeOne(o) }, '✕'),
        ));
      return React.createElement('div', { className: 'dsh-quote-dock' },
        React.createElement('div', { className: 'dsh-quote-dock-head' },
          React.createElement('span', { className: 'dsh-quote-dock-note' }, `已引用 ${quotes.length} 段 · 发送时将作为「引用」上下文标注`),
          React.createElement('button', { type: 'button', className: 'dsh-quote-item-btn', onClick: clearAll }, '清空引用'),
        ),
        React.createElement('div', { className: 'dsh-quote-dock-list' }, quotes.map(row)),
      );
    }

    /* ================= 注册层 ================= */

    // 包级样式（10% 中性半透明；深浅主题兼容；持久插件常驻，不随卸载清理）
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
      if (slots === undefined || sessions === undefined || inputTriggers === undefined) return;

      // 1) 发送时序列化 codec（必须注册，官方 sinkSerialized 按 source 名路由）
      //    空候选组会自动关闭菜单，不干扰 @文件/@会话 菜单
      ctx.effect(() => inputTriggers.registerSource({
        trigger: '@',
        name: SOURCE,
        order: 99,
        showGroupTitle: false,
        candidates: async () => [],
        onPick: () => undefined,
        codec: {
          clipboardText: () => '@引用',
          serialize: (ref) => Promise.resolve(expandRef(ref)),
        },
      }), 'quote: codec source');

      // 2) 每条定稿 AI 消息操作条上的引用按钮
      //    插入走官方公开服务 conversation.input.for(binding.ctx).insertReference
      //    （IConversation.input 是面向其它插件的公开入口；binding.ctx 仅作为参数传入官方 API）
      slots.inject('conversation.chat.assistant-actions', () => slots.register({
        name: 'conversation.chat.assistant-actions',
        id: 'quote',
        order: 20,
        label: () => '引用',
        inject: (sessionId) => {
          const binding = sessions.binding(sessionId);
          return {
            insertQuote: (reference, span) => {
              try {
                const actx = binding && binding.ctx;
                const conversation = ctx.get('conversation');
                if (actx === undefined || conversation === undefined || !conversation.input) return false;
                return conversation.input.for(actx).insertReference(reference, span) === true;
              } catch { return false; }
            },
          };
        },
      }, QuoteAction));

      // 3) 输入框上方引用管理器（≥2 段才显示）
      slots.inject('conversation.input.dock', () => slots.register({
        name: 'conversation.input.dock',
        id: 'quote-dock',
        order: 5,
        label: () => '引用管理',
      }, QuoteDock));

      // 4) 包级样式
      injectStyles(`
.dsh-quote-action{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:6px;border:none;background:transparent;color:inherit;opacity:.65;cursor:pointer;padding:0}
.dsh-quote-action:hover{opacity:1;background:rgba(127,127,127,.15)}
.dsh-quote-action-icon{font-size:12px;line-height:1}
.dsh-quote-dock{margin:6px auto 2px;padding:6px 12px;border:1px solid rgba(127,127,127,.24);background:rgba(127,127,127,.10);color:inherit;font-size:12px;display:flex;flex-direction:column;gap:2px;width:fit-content;max-width:100%;border-radius:12px;box-shadow:none}
.dsh-quote-dock-head{display:flex;align-items:center;justify-content:space-between;gap:12px;opacity:.8;min-width:0;padding:3px 2px}
.dsh-quote-dock-note{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-quote-dock-list{display:flex;flex-direction:column;gap:0;min-width:0}
.dsh-quote-item{display:flex;align-items:center;gap:8px;padding:4px 2px;min-width:0;max-width:100%}
.dsh-quote-item + .dsh-quote-item{border-top:1px solid rgba(127,127,127,.14)}
.dsh-quote-item-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-quote-item-actions{display:inline-flex;gap:2px;flex:none}
.dsh-quote-item-btn{appearance:none;border:none;background:transparent;color:inherit;opacity:.7;cursor:pointer;font-size:11px;padding:2px 5px;border-radius:4px}
.dsh-quote-item-btn:hover{opacity:1;background:rgba(127,127,127,.18)}
`);
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
