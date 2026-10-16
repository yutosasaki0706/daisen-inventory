import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const requests = [];
const window = {}; window.top = window; window.self = window;
const context = vm.createContext({
  window, Date, Headers, URLSearchParams,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  fetch: async (url, options) => {
    requests.push({ url, options });
    return new Response('[]', { headers: { 'Content-Type': 'application/json' } });
  },
});
const source = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8').split('\nwireEvents();')[0];
vm.runInContext(source, context);
assert.equal(vm.runInContext('canEdit()', context), false);
assert.equal(vm.runInContext('isAdmin()', context), false);
await vm.runInContext('restGet("inventory", "select=id")', context);
assert.equal(requests.at(-1).options.headers.has('Authorization'), false);
await vm.runInContext('rpc("adjust_inventory", { p_item_id: "test", p_delta: 1 })', context);
assert.equal(JSON.parse(requests.at(-1).options.body).p_delta, 1);
vm.runInContext('state.session = { accessToken: "admin-token", expiresAt: Date.now() + 3600000 }; state.profile = { role: "admin" };', context);
assert.equal(vm.runInContext('isAdmin()', context), true);
await vm.runInContext('rpc("archive_inventory_item", { p_item_id: "test", p_expected_version: 1 })', context);
assert.equal(requests.at(-1).options.headers.get('Authorization'), 'Bearer admin-token');
vm.runInContext('state.profile.role = "editor";', context);
assert.equal(vm.runInContext('isAdmin()', context), false);
assert.equal(vm.runInContext('canEdit()', context), false);
vm.runInContext('state.profile.role = "viewer";', context);
assert.equal(vm.runInContext('canEdit()', context), false);
console.log('Optional login and admin request tests passed.');
