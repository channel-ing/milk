/**
 * cloud-media-migration.js — 阶段三：旧数据迁移工具
 *
 * 扫描本地所有 base64 图片，上传到云端，替换成 oss:// 引用。
 * 迁移完成后本地空间会大幅减少。
 *
 * 已支持的类别：
 *   - 背景图库（backgroundGallery）→ 云端全尺寸 + 本地缩略图
 *   - 当前聊天背景（chatBackground）→ 云端全尺寸
 *   - 日记背景图库（companionDiaryBgGallery）→ 云端全尺寸 + 本地缩略图
 *   - 当前日记背景（companionDiaryBg）→ 云端全尺寸
 *   - 对方表情库（stickerLibrary）→ 云端引用（无缩略图，直接懒加载）
 *   - 我的表情库（myStickerLibrary）→ 云端引用
 *
 * 尚未处理（留给 3B 后续）：
 *   - 头像（保持本地+云端双存）
 *   - 聊天消息里的图片
 *   - 陪伴模式媒体（背景 / 语音 / 噪音）
 */
(function (global) {
    'use strict';

    var APP_PREFIX_STR = (typeof APP_PREFIX !== 'undefined' ? APP_PREFIX : 'CHAT_APP_V3_');

    // 迁移状态
    var _state = {
        running: false,
        progress: 0,
        total: 0,
        currentTask: '',
        completed: 0,
        failed: 0,
        listeners: []
    };

    function _notify() {
        _state.listeners.forEach(function (fn) {
            try { fn(getStatus()); } catch (e) {}
        });
    }

    function getStatus() {
        return {
            running: _state.running,
            progress: _state.progress,
            total: _state.total,
            currentTask: _state.currentTask,
            completed: _state.completed,
            failed: _state.failed
        };
    }

    function onStatusChange(fn) { if (typeof fn === 'function') _state.listeners.push(fn); }

    // 判断是否是需要迁移的 base64 图片
    function _isBase64Image(v) {
        return typeof v === 'string' && v.indexOf('data:image/') === 0 && v.length > 1000;
    }

    // ==== 通用：对象数组类型的背景图库迁移（backgroundGallery / companionDiaryBgGallery）====
    async function _migrateObjectGallery(sid, keySuffix, category, label) {
        var key = APP_PREFIX_STR + sid + '_' + keySuffix;
        var gallery = await localforage.getItem(key);
        if (!Array.isArray(gallery) || gallery.length === 0) return;

        var newGallery = [];
        for (var i = 0; i < gallery.length; i++) {
            var bg = gallery[i];
            if (!bg || typeof bg !== 'object') { newGallery.push(bg); continue; }
            // 已经是云端引用了：跳过
            if (typeof bg.value === 'string' && bg.value.indexOf('oss://') === 0) {
                newGallery.push(bg);
                continue;
            }
            // 不是图片（是颜色/渐变）：跳过
            if (!_isBase64Image(bg.value)) {
                newGallery.push(bg);
                continue;
            }
            // 需要迁移
            _state.currentTask = label + ' ' + (i + 1) + '/' + gallery.length;
            _notify();
            try {
                var uploadResult = await window.CloudMedia.upload(bg.value, category, bg.id || undefined);
                var thumb = null;
                try {
                    thumb = await window.CloudMedia.makeThumbnail(bg.value, 200);
                } catch (thumbErr) {
                    console.warn('[migration] 缩略图生成失败，跳过', thumbErr);
                }
                newGallery.push({
                    id: bg.id,
                    type: bg.type,
                    value: uploadResult.url,
                    thumbnail: thumb,
                    cloudKey: uploadResult.key
                });
                _state.completed++;
            } catch (e) {
                console.warn('[migration] ' + label + '上传失败', e);
                newGallery.push(bg); // 失败保留原状
                _state.failed++;
            }
            _state.progress++;
            _notify();
        }
        await localforage.setItem(key, newGallery);
    }

    // ==== 通用：单张图迁移（chatBackground / companionDiaryBg）====
    async function _migrateSingleImage(sid, keySuffix, category, label) {
        var key = APP_PREFIX_STR + sid + '_' + keySuffix;
        var bg = await localforage.getItem(key);
        if (!_isBase64Image(bg)) return;

        _state.currentTask = label;
        _notify();
        try {
            var r = await window.CloudMedia.upload(bg, category);
            await localforage.setItem(key, r.url);
            _state.completed++;
        } catch (e) {
            console.warn('[migration] ' + label + '上传失败', e);
            _state.failed++;
        }
        _state.progress++;
        _notify();
    }

    // ==== 贴纸库迁移（字符串数组）====
    // 字符串数组元素可以是 base64 或 oss://，只迁移 base64
    // 同时更新 disabledStickerItems 里的 key（如果匹配）
    async function _migrateStickerArray(sid, keySuffix, category, label) {
        var key = APP_PREFIX_STR + sid + '_' + keySuffix;
        var arr = await localforage.getItem(key);
        if (!Array.isArray(arr) || arr.length === 0) return;

        // 读取屏蔽集合
        var disabledSet = null;
        try {
            var raw = localStorage.getItem('disabledStickerItems');
            if (raw) disabledSet = new Set(JSON.parse(raw));
        } catch (e) {}

        var newArr = [];
        for (var i = 0; i < arr.length; i++) {
            var item = arr[i];
            // 已是云端引用或非字符串：跳过
            if (typeof item !== 'string' || item.indexOf('oss://') === 0) {
                newArr.push(item);
                continue;
            }
            // 不是 base64 图片：跳过
            if (!_isBase64Image(item)) {
                newArr.push(item);
                continue;
            }
            _state.currentTask = label + ' ' + (i + 1) + '/' + arr.length;
            _notify();
            try {
                var r = await window.CloudMedia.upload(item, category);
                newArr.push(r.url);
                // 更新屏蔽集合：如果老 base64 key 在集合里，替换成新 oss:// key
                if (disabledSet && disabledSet.has(item)) {
                    disabledSet.delete(item);
                    disabledSet.add(r.url);
                }
                _state.completed++;
            } catch (e) {
                console.warn('[migration] ' + label + '上传失败', e);
                newArr.push(item); // 失败保留原状
                _state.failed++;
            }
            _state.progress++;
            _notify();
        }
        await localforage.setItem(key, newArr);

        // 屏蔽集合有更新才写回
        if (disabledSet !== null) {
            try {
                localStorage.setItem('disabledStickerItems', JSON.stringify(Array.from(disabledSet)));
            } catch (e) {}
        }
    }

    // ==== 扫描：计算总项数 ====
    async function _countTasks(sid) {
        var count = 0;

        // 背景图库
        var g = await localforage.getItem(APP_PREFIX_STR + sid + '_backgroundGallery');
        if (Array.isArray(g)) {
            g.forEach(function (bg) { if (bg && _isBase64Image(bg.value)) count++; });
        }
        // 聊天背景
        var cb = await localforage.getItem(APP_PREFIX_STR + sid + '_chatBackground');
        if (_isBase64Image(cb)) count++;

        // 日记背景图库
        var dg = await localforage.getItem(APP_PREFIX_STR + sid + '_companionDiaryBgGallery');
        if (Array.isArray(dg)) {
            dg.forEach(function (bg) { if (bg && _isBase64Image(bg.value)) count++; });
        }
        // 日记当前背景
        var dcb = await localforage.getItem(APP_PREFIX_STR + sid + '_companionDiaryBg');
        if (_isBase64Image(dcb)) count++;

        // 贴纸库（对方 + 我的）
        var sl = await localforage.getItem(APP_PREFIX_STR + sid + '_stickerLibrary');
        if (Array.isArray(sl)) {
            sl.forEach(function (item) { if (_isBase64Image(item)) count++; });
        }
        var ml = await localforage.getItem(APP_PREFIX_STR + sid + '_myStickerLibrary');
        if (Array.isArray(ml)) {
            ml.forEach(function (item) { if (_isBase64Image(item)) count++; });
        }

        return count;
    }

    // ==== 主入口 ====
    async function runMigration() {
        if (_state.running) throw new Error('迁移正在进行中');
        if (!window.CloudSync || !window.CloudSync.isConnected()) {
            throw new Error('请先连接云端');
        }
        if (!window.CloudMedia) throw new Error('云端媒体模块未就绪');

        var sid = SESSION_ID;
        if (!sid) throw new Error('SESSION_ID 未就绪');

        _state.running = true;
        _state.progress = 0;
        _state.completed = 0;
        _state.failed = 0;
        _state.currentTask = '扫描中…';
        _notify();

        try {
            _state.total = await _countTasks(sid);
            if (_state.total === 0) {
                _state.currentTask = '没有需要迁移的项目';
                _notify();
                return { migrated: 0, failed: 0, total: 0 };
            }
            _notify();

            // 阶段三A：聊天背景
            await _migrateObjectGallery(sid, 'backgroundGallery', 'backgrounds', '背景图库');
            await _migrateSingleImage(sid, 'chatBackground', 'backgrounds', '当前聊天背景');

            // 阶段三B：日记背景
            await _migrateObjectGallery(sid, 'companionDiaryBgGallery', 'diary-backgrounds', '日记背景图库');
            await _migrateSingleImage(sid, 'companionDiaryBg', 'diary-backgrounds', '当前日记背景');

            // 阶段三B：贴纸
            await _migrateStickerArray(sid, 'stickerLibrary', 'stickers', '对方表情库');
            await _migrateStickerArray(sid, 'myStickerLibrary', 'my-stickers', '我的表情库');

            _state.currentTask = '完成';
            _notify();
            return { migrated: _state.completed, failed: _state.failed, total: _state.total };
        } finally {
            _state.running = false;
            _notify();
        }
    }

    global.CloudMediaMigration = {
        run: runMigration,
        getStatus: getStatus,
        onStatusChange: onStatusChange
    };
})(typeof window !== 'undefined' ? window : this);
