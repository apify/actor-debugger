import fs from 'node:fs';
import path from 'node:path';

const SKIP_DIRS = new Set(['node_modules', '.git', '.actor', 'apify_storage', 'storage']);
const JS_EXT = new Set(['.js', '.mjs', '.cjs']);
const MAP_RE = /(\/\/[#@][ \t]*sourceMappingURL=)([^\s]+)/g;
const MAX_FILES = 5000;

function lastMapRef(source) {
    let match = null;
    for (const m of source.matchAll(MAP_RE)) match = m;
    return match;
}

function decodeDataUrl(url) {
    const m = /^data:application\/json[^,]*;base64,(.*)$/.exec(url);
    if (!m) return null;
    try {
        return JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
    } catch {
        return null;
    }
}

/** Fill in map.sourcesContent from the .ts/.js sources on disk where missing. */
function embedSources(map, mapDir) {
    const sources = map.sources ?? [];
    const content = map.sourcesContent ?? new Array(sources.length).fill(null);
    let missing = 0;
    for (let i = 0; i < sources.length; i++) {
        if (content[i] != null) continue;
        const src = sources[i];
        if (!src || /^[a-z+]+:/i.test(src)) {
            missing++;
            continue;
        }
        const file = path.resolve(mapDir, map.sourceRoot ?? '', src);
        try {
            content[i] = fs.readFileSync(file, 'utf8');
        } catch {
            missing++;
        }
    }
    map.sourcesContent = content;
    return missing;
}

/**
 * Make every compiled file's source map usable by a REMOTE DevTools frontend. The browser serving
 * our DevTools UI can never fetch `file://` URLs from the container, so external `.map` files (and
 * the original .ts sources they point at) are unreachable to it - only what is embedded in the
 * script itself gets through the inspector. This walks `rootDir`, and for each .js/.mjs/.cjs file:
 *  - resolves an external sourceMappingURL against the file, reading the .map from disk;
 *  - embeds the original sources into the map (`sourcesContent`) from disk where missing;
 *  - rewrites the sourceMappingURL comment to an inline base64 `data:` URL.
 * Already-inline maps just get missing `sourcesContent` filled in. Files without a map reference
 * are left untouched.
 *
 * @returns {{ inlined: number, alreadyInline: number, scanned: number, missingSources: number }}
 */
export function inlineSourceMaps(rootDir, log = () => {}) {
    const stats = { inlined: 0, alreadyInline: 0, scanned: 0, missingSources: 0 };
    const walk = (dir) => {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (stats.scanned >= MAX_FILES) return;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) walk(full);
                continue;
            }
            if (!entry.isFile() || !JS_EXT.has(path.extname(entry.name))) continue;
            stats.scanned++;
            processFile(full, stats, log);
        }
    };
    walk(rootDir);
    return stats;
}

function processFile(file, stats, log) {
    let source;
    try {
        source = fs.readFileSync(file, 'utf8');
    } catch {
        return;
    }
    const ref = lastMapRef(source);
    if (!ref) return;
    const url = ref[2];

    let map;
    let alreadyInline = false;
    if (url.startsWith('data:')) {
        map = decodeDataUrl(url);
        alreadyInline = true;
        // Inline map already carrying all sources - nothing for us to do.
        if (map && (map.sourcesContent ?? []).length >= (map.sources ?? []).length
            && (map.sourcesContent ?? []).every((c) => c != null)) {
            stats.alreadyInline++;
            return;
        }
    } else if (!/^[a-z+]+:/i.test(url)) {
        try {
            map = JSON.parse(fs.readFileSync(path.resolve(path.dirname(file), url), 'utf8'));
        } catch {
            log(`map file for ${file} not readable (${url}) - skipped`);
            return;
        }
    }
    if (!map) return;

    stats.missingSources += embedSources(map, path.dirname(file));
    const dataUrl = `data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}`;
    const start = ref.index + ref[1].length;
    const patched = source.slice(0, start) + dataUrl + source.slice(start + url.length);
    try {
        fs.writeFileSync(file, patched);
        stats.inlined++;
    } catch {
        log(`could not rewrite ${file} - skipped${alreadyInline ? '' : ' (map stays external)'}`);
    }
}
