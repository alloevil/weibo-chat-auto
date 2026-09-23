// 含凭据的 JSON 文件统一写入口：原子替换，并强制仅当前用户可读写。
'use strict';

const fs = require('fs');
const crypto = require('crypto');

const PRIVATE_MODE = 0o600;

function ensurePrivateFileMode(file) {
    if (!fs.existsSync(file)) return false;
    fs.chmodSync(file, PRIVATE_MODE);
    return true;
}

function writePrivateJson(file, value) {
    const nonce = crypto.randomBytes(6).toString('hex');
    const tmp = `${file}.tmp-${process.pid}-${nonce}`;
    try {
        fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: PRIVATE_MODE });
        fs.renameSync(tmp, file);
        // mode 只保证新建临时文件；再 chmod 可覆盖旧文件权限与平台差异。
        fs.chmodSync(file, PRIVATE_MODE);
    } catch (e) {
        try {
            fs.unlinkSync(tmp);
        } catch {}
        throw e;
    }
}

module.exports = { PRIVATE_MODE, ensurePrivateFileMode, writePrivateJson };
