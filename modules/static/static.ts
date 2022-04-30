import { join as joinPath } from 'path';
import Koa from 'koa';
import serve from './lib/serve';

/**
 * Static file serving module.
 * @param serveOptions options
 * @returns Koa middleware
 */
function staticModule(serveOptions: serve.ServeOptions | string): Koa.Middleware {
    const options = typeof serveOptions === 'string' ? { root: serveOptions } : serveOptions;
    const serveHandler = serve(options);
    return async (ctx, next) => {
        ctx.handler = 'Static';
        const path = ctx.path;
        if (options.base) {
            ctx.path = path.replace(options.base, '/');
        }
        if (options.nolog) {
            ctx.log = false;
        }
        if (ctx.log) {
            const { succ, info } = ctx.loggers;
            ctx.log(succ('Served'), info(joinPath(options.root!, ctx.path)));
        }
        await serveHandler(ctx, async () => {
            ctx.path = path;
            await next();
        });
    }
}

export { default as send } from './lib/send';
export { serve };
export default staticModule;