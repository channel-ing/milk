/**
 * anniversary.js — 纪念日功能（情侣空间 #cs-panel-ann）
 * 加载在 onboarding.js 之后，覆盖 renderAnniversariesList / switchAnnType
 */

// ── 模块状态 ──────────────────────────────────────────────
var _annEditingId = null;   // null=新建；Number=编辑中的 id
var _annPinnedId  = null;   // null/'meet'=相遇；Number=具体条目

// ── 置顶：持久化 ──────────────────────────────────────────
async function _annLoadPinnedId() {
    try {
        var val = await localforage.getItem(getStorageKey('annPinnedId'));
        if (val !== null && val !== undefined) _annPinnedId = val;
    } catch(e) {}
}

function _annSavePinnedId(id) {
    _annPinnedId = id;
    try { localforage.setItem(getStorageKey('annPinnedId'), id); } catch(e) {}
}

window._annPinItem = function(annId) {
    _annSavePinnedId(annId);
    renderAnniversariesList();
    if (typeof showNotification === 'function') showNotification('已置顶', 'success');
};

// ── 获取当前置顶（供 Step 3 使用）────────────────────────
window._annGetPinned = function() {
    // 返回 { type:'meet'|'ann', data:... }
    var isMeet = (_annPinnedId === null || _annPinnedId === 'meet');
    if (isMeet) {
        var msgs = (typeof messages !== 'undefined') ? messages : [];
        if (!msgs.length) return null;
        var start = new Date(msgs[0].timestamp);
        var days = Math.max(0, Math.floor((Date.now() - start.getTime()) / 86400000));
        return { type: 'meet', name: '相遇', days: days, dayLabel: '天', start: start };
    }
    var ann = (typeof anniversaries !== 'undefined' ? anniversaries : []).find(function(a) { return a.id === _annPinnedId; });
    if (!ann) return null; // 被删除了，回退
    var now = new Date();
    var target = new Date(ann.date);
    var isCD = ann.type === 'countdown';
    var days2 = isCD
        ? Math.max(0, Math.ceil((target - now) / 86400000))
        : Math.max(0, Math.floor((now - target) / 86400000));
    return { type: 'ann', name: ann.name, days: days2, dayLabel: isCD ? '天后' : '天', ann: ann };
};

// ── 左滑手势 ──────────────────────────────────────────────
function _annSetupSwipe(wrap) {
    var card    = wrap.querySelector('.ann-item-card');
    var actions = wrap.querySelector('.ann-swipe-actions');
    if (!card || !actions) return;

    var startX = 0, startY = 0, dragBaseX = 0;
    var swipeDir = null;  // null=未决, true=横向, false=纵向
    var isOpen = false;

    function actW() { return actions.offsetWidth || 140; }

    function snapTo(x, animate) {
        if (animate) {
            card.style.transition = 'transform 0.22s cubic-bezier(0.4,0,0.2,1)';
            setTimeout(function() { card.style.transition = ''; }, 230);
        }
        card.style.transform = x === 0 ? '' : 'translateX(' + x + 'px)';
    }

    // 供外部调用关闭
    wrap._closeSwipe = function() {
        if (isOpen) { snapTo(0, true); isOpen = false; }
    };

    card.addEventListener('touchstart', function(e) {
        _annCloseAllSwipesExcept(wrap);
        startX    = e.touches[0].clientX;
        startY    = e.touches[0].clientY;
        dragBaseX = isOpen ? -actW() : 0;
        swipeDir  = null;
    }, { passive: true });

    card.addEventListener('touchmove', function(e) {
        var dx = e.touches[0].clientX - startX;
        var dy = e.touches[0].clientY - startY;
        if (swipeDir === null) {
            if (Math.abs(dy) > Math.abs(dx) + 3) { swipeDir = false; return; }
            if (Math.abs(dx) < 5) return;
            swipeDir = true;
        }
        if (!swipeDir) return;
        e.preventDefault();
        var newX = Math.min(0, Math.max(-actW(), dragBaseX + dx));
        card.style.transform = 'translateX(' + newX + 'px)';
    }, { passive: false });

    card.addEventListener('touchend', function(e) {
        if (swipeDir !== true) return;
        var dx     = e.changedTouches[0].clientX - startX;
        var totalX = dragBaseX + dx;
        if (totalX < -(actW() * 0.35)) {
            snapTo(-actW(), true); isOpen = true;
        } else {
            snapTo(0, true); isOpen = false;
        }
    }, { passive: true });

    // 点已展开的卡片主体 → 收回
    card.addEventListener('click', function() {
        if (isOpen) { snapTo(0, true); isOpen = false; }
    });
}

function _annCloseAllSwipesExcept(exceptWrap) {
    document.querySelectorAll('.ann-swipe-wrap').forEach(function(w) {
        if (w !== exceptWrap && typeof w._closeSwipe === 'function') w._closeSwipe();
    });
}

// ── Bottom sheet 开关 ─────────────────────────────────────
window.openAnnSheet = function(mode, annId) {
    _annCloseAllSwipesExcept(null); // 关所有已展开的左滑
    _annEditingId = (mode === 'edit' && annId) ? annId : null;

    var titleEl   = document.getElementById('cs-ann-sheet-title');
    var deleteBtn = document.getElementById('cs-ann-sheet-delete');
    var nameInput = document.getElementById('cs-ann-input-name');
    var dateInput = document.getElementById('cs-ann-input-date');

    if (titleEl)   titleEl.textContent     = _annEditingId ? '编辑纪念日' : '添加纪念日';
    if (deleteBtn) deleteBtn.style.display = _annEditingId ? 'block'      : 'none';

    if (_annEditingId) {
        var ann = (typeof anniversaries !== 'undefined' ? anniversaries : [])
                    .find(function(a) { return a.id === _annEditingId; });
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

    if (!name) { if (typeof showNotification === 'function') showNotification('请填写名称', 'error'); return; }
    if (!date) { if (typeof showNotification === 'function') showNotification('请选择日期', 'error'); return; }
    if (Array.from(name).length > 16) { if (typeof showNotification === 'function') showNotification('名称最多 8 个汉字', 'error'); return; }

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
    if (typeof showNotification === 'function') showNotification(_annEditingId ? '已更新' : '纪念日已添加', 'success');
};

// ── 删除当前编辑条目 ───────────────────────────────────────
window.deleteCurrentAnn = function() {
    if (_annEditingId === null) return;
    if (!confirm('确定要删除这条纪念日吗？')) return;
    anniversaries = anniversaries.filter(function(a) { return a.id !== _annEditingId; });
    if (_annPinnedId === _annEditingId) _annSavePinnedId(null); // 删置顶项 → 重置
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

// ── 覆盖 switchAnnType ────────────────────────────────────
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

// ── 渲染列表 ─────────────────────────────────────────────
function renderAnniversariesList() {
    var container = document.getElementById('ann-list-container');
    if (!container) return;
    container.innerHTML = '';

    var now  = new Date();
    var list = (typeof anniversaries !== 'undefined') ? anniversaries : [];

    // 若置顶 id 已被删除，重置
    if (typeof _annPinnedId === 'number' && !list.some(function(a) { return a.id === _annPinnedId; })) {
        _annSavePinnedId(null);
    }

    var isMeetPinned = (_annPinnedId === null || _annPinnedId === 'meet');

    // ── 用户创建的纪念日（创建时间倒序）──
    list.slice().sort(function(a, b) { return b.id - a.id; }).forEach(function(ann) {
        var isPinned    = (_annPinnedId === ann.id);
        var isCountdown = (ann.type === 'countdown');
        var target      = new Date(ann.date);
        var diffDays    = isCountdown
            ? Math.max(0, Math.ceil((target - now) / 86400000))
            : Math.max(0, Math.floor((now - target) / 86400000));

        var wrap = _annMakeSwipeWrap(
            _annMakeCard(ann.name, target, diffDays, isCountdown, isPinned, ann.id),
            isPinned,
            [
                { label: '置顶', cls: 'ann-action-pin',    fn: function() { window._annPinItem(ann.id); } },
                { label: '删除', cls: 'ann-action-delete', fn: function() {
                    if (typeof window.deleteAnniversaryItem === 'function') window.deleteAnniversaryItem(ann.id);
                }}
            ],
            isPinned ? null : function() { window.openAnnSheet('edit', ann.id); }
        );
        container.appendChild(wrap);
        if (!isPinned) _annSetupSwipe(wrap);
    });

    // ── 末尾固定：相遇 ──
    var msgs  = (typeof messages !== 'undefined') ? messages : [];
    if (!msgs.length) return;
    var start = new Date(msgs[0].timestamp);
    if (isNaN(start.getTime())) return;
    var meetDays = Math.max(0, Math.floor((Date.now() - start.getTime()) / 86400000));

    var meetWrap = _annMakeSwipeWrap(
        _annMakeCard('相遇', start, meetDays, false, isMeetPinned, 'meet'),
        isMeetPinned,
        [{ label: '置顶', cls: 'ann-action-pin', fn: function() { window._annPinItem('meet'); } }],
        null  // 相遇不可点击编辑
    );
    meetWrap.classList.add('ann-swipe-wrap-meet');
    container.appendChild(meetWrap);
    if (!isMeetPinned) _annSetupSwipe(meetWrap);
}

// ── 工厂：卡片元素 ────────────────────────────────────────
function _annMakeCard(name, targetDate, diffDays, isCountdown, isPinned, annId) {
    var card = document.createElement('div');
    card.className = 'ann-item-card '
        + (isCountdown ? 'type-future' : 'type-past')
        + (isPinned ? ' ann-item-pinned' : '');
    if (annId) card.dataset.annId = annId;
    card.innerHTML = [
        '<div class="ann-item-left">',
        '  <div class="ann-item-name">' + name
            + '<span class="ann-tag">' + (isCountdown ? '倒数' : '纪念') + '</span></div>',
        '  <div class="ann-item-date">起始于 ' + targetDate.toLocaleDateString('zh-CN') + '</div>',
        '</div>',
        '<div class="ann-item-right">',
        '  <div class="ann-item-days">' + diffDays.toLocaleString('zh-CN') + '</div>',
        '  <div class="ann-item-days-unit">' + (isCountdown ? '天后' : '天') + '</div>',
        '</div>'
    ].join('');
    return card;
}

// ── 工厂：滑动容器 ─────────────────────────────────────────
function _annMakeSwipeWrap(card, isPinned, actionDefs, onCardClick) {
    var wrap = document.createElement('div');
    wrap.className = 'ann-swipe-wrap' + (isPinned ? ' ann-swipe-pinned' : '');

    // 点击卡片（非滑动状态）
    if (onCardClick) card.addEventListener('click', onCardClick);

    var actions = document.createElement('div');
    actions.className = 'ann-swipe-actions';
    actionDefs.forEach(function(def) {
        var btn = document.createElement('button');
        btn.className = 'ann-action-btn ' + def.cls;
        btn.textContent = def.label;
        btn.addEventListener('click', function(e) { e.stopPropagation(); def.fn(); });
        actions.appendChild(btn);
    });

    wrap.appendChild(card);
    wrap.appendChild(actions);
    return wrap;
}

// ── 初始化 ────────────────────────────────────────────────
window._annInit = async function() {
    await _annLoadPinnedId();
    renderAnniversariesList();

    var addBtn = document.getElementById('cs-ann-add-btn');
    if (addBtn) addBtn.onclick = function() { window.openAnnSheet('add'); };

    var nameInput = document.getElementById('cs-ann-input-name');
    if (nameInput) nameInput.oninput = _annUpdateCharCount;
};
