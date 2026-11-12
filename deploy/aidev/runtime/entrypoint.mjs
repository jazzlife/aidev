// CloudCLI runtime entrypoint. Runs from the shared release volume, never from the image:
//   /srv/app/current -> releases/<sha>   (swapped atomically by deploy/aidev/release/release.sh)
// A release ships prebuilt dist/, dist-server/, public/, shared/ and a node_modules symlink
// into deps/<lockhash>/ (native modules built once on the AI-PC in a bookworm helper).
// Restarting this process (docker restart, ~3s) is all an update needs; the image only
// changes when tools (git/ssh/adb/claude/sdb/node) change.
import fs from 'node:fs';
import crypto from 'node:crypto';

const APP = fs.realpathSync('/srv/app/current');
const release = fs.readFileSync(`${APP}/RELEASE`, 'utf8').trim();
console.log(`[aidev] runtime starting release ${release} from ${APP}`);
fs.writeFileSync('/tmp/aidev-release', release);

process.env.JWT_SECRET = fs.readFileSync('/run/secrets/runtime-jwt', 'utf8').trim();
if (process.env.JWT_SECRET.length < 32) throw new Error('Runtime key too short');
const username = process.env.AIDEV_RUNTIME;
if (!/^(user\d{2}|u[a-f0-9]{24})$/.test(username ?? '')) throw new Error('Invalid runtime identity');
// runtime/bin first: its `gh` signs in as the GitHub account connected in the app.
process.env.PATH = `/srv/app/current/runtime/bin:${APP}/node_modules/.bin:${process.env.PATH ?? ''}`;
// Every git here (agents' shells, the git panel) authenticates to github.com with the account connected in the app.
// Command-scope config comes after the user's own helpers, so a gh login they set up still answers first.
// (GIT_CONFIG_PARAMETERS, not GIT_CONFIG_KEY_n: Codex drops *KEY* variables from its shells.)
const githubHelper = `'credential.https://github.com.helper'='!node /srv/app/current/runtime/git-credential-github.mjs'`;
process.env.GIT_CONFIG_PARAMETERS = [process.env.GIT_CONFIG_PARAMETERS, githubHelper].filter(Boolean).join(' ');

// Seed a fresh isolated database before the server exposes first-run registration.
const { initializeDatabase, userDb, closeConnection } = await import(`${APP}/dist-server/server/modules/database/index.js`);
const { default: bcrypt } = await import(`${APP}/node_modules/bcrypt/bcrypt.js`);
await initializeDatabase();
if (!userDb.hasUsers()) userDb.createUser(username, await bcrypt.hash(crypto.randomBytes(48).toString('hex'), 12));
const user = userDb.getFirstUser();
if (user?.id !== 1 || user.username !== username) throw new Error('Existing home volume belongs to a different runtime identity');
closeConnection();
await import(`${APP}/dist-server/server/index.js`);
