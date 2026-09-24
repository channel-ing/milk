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
        if (!/^\d+(\.\d{1,2})?$/.test(s)) return { valid: false, error: '金额格式不对，最多两位小数' };
        var n = parseFloat(s);
        if (isNaN(n) || n <= 0) return { valid: false, error: '金额要大于0' };
        if (n > 9999999.99) return { valid: false, error: '金额不能超过 9,999,999.99' };
        n = Math.round(n * 100) / 100;
        if (n > 100 && n % 1 !== 0) return { valid: false, error: '超过100元的金额不能带小数' };
        return { valid: true, amount: n };
    }

    function _formatAmountDisplay(n) {
        return Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function _esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

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
            extraLine = '<div class="rp-bubble-extra">已退回</div>';
        }
        return (
            '<div class="redpacket-bubble ' + statusClass + '" onclick="window.RedPacket.openByMessageId(\'' + msg.id + '\')">' +
                '<div class="rp-bubble-top">' +
                    '<span class="rp-bubble-icon"><i class="fas fa-gift"></i></span>' +
                    '<span class="rp-bubble-blessing">' + _esc(blessing) + '</span>' +
                '</div>' +
                '<div class="rp-bubble-divider"></div>' +
                '<div class="rp-bubble-bottom">' + _esc(senderName) + '发出的红包</div>' +
                extraLine +
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
        var senderLabel = sender === 'user' ? '你发出的红包' : (settings.partnerName || '梦角') + '发出的红包';
        var closeBtn = '<button class="rp-card-close" onclick="hideModal(document.getElementById(\'redpacket-view-modal\'))"><i class="fas fa-times"></i></button>';

        var html = '';
        if (record.status === 'pending') {
            html =
                '<div class="rp-card rp-card-sealed">' + closeBtn +
                    '<div class="rp-card-avatar">' + avatarHtml + '</div>' +
                    '<div class="rp-card-sender">' + _esc(senderLabel) + '</div>' +
                    '<div class="rp-card-blessing">' + _esc(record.blessing) + '</div>' +
                    '<div class="rp-card-waiting"><i class="fas fa-hourglass-half"></i> 等待' + _esc(settings.partnerName || '梦角') + '查收…</div>' +
                '</div>';
        } else if (record.status === 'received') {
            var timeStr = new Date(record.receiveTime).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
            html =
                '<div class="rp-card rp-card-opened">' + closeBtn +
                    '<div class="rp-card-avatar">' + avatarHtml + '</div>' +
                    '<div class="rp-card-sender-dark">' + _esc(senderLabel) + '</div>' +
                    '<div class="rp-card-blessing-grey">' + _esc(record.blessing) + '</div>' +
                    '<div class="rp-card-amount">' + _formatAmountDisplay(record.amount) + ' 元</div>' +
                    '<div class="rp-card-time-note">' + _esc(settings.partnerName || '梦角') + ' 于 ' + timeStr + ' 领取</div>' +
                '</div>';
        } else {
            html =
                '<div class="rp-card rp-card-returned">' + closeBtn +
                    '<div class="rp-card-avatar">' + avatarHtml + '</div>' +
                    '<div class="rp-card-sender-dark">' + _esc(senderLabel) + '</div>' +
                    '<div class="rp-card-blessing-grey">' + _esc(record.blessing) + '</div>' +
                    '<div class="rp-card-amount rp-card-amount-muted">' + _formatAmountDisplay(record.amount) + ' 元</div>' +
                    '<div class="rp-card-returned-note"><i class="fas fa-rotate-left"></i> 超过24小时未领取，已自动退回</div>' +
                '</div>';
        }
        wrap.innerHTML = html;
    }

    // ── 发红包弹窗（编写金额+祝福语） ──────────────────────
    function openComposeModal() {
        var amountInput = document.getElementById('rp-compose-amount');
        var blessingInput = document.getElementById('rp-compose-blessing');
        if (amountInput) amountInput.value = '';
        if (blessingInput) blessingInput.value = '';
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
