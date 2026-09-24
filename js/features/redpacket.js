/**
 * 红包功能 —— Step 1 + Step 2 + Step 3
 * 依据《红包功能设计文档.md》第1、2、3.1、4、8节 + 新确认的"双向独立消息"机制实现。
 *
 * 核心机制（跟微信一样，Yuying 明确确认过）：
 *   红包一旦被领取/过期，发送方那张卡片原地更新状态；接收方那边会【额外生成一条独立的新消息】，
 *   同样是红包卡片样式，出现在接收方那一侧——不是同一条消息换边，是两条独立消息共享同一个 record。
 *
 * 覆盖范围：
 *   - 用户发红包给梦角（outbox）：金额校验、祝福语兜底、90%/10%领取判定、0.5~3h/24h 定时
 *   - 梦角发红包给用户（inbox）：金额生成算法（彩蛋池+三档概率）、留言库随机抽取、
 *     用户点"開"手动领取、24小时未点自动过期
 *   - 红包留言库管理界面（回复库→氛围感→"红包祝福语"tab，架构照抄"问卷题库"那套）
 *   - 梦角主动发红包的调度（8~12小时检查一次，15%→50%→95%阶梯概率，命中即触发并清零连续未命中计数；
 *     陪伴模式/观影模式期间不检查，调度结构照抄 cinema.js 的梦角主动邀请那套：
 *     setTimeout+持久化nextCheckAt，不是setInterval轮询）
 *   - 到期提醒悬浮按钮（梦角发的红包超过20小时没领，聊天区右下角提醒，复用#back-to-latest-btn胶囊样式）
 *   - 聊天气泡三态 + 拆红包卡片（红卡/白卡/灰卡）+ 已读联动
 *
 * 存储 key 的取法照抄 survey.js / period.js 那一套（localforage.keys() 扫描 + 等 SESSION_ID 就绪）。
 */
(function () {
    'use strict';

    var _data = { outbox: [], inbox: [], msgBank: [], scheduler: null };
    var _loaded = false;
    var _storageKey = null;
    var _partnerCheckTimer = null;

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
        if (saved) _data = Object.assign({ outbox: [], inbox: [], msgBank: [], scheduler: null }, saved);
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

    // 带表情包版本的背景弧线——不是同一套稿子改个内容，是Yuying另外给的专门稿子，
    // 头部弧线的位置整个不一样（往上收了，给表情包腾地方），坐标原样抠自那两份新SVG
    var _CARD_BG_SEALED_STICKER =
        '<svg class="rp-card-bg" viewBox="0 0 3065 4820" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">' +
        '<rect width="3065" height="4820" fill="#CF1812"/>' +
        '<path d="M1498.03 3826.57C518.909 3826.57 0 3532 0 3532V4820H3065V3532C3065 3532 2477.15 3826.57 1498.03 3826.57Z" fill="#F15744"/>' +
        '</svg>';
    var _CARD_BG_OPENED_STICKER =
        '<svg class="rp-card-bg" viewBox="0 0 3065 4820" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">' +
        '<rect width="3065" height="4820" fill="#F15744"/>' +
        '<path d="M1546.5 1100.52C521.05 1100.52 0 797 0 797V4820H3065V797C3065 797 2571.95 1100.52 1546.5 1100.52Z" fill="white"/>' +
        '</svg>';
    var _CARD_BG_RETURNED_STICKER =
        '<svg class="rp-card-bg" viewBox="0 0 3065 4820" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">' +
        '<rect width="3065" height="4820" fill="#8F8F8F"/>' +
        '<path d="M1546.5 1100.52C521.05 1100.52 0 797 0 797V4820H3065V797C3065 797 2571.95 1100.52 1546.5 1100.52Z" fill="white"/>' +
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
            redpacketRole: 'receipt', // 这条是"领取/过期"生成的回执消息，不是最初那条
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

    // ================================================================
    // 梦角主动发红包 —— 调度器（文档第4节）
    // 结构照抄 cinema.js 的"梦角主动邀请"那套：nextCheckAt 持久化 + setTimeout，
    // 不是 setInterval 轮询——间隔是小时级的，没必要每30秒空转检查一次。
    // 8~12小时检查一次；连续未命中1-4次(missedCount 0~3)：15%；5-7次(4~6)：50%；
    // 8次及以后(≥7)：固定95%。命中就发一个红包并清零计数。
    // 陪伴模式/观影模式期间不检查——不消耗这次检查机会，15分钟后再看一眼。
    // ================================================================
    function _randHours8to12() { return 8 + Math.random() * 4; }

    function _isGatedByOtherModes() {
        try {
            var companionEl = document.getElementById('companion-page');
            var isCompanionActive = !!(companionEl && companionEl.classList.contains('active'));
            var isCinemaWatching = !!window._cinemaWatching;
            return isCompanionActive || isCinemaWatching;
        } catch (e) { return false; }
    }

    function _scheduleNextPartnerCheck() {
        if (_partnerCheckTimer) { clearTimeout(_partnerCheckTimer); _partnerCheckTimer = null; }
        if (!_data.scheduler) {
            // 第一次用，从现在起 8~12 小时后才第一次检查，不是装上就立刻查
            _data.scheduler = { nextCheckAt: Date.now() + _randHours8to12() * 3600000, missedCount: 0 };
            _save();
        }
        var delay = _data.scheduler.nextCheckAt - Date.now();
        if (delay <= 0) { _runPartnerCheck(); return; }
        _partnerCheckTimer = setTimeout(_runPartnerCheck, delay);
    }

    async function _runPartnerCheck() {
        if (_isGatedByOtherModes()) {
            _partnerCheckTimer = setTimeout(_runPartnerCheck, 15 * 60000);
            return;
        }
        var missed = _data.scheduler.missedCount || 0;
        var prob = missed < 4 ? 0.15 : (missed < 7 ? 0.5 : 0.95);
        if (Math.random() < prob) {
            await sendPartnerRedPacket();
            _data.scheduler.missedCount = 0;
        } else {
            _data.scheduler.missedCount = missed + 1;
        }
        _data.scheduler.nextCheckAt = Date.now() + _randHours8to12() * 3600000;
        _save();
        _scheduleNextPartnerCheck();
    }

    // 控制台测试用：不用真等8~12小时，立刻跑一次调度检查（该门控还是会门控，该概率还是走概率）
    function debugForcePartnerCheck() {
        if (_partnerCheckTimer) { clearTimeout(_partnerCheckTimer); _partnerCheckTimer = null; }
        _runPartnerCheck();
    }
    function debugSchedulerState() {
        console.log('[红包调度器状态]', JSON.parse(JSON.stringify(_data.scheduler)));
        return _data.scheduler;
    }

    // ── 一键测试：不用自己拼代码，复制粘贴一行就行 ──────────────────────

    // 1. 一键模拟"梦角发了红包，用户超过20小时没领"——自动发一个红包，
    //    自动把发送时间往前拨到21小时前，自动刷新提醒按钮，右下角应该立刻能看到
    async function debugTestReminder() {
        if (!_loaded) await _load();
        var id = await sendPartnerRedPacket();
        var rec = getById(id, 'inbox');
        if (rec) {
            rec.sentTime = Date.now() - 21 * 3600000;
            _save();
        }
        checkRedPacketStatus(); // 顺手会刷新提醒按钮
        if (typeof showNotification === 'function') {
            showNotification('已模拟一个超过20小时未领的红包，看看聊天区右下角', 'info', 3000);
        }
        console.log('[红包] 已模拟超时未领提醒，红包id=', id);
    }

    // 2. 一键验证"梦角主动发红包"的阶梯概率对不对——不是真的发1000个红包，
    //    是照着调度器同一套逻辑（连续未命中计数+对应概率）在内存里空跑1000轮，
    //    统计每个阶梯实际命中率跟文档写的15%/50%/95%差多少
    function debugSimulateScheduler(rounds) {
        rounds = rounds || 1000;
        var missed = 0;
        var stats = { t1: { hit: 0, total: 0 }, t2: { hit: 0, total: 0 }, t3: { hit: 0, total: 0 } };
        for (var i = 0; i < rounds; i++) {
            var key = missed < 4 ? 't1' : (missed < 7 ? 't2' : 't3');
            var prob = missed < 4 ? 0.15 : (missed < 7 ? 0.5 : 0.95);
            stats[key].total++;
            if (Math.random() < prob) { stats[key].hit++; missed = 0; }
            else { missed++; }
        }
        function fmt(s) { return s.total ? (s.hit / s.total * 100).toFixed(1) + '%' : '（这一档没跑到）'; }
        console.log(
            '[红包主动触发概率模拟] 共跑 ' + rounds + ' 轮\n' +
            '第1-4次检查 (理论15%)：跑到 ' + stats.t1.total + ' 次，命中 ' + stats.t1.hit + ' 次，实际 ' + fmt(stats.t1) + '\n' +
            '第5-7次检查 (理论50%)：跑到 ' + stats.t2.total + ' 次，命中 ' + stats.t2.hit + ' 次，实际 ' + fmt(stats.t2) + '\n' +
            '第8次及以后 (理论95%)：跑到 ' + stats.t3.total + ' 次，命中 ' + stats.t3.hit + ' 次，实际 ' + fmt(stats.t3)
        );
    }

    // ================================================================
    // 到期提醒悬浮按钮（文档第8节）：梦角发的红包超过20小时没领，
    // 聊天界面右下角出现提醒，复用 #back-to-latest-btn 的胶囊样式，定位在它正上方。
    // ================================================================
    function _getExpiryReminderCandidates() {
        var now = Date.now();
        return (_data.inbox || []).filter(function (r) {
            return r.status === 'pending' && !r.reminderDismissed && (now - r.sentTime) >= 20 * 3600000;
        });
    }

    function _updateExpiryReminder() {
        var btn = document.getElementById('rp-expiry-reminder-btn');
        var label = document.getElementById('rp-expiry-reminder-label');
        if (!btn || !label) return;
        var list = _getExpiryReminderCandidates();
        if (!list.length) { btn.style.display = 'none'; return; }
        label.textContent = list.length === 1 ? '1个红包待领取' : (list.length + '个红包待领取');
        btn.style.display = 'flex';
    }

    // 找到某个 inbox record 对应的【原始】那条消息（不是领取后生成的回执消息），用于跳转定位。
    // 之前这里靠 sender !== 'user' 猜"是不是原始消息"，但回执消息的 sender 如果不是字面的
    // 'user'（比如用了真实用户名），这个判断就会失效，两条消息都会命中——现在改成直接认
    // redpacketRole 这个明确标记，不用猜。旧消息没有这个字段时兜底退回旧逻辑，不然老数据直接找不到。
    function _findInboxMessageId(recordId) {
        if (typeof messages === 'undefined') return null;
        var msg = messages.find(function (m) {
            return m.type === 'redpacket' && m.redpacketDirection === 'inbox' && m.redpacketId === recordId && m.redpacketRole === 'original';
        });
        if (!msg) {
            // 兜底：老消息没有 redpacketRole 字段，退回旧的猜测逻辑
            msg = messages.find(function (m) {
                return m.type === 'redpacket' && m.redpacketDirection === 'inbox' && m.redpacketId === recordId && m.sender !== 'user';
            });
        }
        return msg ? msg.id : null;
    }

    function jumpToExpiryReminder() {
        var list = _getExpiryReminderCandidates().sort(function (a, b) { return a.sentTime - b.sentTime; });
        if (!list.length) return;
        var earliest = list[0];
        // 点击就立刻消失——不管用户跳过去之后到底有没有点"開"；真撞上多个待领取，
        // 点一次全部消失（文档原话："不用为这个场景专门设计交互"）
        list.forEach(function (r) { r.reminderDismissed = true; });
        _save();
        _updateExpiryReminder();
        var msgId = _findInboxMessageId(earliest.id);
        if (msgId && typeof window._jumpToMessage === 'function') window._jumpToMessage(msgId);
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
        _updateExpiryReminder();
    }

    // direction 不传时两边都找一下，兼容老消息没存 redpacketDirection 字段的情况
    function getById(id, direction) {
        if (direction === 'inbox') return (_data.inbox || []).find(function (r) { return r.id === id; }) || null;
        if (direction === 'outbox') return (_data.outbox || []).find(function (r) { return r.id === id; }) || null;
        return (_data.outbox || []).find(function (r) { return r.id === id; }) ||
               (_data.inbox || []).find(function (r) { return r.id === id; }) || null;
    }

    // ── 发送（用户 → 梦角） ──────────────────────
    async function sendUserRedPacket(rawAmount, rawBlessing, sticker) {
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
            sticker: sticker || null,
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
                redpacketRole: 'original', // 这是红包最初发出的那条消息
                favorited: false,
                note: null
            });
            if (typeof window._triggerDelayedReply === 'function') window._triggerDelayedReply(true);
        }
        return true;
    }

    // 80%概率带一个表情包，从"对方表情库"(stickerLibrary，纯字符串数组)里随机抽；
    // 库是空的就不带，不会因为抽不到东西而出错或者硬凑
    function _drawPartnerSticker() {
        if (Math.random() >= 0.8) return null;
        var pool = (typeof stickerLibrary !== 'undefined' && Array.isArray(stickerLibrary)) ? stickerLibrary : [];
        if (!pool.length) return null;
        return pool[Math.floor(Math.random() * pool.length)];
    }

    // ── 发送（梦角 → 用户）：Step 3 才会接自动调度器，这一步先暴露成可以手动/控制台调用 ──────────────────
    async function sendPartnerRedPacket() {
        if (!_loaded) await _load();
        var amount = generatePartnerAmount();
        var blessing = _drawPartnerBlessing();
        var sticker = _drawPartnerSticker();
        var id = 'rpi_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
        var record = {
            id: id,
            amount: amount,
            blessing: blessing,
            sticker: sticker,
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
                redpacketRole: 'original', // 这是红包最初发出的那条消息
                favorited: false,
                note: null
            });
            if (typeof playSound === 'function') playSound('message');
            if (typeof window._sendPartnerNotification === 'function') {
                window._sendPartnerNotification(settings.partnerName || '对方', '给你发了一个红包');
            }
        }
        _updateExpiryReminder();
        return id;
    }

    // 開按钮点击入口：先放金元宝旋转动效，动效结束后再真正执行领取——
    // 点击瞬间就调用 claimPartnerRedPacket 会导致弹窗内容立刻被替换成白卡，
    // 动效还没转完就被打断了，所以这里要等一段时间（跟CSS动画时长对齐）再触发真正的领取逻辑
    function playOpenAnimation(id, circleEl) {
        if (!circleEl || circleEl.classList.contains('rp-coin-spinning')) return; // 防止动效播放中重复点击
        circleEl.classList.add('rp-coin-spinning');
        setTimeout(function () {
            claimPartnerRedPacket(id);
        }, 900);
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
                redpacketRole: 'receipt', // 这是用户点開领取之后生成的回执消息，不是最初那条
                favorited: false,
                note: null
            });
            if (typeof window._triggerDelayedReply === 'function') window._triggerDelayedReply(true);
        }
        if (typeof renderMessages === 'function') renderMessages(true);
        _updateExpiryReminder();
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
        _viewModalFromHistory = false;
        _renderViewModal(record, originalSenderIsUser ? 'user' : 'partner', direction);
        var modal = document.getElementById('redpacket-view-modal');
        if (modal && typeof showModal === 'function') showModal(modal);
    }

    function _stickerImgHTML(src) {
        if (!src) return '';
        var isCloud = typeof src === 'string' && src.indexOf('oss://') === 0;
        return isCloud
            ? '<img class="rp-card-sticker-img" data-lazy-cloud-ref="' + _esc(src) + '">'
            : '<img class="rp-card-sticker-img" src="' + _esc(src) + '">';
    }
    function _bindStickerLazyLoad(wrap) {
        if (!window.CloudMedia) return;
        wrap.querySelectorAll('img[data-lazy-cloud-ref]').forEach(function (imgEl) {
            window.CloudMedia.bindLazyImage(imgEl, imgEl.getAttribute('data-lazy-cloud-ref'));
        });
    }

    // sender: 'user' | 'partner'——始终是【这个红包最初的发送人】，不是当前这条气泡消息的 msg.sender
    // direction: 'outbox' | 'inbox'——决定未拆开态的"開"要不要能点（只有用户是接收方，也就是inbox时才能点）
    function _renderViewModal(record, sender, direction) {
        var wrap = document.getElementById('rp-view-content-inner');
        if (!wrap) return;
        var avatarHtml = _getAvatarHtml(sender);
        var senderName = sender === 'user' ? (settings.myName || '我') : (settings.partnerName || '梦角');
        var senderLabel = senderName + '发出的红包';
        var hasSticker = !!record.sticker;
        var stickerClass = hasSticker ? ' rp-card-has-sticker' : '';
        var stickerHTML = hasSticker ? _stickerImgHTML(record.sticker) : '';

        var html = '';
        if (record.status === 'pending') {
            var isClaimable = (direction === 'inbox'); // 用户是接收方，開按钮才可以点
            var openCircleHTML = isClaimable
                ? '<div class="rp-card-open-circle rp-card-open-circle-clickable" onclick="window.RedPacket.playOpenAnimation(\'' + record.id + '\', this)"><span>開</span></div>'
                : '<div class="rp-card-open-circle"><span>開</span></div>';
            var waitingHTML = isClaimable
                ? '<div class="rp-card-waiting">点击"開"拆红包</div>'
                : '<div class="rp-card-waiting">等待' + _esc(settings.partnerName || '梦角') + '领取</div>';
            html =
                '<div class="rp-card rp-card-sealed' + stickerClass + '">' + (hasSticker ? _CARD_BG_SEALED_STICKER : _CARD_BG_SEALED) +
                    '<button class="rp-card-menu-btn" title="查看历史红包记录" onclick="hideModal(document.getElementById(\'redpacket-view-modal\'));window.RedPacket.openHistoryModal(\'' + direction + '\');"><i class="fas fa-ellipsis-h"></i></button>' +
                    '<div class="rp-card-header-row">' +
                        '<div class="rp-card-avatar">' + avatarHtml + '</div>' +
                        '<div class="rp-card-sender">' + _esc(senderLabel) + '</div>' +
                    '</div>' +
                    '<div class="rp-card-blessing">' + _esc(record.blessing) + '</div>' +
                    stickerHTML +
                    openCircleHTML +
                    waitingHTML +
                    '<button class="rp-card-close" onclick="window.RedPacket.closeViewModal()">' + _CLOSE_BTN_SEALED + '</button>' +
                '</div>';
        } else if (record.status === 'received') {
            html =
                '<div class="rp-card rp-card-opened' + stickerClass + '">' + (hasSticker ? _CARD_BG_OPENED_STICKER : _CARD_BG_OPENED) +
                    '<div class="rp-card-header-row">' +
                        '<div class="rp-card-avatar">' + avatarHtml + '</div>' +
                        '<div class="rp-card-sender-dark">' + _esc(senderLabel) + '</div>' +
                    '</div>' +
                    '<div class="rp-card-blessing-grey">' + _esc(record.blessing) + '</div>' +
                    stickerHTML +
                    '<div class="rp-card-amount">' + _formatAmountDisplay(record.amount) + ' <span class="rp-card-amount-unit">元</span></div>' +
                    '<div class="rp-card-link rp-card-link-clickable" onclick="hideModal(document.getElementById(\'redpacket-view-modal\'));window.RedPacket.openHistoryModal(\'' + direction + '\');">查看历史红包记录 <i class="fas fa-chevron-right"></i></div>' +
                    '<button class="rp-card-close" onclick="window.RedPacket.closeViewModal()">' + _CLOSE_BTN_OPENED + '</button>' +
                '</div>';
        } else {
            html =
                '<div class="rp-card rp-card-returned' + stickerClass + '">' + (hasSticker ? _CARD_BG_RETURNED_STICKER : _CARD_BG_RETURNED) +
                    '<div class="rp-card-header-row">' +
                        '<div class="rp-card-avatar">' + avatarHtml + '</div>' +
                        '<div class="rp-card-sender-dark">' + _esc(senderLabel) + '</div>' +
                    '</div>' +
                    '<div class="rp-card-blessing-grey">' + _esc(record.blessing) + '</div>' +
                    stickerHTML +
                    '<div class="rp-card-amount rp-card-amount-muted">' + _formatAmountDisplay(record.amount) + ' <span class="rp-card-amount-unit">元</span></div>' +
                    '<div class="rp-card-link rp-card-link-clickable" onclick="hideModal(document.getElementById(\'redpacket-view-modal\'));window.RedPacket.openHistoryModal(\'' + direction + '\');">查看历史红包记录 <i class="fas fa-chevron-right"></i></div>' +
                    '<button class="rp-card-close" onclick="window.RedPacket.closeViewModal()">' + _CLOSE_BTN_RETURNED + '</button>' +
                '</div>';
        }
        wrap.innerHTML = html;
        if (hasSticker) _bindStickerLazyLoad(wrap);
    }

    // ── 发红包弹窗（编写金额+祝福语+表情包） ──────────────────────
    var _composeSticker = null; // 当前表单里选中的表情包src，没选就是null

    function _syncComposePreview() {
        var amountInput = document.getElementById('rp-compose-amount');
        var preview = document.getElementById('rp-compose-preview-amount');
        if (!amountInput || !preview) return;
        var n = parseFloat(amountInput.value);
        preview.textContent = (isNaN(n) ? 0 : n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function _syncStickerSlotUI() {
        var icon = document.getElementById('rp-compose-sticker-slot-icon');
        var img = document.getElementById('rp-compose-sticker-slot-img');
        if (!icon || !img) return;
        if (_composeSticker) {
            icon.style.display = 'none';
            img.removeAttribute('src');
            img.removeAttribute('data-lazy-cloud-ref');
            if (typeof _composeSticker === 'string' && _composeSticker.indexOf('oss://') === 0) {
                img.setAttribute('data-lazy-cloud-ref', _composeSticker);
                if (window.CloudMedia) window.CloudMedia.bindLazyImage(img, _composeSticker);
            } else {
                img.src = _composeSticker;
            }
            img.style.display = 'block';
        } else {
            icon.style.display = '';
            img.style.display = 'none';
            img.removeAttribute('src');
            img.removeAttribute('data-lazy-cloud-ref');
        }
    }

    function openComposeModal() {
        var amountInput = document.getElementById('rp-compose-amount');
        var blessingInput = document.getElementById('rp-compose-blessing');
        if (amountInput) amountInput.value = '';
        if (blessingInput) blessingInput.value = '';
        _composeSticker = null;
        _syncStickerSlotUI();
        _syncComposePreview();
        var modal = document.getElementById('redpacket-compose-modal');
        if (modal && typeof showModal === 'function') showModal(modal, amountInput);
    }

    // 表情槽位点击：已经选了 → 弹删除确认；还没选 → 打开选择器
    function onStickerSlotClick() {
        if (_composeSticker) {
            var delModal = document.getElementById('rp-sticker-delete-modal');
            if (delModal && typeof showModal === 'function') showModal(delModal);
        } else {
            _openStickerPicker();
        }
    }

    function confirmStickerDelete() {
        _composeSticker = null;
        _syncStickerSlotUI();
        var delModal = document.getElementById('rp-sticker-delete-modal');
        if (delModal && typeof hideModal === 'function') hideModal(delModal);
    }

    // 表情选择器：直接复用"我的表情库"(myStickerLibrary)的内容源，不是另起一个上传入口
    function _openStickerPicker() {
        var grid = document.getElementById('rp-sticker-picker-grid');
        if (grid) {
            var pool = (typeof myStickerLibrary !== 'undefined' && Array.isArray(myStickerLibrary)) ? myStickerLibrary : [];
            if (!pool.length) {
                grid.innerHTML = '<div class="rp-sticker-picker-empty">"我的表情库"里还没有表情，去聊天输入框那边先添加几个吧</div>';
            } else {
                function itemHTML(s) {
                    var src = typeof s === 'string' ? s : s.src;
                    var isCloud = typeof src === 'string' && src.indexOf('oss://') === 0;
                    var imgTag = isCloud ? '<img data-lazy-cloud-ref="' + _esc(src) + '">' : '<img src="' + _esc(src) + '">';
                    return '<button type="button" class="rp-sticker-picker-item" data-src="' + _esc(src) + '">' + imgTag + '</button>';
                }
                // 照搬"我的表情库"本来的分组结构渲染，不打散混在一起
                // 这里必须显式读 window.myStickerGroups，不能用裸变量名——
                // state.js 用 let 声明了同名的 myStickerGroups（一个从来没被填过的空数组），
                // core.js 实际更新的是 window.myStickerGroups 这个属性，两者是两个不同的东西，
                // 裸变量名读到的永远是 state.js 那个空数组，会被"遮蔽"成一直读到空分组
                var groups = (window.myStickerGroups && Array.isArray(window.myStickerGroups)) ? window.myStickerGroups : [];
                var html = '';
                var usedIds = {};
                groups.forEach(function (g) {
                    var items = pool.filter(function (s) { return typeof s !== 'string' && s.groupId === g.id; });
                    if (!items.length) return;
                    items.forEach(function (s) { usedIds[s.id] = true; });
                    html += '<div class="rp-sticker-picker-group-label">' + _esc(g.name) + '</div>' +
                        '<div class="rp-sticker-picker-group-grid">' + items.map(itemHTML).join('') + '</div>';
                });
                var ungrouped = pool.filter(function (s) { return typeof s === 'string' || !usedIds[s.id]; });
                if (ungrouped.length) {
                    html += '<div class="rp-sticker-picker-group-label">未分组</div>' +
                        '<div class="rp-sticker-picker-group-grid">' + ungrouped.map(itemHTML).join('') + '</div>';
                }
                grid.innerHTML = html;
                _bindStickerLazyLoad(grid);
                grid.querySelectorAll('.rp-sticker-picker-item').forEach(function (btn) {
                    btn.addEventListener('click', function () {
                        _composeSticker = btn.dataset.src;
                        _syncStickerSlotUI();
                        var pickerModal = document.getElementById('rp-sticker-picker-modal');
                        if (pickerModal && typeof hideModal === 'function') hideModal(pickerModal);
                    });
                });
            }
        }
        var modal = document.getElementById('rp-sticker-picker-modal');
        if (modal && typeof showModal === 'function') showModal(modal);
    }

    async function submitCompose() {
        var amountInput = document.getElementById('rp-compose-amount');
        var blessingInput = document.getElementById('rp-compose-blessing');
        var btn = document.getElementById('rp-compose-send-btn');
        if (!amountInput) return;
        if (btn) btn.disabled = true;
        var ok = await sendUserRedPacket(amountInput.value, blessingInput ? blessingInput.value : '', _composeSticker);
        if (btn) btn.disabled = false;
        if (ok) {
            var modal = document.getElementById('redpacket-compose-modal');
            if (modal && typeof hideModal === 'function') hideModal(modal);
            if (typeof showNotification === 'function') showNotification('红包已发出～', 'success', 2000);
        }
    }

    // ================================================================
    // 历史红包记录页（文档第7节）：居中弹窗，"我发出的"/"梦角发出的"两个tab，
    // 顶部统计（总金额+共发出+对方已领取数，已退回不计入统计），
    // 下方按日期分组的明细列表，结构参照电影院观影记录"顶部汇总+按天列表"那套。
    // ================================================================
    var _historyTab = 'inbox';

    // 拆红包卡片弹窗是从历史记录点进来的，关掉之后要回到历史列表，不是直接消失——
    // 用这个标志记一下，closeViewModal 关的时候会检查它
    var _viewModalFromHistory = false;

    function openHistoryDetail(recordId, direction) {
        var record = getById(recordId, direction);
        if (!record) {
            if (typeof showNotification === 'function') showNotification('这条记录找不到了', 'error');
            return;
        }
        var originalSenderIsUser = (direction === 'outbox');
        _viewModalFromHistory = true;
        _renderViewModal(record, originalSenderIsUser ? 'user' : 'partner', direction);
        var historyModal = document.getElementById('redpacket-history-modal');
        var viewModal = document.getElementById('redpacket-view-modal');
        if (historyModal && typeof hideModal === 'function') hideModal(historyModal);
        if (viewModal && typeof showModal === 'function') showModal(viewModal);
    }

    // 所有"×"关闭按钮都走这个，不再直接调 hideModal——如果这张卡片是从历史记录点进来的，
    // 关掉之后要自动重新弹出历史列表，不是就此什么都不剩
    function closeViewModal() {
        var viewModal = document.getElementById('redpacket-view-modal');
        if (viewModal && typeof hideModal === 'function') hideModal(viewModal);
        if (_viewModalFromHistory) {
            _viewModalFromHistory = false;
            openHistoryModal(_historyTab);
        }
    }

    function openHistoryModal(tab) {
        _historyTab = tab === 'inbox' ? 'inbox' : 'outbox';
        _renderHistory();
        var modal = document.getElementById('redpacket-history-modal');
        if (modal && typeof showModal === 'function') showModal(modal);
    }

    function switchHistoryTab(tab) {
        _historyTab = tab === 'inbox' ? 'inbox' : 'outbox';
        _renderHistory();
    }

    function _historyDateKey(ts) {
        var d = new Date(ts);
        return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
    }
    function _historyDateLabel(ts) {
        var d = new Date(ts);
        var today = new Date();
        var yest = new Date(Date.now() - 86400000);
        if (_historyDateKey(ts) === _historyDateKey(today.getTime())) return '今天';
        if (_historyDateKey(ts) === _historyDateKey(yest.getTime())) return '昨天';
        return d.getFullYear() === today.getFullYear()
            ? (d.getMonth() + 1) + '月' + d.getDate() + '日'
            : d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
    }

    function _historyEntryHTML(r, direction) {
        var statusLabel = r.status === 'received' ? '已领取' : (r.status === 'returned' ? '已过期' : '待领取');
        var statusClass = r.status === 'received' ? 'rp-hist-status-received' : (r.status === 'returned' ? 'rp-hist-status-returned' : 'rp-hist-status-pending');
        var timeStr = new Date(r.sentTime).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
        return (
            '<div class="rp-hist-row" data-id="' + r.id + '" data-direction="' + direction + '" onclick="window.RedPacket.openHistoryDetail(\'' + r.id + '\', \'' + direction + '\')">' +
                '<span class="rp-hist-row-icon">' + _ICON_SVG + '</span>' +
                '<div class="rp-hist-row-mid">' +
                    '<div class="rp-hist-row-blessing">' + _esc(r.blessing) + '</div>' +
                    '<div class="rp-hist-row-time">' + timeStr + '</div>' +
                '</div>' +
                '<div class="rp-hist-row-right">' +
                    '<div class="rp-hist-row-amount">' + _formatAmountShort(r.amount) + ' 元</div>' +
                    '<div class="rp-hist-row-status ' + statusClass + '">' + statusLabel + '</div>' +
                '</div>' +
            '</div>'
        );
    }

    function _renderHistory() {
        // 接收方视角：outbox这份数据是"我发的"，但收钱的人是梦角，所以站在"谁收到"的角度看，
        // 这个tab该叫"梦角收到的"；inbox反过来是"我收到的"——底下装的记录跟以前完全一样，
        // 只是tab文案换了个角度说
        var myReceivedLabel = (settings.myName || '我') + '收到的';
        var partnerReceivedLabel = (settings.partnerName || '梦角') + '收到的';
        document.querySelectorAll('.rp-history-tab').forEach(function (btn) {
            var isActive = btn.dataset.tab === _historyTab;
            btn.classList.toggle('active', isActive);
            btn.textContent = btn.dataset.tab === 'outbox' ? partnerReceivedLabel : myReceivedLabel;
        });

        var list = (_data[_historyTab] || []).slice();
        var isOutbox = _historyTab === 'outbox';
        var receiverLabel = isOutbox ? (settings.partnerName || '梦角') + '已领取' : (settings.myName || '我') + '已领取';

        // 已退回不计入总金额和已领取数量统计（文档明确要求）
        var totalAmount = 0, receivedCount = 0;
        list.forEach(function (r) {
            if (r.status === 'received') { totalAmount += r.amount; receivedCount++; }
        });

        var statsEl = document.getElementById('rp-history-stats');
        if (statsEl) {
            statsEl.innerHTML =
                '<div class="rp-history-total">' + _formatAmountDisplay(totalAmount) + ' <span class="rp-history-total-unit">元</span></div>' +
                '<div class="rp-history-mini-cards">' +
                    '<div class="rp-history-mini-card"><div class="rp-history-mini-num">' + list.length + '</div><div class="rp-history-mini-label">共收到</div></div>' +
                    '<div class="rp-history-mini-card"><div class="rp-history-mini-num">' + receivedCount + '</div><div class="rp-history-mini-label">' + _esc(receiverLabel) + '</div></div>' +
                '</div>';
        }

        var listEl = document.getElementById('rp-history-list');
        if (!listEl) return;
        if (!list.length) {
            listEl.innerHTML = '<div class="rp-history-empty">还没有红包记录</div>';
            return;
        }
        var sorted = list.slice().sort(function (a, b) { return b.sentTime - a.sentTime; });
        var groups = []; // [{label, items:[]}]，保持按时间从新到旧分组，同一天归一组
        sorted.forEach(function (r) {
            var label = _historyDateLabel(r.sentTime);
            var g = groups.length && groups[groups.length - 1].label === label ? groups[groups.length - 1] : null;
            if (!g) { g = { label: label, items: [] }; groups.push(g); }
            g.items.push(r);
        });
        listEl.innerHTML = groups.map(function (g) {
            return '<div class="rp-hist-day-group">' +
                '<div class="rp-hist-day-label">' + _esc(g.label) + '</div>' +
                g.items.map(function (r) { return _historyEntryHTML(r, _historyTab); }).join('') +
            '</div>';
        }).join('');
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
        _scheduleNextPartnerCheck();
        _updateExpiryReminder();

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
        playOpenAnimation: playOpenAnimation,
        generatePartnerAmount: generatePartnerAmount,
        debugAmountDistribution: debugAmountDistribution,
        debugForcePartnerCheck: debugForcePartnerCheck,
        debugSchedulerState: debugSchedulerState,
        debugTestReminder: debugTestReminder,
        debugSimulateScheduler: debugSimulateScheduler,
        jumpToExpiryReminder: jumpToExpiryReminder,
        openHistoryModal: openHistoryModal,
        openHistoryDetail: openHistoryDetail,
        closeViewModal: closeViewModal,
        switchHistoryTab: switchHistoryTab,
        onStickerSlotClick: onStickerSlotClick,
        confirmStickerDelete: confirmStickerDelete,
        renderBubbleHTML: renderBubbleHTML,
        openByMessageId: openByMessageId,
        openComposeModal: openComposeModal,
        submitCompose: submitCompose,
        checkRedPacketStatus: checkRedPacketStatus,
        getById: getById
    };
})();
