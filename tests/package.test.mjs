import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile, rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const pack = () => {
    const run = spawnSync(process.execPath, ['scripts/package.mjs'], {encoding: 'utf8'});
    assert.equal(run.status, 0, run.stderr);
};
const archive = async () => 'dist/' + JSON.parse(await readFile('metadata.json', 'utf8')).uuid + '.shell-extension.zip';
const list = async () => spawnSync('unzip', ['-Z1', await archive()], {encoding: 'utf8'}).stdout.trim().split('\n').sort();

test('archive is repeatable and ships exactly the runtime files', async () => {
    pack();
    const first = createHash('sha256').update(await readFile(await archive())).digest('hex');
    pack();
    assert.equal(createHash('sha256').update(await readFile(await archive())).digest('hex'), first);
    assert.deepEqual(await list(), ['LICENSE', 'client.js', 'controller.js', 'extension.js', 'indicator.js', 'metadata.json', 'price.js', 'stylesheet.css']);
});

test('stale or injected build files cannot enter the archive', async () => {
    try {
        await writeFile('build/injected.js', 'unexpected');
        pack();
        assert.equal((await list()).includes('injected.js'), false);
    } finally {
        await rm('build/injected.js', {force: true});
    }
});
