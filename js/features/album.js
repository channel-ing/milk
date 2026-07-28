/**
 * album.js — 情侣空间：相册功能
 * 数据结构：
 *   albumData = {
 *     albums: [ { id, name, isSystem, systemType, createdAt } ],
 *     photos:  [ { id, albumId, src, date, timestamp, isFavorite, deletedAt, sourcePostId } ]
 *   }
 * systemType: 'moments' | 'favorites'
 */

let albumData = { albums: [], photos: [] };

const _AL_KEY       = 'albumData';
const _AL_TRASH_TTL = 30 * 24 * 60 * 60 * 1000; // 30天
const _alUid = (p) => (p||'al') + '_' + Date.now() + '_' + Math.random().toString(36).substr(2,4);
const _alToday = () => new Date().toISOString().slice(0,10);

// ─── 系统相册 ID（固定） ───
const _SYS_MOMENTS_ID   = '__sys_moments__';
const _SYS_FAVORITES_ID = '__sys_favorites__';

function _ensureSystemAlbums() {
    if (!albumData.albums.find(a => a.id === _SYS_MOMENTS_ID)) {
        albumData.albums.unshift({ id: _SYS_MOMENTS_ID,   name: '动态',   isSystem: true, systemType: 'moments',   createdAt: 0 });
    }
    if (!albumData.albums.find(a => a.id === _SYS_FAVORITES_ID)) {
        albumData.albums.splice(1, 0, { id: _SYS_FAVORITES_ID, name: '收藏', isSystem: true, systemType: 'favorites', createdAt: 0 });
    }
}

// ─── 持久化 ───
async function loadAlbumData() {
    try {
        const s = await localforage.getItem(getStorageKey(_AL_KEY));
        if (s) { albumData = s; if (!albumData.photos) albumData.photos = []; if (!albumData.albums) albumData.albums = []; }
    } catch(e) { console.warn('[Album] load 失败', e); }
    _ensureSystemAlbums();
    _cleanTrash();
}
async function saveAlbumData() {
    try { await localforage.setItem(getStorageKey(_AL_KEY), albumData); } catch(e) { console.warn('[Album] save 失败', e); }
}

// ─── 回收站清理（超过30天自动删除） ───
function _cleanTrash() {
    const now = Date.now();
    const before = albumData.photos.length;
    albumData.photos = albumData.photos.filter(p => !p.deletedAt || (now - p.deletedAt) < _AL_TRASH_TTL);
    if (albumData.photos.length !== before) saveAlbumData();
}

// ─── 动态图片同步（moments.js 发帖后调用） ───
window._albumSyncMomentsPost = function(postId, images) {
    if (!images || !images.length) return;
    images.forEach(src => {
        if (!src) return;
        albumData.photos.push({
            id: _alUid('p'),
            albumId: _SYS_MOMENTS_ID,
            src,
            date: _alToday(),
            timestamp: Date.now(),
            isFavorite: false,
            deletedAt: null,
            sourcePostId: postId
        });
    });
    saveAlbumData();
};

// ─── 收藏 toggle ───
function _alToggleFavorite(photoId) {
    const photo = albumData.photos.find(p => p.id === photoId);
    if (!photo) return;
    photo.isFavorite = !photo.isFavorite;

    if (photo.isFavorite) {
        // 检查收藏相册里是否已有同src的（防重）
        const exists = albumData.photos.some(p => p.albumId === _SYS_FAVORITES_ID && p.src === photo.src && !p.deletedAt);
        if (!exists) {
            albumData.photos.push({
                id: _alUid('fav'),
                albumId: _SYS_FAVORITES_ID,
                src: photo.src,
                date: photo.date,
                timestamp: Date.now(),
                isFavorite: true,
                deletedAt: null,
                sourcePostId: photo.sourcePostId || null
            });
        }
    } else {
        // 取消收藏：从收藏相册里软删同src的记录
        albumData.photos.filter(p => p.albumId === _SYS_FAVORITES_ID && p.src === photo.src && !p.deletedAt)
            .forEach(p => { p.deletedAt = Date.now(); });
    }
    saveAlbumData();
    _alRenderDetail(photoId); // 刷新详情页心形
}

// ─── 工具 ───
function _alImgEl(src, style) {
    if (!src) return '';
    const isCloud = src.indexOf('oss://') === 0;
    const s = style || 'width:100%;height:100%;object-fit:cover;';
    return isCloud
        ? `<img data-lazy-cloud-ref="${src}" style="${s}">`
        : `<img src="${src}" style="${s}">`;
}
function _alBindLazy(el) {
    if (!window.CloudMedia || !el) return;
    el.querySelectorAll('img[data-lazy-cloud-ref]').forEach(img =>
        window.CloudMedia.bindLazyImage(img, img.getAttribute('data-lazy-cloud-ref'))
    );
}
function _alFmtDate(dateStr) {
    if (!dateStr) return '';
    const today = _alToday();
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0,10);
    if (dateStr === today) return '今天';
    if (dateStr === yesterday) return '昨天';
    const d = new Date(dateStr), now = new Date();
    return d.getFullYear() === now.getFullYear()
        ? `${d.getMonth()+1}月${d.getDate()}日`
        : `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日`;
}

// ─── 页面状态 ───
let _alView = 'list';          // 'list' | 'grid' | 'detail' | 'trash'
let _alCurrentAlbumId = null;
let _alCurrentPhotoId = null;

// ─── 渲染：相册列表 ───
function _alRenderList() {
    _alView = 'list'; _alCurrentAlbumId = null; _alCurrentPhotoId = null;
    const panel = document.getElementById('cs-panel-album'); if (!panel) return;

    // 子tab切到相册
    _alSetSubTab('albums');

    const activePhotos = albumData.photos.filter(p => !p.deletedAt);

    function albumCover(albumId) {
        const photos = activePhotos.filter(p => p.albumId === albumId);
        if (!photos.length) return null;
        return photos[photos.length - 1].src; // 最新一张
    }
    function albumCount(albumId) {
        return activePhotos.filter(p => p.albumId === albumId).length;
    }

    const userAlbums = albumData.albums.filter(a => !a.isSystem);
    const sysAlbums  = albumData.albums.filter(a => a.isSystem);
    const allAlbums  = [...sysAlbums, ...userAlbums];

    let cards = `<div class="al-album-card al-new-card" onclick="window._alCreateAlbum()">
        <div class="al-new-icon"><i class="fas fa-plus"></i></div>
        <div class="al-album-name">新建相册</div>
    </div>`;

    allAlbums.forEach(album => {
        const cover = albumCover(album.id);
        const cnt   = albumCount(album.id);
        const coverHtml = cover ? _alImgEl(cover, 'width:100%;height:100%;object-fit:cover;') : `<div class="al-cover-empty"><i class="fas fa-images"></i></div>`;
        const lockIcon  = album.isSystem ? '<i class="fas fa-lock al-sys-lock"></i>' : '';
        cards += `<div class="al-album-card" onclick="window._alOpenAlbum('${album.id}')">
            <div class="al-cover">${coverHtml}</div>
            <div class="al-album-info">${lockIcon}<span class="al-album-name">${album.name}</span>${cnt > 0 ? `<span class="al-album-cnt">${cnt}张</span>` : ''}</div>
        </div>`;
    });

    document.getElementById('al-list-grid').innerHTML = cards;
    _alBindLazy(document.getElementById('al-list-grid'));
}

// ─── 渲染：图片网格 ───
function _alRenderGrid(albumId) {
    _alView = 'grid'; _alCurrentAlbumId = albumId;
    const album = albumData.albums.find(a => a.id === albumId);
    if (!album) return;

    const photos = albumData.photos
        .filter(p => p.albumId === albumId && !p.deletedAt)
        .sort((a, b) => b.timestamp - a.timestamp);

    // 顶部标题
    document.getElementById('al-grid-title').textContent = album.name;

    // 按日期分组
    const groups = {};
    photos.forEach(p => { if (!groups[p.date]) groups[p.date] = []; groups[p.date].push(p); });
    const sortedDates = Object.keys(groups).sort((a,b) => b.localeCompare(a));

    let html = '';
    if (!sortedDates.length) {
        html = `<div class="al-empty"><i class="fas fa-images"></i><div>还没有照片</div></div>`;
    } else {
        sortedDates.forEach(date => {
            html += `<div class="al-date-label">${_alFmtDate(date)}</div>`;
            html += `<div class="al-photo-grid">`;
            groups[date].forEach(p => {
                html += `<div class="al-photo-cell" onclick="window._alOpenDetail('${p.id}','${albumId}')">
                    ${_alImgEl(p.src)}
                </div>`;
            });
            html += `</div>`;
        });
    }

    document.getElementById('al-grid-body').innerHTML = html;
    _alBindLazy(document.getElementById('al-grid-body'));

    // 切换视图
    _alShowView('grid');
}

// ─── 渲染：图片详情 ───
function _alRenderDetail(photoId) {
    _alView = 'detail'; _alCurrentPhotoId = photoId;
    const photo = albumData.photos.find(p => p.id === photoId); if (!photo) return;

    // 大图
    const mainImg = document.getElementById('al-detail-img');
    if (mainImg) {
        if (photo.src.indexOf('oss://') === 0 && window.CloudMedia) {
            mainImg.src = '';
            window.CloudMedia.fetchUrl(photo.src).then(url => { mainImg.src = url; }).catch(() => { mainImg.src = photo.src; });
        } else {
            mainImg.src = photo.src;
        }
    }

    // 日期
    const dateEl = document.getElementById('al-detail-date');
    if (dateEl) dateEl.textContent = _alFmtDate(photo.date);

    // 收藏心
    const favBtn = document.getElementById('al-detail-fav');
    if (favBtn) {
        favBtn.className = 'al-detail-fav' + (photo.isFavorite ? ' on' : '');
        favBtn.innerHTML = `<i class="${photo.isFavorite ? 'fas' : 'far'} fa-heart"></i>`;
    }

    // 缩略图条（同相册中的图片）
    if (_alCurrentAlbumId) {
        const siblings = albumData.photos
            .filter(p => p.albumId === _alCurrentAlbumId && !p.deletedAt)
            .sort((a, b) => b.timestamp - a.timestamp);
        const strip = document.getElementById('al-detail-strip');
        if (strip) {
            strip.innerHTML = siblings.map(p => `
                <div class="al-strip-thumb${p.id === photoId ? ' active' : ''}" onclick="window._alOpenDetail('${p.id}','${_alCurrentAlbumId}')">
                    ${_alImgEl(p.src, 'width:100%;height:100%;object-fit:cover;')}
                </div>`).join('');
            _alBindLazy(strip);
            // 滚动到当前
            const activeThumb = strip.querySelector('.al-strip-thumb.active');
            if (activeThumb) setTimeout(() => activeThumb.scrollIntoView({ inline: 'center', behavior: 'smooth' }), 100);
        }
    }

    _alShowView('detail');
}

// ─── 左右滑切换（详情页） ───
let _alSwipeStartX = 0;
function _alSwipeStart(e) { _alSwipeStartX = (e.touches ? e.touches[0].clientX : e.clientX); }
function _alSwipeEnd(e) {
    const endX = (e.changedTouches ? e.changedTouches[0].clientX : e.clientX);
    const dx = endX - _alSwipeStartX;
    if (Math.abs(dx) < 40) return;
    _alCurrentAlbumId && (dx < 0 ? _alDetailNext() : _alDetailPrev());
}
function _alDetailPrev() {
    const siblings = albumData.photos.filter(p => p.albumId === _alCurrentAlbumId && !p.deletedAt).sort((a,b) => b.timestamp - a.timestamp);
    const idx = siblings.findIndex(p => p.id === _alCurrentPhotoId);
    if (idx > 0) _alOpenDetail(siblings[idx-1].id, _alCurrentAlbumId);
}
function _alDetailNext() {
    const siblings = albumData.photos.filter(p => p.albumId === _alCurrentAlbumId && !p.deletedAt).sort((a,b) => b.timestamp - a.timestamp);
    const idx = siblings.findIndex(p => p.id === _alCurrentPhotoId);
    if (idx < siblings.length - 1) _alOpenDetail(siblings[idx+1].id, _alCurrentAlbumId);
}

// ─── 渲染：回收站 ───
function _alRenderTrash() {
    _alView = 'trash';
    const trashed = albumData.photos
        .filter(p => p.deletedAt)
        .sort((a,b) => b.deletedAt - a.deletedAt);

    let html = '';
    if (!trashed.length) {
        html = `<div class="al-empty"><i class="fas fa-trash"></i><div>回收站是空的</div></div>`;
    } else {
        html += `<div class="al-trash-tip">照片将在删除后 30 天自动清除</div>`;
        html += `<div class="al-photo-grid al-trash-grid">`;
        trashed.forEach(p => {
            const daysLeft = Math.ceil((_AL_TRASH_TTL - (Date.now() - p.deletedAt)) / 86400000);
            html += `<div class="al-photo-cell al-trash-cell">
                ${_alImgEl(p.src)}
                <div class="al-trash-days">${daysLeft}天</div>
                <div class="al-trash-actions">
                    <button onclick="window._alRestore('${p.id}')"><i class="fas fa-undo"></i></button>
                    <button onclick="window._alPermDelete('${p.id}')"><i class="fas fa-times"></i></button>
                </div>
            </div>`;
        });
        html += `</div>`;
    }
    document.getElementById('al-trash-body').innerHTML = html;
    _alBindLazy(document.getElementById('al-trash-body'));
}

// ─── 视图切换 ───
function _alShowView(view) {
    ['list','grid','detail','trash'].forEach(v => {
        const el = document.getElementById('al-view-' + v);
        if (el) el.style.display = (v === view ? 'flex' : 'none');
    });
}

function _alSetSubTab(tab) {
    document.querySelectorAll('.al-subtab').forEach(b => b.classList.remove('on'));
    const btn = document.getElementById('al-st-' + tab);
    if (btn) btn.classList.add('on');
}

// ─── 对外操作 ───
window._alOpenAlbum = function(albumId) {
    _alRenderGrid(albumId);
};
window._alOpenDetail = _alOpenDetail;
function _alOpenDetail(photoId, albumId) {
    _alCurrentAlbumId = albumId;
    _alRenderDetail(photoId);
}
window._alBackToList = function() {
    _alRenderList();
    _alShowView('list');
};
window._alBackToGrid = function() {
    if (_alCurrentAlbumId) _alRenderGrid(_alCurrentAlbumId);
    else _alRenderList();
};
window._alToggleFav = function(photoId) { _alToggleFavorite(photoId); };
window._alDeletePhoto = function(photoId) {
    if (!confirm('删除后可在回收站找回，确定删除吗？')) return;
    const photo = albumData.photos.find(p => p.id === photoId); if (!photo) return;
    photo.deletedAt = Date.now();
    saveAlbumData();
    // 如果是收藏里的，同步删原图收藏标记
    if (photo.albumId === _SYS_FAVORITES_ID) {
        albumData.photos.filter(p => p.src === photo.src && p.albumId !== _SYS_FAVORITES_ID)
            .forEach(p => { p.isFavorite = false; });
        saveAlbumData();
    }
    // 返回网格
    window._alBackToGrid();
};
window._alRestore = function(photoId) {
    const photo = albumData.photos.find(p => p.id === photoId); if (!photo) return;
    photo.deletedAt = null; saveAlbumData(); _alRenderTrash();
};
window._alPermDelete = function(photoId) {
    if (!confirm('永久删除后无法恢复，确定吗？')) return;
    albumData.photos = albumData.photos.filter(p => p.id !== photoId);
    saveAlbumData(); _alRenderTrash();
};
window._alCreateAlbum = function() {
    const name = prompt('相册名称：'); if (!name || !name.trim()) return;
    albumData.albums.push({ id: _alUid('alb'), name: name.trim(), isSystem: false, createdAt: Date.now() });
    saveAlbumData(); _alRenderList();
};

// ─── 上传到自建相册 ───
window._alUploadToAlbum = function(albumId, input) {
    const files = Array.from(input.files); if (!files.length) return;
    Promise.all(files.map(f => optimizeImage(f, 1200, 0.85))).then(async results => {
        for (const b64 of results) {
            let src = b64;
            if (window.CloudSync && window.CloudSync.isConnected() && window.CloudMedia) {
                try { const r = await window.CloudMedia.upload(b64, 'album-img'); src = r && r.url ? r.url : b64; } catch(e) {}
            }
            albumData.photos.push({ id: _alUid('p'), albumId, src, date: _alToday(), timestamp: Date.now(), isFavorite: false, deletedAt: null, sourcePostId: null });
        }
        saveAlbumData(); _alRenderGrid(albumId);
    });
    input.value = '';
};

// ─── 主入口（csSwitchTab('album') 时调用） ───
window._alInit = async function() {
    await loadAlbumData();
    _alRenderList();
    _alShowView('list');
    _alSetSubTab('albums');
};

// swipe 事件绑定（detail视图）
document.addEventListener('DOMContentLoaded', () => {
    const detailView = document.getElementById('al-view-detail');
    if (detailView) {
        detailView.addEventListener('touchstart', _alSwipeStart, { passive: true });
        detailView.addEventListener('touchend',   _alSwipeEnd,   { passive: true });
    }
});

window._alOpenTrash = function() {
    _alView = 'trash';
    _alSetSubTab('trash');
    _alRenderTrash();
    _alShowView('trash');
};
