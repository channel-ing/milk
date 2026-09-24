/**
 * 红包功能 —— Step 1：数据结构 + 用户发红包（单向闭环）
 * 依据《红包功能设计文档.md》第1、2、3.1、6节实现。
 *
 * 本步范围：
 *   - 用户发红包给梦角：金额校验、祝福语（留空兜底"开心一下"）
 *   - 发送瞬间判定 90% 会领取 / 10% 会退回
 *   - 会领取：0.5~3小时内随机变"已领取"；会退回：24小时后变"已退回"
 *   - 聊天气泡三态（未领取/已领取/已退回）
 *   - 拆红包弹窗（未拆开红卡 / 已拆开白卡 / 已退回态）—— 本步只做"用户查看自己发出的红包"这一侧，
 *     梦角发红包给用户、真正的"点開"交互留给 Step 2
 *
 * 存储 key 的取法照抄 survey.js / period.js 那一套（localforage.keys() 扫描 + 等 SESSION_ID 就绪）。
 */
(function () {
    'use strict';

    var _data = { outbox: [], inbox: [] }; // inbox 留给 Step 2（梦角发红包）用，这一步先占位
    var _loaded = false;
    var _storageKey = null;

    // ── Storage（照抄 survey.js 的取key方式） ──────────────────────
    async function _getKey() {
        if (_storageKey) return _storageKey;
        var properKey = null;
        try {
            if (typeof SESSION_ID !== 'undefined' && SESSION_ID && typeof window.getStorageKey === 'function') {
                properKey = window.getStorageKey('redpacketData');
            }
        } catch (e) { /* SESSION_ID 可能还没初始化 */ }
        if (properKey) { _storageKey = properKey; return properKey; }
        try {
            var allKeys = await localforage.keys();
            var found = allKeys.find(function (k) { return k.indexOf('_redpacketData') !== -1; });
            if (found) return found;
            var msgKey = allKeys.find(function (k) { return k.indexOf('_chatMessages') !== -1; });
            var prefix = msgKey ? msgKey.replace('_chatMessages', '') : 'CHAT_APP_V3_';
            return prefix + '_redpacketData';
        } catch (e) {
            return 'CHAT_APP_V3__redpacketData';
        }
    }

    function _waitForSessionId(maxWaitMs) {
        return new Promise(function (resolve) {
            var waited = 0;
            (function check() {
                if ((typeof SESSION_ID !== 'undefined' && SESSION_ID) || waited >= maxWaitMs) {
                    resolve();
                } else {
                    waited += 100;
                    setTimeout(check, 100);
                }
            })();
        });
    }

    async function _load() {
        var key = await _getKey();
        var saved = await localforage.getItem(key);
        if (saved) _data = Object.assign({ outbox: [], inbox: [] }, saved);
        _loaded = true; // 不管读到的是真数据还是空的，这次读取本身没出错就算加载成功
    }

    function _save() {
        if (!_loaded) {
            console.warn('[redpacket] 本次会话还没确认加载成功过红包数据，为了避免覆盖历史记录，跳过这次保存');
            return;
        }
        _getKey().then(function (key) { localforage.setItem(key, _data); });
    }

    // ── 金额校验（文档 1.1） ──────────────────────
    // ≤100 可带小数（精确到两位）；>100 必须整数；封顶 9,999,999.99
    function validateAmount(raw) {
        var s = (raw == null ? '' : String(raw)).trim();
        if (!s) return { valid: false, error: '请输入金额' };
        if (!/^\d+(\.\d{1,2})?$/.test(s)) return { valid: false, error: '金额最多两位小数' };
        var n = parseFloat(s);
        if (isNaN(n) || n <= 0) return { valid: false, error: '金额要大于0' };
        if (n > 9999999.99) return { valid: false, error: '金额不能超过 9,999,999.99' };
        n = Math.round(n * 100) / 100;
        return { valid: true, amount: n };
    }

    function _formatAmountDisplay(n) {
        return Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function _esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // ── 红包小图标：直接从 Yuying 的 SVG 设计稿里原样扣出来的4个元素（信封身+封口弧+金币+¥符号），
    // 坐标没有做任何改动，靠 viewBox 定位，保证跟设计稿像素级一致 ──────────────────────
    var _ICON_SVG =
        '<svg class="rp-icon-svg" viewBox="1951 10584 635 819.516" xmlns="http://www.w3.org/2000/svg">' +
        '<rect x="1951" y="10584" width="635" height="819.516" rx="73" fill="#FF5151"/>' +
        '<path d="M1951 10928C1951 10928 2064.5 11013.9 2273 11013.5C2481.5 11013.1 2586 10928 2586 10928V11331C2586 11371.3 2553.32 11404 2513 11404H2024C1983.68 11404 1951 11371.3 1951 11331V10928Z" fill="#E14849"/>' +
        '<circle cx="2269" cy="11021" r="92" fill="#FFD145"/>' +
        '<path d="M2234 10970L2268.36 11000.2M2268.36 11000.2L2303 10970M2268.36 11000.2V11072M2223.5 11009.1H2314.63M2223 11042H2314.12" stroke="#D97F22" stroke-width="15" stroke-linecap="round"/>' +
        '</svg>';

    // ── 拆红包卡片的背景弧形：同样是从SVG稿里原样扣出来的路径（未拆开红卡 / 拆开白卡 / 已退回灰卡），
    // 用 viewBox + preserveAspectRatio="none" 铺满容器，容器用 aspect-ratio 锁死比例，
    // 保证响应式缩放时弧线形状跟设计稿完全一致，不是我自己拿CSS凑的曲线 ──────────────────────
    var _CARD_BG_SEALED =
        '<svg class="rp-card-bg" viewBox="1567 3724 3065 4820" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">' +
        '<rect x="1567" y="3724" width="3065" height="4820" fill="#CF1812"/>' +
        '<path d="M3065.03 7373.94C2085.91 7373.94 1567 7027 1567 7027V8544H4632V7027C4632 7027 4044.15 7373.94 3065.03 7373.94Z" fill="#F15744"/>' +
        '</svg>';
    var _CARD_BG_OPENED =
        '<svg class="rp-card-bg" viewBox="6487 3724 3065 4820" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">' +
        '<rect x="6487" y="3724" width="3065" height="4820" fill="#F15744"/>' +
        '<path d="M8033.5 5486.5C7008.05 5486.5 6487 5237 6487 5237V8544H9552V5237C9552 5237 9058.95 5486.5 8033.5 5486.5Z" fill="white"/>' +
        '</svg>';
    var _CARD_BG_RETURNED =
        '<svg class="rp-card-bg" viewBox="11007 3724 3065 4820" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">' +
        '<rect x="11007" y="3724" width="3065" height="4820" fill="#8F8F8F"/>' +
        '<path d="M12553.5 5486.5C11528.1 5486.5 11007 5237 11007 5237V8544H14072V5237C14072 5237 13578.9 5486.5 12553.5 5486.5Z" fill="white"/>' +
        '</svg>';

    // 关闭按钮：之前完全漏掉了——之前只扫了 <rect>/<path fill>，没扫 <circle>，
    // 这次补上，圆圈+X都是描边（无填充），色值#FFC97C，三张卡各有一份坐标不同的原样拷贝
    var _CLOSE_BTN_SEALED =
        '<svg class="rp-card-close-svg" viewBox="2919 8924 361 361" xmlns="http://www.w3.org/2000/svg">' +
        '<circle cx="3099.5" cy="9104.5" r="169.5" stroke="#FFC97C" stroke-width="22" fill="none"/>' +
        '<path d="M3026 9030L3172.5 9179.5" stroke="#FFC97C" stroke-width="22" stroke-linecap="round"/>' +
        '<path d="M3172.5 9030L3026 9179.5" stroke="#FFC97C" stroke-width="22" stroke-linecap="round"/>' +
        '</svg>';
    var _CLOSE_BTN_OPENED =
        '<svg class="rp-card-close-svg" viewBox="7839 8924 361 361" xmlns="http://www.w3.org/2000/svg">' +
        '<circle cx="8019.5" cy="9104.5" r="169.5" stroke="#FFC97C" stroke-width="22" fill="none"/>' +
        '<path d="M7946 9030L8092.5 9179.5" stroke="#FFC97C" stroke-width="22" stroke-linecap="round"/>' +
        '<path d="M8092.5 9030L7946 9179.5" stroke="#FFC97C" stroke-width="22" stroke-linecap="round"/>' +
        '</svg>';
    var _CLOSE_BTN_RETURNED =
        '<svg class="rp-card-close-svg" viewBox="12359 8924 361 361" xmlns="http://www.w3.org/2000/svg">' +
        '<circle cx="12539.5" cy="9104.5" r="169.5" stroke="#FFC97C" stroke-width="22" fill="none"/>' +
        '<path d="M12466 9030L12612.5 9179.5" stroke="#FFC97C" stroke-width="22" stroke-linecap="round"/>' +
        '<path d="M12612.5 9030L12466 9179.5" stroke="#FFC97C" stroke-width="22" stroke-linecap="round"/>' +
        '</svg>';

    // ── 领取/退回判定（文档 3.1：用户 → 梦角） ──────────────────────
    function _rollOutcome(record) {
        var willReceive = Math.random() < 0.9;
        record.willReceive = willReceive;
        if (willReceive) {
            var hours = 0.5 + Math.random() * (3 - 0.5);
            record.resolveAt = Date.now() + hours * 3600000;
        } else {
            record.resolveAt = record.sentTime + 24 * 3600000;
        }
    }

    // ── 定时检查（照抄 envelope.js 的 30秒轮询思路，自己独立跑一份，不需要改 app.js） ──────────────────────
    function checkRedPacketStatus() {
        if (!_loaded) return;
        var now = Date.now();
        var changed = false;
        _data.outbox.forEach(function (r) {
            if (r.status !== 'pending') return;
            if (now >= r.resolveAt) {
                r.status = r.willReceive ? 'received' : 'returned';
                if (r.status === 'received') r.receiveTime = r.resolveAt;
                changed = true;
            }
        });
        if (changed) {
            _save();
            if (typeof renderMessages === 'function') renderMessages(true);
        }
    }

    function getById(id) {
        return _data.outbox.find(function (r) { return r.id === id; }) || null;
    }

    // ── 已读+回复：直接复用普通消息的那套 window._triggerDelayedReply(true)，
    // 不是我自己另写一套——已读之后要不要回复、"已读不回"概率怎么算，都跟普通消息走同一个函数，
    // 不用在红包这边重复实现一遍 ──────────────────────

    // ── 发送（用户 → 梦角） ──────────────────────
    async function sendUserRedPacket(rawAmount, rawBlessing) {
        var check = validateAmount(rawAmount);
        if (!check.valid) {
            if (typeof showNotification === 'function') showNotification(check.error, 'error');
            return false;
        }
        if (!_loaded) await _load();

        var id = 'rp_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
        var blessing = (rawBlessing || '').trim() || '开心一下';
        var record = {
            id: id,
            amount: check.amount,
            blessing: blessing,
            sentTime: Date.now(),
            status: 'pending'
        };
        _rollOutcome(record);
        _data.outbox.push(record);
        _save();

        if (typeof addMessage === 'function') {
            addMessage({
                id: Date.now() + Math.random(),
                sender: 'user',
                text: '',
                timestamp: new Date(),
                status: 'sent',
                type: 'redpacket',
                redpacketId: id,
                favorited: false,
                note: null
            });
            if (typeof window._triggerDelayedReply === 'function') window._triggerDelayedReply(true);
        }
        return true;
    }

    // ── 头像取值（跟主聊天头像保持一致，取不到就用默认图标兜底） ──────────────────────
    function _getAvatarHtml(sender) {
        try {
            var el = sender === 'user' ? DOMElements.me.avatar : DOMElements.partner.avatar;
            if (el && el.innerHTML && el.innerHTML.indexOf('<img') !== -1) return el.innerHTML;
        } catch (e) {}
        return '<i class="fas fa-user"></i>';
    }

    // ── 聊天气泡（供 core.js 的 createMessageFragment 调用） ──────────────────────
    // 三态：未领取(pending) / 已领取(received) / 已退回(returned，配色待 Yuying 定稿，先用灰紫占位)
    function renderBubbleHTML(msg) {
        var record = getById(msg.redpacketId);
        var status = record ? record.status : 'pending';
        var blessing = record ? record.blessing : '';
        var senderName = msg.sender === 'user' ? (settings.myName || '我') : (settings.partnerName || '对方');
        var statusClass = status === 'received' ? 'rp-bubble-received' : (status === 'returned' ? 'rp-bubble-returned' : 'rp-bubble-pending');
        var extraLine = '';
        if (status === 'received' && record) {
            extraLine = '<div class="rp-bubble-extra">已领取 ' + _formatAmountDisplay(record.amount) + '元</div>';
        } else if (status === 'returned') {
            extraLine = '<div class="rp-bubble-extra">已过期</div>';
        }
        return (
            '<div class="redpacket-bubble ' + statusClass + '" onclick="window.RedPacket.openByMessageId(\'' + msg.id + '\')">' +
                '<div class="rp-bubble-top">' +
                    '<span class="rp-bubble-icon">' + _ICON_SVG + '</span>' +
                    '<div class="rp-bubble-text">' +
                        '<div class="rp-bubble-blessing">' + _esc(blessing) + '</div>' +
                        extraLine +
                    '</div>' +
                '</div>' +
                '<div class="rp-bubble-divider"></div>' +
                '<div class="rp-bubble-bottom">' + _esc(senderName) + '发出的红包</div>' +
            '</div>'
        );
    }

    // ── 拆红包弹窗 ──────────────────────
    function openByMessageId(msgId) {
        var msg = (typeof messages !== 'undefined') ? messages.find(function (m) { return String(m.id) === String(msgId); }) : null;
        if (!msg || !msg.redpacketId) return;
        var record = getById(msg.redpacketId);
        if (!record) {
            if (typeof showNotification === 'function') showNotification('这个红包的数据找不到了', 'error');
            return;
        }
        _renderViewModal(record, msg.sender);
        var modal = document.getElementById('redpacket-view-modal');
        if (modal && typeof showModal === 'function') showModal(modal);
    }

    function _renderViewModal(record, sender) {
        var wrap = document.getElementById('rp-view-content-inner');
        if (!wrap) return;
        var avatarHtml = _getAvatarHtml(sender);
        var senderName = sender === 'user' ? (settings.myName || '我') : (settings.partnerName || '梦角');
        var senderLabel = senderName + '发出的红包';

        var html = '';
        if (record.status === 'pending') {
            html =
                '<div class="rp-card rp-card-sealed">' + _CARD_BG_SEALED +
                    '<div class="rp-card-header-row">' +
                        '<div class="rp-card-avatar">' + avatarHtml + '</div>' +
                        '<div class="rp-card-sender">' + _esc(senderLabel) + '</div>' +
                    '</div>' +
                    '<div class="rp-card-blessing">' + _esc(record.blessing) + '</div>' +
                    '<div class="rp-card-open-circle"><span>開</span></div>' +
                    '<div class="rp-card-waiting">等待' + _esc(settings.partnerName || '梦角') + '领取</div>' +
                    '<button class="rp-card-close" onclick="hideModal(document.getElementById(\'redpacket-view-modal\'))">' + _CLOSE_BTN_SEALED + '</button>' +
                '</div>';
        } else if (record.status === 'received') {
            var timeStr = new Date(record.receiveTime).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
            html =
                '<div class="rp-card rp-card-opened">' + _CARD_BG_OPENED +
                    '<div class="rp-card-header-row">' +
                        '<div class="rp-card-avatar">' + avatarHtml + '</div>' +
                        '<div class="rp-card-sender-dark">' + _esc(senderLabel) + '</div>' +
                    '</div>' +
                    '<div class="rp-card-blessing-grey">' + _esc(record.blessing) + '</div>' +
                    '<div class="rp-card-amount">' + _formatAmountDisplay(record.amount) + ' <span class="rp-card-amount-unit">元</span></div>' +
                    '<div class="rp-card-link">' + _esc(settings.partnerName || '梦角') + ' 于 ' + timeStr + ' 领取</div>' +
                    '<button class="rp-card-close" onclick="hideModal(document.getElementById(\'redpacket-view-modal\'))">' + _CLOSE_BTN_OPENED + '</button>' +
                '</div>';
        } else {
            html =
                '<div class="rp-card rp-card-returned">' + _CARD_BG_RETURNED +
                    '<div class="rp-card-header-row">' +
                        '<div class="rp-card-avatar">' + avatarHtml + '</div>' +
                        '<div class="rp-card-sender-dark">' + _esc(senderLabel) + '</div>' +
                    '</div>' +
                    '<div class="rp-card-blessing-grey">' + _esc(record.blessing) + '</div>' +
                    '<div class="rp-card-amount rp-card-amount-muted">' + _formatAmountDisplay(record.amount) + ' <span class="rp-card-amount-unit">元</span></div>' +
                    '<div class="rp-card-link">超过24小时未领取，已自动退回</div>' +
                    '<button class="rp-card-close" onclick="hideModal(document.getElementById(\'redpacket-view-modal\'))">' + _CLOSE_BTN_RETURNED + '</button>' +
                '</div>';
        }
        wrap.innerHTML = html;
    }

    // ── 发红包弹窗（编写金额+祝福语） ──────────────────────
    function _syncComposePreview() {
        var amountInput = document.getElementById('rp-compose-amount');
        var preview = document.getElementById('rp-compose-preview-amount');
        if (!amountInput || !preview) return;
        var n = parseFloat(amountInput.value);
        preview.textContent = (isNaN(n) ? 0 : n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function openComposeModal() {
        var amountInput = document.getElementById('rp-compose-amount');
        var blessingInput = document.getElementById('rp-compose-blessing');
        if (amountInput) amountInput.value = '';
        if (blessingInput) blessingInput.value = '';
        _syncComposePreview();
        var modal = document.getElementById('redpacket-compose-modal');
        if (modal && typeof showModal === 'function') showModal(modal, amountInput);
    }

    async function submitCompose() {
        var amountInput = document.getElementById('rp-compose-amount');
        var blessingInput = document.getElementById('rp-compose-blessing');
        var btn = document.getElementById('rp-compose-send-btn');
        if (!amountInput) return;
        if (btn) btn.disabled = true;
        var ok = await sendUserRedPacket(amountInput.value, blessingInput ? blessingInput.value : '');
        if (btn) btn.disabled = false;
        if (ok) {
            var modal = document.getElementById('redpacket-compose-modal');
            if (modal && typeof hideModal === 'function') hideModal(modal);
            if (typeof showNotification === 'function') showNotification('红包已发出～', 'success', 2000);
        }
    }

    // ── 启动：等 SESSION_ID 就绪 → 加载数据 → 立即检查一次 → 30秒轮询 ──────────────────────
    async function _boot() {
        await _waitForSessionId(3000);
        await _load();
        checkRedPacketStatus();
        setInterval(checkRedPacketStatus, 30000);

        // 把"更多菜单"里的红包坑位从占位升级成真实功能，不用改 more-menu.js
        if (window.MoreMenu && typeof window.MoreMenu.registerItem === 'function') {
            window.MoreMenu.registerItem('redpacket', { ready: true, action: openComposeModal });
        }

        var headerIcon = document.getElementById('rp-compose-header-icon');
        if (headerIcon) headerIcon.innerHTML = _ICON_SVG;
        var amountInput = document.getElementById('rp-compose-amount');
        if (amountInput) amountInput.addEventListener('input', _syncComposePreview);
    }

    document.addEventListener('DOMContentLoaded', function () {
        setTimeout(_boot, 50);
    });

    window.RedPacket = {
        validateAmount: validateAmount,
        sendUserRedPacket: sendUserRedPacket,
        renderBubbleHTML: renderBubbleHTML,
        openByMessageId: openByMessageId,
        openComposeModal: openComposeModal,
        submitCompose: submitCompose,
        checkRedPacketStatus: checkRedPacketStatus,
        getById: getById
    };
})();
