import { promises as fs } from 'fs';
import path from 'path';
import Koa from 'koa';
import createError from 'http-errors';
import Util from '@misaka/util';

interface File {
    name: string;
    isdir?: boolean;
}
function template(fileList: File[], index: string, base?: string) {
    let listing: string = '';
    if (index !== '/') {
        listing += `<pre><a href="${path.join(base || '', index, '..')}">../</a></pre>`;
    }
    for (const file of fileList) {
        listing += `<pre><a href="${path.join(base || '', index, file.name)}">${file.name}${file.isdir ? '/' : ''}</a></pre>`;
    }
    return Util.html`
    <html>
    
    <head>
        <title>Index of "${index}"</title>
    </head>
    
    <body>
        <h1>Index of "${index}"</h1>
        <hr>
        <pre><a href="${base || '/'}">/</a></pre>
        ${listing}
    </body>
    
    </html>`
}

/**
 * Browse the given directory.
 * @param ctx context
 * @param index directory to be listed
 */
async function browse(ctx: Koa.Context, index: string, base?: string) {
    const fileList: File[] = [];
    const filenameList = await fs.readdir(index);
    for (const filename of filenameList) {
        const file: File = { name: filename };
        try {
            const stat = await fs.stat(path.join(index, filename));
            if (stat.isDirectory()) {
                file.isdir = true;
            }
            fileList.push(file);
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
    }
    ctx.body = template(fileList, ctx.path, base);
};

export default browse;