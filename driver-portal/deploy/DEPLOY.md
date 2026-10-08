# Déployer le portail chauffeurs

Guide pas à pas pour un **serveur Linux unique** (Debian 12 ou Ubuntu 24.04 LTS) : HTTPS automatique, disque de données chiffré, secrets hors du code, sauvegardes chiffrées.

> **Statut : rien de ce qui suit n'a été exécuté sur un vrai serveur.** Le code, la vérification de configuration, le générateur de secrets et le script de recette sont testés ; les fichiers `Caddyfile`, `nginx.conf`, `*.service` et `backup.sh` n'ont pas pu être validés ici (outils absents). Chaque étape donne la commande qui les valide chez toi : **ne passe à l'étape suivante que si elle réussit.**

## 0. Trois décisions avant de commencer

1. **Où héberger.** Le portail stocke des CIN, des permis et des visages de Tunisiens. Un serveur **hors de Tunisie** est un transfert de données à l'étranger, qui doit être couvert par l'INPDP. Le plus simple est un hébergeur **en Tunisie** ; sinon, l'inclure dans la demande à l'INPDP (comme le transfert vers AWS).
2. **Le fournisseur de SMS.** Twilio reçoit les numéros de téléphone des chauffeurs (serveurs hors de Tunisie) : même remarque. Un opérateur ou une passerelle SMS tunisienne évite la question. Le code ne sait parler qu'à Twilio pour l'instant.
3. **Le nom de domaine** (ex. `inscription.exemple.tn`) : un enregistrement DNS `A` (et `AAAA`) vers l'IP du serveur, créé avant l'étape 7.

## 1. Préparer le serveur

```bash
# En tant qu'administrateur (sudo). Connexion SSH par clé uniquement, mots de passe désactivés.
sudo apt update && sudo apt -y upgrade
sudo apt -y install ufw unattended-upgrades sqlite3 age cryptsetup curl git
sudo dpkg-reconfigure -plow unattended-upgrades          # mises à jour de sécurité automatiques

# Pare-feu : SSH, HTTP (pour le certificat), HTTPS. Rien d'autre : les ports 4100 et 4000 ne sont PAS ouverts.
sudo ufw default deny incoming && sudo ufw default allow outgoing
sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
sudo ufw enable

# Compte de service sans connexion possible
sudo useradd --system --home /opt/louage-express --shell /usr/sbin/nologin louage
```

**Node.js** : version testée **24 (LTS)** ; les versions plus anciennes n'ont pas été essayées (le module `node:sqlite` est récent). Installer depuis nodejs.org ou NodeSource ; vérifier : `node --version`.

## 2. Installer le code

```bash
sudo mkdir -p /opt/louage-express && sudo chown "$USER" /opt/louage-express
# Copier le dossier du projet (git clone, scp ou rsync) dans /opt/louage-express, puis :
cd /opt/louage-express/driver-portal && npm ci --omit=dev
cd /opt/louage-express/backend       && npm ci --omit=dev
sudo chown -R root:louage /opt/louage-express && sudo chmod -R o-rwx /opt/louage-express   # le service lit, n'écrit pas
```

## 3. Disque de données chiffré (LUKS)

Tout ce qui est sensible (base SQLite, pièces, sauvegardes) vit dans **un volume chiffré** monté sur `/srv/louage`. Si le disque est volé, copié ou récupéré par l'hébergeur, il est illisible sans la phrase de passe.

```bash
lsblk                                   # repérer le volume ajouté (ex. /dev/sdb) : VÉRIFIER, la commande suivante EFFACE le disque
sudo cryptsetup luksFormat --type luks2 /dev/sdb      # taper YES en majuscules, choisir une phrase de passe LONGUE
sudo cryptsetup open /dev/sdb louage
sudo mkfs.ext4 /dev/mapper/louage
sudo mkdir -p /srv/louage && sudo mount /dev/mapper/louage /srv/louage
sudo mkdir -p /srv/louage/data /srv/louage/backups
sudo chown -R louage:louage /srv/louage/data && sudo chmod 700 /srv/louage/data
sudo chmod 700 /srv/louage/backups

# Sauvegarde de l'en-tête LUKS : si elle est abîmée, TOUT le volume est perdu. À ranger HORS du serveur.
sudo cryptsetup luksHeaderBackup /dev/sdb --header-backup-file ~/luks-header-louage.img
```

**Vérifier :** `sudo cryptsetup status louage` doit afficher `type: LUKS2`, `cipher: aes-xts-plain64`, et `lsblk -f` doit montrer `crypto_LUKS` sur `/dev/sdb`.

**Au redémarrage du serveur**, le volume reste verrouillé tant que personne ne tape la phrase de passe : c'est voulu (un serveur volé éteint ne livre rien). Les services (`RequiresMountsFor=/srv/louage`) ne démarrent donc pas seuls. Après chaque reboot :

```bash
sudo cryptsetup open /dev/sdb louage && sudo mount /dev/mapper/louage /srv/louage
sudo systemctl start louage-kyc louage-portal
```

| Option | Sécurité | Contrepartie |
|---|---|---|
| **Déverrouillage manuel** (recommandé au début) | Maximale | Le site est coupé après un reboot tant que tu n'es pas connecté |
| Fichier-clé sur le disque système | Protège contre le vol du seul disque de données | Ne protège pas contre le vol du serveur entier |
| TPM / Clevis-Tang | Bon compromis | Plus technique à monter |

- **Pas de disque supplémentaire ?** Utiliser un fichier conteneur : `sudo fallocate -l 20G /var/lib/louage.img`, puis les mêmes commandes `cryptsetup` sur ce fichier (via `losetup`). Moins propre mais valable.
- **Swap** : la mémoire contient des données déchiffrées. Désactiver le swap (`sudo swapoff -a`, retirer la ligne de `/etc/fstab`) ou le chiffrer.
- **Serveur Windows** : BitLocker sur le volume de données (`manage-bde -on D: -RecoveryPassword`), clé de récupération rangée hors du serveur.

## 4. Secrets et configuration

```bash
cd /opt/louage-express/driver-portal
node deploy/secrets.js            # affiche ADMIN_TOKEN, DATA_KEY, OTP_SECRET, KYC_SERVICE_KEY (une seule fois)
```

1. **Copie immédiatement `DATA_KEY` dans un gestionnaire de mots de passe, et une copie papier dans un coffre.** Sans elle, les CIN et les selfies déjà enregistrés sont **perdus à jamais** (et elle ne se récupère pas depuis le serveur : c'est le but).
2. Créer les deux fichiers d'environnement :

```bash
sudo mkdir -p /etc/louage
sudo cp deploy/portal.env.example /etc/louage/portal.env
sudo cp deploy/kyc.env.example    /etc/louage/kyc.env
sudo chown root:root /etc/louage/*.env && sudo chmod 600 /etc/louage/*.env
sudoedit /etc/louage/portal.env     # remplacer tous les CHANGE_ME ; ADMIN_ALLOWED_IPS = l'IP de ton bureau ; remplir les LEGAL_* (voir ci-dessous)
sudoedit /etc/louage/kyc.env        # KYC_SERVICE_KEY = la MÊME valeur que dans portal.env
```

3. **Vérifier la configuration** (ne montre jamais les secrets) :

```bash
sudo node deploy/check-config.js /etc/louage/portal.env      # doit afficher « ✔ Configuration valide. »
```

Les variables `LEGAL_*` alimentent les pages `/privacy`, `/terms` et `/legal` : nom et adresse de l'éditeur, e-mail pour exercer ses droits, hébergeur, durées de conservation (décisions D5 du plan). **Le démarrage est refusé tant qu'elles manquent** : aucune identité n'est inventée dans les textes. Les durées que tu y écris sont **celles que le site promet publiquement** : choisis-les avec l'INPDP, et ne mets en ligne qu'une fois la suppression automatique en place (voir section 10).

Les avertissements `⚠` ne bloquent pas mais méritent d'être lus (liste blanche d'IP vide, `HOST` différent de `127.0.0.1`, droits du fichier).

## 5. Démarrer les services

```bash
sudo cp deploy/louage-kyc.service deploy/louage-portal.service /etc/systemd/system/
sudo systemd-analyze verify /etc/systemd/system/louage-*.service      # ne doit rien afficher d'inquiétant
sudo systemctl daemon-reload
sudo systemctl enable --now louage-kyc louage-portal
systemctl status louage-kyc louage-portal --no-pager
curl -s http://127.0.0.1:4100/healthz         # {"ok":true}
journalctl -u louage-portal -n 30 --no-pager  # aucun « DATA_KEY non défini », aucune erreur
```

Si `louage-portal` refuse de démarrer, `journalctl -u louage-portal` liste tout ce qui manque dans la configuration.

Le backend KYC est un **prototype** (état en mémoire, autres routes non protégées) : il n'écoute que `127.0.0.1` et le pare-feu ne l'expose pas. Ne jamais l'ouvrir sur Internet.

## 6. HTTPS

**Option A : Caddy (recommandé, certificat automatique)**

```bash
sudo apt -y install caddy          # ou le dépôt officiel Caddy
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudoedit /etc/caddy/Caddyfile      # remplacer inscription.exemple.tn par ton domaine
sudo caddy validate --config /etc/caddy/Caddyfile
sudo mkdir -p /var/log/caddy && sudo chown caddy:caddy /var/log/caddy
sudo systemctl reload caddy
```

**Option B : nginx + certbot**

```bash
sudo apt -y install nginx certbot python3-certbot-nginx
sudo cp deploy/nginx.conf /etc/nginx/sites-available/louage && sudo ln -s /etc/nginx/sites-available/louage /etc/nginx/sites-enabled/
sudoedit /etc/nginx/sites-available/louage      # remplacer le domaine
sudo certbot --nginx -d inscription.exemple.tn
sudo nginx -t && sudo systemctl reload nginx
```

Dans les deux cas le proxy **doit** transmettre `Host` et `X-Forwarded-Proto` (déjà fait dans les fichiers fournis) : sinon l'application redirige en boucle ou refuse les envois du site.

## 7. Recette après déploiement

```bash
./deploy/smoke-test.sh https://inscription.exemple.tn
ADMIN_TOKEN='...' ./deploy/smoke-test.sh https://inscription.exemple.tn     # vérifie aussi le jeton : accepté avant le premier compte, refusé après
```

Tout doit être `✔`. Puis à la main :

1. Ouvrir le site sur **un vrai téléphone** : la caméra exige HTTPS, c'est le premier vrai test des selfies.
2. Faire **une vraie inscription** avec ton numéro : reçois-tu le SMS ? Le dossier apparaît-il dans `/admin` ? Les pièces s'ouvrent-elles ?
3. Sur le serveur : `sudo head -c 8 /srv/louage/data/uploads/* | xxd | head` ne doit **pas** montrer d'en-tête d'image (`ffd8` ou `8950 4e47`) : les fichiers sont chiffrés.
4. SSL Labs (ssllabs.com/ssltest) : viser A ou A+. securityheaders.com : viser A.
5. **Aperçu de lien** : colle l'adresse du site dans une conversation WhatsApp (à toi-même) : l'image, le titre et le texte doivent apparaître. WhatsApp garde un aperçu en cache : après une correction, tester avec une adresse légèrement différente (`?v=2`) ou attendre. Facebook propose un outil de débogage des partages (developers.facebook.com/tools/debug).

## 8. Sauvegardes

```bash
# Une fois, SUR TON POSTE (pas sur le serveur) : créer la paire de clés. La clé PRIVÉE ne va jamais sur le serveur.
age-keygen -o age-key.txt            # affiche la clé publique « age1... »

# Sur le serveur : planifier chaque nuit (avec la clé PUBLIQUE seulement)
sudo crontab -e
#   30 2 * * *  AGE_RECIPIENT=age1xxxxxxxx /opt/louage-express/driver-portal/deploy/backup.sh >> /var/log/louage-backup.log 2>&1
```

Copier ensuite `/srv/louage/backups/` **hors du serveur** (rclone, scp…) : une sauvegarde sur la même machine ne protège ni d'un vol ni d'un incendie.

**Teste la restauration avant d'en avoir besoin** (une sauvegarde jamais restaurée n'est pas une sauvegarde) :

```bash
age -d -i age-key.txt louage-AAAAMMJJ....tar.age | tar -x -C /tmp/restore     # sur ton poste
sudo systemctl stop louage-portal
sudo rm -f /srv/louage/data/portal.db-wal /srv/louage/data/portal.db-shm
sudo cp /tmp/restore/portal.db /srv/louage/data/ && sudo rsync -a /tmp/restore/uploads/ /srv/louage/data/uploads/
sudo chown -R louage:louage /srv/louage/data && sudo systemctl start louage-portal
```

La base restaurée ne se relit qu'avec la **même `DATA_KEY`** pour les pièces.

## 9. Exploitation

| Tâche | Comment |
|---|---|
| Logs | `journalctl -u louage-portal -f` (aucun numéro de téléphone ni CIN n'y est écrit) |
| Supervision | Sonde externe sur `https://domaine/healthz` (attendu `{"ok":true}`) |
| Qui a consulté quoi | Console admin ou `GET /api/admin/audit` : à relire régulièrement, surtout les `file_view` |
| Changer le jeton admin | Nouveau `ADMIN_TOKEN` dans `portal.env`, `sudo systemctl restart louage-portal` (le jeton ne sert qu'avant le premier compte) |
| Compte admin bloqué, mot de passe ou téléphone perdu | Un propriétaire : onglet Comptes. Sinon sur le serveur : `npm run admin -- unlock\|reset-password\|reset-2fa <identifiant>` |
| Changer la clé du backend KYC | Même valeur dans `portal.env` ET `kyc.env`, redémarrer les deux services |
| Mises à jour des dépendances | `npm audit --omit=dev` puis `npm update` et relancer `npm test` |
| Mise à jour du code | Copier la nouvelle version, `npm ci --omit=dev`, `sudo systemctl restart louage-portal` |

### Rotation de la clé de chiffrement (`DATA_KEY`)

À faire : une fois par an, **immédiatement si la clé a pu fuiter** (poste volé, ancien prestataire, copie égarée), et lors du départ d'une personne qui la connaissait.

Principe : pendant la rotation le serveur connaît deux clés. `DATA_KEY` (la nouvelle) **écrit** ; `DATA_KEY_PREVIOUS` (l'ancienne) ne sert qu'à **lire**. L'outil rechiffre ensuite tous les fichiers, puis on retire l'ancienne.

1. **Sauvegarde fraîche** : lancer `backup.sh` et vérifier qu'elle se restaure. C'est le filet si quelque chose tourne mal.
2. **Répétition** (la première fois) : restaurer cette sauvegarde sur une machine de test et y dérouler les étapes 3 à 6.
3. **Nouvelle clé** : `node deploy/secrets.js` → copier la ligne `DATA_KEY=...` et la **sauvegarder tout de suite** (gestionnaire de mots de passe + papier), comme la première.
4. **Environnement** (`/etc/louage/portal.env`) : mettre l'**ancienne** valeur dans `DATA_KEY_PREVIOUS=` et la **nouvelle** dans `DATA_KEY=`. `sudo node deploy/check-config.js /etc/louage/portal.env` doit répondre « valide » (avec un avertissement « rotation en cours »), puis `sudo systemctl restart louage-portal`. Les nouveaux envois sont chiffrés avec la nouvelle clé ; les anciens restent lisibles.
5. **Rechiffrer** : voir l'état (`--status`, ne modifie rien), puis lancer.
   ```bash
   cd /opt/louage-express/driver-portal
   set -a; . /etc/louage/portal.env; set +a            # charge les variables sans les afficher
   sudo -E -u louage node rotate-key.js --status      # « N fichier(s) à rechiffrer »
   sudo -E -u louage node rotate-key.js
   ```
   Le site reste en ligne. En cas de coupure, relancer la même commande : elle reprend où elle s'est arrêtée. Un fichier en échec reste **intact** sur son ancienne clé et est listé.
6. **Vérifier** : `--status` doit afficher **« 0 fichier(s) à rechiffrer »**, et la page `/admin` doit toujours ouvrir une pièce. Ensuite seulement :
7. **Retirer `DATA_KEY_PREVIOUS`** du fichier d'environnement… **mais pas avant** que les sauvegardes faites avec l'ancienne clé aient expiré (14 jours par défaut, voir `KEEP_DAYS`) : ces sauvegardes ne se relisent **qu'avec l'ancienne clé**. **Garde l'ancienne clé archivée** (hors serveur) au moins aussi longtemps que la plus ancienne sauvegarde. Redémarrer le service.

Si la clé a **fuité** : la rotation protège les pièces **sur le serveur**, mais pas les anciennes sauvegardes ni les copies déjà prises (elles restent lisibles avec la clé volée). Détruire les anciennes sauvegardes dès que possible, et décider avec l'INPDP s'il s'agit d'une violation de données à déclarer.

**Si le service refuse de démarrer** après une manipulation : le message cite l'**empreinte** de la clé manquante (jamais la clé). Remettre la clé correspondante dans `DATA_KEY_PREVIOUS` (ou `DATA_KEY`) et relancer. `GET /api/admin/security` et `rotate-key.js --status` donnent le même diagnostic.

## 10. Limites connues (à connaître avant la mise en ligne)

- **Rotation de `DATA_KEY` : outil prêt mais jamais essayé sur ton serveur.** Il est testé automatiquement (pannes, coupures, mauvaise clé), pas en conditions réelles : **fais d'abord une répétition sur une copie** (étape de la section 9).
- **La base SQLite n'est pas chiffrée par l'application** (noms, téléphones, numéros de CIN) : seul le chiffrement du disque (étape 3) la protège. Pas de chiffrement des colonnes.
- **Un seul serveur** : pas de haute disponibilité ; un reboot demande ta présence (déverrouillage du volume).
- **Jeton admin partagé** : pas de comptes nominatifs ni de double authentification.
- **Purge automatique : testée, jamais vue tourner en vrai.** Le serveur supprime chaque jour les dossiers refusés ou abandonnés au-delà de `LEGAL_RETENTION_REJECTED_MONTHS`, et les chauffeurs acceptés `LEGAL_RETENTION_APPROVED_MONTHS` après la **fin de collaboration que tu marques dans l'admin** (case « Collaboration terminée ») : sans ce clic, un chauffeur accepté n'est jamais supprimé. **Avant la mise en ligne, lance `npm run purge -- --dry-run`** sur des données de test pour voir ce qui serait supprimé. Le journal (`admin_audit`) garde la référence de chaque suppression.
- **Les sauvegardes gardent ce qui a été supprimé** jusqu'à leur expiration (`KEEP_DAYS`, 14 jours par défaut) : `LEGAL_BACKUP_DAYS` doit avoir la MÊME valeur, la politique l'annonce. Si tu restaures une sauvegarde, **relance la purge et re-supprime les dossiers que des chauffeurs avaient déjà effacés** (le journal en garde la liste des références).
- **Textes légaux = projet** : rédigés à partir de ce que fait le site, non relus par un juriste ni par l'INPDP ; relecture arabe par un locuteur natif à faire.
- **Backend KYC prototype** : sans moteur AWS, aucun dossier n'est jamais « vérifié » automatiquement (tous passent en « À examiner ») ; l'activer envoie visage et CIN hors de Tunisie (voir `kyc.env.example`).
- Aucun test de charge ni test d'intrusion externe n'a été réalisé.

## 11. Liste de mise en ligne

- [ ] Hébergement et SMS validés au regard de l'INPDP (étape 0)
- [ ] Déclaration / autorisation INPDP obtenue avant de collecter de vraies données
- [ ] Volume LUKS créé, en-tête sauvegardé hors serveur, swap désactivé
- [ ] `DATA_KEY` sauvegardée hors serveur (gestionnaire de mots de passe + papier)
- [ ] Rotation de clé répétée une fois sur une copie (section 9)
- [ ] Pages légales relues (juriste ou INPDP), `LEGAL_*` renseignées (`LEGAL_BACKUP_DAYS` = `KEEP_DAYS`)
- [ ] Comptes admin : premier compte propriétaire créé (`npm run admin -- create <identifiant>`), double authentification activée sur un vrai téléphone, **codes de secours imprimés et rangés**, un second propriétaire créé (sinon un téléphone perdu bloque tout), `ADMIN_TOKEN` désormais sans effet
- [ ] SMS de notification : `SMS_NOTIFICATIONS=on` seulement après un essai réel (statut changé dans l'admin → SMS reçu sur un téléphone de chaque opérateur), plafond `NOTIFY_DAILY_CAP` adapté au budget
- [ ] `npm run purge -- --dry-run` essayé sur des données de test ; équipe informée qu'il faut cocher « Collaboration terminée »
- [ ] Un chauffeur de test a supprimé sa propre demande depuis la page de suivi (code SMS reçu)
- [ ] `check-config.js` : « Configuration valide » sans avertissement important
- [ ] `smoke-test.sh` : tout `✔` sur le domaine réel
- [ ] Vraie inscription faite depuis un téléphone (SMS, caméra, pièces)
- [ ] Sauvegarde nocturne planifiée **et restauration testée**
- [ ] Sonde de supervision sur `/healthz`
- [ ] `ADMIN_ALLOWED_IPS` renseignée
