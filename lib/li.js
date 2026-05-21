'use strict';

/**
 * lib/li.js — Wrappers sobre la API GraphQL de LinkedIn via CDP.
 *
 * LinkedIn migró la mensajería de Voyager REST a GraphQL.
 * Los queryIds son hashes que pueden cambiar entre deploys.
 */

const { connectToLinkedIn } = require('./cdp');
const store = require('./store');

/* ── Configuración de robustez ───────────────────────────────────────────── */

const DEFAULT_RETRIES = 2;
const RETRY_DELAY_MS  = 1500;

let _inFlight = 0;
const MAX_CONCURRENT = 3;

async function throttle() {
    while (_inFlight >= MAX_CONCURRENT) {
        await new Promise(r => setTimeout(r, 200));
    }
    _inFlight++;
}

function releaseThrottle() { _inFlight = Math.max(0, _inFlight - 1); }

async function withRetry(fn, retries = DEFAULT_RETRIES) {
    let lastErr;
    for (let i = 0; i <= retries; i++) {
        try { return await fn(); }
        catch (e) {
            lastErr = e;
            const isRecoverable = /timeout|429|NetworkError|cerrado/i.test(e.message);
            if (!isRecoverable || i === retries) throw e;
            const delay = RETRY_DELAY_MS * (i + 1);
            console.warn(`[retry ${i + 1}/${retries}] Esperando ${delay}ms...`);
            await new Promise(r => setTimeout(r, delay));
        }
    }
    throw lastErr;
}

/* ── Voyager API (fetch inyectado) ───────────────────────────────────────── */

async function voyager(cdp, method, path, bodyObj) {
    const bodyJson = bodyObj ? JSON.stringify(bodyObj) : null;

    const js = `(async function(){
        try {
            const csrfMatch = document.cookie.match(/JSESSIONID=([^;]+)/);
            const csrf = csrfMatch ? csrfMatch[1].replace(/^"|"$/g,'') : '';
            const opts = {
                method:      ${JSON.stringify(method)},
                credentials: 'include',
                headers: {
                    'csrf-token':                   csrf,
                    'x-restli-protocol-version':    '2.0.0',
                    'x-li-lang':                    'en_US',
                    'accept': 'application/vnd.linkedin.normalized+json+2.1',
                    ${bodyJson ? "'content-type': 'application/json'," : ''}
                },
                ${bodyJson ? `body: ${JSON.stringify(bodyJson)},` : ''}
            };
            const res  = await fetch('https://www.linkedin.com' + ${JSON.stringify(path)}, opts);
            const text = await res.text();
            return JSON.stringify({ ok: res.ok, status: res.status, text });
        } catch(e) { return JSON.stringify({ error: e.message }); }
    })()`;

    await throttle();
    try {
        const raw = await withRetry(() => cdp.evaluate(js, true), DEFAULT_RETRIES);
        const result = JSON.parse(raw ?? '{}');
        if (result.error) throw new Error(`voyager: ${result.error}`);
        if (!result.ok)   throw new Error(`LinkedIn ${method} ${path} → ${result.status}: ${(result.text ?? '').slice(0, 200)}`);
        try { return JSON.parse(result.text); }
        catch { return result.text; }
    } finally {
        releaseThrottle();
    }
}

/* ── Perfil ───────────────────────────────────────────────────────────────── */

async function getProfile(cdp) {
    // Intentar cache primero
    const cached = await store.getCachedProfile('me');
    if (cached) return { urn: cached.urn, name: cached.name, publicId: cached.publicId, headline: cached.headline };
    
    const data = await voyager(cdp, 'GET', '/voyager/api/me');
    const inc  = buildMap(data.included ?? []);
    const root = data.data ?? data;
    const miniUrn = root['*miniProfile'] ?? root.miniProfile;
    const mini = miniUrn ? resolve(miniUrn, inc) : (inc[Object.keys(inc).find(k => k.includes('miniProfile'))] ?? {});
    
    const profile = {
        urn:      mini.dashEntityUrn ?? mini.entityUrn ?? root.entityUrn ?? root.dashEntityUrn ?? null,
        name:     `${mini.firstName ?? ''} ${mini.lastName ?? ''}`.trim(),
        publicId: mini.publicIdentifier ?? null,
        headline: mini.occupation ?? null,
    };
    
    await store.saveProfile(profile);
    return profile;
}

/* ── Conversaciones (GraphQL) ──────────────────────────────────────────── */

const GRAPHQL_QUERY_IDS = {
    conversations: 'messengerConversations.0d5e6781bbee71c3e51c8843c6519f48',
    messages:      'messengerMessages.5846eeb71c981f11e0134cb6626cc314',
    mailboxCounts: 'messengerMailboxCounts.fc528a5a81a76dff212a4a3d2d48e84b',
    profileFull:     'voyagerIdentityDashProfiles.da93c92bffce3da586a992376e42a305',
    profilePosts:    'voyagerFeedDashProfileUpdates.4af00b28d60ed0f1488018948daad822',

};



async function getProfileFull(cdp, profileUrn) {
    if (!profileUrn) {
        const profile = await getProfile(cdp);
        profileUrn = profile.urn;
    }
    const variables = '(profileUrn:' + profileUrn.replace(/:/g, '%3A') + ')';
    const path = `/voyager/api/graphql?includeWebMetadata=true&variables=${variables}&queryId=${GRAPHQL_QUERY_IDS.profileFull}`;
    
    const data = await voyager(cdp, 'GET', path);
    const inc = buildMap(data.included ?? []);
    const inner = data.data?.data ?? {};
    const profileRef = inner['*identityDashProfilesById']?.[0];
    const profile = profileRef ? resolve(profileRef, inc) : null;
    
    return {
        urn: profileUrn,
        entityUrn: profile?.entityUrn ?? null,
        dashEntityUrn: profile?.dashEntityUrn ?? null,
        premium: profile?.premium ?? false,
        created: profile?.created ?? null,
        // Nombre completo puede requerir otro endpoint; este devuelve metadatos
    };
}



async function getProfilePosts(cdp, profileUrn, { start = 0, count = 20 } = {}) {
    if (!profileUrn) {
        const profile = await getProfile(cdp);
        profileUrn = profile.urn;
    }
    
    // Cache: solo si start=0
    if (start === 0) {
        const cached = await store.getCachedPosts(profileUrn);
        if (cached) return { posts: cached, hasMore: cached.length >= count, total: cached.length };
    }
    
    const variables = '(count:' + count + ',start:' + start + ',profileUrn:' + profileUrn.replace(/:/g, '%3A') + ')';
    const path = `/voyager/api/graphql?includeWebMetadata=true&variables=${variables}&queryId=${GRAPHQL_QUERY_IDS.profilePosts}`;
    
    const data = await voyager(cdp, 'GET', path);
    const inc = buildMap(data.included ?? []);
    const feedData = data.data?.data?.feedDashProfileUpdatesByMemberShareFeed ?? {};
    const elements = feedData['*elements'] ?? [];
    const paging = feedData.paging ?? {};
    
    const posts = elements.map(urn => {
        const update = resolve(urn, inc);
        if (!update) return null;
        
        let text = '';
        const article = update.content?.articleComponent;
        if (article) {
            text = article.title?.text ?? article.headline?.text ?? '';
            if (!text && article.description) text = article.description?.text ?? '';
        }
        
        if (!text) {
            const components = update.content ?? {};
            for (const key of Object.keys(components)) {
                if (components[key]?.text) { text = components[key].text; break; }
                if (components[key]?.headline?.text) { text = components[key].headline.text; break; }
            }
        }
        
        let stats = null;
        const activityMatch = update.entityUrn?.match(/activity:(\d+)/);
        const activityId = activityMatch ? activityMatch[1] : null;
        if (activityId) {
            const socialCounts = Object.values(inc).find(i =>
                i['$type']?.includes('SocialActivityCounts') &&
                i.entityUrn?.includes(activityId)
            );
            if (socialCounts) {
                stats = {
                    likes: socialCounts.numLikes ?? 0,
                    comments: socialCounts.numComments ?? 0,
                    shares: socialCounts.numShares ?? 0,
                    impressions: socialCounts.numImpressions ?? 0,
                };
            }
        }
        
        return {
            urn:       update.entityUrn ?? urn,
            text:      text,
            actor:     update.actor ?? update['*actor'] ?? null,
            createdAt: update.metadata?.createdAt ?? null,
            stats:     stats,
        };
    }).filter(Boolean);
    
    if (start === 0) await store.savePosts(profileUrn, posts);
    return { posts, hasMore: !!paging['*nextPage'], total: paging.total ?? posts.length };
}
async function getConversations(cdp, { limit = 20 } = {}) {
    const cached = await store.getCachedConversations();
    if (cached) return cached;
    
    const profile = await getProfile(cdp);
    const mailboxUrn = profile.urn;
    if (!mailboxUrn) throw new Error('No se pudo obtener mailboxUrn del perfil');
    
    const variables = '(mailboxUrn:' + mailboxUrn.replace(/:/g, '%3A') + ')';
    const path = "/voyager/api/voyagerMessagingGraphQL/graphql?queryId=" + GRAPHQL_QUERY_IDS.conversations + "&variables=" + variables;
    
    const data = await voyager(cdp, 'GET', path);
    const inc  = buildMap(data.included ?? []);
    const convData = data?.data?.data?.messengerConversationsBySyncToken ?? {};
    const elements = convData['*elements'] ?? [];
    
    const conversations = elements.map(urn => {
        const conv = resolve(urn, inc);
        if (!conv?.entityUrn) return null;
        
        const participants = (conv['*conversationParticipants'] ?? [])
            .map(pUrn => parseParticipant(resolve(pUrn, inc), inc))
            .filter(Boolean);
        
        const lastMsgUrn = conv.messages?.['*elements'];
        const lastMsg = lastMsgUrn ? parseMessage(resolve(lastMsgUrn, inc), inc) : null;
        
        return {
            id:             urnToId(conv.entityUrn),
            urn:            conv.entityUrn,
            unread:         !conv.read,
            unreadCount:    conv.unreadCount ?? 0,
            lastActivityAt: conv.lastActivityAt ?? null,
            participants:   participants,
            lastMessage:    lastMsg,
            conversationUrl: conv.conversationUrl ?? null,
        };
    }).filter(Boolean);
    
    await store.saveConversations(conversations);
    return conversations;
}

async function getMessages(cdp, id, { limit = 20 } = {}) {
    const cached = await store.getCachedMessages(id);
    if (cached) return cached;
    
    const urn = idToUrn(id);
    const variables = '(conversationUrn:' + urn.replace(/:/g, '%3A').replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/,/g, '%2C').replace(/=/g, '%3D') + ')';
    const path = `/voyager/api/voyagerMessagingGraphQL/graphql?queryId=${GRAPHQL_QUERY_IDS.messages}&variables=${variables}`;
    
    const data = await voyager(cdp, 'GET', path);
    const inc  = buildMap(data.included ?? []);
    const msgData = data?.data?.data?.messengerMessagesBySyncToken ?? {};
    const elements = msgData['*elements'] ?? [];
    
    const messages = elements.map(msgUrn => {
        const msg = resolve(msgUrn, inc);
        return parseMessage(msg, inc);
    }).filter(Boolean);
    
    await store.saveMessages(id, messages);
    return messages;
}

async function sendMessage(cdp, id, text) {
    const urn = idToUrn(id);
    const body = {
        eventCreate: {
            originToken:    require('crypto').randomUUID(),
            value: {
                'com.linkedin.voyager.messaging.create.MessageCreate': {
                    attributedBody: { text, attributes: [] },
                    attachments:    [],
                },
            },
            visibleToGuest: false,
        },
    };
    const data = await voyager(cdp, 'POST',
        `/voyager/api/messaging/conversations/${encodeURIComponent(urn)}/events`,
        body
    );
    const evUrn = data?.value?.entityUrn ?? data?.data?.entityUrn ?? null;
    
    // Invalidar cache de mensajes para esta conversación
    await store.saveMessages(id, []);
    await store.persist();
    
    return { ok: true, eventId: evUrn };
}



/* ── Newsletter Articles (extracción DOM) ──────────────────────────────── */

async function getNewsletterArticles(cdp, profilePublicId, { limit = 20 } = {}) {
    const publicId = profilePublicId || 'johndoe';
    
    const cached = await store.getCachedNewsletters(publicId);
    if (cached) return cached;
    
    const url = 'https://www.linkedin.com/in/' + publicId + '/recent-activity/articles/';
    
    await cdp.evaluate('window.location.href = "' + url + '"', false);
    await new Promise(r => setTimeout(r, 4000));
    
    for (let i = 0; i < 3; i++) {
        await cdp.evaluate('window.scrollBy(0, 1000)', false);
        await new Promise(r => setTimeout(r, 1500));
    }
    
    const raw = await cdp.evaluate(`
        (function() {
            const articles = [];
            const seen = new Set();
            
            const links = document.querySelectorAll('a[href*="/pulse/"]');
            for (const link of links) {
                const href = link.href.split('?')[0];
                if (seen.has(href)) continue;
                seen.add(href);
                
                let container = link.closest('article') || link.closest('[data-test-id="content-entity-card"]') || link.parentElement?.parentElement;
                let title = '';
                let description = '';
                let date = '';
                
                if (container) {
                    const titleEl = container.querySelector('h2, h3, .content-title, [data-test-id="content-title"], span[dir="ltr"]');
                    title = titleEl?.innerText?.trim() || link.innerText?.trim() || '';
                    
                    const descEl = container.querySelector('p, .content-description, [data-test-id="content-description"]');
                    description = descEl?.innerText?.trim() || '';
                    
                    const dateEl = container.querySelector('time, [data-test-id="content-date"], span[aria-hidden="true"]');
                    date = dateEl?.innerText?.trim() || dateEl?.getAttribute('datetime') || '';
                } else {
                    title = link.innerText?.trim() || '';
                }
                
                if (title || description) {
                    articles.push({ href, title, description: description.slice(0, 300), date });
                }
            }
            
            return JSON.stringify(articles.slice(0, ${limit}));
        })()
    `, true);
    
    const articles = JSON.parse(raw ?? '[]');
    await store.saveNewsletters(publicId, articles);
    return articles;
}


/* ── Helpers de parseo (GraphQL) ─────────────────────────────────────────── */

function parseParticipant(p, inc) {
    if (!p) return null;
    const memberInfo = p.participantType?.member;
    if (!memberInfo) return null;
    
    // GraphQL: firstName/lastName son AttributedText con .text
    const firstName = typeof memberInfo.firstName === 'string' ? memberInfo.firstName : (memberInfo.firstName?.text ?? '');
    const lastName  = typeof memberInfo.lastName  === 'string' ? memberInfo.lastName  : (memberInfo.lastName?.text ?? '');
    const headline  = typeof memberInfo.headline   === 'string' ? memberInfo.headline   : (memberInfo.headline?.text ?? null);
    
    return {
        name:     `${firstName} ${lastName}`.trim(),
        publicId: memberInfo.profileUrl?.replace(/.*\/in\//, '') ?? null,
        headline: headline,
    };
}

function parseMessage(msg, inc) {
    if (!msg) return null;
    const senderUrn = msg['*sender'];
    const sender = senderUrn ? parseParticipant(resolve(senderUrn, inc), inc) : null;
    
    return {
        id:       msg.entityUrn ?? null,
        sentAt:   msg.deliveredAt ?? null,
        from:     sender,
        body:     msg.body?.text ?? '',
        hasMedia: (msg.renderContent?.length ?? 0) > 0,
    };
}

function buildMap(arr) {
    const map = {};
    for (const item of arr) { 
        if (item?.entityUrn) map[item.entityUrn] = item;
        if (item?.objectUrn) map[item.objectUrn] = item;
        if (item?.dashEntityUrn) map[item.dashEntityUrn] = item;
    }
    return map;
}

function resolve(urnOrObj, map) {
    if (!urnOrObj) return null;
    if (typeof urnOrObj === 'string') return map[urnOrObj] ?? null;
    return urnOrObj;
}

function urnToId(urn) {
    return Buffer.from(urn ?? '').toString('base64url');
}

function idToUrn(id) {
    try {
        const decoded = Buffer.from(id, 'base64url').toString('utf8');
        return decoded.startsWith('urn:li:') ? decoded : id;
    } catch { return id; }
}


/* ── Jobs ─────────────────────────────────────────────────────────────────── */

async function searchJobs(cdp, keywords, { locationUrn = null, count = 25, start = 0 } = {}) {
    const queryParts = [`keywords:${encodeURIComponent(keywords)}`, 'flagshipSearchIntent:SEARCH_SRP', 'includeFiltersInResponse:false'];
    if (locationUrn) queryParts.push(`locationUnion:(geoId:${locationUrn})`);
    const query = `(${queryParts.join(',')})`;
    const path = `/voyager/api/search/blended?count=${count}&origin=JOB_SEARCH_PAGE&q=all&query=${encodeURIComponent(query)}&start=${start}`;

    const data = await voyager(cdp, 'GET', path);
    const inc = buildMap(data.included ?? []);

    const jobs = [];
    for (const item of data.included ?? []) {
        if ((item.$type && item.$type.includes('JobPosting')) || (item.entityUrn && item.entityUrn.includes('jobPosting'))) {
            const company = item.companyDetails?.company?.name ?? item.companyName ?? null;
            const location = item.formattedLocation ?? item.location ?? null;
            jobs.push({
                urn: item.entityUrn ?? item.objectUrn ?? null,
                title: item.title ?? null,
                company,
                location,
                description: item.description?.text?.slice(0, 300) ?? item.description?.slice(0, 300) ?? null,
                listedAt: item.listedAt ?? null,
                url: item.jobPostingUrl ?? null,
            });
        }
    }
    return { jobs, total: data.data?.paging?.total ?? jobs.length };
}

async function getJobDetails(cdp, jobUrn) {
    const urn = encodeURIComponent(jobUrn);
    const path = `/voyager/api/jobs/jobPostings?decorationId=com.linkedin.voyager.deco.jobs.web.shared.WebFullJobPostingWithRelevanceSignals&jobPosting=${urn}`;
    const data = await voyager(cdp, 'GET', path);
    const root = data.included?.find(i => i.$type && i.$type.includes('JobPosting')) ?? {};

    return {
        urn: root.entityUrn ?? jobUrn,
        title: root.title ?? null,
        description: root.description?.text ?? root.description ?? null,
        company: root.companyDetails?.company?.name ?? root.companyName ?? null,
        location: root.formattedLocation ?? root.location ?? null,
        listedAt: root.listedAt ?? null,
        applicants: root.applies ?? root.applicantCount ?? null,
        workType: root.workRemoteAllowed ? 'Remote' : (root.workplaceType?.localizedName ?? null),
        jobState: root.jobState ?? null,
    };
}

/* ── Escritura ──────────────────────────────────────────────────────────── */

async function createPost(cdp, text, { visibility = 'PUBLIC' } = {}) {
    const payload = {
        commentary: { text },
        visibility,
        origin: 'MEMBER_PROFILE',
    };

    // LinkedIn usa varios endpoints según el flujo; probamos el más estable
    const data = await voyager(cdp, 'POST',
        '/voyager/api/contentcreation/normPromos?action=create',
        payload
    );
    return {
        ok: true,
        urn: data?.data?.urn ?? data?.data?.entityUrn ?? null,
        text,
    };
}

async function likePost(cdp, postUrn) {
    // postUrn puede ser urn:li:activity:XXX o urn:li:fsd_update:...
    const urn = encodeURIComponent(postUrn);
    const path = `/voyager/api/socialActions/${urn}/like`;
    const data = await voyager(cdp, 'POST', path, {});
    return { ok: true, urn: postUrn };
}

/* ── Comentar un post ──────────────────────────────────────────────────── */

async function commentPost(cdp, postUrn, text) {
    const urn = encodeURIComponent(postUrn);
    const path = `/voyager/api/feed/updates/${urn}/comments`;
    const payload = {
        value: {
            'com.linkedin.voyager.feed.Comment': {
                text,
            },
        },
    };
    const data = await voyager(cdp, 'POST', path, payload);
    return { ok: true, urn: postUrn, commentId: data?.data?.entityUrn ?? null };
}

/* ── Enviar solicitud de conexión ───────────────────────────────────────── */

async function sendInvite(cdp, profileUrn, message = '') {
    const payload = {
        invitee: {
            'com.linkedin.voyager.growth.invitation.InviteeProfile': {
                profileId: profileUrn.replace('urn:li:fsd_profile:', ''),
            },
        },
        ...(message ? { message: { body: message } } : {}),
    };
    const data = await voyager(cdp, 'POST', '/voyager/api/growth/invitations', payload);
    return { ok: true, profileUrn, trackingId: data?.data?.trackingId ?? null };
}

/* ── Guardar empleo ─────────────────────────────────────────────────────── */

async function saveJob(cdp, jobUrn) {
    const urn = encodeURIComponent(jobUrn);
    const path = `/voyager/api/jobs/jobPostings/${urn}/saveState`;
    const data = await voyager(cdp, 'POST', path, { saved: true });
    return { ok: true, jobUrn, saved: true };
}

module.exports = {
    connectToLinkedIn, voyager,
    getProfile, getProfileFull, getProfilePosts, getNewsletterArticles, getConversations, getMessages, sendMessage,
    searchJobs, getJobDetails,
    createPost, likePost,
    commentPost, sendInvite, saveJob,
};

