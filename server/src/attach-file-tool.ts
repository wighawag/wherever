import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Type } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';

/**
 * Build the `attach_file` tool for a SERVER-SIDE agent session.
 *
 * This is the server-created-session counterpart of the identical tool the
 * CLI-bridge extension registers. It is intentionally SELF-CONTAINED (like
 * `read`): it only validates the requested path and returns a normal tool
 * result carrying that path. It does NOT read the file bytes and emits no
 * side-channel message.
 *
 * The download affordance is driven entirely by the tool CALL: every connected
 * client already receives tool_start/tool_end for this session, and the web UI
 * recognizes the `attach_file` tool name and renders a download button from its
 * `path` argument (hitting GET /session/download). That is why the same tool
 * works in a pure web-frontend session with no CLI bridge present.
 *
 * `cwd` is the session's working directory; relative paths resolve against it.
 *
 * Serving: a successful call is itself the download grant (download-grants.ts),
 * so any existing file the agent attaches is downloadable, inside the cwd or not.
 * The remaining refusals are server-wide policy, which `downloadsConfig` exposes
 * so the tool can FAIL LOUDLY instead of showing a button that can only error:
 * downloads disabled, or the file over `downloads.maxBytes`.
 */
export function createAttachFileTool(
  cwd: string,
  downloadsConfig: () => DownloadsPolicy | undefined = () => undefined,
): ToolDefinition {
  return {
    name: 'attach_file',
    label: 'Attach File',
    description:
      'Attach a file to the conversation so the person on the other end (e.g. a ' +
      'phone/browser) can download it with one tap. The user is remote and CANNOT ' +
      'reach the local filesystem, so a file path in your reply is NOT enough: they ' +
      'can only obtain a file if you attach it with this tool. Pass the path to a ' +
      'real, existing file (relative to the working directory, or absolute; it does ' +
      'not need to be inside the working directory). Use this both right after generating a ' +
      'deliverable (a PDF, an export, a report) AND whenever the user asks for a ' +
      "file by name or type, including one created earlier in the conversation, " +
      "e.g. 'give me the gpx', 'send me the pdf', 'download the report', 'can I " +
      "have that file'. Resolve which file they mean from the conversation and " +
      'attach it; if truly ambiguous, ask which file, otherwise attach the most ' +
      'likely match rather than only printing its path.',
    promptSnippet:
      'Attach a file to the conversation so the remote user can download it',
    promptGuidelines: [
      "Use attach_file whenever the user asks you to give/send/download/share a file, or asks for a file by name or type (e.g. 'give me the gpx', 'send the pdf'), including files created earlier in the conversation: the user is remote and can only download a file you attach, so never answer such a request with just a file path.",
      'Use attach_file right after generating a downloadable deliverable (PDF, export, archive) so the remote user can retrieve it without asking.',
    ],
    parameters: Type.Object({
      path: Type.String({
        description:
          'Path to the file to attach. Relative paths resolve against the working directory.',
      }),
    }),
    async execute(_toolCallId: string, params: unknown) {
      const rawPath = String((params as { path?: string }).path || '').trim();
      if (!rawPath) {
        return {
          content: [{ type: 'text' as const, text: 'attach_file: no path provided.' }],
          details: undefined,
          isError: true,
        };
      }

      const found = resolveAttachPath(cwd, rawPath);
      if (!found.ok) {
        return {
          content: [{ type: 'text' as const, text: `attach_file: ${found.error}` }],
          details: undefined,
          isError: true,
        };
      }
      const { size } = found;

      const refusal = downloadRefusal(downloadsConfig(), size, found.lexical);
      if (refusal) {
        return {
          content: [{ type: 'text' as const, text: refusal }],
          details: undefined,
          isError: true,
        };
      }

      const resolved = found.path;
      const filename = path.basename(resolved);
      return {
        content: [
          {
            type: 'text' as const,
            text:
              `Attached "${filename}" (${size} bytes) to the conversation. ` +
              `A download button is now shown to the user for: ${resolved}`,
          },
        ],
        details: { path: resolved, filename, size },
      };
    },
  } as unknown as ToolDefinition;
}

/**
 * Resolve a file path the way `attach_file` does (shared with
 * `assistant_notify`'s `attachments`): `~` is the home dir, a relative path is
 * against `cwd`. It must name an existing regular file. `path` is the REAL path
 * (it is what a download grant names, so it pins the file attached now, not
 * whatever a symlink points at later); `lexical` is the resolved path before
 * that. The error has no tool-name prefix.
 */
export function resolveAttachPath(
  cwd: string,
  rawPath: string,
): { ok: true; path: string; lexical: string; size: number } | { ok: false; error: string } {
  let resolved = rawPath;
  if (resolved.startsWith('~')) {
    resolved = path.join(os.homedir(), resolved.slice(1));
  } else if (!path.isAbsolute(resolved)) {
    resolved = path.resolve(cwd, resolved);
  } else {
    resolved = path.resolve(resolved);
  }
  let size: number;
  try {
    const st = fs.statSync(resolved);
    if (!st.isFile()) return { ok: false, error: `not a regular file: ${resolved}` };
    size = st.size;
  } catch {
    return { ok: false, error: `file not found: ${resolved}` };
  }
  let real = resolved;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    // Raced away after the stat: keep the lexical path; the download will 404.
  }
  return { ok: true, path: real, lexical: resolved, size };
}

/** The slice of `WhereverConfig.downloads` the tool needs to predict a refusal. */
export interface DownloadsPolicy {
  enabled?: boolean;
  maxBytes?: number;
}

/** Default `downloads.maxBytes`, kept in step with GET /session/download. */
export const DEFAULT_DOWNLOAD_MAX_BYTES = 100 * 1024 * 1024;

/**
 * Why GET /session/download would refuse this file, as an actionable tool error,
 * or null when it will be served. Mirrors the endpoint's policy checks so the
 * agent learns at attach time rather than the user at tap time.
 */
export function downloadRefusal(
  policy: DownloadsPolicy | undefined,
  size: number,
  resolved: string,
): string | null {
  if (policy?.enabled === false) {
    return (
      `attach_file: downloads are disabled on this server (downloads.enabled is false), ` +
      `so the user cannot download ${resolved}. Tell the user the file path instead.`
    );
  }
  const maxBytes = policy?.maxBytes ?? DEFAULT_DOWNLOAD_MAX_BYTES;
  if (size > maxBytes) {
    return (
      `attach_file: ${resolved} is ${size} bytes, over the server's download limit of ` +
      `${maxBytes} bytes (downloads.maxBytes). Produce a smaller file (compress, split ` +
      `or downscale it) and attach that instead.`
    );
  }
  return null;
}
