// Prints the resolved frontend URL (src/lib/frontendUrl.ts) for .devcontainer/start.sh:
//   cd backend && npx --no-install ts-node --transpile-only src/scripts/frontendUrl.ts
import 'dotenv/config' // backend/.env, like the app
import { resolveFrontendUrl } from '../lib/frontendUrl'

const resolved = resolveFrontendUrl()
process.stdout.write(`${resolved.url}\n`)
