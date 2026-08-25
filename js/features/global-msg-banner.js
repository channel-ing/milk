/**
 * global-msg-banner.js — 全局新消息推送横条（微信风格）
 *
 * 需求：梦角在主聊天发新消息时，只要用户不在下面这三种情况里，就在当前页面顶部弹一条横条：
 *   1）用户当前就在主聊天本身（消息本来就实时显示在眼前，不需要再弹）
 *   2）陪伴模式（陪伴页里本来就会同步显示气泡）
 *   3）电影院沉浸模式（全屏剧场，本来就在这个聊天场景里）
 * 点一下横条：关掉当前打开的情侣空间页面，跳回主聊天并滚动到最新消息。
 *
 * 挂载方式：走 core.js 里已有的 window._registerPartnerMessageListener 钩子——
 * 这个钩子只对"梦角发的普通文字消息"触发（message.type === 'normal'），
 * 图片/语音等类型的梦角消息目前不会经过这个钩子，横条也就不会为那些类型弹出，
 * 这是钩子本身的既有范围，不在这个文件里改动。
 */
(function () {
    'use strict';

    var _banner = null;
    var _hideTimer = null;

    function _ensureBanner() {
        if (_banner) return _banner;
        _banner = document.createElement('div');
        _banner.className = 'gmb-banner';
        _banner.id = 'gmb-banner';
        _banner.innerHTML =
            '<div class="gmb-avatar" id="gmb-avatar"></div>' +
            '<div class="gmb-body">' +
                '<div class="gmb-name" id="gmb-name"></div>' +
                '<div class="gmb-text" id="gmb-text"></div>' +
            '</div>';
        document.body.appendChild(_banner);
        _banner.addEventListener('click', _onTap);
        return _banner;
    }

    // 判断当前是不是"不需要弹"的三种情况之外——只有情侣空间页面打开着、且不是电影院沉浸模式时才弹。
    // 情侣空间没打开＝主聊天本身就是当前可见页面，不用弹；companion-page.active＝陪伴模式，不用弹；
    // 情侣空间开着但同时是 cinema-theater-mode（沉浸剧场）也不用弹。
    function _shouldShow() {
        var companionPage = document.getElementById('companion-page');
        if (companionPage && companionPage.classList.contains('active')) return false;
        var csPage = document.getElementById('couple-space-page');
        if (!csPage || !csPage.classList.contains('cs-open')) return false;
        if (csPage.classList.contains('cinema-theater-mode')) return false;
        return true;
    }

    function _previewText(msg) {
        var t = (msg && msg.text) ? String(msg.text).replace(/\n/g, ' ').trim() : '';
        if (!t) return (msg && msg.image) ? '[图片]' : '';
        return t.length > 24 ? t.slice(0, 24) + '…' : t;
    }

    function _hide() {
        if (_banner) _banner.classList.remove('gmb-show');
    }

    function _onTap() {
        clearTimeout(_hideTimer);
        _hide();
        if (typeof window.closeCoupleSpace === 'function') window.closeCoupleSpace();
        // closeCoupleSpace 内部关闭动画是 380ms，等它跑完再回到底部，避免动画进行中跳转看起来很突兀
        setTimeout(function () {
            if (typeof window._backToLatestMessages === 'function') window._backToLatestMessages();
        }, 400);
    }

    function _show(msg) {
        var banner = _ensureBanner();
        var partnerName = (typeof settings !== 'undefined' && settings.partnerName) || '对方';
        banner.querySelector('#gmb-name').textContent = partnerName;
        banner.querySelector('#gmb-text').textContent = _previewText(msg);

        var avatarEl = banner.querySelector('#gmb-avatar');
        var srcImg = document.querySelector('#partner-avatar img');
        avatarEl.innerHTML = (srcImg && srcImg.src)
            ? '<img src="' + srcImg.src + '">'
            : '<i class="fas fa-user"></i>';

        clearTimeout(_hideTimer);
        // 先摘掉再加回去，保证连续收到好几条消息时，每次都能重新触发一次入场动画，不会因为已经是
        // active 状态而"静默换内容"，用户很容易漏看
        banner.classList.remove('gmb-show');
        requestAnimationFrame(function () {
            requestAnimationFrame(function () {
                banner.classList.add('gmb-show');
            });
        });
        _hideTimer = setTimeout(_hide, 4000);
    }

    if (typeof window._registerPartnerMessageListener === 'function') {
        window._registerPartnerMessageListener(function (msg) {
            if (!msg || msg.sender === 'user') return;
            if (!_shouldShow()) return;
            _show(msg);
        });
    } else {
        console.warn('[global-msg-banner] window._registerPartnerMessageListener 不存在，新消息横条功能不会生效（core.js 是否正常加载？）');
    }
})();
