import { initDb, getDb } from './db';
import { initDjenCache } from '../integrations/djen';

async function migrate() {
  await initDb();
  initDjenCache();
  console.log('[migrate] todas as tabelas criadas com sucesso');
  process.exit(0);
}

migrate().catch(e => { console.error(e); process.exit(1); });
