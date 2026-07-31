/**
 * anniversary.js — 纪念日功能（情侣空间 #cs-panel-ann）
 * 加载在 onboarding.js 之后，覆盖 renderAnniversariesList / switchAnnType
 */

// ── 模块状态 ──────────────────────────────────────────────
var _annEditingId   = null;
var _annPinnedId    = null;   // null/'meet'=相遇；Number=具体条目
var _annCoverDataUrl = null;  // 当前 sheet 内的封面图 data URL
var _annCoverChanged = false; // 本次打开 sheet 是否修改过封面

// ── 封面图片辅助函数 ──────────────────────────────────────
function _annShowCoverPreview(url) {
    var img   = document.getElementById('cs-ann-cover-img');
    var thumb = document.getElementById('cs-ann-cover-thumb');
    if (img)   img.src = url || '';
    if (thumb) thumb.style.display = url ? '' : 'none';
}

window._annOnCoverSelected = function(input) {
    var file = input.files && input.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function(ev) {
        _annCoverDataUrl = ev.target.result;
        _annCoverChanged = true;
        _annShowCoverPreview(_annCoverDataUrl);
    };
    reader.readAsDataURL(file);
    input.value = '';
};

window._annRemoveCover = function() {
    _annCoverDataUrl = null;
    _annCoverChanged = true;
    _annShowCoverPreview(null);
};

// ── 置顶持久化 ────────────────────────────────────────────
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
    if (typeof window._updateDaysCounter === 'function') window._updateDaysCounter();
    if (typeof showNotification === 'function') showNotification('已置顶', 'success');
};

window._annLoadPinned = _annLoadPinnedId;
window._annGetPinned = function() {
    var isMeet = (_annPinnedId === null || _annPinnedId === 'meet');
    if (isMeet) {
        var msgs = (typeof messages !== 'undefined') ? messages : [];
        if (!msgs.length) return null;
        var start = new Date(msgs[0].timestamp);
        var days = Math.max(0, Math.floor((Date.now() - start.getTime()) / 86400000));
        return { type: 'meet', name: '相遇', days: days, dayLabel: '天', start: start };
    }
    var ann = (typeof anniversaries !== 'undefined' ? anniversaries : []).find(function(a) { return a.id === _annPinnedId; });
    if (!ann) return null;
    var now = new Date(), target = new Date(ann.date), isCD = ann.type === 'countdown';
    var days2 = isCD ? Math.max(0, Math.ceil((target - now) / 86400000)) : Math.max(0, Math.floor((now - target) / 86400000));
    return { type: 'ann', name: ann.name, days: days2, dayLabel: isCD ? '天后' : '天', ann: ann };
};

// ── 左滑手势（基于 ann-swipe-inner 平移）─────────────────
function _annSetupSwipe(wrap) {
    var inner   = wrap.querySelector('.ann-swipe-inner');
    var actions = wrap.querySelector('.ann-swipe-actions');
    if (!inner || !actions) return;

    var startX = 0, startY = 0, dragBaseX = 0;
    var decided = false, isHoriz = false;
    var isOpen  = false;

    function actW() { return actions.offsetWidth || 144; }

    function snapTo(x, animate) {
        if (animate) {
            inner.style.transition = 'transform 0.22s cubic-bezier(0.4,0,0.2,1)';
            setTimeout(function() { inner.style.transition = ''; }, 230);
        }
        inner.style.transform = x === 0 ? '' : 'translateX(' + x + 'px)';
    }

    wrap._closeSwipe = function() {
        if (isOpen) { snapTo(0, true); isOpen = false; }
    };

    inner.addEventListener('touchstart', function(e) {
        _annCloseAllSwipesExcept(wrap);
        startX    = e.touches[0].clientX;
        startY    = e.touches[0].clientY;
        dragBaseX = isOpen ? -actW() : 0;
        decided   = false;
        isHoriz   = false;
    }, { passive: true });

    // touch-action:pan-y 已告知浏览器横向不归它管，这里 passive:true 即可
    inner.addEventListener('touchmove', function(e) {
        var dx = e.touches[0].clientX - startX;
        var dy = e.touches[0].clientY - startY;
        if (!decided) {
            if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
            isHoriz = Math.abs(dx) > Math.abs(dy);
            decided = true;
        }
        if (!isHoriz) return;
        var newX = Math.min(0, Math.max(-actW(), dragBaseX + dx));
        inner.style.transform = newX === 0 ? '' : 'translateX(' + newX + 'px)';
    }, { passive: true });

    inner.addEventListener('touchend', function(e) {
        if (!decided || !isHoriz) return;
        var dx     = e.changedTouches[0].clientX - startX;
        var totalX = dragBaseX + dx;
        if (totalX < -(actW() * 0.35)) {
            snapTo(-actW(), true); isOpen = true;
        } else {
            snapTo(0, true); isOpen = false;
        }
    }, { passive: true });

    inner.addEventListener('click', function(e) {
        if (e.target.closest('.ann-swipe-actions')) return;
        if (isOpen) { snapTo(0, true); isOpen = false; return; }
        if (typeof wrap._onCardClick === 'function') wrap._onCardClick();
    });
}

function _annCloseAllSwipesExcept(exceptWrap) {
    document.querySelectorAll('.ann-swipe-wrap').forEach(function(w) {
        if (w !== exceptWrap && typeof w._closeSwipe === 'function') w._closeSwipe();
    });
}

// ── Bottom sheet 开关 ─────────────────────────────────────
window.openAnnSheet = function(mode, annId) {
    _annCloseAllSwipesExcept(null);
    _annEditingId = (mode === 'edit' && annId) ? annId : null;

    var titleEl   = document.getElementById('cs-ann-sheet-title');
    var deleteBtn = document.getElementById('cs-ann-sheet-delete');
    var nameInput = document.getElementById('cs-ann-input-name');
    var dateInput = document.getElementById('cs-ann-input-date');

    if (titleEl)   titleEl.textContent     = _annEditingId ? '编辑纪念日' : '添加纪念日';
    if (deleteBtn) deleteBtn.style.display = _annEditingId ? 'block'      : 'none';

    // 重置封面
    _annCoverDataUrl = null;
    _annCoverChanged = false;
    _annShowCoverPreview(null);

    if (_annEditingId) {
        var ann = (typeof anniversaries !== 'undefined' ? anniversaries : []).find(function(a) { return a.id === _annEditingId; });
        if (ann) {
            if (nameInput) nameInput.value = ann.name || '';
            if (dateInput) dateInput.value = ann.date || '';
            window.switchAnnType(ann.type || 'anniversary');
        }
        // 异步加载已有封面
        try {
            localforage.getItem(getStorageKey('annCoverBg_' + _annEditingId)).then(function(url) {
                if (url) { _annCoverDataUrl = url; _annShowCoverPreview(url); }
            });
        } catch(e) {}
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

    var savedId;
    if (_annEditingId !== null) {
        savedId = _annEditingId;
        var idx = anniversaries.findIndex(function(a) { return a.id === _annEditingId; });
        if (idx !== -1) { anniversaries[idx].name = name; anniversaries[idx].date = date; anniversaries[idx].type = type; }
    } else {
        savedId = Date.now();
        anniversaries.push({ id: savedId, name: name, date: date, type: type });
    }

    // 封面图片：有变化才写入
    if (_annCoverChanged) {
        try {
            var coverKey = getStorageKey('annCoverBg_' + savedId);
            if (_annCoverDataUrl) {
                localforage.setItem(coverKey, _annCoverDataUrl);
            } else {
                localforage.removeItem(coverKey);
            }
        } catch(e) {}
    }

    if (typeof throttledSaveData === 'function') throttledSaveData();
    renderAnniversariesList();
    window.closeAnnSheet();
    if (typeof showNotification === 'function') showNotification(_annEditingId ? '已更新' : '纪念日已添加', 'success');
};

// ── 删除（编辑 sheet 里的删除按钮）───────────────────────
window.deleteCurrentAnn = function() {
    if (_annEditingId === null) return;
    if (!confirm('确定要删除这条纪念日吗？')) return;
    anniversaries = anniversaries.filter(function(a) { return a.id !== _annEditingId; });
    if (_annPinnedId === _annEditingId) _annSavePinnedId(null);
    try { localforage.removeItem(getStorageKey('annCoverBg_' + _annEditingId)); } catch(e) {}
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

    // 若置顶 id 已被删除，重置为相遇
    if (typeof _annPinnedId === 'number' && !list.some(function(a) { return a.id === _annPinnedId; })) {
        _annSavePinnedId(null);
    }
    var isMeetPinned = (_annPinnedId === null || _annPinnedId === 'meet');

    // ── 构造相遇条目（供置顶或末尾使用）──
    var msgs  = (typeof messages !== 'undefined') ? messages : [];
    var meetWrap = null;
    if (msgs.length) {
        var start = new Date(msgs[0].timestamp);
        if (!isNaN(start.getTime())) {
            var meetDays = Math.max(0, Math.floor((Date.now() - start.getTime()) / 86400000));
            meetWrap = _annMakeWrap(
                _annMakeCard('相遇', start, meetDays, false, isMeetPinned),
                isMeetPinned,
                [{ label: '置顶', cls: 'ann-action-pin', fn: function() { window._annPinItem('meet'); } }],
                null   // 相遇不可编辑
            );
            meetWrap.classList.add('ann-swipe-wrap-meet');
        }
    }

    // 若相遇置顶，先渲染它
    if (isMeetPinned && meetWrap) container.appendChild(meetWrap);

    // ── 用户创建的纪念日：置顶项排首位，其余创建时间倒序 ──
    list.slice().sort(function(a, b) {
        if (_annPinnedId === a.id) return -1;
        if (_annPinnedId === b.id) return 1;
        return b.id - a.id;
    }).forEach(function(ann) {
        var isPinned    = (_annPinnedId === ann.id);
        var isCountdown = (ann.type === 'countdown');
        var target      = new Date(ann.date);
        var diffDays    = isCountdown
            ? Math.max(0, Math.ceil((target - now) / 86400000))
            : Math.max(0, Math.floor((now - target) / 86400000));

        var editFn = function() { window.openAnnSheet('edit', ann.id); };
        var wrap = _annMakeWrap(
            _annMakeCard(ann.name, target, diffDays, isCountdown, isPinned),
            isPinned,
            [
                { label: '置顶', cls: 'ann-action-pin',    fn: function() { window._annPinItem(ann.id); } },
                { label: '删除', cls: 'ann-action-delete', fn: function() {
                    if (typeof window.deleteAnniversaryItem === 'function') window.deleteAnniversaryItem(ann.id);
                }}
            ],
            editFn
        );
        container.appendChild(wrap);

        if (!isPinned) {
            _annSetupSwipe(wrap);
        } else {
            // 置顶项：无滑动，点击直接编辑
            var inner = wrap.querySelector('.ann-swipe-inner');
            if (inner) inner.addEventListener('click', editFn);
        }
    });

    // 若相遇未置顶，末尾渲染
    if (!isMeetPinned && meetWrap) {
        container.appendChild(meetWrap);
        _annSetupSwipe(meetWrap);
    }
}

// ── 工厂：卡片 ────────────────────────────────────────────
// ── 日期格式化（置顶大卡用）────────────────────────────
function _annFormatDate(date) {
    var dow = ['日','一','二','三','四','五','六'][date.getDay()];
    return date.getFullYear() + '年'
         + (date.getMonth() + 1) + '月'
         + date.getDate() + '日 星期' + dow;
}

// ── 工厂：卡片（置顶/普通两套模板）──────────────────────
function _annMakeCard(name, targetDate, diffDays, isCountdown, isPinned) {
    var el    = document.createElement('div');
    var label = isCountdown ? '倒数' : '已过';

    // 关键布局样式全用内联，不依赖 CSS 缓存
    var cardBaseStyle = 'flex:0 0 100%;min-width:0;display:flex;align-items:center;'
        + 'justify-content:space-between;box-sizing:border-box;background:var(--secondary-bg);';
    var tagStyle = 'background:rgba(var(--accent-color-rgb),0.12);color:var(--accent-color);'
        + 'border-color:rgba(var(--accent-color-rgb),0.2);';

    if (isPinned) {
        el.className = 'ann-pinned-card';
        el.setAttribute('style', cardBaseStyle + 'padding:18px 16px;min-height:88px;border-radius:0;border:none;margin:0;');
        el.innerHTML = [
            '<div style="flex:1;min-width:0;padding-left:4px;">',
            '  <div class="ann-item-name">' + name
                + '<span class="ann-tag" style="' + tagStyle + '">' + label + '</span></div>',
            '  <div style="font-size:12px;color:var(--text-secondary);margin-top:6px;opacity:0.8;">'
                + '起始于：' + _annFormatDate(targetDate) + '</div>',
            '</div>',
            '<div style="text-align:right;flex-shrink:0;margin-left:16px;">',
            '  <div style="font-size:52px;font-weight:800;color:var(--accent-color);line-height:1;letter-spacing:-1px;">'
                + diffDays.toLocaleString('zh-CN') + '</div>',
            '  <div style="font-size:12px;color:var(--text-secondary);margin-top:3px;">天</div>',
            '</div>'
        ].join('');
    } else {
        el.className = 'ann-list-row';
        el.setAttribute('style', cardBaseStyle + 'padding:14px 16px;min-height:54px;border-radius:0;border:none;margin:0;');
        el.innerHTML = [
            '<div style="flex:1;min-width:0;">',
            '  <div class="ann-item-name">' + name
                + '<span class="ann-tag" style="' + tagStyle + '">' + label + '</span></div>',
            '</div>',
            '<div style="text-align:right;flex-shrink:0;margin-left:12px;">',
            '  <div style="font-size:26px;font-weight:800;color:var(--accent-color);line-height:1;">'
                + diffDays.toLocaleString('zh-CN') + '</div>',
            '  <div style="font-size:12px;color:var(--text-secondary);">天</div>',
            '</div>'
        ].join('');
    }
    return el;
}

// ── 工厂：滑动容器（card + inner + actions 并排）─────────
function _annMakeWrap(card, isPinned, actionDefs, onCardClick) {
    var wrap  = document.createElement('div');
    wrap.className = 'ann-swipe-wrap' + (isPinned ? ' ann-swipe-pinned' : '');
    wrap.style.cssText = 'overflow:hidden;border-radius:14px;margin-bottom:10px;'
        + (isPinned ? 'border:1px solid rgba(var(--accent-color-rgb),0.45);' : 'border:1px solid var(--border-color);');
    wrap._onCardClick = onCardClick;

    var inner = document.createElement('div');
    inner.className = 'ann-swipe-inner';
    inner.style.cssText = 'display:flex;width:100%;'; // 内联确保横向排列不被缓存影响
    inner.appendChild(card);

    var actions = document.createElement('div');
    actions.className = 'ann-swipe-actions';
    actionDefs.forEach(function(def) {
        var btn = document.createElement('button');
        btn.className = 'ann-action-btn ' + def.cls;
        btn.textContent = def.label;
        btn.addEventListener('click', function(e) { e.stopPropagation(); def.fn(); });
        actions.appendChild(btn);
    });
    inner.appendChild(actions);

    wrap.appendChild(inner);
    return wrap;
}

// ── 初始化 ────────────────────────────────────────────────
window._annInit = async function() {
    await _annLoadPinnedId();
    renderAnniversariesList();
    if (typeof window._updateDaysCounter === 'function') window._updateDaysCounter();

    var addBtn = document.getElementById('cs-ann-add-btn');
    if (addBtn) addBtn.onclick = function() { window.openAnnSheet('add'); };

    var nameInput = document.getElementById('cs-ann-input-name');
    if (nameInput) nameInput.oninput = _annUpdateCharCount;
};
