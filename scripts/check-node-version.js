#!/usr/bin/env node
'use strict';

const {
    SUPPORTED_NODE_LABEL,
    SUPPORTED_NODE_RANGE,
    isSupportedNodeVersion,
} = require('../lib/node-version');

if (!isSupportedNodeVersion(process.version)) {
    console.error(
        `当前 ${process.version} 不受支持；需要 ${SUPPORTED_NODE_LABEL}（engines: ${SUPPORTED_NODE_RANGE}）。`
    );
    process.exitCode = 1;
}
