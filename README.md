# li-automation

LinkedIn Desktop automation toolkit via Chrome DevTools Protocol (CDP).

> **IMPORTANTE — Qué app usar:**
> Este toolkit **NO funciona con la app nativa de LinkedIn de Microsoft Store**. Debes usar **Microsoft Edge como Progressive Web App (PWA)** de LinkedIn. Edge expone el puerto de depuración remota (CDP) que necesitamos para inyectar código JavaScript y hacer peticiones autenticadas.

---

## Arquitectura

En lugar de extraer cookies y hacer peticiones HTTP desde Node.js (lo cual LinkedIn detecta por el TLS fingerprint diferente), este toolkit **inyecta `fetch()` directamente dentro del Edge donde ya tienes tu sesión de LinkedIn iniciada**. Las peticiones salen con las mismas cookies, headers y fingerprint que si las hicieras tú mismo desde la app.

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

---

## App de LinkedIn a usar

### ❌ NO usar: LinkedIn de Microsoft Store

La app UWP de LinkedIn que descargas desde Microsoft Store **no expone CDP**. No podemos conectar Node.js a ella. El script `start-li-native.ps1` incluido es solo una prueba de concepto que no funciona.

### ✅ USAR: Microsoft Edge como PWA de LinkedIn

El toolkit automatiza el lanzamiento de Edge como una app dedicada de LinkedIn con el puerto de depuración remota activado.

#### Requisitos previos

1. **Microsoft Edge** instalado (viene por defecto en Windows 10/11).
2. **Node.js >= 21.0.0** (por el WebSocket global).
3. Una cuenta de LinkedIn (la sesión se guarda en un perfil de Edge dedicado).

#### Primera vez — Preparar el entorno

```powershell
# 1. Clonar o descargar este repo
# 2. Instalar dependencias (no hay externas, pero por si acaso)
npm install

# 3. Lanza Edge como app de LinkedIn con Remote Debugging en puerto 9222
npm run cdp
```

El comando `npm run cdp` ejecuta `start-li-cdp.ps1`, que:
- Detecta si ya hay una instancia de Edge con CDP en el puerto 9222.
- Si no existe, lanza Edge con `--app=https://www.linkedin.com` en un **perfil dedicado** (`LI-Automation`) separado de tu perfil principal de navegación.
- Espera hasta 24 segundos a que CDP responda.

#### Iniciar sesión en LinkedIn (solo la primera vez)

Cuando Edge se abra como app de LinkedIn:
1. Ingresa tu email y contraseña de LinkedIn.
2. Completa la verificación de dos factores si la tienes activada.
3. La sesión se guarda automáticamente en el perfil `LI-Automation`. No necesitas volver a loguearte.

#### Verificar que funciona

```powershell
# En otra terminal (PowerShell o CMD), con Edge abierto:
node li-api.js profile

# Debería devolver algo como:
# {"name":"John Doe","publicId":"johndoe",...}
```

---

## Setup resumido

```powershell
# 1. Lanza Edge como app de LinkedIn con remote debugging
npm run cdp

# 2. Haz login la primera vez (se guarda en el perfil dedicado)
# 3. En otra terminal, ejecuta cualquier comando CLI
node li-api.js profile
```

---

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

---

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
| `node li-api.js create-post 'texto del post'` | Publicar un post |
| `node li-api.js like <post-urn>` | Dar like a un post |
| `node li-api.js search-jobs <keywords>` | Buscar ofertas de empleo |
| `node li-api.js job-details <job-urn>` | Detalles de una oferta de empleo |
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

# Publicar un post
node li-api.js create-post "Hola mundo desde la API automatizada"
# => {"ok":true,"urn":"urn:li:activity:12345..."}

# Dar like a un post
node li-api.js like "urn:li:activity:12345"
# => {"ok":true,"urn":"urn:li:activity:12345"}

# Buscar empleos
node li-api.js search-jobs "software engineer"
# => --- Trabajo 1 ---
#    Título: Senior Software Engineer
#    Empresa: ACME Corp
#    Ubicación: San Francisco, CA
#    URN: urn:li:fsd_jobPosting:12345...

# Detalles de un empleo
node li-api.js job-details "urn:li:fsd_jobPosting:12345"
# => { "title": "Senior Software Engineer", "company": "ACME Corp", ... }
```

---

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
  "hasMore": true,
  "total": 150
}
```

---

### `getNewsletterArticles(cdp, profilePublicId?, options)`

Extrae artículos de newsletter del perfil navegando al DOM de `/recent-activity/articles/`.

**Options:**
- `limit` (number): cantidad de artículos (default: 20)

**Respuesta:**
```json
[
  {
    "href": "https://www.linkedin.com/pulse/...",
    "title": "Cómo automatizar procesos con IA",
    "description": "Resumen del artículo...",
    "date": "20 may 2026"
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
    "id": "urn:li:fsd_conversation:...",
    "participants": [
      { "name": "Jane Smith", "publicId": "janesmith", "headline": "..." }
    ],
    "unread": true,
    "lastMessage": { "body": "Hey John...", "sentAt": 1774736015305 }
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

### `searchJobs(cdp, keywords, options)`

Busca ofertas de empleo en LinkedIn.

**Endpoint:** `GET /voyager/api/search/blended`

**Options:**
- `locationUrn` (string): geoId de ubicación (ej. `102095887` para México)
- `count` (number): resultados por página (default: 25)
- `start` (number): offset (default: 0)

**Respuesta:**
```json
{
  "jobs": [
    {
      "urn": "urn:li:fsd_jobPosting:...",
      "title": "Senior Software Engineer",
      "company": "ACME Corp",
      "location": "San Francisco, CA",
      "description": "We are looking for...",
      "listedAt": 1774736015305,
      "url": "https://www.linkedin.com/jobs/view/..."
    }
  ],
  "total": 150
}
```

---

### `getJobDetails(cdp, jobUrn)`

Devuelve los detalles completos de una oferta.

**Endpoint:** `GET /voyager/api/jobs/jobPostings`

**Respuesta:**
```json
{
  "urn": "urn:li:fsd_jobPosting:...",
  "title": "Senior Software Engineer",
  "description": "Full description...",
  "company": "ACME Corp",
  "location": "San Francisco, CA",
  "listedAt": 1774736015305,
  "applicants": 42,
  "workType": "Remote",
  "jobState": "LISTED"
}
```

---

### `createPost(cdp, text, options)`

Publica un post de texto en tu perfil de LinkedIn.

**Endpoint:** `POST /voyager/api/contentcreation/normPromos`

**Options:**
- `visibility` (string): `PUBLIC` o `CONNECTIONS` (default: `PUBLIC`)

**Respuesta:**
```json
{
  "ok": true,
  "urn": "urn:li:activity:12345...",
  "text": "Hola mundo desde la API automatizada"
}
```

> **Advertencia:** LinkedIn puede bloquear la cuenta si publicas posts con demasiada frecuencia o contenido duplicado.

---

### `likePost(cdp, postUrn)`

Da like a un post por su URN.

**Endpoint:** `POST /voyager/api/socialActions/{postUrn}/like`

**Respuesta:**
```json
{ "ok": true, "urn": "urn:li:activity:12345..." }
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

---

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

---

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

---


---

## API REST (`api-server.js`)

Para integrar con **n8n**, **Make**, **Zapier** o cualquier otro orquestador, levanta el servidor HTTP:

```powershell
npm run server
# o
node api-server.js
```

El servidor expone endpoints JSON en `http://localhost:3000` (configurable via variable de entorno `PORT`).

### Endpoints

| Método | Endpoint | Query / Body | Descripción |
|--------|----------|--------------|-------------|
| GET | `/health` | — | Estado del servidor y CDP |
| GET | `/profile` | — | Perfil básico |
| GET | `/profile-full` | `?urn=` | Perfil completo |
| GET | `/posts` | `?urn=&start=&count=` | Posts con stats |
| GET | `/newsletters` | `?publicId=&limit=` | Artículos newsletter |
| GET | `/conversations` | `?limit=` | Lista de conversaciones |
| GET | `/messages` | `?id=` | Mensajes de una conversación |
| POST | `/send` | `{"conversationId":"...","text":"..."}` | Enviar mensaje |
| GET | `/search-jobs` | `?keywords=&locationUrn=&start=&count=` | Buscar empleos |
| GET | `/job-details` | `?jobUrn=` | Detalles de empleo |
| GET | `/stats` | — | Estadísticas de cache |

### Ejemplos con curl

```bash
# Health check
curl http://localhost:3000/health

# Perfil
curl http://localhost:3000/profile

# Conversaciones
curl http://localhost:3000/conversations

# Enviar mensaje
curl -X POST http://localhost:3000/send \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"abc123...","text":"Hola desde n8n"}'

# Buscar empleos
curl "http://localhost:3000/search-jobs?keywords=software%20engineer"

# Stats de cache
curl http://localhost:3000/stats
```

### Integración con n8n

En n8n, usa el nodo **HTTP Request**:

1. **Método:** `GET` o `POST` según el endpoint.
2. **URL:** `http://localhost:3000/<endpoint>` (o la IP de la máquina si n8n corre en Docker).
3. **Body JSON** (solo para POST): activa **Send JSON Body** y envía el payload.
4. El servidor devuelve siempre JSON; n8n puede mapear los campos directamente con expresiones como `{{ $json.name }}`.

**Workflow típico:**

```
[Trigger cada 5 min]
    |
    v
[HTTP Request: GET /conversations]
    |
    v
[IF: nueva conversación sin leer]
    |
    v
[HTTP Request: GET /messages?id=...]
    |
    v
[OpenAI / procesamiento]
    |
    v
[HTTP Request: POST /send]
```

> **Tip:** añade un nodo **HTTP Request** a `/health` al inicio del workflow para validar que Edge con CDP esté activo antes de ejecutar las demás operaciones.

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

---

## Limitaciones conocidas

1. **App nativa de Microsoft Store**: la app UWP de LinkedIn no expone CDP. Se usa Edge como PWA en su lugar.
2. **QueryIds rotativos**: LinkedIn puede cambiar los hashes de GraphQL en cualquier deploy.
3. **sendMessage**: aún usa el endpoint REST legacy. Puede fallar si LinkedIn lo migra a GraphQL.
4. **Posts**: el texto se extrae del componente `articleComponent`. Posts de solo imagen/video pueden devolver texto vacío.
5. **Dependencia de sesión**: si la sesión de LinkedIn expira, hay que volver a hacer login manualmente en Edge.
6. **Escritura**: las operaciones de escritura (posts, likes, mensajes) son más fáciles de detectar por LinkedIn. Usa delays entre operaciones y contenido variado.
6. **Job Search**: usa el endpoint REST `/search/blended` que puede devolver resultados mezclados (no solo jobs). Para búsqueda pura de empleos, los queryIds GraphQL específicos de jobs suelen ser más precisos pero rotan con frecuencia.

## Licencia

MIT

