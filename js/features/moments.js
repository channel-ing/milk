/**
 * moments.js — 情侣空间：动态功能
 */

// ─────────────────────────────────
//  数据结构
// ─────────────────────────────────
let momentsData = { posts: [], notifications: [] };

// ─────────────────────────────────
//  常量
// ─────────────────────────────────
const _M_STORAGE_KEY  = 'momentsData';
const _M_COOLDOWN_KEY = 'partnerLetterNextTime';
const _M_CD_MIN  = 48 * 60 * 60 * 1000;
const _M_CD_MAX  = 72 * 60 * 60 * 1000;
const _M_PROB    = 0.40;
const _M_DLY_MIN = 5  * 60 * 1000;
const _M_DLY_MAX = 20 * 60 * 1000;

// ─────────────────────────────────
//  工具
// ─────────────────────────────────
const _mDly   = () => _M_DLY_MIN + Math.random() * (_M_DLY_MAX - _M_DLY_MIN);
const _mToday = () => new Date().toISOString().slice(0, 10);
const _mUid   = p  => (p||'id') + '_' + Date.now() + '_' + Math.random().toString(36).substr(2,4);
const _mPName = () => (typeof settings !== 'undefined' && settings.partnerName) || '梦角';
const _mMName = () => (typeof settings !== 'undefined' && settings.myName)      || '我';

function _mPostText() {
    const pool = [...(window._customReplies || customReplies || [])];
    if (!pool.length) return '想着你呢。';
    let t = '';
    const n = 3 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) {
        const s = pool[Math.floor(Math.random() * pool.length)];
        t += s + (Math.random() < .2 ? '！' : Math.random() < .2 ? '……' : '。');
    }
    return t;
}
function _mPickStickers() {
    if (Math.random() >= 0.40) return [];
    const pool = [...(stickerLibrary || [])];
    if (!pool.length) return [];
    const n = 1 + Math.floor(Math.random() * 3);
    return pool.sort(() => Math.random() - .5).slice(0, Math.min(n, pool.length));
}
function _mCmtText() {
    const pool = [...(window._customReplies || customReplies || [])];
    return pool.length ? pool[Math.floor(Math.random() * pool.length)] : '嗯嗯~';
}

// ─────────────────────────────────
//  存储
// ─────────────────────────────────
async function loadMomentsData() {
    try {
        const s = await localforage.getItem(getStorageKey(_M_STORAGE_KEY));
        if (s) {
            momentsData = s;
            if (!momentsData.notifications) momentsData.notifications = [];
        }
    } catch(e) { console.warn('[Moments] load 失败', e); }
}
function saveMomentsData() {
    try { localforage.setItem(getStorageKey(_M_STORAGE_KEY), momentsData); }
    catch(e) { console.warn('[Moments] save 失败', e); }
}

// ─────────────────────────────────
//  通知系统
// ─────────────────────────────────
let _nQ = [], _nBusy = false;

function _pushNotif(type, postId) {
    // 存入通知历史
    momentsData.notifications = momentsData.notifications || [];
    const name = _mPName();
    const texts = {
        newPost:   `${name}发了新动态`,
        liked:     `${name}为你的动态点了赞`,
        commented: `${name}评论了你的动态`,
        replied:   `${name}回复了你`,
    };
    momentsData.notifications.unshift({
        id: _mUid('n'), type, postId,
        text: texts[type] || type,
        timestamp: Date.now(), read: false
    });
    if (momentsData.notifications.length > 50) momentsData.notifications = momentsData.notifications.slice(0, 50);
    saveMomentsData();
    _updateBadge();
    // 也走弹窗队列
    _nQ.push({type, postId}); _drainN();
}

function _drainN() {
    if (_nBusy || !_nQ.length) return;
    _nBusy = true; _showN(_nQ.shift());
}
function _showN({type, postId}) {
    const el = document.getElementById('moments-notif-popup');
    if (el) el.remove();
    const name = _mPName();
    const C = {
        newPost:   { icon:'📸', title:`${name}发了新动态`,       sub:'快去看看 Ta 的动态~' },
        liked:     { icon:'❤️',  title:`${name}为你的动态点了赞`, sub:'' },
        commented: { icon:'💬', title:`${name}评论了你的动态`,    sub:'去看看 Ta 说了什么~' },
        replied:   { icon:'💬', title:`${name}回复了你`,          sub:'去看看 Ta 说了什么~' },
    };
    const c = C[type] || C.newPost;
    const p = document.createElement('div');
    p.id = 'moments-notif-popup';
    p.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:var(--secondary-bg);border:1px solid var(--border-color);border-radius:20px;padding:18px 20px;z-index:9000;max-width:320px;width:88%;box-shadow:0 8px 32px rgba(0,0,0,0.18);display:flex;flex-direction:column;gap:12px;animation:_mSlideUp 0.4s cubic-bezier(0.22,1,0.36,1);';
    p.innerHTML = `<style>@keyframes _mSlideUp{from{opacity:0;transform:translateX(-50%) translateY(24px) scale(0.9)}60%{transform:translateX(-50%) translateY(-4px) scale(1.02)}to{opacity:1;transform:translateX(-50%) translateY(0) scale(1)}}</style>
        <div style="display:flex;align-items:center;gap:10px;"><span style="font-size:26px;">${c.icon}</span>
        <div><div style="font-size:14px;font-weight:700;color:var(--text-primary);">${c.title}</div>
        ${c.sub?`<div style="font-size:11px;color:var(--text-secondary);margin-top:2px;opacity:0.8;">${c.sub}</div>`:''}</div></div>
        <div style="display:flex;gap:8px;">
            <button onclick="document.getElementById('moments-notif-popup').remove();window._mND();" style="flex:1;padding:8px 0;border-radius:12px;border:1px solid var(--border-color);background:var(--primary-bg);color:var(--text-secondary);font-size:13px;cursor:pointer;">稍后</button>
            <button onclick="window._openMomentsPost('${postId}');document.getElementById('moments-notif-popup').remove();window._mND();" style="flex:2;padding:8px 0;border-radius:12px;border:none;background:var(--accent-color);color:#fff;font-size:13px;font-weight:600;cursor:pointer;">立即查看 ✦</button>
        </div>`;
    document.body.appendChild(p);
    setTimeout(() => { if (p.parentNode) { p.remove(); window._mND(); } }, 8000);
}
window._mND = () => { _nBusy = false; setTimeout(_drainN, 400); };

// ─────────────────────────────────
//  铃铛弹出层
// ─────────────────────────────────
window._mOpenBell = function() {
    let popup = document.getElementById('cs-notif-popup');
    if (popup && popup.style.display !== 'none') {
        popup.style.display = 'none'; return;
    }
    if (!popup) {
        popup = document.createElement('div');
        popup.id = 'cs-notif-popup';
        popup.className = 'cs-notif-popup';
        document.getElementById('couple-space-page').appendChild(popup);
    }
    popup.style.display = 'block';
    _renderNotifPopup(popup);
    // 标记全部已读
    (momentsData.notifications || []).forEach(n => { n.read = true; });
    saveMomentsData(); _updateBadge();
    // 点外面关闭
    setTimeout(() => {
        function closeOnOut(e) {
            const btn = document.getElementById('cs-bell-btn');
            if (!popup.contains(e.target) && (!btn || !btn.contains(e.target))) {
                popup.style.display = 'none';
                document.removeEventListener('click', closeOnOut);
            }
        }
        document.addEventListener('click', closeOnOut);
    }, 100);
};

function _renderNotifPopup(popup) {
    const notifs = (momentsData.notifications || []).slice(0, 15);
    if (!notifs.length) {
        popup.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-secondary);font-size:13px;opacity:0.6;">暂无通知</div>';
        return;
    }
    const icons = { newPost:'📸', liked:'❤️', commented:'💬', replied:'💬' };
    popup.innerHTML = '<div style="padding:10px 14px 6px;font-size:12px;font-weight:600;color:var(--text-secondary);">互动通知</div>' +
        notifs.map(n => {
            const t = new Date(n.timestamp);
            const timeStr = `${t.getMonth()+1}/${t.getDate()} ${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}`;
            return `<div class="cs-notif-item${n.read?'':' cs-notif-unread'}" onclick="window._openMomentsPost('${n.postId}');document.getElementById('cs-notif-popup').style.display='none';">
                <span style="font-size:18px;flex-shrink:0;">${icons[n.type]||'🔔'}</span>
                <div style="flex:1;min-width:0;">
                    <div style="font-size:13px;color:var(--text-primary);line-height:1.4;">${n.text}</div>
                    <div style="font-size:11px;color:var(--text-secondary);margin-top:2px;">${timeStr}</div>
                </div>
                ${!n.read?'<div style="width:7px;height:7px;background:var(--accent-color);border-radius:50%;flex-shrink:0;margin-top:4px;"></div>':''}
            </div>`;
        }).join('');
}

// ─────────────────────────────────
//  梦角发动态
// ─────────────────────────────────
async function generatePartnerMoment() {
    const now = Date.now();
    const post = {
        id: _mUid('partner'), type: 'partner',
        text: _mPostText(), images: _mPickStickers(),
        date: _mToday(), timestamp: now,
        isNewForUser: true, userLiked: false,
        partnerLiked: false, pendingLikeTime: null,
        comments: [], pendingPartnerComment: null,
        chainProbability: 0.70,
    };
    if (Math.random() < 0.10)
        post.pendingPartnerComment = { text: _mCmtText(), time: now + Math.floor(_mDly()), isSelfComment: true };
    momentsData.posts.unshift(post);
    saveMomentsData();
    _pushNotif('newPost', post.id);
}

// ─────────────────────────────────
//  用户发帖钩子
// ─────────────────────────────────
function onUserPostCreated(postId) {
    const p = momentsData.posts.find(p => p.id === postId);
    if (!p || p.type !== 'user') return;
    p.pendingLikeTime = Date.now() + _mDly();
    if (Math.random() < 0.90) {
        p.pendingPartnerComment = {
            text: _mCmtText(), time: Date.now() + _mDly(),
            replyTo: null
        };
        p.chainProbability = 0.45;
    } else { p.chainProbability = null; }
    saveMomentsData();
}

// ─────────────────────────────────
//  评论链
// ─────────────────────────────────
function onUserCommented(postId) {
    const p = momentsData.posts.find(p => p.id === postId);
    if (!p) return;
    const prob = p.chainProbability;
    if (prob === null || prob < 0.06) { p.chainProbability = null; saveMomentsData(); return; }
    if (Math.random() < prob) {
        p.pendingPartnerComment = {
            text: _mCmtText(), time: Date.now() + _mDly(),
            replyTo: { authorName: _mMName() } // 梦角回复用户
        };
        p.chainProbability = prob / 2;
    } else { p.chainProbability = null; }
    saveMomentsData();
}

// ─────────────────────────────────
//  状态检查
// ─────────────────────────────────
async function checkMomentsStatus() {
    await loadMomentsData();
    const now = Date.now(); let changed = false;
    for (const p of momentsData.posts) {
        if (p.pendingLikeTime && !p.partnerLiked && now >= p.pendingLikeTime) {
            p.partnerLiked = true; p.pendingLikeTime = null; changed = true;
            _pushNotif('liked', p.id);
        }
        if (p.pendingPartnerComment && now >= p.pendingPartnerComment.time) {
            const ppc = p.pendingPartnerComment;
            p.comments.push({
                id: _mUid('c'), authorType: 'partner',
                text: ppc.text, timestamp: ppc.time,
                isNew: true, replyTo: ppc.replyTo || null
            });
            p.pendingPartnerComment = null; changed = true;
            if (!ppc.isSelfComment) _pushNotif(p.type === 'user' ? 'commented' : 'replied', p.id);
        }
    }
    if (changed) { saveMomentsData(); _updateBadge(); }
    await _checkAction();
}

async function _checkAction() {
    try {
        const KEY = getStorageKey(_M_COOLDOWN_KEY), now = Date.now();
        const next = await localforage.getItem(KEY);
        if (next !== null && now < next) return;
        await localforage.setItem(KEY, now + _M_CD_MIN + Math.random() * (_M_CD_MAX - _M_CD_MIN));
        if (Math.random() >= _M_PROB) return;
        if (Math.random() < 0.5) {
            if (typeof window._generatePartnerLetter === 'function') window._generatePartnerLetter();
        } else { await generatePartnerMoment(); }
    } catch(e) { console.warn('[Moments] _checkAction 失败', e); }
}

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible')
        checkMomentsStatus().catch(e => console.warn('[Moments] visibility check 失败', e));
});

// ─────────────────────────────────
//  角标
// ─────────────────────────────────
function getMomentsUnreadCount() {
    let n = 0;
    for (const p of momentsData.posts) {
        if (p.isNewForUser) n++;
        for (const c of p.comments) if (c.authorType === 'partner' && c.isNew) n++;
    }
    return n;
}
function _countUnreadNotifs() {
    return (momentsData.notifications || []).filter(n => !n.read).length;
}
function markPostRead(postId) {
    const p = momentsData.posts.find(p => p.id === postId);
    if (!p) return;
    p.isNewForUser = false;
    p.comments.forEach(c => { c.isNew = false; });
    saveMomentsData(); _updateBadge();
}
function _updateBadge() {
    // 主页面角标
    const b = document.getElementById('moments-header-badge');
    if (b) b.style.display = getMomentsUnreadCount() > 0 ? 'inline-block' : 'none';
    // 铃铛红点
    const bell = document.getElementById('cs-bell-dot');
    if (bell) bell.style.display = _countUnreadNotifs() > 0 ? 'block' : 'none';
}

// ─────────────────────────────────
//  UI：图片渲染
// ─────────────────────────────────
function _imgEl(src) {
    if (!src || typeof src !== 'string') return '';
    const isCloud = src.indexOf('oss://') === 0;
    // 避免 data URL 放进 onclick 属性导致问题
    const clickable = !src.startsWith('data:');
    const clickAttr = clickable ? `onclick="viewImage('${src}')" style="cursor:pointer;"` : '';
    if (isCloud) return `<img data-lazy-cloud-ref="${src}" style="width:100%;height:100%;object-fit:cover;" ${clickAttr}>`;
    return `<img src="${src}" style="width:100%;height:100%;object-fit:cover;" ${clickAttr}>`;
}
function _bindLazy(el) {
    if (!window.CloudMedia) return;
    el.querySelectorAll('img[data-lazy-cloud-ref]').forEach(img =>
        window.CloudMedia.bindLazyImage(img, img.getAttribute('data-lazy-cloud-ref')));
}
function _imgGrid(images) {
    if (!images || !images.length) return '';
    const n = Math.min(images.length, 6);
    return `<div class="cs-post-imgs n${n}">
        ${images.slice(0, n).map(src => `<div style="aspect-ratio:1;overflow:hidden;border-radius:8px;">${_imgEl(src)}</div>`).join('')}
    </div>`;
}

// ─────────────────────────────────
//  UI：日期格式化
// ─────────────────────────────────
function _fmtDate(dateStr) {
    if (!dateStr) return '';
    const today = _mToday();
    if (dateStr === today) return '今天';
    const d = new Date(dateStr);
    const now = new Date();
    return d.getFullYear() === now.getFullYear()
        ? `${d.getMonth()+1}月${d.getDate()}日`
        : dateStr;
}

// ─────────────────────────────────
//  UI：头像
// ─────────────────────────────────
function _getAvSrc(isPartner) {
    const cache = window._avatarCache || {};
    if (isPartner) {
        if (cache.partner) return cache.partner;
        const el = document.getElementById('partner-avatar');
        return el && el.src && !el.src.endsWith('/') ? el.src : null;
    } else {
        if (cache.me) return cache.me;
        const el = document.getElementById('my-avatar');
        return el && el.src && !el.src.endsWith('/') ? el.src : null;
    }
}
function _avEl(isPartner, size) {
    const src = _getAvSrc(isPartner);
    const s = size || 36;
    const fallback = isPartner ? '🌸' : '🙂';
    return src
        ? `<img src="${src}" style="width:${s}px;height:${s}px;border-radius:50%;object-fit:cover;">`
        : `<span style="font-size:${Math.round(s*0.5)}px;">${fallback}</span>`;
}

// ─────────────────────────────────
//  UI：帖子卡片
// ─────────────────────────────────
let _openCmtPostId = null;
let _replyInfo = null;

function _renderCard(post) {
    const isPartner = post.type === 'partner';
    const name = isPartner ? _mPName() : _mMName();
    const likeOn = post.userLiked || post.partnerLiked;
    const likeCount = (post.partnerLiked ? 1 : 0) + (post.userLiked ? 1 : 0);
    const cmtCount = post.comments.length;
    const cmtOpen = _openCmtPostId === post.id;
    const hasNew = post.isNewForUser || post.comments.some(c => c.authorType === 'partner' && c.isNew);
    const canDel = post.type === 'user';

    return `<div class="cs-post" data-pid="${post.id}">
        <div class="cs-post-top">
            <div class="cs-post-av">${_avEl(isPartner, 36)}</div>
            <div class="cs-post-name">${name}${hasNew ? '<span style="width:7px;height:7px;background:var(--accent-color);border-radius:50%;display:inline-block;margin-left:6px;vertical-align:middle;"></span>' : ''}</div>
            ${canDel ? `<button class="cs-post-del" onclick="event.stopPropagation();_mDeletePost('${post.id}')"><i class="fas fa-trash-alt"></i></button>` : '<div style="width:24px;"></div>'}
        </div>
        <div class="cs-post-body">${post.text}</div>
        ${_imgGrid(post.images)}
        <div class="cs-post-foot">
            <span class="cs-post-date">${_fmtDate(post.date)}</span>
            <button class="cs-like-btn${likeOn?' on':''}" onclick="event.stopPropagation();_mToggleLike('${post.id}')">
                <i class="${likeOn?'fas':'far'} fa-heart"></i><span id="cs-lc-${post.id}">${likeCount>0?' '+likeCount:''}</span>
            </button>
            <button class="cs-cmt-btn${cmtOpen?' on':''}" onclick="event.stopPropagation();_mToggleCmt('${post.id}')">
                <i class="${cmtCount>0?'fas':'far'} fa-comment"></i><span id="cs-cc-${post.id}">${cmtCount>0?' '+cmtCount:''}</span>
            </button>
        </div>
        <div class="cs-cmt-section" id="cs-cmt-${post.id}" style="display:${cmtOpen?'block':'none'};"></div>
    </div>`;
}

// ─────────────────────────────────
//  UI：评论区渲染（内联）
// ─────────────────────────────────
function _renderCmtSection(postId) {
    const section = document.getElementById('cs-cmt-' + postId);
    if (!section) return;
    const post = momentsData.posts.find(p => p.id === postId);
    if (!post) return;
    const isMyPost = _openCmtPostId === postId;
    if (!isMyPost) { section.style.display = 'none'; return; }

    const showAll = section.dataset.showAll === '1';
    const MAX = 3;
    const cmts = post.comments;
    const toShow = showAll ? cmts : cmts.slice(0, MAX);
    const needMore = !showAll && cmts.length > MAX;

    let html = '<div class="cs-cmt-list">';
    if (!cmts.length) {
        html += '<div style="text-align:center;padding:10px 0;color:var(--text-secondary);font-size:12px;opacity:0.6;">还没有评论，来说点什么~</div>';
    } else {
        html += toShow.map(c => {
            const isP = c.authorType === 'partner';
            const cName = isP ? _mPName() : _mMName();
            const replyPart = c.replyTo
                ? ` <span style="color:var(--text-secondary);font-size:11px;">回复</span> <span style="color:var(--accent-color);">${c.replyTo.authorName}</span>`
                : '';
            const dot = isP && c.isNew ? '<span style="width:5px;height:5px;background:var(--accent-color);border-radius:50%;display:inline-block;margin-left:3px;vertical-align:middle;"></span>' : '';
            return `<div class="cs-cmt-item">
                <div class="cs-cmt-content">
                    <span class="cs-cmt-name">${cName}</span>${replyPart}：
                    <span class="cs-cmt-text">${c.text}${dot}</span>
                </div>
                <button class="cs-cmt-reply-btn" onclick="_mSetReply('${postId}','${c.id}','${cName}')">回复</button>
            </div>`;
        }).join('');
        if (needMore) {
            html += `<div class="cs-show-all-cmt" onclick="_mShowAllCmt('${postId}')">查看全部 ${cmts.length} 条评论</div>`;
        }
    }
    html += '</div>';

    const replyLabel = _replyInfo ? `回复 ${_replyInfo.authorName}：` : '';
    html += `<div class="cs-cmt-input-area">
        ${_replyInfo ? `<div class="cs-reply-label"><span>${replyLabel}</span><button onclick="_mCancelReply('${postId}')">✕</button></div>` : ''}
        <div class="cs-cmt-row">
            <input type="text" id="cs-ci-${postId}" class="cs-cmt-input-inline"
                placeholder="${_replyInfo ? '回复…' : '发表评论…'}"
                onkeydown="if(event.key==='Enter'){event.preventDefault();_mSendComment('${postId}');}">
            <button class="cs-cmt-send" onclick="_mSendComment('${postId}')"><i class="fas fa-paper-plane"></i></button>
        </div>
    </div>`;

    section.innerHTML = html;
    _bindLazy(section);
    setTimeout(() => {
        const inp = document.getElementById('cs-ci-' + postId);
        if (inp) inp.focus();
    }, 100);
}

window._mToggleCmt = function(postId) {
    if (_openCmtPostId === postId) {
        _openCmtPostId = null;
        _replyInfo = null;
        const s = document.getElementById('cs-cmt-' + postId);
        if (s) s.style.display = 'none';
        // update button style
        const btn = document.querySelector(`[data-pid="${postId}"] .cs-cmt-btn`);
        if (btn) btn.classList.remove('on');
    } else {
        // close previous
        if (_openCmtPostId) {
            const prev = document.getElementById('cs-cmt-' + _openCmtPostId);
            if (prev) prev.style.display = 'none';
            const prevBtn = document.querySelector(`[data-pid="${_openCmtPostId}"] .cs-cmt-btn`);
            if (prevBtn) prevBtn.classList.remove('on');
        }
        _openCmtPostId = postId;
        _replyInfo = null;
        markPostRead(postId);
        const s = document.getElementById('cs-cmt-' + postId);
        if (s) { s.style.display = 'block'; _renderCmtSection(postId); }
        const btn = document.querySelector(`[data-pid="${postId}"] .cs-cmt-btn`);
        if (btn) btn.classList.add('on');
    }
};

window._mSetReply = function(postId, commentId, authorName) {
    _replyInfo = { commentId, authorName };
    _renderCmtSection(postId);
};
window._mCancelReply = function(postId) {
    _replyInfo = null; _renderCmtSection(postId);
};
window._mShowAllCmt = function(postId) {
    const s = document.getElementById('cs-cmt-' + postId);
    if (s) { s.dataset.showAll = '1'; _renderCmtSection(postId); }
};

window._mSendComment = function(postId) {
    const inp = document.getElementById('cs-ci-' + postId);
    if (!inp) return;
    const text = inp.value.trim();
    if (!text) return;
    const post = momentsData.posts.find(p => p.id === postId);
    if (!post) return;
    post.comments.push({
        id: _mUid('c'), authorType: 'user', text,
        timestamp: Date.now(), isNew: false,
        replyTo: _replyInfo ? { commentId: _replyInfo.commentId, authorName: _replyInfo.authorName } : null
    });
    saveMomentsData();
    inp.value = ''; _replyInfo = null;
    onUserCommented(postId);
    // 更新评论数
    const cc = document.getElementById('cs-cc-' + postId);
    if (cc) cc.textContent = ' ' + post.comments.length;
    const cmtBtn = document.querySelector(`[data-pid="${postId}"] .cs-cmt-btn i`);
    if (cmtBtn) cmtBtn.className = 'fas fa-comment';
    // 重新渲染评论区（不重渲整个 feed）
    _renderCmtSection(postId);
};

// ─────────────────────────────────
//  UI：点赞（用户可以给任何帖子点赞）
// ─────────────────────────────────
window._mToggleLike = function(postId) {
    const p = momentsData.posts.find(p => p.id === postId);
    if (!p) return;
    if (p.type === 'partner') {
        p.userLiked = !p.userLiked;
    } else {
        // 用户自己的帖子也可以点赞
        p.userLiked = !p.userLiked;
    }
    saveMomentsData();
    // 只更新这张卡的点赞按钮，不重渲整个 feed
    const likeOn = p.userLiked || p.partnerLiked;
    const likeCount = (p.partnerLiked ? 1 : 0) + (p.userLiked ? 1 : 0);
    const btn = document.querySelector(`[data-pid="${postId}"] .cs-like-btn`);
    if (btn) {
        btn.className = 'cs-like-btn' + (likeOn ? ' on' : '');
        btn.querySelector('i').className = likeOn ? 'fas fa-heart' : 'far fa-heart';
    }
    const lc = document.getElementById('cs-lc-' + postId);
    if (lc) lc.textContent = likeCount > 0 ? ' ' + likeCount : '';
};

// ─────────────────────────────────
//  UI：删除帖子
// ─────────────────────────────────
window._mDeletePost = function(postId) {
    if (!confirm('确定删除这条动态吗？')) return;
    momentsData.posts = momentsData.posts.filter(p => p.id !== postId);
    if (_openCmtPostId === postId) _openCmtPostId = null;
    saveMomentsData(); _csRenderFeed();
};

// ─────────────────────────────────
//  UI：相识天数
// ─────────────────────────────────
function _updateDaysCounter() {
    const el = document.getElementById('cs-days-num');
    if (!el) return;
    try {
        const list = Array.isArray(anniversaries) ? anniversaries : [];
        const main = list.find(a => a.type === 'anniversary') || list[0];
        if (main && main.date) {
            const diff = Math.floor((Date.now() - new Date(main.date)) / 86400000) + 1;
            if (diff > 0) { el.textContent = diff; return; }
        }
    } catch(e) {}
    el.textContent = '---';
}

// ─────────────────────────────────
//  UI：大头像
// ─────────────────────────────────
function _updateBigAvatars() {
    const ptEl = document.getElementById('cs-bav-partner');
    const meEl = document.getElementById('cs-bav-me');
    if (ptEl) {
        const src = _getAvSrc(true);
        ptEl.innerHTML = src ? `<img src="${src}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">` : '🌸';
    }
    if (meEl) {
        const src = _getAvSrc(false);
        meEl.innerHTML = src ? `<img src="${src}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">` : '🙂';
    }
}

// ─────────────────────────────────
//  UI：主入口
// ─────────────────────────────────
window.openCoupleSpace = window.openMomentsModal = function(scrollToPostId) {
    const page = document.getElementById('couple-space-page');
    if (!page) return;
    page.style.display = 'flex';
    requestAnimationFrame(() => requestAnimationFrame(() => {
        page.classList.add('cs-open');
        _csSetTab('feed');
        _csRenderFeed();
        _updateBigAvatars();
        _updateDaysCounter();
        _updateBadge();
        if (scrollToPostId) setTimeout(() => _csScrollTo(scrollToPostId), 350);
    }));
};

window.closeCoupleSpace = window.closeMomentsModal = function() {
    const page = document.getElementById('couple-space-page');
    if (!page) return;
    page.classList.remove('cs-open');
    // 关闭所有 sheet 和 popup
    window.closeAllCsSheets();
    const np = document.getElementById('cs-notif-popup');
    if (np) np.style.display = 'none';
    setTimeout(() => { page.style.display = 'none'; }, 380);
};

window.csSwitchTab = function(tab) { _csSetTab(tab); if (tab === 'feed') _csRenderFeed(); };

function _csSetTab(tab) {
    document.querySelectorAll('.cs-panel').forEach(p => p.classList.remove('cs-panel-active'));
    const panel = document.getElementById('cs-panel-' + tab);
    if (panel) panel.classList.add('cs-panel-active');
    document.querySelectorAll('.cs-pill').forEach(b => b.classList.remove('cs-pill-on'));
    const btn = document.getElementById('csp-' + tab);
    if (btn) btn.classList.add('cs-pill-on');
}

function _csRenderFeed() {
    const list = document.getElementById('cs-feed-list');
    if (!list) return;
    if (!momentsData.posts.length) {
        list.innerHTML = `<div class="cs-empty"><i class="fas fa-wind"></i><div class="cs-empty-label">还没有动态<br>来发第一条吧~</div></div>`;
        return;
    }
    list.innerHTML = momentsData.posts.map(p => _renderCard(p)).join('');
    _bindLazy(list);
    // 如果有展开的评论区，重新渲染
    if (_openCmtPostId) {
        const s = document.getElementById('cs-cmt-' + _openCmtPostId);
        if (s) { s.style.display = 'block'; _renderCmtSection(_openCmtPostId); }
    }
}

function _csScrollTo(postId) {
    const idx = momentsData.posts.findIndex(p => p.id === postId);
    const panel = document.getElementById('cs-panel-feed');
    if (!panel || idx < 0) return;
    const cards = panel.querySelectorAll('.cs-post');
    if (cards[idx]) cards[idx].scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ─────────────────────────────────
//  UI：发帖 sheet
// ─────────────────────────────────
let _composeImgs = [];

window.openCsCompose = function() {
    _composeImgs = [];
    const ta = document.getElementById('cs-compose-text');
    if (ta) ta.value = '';
    _refreshPreviews();
    _openSheet('cs-compose-sheet');
    setTimeout(() => { const ta = document.getElementById('cs-compose-text'); if(ta) ta.focus(); }, 350);
};
window.closeCsCompose = function() { _closeSheet('cs-compose-sheet'); _composeImgs = []; };

window.onCsImagesSelected = function(input) {
    const files = Array.from(input.files);
    const rem = 6 - _composeImgs.length;
    if (rem <= 0) { alert('最多 6 张'); return; }
    Promise.all(files.slice(0, rem).map(f => optimizeImage(f, 800, 0.75))).then(results => {
        results.forEach(d => _composeImgs.push(d)); _refreshPreviews();
    });
    input.value = '';
};

function _refreshPreviews() {
    const wrap = document.getElementById('cs-compose-previews');
    if (wrap) wrap.innerHTML = _composeImgs.map((d, i) =>
        `<div class="cs-prev-thumb"><img src="${d}"><button class="cs-prev-del" onclick="_mDelImg(${i})">✕</button></div>`
    ).join('');
    const cnt = document.getElementById('cs-image-count');
    if (cnt) cnt.textContent = _composeImgs.length > 0 ? `${_composeImgs.length}/6` : '';
}
window._mDelImg = function(i) { _composeImgs.splice(i, 1); _refreshPreviews(); };

window.submitCsPost = async function() {
    const ta = document.getElementById('cs-compose-text');
    const text = ta ? ta.value.trim() : '';
    if (!text) { if(ta) ta.focus(); return; }
    const btn = document.getElementById('cs-submit-btn');
    if (btn) { btn.disabled = true; btn.textContent = '发布中…'; }
    try {
        let images = [];
        for (const d of _composeImgs) {
            if (window.CloudSync && window.CloudSync.isConnected() && window.CloudMedia) {
                try {
                    const r = await window.CloudMedia.upload(d, 'moments-img');
                    images.push(r && r.url ? r.url : d);
                } catch(e) { images.push(d); }
            } else { images.push(d); }
        }
        const post = {
            id: _mUid('user'), type: 'user',
            text, images, date: _mToday(), timestamp: Date.now(),
            isNewForUser: false, userLiked: false,
            partnerLiked: false, pendingLikeTime: null,
            comments: [], pendingPartnerComment: null, chainProbability: null,
        };
        momentsData.posts.unshift(post);
        saveMomentsData();
        onUserPostCreated(post.id);
        window.closeCsCompose();
        _csRenderFeed();
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '发布'; }
    }
};

// ─────────────────────────────────
//  UI：sheet 控制
// ─────────────────────────────────
function _openSheet(id) {
    const s = document.getElementById(id);
    const o = document.getElementById('cs-overlay');
    if (s) s.classList.add('cs-sheet-open');
    if (o) o.classList.add('cs-overlay-on');
}
function _closeSheet(id) {
    const s = document.getElementById(id);
    if (s) s.classList.remove('cs-sheet-open');
    const anyOpen = document.querySelectorAll('.cs-sheet.cs-sheet-open').length > 0;
    if (!anyOpen) {
        const o = document.getElementById('cs-overlay');
        if (o) o.classList.remove('cs-overlay-on');
    }
}
window.closeAllCsSheets = function() {
    document.querySelectorAll('.cs-sheet').forEach(s => s.classList.remove('cs-sheet-open'));
    const o = document.getElementById('cs-overlay');
    if (o) o.classList.remove('cs-overlay-on');
};

// ─────────────────────────────────
//  通知跳转
// ─────────────────────────────────
window._openMomentsPost = function(postId) {
    window.openCoupleSpace();
    setTimeout(() => {
        _csScrollTo(postId);
        setTimeout(() => _mToggleCmt(postId), 300);
    }, 400);
};

// ─────────────────────────────────
//  暴露
// ─────────────────────────────────
window.loadMomentsData        = loadMomentsData;
window.saveMomentsData        = saveMomentsData;
window.checkMomentsStatus     = checkMomentsStatus;
window.generatePartnerMoment  = generatePartnerMoment;
window.onUserPostCreated      = onUserPostCreated;
window.onUserCommented        = onUserCommented;
window.getMomentsUnreadCount  = getMomentsUnreadCount;
window.markPostRead           = markPostRead;
window._updateMomentsBadge    = _updateBadge;
Object.defineProperty(window, '_momentsData', { get: () => momentsData });
