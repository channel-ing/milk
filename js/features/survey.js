/**
 * survey.js — 调查问卷功能
 *
 * Step 1（这一步做的）：数据结构 + 创建问卷弹窗（我问梦角）+ 聊天设置→节奏tab 问卷回复时间滑块
 * Step 2（下一步）：梦角选择算法 + 提醒机制 + 历史记录列表页 + 详情页（我问梦角完整闭环）
 * Step 3（最后）：反向问卷（梦角问我）+ 回复库"问卷题库"tab + 撤回/编辑/删除走回收站
 *
 * 数据结构（_data）：
 * {
 *   askPartner: [
 *     {
 *       id, createdAt, dueAt,                 // dueAt = 倒计时结束时间点，到点才真正"算"梦角选了什么
 *       status: 'pending' | 'answered' | 'withdrawn',
 *       answeredAt: null | timestamp,
 *       selections: null | { [questionId]: [optionId, ...] },  // 倒计时结束那一刻才算，之前一直是 null
 *       questions: [
 *         { id, type: 'single'|'multi', text, options: [ { id, kind:'text'|'image', value } ] }
 *       ]
 *     }, ...
 *   ],
 *   askMe: [],                 // Step 3 才用
 *   replyDelayMinHours: 1,      // 问卷回复时间区间（小时），聊天设置→节奏tab 那两个新滑块
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
            }
        } catch (e) { console.warn('[survey] load failed:', e); }
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

    function _openCreateModal() {
        _draftQuestions = [_newDraftQuestion()];
        _renderDraftQuestions();
        if (typeof window.showModal === 'function') {
            window.showModal(document.getElementById('survey-create-modal'));
        } else {
            document.getElementById('survey-create-modal').style.display = 'flex';
        }
    }

    function _closeCreateModal() {
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
        // 只有多于1题时才能删——至少要留1题
        delBtn.style.visibility = _draftQuestions.length > 1 ? 'visible' : 'hidden';
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
            b.onclick = function () {
                q.type = t;
                _renderDraftQuestions();
            };
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
            b.onclick = function () {
                if (q.optKind === pair[0]) return;
                q.optKind = pair[0];
                // 切类型清空已填的内容——文字和图片的 value 含义不一样，混着留没意义，
                // 而且用户是主动点切换的，清空不算意外丢数据
                q.options.forEach(function (o) { o.value = ''; });
                _renderDraftQuestions();
            };
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
        var survey = {
            id: _uid('sv'),
            createdAt: Date.now(),
            dueAt: _randomDueAt(),
            status: 'pending',
            answeredAt: null,
            selections: null,
            questions: _draftQuestions.map(function (q) {
                return {
                    id: q.id,
                    type: q.type,
                    text: q.text.trim(),
                    options: q.options.map(function (o) {
                        return { id: o.id, kind: q.optKind, value: o.value };
                    })
                };
            })
        };
        _data.askPartner.push(survey);
        _save();
        _migrateOptionImagesToCloud(survey);
        _closeCreateModal();
        if (typeof showNotification === 'function') showNotification('问卷已发出，等待回复中', 'success');
    }

    // ── 调试用（console 里跑，不会自动执行）──────────────────────
    window._surveyDebugList = function () { console.log(JSON.parse(JSON.stringify(_data.askPartner))); return _data.askPartner; };
    window._surveyDebugClear = function () { _data.askPartner = []; _save(); console.log('[survey] askPartner 已清空'); };
    // 直接把某一份问卷的 dueAt 改成"刚刚"，方便测试 Step 2 的到点计算逻辑，不用真的等几个小时
    window._surveyDebugForceDue = function (idOrIndex) {
        var s = (typeof idOrIndex === 'number') ? _data.askPartner[idOrIndex] : _data.askPartner.find(function (x) { return x.id === idOrIndex; });
        if (!s) { console.warn('[survey] 没找到这份问卷'); return; }
        s.dueAt = Date.now() - 1000;
        _save();
        console.log('[survey] 已把这份问卷的 dueAt 改成刚刚：', s.id);
    };

    window._surveyOpenCreateModal = _openCreateModal;

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

        _bindDelaySliders();
    });

    _load();
})();
