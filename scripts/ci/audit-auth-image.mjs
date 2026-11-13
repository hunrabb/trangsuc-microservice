// Runs only inside the built Auth runtime on the GitHub-hosted runner.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const suspicious = [];
let checked = 0;
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(filename);
    } else if (entry.isFile()) {
      checked++;
      if (entry.name === '.env' || /\.(pem|key)$/.test(entry.name)) {
        suspicious.push(filename);
      } else if (
        /\.(js|json|ts|txt|ya?ml|conf)$/.test(entry.name) &&
        fs.statSync(filename).size < 2_000_000
      ) {
        const content = fs.readFileSync(filename, 'utf8');
        // Libraries also contain the header string as a parser constant. Match
        // complete PEM material, including keys encoded as JS string literals.
        const normalized = content.replace(/(?:\\r)?\\n/g, '\n');
        if (
          /-----BEGIN ((?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY)-----\s+[A-Za-z0-9+/=\s]{32,}-----END \1-----/.test(
            normalized,
          )
        ) {
          suspicious.push(filename);
        }
      }
    }
  }
}
walk('/app');
assert.deepEqual(suspicious, [], 'Unexpected env/key material in runtime; contents withheld');
assert.ok(fs.existsSync('/app/dist/main.js'));
assert.ok(fs.existsSync('/app/dist/generated/prisma/client.js'));
assert.ok(require.resolve('@jewelry/contracts'));
assert.ok(require.resolve('@jewelry/common'));
const allowed = new Set(['PATH', 'NODE_VERSION', 'YARN_VERSION', 'NODE_ENV', 'PORT']);
// Docker injects these independently of image Config.Env.
const injected = new Set(['HOSTNAME', 'HOME']);
assert.ok(Object.keys(process.env).every((key) => allowed.has(key) || injected.has(key)));
console.log(JSON.stringify({ checked, envOrPrivateKeyFiles: 0, runtime: 'PASS' }));
