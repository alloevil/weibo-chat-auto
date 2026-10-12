import cookieStore from '../lib/cookie-store.js';

const task = process.argv[2];
try {
    if (task === 'archive') {
        if (!cookieStore.hasLoginCookie()) {
            throw new Error('微博 Cookie 未配置，请先在应用内扫码登录');
        }
        await import('../scripts/auto-archive-simple.js');
    } else if (task === 'index') {
        const { main } = await import('../scripts/build-qa-index.mjs');
        await main(process.argv.slice(3));
    } else {
        throw new Error('需要指定 archive 或 index 任务');
    }
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
