Rebuild frontend and restart Nexus service.

```bash
cd /home/librae/work/nexus/frontend && npm run build && cd - && pm2 restart nexus
```
