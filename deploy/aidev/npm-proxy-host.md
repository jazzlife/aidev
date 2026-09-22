# Nginx Proxy Manager entry for `dev.nado.work`

Create one Proxy Host in the existing NPM installation:

- **Domain Names:** `dev.nado.work`
- **Scheme:** `http`
- **Forward Hostname/IP:** `aidev-auth-gateway`
- **Forward Port:** `8080`
- **Websockets Support:** on
- **Block Common Exploits:** on
- **SSL:** select the NPM-issued `dev.nado.work` certificate (ID 6) and enable **Force SSL**

NPM must be attached to the same external Docker network configured as
`AIDEV_PROXY_NETWORK` (`npm_bridge` on the AI-PC). Do not create a Proxy Host for any `cloudcli-user*`
service and do not publish those services with `ports:`.

If NPM's Advanced field is available, add these timeouts so long model turns and
terminal sessions survive beyond the default idle window:

```nginx
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
```

NPM supplies `Upgrade`/`Connection` headers when **Websockets Support** is
enabled. No path rewrite is needed: the current CloudCLI source uses root
paths, so `/api`, `/ws`, `/shell`, and the UI are all sent unchanged.
