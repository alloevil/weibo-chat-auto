// 本地查看器 JSON 请求体的统一解析入口。
'use strict';

const { readUtf8 } = require('./read-stream');

const DEFAULT_MAX_BYTES = 64 * 1024;

class JsonBodyError extends Error {
    constructor(message, statusCode) {
        super(message);
        this.name = 'JsonBodyError';
        this.statusCode = statusCode;
    }
}

async function readJsonBody(stream, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
    let text;
    try {
        // 请求超限后排空剩余输入而不销毁 socket，调用方才能稳定返回 HTTP 413。
        text = await readUtf8(stream, { maxBytes, destroyOnLimit: false });
    } catch (e) {
        if (e.code === 'ERR_STREAM_MAX_BYTES') throw new JsonBodyError(e.message, 413);
        throw new JsonBodyError(`读取请求体失败: ${e.message}`, 400);
    }
    try {
        return JSON.parse(text);
    } catch {
        throw new JsonBodyError('参数解析失败', 400);
    }
}

module.exports = { DEFAULT_MAX_BYTES, JsonBodyError, readJsonBody };
