import { isAbsolute } from "node:path";

/**
 * Where Prevue state lives, resolved with the enforcement hook's rules: CLAUDE_PLUGIN_DATA must be set and absolute
 * (empty or relative counts as unset, never resolved against a working directory). The MCP server has no hook payload
 * to take a project from, so the project directory must come from an absolute CLAUDE_PROJECT_DIR; the process's own
 * working directory is deliberately not used. Only the two variables are read.
 */
export type Runtime = { ok: true; dataDir: string; projectDir: string } | { ok: false; code: "env_data_dir" | "env_project_dir"; message: string };

export function resolveRuntime(env: NodeJS.ProcessEnv, projectOverride?: string): Runtime {
  const data = env.CLAUDE_PLUGIN_DATA;
  if (!data || !isAbsolute(data)) return { ok: false, code: "env_data_dir", message: "CLAUDE_PLUGIN_DATA is not set to an absolute path" };
  const project = projectOverride ?? env.CLAUDE_PROJECT_DIR;
  if (!project || !isAbsolute(project)) return { ok: false, code: "env_project_dir", message: "the project directory is not an absolute path (CLAUDE_PROJECT_DIR)" };
  return { ok: true, dataDir: data, projectDir: project };
}
