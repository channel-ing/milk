/**
 * survey.js — 调查问卷功能
 *
 * Step 1：数据结构 + 创建问卷弹窗（我问梦角）+ 聊天设置→节奏tab 问卷回复时间滑块
 * Step 2：梦角选择算法 + 提醒机制 + 历史记录列表页 + 详情页（我问梦角完整闭环）
 * Step 3（这一步做的）：反向问卷（梦角问我）+ 回复库"问卷题库"tab + 触发引擎 + 回收站
 *
 * 数据结构（_data）：
 * {
 *   askPartner: [
 *     {
 *       id, createdAt, dueAt,                 // dueAt = 倒计时结束时间点，到点才真正"算"梦角选了什么
 *       status: 'pending' | 'answered' | 'withdrawn',
 *       answeredAt, deletedAt,
 *       selections: null | { [questionId]: [optionId, ...] },  // 倒计时结束那一刻才算，之前一直是 null
 *       questions: [
 *         { id, type: 'single'|'multi', text, options: [ { id, kind:'text'|'image', value } ] }
 *       ]
 *     }, ...
 *   ],
 *   askMe: [                     // 反向问卷（梦角问我）
 *     {
 *       id, sentAt, status: 'sent' | 'received', receivedAt, deletedAt,
 *       answers: null | { [questionId]: answerText },
 *       questions: [ { id, text } ]   // 纯文字开放式提问，没有选项
 *     }, ...
 *   ],
 *   bank: [                      // 反向问卷题库（回复库→氛围感→"问卷题库"tab 管理）
 *     { id, text, builtin: bool, hidden: bool, usedInRound: bool }
 *   ],
 *   askMeTrigger: { nextCheckAt: timestamp, missStreak: 0|1|2+ },
 *     // 触发概率：missStreak 0→50%，1→80%，2+→100%；中了清零；每次检查后不管中没中都重排 5-10 天后的 nextCheckAt
 *   replyDelayMinHours: 1,       // 问卷回复时间区间（小时），聊天设置→节奏tab 那两个新滑块
 *   replyDelayMaxHours: 24
 * }
 *
 * 存储 key 的取法完全照抄 period.js 那一套（localforage.keys() 扫描 + 等 SESSION_ID 就绪），
 * 理由和坑点跟经期记录一模一样，不再重复注释。
 */
(function () {
    'use strict';

    var _data = { askPartner: [], askMe: [], replyDelayMinHours: 1, replyDelayMaxHours: 24 };
    var _loaded = false;
    var _storageKey = null;

    // 创建问卷弹窗的临时编辑态（还没点"发送"之前，都存在这里，跟 _data 完全分开）
    var _draftQuestions = [];
    // 非 null 时表示当前是"编辑已有问卷"，值是那份问卷的 id——
    // 编辑态下弹窗复用同一套渲染，但要锁掉"加题/删题/改单多选"这三个操作
    var _editingSurveyId = null;

    // ── Storage（照抄 period.js 的取key方式） ──────────────────────
    async function _getKey() {
        if (_storageKey) return _storageKey;
        var properKey = null;
        try {
            if (typeof SESSION_ID !== 'undefined' && SESSION_ID && typeof window.getStorageKey === 'function') {
                properKey = window.getStorageKey('surveyData');
            }
        } catch (e) { /* SESSION_ID 可能还没初始化 */ }
        if (properKey) { _storageKey = properKey; return properKey; }
        try {
            var allKeys = await localforage.keys();
            var found = allKeys.find(function (k) { return k.indexOf('_surveyData') !== -1; });
            if (found) return found;
            var msgKey = allKeys.find(function (k) { return k.indexOf('_chatMessages') !== -1; });
            var prefix = msgKey ? msgKey.replace('_chatMessages', '') : 'CHAT_APP_V3_';
            return prefix + '_surveyData';
        } catch (e) {
            return 'CHAT_APP_V3__surveyData';
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
        await _waitForSessionId(5000);
        try {
            var key = await _getKey();
            var saved = await localforage.getItem(key);
            if (saved) {
                _data = saved;
                if (!Array.isArray(_data.askPartner)) _data.askPartner = [];
                if (!Array.isArray(_data.askMe)) _data.askMe = [];
                if (!_data.replyDelayMinHours) _data.replyDelayMinHours = 1;
                if (!_data.replyDelayMaxHours) _data.replyDelayMaxHours = 24;
                // 兼容 Step 1 时创建的旧数据（那会儿还没有 deletedAt 字段）
                _data.askPartner.forEach(function (s) { if (s.deletedAt === undefined) s.deletedAt = null; });
                _data.askMe.forEach(function (s) { if (s.deletedAt === undefined) s.deletedAt = null; });
            }
        } catch (e) { console.warn('[survey] load failed:', e); }
        if (!Array.isArray(_data.bank) || !_data.bank.length) _seedBuiltinBank();
        if (!_data.askMeTrigger) {
            _data.askMeTrigger = { nextCheckAt: Date.now() + _randDays(5, 10), missStreak: 0 };
        }
        _loaded = true;
        _syncDelaySlidersUI();
    }

    async function _save() {
        try {
            var key = await _getKey();
            await localforage.setItem(key, _data);
        } catch (e) { console.warn('[survey] save failed:', e); }
    }

    function _uid(prefix) {
        return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    }

    function _randDays(a, b) { return (a + Math.random() * (b - a)) * 86400000; }

    // ── 反向问卷（梦角问我）内置题库，60条，感情/生活习惯/未来展望各20 ──
    var BUILTIN_BANK_TEXTS = [
        '你生气的时候希望我哄你还是让你静一静', '你难过的时候想让我抱你还是陪你说话', '你跟我吵架的时候最怕我说什么',
        '你希望我吃醋还是不吃的醋', '你喜欢惊喜还是提前商量', '你最喜欢我碰你哪里',
        '你睡觉的时候希望我抱着你还是各自睡', '你早上醒来第一件事会想我吗', '你希望每天说晚安吗',
        '你怎么表达"我想你了"', '你什么时候会主动牵我的手', '你会因为什么小事突然对我心动',
        '你最喜欢我叫你什么', '你会因为我的哪句话开心一整天', '你心里有没有一个"理想伴侣"的样子，我像吗',
        '你觉得我们之间最默契的地方是什么', '你希望我怎么对待你的朋友', '你有没有幻想过我们结婚的场景',
        '你更想要浪漫还是实用', '你希望我用什么方式告诉你我爱你',
        '你刷牙用冷水还是温水', '你睡觉喜欢朝左还是朝右', '你吃饭时先吃菜还是先吃饭',
        '你洗澡的时候会唱歌吗', '你挤牙膏从中间挤还是从尾巴挤', '你吃饺子蘸醋还是蘸酱油',
        '你睡觉抱东西吗', '你喜欢穿拖鞋还是光脚', '你吃西瓜用勺子还是切块',
        '你喜欢淋浴还是泡澡', '你喝咖啡加糖吗', '你吃薯条蘸番茄酱还是冰淇淋',
        '你煮泡面会加鸡蛋吗', '你吃苹果削皮吗', '你喜欢开灯睡觉还是全黑',
        '你吃炸鸡先吃皮还是先吃肉', '你喝汤会端起碗喝还是用勺子', '你吃巧克力会咬还是含',
        '你系鞋带是蝴蝶结还是单结', '你喝牛奶会舔嘴角吗',
        '我们以后会住在一起吗', '以后家里你想养猫还是狗', '你想过结婚吗',
        '孩子像你还是像我', '十年后我们还会一起吃饭吗', '我们以后每年都去旅行好不好',
        '你以后还会像现在这样对我好吗', '下辈子你还想遇到我吗', '你以后会记得我们的纪念日吗',
        '我想多了解你一点', '你小时候发生过什么有趣的事吗', '你最喜欢的颜色是什么',
        '你小时候的梦想是什么', '你最开心的一次回忆是什么', '你最喜欢吃什么',
        '你喜欢什么样的天气', '你最喜欢的一首歌是什么', '你从什么时候开始喜欢我的',
        '你最喜欢我哪一点', '你希望我们变成什么样子'
    ];

    function _seedBuiltinBank() {
        var existing = Array.isArray(_data.bank) ? _data.bank : [];
        // 万一之前已经有自定义题（理论上现在不会，但留个防御），种子只补内置的，不覆盖已有数据
        var already = new Set(existing.filter(function (q) { return q.builtin; }).map(function (q) { return q.text; }));
        BUILTIN_BANK_TEXTS.forEach(function (t, i) {
            if (already.has(t)) return;
            existing.push({ id: 'bk_' + i, text: t, builtin: true, hidden: false, usedInRound: false });
        });
        _data.bank = existing;
    }

    // ── 问卷回复时间滑块（聊天设置→节奏tab）──────────────────────
    // 这两个滑块的值不进全局 settings 对象，单独存在 _data 里、单独绑定事件，
    // 不碰 core.js 里主聊天回复速度那套逻辑，两边完全独立
    function _syncDelaySlidersUI() {
        var minSlider = document.getElementById('survey-delay-min-slider');
        var maxSlider = document.getElementById('survey-delay-max-slider');
        var minVal = document.getElementById('survey-delay-min-value');
        var maxVal = document.getElementById('survey-delay-max-value');
        if (minSlider) minSlider.value = _data.replyDelayMinHours;
        if (maxSlider) maxSlider.value = _data.replyDelayMaxHours;
        if (minVal) minVal.textContent = _data.replyDelayMinHours + 'h';
        if (maxVal) maxVal.textContent = _data.replyDelayMaxHours + 'h';
        if (minSlider && maxSlider) maxSlider.min = minSlider.value;
    }

    function _bindDelaySliders() {
        var minSlider = document.getElementById('survey-delay-min-slider');
        var maxSlider = document.getElementById('survey-delay-max-slider');
        if (!minSlider || !maxSlider) return;
        minSlider.addEventListener('input', function () {
            var minVal = document.getElementById('survey-delay-min-value');
            if (minVal) minVal.textContent = minSlider.value + 'h';
            if (+minSlider.value > +maxSlider.value) {
                maxSlider.value = minSlider.value;
                var maxVal = document.getElementById('survey-delay-max-value');
                if (maxVal) maxVal.textContent = maxSlider.value + 'h';
            }
            maxSlider.min = minSlider.value;
        });
        minSlider.addEventListener('change', function () {
            _data.replyDelayMinHours = +minSlider.value;
            if (_data.replyDelayMinHours > _data.replyDelayMaxHours) _data.replyDelayMaxHours = _data.replyDelayMinHours;
            _save();
        });
        maxSlider.addEventListener('input', function () {
            var maxVal = document.getElementById('survey-delay-max-value');
            if (maxVal) maxVal.textContent = maxSlider.value + 'h';
        });
        maxSlider.addEventListener('change', function () {
            _data.replyDelayMaxHours = +maxSlider.value;
            _save();
        });
    }

    // ── 创建问卷弹窗：草稿态问题结构 ──────────────────────────────
    function _newDraftQuestion() {
        return {
            id: _uid('q'),
            type: 'single',
            text: '',
            optKind: 'text', // 同题内类型不混用，这个是"这道题的选项统一是文字还是图片"
            options: [
                { id: _uid('o'), value: '' },
                { id: _uid('o'), value: '' }
            ]
        };
    }

    function _openCreateModal(editSurvey) {
        var titleEl = document.querySelector('#survey-create-modal .modal-title span');
        var addQBtn = document.getElementById('survey-add-q-btn');
        if (editSurvey) {
            _editingSurveyId = editSurvey.id;
            // 深拷贝一份出来编辑，不直接改原对象，点"取消"就什么都没发生过
            _draftQuestions = editSurvey.questions.map(function (q) {
                return {
                    id: q.id, type: q.type, text: q.text, optKind: q.options[0] ? q.options[0].kind : 'text',
                    options: q.options.map(function (o) { return { id: o.id, value: o.value }; })
                };
            });
            if (titleEl) titleEl.textContent = '编辑问卷';
            if (addQBtn) addQBtn.style.display = 'none';
        } else {
            _editingSurveyId = null;
            _draftQuestions = [_newDraftQuestion()];
            if (titleEl) titleEl.textContent = '创建问卷';
            if (addQBtn) addQBtn.style.display = '';
        }
        _renderDraftQuestions();
        if (typeof window.showModal === 'function') {
            window.showModal(document.getElementById('survey-create-modal'));
        } else {
            document.getElementById('survey-create-modal').style.display = 'flex';
        }
    }

    function _closeCreateModal() {
        _editingSurveyId = null;
        if (typeof window.hideModal === 'function') {
            window.hideModal(document.getElementById('survey-create-modal'));
        } else {
            document.getElementById('survey-create-modal').style.display = 'none';
        }
    }

    // 校验：至少1个问题，每题至少2个选项（不管文字还是图片，都要求"有内容"才算数）
    function _validateDraft() {
        if (!_draftQuestions.length) return false;
        return _draftQuestions.every(function (q) {
            if (!q.options || q.options.length < 2) return false;
            return q.options.every(function (o) {
                return o.kind === 'image' ? !!o.value : (o.value && o.value.trim());
            });
        });
    }

    function _updateSendBtnState() {
        var btn = document.getElementById('survey-create-send');
        if (btn) btn.disabled = !_validateDraft();
    }

    function _renderDraftQuestions() {
        var list = document.getElementById('survey-q-list');
        if (!list) return;
        list.innerHTML = '';
        _draftQuestions.forEach(function (q, qIdx) {
            list.appendChild(_buildQuestionCard(q, qIdx));
        });
        _updateSendBtnState();
    }

    function _buildQuestionCard(q, qIdx) {
        var card = document.createElement('div');
        card.className = 'survey-q-card';
        card.dataset.qid = q.id;

        var hd = document.createElement('div');
        hd.className = 'survey-q-card-hd';
        hd.innerHTML = '<span class="survey-q-index">Q' + (qIdx + 1) + '</span>';
        var delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'survey-q-del-btn';
        delBtn.innerHTML = '<i class="fas fa-times"></i>';
        delBtn.onclick = function () {
            _draftQuestions = _draftQuestions.filter(function (x) { return x.id !== q.id; });
            _renderDraftQuestions();
        };
        // 编辑模式下不能加题删题——整个删除按钮都不显示；创建模式下只有多于1题时才能删
        delBtn.style.visibility = (!_editingSurveyId && _draftQuestions.length > 1) ? 'visible' : 'hidden';
        hd.appendChild(delBtn);
        card.appendChild(hd);

        var textInput = document.createElement('textarea');
        textInput.className = 'survey-q-text-input';
        textInput.placeholder = '问题内容';
        textInput.value = q.text;
        textInput.rows = 1;
        textInput.oninput = function () { q.text = textInput.value; };
        card.appendChild(textInput);

        var typeToggle = document.createElement('div');
        typeToggle.className = 'survey-type-toggle';
        ['single', 'multi'].forEach(function (t) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'survey-type-btn' + (q.type === t ? ' active' : '');
            b.textContent = t === 'single' ? '单选' : '多选';
            if (_editingSurveyId) {
                // 编辑模式下不能改单选/多选——按钮还看得见（保留视觉一致性），但点了没反应
                b.disabled = true;
                b.style.opacity = (q.type === t) ? '1' : '0.4';
                b.style.cursor = 'default';
            } else {
                b.onclick = function () {
                    q.type = t;
                    _renderDraftQuestions();
                };
            }
            typeToggle.appendChild(b);
        });
        card.appendChild(typeToggle);

        var kindToggle = document.createElement('div');
        kindToggle.className = 'survey-q-kind-toggle';
        [['text', '文字选项'], ['image', '图片选项']].forEach(function (pair) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'survey-q-kind-btn' + (q.optKind === pair[0] ? ' active' : '');
            b.textContent = pair[1];
            if (_editingSurveyId) {
                // 编辑模式下同样锁掉——只让改"内容"，选项是文字还是图片这个类型不算内容
                b.disabled = true;
                b.style.opacity = (q.optKind === pair[0]) ? '1' : '0.4';
                b.style.cursor = 'default';
            } else {
                b.onclick = function () {
                    if (q.optKind === pair[0]) return;
                    q.optKind = pair[0];
                    // 切类型清空已填的内容——文字和图片的 value 含义不一样，混着留没意义，
                    // 而且用户是主动点切换的，清空不算意外丢数据
                    q.options.forEach(function (o) { o.value = ''; });
                    _renderDraftQuestions();
                };
            }
            kindToggle.appendChild(b);
        });
        card.appendChild(kindToggle);

        var optList = document.createElement('div');
        optList.className = 'survey-option-list';
        q.options.forEach(function (opt, oIdx) {
            optList.appendChild(_buildOptionRow(q, opt, oIdx));
        });
        card.appendChild(optList);

        var addOptBtn = document.createElement('button');
        addOptBtn.type = 'button';
        addOptBtn.className = 'survey-add-option-btn';
        addOptBtn.innerHTML = '<i class="fas fa-plus"></i> 添加选项';
        addOptBtn.disabled = q.options.length >= 10;
        addOptBtn.onclick = function () {
            if (q.options.length >= 10) return;
            q.options.push({ id: _uid('o'), value: '' });
            _renderDraftQuestions();
        };
        card.appendChild(addOptBtn);

        return card;
    }

    function _buildOptionRow(q, opt, oIdx) {
        var row = document.createElement('div');
        row.className = 'survey-option-row';

        if (q.optKind === 'image') {
            var wrap = document.createElement('div');
            wrap.className = 'survey-option-img-wrap';
            var thumb = document.createElement('div');
            thumb.className = 'survey-option-img-thumb';
            thumb.innerHTML = opt.value ? '<img src="' + opt.value + '">' : '<i class="fas fa-image"></i>';
            wrap.appendChild(thumb);

            var pickLabel = document.createElement('label');
            pickLabel.className = 'survey-option-img-pick';
            pickLabel.textContent = opt.value ? '换一张' : '选择图片';
            var fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.accept = 'image/*';
            fileInput.style.display = 'none';
            fileInput.onchange = function () {
                var file = fileInput.files && fileInput.files[0];
                if (!file) return;
                if (file.size > 2 * 1024 * 1024) {
                    showNotification && showNotification('图片不能超过2MB', 'error');
                    fileInput.value = '';
                    return;
                }
                var reader = new FileReader();
                reader.onload = function () {
                    opt.value = reader.result;
                    _renderDraftQuestions();
                };
                reader.readAsDataURL(file);
            };
            pickLabel.appendChild(fileInput);
            wrap.appendChild(pickLabel);
            row.appendChild(wrap);
        } else {
            var input = document.createElement('input');
            input.type = 'text';
            input.className = 'survey-option-text-input';
            input.placeholder = '选项 ' + (oIdx + 1);
            input.value = opt.value;
            input.oninput = function () { opt.value = input.value; _updateSendBtnState(); };
            row.appendChild(input);
        }

        var delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'survey-option-del-btn';
        delBtn.innerHTML = '<i class="fas fa-times"></i>';
        delBtn.style.visibility = q.options.length > 2 ? 'visible' : 'hidden';
        delBtn.onclick = function () {
            if (q.options.length <= 2) return;
            q.options = q.options.filter(function (x) { return x.id !== opt.id; });
            _renderDraftQuestions();
        };
        row.appendChild(delBtn);

        return row;
    }

    // ── 图片选项：本地存的是 base64，配置了 OSS 就在后台悄悄迁移成云端地址 ──
    // 跟聊天发图片那套"发送即成功、后台重试"共用同一个上传队列（CloudMedia.queueUpload），
    // 区别是问卷这边不用管"消息还没发出去"这种时序问题，直接迁移+存回本地数据就完事
    function _migrateOptionImagesToCloud(survey) {
        if (!(window.CloudMedia && window.CloudSync && window.CloudSync.isConnected())) return;
        survey.questions.forEach(function (q) {
            q.options.forEach(function (opt) {
                if (opt.kind === 'image' && typeof opt.value === 'string' && opt.value.indexOf('data:image') === 0) {
                    window.CloudMedia.queueUpload(opt.value, 'survey-options', {
                        onSuccess: function (result) {
                            opt.value = result.url;
                            _save();
                        }
                    });
                }
            });
        });
    }

    function _randomDueAt() {
        var minH = _data.replyDelayMinHours || 1;
        var maxH = Math.max(minH, _data.replyDelayMaxHours || 24);
        var hours = minH + Math.random() * (maxH - minH);
        return Date.now() + hours * 3600000;
    }

    function _submitCreate() {
        if (!_validateDraft()) return;
        var questionsPayload = _draftQuestions.map(function (q) {
            return {
                id: q.id,
                type: q.type,
                text: q.text.trim(),
                options: q.options.map(function (o) {
                    return { id: o.id, kind: q.optKind, value: o.value };
                })
            };
        });

        if (_editingSurveyId) {
            var target = _data.askPartner.find(function (s) { return s.id === _editingSurveyId; });
            if (!target) { _closeCreateModal(); return; }
            // 编辑不重置倒计时——dueAt/status/createdAt 都原样保留，只换题目内容
            target.questions = questionsPayload;
            _save();
            _migrateOptionImagesToCloud(target);
            _closeCreateModal();
            if (typeof showNotification === 'function') showNotification('问卷已更新', 'success');
            _refreshOpenViews();
        } else {
            var survey = {
                id: _uid('sv'),
                createdAt: Date.now(),
                dueAt: _randomDueAt(),
                status: 'pending',
                answeredAt: null,
                deletedAt: null,
                selections: null,
                questions: questionsPayload
            };
            _data.askPartner.push(survey);
            _save();
            _migrateOptionImagesToCloud(survey);
            _closeCreateModal();
            if (typeof showNotification === 'function') showNotification('问卷已发出，等待回复中', 'success');
            _refreshOpenViews();
        }
    }

    // ══════════════════════════════════════════════════════════════
    // Step 2：梦角选择算法 + 到点检查 + 提醒机制 + 历史列表/详情页
    // ══════════════════════════════════════════════════════════════

    // ── 梦角选择算法：单选等概率随机1个；多选先等概率随机决定选几个(1~选项总数)，
    //    再洗牌取前K个——保证不会出现"总是全选"或"总是只选1个"这种明显不公平的偏向 ──
    function _computeSelection(question) {
        var n = question.options.length;
        if (question.type === 'single') {
            var idx = Math.floor(Math.random() * n);
            return [question.options[idx].id];
        }
        var k = 1 + Math.floor(Math.random() * n); // 1 ~ n 等概率
        var shuffled = question.options.slice().sort(function () { return Math.random() - 0.5; });
        return shuffled.slice(0, k).map(function (o) { return o.id; });
    }

    // ── 到点检查：每分钟扫一次，倒计时到了才真正"算"梦角选了什么——
    //    编辑问卷不会重置这个 dueAt，所以编辑到最后一刻都是安全的 ──
    function _checkDueSurveys() {
        if (!_loaded) return;
        var now = Date.now();
        var newlyAnswered = [];
        _data.askPartner.forEach(function (s) {
            if (s.status === 'pending' && !s.deletedAt && s.dueAt && now >= s.dueAt) {
                var selections = {};
                s.questions.forEach(function (q) { selections[q.id] = _computeSelection(q); });
                s.selections = selections;
                s.status = 'answered';
                s.answeredAt = now;
                newlyAnswered.push(s);
            }
        });
        if (newlyAnswered.length) {
            _save();
            newlyAnswered.forEach(function (s) { _queueNotify({ type: 'answered', survey: s }); });
            _refreshOpenViews();
        }
    }

    // ══ 反向问卷（梦角问我）：触发引擎 + 抽题 + 提交回答 ══════════
    //
    // 触发概率：5-10天随机检查一次；上次触发过 → 这次50%；上次没中 → 这次80%；
    // 再没中 → 这次100%必中。中了就把 missStreak 清零，重新从50%开始下一轮计时。
    function _checkAskMeTrigger() {
        if (!_loaded) return;
        var t = _data.askMeTrigger;
        if (!t || Date.now() < t.nextCheckAt) return;

        var prob = t.missStreak === 0 ? 0.5 : (t.missStreak === 1 ? 0.8 : 1);
        var hit = Math.random() < prob;
        if (hit) {
            var batch = _createAskMeBatch();
            if (batch) {
                t.missStreak = 0;
                _queueNotify({ type: 'askme_new', survey: batch });
                _refreshOpenViews();
            }
            // 题库里没有可用题目（比如全被隐藏了）就当这次白抽，missStreak 不变，
            // 照样往下重新排一次 5-10 天后的检查时间，不会卡住
        } else {
            t.missStreak++;
        }
        t.nextCheckAt = Date.now() + _randDays(5, 10);
        _save();
    }

    // 抽题：不放回抽取，题库（排除隐藏的）问完一轮就整体重置再开始新一轮
    function _createAskMeBatch() {
        var pool = _data.bank.filter(function (q) { return !q.hidden; });
        if (!pool.length) return null;
        var available = pool.filter(function (q) { return !q.usedInRound; });
        if (!available.length) {
            pool.forEach(function (q) { q.usedInRound = false; });
            available = pool.slice();
        }
        var kChoices = [3, 4, 5];
        var k = Math.min(kChoices[Math.floor(Math.random() * 3)], available.length);
        var shuffled = available.slice().sort(function () { return Math.random() - 0.5; });
        var picked = shuffled.slice(0, k);
        picked.forEach(function (q) { q.usedInRound = true; });

        var batch = {
            id: _uid('am'),
            sentAt: Date.now(),
            status: 'sent',
            receivedAt: null,
            deletedAt: null,
            answers: null,
            questions: picked.map(function (q) { return { id: q.id, text: q.text }; })
        };
        _data.askMe.push(batch);
        _save();
        return batch;
    }

    function _submitAskMeAnswers(id, answersMap) {
        var b = _data.askMe.find(function (x) { return x.id === id; });
        if (!b) return;
        b.answers = answersMap;
        b.status = 'received';
        b.receivedAt = Date.now();
        _save();
        _closeDetailModal();
        _refreshOpenViews();
        if (typeof showNotification === 'function') showNotification('已提交', 'success');
    }

    // ── 问卷题库管理（回复库 → 氛围感 → "问卷题库" tab）──────────
    // 内置(60条)+自定义功能完全一致，都可编辑/删除/隐藏；隐藏的不参与 _createAskMeBatch 抽题
    function _bankAdd(text) {
        text = (text || '').trim();
        if (!text) return;
        _data.bank.push({ id: _uid('bk'), text: text, builtin: false, hidden: false, usedInRound: false });
        _save();
    }
    function _bankEdit(id, text) {
        var q = _data.bank.find(function (x) { return x.id === id; });
        if (!q) return;
        text = (text || '').trim();
        if (!text) return;
        q.text = text;
        _save();
    }
    function _bankDelete(id) {
        _data.bank = _data.bank.filter(function (x) { return x.id !== id; });
        _save();
    }
    function _bankToggleHide(id) {
        var q = _data.bank.find(function (x) { return x.id === id; });
        if (!q) return;
        q.hidden = !q.hidden;
        _save();
    }

    // 新增/编辑用小弹窗输入，不用浏览器原生 prompt()——iOS Safari 下原生对话框这类东西
    // 之前踩过坑（confirm() 在 iOS Safari 不好用），而且原生 prompt 长相跟 app 完全不搭
    function _bankPromptModal(title, initialValue, onConfirm) {
        var existing = document.getElementById('survey-bank-prompt-modal');
        if (existing) existing.remove();
        var modal = document.createElement('div');
        modal.className = 'modal';
        modal.id = 'survey-bank-prompt-modal';
        modal.innerHTML =
            '<div class="modal-content" style="max-width:320px;">' +
                '<div class="modal-title"><i class="fas fa-clipboard-list"></i><span>' + _esc(title) + '</span></div>' +
                '<textarea class="modal-input" id="survey-bank-prompt-input" rows="2" style="resize:none;width:100%;box-sizing:border-box;"></textarea>' +
                '<div class="modal-buttons">' +
                    '<button class="modal-btn modal-btn-secondary" id="survey-bank-prompt-cancel">取消</button>' +
                    '<button class="modal-btn modal-btn-primary" id="survey-bank-prompt-ok">确定</button>' +
                '</div>' +
            '</div>';
        document.body.appendChild(modal);
        var input = modal.querySelector('#survey-bank-prompt-input');
        input.value = initialValue || '';
        if (typeof window.showModal === 'function') window.showModal(modal, input); else modal.style.display = 'flex';
        function close() { modal.remove(); }
        modal.querySelector('#survey-bank-prompt-cancel').onclick = close;
        modal.querySelector('#survey-bank-prompt-ok').onclick = function () {
            var val = input.value;
            close();
            onConfirm(val);
        };
    }

    var _bankSearchQuery = '';
    function _renderBankTab(list) {
        list.innerHTML =
            '<div class="survey-bank-toolbar">' +
                '<input type="text" class="survey-bank-search" id="survey-bank-search" placeholder="搜索题目…" value="' + _esc(_bankSearchQuery) + '">' +
            '</div>' +
            '<div id="survey-bank-rows"></div>' +
            '<button type="button" class="survey-add-option-btn" id="survey-bank-add-btn" style="margin-top:8px;">' +
                '<i class="fas fa-plus"></i> 新增题目' +
            '</button>';

        var searchInput = list.querySelector('#survey-bank-search');
        searchInput.oninput = function () { _bankSearchQuery = searchInput.value; _renderBankRows(); };
        list.querySelector('#survey-bank-add-btn').onclick = function () {
            _bankPromptModal('新增问卷题目', '', function (text) {
                if (text && text.trim()) { _bankAdd(text); _renderBankRows(); }
            });
        };
        _renderBankRows();
    }

    function _renderBankRows() {
        var rows = document.getElementById('survey-bank-rows');
        if (!rows) return;
        var q = _bankSearchQuery.toLowerCase().trim();
        var items = _data.bank.filter(function (x) { return !q || x.text.toLowerCase().indexOf(q) !== -1; });
        if (!items.length) {
            rows.innerHTML = '<div style="text-align:center;font-size:12.5px;color:var(--text-secondary);opacity:0.6;padding:20px 0;">' +
                (q ? ('未找到 "' + _esc(q) + '"') : '还没有题目') + '</div>';
            return;
        }
        rows.innerHTML = items.map(function (item) {
            return '<div class="custom-reply-item' + (item.hidden ? ' survey-bank-row-hidden' : '') + '" data-id="' + item.id + '">' +
                '<span class="custom-reply-text">' +
                    (item.builtin ? '<span class="survey-bank-builtin-tag">内置</span>' : '') +
                    _esc(item.text) +
                '</span>' +
                '<div class="custom-reply-actions">' +
                    '<button class="reply-action-mini hide-btn" title="' + (item.hidden ? '取消隐藏' : '隐藏') + '"><i class="fas fa-eye' + (item.hidden ? '-slash' : '') + '"></i></button>' +
                    '<button class="reply-action-mini edit-btn" title="编辑"><i class="fas fa-pen"></i></button>' +
                    '<button class="reply-action-mini delete-btn" title="删除"><i class="fas fa-trash"></i></button>' +
                '</div>' +
            '</div>';
        }).join('');
        rows.querySelectorAll('.custom-reply-item').forEach(function (row) {
            var id = row.dataset.id;
            row.querySelector('.hide-btn').onclick = function () { _bankToggleHide(id); _renderBankRows(); };
            row.querySelector('.edit-btn').onclick = function () {
                var cur = _data.bank.find(function (x) { return x.id === id; });
                _bankPromptModal('编辑题目', cur ? cur.text : '', function (text) {
                    if (text && text.trim()) { _bankEdit(id, text); _renderBankRows(); }
                });
            };
            row.querySelector('.delete-btn').onclick = function () {
                _bankDelete(id);
                _renderBankRows();
            };
        });
    }
    window._surveyRenderBankTab = _renderBankTab;

    // ── 提醒合并：不管什么来源（问卷回复、以后 Step 3 的反向问卷新提问……），
    //    只要短时间内一起发生，就合并成一条弹窗，不用逐条打扰 ──
    var _notifyQueue = [];
    var _notifyFlushTimer = null;
    function _queueNotify(item) {
        _notifyQueue.push(item);
        clearTimeout(_notifyFlushTimer);
        _notifyFlushTimer = setTimeout(_flushNotify, 1500);
    }
    function _flushNotify() {
        var items = _notifyQueue.slice();
        _notifyQueue = [];
        if (!items.length) return;
        _showMergedReminder(items);
    }

    function _partnerName() {
        return (typeof settings !== 'undefined' && settings.partnerName) || '对方';
    }

    // 提醒弹窗样式照抄经期记录那套（js/features/period.js 的 _showPdNotif）——
    // 头像+一句话+"稍后/立即查看"两个按钮，8秒自动消失。
    // 是否受陪伴模式/电影院抑制：现有的信件/月经留言/动态互动提醒都没做这个抑制判断
    // （翻了代码确认过，不是漏看），这里跟它们保持一致，不额外加抑制逻辑。
    function _showMergedReminder(items) {
        var existing = document.getElementById('survey-notif-popup');
        if (existing) existing.remove();

        var answeredCount = items.filter(function (it) { return it.type === 'answered'; }).length;
        var newAskMeCount = items.filter(function (it) { return it.type === 'askme_new'; }).length;

        var parts = [];
        if (answeredCount) parts.push(answeredCount + ' 个问卷回复');
        if (newAskMeCount) parts.push(newAskMeCount + ' 个新提问');
        var bodyText = parts.length ? ('你有 ' + parts.join(' + ')) : '有新的问卷动态';

        var pname = _partnerName();
        var realImg = document.querySelector('#partner-avatar img');
        var avatarHtml = (realImg && realImg.src)
            ? '<img src="' + realImg.src + '" style="width:100%;height:100%;object-fit:cover;">'
            : '<i class="fas fa-user" style="font-size:18px;color:var(--text-secondary);"></i>';

        var popup = document.createElement('div');
        popup.id = 'survey-notif-popup';
        popup.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);' +
            'background:var(--secondary-bg);border:1px solid var(--border-color);' +
            'border-radius:20px;padding:18px 20px;z-index:9000;max-width:320px;width:88%;' +
            'box-shadow:0 8px 32px rgba(0,0,0,0.18);display:flex;flex-direction:column;gap:12px;' +
            'animation:_mSlideUp 0.4s cubic-bezier(0.22,1,0.36,1);';
        popup.innerHTML =
            '<style>@keyframes _mSlideUp{from{opacity:0;transform:translateX(-50%) translateY(24px) scale(0.9)}60%{transform:translateX(-50%) translateY(-4px) scale(1.02)}to{opacity:1;transform:translateX(-50%) translateY(0) scale(1)}}</style>' +
            '<div style="display:flex;align-items:center;gap:10px;">' +
                '<div style="width:36px;height:36px;border-radius:50%;background:rgba(var(--accent-color-rgb),0.12);' +
                    'display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0;">' + avatarHtml + '</div>' +
                '<div>' +
                    '<div style="font-size:14px;font-weight:700;color:var(--text-primary);">' + pname + ' · 问卷动态</div>' +
                    '<div style="font-size:11px;color:var(--text-secondary);margin-top:2px;opacity:0.8;">' + bodyText + '</div>' +
                '</div>' +
            '</div>' +
            '<div style="display:flex;gap:8px;">' +
                '<button id="survey-notif-later" style="flex:1;padding:8px 0;border-radius:12px;border:1px solid var(--border-color);background:var(--primary-bg);color:var(--text-secondary);font-size:13px;cursor:pointer;font-family:inherit;">稍后</button>' +
                '<button id="survey-notif-view" style="flex:2;padding:8px 0;border-radius:12px;border:none;background:var(--accent-color);color:#fff;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;">立即查看 ✦</button>' +
            '</div>';
        document.body.appendChild(popup);
        popup.querySelector('#survey-notif-later').onclick = function () { popup.remove(); };
        popup.querySelector('#survey-notif-view').onclick = function () {
            popup.remove();
            // 只有一条动态时直接进详情/回答页；混了好几条（不管什么类型）就进列表页让用户自己挑
            if (items.length === 1) {
                _openListModal();
                var only = items[0];
                var src = only.type === 'answered' ? 'partner' : 'me';
                setTimeout(function () { _openDetailModal(only.survey.id, src); }, 320);
            } else {
                _openListModal();
            }
        };
        setTimeout(function () { if (popup.parentNode) popup.remove(); }, 8000);
    }

    // ── 历史列表页 ──────────────────────────────────────────────
    function _fmtTime(ts) {
        if (!ts) return '';
        var d = new Date(ts);
        var p2 = function (n) { return String(n).padStart(2, '0'); };
        return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
    }

    var STATUS_LABEL = { pending: '等待中', answered: '已回复', withdrawn: '已撤回', sent: '已发送', received: '已收到' };

    function _surveyTitle(s) {
        var t = s.questions[0] && s.questions[0].text;
        return (t && t.trim()) ? t.trim() : '（无标题问题）';
    }

    function _openListModal() {
        _renderListBody();
        if (typeof window.showModal === 'function') window.showModal(document.getElementById('survey-modal'));
        else document.getElementById('survey-modal').style.display = 'flex';
    }
    function _closeListModal() {
        if (typeof window.hideModal === 'function') window.hideModal(document.getElementById('survey-modal'));
        else document.getElementById('survey-modal').style.display = 'none';
    }

    function _renderListBody() {
        var body = document.getElementById('survey-list-body');
        if (!body) return;
        var partnerItems = _data.askPartner.filter(function (s) { return !s.deletedAt; }).map(function (s) { return { ref: s, src: 'partner' }; });
        var meItems = _data.askMe.filter(function (s) { return !s.deletedAt; }).map(function (s) { return { ref: s, src: 'me' }; });
        var all = partnerItems.concat(meItems);
        if (!all.length) {
            body.innerHTML =
                '<div class="survey-list-empty">' +
                    '<i class="fas fa-clipboard-list"></i>' +
                    '<p>还没有问卷，问点什么给梦角吧</p>' +
                '</div>';
            _sizeListBody();
            return;
        }
        var isPinned = function (it) { return it.src === 'partner' ? it.ref.status === 'pending' : it.ref.status === 'sent'; };
        var pinned = all.filter(isPinned).sort(function (a, b) { return (b.ref.createdAt || b.ref.sentAt) - (a.ref.createdAt || a.ref.sentAt); });
        var rest = all.filter(function (it) { return !isPinned(it); }).sort(function (a, b) { return (b.ref.createdAt || b.ref.sentAt) - (a.ref.createdAt || a.ref.sentAt); });

        var html = '';
        pinned.forEach(function (it) { html += _cardHTML(it.ref, it.src); });
        if (pinned.length && rest.length) html += '<div class="survey-pin-divider">已完成</div>';
        rest.forEach(function (it) { html += _cardHTML(it.ref, it.src); });
        body.innerHTML = html;

        body.querySelectorAll('.survey-card').forEach(function (el) {
            el.onclick = function () { _openDetailModal(el.dataset.sid, el.dataset.src); };
        });
        _sizeListBody();
    }

    // 弹窗高度固定在"大概4张卡片"这个高度，不管实际有几份问卷都不会跟着变矮/变高——
    // 超过4份就在这块区域内部上下滑动看剩下的。量的是第一张卡片的实际渲染高度（卡片高度
    // 会因为标题是1行还是2行有点误差，但足够接近"4份"这个视觉预期了），量不到（比如空状态）
    // 就用一个兜底估算值，保证弹窗不会因为没数据而缩得比平时小
    function _sizeListBody() {
        var body = document.getElementById('survey-list-body');
        if (!body) return;
        requestAnimationFrame(function () {
            var card = body.querySelector('.survey-card');
            var cardH = card ? card.getBoundingClientRect().height : 100;
            var gap = 10; // 对应 .survey-card 的 margin-bottom
            body.style.height = (cardH * 4 + gap * 3) + 'px';
            body.style.overflowY = 'auto';
        });
    }

    function _cardHTML(s, src) {
        var statusCls = 'survey-tag-status-' + s.status;
        var srcTagCls = src === 'partner' ? 'survey-tag-src-me' : 'survey-tag-src-partner';
        var srcTagText = src === 'partner' ? '我问的' : '它问的';
        var createdAt = s.createdAt || s.sentAt;
        var answeredAt = s.answeredAt || s.receivedAt;
        return '<div class="survey-card" data-sid="' + s.id + '" data-src="' + src + '">' +
            '<div class="survey-card-top">' +
                '<span class="survey-tag ' + srcTagCls + '">' + srcTagText + '</span>' +
                '<span class="survey-tag survey-tag-status ' + statusCls + '">' + STATUS_LABEL[s.status] + '</span>' +
            '</div>' +
            '<div class="survey-card-title">' + _esc(_surveyTitle(s)) + '</div>' +
            '<div class="survey-card-meta">' + _fmtTime(createdAt) +
                (answeredAt ? (' · 回复于 ' + _fmtTime(answeredAt)) : '') +
                ' · ' + s.questions.length + ' 题</div>' +
        '</div>';
    }

    function _esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    // ── 详情页 ──────────────────────────────────────────────────
    var _detailCurrentId = null;
    var _detailCurrentSrc = 'partner';

    function _openDetailModal(id, src) {
        _detailCurrentId = id;
        _detailCurrentSrc = src || 'partner';
        _renderDetail();
        if (typeof window.showModal === 'function') window.showModal(document.getElementById('survey-detail-modal'));
        else document.getElementById('survey-detail-modal').style.display = 'flex';
    }
    function _closeDetailModal() {
        if (typeof window.hideModal === 'function') window.hideModal(document.getElementById('survey-detail-modal'));
        else document.getElementById('survey-detail-modal').style.display = 'none';
    }

    function _renderDetail() {
        if (_detailCurrentSrc === 'me') _renderDetailAskMe();
        else _renderDetailPartner();
    }

    function _renderDetailPartner() {
        var s = _data.askPartner.find(function (x) { return x.id === _detailCurrentId; });
        var body = document.getElementById('survey-detail-body');
        var actions = document.getElementById('survey-detail-actions');
        if (!s || !body || !actions) return;

        var metaHtml = '<div class="survey-detail-meta-row">' +
            '<span class="survey-tag survey-tag-status survey-tag-status-' + s.status + '">' + STATUS_LABEL[s.status] + '</span>' +
            '<span>提问于 ' + _fmtTime(s.createdAt) + '</span>' +
            (s.answeredAt ? ('<span>回复于 ' + _fmtTime(s.answeredAt) + '</span>') : '') +
        '</div>';

        var qHtml = s.questions.map(function (q) {
            var selected = (s.selections && s.selections[q.id]) || [];
            var optsHtml = q.options.map(function (o) {
                var isSel = selected.indexOf(o.id) !== -1;
                var inner = (o.kind === 'image')
                    ? '<img class="survey-detail-opt-img" src="' + o.value + '">'
                    : '<span>' + _esc(o.value) + '</span>';
                return '<div class="survey-detail-opt' + (isSel ? ' selected' : '') + '">' + inner +
                    (isSel ? '<i class="fas fa-check-circle survey-detail-opt-check"></i>' : '') +
                '</div>';
            }).join('');
            return '<div class="survey-detail-q-block">' +
                '<div class="survey-detail-q-text">' + _esc(q.text) + '</div>' +
                optsHtml +
            '</div>';
        }).join('');

        body.innerHTML = metaHtml + qHtml;

        if (s.status === 'pending') {
            actions.className = 'modal-buttons';
            actions.innerHTML =
                '<button class="modal-btn modal-btn-secondary" id="survey-detail-withdraw">撤回</button>' +
                '<button class="modal-btn modal-btn-primary" id="survey-detail-edit">编辑</button>';
            actions.querySelector('#survey-detail-withdraw').onclick = function () { _withdrawSurvey(s.id); };
            actions.querySelector('#survey-detail-edit').onclick = function () {
                _closeDetailModal();
                setTimeout(function () { _openCreateModal(s); }, 200);
            };
        } else if (s.status === 'withdrawn') {
            actions.className = 'modal-buttons';
            actions.innerHTML =
                '<button class="modal-btn modal-btn-secondary" id="survey-detail-delete" style="color:#e0605a;">删除</button>' +
                '<button class="modal-btn modal-btn-primary" id="survey-detail-resend">重新发送</button>';
            actions.querySelector('#survey-detail-delete').onclick = function () { _softDeleteSurvey(s.id); };
            actions.querySelector('#survey-detail-resend').onclick = function () { _resendSurvey(s.id); };
        } else {
            // 已回复：单独一个"删除"按钮，靠右下角（survey-buttons-solo 这个类负责让它靠右，见 survey.css）
            actions.className = 'modal-buttons survey-buttons-solo';
            actions.innerHTML = '<button class="modal-btn modal-btn-secondary" id="survey-detail-delete" style="color:#e0605a;">删除</button>';
            actions.querySelector('#survey-detail-delete').onclick = function () { _softDeleteSurvey(s.id); };
        }
    }

    // 反向问卷（梦角问我）详情页：
    //   已发送 → 逐题一个文字输入框，底部"提交"（全部填完才能点亮）
    //   已收到 → 只读展示题目+已填的回答，底部只有"删除"
    function _renderDetailAskMe() {
        var s = _data.askMe.find(function (x) { return x.id === _detailCurrentId; });
        var body = document.getElementById('survey-detail-body');
        var actions = document.getElementById('survey-detail-actions');
        if (!s || !body || !actions) return;

        var metaHtml = '<div class="survey-detail-meta-row">' +
            '<span class="survey-tag survey-tag-status survey-tag-status-' + s.status + '">' + STATUS_LABEL[s.status] + '</span>' +
            '<span>提问于 ' + _fmtTime(s.sentAt) + '</span>' +
            (s.receivedAt ? ('<span>回复于 ' + _fmtTime(s.receivedAt) + '</span>') : '') +
        '</div>';

        if (s.status === 'sent') {
            var qHtml = s.questions.map(function (q, qi) {
                return '<div class="survey-detail-q-block">' +
                    '<div class="survey-detail-q-text">' + _esc(q.text) + '</div>' +
                    '<textarea class="survey-answer-input" data-qidx="' + qi + '" placeholder="写点什么…" rows="2"></textarea>' +
                '</div>';
            }).join('');
            body.innerHTML = metaHtml + qHtml;

            var textareas = body.querySelectorAll('.survey-answer-input');
            var submitBtn;
            function updateSubmitState() {
                var allFilled = Array.prototype.every.call(textareas, function (ta) { return ta.value.trim(); });
                if (submitBtn) submitBtn.disabled = !allFilled;
            }
            textareas.forEach(function (ta) { ta.oninput = updateSubmitState; });

            actions.className = 'modal-buttons survey-buttons-solo';
            actions.innerHTML = '<button class="modal-btn modal-btn-primary" id="survey-detail-submit-answer" disabled>提交</button>';
            submitBtn = actions.querySelector('#survey-detail-submit-answer');
            submitBtn.onclick = function () {
                var answers = {};
                textareas.forEach(function (ta) {
                    var q = s.questions[+ta.dataset.qidx];
                    answers[q.id] = ta.value.trim();
                });
                _submitAskMeAnswers(s.id, answers);
            };
            updateSubmitState();
        } else {
            var qHtml2 = s.questions.map(function (q) {
                var answerText = (s.answers && s.answers[q.id]) || '';
                return '<div class="survey-detail-q-block">' +
                    '<div class="survey-detail-q-text">' + _esc(q.text) + '</div>' +
                    '<div class="survey-detail-opt selected"><span>' + _esc(answerText) + '</span></div>' +
                '</div>';
            }).join('');
            body.innerHTML = metaHtml + qHtml2;

            actions.className = 'modal-buttons survey-buttons-solo';
            actions.innerHTML = '<button class="modal-btn modal-btn-secondary" id="survey-detail-delete" style="color:#e0605a;">删除</button>';
            actions.querySelector('#survey-detail-delete').onclick = function () { _softDeleteSurvey(s.id); };
        }
    }

    // ── 撤回 / 软删除（回收站，30天）/ 恢复 / 彻底删除 ────────────
    var _TRASH_TTL = 30 * 24 * 60 * 60 * 1000;

    // 在两个数组里都找一下，返回 {rec, arr} 或 null——回收站/删除这些操作现在两种来源都要处理
    function _findRecord(id) {
        var r = _data.askPartner.find(function (x) { return x.id === id; });
        if (r) return { rec: r, arr: _data.askPartner };
        r = _data.askMe.find(function (x) { return x.id === id; });
        if (r) return { rec: r, arr: _data.askMe };
        return null;
    }

    function _withdrawSurvey(id) {
        var s = _data.askPartner.find(function (x) { return x.id === id; });
        if (!s || s.status !== 'pending') return;
        s.status = 'withdrawn';
        _save();
        _closeDetailModal();
        _refreshOpenViews();
        if (typeof showNotification === 'function') showNotification('问卷已撤回', 'info');
    }

    function _softDeleteSurvey(id) {
        var found = _findRecord(id);
        if (!found) return;
        found.rec.deletedAt = Date.now();
        _save();
        _closeDetailModal();
        _refreshOpenViews();
        if (typeof showNotification === 'function') showNotification('已删除，30天内可在回收站恢复', 'info');
    }

    // 撤回的问卷可以"重新发送"——原样复制一份题目内容，当成一份全新的问卷发出去
    // （新 id、新的创建时间、重新随机一个 dueAt），跟原来那份撤回的问卷互不影响
    function _resendSurvey(id) {
        var s = _data.askPartner.find(function (x) { return x.id === id; });
        if (!s) return;
        var fresh = {
            id: _uid('sv'),
            createdAt: Date.now(),
            dueAt: _randomDueAt(),
            status: 'pending',
            answeredAt: null,
            deletedAt: null,
            selections: null,
            questions: JSON.parse(JSON.stringify(s.questions))
        };
        _data.askPartner.push(fresh);
        _save();
        _migrateOptionImagesToCloud(fresh); // 万一原问卷的图片选项当时是本地base64、现在配了OSS，顺手迁移一下
        _closeDetailModal();
        _refreshOpenViews();
        if (typeof showNotification === 'function') showNotification('已作为新问卷重新发出', 'success');
    }

    // 开机自检+每次打开回收站前都清一次——过期的直接从数组里摘掉，不占地方
    function _cleanTrash() {
        var filterFn = function (s) { return !s.deletedAt || (Date.now() - s.deletedAt) < _TRASH_TTL; };
        _data.askPartner = _data.askPartner.filter(filterFn);
        _data.askMe = _data.askMe.filter(filterFn);
    }

    function _openTrashModal() {
        _cleanTrash();
        _save();
        _renderTrashBody();
        if (typeof window.showModal === 'function') window.showModal(document.getElementById('survey-trash-modal'));
        else document.getElementById('survey-trash-modal').style.display = 'flex';
    }
    function _closeTrashModal() {
        if (typeof window.hideModal === 'function') window.hideModal(document.getElementById('survey-trash-modal'));
        else document.getElementById('survey-trash-modal').style.display = 'none';
    }

    function _renderTrashBody() {
        var body = document.getElementById('survey-trash-body');
        if (!body) return;
        var trashedPartner = _data.askPartner.filter(function (s) { return s.deletedAt; }).map(function (s) { return { rec: s, src: 'partner' }; });
        var trashedMe = _data.askMe.filter(function (s) { return s.deletedAt; }).map(function (s) { return { rec: s, src: 'me' }; });
        var trashed = trashedPartner.concat(trashedMe).sort(function (a, b) { return b.rec.deletedAt - a.rec.deletedAt; });
        if (!trashed.length) {
            body.innerHTML = '<div style="text-align:center;font-size:12.5px;color:var(--text-secondary);opacity:0.6;padding:24px 0;">回收站是空的</div>';
            return;
        }
        body.innerHTML = trashed.map(function (it) {
            var s = it.rec;
            var daysLeft = Math.max(0, Math.ceil((_TRASH_TTL - (Date.now() - s.deletedAt)) / 86400000));
            return '<div class="survey-trash-row" data-sid="' + s.id + '">' +
                '<span class="survey-trash-title">' + _esc(_surveyTitle(s)) + '</span>' +
                '<span class="survey-trash-days">还剩' + daysLeft + '天</span>' +
                '<button class="survey-trash-btn-mini" data-act="restore">恢复</button>' +
                '<button class="survey-trash-btn-mini danger" data-act="wipe">彻底删除</button>' +
            '</div>';
        }).join('');
        body.querySelectorAll('.survey-trash-btn-mini').forEach(function (btn) {
            btn.onclick = function () {
                var row = btn.closest('.survey-trash-row');
                var sid = row.dataset.sid;
                if (btn.dataset.act === 'restore') {
                    var found = _findRecord(sid);
                    if (found) { found.rec.deletedAt = null; _save(); }
                } else {
                    _data.askPartner = _data.askPartner.filter(function (x) { return x.id !== sid; });
                    _data.askMe = _data.askMe.filter(function (x) { return x.id !== sid; });
                    _save();
                }
                _renderTrashBody();
                _refreshOpenViews();
            };
        });
    }

    // 有变化时，如果对应页面正开着，就顺手刷新一下，不用用户自己关了再开
    function _refreshOpenViews() {
        var listModal = document.getElementById('survey-modal');
        if (listModal && getComputedStyle(listModal).display !== 'none') _renderListBody();
        var detailModal = document.getElementById('survey-detail-modal');
        if (detailModal && getComputedStyle(detailModal).display !== 'none' && _detailCurrentId) _renderDetail();
    }

    // ── 调试用（console 里跑，不会自动执行）──────────────────────
    window._surveyDebugList = function () { console.log(JSON.parse(JSON.stringify(_data.askPartner))); return _data.askPartner; };
    window._surveyDebugClear = function () { _data.askPartner = []; _save(); console.log('[survey] askPartner 已清空'); };
    // 直接把某一份问卷的 dueAt 改成"刚刚"，方便测试到点计算逻辑，不用真的等几个小时；
    // 传 true 会紧接着立刻跑一次检查（不用等下一次60秒轮询）
    window._surveyDebugForceDue = function (idOrIndex, checkNow) {
        var s = (typeof idOrIndex === 'number') ? _data.askPartner[idOrIndex] : _data.askPartner.find(function (x) { return x.id === idOrIndex; });
        if (!s) { console.warn('[survey] 没找到这份问卷'); return; }
        s.dueAt = Date.now() - 1000;
        _save();
        console.log('[survey] 已把这份问卷的 dueAt 改成刚刚：', s.id);
        if (checkNow) _checkDueSurveys();
    };
    window._surveyOpenCreateModal = function () { _openCreateModal(); };
    window._surveyOpenListModal = _openListModal;
    window._surveyOpenDetailModal = _openDetailModal;
    window._surveyDebugListAskMe = function () { console.log(JSON.parse(JSON.stringify(_data.askMe))); return _data.askMe; };
    window._surveyDebugBank = function () { console.log(JSON.parse(JSON.stringify(_data.bank))); return _data.bank; };
    // 强制立刻触发一次反向问卷（不用等5-10天），传 true 强制必中（跳过概率判定），方便测试抽题/去重逻辑
    window._surveyDebugForceAskMe = function (forceHit) {
        if (forceHit) {
            var batch = _createAskMeBatch();
            if (batch) { _data.askMeTrigger.missStreak = 0; _save(); console.log('[survey] 已生成一批反向问卷：', batch.id); }
            else console.warn('[survey] 题库里没有可用（未隐藏）的题目');
            return;
        }
        _data.askMeTrigger.nextCheckAt = Date.now() - 1000;
        _save();
        _checkAskMeTrigger();
    };
    // 跟上面那个不一样：这个会连提醒弹窗一起触发，走的是跟真实流程完全一样的路径
    // （生成问卷 → missStreak清零 → 排队提醒 → 刷新已打开的界面），方便测试提醒弹窗长什么样
    window._surveyDebugForceAskMeWithNotify = function () {
        var batch = _createAskMeBatch();
        if (batch) {
            _data.askMeTrigger.missStreak = 0;
            _queueNotify({ type: 'askme_new', survey: batch });
            _refreshOpenViews();
            _save();
            console.log('[survey] 已生成一批反向问卷并触发提醒：', batch.id);
        } else {
            console.warn('[survey] 题库里没有可用（未隐藏）的题目');
        }
    };

    // ── 初始化 ────────────────────────────────────────────────
    document.addEventListener('DOMContentLoaded', function () {
        var addQBtn = document.getElementById('survey-add-q-btn');
        if (addQBtn) addQBtn.onclick = function () {
            _draftQuestions.push(_newDraftQuestion());
            _renderDraftQuestions();
        };
        var cancelBtn = document.getElementById('survey-create-cancel');
        if (cancelBtn) cancelBtn.onclick = _closeCreateModal;
        var sendBtn = document.getElementById('survey-create-send');
        if (sendBtn) sendBtn.onclick = _submitCreate;

        var listCloseBtn = document.getElementById('survey-list-close');
        if (listCloseBtn) listCloseBtn.onclick = _closeListModal;
        var addBtn = document.getElementById('survey-add-btn');
        if (addBtn) addBtn.onclick = function () { _openCreateModal(); };
        var trashBtn = document.getElementById('survey-trash-btn');
        if (trashBtn) trashBtn.onclick = _openTrashModal;

        var detailBackBtn = document.getElementById('survey-detail-back');
        if (detailBackBtn) detailBackBtn.onclick = _closeDetailModal;

        var trashCloseBtn = document.getElementById('survey-trash-close');
        if (trashCloseBtn) trashCloseBtn.onclick = _closeTrashModal;

        _bindDelaySliders();
    });

    // 每分钟检查一次到点的问卷（照抄 period.js 的轮询方式）；反向问卷的触发检查间隔是"天"级别的，
    // 不需要这么密，但挂在同一个 60秒 定时器里跑一下也没什么成本，简单点，不用另开一个定时器
    setInterval(function () { _checkDueSurveys(); _checkAskMeTrigger(); }, 60000);

    _load().then(function () {
        _cleanTrash();
        _save();
        setTimeout(function () { _checkDueSurveys(); _checkAskMeTrigger(); }, 4000);
    });
})();
