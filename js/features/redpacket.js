/**
 * 红包功能 —— Step 1 + Step 2
 * 依据《红包功能设计文档.md》第1、2、3.1、6节 + 新确认的"双向独立消息"机制实现。
 *
 * 核心机制（跟微信一样，Yuying 明确确认过）：
 *   红包一旦被领取/过期，发送方那张卡片原地更新状态；接收方那边会【额外生成一条独立的新消息】，
 *   同样是红包卡片样式，出现在接收方那一侧——不是同一条消息换边，是两条独立消息共享同一个 record。
 *
 * 覆盖范围：
 *   - 用户发红包给梦角（outbox）：金额校验、祝福语兜底、90%/10%领取判定、0.5~3h/24h 定时
 *   - 梦角发红包给用户（inbox）：金额生成算法（彩蛋池+三档概率）、留言库随机抽取、
 *     用户点"開"手动领取、24小时未点自动过期
 *   - 红包留言库管理界面（回复库→氛围感→"红包留言库"tab，架构照抄"问卷题库"那套）
 *   - 聊天气泡三态 + 拆红包卡片（红卡/白卡/灰卡）+ 已读联动
 *
 * 存储 key 的取法照抄 survey.js / period.js 那一套（localforage.keys() 扫描 + 等 SESSION_ID 就绪）。
 */
(function () {
    'use strict';

    var _data = { outbox: [], inbox: [], msgBank: [] };
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

    function _uid(prefix) {
        return (prefix || 'rpb') + '_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
    }

    // ── 红包留言库：内置预设（Yuying 给的4条）+ 用户自定义，完全可编辑/删除/隐藏，内置没有只读保护 ──
    var _BUILTIN_BANK_TEXTS = ['开心一下', '拿去花', '恭喜发财，大吉大利', '惊喜红包'];

    function _seedMsgBank() {
        if (!Array.isArray(_data.msgBank)) _data.msgBank = [];
        var hasBuiltin = _data.msgBank.some(function (x) { return x.builtin; });
        if (!hasBuiltin) {
            _BUILTIN_BANK_TEXTS.forEach(function (t) {
                _data.msgBank.push({ id: _uid('rpb'), text: t, builtin: true, hidden: false });
            });
        }
    }

    async function _load() {
        var key = await _getKey();
        var saved = await localforage.getItem(key);
        if (saved) _data = Object.assign({ outbox: [], inbox: [], msgBank: [] }, saved);
        _seedMsgBank();
        _loaded = true; // 不管读到的是真数据还是空的，这次读取本身没出错就算加载成功
    }

    function _save() {
        if (!_loaded) {
            console.warn('[redpacket] 本次会话还没确认加载成功过红包数据，为了避免覆盖历史记录，跳过这次保存');
            return;
        }
        _getKey().then(function (key) { localforage.setItem(key, _data); });
    }

    // ── 金额校验（用户发红包用，文档1.1简化版：两位小数以内即可，不分100元档位） ──────────────────────
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

    // ── 梦角发红包的金额生成算法（文档1.2）：50%彩蛋池，50%走三档区间(40%/40%/20%) ──────────────────────
    var _EGG_POOL = [520, 1314, 13.14, 52000, 520000, 9999999.99];
    function generatePartnerAmount() {
        if (Math.random() < 0.5) {
            return _EGG_POOL[Math.floor(Math.random() * _EGG_POOL.length)];
        }
        var r = Math.random(), min, max;
        if (r < 0.4) { min = 1; max = 10000; }
        else if (r < 0.8) { min = 10000; max = 100000; }
        else { min = 100000; max = 1000000; }
        var amount = Math.floor(min + Math.random() * (max - min));
        return Math.max(1, amount);
    }

    // 控制台批量验证概率分布用（照项目里其它随机系统的验证惯例，跑几百次看分布对不对）
    function debugAmountDistribution(n) {
        n = n || 500;
        var egg = 0, t1 = 0, t2 = 0, t3 = 0;
        for (var i = 0; i < n; i++) {
            var a = generatePartnerAmount();
            if (_EGG_POOL.indexOf(a) !== -1) egg++;
            else if (a < 10000) t1++;
            else if (a < 100000) t2++;
            else t3++;
        }
        console.log(
            '[红包金额分布] 样本数=' + n +
            ' | 彩蛋=' + egg + ' (' + (egg / n * 100).toFixed(1) + '%)' +
            ' | 档位一 1~1万=' + t1 + ' (' + (t1 / n * 100).toFixed(1) + '%)' +
            ' | 档位二 1万~10万=' + t2 + ' (' + (t2 / n * 100).toFixed(1) + '%)' +
            ' | 档位三 10万~100万=' + t3 + ' (' + (t3 / n * 100).toFixed(1) + '%)'
        );
    }

    // 从留言库非隐藏的条目里随机抽一条；万一全被隐藏了（理论上内置4条不会被一次性全隐藏，但防御一下）
    function _drawPartnerBlessing() {
        var pool = (_data.msgBank || []).filter(function (x) { return !x.hidden; });
        if (!pool.length) return '恭喜发财';
        return pool[Math.floor(Math.random() * pool.length)].text;
    }

    function _formatAmountDisplay(n) {
        return Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    // 气泡里"已领取 X元"用这个：整数就不带小数点（52000 不显示成 52000.00），
    // 有小数就照原样保留（13.14 还是 13.14）——跟卡片弹窗里那个永远两位小数的大字金额是两套格式，不能共用
    function _formatAmountShort(n) {
        return Number(n).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
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

    // ── 领取/退回判定（文档 3.1：用户 → 梦角，90%/10%骰子） ──────────────────────
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

    // ── 领取/过期那一刻，在"接收方"那边额外生成一条独立的新消息（自动轮询触发的场景专用：
    // outbox一方的领取/过期结算、inbox一方超时未点開的过期结算，都走这里）。
    // 手动点"開"领取(claimPartnerRedPacket)是用户的真实操作，走它自己那条路，不复用这个函数。 ──────────
    function _spawnReceiverMessage(record, direction) {
        if (typeof addMessage !== 'function') return;
        var receiverIsUser = (direction === 'inbox'); // inbox的接收方是用户自己；outbox的接收方是对方
        var receiverName = receiverIsUser ? 'user' : (settings.partnerName || '对方');
        addMessage({
            id: Date.now() + Math.random(),
            sender: receiverName,
            text: '',
            timestamp: new Date(), // 用生成这一刻的真实时间，不用 resolveAt 那个理论时间点
            status: receiverIsUser ? 'sent' : 'received',
            type: 'redpacket',
            redpacketId: record.id,
            redpacketDirection: direction,
            favorited: false,
            note: null
        });
        if (!receiverIsUser) {
            // 对方是接收方——这是"对方发来的新消息"，要有声音+推送通知
            if (typeof playSound === 'function') playSound('message');
            if (typeof window._sendPartnerNotification === 'function') {
                var noticeText = record.status === 'received' ? '领取了你的红包' : '你的红包已过期，自动退回了';
                window._sendPartnerNotification(receiverName, noticeText);
            }
        }
        // receiverIsUser（对方发的包，用户超时没点開自动过期）：安静补一条记录就行，
        // 不额外配音效/推送，也不触发已读+回复——这是系统自动结算，不是用户的真实操作
    }

    // ── 定时检查（照抄 envelope.js 的 30秒轮询思路，自己独立跑一份，不需要改 app.js）：
    // outbox 和 inbox 两边的"到期未处理"都在这里统一扫 ──────────────────────
    function checkRedPacketStatus() {
        if (!_loaded) return;
        var now = Date.now();
        var changed = false;
        (_data.outbox || []).forEach(function (r) {
            if (r.status !== 'pending') return;
            if (now >= r.resolveAt) {
                r.status = r.willReceive ? 'received' : 'returned';
                if (r.status === 'received') r.receiveTime = r.resolveAt;
                changed = true;
                _spawnReceiverMessage(r, 'outbox');
            }
        });
        (_data.inbox || []).forEach(function (r) {
            if (r.status !== 'pending') return;
            if (now >= r.resolveAt) {
                r.status = 'returned'; // inbox 只有"用户点開"或"超时过期"两条路，轮询扫到的只会是超时这条
                changed = true;
                _spawnReceiverMessage(r, 'inbox');
            }
        });
        if (changed) {
            _save();
            if (typeof renderMessages === 'function') renderMessages(true);
        }
    }

    // direction 不传时两边都找一下，兼容老消息没存 redpacketDirection 字段的情况
    function getById(id, direction) {
        if (direction === 'inbox') return (_data.inbox || []).find(function (r) { return r.id === id; }) || null;
        if (direction === 'outbox') return (_data.outbox || []).find(function (r) { return r.id === id; }) || null;
        return (_data.outbox || []).find(function (r) { return r.id === id; }) ||
               (_data.inbox || []).find(function (r) { return r.id === id; }) || null;
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
                redpacketDirection: 'outbox',
                favorited: false,
                note: null
            });
            if (typeof window._triggerDelayedReply === 'function') window._triggerDelayedReply(true);
        }
        return true;
    }

    // ── 发送（梦角 → 用户）：Step 3 才会接自动调度器，这一步先暴露成可以手动/控制台调用 ──────────────────
    async function sendPartnerRedPacket() {
        if (!_loaded) await _load();
        var amount = generatePartnerAmount();
        var blessing = _drawPartnerBlessing();
        var id = 'rpi_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
        var record = {
            id: id,
            amount: amount,
            blessing: blessing,
            sentTime: Date.now(),
            status: 'pending',
            resolveAt: Date.now() + 24 * 3600000 // 24小时未点開自动过期
        };
        if (!Array.isArray(_data.inbox)) _data.inbox = [];
        _data.inbox.push(record);
        _save();

        if (typeof addMessage === 'function') {
            addMessage({
                id: Date.now() + Math.random(),
                sender: settings.partnerName || '对方',
                text: '',
                timestamp: new Date(),
                status: 'received',
                type: 'redpacket',
                redpacketId: id,
                redpacketDirection: 'inbox',
                favorited: false,
                note: null
            });
            if (typeof playSound === 'function') playSound('message');
            if (typeof window._sendPartnerNotification === 'function') {
                window._sendPartnerNotification(settings.partnerName || '对方', '给你发了一个红包');
            }
        }
        return id;
    }

    // 用户点"開"手动领取梦角发来的红包——这是真实的用户操作，跟普通消息一样触发已读+可能的回复
    function claimPartnerRedPacket(id) {
        var record = getById(id, 'inbox');
        if (!record || record.status !== 'pending') return;
        record.status = 'received';
        record.receiveTime = Date.now();
        _save();

        if (typeof addMessage === 'function') {
            addMessage({
                id: Date.now() + Math.random(),
                sender: 'user',
                text: '',
                timestamp: new Date(),
                status: 'sent',
                type: 'redpacket',
                redpacketId: record.id,
                redpacketDirection: 'inbox',
                favorited: false,
                note: null
            });
            if (typeof window._triggerDelayedReply === 'function') window._triggerDelayedReply(true);
        }
        if (typeof renderMessages === 'function') renderMessages(true);
        // 点開之后立刻把当前弹窗内容换成拆开的样子，不用用户重新点一次才看到结果
        _renderViewModal(record, 'partner', 'inbox');
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
    // 三态：未领取(pending) / 已领取(received) / 已过期(returned)。
    // 底部"XX发出的红包"这行，反映的是【这个红包最初是谁发的】（由 direction 决定），
    // 不是这条具体气泡消息自己的 msg.sender——因为领取时在接收方那边生成的那条"回执"消息，
    // sender 是接收方，但卡片上仍然要写着最初发送人的名字，两者不能混用。
    function renderBubbleHTML(msg) {
        var direction = msg.redpacketDirection || 'outbox';
        var record = getById(msg.redpacketId, direction);
        var status = record ? record.status : 'pending';
        var blessing = record ? record.blessing : '';
        var originalSenderIsUser = (direction === 'outbox');
        var senderName = originalSenderIsUser ? (settings.myName || '我') : (settings.partnerName || '对方');
        var statusClass = status === 'received' ? 'rp-bubble-received' : (status === 'returned' ? 'rp-bubble-returned' : 'rp-bubble-pending');
        var extraLine = '';
        if (status === 'received' && record) {
            extraLine = '<div class="rp-bubble-extra">已领取 ' + _formatAmountShort(record.amount) + '元</div>';
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
                '<div class="rp-bubble-overlay"></div>' +
            '</div>'
        );
    }

    // ── 拆红包弹窗 ──────────────────────
    function openByMessageId(msgId) {
        var msg = (typeof messages !== 'undefined') ? messages.find(function (m) { return String(m.id) === String(msgId); }) : null;
        if (!msg || !msg.redpacketId) return;
        var direction = msg.redpacketDirection || 'outbox';
        var record = getById(msg.redpacketId, direction);
        if (!record) {
            if (typeof showNotification === 'function') showNotification('这个红包的数据找不到了', 'error');
            return;
        }
        var originalSenderIsUser = (direction === 'outbox');
        _renderViewModal(record, originalSenderIsUser ? 'user' : 'partner', direction);
        var modal = document.getElementById('redpacket-view-modal');
        if (modal && typeof showModal === 'function') showModal(modal);
    }

    // sender: 'user' | 'partner'——始终是【这个红包最初的发送人】，不是当前这条气泡消息的 msg.sender
    // direction: 'outbox' | 'inbox'——决定未拆开态的"開"要不要能点（只有用户是接收方，也就是inbox时才能点）
    function _renderViewModal(record, sender, direction) {
        var wrap = document.getElementById('rp-view-content-inner');
        if (!wrap) return;
        var avatarHtml = _getAvatarHtml(sender);
        var senderName = sender === 'user' ? (settings.myName || '我') : (settings.partnerName || '梦角');
        var senderLabel = senderName + '发出的红包';

        var html = '';
        if (record.status === 'pending') {
            var isClaimable = (direction === 'inbox'); // 用户是接收方，開按钮才可以点
            var openCircleHTML = isClaimable
                ? '<div class="rp-card-open-circle rp-card-open-circle-clickable" onclick="window.RedPacket.claimById(\'' + record.id + '\')"><span>開</span></div>'
                : '<div class="rp-card-open-circle"><span>開</span></div>';
            var waitingHTML = isClaimable
                ? '<div class="rp-card-waiting">点击"開"拆红包</div>'
                : '<div class="rp-card-waiting">等待' + _esc(settings.partnerName || '梦角') + '领取</div>';
            html =
                '<div class="rp-card rp-card-sealed">' + _CARD_BG_SEALED +
                    '<div class="rp-card-header-row">' +
                        '<div class="rp-card-avatar">' + avatarHtml + '</div>' +
                        '<div class="rp-card-sender">' + _esc(senderLabel) + '</div>' +
                    '</div>' +
                    '<div class="rp-card-blessing">' + _esc(record.blessing) + '</div>' +
                    openCircleHTML +
                    waitingHTML +
                    '<button class="rp-card-close" onclick="hideModal(document.getElementById(\'redpacket-view-modal\'))">' + _CLOSE_BTN_SEALED + '</button>' +
                '</div>';
        } else if (record.status === 'received') {
            var timeStr = new Date(record.receiveTime).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
            var receiverLabel = direction === 'inbox' ? (settings.myName || '我') : (settings.partnerName || '梦角');
            html =
                '<div class="rp-card rp-card-opened">' + _CARD_BG_OPENED +
                    '<div class="rp-card-header-row">' +
                        '<div class="rp-card-avatar">' + avatarHtml + '</div>' +
                        '<div class="rp-card-sender-dark">' + _esc(senderLabel) + '</div>' +
                    '</div>' +
                    '<div class="rp-card-blessing-grey">' + _esc(record.blessing) + '</div>' +
                    '<div class="rp-card-amount">' + _formatAmountDisplay(record.amount) + ' <span class="rp-card-amount-unit">元</span></div>' +
                    '<div class="rp-card-link">' + _esc(receiverLabel) + ' 于 ' + timeStr + ' 领取</div>' +
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

    // ================================================================
    // 红包留言库管理界面（回复库 → 氛围感 → "红包留言库" tab）
    // 架构照抄 survey.js 的"问卷题库"：内置(4条)+自定义功能完全一致，
    // 都可编辑/删除/隐藏，内置没有只读保护；隐藏的不参与 _drawPartnerBlessing 抽取。
    // 没做分组——原始设计文档没要求这个，做了是过度设计。
    // ================================================================
    var _bankSearchQuery = '';

    function _bankAdd(text) {
        text = (text || '').trim();
        if (!text) return;
        _data.msgBank.push({ id: _uid('rpb'), text: text, builtin: false, hidden: false });
        _save();
    }
    function _bankEdit(id, text) {
        var item = (_data.msgBank || []).find(function (x) { return x.id === id; });
        if (!item) return;
        text = (text || '').trim();
        if (!text) return;
        item.text = text;
        _save();
    }
    function _bankDelete(id) {
        _data.msgBank = (_data.msgBank || []).filter(function (x) { return x.id !== id; });
        _save();
    }
    function _bankToggleHide(id) {
        var item = (_data.msgBank || []).find(function (x) { return x.id === id; });
        if (!item) return;
        item.hidden = !item.hidden;
        _save();
        if (typeof showNotification === 'function') {
            showNotification(item.hidden ? '已隐藏，不会再被抽到' : '已启用', item.hidden ? 'info' : 'success');
        }
    }

    // 新增/编辑用小弹窗输入，不用浏览器原生 prompt()——iOS Safari 下原生对话框不好用，
    // 长相也跟app不搭，这块直接照抄 survey.js 里 _bankPromptModal 的写法
    function _bankPromptModal(title, initialValue, onConfirm) {
        var existing = document.getElementById('rp-bank-prompt-modal');
        if (existing) existing.remove();
        var modal = document.createElement('div');
        modal.className = 'modal';
        modal.id = 'rp-bank-prompt-modal';
        modal.innerHTML =
            '<div class="modal-content" style="max-width:320px;">' +
                '<div class="modal-title"><i class="fas fa-gift"></i><span>' + _esc(title) + '</span></div>' +
                '<textarea class="modal-input" id="rp-bank-prompt-input" rows="2" style="resize:none;width:100%;box-sizing:border-box;"></textarea>' +
                '<div class="modal-buttons">' +
                    '<button class="modal-btn modal-btn-secondary" id="rp-bank-prompt-cancel">取消</button>' +
                    '<button class="modal-btn modal-btn-primary" id="rp-bank-prompt-ok">确定</button>' +
                '</div>' +
            '</div>';
        document.body.appendChild(modal);
        var input = modal.querySelector('#rp-bank-prompt-input');
        input.value = initialValue || '';
        if (typeof showModal === 'function') showModal(modal, input); else modal.style.display = 'flex';
        function close() { modal.remove(); }
        modal.querySelector('#rp-bank-prompt-cancel').onclick = close;
        modal.querySelector('#rp-bank-prompt-ok').onclick = function () {
            var val = input.value;
            close();
            onConfirm(val);
        };
    }

    function _bankRowHTML(item) {
        return '<div class="custom-reply-item' + (item.hidden ? ' survey-bank-row-hidden' : '') + '" data-id="' + item.id + '">' +
            '<span class="custom-reply-text">' + _esc(item.text) +
                (item.builtin ? ' <span style="font-size:10px;opacity:0.55;">(内置)</span>' : '') +
            '</span>' +
            '<div class="custom-reply-actions">' +
                '<button class="reply-action-mini hide-btn" title="' + (item.hidden ? '取消隐藏' : '隐藏') + '"><i class="fas fa-eye' + (item.hidden ? '-slash' : '') + '"></i></button>' +
                '<button class="reply-action-mini edit-btn" title="编辑"><i class="fas fa-pen"></i></button>' +
                '<button class="reply-action-mini delete-btn" title="删除"><i class="fas fa-trash"></i></button>' +
            '</div>' +
        '</div>';
    }

    function _renderBankRows() {
        var rows = document.getElementById('rp-bank-rows');
        if (!rows) return;
        var q = _bankSearchQuery.toLowerCase().trim();
        var pool = (_data.msgBank || []).filter(function (x) { return !q || x.text.toLowerCase().indexOf(q) !== -1; });
        if (!pool.length) {
            rows.innerHTML = '<div style="text-align:center;font-size:12.5px;color:var(--text-secondary);opacity:0.6;padding:20px 0;">' +
                (q ? ('未找到 "' + _esc(q) + '"') : '还没有祝福语') + '</div>';
            return;
        }
        rows.innerHTML = pool.map(_bankRowHTML).join('');
        rows.querySelectorAll('.custom-reply-item').forEach(function (row) {
            var id = row.dataset.id;
            row.querySelector('.hide-btn').onclick = function () { _bankToggleHide(id); _renderBankRows(); };
            row.querySelector('.edit-btn').onclick = function () {
                var cur = (_data.msgBank || []).find(function (x) { return x.id === id; });
                _bankPromptModal('编辑祝福语', cur ? cur.text : '', function (text) {
                    if (text && text.trim()) { _bankEdit(id, text); _renderBankRows(); }
                });
            };
            row.querySelector('.delete-btn').onclick = function () { _bankDelete(id); _renderBankRows(); };
        });
    }

    function _renderBankTab(list) {
        list.innerHTML =
            '<div class="survey-bank-toolbar-row">' +
                '<input type="text" class="survey-bank-search" id="rp-bank-search" placeholder="搜索祝福语…" value="' + _esc(_bankSearchQuery) + '">' +
            '</div>' +
            '<div id="rp-bank-rows"></div>' +
            '<button type="button" class="survey-add-option-btn" id="rp-bank-add-btn" style="margin-top:8px;">' +
                '<i class="fas fa-plus"></i> 新增祝福语' +
            '</button>';
        var searchInput = list.querySelector('#rp-bank-search');
        searchInput.oninput = function () { _bankSearchQuery = searchInput.value; _renderBankRows(); };
        list.querySelector('#rp-bank-add-btn').onclick = function () { _showBankBatchAddDialog(); };
        _renderBankRows();
    }

    // 批量添加——每行一条+自动去重，照抄主字卡批量添加的思路，没做分组选择（这个库不需要分组）
    function _showBankBatchAddDialog() {
        var existing = document.getElementById('rp-bank-batchadd-modal');
        if (existing) existing.remove();
        var modal = document.createElement('div');
        modal.className = 'modal';
        modal.id = 'rp-bank-batchadd-modal';
        modal.innerHTML =
            '<div class="modal-content" style="max-width:400px;">' +
                '<div class="modal-title"><i class="fas fa-gift"></i><span>批量添加祝福语</span></div>' +
                '<div style="font-size:12px;color:var(--text-secondary);margin:6px 0 10px;">每行一条，自动去重</div>' +
                '<textarea class="modal-input" id="rp-bank-batchadd-input" rows="8" placeholder="在此粘贴内容，每行一条…" style="width:100%;box-sizing:border-box;resize:vertical;"></textarea>' +
                '<div class="modal-buttons">' +
                    '<button class="modal-btn modal-btn-secondary" id="rp-bank-batchadd-cancel">取消</button>' +
                    '<button class="modal-btn modal-btn-primary" id="rp-bank-batchadd-ok">添加</button>' +
                '</div>' +
            '</div>';
        document.body.appendChild(modal);
        var ta = modal.querySelector('#rp-bank-batchadd-input');
        if (typeof showModal === 'function') showModal(modal, ta); else modal.style.display = 'flex';
        function close() { modal.remove(); }
        modal.querySelector('#rp-bank-batchadd-cancel').onclick = close;
        modal.querySelector('#rp-bank-batchadd-ok').onclick = function () {
            var lines = ta.value.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
            var existingTexts = (_data.msgBank || []).map(function (x) { return x.text; });
            var added = 0;
            lines.forEach(function (l) {
                if (existingTexts.indexOf(l) === -1) {
                    _data.msgBank.push({ id: _uid('rpb'), text: l, builtin: false, hidden: false });
                    existingTexts.push(l);
                    added++;
                }
            });
            _save();
            close();
            _renderBankRows();
            if (typeof showNotification === 'function') showNotification('已添加 ' + added + ' 条', 'success');
        };
    }

    // ── 启动：等 SESSION_ID 就绪 → 加载数据（含留言库种子） → 立即检查一次 → 30秒轮询 ──────────────────────
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

        // 挂给 reply-library.js 转发用（跟 survey.js 暴露 _surveyRenderBankTab 是同一个模式）
        window._redpacketRenderBankTab = _renderBankTab;
        window._redpacketShowBankBatchAddDialog = _showBankBatchAddDialog;
    }

    document.addEventListener('DOMContentLoaded', function () {
        setTimeout(_boot, 50);
    });

    window.RedPacket = {
        validateAmount: validateAmount,
        sendUserRedPacket: sendUserRedPacket,
        sendPartnerRedPacket: sendPartnerRedPacket,
        claimById: claimPartnerRedPacket,
        generatePartnerAmount: generatePartnerAmount,
        debugAmountDistribution: debugAmountDistribution,
        renderBubbleHTML: renderBubbleHTML,
        openByMessageId: openByMessageId,
        openComposeModal: openComposeModal,
        submitCompose: submitCompose,
        checkRedPacketStatus: checkRedPacketStatus,
        getById: getById
    };
})();
