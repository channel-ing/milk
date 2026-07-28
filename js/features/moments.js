/**
 * moments.js - 动态功能
 * 数据逻辑 + UI 渲染
 *
 * 接入 checklist（已完成）：
 *   1. envelope.js：window._generatePartnerLetter 已暴露 ✓
 *   2. core.js：loadData 里调用 checkMomentsStatus() ✓
 *   3. index.html：script 标签 + 入口按钮 + 弹窗壳 ✓
 */

// ─────────────────────────────────────────────
//  数据结构
// ─────────────────────────────────────────────
let momentsData = { posts: [] };

// Post { id, type:'partner'|'user', text, images:string[],
//         date:'YYYY-MM-DD', timestamp, isNewForUser,
//         userLiked, partnerLiked, pendingLikeTime,
//         comments:Comment[], pendingPartnerComment:{text,time,isSelfComment?},
//         chainProbability:number|null }
// Comment { id, authorType:'partner'|'user', text, timestamp, isNew }

// ─────────────────────────────────────────────
//  常量
// ─────────────────────────────────────────────
const _M_STORAGE_KEY  = 'momentsData';
const _M_COOLDOWN_KEY = 'partnerLetterNextTime';
const _M_CD_MIN       = 48 * 60 * 60 * 1000;
const _M_CD_MAX       = 72 * 60 * 60 * 1000;
const _M_ACTION_PROB  = 0.40;
const _M_DELAY_MIN    = 5  * 60 * 1000;
const _M_DELAY_MAX    = 20 * 60 * 1000;

// ─────────────────────────────────────────────
//  工具
// ─────────────────────────────────────────────
function _mDelay()    { return _M_DELAY_MIN + Math.random() * (_M_DELAY_MAX - _M_DELAY_MIN); }
function _mToday()    { return new Date().toISOString().slice(0, 10); }
function _mUid(p)     { return (p||'id') + '_' + Date.now() + '_' + Math.random().toString(36).substr(2,4); }
function _mName()     { return (typeof settings !== 'undefined' && settings.partnerName) || '梦角'; }
function _mMyName()   { return (typeof settings !== 'undefined' && settings.myName)  || '我'; }

function _mPostText() {
    const pool = [...(window._customReplies || customReplies || [])];
    if (!pool.length) return '想着你呢。';
    const n = 3 + Math.floor(Math.random() * 3);
    let t = '';
    for (let i = 0; i < n; i++) {
        const s = pool[Math.floor(Math.random() * pool.length)];
        const p = Math.random() < 0.2 ? '！' : (Math.random() < 0.2 ? '……' : '。');
        t += s + p;
    }
    return t;
}

function _mPickStickers() {
    if (Math.random() >= 0.40) return [];
    const pool = [...(stickerLibrary || [])];
    if (!pool.length) return [];
    const n = 1 + Math.floor(Math.random() * 3);
    return pool.sort(() => Math.random() - 0.5).slice(0, Math.min(n, pool.length));
}

function _mCommentText() {
    const pool = [...(window._customReplies || customReplies || [])];
    if (!pool.length) return '嗯嗯~';
    return pool[Math.floor(Math.random() * pool.length)];
}

// ─────────────────────────────────────────────
//  存储
// ─────────────────────────────────────────────
async function loadMomentsData() {
    try {
        const saved = await localforage.getItem(getStorageKey(_M_STORAGE_KEY));
        if (saved) momentsData = saved;
    } catch(e) { console.warn('[Moments] load 失败', e); }
}

function saveMomentsData() {
    try { localforage.setItem(getStorageKey(_M_STORAGE_KEY), momentsData); }
    catch(e) { console.warn('[Moments] save 失败', e); }
}

// ─────────────────────────────────────────────
//  通知队列
// ─────────────────────────────────────────────
let _nQueue = [], _nBusy = false;

function _qNotif(type, postId) { _nQueue.push({ type, postId }); _drainNotif(); }

function _drainNotif() {
    if (_nBusy || !_nQueue.length) return;
    _nBusy = true;
    _showNotif(_nQueue.shift());
}

function _showNotif({ type, postId }) {
    const el = document.getElementById('moments-notif-popup');
    if (el) el.remove();
    const name = _mName();
    const C = {
        newPost:   { icon:'📸', title:`${name}发了新动态`,      sub:'快去看看 Ta 的动态~' },
        liked:     { icon:'❤️', title:`${name}为你的动态点了赞`, sub:'' },
        commented: { icon:'💬', title:`${name}评论了你的动态`,   sub:'去看看 Ta 说了什么~' },
        replied:   { icon:'💬', title:`${name}回复了你`,         sub:'去看看 Ta 说了什么~' },
    };
    const c = C[type] || C.newPost;
    const p = document.createElement('div');
    p.id = 'moments-notif-popup';
    p.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:var(--secondary-bg);border:1px solid var(--border-color);border-radius:20px;padding:18px 20px;z-index:8000;max-width:320px;width:88%;box-shadow:0 8px 32px rgba(0,0,0,0.18);display:flex;flex-direction:column;gap:12px;animation:_mSlideUp 0.4s cubic-bezier(0.22,1,0.36,1);';
    p.innerHTML = `
        <style>@keyframes _mSlideUp{from{opacity:0;transform:translateX(-50%) translateY(24px) scale(0.9)}60%{transform:translateX(-50%) translateY(-4px) scale(1.02)}to{opacity:1;transform:translateX(-50%) translateY(0) scale(1)}}</style>
        <div style="display:flex;align-items:center;gap:10px;">
            <span style="font-size:26px;">${c.icon}</span>
            <div>
                <div style="font-size:14px;font-weight:700;color:var(--text-primary);">${c.title}</div>
                ${c.sub ? `<div style="font-size:11px;color:var(--text-secondary);margin-top:2px;opacity:0.8;">${c.sub}</div>` : ''}
            </div>
        </div>
        <div style="display:flex;gap:8px;">
            <button onclick="document.getElementById('moments-notif-popup').remove();window._mNotifDone();" style="flex:1;padding:8px 0;border-radius:12px;border:1px solid var(--border-color);background:var(--primary-bg);color:var(--text-secondary);font-size:13px;cursor:pointer;">稍后查看</button>
            <button onclick="window._openMomentsPost('${postId}');document.getElementById('moments-notif-popup').remove();window._mNotifDone();" style="flex:2;padding:8px 0;border-radius:12px;border:none;background:var(--accent-color);color:#fff;font-size:13px;font-weight:600;cursor:pointer;">立即查看 ✦</button>
        </div>`;
    document.body.appendChild(p);
    setTimeout(() => { if (p.parentNode) { p.remove(); window._mNotifDone(); } }, 8000);
}

window._mNotifDone = function() { _nBusy = false; setTimeout(_drainNotif, 400); };

// ─────────────────────────────────────────────
//  梦角发动态
// ─────────────────────────────────────────────
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
    if (Math.random() < 0.10) {
        post.pendingPartnerComment = { text: _mCommentText(), time: now + Math.floor(_mDelay()), isSelfComment: true };
    }
    momentsData.posts.unshift(post);
    saveMomentsData();
    _qNotif('newPost', post.id);
}

// ─────────────────────────────────────────────
//  用户发帖后钩子
// ─────────────────────────────────────────────
function onUserPostCreated(postId) {
    const post = momentsData.posts.find(p => p.id === postId);
    if (!post || post.type !== 'user') return;
    post.pendingLikeTime = Date.now() + _mDelay();
    if (Math.random() < 0.90) {
        post.pendingPartnerComment = { text: _mCommentText(), time: Date.now() + _mDelay() };
        post.chainProbability = 0.45;
    } else {
        post.chainProbability = null;
    }
    saveMomentsData();
}

// ─────────────────────────────────────────────
//  用户评论后触发链
// ─────────────────────────────────────────────
function onUserCommented(postId) {
    const post = momentsData.posts.find(p => p.id === postId);
    if (!post) return;
    const prob = post.chainProbability;
    if (prob === null || prob < 0.06) { post.chainProbability = null; saveMomentsData(); return; }
    if (Math.random() < prob) {
        post.pendingPartnerComment = { text: _mCommentText(), time: Date.now() + _mDelay() };
        post.chainProbability = prob / 2;
    } else {
        post.chainProbability = null;
    }
    saveMomentsData();
}

// ─────────────────────────────────────────────
//  状态检查
// ─────────────────────────────────────────────
async function checkMomentsStatus() {
    await loadMomentsData();
    const now = Date.now();
    let changed = false;
    for (const post of momentsData.posts) {
        if (post.pendingLikeTime && !post.partnerLiked && now >= post.pendingLikeTime) {
            post.partnerLiked = true; post.pendingLikeTime = null; changed = true;
            _qNotif('liked', post.id);
        }
        if (post.pendingPartnerComment && now >= post.pendingPartnerComment.time) {
            const ppc = post.pendingPartnerComment;
            post.comments.push({ id: _mUid('c'), authorType: 'partner', text: ppc.text, timestamp: ppc.time, isNew: true });
            post.pendingPartnerComment = null; changed = true;
            if (!ppc.isSelfComment) _qNotif(post.type === 'user' ? 'commented' : 'replied', post.id);
        }
    }
    if (changed) { saveMomentsData(); _updateBadge(); }
    await _checkAction();
}

async function _checkAction() {
    try {
        const KEY = getStorageKey(_M_COOLDOWN_KEY);
        const now = Date.now();
        const next = await localforage.getItem(KEY);
        if (next !== null && now < next) return;
        const cd = _M_CD_MIN + Math.random() * (_M_CD_MAX - _M_CD_MIN);
        await localforage.setItem(KEY, now + cd);
        if (Math.random() >= _M_ACTION_PROB) return;
        if (Math.random() < 0.5) {
            if (typeof window._generatePartnerLetter === 'function') window._generatePartnerLetter();
            else console.warn('[Moments] _generatePartnerLetter 未注册');
        } else {
            await generatePartnerMoment();
        }
    } catch(e) { console.warn('[Moments] _checkAction 失败', e); }
}

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible')
        checkMomentsStatus().catch(e => console.warn('[Moments] visibility check 失败', e));
});

// ─────────────────────────────────────────────
//  角标
// ─────────────────────────────────────────────
function getMomentsUnreadCount() {
    let n = 0;
    for (const p of momentsData.posts) {
        if (p.isNewForUser) n++;
        for (const c of p.comments) if (c.authorType === 'partner' && c.isNew) n++;
    }
    return n;
}

function markPostRead(postId) {
    const p = momentsData.posts.find(p => p.id === postId);
    if (!p) return;
    p.isNewForUser = false;
    p.comments.forEach(c => { c.isNew = false; });
    saveMomentsData(); _updateBadge();
}

function _updateBadge() {
    const b = document.getElementById('moments-header-badge');
    if (b) b.style.display = getMomentsUnreadCount() > 0 ? 'inline-block' : 'none';
}

// ─────────────────────────────────────────────
//  UI：当前状态
// ─────────────────────────────────────────────
let _detailPostId = null;
let _composeImages = []; // [{ dataUrl, file }]

// ─────────────────────────────────────────────
//  UI：图片渲染工具
// ─────────────────────────────────────────────
function _mImgEl(src, style) {
    const isCloud = typeof src === 'string' && src.indexOf('oss://') === 0;
    const s = style || 'width:100%;aspect-ratio:1;object-fit:cover;border-radius:8px;cursor:pointer;background:rgba(var(--accent-color-rgb),0.08);';
    if (isCloud) {
        return `<img data-lazy-cloud-ref="${src}" style="${s}" onclick="viewImage('${src}')">`;
    }
    return `<img src="${src}" style="${s}" onclick="viewImage('${src}')">`;
}

function _mBindLazy(el) {
    if (!window.CloudMedia) return;
    el.querySelectorAll('img[data-lazy-cloud-ref]').forEach(img => {
        window.CloudMedia.bindLazyImage(img, img.getAttribute('data-lazy-cloud-ref'));
    });
}

function _mImageGrid(images) {
    if (!images || !images.length) return '';
    const n = images.length;
    const cols = n === 1 ? '1fr' : n === 2 ? '1fr 1fr' : '1fr 1fr 1fr';
    const imgs = images.map(src => `<div style="aspect-ratio:1;overflow:hidden;border-radius:8px;">${_mImgEl(src, 'width:100%;height:100%;object-fit:cover;cursor:pointer;')}</div>`).join('');
    return `<div style="display:grid;grid-template-columns:${cols};gap:3px;padding:0 14px 10px;">${imgs}</div>`;
}

// ─────────────────────────────────────────────
//  UI：帖子卡片（feed & detail 共用）
// ─────────────────────────────────────────────
function _mRenderCard(post, isDetail) {
    const isPartner = post.type === 'partner';
    const avatar = isPartner
        ? (window._avatarCache && window._avatarCache.partner ? `<img src="${window._avatarCache.partner}" style="width:36px;height:36px;border-radius:50%;object-fit:cover;">` : `<div style="width:36px;height:36px;border-radius:50%;background:rgba(var(--accent-color-rgb),0.2);display:flex;align-items:center;justify-content:center;font-size:16px;">🌸</div>`)
        : (window._avatarCache && window._avatarCache.me ? `<img src="${window._avatarCache.me}" style="width:36px;height:36px;border-radius:50%;object-fit:cover;">` : `<div style="width:36px;height:36px;border-radius:50%;background:rgba(var(--accent-color-rgb),0.15);display:flex;align-items:center;justify-content:center;font-size:16px;">🙂</div>`);
    const name = isPartner ? _mName() : _mMyName();
    const MAX_LEN = 120;
    const needsExpand = !isDetail && post.text.length > MAX_LEN;
    const textContent = needsExpand
        ? `<div id="mt-text-${post.id}" style="padding:0 14px 4px;font-size:14px;color:var(--text-primary);line-height:1.65;overflow:hidden;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;">${post.text}</div>
           <button onclick="window._mExpandText('${post.id}')" style="background:none;border:none;color:var(--accent-color);font-size:12px;padding:0 14px 10px;cursor:pointer;">展开全文</button>`
        : `<div style="padding:0 14px 10px;font-size:14px;color:var(--text-primary);line-height:1.65;">${post.text}</div>`;
    const likeCount = (post.partnerLiked ? 1 : 0) + (post.userLiked ? 1 : 0);
    const likeActive = isPartner ? post.userLiked : post.partnerLiked;
    const likeColor = likeActive ? '#ff6b8a' : 'var(--text-secondary)';
    const commentCount = post.comments.filter(c => !c.pendingPartnerComment).length;
    const hasNew = post.isNewForUser || post.comments.some(c => c.authorType === 'partner' && c.isNew);
    return `
        <div style="background:var(--secondary-bg);border:1px solid var(--border-color);border-radius:16px;overflow:hidden;${!isDetail ? 'cursor:pointer;' : ''}" ${!isDetail ? `onclick="window._mOpenDetail('${post.id}')"` : ''}>
            <div style="display:flex;align-items:center;gap:10px;padding:12px 14px 8px;">
                ${avatar}
                <div>
                    <div style="font-size:13px;font-weight:600;color:var(--text-primary);">${name}</div>
                    <div style="font-size:11px;color:var(--text-secondary);">${post.date}</div>
                </div>
                ${hasNew && !isDetail ? '<div style="width:8px;height:8px;background:var(--accent-color);border-radius:50%;margin-left:auto;flex-shrink:0;"></div>' : ''}
            </div>
            ${textContent}
            ${_mImageGrid(post.images)}
            <div style="display:flex;align-items:center;gap:16px;padding:8px 14px 12px;border-top:1px solid var(--border-color);" onclick="event.stopPropagation()">
                <button onclick="window._mToggleLike('${post.id}')" style="background:none;border:none;cursor:pointer;display:flex;align-items:center;gap:5px;font-size:13px;color:${likeColor};padding:4px 0;transition:transform 0.15s;" id="ml-btn-${post.id}">
                    <i class="fas fa-heart"></i>${likeCount > 0 ? ` ${likeCount}` : ''}
                </button>
                <button onclick="window._mOpenDetail('${post.id}')" style="background:none;border:none;cursor:pointer;display:flex;align-items:center;gap:5px;font-size:13px;color:var(--text-secondary);padding:4px 0;">
                    <i class="fas fa-comment"></i>${commentCount > 0 ? ` ${commentCount}` : ' 评论'}
                </button>
            </div>
        </div>`;
}

// ─────────────────────────────────────────────
//  UI：动态列表主弹窗
// ─────────────────────────────────────────────
window.openMomentsModal = function(scrollToPostId) {
    const modal = document.getElementById('moments-modal');
    if (!modal) return;
    showModal(modal);
    _renderFeed();
    _updateBadge();
    if (scrollToPostId) setTimeout(() => _scrollToPost(scrollToPostId), 300);
};

window.closeMomentsModal = function() {
    const modal = document.getElementById('moments-modal');
    if (modal) hideModal(modal);
};

function _renderFeed() {
    const feed = document.getElementById('moments-feed');
    if (!feed) return;
    if (!momentsData.posts.length) {
        feed.innerHTML = `<div style="text-align:center;padding:48px 24px;color:var(--text-secondary);">
            <div style="font-size:40px;margin-bottom:12px;opacity:0.4;">🌿</div>
            <div style="font-size:14px;opacity:0.7;">还没有动态<br>你也可以先发一条~</div>
        </div>`;
        return;
    }
    feed.innerHTML = momentsData.posts.map(p => `<div style="margin-bottom:12px;">${_mRenderCard(p, false)}</div>`).join('');
    _mBindLazy(feed);
}

function _scrollToPost(postId) {
    const feed = document.getElementById('moments-feed');
    if (!feed) return;
    const idx = momentsData.posts.findIndex(p => p.id === postId);
    if (idx < 0) return;
    const cards = feed.querySelectorAll('[style*="margin-bottom"]');
    if (cards[idx]) cards[idx].scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ─────────────────────────────────────────────
//  UI：帖子详情弹窗
// ─────────────────────────────────────────────
window._mOpenDetail = function(postId) {
    _detailPostId = postId;
    markPostRead(postId);
    const modal = document.getElementById('moments-detail-modal');
    if (!modal) return;
    showModal(modal);
    _renderDetail(postId);
};

window.closeMomentsDetail = function() {
    const modal = document.getElementById('moments-detail-modal');
    if (modal) hideModal(modal);
    _detailPostId = null;
    _renderFeed(); // 刷新 feed 的已读状态
};

function _renderDetail(postId) {
    const post = momentsData.posts.find(p => p.id === postId);
    if (!post) return;
    const body = document.getElementById('moments-detail-body');
    if (!body) return;
    const comments = post.comments.map(c => {
        const isPartner = c.authorType === 'partner';
        const cName = isPartner ? _mName() : _mMyName();
        const dot = (isPartner && c.isNew) ? '<span style="width:6px;height:6px;background:var(--accent-color);border-radius:50%;display:inline-block;margin-left:4px;vertical-align:middle;"></span>' : '';
        return `<div style="display:flex;gap:8px;margin-bottom:10px;font-size:13px;align-items:flex-start;">
            <span style="font-weight:600;color:var(--accent-color);flex-shrink:0;">${cName}：</span>
            <span style="color:var(--text-primary);line-height:1.55;">${c.text}${dot}</span>
        </div>`;
    }).join('');
    body.innerHTML = `
        ${_mRenderCard(post, true)}
        <div style="margin-top:14px;">
            <div style="font-size:12px;color:var(--text-secondary);margin-bottom:10px;font-weight:600;">评论 ${post.comments.length}</div>
            ${comments || `<div style="text-align:center;padding:20px;color:var(--text-secondary);font-size:13px;opacity:0.6;">还没有评论，来说点什么~</div>`}
        </div>`;
    _mBindLazy(body);
}

// ─────────────────────────────────────────────
//  UI：点赞
// ─────────────────────────────────────────────
window._mToggleLike = function(postId) {
    const post = momentsData.posts.find(p => p.id === postId);
    if (!post) return;
    if (post.type === 'partner') {
        post.userLiked = !post.userLiked;
    }
    // user帖子的赞是梦角给的，不允许自己点
    saveMomentsData();
    _renderFeed();
    if (_detailPostId === postId) _renderDetail(postId);
};

// ─────────────────────────────────────────────
//  UI：发评论
// ─────────────────────────────────────────────
window.sendMomentsComment = function() {
    const input = document.getElementById('moments-comment-input');
    if (!input) return;
    const text = input.value.trim();
    if (!text || !_detailPostId) return;
    const post = momentsData.posts.find(p => p.id === _detailPostId);
    if (!post) return;
    post.comments.push({ id: _mUid('c'), authorType: 'user', text, timestamp: Date.now(), isNew: false });
    saveMomentsData();
    input.value = '';
    onUserCommented(_detailPostId);
    _renderDetail(_detailPostId);
};

// ─────────────────────────────────────────────
//  UI：展开文字
// ─────────────────────────────────────────────
window._mExpandText = function(postId) {
    const el = document.getElementById('mt-text-' + postId);
    if (!el) return;
    el.style.webkitLineClamp = 'unset';
    el.style.display = 'block';
    el.nextElementSibling && el.nextElementSibling.remove();
};

// ─────────────────────────────────────────────
//  UI：发帖弹窗
// ─────────────────────────────────────────────
window.openMomentsCompose = function() {
    _composeImages = [];
    const modal = document.getElementById('moments-compose-modal');
    if (!modal) return;
    showModal(modal);
    const ta = document.getElementById('moments-compose-text');
    if (ta) { ta.value = ''; ta.focus(); }
    _refreshComposePreviews();
};

window.closeMomentsCompose = function() {
    const modal = document.getElementById('moments-compose-modal');
    if (modal) hideModal(modal);
    _composeImages = [];
};

window.onMomentsImagesSelected = function(input) {
    const files = Array.from(input.files);
    const remaining = 6 - _composeImages.length;
    if (remaining <= 0) { alert('最多添加 6 张图片'); return; }
    const toAdd = files.slice(0, remaining);
    Promise.all(toAdd.map(f => optimizeImage(f, 800, 0.75))).then(results => {
        results.forEach((dataUrl, i) => _composeImages.push({ dataUrl, file: toAdd[i] }));
        _refreshComposePreviews();
    }).catch(e => console.warn('[Moments] 图片处理失败', e));
    input.value = '';
};

function _refreshComposePreviews() {
    const wrap = document.getElementById('moments-compose-previews');
    if (!wrap) return;
    wrap.innerHTML = _composeImages.map((img, i) => `
        <div style="position:relative;width:72px;height:72px;border-radius:10px;overflow:hidden;flex-shrink:0;">
            <img src="${img.dataUrl}" style="width:100%;height:100%;object-fit:cover;">
            <button onclick="window._mRemoveComposeImg(${i})" style="position:absolute;top:2px;right:2px;width:18px;height:18px;border-radius:50%;background:rgba(0,0,0,0.55);border:none;color:#fff;font-size:10px;cursor:pointer;display:flex;align-items:center;justify-content:center;">✕</button>
        </div>`).join('');
    const cnt = document.getElementById('moments-image-count');
    if (cnt) cnt.textContent = _composeImages.length > 0 ? `${_composeImages.length}/6` : '';
}

window._mRemoveComposeImg = function(idx) {
    _composeImages.splice(idx, 1);
    _refreshComposePreviews();
};

window.submitMomentsPost = async function() {
    const ta = document.getElementById('moments-compose-text');
    const text = ta ? ta.value.trim() : '';
    if (!text) { ta && ta.focus(); return; }

    const btn = document.getElementById('moments-submit-btn');
    if (btn) { btn.disabled = true; btn.textContent = '发布中…'; }

    try {
        let images = [];
        // 上传图片（OSS 或本地）
        for (const img of _composeImages) {
            if (window.CloudSync && window.CloudSync.isConnected() && window.CloudMedia) {
                try {
                    const ref = await window.CloudMedia.upload(img.dataUrl, 'moments-img');
                    images.push(ref);
                } catch(e) {
                    console.warn('[Moments] OSS 上传失败，降级本地', e);
                    images.push(img.dataUrl);
                }
            } else {
                images.push(img.dataUrl);
            }
        }

        const now = Date.now();
        const post = {
            id: _mUid('user'), type: 'user',
            text, images, date: _mToday(), timestamp: now,
            isNewForUser: false, userLiked: false,
            partnerLiked: false, pendingLikeTime: null,
            comments: [], pendingPartnerComment: null,
            chainProbability: null,
        };
        momentsData.posts.unshift(post);
        saveMomentsData();
        onUserPostCreated(post.id);
        window.closeMomentsCompose();
        _renderFeed();
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '发布'; }
    }
};

// ─────────────────────────────────────────────
//  跳转（通知用）
// ─────────────────────────────────────────────
window._openMomentsPost = function(postId) {
    window.openMomentsModal();
    setTimeout(() => window._mOpenDetail(postId), 200);
};

// ─────────────────────────────────────────────
//  暴露
// ─────────────────────────────────────────────
window.loadMomentsData       = loadMomentsData;
window.saveMomentsData       = saveMomentsData;
window.checkMomentsStatus    = checkMomentsStatus;
window.generatePartnerMoment = generatePartnerMoment;
window.onUserPostCreated     = onUserPostCreated;
window.onUserCommented       = onUserCommented;
window.getMomentsUnreadCount = getMomentsUnreadCount;
window.markPostRead          = markPostRead;
window._updateMomentsBadge   = _updateBadge;
Object.defineProperty(window, '_momentsData', { get: () => momentsData });
