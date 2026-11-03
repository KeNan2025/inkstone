import assert from 'node:assert/strict'
import { readFile, promises as fsp } from 'node:fs'
import { readFile as readText } from 'node:fs/promises'
import Path from 'node:path'
import vm from 'node:vm'
const KEY_SEGMENT_PATTERN = /^[a-z][a-z0-9-]*$/;
const brandString = value => value;
function credentialKey(scope, id) {
	for (const segment of [scope, id]) if (!KEY_SEGMENT_PATTERN.test(segment)) throw new TypeError(`credential key segment "${segment}" must match ${String(KEY_SEGMENT_PATTERN)}`);
	return brandString(`${scope}/${id}`);
}
function parseCredentialKey(value) {
	const segments = value.split("/");
	const [scope, id] = segments;
	if (segments.length !== 2 || scope === void 0 || id === void 0) throw new TypeError(`credential key "${value}" must be "<scope>/<id>"`);
	return credentialKey(scope, id);
}

// The parser above is copied directly from the installed DSH credential package.
const source = await readText(new URL('../index.js', import.meta.url), 'utf8')
const a = source.indexOf('class SessionStore {')
const b = source.indexOf('/* -------------------------------------------------------------- helpers */', a)
assert(a >= 0 && b > a)
const SessionStore = vm.runInNewContext('(' + source.slice(a, b).trim() + ')', { fsp, Path })
const records = new Map()
const service = {
 async readRecord(key) { parseCredentialKey(key); return records.get(key) },
 async modifyRecord(key, update) { parseCredentialKey(key); records.set(key, await update(records.get(key))) },
 async deleteRecord(key) { parseCredentialKey(key); records.delete(key) },
}
const store = new SessionStore({ get: name => name === 'credentials' ? service : undefined },
 Path.resolve('.overleaf-workbench/.credential-test-unused'))
assert.equal(store.credentialsKey, 'inkstone/session')
assert.equal(parseCredentialKey(store.credentialsKey), store.credentialsKey)
assert.throws(() => parseCredentialKey('dsh-overleaf-workbench'), TypeError)
await store.write({ cookie: 'fixture-not-a-real-cookie', email: 'fixture@example.invalid' })
// Simulate the loader admitting every persisted key on the next startup.
for (const key of records.keys()) parseCredentialKey(key)
const session = await store.read()
assert.equal(session.cookie, 'fixture-not-a-real-cookie')
assert.equal(session.email, 'fixture@example.invalid')
assert.equal(records.size, 1)
await store.clear()
assert.equal(records.size, 0)
console.log('PASS: installed DSH key validation; plugin write/reload/read/clear contract.')
