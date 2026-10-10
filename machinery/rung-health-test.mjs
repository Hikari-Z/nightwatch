// Tests for rung-health.mjs — the warn-only fold-time rung checks born from
// the 2026-10-10 loss-taxonomy pilot. Run: node rung-health-test.mjs
import { rungHealth } from './rung-health.mjs';
import { readFileSync, existsSync } from 'node:fs';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) fails++; };

const healthy = '## Sequence\nstuff\n## Said to me\n- a quote [lived]\n## Corrections\n- **Wrong or overruled:** my X claim died when the bench printed red; a sibling self-catch, credited. [lived]\n';
t('healthy rung is clean', rungHealth(healthy).length, 0);
t('empty Corrections warns', rungHealth('## Said to me\n- q\n## Corrections\n- \n').length, 1);
t('missing Corrections warns', rungHealth('## Said to me\n- q\n').length, 1);
t('missing Said-to-me warns', rungHealth('## Corrections\n- **Wrong:** a long enough correction line passing the forty character floor easily.\n').length, 1);
t('both missing = two warnings', rungHealth('## Sequence\nonly').length, 2);
t('Corrections as LAST section is seen (the JS-has-no-\\Z trap)', rungHealth('## Said to me\n- q\n## Corrections\n- **Wrong:** long enough to pass the character floor, written at the very end of file.').length, 0);

console.log(fails ? `\n${fails} FAILED` : '\nall pass');
process.exit(fails ? 1 : 0);
