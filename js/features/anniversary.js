/**
 * anniversary.js — 情侣空间：纪念日 tab
 *
 * 数据层、天数计算、增删逻辑与 onboarding.js / core.js / mood.js 里的高级功能纪念日完全一致。
 * 唯一的区别：渲染目标从 #anniversary-modal 换成了 #cs-panel-ann。
 */

/* ─── 私有状态 ─────────────────────────────── */
let _annEditId   = null;          // null=新增, id=编辑
let _annCurrId   = null;          // 详情当前 id
let _annCoverTmp = null;          // dialog 封面临时 base64
let _annDialogType = 'anniversary'; // dialog 当前类型选中
let _annSwiped   = null;          // 当前已滑开的列表行
let _annNotesTmr = null;          // 备注防抖 timer

/* ─── 天数计算（逻辑与 onboarding.js fillAnnHeaderCard 完全一致） ── */
function _annCalcDays(ann) {
    const now = new Date();
    const targetDate = new Date(ann.date);
    if (ann.type === 'countdown') {
        const d = Math.ceil((targetDate - now) / (1000 * 60 * 60 * 24));
        return d < 0 ? 0 : d;
    } else {
        const d = Math.floor((now - targetDate) / (1000 * 60 * 60 * 24));
        return d < 0 ? 0 : d;
    }
}

/* ─── 日期格式化 ──────────────────────────── */
function _annFmtDate(dateStr) {
    if (!dateStr) return '';
    const d  = new Date(dateStr + 'T00:00:00');
    const wk = ['星期日','星期一','星期二','星期三','星期四','星期五','星期六'];
    return `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日 ${wk[d.getDay()]}`;
}

/* ─── 获取当前置顶/活跃项（pinned 优先，否则取第一条） ── */
function _annGetActive() {
    if (!Array.isArray(anniversaries) || !anniversaries.length) return null;
    return anniversaries.find(a => a.pinned) || anniversaries[0];
}

function _annById(id) {
    return (Array.isArray(anniversaries) ? anniversaries : [])
        .find(a => String(a.id) === String(id));
}

/* ─── 默认条目（初次相遇，与消息统计用同一数据来源） ── */
function _annEnsureDefault() {
    if (!Array.isArray(anniversaries)) anniversaries = [];
    if (anniversaries.length > 0) return;

    let firstDate = new Date().toISOString().slice(0, 10);
    try {
        const msgs = (typeof messages !== 'undefined' ? messages : [])
            .filter(m => m && m.timestamp);
        if (msgs.length) {
            firstDate = new Date(msgs[0].timestamp).toISOString().slice(0, 10);
        }
    } catch(e) {}

    anniversaries.push({
        id:        'default_meet',
        name:      '与梦角相遇',
        date:      firstDate,
        type:      'anniversary',
        desc:      '',
        cover:     null,
        notes:     '',
        pinned:    true,
        isDefault: true
    });
    throttledSaveData();
}

/* ─── cs-outer-header 天数行更新 ────────────── */
window._annUpdateHeader = function () {
    const textEl = document.getElementById('cs-days-text');
    if (!textEl) return;

    const active = _annGetActive();
    if (!active) {
        textEl.innerHTML = '相识 <span class="cs-days-num" id="cs-days-num">---</span> 天';
        return;
    }

    const days  = _annCalcDays(active);
    const label = active.type === 'countdown' ? '还有' : '已经';
    const name  = active.name || '与梦角相遇';

    // 按名称长度缩放字号，保证在头部塞得下
    const len = name.length;
    const fs  = len <= 5 ? '14px' : len <= 8 ? '12px' : '10px';

    textEl.innerHTML =
        `<span style="font-size:${fs};color:var(--text-secondary);">${name} ${label}</span>` +
        ` <span class="cs-days-num" id="cs-days-num">${days}</span>` +
        ` <span style="color:var(--text-secondary);">天</span>`;
};

/* ─── 入口（由 csSwitchTab('ann') 调用） ───── */
window._annInit = function () {
    _annEnsureDefault();
    _annShowList();
    window._annUpdateHeader();
};

/* ─── 视图切换 ──────────────────────────────── */
function _annShowList() {
    const vl = document.getElementById('ann-view-list');
    const vd = document.getElementById('ann-view-detail');
    if (vl) { vl.style.display = 'block'; _annRenderList(); }
    if (vd) vd.style.display = 'none';
    window._annCloseDialog();
    if (_annSwiped) _annSnapBack(_annSwiped);
}

function _annShowDetail(id) {
    _annCurrId = id;
    const vl = document.getElementById('ann-view-list');
    const vd = document.getElementById('ann-view-detail');
    if (vl) vl.style.display = 'none';
    if (vd) { vd.style.display = 'block'; _annRenderDetail(id); }
}

/* ─── 渲染：列表视图 ─────────────────────────
   结构与 onboarding.js renderAnniversariesList() 相同，
   只是渲染目标从 #ann-list-container 换成了 #ann-featured-wrap / #ann-list-rows
   ─────────────────────────────────────────── */
function _annRenderList() {
    const list  = Array.isArray(anniversaries) ? anniversaries : [];
    const featW = document.getElementById('ann-featured-wrap');
    const rowsW = document.getElementById('ann-list-rows');
    if (!featW || !rowsW) return;

    if (!list.length) {
        featW.innerHTML = '';
        rowsW.innerHTML =
            '<div class="ann-empty"><i class="fas fa-calendar-heart"></i>' +
            '<div>还没有纪念日<br>点右上角 + 添加吧</div></div>';
        return;
    }

    const active = _annGetActive();
    const others = list.filter(a => String(a.id) !== String(active.id));

    featW.innerHTML = _annFeaturedHtml(active);
    rowsW.innerHTML = others.map(a => _annRowHtml(a)).join('');

    others.forEach(a => {
        const row = rowsW.querySelector(`.ann-row[data-id="${a.id}"]`);
        if (row) _annBindSwipe(row, a.id);
    });
}

function _annFeaturedHtml(ann) {
    const days    = _annCalcDays(ann);
    const label   = ann.type === 'countdown' ? '还有' : '已经';
    const dateLbl = ann.type === 'countdown' ? '目标日' : '起始于';
    const hasCover = !!ann.cover;
    const coverSt  = hasCover
        ? `background-image:url(${ann.cover});background-size:cover;background-position:center;`
        : '';
    return `
<div class="ann-featured${hasCover ? ' ann-featured-img' : ''}"
     style="${coverSt}" onclick="window._annOpenDetail('${ann.id}')">
    <div class="ann-featured-overlay"></div>
    <div class="ann-featured-body">
        <div class="ann-featured-top">
            <span class="ann-featured-name">"${ann.name}"</span>
            <span class="ann-featured-label">&nbsp;${label}</span>
        </div>
        <div class="ann-featured-num">${days.toLocaleString('zh-CN')}</div>
        <div class="ann-featured-date">${dateLbl}：${_annFmtDate(ann.date)}</div>
    </div>
    ${ann.pinned ? '<span class="ann-pin-dot"></span>' : ''}
</div>`;
}

function _annRowHtml(ann) {
    /* 与 onboarding.js renderAnniversariesList 里的 ann-item-card 逻辑相同 */
    const days    = _annCalcDays(ann);
    const label   = ann.type === 'countdown' ? '还有' : '已经';
    const dayUnit = ann.type === 'countdown' ? '天后' : '天';
    return `
<div class="ann-row" data-id="${ann.id}">
    <div class="ann-row-del" onclick="window._annDeleteById('${ann.id}')">删除</div>
    <div class="ann-row-inner" onclick="window._annOpenDetail('${ann.id}')">
        <span class="ann-row-name">${ann.name}</span>
        <div class="ann-row-right">
            <span class="ann-row-label">${label}</span>
            <span class="ann-row-num">${days.toLocaleString('zh-CN')}</span>
            <span class="ann-row-unit">${dayUnit}</span>
            <i class="fas fa-chevron-right ann-row-arrow"></i>
        </div>
    </div>
</div>`;
}

/* ─── 渲染：详情视图 ─────────────────────────
   与 onboarding.js fillAnnHeaderCard() 展示相同的数据，
   只是渲染目标换成了 #ann-detail-cover
   ─────────────────────────────────────────── */
function _annRenderDetail(id) {
    const ann = _annById(id);
    if (!ann) { _annShowList(); return; }

    const days    = _annCalcDays(ann);
    const label   = ann.type === 'countdown' ? '还有' : '已经';
    const dateLbl = ann.type === 'countdown' ? '目标日' : '起始于';

    const coverEl = document.getElementById('ann-detail-cover');
    if (coverEl) {
        const coverSt = ann.cover
            ? `background-image:url(${ann.cover});background-size:cover;background-position:center;`
            : '';
        coverEl.setAttribute('style', coverSt);
        coverEl.innerHTML = `
<div class="ann-cover-gradient"></div>
<div class="ann-cover-content">
    <div class="ann-cover-top-lbl">"${ann.name}" ${label}</div>
    <div class="ann-cover-num">${days.toLocaleString('zh-CN')}</div>
    <div class="ann-cover-bot-lbl">${dateLbl}：${ann.date}</div>
</div>`;
    }

    const pinBtn = document.getElementById('ann-pin-btn');
    if (pinBtn) {
        pinBtn.textContent = ann.pinned ? '✦ 已置顶' : '置顶';
        pinBtn.classList.toggle('ann-pin-btn-on', !!ann.pinned);
    }

    /* 备注：自动保存，与 mood.js 里的 autosave 模式一致 */
    const notesEl = document.getElementById('ann-notes-input');
    if (notesEl) {
        notesEl.value = ann.notes || '';
        notesEl.oninput = () => {
            clearTimeout(_annNotesTmr);
            _annNotesTmr = setTimeout(() => {
                const a = _annById(id);
                if (a) { a.notes = notesEl.value; throttledSaveData(); }
            }, 800);
        };
    }
}

/* ─── 详情交互 ──────────────────────────────── */
window._annOpenDetail = function (id) { _annShowDetail(id); };

window._annBackToList = function () {
    _annShowList();
    window._annUpdateHeader();
};

window._annPinCurrent = function () {
    if (!_annCurrId) return;
    (Array.isArray(anniversaries) ? anniversaries : []).forEach(a => {
        a.pinned = (String(a.id) === String(_annCurrId));
    });
    throttledSaveData();
    _annRenderDetail(_annCurrId);
    window._annUpdateHeader();
    showNotification('已置顶', 'success');
};

window._annOpenEdit = function () {
    if (!_annCurrId) return;
    _annOpenDialogFor(_annCurrId);
};

/* ─── 滑动删除（列表项向左划出删除按钮） ─── */
function _annBindSwipe(rowEl, id) {
    const THRESH = 72;
    let startX = 0;
    rowEl.addEventListener('touchstart', e => {
        startX = e.touches[0].clientX;
        if (_annSwiped && _annSwiped !== rowEl) _annSnapBack(_annSwiped);
    }, { passive: true });
    rowEl.addEventListener('touchmove', e => {
        const dx = e.touches[0].clientX - startX;
        if (dx >= 0) return;
        const t     = Math.max(dx, -THRESH);
        const inner = rowEl.querySelector('.ann-row-inner');
        const del   = rowEl.querySelector('.ann-row-del');
        if (inner) inner.style.transform = `translateX(${t}px)`;
        if (del)   del.style.opacity     = String(Math.min(1, -t / THRESH));
    }, { passive: true });
    rowEl.addEventListener('touchend', e => {
        const dx = e.changedTouches[0].clientX - startX;
        if (dx < -(THRESH / 2)) {
            const inner = rowEl.querySelector('.ann-row-inner');
            const del   = rowEl.querySelector('.ann-row-del');
            if (inner) inner.style.transform = `translateX(-${THRESH}px)`;
            if (del)   del.style.opacity     = '1';
            _annSwiped = rowEl;
        } else {
            _annSnapBack(rowEl);
        }
    }, { passive: true });
}
function _annSnapBack(rowEl) {
    if (!rowEl) return;
    const inner = rowEl.querySelector('.ann-row-inner');
    const del   = rowEl.querySelector('.ann-row-del');
    if (inner) inner.style.transform = '';
    if (del)   del.style.opacity     = '0';
    if (_annSwiped === rowEl) _annSwiped = null;
}

/* ─── 删除（与 deleteAnniversaryItem / deleteAnniversary 逻辑相同） ── */
window._annDeleteById = function (id) {
    const ann = _annById(id);
    if (!ann) return;
    if (ann.isDefault) {
        showNotification('默认条目不可删除，可在编辑里修改', 'warning');
        return;
    }
    if (!confirm(`确定删除"${ann.name}"吗？`)) return;

    /* ↓ 与 deleteAnniversaryItem() 完全相同的数据操作 */
    const wasPinned = ann.pinned;
    anniversaries = anniversaries.filter(a => String(a.id) !== String(id));
    if (wasPinned && anniversaries.length) anniversaries[0].pinned = true;
    throttledSaveData();
    /* ↑ */

    _annRenderList();
    window._annUpdateHeader();
    showNotification('已删除', 'success');
    if (typeof playSound === 'function') playSound('anniversary');
};

window._annDeleteFromDialog = function () {
    if (_annEditId === null) return;
    const wasDetail = String(_annCurrId) === String(_annEditId);
    const targetId  = _annEditId;
    window._annCloseDialog();
    window._annDeleteById(targetId);
    if (wasDetail) _annShowList();
};

/* ─── 弹窗（添加 / 编辑） ──────────────────── */
window._annOpenAdd = function () { _annOpenDialogFor(null); };

function _annOpenDialogFor(id) {
    _annEditId     = id;
    _annCoverTmp   = null;
    _annDialogType = 'anniversary';

    const overlay = document.getElementById('ann-dialog-overlay');
    if (!overlay) return;

    const title  = document.getElementById('ann-dialog-title');
    const delBtn = document.getElementById('ann-del-btn');
    const nameI  = document.getElementById('ann-inp-name');
    const dateI  = document.getElementById('ann-inp-date');
    const descI  = document.getElementById('ann-inp-desc');
    const prevEl = document.getElementById('ann-cover-preview');
    const hintEl = document.getElementById('ann-cover-hint');

    if (id !== null) {
        const ann = _annById(id);
        if (!ann) return;
        if (title)  title.textContent = '编辑纪念日';
        if (delBtn) delBtn.style.display = ann.isDefault ? 'none' : 'block';
        if (nameI)  nameI.value = ann.name || '';
        if (dateI)  dateI.value = ann.date || '';
        if (descI)  descI.value = ann.desc || '';
        _annDialogType = ann.type || 'anniversary';
        if (ann.cover) {
            _annCoverTmp = ann.cover;
            if (prevEl) prevEl.style.backgroundImage = `url(${ann.cover})`;
            if (hintEl) hintEl.textContent = '点击更换图片';
        } else {
            if (prevEl) prevEl.style.backgroundImage = '';
            if (hintEl) hintEl.textContent = '点击上传图片';
        }
    } else {
        if (title)  title.textContent = '添加纪念日';
        if (delBtn) delBtn.style.display = 'none';
        if (nameI)  nameI.value = '';
        if (dateI)  dateI.value = '';
        if (descI)  descI.value = '';
        if (prevEl) prevEl.style.backgroundImage = '';
        if (hintEl) hintEl.textContent = '点击上传图片';
    }

    window._annSetType(_annDialogType);
    overlay.style.display = 'flex';
}

window._annCloseDialog = function () {
    const overlay = document.getElementById('ann-dialog-overlay');
    if (overlay) overlay.style.display = 'none';
};

/* 类型切换（与 switchAnnType / selectAnnType 逻辑相同，目标换成新按钮） */
window._annSetType = function (type) {
    _annDialogType = type;
    ['anniversary','countdown'].forEach(t => {
        const btn = document.getElementById('ann-tbtn-' + t);
        if (btn) btn.classList.toggle('ann-type-on', t === type);
    });
};

/* 封面上传（与 ann-header-bg-input 的处理一致，用 optimizeImage 压缩） */
window._annHandleCover = function (input) {
    const file = input.files[0];
    if (!file) return;
    const doCompress = typeof optimizeImage === 'function'
        ? optimizeImage(file, 800, 0.75)
        : new Promise((res, rej) => {
            const r = new FileReader();
            r.onload = e => res(e.target.result);
            r.onerror = rej;
            r.readAsDataURL(file);
        });
    doCompress.then(b64 => {
        _annCoverTmp = b64;
        const prevEl = document.getElementById('ann-cover-preview');
        const hintEl = document.getElementById('ann-cover-hint');
        if (prevEl) prevEl.style.backgroundImage = `url(${b64})`;
        if (hintEl) hintEl.textContent = '点击更换图片';
    }).catch(() => {});
    input.value = '';
};

/* 保存（与 addAnniversary() 逻辑相同，增加了 cover/notes/pinned 字段） */
window._annSave = function () {
    const nameI = document.getElementById('ann-inp-name');
    const dateI = document.getElementById('ann-inp-date');
    const descI = document.getElementById('ann-inp-desc');
    const name  = (nameI ? nameI.value : '').trim();
    const date  = dateI ? dateI.value : '';
    const desc  = (descI ? descI.value : '').trim();

    if (!name) { showNotification('请填写名称', 'error');  return; }
    if (!date) { showNotification('请选择日期', 'error'); return; }

    if (!Array.isArray(anniversaries)) anniversaries = [];

    if (_annEditId !== null) {
        /* 编辑：更新现有条目 */
        const ann = _annById(_annEditId);
        if (ann) {
            ann.name = name;
            ann.date = date;
            ann.type = _annDialogType;
            ann.desc = desc;
            if (_annCoverTmp !== null) ann.cover = _annCoverTmp;
        }
        throttledSaveData();
        window._annCloseDialog();
        window._annUpdateHeader();
        /* 若在详情 → 刷新详情；否则回列表 */
        const vd = document.getElementById('ann-view-detail');
        if (vd && vd.style.display !== 'none' && String(_annCurrId) === String(_annEditId)) {
            _annRenderDetail(_annEditId);
        } else {
            _annShowList();
        }
    } else {
        /* 新增：与 addAnniversary() 相同的 push 操作 */
        const isFirst = anniversaries.length === 0;
        anniversaries.push({
            id:        Date.now(),
            name, date, desc,
            type:      _annDialogType,
            cover:     _annCoverTmp || null,
            notes:     '',
            pinned:    isFirst,
            isDefault: false
        });
        throttledSaveData();
        window._annCloseDialog();
        window._annUpdateHeader();
        _annShowList();
    }

    showNotification(_annEditId !== null ? '已保存' : '纪念日已添加', 'success');
    if (typeof playSound === 'function') playSound('anniversary');
};
