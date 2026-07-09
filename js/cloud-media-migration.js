/**
 * cloud-media-migration.js — 阶段三A：旧数据迁移工具
 *
 * 扫描本地所有 base64 图片，上传到云端，替换成 oss:// 引用。
 * 迁移完成后本地空间会大幅减少。
 *
 * 3A 阶段只处理：
 *   - 背景图库（backgroundGallery）→ 云端全尺寸 + 本地缩略图
 *   - 当前聊天背景（chatBackground）→ 云端全尺寸
 *
 * 不处理（留给 3B）：
 *   - 头像（保持本地+云端双存）
 *   - 聊天消息里的图片（涉及消息渲染改造）
 *   - 贴纸库（涉及贴纸面板改造）
 *   - 陪伴模式媒体（涉及陪伴模块改造）
 *   - 日记背景（涉及日记模块改造）
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

    // ==== 迁移背景图库 ====
    async function _migrateBackgroundGallery(sid) {
        var key = APP_PREFIX_STR + sid + '_backgroundGallery';
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
            _state.currentTask = '背景图库 ' + (i + 1) + '/' + gallery.length;
            _notify();
            try {
                var uploadResult = await window.CloudMedia.upload(bg.value, 'backgrounds', bg.id || undefined);
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
                console.warn('[migration] 背景图上传失败', e);
                newGallery.push(bg); // 失败保留原状
                _state.failed++;
            }
            _state.progress++;
            _notify();
        }
        await localforage.setItem(key, newGallery);
    }

    // ==== 迁移当前聊天背景（单张图）====
    async function _migrateChatBackground(sid) {
        var key = APP_PREFIX_STR + sid + '_chatBackground';
        var bg = await localforage.getItem(key);
        if (!_isBase64Image(bg)) return;

        _state.currentTask = '当前聊天背景';
        _notify();
        try {
            var r = await window.CloudMedia.upload(bg, 'backgrounds');
            await localforage.setItem(key, r.url);
            _state.completed++;
        } catch (e) {
            _state.failed++;
        }
        _state.progress++;
        _notify();
    }

    // ==== 扫描：计算总项数 ====
    async function _countTasks(sid) {
        var count = 0;
        var g = await localforage.getItem(APP_PREFIX_STR + sid + '_backgroundGallery');
        if (Array.isArray(g)) {
            g.forEach(function (bg) { if (bg && _isBase64Image(bg.value)) count++; });
        }
        var cb = await localforage.getItem(APP_PREFIX_STR + sid + '_chatBackground');
        if (_isBase64Image(cb)) count++;
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

            await _migrateBackgroundGallery(sid);
            await _migrateChatBackground(sid);

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
