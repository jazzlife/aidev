import fs from 'node:fs';
import crypto from 'node:crypto';

process.env.JWT_SECRET = fs.readFileSync('/run/secrets/runtime-jwt', 'utf8').trim();
if (process.env.JWT_SECRET.length < 32) throw new Error('Runtime key too short');
const username = process.env.AIDEV_RUNTIME;
if (!/^(user\d{2}|u[a-f0-9]{24})$/.test(username ?? '')) throw new Error('Invalid runtime identity');
// Seed a fresh isolated database before the server exposes first-run registration.
const { initializeDatabase, userDb, closeConnection } = await import('/opt/cloudcli/dist-server/server/modules/database/index.js');
const { default: bcrypt } = await import('bcrypt');
await initializeDatabase();
if (!userDb.hasUsers()) userDb.createUser(username, await bcrypt.hash(crypto.randomBytes(48).toString('hex'), 12));
const user = userDb.getFirstUser();
if (user?.id !== 1 || user.username !== username) throw new Error('Existing home volume belongs to a different runtime identity');
closeConnection();
await import('/opt/cloudcli/dist-server/server/index.js');
