import fs, { promises as fsa } from 'fs';
import { normalize, basename, extname, resolve, parse, sep } from 'path';
import Koa from 'koa';
import resolvePath from 'resolve-path';
import createError from 'http-errors';
import Util from '@misaka/util';

async function exists(path: fs.PathLike) {
    try {
        await fsa.access(path);
        return true;
    } catch (e) {
        return false;
    }
}

type SetHeaders = (res: Koa.ParameterizedContext["res"], path: string, stats: fs.Stats) => any;

declare namespace send {
    interface SendOptions {
        /** Path is absolute path. */
        absolute?: boolean;
        /** Browser cache max-age in milliseconds. (defaults to 0) */
        maxage?: number;
        maxAge?: SendOptions["maxage"];
        /** Tell the browser the resource is immutable and can be cached indefinitely. (defaults to false) */
        immutable?: boolean;
        /** Allow transfer of hidden files. (defaults to false) */
        hidden?: boolean;
        /** Root directory to restrict file access. (defaults to '') */
        root?: string;
        /** Name of the index file to serve automatically when visiting the root location. (defaults to none) */
        index?: string | false;
        /** Try to serve the gzipped version of a file automatically when gzip is supported by a client and if the requested file with .gz extension exists. (defaults to true). */
        gzip?: boolean;
        /** Try to serve the brotli version of a file automatically when brotli is supported by a client and if the requested file with .br extension exists. (defaults to true). */
        brotli?: boolean;
        /** If not false (defaults to true), format the path to serve static file servers and not require a trailing slash for directories, so that you can do both /directory and /directory/. */
        format?: boolean;
        /** Function to set custom headers on response. */
        setHeaders?: SetHeaders;
        /** Try to match extensions from passed array to search for file when no extension is sufficed in URL. First found is served. (defaults to false) */
        extensions?: string[] | false;
    }
    interface SendResult {
        /** Indicates the request is handled successfully. */
        ok: boolean;
        /** Requested path. */
        path?: string;
        /** The requested path is a directory and can be browsed. */
        isDirectory?: boolean;
    }
}
/**
 * Send file at `path` with the
 * given `options` to the koa `ctx`.
 * @param ctx context
 * @param path path of request
 * @param opts options
 */
async function send(ctx: Koa.Context, path: string, opts?: send.SendOptions): Promise<send.SendResult> {
    if (!ctx) throw new Error('Koa context required');
    if (!path) throw new Error('pathname required');
    if (!opts) opts = {};

    // options
    const root = opts.root ? normalize(resolve(opts.root)) : '';
    const trailingSlash = path[path.length - 1] === '/';
    path = path.substring(parse(path).root.length);
    const index = opts.index;
    const maxage = opts.maxage || opts.maxAge || 0;
    const immutable = opts.immutable || false;
    const hidden = opts.hidden || false;
    const format = opts.format !== false;
    const extensions = Array.isArray(opts.extensions) ? opts.extensions : false;
    const brotli = opts.brotli !== false;
    const gzip = opts.gzip !== false;
    const setHeaders = opts.setHeaders;

    if (setHeaders && typeof setHeaders !== 'function') {
        throw new TypeError('option setHeaders must be function');
    }

    if (path.startsWith('/')) {
        path = path.replace('/', '')
    }
    // normalize path
    const normalizedPath = decode(path);
    if (normalizedPath === -1) ctx.throw(400, 'failed to decode path');
    path = normalizedPath;

    // index file support
    if (index && trailingSlash) path += index;

    if (!opts.absolute) {
        path = resolvePath(root, path);
    } else {
        path = '/' + path;
    }

    // hidden file support, ignore
    if (!hidden && isHidden(root, path)) return { ok: false };

    let encodingExt = '';
    // serve brotli file when possible otherwise gzipped file when possible
    if (ctx.acceptsEncodings('br', 'identity') === 'br' && brotli && await exists(path + '.br')) {
        path = path + '.br';
        ctx.set('Content-Encoding', 'br');
        ctx.res.removeHeader('Content-Length');
        encodingExt = '.br';
    } else if (ctx.acceptsEncodings('gzip', 'identity') === 'gzip' && gzip && await exists(path + '.gz')) {
        path = path + '.gz';
        ctx.set('Content-Encoding', 'gzip');
        ctx.res.removeHeader('Content-Length');
        encodingExt = '.gz';
    }

    if (extensions && !/\./.exec(basename(path))) {
        const list = new Array<string>().concat(extensions);
        for (let i = 0; i < list.length; i++) {
            let ext = list[i];
            if (typeof ext !== 'string') {
                throw new TypeError('option extensions must be array of strings or false');
            }
            if (!/^\./.exec(ext)) ext = `.${ext}`;
            if (await exists(`${path}${ext}`)) {
                path = `${path}${ext}`;
                break;
            }
        }
    }

    // stat
    let stats: fs.Stats;
    try {
        stats = await fsa.stat(path);

        // Format the path to serve static file servers
        // and not require a trailing slash for directories,
        // so that you can do both `/directory` and `/directory/`
        if (stats.isDirectory()) {
            if (format && index) {
                path += `/${index}`;
                stats = await fsa.stat(path);
            } else {
                return { ok: false, isDirectory: true, path };
            }
        }
    } catch (err: any) {
        if (Util.isError(err)) {
            const notfound = ['ENOENT', 'ENAMETOOLONG', 'ENOTDIR'];
            if (err.code && notfound.includes(err.code)) {
                throw createError(404, err);
            }
            err.status = 500;
        }
        throw err;
    }

    if (setHeaders) setHeaders(ctx.res, path, stats);

    // stream
    ctx.set('Content-Length', stats.size.toString());
    ctx.set('Accept-Ranges', 'bytes');
    if (!ctx.response.get('Last-Modified')) ctx.set('Last-Modified', stats.mtime.toUTCString());
    if (!ctx.response.get('Cache-Control')) {
        const directives = [`max-age=${(maxage / 1000 | 0)}`];
        if (immutable) {
            directives.push('immutable');
        }
        ctx.set('Cache-Control', directives.join(','));
    }
    if (!ctx.type) ctx.type = type(path, encodingExt);
    if (ctx.headers.range) {
        try {
            const rangeHeader = ctx.headers.range;
            // const unit = (/^(bytes)=/.exec(rangeHeader) ?? Util.throw('cannot extract unit'))[1];
            const rangeValue = (/=(.*)$/.exec(rangeHeader) ?? Util.throw('cannot extract rangeValue'))[1];
            const range = /^[\w]*?(\d*)-(\d*)$/.exec(rangeValue) ?? Util.throw('cannot extract range');

            let start = range[1] ? parseInt(range[1]) : undefined;
            let end = range[2] ? parseInt(range[2]) : stats.size - 1;

            if (typeof start == 'undefined') {
                start = (stats.size - end);
                end = (stats.size - 1);
            }

            const chunksize = (end - start + 1)

            ctx.status = 206
            ctx.set('Content-Length', chunksize.toString());
            ctx.set('Content-Range', `bytes ${start}-${end}/${stats.size}`);
            ctx.body = fs.createReadStream(path, { start, end });
        } catch (err) {
            ctx.status = 416
            ctx.set('Content-Length', stats.size.toString());
            ctx.set('Content-Range', `bytes */${stats.size}`);
            ctx.body = fs.createReadStream(path);
        }
    } else {
        ctx.set('Content-Length', stats.size.toString());
        ctx.body = fs.createReadStream(path);
    }

    return { ok: true, path };
}

/**
 * Check if it's hidden.
 */
function isHidden(root: string, path: string) {
    const pathParts = path.substring(root.length).split(sep);
    for (let i = 0; i < path.length; i++) {
        const pathPart = pathParts[i];
        if (pathPart && pathPart[0] === '.') {
            return true;
        }
    }
    return false;
}

/**
 * File type.
 */
function type(file: string, ext: string) {
    return ext !== '' ? extname(basename(file, ext)) : extname(file);
}

/**
 * Decode `path`.
 */
function decode(path: string) {
    try {
        return decodeURIComponent(path);
    } catch (err) {
        return -1;
    }
}

export default send;