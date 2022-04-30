const appName = 'Misaka Server'
const scriptName = 'misaka-server'
const timeStart = Date.now();

import fs, { promises as fsa } from 'fs';
import net from 'net';
import url from 'url';
import path from 'path';
import http from 'http';
import https from 'https';
import http2 from 'http2';
import utf8 from 'utf8';
import YAML from 'yaml';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import chalk from 'chalk';
import Redis from 'ioredis';
import geoip from 'geoip-lite';
import filesize from 'filesize';
import useragent from 'useragent';
import Koa from 'koa';
import etag from 'koa-etag';
import helmet from 'koa-helmet';
import session from 'koa-session';
import compress from 'koa-compress';
import ratelimit from 'koa-ratelimit';
import conditional from 'koa-conditional-get';
import UpgradableResponse from './lib/response';
import Statistics from './lib/stat';
import Util from '@misaka/util';
import Router from '@misaka/router';

// Define colors from chalk library
const succ = chalk.green;
const info = chalk.blue;
const warn = chalk.yellow.bold;
const crit = chalk.red.bold;
const metric = (n: number, warnThreshold: number, critThreshold: number) => {
	if (n >= critThreshold) return crit(n);
	if (n >= warnThreshold) return warn(n);
	return succ(n);
}
const statusCode = (n: number) => {
	if (n >= 500) return crit(n);
	if (n >= 400) return warn(n);
	if (n == 304) return succ(n);
	if (n >= 300) return info(n);
	if (n == 204) return chalk.gray(n);
	if (n >= 200) return succ(n);
	if (n >= 100) return chalk.gray(n);
	return chalk.gray(n);
}
const filename = url.fileURLToPath(import.meta.url).replace('src/', '');
const dirname = path.dirname(filename);
const version = await (async () => {
	const fpath = path.join(dirname, 'package.json');
	const ftext = await fsa.readFile(fpath);
	const json = JSON.parse(ftext.toString());
	return json.version;
})()

interface CLIOptions {
	conf?: string;
	dev?: boolean;
}

interface ServerConfig {
	server: {
		listen: string;
		port: number;
		user: string;
		group: string;
		https: {
			enabled: boolean;
			listen: string;
			port: number;
			cert: string;
			key: string;
		};
		h2: {
			enabled: boolean;
		}
		ws: {
			enabled: boolean;
		}
	};
	info: {
		name: string;
		admin: string;
		email: string;
	}
	http: {
		proxy: boolean;
		logger: boolean;
		error: boolean;
		forceHttps: boolean;
		ratelimit: {
			enabled: boolean;
			redis: boolean;
			id: string;
			max: number;
			duration: number;
			errorMessage: string;
			whitelist: string[];
		};
		events: {
			error: string;
			notFound: boolean;
		};
		headers: {
			security: boolean;
			hsts: {
				enabled: boolean;
				maxAge: number;
				subDomains: boolean;
				preload: boolean;
			};
			custom: Util.Headers;
		};
		compress: boolean;
	};
	router: Router.Router;
};

/**
 * Main server object.
 */
class MainServer {
	conf: ServerConfig;
	dev: boolean;
	app: Koa;
	stat: Statistics;
	loggers: {
		succ: typeof succ;
		info: typeof info;
		warn: typeof warn;
		crit: typeof crit;
		metric: typeof metric;
		statusCode: typeof statusCode;
	};
	createContext?: typeof Koa.prototype.createContext;

	/**
	 * Start the server up.
	 */
	async start() {
		const conf = this.conf;
		const app = this.app;
		console.log('    Configuration Checklist\n');
		if (conf.http.proxy) {
			app.proxy = true;
			console.log(` +  Proxy ${succ('trusted')}`);
		}
		// Enable logger
		if (conf.http.logger) {
			app.use(this.logger());
			console.log(` +  Logger ${succ('enabled')}`);
		}
		// Enable timer
		app.use(this.timer());
		// Enable statistics
		app.use(this.statistics());
		// Enable geolookup
		app.use(this.geolookup());
		// Enable uaparse
		app.use(this.uaparser());
		// Enable content length detecting
		app.use(this.contentLength());
		// Security headers
		if (!this.dev && conf.http.headers.security !== false) {
			app.use(helmet.frameguard());
			app.use(helmet.noSniff());
			app.use(helmet.ieNoOpen());
			app.use(helmet.xssFilter());
			app.use(helmet.permittedCrossDomainPolicies());
			console.log(` +  Security headers ${succ('loaded')}`);
		} else {
			console.log(` -  Security headers ${warn('disabled')} `);
		}
		// Enable HSTS
		if (!this.dev && conf.http.headers.hsts.enabled) {
			const maxAge = conf.http.headers.hsts.maxAge || 86400;
			app.use(helmet.hsts({
				maxAge,
				includeSubDomains: conf.http.headers.hsts.subDomains || false,
				preload: conf.http.headers.hsts.preload || false
			}));
			console.log(` +  HSTS ${succ('enabled')} for ${succ(maxAge / 86400)} days`);
		} else {
			console.log(` -  HSTS ${warn('disabled')}`);
		}
		// Custom headers
		if (conf.http.headers.custom) {
			app.use(this.customHeaders(conf.http.headers.custom));
			console.log(` +  Loaded ${succ(Object.keys(conf.http.headers.custom).length)} custom headers`);
		}
		// Rate limit
		if (!this.dev && conf.http.ratelimit.enabled) {
			const options: ratelimit.MiddlewareOptions = {
				id: ctx => conf.http.ratelimit.id ? eval(conf.http.ratelimit.id) : ctx.ip,
				max: conf.http.ratelimit.max,
				duration: conf.http.ratelimit.duration * 1000,
				errorMessage: conf.http.ratelimit.errorMessage || '',
				driver: 'memory',
				db: new Map()
			};
			if (conf.http.ratelimit.redis) {
				options.driver = 'redis';
				options.db = new Redis();
			}
			if (conf.http.ratelimit.whitelist) {
				const whitelist = conf.http.ratelimit.whitelist;
				options.whitelist = ctx => whitelist.includes(ctx.ip);
			}
			app.use(ratelimit(options));
			console.log(` +  Rate limiting ${succ('set')} at ${succ(options.max)} requests per ${succ(options.duration! / 1000)} seconds`);
		} else {
			console.log(` -  Rate limiting ${warn('not set')}`);
		}
		// Enable compress
		if (conf.http.compress !== false) {
			app.use(compress());
			console.log(` +  Compression ${succ('enabled')}`);
		} else {
			console.log(` -  Compression ${warn('disabled')}`);
		}
		// Error handler
		if (conf.http.error !== false) {
			app.use(this.error());
		}
		// Conditional GET
		app.use(conditional());
		// ETag header
		app.use(etag());
		// Force HTTPS
		if (!this.dev && conf.http.forceHttps !== false && conf.server.https.enabled) {
			// use if https enabled and force https not disabled
			app.use(this.forceHttps());
			console.log(` +  HTTP ${succ('redirecting')} to HTTPS`);
		} else if (conf.server.https.enabled) {
			// suggest if https enabled but force https disabled
			console.log(` -  HTTP ${warn('not redirecting')} to HTTPS`);
		}
		const CONFIG: Partial<session.opts> = {
			key: 'SESSIONID', /** (string) cookie key (default is koa.sess) */
			/** (number || 'session') maxAge in ms (default is 1 days) */
			/** 'session' will result in a cookie that expires when session/browser is closed */
			/** Warning: If a session cookie is stolen, this cookie will never expire */
			maxAge: 86400000,
			autoCommit: true, /** (boolean) automatically commit headers (default true) */
			overwrite: true, /** (boolean) can overwrite or not (default true) */
			httpOnly: true, /** (boolean) httpOnly or not (default true) */
			signed: false, /** (boolean) signed or not (default true) */
			rolling: false, /** (boolean) Force a session identifier cookie to be set on every response. The expiration is reset to the original maxAge, resetting the expiration countdown. (default is false) */
			renew: false, /** (boolean) renew session when session is nearly expired, so we can always keep user logged in. (default is false)*/
			secure: !this.dev && conf.server.https.enabled, /** (boolean) secure cookie*/
			sameSite: undefined, /** (string) session cookie sameSite options (default null, don't set it) */
		  };
		app.use(session(CONFIG, app));

		// Create router
		const router = new Router(dirname, this.loggers, this.dev);
		// Use router
		await router.use(conf.router);
		app.use(router.apply());

		// `app` should not be modified since here
		console.log(`\n    ${appName} Overview\n`);
		// Create HTTP server
		const addr = conf.server.listen || '0.0.0.0';
		const port = conf.server.port || 80;
		const httpServer = await this.createServer(addr, port);
		console.log(` +  HTTP server listening at ${succ(addr)}:${succ(port)}`);

		if (conf.server.ws.enabled == false) {
			console.log(` -  WebSocket support ${succ('disabled')}`);
		} else if (!conf.server.https.enabled) {
			this.createWebSocketServer(httpServer);
			console.log(` +  WebSocket support ${succ('enabled')}`);
		}
		if (!this.dev && conf.server.https.enabled) {
			const options = {
				allowHTTP1: true,
				cert: await fsa.readFile(conf.server.https.cert),
				key: await fsa.readFile(conf.server.https.key)
			};
			let httpsServer: https.Server | http2.Http2SecureServer;
			const httpsAddr = conf.server.https.listen || conf.server.listen || '0.0.0.0';
			const httpsPort = conf.server.https.port || 443;
			if (conf.server.h2.enabled !== false) {
				httpsServer = await this.createHttp2SecureServer(httpsAddr, httpsPort, options);
				console.log(` +  HTTPS server listening at ${succ(httpsAddr)}:${succ(httpsPort)}`);
				console.log(` +  HTTP2 support ${succ('enabled')}`);
			} else {
				httpsServer = await this.createSecureServer(httpsAddr, httpsPort, options);
				console.log(` +  HTTPS server listening at ${succ(httpsAddr)}:${succ(httpsPort)}`);
				console.log(` -  HTTP2 support ${warn('disabled')}`);
			}
			if (conf.server.ws.enabled !== false) {
				this.createWebSocketServer(httpsServer);
				console.log(` +  WebSocket support ${succ('enabled')}`);
			}
		} else {
			console.log(` -  HTTPS server ${warn('not running')}`);
		}
		console.log(`\n    Misaka Server started ${succ('successfully')}`);
		let user = conf.server.user || 'www-data';
		let group = conf.server.group || user || 'www-data';
		process.setgid(group);
		process.setuid(user);
		console.log(` +  User changed to ${succ(user)}:${succ(group)}`);
		const timeElapsed = Date.now() - timeStart;
		console.log(`    Elapsed time: ${metric(timeElapsed / 1000, 0.5, 1)}s \n`);
		return this;
	}

	/**
	 * Collect logs and output to console.
	 * @returns Koa middleware
	 */
	private logger(): Koa.Middleware {
		return async (ctx: Util.WebSocketContext, next) => {
			ctx.loggers = this.loggers;
			ctx.logs = [];
			const log = ctx.log = (name: string, ...messages: string[]) => {
				ctx.logs.push([name, messages.join('')]);
			};
			const path = utf8.decode(ctx.path);
			await next();
			// if log is disabled
			if (!ctx.log) {
				return;
			}
			const prelogs: [string, string][] = [];
			const prelog = (name: string, ...messages: any[]) => {
				prelogs.push([name, messages.join('')]);
			};
			let remote = ctx.ip;
			const geo: geoip.Lookup = ctx.geo;
			if (geo) {
				remote += ' ' + geo.country;
				if (geo.region) remote += '-' + geo.region;
				if (geo.city) remote += '/' + geo.city;
			}
			const agent: useragent.Agent = ctx.agent;
			if (agent) {
				remote += ' ' + agent.toString();
			}
			console.log(statusCode(ctx.status), ctx.method, path, '->', ctx.handler ? succ(ctx.handler) : warn('Unhandled'));
			prelog('Remote', remote);
			prelog('Host', ctx.host, !ctx.site ? warn(' unmatched') : '');
			if (ctx.querystring) prelog('Query', decodeURI(ctx.querystring));
			if (ctx.ws && !ctx.res.upgraded) prelog('WebSocket', warn('upgradable'));
			if (ctx.response.get('Location')) log(info('Location'), ctx.response.get('Location'));
			if (ctx.error) log('Error', crit(ctx.error.stack));
			for (const log of [...prelogs, ...ctx.logs]) {
				console.log(`    ${log[0]}: ${log[1]}`);
			}
			console.log();
		}
	}

	/**
	 * Provide response time or connect time for websocket.
	 * @returns Koa middleware
	 */
	private timer(): Koa.Middleware {
		return async (ctx, next) => {
			const start = Date.now();
			await next();
			const elapsed = Date.now() - start;
			ctx.elapsed = elapsed;
			if (ctx.log && ctx.ws) {
				ctx.log('Connect-Time', ctx.elapsed / 1000, 's');
			} else if (ctx.log) {
				ctx.log('Response-Time', metric(ctx.elapsed, 500, 2000), 'ms');
			}
		}
	}

	/**
	 * Runtime statistics information.
	 * @returns Koa middleware
	 */
	private statistics(): Koa.Middleware {
		return async (ctx, next) => {
			await next();
			ctx.stat = this.stat.record();
			if (ctx.log) {
				ctx.log('Runtime-Stat', `No.${ctx.stat.count} ${ctx.stat.last1min} / ${ctx.stat.last5min} / ${ctx.stat.last15min}`);
			}
		}
	}

	/**
	 * IP geolocation information.
	 * @returns Koa middleware
	 */
	private geolookup(): Koa.Middleware {
		return async (ctx, next) => {
			ctx.geo = geoip.lookup(ctx.ip);
			await next();
		}
	}

	/**
	 * User agent parser.
	 * @returns Koa middleware
	 */
	private uaparser(): Koa.Middleware {
		return async (ctx, next) => {
			ctx.agent = useragent.parse(ctx.get('User-Agent'));
			await next();
		}
	}

	/**
	 * Detect content length.
	 * @returns Koa middleware
	 */
	private contentLength(): Koa.Middleware {
		return async (ctx, next) => {
			await next();
			if (ctx.status === 304 || ctx.status === 204) return; // No content
			if (!ctx.bytes) {
				const bytesHeader = Number(ctx.get('Content-Length'));
				if (bytesHeader !== 0) {
					ctx.bytes = bytesHeader;
				} else if (typeof ctx.body === 'string' || ctx.body instanceof Buffer) {
					ctx.bytes = Buffer.byteLength(ctx.body);
				} else if (ctx.body === null || ctx.body === undefined) {
					ctx.bytes = 0;
				} else if (ctx.body.length) {
					ctx.bytes = ctx.body.length;
				} else if (ctx.body._writableState) {
					ctx.bytes = ctx.body._writableState.length;
				}
			}
			if (ctx.log) ctx.log('Content', 'type=',
				ctx.ws ?
					'websocket' :
					ctx.type,
				ctx.bytes ?
					' len=' + filesize(ctx.bytes, { spacer: '' }) :
					warn(' empty'));
		};
	}

	/**
	 * Error handling.
	 * @returns Koa middleware
	 */
	private error(): Koa.Middleware {
		const conf = this.conf;
		return async (ctx, next) => {
			try {
				await next();
			} catch (err) {
				if (!ctx.expose) {
					if (!ctx.status || ctx.status === 200) {
						ctx.status = 500;
					}
					ctx.id = Util.genRand({
						length: 12,
						charset: 'alphabetic'
					});
					ctx.set('X-Request-ID', ctx.id);
					if (ctx.log) ctx.log('Request-ID', crit(ctx.id));
					const status = ctx.status;
					ctx.body = Util.html`
					<html>
					
					<head>
						<meta cherset="utf-8">
						<title>500 Internal Server Error - ${conf.info.name || appName}</title>
					</head>
					
					<body>
						<div style="text-align: center;">
							<h1>500 Internal Server Error</h1>
							<p>Please contact the administrator with the following information to report the issue.</p>
							<p>Request ID: ${ctx.id}</p>
							<hr />
							<p>${appName}/${version}</p>
						</div>
					</body>
					
					</html>`;
					ctx.status = status;
					if (conf.http.events.error) {
						ctx.body = await fsa.readFile(conf.http.events.error);
					}
					ctx.type = 'html';
					ctx.error = err;
				} else {
					throw err;
				}
			}
			if (ctx.status === 404 || !ctx.error && !ctx.handler) {
				ctx.body = Util.html`
				<html>
				
				<head>
					<meta cherset="utf-8">
					<title>404 Not Found - ${conf.info.name || appName}</title>
				</head>
				
				<body>
					<div style='text-align: center;'>
						<h1>404 Not Found</h1>
						</p>
						<hr />
						<p>${appName}/${version}</p>
					</div>
				</body>
				
				</html>`;
				ctx.status = 404;
				if (conf.http.events.error) {
					ctx.body = await fsa.readFile(conf.http.events.error);
				}
				if (conf.http.events.notFound) {
					ctx.body = await fsa.readFile(conf.http.events.error);
				}
				ctx.type = 'html';
			}
		}
	}

	/**
	 * Apply custom headers to response.
	 * @param headers custom headers
	 * @returns Koa middleware
	 */
	private customHeaders(headers: Util.Headers): Koa.Middleware {
		return async (ctx, next) => {
			await next();
			ctx.set(headers);
		};
	}

	/**
	 * Force HTTPS.
	 * @returns Koa middleware
	 */
	private forceHttps(): Koa.Middleware {
		return async (ctx, next) => {
			// don't force https if already secure or accessing by ip
			if (!ctx.secure && !Util.isIP(ctx.hostname)) {
				if (ctx.log) {
					const { succ, info } = ctx.loggers;
					ctx.log(succ('Redirected'), `to=${info('https')} code=301`);
				}
				ctx.handler = 'HTTPSRedirecter';
				ctx.status = 301;
				return ctx.redirect('https://' + ctx.host + ctx.url);
			}
			await next();
		};
	}

	/**
	 * Create a HTTP Server.
	 * @param addr listen address
	 * @param port listen port
	 * @returns HTTP server
	 */
	private createServer(addr: string, port: number) {
		return new Promise<http.Server>(resolve => {
			const server: http.Server = this.app
				.listen(port, addr)
				.on('listening', () => resolve(server));
		});
	}

	/**
	 * Create a HTTPS server.
	 * @param addr listen address
	 * @param port listen port
	 * @param options HTTPS options
	 * @returns HTTPS server
	 */
	private createSecureServer(addr: string, port: number, options: https.ServerOptions) {
		return new Promise<https.Server>(resolve => {
			const server: https.Server = https
				.createServer(options, this.app.callback())
				.listen(port, addr)
				.on('listening', () => resolve(server));
		});
	}

	/**
	 * Create a HTTP2 server.
	 * @param addr listen address
	 * @param port listen port
	 * @param options HTTP2 options
	 * @returns HTTPS server
	 */
	private createHttp2SecureServer(addr: string, port: number, options: http2.SecureServerOptions) {
		return new Promise<http2.Http2SecureServer>(resolve => {
			const server: http2.Http2SecureServer = http2
				.createSecureServer(options, this.app.callback())
				.listen(port, addr)
				.on('listening', () => resolve(server));
		});
	}

	/**
	 * Create a WebSocket server.
	 * @param server HTTP server
	 */
	private createWebSocketServer(server: http.Server | https.Server | http2.Http2SecureServer) {
		server.on('upgrade', (req: http.IncomingMessage, sock: net.Socket, head: Buffer) => {
			server.emit('request', req, new UpgradableResponse(sock, head));
		});
		const createContext = this.app.createContext;
		this.app.createContext = (req: http.IncomingMessage, res: http.ServerResponse | UpgradableResponse) => {
			const ctx: Koa.Context = createContext.call(this.app, req, res);
			if (res instanceof UpgradableResponse) {
				ctx.ws = true;
				ctx.upgrade = () => res.upgrade(req);
			}
			return ctx;
		};
	}

	/**
	 * Create a Misaka Server.
	 * @param options user config
	 */
	constructor(options: CLIOptions) {
		// parse config
		const ctext = fs.readFileSync(options.conf || './config.yaml', 'utf-8');
		let conf = YAML.parse(ctext) || {};
		conf = {
			server: {},
			http: {},
			router: {},
			...conf
		};
		conf.server = {
			https: {},
			ws: {},
			...conf.server
		};
		conf.http = {
			logger: {},
			events: {},
			headers: {},
			...conf.http
		};
		this.conf = conf;
		this.dev = Boolean(options.dev);
		this.loggers = {
			succ, info, warn, crit, metric, statusCode
		};
		this.app = new Koa();
		this.stat = new Statistics();
	}
}

// unhandled exceptions
process
	.on('unhandledRejection', (err: Error) => {
		console.error(err.stack);
		console.error('Promise rejection not handled!');
		// process.exit(1);
	})
	.on('uncaughtException', err => {
		console.error(err.stack);
		console.error('Exception not handled!');
		// process.exit(1);
	});

yargs(hideBin(process.argv))
	.scriptName(scriptName)
	.usage('$0 <command> [args]')
	.command('start', 'start the server', {}, async (argv: any) => {
		try {
			// greetings
			console.log(`    ${appName} ${version}`);
			// start server
			const server = new MainServer(argv);
			await server.start();
		} catch (err) {
			process.stderr.write(`\n    ${appName} ${crit('failed')} to start\n\n !  `);
			console.error(err);
			process.exit(1);
		}
	})
	.option('conf', {
		alias: 'c',
		type: 'string',
		default: './config.yaml',
		description: 'path to config.yaml file'
	})
	.options('dev', {
		alias: 'd',
		type: 'boolean',
		default: false,
		description: 'enable developer mode'
	})
	.version(version)
	.help()
	.strict()
	.demandCommand(1)
	.recommendCommands()
	.parse();
