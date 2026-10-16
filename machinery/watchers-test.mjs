// node machinery/watchers-test.mjs — who counts as listening for a lane's bell.
import { laneWatchers, unheardBell } from './watchers.mjs';
let pass = 0, fail = 0;
const check = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`); ok ? pass++ : fail++; };
const ps = [
  '  100   50 /bin/zsh -c source snap.sh; WEFT_CONFIG=x sh /m/bell-watcher.sh opus',
  '  101  100 sh /m/bell-watcher.sh opus',
  '  200    1 sh /m/bell-watcher.sh fable',
  '  300   60 /bin/bash /w/inbox-watcher.sh fable',
  '  400   70 sh /m/bell-watcher.sh opusx',
  '  500   80 node /m/nightshift.mjs',
].join('\n');
check('a tracked bell watcher counts; the zsh wrapper does not', laneWatchers(ps, 'opus'), [{ pid: 101, ppid: 100, tracked: true }]);
check('a detached watcher is listed but not tracked, and an inbox watcher on the lane counts',
  laneWatchers(ps, 'fable'), [{ pid: 200, ppid: 1, tracked: false }, { pid: 300, ppid: 60, tracked: true }]);
check('a lane name that is a prefix of another does not match it', laneWatchers(ps, 'opu'), []);
check('no watcher at all', laneWatchers(ps, 'scout'), []);
check('a lane with a tracked watcher hears its bell: no line', unheardBell(ps, 'opus'), null);
const detachedOnly = ps.split('\n').filter((l) => !l.includes('inbox-watcher.sh fable')).join('\n');
check('a lane with only a detached watcher gets the LOUD line naming it', unheardBell(detachedOnly, 'fable')?.includes('only a detached one, pid 200'), true);
check('a lane with no watcher at all gets the LOUD line', /^LOUD: no tracked watcher holds scout's spool at the bell:/.test(unheardBell(ps, 'scout')), true);
console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
