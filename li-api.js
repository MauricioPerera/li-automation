#!/usr/bin/env node
'use strict';

/**
 * li-api.js — CLI de demostración para automatizar LinkedIn Desktop via CDP.
 *
 * Uso:
 *   npm run cdp        # Lanza Edge con LinkedIn (o verifica que ya esté)
 *   node li-api.js profile
 *   node li-api.js profile-full [profile-urn]
 *   node li-api.js posts [profile-urn]
 *   node li-api.js newsletters [public-id]
 *   node li-api.js conversations
 *   node li-api.js messages <conversation-id>
 *   node li-api.js stats\n  node li-api.js send <conversation-id> "Hola, mensaje de prueba"
 */

const { connectToLinkedIn } = require('./lib/cdp');
const {
    getProfile, getProfileFull, getProfilePosts, getNewsletterArticles,
    getConversations, getMessages, sendMessage
} = require('./lib/li');
const store = require('./lib/store');

const PORT = Number(process.env.LI_CDP_PORT) || 9222;

const cmd = process.argv[2];

async function main() {
    let cdp;
    try {
        console.log(`Conectando a LinkedIn en CDP puerto ${PORT}...`);
        cdp = await connectToLinkedIn(PORT);
        console.log('Conectado.\n');

        switch (cmd) {
            case 'profile': {
                const p = await getProfile(cdp);
                console.log(JSON.stringify(p, null, 2));
                break;
            }
            case 'profile-full': {
                const urn = process.argv[3];
                const p = await getProfileFull(cdp, urn);
                console.log(JSON.stringify(p, null, 2));
                break;
            }
            case 'posts': {
                const urn = process.argv[3];
                const { posts, hasMore, total } = await getProfilePosts(cdp, urn, { start: 0, count: 10 });
                for (let i = 0; i < posts.length; i++) {
                    const post = posts[i];
                    console.log(`--- Post ${i + 1} ---`);
                    console.log('Texto:', post.text?.slice(0, 200) ?? '(sin texto)');
                    if (post.stats) {
                        const { likes, comments, shares, impressions } = post.stats;
                        console.log(`Stats: likes=${likes} comments=${comments} shares=${shares} impressions=${impressions}`);
                    }
                    console.log('URN:', post.urn);
                    console.log();
                }
                console.log(`Total: ${total} posts | Más: ${hasMore}`);
                break;
            }
            case 'newsletters': {
                const publicId = process.argv[3] || 'johndoe';
                const articles = await getNewsletterArticles(cdp, publicId, { limit: 10 });
                for (let i = 0; i < articles.length; i++) {
                    const a = articles[i];
                    console.log(`--- Artículo ${i + 1} ---`);
                    console.log('Título:', a.title);
                    console.log('Fecha:', a.date);
                    console.log('URL:', a.href);
                    if (a.description) console.log('Desc:', a.description.slice(0, 200));
                    console.log();
                }
                console.log(`Total: ${articles.length} artículos`);
                break;
            }
            case 'conversations': {
                const list = await getConversations(cdp, { limit: 20 });
                for (const c of list) {
                    const names = c.participants.map(x => x.name).join(', ');
                    const last  = c.lastMessage?.body?.slice(0, 60) ?? '';
                    const status = c.unread ? 'NUEVO' : 'leído';
                    console.log(`[${status}] ${c.id} — ${names}`);
                    if (last) console.log(`  Último: ${last}${c.lastMessage?.body?.length > 60 ? '...' : ''}`);
                    console.log();
                }
                console.log(`Total: ${list.length} conversaciones`);
                break;
            }
            case 'messages': {
                const id = process.argv[3];
                if (!id) { console.error('Falta conversation-id'); process.exit(1); }
                const msgs = await getMessages(cdp, id, { limit: 30 });
                for (const m of msgs.slice().reverse()) {
                    const from = m.from?.name ?? '?';
                    const time = m.sentAt ? new Date(m.sentAt).toLocaleString() : '?';
                    console.log(`[${time}] ${from}: ${m.body}`);
                }
                break;
            }
                        case 'stats': {
                const s = await store.stats();
                console.log('Cache stats:');
                for (const [k, v] of Object.entries(s)) {
                    console.log('  ' + k + ': ' + v);
                }
                break;
            }
            case 'send': {
                const id   = process.argv[3];
                const text = process.argv[4];
                if (!id || !text) { console.error('Uso: send <conversation-id> <texto>'); process.exit(1); }
                const res = await sendMessage(cdp, id, text);
                console.log('Mensaje enviado:', JSON.stringify(res, null, 2));
                break;
            }
                        case 'search-jobs': {
                const keywords = process.argv[3];
                if (!keywords) { console.error('Falta keywords'); process.exit(1); }
                const { jobs, total } = await searchJobs(cdp, keywords, { count: 25, start: 0 });
                for (let i = 0; i < jobs.length; i++) {
                    const j = jobs[i];
                    console.log(`--- Trabajo ${i + 1} ---`);
                    console.log('Título:', j.title);
                    console.log('Empresa:', j.company);
                    console.log('Ubicación:', j.location);
                    console.log('URN:', j.urn);
                    if (j.description) console.log('Desc:', j.description.slice(0, 120));
                    console.log();
                }
                console.log(`Total encontrados: ${total}`);
                break;
            }
            case 'job-details': {
                const jobUrn = process.argv[3];
                if (!jobUrn) { console.error('Falta job-urn'); process.exit(1); }
                const job = await getJobDetails(cdp, jobUrn);
                console.log(JSON.stringify(job, null, 2));
                break;
            }
                        case 'create-post': {
                const text = process.argv[3];
                if (!text) { console.error('Falta texto del post'); process.exit(1); }
                const result = await createPost(cdp, text);
                console.log('Post creado:', JSON.stringify(result, null, 2));
                break;
            }
            case 'like': {
                const postUrn = process.argv[3];
                if (!postUrn) { console.error('Falta post-urn'); process.exit(1); }
                const result = await likePost(cdp, postUrn);
                console.log('Like dado:', JSON.stringify(result, null, 2));
                break;
            }
            case 'comment': {
                const cPostUrn = process.argv[3];
                const cText = process.argv[4];
                if (!cPostUrn || !cText) { console.error('Uso: comment <post-urn> "texto del comentario"'); process.exit(1); }
                const result = await commentPost(cdp, cPostUrn, cText);
                console.log('Comentario enviado:', JSON.stringify(result, null, 2));
                break;
            }
            case 'invite': {
                const iUrn = process.argv[3];
                const iMsg = process.argv[4] || '';
                if (!iUrn) { console.error('Uso: invite <profile-urn> ["mensaje personalizado"]'); process.exit(1); }
                const result = await sendInvite(cdp, iUrn, iMsg);
                console.log('Invitación enviada:', JSON.stringify(result, null, 2));
                break;
            }
            case 'save-job': {
                const sUrn = process.argv[3];
                if (!sUrn) { console.error('Uso: save-job <job-urn>'); process.exit(1); }
                const result = await saveJob(cdp, sUrn);
                console.log('Empleo guardado:', JSON.stringify(result, null, 2));
                break;
            }

            default: {
                console.log(`Comandos disponibles:
  node li-api.js profile
  node li-api.js profile-full [profile-urn]
  node li-api.js posts [profile-urn]
  node li-api.js newsletters [public-id]
  node li-api.js conversations
  node li-api.js messages <conversation-id>
  node li-api.js stats
  node li-api.js send <conversation-id> <mensaje>
  node li-api.js search-jobs <keywords>
  node li-api.js job-details <job-urn>
  node li-api.js create-post 'texto del post'
  node li-api.js like <post-urn>
  node li-api.js comment <post-urn> "texto del comentario"
  node li-api.js invite <profile-urn> ["mensaje personalizado"]
  node li-api.js save-job <job-urn>

Asegúrate de correr primero:
  npm run cdp
`);
            }
        }
    } catch (err) {
        console.error('Error:', err.message);
        process.exit(1);
    } finally {
        cdp?.close();
    }
}

main();








