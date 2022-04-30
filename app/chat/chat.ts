import { promises as fss } from 'fs';
import path from 'path';
import crypto from 'crypto';
import pug from 'pug';
import Koa from 'koa';
import bodyParser from 'koa-bodyparser';
import _static from '@misaka/static';
import { ExecutionContext } from '@misaka/router';

function pbkdf2(password: crypto.BinaryLike, salt: crypto.BinaryLike, iterations: number, keylen: number, digest: string) {
	return new Promise<Buffer>((resolve, reject) => {
		crypto.pbkdf2(password, salt, iterations, keylen, digest, (err, derivedKey) => {
			if (err) return reject(err);
			return resolve(derivedKey);
		});
	});
}
type Salt = {
	"$salt": string
}
type Users = {
	[name: string]: {
		uid: number;
		password: string;
	}
}
async function chat(this: ExecutionContext) {
	const base = this.base;
	const site = 'Example';
	const render = (page: string) => {
		if (this.devmode) {
			return (ctx: Koa.Context, custom?: { [key: string]: string }) => {
				const template = pug.compileFile(this.resolveFsPath(`views/${page}.pug`));
				return template({ base, site, session: ctx.session, ...custom || {} });
			}
		}
		const template = pug.compileFile(this.resolveFsPath(`views/${page}.pug`));
		return (ctx: Koa.Context, custom?: { [key: string]: string }) => template({ base, site, session: ctx.session, ...custom || {} });
	};
	const hash = (password: string, salt: string) => {
		return pbkdf2(password, Buffer.from(salt, 'hex'), 31000, 32, 'sha256');
	};
	const loadUsers = async () => {
		const json = await fss.readFile(this.resolveFsPath('users.json'));
		const users: Salt & Users = JSON.parse(json.toString());
		const salt = users['$salt'];
		return { salt, users };
	};
	const saveUsers = async (salt: string, users: Users) => {
		await fss.writeFile(this.resolveFsPath('users.json'), JSON.stringify({ "$salt": salt, ...users }));
	};
	const addUser = async (username: string, password: string) => {
		const { salt, users } = await loadUsers();
		if (users[username]) {
			return '此用户已存在';
		}
		const hashed = await hash(password, salt);
		users[username] = {
			uid: Object.values(users).length,
			password: hashed.toString('base64')
		}
		await saveUsers(salt, users);
		return true;
	};
	const verify = async (username: string, password: string) => {
		const { salt, users } = await loadUsers();
		const user = users[username];
		if (!salt || !user) return '密码或用户名错误';
		const hashed = await hash(password, salt);
		if (Buffer.byteLength(user.password, 'base64') !== Buffer.byteLength(hashed) || !crypto.timingSafeEqual(Buffer.from(user.password, 'base64'), hashed)) {
			return '密码或用户名错误';
		}
		return true;
	};
	const index = render('index');
	const redirect = render('redirect');
	const chat = render('chat');
	const denied = render('denied');
	const login = render('login');
	const logout = render('logout');
	const register = render('register');
	const info = render('info');
	this.get('/', async (ctx, next) => {
		ctx.handler = 'Chat-Page-Index';
		ctx.body = index(ctx);
		await next();
	});
	this.get('/chat', async (ctx, next) => {
		const session = ctx.session;
		if (!session || !session.username) {
			ctx.handler = 'Chat-Page-Main-Denied';
			ctx.body = denied(ctx);
			return await next();
		}
		ctx.handler = 'Chat-Page-Main';
		ctx.body = chat(ctx);
		await next();
	});
	this.get('/login', async (ctx, next) => {
		ctx.handler = 'Chat-Page-Login';
		ctx.body = login(ctx);
		await next();
	});
	this.post('/login', bodyParser());
	this.post('/login', async (ctx, next) => {
		const session = ctx.session;
		const params = ctx.request.body;
		ctx.handler = 'Chat-Auth-Login';
		if (ctx.log) {
			const { succ, info } = ctx.loggers;
			ctx.log(succ('Login'), 'user=' + info(params.username));
		}
		if (!params) {
			ctx.status = 400;
			return;
		}
		const message = await verify(params.username, params.password);
		if (message !== true) {
			ctx.body = login(ctx, { message });
			return await next();
		}
		if (session) {
			session.username = params.username;
			ctx.body = redirect(ctx, { location: ctx.params.back || '/' });
		} else {
			ctx.body = login(ctx, { message: '会话失效' });
		}
		await next();
	});
	this.get('/logout', async (ctx, next) => {
		ctx.handler = 'Chat-Page-Logout';
		ctx.body = logout(ctx);
		await next();
	});
	this.post('/logout', async (ctx, next) => {
		ctx.handler = 'Chat-Auth-Logout';
		const session = ctx.session;
		if (!session || !session.username) {
			ctx.body = logout(ctx, { message: '请先登录' });
			return await next();
		}
		if (ctx.log) {
			const { succ, info } = ctx.loggers;
			ctx.log(succ('Logout'), 'user=' + info(session.username));
		}
		session.username = null;
		ctx.body = redirect(ctx, { location: ctx.params.back || '/' });
	});
	this.get('/register', async (ctx, next) => {
		ctx.handler = 'Chat-Page-Register';
		const session = ctx.session;
		if (!session || !session.username) {
			ctx.body = denied(ctx);
			return await next();
		}
		ctx.body = register(ctx);
		await next();
	});
	this.post('/register', bodyParser());
	this.post('/register', async (ctx, next) => {
		ctx.handler = 'Chat-Auth-Register';
		const session = ctx.session;
		const params = ctx.request.body;
		if (!session || !session.username) {
			ctx.body = denied(ctx);
			return await next();
		}
		if (!params) {
			ctx.status = 400;
			return;
		}
		if (ctx.log) {
			const { succ, info } = ctx.loggers;
			ctx.log(succ('Register'), 'by=' + info(session.username) + ' user=' + info(params.username));
		}
		await addUser(params.username, params.password);
		ctx.body = redirect(ctx, { location: ctx.params.back || '/' });
		await next();
	});
	this.get('/info', async (ctx, next) => {
		ctx.handler = 'Chat-Page-Info';
		const session = ctx.session;
		if (!session || !session.username) {
			ctx.body = denied(ctx);
			return await next();
		}
		ctx.body = info(ctx);
		await next();
	})
	this.use('/assets/(.*)', _static({
		root: this.resolveFsPath('assets'),
		base: path.join(this.base, 'assets/'),
		nolog: true
	}));
}

export default chat;
