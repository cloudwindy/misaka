import Koa from 'koa';
export default function echo(options: Buffer | string) {
    let body: Buffer | string;
    if (typeof options === 'string' || options instanceof Buffer) body = options;
    return async function echoMiddleware(ctx: Koa.Context) {
        ctx.body = body;
        if (ctx.log) {
            const { succ, info } = ctx.loggers;
            ctx.handler = 'Echo';
            ctx.log(succ('Echo'), info('done'));
        }
    }
}