# Informe: evaluación en vivo del uso de las tools `opencode_*` por agentes — 2026-11-08

- **Pregunta del auditor:** ¿los modelos se equivocan con las tools por mal funcionamiento del server MCP o por falta de documentación/instrucciones?
- **Método:** (1) probes directos de cada error típico contra un server real; (2) un experimento anidado real — el "host" (yo) delegó una tarea a un agente A en OpenCode server `1.19.5`, **cuya única vía de trabajo fue el server MCP `opencode-mcp`**: A arrancó *su propio* server OpenCode headless, delegó la creación de un proyecto de pruebas a un agente B en él, lo esperó, obtuvo el resultado y reportó sus propios errores/confusiones verbatim; (3) auditoría REST de los mensajes de tool-call de A y B (qué vieron exactamente).
- **Estado del código al momento:** build con los cambios de permisos pendientes de commit; suite verde (481 tests, 100% cobertura).

## El experimento anidado

```
HOST (yo)
 └─ opencode-mcp (instancia stdio mía) ──▶ server 1 (opencode serve :4101, root repo)
      └─ agente A (build, opencode-go/mimo-v2.6-flash) via opencode_start_task(session <repo>/tmp-mcp-e2e)
           └─ MCP interno B1 (spawn de server 1) ──▶ opencode_start_server → server 2 (:4096)
                └─ agente B (build, mimo-v2.6-flash) via start_task(directory tmp-mcp-e2e/nested-buzz)
                     └─ subagente nativo "general" (sesión hija): inspección read-only
```

Resultado final: **completado end-to-end**. B creó `nested-buzz` (package.json ESM, src/main.js, test con node:test ×3, README), corrió `node --test` (3 pass), verificó su propio CLI (`15→Buzz`, `7→7`) y confirmó archivos vía el subagente `general` (sesión hija con `parentID` correcto, $0.002, 151 tokens). Costos: A $0.0072 (12 mensajes), flujo total < $0.02. **A y B no tuvieron ni un solo error proveniente de las tools `opencode_*`** salvo el caso F1 (transport), y A auto-resolvió el anclaje de directorio leyendo `workspace.source_directory` (correctamente).

## Hallazgos y veredicto (funcionamiento vs configuración/doc)

| # | Observación (evidencia verbatim) | Veredicto | Acción |
|---|---|---|---|
| F1 | `MCP error -32001: Request timed out` — mató mi wait a 290s y a 100s, y **también el 1er wait de A** (lo reporta verbatim). El payload elegante `timed_out: true` del tool nunca llega: el *cliente MCP del host* corta el request antes que el timeout del tool. | **Operación del host + diseño del default** (no mal funcionamiento del server). El default del clamp era 300000 ms — inalcanzable tras ese corte. | **FIX CÓDIGO**: default de `MCP_TOOL_TIMEOUT` = **55000 ms** (un wait de 50s sí llegó intacto ambos lados). Instrucciones del workflow reescritas: *repetir el wait* con los mismos task_ids hasta `timed_out: false`, en vez de pedir timeouts largos. |
| F2 | A resuelve `mkdir -p tmp-mcp-e2e/nested-buzz` relativo a **su propio cwd** (su Location) y `start_task(directory: "tmp-mcp-e2e/nested-buzz")` se resuelve relativo al **root del server** — combinación generó el doble anidamiento `<root>/tmp-mcp-e2e/tmp-mcp-e2e/nested-buzz`. Nada falló: al existir ambos dirs, el compuesto salió "bien". A dice textualmente: *"el server ya nace en mi cwd, así que mi `directory=...` anidó el workspace... lo dejé así por ser lo pedido"*. | **Ambigüedad documental + comportamiento del sistema**: en OpenCode 1.19.x el proceso MCP se spawnenea **por sesión con cwd = Location de la sesión** (verificado por proceso: B1 con cwd `<repo>/tmp-mcp-e2e`, no el root del server), por lo que "the server directory / current cwd" no es una sino dos anclas posibles y el `start_server` no reportaba dónde rooteaba. | **FIX CÓDDOC**: `opencode_start_server` ahora devuelve **`directory`** (root real, `realpath`); sus descriptions e instrucciones declaran el ancla ("resolves against the server launch directory ... NOT your own working directory"); el dato machine-checkable para confirmarlo ya existente, `workspace.source_directory` en `start_task`, queda señalado en instrucciones. Gotcha documentado en AGENTS.md con la evidencia. |
| F3 | Probes de errores mínimos: `server_not_found`, `not_found`, `invalid_directory`, `task_not_found` **sin ningún `message`** (p. ej. `{"server_id":"no-such-server","status":"server_not_found"}`). Un agente sin contexto no sabe si reintentar, con qué parámetro, o si el id está mal listo. Además vocabulario inconsistente (`server_not_found` en `start_task` vs `not_found` en `list_agents`). | **Doc/friendliness de las tools.** | **FIX CÓDIGO**: hint accionable en todos los `not_found` (server y task): p. ej. *"server_id is not registered in this MCP process; call opencode_start_server and use the server_id it returned"*, y para tasks: "must be created before dispatch; only ids returned by opencode_start_task/continue_task are trackable". `invalid_directory` en `start_task`/`list_agents` ahora explica el ancla de resolución y el directorio en conflicto. |
| F4 | Probe de agente/model inválido: `promptAsync` **acepta 2xx** con `agent: "no-existe-agente"`, el run falla sin costo (0 mensajes, 0 tokens) y `wait_for_task` reporta `status:"failed"` **sin ninguna causa**; la explicación heurística solo vivía en `get_task_result`. Sesión del server: **0 mensajes persistidos**, sin registro de error — OpenCode no guarda la causa. | **Malfunction menor del impresor de diagnósticos** (más una limitación upstream). | **FIX CÓDIGO**: `wait_for_task` propaga el diagnóstico cacheado del run (`error`/`message` del execution report) en estados terminales fallidos/empty/cancelled — un wait fallido ahora explica *por qué* sin una segunda llamada. Limitación OpenCode (causa real irrecuperable post-hoc) documentada. |
| F5 | Cadena anidada: dos instancias MCP con default `4096` — el spawn anidado chocaría con el port ya ocupado. (Se evitó asignando 4101 en el nivel host; hoc surgió en el probe del build nuevo: 4096 ocupado.) | **Falta de resiliencia de la tool.** | **FIX CÓDIGO**: `opencode_start_server` prueba `port`, `port+1`, `port+2`; si todos fallan, el error explica los ports probados y sugiere un `port` explícito. Timeout del spawn subido a 10s (SDK usa 5s por defecto). **Verificado en vivo**: con server 2 aún en 4096, el build nuevo auto-subió al **4097** y reportó `directory` correcto. |
| F6 | `unknown_model` es un buen error (message + `available_models`), pero la lista plana de 43 ids no lleva tiers ni orden por quota: para recuperar sin volver a `list_agents` no se distingue scarce de high-volume. | **Doc/bajo impacto** (el mensaje ya dirige a `opencode_list_agents`). | No changes (deferred, bajo). Recomendado: anotar tier en la lista o cortarla al top cuando pesa. |
| F7 | Sesiones/store: `/api/session/:id/message` (v2, page-shape) devuelve `{"data":[]}` mientras `/session/:id/message` sin prefijo `/api` devuelve los mensajes; el store de sesiones es **global de usuario** (el listado incluye sesiones de otros projects/servertra). | **Comportamiento wire de OpenCode** (no del adaptador). | Solo evidencia para probes futuros (mismo patrón ya documentado del `?directory=` y del header `x-opencode-directory`). |
| F8 | Cleanup: al parar el server 1, los child MCP anidados (B1, server 2) **quedaron huérfanos** (quedaron vivos tras morir su padre) — tuve que matarlos a mano; el SIGTERM a B1 sí liberó su server trackeado (handler graceful OK). | **Upstream OpenCode** (no libera sus MCP children al salir; importante para cualquier orquestación anidada). | Documentado en el informe; cleanup manual documentado en el test. |

**Veredicto global:** la interacción de los agentes con las tools es **buena**: sigue las instrucciones, corrige con JSON exactos, elige modelos por tier. Los errores observables fueron *pedagógicos/documentation* y un *default* mal calibrado (F1); la única pieza de code-hygiene significativa (F2) es un anclaje de directorio que hoy es ambiguo por como OpenCode spawnnea MCP por sesión. Se aplicaron fixes de código + doc en cada caso donde estaba bajo control del adapter.

## Fixes aplicados en esta ronda

- `src/modules/shared/config.ts` — clamp default 300000 → **55000 ms**.
- `src/modules/tools/start_server.ts` — port walk (3 intents) con error explicativo; spawn timeout 10s; respuesta con `directory`; description/documenting anchoring.
- `src/modules/tools/wait_for_task.ts` — diagnóstico de fallas cacheado propagado en el reporte del wait + hint en `not_found`.
- `src/modules/tools/{start_task,list_agents,get_task_result,get_task_status,continue_task,cancel_task,stop_server}.ts` + `shared/mcp-result.ts` — mensajes accionables en todos los not_found/invalidическая (hint compartido `unknownTaskHint()`).
- `src/modules/shared/instructions.ts` — workflow: ancla del `directory` + verificación `workspace.source_directory`; loop del wait y semantics de `timed_out`.
- `AGENTS.md` — 3 gotchas nuevos (spawn per-session cwd/anchoring, transport timeout como razón del clamp, prompt-rejection sin causa persistida) + config default actualizado.

## Verificación

- `pnpm build` (tsc/typecheck) ✓ · `pnpm test` **484/484** ✓ · `pnpm test:coverage` **100%** statements/branches/functions/lines ✓ · `pnpm lint` ✓
- Probe stdio en vivo contra el build nuevo (sin costo de LLM): `start_server` en sandbox con 4096 ocupado → **auto 4097** + `directory` reportada, `stop_server` limpio, `not_found` con hint accionable.
- Artefactos del experimento: proyecto creado por B en `tmp-mcp-e2e/tmp-mcp-e2e/nested-buzz` (constatación viviente del doble anidamiento F2), probe script `tmp-mcp-e2e/probe-new-build.mjs`.

## Próximos pasos sugeridos

1. Correr el mismo script de auditoria (probes F3–F4) después de cualquier refactor de respuestas de error para не romper la pedagogía.
2. Considerar anotar el tier en `available_models` de `unknown_model` (F6) cuando toque revisar esa respuesta.
3. A condición de un smoke live futuro: comportar el cierre de la cadena anidada (F8) con un trabajo de limpieza en `stop_server` que identifique y mate MCP children huérfanos (o documentarlo como conocida limitation del host OpenCode).
