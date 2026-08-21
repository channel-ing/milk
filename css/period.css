/* ══════════════════════════════════════════
   经期记录 —— 高级功能独立弹窗样式
   （日历/统计/症状/留言卡等核心样式已在 styles.css 里写好，
   都是通用 .pd-xxx class，直接复用即可，这里只补：
   1. 出血量配色变量的挂载点（原来挂在 #cs-panel-period，
      现在功能搬到 #period-modal，得重新挂一次）
   2. period-modal 本身的弹窗尺寸/滚动，照抄 #stats-modal 的模板
   3. 长按提示小字的样式
   ══════════════════════════════════════════ */

#period-modal { --pd-flow-rgb: 210, 80, 100; }

#period-modal .modal-content {
    display: flex;
    flex-direction: column;
    max-height: 85vh;
    padding: 20px;
    overflow: hidden;
}

#period-modal .modal-title {
    flex-shrink: 0;
    margin-bottom: 15px;
}

#period-body {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
    padding-right: 5px;
    margin-bottom: 15px;
    scrollbar-width: none;
    -ms-overflow-style: none;
}
#period-body::-webkit-scrollbar { display: none; }

#period-modal .modal-buttons {
    flex-shrink: 0;
    margin-top: 0;
    padding-top: 10px;
    border-top: 1px solid var(--border-color);
    display: flex;
    justify-content: flex-end;
}

/* 长按补录提示小字（常驻，不是一次性引导） */
.pd-longpress-hint {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--text-secondary);
    opacity: 0.65;
    padding: 0 2px 10px;
}
.pd-longpress-hint i { font-size: 10px; }
