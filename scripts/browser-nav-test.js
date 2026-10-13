'use strict';

async function clickNavAction(page, selector) {
    const inMenu = await page.$eval(selector, (element) => !!element.closest('#archiveMore'));
    if (inMenu && !(await page.$eval('#archiveMore', (element) => element.open))) {
        await page.click('#archiveMoreToggle');
    }
    await page.click(selector);
}

module.exports = { clickNavAction };
