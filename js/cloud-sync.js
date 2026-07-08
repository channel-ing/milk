/**
 * cloud-sync.js — 阿里云 OSS 云端同步（第一阶段：仅连接测试）
 * 依赖：localforage、APP_PREFIX、showNotification
 *
 * 第一阶段目标：
 *   - 提供密钥填写入口（Bucket / Region / AccessKey ID / Secret）
 *   - 测试与阿里云 OSS 的连接是否可用
 *   - 保存密钥到 localforage，供后续阶段使用
 *   - 在数据管理页显示连接状态（已连接 / 未连接 / 断开）
 *
 * 密钥仅保存在本地浏览器，浏览器数据被清后需重新填写。
 * 云端已有数据不会因此丢失，重新填写密钥即可恢复访问。
 */
(function (global) {
    'use strict';

    // ==== 存储键 ====
    var CFG_KEY = (typeof APP_PREFIX !== 'undefined' ? APP_PREFIX : 'CHAT_APP_V3_') + 'cloudSyncConfig';

    // ==== 阿里云 OSS 地区列表（常用） ====
    var OSS_REGIONS = [
        { id: 'oss-cn-hangzhou',   label: '华东1（杭州）' },
        { id: 'oss-cn-shanghai',   label: '华东2（上海）' },
        { id: 'oss-cn-nanjing',    label: '华东5（南京）' },
        { id: 'oss-cn-fuzhou',     label: '华东6（福州）' },
        { id: 'oss-cn-qingdao',    label: '华北1（青岛）' },
        { id: 'oss-cn-beijing',    label: '华北2（北京）' },
        { id: 'oss-cn-zhangjiakou',label: '华北3（张家口）' },
        { id: 'oss-cn-huhehaote',  label: '华北5（呼和浩特）' },
        { id: 'oss-cn-wulanchabu', label: '华北6（乌兰察布）' },
        { id: 'oss-cn-shenzhen',   label: '华南1（深圳）' },
        { id: 'oss-cn-heyuan',     label: '华南2（河源）' },
        { id: 'oss-cn-guangzhou',  label: '华南3（广州）' },
        { id: 'oss-cn-chengdu',    label: '西南1（成都）' },
        { id: 'oss-cn-hongkong',   label: '中国香港' }
    ];

    // ==== 内部状态 ====
    var _config = null;      // { bucket, region, accessKeyId, accessKeySecret, connectedAt }
    var _isConnected = false;
    var _statusListeners = [];

    // ==== 配置读写 ====
    async function loadConfig() {
        try {
            var cfg = await localforage.getItem(CFG_KEY);
            _config = cfg || null;
            _isConnected = !!(cfg && cfg.connectedAt);
            _notifyStatus();
            return _config;
        } catch (e) {
            console.warn('[cloud-sync] 读取配置失败', e);
            return null;
        }
    }

    async function saveConfig(cfg) {
        _config = cfg;
        _isConnected = !!(cfg && cfg.connectedAt);
        try {
            await localforage.setItem(CFG_KEY, cfg);
        } catch (e) {
            console.warn('[cloud-sync] 保存配置失败', e);
        }
        _notifyStatus();
    }

    async function clearConfig() {
        _config = null;
        _isConnected = false;
        try {
            await localforage.removeItem(CFG_KEY);
        } catch (e) {}
        _notifyStatus();
    }

    function getConfig() { return _config; }
    function isConnected() { return _isConnected; }
    function getRegions() { return OSS_REGIONS.slice(); }

    function onStatusChange(fn) {
        if (typeof fn === 'function') _statusListeners.push(fn);
    }
    function _notifyStatus() {
        _statusListeners.forEach(function (fn) {
            try { fn({ connected: _isConnected, config: _config }); } catch (e) {}
        });
    }

    // ==== 阿里云 OSS 签名（V1，用于测试连接） ====

    /**
     * 生成 OSS V1 签名（HMAC-SHA1 + Base64）
     * 参考：https://help.aliyun.com/document_detail/31951.html
     */
    async function _hmacSha1Base64(key, message) {
        var enc = new TextEncoder();
        var cryptoKey = await crypto.subtle.importKey(
            'raw', enc.encode(key),
            { name: 'HMAC', hash: 'SHA-1' },
            false, ['sign']
        );
        var sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
        var bytes = new Uint8Array(sig);
        var binary = '';
        for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        return btoa(binary);
    }

    function _gmtDate() {
        return new Date().toUTCString();
    }

    /**
     * 构造 OSS 请求签名
     * @param {string} method  HTTP 方法 GET/PUT/DELETE/HEAD
     * @param {string} bucket  Bucket 名
     * @param {string} objectKey  对象路径（可为空字符串）
     * @param {string} date    GMT 日期字符串
     * @param {string} contentType
     * @param {string} accessKeySecret
     */
    async function _buildAuthHeader(method, bucket, objectKey, date, contentType, accessKeyId, accessKeySecret) {
        var canonicalResource = '/' + bucket + '/' + (objectKey || '');
        var stringToSign = [
            method,
            '',                      // Content-MD5
            contentType || '',       // Content-Type
            date,                    // Date
            canonicalResource
        ].join('\n');
        var signature = await _hmacSha1Base64(accessKeySecret, stringToSign);
        return 'OSS ' + accessKeyId + ':' + signature;
    }

    /**
     * 测试连接：向 Bucket 发送一个 GET (?prefix=&max-keys=1) 请求，验证凭据可用
     * @returns {Promise<{ok:boolean, code?:string, message?:string}>}
     */
    async function testConnection(cfg) {
        cfg = cfg || _config;
        if (!cfg || !cfg.bucket || !cfg.region || !cfg.accessKeyId || !cfg.accessKeySecret) {
            return { ok: false, code: 'MISSING_CONFIG', message: '请填写完整的密钥信息' };
        }
        var host = cfg.bucket + '.' + cfg.region + '.aliyuncs.com';
        var url = 'https://' + host + '/?max-keys=1';
        var date = _gmtDate();
        try {
            var auth = await _buildAuthHeader('GET', cfg.bucket, '', date, '', cfg.accessKeyId, cfg.accessKeySecret);
            var res = await fetch(url, {
                method: 'GET',
                headers: {
                    'Authorization': auth,
                    'Date': date
                }
            });
            if (res.ok) {
                return { ok: true };
            }
            // 尝试解析 OSS 错误
            var text = '';
            try { text = await res.text(); } catch (e) {}
            var codeMatch = /<Code>([^<]+)<\/Code>/.exec(text);
            var msgMatch = /<Message>([^<]+)<\/Message>/.exec(text);
            var code = codeMatch ? codeMatch[1] : ('HTTP_' + res.status);
            var message = msgMatch ? msgMatch[1] : ('请求失败：HTTP ' + res.status);
            // 常见错误的中文说明
            var friendly = _friendlyError(code, message, res.status);
            return { ok: false, code: code, message: friendly };
        } catch (e) {
            console.warn('[cloud-sync] 测试连接失败', e);
            // 网络错误 / CORS
            var msg = String(e && e.message || e);
            if (/Failed to fetch|NetworkError|CORS/i.test(msg)) {
                return {
                    ok: false,
                    code: 'NETWORK_OR_CORS',
                    message: '无法连接到阿里云。请检查：\n1) 网络是否正常\n2) Bucket 是否已开启跨域访问（CORS）\n3) Bucket 名和地区是否正确'
                };
            }
            return { ok: false, code: 'UNKNOWN', message: '连接失败：' + msg };
        }
    }

    function _friendlyError(code, message, status) {
        if (code === 'InvalidAccessKeyId')      return 'AccessKey ID 不正确';
        if (code === 'SignatureDoesNotMatch')   return 'AccessKey Secret 不正确';
        if (code === 'NoSuchBucket')            return '找不到 Bucket，请检查 Bucket 名称和地区是否匹配';
        if (code === 'AccessDenied')            return '权限不足。请检查 AccessKey 是否有该 Bucket 的读写权限';
        if (status === 403)                     return '权限被拒绝（403）。请检查 AccessKey 权限或 Bucket 配置';
        if (status === 404)                     return '资源不存在（404）。请检查 Bucket 名称和地区';
        return message || '连接失败';
    }

    // ==== 暴露 ====
    global.CloudSync = {
        // 常量
        OSS_REGIONS: OSS_REGIONS,
        // 配置
        loadConfig: loadConfig,
        saveConfig: saveConfig,
        clearConfig: clearConfig,
        getConfig: getConfig,
        isConnected: isConnected,
        getRegions: getRegions,
        onStatusChange: onStatusChange,
        // 连接
        testConnection: testConnection
    };

    // 页面加载时读取一次
    if (typeof localforage !== 'undefined') {
        loadConfig().catch(function () {});
    }
})(typeof window !== 'undefined' ? window : this);
