/**
 * cloud-sync-ui.js — 云端同步的 UI（第一阶段：入口 + 密钥填写表单 + 状态显示）
 * 依赖：CloudSync、showNotification、data.js 数据管理页
 *
 * 提供内容：
 *   - 在数据管理页动态插入「云端同步」板块（入口卡片 + 状态标签）
 *   - 抽屉/弹窗：填写 Bucket / 地区 / AccessKey ID / Secret
 *   - 「测试连接」「保存并连接」「断开连接」按钮
 *   - 「如何申请密钥」教程链接（点击弹出简要说明）
 */
(function () {
    'use strict';

    var SECTION_ID = 'cloud-sync-section';
    var TILE_ID = 'cloud-sync-tile';
    var STATUS_ID = 'cloud-sync-status';
    var MODAL_ID = 'cloud-sync-modal';
    var HELP_MODAL_ID = 'cloud-sync-help-modal';

    // ==== 样式（内联注入，避免碰其他 CSS） ====
    function injectStyles() {
        if (document.getElementById('cloud-sync-style')) return;
        var s = document.createElement('style');
        s.id = 'cloud-sync-style';
        s.textContent = [
            '#' + SECTION_ID + ' .cs-tile { background: var(--secondary-bg, #fff); border: 1px solid var(--border-color, #eee); border-radius: 14px; padding: 14px 16px; display: flex; align-items: center; gap: 12px; cursor: pointer; transition: transform .15s ease; }',
            '#' + SECTION_ID + ' .cs-tile:active { transform: scale(0.98); }',
            '#' + SECTION_ID + ' .cs-icon { width: 40px; height: 40px; border-radius: 10px; display: flex; align-items: center; justify-content: center; color: #fff; background: linear-gradient(135deg, #6EC7E8, #4AA3D4); flex-shrink: 0; font-size: 18px; }',
            '#' + SECTION_ID + ' .cs-info { flex: 1; min-width: 0; }',
            '#' + SECTION_ID + ' .cs-title { font-size: 14px; font-weight: 600; color: var(--text-color, #333); margin-bottom: 2px; }',
            '#' + SECTION_ID + ' .cs-desc { font-size: 12px; color: var(--text-secondary, #999); }',
            '#' + SECTION_ID + ' .cs-status-badge { font-size: 11px; padding: 3px 8px; border-radius: 10px; font-weight: 500; }',
            '#' + SECTION_ID + ' .cs-status-connected { background: rgba(60,180,120,0.12); color: #2ba46e; }',
            '#' + SECTION_ID + ' .cs-status-disconnected { background: rgba(160,160,160,0.14); color: #888; }',
            '#' + SECTION_ID + ' .cs-status-error { background: rgba(230,90,90,0.14); color: #d05656; }',

            '#' + MODAL_ID + ' .cs-form { padding: 4px 20px 12px 20px; overflow-y: auto; }',
            '#' + MODAL_ID + ' .cs-field { margin-bottom: 14px; }',
            '#' + MODAL_ID + ' .cs-label { font-size: 12px; color: var(--text-secondary, #888); margin-bottom: 6px; display: block; }',
            '#' + MODAL_ID + ' .cs-input, #' + MODAL_ID + ' .cs-select { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid var(--border-color, #e6e6e6); border-radius: 10px; font-size: 14px; background: var(--input-bg, #fafafa); color: var(--text-color, #333); font-family: inherit; }',
            '#' + MODAL_ID + ' .cs-input:focus, #' + MODAL_ID + ' .cs-select:focus { outline: none; border-color: var(--accent-color, #c5a47e); background: var(--secondary-bg, #fff); }',
            '#' + MODAL_ID + ' .cs-hint { font-size: 11px; color: var(--text-secondary, #aaa); margin-top: 5px; line-height: 1.5; }',
            '#' + MODAL_ID + ' .cs-help-link { color: var(--accent-color, #c5a47e); font-size: 12px; text-decoration: underline; cursor: pointer; margin-bottom: 12px; display: inline-block; }',
            '#' + MODAL_ID + ' .cs-actions { display: flex; gap: 10px; padding: 12px 20px; border-top: 1px solid var(--border-color, #eee); background: var(--secondary-bg, #fafafa); flex-shrink: 0; }',
            '#' + MODAL_ID + ' .cs-btn { flex: 1; padding: 11px; border-radius: 10px; border: none; font-size: 14px; font-weight: 500; cursor: pointer; font-family: inherit; }',
            '#' + MODAL_ID + ' .cs-btn-primary { background: var(--accent-color, #c5a47e); color: #fff; }',
            '#' + MODAL_ID + ' .cs-btn-primary:disabled { opacity: 0.55; cursor: not-allowed; }',
            '#' + MODAL_ID + ' .cs-btn-secondary { background: var(--input-bg, #f0f0f0); color: var(--text-color, #333); }',
            '#' + MODAL_ID + ' .cs-btn-danger { background: rgba(230,90,90,0.12); color: #d05656; }',
            '#' + MODAL_ID + ' .cs-test-result { padding: 10px 12px; border-radius: 10px; font-size: 13px; margin-bottom: 12px; display: none; white-space: pre-line; line-height: 1.5; }',
            '#' + MODAL_ID + ' .cs-test-result.ok { display: block; background: rgba(60,180,120,0.10); color: #2ba46e; }',
            '#' + MODAL_ID + ' .cs-test-result.err { display: block; background: rgba(230,90,90,0.10); color: #d05656; }',
            '#' + MODAL_ID + ' .cs-test-result.loading { display: block; background: rgba(120,120,120,0.08); color: #666; }',

            '#' + HELP_MODAL_ID + ' .cs-help-body { padding: 8px 20px 20px; font-size: 13px; line-height: 1.7; color: var(--text-color, #333); }',
            '#' + HELP_MODAL_ID + ' .cs-help-body h4 { margin: 14px 0 6px; font-size: 14px; }',
            '#' + HELP_MODAL_ID + ' .cs-help-body ol { padding-left: 22px; margin: 6px 0; }',
            '#' + HELP_MODAL_ID + ' .cs-help-body a { color: var(--accent-color, #c5a47e); }'
        ].join('\n');
        document.head.appendChild(s);
    }

    // ==== 在数据管理页插入云端同步板块 ====
    function insertCloudSection() {
        var dataModal = document.getElementById('data-modal');
        if (!dataModal) return false;
        var body = dataModal.querySelector('.dm-body');
        if (!body) return false;
        if (document.getElementById(SECTION_ID)) return true; // 已插入

        var backupLabel = null;
        var labels = body.querySelectorAll('.dm-section-label');
        for (var i = 0; i < labels.length; i++) {
            if (/备份与恢复/.test(labels[i].textContent)) {
                backupLabel = labels[i];
                break;
            }
        }

        var section = document.createElement('div');
        section.id = SECTION_ID;
        section.innerHTML =
            '<div class="dm-section-label" style="margin-top:16px;"><i class="fas fa-cloud"></i> 云端同步</div>' +
            '<div class="cs-tile" id="' + TILE_ID + '">' +
                '<div class="cs-icon"><i class="fas fa-cloud"></i></div>' +
                '<div class="cs-info">' +
                    '<div class="cs-title">阿里云 OSS</div>' +
                    '<div class="cs-desc" id="' + TILE_ID + '-desc">未连接，点击设置密钥</div>' +
                '</div>' +
                '<div class="cs-status-badge cs-status-disconnected" id="' + STATUS_ID + '">未连接</div>' +
            '</div>';

        // 插入位置：备份与恢复标签之前
        if (backupLabel) {
            body.insertBefore(section, backupLabel);
        } else {
            body.insertBefore(section, body.firstChild);
        }

        var tile = document.getElementById(TILE_ID);
        if (tile) tile.addEventListener('click', openConfigModal);

        updateStatusBadge();
        return true;
    }

    function updateStatusBadge() {
        var badge = document.getElementById(STATUS_ID);
        var desc = document.getElementById(TILE_ID + '-desc');
        if (!badge || !desc) return;
        var connected = window.CloudSync && window.CloudSync.isConnected();
        var cfg = window.CloudSync && window.CloudSync.getConfig();
        if (connected && cfg) {
            badge.className = 'cs-status-badge cs-status-connected';
            badge.textContent = '已连接';
            desc.textContent = cfg.bucket + '（' + _regionLabel(cfg.region) + '）';
        } else {
            badge.className = 'cs-status-badge cs-status-disconnected';
            badge.textContent = '未连接';
            desc.textContent = '未连接，点击设置密钥';
        }
    }

    function _regionLabel(id) {
        var regs = (window.CloudSync && window.CloudSync.getRegions()) || [];
        for (var i = 0; i < regs.length; i++) {
            if (regs[i].id === id) return regs[i].label;
        }
        return id || '';
    }

    // ==== 配置弹窗 ====
    function ensureConfigModal() {
        var m = document.getElementById(MODAL_ID);
        if (m) return m;
        m = document.createElement('div');
        m.id = MODAL_ID;
        m.className = 'modal';
        m.style.display = 'none';
        m.innerHTML =
            '<div class="modal-content" style="max-width:460px;max-height:90vh;display:flex;flex-direction:column;">' +
                '<div class="modal-title" style="flex-shrink:0;">' +
                    '<i class="fas fa-cloud"></i><span>云端同步设置</span>' +
                '</div>' +
                '<div class="cs-form">' +
                    '<span class="cs-help-link" id="cs-open-help"><i class="fas fa-circle-question"></i> 如何申请阿里云密钥？</span>' +
                    '<div class="cs-test-result" id="cs-test-result"></div>' +
                    '<div class="cs-field">' +
                        '<label class="cs-label">Bucket 名称</label>' +
                        '<input class="cs-input" id="cs-bucket" type="text" placeholder="例如 mengjiao-storage" autocomplete="off" />' +
                    '</div>' +
                    '<div class="cs-field">' +
                        '<label class="cs-label">地区</label>' +
                        '<select class="cs-select" id="cs-region"></select>' +
                        '<div class="cs-hint">与创建 Bucket 时选择的地区保持一致</div>' +
                    '</div>' +
                    '<div class="cs-field">' +
                        '<label class="cs-label">AccessKey ID</label>' +
                        '<input class="cs-input" id="cs-ak-id" type="text" autocomplete="off" />' +
                    '</div>' +
                    '<div class="cs-field">' +
                        '<label class="cs-label">AccessKey Secret</label>' +
                        '<input class="cs-input" id="cs-ak-secret" type="password" autocomplete="off" />' +
                        '<div class="cs-hint">密钥仅保存在你的浏览器本地，Anthropic 与阿里云之外的任何服务器都不会拿到。</div>' +
                    '</div>' +
                '</div>' +
                '<div class="cs-actions">' +
                    '<button class="cs-btn cs-btn-danger" id="cs-disconnect" style="display:none;">断开连接</button>' +
                    '<button class="cs-btn cs-btn-secondary" id="cs-cancel">取消</button>' +
                    '<button class="cs-btn cs-btn-secondary" id="cs-test">测试连接</button>' +
                    '<button class="cs-btn cs-btn-primary" id="cs-save">保存并连接</button>' +
                '</div>' +
            '</div>';
        document.body.appendChild(m);

        // 填充地区下拉
        var regionSel = m.querySelector('#cs-region');
        var regions = (window.CloudSync && window.CloudSync.getRegions()) || [];
        regionSel.innerHTML = regions.map(function (r) {
            return '<option value="' + r.id + '">' + r.label + '</option>';
        }).join('');

        // 绑定事件
        m.querySelector('#cs-cancel').addEventListener('click', closeConfigModal);
        m.querySelector('#cs-test').addEventListener('click', onTestConnection);
        m.querySelector('#cs-save').addEventListener('click', onSaveAndConnect);
        m.querySelector('#cs-disconnect').addEventListener('click', onDisconnect);
        m.querySelector('#cs-open-help').addEventListener('click', openHelpModal);

        // 点击背景关闭
        m.addEventListener('click', function (e) {
            if (e.target === m) closeConfigModal();
        });

        return m;
    }

    function openConfigModal() {
        injectStyles();
        var m = ensureConfigModal();
        var cfg = (window.CloudSync && window.CloudSync.getConfig()) || {};
        m.querySelector('#cs-bucket').value    = cfg.bucket || '';
        m.querySelector('#cs-region').value    = cfg.region || 'oss-cn-hangzhou';
        m.querySelector('#cs-ak-id').value     = cfg.accessKeyId || '';
        m.querySelector('#cs-ak-secret').value = cfg.accessKeySecret || '';
        m.querySelector('#cs-test-result').className = 'cs-test-result';
        m.querySelector('#cs-test-result').textContent = '';
        m.querySelector('#cs-disconnect').style.display =
            (window.CloudSync && window.CloudSync.isConnected()) ? '' : 'none';
        m.style.display = 'flex';
    }

    function closeConfigModal() {
        var m = document.getElementById(MODAL_ID);
        if (m) m.style.display = 'none';
    }

    function _readForm() {
        var m = document.getElementById(MODAL_ID);
        if (!m) return null;
        return {
            bucket:          (m.querySelector('#cs-bucket').value || '').trim(),
            region:          (m.querySelector('#cs-region').value || '').trim(),
            accessKeyId:     (m.querySelector('#cs-ak-id').value || '').trim(),
            accessKeySecret: (m.querySelector('#cs-ak-secret').value || '').trim()
        };
    }

    function _validateForm(cfg) {
        if (!cfg.bucket)          return 'Bucket 名称不能为空';
        if (!cfg.region)          return '请选择地区';
        if (!cfg.accessKeyId)     return 'AccessKey ID 不能为空';
        if (!cfg.accessKeySecret) return 'AccessKey Secret 不能为空';
        return null;
    }

    function _showResult(state, message) {
        var el = document.getElementById('cs-test-result');
        if (!el) return;
        el.className = 'cs-test-result ' + state; // loading | ok | err
        el.textContent = message;
    }

    async function onTestConnection() {
        var cfg = _readForm();
        var err = _validateForm(cfg);
        if (err) { _showResult('err', err); return; }
        _showResult('loading', '正在测试连接…');
        var btn = document.querySelector('#' + MODAL_ID + ' #cs-test');
        if (btn) btn.disabled = true;
        try {
            var result = await window.CloudSync.testConnection(cfg);
            if (result.ok) {
                _showResult('ok', '✓ 连接成功，密钥可用');
            } else {
                _showResult('err', '✗ ' + (result.message || '连接失败'));
            }
        } catch (e) {
            _showResult('err', '✗ 连接失败：' + (e && e.message || e));
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    async function onSaveAndConnect() {
        var cfg = _readForm();
        var err = _validateForm(cfg);
        if (err) { _showResult('err', err); return; }
        _showResult('loading', '正在验证并保存…');
        var saveBtn = document.querySelector('#' + MODAL_ID + ' #cs-save');
        if (saveBtn) saveBtn.disabled = true;
        try {
            var result = await window.CloudSync.testConnection(cfg);
            if (!result.ok) {
                _showResult('err', '✗ ' + (result.message || '连接失败，未保存'));
                return;
            }
            cfg.connectedAt = new Date().toISOString();
            await window.CloudSync.saveConfig(cfg);
            _showResult('ok', '✓ 已连接并保存');
            updateStatusBadge();
            if (typeof showNotification === 'function') {
                showNotification('云端同步已连接', 'success', 2500);
            }
            setTimeout(closeConfigModal, 700);
        } catch (e) {
            _showResult('err', '✗ 保存失败：' + (e && e.message || e));
        } finally {
            if (saveBtn) saveBtn.disabled = false;
        }
    }

    async function onDisconnect() {
        if (!confirm('断开连接后，本地数据不会丢失，云端已同步的数据也仍在阿里云上。\n\n确定要断开吗？')) return;
        try {
            await window.CloudSync.clearConfig();
            updateStatusBadge();
            if (typeof showNotification === 'function') {
                showNotification('已断开云端连接', 'info', 2500);
            }
            closeConfigModal();
        } catch (e) {
            _showResult('err', '断开失败：' + (e && e.message || e));
        }
    }

    // ==== 帮助弹窗 ====
    function ensureHelpModal() {
        var m = document.getElementById(HELP_MODAL_ID);
        if (m) return m;
        m = document.createElement('div');
        m.id = HELP_MODAL_ID;
        m.className = 'modal';
        m.style.display = 'none';
        m.innerHTML =
            '<div class="modal-content" style="max-width:480px;max-height:88vh;display:flex;flex-direction:column;">' +
                '<div class="modal-title" style="flex-shrink:0;">' +
                    '<i class="fas fa-circle-question"></i><span>如何申请阿里云 OSS 密钥</span>' +
                '</div>' +
                '<div class="cs-help-body" style="overflow-y:auto;">' +
                    '<h4>1. 开通对象存储 OSS</h4>' +
                    '<ol>' +
                        '<li>打开 <a href="https://www.aliyun.com" target="_blank" rel="noopener">aliyun.com</a>，用手机号登录并完成实名认证</li>' +
                        '<li>搜索「对象存储 OSS」并开通（免费开通，只按实际用量收费）</li>' +
                    '</ol>' +
                    '<h4>2. 创建 Bucket</h4>' +
                    '<ol>' +
                        '<li>进入 OSS 控制台 → Bucket 列表 → 创建 Bucket</li>' +
                        '<li>名称：随便起，例如 <code>mengjiao-storage</code></li>' +
                        '<li>地区：选离你近的（例如「华东1-杭州」），记住这个地区</li>' +
                        '<li>读写权限：<b>私有</b></li>' +
                    '</ol>' +
                    '<h4>3. 配置跨域（CORS）</h4>' +
                    '<ol>' +
                        '<li>进入刚创建的 Bucket → 权限管理 → 跨域设置 → 创建规则</li>' +
                        '<li>来源：<code>*</code>（或填你的域名，如 <code>https://ivyo1214.github.io</code>）</li>' +
                        '<li>允许 Methods：勾选 <b>GET、PUT、POST、DELETE、HEAD</b></li>' +
                        '<li>允许 Headers：<code>*</code></li>' +
                        '<li>暴露 Headers：<code>ETag</code></li>' +
                    '</ol>' +
                    '<h4>4. 创建 AccessKey</h4>' +
                    '<ol>' +
                        '<li>右上角头像 → AccessKey 管理</li>' +
                        '<li>推荐创建「RAM 用户」而不是主账号 AccessKey（更安全）</li>' +
                        '<li>给该 RAM 用户授权：<code>AliyunOSSFullAccess</code>（或只对刚创建的 Bucket 授权）</li>' +
                        '<li>获取 AccessKey ID 与 Secret，<b>Secret 只显示一次，请妥善保存</b></li>' +
                    '</ol>' +
                    '<h4>5. 回到本页填写</h4>' +
                    '<ol>' +
                        '<li>Bucket 名称：第 2 步起的名字</li>' +
                        '<li>地区：第 2 步选的地区</li>' +
                        '<li>AccessKey ID / Secret：第 4 步生成的</li>' +
                        '<li>点「测试连接」，绿色即为成功</li>' +
                    '</ol>' +
                '</div>' +
                '<div class="modal-buttons" style="padding:12px 20px;border-top:1px solid var(--border-color,#eee);flex-shrink:0;text-align:right;">' +
                    '<button class="modal-btn modal-btn-primary" id="cs-help-close">我知道了</button>' +
                '</div>' +
            '</div>';
        document.body.appendChild(m);
        m.querySelector('#cs-help-close').addEventListener('click', function () { m.style.display = 'none'; });
        m.addEventListener('click', function (e) { if (e.target === m) m.style.display = 'none'; });
        return m;
    }

    function openHelpModal() {
        var m = ensureHelpModal();
        m.style.display = 'flex';
    }

    // ==== 与数据管理页的挂接 ====
    // 数据管理弹窗每次打开时（点击设置里的入口）会触发 rebuild；用 MutationObserver 监听插入时机
    function watchDataModal() {
        var dataModal = document.getElementById('data-modal');
        if (!dataModal) {
            setTimeout(watchDataModal, 500);
            return;
        }
        // data.js 用 setTimeout(init,0) 注册它自己的 observer，所以我们的 observer 会先触发。
        // 延迟 120ms，等 data.js 的 ensureHTML/writeHTML 执行完毕再插入，否则会被覆盖。
        var observer = new MutationObserver(function () {
            var d = dataModal.style.display;
            if (d === 'flex' || d === 'block') {
                setTimeout(function () {
                    injectStyles();
                    insertCloudSection();
                    updateStatusBadge();
                }, 120);
            }
        });
        observer.observe(dataModal, { attributes: true, attributeFilter: ['style'] });
    }

    // ==== 启动 ====
    function boot() {
        if (typeof window.CloudSync === 'undefined') {
            // cloud-sync.js 尚未加载完成，延迟启动
            setTimeout(boot, 200);
            return;
        }
        window.CloudSync.onStatusChange(function () { updateStatusBadge(); });
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', watchDataModal);
        } else {
            watchDataModal();
        }
    }

    boot();
})();
