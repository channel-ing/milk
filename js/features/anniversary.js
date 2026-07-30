/**
 * anniversary.js — 纪念日功能（情侣空间 #cs-panel-ann）
 *
 * 加载顺序在 onboarding.js 之后，会覆盖其中的：
 *   - renderAnniversariesList()
 *   - window.switchAnnType()
 */

// ── 内部状态 ──────────────────────────────────────────────
let _annEditingId = null; // null = 新建；数字 = 当前编辑的 id

// ── Bottom sheet 开关 ─────────────────────────────────────
window.openAnnSheet = function(mode, annId) {
    _annEditingId = (mode === 'edit' && annId) ? annId : null;

    var titleEl   = document.getElementById('cs-ann-sheet-title');
    var deleteBtn = document.getElementById('cs-ann-sheet-delete');
    var nameInput = document.getElementById('cs-ann-input-name');
    var dateInput = document.getElementById('cs-ann-input-date');

    if (titleEl)   titleEl.textContent     = _annEditingId ? '编辑纪念日' : '添加纪念日';
    if (deleteBtn) deleteBtn.style.display = _annEditingId ? 'block'      : 'none';

    if (_annEditingId) {
        var ann = (typeof anniversaries !== 'undefined' ? anniversaries : []).find(function(a) { return a.id === _annEditingId; });
        if (ann) {
            if (nameInput) nameInput.value = ann.name || '';
            if (dateInput) dateInput.value = ann.date || '';
            window.switchAnnType(ann.type || 'anniversary');
        }
    } else {
        if (nameInput) nameInput.value = '';
        if (dateInput) dateInput.value = '';
        window.switchAnnType('anniversary');
    }

    _annUpdateCharCount();

    var sheet   = document.getElementById('cs-ann-sheet');
    var overlay = document.getElementById('cs-overlay');
    if (sheet)   sheet.classList.add('cs-sheet-open');
    if (overlay) overlay.classList.add('cs-overlay-on');
};

window.closeAnnSheet = function() {
    var sheet = document.getElementById('cs-ann-sheet');
    if (sheet) sheet.classList.remove('cs-sheet-open');
    var anyOpen = document.querySelectorAll('.cs-sheet.cs-sheet-open').length;
    if (!anyOpen) {
        var overlay = document.getElementById('cs-overlay');
        if (overlay) overlay.classList.remove('cs-overlay-on');
    }
};

// ── 保存 ─────────────────────────────────────────────────
window.saveAnnFromSheet = function() {
    var nameInput = document.getElementById('cs-ann-input-name');
    var dateInput = document.getElementById('cs-ann-input-date');
    var name = nameInput ? nameInput.value.trim() : '';
    var date = dateInput ? dateInput.value : '';

    if (!name) {
        if (typeof showNotification === 'function') showNotification('请填写名称', 'error');
        return;
    }
    if (!date) {
        if (typeof showNotification === 'function') showNotification('请选择日期', 'error');
        return;
    }
    // 字数限制：最多 16 个码点（约 8 个汉字）
    if (Array.from(name).length > 16) {
        if (typeof showNotification === 'function') showNotification('名称最多 8 个汉字', 'error');
        return;
    }

    var type = (typeof currentAnnType !== 'undefined' && currentAnnType)
            || (typeof currentAnniversaryType !== 'undefined' && currentAnniversaryType)
            || 'anniversary';

    if (_annEditingId !== null) {
        var idx = anniversaries.findIndex(function(a) { return a.id === _annEditingId; });
        if (idx !== -1) {
            anniversaries[idx].name = name;
            anniversaries[idx].date = date;
            anniversaries[idx].type = type;
        }
    } else {
        anniversaries.push({ id: Date.now(), name: name, date: date, type: type });
    }

    if (typeof throttledSaveData === 'function') throttledSaveData();
    renderAnniversariesList();
    window.closeAnnSheet();
    if (typeof showNotification === 'function') {
        showNotification(_annEditingId ? '已更新' : '纪念日已添加', 'success');
    }
};

// ── 删除当前编辑的条目 ────────────────────────────────────
window.deleteCurrentAnn = function() {
    if (_annEditingId === null) return;
    if (!confirm('确定要删除这条纪念日吗？')) return;
    if (typeof anniversaries !== 'undefined') {
        anniversaries = anniversaries.filter(function(a) { return a.id !== _annEditingId; });
    }
    if (typeof throttledSaveData === 'function') throttledSaveData();
    renderAnniversariesList();
    window.closeAnnSheet();
    if (typeof showNotification === 'function') showNotification('已删除', 'success');
};

// ── 字数提示 ──────────────────────────────────────────────
function _annUpdateCharCount() {
    var inp = document.getElementById('cs-ann-input-name');
    var el  = document.getElementById('cs-ann-char-count');
    if (!inp || !el) return;
    var len = Array.from(inp.value).length;
    el.textContent = len + ' / 8';
    el.style.color = len > 16 ? '#ff5050' : 'var(--text-secondary)';
}

// ── 覆盖 switchAnnType（更新描述文字）────────────────────
window.switchAnnType = function(type) {
    if (typeof currentAnnType !== 'undefined') currentAnnType = type;
    if (typeof currentAnniversaryType !== 'undefined') currentAnniversaryType = type;
    document.querySelectorAll('.ann-type-btn').forEach(function(btn) {
        btn.classList.toggle('active', btn.dataset.type === type);
    });
    var desc = document.getElementById('ann-type-desc');
    if (desc) {
        desc.textContent = type === 'anniversary'
            ? '记录从某一天到今天已经走过了多少天，适合相识日、恋爱纪念日等。'
            : '记录到未来某一天还剩下多少天，适合生日、旅行、重要考试等。';
    }
};

// ── 渲染列表（覆盖 onboarding.js 版本）───────────────────
function renderAnniversariesList() {
    var container = document.getElementById('ann-list-container');
    if (!container) return;
    container.innerHTML = '';

    var now  = new Date();
    var list = (typeof anniversaries !== 'undefined') ? anniversaries : [];

    // 按创建时间倒序（id 为 Date.now() 时间戳）
    list.slice().sort(function(a, b) { return b.id - a.id; }).forEach(function(ann) {
        var target     = new Date(ann.date);
        var isCountdown = ann.type === 'countdown';
        var diffDays   = isCountdown
            ? Math.max(0, Math.ceil((target - now) / 86400000))
            : Math.max(0, Math.floor((now - target) / 86400000));

        var item = document.createElement('div');
        item.className = 'ann-item-card ' + (isCountdown ? 'type-future' : 'type-past');
        item.dataset.annId = ann.id;
        item.innerHTML = [
            '<div class="ann-item-left">',
            '  <div class="ann-item-name">' + ann.name + '<span class="ann-tag">' + (isCountdown ? '倒数' : '纪念') + '</span></div>',
            '  <div class="ann-item-date">起始于 ' + target.toLocaleDateString('zh-CN') + '</div>',
            '</div>',
            '<div style="display:flex;align-items:center;gap:6px;">',
            '  <div class="ann-item-right">',
            '    <div class="ann-item-days">' + diffDays.toLocaleString('zh-CN') + '</div>',
            '    <div class="ann-item-days-unit">' + (isCountdown ? '天后' : '天') + '</div>',
            '  </div>',
            '  <button class="ann-delete-btn" title="删除"><i class="fas fa-times"></i></button>',
            '</div>'
        ].join('');

        var deleteBtn = item.querySelector('.ann-delete-btn');
        deleteBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            if (typeof window.deleteAnniversaryItem === 'function') window.deleteAnniversaryItem(ann.id);
        });
        item.addEventListener('click', function() {
            window.openAnnSheet('edit', ann.id);
        });
        container.appendChild(item);
    });

    // 末尾固定：相遇 xx 天（动态计算，不可删除）
    var meet = _annBuildMeetCard();
    if (meet) container.appendChild(meet);
}

function _annBuildMeetCard() {
    var msgs = (typeof messages !== 'undefined') ? messages : [];
    if (!msgs.length) return null;

    var start = new Date(msgs[0].timestamp);
    if (isNaN(start.getTime())) return null;

    var days = Math.max(0, Math.floor((Date.now() - start.getTime()) / 86400000));

    var el = document.createElement('div');
    el.className = 'ann-item-card type-past ann-item-meet';
    el.innerHTML = [
        '<div class="ann-item-left">',
        '  <div class="ann-item-name">相遇<span class="ann-tag">纪念</span></div>',
        '  <div class="ann-item-date">起始于 ' + start.toLocaleDateString('zh-CN') + '</div>',
        '</div>',
        '<div class="ann-item-right">',
        '  <div class="ann-item-days">' + days.toLocaleString('zh-CN') + '</div>',
        '  <div class="ann-item-days-unit">天</div>',
        '</div>'
    ].join('');
    return el;
}

// ── 初始化（供 csSwitchTab('ann') 调用）──────────────────
window._annInit = function() {
    renderAnniversariesList();

    var addBtn = document.getElementById('cs-ann-add-btn');
    if (addBtn) addBtn.onclick = function() { window.openAnnSheet('add'); };

    var nameInput = document.getElementById('cs-ann-input-name');
    if (nameInput) nameInput.oninput = _annUpdateCharCount;
};
