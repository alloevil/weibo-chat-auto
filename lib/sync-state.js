'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { writePrivateJson } = require('./private-json');

function readLastSuccessfulSync(stateDirectory) {
    let value;
    try {
        value = JSON.parse(fs.readFileSync(path.join(stateDirectory, 'sync-status.json'), 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
    const timestamp = value?.lastSuccessfulSyncAt;
    if (typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp))) {
        throw new Error('Invalid last successful sync time');
    }
    return new Date(timestamp).toISOString();
}

function recordSuccessfulSync(stateDirectory, completedAt = new Date()) {
    const lastSuccessfulSyncAt = completedAt.toISOString();
    fs.mkdirSync(stateDirectory, { recursive: true });
    writePrivateJson(path.join(stateDirectory, 'sync-status.json'), { lastSuccessfulSyncAt });
    return lastSuccessfulSyncAt;
}

module.exports = { readLastSuccessfulSync, recordSuccessfulSync };
