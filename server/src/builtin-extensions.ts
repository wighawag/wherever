import type { InlineExtension } from '@earendil-works/pi-coding-agent';
import { piBuiltinExtensions } from './pi-sdk.js';

/**
 * pi's BUILT-IN extensions (native MCP, codemode, tool search, plus llama.cpp
 * when the SDK install provides its own list) for server-created sessions.
 *
 * The pi CLI loads them on its own (`builtInExtensions` in its main entry), but
 * the SDK does not: "SDK sessions do not load built-in extensions". Without
 * this, a web session would have no MCP at all even though the same user's
 * terminal pi connects every server in `mcp.json`.
 *
 * They come from the SAME install as the rest of the SDK (pi-sdk.ts), as that
 * install's CLI defines them: `builtin: true` entries, so they behave as in a
 * terminal pi:
 *   - they load as `builtin:<name>` extension paths, so `-builtin:mcp` (or any
 *     other name) in the `extensions` setting, i.e. `pi config` > Built-in,
 *     turns them off for web sessions too;
 *   - `replaceable: true`: an installed extension that registers `/mcp`,
 *     `codemode` or `tool_search` (pi-mcp-adapter, say) takes over instead of
 *     both loading with a conflict, as in the CLI.
 *
 * Every factory keeps its state inside the `(pi) => ...` call, so one entry is
 * safely shared by every session: each session build gets its own instance.
 * The MCP extension connects its servers on `session_start`, which
 * `bindServerSessionExtensions()` emits, and closes them on
 * `session_shutdown`, which `shutdownAndDisposeAgentSession()` emits.
 */
export const serverBuiltinExtensions: readonly InlineExtension[] = piBuiltinExtensions;
