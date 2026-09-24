/* ============================================================
   更多菜单（输入区 “+” 按钮）框架
   - 已实现的功能项：直接执行 action
   - 未开发的功能项：统一走 showNotification 弹"开发中"提示
   - 后续开发红包/位置共享等功能时，直接调用 window.MoreMenu.registerItem()
     把对应项从"占位"升级成"真实功能"，不需要再碰这个文件的弹层/关闭逻辑
   ============================================================ */

(function () {
    // 占位菜单项，按文档《加号菜单功能全景》里的顺序排列
    const MORE_MENU_ITEMS = [
        {
            id: 'image',
            icon: 'fa-image',
            label: '图片',
            ready: true,
            action: function () {
                const input = document.getElementById('image-input');
                if (input) input.click();
            }
        },
        { id: 'redpacket', icon: 'fa-envelope-open-text', label: '红包', ready: false },
        { id: 'location', icon: 'fa-location-dot', label: '位置', ready: false },
        { id: 'xiaohongshu', icon: 'fa-heart', label: '小红书', ready: false },
        { id: 'douyin', icon: 'fa-music', label: '抖音', ready: false },
        { id: 'qa', icon: 'fa-comments', label: '快问快答', ready: false }
    ];

    function getPanel() { return document.getElementById('more-menu-panel'); }
    function getBtn() { return document.getElementById('more-menu-btn'); }

    function closeMoreMenu() {
        const panel = getPanel(), btn = getBtn();
        if (panel) panel.classList.remove('active');
        if (btn) btn.classList.remove('active');
    }

    function openMoreMenu() {
        const panel = getPanel(), btn = getBtn();
        if (!panel || !btn) return;
        // 跟输入区其它弹层（表情/拍一拍、收纳面板）互斥，避免叠在一起
        try {
            document.getElementById('user-sticker-picker')?.classList.remove('active');
            const extrasPanel = document.getElementById('collapsed-extras-panel');
            if (extrasPanel) extrasPanel.style.display = 'none';
            document.getElementById('collapse-expand-btn')?.classList.remove('open');
        } catch (e) {}
        panel.classList.add('active');
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
        panel.innerHTML = MORE_MENU_ITEMS.map(function (item) {
            return (
                '<button class="more-menu-item' + (item.ready ? '' : ' disabled') + '" data-id="' + item.id + '" title="' + item.label + '">' +
                '<span class="more-menu-icon"><i class="fas ' + item.icon + '"></i></span>' +
                '<span class="more-menu-label">' + item.label + '</span>' +
                '</button>'
            );
        }).join('');

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

    // 供后续开发（红包等）把占位项升级为真实功能，不用改这个文件的弹层逻辑
    function registerItem(id, patch) {
        const item = MORE_MENU_ITEMS.find(function (i) { return i.id === id; });
        if (!item) return;
        Object.assign(item, patch);
        renderMoreMenu();
    }

    document.addEventListener('DOMContentLoaded', function () {
        renderMoreMenu();
        const btn = getBtn();
        if (btn) {
            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                toggleMoreMenu();
            });
        }
        // 点击面板外部自动收起
        document.addEventListener('click', function (e) {
            const panel = getPanel(), btn2 = getBtn();
            if (!panel || !panel.classList.contains('active')) return;
            if (panel.contains(e.target) || (btn2 && btn2.contains(e.target))) return;
            closeMoreMenu();
        });
    });

    window.MoreMenu = {
        open: openMoreMenu,
        close: closeMoreMenu,
        toggle: toggleMoreMenu,
        registerItem: registerItem
    };
})();
