import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const distDir = path.join(__dirname, 'dist');
const binDir = path.join(root, 'src-tauri', 'binaries');
const resourceDir = path.join(__dirname, 'resources');

const ext = process.platform === 'win32' ? '.exe' : '';
const targetTriple = execSync('rustc --print host-tuple').toString().trim();

console.log(`[sidecar] Platform: ${process.platform}, Target: ${targetTriple}`);

// Use Bun to compile viewer-server.js into a standalone binary
console.log('[sidecar] Compiling with bun build --compile...');
fs.mkdirSync(distDir, { recursive: true });

const outfile = path.join(distDir, `viewer-server${ext}`);
execSync(
    `bun build "${path.join(root, 'scripts', 'viewer-server.js')}" --compile --outfile "${outfile}"`,
    { cwd: root, stdio: 'inherit' }
);

// Move to binaries directory with Tauri's expected naming
console.log('[sidecar] Moving to binaries/...');
fs.mkdirSync(binDir, { recursive: true });
const dst = path.join(binDir, `viewer-server-${targetTriple}${ext}`);
if (fs.existsSync(dst)) fs.unlinkSync(dst);
fs.copyFileSync(outfile, dst);
fs.chmodSync(dst, 0o755);

console.log(`[sidecar] Done: ${dst}`);
console.log(`[sidecar] Size: ${(fs.statSync(dst).size / 1024 / 1024).toFixed(1)} MB`);

fs.mkdirSync(path.join(resourceDir, 'lib'), { recursive: true });
for (const file of ['viewer.html', 'lib/text-utils.js', 'lib/viewer-filters.js']) {
    fs.copyFileSync(path.join(root, file), path.join(resourceDir, file));
}
const worker = path.join(resourceDir, `archive-worker${ext}`);
execSync(
    `bun build "${path.join(__dirname, 'archive-worker.mjs')}" --compile --outfile "${worker}"`,
    { cwd: root, stdio: 'inherit' }
);
fs.chmodSync(worker, 0o755);
console.log(`[sidecar] Runtime resources: ${resourceDir}`);
