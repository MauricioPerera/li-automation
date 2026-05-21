#!/usr/bin/env node
'use strict';

/**
 * api-server.js — Servidor REST HTTP para automatizar LinkedIn via CDP.
 *
 * Pensado para integración con n8n, Make, Zapier o cualquier otro
 * orquestador que pueda consumir una API REST local.
 *
 * Requiere que Edge con LinkedIn esté corriendo con CDP:
 *   npm run cdp
 *
 * Variables de entorno:
 *   PORT          — puerto del servidor HTTP (default: 3000)
 *   LI_CDP_PORT   — puerto CDP de Edge (default: 9222)
 */

const http = require('http');
const url  = require('url');
const { connectToLinkedIn } = require('./lib/cdp');
const {
    getProfile, getProfileFull, getProfilePosts, getNewsletterArticles,
    getConversations, getMessages, sendMessage,
    searchJobs, getJobDetails,
    createPost, likePost
} = require('./lib/li');
const store = require('./lib/store');

const PORT     = Number(process.env.PORT)        || 3000;
const CDP_PORT = Number(process.env.LI_CDP_PORT) || 9222;

/* ── Conexión persistente a CDP ─────────────────────────────────────────── */

let _cdp = null;
let _connecting = false;

async function ensureCdp() {
    if (_cdp && _cdp.ws && _cdp.ws.readyState === 1) return _cdp;
    if (_connecting) {
        while (_connecting) await new Promise(r => setTimeout(r, 200));
        if (_cdp && _cdp.ws && _cdp.ws.readyState === 1) return _cdp;
    }
    _connecting = true;
    try {
        console.log(`[CDP] Conectando a LinkedIn en puerto ${CDP_PORT}...`);
        _cdp = await connectToLinkedIn(CDP_PORT);
        console.log('[CDP] Conectado.');
        _cdp.onClose(() => {
            console.warn('[CDP] Conexión cerrada. Se reconectará en la siguiente petición.');
            _cdp = null;
        });
        return _cdp;
    } finally {
        _connecting = false;
    }
}

/* ── Helpers HTTP ────────────────────────────────────────────────────────── */

function json(res, status, data) {
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end(JSON.stringify(data, null, 2));
}

function parseBody(req) {
    return new Promise((resolve, reject) => {
        if (req.method !== 'POST') return resolve({});
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try { resolve(JSON.parse(body || '{}')); }
            catch { resolve({ _raw: body }); }
        });
        req.on('error', reject);
    });
}

/* ── Router ────────────────────────────────────────────────────────────── */

const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
        json(res, 204, {});
        return;
    }

    const parsed = url.parse(req.url, true);
    const q = parsed.query;

    try {
        switch (parsed.pathname) {
            /* ── Health ─────────────────────────────────────────────── */
            case '/':
            case '/health': {
                const cdpOk = _cdp && _cdp.ws && _cdp.ws.readyState === 1;
                json(res, 200, { ok: true, cdp: cdpOk, port: PORT, cdpPort: CDP_PORT });
                break;
            }

            /* ── Perfil ───────────────────────────────────────────────── */
            case '/profile': {
                const cdp = await ensureCdp();
                const data = await getProfile(cdp);
                json(res, 200, data);
                break;
            }

            case '/profile-full': {
                const cdp2 = await ensureCdp();
                const data = await getProfileFull(cdp2, q.urn || undefined);
                json(res, 200, data);
                break;
            }

            /* ── Posts ────────────────────────────────────────────────── */
            case '/posts': {
                const cdp3 = await ensureCdp();
                const result = await getProfilePosts(cdp3, q.urn || undefined, {
                    start: Number(q.start) || 0,
                    count: Number(q.count) || 20,
                });
                json(res, 200, result);
                break;
            }

            /* ── Newsletters ──────────────────────────────────────────── */
            case '/newsletters': {
                const cdp4 = await ensureCdp();
                const articles = await getNewsletterArticles(cdp4, q.publicId || undefined, {
                    limit: Number(q.limit) || 20,
                });
                json(res, 200, { articles });
                break;
            }

            /* ── Conversaciones ───────────────────────────────────────── */
            case '/conversations': {
                const cdp5 = await ensureCdp();
                const list = await getConversations(cdp5, { limit: Number(q.limit) || 20 });
                json(res, 200, { conversations: list });
                break;
            }

            /* ── Mensajes ─────────────────────────────────────────────── */
            case '/messages': {
                const cdp6 = await ensureCdp();
                const id = q.id || parsed.pathname.split('/').pop();
                if (!id) { json(res, 400, { error: 'Falta conversation id (query ?id=...)' }); break; }
                const msgs = await getMessages(cdp6, id, { limit: Number(q.limit) || 30 });
                json(res, 200, { messages: msgs });
                break;
            }

            /* ── Enviar mensaje ───────────────────────────────────────── */
            case '/send': {
                if (req.method !== 'POST') { json(res, 405, { error: 'Use POST' }); break; }
                const body = await parseBody(req);
                const cid  = body.conversationId || body.conversation_id || body.id;
                const text = body.text;
                if (!cid || !text) {
                    json(res, 400, { error: 'Falta conversationId o text en el body JSON' });
                    break;
                }
                const cdp7 = await ensureCdp();
                const result = await sendMessage(cdp7, cid, text);
                json(res, 200, result);
                break;
            }

            /* ── Jobs ─────────────────────────────────────────────────── */
            case '/search-jobs': {
                const cdp8 = await ensureCdp();
                if (!q.keywords) { json(res, 400, { error: 'Falta query ?keywords=...' }); break; }
                const result = await searchJobs(cdp8, q.keywords, {
                    locationUrn: q.locationUrn || null,
                    start: Number(q.start) || 0,
                    count: Number(q.count) || 25,
                });
                json(res, 200, result);
                break;
            }

            case '/job-details': {
                const cdp9 = await ensureCdp();
                if (!q.jobUrn) { json(res, 400, { error: 'Falta query ?jobUrn=...' }); break; }
                const job = await getJobDetails(cdp9, q.jobUrn);
                json(res, 200, job);
                break;
            }

            /* ── Cache stats ──────────────────────────────────────────── */
            case '/stats': {
                const s = await store.stats();
                json(res, 200, { stats: s });
                break;
            }

            default:
                json(res, 404, { error: 'Endpoint no encontrado', path: parsed.pathname });
        }
    } catch (err) {
        const isCdp = /CDP|WebSocket|LinkedIn|timeout/i.test(err.message);
        const status = isCdp ? 503 : 500;
        const payload = { error: err.message, type: isCdp ? 'cdp_error' : 'internal_error' };
        if (!isCdp) console.error('[ERROR]', err);
        json(res, status, payload);
    }
});

/* ── Arranque ──────────────────────────────────────────────────────────── */

server.listen(PORT, () => {
    console.log(`[API] Servidor REST escuchando en http://localhost:${PORT}`);
    console.log('[API] Asegúrate de tener Edge con CDP corriendo: npm run cdp');
    console.log('[API] Health check: http://localhost:' + PORT + '/health');
});

process.on('SIGINT', async () => {
    console.log('\n[API] Cerrando servidor...');
    if (_cdp) _cdp.close();
    server.close(() => process.exit(0));
});
