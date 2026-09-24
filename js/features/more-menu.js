/* ============================================================
   更多菜单（输入区 "+" 按钮）框架 v2
   - 微信同款交互：点"+"在输入框下方展开一整块网格面板（不是浮层），
     推开聊天区域，不盖在消息上面
   - 输入框一旦有文字，"+"自动换成"发送"，跟微信一样
   - 已实现的功能项：直接执行 action
   - 未开发的功能项：统一走 showNotification 弹"开发中"提示
   - 后续开发红包/位置共享等功能时，直接调用 window.MoreMenu.registerItem()
     把对应项从"占位"升级成"真实功能"，不需要再碰这个文件的面板/切换逻辑
   ============================================================ */

(function () {
    // 图标里 emoji 优先于 iconClass（emoji 更容易一眼分辨，比如红包用 🧧 而不是信封，
    // 避免跟信箱功能的信封图标混淆）；iconClass 支持传完整的 class 字符串（包括 fab 品牌图标）
    const MORE_MENU_ITEMS = [
        {
            id: 'image',
            iconClass: 'fas fa-image',
            label: '图片',
            ready: true,
            action: function () {
                const input = document.getElementById('image-input');
                if (input) input.click();
            }
        },
        { id: 'redpacket', iconClass: 'fas fa-gift', label: '红包', ready: false },
        {
            id: 'videocall',
            iconClass: 'fas fa-video',
            label: '视频通话',
            ready: true,
            action: function () {
                if (window.callFeature && typeof window.callFeature.startCall === 'function') {
                    window.callFeature.startCall(false);
                }
            }
        },
        { id: 'location', iconClass: 'fas fa-location-dot', label: '位置', ready: false },
        {
            id: 'batch',
            iconClass: 'fas fa-layer-group',
            label: '批量发送',
            ready: true,
            action: function () {
                if (typeof toggleBatchMode === 'function') toggleBatchMode();
            }
        },
        { id: 'xiaohongshu', iconClass: 'fas fa-book', label: '小红书', ready: false },
        { id: 'douyin', iconClass: 'fab fa-tiktok', label: '抖音', ready: false },
        { id: 'qa', iconClass: 'fas fa-comments', label: '快问快答', ready: false }
    ];

    function getPanel() { return document.getElementById('more-menu-panel'); }
    function getPlusBtn() { return document.getElementById('more-menu-btn'); }
    function getSendBtn() { return document.getElementById('send-btn'); }
    function getInput() { return document.getElementById('message-input'); }

    function closeMoreMenu() {
        const panel = getPanel(), btn = getPlusBtn();
        if (panel) {
            panel.classList.remove('active');
            clearTimeout(panel._hideTimer);
            panel._hideTimer = setTimeout(function () {
                if (!panel.classList.contains('active')) panel.style.display = 'none';
            }, 220);
        }
        if (btn) btn.classList.remove('active');
    }

    function openMoreMenu() {
        const panel = getPanel(), btn = getPlusBtn();
        if (!panel || !btn) return;
        // 跟输入区其它弹层（表情/拍一拍、收纳面板）互斥，避免叠在一起
        try {
            document.getElementById('user-sticker-picker')?.classList.remove('active');
            const extrasPanel = document.getElementById('collapsed-extras-panel');
            if (extrasPanel) extrasPanel.style.display = 'none';
            document.getElementById('collapse-expand-btn')?.classList.remove('open');
        } catch (e) {}
        // 跟微信一样：展开面板前先收起软键盘，把屏幕空间让给图标网格
        const input = getInput();
        if (input) input.blur();
        clearTimeout(panel._hideTimer);
        panel.style.display = 'block';
        requestAnimationFrame(function () { panel.classList.add('active'); });
        btn.classList.add('active');
    }

    function toggleMoreMenu() {
        const panel = getPanel();
        if (panel && panel.classList.contains('active')) closeMoreMenu();
        else openMoreMenu();
    }

    function renderMoreMenu() {
        const panel = getPanel();
        if (!panel) return;
        const gridHTML = MORE_MENU_ITEMS.map(function (item) {
            const iconHTML = item.emoji
                ? '<span class="more-menu-emoji">' + item.emoji + '</span>'
                : '<i class="' + item.iconClass + '"></i>';
            return (
                '<button class="more-menu-item' + (item.ready ? '' : ' disabled') + '" data-id="' + item.id + '" title="' + item.label + '">' +
                '<span class="more-menu-icon">' + iconHTML + '</span>' +
                '<span class="more-menu-label">' + item.label + '</span>' +
                '</button>'
            );
        }).join('');
        panel.innerHTML = '<div class="more-menu-grid">' + gridHTML + '</div>';

        panel.querySelectorAll('.more-menu-item').forEach(function (btnEl) {
            btnEl.addEventListener('click', function () {
                const item = MORE_MENU_ITEMS.find(function (i) { return i.id === btnEl.dataset.id; });
                closeMoreMenu();
                if (!item) return;
                if (item.ready && typeof item.action === 'function') {
                    item.action();
                } else if (typeof showNotification === 'function') {
                    showNotification('「' + item.label + '」功能开发中，敬请期待～', 'info', 2200);
                }
            });
        });
    }

    // 供后续开发（红包等）把占位项升级为真实功能，不用改这个文件的面板/切换逻辑
    function registerItem(id, patch) {
        const item = MORE_MENU_ITEMS.find(function (i) { return i.id === id; });
        if (!item) return;
        Object.assign(item, patch);
        renderMoreMenu();
    }

    // "+" 和 "发送" 二选一：输入框有内容时显示发送，没内容时显示"+"（跟微信一样）
    function syncTrailingButton() {
        const input = getInput(), plusBtn = getPlusBtn(), sendBtn = getSendBtn();
        if (!input || !plusBtn || !sendBtn) return;
        const hasText = input.value.trim().length > 0;
        plusBtn.style.display = hasText ? 'none' : 'flex';
        sendBtn.style.display = hasText ? 'flex' : 'none';
        if (hasText) closeMoreMenu();
    }

    document.addEventListener('DOMContentLoaded', function () {
        renderMoreMenu();
        syncTrailingButton();

        const plusBtn = getPlusBtn();
        if (plusBtn) {
            plusBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                toggleMoreMenu();
            });
        }

        const input = getInput();
        if (input) {
            input.addEventListener('input', syncTrailingButton);
            // 聚焦输入框时（唤起软键盘）收起"更多"面板，避免面板和键盘抢屏幕
            input.addEventListener('focus', closeMoreMenu);
        }

        // 点击面板/输入区以外的地方自动收起
        document.addEventListener('click', function (e) {
            const panel = getPanel(), btn2 = getPlusBtn();
            if (!panel || !panel.classList.contains('active')) return;
            if (panel.contains(e.target) || (btn2 && btn2.contains(e.target))) return;
            closeMoreMenu();
        });
    });

    window.MoreMenu = {
        open: openMoreMenu,
        close: closeMoreMenu,
        toggle: toggleMoreMenu,
        registerItem: registerItem,
        syncTrailingButton: syncTrailingButton
    };
})();
