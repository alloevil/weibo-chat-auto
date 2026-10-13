'use strict';

const puppeteer = require('puppeteer');
const { resolveChromePath } = require('../lib/chrome-path');

function launchTestBrowser() {
    return puppeteer.launch({
        executablePath: resolveChromePath(),
        headless: true,
        args: ['--no-sandbox'],
    });
}

async function newTestPage(owner, errors) {
    const page = await owner.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    return page;
}

function handleNonLocalRequest(request, external) {
    const url = new URL(request.url());
    if (!['http:', 'https:'].includes(url.protocol)) request.continue();
    else if (url.hostname !== '127.0.0.1') {
        external.push(request.url());
        request.abort();
    } else return false;
    return true;
}

function waitForLayout(page) {
    return page.evaluate(
        () =>
            new Promise((resolve) => {
                globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve));
            })
    );
}

module.exports = { launchTestBrowser, newTestPage, handleNonLocalRequest, waitForLayout };
