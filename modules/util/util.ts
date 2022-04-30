import http from 'http';
import Koa from 'koa';
import { WebSocket } from 'ws';
import randomstring from 'randomstring';

declare namespace Util {
	type Headers = { [name: string]: string };
	type WebSocketContext = Koa.ParameterizedContext<Koa.DefaultState, Koa.DefaultContext & {
		ws?: boolean;
		upgrade?: () => Promise<WebSocket>;
		res: http.ServerResponse & { upgraded?: boolean }
	}>;
	type UnsafeError = Error & {
		name: string;
		message: string;
		stack?: string;
		status?: number;
		errno?: number;
		code?: string;
		path?: string;
		syscall?: string;
	} & {
		[property: string]: unknown;
	}
}

class Util {
	/**
	 * Validate IP address.
	 * @param str string to check
	 * @returns true if the given string is an valid ip address
	 */
	static isIP(str: string) {
		return /^(?:(?:[0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])\.){3}(?:[0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])$/.test(str);
	}
	/**
	 * Check if an object is a string.
	 * @param obj object to check
	 * @returns true if the given object is a string
	 */
	static isString(obj: any): obj is string {
		return typeof obj === 'string';
	}
	/**
	 * Check if an object is an error.
	 * @param obj object to check
	 * @returns true if the given object is an error
	 */
	static isError(obj: any): obj is Util.UnsafeError {
		return obj instanceof Error;
	}
	/**
	 * Generate a random string.
	 * @param op generate option
	 * @returns random string
	 */
	static genRand(op?: randomstring.GenerateOptions) {
		return randomstring.generate(op);
	}
	static filter<T>(obj: { [k: string]: T | undefined }, predicate: (x: string) => boolean): { [k: string]: T } {
		const filter = (x: [string, T | undefined]): x is [string, T] => obj !== undefined && predicate(x[0]);
		return Object.fromEntries(Object.entries(obj).filter(filter));
	}
	static filterReverse<T>(obj: { [k: string]: T | undefined }, predicate: (x: string) => boolean): { [k: string]: T } {
		return Util.filter(obj, x => !predicate(x));
	}
	static strArray(str: string) {
		if (str.includes(',')) {
			return str.split(',');
		}
		return str;
	}
	/**
	 * Compose multiple middlewares into one.
	 * @param middlewares list of middlewares
	 * @returns Koa middleware
	 */
	static compose(middlewares: Koa.Middleware[]): Koa.Middleware {
		return async (ctx, next) => {
			let index = -1;
			const dispatch = async function (i: number) {
				if (i <= index) throw new Error('next() called multiple times');
				index = i;
				const route: Koa.Middleware | undefined = middlewares[i];
				if (route) {
					await route(ctx, dispatch.bind(null, i + 1));
				} else if (i === middlewares.length) {
					await next();
				}
			}
			await dispatch(0);
		}
	}
	static throw(msg?: string) {
		throw new Error(msg);
	}
	static html(strings: TemplateStringsArray, ...values: string[]) {
		return strings.reduce((result, currentString, i) => 
			`${result}${currentString}${values[i] || ''}`, '')
	}
}

export default Util;