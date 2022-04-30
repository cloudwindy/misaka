import path from 'path';
import Koa from 'koa';
import send from './send';
import browse from './browse';
import Util from '@misaka/util';

declare namespace serve {
    interface ServeOptions extends send.SendOptions {
        /** If true, serves after return next(), allowing any downstream middleware to respond first. */
        defer?: boolean;
        /** Enable auto indexing. */
        browse?: boolean;
        /** Base url. */
        base?: string;
        /** Disable log output. */
        nolog?: boolean;
    }
}

/**
 * Serve static files from `root`.
 * @param options options
 * @returns Koa middleware
 */
function serve(options: serve.ServeOptions): Koa.Middleware {
    if (!options.root) {
        throw new Error('root directory is required to serve files');
    }
    options.root = path.resolve(options.root);
    if (options.defer) {
        return async (ctx, next) => {
            await next();
            if (ctx.method !== 'HEAD' && ctx.method !== 'GET') return;
            // response is already handled
            if (ctx.body != null || ctx.status !== 404) return;
            try {
                await send(ctx, ctx.path, options);
            } catch (err) {
                // slience if it's an 404 error
                if (!Util.isError(err) || err.status !== 404) {
                    // otherwise throw it
                    throw err;
                }
            }
        };
    }
    return async (ctx, next) => {
        if (ctx.method === 'HEAD' || ctx.method === 'GET') {
            try {
                const result = await send(ctx, ctx.path, options);
                if (result.ok) {
                    return;
                } else if (result.isDirectory && options.browse) {
                    return await browse(ctx, result.path!, options.base);
                }
            } catch (err) {
                if (!Util.isError(err) || err.status !== 404) {
                    throw err;
                }
            }
        }
        await next();
    };
}

export default serve;