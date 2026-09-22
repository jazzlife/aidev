#!/usr/bin/env node
import process from 'node:process';

const baseUrl = (process.env.AIDEV_GATEWAY_URL ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
const adminToken = process.env.ADMIN_TOKEN;
if (!adminToken) throw new Error('ADMIN_TOKEN is required');
const [command, username, password, runtimeName] = process.argv.slice(2);
const request = async (path, options = {}) => {
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers: { 'x-admin-token': adminToken, ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers ?? {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status}: ${body.error ?? 'request failed'}`);
  return body;
};
if (command === 'list') console.log(JSON.stringify(await request('/admin/users'), null, 2));
else if (command === 'add' && username && password && runtimeName) console.log(JSON.stringify(await request('/admin/users', { method: 'POST', body: JSON.stringify({ username, password, runtimeName }) }), null, 2));
else if (command === 'disable' && username) console.log(JSON.stringify(await request(`/admin/users?username=${encodeURIComponent(username)}`, { method: 'DELETE' }), null, 2));
else {
  console.error('Usage: manage-users.mjs list | add <username> <password> <runtimeName> | disable <username>');
  process.exit(2);
}
