// Gestion des comptes d'administration en ligne de commande, sur le serveur. Sert à créer le PREMIER compte et à débloquer quelqu'un
// quand plus aucun propriétaire ne peut se connecter. Qui a un accès shell au serveur a de toute façon la main sur la base : c'est le recours ultime.
//
//   npm run admin -- create <identifiant> [--role owner|reviewer] [--name "Prénom Nom"]
//   npm run admin -- list
//   npm run admin -- reset-password <identifiant>     nouveau mot de passe provisoire (la double authentification est conservée)
//   npm run admin -- reset-2fa <identifiant>          téléphone perdu : désactive le TOTP et les codes de secours
//   npm run admin -- unlock <identifiant>
//   npm run admin -- disable <identifiant> | enable <identifiant>
//
// Les mots de passe provisoires ne s'affichent qu'une fois, ici ; ils doivent être changés à la première connexion.
import { db } from "./db.js";
import { createAdminAuth } from "./admin-auth.js";

const [command, username, ...rest] = process.argv.slice(2);
const flag = (name) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
const auth = createAdminAuth({ db }); // pas besoin de DATA_KEY : aucune de ces commandes ne lit un secret TOTP
const log = (action, ref) => db.prepare("INSERT INTO admin_audit (ip, action, ref, actor) VALUES ('local', ?, ?, 'cli')").run(action, ref ?? null);
const fail = (message) => { console.error(message); db.close(); process.exit(1); };
const target = () => {
  const user = username && auth.byName(username);
  return user || fail(`Compte introuvable : « ${username ?? ""} »`);
};

switch (command) {
  case "create": {
    if (!username) fail("Usage : npm run admin -- create <identifiant> [--role owner|reviewer] [--name \"Prénom Nom\"]");
    const role = flag("role") ?? (auth.hasUsers() ? "reviewer" : "owner"); // le premier compte est propriétaire
    const r = await auth.createUser({ username, displayName: flag("name"), role });
    if (r.error) fail(`Refusé : ${r.error}${r.error === "invalid_username" ? " (3 à 32 caractères : minuscules, chiffres, . _ -)" : ""}`);
    log("user_create", r.user.username);
    console.log(`Compte « ${r.user.username} » créé (${r.user.role}).\nMot de passe provisoire (affiché une seule fois) : ${r.temp_password}\nÀ la première connexion : changer le mot de passe et activer la double authentification.`);
    break;
  }
  case "list":
    for (const u of auth.listUsers()) console.log(`${u.username.padEnd(20)} ${u.role.padEnd(9)} ${u.active ? "actif  " : "inactif"} 2FA:${u.totp_enabled ? "oui" : "non"}${u.locked ? "  VERROUILLÉ" : ""}  dernière connexion : ${u.last_login_at ?? "jamais"}`);
    if (!auth.hasUsers()) console.log("Aucun compte : l'administration s'ouvre encore avec ADMIN_TOKEN. Créer le premier compte : npm run admin -- create <identifiant>");
    break;
  case "reset-password": {
    const r = await auth.resetPassword(target().id);
    log("user_reset_password", username);
    console.log(`Nouveau mot de passe provisoire pour « ${username} » (affiché une seule fois) : ${r.temp_password}`);
    break;
  }
  case "reset-2fa":
    auth.resetTotp(target().id);
    log("user_reset_2fa", username);
    console.log(`Double authentification de « ${username} » désactivée : un nouveau TOTP sera exigé à sa prochaine connexion.`);
    break;
  case "unlock":
    auth.unlock(target().id);
    log("user_unlock", username);
    console.log(`Compte « ${username} » débloqué.`);
    break;
  case "disable":
  case "enable": {
    const r = auth.updateUser(target().id, { active: command === "enable" }, null);
    if (r.error) fail(r.error === "last_owner" ? "Refusé : c'est le dernier propriétaire actif." : `Refusé : ${r.error}`);
    log("user_update", username);
    console.log(`Compte « ${username} » ${command === "enable" ? "activé" : "désactivé"}.`);
    break;
  }
  default:
    fail("Commandes : create, list, reset-password, reset-2fa, unlock, disable, enable (voir l'en-tête de admin-cli.js)");
}
db.close();
