import { promises as fs } from 'fs';
import { join as joinPath } from 'path';
import Koa from 'koa';
import { ExecutionContext } from '@misaka/router';

async function app(this: ExecutionContext, conf: any): Promise<Koa.Middleware | void> {
    const options = typeof conf === 'string' ? { name: conf } : conf;
    const dirname = this.dirname;
    const appname = options.name;
    delete options.name;
    this.resolveFsPath = (filename: string) => joinPath(dirname, 'app/', appname, filename);
    const use = this.use.bind(this);
    this.use = (path, middleware) => {
        use(path, async (ctx, next) => {
            ctx.handler = appname;
            await middleware(ctx, next);
        })
    }
    const packageJsonPath = this.resolveFsPath('package.json');
    const packageJson = JSON.parse((await fs.readFile(packageJsonPath)).toString());
    const modulePath = this.resolveFsPath(packageJson.main);
    const module: { default: (args: any) => Promise<undefined> } = await import(modulePath);
    // pass "this" to module to allow modifying this router
    await module.default.call(this, options);
}

export default app;