// Every inline <script> in resources/ui/*.html must parse: one syntax error kills a whole page (0.37.0 settings).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
const dir = join(import.meta.dirname, '..', 'resources', 'ui');
let failures = 0, n = 0;
for (const f of readdirSync(dir).filter((f) => f.endsWith('.html'))) {
  for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)) {
    n++;
    try {
      if (/type=["']?module/.test(m[1])) new vm.SourceTextModule(m[2]); else new vm.Script(m[2], { filename: f });
    } catch (e) { failures++; console.error(`${f}: ${e.message}`); }
  }
}
console.log(`${n} inline scripts, ${failures} failing`);
process.exit(failures ? 1 : 0);
