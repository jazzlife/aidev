#!/usr/bin/env node
import { spawn } from 'node:child_process';
const [action, username] = process.argv.slice(2);
if (!['list', 'add', 'delete', 'disable'].includes(action) || ((action !== 'list') && !username)) {
  console.error('Usage: aidev-user list | add USERNAME | delete USERNAME | disable USERNAME'); process.exit(2);
}
const child = spawn('docker', ['exec', '-i', 'aidev-auth-gateway', 'node', '/app/dist/manage-users.js', action, ...(username ? [username] : [])], { stdio: ['pipe', 'inherit', 'inherit'] });
if (action === 'add') process.stdin.pipe(child.stdin); else child.stdin.end();
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
