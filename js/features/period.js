/**
 * period.js — 经期记录功能 Step 2
 * 数据持久化 + 日历渲染 + 统计计算 + 标记逻辑
 */
(function () {
    'use strict';

    // ── 常量 ──────────────────────────────────────────
    var DEFAULT_SYMPTOMS = ['痛经', '腰酸', '头痛', '疲惫', '胸胀', '恶心'];
    var FLOW_LABELS      = ['', '极少', '少', '正常', '多', '极多'];
    var WEEKDAYS         = ['日', '一', '二', '三', '四', '五', '六'];

    // ── 内存状态 ──────────────────────────────────────
    // _data 结构：
    // {
    //   periods: [ { id, startDate, endDate|null } ],
    //   dailyRecords: { 'YYYY-MM-DD': { flow:0-5, symptoms:[] } },
    //   customSymptoms: [],
    //   partnerMsg: { periodId, lines:[] } | null,
    //   notifyAt: timestamp | null,
    //   notifyPeriodId: string | null
    // }
    var _data   = { periods: [], dailyRecords: {}, customSymptoms: [], partnerMsg: null, notifyAt: null, notifyPeriodId: null };
    var _loaded = false;
    var _viewYear, _viewMonth;   // 0-based month
    var _currentFlow     = 0;
    var _currentSymptoms = [];
    var _longPressTimer  = null;
    var _storageKey      = null;

    // ── Storage ───────────────────────────────────────
    async function _getKey() {
        if (_storageKey) return _storageKey;
        try {
            var allKeys = await localforage.keys();
            var found = allKeys.find(function (k) { return k.indexOf('_periodData') !== -1; });
            if (found) { _storageKey = found; return found; }
            // 推导 session prefix
            var msgKey = allKeys.find(function (k) { return k.indexOf('_messages') !== -1; });
            var prefix = msgKey ? msgKey.replace('_messages', '') : 'CHAT_APP_V3_';
            _storageKey = prefix + '_periodData';
        } catch (e) {
            _storageKey = 'CHAT_APP_V3__periodData';
        }
        return _storageKey;
    }

    async function _load() {
        try {
            var key = await _getKey();
            var saved = await localforage.getItem(key);
            if (saved && saved.periods) {
                _data = saved;
                if (!_data.dailyRecords)   _data.dailyRecords   = {};
                if (!_data.customSymptoms) _data.customSymptoms = [];
            }
        } catch (e) { console.warn('[period] load failed:', e); }
        // 开机自检：把满足合并条件、但因为之前版本的bug没能合并的历史碎片自动接好，
        // 不用用户再手动操作一次。_reconcilePeriods 定义在下面，这里是前向引用，
        // 因为函数声明会整体提升，运行时没问题。
        _reconcilePeriods();
        _save();
        _loaded = true;
    }

    async function _save() {
        try {
            var key = await _getKey();
            await localforage.setItem(key, _data);
        } catch (e) { console.warn('[period] save failed:', e); }
    }

    // ── 日期工具 ──────────────────────────────────────
    function _pad(n) { return String(n).padStart(2, '0'); }
    function _toStr(d) { return d.getFullYear() + '-' + _pad(d.getMonth() + 1) + '-' + _pad(d.getDate()); }
    function _today()  { return _toStr(new Date()); }
    function _parse(s) { var p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
    function _diff(a, b) { return Math.round((_parse(b) - _parse(a)) / 86400000); }
    function _addD(s, n) { var d = _parse(s); d.setDate(d.getDate() + n); return _toStr(d); }

    // ── Period 查询 ───────────────────────────────────
    function _getPeriodOf(dateStr) {
        return _data.periods.find(function (p) {
            if (dateStr < p.startDate) return false;
            if (p.endDate)  return dateStr <= p.endDate;
            return dateStr <= _today();
        }) || null;
    }
    function _isInPeriod(dateStr) { return !!_getPeriodOf(dateStr); }
    function _getDayNum(dateStr) {
        var p = _getPeriodOf(dateStr);
        return p ? _diff(p.startDate, dateStr) + 1 : 0;
    }
    function _activePeriod() {
        return _data.periods.find(function (p) { return !p.endDate; }) || null;
    }

    // 区间宽度：历史周期波动越大，区间越宽；波动很小时至少给±2天，避免看起来像没算清楚
    function _calcSwing(gaps) {
        if (gaps.length < 2) return 2;
        var maxGap = Math.max.apply(null, gaps);
        var minGap = Math.min.apply(null, gaps);
        return Math.min(5, Math.max(2, Math.round((maxGap - minGap) / 2)));  // 上限5天，避免历史数据不稳定时区间宽得离谱
    }

    // ── 统计 ──────────────────────────────────────────
    function _calcStats() {
        var completed = _data.periods.filter(function (p) { return p.endDate; });

        // 平均经期天数
        var avgDays = '--';
        if (completed.length > 0) {
            var total = completed.reduce(function (s, p) { return s + _diff(p.startDate, p.endDate) + 1; }, 0);
            avgDays = Math.round(total / completed.length) + '天';
        }

        // 预测下次 —— 始终给区间，不再有"波动小就给单一日期"的分支：
        // 经期本身就有生理波动，给一个看似精确的单一日期反而是假精确。
        // 区间宽度跟着历史波动走：波动越大区间越宽；波动很小时至少给±2天，
        // 避免看起来像没算清楚。
        var nextDate = '暂无预测';
        var sorted = _data.periods.slice().sort(function (a, b) { return a.startDate < b.startDate ? -1 : 1; });
        if (sorted.length >= 2) {
            var gaps = [];
            for (var i = 1; i < sorted.length; i++) {
                gaps.push(_diff(sorted[i - 1].startDate, sorted[i].startDate));
            }
            var avgCycle = Math.round(gaps.reduce(function (a, b) { return a + b; }, 0) / gaps.length);
            var lastStart = sorted[sorted.length - 1].startDate;
            var predStart = _addD(lastStart, avgCycle);

            var swing = _calcSwing(gaps);
            var lo = _parse(_addD(predStart, -swing));
            var hi = _parse(_addD(predStart, swing));
            nextDate = (lo.getMonth() + 1) + '月' + lo.getDate() + '日 ~ ' +
                       (hi.getMonth() + 1) + '月' + hi.getDate() + '日';
        }

        return { avgDays: avgDays, nextDate: nextDate };
    }

    function _predictedDates() {
        var dates = {};
        var completed = _data.periods.filter(function (p) { return p.endDate; });

        // 1）当前正在进行的经期（还没标记结束）——按历史平均时长推算，
        //    "还没到/还没打卡"的那几天大概率也算经期，标成浅色预测
        var active = _activePeriod();
        if (active && completed.length > 0) {
            var avgDur = Math.round(completed.reduce(function (s, p) { return s + _diff(p.startDate, p.endDate) + 1; }, 0) / completed.length);
            for (var d = 0; d < avgDur; d++) {
                var ds = _addD(active.startDate, d);
                if (!_isInPeriod(ds)) dates[ds] = true;  // 已经算作经期(到今天为止)的不用重复标
            }
        }

        // 2）下一次经期的预测窗口——高亮范围跟统计卡片里显示的区间完全对齐，
        //    不再额外叠加经期时长（之前这里多加了一层，导致日历高亮的范围比
        //    文字描述的区间宽出一大截，看起来莫名其妙）
        var sorted = _data.periods.slice().sort(function (a, b) { return a.startDate < b.startDate ? -1 : 1; });
        if (sorted.length >= 2) {
            var gaps = [];
            for (var i = 1; i < sorted.length; i++) {
                gaps.push(_diff(sorted[i - 1].startDate, sorted[i].startDate));
            }
            var avgCycle = Math.round(gaps.reduce(function (a, b) { return a + b; }, 0) / gaps.length);
            var swing = _calcSwing(gaps);
            var predStart = _addD(sorted[sorted.length - 1].startDate, avgCycle);
            for (var s = -swing; s <= swing; s++) dates[_addD(predStart, s)] = true;
        }

        return Object.keys(dates);
    }

    // ── 经期操作 ──────────────────────────────────────
    function _startPeriod(dateStr, sendNotif) {
        if (_isInPeriod(dateStr)) return;
        var active = _activePeriod();
        if (active) active.endDate = _addD(dateStr, -1);  // 自动结束上次
        _data.periods.push({ id: 'pd_' + Date.now(), startDate: dateStr, endDate: null });
        _save();
        if (sendNotif) _scheduleNotif();
    }

    // 把间隔在合理范围内的经期记录自动接成一条——不管是新长按产生的碎片，
    // 还是账号里本来就存在的历史碎片，每次数据变动后调用一次就会自动愈合。
    // 阈值定为10天：正常经期很少超过7天，10天已经留足余量；
    // 同时明显小于两次不同经期之间的间隔（哪怕周期很不规律，通常也不会短于10天以内），
    // 所以不容易把两次完全不同的经期误判成一条。
    var MERGE_GAP_LIMIT = 5;
    function _reconcilePeriods() {
        _data.periods.sort(function (a, b) { return a.startDate < b.startDate ? -1 : 1; });
        for (var i = 0; i < _data.periods.length - 1; i++) {
            var cur = _data.periods[i], next = _data.periods[i + 1];
            if (!cur.endDate) continue;  // cur 正在进行中（理论上只会是排序后最后一条），没法再往后并
            if (_diff(cur.endDate, next.startDate) <= MERGE_GAP_LIMIT) {
                cur.endDate = next.endDate;  // next 若也在进行中，合并后 cur 也变成进行中
                _data.periods.splice(i + 1, 1);
                i--;  // 合并后原地再检查一次，可能还能继续往后并
            }
        }
    }

    function _toggleHistory(dateStr) {
        var p = _getPeriodOf(dateStr);
        if (p) {
            if (p.startDate === dateStr) {
                _data.periods = _data.periods.filter(function (x) { return x.id !== p.id; });
            } else {
                p.endDate = _addD(dateStr, -1);
            }
        } else {
            _data.periods.push({ id: 'pd_' + Date.now(), startDate: dateStr, endDate: dateStr });
        }
        _reconcilePeriods();
        _save();
    }

    // ── 通知（梦角留言） ──────────────────────────────
    function _scheduleNotif() {
        var active = _activePeriod();
        if (!active) return;
        if (_data.notifyPeriodId === active.id) return;  // 已安排
        _data.notifyAt       = Date.now() + (20 + Math.floor(Math.random() * 11)) * 60000;
        _data.notifyPeriodId = active.id;
        _save();
    }

    function _checkNotif() {
        if (!_data.notifyAt || !_data.notifyPeriodId) return;
        if (Date.now() < _data.notifyAt) return;
        if (_data.partnerMsg && _data.partnerMsg.periodId === _data.notifyPeriodId) return;

        var replies = (window._customReplies) ||
                      (typeof customReplies !== 'undefined' ? customReplies : []) || [];
        if (!replies.length) return;

        var shuffled = replies.slice().sort(function () { return Math.random() - 0.5; });
        var lines    = shuffled.slice(0, 2 + Math.floor(Math.random() * 2));

        _data.partnerMsg = { periodId: _data.notifyPeriodId, lines: lines };
        _data.notifyAt   = null;
        _save();

        _showPdNotif(lines);
        _renderLetterCard();
    }

    function _showPdNotif(lines) {
        var existing = document.getElementById('pd-notif-popup');
        if (existing) existing.remove();

        var pname = _partnerName();
        var popup = document.createElement('div');
        popup.id = 'pd-notif-popup';
        popup.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);' +
            'background:var(--secondary-bg);border:1px solid var(--border-color);' +
            'border-radius:20px;padding:18px 20px;z-index:9000;max-width:320px;width:88%;' +
            'box-shadow:0 8px 32px rgba(0,0,0,0.18);display:flex;flex-direction:column;gap:12px;' +
            'animation:_mSlideUp 0.4s cubic-bezier(0.22,1,0.36,1);';
        popup.innerHTML =
            '<div style="display:flex;align-items:center;gap:10px;">' +
                '<span style="font-size:26px;">🌸</span>' +
                '<div>' +
                    '<div style="font-size:14px;font-weight:700;color:var(--text-primary);">' + pname + ' 有话想说</div>' +
                    '<div style="font-size:11px;color:var(--text-secondary);margin-top:2px;opacity:0.8;">去经期记录里看看</div>' +
                '</div>' +
            '</div>' +
            '<div style="display:flex;gap:8px;">' +
                '<button onclick="document.getElementById(\'pd-notif-popup\').remove();" ' +
                    'style="flex:1;padding:8px 0;border-radius:12px;border:1px solid var(--border-color);background:var(--primary-bg);color:var(--text-secondary);font-size:13px;cursor:pointer;font-family:inherit;">稍后</button>' +
                '<button onclick="window._pdGoToPeriodTab();document.getElementById(\'pd-notif-popup\').remove();" ' +
                    'style="flex:2;padding:8px 0;border-radius:12px;border:none;background:var(--accent-color);color:#fff;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;">立即查看 ✦</button>' +
            '</div>';
        document.body.appendChild(popup);
        setTimeout(function () { if (popup.parentNode) popup.remove(); }, 8000);
    }

    window._pdGoToPeriodTab = function () {
        var modal = document.getElementById('period-modal');
        if (modal && typeof window.showModal === 'function') {
            window.showModal(modal);
            window._pdInit();
        }
    };

    // ── UI 渲染 ───────────────────────────────────────
    function _updateStats() {
        var s = _calcStats();
        var nEl = document.getElementById('pd-next-date');
        var aEl = document.getElementById('pd-avg-days');
        if (nEl) nEl.textContent = s.nextDate;
        if (aEl) aEl.textContent = s.avgDays;
    }

    function _updateToggleBtn() {
        var track = document.getElementById('pd-toggle-btn');   // pd-toggle-track
        var label = document.getElementById('pd-toggle-label');
        if (!track || !label) return;
        var inP = _isInPeriod(_today());
        track.classList.toggle('pd-toggle-on', inP);
        label.textContent = inP ? '经期中' : '标记经期';
    }

    function _updateStatusCard() {
        var today  = _today();
        var dayTag = document.getElementById('pd-status-day-tag');
        var dateEl = document.getElementById('pd-status-date');
        var now    = new Date();
        if (dateEl) dateEl.textContent = (now.getMonth() + 1) + '月' + now.getDate() + '日';

        if (dayTag) {
            var dayNum = _getDayNum(today);
            if (dayNum > 0) {
                dayTag.textContent  = '经期第' + dayNum + '天';
                dayTag.style.display = '';
            } else {
                dayTag.style.display = 'none';
            }
        }

        // 载入今天已有的记录
        var rec      = _data.dailyRecords[today];
        _currentFlow     = rec ? (rec.flow || 0) : 0;
        _currentSymptoms = rec ? (rec.symptoms ? rec.symptoms.slice() : []) : [];

        document.querySelectorAll('.pd-flow-btn').forEach(function (btn) {
            btn.classList.toggle('pd-flow-active', Number(btn.dataset.val) === _currentFlow);
        });

        _updateSaveBtn(!!rec);
        _renderSymptoms();
    }

    function _updateSaveBtn(saved) {
        var btn  = document.getElementById('pd-save-btn');
        var hint = document.getElementById('pd-saved-hint');
        if (!btn) return;
        if (saved) {
            btn.textContent  = '已保存';
            btn.disabled     = true;
            btn.style.opacity = '0.5';
            if (hint) hint.textContent = '';
        } else {
            btn.textContent  = '保存记录';
            btn.disabled     = false;
            btn.style.opacity = '';
        }
    }

    // ── 日历 ──────────────────────────────────────────
    function _renderCalendar() {
        var label = document.getElementById('pd-month-label');
        if (label) label.textContent = _viewYear + '年' + (_viewMonth + 1) + '月';

        var grid = document.getElementById('pd-cal-grid');
        if (!grid) return;

        var firstDay    = new Date(_viewYear, _viewMonth, 1).getDay();
        var daysInMonth = new Date(_viewYear, _viewMonth + 1, 0).getDate();
        var today       = _today();
        var predicted   = _predictedDates();

        var html = '';
        var prevTotal = new Date(_viewYear, _viewMonth, 0).getDate();
        for (var i = firstDay - 1; i >= 0; i--) {
            var ds = _toStr(new Date(_viewYear, _viewMonth - 1, prevTotal - i));
            html += _cellHtml(prevTotal - i, ds, today, predicted, true);
        }
        for (var d = 1; d <= daysInMonth; d++) {
            var ds2 = _toStr(new Date(_viewYear, _viewMonth, d));
            html += _cellHtml(d, ds2, today, predicted, false);
        }
        var total = firstDay + daysInMonth;
        var nextDays = total % 7 === 0 ? 0 : 7 - (total % 7);
        for (var n = 1; n <= nextDays; n++) {
            var ds3 = _toStr(new Date(_viewYear, _viewMonth + 1, n));
            html += _cellHtml(n, ds3, today, predicted, true);
        }

        grid.innerHTML = html;
        _bindCalCells(grid);
    }

    function _cellHtml(day, dateStr, today, predicted, otherMonth) {
        var cls = 'pd-cal-cell';
        if (otherMonth) cls += ' pd-other-month';
        if (dateStr === today) cls += ' pd-today';
        if (_isInPeriod(dateStr)) cls += ' pd-period';
        else if (predicted.indexOf(dateStr) !== -1) cls += ' pd-predict';
        // 有日记录但没有颜色时加小圆点
        var dot = (!otherMonth && _data.dailyRecords[dateStr] && !_isInPeriod(dateStr) && predicted.indexOf(dateStr) === -1)
            ? '<span class="pd-cal-dot"></span>' : '';
        return '<div class="' + cls + '" data-date="' + dateStr + '">' + day + dot + '</div>';
    }

    function _bindCalCells(grid) {
        grid.querySelectorAll('.pd-cal-cell').forEach(function (cell) {
            var dateStr = cell.dataset.date;
            if (!dateStr) return;
            var otherMonth = cell.classList.contains('pd-other-month');

            // 长按：仅历史非当月格子以及当月历史格子
            if (!otherMonth) {
                cell.addEventListener('touchstart', function () {
                    _longPressTimer = setTimeout(function () {
                        _longPressTimer = null;
                        if (dateStr < _today()) {
                            cell._longPressed = true;  // 标记这次是长按触发的，供下面 click 处理跳过
                            _toggleHistory(dateStr);
                            _renderCalendar();
                            _updateStats();
                            _updateToggleBtn();
                            _updateStatusCard();  // 之前漏了这一行：长按补录后"今日记录"卡片的经期天数标签不会跟着刷新
                        }
                    }, 600);
                }, { passive: true });
                cell.addEventListener('touchend', function () {
                    if (_longPressTimer) { clearTimeout(_longPressTimer); _longPressTimer = null; }
                });
                cell.addEventListener('touchmove', function () {
                    if (_longPressTimer) { clearTimeout(_longPressTimer); _longPressTimer = null; }
                });
            }

            // 单击
            cell.addEventListener('click', function () {
                // 长按刚触发完，手机上松手常常会跟着补一个click事件——之前这里想跳过这种情况，
                // 但判断条件里用来标记"刚长按过"的 cell._longPressed 从没被真正设置过（死代码，
                // 长按已经在上面正确设置了这个标记），现在直接读它、读完立刻清掉，避免下次误判。
                if (cell._longPressed) { cell._longPressed = false; return; }
                var today = _today();
                if (dateStr === today) {
                    var card = document.getElementById('pd-status-card');
                    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
                } else if (!otherMonth) {
                    _openDaySheet(dateStr);
                }
            });
        });
    }

    // ── 历史日弹窗（只读） ────────────────────────────
    function _openDaySheet(dateStr) {
        var d = _parse(dateStr);
        var titleEl = document.getElementById('pd-day-sheet-title');
        if (titleEl) titleEl.textContent = (d.getMonth() + 1) + '月' + d.getDate() + '日';

        var tagEl    = document.getElementById('pd-day-period-tag');
        var infoRow  = document.getElementById('pd-day-info-row');
        var dayNum   = _getDayNum(dateStr);
        if (tagEl)   { tagEl.textContent = '经期第' + dayNum + '天'; tagEl.style.display = dayNum > 0 ? '' : 'none'; }
        if (infoRow) infoRow.style.display = dayNum > 0 ? '' : 'none';

        var rec        = _data.dailyRecords[dateStr];
        var contentEl  = document.getElementById('pd-day-content');
        var emptyEl    = document.getElementById('pd-day-empty');
        var isEmpty    = dayNum === 0 && !rec;  // 既不在经期里，也没有任何打卡记录 —— 缺省状态

        if (isEmpty) {
            if (contentEl) contentEl.style.display = 'none';
            if (emptyEl)   emptyEl.style.display = '';
        } else {
            if (contentEl) contentEl.style.display = '';
            if (emptyEl)   emptyEl.style.display = 'none';

            var flowEl = document.getElementById('pd-day-flow-display');
            var sympEl = document.getElementById('pd-day-symptom-tags');
            if (flowEl) flowEl.textContent = (rec && rec.flow) ? FLOW_LABELS[rec.flow] : '暂无出血量记录';
            if (sympEl) {
                if (rec && rec.symptoms && rec.symptoms.length) {
                    sympEl.innerHTML = rec.symptoms.map(function (s) {
                        return '<span class="pd-day-symptom-tag">' + s + '</span>';
                    }).join('');
                } else {
                    sympEl.innerHTML = '<span style="color:var(--text-secondary);font-size:12px;opacity:0.6;">暂无症状记录</span>';
                }
            }
        }

        var sheet = document.getElementById('pd-day-sheet');
        if (sheet && typeof window.showModal === 'function') window.showModal(sheet);
    }

    // ── 症状渲染 ──────────────────────────────────────
    function _renderSymptoms() {
        var wrap = document.getElementById('pd-symptoms-wrap');
        if (!wrap) return;
        var all = DEFAULT_SYMPTOMS.concat(_data.customSymptoms || []);
        var html = all.map(function (s) {
            var on = _currentSymptoms.indexOf(s) !== -1;
            return '<button class="pd-symptom-chip' + (on ? ' pd-chip-on' : '') +
                   '" onclick="window._pdToggleSymptom(this)">' + s + '</button>';
        }).join('');
        html += '<button class="pd-symptom-add" onclick="window._pdAddSymptom()">+ 自定义</button>';
        wrap.innerHTML = html;
    }

    // ── 梦角留言 ──────────────────────────────────────
    function _partnerName() {
        return (typeof settings !== 'undefined' && settings.partnerName) ||
               (window._settings && window._settings.partnerName) || '梦角';
    }

    function _renderLetterCard() {
        var pname   = _partnerName();
        var nameEl  = document.getElementById('pd-letter-name');
        var pnEl    = document.getElementById('pd-letter-pname');
        if (nameEl) nameEl.textContent = pname;
        if (pnEl)   pnEl.textContent   = pname;

        // 头像 —— 之前读的是 #partner-avatar 这个 div 容器的 .src，
        // 但 div 没有 src 属性，永远是 undefined，判断永远不成立，头像永远不会联动。
        // 改成读容器里真正的 <img> 子元素（有设置头像时，头像模块会把 <img> 塞进这个 div 里；
        // 没设置时塞的是 <i class="fas fa-user">，这里做法保持一致，不再写死🌸）。
        var avEl = document.getElementById('pd-partner-av');
        if (avEl) {
            var realImg = document.querySelector('#partner-avatar img');
            avEl.innerHTML = (realImg && realImg.src)
                ? '<img src="' + realImg.src + '">'
                : '<i class="fas fa-user"></i>';
        }

        // 留言内容
        var emptyEl = document.getElementById('pd-letter-empty');
        var linesEl = document.getElementById('pd-letter-lines');

        // 判断当前经期是否有留言
        var active   = _activePeriod() || (_data.periods.length ? _data.periods[_data.periods.length - 1] : null);
        var hasMsg   = _data.partnerMsg && active && _data.partnerMsg.periodId === active.id;

        if (hasMsg && _data.partnerMsg.lines && _data.partnerMsg.lines.length) {
            if (emptyEl) emptyEl.style.display = 'none';
            if (linesEl) {
                linesEl.style.display = '';
                linesEl.innerHTML = _data.partnerMsg.lines.map(function (l) {
                    return '<div class="pd-letter-line">' + l + '</div>';
                }).join('');
            }
        } else {
            if (emptyEl) emptyEl.style.display = '';
            if (linesEl) linesEl.style.display = 'none';
        }
    }

    // ── 公开 API ──────────────────────────────────────
    window._pdToggleToday = function () {
        var today = _today();
        if (_isInPeriod(today)) {
            // 覆盖"今天"的这条记录，可能是点"标记经期"建出来的"进行中"记录（_activePeriod能找到），
            // 也可能是长按补录出来的、一开始就有明确结束日期的记录（_activePeriod找不到，
            // 之前只处理前一种，导致长按补录出来的记录点"关闭"完全没反应）。
            // 这里不区分是哪一种，统一找到"覆盖今天的那条记录"来处理。
            var p = _getPeriodOf(today);
            if (p) {
                var newEnd = _addD(today, -1);
                if (newEnd < p.startDate) {
                    // 缩回去的结束日期比开始日期还早，说明这条记录只覆盖今天一天，直接整条删掉
                    _data.periods = _data.periods.filter(function (x) { return x.id !== p.id; });
                } else {
                    p.endDate = newEnd;  // 今天不算了，缩到昨天为止
                }
                _save();
            }
        } else {
            _startPeriod(today, true);
        }
        _renderCalendar();
        _updateStats();
        _updateToggleBtn();
        _updateStatusCard();
    };

    window._pdSetFlow = function (val) {
        _currentFlow = val;
        document.querySelectorAll('.pd-flow-btn').forEach(function (btn) {
            btn.classList.toggle('pd-flow-active', Number(btn.dataset.val) === val);
        });
        _updateSaveBtn(false);
    };

    window._pdToggleSymptom = function (btn) {
        btn.classList.toggle('pd-chip-on');
        var s   = btn.textContent;
        var idx = _currentSymptoms.indexOf(s);
        if (idx === -1) _currentSymptoms.push(s); else _currentSymptoms.splice(idx, 1);
        _updateSaveBtn(false);
    };

    window._pdAddSymptom = function () {
        var val = prompt('输入自定义症状名称：');
        if (!val || !val.trim()) return;
        val = val.trim();
        if (!_data.customSymptoms) _data.customSymptoms = [];
        if (DEFAULT_SYMPTOMS.indexOf(val) === -1 && _data.customSymptoms.indexOf(val) === -1) {
            _data.customSymptoms.push(val);
            _save();
        }
        _renderSymptoms();
    };

    window._pdSaveRecord = function () {
        var today = _today();
        _data.dailyRecords[today] = { flow: _currentFlow, symptoms: _currentSymptoms.slice() };
        _save();
        _updateSaveBtn(true);
        _renderCalendar();  // 刷新日历上的小点
    };

    window._pdCloseDaySheet = function () {
        var sheet = document.getElementById('pd-day-sheet');
        if (sheet && typeof window.hideModal === 'function') window.hideModal(sheet);
    };

    // ── 入口 ──────────────────────────────────────────
    window._pdInit = async function () {
        if (!_loaded) await _load();

        var now    = new Date();
        _viewYear  = now.getFullYear();
        _viewMonth = now.getMonth();

        _renderCalendar();
        _renderSymptoms();
        _updateStats();
        _updateToggleBtn();
        _updateStatusCard();
        _renderLetterCard();
        _checkNotif();

        // 月份切换
        var prev = document.getElementById('pd-prev-month');
        var next = document.getElementById('pd-next-month');
        if (prev) prev.onclick = function () {
            _viewMonth--;
            if (_viewMonth < 0) { _viewMonth = 11; _viewYear--; }
            _renderCalendar();
        };
        if (next) next.onclick = function () {
            _viewMonth++;
            if (_viewMonth > 11) { _viewMonth = 0; _viewYear++; }
            _renderCalendar();
        };
    };

    // 每分钟检查一次通知
    setInterval(function () { if (_loaded) _checkNotif(); }, 60000);

})();
