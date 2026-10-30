const { randomBytes } = require('node:crypto');

const STORE_KEY = 'set:community:v1';
const CODE = /^SET-[A-Z2-9]{4}$/;
const ANON = /^[0-9a-f-]{20,80}$/i;
const IMAGE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function send(res, status, body) {
  res.status(status).setHeader('Cache-Control', 'no-store').json(body);
}

function emptyStore() {
  return { profiles: {}, codes: {}, friendships: {}, requests: [], posts: [] };
}

function newCode(store) {
  let code;
  do {
    code = 'SET-' + Array.from(randomBytes(4), n => alphabet[n % alphabet.length]).join('');
  } while (store.codes[code]);
  return code;
}

function ownerId(req) {
  const id = String(req.headers['x-set-anonymous-id'] || '');
  return ANON.test(id) ? `anon:${id}` : '';
}

async function bodyOf(req) {
  if (typeof req.body === 'object' && req.body !== null) return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function redis(command) {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

  if (!url || !token) {
    const error = new Error('Die Community-Datenbank ist noch nicht eingerichtet.');
    error.status = 503;
    throw error;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command)
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) {
    const error = new Error(payload.error || 'Community-Datenbank nicht erreichbar.');
    error.status = 503;
    throw error;
  }
  return payload.result;
}

async function readStore() {
  const raw = await redis(['GET', STORE_KEY]);
  if (!raw) return emptyStore();
  try {
    const data = JSON.parse(raw);
    return {
      profiles: data.profiles || {},
      codes: data.codes || {},
      friendships: data.friendships || {},
      requests: Array.isArray(data.requests) ? data.requests : [],
      posts: Array.isArray(data.posts) ? data.posts : []
    };
  } catch {
    return emptyStore();
  }
}

async function saveStore(store) {
  await redis(['SET', STORE_KEY, JSON.stringify(store)]);
}

function profileFor(store, id) {
  let profile = store.profiles[id];
  if (!profile) {
    profile = { ownerId: id, code: newCode(store), name: '', avatar: '' };
    store.profiles[id] = profile;
    store.codes[profile.code] = id;
    store.friendships[id] = [];
  }
  return profile;
}

function publicProfile(profile) {
  return { code: profile.code, name: profile.name || '', avatar: profile.avatar || '' };
}

function friendsFor(store, id) {
  return (store.friendships[id] || [])
    .map(code => store.profiles[store.codes[code]])
    .filter(Boolean)
    .map(publicProfile);
}

function validImage(image, allowEmpty = false) {
  return typeof image === 'string' && image.length <= 180000 && (allowEmpty && image === '' || IMAGE.test(image));
}

module.exports = async (req, res) => {
  try {
    const id = ownerId(req);
    if (!id) return send(res, 401, { error: 'identity required' });

    const store = await readStore();
    const me = profileFor(store, id);
    const url = new URL(req.url, `https://${req.headers.host}`);

    if (req.method === 'GET') {
      const action = url.searchParams.get('action') || 'init';

      if (action === 'search') {
        const q = (url.searchParams.get('q') || '').trim().slice(0, 80).toLocaleLowerCase('de-DE');
        const profiles = q
          ? Object.values(store.profiles)
              .filter(p => p.ownerId !== id && (p.code.toLocaleLowerCase('de-DE') === q || (p.name || '').toLocaleLowerCase('de-DE').includes(q)))
              .slice(0, 20)
              .map(publicProfile)
          : [];
        await saveStore(store);
        return send(res, 200, { profiles });
      }

      const friendCodes = new Set(store.friendships[id] || []);
      const ownerIds = new Set([id, ...[...friendCodes].map(code => store.codes[code]).filter(Boolean)]);
      const posts = store.posts
        .filter(post => ownerIds.has(post.ownerId))
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, 120)
        .map(post => ({ ...post, ...publicProfile(store.profiles[post.ownerId]) }));
      const requests = store.requests
        .filter(request => request.recipientId === id)
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .map(request => ({ ...publicProfile(store.profiles[request.senderId]), createdAt: request.createdAt }));
      const sent = store.requests
        .filter(request => request.senderId === id)
        .map(request => store.profiles[request.recipientId]?.code)
        .filter(Boolean);

      await saveStore(store);
      return send(res, 200, { profile: publicProfile(me), friends: friendsFor(store, id), requests, sent, posts });
    }

    if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });

    const body = await bodyOf(req);
    const action = body.action || '';

    if (action === 'update-name') {
      me.name = String(body.name || '').trim().slice(0, 40);
      await saveStore(store);
      return send(res, 200, { profile: publicProfile(me) });
    }

    if (action === 'update-avatar') {
      if (!validImage(body.avatar, true)) return send(res, 400, { error: 'Ungültiges Profilbild' });
      me.avatar = body.avatar;
      await saveStore(store);
      return send(res, 200, { ok: true });
    }

    if (action === 'save-post') {
      const post = body.post || {};
      const date = String(post.date || '');
      const workoutName = String(post.workoutName || 'Freies Training').trim().slice(0, 80);
      const capturedAt = String(post.capturedAt || new Date().toISOString());
      if (typeof post.id !== 'string' || post.id.length < 8 || post.id.length > 100 || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !validImage(post.image) || Number.isNaN(Date.parse(capturedAt))) {
        return send(res, 400, { error: 'Ungültiger Community-Beitrag' });
      }
      store.posts = store.posts.filter(item => !(item.ownerId === id && item.date === date));
      const createdAt = new Date().toISOString();
      const saved = { id: post.id, ownerId: id, date, capturedAt, image: post.image, workoutName, createdAt };
      store.posts.push(saved);
      await saveStore(store);
      return send(res, 200, { post: { ...saved, ...publicProfile(me) } });
    }

    if (action === 'delete-post') {
      const postId = String(body.post?.id || '');
      store.posts = store.posts.filter(post => !(post.ownerId === id && post.id === postId));
      await saveStore(store);
      return send(res, 200, { ok: true });
    }

    if (action === 'match-contacts') {
      const names = new Set((Array.isArray(body.names) ? body.names : []).map(name => String(name).trim().toLocaleLowerCase('de-DE')).filter(Boolean).slice(0, 100));
      const profiles = Object.values(store.profiles)
        .filter(profile => profile.ownerId !== id && names.has((profile.name || '').toLocaleLowerCase('de-DE')))
        .slice(0, 100)
        .map(publicProfile);
      await saveStore(store);
      return send(res, 200, { profiles });
    }

    const code = String(body.code || '').toUpperCase();
    const otherId = store.codes[code];
    const other = otherId && store.profiles[otherId];
    if (!['send-request', 'accept-request', 'decline-request', 'add-friend'].includes(action)) return send(res, 400, { error: 'Ungültige Aktion' });
    if (!CODE.test(code) || !other || otherId === id) return send(res, 404, { error: action === 'add-friend' ? 'profile not found' : 'Profil nicht gefunden' });

    if (action === 'send-request') {
      const alreadyFriends = (store.friendships[id] || []).includes(code);
      const alreadySent = store.requests.some(request => request.senderId === id && request.recipientId === otherId);
      if (!alreadyFriends && !alreadySent) store.requests.push({ senderId: id, recipientId: otherId, createdAt: new Date().toISOString() });
      await saveStore(store);
      return send(res, 200, { ok: true });
    }

    const incoming = store.requests.some(request => request.senderId === otherId && request.recipientId === id);
    if (action === 'decline-request') {
      store.requests = store.requests.filter(request => !(request.senderId === otherId && request.recipientId === id));
      await saveStore(store);
      return send(res, 200, { ok: true });
    }

    if (action === 'accept-request' && !incoming) return send(res, 409, { error: 'Diese Anfrage ist nicht mehr offen.' });

    for (const [owner, friendCode] of [[id, code], [otherId, me.code]]) {
      const list = store.friendships[owner] || [];
      if (!list.includes(friendCode)) list.push(friendCode);
      store.friendships[owner] = list;
    }
    store.requests = store.requests.filter(request => !((request.senderId === id && request.recipientId === otherId) || (request.senderId === otherId && request.recipientId === id)));
    await saveStore(store);
    return send(res, 200, { friend: publicProfile(other) });
  } catch (error) {
    return send(res, error.status || 500, { error: error.message || 'Community nicht erreichbar' });
  }
};
