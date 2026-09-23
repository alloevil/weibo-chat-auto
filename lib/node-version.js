'use strict';

const SUPPORTED_NODE_RANGE = '^22.13.0 || >=24.0.0';
const SUPPORTED_NODE_LABEL = 'Node.js 22.13+ LTS 或 24+';

function parseNodeVersion(value) {
    const match = String(value || '')
        .trim()
        .match(/^v?(\d+)\.(\d+)\.(\d+)/);
    if (!match) return null;
    return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function isSupportedNodeVersion(value) {
    const version = parseNodeVersion(value);
    if (!version) return false;
    if (version.major >= 24) return true;
    return version.major === 22 && version.minor >= 13;
}

module.exports = {
    SUPPORTED_NODE_RANGE,
    SUPPORTED_NODE_LABEL,
    parseNodeVersion,
    isSupportedNodeVersion,
};
