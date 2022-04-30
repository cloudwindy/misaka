import { Writable as WritableStream } from 'stream';
import { IncomingMessage, OutgoingHttpHeader, OutgoingHttpHeaders } from 'http';
import { Socket } from 'net';
import statusCodes from 'http-status-codes';
import { WebSocket, WebSocketServer } from 'ws';

class UpgradableResponse extends WritableStream {
    upgraded: boolean;
    socket: Socket;
    connection: Socket;
    head: Buffer;
    finished: boolean;
    headersSent: boolean;
    headers: OutgoingHttpHeaders;
    statusCode: number;
    statusMessage: string;
    sendDate: boolean;
    websocket?: WebSocket;
    chunkedEncoding: boolean;
    shouldKeepAlive: boolean;
    useChunkedEncodingByDefault: boolean;

    constructor(socket: Socket, head: Buffer) {
        super();
        this.chunkedEncoding = false;
        this.shouldKeepAlive = true;
        this.useChunkedEncodingByDefault = false;
        this.upgraded = false;
        this.socket = socket;
        this.connection = socket;
        this.head = head;
        this.finished = false;
        this.headersSent = false;
        this.headers = {};
        this.statusCode = 200;
        this.statusMessage = '';
        this.sendDate = true;

        this.on('finish', () => {
            this._write(null);
            this.finished = true;
        });
    }

    override _write(chunk: any, encoding?: BufferEncoding, callback?: (error?: Error | null) => void) {
        if (!this.headersSent) this.writeHead(this.statusCode, this.statusMessage, this.headers);
        if (this.upgraded) {
            if (this.websocket && !chunk && this.websocket.readyState === 1) {
                this.websocket.close(this.statusCode == 500 ? 1011 : 1000);
            }
            if (callback) {
                callback();
            }
        } else {
            if (!chunk) {
                this.socket.end(callback);
            } else {
                this.socket.write(chunk, encoding, callback);
            }
        }
        return this;
    }

    flushHeaders() { }

    getHeader(name: string) {
        return this.headers[name];
    }

    getHeaders() {
        return this.headers;
    }

    hasHeader(name: string) {
        return this.headers[name] !== undefined;
    }

    getHeaderNames() {
        return Object.keys(this.headers);
    }

    removeHeader(name: string) {
        if (this.headersSent) throw new Error('Headers have already been sent');
        delete this.headers[name];
        return this;
    }

    setHeader(name: string, value: string) {
        if (this.headersSent) throw new Error('Headers have already been sent');
        this.headers[name] = value;
        return this;
    }

    writeHead(code: number, message: OutgoingHttpHeaders | OutgoingHttpHeader[] | string | undefined, headers?: OutgoingHttpHeaders | OutgoingHttpHeader[] | undefined): this {
        if (this.headersSent) throw new Error('Headers have already been sent');
        if (!headers && !message) throw new Error('One of headers or message must be provided');
        if (typeof message !== 'string') {
            headers = message;
            message = '';
        }
        if (headers instanceof Array) {
            throw new Error('Headers must not be an array');
        }
        if (!this.upgraded) {
            this.socket.write('HTTP/1.1 ' + code + ' ' + (message || statusCodes.getStatusText(code)) + '\r\n');
            for (var header in headers) {
                this.socket.write(header + ': ' + headers[header] + '\r\n');
            }
            this.socket.write('\r\n');
        }
        this.headersSent = true;
        return this;
    }

    /**
     * Upgrade the connection to websocket.
     * @param req Request
     * @returns WebSocket
     */
    upgrade(req: IncomingMessage) {
        if (this.headersSent) throw new Error('Headers have already been sent');
        this.upgraded = true;
        return new Promise<WebSocket>((resolve, reject) => {
            const onSocketFinish = () => reject(new Error('Upgrade failed'));
            this.socket.on('finish', onSocketFinish);
            new WebSocketServer({ noServer: true }).handleUpgrade(req, this.socket, this.head, client => {
                this.socket.removeListener('finish', onSocketFinish);
                this.websocket = client;
                resolve(client);
            });
        });
    }
}

export default UpgradableResponse;