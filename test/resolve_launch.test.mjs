import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { resolveLaunch, tokenizeCommand } from '../lib/resolve_launch.mjs';

/** A throwaway Actor directory, so the resolver is exercised against a real filesystem. */
let cwd;

const write = (relativePath, content) => {
    const absolute = path.join(cwd, relativePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
};

const writePackageJson = (pkg) => write('package.json', JSON.stringify(pkg));

before(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'actor-debugger-test-'));
    write('dist/main.js', 'console.log(1);');
    write('src/main.ts', 'console.log(1);');
});

after(() => fs.rmSync(cwd, { recursive: true, force: true }));

describe('tokenizeCommand', () => {
    it('splits on whitespace', () => {
        assert.deepEqual(tokenizeCommand('node dist/main.js'), ['node', 'dist/main.js']);
    });

    it('keeps quoted sections together', () => {
        assert.deepEqual(tokenizeCommand(`sh -c "node dist/main.js --flag"`), [
            'sh',
            '-c',
            'node dist/main.js --flag',
        ]);
    });

    it('preserves an empty quoted argument', () => {
        assert.deepEqual(tokenizeCommand(`node dist/main.js ""`), ['node', 'dist/main.js', '']);
    });
});

describe('resolveLaunch with a passed-through start command', () => {
    it('honours `node <script>`', () => {
        const launch = resolveLaunch({ command: ['node', 'dist/main.js'], cwd });
        assert.equal(launch.entry, path.join(cwd, 'dist/main.js'));
        assert.deepEqual(launch.nodeFlags, []);
        assert.deepEqual(launch.scriptArgs, []);
    });

    it('keeps the original node flags and script arguments', () => {
        const launch = resolveLaunch({
            command: ['node', '--experimental-vm-modules', 'dist/main.js', '--verbose', 'input.json'],
            cwd,
        });
        assert.equal(launch.entry, path.join(cwd, 'dist/main.js'));
        assert.deepEqual(launch.nodeFlags, ['--experimental-vm-modules']);
        assert.deepEqual(launch.scriptArgs, ['--verbose', 'input.json']);
    });

    it('does not mistake a flag value for the script', () => {
        const launch = resolveLaunch({ command: ['node', '-r', 'ts-node/register', 'dist/main.js'], cwd });
        assert.equal(launch.entry, path.join(cwd, 'dist/main.js'));
        assert.deepEqual(launch.nodeFlags, ['-r', 'ts-node/register']);
    });

    it('resolves an absolute node binary path', () => {
        const launch = resolveLaunch({ command: ['/usr/local/bin/node', 'dist/main.js'], cwd });
        assert.equal(launch.entry, path.join(cwd, 'dist/main.js'));
    });

    it('follows `npm start` through package.json', () => {
        writePackageJson({ scripts: { start: 'node dist/main.js' } });
        const launch = resolveLaunch({ command: ['npm', 'start'], cwd });
        assert.equal(launch.entry, path.join(cwd, 'dist/main.js'));
    });

    it('follows `pnpm run <script>` and `yarn start`', () => {
        writePackageJson({ scripts: { start: 'node dist/main.js', serve: 'node dist/main.js --serve' } });
        assert.equal(resolveLaunch({ command: ['pnpm', 'run', 'serve'], cwd }).entry, path.join(cwd, 'dist/main.js'));
        assert.deepEqual(resolveLaunch({ command: ['pnpm', 'run', 'serve'], cwd }).scriptArgs, ['--serve']);
        assert.equal(resolveLaunch({ command: ['yarn', 'start'], cwd }).entry, path.join(cwd, 'dist/main.js'));
    });

    it('skips preceding build steps in a chained script', () => {
        writePackageJson({ scripts: { start: 'npm run build && node dist/main.js', build: 'tsc' } });
        const launch = resolveLaunch({ command: ['npm', 'start'], cwd });
        assert.equal(launch.entry, path.join(cwd, 'dist/main.js'));
    });

    it('picks the node segment even when it is not last in the chain', () => {
        writePackageJson({ scripts: { start: 'node dist/main.js && echo done' } });
        const launch = resolveLaunch({ command: ['npm', 'start'], cwd });
        assert.equal(launch.entry, path.join(cwd, 'dist/main.js'));
    });

    it('unwraps `sh -c`', () => {
        const launch = resolveLaunch({ command: ['sh', '-c', 'node dist/main.js'], cwd });
        assert.equal(launch.entry, path.join(cwd, 'dist/main.js'));
    });

    it('accepts a bare script path (the documented CMD form)', () => {
        const launch = resolveLaunch({ command: ['dist/main.js'], cwd });
        assert.equal(launch.entry, path.join(cwd, 'dist/main.js'));
    });
});

describe('resolveLaunch fallbacks and failures', () => {
    it('auto-detects when no command is passed', () => {
        writePackageJson({ main: 'dist/main.js' });
        const launch = resolveLaunch({ command: [], cwd });
        assert.equal(launch.entry, path.join(cwd, 'dist/main.js'));
        assert.equal(launch.source, 'auto-detected entrypoint');
    });

    it('reports a missing script instead of guessing', () => {
        const launch = resolveLaunch({ command: ['node', 'dist/nope.js'], cwd });
        assert.equal(launch.entry, null);
        assert.match(launch.reason, /does not exist/);
    });

    it('reports a missing package.json script', () => {
        writePackageJson({ scripts: {} });
        const launch = resolveLaunch({ command: ['npm', 'start'], cwd });
        assert.equal(launch.entry, null);
        assert.match(launch.reason, /no "start" script/);
    });

    it('reports an unrecognized launcher rather than running the wrong thing', () => {
        const launch = resolveLaunch({ command: ['tsx', 'src/main.ts'], cwd });
        assert.equal(launch.entry, null);
        assert.match(launch.reason, /unrecognized start command/);
    });

    it('stops on self-referential scripts', () => {
        writePackageJson({ scripts: { start: 'npm start' } });
        const launch = resolveLaunch({ command: ['npm', 'start'], cwd });
        assert.equal(launch.entry, null);
        assert.match(launch.reason, /indirection/);
    });
});
