/**
 * period.js — 经期记录功能
 * Step 1: UI骨架，暴露空函数防止点击报错
 */
(function () {
    'use strict';

    // ── 常量 ──
    var DEFAULT_SYMPTOMS = ['痛经', '腰酸', '头痛', '疲惫', '胸胀', '恶心'];
    var FLOW_LABELS = ['', '极少', '少', '正常', '多', '极多'];

    // ── 日历渲染（假数据演示） ──
    function renderCalendar() {
        var now = new Date();
        var year = now.getFullYear();
        var month = now.getMonth(); // 0-based

        var label = document.getElementById('pd-month-label');
        if (label) label.textContent = year + '年' + (month + 1) + '月';

        var grid = document.getElementById('pd-cal-grid');
        if (!grid) return;

        var firstDay = new Date(year, month, 1).getDay();
        var daysInMonth = new Date(year, month + 1, 0).getDate();
        var today = now.getDate();

        var html = '';
        // 上月补位
        var prevDays = new Date(year, month, 0).getDate();
        for (var i = firstDay - 1; i >= 0; i--) {
            html += '<div class="pd-cal-cell pd-other-month">' + (prevDays - i) + '</div>';
        }
        // 本月
        for (var d = 1; d <= daysInMonth; d++) {
            var cls = 'pd-cal-cell';
            if (d === today) cls += ' pd-today';
            html += '<div class="' + cls + '" data-date="' + year + '-' + (month+1) + '-' + d + '">' + d + '</div>';
        }
        // 补下月
        var total = firstDay + daysInMonth;
        var nextDays = total % 7 === 0 ? 0 : 7 - (total % 7);
        for (var n = 1; n <= nextDays; n++) {
            html += '<div class="pd-cal-cell pd-other-month">' + n + '</div>';
        }
        grid.innerHTML = html;
    }

    // ── 症状标签渲染 ──
    function renderSymptoms() {
        var wrap = document.getElementById('pd-symptoms-wrap');
        if (!wrap) return;
        var html = '';
        DEFAULT_SYMPTOMS.forEach(function (s) {
            html += '<button class="pd-symptom-chip" onclick="window._pdToggleSymptom(this)">' + s + '</button>';
        });
        html += '<button class="pd-symptom-add" onclick="window._pdAddSymptom()">+ 自定义</button>';
        wrap.innerHTML = html;
    }

    // ── 初始化今日状态区域 ──
    function initStatusCard() {
        var now = new Date();
        var dateStr = (now.getMonth() + 1) + '月' + now.getDate() + '日';
        var el = document.getElementById('pd-status-date');
        if (el) el.textContent = dateStr;

        // Step1：默认显示缺省状态（不在经期）
        var empty = document.getElementById('pd-status-empty');
        var body = document.getElementById('pd-status-body');
        if (empty) empty.style.display = '';
        if (body) body.style.display = 'none';
    }

    // ── 初始化梦角留言区 ──
    function initLetterCard() {
        var pname = (typeof settings !== 'undefined' && settings.partnerName) || '梦角';
        var nameEl = document.getElementById('pd-letter-name');
        var pnameEl = document.getElementById('pd-letter-pname');
        if (nameEl) nameEl.textContent = pname;
        if (pnameEl) pnameEl.textContent = pname;

        // 头像
        var avEl = document.getElementById('pd-partner-av');
        if (avEl) {
            var imgEl = document.getElementById('partner-avatar');
            if (imgEl && imgEl.src && !imgEl.src.endsWith('/')) {
                avEl.innerHTML = '<img src="' + imgEl.src + '">';
            }
        }
    }

    // ── 暴露给HTML的交互函数（Step1全部空实现） ──
    window._pdToggleToday = function () {
        // Step2实现
        if (typeof showNotification === 'function') showNotification('经期标记功能将在下一步实现', 'info');
    };

    window._pdSetFlow = function (val) {
        document.querySelectorAll('.pd-flow-btn').forEach(function (btn) {
            btn.classList.toggle('pd-flow-active', Number(btn.dataset.val) === val);
        });
    };

    window._pdToggleSymptom = function (btn) {
        btn.classList.toggle('pd-chip-on');
    };

    window._pdAddSymptom = function () {
        if (typeof showNotification === 'function') showNotification('自定义症状将在下一步实现', 'info');
    };

    window._pdSaveRecord = function () {
        var hint = document.getElementById('pd-saved-hint');
        if (hint) { hint.textContent = '已保存 ✓'; setTimeout(function(){ hint.textContent=''; }, 2000); }
    };

    window._pdOpenHistory = function () {
        var sheet = document.getElementById('pd-history-sheet');
        if (sheet) sheet.classList.add('cs-sheet-open');
        var overlay = document.getElementById('cs-overlay');
        if (overlay) overlay.style.display = 'block';
        // 渲染空列表
        var body = document.getElementById('pd-history-body');
        if (body) body.innerHTML = '<div style="padding:32px;text-align:center;color:var(--text-secondary);font-size:13px;opacity:0.6;">暂无经期历史记录</div>';
    };

    window._pdCloseHistory = function () {
        var sheet = document.getElementById('pd-history-sheet');
        if (sheet) sheet.classList.remove('cs-sheet-open');
        var overlay = document.getElementById('cs-overlay');
        if (overlay) overlay.style.display = 'none';
    };

    window._pdCloseDaySheet = function () {
        var sheet = document.getElementById('pd-day-sheet');
        if (sheet) sheet.classList.remove('cs-sheet-open');
        var overlay = document.getElementById('cs-overlay');
        if (overlay) overlay.style.display = 'none';
    };

    // ── 入口：切换到经期tab时初始化 ──
    window._pdInit = function () {
        renderCalendar();
        renderSymptoms();
        initStatusCard();
        initLetterCard();
    };

})();
