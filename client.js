/**
 * dsh-goal-board — 面板（Client）。
 *
 * 侧边栏一个图标 → 主面板一页：顶部切项目，下面三段（进行中 / 排队中 / 搁置），
 * 每段是固定高度的独立滚动区。拖动卡片调顺序、跨段搬；条目上标着"哪个会话在处理"。
 * 数据走本机 API：goal-board/api/state | move | update | delete。
 */

window.__ModuleLoader__.load({
  id: 'dsh-goal-board',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    const CSS = [
      '[data-dgb]{color:var(--dsw-alias-label-primary,#1f2329);font-size:13px;line-height:20px;height:100%;display:flex;flex-direction:column;overflow:hidden;box-sizing:border-box}',
      '[data-dgb] *{box-sizing:border-box}',
      '[data-dgb] .dgb-head{flex:none;display:flex;align-items:center;gap:10px;padding:14px 24px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.07))}',
      '[data-dgb] .dgb-title{font-size:15px;font-weight:650;letter-spacing:.2px}',
      '[data-dgb] .dgb-sub{color:var(--dsw-alias-label-tertiary,#8a919e);font-size:12px}',
      '[data-dgb] .dgb-spacer{flex:1}',
      '[data-dgb] .dgb-select{height:28px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:7px;background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font:inherit;font-size:12px;outline:none;cursor:pointer}',
      '[data-dgb] .dgb-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:1px solid transparent;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#5c6370);cursor:pointer}',
      '[data-dgb] .dgb-iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));color:var(--dsw-alias-label-primary,#1f2329)}',
      '[data-dgb] .dgb-iconbtn:disabled{opacity:.4;cursor:default}',
      '[data-dgb] .dgb-iconbtn-danger:hover{background:rgba(229,72,77,.1);color:var(--dsw-alias-state-error-primary,#e5484d)}',
      '[data-dgb] .dgb-error{color:var(--dsw-alias-state-error-primary,#e5484d);font-size:12px;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '[data-dgb] .dgb-body{flex:1;min-height:0;overflow-y:auto;padding:16px 24px 40px}',
      '[data-dgb] .dgb-wrap{max-width:880px;margin:0 auto}',
      '[data-dgb] .dgb-stats{display:flex;gap:16px;margin:0 0 16px;font-size:12px;color:var(--dsw-alias-label-tertiary,#8a919e)}',
      '[data-dgb] .dgb-stats b{color:var(--dsw-alias-label-primary,#1f2329);font-weight:600}',
      '[data-dgb] .dgb-section{margin-bottom:18px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.07));border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff);overflow:hidden;transition:border-color .12s ease}',
      '[data-dgb] .dgb-section.is-over{border-color:var(--dsw-alias-brand-primary,#4f7cff)}',
      '[data-dgb] .dgb-section-head{display:flex;align-items:center;gap:8px;padding:9px 12px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.025));border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06))}',
      '[data-dgb] .dgb-section-title{font-size:12px;font-weight:650;letter-spacing:.3px;color:var(--dsw-alias-label-secondary,#5c6370)}',
      '[data-dgb] .dgb-section-count{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:17px;padding:0 5px;border-radius:999px;background:var(--dsw-alias-bg-layer-3,rgba(0,0,0,.07));font-weight:500;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a919e)}',
      '[data-dgb] .dgb-section-body{max-height:320px;overflow-y:auto;padding:8px 10px 10px}',
      '[data-dgb] .dgb-dropzone{height:4px;margin:0 0 6px;border-radius:3px;transition:background .12s ease}',
      '[data-dgb] .dgb-dropzone.is-over{background:var(--dsw-alias-brand-primary,#4f7cff)}',
      '[data-dgb] .dgb-empty{padding:10px 4px;color:var(--dsw-alias-label-tertiary,#8a919e);font-size:12px}',
      '[data-dgb] .dgb-card{padding:10px 12px;margin-bottom:8px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);transition:box-shadow .12s ease,border-color .12s ease}',
      '[data-dgb] .dgb-card:last-child{margin-bottom:0}',
      '[data-dgb] .dgb-card:hover{box-shadow:0 1px 6px rgba(0,0,0,.06)}',
      '[data-dgb] .dgb-card.is-dragging{opacity:.45}',
      '[data-dgb] .dgb-card-head{display:flex;align-items:center;gap:8px}',
      '[data-dgb] .dgb-grip{cursor:grab;color:var(--dsw-alias-label-tertiary,#b0b6c0);display:inline-flex;flex:none;user-select:none}',
      '[data-dgb] .dgb-card-title{font-size:13.5px;font-weight:600;flex:1;min-width:0;overflow-wrap:anywhere}',
      '[data-dgb] .dgb-badge{flex:none;padding:0 7px;border-radius:999px;font-size:11px;line-height:17px}',
      '[data-dgb] .dgb-badge-active{background:rgba(79,124,255,.12);color:var(--dsw-alias-brand-primary,#4f7cff)}',
      '[data-dgb] .dgb-badge-suspended{background:rgba(138,145,158,.14);color:var(--dsw-alias-label-secondary,#5c6370)}',
      '[data-dgb] .dgb-badge-done{background:rgba(49,163,107,.12);color:var(--dsw-alias-state-success-primary,#31a36b)}',
      '[data-dgb] .dgb-badge-live{background:rgba(49,163,107,.14);color:var(--dsw-alias-state-success-primary,#31a36b)}',
      '[data-dgb] .dgb-badge-idle{background:rgba(138,145,158,.14);color:var(--dsw-alias-label-secondary,#5c6370)}',
      '[data-dgb] .dgb-release{border:0;cursor:pointer;font:inherit;font-size:11px;line-height:17px}',
      '[data-dgb] .dgb-owner.is-stale{opacity:.55;text-decoration:line-through}',
      '[data-dgb] .dgb-section-sub{font-weight:400;font-size:11px;margin-left:6px;color:var(--dsw-alias-label-tertiary,#8a919e)}',
      '[data-dgb] .dgb-card-actions{display:flex;align-items:center;gap:2px;flex:none;opacity:0;transition:opacity .1s ease}',
      '[data-dgb] .dgb-card:hover .dgb-card-actions{opacity:1}',
      '[data-dgb] .dgb-donewhen{margin-top:4px;font-size:12px;color:var(--dsw-alias-label-tertiary,#8a919e);overflow-wrap:anywhere}',
      '[data-dgb] .dgb-items{list-style:none;margin:8px 0 0;padding:0;display:flex;flex-direction:column;gap:3px}',
      '[data-dgb] .dgb-item{display:grid;grid-template-columns:6px minmax(0,1fr);column-gap:8px;align-items:start;font-size:12.5px;line-height:19px;padding:2px;border-radius:5px}',
      '[data-dgb] .dgb-dot{width:6px;height:6px;margin-top:7px;border-radius:50%;background:var(--dsw-alias-label-tertiary,#b0b6c0)}',
      '[data-dgb] .dgb-item-body{min-width:0}',
      '[data-dgb] .dgb-item-main{display:flex;align-items:baseline;gap:8px;min-width:0}',
      '[data-dgb] .dgb-item-doing .dgb-dot{background:var(--dsw-alias-brand-primary,#4f7cff)}',
      '[data-dgb] .dgb-item-done .dgb-dot{background:var(--dsw-alias-state-success-primary,#31a36b)}',
      '[data-dgb] .dgb-item-blocked .dgb-dot{background:var(--dsw-alias-state-error-primary,#e5484d)}',
      '[data-dgb] .dgb-item-done .dgb-item-text{color:var(--dsw-alias-label-tertiary,#8a919e);text-decoration:line-through}',
      '[data-dgb] .dgb-item-text{flex:1;min-width:0;overflow-wrap:anywhere}',
      '[data-dgb] .dgb-item-note{margin-top:1px;color:var(--dsw-alias-label-tertiary,#8a919e);font-size:11.5px;line-height:17px;overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden;cursor:pointer}',
      '[data-dgb] .dgb-item-note:hover{color:var(--dsw-alias-label-secondary,#5c6370)}',
      '[data-dgb] .dgb-item-note.is-open{display:block;-webkit-line-clamp:unset;overflow:visible}',
      '[data-dgb] .dgb-owner{flex:none;padding:0 6px;border-radius:999px;background:rgba(79,124,255,.1);color:var(--dsw-alias-brand-primary,#4f7cff);font-size:10.5px;line-height:16px;white-space:nowrap}',
      '[data-dgb] .dgb-card-foot{display:flex;align-items:center;gap:6px;margin-top:8px;padding-top:7px;border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.05))}',
      '[data-dgb] .dgb-counts{flex:1;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8a919e)}',
      '[data-dgb] .dgb-progress{height:2px;border-radius:1px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.06));overflow:hidden;margin-top:8px}',
      '[data-dgb] .dgb-progress i{display:block;height:100%;background:var(--dsw-alias-state-success-primary,#31a36b)}',
      '[data-dgb] .dgb-archive{margin-top:6px;border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06));padding-top:10px}',
      '[data-dgb] .dgb-archive summary{cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary,#5c6370);user-select:none}',
      '[data-dgb] .dgb-input{width:100%;height:26px;margin:8px 0;padding:0 8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:12px;outline:none}',
      '[data-dgb] .dgb-archive ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:3px}',
      '[data-dgb] .dgb-archive li{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a919e);overflow-wrap:anywhere}',
      '[data-dgb] .dgb-loading{padding:40px 0;color:var(--dsw-alias-label-tertiary,#8a919e)}',
      '[data-dgb] .dgb-hint{margin-top:4px;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8a919e)}',
    ].join('');

    function useStyle() {
      useEffect(() => {
        if (typeof document === 'undefined') return;
        if (document.getElementById('dsh-goal-board-style')) return;
        const style = document.createElement('style');
        style.id = 'dsh-goal-board-style';
        style.textContent = CSS;
        document.head.appendChild(style);
      }, []);
    }

    function apiToken() {
      const injected = globalThis.__DSH_GOAL_BOARD__;
      return injected && typeof injected.token === 'string' ? injected.token : '';
    }

    async function api(path, body) {
      const token = apiToken();
      const headers = { 'x-goal-board': '1' };
      if (token) headers['x-goal-board-token'] = token;
      const res = await fetch('goal-board/api' + path, body === undefined
        ? { cache: 'no-store', headers }
        : {
            method: 'POST',
            cache: 'no-store',
            headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || 'HTTP ' + res.status);
      return payload;
    }

    function readStoredProject() {
      try {
        return localStorage.getItem('dgb.project') || '';
      } catch {
        return '';
      }
    }

    function storeProject(id) {
      try {
        localStorage.setItem('dgb.project', id);
      } catch {
        /* ignore */
      }
    }

    function Icon({ name, size = 15 }) {
      const common = {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      };
      if (name === 'trash') {
        return h(
          'svg',
          common,
          h('path', { d: 'M2.8 4.4h10.4' }),
          h('path', { d: 'M6.4 4.4V3.1c0-.4.3-.7.7-.7h1.8c.4 0 .7.3.7.7v1.3' }),
          h('path', { d: 'M4.3 4.4l.6 8.3c0 .5.4.9.9.9h4.4c.5 0 .9-.4.9-.9l.6-8.3' }),
        );
      }
      if (name === 'refresh') {
        return h(
          'svg',
          common,
          h('path', { d: 'M13.2 8a5.2 5.2 0 1 1-1.6-3.7' }),
          h('path', { d: 'M13.4 2.6v3.2h-3.2' }),
        );
      }
      if (name === 'pause') {
        return h('svg', common, h('path', { d: 'M6 3.4v9.2' }), h('path', { d: 'M10 3.4v9.2' }));
      }
      if (name === 'play') {
        return h('svg', common, h('path', { d: 'M5.4 3.6l7 4.4-7 4.4z' }));
      }
      if (name === 'grip') {
        return h(
          'svg',
          { ...common, viewBox: '0 0 10 16' },
          h('circle', { cx: 3, cy: 4, r: 0.9, fill: 'currentColor', stroke: 'none' }),
          h('circle', { cx: 7, cy: 4, r: 0.9, fill: 'currentColor', stroke: 'none' }),
          h('circle', { cx: 3, cy: 8, r: 0.9, fill: 'currentColor', stroke: 'none' }),
          h('circle', { cx: 7, cy: 8, r: 0.9, fill: 'currentColor', stroke: 'none' }),
          h('circle', { cx: 3, cy: 12, r: 0.9, fill: 'currentColor', stroke: 'none' }),
          h('circle', { cx: 7, cy: 12, r: 0.9, fill: 'currentColor', stroke: 'none' }),
        );
      }
      return null;
    }

    function BoardIcon({ size = 18 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M4 6.5h9' }),
        h('path', { d: 'M4 12h9' }),
        h('path', { d: 'M4 17.5h6' }),
        h('path', { d: 'M16.5 5.5l1.8 1.8 3.2-3.2' }),
        h('path', { d: 'M16.5 16.5l1.8 1.8 3.2-3.2' }),
      );
    }

    const STATUS_LABEL = { active: '进行中', suspended: '搁置', done: '已完成' };

    // 会话名的真源是侧边栏，也就是客户端的 sessions 服务：它挂着会话列表快照，
    // 每行有 displayTitle/title。服务端认领记录里那个 label 是认领那一刻拍的快照
    // （当时还只有 id 尾号），所以这里按 sessionId 现查；查不到才退回 label。
    let appCtx = null;
    let sessionList = null;

    function pickSessionList(ctx) {
      if (!ctx || typeof ctx.get !== 'function') return null;
      try {
        const svc = ctx.get('sessions');
        const list = svc && svc.list;
        if (list && typeof list.getSnapshot === 'function') return list;
      } catch (e) {
        /* 宿主没挂 sessions 服务：保持老样子 */
      }
      return null;
    }

    function tidyTitle(text) {
      const value = String(text || '').replace(/\s+/g, ' ').trim();
      return value.length > 14 ? value.slice(0, 14) + '…' : value;
    }

    function sessionName(sessionId, fallback) {
      if (sessionId) {
        const list = sessionList || (sessionList = pickSessionList(appCtx));
        if (list) {
          try {
            const row = list.getSnapshot()?.byId?.[sessionId];
            const title = row && (row.displayTitle || row.title);
            if (title && String(title).trim()) return tidyTitle(title);
          } catch (e) {
            /* 快照形状变了就当查不到 */
          }
        }
      }
      const label = (fallback || (sessionId ? String(sessionId).slice(-6) : '')).toString().trim();
      return label || '未知会话';
    }

    const sessionLabels = (list) => list.map((s) => sessionName(s.sessionId, s.label)).join('、');

    function ItemRow({ item }) {
      const owner = item.owner;
      const [expanded, setExpanded] = useState(false);
      return h(
        'li',
        { className: 'dgb-item dgb-item-' + item.status },
        h('span', { className: 'dgb-dot' }),
        h(
          'div',
          { className: 'dgb-item-body' },
          h(
            'div',
            { className: 'dgb-item-main' },
            h('span', { className: 'dgb-item-text' }, item.text),
            owner
              ? h(
                  'span',
                  {
                    className: 'dgb-owner' + (owner.stale ? ' is-stale' : ''),
                    title: '会话 ' + (owner.sessionId || ''),
                  },
                  owner.stale
                    ? '会话 ' + sessionName(owner.sessionId, owner.label) + ' · 空闲'
                    : '会话 ' + sessionName(owner.sessionId, owner.label) + ' · ' + (owner.at || ''),
                )
              : null,
          ),
          item.note
            ? h(
                'div',
                {
                  className: 'dgb-item-note' + (expanded ? ' is-open' : ''),
                  title: item.note,
                  onClick: () => setExpanded((value) => !value),
                },
                item.note,
              )
            : null,
        ),
      );
    }

    function GoalCard({ goal, index, status, badge, droppable, dragging, onDragStart, onDrop, onStatus, onDelete, onRelease }) {
      const open = goal.items.filter((item) => item.status !== 'done');
      const done = goal.items.length - open.length;
      const pct = goal.items.length === 0 ? 0 : Math.round((done / goal.items.length) * 100);
      const sessions = goal.sessions ?? [];
      const liveSessions = sessions.filter((s) => !s.stale);
      const idleSessions = sessions.filter((s) => s.stale);
      const looseDoing = goal.items.filter((i) => i.status === 'doing' && !i.owner?.sessionId).length;
      const sessionBadge =
        sessions.length === 0
          ? looseDoing > 0
            ? h(
                'span',
                {
                  className: 'dgb-badge dgb-badge-idle',
                  title: '有条目标着 doing 但没挂会话认领（上一次会话可能没释放）；可以接着做，或把条目改回 todo',
                },
                '○ 待认领',
              )
            : null
          : liveSessions.length > 0
            ? h(
                'button',
                {
                  className: 'dgb-badge dgb-badge-live dgb-release',
                  title: '点击释放这个目标上的会话认领（会话已停但还占着时用）',
                  onClick: () => onRelease(goal),
                },
                '● 会话 ' + sessionLabels(liveSessions) + ' 处理中',
              )
            : h(
                'button',
                {
                  className: 'dgb-badge dgb-badge-idle dgb-release',
                  title: '这些会话已经空闲超过 30 分钟；点击释放认领，让目标回到「排队中」',
                  onClick: () => onRelease(goal),
                },
                '○ 会话 ' + sessionLabels(idleSessions) + ' 空闲',
              );
      return h(
        'div',
        {
          className: 'dgb-card' + (dragging ? ' is-dragging' : ''),
          draggable: true,
          onDragStart: (event) => {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', goal.id);
            onDragStart(goal.id);
          },
          onDragOver: (event) => {
            if (!droppable) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
          },
          onDrop: (event) => {
            if (!droppable) return;
            event.preventDefault();
            event.stopPropagation();
            onDrop(index);
          },
        },
        h(
          'div',
          { className: 'dgb-card-head' },
          h('span', { className: 'dgb-grip', title: '拖动排序' }, h(Icon, { name: 'grip', size: 12 })),
          h('span', { className: 'dgb-card-title' }, goal.title),
          sessionBadge,
          h('span', { className: 'dgb-badge dgb-badge-' + status }, badge || STATUS_LABEL[status] || status),
          h(
            'span',
            { className: 'dgb-card-actions' },
            status === 'active'
              ? h(
                  'button',
                  { className: 'dgb-iconbtn', title: '搁置', onClick: () => onStatus('suspended') },
                  h(Icon, { name: 'pause' }),
                )
              : null,
            status === 'suspended'
              ? h(
                  'button',
                  { className: 'dgb-iconbtn', title: '恢复（重新排队）', onClick: () => onStatus('active') },
                  h(Icon, { name: 'play' }),
                )
              : null,
            h(
              'button',
              { className: 'dgb-iconbtn dgb-iconbtn-danger', title: '删除目标', onClick: () => onDelete(goal) },
              h(Icon, { name: 'trash' }),
            ),
          ),
        ),
        goal.doneWhen ? h('div', { className: 'dgb-donewhen' }, '怎样算做完：' + goal.doneWhen) : null,
        goal.items.length > 0
          ? h(
              'ul',
              { className: 'dgb-items' },
              goal.items.map((item) => h(ItemRow, { key: item.id, item })),
            )
          : null,
        h('div', { className: 'dgb-progress' }, h('i', { style: { width: pct + '%' } })),
        h(
          'div',
          { className: 'dgb-card-foot' },
          h(
            'span',
            { className: 'dgb-counts' },
            '还剩 ' + open.length + ' 条' + (done > 0 ? ' · 已完成 ' + done + ' 条' : ''),
          ),
        ),
      );
    }

    function Section({ title, sub, status, badge, goals, droppable = true, emptyText, dragId, onDragStart, onDrop, onStatus, onDelete, onRelease }) {
      const [over, setOver] = useState(false);
      const [overTop, setOverTop] = useState(false);
      return h(
        'section',
        {
          className: 'dgb-section' + (over ? ' is-over' : ''),
          onDragOver: (event) => {
            if (!droppable) return;
            event.preventDefault();
            setOver(true);
          },
          onDragLeave: () => {
            setOver(false);
            setOverTop(false);
          },
          onDrop: (event) => {
            if (!droppable) return;
            event.preventDefault();
            setOver(false);
            setOverTop(false);
            onDrop(goals.length);
          },
        },
        h(
          'div',
          { className: 'dgb-section-head' },
          h(
            'span',
            { className: 'dgb-section-title' },
            title,
            sub ? h('span', { className: 'dgb-section-sub' }, sub) : null,
          ),
          h('span', { className: 'dgb-section-count' }, goals.length),
        ),
        h(
          'div',
          { className: 'dgb-section-body' },
          droppable
            ? h('div', {
                className: 'dgb-dropzone' + (overTop ? ' is-over' : ''),
                title: '放到最前',
                onDragOver: (event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setOverTop(true);
                },
                onDragLeave: () => setOverTop(false),
                onDrop: (event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setOverTop(false);
                  setOver(false);
                  onDrop(0);
                },
              })
            : null,
          goals.length === 0
            ? h('div', { className: 'dgb-empty' }, emptyText || '（空）')
            : null,
          goals.map((goal, index) =>
            h(GoalCard, {
              key: goal.id,
              goal,
              index,
              status,
              badge,
              droppable,
              dragging: dragId === goal.id,
              onDragStart,
              onDrop,
              onStatus: (next) => onStatus(goal, next),
              onDelete: () => onDelete(goal),
              onRelease: () => onRelease(goal),
            }),
          ),
        ),
      );
    }

    function BoardPage() {
      useStyle();
      const [state, setState] = useState(null);
      const [projectId, setProjectId] = useState(readStoredProject);
      const [error, setError] = useState('');
      const [busy, setBusy] = useState(false);
      const [dragId, setDragId] = useState(null);

      const refresh = useCallback(async () => {
        try {
          const next = await api('/state');
          setState(next);
          setError('');
        } catch (e) {
          setError(String(e?.message ?? e));
        }
      }, []);

      useEffect(() => {
        refresh();
      }, [refresh]);

      // 面板开着不动时也要跟着变：别的会话认领/释放、认领超过 30 分钟变「空闲」，
      // 都需要一个定时回读。拖动或提交中先让路，免得把用户手上的操作刷掉。
      const liveRef = useRef({ busy: false, dragId: null });
      liveRef.current = { busy, dragId };
      useEffect(() => {
        const timer = setInterval(() => {
          if (liveRef.current.busy || liveRef.current.dragId) return;
          refresh();
        }, 15000);
        return () => clearInterval(timer);
      }, [refresh]);

      const projects = state?.projects ?? [];
      const project = projects.find((p) => p.id === projectId) || projects[0] || null;

      useEffect(() => {
        if (project && project.id !== projectId) {
          setProjectId(project.id);
          storeProject(project.id);
        }
      }, [project, projectId]);

      const run = useCallback(async (fn) => {
        setBusy(true);
        try {
          const next = await fn();
          if (next) setState(next);
          setError('');
        } catch (e) {
          setError(String(e?.message ?? e));
        } finally {
          setBusy(false);
          setDragId(null);
        }
      }, []);

      const move = useCallback(
        (toStatus, toIndex) => {
          if (!dragId || !project) return;
          run(() => api('/move', { projectId: project.id, goalId: dragId, toStatus, toIndex }));
        },
        [dragId, project, run],
      );

      const setStatus = useCallback(
        (goal, status) => {
          if (!project) return;
          run(() => api('/update', { projectId: project.id, goalId: goal.id, status }));
        },
        [project, run],
      );

      const deleteGoal = useCallback(
        (goal) => {
          if (!project) return;
          if (!window.confirm('删除目标「' + goal.title + '」？条目会一起删掉，不能撤销。')) return;
          run(() => api('/delete', { projectId: project.id, goalId: goal.id }));
        },
        [project, run],
      );

      const releaseGoal = useCallback(
        (goal) => {
          if (!project) return;
          if (!window.confirm('释放「' + goal.title + '」上的会话认领？条目会回到没人认领的状态。')) return;
          run(() => api('/release', { projectId: project.id, goalId: goal.id }));
        },
        [project, run],
      );

      if (!state) {
        return h('div', { 'data-dgb': '' }, h('div', { className: 'dgb-loading' }, error || '加载中…'));
      }

      const goals = project?.goals ?? [];
      const active = goals.filter((g) => g.status === 'active');
      // 「正在进行」= 有会话在这个目标上干活（有 doing 条目且带 owner）；其余 active 都是「排队中」。
      // doing 条目没挂 owner 的也算（说明上一轮认领丢了），面板标「待认领」，别让它悄悄掉进排队区。
      const claimed = (g) => (g.sessions ?? []).length > 0 || g.items.some((i) => i.status === 'doing');
      const live = active.filter(claimed);
      const queued = active.filter((g) => !claimed(g));
      const suspended = goals.filter((g) => g.status === 'suspended');
      const done = goals.filter((g) => g.status === 'done');

      // 排队区插到第 k 位 → 换算成整条 active 序列里的下标（正在进行的卡片压在前面）。
      const dropQueued = (k) => {
        const anchor = queued[k];
        const at = anchor ? active.indexOf(anchor) : -1;
        move('active', at >= 0 ? at : active.length);
      };

      return h(
        'div',
        { 'data-dgb': '' },
        h(
          'header',
          { className: 'dgb-head' },
          h('span', { className: 'dgb-title' }, '目标清单'),
          h(
            'select',
            {
              className: 'dgb-select',
              value: project?.id ?? '',
              onChange: (event) => {
                setProjectId(event.target.value);
                storeProject(event.target.value);
              },
            },
            projects.map((p) => h('option', { key: p.id, value: p.id }, p.name)),
          ),
          h('span', { className: 'dgb-spacer' }),
          error ? h('span', { className: 'dgb-error', title: error }, error) : null,
          h(
            'button',
            { className: 'dgb-iconbtn', title: '刷新', disabled: busy, onClick: refresh },
            h(Icon, { name: 'refresh' }),
          ),
        ),
        h(
          'div',
          { className: 'dgb-body' },
          h(
            'div',
            { className: 'dgb-wrap' },
            h(
              'div',
              { className: 'dgb-stats' },
              h('span', null, '正在进行 ', h('b', null, live.length)),
              h('span', null, '排队中 ', h('b', null, queued.length)),
              h('span', null, '搁置 ', h('b', null, suspended.length)),
              h('span', null, '条目 ', h('b', null, goals.reduce((n, g) => n + g.items.length, 0))),
            ),
            (() => {
              // 只提醒「这会儿还在干活」的会话：登记表留 2 小时，面板别把早就收工的会话也拉出来。
              const fresh = Date.now() - 30 * 60 * 1000;
              const looseSessions = (state?.sessions ?? []).filter(
                (s) => !s.hasCard && s.inProject !== false && (s.lastSeen ?? 0) >= fresh,
              );
              if (looseSessions.length === 0) return null;
              const names = looseSessions
                .map((s) => `${sessionName(s.id, s.label)}（${s.turns} 轮）`)
                .join('、');
              return h(
                'div',
                { className: 'dgb-hint' },
                `⚠ 有 ${looseSessions.length} 个会话在干活但清单里没卡：${names}。去那个会话说一句「把这次进度写进目标清单」就能补上。`,
              );
            })(),
            project
              ? h(
                  'div',
                  null,
                  h(Section, {
                    title: '正在进行',
                    sub: '会话认领中 · 30 分钟没动静自动放回排队',
                    status: 'active',
                    badge: '会话中',
                    goals: live,
                    droppable: false,
                    emptyText: '现在没有会话在跑任何目标',
                    dragId,
                    onDragStart: setDragId,
                    onDrop: () => {},
                    onStatus: setStatus,
                    onDelete: deleteGoal,
                    onRelease: releaseGoal,
                  }),
                  h(Section, {
                    title: '排队中',
                    sub: '按顺序会被接手',
                    status: 'active',
                    badge: '排队',
                    goals: queued,
                    emptyText: '把「搁置」的卡片拖到这里恢复',
                    dragId,
                    onDragStart: setDragId,
                    onDrop: dropQueued,
                    onStatus: setStatus,
                    onDelete: deleteGoal,
                    onRelease: releaseGoal,
                  }),
                  h(Section, {
                    title: '搁置',
                    sub: '会话不主动碰',
                    status: 'suspended',
                    goals: suspended,
                    emptyText: '（空）',
                    dragId,
                    onDragStart: setDragId,
                    onDrop: (index) => move('suspended', index),
                    onStatus: setStatus,
                    onDelete: deleteGoal,
                    onRelease: releaseGoal,
                  }),
                  done.length > 0
                    ? h('div', { className: 'dgb-hint' }, `另有 ${done.length} 个目标已经做完，下次开工时我会核对产出、归档后从清单删掉。`)
                    : null,
                  h('div', { className: 'dgb-hint' }, '拖动卡片排序或换区：从「搁置」拖回「排队中」就恢复。会话 30 分钟没动静，认领会自动释放、卡片回到排队中，不用你点。目标做完由我核对产出后自动归档。'),
                )
              : h('div', { className: 'dgb-empty' }, '还没有项目。让 agent 用 goal_board_update 建一个。'),
          ),
        ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        appCtx = ctx;
        sessionList = pickSessionList(ctx) || sessionList;
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: 'goal-board', order: 20, label: '目标清单' },
            BoardIcon,
          ),
        );
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: 'goal-board' }, BoardPage),
        );
      },
    };
  },
});
