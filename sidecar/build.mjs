import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const distDir = path.join(__dirname, 'dist');
const binDir = path.join(root, 'src-tauri', 'binaries');

const ext = process.platform === 'win32' ? '.exe' : '';
const targetTriple = execSync('rustc --print host-tuple').toString().trim();

console.log(`[sidecar] Platform: ${process.platform}, Target: ${targetTriple}`);
console.log(`[sidecar] Node: ${process.version}`);

// Step 1: Bundle viewer-server.js + qa-agent.mjs into single CJS file
console.log('[sidecar] Step 1: esbuild bundle...');
fs.mkdirSync(distDir, { recursive: true });

execSync(
  `npx esbuild "${path.join(root, 'viewer-server.js')}" ` +
  `--bundle --platform=node --format=cjs ` +
  `--outfile="${path.join(distDir, 'server.cjs')}" ` +
  `--external:puppeteer ` +
  `--define:import.meta.url=__filename_url`,
  { cwd: root, stdio: 'inherit' }
);

// Prepend a shim for import.meta.url used in the bundle
const bundled = fs.readFileSync(path.join(distDir, 'server.cjs'), 'utf8');
const shimmed = `var __filename_url = require('url').pathToFileURL(__filename).href;\n` + bundled;
fs.writeFileSync(path.join(distDir, 'server.cjs'), shimmed);

// Step 2: Create SEA config
console.log('[sidecar] Step 2: Node.js SEA prep...');
const seaConfig = {
  main: path.join(distDir, 'server.cjs'),
  output: path.join(distDir, 'sea-prep.blob'),
  disableExperimentalSEAWarning: true
};
const seaConfigPath = path.join(distDir, 'sea-config.json');
fs.writeFileSync(seaConfigPath, JSON.stringify(seaConfig, null, 2));

execSync(`node --experimental-sea-config "${seaConfigPath}"`, {
  cwd: root,
  stdio: 'inherit'
});

// Step 3: Copy node binary and inject blob
console.log('[sidecar] Step 3: inject SEA blob...');
const nodeBin = process.execPath;
const outputBin = path.join(distDir, `viewer-server${ext}`);

fs.copyFileSync(nodeBin, outputBin);
fs.chmodSync(outputBin, 0o755);

if (process.platform === 'darwin') {
  execSync(`codesign --remove-signature "${outputBin}"`, { stdio: 'inherit' });
}

execSync(
  `npx postject "${outputBin}" NODE_SEA_BLOB "${path.join(distDir, 'sea-prep.blob')}" ` +
  `--sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6ac44c7a9e8d1070f ` +
  (process.platform === 'darwin' ? '--macho-segment-name NODE_SEA ' : ''),
  { cwd: root, stdio: 'inherit' }
);

if (process.platform === 'darwin') {
  execSync(`codesign --sign - "${outputBin}"`, { stdio: 'inherit' });
}

// Step 4: Move to binaries directory
console.log('[sidecar] Step 4: move to binaries/...');
fs.mkdirSync(binDir, { recursive: true });
const dst = path.join(binDir, `viewer-server-${targetTriple}${ext}`);
if (fs.existsSync(dst)) fs.unlinkSync(dst);
fs.copyFileSync(outputBin, dst);
fs.chmodSync(dst, 0o755);

console.log(`[sidecar] Done: ${dst}`);
console.log(`[sidecar] Size: ${(fs.statSync(dst).size / 1024 / 1024).toFixed(1)} MB`);
