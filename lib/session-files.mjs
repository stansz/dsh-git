/**
 * Re-export of the shared core, so this bundle has one implementation of it.
 *
 * The code lives in `dsh-git-core`; this file exists so every caller keeps
 * importing `./session-files.mjs` and there is exactly one copy of the logic. See
 * `core-loader.mjs` for how it is found.
 */
import { loadCore } from './core-loader.mjs';

const core = await loadCore('session-files.mjs');

export const { safeSessionId, indexPath, record, reposOf, pathsOf, forgetRepo, targetPath, registerSessionFiles } = core;
export default core;
