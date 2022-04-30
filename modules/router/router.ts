import url from 'url';
import { normalize as pathNormalize, join as joinPath } from 'path';
import Koa from 'koa';
import KoaRouter from '@koa/router';
import { send } from '@misaka/static';
import MisakaUtil from '@misaka/util';

/** Type representing a site. */
type SiteLike = string | string[] | RegExp;
/** Type representing methods. */
type Methods = string | string[] | undefined;

/**
 * User config.
 */
declare namespace Router {
	/**
	 * Router config. Config object passed to Mizuki Router.
	 */
	interface Router {
		verbose?: boolean;
		routes?: {
			[site: string]: Site;
		};
	}
	type Site = {
		[path: string]: Path;
	}
	type Path = {
		redirect?: string;
		code?: number;
		rewrite?: [string, string][];
	} & {
		[handler: string]: string | null;
	};
}

type Logger = (...msg: any[]) => string;
type LoggerName = 'info' | 'succ' | 'warn' | 'crit';
type Loggers = {
	[name in LoggerName]: Logger;
};

/**
 * User config parser.
 */
class Router {
	siteRouter: SiteRouter;
	dirname: string;
	loggers: Loggers;
	counter: number;
	devmode: boolean;
	msg: string[];

	/**
	 * Initialize a Config Parser.
	 * @param dirname path to project home directory
	 * @param loggers loggers
	 */
	constructor(dirname: string, loggers: Loggers, devmode: boolean) {
		this.siteRouter = new SiteRouter(dirname, devmode);
		this.dirname = dirname;
		this.loggers = loggers;
		this.devmode = devmode;
		this.counter = 0;
		this.msg = [];
	}

	/**
	 * Add a count.
	 */
	count() {
		this.counter++;
	}

	/**
	 * Add new log message.
	 * @param msg message
	 */
	log(...msg: string[]) {
		this.msg.push(msg.join(''));
	}

	/**
	 * Use router.
	 * - verbose: show verbose routes
	 * - routes: routes
	 * @param rconf router config
	 */
	async use(rconf: Router.Router): Promise<void> {
		rconf || (rconf = {});
		const { succ } = this.loggers;
		console.log('\n    Mizuki Router Overview\n');
		rconf.routes || (rconf.routes = {});
		for (const [originalSite, sconf] of Object.entries(rconf.routes)) {
			const site = Util.strArray(originalSite);
			if (!sconf) continue;
			await this.parseSiteConfig(site, sconf);
		}
		console.log(` +  Loaded ${succ(this.counter.toString())} routes`);
		if (rconf.verbose) {
			this.printMsg();
		}
	}

	/**
	 * Add new site config.
	 * - host: Host name of the site.
	 * - redirects: Custom redirects.
	 * @param site site name
	 * @param sconf site config
	 */
	async parseSiteConfig(site: SiteLike, sconf: Router.Site) {
		const { info, warn, succ } = this.loggers;
		if (typeof site === 'string' && site.startsWith('/')) {
			const parts = /^\/(.*)\/(.*)$/.exec(site);
			if (!parts || parts.length === 0 || !parts[1]) throw new Error('Invalid regular expression path.');
			site = new RegExp(parts[1], parts[2]);
		}
		const routes = Util.filter(sconf, (s: string) => /^\/|\^\//.test(s));
		const router = this.siteRouter.get(site);
		for (let [path, rconf] of Object.entries(routes)) {
			if (path.startsWith('^')) {
				path = path.substring(1) + '(.*)';
			}
			if (rconf.rewrite) {
				for (const [src, dest] of rconf.rewrite) {
					router.addRewrite(path, src, dest);
					this.log(`    ${site || '(UNKNOWN)'}: (REWRITE) ${info(src)} -> ${succ(dest)}`);
					this.count();
					delete rconf.rewrite;
				}
			}
			if (rconf.redirect) {
				router.addRedirect(path, rconf.redirect, rconf.code);
				this.log(`    ${site || '(UNKNOWN)'}: (REDIRECT) ${info(path)} -> ${succ(rconf.redirect)}`);
				this.count();
				continue;
			}
			if (typeof rconf === 'string') rconf = { [rconf]: null };
			if (!rconf) {
				this.log(`    ${site || '(UNKNOWN)'}: ${info(path)} -> ${warn('UNHANDLED')}`);
				this.count();
				break;
			}
			this.log(`    ${site || '(UNKNOWN)'}: ${info(path)} -> ${succ(Object.keys(rconf))}`);
			this.count();
			await router.addRoute(path, rconf);
		}
	}

	printMsg() {
		for (const msg of this.msg) {
			console.log(msg);
		}
	}

	apply(): Koa.Middleware {
		return this.siteRouter.apply();
	}
}

/**
 * SiteRouter provides routing for different hostnames ("sites").
 */
class SiteRouter {
	sites: Map<SiteLike, PathRouter>;
	dirname: string;
	devmode: boolean;

	constructor(dirname: string, devmode: boolean) {
		this.dirname = dirname;
		this.sites = new Map();
		this.devmode = devmode;
	}

	/**
	 * Get one or new registered one.
	 * @param site hostname
	 */
	get(site: SiteLike) {
		let pathRouter = this.sites.get(site);
		if (!pathRouter) {
			pathRouter = new PathRouter(site, this.dirname, this.devmode);
			this.use(site, pathRouter);
		}
		return pathRouter;
	}

	/**
	 * Add site.
	 * @param site hostname
	 * @param pathRouter middleware
	 */
	use(site: SiteLike, pathRouter: PathRouter) {
		this.sites.set(site, pathRouter);
	}

	/**
	 * Delete site.
	 * @param site site
	 */
	delete(site: SiteLike) {
		this.sites.delete(site);
	}

	/**
	 * Match hostname with pattern.
	 * @returns true if matches
	 */
	private static match(pattern: SiteLike, hostname: string) {
		if (pattern === '*') {
			return true;
		}
		if (pattern instanceof Array) {
			return pattern.includes(hostname);
		}
		if (pattern instanceof RegExp) {
			return pattern.test(hostname);
		}
		return pattern === hostname;
	}

	/**
	 * Process request
	 * @param ctx context
	 * @param next next
	 */
	async process(ctx: Koa.Context, next: Koa.Next) {
		for (const [site, pathRouter] of this.sites) {
			const hostname = url.domainToUnicode(ctx.hostname);
			if (SiteRouter.match(site, hostname)) {
				ctx.site = site;
				return await pathRouter.process(ctx, next);
			}
		}
		await next();
	}

	/**
	 * Get middleware.
	 * @returns middleware
	 */
	apply(): Koa.Middleware {
		return this.process.bind(this);
	}
}

class PathRouter {
	site: SiteLike;
	dirname: string;
	router: KoaRouter;
	devmode: boolean;
	stacks: Map<string, Koa.Middleware[]>;

	/**
	 * Initialize an path router.
	 * @param site site name
	 * @param dirname project home directory
	 */
	constructor(site: SiteLike, dirname: string, devmode: boolean) {
		this.site = site;
		this.dirname = dirname;
		this.devmode = devmode;
		this.router = new KoaRouter();
		this.stacks = new Map();
	}

	use(path: string, middleware: Koa.Middleware) {
		this.router.all(path, middleware);
	}

	useWild(middleware: Koa.Middleware) {
		this.router.use(middleware);
	}

	get(path: string, middleware: Koa.Middleware) {
		this.router.get(path, middleware);
	}

	post(path: string, middleware: Koa.Middleware) {
		this.router.post(path, middleware);
	}

	getStack(path: string) {
		let stack = this.stacks.get(path);
		if (!stack) {
			stack = [];
			this.use(path, Util.compose(stack));
			this.stacks.set(path, stack);
		}
		return stack;
	};

	/**
	 * Add new route.
	 * @param path path to match
	 * @param rconf route config
	 */
	async addRoute(path: string, rconf: Router.Path) {
		for (const [name, args] of Object.entries(rconf)) {
			await this.addModule(path, name, args);
		}
	}

	async addModule(path: string, name: string, args: any) {
		const stack: Koa.Middleware[] = this.getStack(path);
		const module = await Util.getModule(new ExecutionContext(this, path, name, this.devmode), name, args);
		if (!module) return;
		stack.push(module);
	}

	/**
	 * Add new rewrite.
	 * @param path path to match this middleware
	 * @param src source
	 * @param dest destination
	 */
	addRewrite(path: string, src: string, dest: string) {
		this.use(path, async (ctx, next) => {
			ctx.path = pathNormalize(ctx.path.replace(src, dest));
			if (ctx.log) {
				const { succ, info } = ctx.loggers;
				ctx.log(succ('Rewritten'), `to=${info(ctx.path)}`);
			}
			await next();
		});
	}

	/**
	 * Add new redirect.
	 * @param src redirect source
	 * @param dest redirect destination
	 * @param code redirect status code (e.g. 301)
	 */
	addRedirect(src: string, dest: string, code?: number) {
		this.use(src, async ctx => {
			if (ctx.log) {
				const { succ, info } = ctx.loggers;
				ctx.log(succ('Redirected'), `to=${info(dest)} code=${code}`);
			}
			ctx.handler = 'MizukiRedirecter';
			ctx.redirect(dest);
			ctx.status = code || 301;
		});
	}

	/**
	 * Process request.
	 * @param ctx context
	 * @param next next
	 */
	async process(ctx: Koa.Context, next: Koa.Next) {
		// @ts-ignore
		await this.router.routes()(ctx, next);
	}

	/**
	 * Get middleware.
	 * @returns middleware
	 */
	apply(): Koa.Middleware {
		return this.process.bind(this);
	}
}

class ExecutionContext {
	site: SiteLike;
	appname: string;
	modname: string;
	dirname: string;
	devmode: boolean;
	base: string;
	router: PathRouter;

	constructor(router: PathRouter, base: string, modname: string, devmode: boolean) {
		this.site = router.site;
		this.dirname = router.dirname;
		this.router = router;
		this.base = base.endsWith('/') ? base : base + '/';
		this.appname = '';
		this.modname = modname;
		this.devmode = devmode;
	}

	/**
	 * Can be rewritten to change base path.
	 * @param path path to resolve
	 * @returns resolved path
	 */
	resolveReqPath(path: string) {
		if (!/^\/|(?:\/[0-9a-zA-Z]*)*$/.test(path)) {
			throw new Error('This module does not accept regular expression path.');
		}
		return joinPath(this.base, path);
	}

	resolveFsPath(path: string) {
		return joinPath(this.dirname, path);
	}

	mount(middleware: Koa.Middleware): Koa.Middleware {
		return async (ctx, next) => {
			const original = ctx.path;
			ctx.path = ctx.path.replace(this.base, '/');
			await middleware(ctx, async () => {
				ctx.path = original;
				await next();
			})
		}
	}

	use(path: string, middleware: Koa.Middleware) {
		this.router.use(this.resolveReqPath(path), this.mount(middleware));
	}

	get(path: string, middleware: Koa.Middleware) {
		this.router.get(path, this.mount(middleware));
	}

	post(path: string, middleware: Koa.Middleware) {
		this.router.post(path, this.mount(middleware));
	}

	async addModule(path: string, name: string, args: any) {
		await this.router.addModule(this.resolveReqPath(path), name, args);
	}

	addRewrite(path: string, src: string, dest: string) {
		this.router.addRewrite(this.resolveReqPath(path), src, dest);
	}

	addRedirect(src: string, dest: string, code?: number) {
		this.router.addRedirect(this.resolveReqPath(src), dest, code);
	}

	send(ctx: Koa.Context, path: string, options?: send.SendOptions) {
		options || (options = {});
		options.absolute = true;
		return send(ctx, this.resolveFsPath(path), options);
	}
}

class Util extends MisakaUtil {
	static methods = [
		'HEAD',
		'OPTIONS',
		'GET',
		'PUT',
		'PATCH',
		'POST',
		'DELETE'
	];
	/**
	 * Get a list of allowed methods from config.
	 * @param methods user provided methods
	 */
	static getMethods(methods: Methods) {
		if (methods === 'ALL') return Util.methods;
		if (typeof methods === 'string') return [methods];
		if (methods instanceof Array) return methods;
		return Util.methods;
	}
	static async getModule(thisObj: any, name: string, args: any) {
		const moduleWrapper: { default: (args: any) => Promise<Koa.Middleware> } = await import("@misaka/" + name);
		// pass "this" to module to allow modifying this router
		const moduleMiddleware = await moduleWrapper.default.call(thisObj, args);
		if (!moduleMiddleware) return;
		return moduleMiddleware;
	}
}

export { Router, SiteRouter, PathRouter, ExecutionContext };
export default Router;
