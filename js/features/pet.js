/**
 * pet.js — 虚拟宠物功能
 *
 * Step 1（这一步做的）：数据结构 + 选品种/起名/创建宠物档案 + 基本信息展示 + 换宠物（重置进度）
 * 还没做：饥饿/心情随时间衰减、喂食/摸摸互动、梦角主动喂养、悬浮球
 *
 * 数据结构（_data）：
 * {
 *   pets: [
 *     {
 *       id,
 *       species: 'cat' | 'dog' | 'rabbit' | 'hamster',
 *       breed,                 // 品种key，如 'lihua'，对应 PET_REGISTRY 里的条目
 *       name,                  // 用户自定义名字
 *       createdAt,
 *       hunger: 0-100,         // 初始 80，Step 2 才会真的随时间掉
 *       mood: 0-100,           // 初始 80
 *       lastDecayAt,           // 预留给 Step 2 算离线衰减用，这一步先等于 createdAt
 *     }, ...
 *     // MVP 只会有 1 条，但存成数组是为了以后要支持多只养成时不用改数据结构
 *   ],
 *   activePetId,   // 当前展示的宠物id，MVP下 = pets[0].id
 * }
 *
 * 存储 key 的取法照抄 survey.js / period.js 那一套（localforage.keys() 扫描 + 等 SESSION_ID 就绪）。
 */
(function () {
    'use strict';

    // ── 品种注册表：物种 -> 品种列表。目前只有猫有素材，狗/兔/仓鼠先占位（UI里显示"即将上线"，不可选） ──
    var PET_REGISTRY = {
        cat: {
            label: '猫',
            icon: 'fa-cat',
            ready: true,
            breeds: [
                { key: 'lihua', name: '狸花猫', folder: '狸花猫' },
                { key: 'meiduan', name: '美短猫', folder: '美短猫' },
                { key: 'sanhua', name: '三花猫', folder: '三花猫' },
                { key: 'hei', name: '黑猫', folder: '黑猫' },
                { key: 'buou', name: '布偶猫', folder: '布偶猫' },
                { key: 'xianluo', name: '暹罗猫', folder: '暹罗猫' },
                { key: 'bai', name: '白猫', folder: '白猫' }
            ]
        },
        dog: { label: '狗', icon: 'fa-dog', ready: false, breeds: [] },
        rabbit: { label: '兔', icon: 'fa-carrot', ready: false, breeds: [] },
        hamster: { label: '仓鼠', icon: 'fa-circle', ready: false, breeds: [] }
    };

    // 情绪状态 key -> 文件名里的中文后缀。Step 1 只用得到 'idle'（基本信息卡的展示图）。
    var EMOTION_SUFFIX = {
        happy: '开心',
        hungry: '饿了',
        sleepy: '困了',
        full: '满足',
        sulky: '委屈',
        idle: '日常待机'
    };

    function _breedInfo(species, breedKey) {
        var sp = PET_REGISTRY[species];
        if (!sp) return null;
        for (var i = 0; i < sp.breeds.length; i++) {
            if (sp.breeds[i].key === breedKey) return sp.breeds[i];
        }
        return null;
    }

    function _imgUrl(species, breedKey, emotionKey) {
        var breed = _breedInfo(species, breedKey);
        if (!breed) return '';
        var suffix = EMOTION_SUFFIX[emotionKey] || EMOTION_SUFFIX.idle;
        var speciesFolder = species === 'cat' ? 'cat' : species; // 目前只有cat，先占位写法
        return 'assets/pets/' + speciesFolder + '/' + encodeURIComponent(breed.folder) + '/' +
            encodeURIComponent(breed.folder + '_' + suffix) + '.png';
    }

    // ── Storage（照抄 survey.js 的取key方式） ──────────────────────
    var _data = { pets: [], activePetId: null };
    var _loaded = false;
    var _storageKey = null;

    async function _getKey() {
        if (_storageKey) return _storageKey;
        var properKey = null;
        try {
            if (typeof SESSION_ID !== 'undefined' && SESSION_ID && typeof window.getStorageKey === 'function') {
                properKey = window.getStorageKey('petData');
            }
        } catch (e) { /* SESSION_ID 可能还没初始化 */ }
        if (properKey) { _storageKey = properKey; return properKey; }
        try {
            var allKeys = await localforage.keys();
            var found = allKeys.find(function (k) { return k.indexOf('_petData') !== -1; });
            if (found) return found;
            var msgKey = allKeys.find(function (k) { return k.indexOf('_chatMessages') !== -1; });
            var prefix = msgKey ? msgKey.replace('_chatMessages', '') : 'CHAT_APP_V3_';
            return prefix + '_petData';
        } catch (e) {
            return 'CHAT_APP_V3__petData';
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
        if (_loaded) return;
        await _waitForSessionId(5000);
        try {
            var key = await _getKey();
            var saved = await localforage.getItem(key);
            if (saved) {
                _data = saved;
                if (!Array.isArray(_data.pets)) _data.pets = [];
                if (_data.activePetId === undefined) _data.activePetId = _data.pets.length ? _data.pets[0].id : null;
            }
        } catch (e) { console.warn('[pet] load failed:', e); }
        _loaded = true; // 数据完整性guard：save必须在load确认完成后才允许执行，防止空数据覆盖已有记录
    }

    async function _save() {
        if (!_loaded) { console.warn('[pet] save被拦截：还没load完成，防止空数据覆盖'); return; }
        try {
            var key = await _getKey();
            await localforage.setItem(key, _data);
        } catch (e) { console.warn('[pet] save failed:', e); }
    }

    function _uid() {
        return 'pet_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    }

    function _activePet() {
        if (!_data.activePetId) return null;
        for (var i = 0; i < _data.pets.length; i++) {
            if (_data.pets[i].id === _data.activePetId) return _data.pets[i];
        }
        return null;
    }

    // ── 创建/替换宠物 ──────────────────────
    function _createPet(species, breedKey, name) {
        var now = Date.now();
        var pet = {
            id: _uid(),
            species: species,
            breed: breedKey,
            name: name,
            createdAt: now,
            hunger: 80,
            mood: 80,
            lastDecayAt: now
        };
        // MVP 单只：新建即替换掉旧的（换宠物走这个函数，调用前已经在UI层二次确认过"会重置进度"）
        _data.pets = [pet];
        _data.activePetId = pet.id;
        _save();
        return pet;
    }

    // ── UI：弹窗内部状态机（选物种 -> 选品种 -> 起名 -> 完成） ──────────────────────
    var _flowStep = 'species'; // 'species' | 'breed' | 'name' | 'info'
    var _flowSpecies = null;
    var _flowBreed = null;

    function _resetFlow() {
        _flowStep = _activePet() ? 'info' : 'species';
        _flowSpecies = null;
        _flowBreed = null;
    }

    function _render() {
        var body = document.getElementById('pet-modal-body');
        if (!body) return;

        if (_flowStep === 'info') {
            body.innerHTML = _renderInfoCard();
            _bindInfoEvents();
            return;
        }
        if (_flowStep === 'species') {
            body.innerHTML = _renderSpeciesPicker();
            _bindSpeciesEvents();
            return;
        }
        if (_flowStep === 'breed') {
            body.innerHTML = _renderBreedPicker();
            _bindBreedEvents();
            return;
        }
        if (_flowStep === 'name') {
            body.innerHTML = _renderNameStep();
            _bindNameEvents();
            return;
        }
    }

    function _renderSpeciesPicker() {
        var html = '<div class="pet-step-title">养一只什么呢？</div>';
        html += '<div class="pet-species-grid">';
        Object.keys(PET_REGISTRY).forEach(function (key) {
            var sp = PET_REGISTRY[key];
            html += '<div class="pet-species-card' + (sp.ready ? '' : ' pet-disabled') + '" data-species="' + key + '">' +
                '<i class="fas ' + sp.icon + '"></i><span>' + sp.label + '</span>' +
                (sp.ready ? '' : '<small>即将上线</small>') +
                '</div>';
        });
        html += '</div>';
        return html;
    }

    function _bindSpeciesEvents() {
        var cards = document.querySelectorAll('.pet-species-card:not(.pet-disabled)');
        cards.forEach(function (card) {
            card.addEventListener('click', function () {
                _flowSpecies = card.getAttribute('data-species');
                _flowStep = 'breed';
                _render();
            });
        });
    }

    function _renderBreedPicker() {
        var sp = PET_REGISTRY[_flowSpecies];
        var html = '<div class="pet-step-title"><i class="fas fa-arrow-left pet-back-btn" id="pet-back-to-species"></i> 选一个品种</div>';
        html += '<div class="pet-breed-grid">';
        sp.breeds.forEach(function (b) {
            var thumb = _imgUrl(_flowSpecies, b.key, 'happy');
            html += '<div class="pet-breed-card" data-breed="' + b.key + '">' +
                '<img src="' + thumb + '" alt="' + b.name + '" loading="lazy">' +
                '<span>' + b.name + '</span>' +
                '</div>';
        });
        html += '</div>';
        return html;
    }

    function _bindBreedEvents() {
        var back = document.getElementById('pet-back-to-species');
        if (back) back.addEventListener('click', function () { _flowStep = 'species'; _render(); });
        var cards = document.querySelectorAll('.pet-breed-card');
        cards.forEach(function (card) {
            card.addEventListener('click', function () {
                _flowBreed = card.getAttribute('data-breed');
                _flowStep = 'name';
                _render();
            });
        });
    }

    function _renderNameStep() {
        var breed = _breedInfo(_flowSpecies, _flowBreed);
        var thumb = _imgUrl(_flowSpecies, _flowBreed, 'happy');
        var html = '<div class="pet-step-title"><i class="fas fa-arrow-left pet-back-btn" id="pet-back-to-breed"></i> 给Ta起个名字</div>';
        html += '<div class="pet-name-preview"><img src="' + thumb + '" alt="' + breed.name + '"><span>' + breed.name + '</span></div>';
        html += '<input type="text" id="pet-name-input" class="pet-name-input" placeholder="比如：豆豆" maxlength="10">';
        html += '<button class="modal-btn modal-btn-primary" id="pet-confirm-create-btn" style="width:100%;margin-top:14px;">确定，开始养Ta</button>';
        return html;
    }

    function _bindNameEvents() {
        var back = document.getElementById('pet-back-to-breed');
        if (back) back.addEventListener('click', function () { _flowStep = 'breed'; _render(); });
        var input = document.getElementById('pet-name-input');
        var btn = document.getElementById('pet-confirm-create-btn');
        if (btn) {
            btn.addEventListener('click', function () {
                var name = (input.value || '').trim();
                if (!name) { input.focus(); input.classList.add('pet-input-error'); return; }
                _createPet(_flowSpecies, _flowBreed, name);
                _flowStep = 'info';
                _render();
            });
        }
    }

    function _renderInfoCard() {
        var pet = _activePet();
        if (!pet) { _flowStep = 'species'; return _renderSpeciesPicker(); }
        var breed = _breedInfo(pet.species, pet.breed);
        var img = _imgUrl(pet.species, pet.breed, 'happy');
        var html = '<div class="pet-info-card">';
        html += '<img src="' + img + '" alt="' + pet.name + '" class="pet-info-avatar">';
        html += '<div class="pet-info-name">' + pet.name + '</div>';
        html += '<div class="pet-info-breed">' + (breed ? breed.name : pet.breed) + '</div>';
        html += '<div class="pet-info-stats">';
        html += '<div class="pet-stat"><span>饥饿</span><div class="pet-stat-bar"><div class="pet-stat-fill" style="width:' + pet.hunger + '%"></div></div></div>';
        html += '<div class="pet-stat"><span>心情</span><div class="pet-stat-bar"><div class="pet-stat-fill" style="width:' + pet.mood + '%"></div></div></div>';
        html += '</div>';
        html += '<div class="pet-info-hint">喂养互动下一步就来～这一步先认识一下Ta</div>';
        html += '<button class="modal-btn modal-btn-secondary" id="pet-change-btn" style="width:100%;margin-top:14px;">换一只养</button>';
        html += '</div>';
        return html;
    }

    function _bindInfoEvents() {
        var btn = document.getElementById('pet-change-btn');
        if (btn) {
            btn.addEventListener('click', function () {
                if (confirm('换宠物会重置当前的养成进度（饥饿/心情都会清空重来），确定要换吗？')) {
                    _flowStep = 'species';
                    _flowSpecies = null;
                    _flowBreed = null;
                    _render();
                }
            });
        }
    }

    // ── 对外入口 ──────────────────────
    window._petOpenModal = async function () {
        await _load();
        _resetFlow();
        _render();
        if (typeof window.showModal === 'function') window.showModal(document.getElementById('pet-modal'));
        else document.getElementById('pet-modal').style.display = 'flex';
    };

    window._petCloseModal = function () {
        if (typeof window.hideModal === 'function') window.hideModal(document.getElementById('pet-modal'));
        else document.getElementById('pet-modal').style.display = 'none';
    };

})();
