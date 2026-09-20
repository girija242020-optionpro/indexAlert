# NIFTY / SENSEX alert system (single repo, single Render service)

Ek hi repo, ek hi Render service. Backend (Dhan data + push) aur PWA (`public/`) dono isi URL se serve hote hain.

Render steps: `RENDER_STEPS.md` dekho.

- `src/`     backend (Node, Express, ws, web-push)
- `public/`  PWA (strategy engine, alerts, logs)
- `test/`    backend tests (`npm test`), `test-pwa/` strategy tests (`npm test` dono chalata hai)
