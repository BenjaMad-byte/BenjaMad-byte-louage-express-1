import { test } from "node:test";
import assert from "node:assert/strict";
import { launchBrowser } from "../e2e/_harness.js";

const noBrowser = { launch: async () => { throw new Error("introuvable"); } };
const fakeBrowser = { launch: async ({ channel }) => ({ channel }) };

test("sans navigateur : les tests de navigateur sont ignorés en local, mais font ÉCHOUER la CI (E2E_REQUIRE_BROWSER=1)", async () => {
  const local = await launchBrowser({ launcher: noBrowser, env: {} });
  assert.match(local.skip, /aucun navigateur Chrome\/Edge trouvé/);
  await assert.rejects(launchBrowser({ launcher: noBrowser, env: { E2E_REQUIRE_BROWSER: "1" } }), /aucun navigateur Chrome\/Edge trouvé/);
  const other = await launchBrowser({ launcher: noBrowser, env: { E2E_REQUIRE_BROWSER: "0" } });
  assert.ok(other.skip, "seule la valeur « 1 » rend le navigateur obligatoire");
});

test("canaux essayés dans l'ordre : E2E_CHANNEL, puis Chrome, puis Edge", async () => {
  assert.equal((await launchBrowser({ launcher: fakeBrowser, env: { E2E_CHANNEL: "chrome-beta" } })).browser.channel, "chrome-beta");
  assert.equal((await launchBrowser({ launcher: fakeBrowser, env: {} })).browser.channel, "chrome");
  const onlyEdge = { launch: async ({ channel }) => { if (channel !== "msedge") throw new Error("non"); return { channel }; } };
  assert.equal((await launchBrowser({ launcher: onlyEdge, env: {} })).browser.channel, "msedge");
});
