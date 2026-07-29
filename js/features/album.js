/**
 * album.js — 情侣空间：相册
 *
 * 数据结构：
 *   albumData = {
 *     albums: [ { id, name, isSystem, systemType, createdAt } ],
 *     photos:  [ { id, albumId, src, date, timestamp,
 *                  isFavorite, deletedAt, sourcePostId,
 *                  isVideo, videoSrc } ]
 *   }
 * systemType: 'moments' | 'favorites'
 *
 * 删除逻辑：
 *   - 动态/自建相册：软删除进回收站，30天自动清理
 *   - 收藏相册：取消收藏（硬删除收藏记录，原图 isFavorite→false）
 *   - 跨相册独立：从动态删不影响收藏里的副本
 */

let albumData = { albums: [], photos: [] };

const _AL_KEY       = 'albumData';
const _AL_TRASH_TTL = 30 * 24 * 60 * 60 * 1000;
const _alUid  = (p) => (p||'al') + '_' + Date.now() + '_' + Math.random().toString(36).substr(2,4);
const _alToday = () => new Date().toISOString().slice(0,10);

const _SYS_MOMENTS_ID   = '__sys_moments__';
const _SYS_FAVORITES_ID = '__sys_favorites__';

// 状态（暴露到 window 供 HTML onclick 访问）
window._alCurrentAlbumId = null;
window._alCurrentPhotoId = null;
let _alView        = 'list';
let _alSelectMode  = false;
let _alSelectedIds = new Set();

// ─── 系统相册初始化 ───
function _ensureSystemAlbums() {
    if (!albumData.albums.find(a => a.id === _SYS_MOMENTS_ID))
        albumData.albums.unshift({ id:_SYS_MOMENTS_ID, name:'动态', isSystem:true, systemType:'moments', createdAt:0 });
    if (!albumData.albums.find(a => a.id === _SYS_FAVORITES_ID))
        albumData.albums.splice(1, 0, { id:_SYS_FAVORITES_ID, name:'收藏', isSystem:true, systemType:'favorites', createdAt:0 });
}

// ─── 持久化 ───
async function loadAlbumData() {
    try {
        const s = await localforage.getItem(getStorageKey(_AL_KEY));
        if (s) { albumData = s; if (!albumData.photos) albumData.photos=[]; if (!albumData.albums) albumData.albums=[]; }
    } catch(e) { console.warn('[Album] load 失败', e); }
    _ensureSystemAlbums();
    _cleanTrash();
}
async function saveAlbumData() {
    try { await localforage.setItem(getStorageKey(_AL_KEY), albumData); } catch(e) { console.warn('[Album] save 失败', e); }
}
function _cleanTrash() {
    const n = albumData.photos.length;
    albumData.photos = albumData.photos.filter(p => !p.deletedAt || (Date.now()-p.deletedAt) < _AL_TRASH_TTL);
    if (albumData.photos.length !== n) saveAlbumData();
}

// ─── 动态同步（moments.js 发帖后调用） ───
window._albumSyncMomentsPost = function(postId, images, videoSrc, videoCover) {
    let changed = false;
    if (images && images.length) {
        images.forEach(src => {
            if (!src || src.indexOf('oss://') !== 0) return; // 只同步 OSS 引用
            albumData.photos.push({ id:_alUid('p'), albumId:_SYS_MOMENTS_ID, src,
                date:_alToday(), timestamp:Date.now(), isFavorite:false, deletedAt:null,
                sourcePostId:postId, isVideo:false, videoSrc:null });
            changed = true;
        });
    }
    if (videoSrc && videoSrc.indexOf('oss://') === 0) {
        albumData.photos.push({ id:_alUid('p'), albumId:_SYS_MOMENTS_ID,
            src: (videoCover && videoCover.indexOf('oss://') === 0) ? videoCover : null,
            date:_alToday(), timestamp:Date.now(), isFavorite:false, deletedAt:null,
            sourcePostId:postId, isVideo:true, videoSrc });
        changed = true;
    }
    if (changed) saveAlbumData();
};

// ─── 收藏 toggle ───
function _alToggleFavorite(photoId) {
    const photo = albumData.photos.find(p => p.id === photoId); if (!photo) return;
    photo.isFavorite = !photo.isFavorite;
    if (photo.isFavorite) {
        const exists = albumData.photos.some(p => p.albumId===_SYS_FAVORITES_ID && p.src===photo.src && !p.deletedAt);
        if (!exists) albumData.photos.push({
            id:_alUid('fav'), albumId:_SYS_FAVORITES_ID, src:photo.src,
            date:photo.date, timestamp:Date.now(), isFavorite:true, deletedAt:null,
            sourcePostId:photo.sourcePostId||null, isVideo:photo.isVideo||false, videoSrc:photo.videoSrc||null
        });
    } else {
        albumData.photos.filter(p => p.albumId===_SYS_FAVORITES_ID && p.src===photo.src && !p.deletedAt)
            .forEach(p => { p.deletedAt = Date.now(); });
    }
    saveAlbumData();
    _alUpdateDetailFav(photo);
}

function _alUpdateDetailFav(photo) {
    const btn = document.getElementById('al-detail-fav'); if (!btn) return;
    btn.className = 'al-detail-fav' + (photo.isFavorite ? ' on' : '');
    btn.innerHTML = `<i class="${photo.isFavorite?'fas':'far'} fa-heart"></i>`;
}

// ─── 工具 ───
function _alImgEl(src, style) {
    if (!src) return '<div class="al-cell-empty"><i class="fas fa-film"></i></div>';
    const s = style || 'width:100%;height:100%;object-fit:cover;display:block;';
    return src.indexOf('oss://') === 0
        ? `<img data-lazy-cloud-ref="${src}" style="${s}">`
        : `<img src="${src}" style="${s}">`;
}
function _alVideoCell(photo) {
    return `${_alImgEl(photo.src)}<div class="al-cell-play"><i class="fas fa-play"></i></div>`;
}
function _alBindLazy(el) {
    if (!window.CloudMedia || !el) return;
    el.querySelectorAll('img[data-lazy-cloud-ref]').forEach(img =>
        window.CloudMedia.bindLazyImage(img, img.getAttribute('data-lazy-cloud-ref')));
}
function _alFmtDate(d) {
    if (!d) return '';
    const today = _alToday(), yest = new Date(Date.now()-86400000).toISOString().slice(0,10);
    if (d === today) return '今天';
    if (d === yest)  return '昨天';
    const dt = new Date(d), now = new Date();
    return dt.getFullYear()===now.getFullYear()
        ? `${dt.getMonth()+1}月${dt.getDate()}日`
        : `${dt.getFullYear()}年${dt.getMonth()+1}月${dt.getDate()}日`;
}

// ─── OSS 未连接缺省页 ───
function _alRenderNoOss() {
    const wrap = document.getElementById('al-list-grid'); if (!wrap) return;
    wrap.innerHTML = `
        <div class="al-no-oss">
            <div class="al-no-oss-icon"><i class="fas fa-cloud-slash"></i></div>
            <div class="al-no-oss-title">相册暂不可用</div>
            <div class="al-no-oss-desc">
                相册依赖云端存储来保存图片。<br>
                直接存在本地的话，大量图片会撑爆内存导致页面崩溃，所以没有配置云存储就没办法用相册功能。
            </div>
            <div class="al-no-oss-path">
                <i class="fas fa-route"></i>
                右上角 ⚙️ 设置 → 数据管理 → 阿里云 OSS
            </div>
            <button class="al-no-oss-btn" onclick="window._alGoOssConfig()">去配置</button>
        </div>`;
    _alShowView('list');
}
window._alGoOssConfig = function() {
    // 先关闭情侣空间，再打开设置→数据管理
    if (typeof closeCoupleSpace === 'function') closeCoupleSpace();
    setTimeout(() => {
        const settingsModal = document.getElementById('settings-modal');
        if (settingsModal && typeof showModal === 'function') {
            showModal(settingsModal);
            setTimeout(() => { document.getElementById('data-settings')?.click(); }, 350);
        }
    }, 300);
};

// ─── 渲染：相册列表 ───
function _alRenderList() {
    _alView = 'list';
    window._alCurrentAlbumId = null;
    window._alCurrentPhotoId = null;
    _alSelectMode = false; _alSelectedIds.clear();
    _alSetSubTab('albums');

    const active = albumData.photos.filter(p => !p.deletedAt);
    const cover  = (id) => { const arr = active.filter(p=>p.albumId===id); return arr.length ? arr[arr.length-1].src : null; };
    const cnt    = (id) => active.filter(p=>p.albumId===id).length;

    const allAlbums = [
        ...albumData.albums.filter(a=>a.isSystem),
        ...albumData.albums.filter(a=>!a.isSystem)
    ];

    let html = `<div class="al-album-card al-new-card" onclick="window._alCreateAlbum()">
        <div class="al-cover al-new-cover"><i class="fas fa-plus al-new-plus"></i></div>
        <div class="al-album-info"><span class="al-album-name">新建相册</span></div>
    </div>`;

    allAlbums.forEach(album => {
        const c = cover(album.id), n = cnt(album.id);
        const coverHtml = c ? _alImgEl(c, 'width:100%;height:100%;object-fit:cover;display:block;')
                            : `<div class="al-cover-empty"><i class="fas fa-images"></i></div>`;
        const lock = album.isSystem ? '<i class="fas fa-lock al-sys-lock"></i>' : '';
        const cntHtml = n > 0 ? `<span class="al-album-cnt">${n}张</span>` : '';
        html += `<div class="al-album-card" onclick="window._alOpenAlbum('${album.id}')">
            <div class="al-cover">${coverHtml}</div>
            <div class="al-album-info">${lock}<span class="al-album-name">${album.name}</span>${cntHtml}</div>
        </div>`;
    });

    const grid = document.getElementById('al-list-grid'); if (!grid) return;
    grid.innerHTML = html;
    _alBindLazy(grid);
    _alShowView('list');
}

// ─── 渲染：图片网格 ───
function _alRenderGrid(albumId) {
    _alView = 'grid';
    window._alCurrentAlbumId = albumId;
    _alSelectMode = false; _alSelectedIds.clear();

    const album = albumData.albums.find(a => a.id === albumId); if (!album) return;
    const isMoments   = albumId === _SYS_MOMENTS_ID;
    const isFavorites = albumId === _SYS_FAVORITES_ID;
    const isSys = isMoments || isFavorites;

    const titleEl = document.getElementById('al-grid-title');
    if (titleEl) titleEl.textContent = album.name;

    // 上传按钮：系统相册隐藏
    const uploadBtn = document.getElementById('al-upload-btn');
    if (uploadBtn) uploadBtn.style.display = isSys ? 'none' : 'flex';
    // 选择按钮显示
    const selBtn = document.getElementById('al-sel-btn');
    if (selBtn) selBtn.style.display = 'flex';
    // 选择栏隐藏
    const selBar = document.getElementById('al-select-bar');
    if (selBar) selBar.style.display = 'none';

    const photos = albumData.photos
        .filter(p => p.albumId === albumId && !p.deletedAt)
        .sort((a,b) => b.timestamp - a.timestamp);

    const groups = {};
    photos.forEach(p => { if (!groups[p.date]) groups[p.date]=[]; groups[p.date].push(p); });
    const dates = Object.keys(groups).sort((a,b) => b.localeCompare(a));

    let html = '';
    if (!dates.length) {
        html = `<div class="al-empty"><i class="fas fa-images"></i><div>还没有照片</div></div>`;
    } else {
        dates.forEach(date => {
            html += `<div class="al-date-label">${_alFmtDate(date)}</div><div class="al-photo-grid">`;
            groups[date].forEach(p => {
                const inner = p.isVideo ? _alVideoCell(p) : _alImgEl(p.src);
                html += `<div class="al-photo-cell" data-id="${p.id}" onclick="_alCellClick('${p.id}','${albumId}')">${inner}</div>`;
            });
            html += `</div>`;
        });
    }

    const body = document.getElementById('al-grid-body'); if (!body) return;
    body.innerHTML = html;
    _alBindLazy(body);
    _alShowView('grid');
}

// 单元格点击：选择模式 or 打开详情
function _alCellClick(photoId, albumId) {
    if (_alSelectMode) {
        _alToggleSelectCell(photoId);
    } else {
        window._alCurrentAlbumId = albumId;
        _alRenderDetail(photoId);
    }
}
window._alCellClick = _alCellClick;

// ─── 批量选择 ───
window._alToggleSelectMode = function() {
    _alSelectMode = !_alSelectMode;
    _alSelectedIds.clear();
    const selBtn = document.getElementById('al-sel-btn');
    const selBar = document.getElementById('al-select-bar');
    const uploadBtn = document.getElementById('al-upload-btn');
    if (selBtn)    selBtn.textContent = _alSelectMode ? '取消' : '选择';
    if (selBar)    selBar.style.display = _alSelectMode ? 'flex' : 'none';
    if (uploadBtn && window._alCurrentAlbumId !== _SYS_MOMENTS_ID && window._alCurrentAlbumId !== _SYS_FAVORITES_ID)
        uploadBtn.style.display = _alSelectMode ? 'none' : 'flex';
    document.querySelectorAll('.al-photo-cell').forEach(c => c.classList.remove('selected'));
    _alUpdateSelBar();
};

function _alToggleSelectCell(photoId) {
    if (_alSelectedIds.has(photoId)) _alSelectedIds.delete(photoId);
    else _alSelectedIds.add(photoId);
    const cell = document.querySelector(`.al-photo-cell[data-id="${photoId}"]`);
    if (cell) cell.classList.toggle('selected', _alSelectedIds.has(photoId));
    _alUpdateSelBar();
}

function _alUpdateSelBar() {
    const cnt = document.getElementById('al-sel-count');
    const del = document.getElementById('al-sel-del');
    const all = document.getElementById('al-sel-all');
    const n = _alSelectedIds.size;
    if (cnt) cnt.textContent = n > 0 ? `已选 ${n} 张` : '点击照片选择';
    if (del) del.disabled = n === 0;
    // 全选状态
    const total = albumData.photos.filter(p => p.albumId===window._alCurrentAlbumId && !p.deletedAt).length;
    if (all) all.textContent = _alSelectedIds.size === total ? '取消全选' : '全选';
}

window._alSelectAll = function() {
    const photos = albumData.photos.filter(p => p.albumId===window._alCurrentAlbumId && !p.deletedAt);
    const allSelected = _alSelectedIds.size === photos.length;
    _alSelectedIds.clear();
    if (!allSelected) photos.forEach(p => _alSelectedIds.add(p.id));
    document.querySelectorAll('.al-photo-cell').forEach(c => {
        const id = c.dataset.id;
        c.classList.toggle('selected', _alSelectedIds.has(id));
    });
    _alUpdateSelBar();
};

window._alDeleteSelected = function() {
    if (!_alSelectedIds.size) return;
    const isFav = window._alCurrentAlbumId === _SYS_FAVORITES_ID;
    const action = isFav ? '取消收藏' : '删除';
    if (!confirm(`确定${action}已选的 ${_alSelectedIds.size} 张照片？`)) return;
    _alSelectedIds.forEach(id => {
        const photo = albumData.photos.find(p => p.id === id); if (!photo) return;
        if (isFav) {
            // 收藏相册：硬删除 + 原图 isFavorite→false
            albumData.photos = albumData.photos.filter(p => p.id !== id);
            albumData.photos.filter(p => p.src === photo.src && !p.deletedAt)
                .forEach(p => { p.isFavorite = false; });
        } else {
            photo.deletedAt = Date.now();
        }
    });
    saveAlbumData();
    _alSelectMode = false; _alSelectedIds.clear();
    _alRenderGrid(window._alCurrentAlbumId);
};

// ─── 渲染：图片详情（全屏 fixed overlay） ───
function _alRenderDetail(photoId) {
    _alView = 'detail';
    window._alCurrentPhotoId = photoId;
    const photo = albumData.photos.find(p => p.id === photoId); if (!photo) return;

    const isFav = window._alCurrentAlbumId === _SYS_FAVORITES_ID;

    // 大图 or 视频
    const mainArea = document.getElementById('al-detail-main');
    if (mainArea) {
        if (photo.isVideo && photo.videoSrc) {
            // 视频：点击打开播放器
            const cover = photo.src;
            mainArea.innerHTML = `<div class="al-detail-video-thumb" onclick="window.openCsVideoPlayer('${photo.videoSrc}')">
                ${cover ? _alImgEl(cover, 'width:100%;height:100%;object-fit:contain;') : '<div class="al-cell-empty al-detail-empty"><i class="fas fa-film"></i></div>'}
                <div class="al-detail-play"><i class="fas fa-play"></i></div>
            </div>`;
            _alBindLazy(mainArea);
        } else {
            const src = photo.src || '';
            let imgTag;
            if (src.indexOf('oss://') === 0 && window.CloudMedia) {
                imgTag = `<img id="al-detail-img" class="al-detail-img" src="">`;
                mainArea.innerHTML = imgTag;
                window.CloudMedia.fetchUrl(src)
                    .then(url => { const el=document.getElementById('al-detail-img'); if(el) el.src=url; })
                    .catch(() => { const el=document.getElementById('al-detail-img'); if(el) el.src=src; });
            } else {
                imgTag = `<img id="al-detail-img" class="al-detail-img" src="${src}">`;
                mainArea.innerHTML = imgTag;
            }
        }
    }

    // 日期
    const dateEl = document.getElementById('al-detail-date');
    if (dateEl) dateEl.textContent = _alFmtDate(photo.date);

    // 收藏按钮
    const favBtn = document.getElementById('al-detail-fav');
    if (favBtn) {
        favBtn.style.display = isFav ? 'none' : 'flex'; // 收藏相册里已经是收藏，用取消收藏操作代替
        _alUpdateDetailFav(photo);
    }

    // 删除按钮文案（收藏相册显示「取消收藏」图标）
    const delBtn = document.getElementById('al-detail-del');
    if (delBtn) {
        delBtn.title = isFav ? '取消收藏' : '删除';
        delBtn.innerHTML = isFav ? '<i class="fas fa-heart-broken"></i>' : '<i class="fas fa-trash-alt"></i>';
    }

    // 缩略图条
    const strip = document.getElementById('al-detail-strip');
    if (strip && window._alCurrentAlbumId) {
        const siblings = albumData.photos
            .filter(p => p.albumId===window._alCurrentAlbumId && !p.deletedAt)
            .sort((a,b) => b.timestamp - a.timestamp);
        strip.innerHTML = siblings.map(p => `
            <div class="al-strip-thumb${p.id===photoId?' active':''}" onclick="window._alOpenDetail('${p.id}','${window._alCurrentAlbumId}')">
                ${_alImgEl(p.src, 'width:100%;height:100%;object-fit:cover;')}
                ${p.isVideo ? '<div class="al-strip-play"><i class="fas fa-play"></i></div>' : ''}
            </div>`).join('');
        _alBindLazy(strip);
        const active = strip.querySelector('.al-strip-thumb.active');
        if (active) setTimeout(() => active.scrollIntoView({inline:'center',behavior:'smooth'}), 100);
    }

    _alShowView('detail');
}

// ─── 左右滑切换 ───
let _alSwipeX = 0;
window._alSwipeStart = function(e) { _alSwipeX = e.touches?e.touches[0].clientX:e.clientX; };
window._alSwipeEnd   = function(e) {
    const dx = (e.changedTouches?e.changedTouches[0].clientX:e.clientX) - _alSwipeX;
    if (Math.abs(dx) < 50) return;
    const albumId = window._alCurrentAlbumId; if (!albumId) return;
    const siblings = albumData.photos.filter(p=>p.albumId===albumId&&!p.deletedAt).sort((a,b)=>b.timestamp-a.timestamp);
    const idx = siblings.findIndex(p=>p.id===window._alCurrentPhotoId);
    if (dx < 0 && idx < siblings.length-1) _alOpenDetail(siblings[idx+1].id, albumId);
    if (dx > 0 && idx > 0)                 _alOpenDetail(siblings[idx-1].id, albumId);
};

// ─── 回收站 ───
function _alRenderTrash() {
    _alView = 'trash';
    const trashed = albumData.photos.filter(p=>p.deletedAt).sort((a,b)=>b.deletedAt-a.deletedAt);
    let html = '';
    if (!trashed.length) {
        html = `<div class="al-empty"><i class="fas fa-trash"></i><div>回收站是空的</div></div>`;
    } else {
        html += `<div class="al-trash-tip">照片将在删除后 30 天自动清除</div><div class="al-photo-grid al-trash-grid">`;
        trashed.forEach(p => {
            const d = Math.ceil((_AL_TRASH_TTL-(Date.now()-p.deletedAt))/86400000);
            html += `<div class="al-photo-cell al-trash-cell">
                ${_alImgEl(p.src)}
                ${p.isVideo ? '<div class="al-cell-play"><i class="fas fa-play"></i></div>' : ''}
                <div class="al-trash-days">${d}天</div>
                <div class="al-trash-actions">
                    <button onclick="window._alRestore('${p.id}')"><i class="fas fa-undo"></i></button>
                    <button onclick="window._alPermDelete('${p.id}')"><i class="fas fa-times"></i></button>
                </div>
            </div>`;
        });
        html += `</div>`;
    }
    const body = document.getElementById('al-trash-body'); if (!body) return;
    body.innerHTML = html;
    _alBindLazy(body);
}

// ─── 视图切换 ───
function _alShowView(view) {
    ['list','grid','trash'].forEach(v => {
        const el = document.getElementById('al-view-'+v);
        if (el) el.style.display = v===view ? 'flex' : 'none';
    });
    // detail 是 fixed overlay，单独控制
    const det = document.getElementById('al-view-detail');
    if (det) det.style.display = view==='detail' ? 'flex' : 'none';
}
function _alSetSubTab(tab) {
    document.querySelectorAll('.al-subtab').forEach(b=>b.classList.remove('on'));
    const btn = document.getElementById('al-st-'+tab); if (btn) btn.classList.add('on');
}

// ─── 对外 API ───
window._alOpenAlbum = function(albumId) { _alRenderGrid(albumId); };

window._alOpenDetail = _alOpenDetail;
function _alOpenDetail(photoId, albumId) {
    window._alCurrentAlbumId = albumId;
    _alRenderDetail(photoId);
}

window._alBackToList = function() { _alRenderList(); };
window._alBackToGrid = function() {
    if (window._alCurrentAlbumId) _alRenderGrid(window._alCurrentAlbumId);
    else _alRenderList();
};

window._alToggleFav = function(photoId) { _alToggleFavorite(photoId); };

window._alDeletePhoto = function(photoId) {
    const photo = albumData.photos.find(p=>p.id===photoId); if (!photo) return;
    const isFav = window._alCurrentAlbumId === _SYS_FAVORITES_ID;
    if (isFav) {
        if (!confirm('取消收藏这张照片？')) return;
        albumData.photos = albumData.photos.filter(p=>p.id!==photoId);
        albumData.photos.filter(p=>p.src===photo.src&&!p.deletedAt).forEach(p=>{p.isFavorite=false;});
    } else {
        if (!confirm('删除后可在回收站找回，确定删除吗？')) return;
        photo.deletedAt = Date.now();
    }
    saveAlbumData();
    window._alBackToGrid();
};

window._alRestore    = function(id) { const p=albumData.photos.find(x=>x.id===id); if(p){p.deletedAt=null;saveAlbumData();_alRenderTrash();} };
window._alPermDelete = function(id) { if(!confirm('永久删除后无法恢复，确定吗？'))return; albumData.photos=albumData.photos.filter(x=>x.id!==id); saveAlbumData();_alRenderTrash(); };

window._alCreateAlbum = function() {
    const name = prompt('相册名称：'); if (!name||!name.trim()) return;
    albumData.albums.push({ id:_alUid('alb'), name:name.trim(), isSystem:false, createdAt:Date.now() });
    saveAlbumData(); _alRenderList();
};

window._alUploadToAlbum = function(albumId, input) {
    if (!albumId) return;
    const files = Array.from(input.files); if (!files.length) return;
    Promise.all(files.map(f=>optimizeImage(f,1200,0.85))).then(async results => {
        for (const b64 of results) {
            let src = b64;
            if (window.CloudSync&&window.CloudSync.isConnected()&&window.CloudMedia) {
                try { const r=await window.CloudMedia.upload(b64,'album-img'); src=r&&r.url?r.url:b64; } catch(e){}
            }
            albumData.photos.push({ id:_alUid('p'), albumId, src, date:_alToday(), timestamp:Date.now(),
                isFavorite:false, deletedAt:null, sourcePostId:null, isVideo:false, videoSrc:null });
        }
        saveAlbumData(); _alRenderGrid(albumId);
    });
    input.value='';
};

window._alOpenTrash = function() {
    _alView='trash'; _alSetSubTab('trash'); _alRenderTrash(); _alShowView('trash');
};

// ─── 主入口 ───
window._alInit = async function() {
    await loadAlbumData();
    if (!window.CloudSync || !window.CloudSync.isConnected()) {
        _alRenderNoOss();
        return;
    }
    _alRenderList();
};

// swipe 绑定
document.addEventListener('DOMContentLoaded', () => {
    const det = document.getElementById('al-view-detail');
    if (det) {
        det.addEventListener('touchstart', window._alSwipeStart, { passive:true });
        det.addEventListener('touchend',   window._alSwipeEnd,   { passive:true });
    }
});
