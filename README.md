# li-automation

LinkedIn Desktop automation toolkit via Chrome DevTools Protocol (CDP).

## Arquitectura

En lugar de extraer cookies y hacer peticiones HTTP desde Node.js (lo cual LinkedIn detecta por el TLS fingerprint diferente), este toolkit **inyecta `fetch()` directamente dentro del WebView2/Edge donde ya tienes tu sesión de LinkedIn iniciada**. Las peticiones salen con las mismas cookies, headers y fingerprint que si las hicieras tú mismo desde la app.

```
Node.js (li-api.js)
    |
    v
CdpClient (lib/cdp.js)  -- WebSocket -->  Edge con LinkedIn (CDP :9222)
    |                                        |
    |  inyecta JS (Runtime.evaluate)         |
    |                                        v
    +----------------------------------> fetch() en el navegador
                                              |
                                              v
                                         LinkedIn GraphQL API
```

## Requisitos

- Node.js >= 21.0.0 (WebSocket global)
- Microsoft Edge instalado
- Sesión de LinkedIn iniciada (se guarda en perfil dedicado)

## Setup

```powershell
# 1. Lanza Edge como app de LinkedIn con remote debugging
npm run cdp

# 2. Haz login la primera vez (se guarda en el perfil dedicado)
# 3. En otra terminal, ejecuta cualquier comando CLI
```

## Cache local con js-doc-store

Todas las funciones de `lib/li.js` usan una capa de persistencia local (`lib/store.js`) sobre [js-doc-store](https://github.com/MauricioPerera/js-doc-store). Los datos se guardan en `.li-store/` como archivos JSON planos.

**TTLs configurados:**

| Recurso | TTL | Comando CLI |
|---------|-----|-------------|
| Perfil | 5 minutos | `profile` |
| Posts | 10 minutos | `posts` |
| Conversaciones | 2 minutos | `conversations` |
| Mensajes | 2 minutos | `messages` |
| Newsletters | 30 minutos | `newsletters` |

### Comandos de cache

```powershell
# Ver estadísticas del cache
node li-api.js stats
```

### API programática del store

```js
const store = require('./lib/store');

// Ver estadísticas
const s = await store.stats();
console.log(s); // { profiles: 1, posts: 0, conversations: 20, ... }

// Forzar flush a disco
await store.persist();
```

## CLI Commands

| Comando | Descripción |
|---------|-------------|
| `node li-api.js profile` | Perfil básico del usuario logueado |
| `node li-api.js profile-full [profile-urn]` | Metadatos extendidos del perfil |
| `node li-api.js posts [profile-urn]` | Posts del perfil con estadísticas de engagement |
| `node li-api.js newsletters [public-id]` | Artículos de newsletter del perfil |
| `node li-api.js conversations` | Lista de conversaciones de mensajería |
| `node li-api.js messages <id>` | Historial de mensajes de una conversación |
| `node li-api.js send <id> "texto"` | Enviar mensaje a una conversación |
| `node li-api.js stats` | Ver estadísticas del cache local |

### Ejemplos

```powershell
# Perfil
node li-api.js profile
# => {"name":"John Doe","publicId":"johndoe",...}

# Conversaciones
node li-api.js conversations
# => [NUEVO] abc123... — John Doe, Jane Smith

# Mensajes de una conversación
node li-api.js messages abc123...
# => [20/05/2026, 12:41:59 p.m.] Jane Smith: Hey John...

# Posts con estadísticas
node li-api.js posts
# => --- Post 1 ---
#    Texto: Mi post de ejemplo
#    Stats: likes=42 comments=5 shares=2 impressions=891

# Newsletters
node li-api.js newsletters johndoe
# => --- Artículo 1 ---
#    Título: Cómo automatizar procesos con IA
#    URL: https://www.linkedin.com/pulse/...
```

## API Programática (lib/li.js)

Todas las funciones reciben una instancia de `CdpClient` conectada a LinkedIn.

### `getProfile(cdp)`

Devuelve el perfil básico del usuario logueado. Consulta cache primero.

**Endpoint:** `GET /voyager/api/me`

**Respuesta:**
```json
{
  "urn": "urn:li:fsd_profile:ACoXXXXX...",
  "name": "John Doe",
  "publicId": "johndoe",
  "headline": "Software Engineer at..."
}
```

---

### `getProfileFull(cdp, profileUrn?)`

Devuelve metadatos extendidos del perfil (premium, created, etc.).

**GraphQL QueryId:** `voyagerIdentityDashProfiles.da93c92bffce3da586a992376e42a305`

**Respuesta:**
```json
{
  "urn": "urn:li:fsd_profile:...",
  "entityUrn": null,
  "dashEntityUrn": null,
  "premium": false,
  "created": null
}
```

---

### `getProfilePosts(cdp, profileUrn?, options)`

Devuelve los posts/recursos compartidos del perfil con estadísticas de engagement.

**GraphQL QueryId:** `voyagerFeedDashProfileUpdates.4af00b28d60ed0f1488018948daad822`

**Options:**
- `start` (number): offset de paginación (default: 0)
- `count` (number): cantidad de posts (default: 20)

**Respuesta:**
```json
{
  "posts": [
    {
      "urn": "urn:li:fsd_update:(urn:li:activity:1234567890,...)",
      "text": "Mi post de ejemplo",
      "actor": null,
      "createdAt": null,
      "stats": {
        "likes": 42,
        "comments": 5,
        "shares": 2,
        "impressions": 891
      }
    }
  ],
  "hasMore": false,
  "total": 20
}
```

---

### `getNewsletterArticles(cdp, profilePublicId, options)`

Extrae los artículos de newsletter del perfil navegando a `/recent-activity/articles/` y extrayendo los links del DOM.

**URL navegada:** `https://www.linkedin.com/in/{publicId}/recent-activity/articles/`

**Options:**
- `limit` (number): cantidad máxima de artículos (default: 20)

**Respuesta:**
```json
[
  {
    "href": "https://www.linkedin.com/pulse/...",
    "title": "Cómo automatizar procesos con IA",
    "description": "por John Doe • 5 min de lectura",
    "date": ""
  }
]
```

---

### `getConversations(cdp, options)`

Devuelve la lista de conversaciones de mensajería. Consulta cache primero.

**GraphQL QueryId:** `messengerConversations.0d5e6781bbee71c3e51c8843c6519f48`

**Options:**
- `limit` (number): cantidad de conversaciones (default: 20)

**Respuesta:**
```json
[
  {
    "id": "abc123...",
    "urn": "urn:li:msg_conversation:(...)",
    "unread": true,
    "unreadCount": 1,
    "lastActivityAt": 1774736015305,
    "participants": [
      { "name": "John Doe", "publicId": "johndoe", "headline": "..." },
      { "name": "Jane Smith", "publicId": "janesmith", "headline": "..." }
    ],
    "lastMessage": { "id": "...", "sentAt": 1774736015305, "from": {...}, "body": "Hola...", "hasMedia": false },
    "conversationUrl": "https://www.linkedin.com/messaging/thread/..."
  }
]
```

---

### `getMessages(cdp, conversationId, options)`

Devuelve el historial de mensajes de una conversación. Consulta cache primero.

**GraphQL QueryId:** `messengerMessages.5846eeb71c981f11e0134cb6626cc314`

**Options:**
- `limit` (number): cantidad de mensajes (default: 20)

**Respuesta:**
```json
[
  {
    "id": "urn:li:msg_message:(...)",
    "sentAt": 1774736015305,
    "from": { "name": "Jane Smith", "publicId": "...", "headline": "..." },
    "body": "Hey John, impressive work...",
    "hasMedia": false
  }
]
```

---

### `sendMessage(cdp, conversationId, text)`

Envía un mensaje de texto a una conversación. Invalida cache de mensajes.

**Endpoint:** `POST /voyager/api/messaging/conversations/{urn}/events`

**Body:**
```json
{
  "eventCreate": {
    "originToken": "<uuid>",
    "value": {
      "com.linkedin.voyager.messaging.create.MessageCreate": {
        "attributedBody": { "text": "...", "attributes": [] },
        "attachments": []
      }
    },
    "visibleToGuest": false
  }
}
```

**Respuesta:**
```json
{ "ok": true, "eventId": "urn:li:msg_message:(...)" }
```

---

### `voyager(cdp, method, path, body?)`

Función de bajo nivel para inyectar cualquier petición fetch dentro del navegador.

```js
const data = await voyager(cdp, 'GET', '/voyager/api/me');
```

---

## GraphQL QueryIds

LinkedIn usa GraphQL con queryIds hasheados. Estos pueden cambiar entre deploys. Los actuales son:

| QueryId | Uso |
|---------|-----|
| `messengerConversations.0d5e6781bbee71c3e51c8843c6519f48` | Lista de conversaciones |
| `messengerMessages.5846eeb71c981f11e0134cb6626cc314` | Mensajes de una conversación |
| `messengerMailboxCounts.fc528a5a81a76dff212a4a3d2d48e84b` | Contadores de inbox (no implementado) |
| `voyagerIdentityDashProfiles.da93c92bffce3da586a992376e42a305` | Perfil completo |
| `voyagerFeedDashProfileUpdates.4af00b28d60ed0f1488018948daad822` | Posts del perfil |

> Nota: Los artículos de newsletter se extraen del DOM (no via GraphQL) navegando a `/recent-activity/articles/`.

### Cómo descubrir nuevos queryIds

Navega a la sección deseada en LinkedIn y ejecuta:

```js
// Desde consola del navegador o via CDP
performance.getEntriesByType('resource')
  .filter(r => r.name.includes('graphql'))
  .map(r => r.name.match(/queryId=([^\u0026]+)/)?.[1])
  .filter(Boolean)
```

## CDP Client (lib/cdp.js)

### `connectToLinkedIn(port = 9222)`

Conecta al target de LinkedIn en CDP. Soporta fallback vía browser WebSocket si `/json` no lista targets (como pasa con Edge en modo app).

### `CdpClient`

| Método | Descripción |
|--------|-------------|
| `connect()` | Abre el WebSocket |
| `send(method, params, timeoutMs)` | Envía un comando CDP y espera respuesta |
| `evaluate(expression, awaitPromise, timeoutMs)` | Evalúa JavaScript en el contexto de la página |
| `close()` | Cierra la conexión |

## Notas de implementación

### Encoding de URNs

Los endpoints GraphQL de LinkedIn requieren encoding especial de los dos puntos (`:` -> `%3A`) y de paréntesis/comas para mensajes. La función `voyager()` maneja esto internamente, pero si construyes URLs manualmente ten en cuenta:

```js
// Conversaciones: solo reemplazar ':'
'(mailboxUrn:' + urn.replace(/:/g, '%3A') + ')'

// Mensajes: reemplazar también (), =, ,
'(conversationUrn:' + urn.replace(/:/g, '%3A').replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/,/g, '%2C').replace(/=/g, '%3D') + ')'
```

### Rate limiting

`lib/li.js` implementa throttling (máx 3 peticiones concurrentes) y retries con backoff. Aún así, LinkedIn puede bloquear la cuenta si se hacen demasiadas peticiones rápidas.

### Sesión

La sesión se guarda en un perfil dedicado de Edge (`LI-Automation`). No necesitas hacer login cada vez, solo la primera.

## Estructura del proyecto

```
li-automation/
├── lib/
│   ├── cdp.js              # Cliente CDP genérico + conector de LinkedIn
│   ├── li.js               # Wrappers de la API GraphQL de LinkedIn
│   ├── store.js            # Capa de persistencia local (js-doc-store)
│   └── js-doc-store.js     # Motor de base de datos de documentos
├── li-api.js               # CLI de demostración
├── package.json
├── start-li-cdp.ps1        # Script para lanzar Edge con CDP
├── start-li-native.ps1     # Script de prueba para app nativa (no funciona)
└── .gitignore              # Excluye .li-store/ y node_modules/
```

## Limitaciones conocidas

1. **App nativa de Microsoft Store**: la app UWP de LinkedIn no expone CDP. Se usa Edge como PWA en su lugar.
2. **QueryIds rotativos**: LinkedIn puede cambiar los hashes de GraphQL en cualquier deploy.
3. **sendMessage**: aún usa el endpoint REST legacy. Puede fallar si LinkedIn lo migra a GraphQL.
4. **Posts**: el texto se extrae del componente `articleComponent`. Posts de solo imagen/video pueden devolver texto vacío.
5. **Dependencia de sesión**: si la sesión de LinkedIn expira, hay que volver a hacer login manualmente en Edge.

## Licencia

MIT
