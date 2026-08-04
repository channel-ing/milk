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

    // ── 约定状态持久化：_uiState + _fakeAppt ──────────────
    // 之前这两个是纯内存变量，刷新/重进页面就丢，导致约好了时间也会
    // 打回"待邀请"。现在跟待看清单/观看历史一样存到 localforage。
    // 注意：'watching' 不落盘 —— 播放的视频是本地文件对象(createObjectURL)，
    // 刷新后浏览器拿不到这个文件了没法自动续播，所以观影中被刷新/重进时
    // 退回到 'waiting'（约定还在，只是要重新选一次片），而不是清空到 'empty'。
    var _apptLoaded = false;
    var _apptStorageKey = null;
    async function _apptGetKey() {
        if (_apptStorageKey) return _apptStorageKey;
        try {
            var allKeys = await localforage.keys();
            var found = allKeys.find(function (k) { return k.indexOf('_cinemaAppt') !== -1; });
            if (found) { _apptStorageKey = found; return found; }
            var msgKey = allKeys.find(function (k) { return k.indexOf('_messages') !== -1; });
            var prefix = msgKey ? msgKey.replace('_messages', '') : 'CHAT_APP_V3_';
            _apptStorageKey = prefix + '_cinemaAppt';
        } catch (e) {
            _apptStorageKey = 'CHAT_APP_V3__cinemaAppt';
        }
        return _apptStorageKey;
    }
    async function _apptLoad() {
        if (_apptLoaded) return;
        _apptLoaded = true;
        try {
            var key = await _apptGetKey();
            var saved = await localforage.getItem(key);
            if (saved && typeof saved === 'object') {
                if (saved.fakeAppt) _fakeAppt = saved.fakeAppt;
                if (saved.uiState === 'waiting' || saved.uiState === 'watching') {
                    _uiState = 'waiting'; // watching 也统一落回 waiting，见上面注释
                }
            }
        } catch (e) { console.warn('[cinema] 约定状态加载失败:', e); }
    }
    async function _apptSave() {
        try {
            var key = await _apptGetKey();
            var stateToSave = (_uiState === 'watching') ? 'waiting' : _uiState;
            await localforage.setItem(key, { uiState: stateToSave, fakeAppt: _fakeAppt });
        } catch (e) { console.warn('[cinema] 约定状态保存失败:', e); }
    }

    // ── 邀请弹层：让用户填片名 + 日期 + 时间来发起邀请 ──────
    // 目前还没做梦角同意/拒绝的系统，所以点"确定邀请"就直接当作梦角同意了，
    // 直接进入 waiting（约定生效）
    function _openInviteSheet() {
        var old = document.getElementById('cinema-invite-sheet');
        if (old) old.remove();
        var now = new Date();
        var defaultDate = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
        var later = new Date(now.getTime() + 3600000);
        var defaultTime = String(later.getHours()).padStart(2, '0') + ':' + String(later.getMinutes()).padStart(2, '0');
        var minDate = defaultDate; // 日期选择器不能选比今天更早的日期

        var partnerName = (typeof settings !== 'undefined' && settings.partnerName) || '梦角';
        var sheet = document.createElement('div');
        sheet.id = 'cinema-invite-sheet';
        sheet.className = 'cinema-invite-sheet';
        sheet.innerHTML =
            '<div class="cinema-invite-mask" id="cinema-invite-mask"></div>' +
            '<div class="cinema-invite-body">' +
                '<div class="cinema-invite-title">邀请' + _escapeHtml(partnerName) + '一起观影</div>' +
                '<div class="cinema-invite-label">片名</div>' +
                '<input type="text" class="cinema-invite-input" id="cinema-invite-movie" maxlength="40" placeholder="想看什么电影？">' +
                '<div class="cinema-invite-label">日期</div>' +
                '<input type="date" class="cinema-invite-input" id="cinema-invite-date" min="' + minDate + '" value="' + defaultDate + '">' +
                '<div class="cinema-invite-label">时间</div>' +
                '<input type="time" class="cinema-invite-input" id="cinema-invite-time" value="' + defaultTime + '">' +
                '<div class="cinema-invite-error" id="cinema-invite-error"></div>' +
                '<div class="cinema-invite-hint">发出后' + _escapeHtml(partnerName) + '会在主聊天回复你，可能会提议换个时间～</div>' +
                '<div class="cinema-invite-actions">' +
                    '<button class="cinema-invite-cancel" id="cinema-invite-cancel">取消</button>' +
                    '<button class="cinema-invite-confirm" id="cinema-invite-confirm">确定邀请</button>' +
                '</div>' +
            '</div>';
        document.body.appendChild(sheet);

        function close() { sheet.remove(); }
        document.getElementById('cinema-invite-mask').addEventListener('click', close);
        document.getElementById('cinema-invite-cancel').addEventListener('click', close);
        document.getElementById('cinema-invite-confirm').addEventListener('click', function () {
            var movieInput = document.getElementById('cinema-invite-movie');
            var movieVal = movieInput.value.trim();
            var dateVal = document.getElementById('cinema-invite-date').value; // "YYYY-MM-DD"
            var timeVal = document.getElementById('cinema-invite-time').value; // "HH:MM"
            var errorEl = document.getElementById('cinema-invite-error');
            errorEl.textContent = '';
            if (!movieVal) { movieInput.focus(); return; }
            var dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateVal || '');
            var tm = /^(\d{2}):(\d{2})$/.exec(timeVal || '');
            if (!dm || !tm) return;
            var picked = new Date(+dm[1], +dm[2] - 1, +dm[3], +tm[1], +tm[2], 0, 0);
            if (picked.getTime() <= Date.now()) {
                errorEl.textContent = '约的时间不能早于现在，改一下吧';
                return;
            }
            close();
            _negoStartRound(movieVal, (+dm[1]) + '年' + (+dm[2]) + '月' + (+dm[3]) + '日', timeVal, 1);
        });
    }

    // ── 居中卡片式确认弹窗（跟 album.js 的 _alShowConfirm 底部弹出不一样，
    //    这个是居中卡片，配对之前打分/邀请弹层的圆角卡片风格）──────
    function _cinemaCenterConfirm(title, desc, confirmText, onConfirm) {
        var old = document.getElementById('cinema-confirm-modal');
        if (old) old.remove();
        var modal = document.createElement('div');
        modal.id = 'cinema-confirm-modal';
        modal.className = 'cinema-confirm-modal';
        modal.innerHTML =
            '<div class="cinema-confirm-mask" id="cinema-confirm-mask"></div>' +
            '<div class="cinema-confirm-card">' +
                '<div class="cinema-confirm-title">' + _escapeHtml(title) + '</div>' +
                '<div class="cinema-confirm-desc">' + _escapeHtml(desc) + '</div>' +
                '<div class="cinema-confirm-actions">' +
                    '<button class="cinema-confirm-cancel" id="cinema-confirm-cancel">取消</button>' +
                    '<button class="cinema-confirm-ok" id="cinema-confirm-ok">' + _escapeHtml(confirmText) + '</button>' +
                '</div>' +
            '</div>';
        document.body.appendChild(modal);
        function close() { modal.remove(); }
        document.getElementById('cinema-confirm-mask').addEventListener('click', close);
        document.getElementById('cinema-confirm-cancel').addEventListener('click', close);
        document.getElementById('cinema-confirm-ok').addEventListener('click', function () {
            close();
            onConfirm();
        });
    }

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

    // ── 结束观影后：弹出打分/写影评弹层 ──────────────────
    // 不管用户是保存还是跳过，都会记一条观看历史（跳过就是 0 星 + 空评价），
    // 保证"影评"里能看到真实看过的片子，而不是只有手动造的假数据。
    // 保存前先 _histLoad()，避免这次会话都没打开过"影评"tab 时 _history
    // 还是空数组，写回去把之前存的记录覆盖掉。
    // ── 梦角对本次观影的自动评价：100% 给星，评语从字卡池真实抽取 ──
    // 星级 1-5 随机；评语从 customReplies 字卡池（跟聊天自动回复同一个池子）
    // 随机不重复抽 2-4 条拼起来，绝不使用任何预设/编造的文案。
    // 如果字卡池是空的，星级照给，评语只能空着（没有素材可用）。
    function _cinemaGeneratePartnerReview() {
        var stars = 1 + Math.floor(Math.random() * 5);
        var pool = _cinemaBuildReplyPool();
        if (!pool.length) return { stars: stars, review: '' };
        var shuffled = pool.slice();
        for (var i = shuffled.length - 1; i > 0; i--) {
            var j = Math.floor(Math.random() * (i + 1));
            var tmp = shuffled[i]; shuffled[i] = shuffled[j]; shuffled[j] = tmp;
        }
        var count = Math.min(2 + Math.floor(Math.random() * 3), shuffled.length); // 2~4 条
        return { stars: stars, review: shuffled.slice(0, count).join(' ') };
    }

    function _openRatingSheet(title) {
        var old = document.getElementById('cinema-rating-sheet');
        if (old) old.remove();
        var stars = 0;
        var sheet = document.createElement('div');
        sheet.id = 'cinema-rating-sheet';
        sheet.className = 'cinema-rating-sheet';
        sheet.innerHTML =
            '<div class="cinema-rating-mask" id="cinema-rating-mask"></div>' +
            '<div class="cinema-rating-body">' +
                '<div class="cinema-rating-title">《' + _escapeHtml(title) + '》看完啦</div>' +
                '<div class="cinema-rating-sub">给这次观影打个分吧</div>' +
                '<div id="cinema-rating-stars">' + _histStarsHTML(0, true) + '</div>' +
                '<textarea class="cinema-rating-textarea" id="cinema-rating-review" maxlength="200" placeholder="影评（可选）"></textarea>' +
                '<div class="cinema-rating-actions">' +
                    '<button class="cinema-rating-skip" id="cinema-rating-skip">跳过</button>' +
                    '<button class="cinema-rating-save" id="cinema-rating-save">保存</button>' +
                '</div>' +
            '</div>';
        document.body.appendChild(sheet);

        var starsWrap = document.getElementById('cinema-rating-stars');
        function bindStarClicks() {
            starsWrap.querySelectorAll('.cinema-hist-star').forEach(function (starEl) {
                starEl.addEventListener('click', function () {
                    stars = parseInt(starEl.dataset.star, 10);
                    starsWrap.innerHTML = _histStarsHTML(stars, true);
                    bindStarClicks();
                });
            });
        }
        bindStarClicks();

        function finish(withReview) {
            var reviewVal = withReview ? document.getElementById('cinema-rating-review').value.trim() : '';
            var finalStars = withReview ? stars : 0;
            var partner = _cinemaGeneratePartnerReview();
            _histLoad().then(function () {
                _history.unshift({
                    id: Date.now() + Math.random(),
                    title: title,
                    ts: Date.now(),
                    userStars: finalStars,
                    userReview: reviewVal,
                    partnerStars: partner.stars,
                    partnerReview: partner.review
                });
                _histSave();
                sheet.remove();
                _uiState = 'empty';
                _apptSave();
                _cinemaRender();
            });
        }
        document.getElementById('cinema-rating-mask').addEventListener('click', function () { finish(false); });
        document.getElementById('cinema-rating-skip').addEventListener('click', function () { finish(false); });
        document.getElementById('cinema-rating-save').addEventListener('click', function () { finish(true); });
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
    function _avatarHTML(isPartner, size) {
        var s = size || 30;
        if (typeof _avEl === 'function') return _avEl(isPartner, s);
        return '<span style="font-size:' + Math.round(s * 0.65) + 'px;">' + (isPartner ? '🌸' : '🙂') + '</span>';
    }
    function _msgHTML(msg) {
        var isPartner = msg.sender === 'partner';
        var bodyHTML;
        if (msg.type === 'image') {
            var isCloudRef = window.CloudMedia && typeof window.CloudMedia.isCloudRef === 'function' && window.CloudMedia.isCloudRef(msg.content);
            // 云端引用（oss://...）不是真实可加载的图片地址，不能直接塞进 src，
            // 否则浏览器会报 net::ERR_UNKNOWN_URL_SCHEME —— 要走 CloudMedia.bindLazyImage
            // 解析成真实签名 URL 后再显示（跟主聊天图片消息用的是同一套机制）
            bodyHTML = isCloudRef
                ? '<div class="cinema-msg-img"><img data-cinema-cloud-ref="' + _escapeHtml(msg.content) + '" alt=""></div>'
                : '<div class="cinema-msg-img"><img src="' + msg.content + '" alt=""></div>';
        } else {
            bodyHTML = '<div class="cinema-msg-bubble">' + _escapeHtml(msg.content) + '</div>';
        }
        var avatarHTML = '<div class="cinema-msg-avatar">' + _avatarHTML(isPartner) + '</div>';
        return '<div class="cinema-msg-row ' + (isPartner ? 'cinema-msg-partner' : 'cinema-msg-mine') + '">' +
            (isPartner ? avatarHTML + bodyHTML : bodyHTML + avatarHTML) +
        '</div>';
    }
    // 扫描容器里带 data-cinema-cloud-ref 的图片，用 CloudMedia 解析成真实 URL
    function _bindCinemaCloudImages(container) {
        if (!container || !window.CloudMedia || typeof window.CloudMedia.bindLazyImage !== 'function') return;
        container.querySelectorAll('img[data-cinema-cloud-ref]').forEach(function (imgEl) {
            var ref = imgEl.getAttribute('data-cinema-cloud-ref');
            imgEl.removeAttribute('data-cinema-cloud-ref');
            window.CloudMedia.bindLazyImage(imgEl, ref);
        });
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
        var newEl = tmp.firstChild;
        area.appendChild(newEl);
        _bindCinemaCloudImages(newEl);
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

        var negoActive = !!(_negoState && _negoState.active);
        var partnerName = (typeof settings !== 'undefined' && settings.partnerName) || '梦角';
        var emptyText = negoActive ? ('邀请已发出，等' + _escapeHtml(partnerName) + '回主聊天里的消息～') : '还没有约定观影';
        var btnHtml = negoActive
            ? '<button class="cinema-invite-btn" id="cinema-invite-btn" disabled>等待' + _escapeHtml(partnerName) + '回复中…</button>'
            : '<button class="cinema-invite-btn" id="cinema-invite-btn">邀请' + _escapeHtml(partnerName) + '一起观影</button>';

        panel.innerHTML =
            _hdHTML() +
            '<div class="cinema-body">' +
                '<div class="cinema-screen-wrap">' +
                    '<div class="cinema-empty-icon"><i class="fas fa-film"></i></div>' +
                    '<div class="cinema-empty-text">' + emptyText + '</div>' +
                '</div>' +
                btnHtml +
                _chatAreaHTML() +
            '</div>';

        if (!negoActive) {
            document.getElementById('cinema-invite-btn').addEventListener('click', _openInviteSheet);
        }
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
            _apptSave();
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
                _apptSave();
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
            var doEnd = function () {
                var watchedTitle = _currentVideo.title || _fakeAppt.movieTitle || '这部电影';
                _endWatchingCleanup();
                _exitTheaterMode();
                _openRatingSheet(watchedTitle);
            };
            _cinemaCenterConfirm('结束观影', '确定要结束观影吗？', '结束观影', doEnd);
        });

        _bindInputBarListeners();
    }

    // ── 统一渲染入口 ─────────────────────────────────────
    function _cinemaRender() {
        if (_uiState === 'empty')        _renderEmpty();
        else if (_uiState === 'waiting') _renderWaiting();
        else if (_uiState === 'watching')_renderWatching();
        _bindCinemaCloudImages(_getPanel());
    }

    // ── 档案页 ───────────────────────────────────────────
    var _archiveTab = 'history'; // 'history' | 'watchlist'
    var _archiveTabsBound = false;

    // 待看清单：独立持久化，跟 period.js 一样用 keys() 扫描避免 SESSION_ID 异步问题
    var _watchlist = [];
    var _wlLoaded = false;
    var _wlStorageKey = null;

    async function _wlGetKey() {
        if (_wlStorageKey) return _wlStorageKey;
        try {
            var allKeys = await localforage.keys();
            var found = allKeys.find(function (k) { return k.indexOf('_cinemaWatchlist') !== -1; });
            if (found) { _wlStorageKey = found; return found; }
            var msgKey = allKeys.find(function (k) { return k.indexOf('_messages') !== -1; });
            var prefix = msgKey ? msgKey.replace('_messages', '') : 'CHAT_APP_V3_';
            _wlStorageKey = prefix + '_cinemaWatchlist';
        } catch (e) {
            _wlStorageKey = 'CHAT_APP_V3__cinemaWatchlist';
        }
        return _wlStorageKey;
    }
    async function _wlLoad() {
        if (_wlLoaded) return;
        try {
            var key = await _wlGetKey();
            var saved = await localforage.getItem(key);
            if (Array.isArray(saved)) _watchlist = saved;
        } catch (e) { console.warn('[cinema] 待看清单加载失败:', e); }
        _wlLoaded = true;
    }
    async function _wlSave() {
        try {
            var key = await _wlGetKey();
            await localforage.setItem(key, _watchlist);
        } catch (e) { console.warn('[cinema] 待看清单保存失败:', e); }
    }

    function _wlAdd(title) {
        title = String(title || '').trim();
        if (!title) return;
        _watchlist.unshift({ id: Date.now() + Math.random(), title: title, watched: false, stars: 0, ts: Date.now() });
        _wlSave();
        _renderWatchlistContent();
    }
    function _wlToggleWatched(id) {
        var item = _watchlist.find(function (w) { return String(w.id) === String(id); });
        if (!item) return;
        item.watched = !item.watched;
        _wlSave();
        _renderWatchlistContent();
    }
    function _wlSetStars(id, stars) {
        var item = _watchlist.find(function (w) { return String(w.id) === String(id); });
        if (!item) return;
        item.stars = stars;
        _wlSave();
        _renderWatchlistContent();
    }
    function _wlDelete(id) {
        var doDelete = function () {
            _watchlist = _watchlist.filter(function (w) { return String(w.id) !== String(id); });
            _wlSave();
            _renderWatchlistContent();
        };
        if (typeof _alShowConfirm === 'function') {
            _alShowConfirm('删除待看', '删除后无法恢复，确定吗？', '删除', true, doDelete);
        } else if (confirm('确定要删除这条待看记录吗？')) {
            doDelete();
        }
    }

    function _wlItemHTML(item) {
        var stars = '';
        for (var i = 1; i <= 5; i++) {
            var filled = i <= (item.stars || 0);
            stars += '<i class="fas fa-star cinema-wl-star' + (filled ? ' filled' : '') + '" data-star="' + i + '"></i>';
        }
        return '<div class="cinema-wl-item' + (item.watched ? ' cinema-wl-watched' : '') + '" data-id="' + item.id + '">' +
            '<div class="cinema-wl-check" data-action="toggle"><i class="fas fa-check"></i></div>' +
            '<div class="cinema-wl-body">' +
                '<div class="cinema-wl-title">' + _escapeHtml(item.title) + '</div>' +
                '<div class="cinema-wl-stars" data-action="stars">' + stars + '</div>' +
            '</div>' +
            '<button class="cinema-wl-delete" data-action="delete"><i class="fas fa-trash-alt"></i></button>' +
        '</div>';
    }
    function _renderWatchlistContent() {
        var content = document.getElementById('cinema-archive-content');
        if (!content) return;
        var listHTML = _watchlist.length
            ? _watchlist.map(_wlItemHTML).join('')
            : '<div class="cinema-archive-empty">暂无待看片单</div>';
        content.innerHTML =
            '<div class="cinema-wl-addrow">' +
                '<input type="text" class="cinema-wl-add-input" id="cinema-wl-add-input" placeholder="想看的片名…" maxlength="60">' +
                '<button class="cinema-wl-add-btn" id="cinema-wl-add-btn"><i class="fas fa-plus"></i></button>' +
            '</div>' +
            '<div class="cinema-wl-list">' + listHTML + '</div>';

        var input = document.getElementById('cinema-wl-add-input');
        var addBtn = document.getElementById('cinema-wl-add-btn');
        function doAdd() {
            _wlAdd(input.value);
            input.value = '';
            input.focus();
        }
        if (addBtn) addBtn.addEventListener('click', doAdd);
        if (input) input.addEventListener('keydown', function (e) { if (e.key === 'Enter') doAdd(); });

        content.querySelectorAll('.cinema-wl-item').forEach(function (el) {
            var id = el.dataset.id;
            var checkEl = el.querySelector('[data-action="toggle"]');
            if (checkEl) checkEl.addEventListener('click', function () { _wlToggleWatched(id); });
            var starsEl = el.querySelector('[data-action="stars"]');
            if (starsEl) {
                starsEl.querySelectorAll('.cinema-wl-star').forEach(function (starEl) {
                    starEl.addEventListener('click', function (e) {
                        e.stopPropagation();
                        _wlSetStars(id, parseInt(starEl.dataset.star, 10));
                    });
                });
            }
            var delEl = el.querySelector('[data-action="delete"]');
            if (delEl) delEl.addEventListener('click', function (e) { e.stopPropagation(); _wlDelete(id); });
        });
    }
    // ── 观看历史：独立持久化（跟待看清单一样的 keys() 扫描方式）──
    var _history = [];
    var _histLoaded = false;
    var _histStorageKey = null;
    var _histEditingId = null;

    async function _histGetKey() {
        if (_histStorageKey) return _histStorageKey;
        try {
            var allKeys = await localforage.keys();
            var found = allKeys.find(function (k) { return k.indexOf('_cinemaHistory') !== -1; });
            if (found) { _histStorageKey = found; return found; }
            var msgKey = allKeys.find(function (k) { return k.indexOf('_messages') !== -1; });
            var prefix = msgKey ? msgKey.replace('_messages', '') : 'CHAT_APP_V3_';
            _histStorageKey = prefix + '_cinemaHistory';
        } catch (e) {
            _histStorageKey = 'CHAT_APP_V3__cinemaHistory';
        }
        return _histStorageKey;
    }
    async function _histLoad() {
        if (_histLoaded) return;
        try {
            var key = await _histGetKey();
            var saved = await localforage.getItem(key);
            if (Array.isArray(saved)) _history = saved;
        } catch (e) { console.warn('[cinema] 观看历史加载失败:', e); }
        _histLoaded = true;
    }
    async function _histSave() {
        try {
            var key = await _histGetKey();
            await localforage.setItem(key, _history);
        } catch (e) { console.warn('[cinema] 观看历史保存失败:', e); }
    }

    function _histFormatDateTime(ts) {
        var d = new Date(ts);
        var h = d.getHours(), m = d.getMinutes();
        return (d.getMonth() + 1) + '月' + d.getDate() + '日 · ' +
            (h < 10 ? '0' + h : h) + ':' + (m < 10 ? '0' + m : m);
    }
    function _histStarsHTML(stars, clickable) {
        var wrapClass = clickable ? 'cinema-hist-stars cinema-hist-stars-clickable' : 'cinema-hist-stars';
        var wrapAttr = clickable ? ' data-action="user-stars"' : '';
        var html = '<span class="' + wrapClass + '"' + wrapAttr + '>';
        for (var i = 1; i <= 5; i++) {
            var filled = i <= (stars || 0);
            html += '<i class="fas fa-star cinema-hist-star' + (filled ? ' filled' : '') + '" data-star="' + i + '"></i>';
        }
        html += '</span>';
        return html;
    }
    // 头像 + 星星一行 + 影评一行（读卡展示用，梦角/用户共用同一个模板）
    function _histPersonBlockHTML(isPartner, name, stars, review, emptyPlaceholder) {
        var reviewHtml = review
            ? '<div class="cinema-hist-review-text">' + _escapeHtml(review) + '</div>'
            : '<div class="cinema-hist-review-empty">' + _escapeHtml(emptyPlaceholder) + '</div>';
        return '<div class="cinema-hist-person">' +
            '<div class="cinema-hist-person-row">' +
                '<div class="cinema-hist-person-avatar">' + _avatarHTML(isPartner, 44) + '</div>' +
                _histStarsHTML(stars, false) +
            '</div>' +
            reviewHtml +
        '</div>';
    }
    function _histEntryHTML(e) {
        var partnerName = (typeof settings !== 'undefined' && settings.partnerName) || '梦角';
        var partnerBlock = _histPersonBlockHTML(true, partnerName, e.partnerStars, e.partnerReview, partnerName + '还没有写影评');
        var userBlock = _histPersonBlockHTML(false, '我', e.userStars, e.userReview, '点击此处添加影评…');
        return '<div class="cinema-hist-entry" data-id="' + e.id + '">' +
            '<div class="cinema-hist-title">' + _escapeHtml(e.title) + '</div>' +
            '<div class="cinema-hist-meta">' + _histFormatDateTime(e.ts) + '</div>' +
            '<div class="cinema-hist-reviews">' + partnerBlock + userBlock + '</div>' +
        '</div>';
    }
    function _renderHistoryContent() {
        var content = document.getElementById('cinema-archive-content');
        if (!content) return;
        if (!_history.length) {
            content.innerHTML = '<div class="cinema-archive-empty">暂无观影记录</div>';
            return;
        }
        var sorted = _history.slice().sort(function (a, b) { return b.ts - a.ts; });
        content.innerHTML = '<div class="cinema-hist-list">' + sorted.map(_histEntryHTML).join('') + '</div>';
        content.querySelectorAll('.cinema-hist-entry').forEach(function (el) {
            el.addEventListener('click', function () { _histOpenEditor(el.dataset.id); });
        });
    }

    // ── 观看历史：编辑弹层（片名 + 我的评价/评分可改，梦角评价只读）──
    function _histOpenEditor(id) {
        var entry = _history.find(function (e) { return String(e.id) === String(id); });
        if (!entry) return;
        _histEditingId = id;
        var partnerName = (typeof settings !== 'undefined' && settings.partnerName) || '梦角';
        var old = document.getElementById('cinema-hist-edit-sheet');
        if (old) old.remove();
        var sheet = document.createElement('div');
        sheet.id = 'cinema-hist-edit-sheet';
        sheet.className = 'cinema-hist-edit-sheet';
        var editUserStars = entry.userStars || 0;
        sheet.innerHTML =
            '<div class="cinema-hist-edit-mask" id="cinema-hist-edit-mask"></div>' +
            '<div class="cinema-hist-edit-body">' +
                '<div class="cinema-hist-edit-label">片名</div>' +
                '<input type="text" class="cinema-hist-edit-input" id="cinema-hist-edit-title" maxlength="60" value="' + _escapeHtml(entry.title) + '">' +
                ((entry.partnerReview || entry.partnerStars > 0)
                    ? '<div class="cinema-hist-edit-label">' + _escapeHtml(partnerName) + '的评价</div>' +
                      '<div class="cinema-hist-edit-readonly">' +
                        _histStarsHTML(entry.partnerStars, false) +
                        (entry.partnerReview ? '<div style="margin-top:6px;">' + _escapeHtml(entry.partnerReview) + '</div>' : '') +
                      '</div>'
                    : '') +
                '<div class="cinema-hist-edit-label">我的评分</div>' +
                '<div id="cinema-hist-edit-stars">' + _histStarsHTML(editUserStars, true) + '</div>' +
                '<div class="cinema-hist-edit-label">我的评价</div>' +
                '<textarea class="cinema-hist-edit-textarea" id="cinema-hist-edit-review" maxlength="200" placeholder="写点什么吧…">' + _escapeHtml(entry.userReview || '') + '</textarea>' +
                '<div class="cinema-hist-edit-actions">' +
                    '<button class="cinema-hist-edit-cancel" id="cinema-hist-edit-cancel">取消</button>' +
                    '<button class="cinema-hist-edit-save" id="cinema-hist-edit-save">保存</button>' +
                '</div>' +
            '</div>';
        document.body.appendChild(sheet);

        var starsWrap = document.getElementById('cinema-hist-edit-stars');
        function refreshStars() {
            starsWrap.innerHTML = _histStarsHTML(editUserStars, true);
            bindStarClicks();
        }
        function bindStarClicks() {
            starsWrap.querySelectorAll('.cinema-hist-star').forEach(function (starEl) {
                starEl.addEventListener('click', function () {
                    editUserStars = parseInt(starEl.dataset.star, 10);
                    refreshStars();
                });
            });
        }
        bindStarClicks();

        function close() { sheet.remove(); _histEditingId = null; }
        document.getElementById('cinema-hist-edit-mask').addEventListener('click', close);
        document.getElementById('cinema-hist-edit-cancel').addEventListener('click', close);
        document.getElementById('cinema-hist-edit-save').addEventListener('click', function () {
            var titleVal = document.getElementById('cinema-hist-edit-title').value.trim();
            var reviewVal = document.getElementById('cinema-hist-edit-review').value.trim();
            if (titleVal) entry.title = titleVal;
            entry.userReview = reviewVal;
            entry.userStars = editUserStars;
            _histSave();
            close();
            _renderHistoryContent();
        });
    }

    // ── 调试专用：注入假观看历史数据，方便预览设计 ──────────
    window._cinemaDebugSeedHistory = function () {
        var now = Date.now();
        var day = 86400000;
        _history = _history.concat([
            { id: now + 1, title: '阿嫚的情书', ts: now - day * 1,  partnerReview: '这段太戳心了，我看哭了', partnerStars: 5, userReview: '结局猜到了但还是很感动', userStars: 4 },
            { id: now + 2, title: '深夜食堂 S01E03', ts: now - day * 3,  partnerReview: '', partnerStars: 3, userReview: '适合睡前看，很治愈', userStars: 4 },
            { id: now + 3, title: 'error.mp4',        ts: now - day * 5,  partnerReview: '这个我们下次再看一遍吧', partnerStars: 0, userReview: '', userStars: 0 },
            { id: now + 4, title: '风起',              ts: now - day * 9,  partnerReview: '摄影很好看', partnerStars: 4, userReview: '剧情有点拖', userStars: 2 }
        ]);
        _histSave();
        if (_archiveTab === 'history') _renderHistoryContent();
        console.log('[cinema] 已注入 4 条假观看历史，当前共', _history.length, '条');
    };
    window._cinemaDebugClearHistory = function () {
        _history = [];
        _histSave();
        if (_archiveTab === 'history') _renderHistoryContent();
        console.log('[cinema] 观看历史已清空');
    };

    function _renderArchiveContent() {
        if (_archiveTab === 'watchlist') _renderWatchlistContent();
        else _renderHistoryContent();
    }
    function _bindArchiveTabsOnce() {
        if (_archiveTabsBound) return;
        _archiveTabsBound = true;
        var historyTab = document.getElementById('cinema-tab-history');
        var watchlistTab = document.getElementById('cinema-tab-watchlist');
        if (historyTab) historyTab.addEventListener('click', function () {
            _archiveTab = 'history';
            historyTab.classList.add('active');
            if (watchlistTab) watchlistTab.classList.remove('active');
            _renderArchiveContent();
        });
        if (watchlistTab) watchlistTab.addEventListener('click', function () {
            _archiveTab = 'watchlist';
            watchlistTab.classList.add('active');
            if (historyTab) historyTab.classList.remove('active');
            _renderArchiveContent();
        });
    }
    function _openArchive() {
        var page = document.getElementById('cinema-archive-page');
        if (page) page.classList.add('cinema-archive-open');
        _bindArchiveTabsOnce();
        Promise.all([_wlLoad(), _histLoad()]).then(function () {
            _renderArchiveContent();
        });
    }
    window._cinemaCloseArchive = function () {
        var page = document.getElementById('cinema-archive-page');
        if (page) page.classList.remove('cinema-archive-open');
    };

    // ── 调试专用：跳过邀请/倒计时，直接切状态（浏览器控制台里手动调用）──
    window._cinemaDebugGoto = function (state) {
        _uiState = state;
        _apptSave();
        _cinemaRender();
    };
    // 把约定时间改成"刚刚"，强制解锁选片按钮（waiting 状态下调用）
    window._cinemaDebugUnlock = function () {
        var now = new Date();
        _fakeAppt.dateStr = now.getFullYear() + '年' + (now.getMonth() + 1) + '月' + now.getDate() + '日';
        _fakeAppt.timeStr = '00:00';
        _apptSave();
        if (_uiState === 'waiting') _renderWaiting();
    };
    // 把约定时间改成 1 小时后，强制锁定选片按钮，方便看倒计时文案
    window._cinemaDebugLock = function () {
        var future = new Date(Date.now() + 3600000);
        _fakeAppt.dateStr = future.getFullYear() + '年' + (future.getMonth() + 1) + '月' + future.getDate() + '日';
        _fakeAppt.timeStr = String(future.getHours()).padStart(2, '0') + ':' + String(future.getMinutes()).padStart(2, '0');
        _apptSave();
        if (_uiState === 'waiting') _renderWaiting();
    };

    // 清空约定状态持久化数据，方便测试（回到最初的"待邀请"）
    window._cinemaDebugResetAppt = function () {
        _uiState = 'empty';
        _fakeAppt = { movieTitle: '阿嫚的情书', dateStr: '2026年8月3日', timeStr: '20:30' };
        _apptSave();
        _cinemaRender();
        console.log('[cinema] 约定状态已重置为 empty');
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
        Promise.all([_apptLoad(), _negoLoad()]).then(function () {
            _cinemaRender();
        });
    };

    // ── 接管 csSwitchTab：切到别的功能 tab 时，如果影日志档案页还开着
    //     （全屏 overlay，z-index:50），必须先关掉，否则会一直挡住其它面板，
    //     导致"点了别的 tab 但页面没有跳转"——跟 anniversary.js 用的是同一套
    //     "包一层 window.csSwitchTab，不改 moments.js 原文件"的写法 ──
    (function () {
        function hookCsSwitchTab() {
            if (typeof window.csSwitchTab !== 'function') {
                setTimeout(hookCsSwitchTab, 100);
                return;
            }
            var orig = window.csSwitchTab;
            window.csSwitchTab = function (tab) {
                if (tab !== 'cinema') {
                    var page = document.getElementById('cinema-archive-page');
                    if (page && page.classList.contains('cinema-archive-open')) {
                        window._cinemaCloseArchive();
                    }
                }
                orig.call(this, tab);
            };
        }
        hookCsSwitchTab();
    })();

    // ── 主聊天里的"电影邀请卡"消息类型 ────────────────────
    // 包一层 window.createMessageFragment（跟上面包 csSwitchTab 同一个原理），
    // 遇到 msg.type === 'cinema-invite' 就渲染邀请卡，其余类型原样交给原函数处理，
    // 完全不用改 core.js。
    //
    // 卡片纯 CSS 画，不依赖图片素材（GitHub Pages 部署那张背景图一直 404，
    // 排查了分支/Jekyll 都没解决，索性直接用代码画一张风格类似但更简洁的卡片）。

    // 卡片有三种状态：
    //   pending   —— 用户刚发出的邀请，靠右，用户头像，没有按钮
    //   countered —— 梦角提议了新时间，靠左，梦角头像，"更换时间"/"接受邀请"两个按钮
    //   accepted  —— 梦角最终同意，靠左，梦角头像，没有按钮，显示"约定成功"
    function _cinemaInviteCardFragment(msg) {
        var data = msg.cinemaInviteData || {};
        var state = data.state || 'countered';
        var isUser = state === 'pending'; // 只有"发出邀请"这个状态是用户说的话，其余都是梦角的回复
        var partnerName = (typeof settings !== 'undefined' && settings.partnerName) || '梦角';
        var actionsHtml;
        if (state === 'pending') {
            actionsHtml = '<div class="cinema-invite-card-status">等待' + _escapeHtml(partnerName) + '回复中…</div>';
        } else if (state === 'accepted') {
            actionsHtml = '<div class="cinema-invite-card-status cinema-invite-card-status--ok">🎉 约定成功</div>';
        } else {
            actionsHtml =
                '<div class="cinema-invite-card-actions">' +
                    '<button class="cinema-invite-card-btn cinema-invite-card-btn--secondary" data-invite-action="reschedule">更换时间</button>' +
                    '<button class="cinema-invite-card-btn cinema-invite-card-btn--primary" data-invite-action="accept">接受邀请</button>' +
                '</div>';
        }
        var fragment = new DocumentFragment();
        // 用真正的 .message-wrapper 结构（跟主聊天普通消息完全一样），
        // 这样自动继承 flex-shrink:0、sent/received 左右镜像、头像位置这些既有布局逻辑，
        // 不用自己再重新发明一套。卡片本身不套 .message 气泡样式，只是内容换成卡片。
        var wrap = document.createElement('div');
        wrap.className = 'message-wrapper ' + (isUser ? 'sent' : 'received') + ' cinema-invite-msg-wrap';
        wrap.dataset.id = msg.id;
        wrap.innerHTML =
            '<div class="message-avatar">' + _avatarHTML(!isUser, 36) + '</div>' +
            '<div class="message-content-wrapper">' +
                '<div class="cinema-invite-card" data-invite-id="' + _escapeHtml(String(data.negoId || '')) + '">' +
                    '<div class="cinema-invite-card-decor">' +
                        '<span class="d1">🍿</span><span class="d2">⭐</span>' +
                        '<span class="d3">🥤</span><span class="d4">💕</span>' +
                    '</div>' +
                    '<div class="cinema-invite-card-banner">CINEMA</div>' +
                    '<div class="cinema-invite-card-movie">' + _escapeHtml(data.movieTitle || '') + '</div>' +
                    '<div class="cinema-invite-card-time">' + _escapeHtml((data.dateStr || '') + '  ' + (data.timeStr || '')) + '</div>' +
                    '<div class="cinema-invite-card-divider"></div>' +
                    actionsHtml +
                '</div>' +
            '</div>';
        fragment.appendChild(wrap);
        return fragment;
    }

    function _hookCreateMessageFragment() {
        function tryHook() {
            if (typeof window.createMessageFragment !== 'function') {
                setTimeout(tryHook, 100);
                return;
            }
            var origFn = window.createMessageFragment;
            window.createMessageFragment = function (msg, prevMsg, nextMsg, lastSenderRef) {
                if (msg && msg.type === 'cinema-invite') {
                    if (lastSenderRef) lastSenderRef.current = (msg.sender === 'user' ? 'user' : 'partner');
                    return _cinemaInviteCardFragment(msg);
                }
                return origFn.apply(this, arguments);
            };
        }
        tryHook();
    }
    _hookCreateMessageFragment();

    // 真正把卡片发到主聊天（跟 envelope.js 一样直接裸调用 addMessage，不用改 core.js）
    // sender 由 state 自动决定：pending 是用户发的，countered/accepted 是梦角发的
    function _cinemaSendInviteCard(state, movieTitle, dateStr, timeStr, negoId) {
        if (typeof addMessage !== 'function') {
            console.warn('[cinema] addMessage 不可用，无法发送邀请卡');
            return;
        }
        var sender = state === 'pending' ? 'user' : 'partner';
        addMessage({
            id: Date.now() + Math.random(),
            sender: sender,
            text: '',
            timestamp: new Date(),
            status: sender === 'user' ? 'sent' : 'received',
            type: 'cinema-invite',
            cinemaInviteData: { state: state, movieTitle: movieTitle, dateStr: dateStr, timeStr: timeStr, negoId: negoId },
            favorited: false,
            note: null
        });
    }

    // ── 邀请协商状态：持久化，跟 tab 开不开无关，app 一启动就会检查 ──
    var _negoState = null; // null=没有进行中的协商；否则见下面结构
    var _negoLoaded = false;
    var _negoStorageKey = null;
    var _negoReplyTimer = null;

    async function _negoGetKey() {
        if (_negoStorageKey) return _negoStorageKey;
        try {
            var allKeys = await localforage.keys();
            var found = allKeys.find(function (k) { return k.indexOf('_cinemaNego') !== -1; });
            if (found) { _negoStorageKey = found; return found; }
            var msgKey = allKeys.find(function (k) { return k.indexOf('_messages') !== -1; });
            var prefix = msgKey ? msgKey.replace('_messages', '') : 'CHAT_APP_V3_';
            _negoStorageKey = prefix + '_cinemaNego';
        } catch (e) {
            _negoStorageKey = 'CHAT_APP_V3__cinemaNego';
        }
        return _negoStorageKey;
    }
    async function _negoLoad() {
        if (_negoLoaded) return;
        _negoLoaded = true;
        try {
            var key = await _negoGetKey();
            var saved = await localforage.getItem(key);
            if (saved && typeof saved === 'object') _negoState = saved;
        } catch (e) { console.warn('[cinema] 协商状态加载失败:', e); }
    }
    async function _negoSave() {
        try {
            var key = await _negoGetKey();
            await localforage.setItem(key, _negoState);
        } catch (e) { console.warn('[cinema] 协商状态保存失败:', e); }
    }
    async function _negoClear() {
        _negoState = null;
        if (_negoReplyTimer) { clearTimeout(_negoReplyTimer); _negoReplyTimer = null; }
        try {
            var key = await _negoGetKey();
            await localforage.removeItem(key);
        } catch (e) { console.warn('[cinema] 协商状态清除失败:', e); }
    }

    // 第几次回复对应的"梦角同意"概率：第1次70%，第2次90%，第3次及以后100%
    function _negoAcceptProbability(replyIndex) {
        if (replyIndex <= 1) return 0.7;
        if (replyIndex === 2) return 0.9;
        return 1;
    }

    // 生成梦角的"换时间"提议：在基准时间前后 2~3 小时内随机取一个点，尽量取整（round 到最近的半小时）
    function _negoGenerateCounterTime(dateStr, timeStr) {
        var m = /(\d+)年(\d+)月(\d+)日/.exec(dateStr || '');
        var t = /(\d+):(\d+)/.exec(timeStr || '');
        var base = (m && t) ? new Date(+m[1], +m[2] - 1, +m[3], +t[1], +t[2], 0, 0) : new Date(Date.now() + 3600000);
        var offsetHours = 2 + Math.random(); // 2~3 小时
        var sign = Math.random() < 0.5 ? -1 : 1;
        var newTime = new Date(base.getTime() + sign * offsetHours * 3600000);
        // 取整到最近的半小时
        var minutes = newTime.getMinutes();
        var roundedMinutes = minutes < 15 ? 0 : (minutes < 45 ? 30 : 60);
        newTime.setMinutes(0, 0, 0);
        if (roundedMinutes === 60) newTime.setHours(newTime.getHours() + 1);
        else newTime.setMinutes(roundedMinutes);
        // 保底：不能早于现在，否则往后推到最近的下一个整/半小时
        if (newTime.getTime() <= Date.now()) {
            newTime = new Date(Date.now() + 3600000);
            var mm = newTime.getMinutes();
            newTime.setMinutes(0, 0, 0);
            if (mm > 30) newTime.setHours(newTime.getHours() + 1);
            else newTime.setMinutes(30);
        }
        return {
            dateStr: newTime.getFullYear() + '年' + (newTime.getMonth() + 1) + '月' + newTime.getDate() + '日',
            timeStr: String(newTime.getHours()).padStart(2, '0') + ':' + String(newTime.getMinutes()).padStart(2, '0')
        };
    }

    // 开始新一轮协商（用户主动邀请，或者用户换时间后重新提议）—— 发"等待中"卡 + 排定梦角的定时回复
    function _negoStartRound(movieTitle, dateStr, timeStr, replyIndex) {
        var negoId = 'nego-' + Date.now();
        _negoState = {
            active: true,
            replyIndex: replyIndex, // 这是梦角接下来要做的第几次回复
            movieTitle: movieTitle,
            dateStr: dateStr,
            timeStr: timeStr,
            replyDueAt: Date.now() + (2 + Math.random() * 3) * 60000, // 2~5 分钟后
            negoId: negoId
        };
        _negoSave();
        _cinemaSendInviteCard('pending', movieTitle, dateStr, timeStr, negoId);
        if (typeof showNotification === 'function') showNotification('邀请已发出', 'success');
        _negoScheduleReply();
    }

    function _negoScheduleReply() {
        if (_negoReplyTimer) { clearTimeout(_negoReplyTimer); _negoReplyTimer = null; }
        if (!_negoState || !_negoState.active) return;
        var delay = _negoState.replyDueAt - Date.now();
        if (delay <= 0) { _negoResolveReply(); return; }
        _negoReplyTimer = setTimeout(_negoResolveReply, delay);
    }

    function _negoResolveReply(forceAccept) {
        if (!_negoState || !_negoState.active) return;
        var accept = (typeof forceAccept === 'boolean') ? forceAccept : (Math.random() < _negoAcceptProbability(_negoState.replyIndex));
        if (accept) {
            _fakeAppt = { movieTitle: _negoState.movieTitle, dateStr: _negoState.dateStr, timeStr: _negoState.timeStr };
            _uiState = 'waiting';
            _apptSave();
            _cinemaSendInviteCard('accepted', _negoState.movieTitle, _negoState.dateStr, _negoState.timeStr, _negoState.negoId);
            _negoClear();
            if (_getPanel()) _cinemaRender();
        } else {
            var newTime = _negoGenerateCounterTime(_negoState.dateStr, _negoState.timeStr);
            _negoState.dateStr = newTime.dateStr;
            _negoState.timeStr = newTime.timeStr;
            _negoState.active = true;
            // replyIndex 不变——它代表"梦角刚做的这次回复是第几次"，用户看到后如果换时间，
            // 下一次梦角回复时 replyIndex 才 +1（见 reschedule 按钮的处理）
            _negoSave();
            _cinemaSendInviteCard('countered', _negoState.movieTitle, _negoState.dateStr, _negoState.timeStr, _negoState.negoId);
        }
    }

    // 卡片按钮：接受梦角提议的时间
    function _negoAcceptCountered() {
        if (!_negoState || !_negoState.active) return;
        _fakeAppt = { movieTitle: _negoState.movieTitle, dateStr: _negoState.dateStr, timeStr: _negoState.timeStr };
        _uiState = 'waiting';
        _apptSave();
        _cinemaSendInviteCard('accepted', _negoState.movieTitle, _negoState.dateStr, _negoState.timeStr, _negoState.negoId);
        _negoClear();
        if (_getPanel()) _cinemaRender();
    }

    // 卡片按钮：用户不想要梦角提议的时间，自己重新选一个（打开居中弹窗）
    function _negoOpenRescheduleModal() {
        if (!_negoState || !_negoState.active) return;
        var old = document.getElementById('cinema-reschedule-modal');
        if (old) old.remove();
        var now = new Date();
        var defaultDate = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
        var later = new Date(now.getTime() + 3600000);
        var defaultTime = String(later.getHours()).padStart(2, '0') + ':' + String(later.getMinutes()).padStart(2, '0');

        var modal = document.createElement('div');
        modal.id = 'cinema-reschedule-modal';
        modal.className = 'cinema-invite-sheet';
        modal.innerHTML =
            '<div class="cinema-invite-mask" id="cinema-reschedule-mask"></div>' +
            '<div class="cinema-invite-body">' +
                '<div class="cinema-invite-title">换个时间</div>' +
                '<div class="cinema-invite-label">日期</div>' +
                '<input type="date" class="cinema-invite-input" id="cinema-reschedule-date" min="' + defaultDate + '" value="' + defaultDate + '">' +
                '<div class="cinema-invite-label">时间</div>' +
                '<input type="time" class="cinema-invite-input" id="cinema-reschedule-time" value="' + defaultTime + '">' +
                '<div class="cinema-invite-error" id="cinema-reschedule-error"></div>' +
                '<div class="cinema-invite-actions">' +
                    '<button class="cinema-invite-cancel" id="cinema-reschedule-cancel">取消</button>' +
                    '<button class="cinema-invite-confirm" id="cinema-reschedule-confirm">发出新时间</button>' +
                '</div>' +
            '</div>';
        document.body.appendChild(modal);

        function close() { modal.remove(); }
        document.getElementById('cinema-reschedule-mask').addEventListener('click', close);
        document.getElementById('cinema-reschedule-cancel').addEventListener('click', close);
        document.getElementById('cinema-reschedule-confirm').addEventListener('click', function () {
            var dateVal = document.getElementById('cinema-reschedule-date').value;
            var timeVal = document.getElementById('cinema-reschedule-time').value;
            var errorEl = document.getElementById('cinema-reschedule-error');
            var dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateVal || '');
            var tm = /^(\d{2}):(\d{2})$/.exec(timeVal || '');
            if (!dm || !tm) return;
            var picked = new Date(+dm[1], +dm[2] - 1, +dm[3], +tm[1], +tm[2], 0, 0);
            if (picked.getTime() <= Date.now()) {
                errorEl.textContent = '约的时间不能早于现在，改一下吧';
                return;
            }
            var newDateStr = (+dm[1]) + '年' + (+dm[2]) + '月' + (+dm[3]) + '日';
            var newTimeStr = timeVal;
            close();
            // 用户重新提议时间 → 梦角下一次回复的"第几次"要 +1（比如梦角第1次换时间后，
            // 用户重选，梦角第2次回复概率是90%）
            var nextReplyIndex = (_negoState ? _negoState.replyIndex : 1) + 1;
            _negoStartRound(_negoState.movieTitle, newDateStr, newTimeStr, nextReplyIndex);
        });
    }

    // 主聊天里邀请卡按钮的事件委托（卡片是动态插入主聊天的，绑定在 document 上）
    function _bindInviteCardDelegation() {
        document.addEventListener('click', function (e) {
            var btn = e.target.closest && e.target.closest('[data-invite-action]');
            if (!btn) return;
            var card = btn.closest('.cinema-invite-card');
            if (!card) return;
            var negoId = card.getAttribute('data-invite-id');
            if (!_negoState || _negoState.negoId !== negoId) return; // 已经是过期的卡片，不响应
            var action = btn.getAttribute('data-invite-action');
            if (action === 'accept') _negoAcceptCountered();
            else if (action === 'reschedule') _negoOpenRescheduleModal();
        });
    }
    _bindInviteCardDelegation();

    // ── app 启动时检查：如果有正在进行的协商，恢复定时器（哪怕中途关过 app）──
    function _negoBootCheck() {
        _negoLoad().then(function () {
            if (_negoState && _negoState.active) _negoScheduleReply();
        });
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _negoBootCheck);
    } else {
        setTimeout(_negoBootCheck, 0);
    }

    // ── 调试专用 ──────────────────────────────────────────
    window._cinemaDebugSendInviteCard = function (movieTitle, dateStr, timeStr) {
        _cinemaSendInviteCard('countered', movieTitle || '阿嫊的情书', dateStr || '2026年8月3日', timeStr || '20:30', 'debug-' + Date.now());
        console.log('[cinema] 测试邀请卡已发送到主聊天（countered 状态，两个按钮不会真正生效，仅看样式）');
    };
    window._cinemaDebugNegoStatus = function () {
        console.log('[cinema] 当前协商状态:', _negoState);
        return _negoState;
    };
    window._cinemaDebugForceReply = function () {
        if (!_negoState || !_negoState.active) { console.log('[cinema] 目前没有进行中的协商'); return; }
        if (_negoReplyTimer) { clearTimeout(_negoReplyTimer); _negoReplyTimer = null; }
        _negoResolveReply();
        console.log('[cinema] 已强制触发梦角回复（走真实概率，可能同意也可能换时间）');
    };
    // 强制这一次回复一定是"换时间"，方便测试改时间的弹窗，不用反复重试等运气
    window._cinemaDebugForceCounter = function () {
        if (!_negoState || !_negoState.active) { console.log('[cinema] 目前没有进行中的协商'); return; }
        if (_negoReplyTimer) { clearTimeout(_negoReplyTimer); _negoReplyTimer = null; }
        _negoResolveReply(false);
        console.log('[cinema] 已强制触发"换时间"，去主聊天看新的邀请卡');
    };
    // 强制这一次回复一定是"同意"，方便测试约定成功的流程
    window._cinemaDebugForceAccept = function () {
        if (!_negoState || !_negoState.active) { console.log('[cinema] 目前没有进行中的协商'); return; }
        if (_negoReplyTimer) { clearTimeout(_negoReplyTimer); _negoReplyTimer = null; }
        _negoResolveReply(true);
        console.log('[cinema] 已强制触发"同意"');
    };

})();
