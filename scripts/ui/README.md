# UI checks against the local platform emulation

1. `npm run build` (dist, dist-mobile, dist-server) and `cd deploy/aidev/auth-gateway && npm run build`
2. `bash deploy/aidev/release/local-platform.sh up`  → gateway 18080 (both apps), real CloudCLI runtime 3001, mock manager/Laya
3. `cd /tmp/pw && npm i playwright` (any scratch dir), then
   - `node <repo>/scripts/ui/shots.mjs`        screenshots: desktop / tablet workbench, mobile app → /mnt/user-data/outputs/shots
   - `node <repo>/scripts/ui/mobile-flow.mjs`  sends a routed message from the mobile app; check `aidev routing` in <LOCAL_PLATFORM_DIR>/runtime.log
4. `bash deploy/aidev/release/local-platform.sh down`
