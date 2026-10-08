import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startApp, launchBrowser, newContext, watchErrors, axeViolations, hasHorizontalOverflow, registerViaApi, ADMIN_TOKEN } from "./_harness.js";
import { base32Decode, hotp, stepOf } from "../totp.js";

let env, browser, skip;
const PW = "correct horse battery";
before(async () => {
  env = await startApp();
  ({ browser, skip } = await launchBrowser());
});
after(async () => {
  await browser?.close();
  env.stop();
});

const totp = (secretText) => hotp(base32Decode(secretText.replace(/\s/g, "")), stepOf(env.now()));
const api = (method, url, token, body) =>
  fetch(`${env.base}/api/admin${url}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
const noA11yProblems = async (page, where) => assert.deepEqual((await axeViolations(page)).map((v) => `${v.id}: ${v.nodes.join(", ")}`), [], where);

async function loginAccount(page, username, password, code = "") {
  await page.goto(env.base + "/admin");
  await page.locator("#username").waitFor();
  await page.fill("#username", username);
  await page.fill("#password", password);
  await page.fill("#code", code);
  await page.getByRole("button", { name: "Se connecter" }).click();
}

test("du jeton partagé au premier compte : création, première connexion (mot de passe + double authentification), console nominative", { timeout: 180_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const context = await newContext(browser, { viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = watchErrors(page);

  // 1. Installation initiale : le jeton ouvre la console, l'onglet Comptes permet de créer le premier compte.
  await page.goto(env.base + "/admin");
  await page.locator("#token").waitFor();
  assert.equal(await page.locator("#gate-account").isHidden(), true);
  await page.fill("#token", ADMIN_TOKEN);
  await page.getByRole("button", { name: "Se connecter" }).click();
  await page.locator("#app").waitFor();
  await page.locator("#tab-acc").click();
  await page.locator("#new-username").waitFor();
  assert.ok((await page.locator("#view-acc").innerText()).includes("le jeton ne donne plus aucun accès"));
  await page.fill("#new-username", "alice");
  await page.fill("#new-name", "Alice Test");
  await page.selectOption("#new-role", "owner");
  await noA11yProblems(page, "onglet Comptes (installation)");
  await page.getByRole("button", { name: "Créer le compte" }).click();

  // 2. Le premier compte est créé : retour à l'écran de connexion avec le mot de passe provisoire ; le jeton ne donne plus rien.
  await page.locator("#username").waitFor();
  const message = await page.locator("#gate-err").innerText();
  const temp = message.match(/([a-z2-9]{4}-){3}[a-z2-9]{4}/)?.[0];
  assert.ok(temp, message);
  assert.ok(message.includes("Le jeton partagé ne donne plus accès"));
  assert.equal(await page.locator("#gate-token").isHidden(), true);
  assert.equal((await api("GET", "/applications", ADMIN_TOKEN)).status, 401);
  await noA11yProblems(page, "connexion par compte");

  // 3. Mauvais identifiants : message unique, rien de plus.
  await loginAccount(page, "alice", "pas le bon mot de passe");
  await page.locator("#gate-err:not(:empty)").waitFor();
  assert.equal(await page.locator("#gate-err").textContent(), "Identifiants invalides (identifiant, mot de passe ou code).");

  // 4. Première connexion : mot de passe provisoire, code vide → écran d'activation.
  await loginAccount(page, "alice", temp);
  await page.locator("#setup").waitFor({ state: "visible" });
  assert.equal(await page.locator("#app").isHidden(), true, "la console reste fermée tant que le compte n'est pas activé");
  await noA11yProblems(page, "activation : mot de passe");
  await page.fill("#pw-current", temp);
  await page.fill("#pw-new", "court");
  await page.fill("#pw-confirm", "court");
  await page.getByRole("button", { name: "Changer mon mot de passe" }).click();
  await page.locator("#setup .err:not(:empty)").waitFor();
  assert.equal(await page.locator("#setup .err").textContent(), "Au moins 12 caractères.");
  await page.fill("#pw-new", PW);
  await page.fill("#pw-confirm", PW + "x");
  await page.getByRole("button", { name: "Changer mon mot de passe" }).click();
  await page.locator("#setup .err", { hasText: "pas identiques" }).waitFor();
  await page.fill("#pw-confirm", PW);
  await page.getByRole("button", { name: "Changer mon mot de passe" }).click();

  // 5. Double authentification : clé, mauvais code, bon code, codes de secours.
  await page.getByRole("button", { name: "Activer la double authentification" }).click();
  await page.locator("#totp-secret").waitFor();
  const secret = (await page.locator("#totp-secret").textContent()).trim();
  assert.match(secret.replace(/\s/g, ""), /^[A-Z2-7]{32}$/);
  assert.match(await page.locator("#setup a[href^='otpauth://']").getAttribute("href"), /^otpauth:\/\/totp\/Louage%20Express:alice\?secret=/);
  await noA11yProblems(page, "activation : double authentification");
  await page.fill("#totp-code", "000000");
  await page.getByRole("button", { name: "Vérifier et activer" }).click();
  await page.locator("#setup .err", { hasText: "Code incorrect" }).waitFor();
  await page.fill("#totp-code", totp(secret));
  await page.getByRole("button", { name: "Vérifier et activer" }).click();
  await page.locator("#recovery-codes").waitFor();
  const recovery = await page.locator("#recovery-codes li").allTextContents();
  assert.equal(recovery.length, 8);
  assert.ok(recovery.every((c) => /^[a-z2-9]{5}-[a-z2-9]{5}$/.test(c)));
  await page.getByRole("button", { name: "J'ai noté mes codes de secours" }).click();
  await page.locator("#app").waitFor({ state: "visible" });
  assert.equal(await page.locator("#whoami").textContent(), "Alice Test — propriétaire");
  await page.getByRole("button", { name: "Se déconnecter" }).click();

  // 6. Connexion normale : mot de passe + code (le code du pas suivant, puisque le pas courant a servi à l'activation).
  env.advance(31_000);
  await loginAccount(page, "alice", PW, totp(secret));
  await page.locator("#app").waitFor({ state: "visible" });
  await page.locator("#tab-acc").click();
  await page.locator("#users tbody tr").first().waitFor();
  const accountsView = await page.locator("#view-acc").innerText();
  assert.ok(accountsView.includes("Journal des actions") && accountsView.includes("Alice Test"));
  assert.equal(await page.locator("#users tbody tr").count(), 1);
  await page.locator("#audit tbody tr").first().waitFor();
  const audit = await page.locator("#audit tbody").innerText();
  assert.ok(audit.includes("alice") && audit.includes("connexion") && audit.includes("double authentification activée"), audit);
  await noA11yProblems(page, "onglet Comptes (propriétaire)");

  // 7. Rejouer un code déjà utilisé échoue ; un code de secours passe, une seule fois.
  await page.getByRole("button", { name: "Se déconnecter" }).click();
  await loginAccount(page, "alice", PW, totp(secret));
  await page.locator("#gate-err:not(:empty)").waitFor();
  await page.fill("#code", recovery[0]);
  await page.fill("#password", PW);
  await page.getByRole("button", { name: "Se connecter" }).click();
  await page.locator("#app").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Se déconnecter" }).click();
  await loginAccount(page, "alice", PW, recovery[0]);
  await page.locator("#gate-err:not(:empty)").waitFor();

  assert.deepEqual(errors.filter((e) => !/401/.test(e)), []);
  await context.close();
});

test("relecteur : traite les dossiers mais n'a ni gestion des comptes, ni journal, ni bouton de suppression ; l'inactivité ferme la session", { timeout: 180_000 }, async (t) => {
  if (skip) return t.skip(skip);
  const owner = env.db.prepare("SELECT username FROM admin_users WHERE role = 'owner'").get();
  assert.equal(owner.username, "alice", "dépend du test précédent");
  // Alice (propriétaire) crée et active « carol » par l'API ; carol se connecte ensuite par l'interface.
  env.advance(31_000);
  const adminAuth = env.app.locals.adminAuth;
  const created = await adminAuth.createUser({ username: "carol", displayName: "Carol Relectrice", role: "reviewer" });
  const first = await adminAuth.login({ username: "carol", password: created.temp_password });
  const session = adminAuth.authenticate(first.token);
  await adminAuth.changePassword(session.user.id, created.temp_password, PW, session.hash);
  const { secret } = adminAuth.totpSetup(session.user.id);
  adminAuth.totpConfirm(session.user.id, totp(secret));
  const ref = await registerViaApi(env, { phone: "98730001", cin: "07300001", name: "Chauffeur Dossier" });

  env.advance(31_000);
  const context = await newContext(browser, { viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await loginAccount(page, "carol", PW, totp(secret));
  await page.locator("#app").waitFor({ state: "visible" });
  assert.equal(await page.locator("#whoami").textContent(), "Carol Relectrice — relecteur");

  await page.fill("#f-q", "98730001");
  await page.waitForFunction(() => document.querySelectorAll("#apps tbody tr").length === 1);
  await page.locator("#apps tbody tr").first().click();
  await page.locator("#detail h2").waitFor();
  assert.ok((await page.locator("#detail").innerText()).includes("Chauffeur Dossier"));
  assert.equal(await page.getByRole("button", { name: /Supprimer \(données/ }).count(), 0, "pas de bouton de suppression pour un relecteur");
  await page.selectOption("#d-status", "interview");
  await page.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await page.locator("#detail .note", { hasText: "Enregistré." }).waitFor();
  assert.equal(env.db.prepare("SELECT status FROM applications WHERE ref = ?").get(ref).status, "interview");
  assert.equal(env.db.prepare("SELECT actor FROM admin_audit WHERE action = 'application_update' ORDER BY id DESC").get().actor, "carol", "la modification porte son nom");

  await page.locator("#tab-acc").click();
  await page.locator("#view-acc h2").first().waitFor();
  const view = await page.locator("#view-acc").innerText();
  assert.ok(view.toLowerCase().includes("changer mon mot de passe"), "texte des boutons rendu en capitales par le style");
  assert.ok(!view.includes("Comptes de l'équipe") && !view.includes("Journal des actions"));
  assert.equal(await hasHorizontalOverflow(page), false);

  // L'inactivité ferme la session : la prochaine action renvoie à la connexion avec un message.
  env.advance(31 * 60_000);
  await page.locator("#tab-ivs").click();
  await page.locator("#gate").waitFor({ state: "visible" });
  assert.equal(await page.locator("#gate-err").textContent(), "Session expirée ou fermée : reconnectez-vous.");
  assert.equal(await page.evaluate(() => sessionStorage.getItem("admin_token")), null);
  await context.close();
});
