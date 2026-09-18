/**
 * Turns the Actor's start command into a Node.js launch spec (entrypoint + node flags + script args).
 *
 * This exists because `actor-debugger` can run as the image ENTRYPOINT, in which case Docker appends
 * the image's original CMD to our arguments - so the Actor's real start command arrives as argv and
 * we can honour it instead of guessing. It still supports being run as the CMD itself, with either an
 * explicit entrypoint path or nothing at all (then the entrypoint is auto-detected).
 */
import fs from 'node:fs';
import path from 'node:path';

/** How many layers of indirection to follow (`npm start` -> `sh -c "..."` -> `node x.js`). */
const MAX_DEPTH = 4;

const NODE_BINARIES = new Set(['node', 'nodejs']);
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn']);
const SHELLS = new Set(['sh', 'bash', 'dash', 'ash', 'zsh']);

/** Subcommands that precede the script name (`npm run start`); `npm start` names the script directly. */
const RUN_SUBCOMMANDS = new Set(['run', 'run-script']);

/**
 * Node flags whose value is a separate argument, so the token after them is NOT the script path
 * (e.g. `node -r ts-node/register src/main.ts`).
 */
const NODE_FLAGS_WITH_SEPARATE_VALUE = new Set([
    '-r',
    '--require',
    '--import',
    '--loader',
    '--experimental-loader',
    '-C',
    '--conditions',
    '--max-old-space-size',
    '--max-semi-space-size',
    '--inspect-port',
    '--title',
]);

/** Entrypoints to try when there is no start command to learn from. */
const FALLBACK_ENTRIES = ['dist/main.js', 'dist/index.js', 'build/main.js', 'src/main.js', 'main.js', 'index.js'];

/** Operators that chain commands; the Actor is started by one of the segments, usually the last. */
const CHAIN_OPERATORS = new Set(['&&', '||', ';', '|']);

/**
 * Splits a command string into tokens, honouring single and double quotes so that
 * `sh -c "node dist/main.js"` keeps the inner command in one token.
 */
export function tokenizeCommand(commandString) {
    const tokens = [];
    let current = '';
    let quote = null;
    let hasContent = false;

    for (const char of commandString) {
        if (quote) {
            if (char === quote) quote = null;
            else current += char;
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            hasContent = true;
            continue;
        }
        if (/\s/.test(char)) {
            if (hasContent || current) tokens.push(current);
            current = '';
            hasContent = false;
            continue;
        }
        current += char;
    }
    if (hasContent || current) tokens.push(current);
    return tokens;
}

/** Splits a token list on shell chaining operators, e.g. `npm run build && node dist/main.js`. */
function splitChain(command) {
    const segments = [[]];
    for (const token of command) {
        if (CHAIN_OPERATORS.has(token)) segments.push([]);
        else segments[segments.length - 1].push(token);
    }
    return segments.filter((segment) => segment.length > 0);
}

/** Separates a `node`-invocation tail into flags, the script path and the script's own arguments. */
function splitNodeInvocation(args) {
    const flags = [];
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (!arg.startsWith('-')) return { flags, target: arg, scriptArgs: args.slice(index + 1) };
        flags.push(arg);
        // `-r ts-node/register` - the value is a separate token and must not be read as the script.
        if (NODE_FLAGS_WITH_SEPARATE_VALUE.has(arg) && args[index + 1] !== undefined) {
            flags.push(args[index + 1]);
            index++;
        }
    }
    return { flags, target: undefined, scriptArgs: [] };
}

/** Reads the script name out of a package-manager invocation (`npm start`, `pnpm run dev`, ...). */
function packageManagerScript(args) {
    const positional = args.filter((arg) => !arg.startsWith('-') && arg !== '--');
    if (positional.length === 0) return undefined;
    if (RUN_SUBCOMMANDS.has(positional[0])) return positional[1];
    return positional[0];
}

function readPackageJson(cwd) {
    try {
        return JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    } catch {
        return undefined;
    }
}

function existingFile(cwd, candidate) {
    const absolute = path.resolve(cwd, candidate);
    return fs.existsSync(absolute) && fs.statSync(absolute).isFile() ? absolute : undefined;
}

/** Looks for a conventional entrypoint when no usable start command is available. */
function autoDetectEntry(cwd) {
    const pkg = readPackageJson(cwd);
    const candidates = [];
    const startScript = pkg?.scripts?.start;
    if (startScript) {
        const startMatch = /node\s+(?:--\S+\s+)*(\S+)/.exec(startScript);
        if (startMatch) candidates.push(startMatch[1]);
    }
    if (pkg?.main) candidates.push(pkg.main);
    candidates.push(...FALLBACK_ENTRIES);

    for (const candidate of candidates) {
        const absolute = existingFile(cwd, candidate);
        if (absolute) return absolute;
    }
    return undefined;
}

const autoDetect = (cwd) => {
    const entry = autoDetectEntry(cwd);
    return entry
        ? { entry, nodeFlags: [], scriptArgs: [], source: 'auto-detected entrypoint' }
        : {
              entry: null,
              reason: 'could not find an Actor entrypoint, and no start command was passed through to learn from',
          };
};

/**
 * Resolves how to start the Actor under the inspector.
 *
 * @param {object} options
 * @param {string[]} options.command The Actor's start command (image CMD passed through by Docker),
 *   or a single explicit entrypoint path, or empty to auto-detect.
 * @param {string} [options.cwd] Directory the command would run in.
 * @returns {{entry: string, nodeFlags: string[], scriptArgs: string[], source: string}
 *   | {entry: null, reason: string}}
 */
export function resolveLaunch({ command = [], cwd = process.cwd(), depth = 0 } = {}) {
    if (command.length === 0) return autoDetect(cwd);
    if (depth > MAX_DEPTH) {
        return { entry: null, reason: `start command "${command.join(' ')}" has too many layers of indirection` };
    }

    // `npm run build && node dist/main.js` - try the segments from the last one back, so the segment
    // that actually starts the Actor wins over preceding build steps.
    const segments = splitChain(command);
    if (segments.length > 1) {
        for (const segment of segments.reverse()) {
            const resolved = resolveLaunch({ command: segment, cwd, depth: depth + 1 });
            if (resolved.entry) return resolved;
        }
        return { entry: null, reason: `no Node.js entrypoint found in "${command.join(' ')}"` };
    }

    const [binary, ...args] = segments[0] ?? command;
    const name = path.basename(binary);
    const printable = command.join(' ');

    // `node [flags] <script> [args]`
    if (NODE_BINARIES.has(name)) {
        const { flags, target, scriptArgs } = splitNodeInvocation(args);
        if (!target) return { entry: null, reason: `no script found in "${printable}"` };
        const entry = existingFile(cwd, target);
        return entry
            ? { entry, nodeFlags: flags, scriptArgs, source: `"${printable}"` }
            : { entry: null, reason: `script "${target}" from "${printable}" does not exist in the image` };
    }

    // `npm start`, `pnpm run dev`, `yarn start`, ... - follow the script from package.json.
    if (PACKAGE_MANAGERS.has(name)) {
        const script = packageManagerScript(args);
        if (!script) return { entry: null, reason: `could not tell which script "${printable}" runs` };
        const scriptCommand = readPackageJson(cwd)?.scripts?.[script];
        if (!scriptCommand) return { entry: null, reason: `package.json has no "${script}" script` };
        return resolveLaunch({ command: tokenizeCommand(scriptCommand), cwd, depth: depth + 1 });
    }

    // `sh -c "node dist/main.js"`
    if (SHELLS.has(name)) {
        const flagIndex = args.indexOf('-c');
        const inner = flagIndex === -1 ? undefined : args[flagIndex + 1];
        if (!inner) return { entry: null, reason: `could not read the command out of "${printable}"` };
        return resolveLaunch({ command: tokenizeCommand(inner), cwd, depth: depth + 1 });
    }

    // A bare path to a script - the documented `actor-debugger dist/main.js` form.
    const entry = existingFile(cwd, binary);
    if (entry) return { entry, nodeFlags: [], scriptArgs: args, source: `"${printable}"` };

    return { entry: null, reason: `unrecognized start command "${printable}"` };
}
