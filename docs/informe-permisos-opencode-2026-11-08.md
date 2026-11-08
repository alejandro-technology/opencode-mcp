# Informe de permisos no bloqueantes para tareas delegadas — OpenCode 1.19.5

- **Fecha:** 2026-11-08
- **Alcance:** `opencode-mcp` (capa de permisos: `permissions.ts`, `permission-scopes.ts`, `start_server.ts`)
- **Origen:** hallazgos de `docs/informe-ejecucion-opencode-2026-11-07.md` (rechazos de `bash` y wedges en las tareas delegadas de `jobs-core`/`jobs-ui`)
- **Resultado:** implementado y verificado — 481 tests, 100% de cobertura, smoke en vivo contra OpenCode `1.19.5`.

## Resumen

Las tareas delegadas con `directory` corrián en **sesiones anidadas** al root del server. OpenCode 1.19.x genera asks de permiso `external_directory` para cualquier path *dentro del árbol del server pero fuera de la Location de esa sesión*, y además **solo los publica por REST v2** (`/api/permission/request`), nunca en el stream `/event` legacy que escuchaba el responder del adaptador. Con la política `read-only` por defecto, `decidePermission` rechazaba **siempre** cualquier ask de shell (`metadata.command`), lo que produce exactamente el error del informe: `bash failed: The user rejected permission to use this specific tool call` (mensaje de `PermissionV1.RejectedError`: un ask pendiente respondido con `reject`).

## Contrato verificado en vivo (probe)

Facts validados con scripts `tsx` contra el binario real `opencode` `1.19.5` + `@opencode-ai/sdk` `1.19.5`:

1. **Superficie v2**: los asks pendientes se listan en `GET /api/permission/request?directory=<dir>` y se responden con `POST /api/session/{id}/permission/{requestID}/reply` con body `{ "reply": "once" | "always" | "reject" }`. Nunca aparecen en el SSE legacy.
2. **Forma del ask**: cada item lleva `action` (p. ej. `external_directory`), `resources` = patrón del directorio tocado (`<canonDir>/*`), `metadata`, y `source.{messageID, callID}`. El mapeo a la forma legacy queda: `action` → `permission`/`type`, `resources` → `patterns`, `save` → `always`, `source` → `tool`.
3. **Alcance del gating**: en 1.19.x `external_directory` solo se dispara para paths dentro del root del server pero fuera de la Location de la sesión (hermanos/parents del cwd de la tarea). Un bash con `workdir` **fuera del árbol** corre sin ask alguno — el boundary out-of-tree no está forzado localmente por la config (documentado; el rechazo out-of-root del responder queda como red de seguridad para 1.18.x / builds futuras).
4. **Config object**: `permission.external_directory` acepta scalar (`"ask" | "allow" | "deny"`) **o** objeto de globs (`{ "<root>/**": "allow" }`). La config del server **reemplaza** por completo el valor de esa key en configs de nivel inferior (proyecto); las keys `read`/`edit`/`bash` siguen pasando por el deep-merge intactas.
5. **Subagentes**: los subagentes corren como **sesiones hijas** con `Session.parentID` apuntando al task; sus asks llevan el sessionID del hijo, son listables con `client.session.children`, y heredan las reglas `external_directory` del padre.
6. **Detalles menores**: los posts sintéticos a `/api/session/:id/permission` sin campo `agent` se evalúan con el fallback deny-all (`missingAgentPermissions`) — engañosos para probes; `session.shell` permite probar el path de bash sin costo de LLM; los modelos `opencode/*` free pudieron quedar en loop de `retry` transitorio, mientras los `opencode-go/*` high-volume ejecutaron normal (~$0.02–0.06 por tarea de código).

## Cambios

| Archivo | Cambio |
| --- | --- |
| `src/modules/shared/permissions.ts` | `buildServerConfig(policy, { rootDirectory })`: con `read-only` + root emite `{ permission: { external_directory: { "<root>/**": "allow" } } }` → los comandos y ediciones dentro del árbol del server **no generan ningún ask**. `decidePermission(client, ask, policy, { sleep, rootDirectory })` con *grounding*: los asks de shell (detectados por `metadata.command` o por el nombre de tool del `callID`) se aprueban con `once` si `groundExternalPatterns()` confirma que todos los patterns caen dentro del root; fuera del root o sin grounding → `reject` (fail-closed, sin bloqueos). |
| `src/modules/shared/permissions.ts` (responder) | `startPermissionResponder` corre **dos loops**: el SSE legacy (servidores 1.18.x) y, si hay `baseUrl`, un **drain REST v2** de 1 s (`GET /api/permission/request?directory=` + `POST .../reply`) con dedupe FIFO (tope 512 ids) y 404s ya resueltos tragados. `done` espera a ambos loops. Opción `rootDirectory` (con fallback al `directory`). |
| `src/modules/shared/permission-scopes.ts` | Cada scope auto-acepta **sesiones hijas** con un poller de 3 s (`CHILD_POLL_MS`) que consulta `session.children` sobre las sesiones conocidas. Un ask v2 que llegue antes de que el hijo sea conocido se salta **sin** marcarse como manejado → el siguiente tick del drain lo responde una vez aceptado el hijo: los subagentes ya no pueden colgar la tarea. El responder ahora recibe también `baseUrl`, `directory` y `rootDirectory: server.directory`. |
| `src/modules/tools/start_server.ts` | Nuevo input opcional `external_directory` (`read-only` \| `allow` \| `deny`) con precedencia **tool param > `OPENCODE_MCP_EXTERNAL_DIR` (env) > CLI arg > `read-only` default**. El launch root se resuelve con `realpath` antes de crear el server y se pasa a `buildServerConfig` como `rootDirectory`. La respuesta del tool reporta la política efectiva elegida. |
| `AGENTS.md` | Sección de permisos reescrita (tres capas), gotcha de versión actualizado a `1.19.5` con los hechos del contrato. |

## Verificación

- `pnpm build` ✓ (typecheck incluido), `pnpm test` **481/481** ✓, `pnpm test:coverage` **100%** en statements/branches/functions/lines ✓, `pnpm lint` ✓.
- **Smoke en vivo** (server real `1.19.5`, agente `build`, modelo `opencode-go/mimo-v2.6-flash`):
  - Bash con `workdir` **dentro del árbol** (p. ej. hermano del directorio de la tarea): completa sin ningún ask (capa de config). ✓
  - Con config scalar `ask` (comportamiento anterior), el mismo comando genera el ask y el drain lo aprueba en vivo con la decisión `once — "shell command inside the server working directory"`. ✓
  - Bash con `workdir` fuera del árbol: corre sin ask (limitación documentada del gating de 1.19.x). ✓

## Uso

- **Default**: sin configurar nada, cualquier tarea con `directory` bajo el root del server puede ejecutar cualquier comando dentro del árbol del server; fuera del árbol, los tools que el server sí gatea siguen la frontera `read-only` (lecturas `once`, escrituras rechazadas).
- **Libertad total** (incluso fuera del árbol): `opencode_start_server({ external_directory: "allow" })`, o `OPENCODE_MCP_EXTERNAL_DIR=allow`.
- **Muro estricto**: `external_directory: "deny"`.

## Lecciones para la orquestación

1. Verificar los shapes del wire contra un server real antes de confiar en tipos generados: el SDK declara otra cosa, y un permiso que nunca se responde simplemente cuelga la tarea (falla silenciosa).
2. Probar rutas de permisos con `session.shell` (sin LLM) cuando sea posible; los prompts sintéticos a la API de permisos sin `agent` evalúan con un ruleset deny-all que no refleja el path real de tools.
3. Las tareas de código en modo shared se serializan por la lease exclusiva del workspace (incluso sin `expected_changes`/`checks`): planificar secuencias o usar `workspace_mode: "worktree"`.
4. Los modelos free pueden quedar atrapados en loops de `retry`; escalar al high-volume sancionado (~$0.02–0.06 por tarea) cuando el estado quede en `running` sin tool calls.
