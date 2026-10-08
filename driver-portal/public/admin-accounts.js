// Console d'administration : première connexion d'un compte (mot de passe + double authentification) et gestion des comptes.
// Aucune donnée n'est insérée via innerHTML : tout passe par textContent (fonction h() fournie par admin.js).

const PASSWORD_PROBLEMS = {
  too_short: "Au moins 12 caractères.",
  too_long: "Trop long (200 caractères au plus).",
  too_simple: "Trop simple : variez les caractères.",
  contains_username: "Le mot de passe ne doit pas contenir votre identifiant.",
};
const ROLE_LABEL = { owner: "Propriétaire", reviewer: "Relecteur" };
const ACTION_LABEL = {
  login: "connexion", login_failed: "connexion refusée", logout: "déconnexion", password_change: "mot de passe changé", "2fa_enabled": "double authentification activée",
  user_create: "compte créé", user_update: "compte modifié", user_reset_password: "mot de passe réinitialisé", user_reset_2fa: "double authentification réinitialisée", user_unlock: "compte débloqué",
  application_view: "dossier consulté", application_update: "dossier modifié", application_delete: "dossier supprimé", applications_list: "liste des dossiers", file_view: "pièce consultée",
  network_view: "réseau consulté", network_export: "réseau exporté", interviews_list: "entretiens consultés", kyc_retry: "vérification relancée", security_view: "sécurité consultée", key_rotation: "rotation de clé",
  application_self_delete: "suppression par le chauffeur",
};

export function createAccounts({ $, h, call, fmtDate, onReady, onFirstAccount }) {
  const say = (el, text, kind = "note") => { el.textContent = text ?? ""; el.className = kind; };
  const grouped = (secret) => secret.match(/.{1,4}/g).join(" ");

  /** Champ de formulaire avec son libellé. */
  const field = (id, label, attrs = {}) => h("div", { class: "field" }, h("label", { for: id }, label), h("input", { id, ...attrs }));

  // ------------------------------------------------------------ première connexion
  async function showSetup(needs) {
    $("gate").hidden = true;
    $("app").hidden = true;
    $("setup").hidden = false;
    const host = $("setup");
    const err = h("div", { class: "err", role: "alert" });
    const intro = h("p", { class: "note" }, "Première connexion : pour protéger les dossiers des chauffeurs, changez votre mot de passe provisoire puis activez la double authentification.");

    if (needs.includes("password")) {
      const form = h("form", { novalidate: true },
        h("h2", {}, "1. Choisissez votre mot de passe"),
        field("pw-current", "Mot de passe provisoire", { type: "password", autocomplete: "current-password", required: true }),
        field("pw-new", "Nouveau mot de passe (12 caractères au moins)", { type: "password", autocomplete: "new-password", required: true }),
        field("pw-confirm", "Confirmez le nouveau mot de passe", { type: "password", autocomplete: "new-password", required: true }),
        h("button", { class: "btn", type: "submit" }, "Changer mon mot de passe"));
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        say(err, "", "err");
        if ($("pw-new").value !== $("pw-confirm").value) return say(err, "Les deux mots de passe ne sont pas identiques.", "err");
        const res = await call("/me/password", { method: "POST", body: JSON.stringify({ current: $("pw-current").value, next: $("pw-new").value }) });
        const data = await res.json();
        if (!res.ok) {
          const text = data.error === "weak_password" ? PASSWORD_PROBLEMS[data.reason] : data.error === "same_password" ? "Choisissez un mot de passe différent du provisoire." : "Mot de passe provisoire incorrect.";
          return say(err, text, "err");
        }
        if (data.scope === "full") return onReady();
        showSetup(data.needs);
      });
      host.replaceChildren(h("h1", {}, "Activation de votre compte"), intro, form, err);
      $("pw-current").focus();
      return;
    }

    // Double authentification : l'application d'authentification (Google Authenticator, Microsoft Authenticator, FreeOTP...) génère les codes.
    const box = h("div", {});
    const start = h("button", { class: "btn", type: "button" }, "Activer la double authentification");
    start.addEventListener("click", async () => {
      say(err, "", "err");
      const res = await call("/2fa/setup", { method: "POST" });
      const data = await res.json();
      if (!res.ok) return say(err, "Impossible de démarrer l'activation.", "err");
      start.hidden = true;
      const form = h("form", { novalidate: true },
        h("p", {}, "Dans votre application d'authentification, ajoutez un compte avec cette clé (saisie manuelle, type « basé sur le temps »)."),
        h("p", {}, h("code", { class: "secret mono", id: "totp-secret" }, grouped(data.secret))),
        h("p", { class: "note" }, "Sur un téléphone : ", h("a", { href: data.uri }, "ouvrir directement dans l'application"), "."),
        field("totp-code", "Code à 6 chiffres affiché par l'application", { inputmode: "numeric", autocomplete: "one-time-code", maxlength: "7", required: true, dir: "ltr" }),
        h("button", { class: "btn", type: "submit" }, "Vérifier et activer"));
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        say(err, "", "err");
        const r = await call("/2fa/confirm", { method: "POST", body: JSON.stringify({ code: $("totp-code").value }) });
        const d = await r.json();
        if (!r.ok) return say(err, "Code incorrect. Vérifiez que l'heure de votre téléphone est automatique.", "err");
        const done = h("button", { class: "btn", type: "button" }, "J'ai noté mes codes de secours");
        done.addEventListener("click", () => onReady());
        host.replaceChildren(h("h1", {}, "Double authentification activée"),
          h("p", {}, "Voici vos codes de secours : chacun ne sert qu'une fois, si vous perdez votre téléphone. ", h("strong", {}, "Notez-les maintenant, ils ne seront plus jamais affichés.")),
          h("ul", { class: "recovery mono", id: "recovery-codes" }, d.recovery_codes.map((c) => h("li", {}, c))), done);
      });
      box.append(form);
    });
    host.replaceChildren(h("h1", {}, "Activation de votre compte"), intro, h("h2", {}, "2. Double authentification"), start, box, err);
  }

  // ------------------------------------------------------------ onglet « Comptes »
  async function renderView(me) {
    const host = $("view-acc");
    const result = h("div", { id: "acc-result", role: "status", class: "note" });
    const sections = [h("h2", {}, "Mon compte")];

    if (me.legacy) {
      sections.push(h("p", { class: "note" }, "Vous êtes connecté avec le jeton d'administration partagé (installation initiale). Créez ci-dessous un premier compte propriétaire : dès qu'il existe, le jeton ne donne plus aucun accès."));
    } else {
      const err = h("div", { class: "err", role: "alert" });
      const form = h("form", { class: "inline-form", novalidate: true },
        h("p", {}, `${me.user.display_name} (${me.user.username}) — ${ROLE_LABEL[me.user.role]}. Codes de secours restants : ${me.recovery_codes_left ?? 0}.`),
        field("me-current", "Mot de passe actuel", { type: "password", autocomplete: "current-password", required: true }),
        field("me-new", "Nouveau mot de passe (12 caractères au moins)", { type: "password", autocomplete: "new-password", required: true }),
        h("button", { class: "btn secondary small", type: "submit" }, "Changer mon mot de passe"), err);
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        say(err, "", "err");
        const res = await call("/me/password", { method: "POST", body: JSON.stringify({ current: $("me-current").value, next: $("me-new").value }) });
        const data = await res.json();
        if (!res.ok) return say(err, data.error === "weak_password" ? PASSWORD_PROBLEMS[data.reason] : data.error === "same_password" ? "Choisissez un mot de passe différent." : "Mot de passe actuel incorrect.", "err");
        form.reset();
        say(result, "Mot de passe changé. Vos autres appareils ont été déconnectés.");
      });
      sections.push(form);
    }

    if (me.user.role === "owner") {
      sections.push(h("h2", {}, "Comptes de l'équipe"), result, h("div", { class: "table-wrap" }, h("table", { id: "users" }, h("thead", {}, h("tr", {}, ["Identifiant", "Nom", "Rôle", "2FA", "Dernière connexion", "État", "Actions"].map((t) => h("th", {}, t)))), h("tbody", {}))));
      const createErr = h("div", { class: "err", role: "alert" });
      const create = h("form", { class: "inline-form", novalidate: true },
        h("h3", {}, "Ajouter une personne"),
        field("new-username", "Identifiant (minuscules, chiffres, . _ -)", { autocomplete: "off", required: true }),
        field("new-name", "Nom affiché", { autocomplete: "off" }),
        h("div", { class: "field" }, h("label", { for: "new-role" }, "Rôle"),
          h("select", { id: "new-role" }, h("option", { value: "reviewer" }, "Relecteur : traite les dossiers"), h("option", { value: "owner" }, "Propriétaire : gère aussi les comptes et supprime"))),
        h("button", { class: "btn small", type: "submit" }, "Créer le compte"), createErr);
      create.addEventListener("submit", async (e) => {
        e.preventDefault();
        say(createErr, "", "err");
        const res = await call("/users", { method: "POST", body: JSON.stringify({ username: $("new-username").value, display_name: $("new-name").value, role: $("new-role").value }) });
        const data = await res.json();
        if (!res.ok) return say(createErr, { username_taken: "Cet identifiant existe déjà.", invalid_username: "Identifiant invalide (3 à 32 caractères : minuscules, chiffres, . _ -).", first_must_be_owner: "Le premier compte doit être propriétaire." }[data.error] ?? "Création impossible.", "err");
        create.reset();
        // Premier compte : le jeton partagé est désormais refusé par le serveur ; on renvoie à l'écran de connexion avec le mot de passe provisoire.
        if (me.legacy) return onFirstAccount(`Compte « ${data.user.username} » créé. Mot de passe provisoire (affiché une seule fois) : ${data.temp_password}. Le jeton partagé ne donne plus accès : connectez-vous avec ce compte.`);
        say(result, `Compte « ${data.user.username} » créé. Mot de passe provisoire (affiché une seule fois) : ${data.temp_password}`);
        loadUsers(me, result);
      });
      sections.push(create, h("h2", {}, "Journal des actions"), h("div", { class: "toolbar" }, h("p", { class: "note" }, "Les 50 dernières actions, avec leur auteur. Jamais de nom, téléphone ni CIN de chauffeur : seulement la référence du dossier."),
        h("button", { id: "audit-refresh", class: "btn secondary small", type: "button" }, "Actualiser")),
      h("div", { class: "table-wrap" }, h("table", { id: "audit" }, h("thead", {}, h("tr", {}, ["Date", "Auteur", "Action", "Référence", "Adresse"].map((t) => h("th", {}, t)))), h("tbody", {}))));
    }
    host.replaceChildren(...sections);
    if (me.user.role === "owner") {
      await loadUsers(me, result);
      await loadAudit();
      $("audit-refresh").addEventListener("click", () => loadAudit());
    }
  }

  async function loadUsers(me, result) {
    const res = await call("/users");
    if (!res.ok) return;
    const { users } = await res.json();
    const act = async (label, path, opts, confirmText) => {
      if (confirmText && !confirm(confirmText)) return;
      const r = await call(path, opts);
      const data = await r.json().catch(() => ({}));
      if (!r.ok) say(result, { last_owner: "Impossible : c'est le dernier propriétaire actif.", cannot_disable_self: "Vous ne pouvez pas désactiver votre propre compte." }[data.error] ?? "Action impossible.");
      else say(result, data.temp_password ? `${label} Mot de passe provisoire (affiché une seule fois) : ${data.temp_password}` : label);
      loadUsers(me, result);
      loadAudit();
    };
    $("users").querySelector("tbody").replaceChildren(...users.map((u) => {
      const role = h("select", { "aria-label": `Rôle de ${u.username}` }, Object.entries(ROLE_LABEL).map(([v, l]) => h("option", { value: v, selected: v === u.role }, l)));
      role.addEventListener("change", () => act(`Rôle de ${u.username} modifié.`, `/users/${u.id}`, { method: "PATCH", body: JSON.stringify({ role: role.value }) }));
      const btn = (text, handler) => h("button", { type: "button", class: "btn secondary small", onclick: handler }, text);
      return h("tr", {},
        h("td", { class: "mono" }, u.username), h("td", {}, u.display_name), h("td", {}, role),
        h("td", {}, u.totp_enabled ? "Activée" : "À activer"),
        h("td", {}, u.last_login_at ? fmtDate(u.last_login_at) : "jamais"),
        h("td", {}, u.active ? (u.locked ? "Verrouillé" : "Actif") : "Désactivé"),
        h("td", {}, h("div", { class: "doc-actions" },
          u.locked ? btn("Débloquer", () => act(`${u.username} débloqué.`, `/users/${u.id}/unlock`, { method: "POST" })) : null,
          btn("Mot de passe oublié", () => act(`Mot de passe de ${u.username} réinitialisé.`, `/users/${u.id}/reset-password`, { method: "POST" }, `Réinitialiser le mot de passe de ${u.username} ? Ses sessions seront fermées.`)),
          btn("Téléphone perdu", () => act(`Double authentification de ${u.username} réinitialisée.`, `/users/${u.id}/reset-2fa`, { method: "POST" }, `Supprimer la double authentification de ${u.username} ? Elle devra en activer une nouvelle.`)),
          btn(u.active ? "Désactiver" : "Réactiver", () => act(`${u.username} ${u.active ? "désactivé" : "réactivé"}.`, `/users/${u.id}`, { method: "PATCH", body: JSON.stringify({ active: !u.active }) }, u.active ? `Désactiver le compte de ${u.username} ?` : null)))));
    }));
  }

  async function loadAudit() {
    const res = await call("/audit?limit=50");
    if (!res.ok) return;
    const { entries } = await res.json();
    $("audit").querySelector("tbody").replaceChildren(...entries.map((e) =>
      h("tr", {}, h("td", {}, fmtDate(e.at)), h("td", { class: "mono" }, e.actor ?? "—"), h("td", {}, ACTION_LABEL[e.action] ?? e.action), h("td", { class: "mono" }, e.ref ?? ""), h("td", { class: "mono" }, e.ip))));
  }

  return { showSetup, renderView };
}
