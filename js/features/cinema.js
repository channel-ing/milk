/**
 * cinema.js — 电影院功能 Step 1 v2
 */
(function () {
    'use strict';

    var _uiState = 'empty'; // 'empty' | 'waiting' | 'watching'

    var _fakeAppt = {
        movieTitle: '阿嫚的情书',
        dateStr: '2026年8月3日',
        timeStr: '20:30'
    };

    function _getPanel() {
        return document.getElementById('cs-panel-cinema');
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

    // ── 公共聊天区 + 输入栏 HTML ─────────────────────────
    function _chatHTML() {
        return '<div class="cinema-chat-area" id="cinema-chat-area">' +
                '<div class="cinema-chat-empty">' +
                    '<i class="far fa-comment-dots"></i>' +
                    '<p>暂无聊天记录</p>' +
                '</div>' +
            '</div>' +
            '<div class="cinema-input-bar">' +
                '<input type="text" class="cinema-input-field" placeholder="说点什么吧…">' +
                '<button class="cinema-chat-btn" title="表情包"><i class="far fa-smile"></i></button>' +
                '<button class="cinema-chat-btn" title="图片"><i class="far fa-image"></i></button>' +
            '</div>';
    }

    // ── 渲染：空状态 ────────────────────────────────────
    function _renderEmpty() {
        var panel = _getPanel();
        if (!panel) return;

        panel.innerHTML =
            _hdHTML() +
            '<div class="cinema-body">' +
                '<div class="cinema-screen-wrap">' +
                    '<div class="cinema-empty-icon"><i class="fas fa-film"></i></div>' +
                    '<div class="cinema-empty-text">还没有约定观影</div>' +
                    '<button class="cinema-invite-btn" id="cinema-invite-btn">邀请梦角一起观影</button>' +
                '</div>' +
                _chatHTML() +
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

        panel.innerHTML =
            _hdHTML() +
            '<div class="cinema-body">' +
                '<div class="cinema-appt-card">' +
                    '<div class="cinema-appt-badge">约定待履行</div>' +
                    '<div class="cinema-appt-movie">' + _fakeAppt.movieTitle + '</div>' +
                    '<div class="cinema-appt-time">' + _fakeAppt.dateStr + '&nbsp;&nbsp;' + _fakeAppt.timeStr + '</div>' +
                    '<div class="cinema-appt-actions">' +
                        '<button class="cinema-cancel-btn" id="cinema-cancel-btn">取消约定</button>' +
                        '<button class="cinema-start-btn" id="cinema-start-btn">选择影片并开始</button>' +
                    '</div>' +
                '</div>' +
                _chatHTML() +
            '</div>';

        document.getElementById('cinema-cancel-btn').addEventListener('click', function () {
            _uiState = 'empty';
            _cinemaRender();
        });
        document.getElementById('cinema-start-btn').addEventListener('click', function () {
            _uiState = 'watching';
            _cinemaRender();
        });
        document.getElementById('cinema-archive-btn').addEventListener('click', _openArchive);
    }

    // ── 渲染：观影中 ─────────────────────────────────────
    function _renderWatching() {
        var panel = _getPanel();
        if (!panel) return;

        panel.innerHTML =
            '<div class="cinema-player-wrap">' +
                '<video id="cinema-video" class="cinema-video" controls>' +
                    '<source src="" type="video/mp4">' +
                '</video>' +
                '<div class="cinema-video-overlay" id="cinema-video-overlay">' +
                    '<div class="cinema-video-placeholder">' +
                        '<i class="fas fa-play-circle"></i>' +
                        '<p>请选择影片文件</p>' +
                    '</div>' +
                '</div>' +
            '</div>' +
            '<div class="cinema-watch-toolbar">' +
                '<button class="cinema-tool-btn" id="cinema-change-film-btn"><i class="fas fa-exchange-alt"></i> 换片</button>' +
                '<span class="cinema-watch-title" id="cinema-watch-title">' + _fakeAppt.movieTitle + '</span>' +
                '<button class="cinema-tool-btn cinema-tool-end" id="cinema-end-btn"><i class="fas fa-stop-circle"></i> 结束观影</button>' +
            '</div>' +
            '<div class="cinema-body cinema-body-watch">' +
                _chatHTML() +
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
            video.src = URL.createObjectURL(file);
            video.play();
            if (overlay) overlay.style.display = 'none';
            if (titleEl) titleEl.textContent = file.name.replace(/\.[^.]+$/, '');
        });
        document.getElementById('cinema-end-btn').addEventListener('click', function () {
            var video = document.getElementById('cinema-video');
            if (video && video.src.startsWith('blob:')) URL.revokeObjectURL(video.src);
            _uiState = 'empty';
            _cinemaRender();
        });
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
        _cinemaRender();
    };

})();
