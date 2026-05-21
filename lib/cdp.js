'use strict';

const http = require('http');

/* ═══════════════════════════════════════════════════════════════════════════
   CDP Client genérico + helper para conectar al WebView2 de LinkedIn
   Requiere Node.js >= 21.0.0 (WebSocket global) o instalar el paquete 'ws'.
   ═══════════════════════════════════════════════════════════════════════════ */

const WS = globalThis.WebSocket || (() => {
    try { return require('ws'); } catch { return null; }
})();
if (!WS) throw new Error('WebSocket no disponible. Usa Node >=21 o instala el paquete "ws".');

/**
 * Encuentra targets en localhost:port/json y devuelve el array.
 */
async function fetchCdpTargets(port = 9222) {
    return new Promise((resolve, reject) => {
        http.get(`http://localhost:${port}/json`, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => {
                try { resolve(JSON.parse(d)); }
                catch (e) { reject(new Error(`CDP JSON inválido: ${e.message}`)); }
            });
        }).on('error', err => reject(new Error(
            `No se pudo conectar a CDP en el puerto ${port}.\n` +
            `Ejecuta primero:  npm run cdp\nError: ${err.message}`
        )));
    });
}

/**
 * Obtiene el browser WebSocket URL desde /json/version
 */
async function fetchBrowserWsUrl(port = 9222) {
    return new Promise((resolve, reject) => {
        http.get(`http://localhost:${port}/json/version`, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => {
                try {
                    const obj = JSON.parse(d);
                    resolve(obj.webSocketDebuggerUrl);
                } catch (e) { reject(e); }
            });
        }).on('error', err => reject(err));
    });
}

/**
 * Lista targets via browser WebSocket usando Target.getTargets
 */
async function listTargetsViaBrowserWs(browserWsUrl) {
    return new Promise((resolve, reject) => {
        const ws = new WS(browserWsUrl);
        let done = false;
        const timer = setTimeout(() => { if (!done) { done = true; ws.close(); reject(new Error('Timeout listando targets')); } }, 5000);
        
        ws.addEventListener('open', () => {
            ws.send(JSON.stringify({ id: 1, method: 'Target.getTargets' }));
        });
        
        ws.addEventListener('message', (event) => {
            if (done) return;
            const msg = JSON.parse(event.data);
            if (msg.id === 1 && msg.result?.targetInfos) {
                clearTimeout(timer);
                done = true;
                ws.close();
                resolve(msg.result.targetInfos);
            }
        });
        
        ws.addEventListener('error', (e) => {
            if (!done) { clearTimeout(timer); done = true; reject(e); }
        });
    });
}

/**
 * Conecta a un target genérico via CDP.
 */
async function connectCdp(port = 9222, filter = null) {
    const targets = await fetchCdpTargets(port);
    const target = filter
        ? targets.find(filter)
        : targets.find(t => t.type === 'page');
    if (!target) throw new Error('No se encontró target compatible en CDP.');

    const client = new CdpClient(target.webSocketDebuggerUrl);
    await client.connect();
    return client;
}

/**
 * Conecta específicamente al target de LinkedIn.
 * Fallback: si /json no lista targets, usa browser WS + Target.getTargets
 */
async function connectToLinkedIn(port = 9222) {
    // Intento 1: /json tradicional
    let targets;
    try {
        targets = await fetchCdpTargets(port);
    } catch (e) {
        // Si /json falla, intentamos via browser WS
        targets = [];
    }
    
    let target = targets.find(t => t.type === 'page' && t.url.includes('linkedin.com'))
                ?? targets.find(t => t.type === 'page');
    
    // Intento 2: si /json no devolvió targets o no encontró LinkedIn,
    // usamos el browser WS para listar targets
    if (!target) {
        try {
            const browserWsUrl = await fetchBrowserWsUrl(port);
            const allTargets = await listTargetsViaBrowserWs(browserWsUrl);
            const liTarget = allTargets.find(t => t.type === 'page' && t.url.includes('linkedin.com'));
            if (liTarget) {
                // Construir WS URL del target
                const targetWsUrl = `ws://localhost:${port}/devtools/page/${liTarget.targetId}`;
                const client = new CdpClient(targetWsUrl);
                await client.connect();
                return client;
            }
        } catch (e) {
            console.warn('Fallback browser WS falló:', e.message);
        }
    }
    
    if (!target) throw new Error('No se encontró ningún target de LinkedIn en CDP.');

    const client = new CdpClient(target.webSocketDebuggerUrl);
    await client.connect();
    return client;
}

/* ── CdpClient ───────────────────────────────────────────────────────────── */

class CdpClient {
    constructor(wsUrl) {
        this.wsUrl   = wsUrl;
        this.ws      = null;
        this.pending = new Map();
        this.nextId  = 1;
        this._onClose = null;
    }

    connect() {
        return new Promise((resolve, reject) => {
            const ws = new WS(this.wsUrl);
            this.ws = ws;

            const cleanup = () => {
                ws.removeEventListener('open', onOpen);
                ws.removeEventListener('error', onError);
            };

            const onOpen = () => {
                cleanup();
                resolve();
            };

            const onError = (e) => {
                cleanup();
                reject(new Error(`WS: ${e.message ?? e}`));
            };

            ws.addEventListener('open', onOpen);
            ws.addEventListener('error', onError);
            ws.addEventListener('message', event => {
                try {
                    const msg = JSON.parse(event.data);
                    const cb  = this.pending.get(msg.id);
                    if (cb) { this.pending.delete(msg.id); cb(msg); }
                } catch (err) {
                    console.error('CDP mensaje inválido:', event.data.slice(0, 200));
                }
            });
            ws.addEventListener('close', () => {
                for (const [id, cb] of this.pending) {
                    cb({ error: { message: 'WebSocket cerrado inesperadamente' } });
                }
                this.pending.clear();
                if (this._onClose) this._onClose();
            });
        });
    }

    send(method, params = {}, timeoutMs = 30000) {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`CDP timeout: ${method} > ${timeoutMs}ms`));
            }, timeoutMs);

            this.pending.set(id, msg => {
                clearTimeout(timer);
                if (msg.error) reject(new Error(JSON.stringify(msg.error)));
                else resolve(msg.result);
            });

            if (!this.ws || this.ws.readyState !== 1) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(new Error('WebSocket no está abierto'));
                return;
            }

            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }

    async evaluate(expression, awaitPromise = false, timeoutMs = 30000) {
        const result = await this.send('Runtime.evaluate', {
            expression, awaitPromise, returnByValue: true,
        }, timeoutMs);
        if (result?.result?.subtype === 'error') {
            throw new Error(result.result.description);
        }
        return result?.result?.value;
    }

    onClose(fn) { this._onClose = fn; }

    close() {
        this.ws?.close();
        this.ws = null;
    }
}

module.exports = { CdpClient, connectCdp, connectToLinkedIn, fetchCdpTargets };
