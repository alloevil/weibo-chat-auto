// 流式读取 UTF-8 文本。
//
// 为什么需要它：`stream.on('data', chunk => text += chunk)` 会把每个 Buffer
// 单独 toString('utf8')，一个中文字（3 字节）跨 chunk 边界时两半各自解码失败，
// 变成 ���。归档器的 httpsGet 正是这么写的，实测已经把 446 条消息写坏了
// （例："这样咱就不用撤回了" → "���样咱就不用撤回了"）。
//
// 正确做法：要么攒 Buffer 最后一次 concat，要么用 setEncoding（内部 StringDecoder
// 会保留不完整的多字节序列）。这里用前者，顺带能返回字节数。
'use strict';

/**
 * 把可读流读成 UTF-8 字符串（正确处理跨 chunk 的多字节字符）。
 * @param {import('stream').Readable} stream
 * @param {{maxBytes?: number}} [opts] 超过上限即销毁流并拒绝（防止无界内存）
 * @returns {Promise<string>}
 */
function readUtf8(stream, { maxBytes = 0 } = {}) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let bytes = 0;
        stream.on('data', (chunk) => {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf-8');
            bytes += buf.length;
            if (maxBytes > 0 && bytes > maxBytes) {
                stream.destroy();
                reject(new Error(`请求体超过 ${maxBytes} 字节上限`));
                return;
            }
            chunks.push(buf);
        });
        stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        stream.on('error', reject);
    });
}

module.exports = { readUtf8 };
