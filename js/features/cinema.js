/**
 * cinema.js — 电影院功能 Step 1 v5
 *
 * 本轮改动（在 v4 基础上）：
 * 12. "返回"改回：只退出沉浸模式，回到嵌入式观影视图（图2那种：外层头像条 +
 *     电影院header都还在，视频框大小位置跟 waiting/empty 一致），不再直接结束观影/离开情侣空间
 *     — 点嵌入视图里的视频框可以重新进沉浸模式
 * 13. 表情面板改用独立类名（不复用主聊天 .sticker-picker-popover 等一堆全局样式，
 *     之前因为规则冲突导致格子巨大），改成贴近"我的表情库"管理页那种小格子紧凑网格；
 *     数据源从 stickerLibrary 换成 myStickerLibrary（用户自己的表情库，不是梦角的）
 * 14. waiting 卡片徽标文案"约定待履行"→"待观影"
 * 15. 加载过渡改为全屏进度条样式（纯黑背景+图标+进度条+文案，无header）
 * 16. 聊天消息气泡加头像：自己的消息头像在右，梦角消息头像在左，
 *     复用 moments.js 里现成的 _avEl() 头像解析逻辑（跟主聊天头像来源一致）
 *
 * 历史（v4）：
 * 8. 选完片 → 先过一个假的"电影加载中"过渡，再进播放页
 * 9. 观影模式新增沉浸式头部：返回 / 观影中 / 设置(占位)
 * 10. 观影模式强制暗色主题（CSS 变量局部覆盖）
 *
 * 历史（v3）：
 * 1. 未在播放时（empty / waiting）隐藏底部输入栏，只在 watching 状态显示
 * 2. header 文字/icon 对齐纪念日/心情手账
 * 3. waiting 状态：黑框在上、信息卡在下；未到时间前禁用+倒计时；
 *    选完文件才跳转，且不自动播放
 * 4. empty 状态：邀请按钮移到黑框下面
 * 5. watching 状态：黑框样式与 empty/waiting 保持一致
 * 6. 结束观影 → 二次确认
 * 7. 输入栏表情/图片：不侵入主聊天的 #user-sticker-picker / #image-input
 */
(function () {
    'use strict';

    var _uiState = 'empty'; // 'empty' | 'waiting' | 'watching'

    // watching 状态下：true=沉浸全屏剧场模式，false=嵌入普通电影院tab视图
    var _immersive = true;

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

    // ── 观影沉浸模式：进入/退出（隐藏外层头像条+顶栏，强制暗色）──
    function _enterTheaterMode() {
        var page = document.getElementById('couple-space-page');
        if (page) page.classList.add('cinema-theater-mode');
    }
    function _exitTheaterMode() {
        var page = document.getElementById('couple-space-page');
        if (page) page.classList.remove('cinema-theater-mode');
    }

    // ── 观影模式专属头部：返回 / 观影中 / 设置(占位) ──────
    function _theaterHdHTML() {
        return '<div class="cinema-theater-hd">' +
            '<button class="cs-icon-btn" id="cinema-theater-back-btn" title="返回"><i class="fas fa-chevron-left"></i></button>' +
            '<span class="cinema-theater-hd-title">观影中</span>' +
            '<button class="cs-icon-btn" id="cinema-theater-settings-btn" title="设置"><i class="fas fa-cog"></i></button>' +
        '</div>';
    }
    function _bindTheaterHdListeners() {
        var backBtn = document.getElementById('cinema-theater-back-btn');
        if (backBtn) {
            backBtn.addEventListener('click', function () {
                _immersive = false;
                _renderWatching();
            });
        }
        var settingsBtn = document.getElementById('cinema-theater-settings-btn');
        if (settingsBtn) {
            // 占位：整个情侣空间的设置，功能后续再接
            settingsBtn.addEventListener('click', function () {});
        }
    }

    // ── 结束观影时的公共清理（释放 blob、清空本次会话消息）────
    function _endWatchingCleanup() {
        var video = document.getElementById('cinema-video');
        if (video && video.src && video.src.indexOf('blob:') === 0) URL.revokeObjectURL(video.src);
        _currentVideo = { src: '', title: '' };
        _cinemaMessages = [];
        if (_cinemaPendingReplyTimer) { clearTimeout(_cinemaPendingReplyTimer); _cinemaPendingReplyTimer = null; }
        _cinemaHideTyping();
    }

    // ── 渲染：选片后的假加载过渡（纯视觉，全屏进度条，真实读取几乎不耗时）──
    function _renderLoading() {
        _enterTheaterMode();
        var panel = _getPanel();
        if (!panel) return;
        panel.innerHTML =
            '<div class="cinema-loading-full">' +
                '<div class="cinema-loading-icon"><i class="fas fa-film"></i></div>' +
                '<div class="cinema-loading-bar-track">' +
                    '<div class="cinema-loading-bar-fill" id="cinema-loading-bar-fill"></div>' +
                '</div>' +
                '<div class="cinema-loading-full-text">电影加载中……</div>' +
            '</div>';
        // 双 rAF 确保初始 width:0% 已经上屏，再触发到 100% 的过渡动画
        requestAnimationFrame(function () {
            requestAnimationFrame(function () {
                var fill = document.getElementById('cinema-loading-bar-fill');
                if (fill) fill.style.width = '100%';
            });
        });
    }

    // ── 聊天消息渲染（带头像，跟主聊天头像来源一致）───────
    function _escapeHtml(s) {
        var d = document.createElement('div');
        d.textContent = s == null ? '' : String(s);
        return d.innerHTML;
    }
    function _avatarHTML(isPartner) {
        if (typeof _avEl === 'function') return _avEl(isPartner, 30);
        return '<span style="font-size:20px;">' + (isPartner ? '🌸' : '🙂') + '</span>';
    }
    function _msgHTML(msg) {
        var isPartner = msg.sender === 'partner';
        var bodyHTML = msg.type === 'image'
            ? '<div class="cinema-msg-img"><img src="' + msg.content + '" alt=""></div>'
            : '<div class="cinema-msg-bubble">' + _escapeHtml(msg.content) + '</div>';
        var avatarHTML = '<div class="cinema-msg-avatar">' + _avatarHTML(isPartner) + '</div>';
        return '<div class="cinema-msg-row ' + (isPartner ? 'cinema-msg-partner' : 'cinema-msg-mine') + '">' +
            (isPartner ? avatarHTML + bodyHTML : bodyHTML + avatarHTML) +
        '</div>';
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
        msg.sender = msg.sender || 'user';
        _cinemaMessages.push(msg);
        _appendMsgToDOM(msg);
        if (msg.sender === 'user') _cinemaScheduleReply();
    }

    // ── 梦角自动回复：复用主聊天"字卡"回复库(customReplies)的选取/过滤逻辑 ──
    var _cinemaPendingReplyTimer = null;

    function _cinemaShowTyping() {
        var slot = document.getElementById('cinema-typing-fixed');
        if (!slot) return;
        var name = (typeof settings !== 'undefined' && settings.partnerName) || '梦角';
        slot.innerHTML =
            '<div class="cinema-typing-pill">' +
                '<div class="cinema-typing-pill-avatar">' + _avatarHTML(true) + '</div>' +
                '<span class="cinema-typing-pill-label">' + _escapeHtml(name) + ' 正在输入</span>' +
                '<div class="typing-dots">' +
                    '<div class="typing-dot"></div>' +
                    '<div class="typing-dot"></div>' +
                    '<div class="typing-dot"></div>' +
                '</div>' +
            '</div>';
        slot.style.display = 'block';
    }
    function _cinemaHideTyping() {
        var slot = document.getElementById('cinema-typing-fixed');
        if (slot) { slot.innerHTML = ''; slot.style.display = 'none'; }
    }
    // 跟主聊天 simulateReply() 里一样：按 disabledReplyItems / 禁用分组 过滤 customReplies
    function _cinemaBuildReplyPool() {
        var replies = (typeof customReplies !== 'undefined' && customReplies) ? customReplies : [];
        if (!replies.length) return [];
        var disabledItems = (function () {
            try {
                var raw = localStorage.getItem('disabledReplyItems');
                return raw ? new Set(JSON.parse(raw)) : new Set();
            } catch (e) { return new Set(); }
        })();
        var disabledGroupItems = new Set();
        (window.customReplyGroups || []).forEach(function (g) {
            if (g.disabled && Array.isArray(g.items)) {
                g.items.forEach(function (it) { disabledGroupItems.add(it); });
            }
        });
        return replies
            .filter(function (r) { return !disabledItems.has(r) && !disabledGroupItems.has(r); })
            .map(function (r) { return String(r || '').trim(); })
            .filter(Boolean);
    }
    function _cinemaScheduleReply() {
        if (_cinemaPendingReplyTimer) { clearTimeout(_cinemaPendingReplyTimer); }
        // 短暂 debounce：用户连续快速发几条消息时，只在最后一条之后触发一次回复
        _cinemaPendingReplyTimer = setTimeout(function () {
            _cinemaPendingReplyTimer = null;
            _cinemaSimulateReply();
        }, 300);
    }
    function _cinemaSimulateReply() {
        var pool = _cinemaBuildReplyPool();
        if (!pool.length) return; // 字卡回复库为空/被禁用完，静默跳过

        if (typeof settings !== 'undefined' && settings.typingIndicatorEnabled === false) {
            // 关闭了"正在输入"提示，直接跳过 typing 展示
        } else {
            _cinemaShowTyping();
        }

        var delayMin = (typeof settings !== 'undefined' && settings.replyDelayMin) || 800;
        var delayMax = (typeof settings !== 'undefined' && settings.replyDelayMax) || 2200;
        var delay = delayMin + Math.random() * Math.max(0, delayMax - delayMin);

        setTimeout(function () {
            _cinemaHideTyping();

            var replyText = '';
            for (var t = 0; t < 6; t++) {
                var picked = pool[Math.floor(Math.random() * pool.length)];
                if (picked && String(picked).trim()) { replyText = String(picked).trim(); break; }
            }
            if (!replyText) return;

            var customs = (typeof customEmojis !== 'undefined' && customEmojis) ? customEmojis : [];
            var finalText = replyText;
            if (customs.length && Math.random() < 0.2) {
                var emoji = customs[Math.floor(Math.random() * customs.length)];
                finalText = Math.random() < 0.5 ? (emoji + ' ' + replyText) : (replyText + ' ' + emoji);
            }
            _pushMessage({ type: 'text', content: finalText, sender: 'partner' });
            if (typeof playSound === 'function') { try { playSound('message'); } catch (e) {} }

            // 小概率附带梦角的表情包（跟主聊天一样用 stickerLibrary，不是用户自己的 myStickerLibrary）
            var disabledStickers = (function () {
                try {
                    var raw = localStorage.getItem('disabledStickerItems');
                    return raw ? new Set(JSON.parse(raw)) : new Set();
                } catch (e) { return new Set(); }
            })();
            var stickerPool = ((typeof stickerLibrary !== 'undefined' && stickerLibrary) ? stickerLibrary : [])
                .filter(function (s) { return !disabledStickers.has(s); });
            if (stickerPool.length && Math.random() < 0.2) {
                setTimeout(function () {
                    var src = stickerPool[Math.floor(Math.random() * stickerPool.length)];
                    _pushMessage({ type: 'image', content: src, sender: 'partner' });
                }, 400 + Math.random() * 500);
            }
        }, delay);
    }

    // ── 输入栏（只在 watching 状态渲染）───────────────────
    function _stickerPickerHTML() {
        return '<div class="cinema-sticker-popover" id="cinema-sticker-picker">' +
            '<div class="cinema-sticker-popover-hd">我的表情</div>' +
            '<div class="cinema-sticker-grid" id="cinema-sticker-grid"></div>' +
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
        // 用户自己添加的表情库（不是梦角的）
        var myStickers = (typeof myStickerLibrary !== 'undefined' && myStickerLibrary) ? myStickerLibrary : [];

        if (!presets.length && !customs.length && !myStickers.length) {
            grid.innerHTML = '<div class="cinema-sticker-empty">暂无表情，去主聊天页的"我的表情库"里添加吧</div>';
            return;
        }

        presets.concat(customs).forEach(function (emoji) {
            var item = document.createElement('div');
            item.className = 'cinema-sticker-item';
            item.innerHTML = '<span>' + _escapeHtml(emoji) + '</span>';
            item.onclick = function () {
                var input = document.getElementById('cinema-input-field');
                if (input) { input.value += emoji; input.focus(); }
                var picker = document.getElementById('cinema-sticker-picker');
                if (picker) picker.classList.remove('active');
            };
            grid.appendChild(item);
        });

        myStickers.forEach(function (src) {
            var item = document.createElement('div');
            item.className = 'cinema-sticker-item';
            item.innerHTML = '<img>';
            var imgEl = item.querySelector('img');
            var isCloud = typeof src === 'string' && src.indexOf('oss://') === 0;
            if (isCloud && window.CloudMedia && typeof window.CloudMedia.bindLazyImage === 'function') {
                window.CloudMedia.bindLazyImage(imgEl, src);
            } else {
                imgEl.src = src;
            }
            item.onclick = function () {
                _pushMessage({ type: 'image', content: imgEl.src, sender: 'user' });
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
        _exitTheaterMode();
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
        _exitTheaterMode();
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
                    '<div class="cinema-appt-badge">待观影</div>' +
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
            _immersive = true;
            _renderLoading();
            setTimeout(function () {
                _uiState = 'watching';
                _cinemaRender();
            }, 1650);
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

    // ── 渲染：观影中（沉浸/嵌入两种视图共用同一套播放器+工具栏+聊天）──
    function _renderWatching() {
        _clearWaitTimer();
        var panel = _getPanel();
        if (!panel) return;

        if (_immersive) {
            _enterTheaterMode();
        } else {
            _exitTheaterMode();
        }

        var title = _currentVideo.title || _fakeAppt.movieTitle;
        var headerHTML = _immersive ? _theaterHdHTML() : _hdHTML();

        panel.innerHTML =
            headerHTML +
            '<div class="cinema-watch-video-pad">' +
                '<div class="cinema-player-wrap" id="cinema-player-wrap">' +
                    '<video id="cinema-video" class="cinema-video" controls playsinline webkit-playsinline>' +
                        '<source src="' + _currentVideo.src + '" type="video/mp4">' +
                    '</video>' +
                    (_immersive ? '' :
                        '<button class="cinema-immersive-btn" id="cinema-immersive-btn" title="进入沉浸模式">' +
                            '<i class="fas fa-expand"></i>' +
                        '</button>'
                    ) +
                '</div>' +
            '</div>' +
            '<div class="cinema-watch-toolbar">' +
                '<button class="cinema-tool-btn" id="cinema-change-film-btn"><i class="fas fa-exchange-alt"></i> 换片</button>' +
                '<span class="cinema-watch-title" id="cinema-watch-title">' + _escapeHtml(title) + '</span>' +
                '<button class="cinema-tool-btn cinema-tool-end" id="cinema-end-btn"><i class="fas fa-stop-circle"></i> 结束观影</button>' +
            '</div>' +
            '<div class="cinema-body cinema-body-watch">' +
                _chatAreaHTML() +
                '<div class="cinema-typing-fixed" id="cinema-typing-fixed" style="display:none;"></div>' +
                _inputBarHTML() +
            '</div>' +
            '<input type="file" id="cinema-file-input" accept="video/*" style="display:none;">';

        if (_immersive) {
            _bindTheaterHdListeners();
        } else {
            var archiveBtn = document.getElementById('cinema-archive-btn');
            if (archiveBtn) archiveBtn.addEventListener('click', _openArchive);
            // 嵌入视图下：点右下角按钮，或直接点视频区域，都能重新进入沉浸模式
            var immersiveBtn = document.getElementById('cinema-immersive-btn');
            if (immersiveBtn) {
                immersiveBtn.addEventListener('click', function (e) {
                    e.stopPropagation();
                    _immersive = true;
                    _renderWatching();
                });
            }
            var wrap = document.getElementById('cinema-player-wrap');
            if (wrap) {
                wrap.addEventListener('click', function () {
                    _immersive = true;
                    _renderWatching();
                });
            }
        }

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
            _endWatchingCleanup();
            _exitTheaterMode();
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

    // ── 调试专用：跳过邀请/倒计时，直接切状态（浏览器控制台里手动调用）──
    window._cinemaDebugGoto = function (state) {
        _uiState = state;
        _cinemaRender();
    };
    // 把约定时间改成"刚刚"，强制解锁选片按钮（waiting 状态下调用）
    window._cinemaDebugUnlock = function () {
        var now = new Date();
        _fakeAppt.dateStr = now.getFullYear() + '年' + (now.getMonth() + 1) + '月' + now.getDate() + '日';
        _fakeAppt.timeStr = '00:00';
        if (_uiState === 'waiting') _renderWaiting();
    };
    // 把约定时间改成 1 小时后，强制锁定选片按钮，方便看倒计时文案
    window._cinemaDebugLock = function () {
        var future = new Date(Date.now() + 3600000);
        _fakeAppt.dateStr = future.getFullYear() + '年' + (future.getMonth() + 1) + '月' + future.getDate() + '日';
        _fakeAppt.timeStr = String(future.getHours()).padStart(2, '0') + ':' + String(future.getMinutes()).padStart(2, '0');
        if (_uiState === 'waiting') _renderWaiting();
    };

    // ── 调试专用：诊断梦角不回复 ──────────────────────────
    // 控制台运行 _cinemaDebugReply() 可看到字卡池状态，并强制触发一次回复
    window._cinemaDebugReply = function () {
        var pool = _cinemaBuildReplyPool();
        console.log('[cinema] 字卡池大小:', pool.length, '条');
        if (pool.length === 0) {
            var rawLen = (typeof customReplies !== 'undefined' && Array.isArray(customReplies))
                ? customReplies.length : '变量不可用';
            console.log('[cinema] customReplies 原始条数:', rawLen);
            console.log('[cinema] 原因可能：① 字卡库为空 ② 字卡全部被禁用 ③ customReplies 未加载');
        } else {
            console.log('[cinema] 样例字卡:', pool.slice(0, 3));
            console.log('[cinema] 正在强制触发一次回复...');
            _cinemaSimulateReply();
        }
        return pool;
    };

    // ── 对外暴露 ─────────────────────────────────────────
    window._cinemaInit = function () {
        _bindOutsideClickOnce();
        _cinemaRender();
    };

})();
