// 跨平台解析 Chrome 可执行文件路径。
// 优先用 config.json 的 chromePath（若存在且文件存在）；否则按平台探测常见安装位置。
'use strict';

const fs = require('fs');

// 各平台 Chrome / Chromium 常见安装路径
const CANDIDATES = {
    darwin: [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ],
    linux: [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/snap/bin/chromium',
        '/usr/bin/microsoft-edge',
    ],
    win32: [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ],
};

// WSL：可指向 Windows 侧的 Chrome
const WSL_CANDIDATES = [
    '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
    '/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];

function isWSL() {
    try {
        return /microsoft|wsl/i.test(fs.readFileSync('/proc/version', 'utf8'));
    } catch {
        return false;
    }
}

// 解析 Chrome 路径。configChromePath 可为 undefined / 空串。
function resolveChromePath(configChromePath) {
    // 1. config 指定且存在 → 直接用
    if (configChromePath && fs.existsSync(configChromePath)) {
        return configChromePath;
    }

    // 2. 按平台探测
    const platform = process.platform;
    let list = CANDIDATES[platform] || [];
    if (platform === 'linux' && isWSL()) {
        list = [...list, ...WSL_CANDIDATES];
    }
    for (const p of list) {
        if (fs.existsSync(p)) return p;
    }

    // 3. config 指定了但文件不存在 → 仍返回它（让 puppeteer 报清晰错误）
    if (configChromePath) return configChromePath;

    // 4. 全部落空
    throw new Error(
        `未找到 Chrome 可执行文件（平台：${platform}）。\n` +
        `请安装 Google Chrome，或在 config.json 的 chromePath 指定其路径。`
    );
}

module.exports = { resolveChromePath, isWSL };
