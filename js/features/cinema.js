/**
 * cinema.js — 电影院功能 Step 1 v3
 *
 * 本轮改动（对齐用户反馈）：
 * 1. 未在播放时（empty / waiting）隐藏底部输入栏，只在 watching 状态显示
 * 2. header 文字/icon 对齐纪念日/心情手账（padding 修正见 cinema.css）
 * 3. waiting 状态：黑框在上、信息卡在下；未到时间前"选择影片并开始"禁用+倒计时；
 *    点击后直接弹出文件选择框（不跳页面）；真正选中文件后才跳到 watching 页，
 *    且不自动播放，等用户自己点播放
 * 4. empty 状态：邀请按钮移到黑框下面，不再叠在黑框里
 * 5. watching 状态：黑框样式与 empty/waiting 保持一致（同样的圆角深色框），
 *    视频控件本身仍用原生 <video controls>
 * 6. 结束观影 → 二次确认（沿用项目里其它危险操作用的原生 confirm()）
 * 7. 输入栏表情/图片：表情面板复用用户自己的表情库(stickerLibrary/customEmojis)，
 *    图片按钮复用主聊天的图片处理逻辑(optimizeImage)，各自建一套独立 DOM，
 *    不侵入主聊天的 #user-sticker-picker / #image-input，避免互相影响
 */
(function () {
    'use strict';

    var _uiState = 'empty'; // 'empty' | 'waiting' | 'watching'

    var _fakeAppt = {
        movieTitle: '阿嫚的情书',
        dateStr: '2026年8月3日',
        timeStr: '20:30'
    };

    // 观影中：当前视频信息（从 waiting 跳转过来时写入）
    var _currentVideo = { src: '', title: '' };

    // 本次观影会话的聊天记录（内存态，结束观影时清空）
    var _cinemaMessages = [];

    // waiting 状态下的解锁轮询定时器
    var _waitLockTimer = null;

    // 文档级"点击外部关闭表情面板"监听是否已绑定
    var _outsideClickBound = false;

    function _getPanel() {
        return document.getElementById('cs-panel-cinema');
    }

    function _clearWaitTimer() {
        if (_waitLockTimer) {
            clearInterval(_waitLockTimer);
            _waitLockTimer = null;
        }
    }

    // ── 时间解析：把 "2026年8月3日" + "20:30" 解析成 Date ──────
    function _parseApptDate() {
        var m = /(\d+)年(\d+)月(\d+)日/.exec(_fakeAppt.dateStr || '');
        var t = /(\d+):(\d+)/.exec(_fakeAppt.timeStr || '');
        if (!m || !t) return null;
        return new Date(+m[1], +m[2] - 1, +m[3], +t[1], +t[2], 0, 0);
    }
    function _isApptReached() {
        var d = _parseApptDate();
        if (!d) return true; // 解析失败时不卡住用户，默认放行
        return Date.now() >= d.getTime();
    }
    function _countdownText() {
        var d = _parseApptDate();
        if (!d) return '';
        var diff = d.getTime() - Date.now();
        if (diff <= 0) return '';
        var totalMin = Math.ceil(diff / 60000);
        var h = Math.floor(totalMin / 60);
        var m = totalMin % 60;
        if (h > 0) return '还有' + h + '小时' + (m > 0 ? m + '分钟' : '');
        return '还有' + m + '分钟';
    }

    // ── 公共 header HTML ────────────────────────────────
    function _hdHTML() {
        return '<div class="cinema-hd">' +
            '<span class="cinema-hd-title">电影院</span>' +
            '<button class="cs-icon-btn" id="cinema-archive-btn" title="影日志">' +
                '<span class="cinema-archive-icon"></span>' +
            '</button>' +
        '</div>';
    }

    // ── 聊天消息渲染 ─────────────────────────────────────
    function _escapeHtml(s) {
        var d = document.createElement('div');
        d.textContent = s == null ? '' : String(s);
        return d.innerHTML;
    }
    function _msgHTML(msg) {
        if (msg.type === 'image') {
            return '<div class="cinema-msg-row"><div class="cinema-msg-img"><img src="' + msg.content + '" alt=""></div></div>';
        }
        return '<div class="cinema-msg-row"><div class="cinema-msg-bubble">' + _escapeHtml(msg.content) + '</div></div>';
    }
    function _chatAreaHTML() {
        if (!_cinemaMessages.length) {
            return '<div class="cinema-chat-area" id="cinema-chat-area">' +
                    '<div class="cinema-chat-empty">' +
                        '<i class="far fa-comment-dots"></i>' +
                        '<p>暂无聊天记录</p>' +
                    '</div>' +
                '</div>';
        }
        return '<div class="cinema-chat-area" id="cinema-chat-area">' +
            _cinemaMessages.map(_msgHTML).join('') +
        '</div>';
    }
    function _appendMsgToDOM(msg) {
        var area = document.getElementById('cinema-chat-area');
        if (!area) return;
        var emptyEl = area.querySelector('.cinema-chat-empty');
        if (emptyEl) emptyEl.remove();
        var tmp = document.createElement('div');
        tmp.innerHTML = _msgHTML(msg);
        area.appendChild(tmp.firstChild);
        area.scrollTop = area.scrollHeight;
    }
    function _pushMessage(msg) {
        msg.id = Date.now() + Math.random();
        msg.ts = Date.now();
        _cinemaMessages.push(msg);
        _appendMsgToDOM(msg);
    }

    // ── 输入栏（只在 watching 状态渲染）───────────────────
    function _stickerPickerHTML() {
        return '<div class="sticker-picker-popover" id="cinema-sticker-picker">' +
            '<div class="combo-tabs-header">' +
                '<span style="font-size:12px;color:var(--text-secondary);padding:8px 4px;">我的表情</span>' +
            '</div>' +
            '<div class="combo-content-area" id="cinema-sticker-grid"></div>' +
        '</div>';
    }
    function _inputBarHTML() {
        return '<div class="cinema-input-bar-wrap">' +
            _stickerPickerHTML() +
            '<div class="cinema-input-bar">' +
                '<input type="text" class="cinema-input-field" id="cinema-input-field" placeholder="说点什么吧…">' +
                '<button class="cinema-chat-btn" id="cinema-emoji-btn" title="表情包"><i class="far fa-smile"></i></button>' +
                '<button class="cinema-chat-btn" id="cinema-img-btn" title="图片"><i class="far fa-image"></i></button>' +
            '</div>' +
            '<input type="file" id="cinema-image-input" accept="image/*" style="display:none;">' +
        '</div>';
    }
    function _renderCinemaStickerGrid() {
        var grid = document.getElementById('cinema-sticker-grid');
        if (!grid) return;
        grid.innerHTML = '';

        var presets = (typeof CONSTANTS !== 'undefined' && CONSTANTS.REPLY_EMOJIS) ? CONSTANTS.REPLY_EMOJIS : [];
        var customs = (typeof customEmojis !== 'undefined' && customEmojis) ? customEmojis : [];
        var stickers = (typeof stickerLibrary !== 'undefined' && stickerLibrary) ? stickerLibrary : [];

        if (!presets.length && !customs.length && !stickers.length) {
            grid.style.display = 'block';
            grid.innerHTML = '<div style="text-align:center;color:var(--text-secondary);opacity:.5;font-size:12px;padding:24px 10px;">暂无表情，去主聊天页添加你的表情包吧</div>';
            return;
        }

        grid.style.display = 'grid';
        grid.style.gridTemplateColumns = 'repeat(5, 1fr)';
        grid.style.gap = '8px';
        grid.style.padding = '10px';

        presets.concat(customs).forEach(function (emoji) {
            var item = document.createElement('div');
            item.className = 'picker-item';
            item.innerHTML = '<span style="font-size:24px;">' + _escapeHtml(emoji) + '</span>';
            item.onclick = function () {
                var input = document.getElementById('cinema-input-field');
                if (input) { input.value += emoji; input.focus(); }
                var picker = document.getElementById('cinema-sticker-picker');
                if (picker) picker.classList.remove('active');
            };
            grid.appendChild(item);
        });

        stickers.forEach(function (src) {
            var item = document.createElement('div');
            item.className = 'picker-item';
            item.innerHTML = '<img>';
            var imgEl = item.querySelector('img');
            var isCloud = typeof src === 'string' && src.indexOf('oss://') === 0;
            if (isCloud && window.CloudMedia && typeof window.CloudMedia.bindLazyImage === 'function') {
                window.CloudMedia.bindLazyImage(imgEl, src);
            } else {
                imgEl.src = src;
            }
            item.onclick = function () {
                _pushMessage({ type: 'image', content: imgEl.src });
                var picker = document.getElementById('cinema-sticker-picker');
                if (picker) picker.classList.remove('active');
            };
            grid.appendChild(item);
        });
    }
    function _bindInputBarListeners() {
        var emojiBtn = document.getElementById('cinema-emoji-btn');
        var imgBtn = document.getElementById('cinema-img-btn');
        var imgInput = document.getElementById('cinema-image-input');
        var textInput = document.getElementById('cinema-input-field');

        if (emojiBtn) {
            emojiBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                var picker = document.getElementById('cinema-sticker-picker');
                if (!picker) return;
                var willOpen = !picker.classList.contains('active');
                picker.classList.toggle('active', willOpen);
                if (willOpen) _renderCinemaStickerGrid();
            });
        }
        if (imgBtn && imgInput) {
            imgBtn.addEventListener('click', function () { imgInput.click(); });
            imgInput.addEventListener('change', function (e) {
                var file = e.target.files && e.target.files[0];
                if (!file) return;
                if (typeof optimizeImage === 'function') {
                    optimizeImage(file).then(function (dataUrl) {
                        _pushMessage({ type: 'image', content: dataUrl });
                    }).catch(function () {
                        var reader = new FileReader();
                        reader.onload = function (ev) { _pushMessage({ type: 'image', content: ev.target.result }); };
                        reader.readAsDataURL(file);
                    });
                } else {
                    var reader = new FileReader();
                    reader.onload = function (ev) { _pushMessage({ type: 'image', content: ev.target.result }); };
                    reader.readAsDataURL(file);
                }
                e.target.value = '';
            });
        }
        if (textInput) {
            textInput.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') {
                    var val = textInput.value.trim();
                    if (val) {
                        _pushMessage({ type: 'text', content: val });
                        textInput.value = '';
                    }
                }
            });
        }
    }
    function _bindOutsideClickOnce() {
        if (_outsideClickBound) return;
        _outsideClickBound = true;
        document.addEventListener('click', function (e) {
            var picker = document.getElementById('cinema-sticker-picker');
            if (!picker || !picker.classList.contains('active')) return;
            if (picker.contains(e.target)) return;
            if (e.target.closest && e.target.closest('#cinema-emoji-btn')) return;
            picker.classList.remove('active');
        });
    }

    // ── 渲染：空状态 ────────────────────────────────────
    function _renderEmpty() {
        _clearWaitTimer();
        var panel = _getPanel();
        if (!panel) return;

        panel.innerHTML =
            _hdHTML() +
            '<div class="cinema-body">' +
                '<div class="cinema-screen-wrap">' +
                    '<div class="cinema-empty-icon"><i class="fas fa-film"></i></div>' +
                    '<div class="cinema-empty-text">还没有约定观影</div>' +
                '</div>' +
                '<button class="cinema-invite-btn" id="cinema-invite-btn">邀请梦角一起观影</button>' +
                _chatAreaHTML() +
            '</div>';

        document.getElementById('cinema-invite-btn').addEventListener('click', function () {
            _uiState = 'waiting';
            _cinemaRender();
        });
        document.getElementById('cinema-archive-btn').addEventListener('click', _openArchive);
    }

    // ── 渲染：有约定（等待中）────────────────────────────
    function _renderWaiting() {
        var panel = _getPanel();
        if (!panel) return;

        var locked = !_isApptReached();

        panel.innerHTML =
            _hdHTML() +
            '<div class="cinema-body">' +
                '<div class="cinema-screen-wrap">' +
                    '<div class="cinema-waiting-icon"><i class="fas fa-film"></i></div>' +
                    '<div class="cinema-waiting-movie">' + _escapeHtml(_fakeAppt.movieTitle) + '</div>' +
                    '<div class="cinema-waiting-sub">' + (locked ? '待到观影时间' : '时间已到，可以选片开始了') + '</div>' +
                '</div>' +
                '<div class="cinema-appt-card">' +
                    '<div class="cinema-appt-badge">约定待履行</div>' +
                    '<div class="cinema-appt-movie">' + _escapeHtml(_fakeAppt.movieTitle) + '</div>' +
                    '<div class="cinema-appt-time">' + _fakeAppt.dateStr + '&nbsp;&nbsp;' + _fakeAppt.timeStr + '</div>' +
                    '<div class="cinema-appt-actions">' +
                        '<button class="cinema-cancel-btn" id="cinema-cancel-btn">取消约定</button>' +
                        '<button class="cinema-start-btn" id="cinema-start-btn"' + (locked ? ' disabled' : '') + '>选择影片并开始</button>' +
                    '</div>' +
                    (locked ? '<div class="cinema-appt-countdown">' + _countdownText() + '后可选择影片</div>' : '') +
                '</div>' +
                _chatAreaHTML() +
            '</div>' +
            '<input type="file" id="cinema-waiting-file-input" accept="video/*" style="display:none;">';

        document.getElementById('cinema-cancel-btn').addEventListener('click', function () {
            _clearWaitTimer();
            _uiState = 'empty';
            _cinemaRender();
        });

        var startBtn = document.getElementById('cinema-start-btn');
        var waitingFileInput = document.getElementById('cinema-waiting-file-input');
        if (startBtn && !locked) {
            startBtn.addEventListener('click', function () {
                waitingFileInput.click();
            });
        }
        waitingFileInput.addEventListener('change', function (e) {
            var file = e.target.files && e.target.files[0];
            if (!file) return; // 用户在文件框里取消了，留在原地不跳转
            _clearWaitTimer();
            _currentVideo.src = URL.createObjectURL(file);
            _currentVideo.title = file.name.replace(/\.[^.]+$/, '');
            _uiState = 'watching';
            _cinemaRender();
        });
        document.getElementById('cinema-archive-btn').addEventListener('click', _openArchive);

        // 未到时间：定时轮询，一旦解锁自动刷新按钮态
        _clearWaitTimer();
        if (locked) {
            _waitLockTimer = setInterval(function () {
                if (_isApptReached()) {
                    _clearWaitTimer();
                    if (_uiState === 'waiting') _renderWaiting();
                }
            }, 20000);
        }
    }

    // ── 渲染：观影中 ─────────────────────────────────────
    function _renderWatching() {
        _clearWaitTimer();
        var panel = _getPanel();
        if (!panel) return;

        var title = _currentVideo.title || _fakeAppt.movieTitle;

        panel.innerHTML =
            '<div class="cinema-watch-video-pad">' +
                '<div class="cinema-player-wrap">' +
                    '<video id="cinema-video" class="cinema-video" controls>' +
                        '<source src="' + _currentVideo.src + '" type="video/mp4">' +
                    '</video>' +
                '</div>' +
            '</div>' +
            '<div class="cinema-watch-toolbar">' +
                '<button class="cinema-tool-btn" id="cinema-change-film-btn"><i class="fas fa-exchange-alt"></i> 换片</button>' +
                '<span class="cinema-watch-title" id="cinema-watch-title">' + _escapeHtml(title) + '</span>' +
                '<button class="cinema-tool-btn cinema-tool-end" id="cinema-end-btn"><i class="fas fa-stop-circle"></i> 结束观影</button>' +
            '</div>' +
            '<div class="cinema-body cinema-body-watch">' +
                _chatAreaHTML() +
                _inputBarHTML() +
            '</div>' +
            '<input type="file" id="cinema-file-input" accept="video/*" style="display:none;">';

        document.getElementById('cinema-change-film-btn').addEventListener('click', function () {
            document.getElementById('cinema-file-input').click();
        });
        document.getElementById('cinema-file-input').addEventListener('change', function (e) {
            var file = e.target.files && e.target.files[0];
            if (!file) return;
            var video = document.getElementById('cinema-video');
            var titleEl = document.getElementById('cinema-watch-title');
            if (video && video.src && video.src.indexOf('blob:') === 0) URL.revokeObjectURL(video.src);
            var newSrc = URL.createObjectURL(file);
            var newTitle = file.name.replace(/\.[^.]+$/, '');
            _currentVideo.src = newSrc;
            _currentVideo.title = newTitle;
            video.src = newSrc;
            video.play();
            if (titleEl) titleEl.textContent = newTitle;
        });
        document.getElementById('cinema-end-btn').addEventListener('click', function () {
            if (!confirm('确定要结束观影吗？')) return;
            var video = document.getElementById('cinema-video');
            if (video && video.src && video.src.indexOf('blob:') === 0) URL.revokeObjectURL(video.src);
            _currentVideo = { src: '', title: '' };
            _cinemaMessages = [];
            _uiState = 'empty';
            _cinemaRender();
        });

        _bindInputBarListeners();
    }

    // ── 统一渲染入口 ─────────────────────────────────────
    function _cinemaRender() {
        if (_uiState === 'empty')        _renderEmpty();
        else if (_uiState === 'waiting') _renderWaiting();
        else if (_uiState === 'watching')_renderWatching();
    }

    // ── 档案页 ───────────────────────────────────────────
    function _openArchive() {
        var page = document.getElementById('cinema-archive-page');
        if (page) page.classList.add('cinema-archive-open');
    }
    window._cinemaCloseArchive = function () {
        var page = document.getElementById('cinema-archive-page');
        if (page) page.classList.remove('cinema-archive-open');
    };

    // ── 对外暴露 ─────────────────────────────────────────
    window._cinemaInit = function () {
        _bindOutsideClickOnce();
        _cinemaRender();
    };

})();
