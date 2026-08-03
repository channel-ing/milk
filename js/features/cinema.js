/**
 * cinema.js — 电影院功能 Step 1（UI骨架 + 假数据）
 */
(function () {
    'use strict';

    // ── 当前UI状态（Step1用假数据演示）──────────────────────
    // 'empty'   : 无约定（默认）
    // 'waiting' : 有约定待履行（含倒计时）
    // 'watching': 观影中
    var _uiState = 'empty';

    // ── 假数据（Step1演示用，Step2替换为真实存取）─────────────
    var _fakeAppt = {
        movieTitle: '阿嫚的情书',
        dateStr: '2026年8月3日',
        timeStr: '20:30',
        initiatedByPartner: false   // false=用户发起，true=梦角发起
    };

    // ── 主面板根元素 ────────────────────────────────────────
    function _getPanel() {
        return document.getElementById('cs-panel-cinema');
    }

    // ── 渲染：空状态 ────────────────────────────────────────
    function _renderEmpty() {
        var panel = _getPanel();
        if (!panel) return;

        panel.innerHTML =
            '<div class="cinema-hd">' +
                '<span class="cinema-hd-title">电影院</span>' +
                '<button class="cs-icon-btn" id="cinema-archive-btn" title="影日志">' +
                    '<i class="fas fa-ticket-alt"></i>' +
                '</button>' +
            '</div>' +
            '<div class="cinema-body">' +
                '<div class="cinema-state-area" id="cinema-state-area">' +
                    '<div class="cinema-empty">' +
                        '<div class="cinema-empty-icon"><i class="fas fa-film"></i></div>' +
                        '<div class="cinema-empty-text">还没有约定观影</div>' +
                        '<button class="cinema-invite-btn" id="cinema-invite-btn">邀请梦角一起观影</button>' +
                    '</div>' +
                '</div>' +
                '<div class="cinema-chat-area" id="cinema-chat-area">' +
                    '<div class="cinema-chat-placeholder">聊天界面，跟主界面聊天一样</div>' +
                '</div>' +
            '</div>' +
            '<div class="cinema-input-bar">' +
                '<div class="cinema-input-placeholder">输入框</div>' +
            '</div>';

        document.getElementById('cinema-invite-btn').addEventListener('click', function () {
            // Step3实现完整约片流程，Step1仅演示
            _uiState = 'waiting';
            _cinemaRender();
        });

        document.getElementById('cinema-archive-btn').addEventListener('click', function () {
            _openArchive();
        });
    }

    // ── 渲染：有约定（等待中）────────────────────────────────
    function _renderWaiting() {
        var panel = _getPanel();
        if (!panel) return;

        panel.innerHTML =
            '<div class="cinema-hd">' +
                '<span class="cinema-hd-title">电影院</span>' +
                '<button class="cs-icon-btn" id="cinema-archive-btn" title="影日志">' +
                    '<i class="fas fa-ticket-alt"></i>' +
                '</button>' +
            '</div>' +
            '<div class="cinema-body">' +
                '<div class="cinema-state-area" id="cinema-state-area">' +
                    '<div class="cinema-appt-card">' +
                        '<div class="cinema-appt-badge">约定待履行</div>' +
                        '<div class="cinema-appt-movie">' + _fakeAppt.movieTitle + '</div>' +
                        '<div class="cinema-appt-time">' + _fakeAppt.dateStr + '&nbsp;&nbsp;' + _fakeAppt.timeStr + '</div>' +
                        '<div class="cinema-appt-actions">' +
                            '<button class="cinema-cancel-btn" id="cinema-cancel-btn">取消约定</button>' +
                            '<button class="cinema-start-btn" id="cinema-start-btn">选择影片并开始</button>' +
                        '</div>' +
                    '</div>' +
                '</div>' +
                '<div class="cinema-chat-area" id="cinema-chat-area">' +
                    '<div class="cinema-chat-placeholder">聊天界面，跟主界面聊天一样</div>' +
                '</div>' +
            '</div>' +
            '<div class="cinema-input-bar">' +
                '<div class="cinema-input-placeholder">输入框</div>' +
            '</div>';

        document.getElementById('cinema-cancel-btn').addEventListener('click', function () {
            _uiState = 'empty';
            _cinemaRender();
        });

        document.getElementById('cinema-start-btn').addEventListener('click', function () {
            // Step2实现文件选择，Step1仅演示跳转
            _uiState = 'watching';
            _cinemaRender();
        });

        document.getElementById('cinema-archive-btn').addEventListener('click', function () {
            _openArchive();
        });
    }

    // ── 渲染：观影中 ─────────────────────────────────────────
    function _renderWatching() {
        var panel = _getPanel();
        if (!panel) return;

        panel.innerHTML =
            '<div class="cinema-player-wrap">' +
                '<video id="cinema-video" class="cinema-video" controls>' +
                    '<source src="" type="video/mp4">' +
                    '您的浏览器不支持视频播放' +
                '</video>' +
                '<div class="cinema-video-overlay" id="cinema-video-overlay">' +
                    '<div class="cinema-video-placeholder"><i class="fas fa-play-circle"></i><p>请先选择影片文件</p></div>' +
                '</div>' +
            '</div>' +
            '<div class="cinema-watch-toolbar">' +
                '<button class="cinema-tool-btn" id="cinema-change-film-btn">' +
                    '<i class="fas fa-exchange-alt"></i> 换片' +
                '</button>' +
                '<span class="cinema-watch-title" id="cinema-watch-title">' + _fakeAppt.movieTitle + '</span>' +
                '<button class="cinema-tool-btn cinema-tool-end" id="cinema-end-btn">' +
                    '<i class="fas fa-stop-circle"></i> 结束观影' +
                '</button>' +
            '</div>' +
            '<div class="cinema-body cinema-body-watch">' +
                '<div class="cinema-chat-area" id="cinema-chat-area">' +
                    '<div class="cinema-chat-placeholder">聊天界面，跟主界面聊天一样</div>' +
                '</div>' +
            '</div>' +
            '<div class="cinema-input-bar">' +
                '<div class="cinema-input-placeholder">输入框</div>' +
            '</div>' +
            '<input type="file" id="cinema-file-input" accept="video/*" style="display:none;">';

        document.getElementById('cinema-change-film-btn').addEventListener('click', function () {
            document.getElementById('cinema-file-input').click();
        });

        document.getElementById('cinema-file-input').addEventListener('change', function (e) {
            var file = e.target.files[0];
            if (!file) return;
            var video = document.getElementById('cinema-video');
            var overlay = document.getElementById('cinema-video-overlay');
            var titleEl = document.getElementById('cinema-watch-title');
            var url = URL.createObjectURL(file);
            video.src = url;
            video.play();
            if (overlay) overlay.style.display = 'none';
            // 用文件名作片名（去掉扩展名）
            var name = file.name.replace(/\.[^.]+$/, '');
            if (titleEl) titleEl.textContent = name;
        });

        document.getElementById('cinema-end-btn').addEventListener('click', function () {
            // Step4实现纪念卡，Step1仅返回空状态
            var video = document.getElementById('cinema-video');
            if (video && video.src) {
                URL.revokeObjectURL(video.src);
            }
            _uiState = 'empty';
            _cinemaRender();
        });
    }

    // ── 统一渲染入口 ─────────────────────────────────────────
    function _cinemaRender() {
        if (_uiState === 'empty') {
            _renderEmpty();
        } else if (_uiState === 'waiting') {
            _renderWaiting();
        } else if (_uiState === 'watching') {
            _renderWatching();
        }
    }

    // ── 档案页（Step4完善，Step1仅骨架）────────────────────
    function _openArchive() {
        var page = document.getElementById('cinema-archive-page');
        if (page) {
            page.classList.add('cinema-archive-open');
        }
    }

    window._cinemaCloseArchive = function () {
        var page = document.getElementById('cinema-archive-page');
        if (page) {
            page.classList.remove('cinema-archive-open');
        }
    };

    // ── 对外暴露初始化 ───────────────────────────────────────
    window._cinemaInit = function () {
        _cinemaRender();
    };

})();
