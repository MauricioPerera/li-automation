'use strict';

/**
 * lib/store.js — Capa de persistencia sobre js-doc-store para cache de datos de LinkedIn.
 */

const { DocStore } = require('./js-doc-store');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '.li-store');

const store = new DocStore(DATA_DIR);

/* ── Colecciones ────────────────────────────────────────────────────────── */

const profileColl     = store.collection('profiles');
const postsColl       = store.collection('posts');
const conversationsColl = store.collection('conversations');
const messagesColl    = store.collection('messages');
const newslettersColl = store.collection('newsletters');

/* ── Perfiles ─────────────────────────────────────────────────────────────── */

async function getCachedProfile(urn, maxAgeMs = 5 * 60 * 1000) {
    const doc = await profileColl.findOne({ urn });
    if (!doc) return null;
    if (Date.now() - doc._cachedAt > maxAgeMs) return null;
    return doc;
}

async function saveProfile(profile) {
    const existing = await profileColl.findOne({ urn: profile.urn });
    const doc = { ...profile, _cachedAt: Date.now() };
    if (existing) {
        await profileColl.update({ urn: profile.urn }, { $set: doc });
    } else {
        await profileColl.insert(doc);
    }
    await profileColl.flush();
}

/* ── Posts ──────────────────────────────────────────────────────────────── */

async function getCachedPosts(profileUrn, maxAgeMs = 10 * 60 * 1000) {
    const docs = await postsColl.find({ profileUrn }).sort({ _cachedAt: -1 }).toArray();
    if (!docs.length) return null;
    const newest = docs[0];
    if (Date.now() - newest._cachedAt > maxAgeMs) return null;
    return docs.map(d => ({ urn: d.urn, text: d.text, stats: d.stats, createdAt: d.createdAt }));
}

async function savePosts(profileUrn, posts) {
    for (const post of posts) {
        const existing = await postsColl.findOne({ urn: post.urn });
        const doc = { ...post, profileUrn, _cachedAt: Date.now() };
        if (existing) {
            await postsColl.update({ urn: post.urn }, { $set: doc });
        } else {
            await postsColl.insert(doc);
        }
    }
    await postsColl.flush();
}

/* ── Conversaciones ──────────────────────────────────────────────────────── */

async function getCachedConversations(maxAgeMs = 2 * 60 * 1000) {
    const docs = await conversationsColl.find({}).sort({ _cachedAt: -1 }).toArray();
    if (!docs.length) return null;
    const newest = docs[0];
    if (Date.now() - newest._cachedAt > maxAgeMs) return null;
    return docs;
}

async function saveConversations(conversations) {
    for (const conv of conversations) {
        const existing = await conversationsColl.findOne({ id: conv.id });
        const doc = { ...conv, _cachedAt: Date.now() };
        if (existing) {
            await conversationsColl.update({ id: conv.id }, { $set: doc });
        } else {
            await conversationsColl.insert(doc);
        }
    }
    await conversationsColl.flush();
}

/* ── Mensajes ───────────────────────────────────────────────────────────── */

async function getCachedMessages(conversationId, maxAgeMs = 2 * 60 * 1000) {
    const doc = await messagesColl.findOne({ conversationId });
    if (!doc) return null;
    if (Date.now() - doc._cachedAt > maxAgeMs) return null;
    return doc.messages;
}

async function saveMessages(conversationId, messages) {
    const existing = await messagesColl.findOne({ conversationId });
    const doc = { conversationId, messages, _cachedAt: Date.now() };
    if (existing) {
        await messagesColl.update({ conversationId }, { $set: doc });
    } else {
        await messagesColl.insert(doc);
    }
    await messagesColl.flush();
}

/* ── Newsletters ─────────────────────────────────────────────────────────── */

async function getCachedNewsletters(publicId, maxAgeMs = 30 * 60 * 1000) {
    const doc = await newslettersColl.findOne({ publicId });
    if (!doc) return null;
    if (Date.now() - doc._cachedAt > maxAgeMs) return null;
    return doc.articles;
}

async function saveNewsletters(publicId, articles) {
    const existing = await newslettersColl.findOne({ publicId });
    const doc = { publicId, articles, _cachedAt: Date.now() };
    if (existing) {
        await newslettersColl.update({ publicId }, { $set: doc });
    } else {
        await newslettersColl.insert(doc);
    }
    await newslettersColl.flush();
}

/* ── Utils ──────────────────────────────────────────────────────────────── */

async function persist() {
    await profileColl.flush();
    await postsColl.flush();
    await conversationsColl.flush();
    await messagesColl.flush();
    await newslettersColl.flush();
}

async function stats() {
    return {
        profiles:     (await profileColl.find({}).toArray()).length,
        posts:        (await postsColl.find({}).toArray()).length,
        conversations: (await conversationsColl.find({}).toArray()).length,
        messages:     (await messagesColl.find({}).toArray()).length,
        newsletters:  (await newslettersColl.find({}).toArray()).length,
    };
}

module.exports = {
    getCachedProfile, saveProfile,
    getCachedPosts, savePosts,
    getCachedConversations, saveConversations,
    getCachedMessages, saveMessages,
    getCachedNewsletters, saveNewsletters,
    persist, stats,
};
