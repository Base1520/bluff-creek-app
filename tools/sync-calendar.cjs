/* Update embedded fallback from the app-owned public events.json.
   Pass a local website checkout to update its identical consumer and build data. */
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const source = path.join(root, 'events.json');
const data = JSON.parse(fs.readFileSync(source, 'utf8'));
const modulePath = path.join(root, 'js/calendar-feed.js');
const original = fs.readFileSync(modulePath, 'utf8');
if (!/^  var DEFAULT_FEED = .*;$/m.test(original)) throw Error('Embedded fallback marker missing');
const updated = original.replace(/^  var DEFAULT_FEED = .*;$/m, () => '  var DEFAULT_FEED = ' + JSON.stringify(data) + ';');
fs.writeFileSync(modulePath, updated);
if (process.argv[2]) {
  const website = path.resolve(process.argv[2]);
  if (!fs.existsSync(path.join(website, 'build.py'))) throw Error('Expected a local website checkout with build.py');
  fs.mkdirSync(path.join(website, 'js'), {recursive: true});
  fs.mkdirSync(path.join(website, 'data'), {recursive: true});
  fs.writeFileSync(path.join(website, 'js/calendar-feed.js'), updated);
  fs.copyFileSync(source, path.join(website, 'data/events-fallback.json'));
}
console.log('Verified public calendar fallback synchronized. Rebuild the website before committing.');
