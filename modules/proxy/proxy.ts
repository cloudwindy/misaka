import { URL } from 'url';
import http from 'http';
import https from 'https';
import { Buffer } from 'buffer';
import Koa from 'koa';
import ws, { WebSocket } from 'ws';
import Util from '@misaka/util';


interface ProxyOptions {
	upstream: string;
	nolog?: boolean;
	timeout?: number;
	websocket?: boolean;
	reqHeadersFilter?: string[];
	resHeadersFilter?: string[];
}

/**
 * Proxy middleware.
 * @param pconf Proxy config
 * @returns proxy middleware
 */
function proxy(pconf: string | ProxyOptions): Koa.Middleware {
	const conf: ProxyOptions = typeof pconf === 'string' ? { upstream: pconf } : pconf;
	const base = new URL(conf.upstream);
	const reqHeadersFilter = conf.reqHeadersFilter || ['host'];
	const resHeadersFilter = conf.resHeadersFilter || ['connection', 'transfer-encoding'];
	return async (ctx: Util.WebSocketContext, next) => {
		// build a new url to not change ctx
		const url = new URL(ctx.href);
		// in case of rewritten
		url.pathname = ctx.path;
		url.host = base.host;
		url.protocol = base.protocol;
		if (conf.nolog) {
			ctx.log = false;
		}
		if (ctx.ws && ctx.upgrade instanceof Function && conf.websocket) {
			ctx.handler = 'ProxyWS';
			url.protocol = { 'http:': 'ws:', 'https:': 'wss:' }[url.protocol] || 'ws';
			try {
				// connect usr and backend
				const stat = await wsforward(url, ctx.upgrade);
				// only for logging
				ctx.status = 101;
				ctx.bytes = stat.bytes;
				if (ctx.log) {
					const { succ, info } = ctx.loggers;
					ctx.log(succ('ProxiedWS'), 'to=' + info(url.href));
				}
				// don't next as handling websocket is not expected
				return;
			} catch (err) {
				// websocket not available, continue
				ctx.body = '';
				ctx.status = 200;
				// setting ctx.errror doesn't trigger error handling
				ctx.error = err;
				if (ctx.log) {
					const { info, crit } = ctx.loggers;
					ctx.log(crit('ProxyWS-Failed'), 'to=' + info(url.href));
				}
				// next to who can handle
				await next();
			}
		} else {
			ctx.handler = 'Proxy';
			const reqHeadersFiltered = Util.filter(ctx.headers, s => !s.startsWith(':') && !reqHeadersFilter.includes(s));
			// send HTTP request
			const res = await request(url, ctx.req, {
				headers: reqHeadersFiltered,
				method: ctx.method,
				timeout: conf.timeout || 3000
			});
			ctx.body = res.body;
			ctx.status = res.statusCode || 503;
			const resHeadersFiltered = Util.filter(res.headers, s => !s.startsWith(':') && !resHeadersFilter.includes(s));
			ctx.set(resHeadersFiltered);
			if (ctx.log) {
				const { succ, info } = ctx.loggers;
				ctx.log(succ('Proxied'), 'to=' + info(url.href));
			}
			await next();
		}
	}
}

type Response = http.IncomingMessage & { body: Buffer };
/**
 * Make a HTTP(S) request
 * @param url URL
 * @param usr Request from user
 * @param options Request options
 * @returns Response
 */
function request(url: URL, usr: http.IncomingMessage, options?: https.RequestOptions): Promise<Response> {
	return new Promise((resolve, reject) => {
		let req: http.ClientRequest;
		options || (options = {});
		options.headers = options.headers ? {
			host: url.hostname,
			...options.headers
		} : { host: url.hostname };
		if (url.protocol === 'http:') {
			req = http.request(url, options);
		} else if (url.protocol === 'https:') {
			req = https.request(url, options);
		} else {
			throw new Error(`Invalid protocol ${url.protocol}`);
		}
		req.on('error', err => reject(err));
		req.on('timeout', () => req.destroy());
		req.on('response', (res: Response) => {
			res.on('error', err => reject(err));
			const chunks: Buffer[] = [];
			res.on('data', data => chunks.push(data));
			res.on('end', () => {
				res.body = Buffer.concat(chunks);
				resolve(res);
			});
		});
		usr.on('abort', () => req.destroy());
		usr.pipe(req);
	});
}

interface WSForwardResult {
	bytes: number;
};
function wsforward(url: URL, upgrade: () => Promise<WebSocket>, options?: ws.ClientOptions): Promise<WSForwardResult> {
	return new Promise((resolve, reject) => {
		const req = new WebSocket(url, options);
		let stat: WSForwardResult = { bytes: 0 };
		const rejectOnError = (err: Error) => reject(err);
		// reject before upgrade
		req.on('error', rejectOnError);
		req.on('open', () => {
			// upgrade user websocket when connected to backend
			upgrade()
				.then(usr => {
					req.removeListener('error', rejectOnError);
					req.on('error', err => {
						reject(err);
						usr.close();
					});
					usr.on('error', err => {
						reject(err);
						req.close();
					});
					req.on('close', () => {
						resolve(stat);
						usr.close();
					});
					usr.on('close', () => {
						resolve(stat);
						req.close();
					});
					req.on('message', data => {
						usr.send(data);
						// @ts-ignore disable type check to increase performance
						stat.bytes += data.byteLength || 0;
					});
					usr.on('message', data => {
						req.send(data);
						// @ts-ignore
						stat.bytes += data.byteLength || 0;
					});
				})
				.catch(err => {
					reject(err);
					req.close();
				});
		});
	});
}

export default proxy;