import {mkdtemp, readFile, readdir, copyFile, mkdir, lstat, utimes, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const root = resolve(import.meta.dirname, '..');
const metadata = JSON.parse(await readFile(join(root, 'metadata.json'), 'utf8'));
if (!/^[a-z0-9-]+@[a-z0-9.-]+$/.test(metadata.uuid)) throw new Error(`Invalid extension UUID: ${metadata.uuid}`);
const staging = await mkdtemp(join(tmpdir(), 'btcprice-package-'));
const entries = [];
async function add(src, dest) {
    if ((await lstat(join(root, src))).isSymbolicLink()) throw new Error(`Symlink in package input: ${src}`);
    await mkdir(join(staging, dest, '..'), {recursive: true});
    await copyFile(join(root, src), join(staging, dest));
    entries.push(dest);
}
try {
    for (const file of ['metadata.json', 'stylesheet.css', 'LICENSE']) await add(file, file);
    // Source-derived manifest: stale or injected files in build/ cannot ship.
    for (const name of (await readdir(join(root, 'src'))).sort())
        if (name.endsWith('.ts') && !name.endsWith('.d.ts')) await add(join('build', name.slice(0, -3) + '.js'), name.slice(0, -3) + '.js');
    entries.sort();
    for (const path of entries) await utimes(join(staging, path), 315532800, 315532800);
    await mkdir(join(root, 'dist'), {recursive: true});
    const output = join(root, 'dist', metadata.uuid + '.shell-extension.zip');
    await rm(output, {force: true}); // zip updates an existing archive; remove only this generated output.
    const zip = spawnSync('zip', ['-X', '-q', output, ...entries], {cwd: staging, encoding: 'utf8'});
    if (zip.status !== 0) throw new Error(`zip failed: ${zip.stderr}`);
    const hash = createHash('sha256').update(await readFile(output)).digest('hex');
    await writeFile(output + '.sha256', `${hash}  ${metadata.uuid}.shell-extension.zip\n`);
    console.log(output);
    console.log('SHA256 ' + hash);
} finally {
    await rm(staging, {recursive: true, force: true});
}
