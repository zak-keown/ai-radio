import { RadioStore } from '../../src/store.js';
import { runCodex } from '../../src/codex.js';
import { fileURLToPath } from 'node:url';
await runCodex(new RadioStore(process.env.RADIO_TEST_PROJECT), 'codex', fileURLToPath(new URL('../../bin/ai-radio.js', import.meta.url)), { executable: fileURLToPath(new URL('./fake-codex.js', import.meta.url)) });
