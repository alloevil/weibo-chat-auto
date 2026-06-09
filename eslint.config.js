'use strict';

// ESLint 9 flat config。规则保持克制：以抓真实错误为主，风格交给 prettier。
const js = require('@eslint/js');
const prettier = require('eslint-config-prettier');

module.exports = [
    { ignores: ['node_modules/**', 'output/**', 'cache/**', 'docs/**', '.archiver-script.js', '.*.js'] },
    js.configs.recommended,
    prettier,
    // 通用 Node 脚本
    {
        files: ['*.js', 'lib/**/*.js', 'test/**/*.js'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'commonjs',
            globals: {
                require: 'readonly',
                module: 'writable',
                process: 'readonly',
                __dirname: 'readonly',
                console: 'readonly',
                Buffer: 'readonly',
                setTimeout: 'readonly',
                clearTimeout: 'readonly',
                globalThis: 'readonly',
                URL: 'readonly',
                fetch: 'readonly',
            },
        },
        rules: {
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
            'no-undef': 'error',
            'no-empty': ['error', { allowEmptyCatch: true }],
            // 表情匹配正则有意包含 surrogate pair / 组合字符，关闭该规则
            'no-misleading-character-class': 'off',
            // 中文场景下「　」(全角空格) 等被判为 irregular whitespace，属正常字符
            'no-irregular-whitespace': 'off',
        },
    },
    // save-cookies.js / auto-archive-simple.js 含 puppeteer page.evaluate 回调，
    // 这些回调在浏览器上下文执行，DOM 全局是合法的
    {
        files: ['save-cookies.js', 'auto-archive-simple.js'],
        languageOptions: {
            globals: {
                document: 'readonly',
                window: 'readonly',
                location: 'readonly',
                XMLHttpRequest: 'readonly',
                KeyboardEvent: 'readonly',
                navigator: 'readonly',
                fetch: 'readonly',
            },
        },
    },
];
