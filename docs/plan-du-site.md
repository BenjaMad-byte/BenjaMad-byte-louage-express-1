# Plan du site d'inscription des chauffeurs de louage

> Plan établi le 7 octobre 2026. Les tailles sont des **estimations de mon travail** (S ≤ 1 jour, M 2 à 4 jours, L 1 à 2 semaines), hors délais d'attente externes (INPDP, hébergeur, opérateurs SMS) que je ne peux pas estimer et que je n'ai pas inventés.

## 1. Objectif et périmètre

**Objectif.** Un site **réservé aux chauffeurs de louage** pour s'inscrire à distance (identité vérifiée, ligne déclarée), réserver un entretien, suivre sa demande ; et une console pour l'équipe qui valide les dossiers.

**Hors périmètre** (autres projets) : gestion des places par tronçon, application chauffeur, application passagers, paiement SVA, géolocalisation en gare.

## 2. État actuel (vérifié)

| Domaine | État |
|---|---|
| Parcours chauffeur | Inscription (SMS, documents, selfies, ligne : régional / interrégional / rural / national, arrêts en route), tampons de villes, suivi par référence + téléphone, réservation d'entretien |
| Console admin | Dossiers, résultat de la vérification d'identité, entretiens, réseau par gouvernorat + export CSV, journal d'accès |
| Accueil | 5 scènes (hero, gare, 24 gouvernorats, étapes, confiance), arabe/français, clair/sombre |
| Sécurité | Pièces chiffrées au repos, HTTPS forcé, anti-CSRF, limites de débit, 0 vulnérabilité connue |
| Déploiement | Guide + outils prêts (`deploy/`), **non exécutés sur un vrai serveur** |
| Tests | 103 tests serveur, couverture 96 %. **Aucun test automatisé du navigateur** |
| Manques constatés | Pages légales faites en projet (non relues) ; la purge est faite mais jamais vue tourner sur de vraies durées ; aucun test avec un vrai SMS |

## 3. Chemin critique

```
Décision hébergeur + SMS ──► déploiement ──► tests réels ──┐
                                                            ├──► PILOTE avec de vraies données
INPDP (démarche) ──► pages légales ──► conservation ────────┘
```

**Règle : aucune vraie CIN ni aucun vrai visage ne doit être collecté avant l'accord de l'INPDP.** Tout le reste peut être construit, déployé et testé en attendant avec des données fictives.

## 4. Phase 0 : décisions et démarches (toi, tout de suite, en parallèle)

| # | Décision / démarche | Pourquoi | Débloque |
|---|---|---|---|
| D1 | **Hébergeur** (en Tunisie de préférence) | Serveur hors Tunisie = transfert à l'étranger à couvrir | Déploiement, dossier INPDP |
| D2 | **Fournisseur de SMS** | Twilio envoie les numéros hors de Tunisie ; livraison réelle chez Ooredoo, Orange, TT jamais testée | Notifications, pilote |
| D3 | **Nom de domaine** | Certificat HTTPS, lien partagé sur WhatsApp | Déploiement |
| D4 | **Dossier INPDP** : collecte de CIN, permis, visage ; transfert éventuel vers AWS ; SMS | Obligation légale avant collecte | Pilote réel |
| D5 | **Durée de conservation** (dossiers acceptés, refusés, selfies) | Exigée dans la démarche | Page de confidentialité, purge automatique |
| D6 | **Qui valide les dossiers**, avec quels délais, et qui mène les entretiens | Détermine les comptes admin et les notifications | Phase 1, point 9 |

Le message pour l'INPDP est prêt à être rédigé quand tu le demandes.

## 5. Phase 1 : prêt pour un pilote (≈ 2 à 3 semaines de travail)

| # | Tâche | Taille | Dépend de | Critère de fin |
|---|---|---|---|---|
| 1 | ~~**Pages légales**~~ **Faites le 7 octobre 2026** (projet de texte) : `/privacy`, `/terms`, `/legal` en arabe et français, liées depuis le pied de page et le consentement ; identité de l'éditeur, hébergeur et durées lues dans `LEGAL_*` (démarrage refusé en production si absentes). **Reste** : décider les durées (D5) et l'éditeur (D1), relecture par une personne compétente (juriste ou INPDP), relecture de l'arabe par un locuteur natif, ajouter une mention de la conservation locale du brouillon si elle change | M | D4, D5 | Le texte dit ce qui est collecté, pourquoi, combien de temps, vers qui, comment supprimer ; relu par une personne compétente |
| 2 | ~~**Droits des personnes**~~ **Fait le 7 octobre 2026** : bouton « Supprimer ma demande » sur la page de suivi, confirmé par code SMS ; efface dossier, pièces, entretiens et vérification d'identité, tracé par la référence seule. **Reste** : essai avec un vrai SMS ; accès et rectification se font par e-mail (pas d'outil) | M | 1 | Suppression effective (base + fichiers), tracée dans le journal |
| 3 | ~~**Conservation automatique**~~ **Faite le 7 octobre 2026** : purge quotidienne (refusés, abandonnés, acceptés après la fin de collaboration marquée dans l'admin), `npm run purge -- --dry-run`, journal des suppressions. **Reste** : la voir tourner sur de vraies durées (D5) ; décision à prendre sur ce qu'on garde (statistiques) après suppression ; les sauvegardes gardent les données jusqu'à leur expiration | M | D5 | Test automatique de la purge ; journal des suppressions |
| 4 | ~~**Balises de partage et finitions**~~ **Fait le 7 octobre 2026** : description, Open Graph, image 1200×630, favicon, icônes, manifeste, couleur de thème, page 404, message sans JavaScript, robots.txt, sitemap.xml. **Reste à vérifier** : l'aperçu réel dans WhatsApp, une fois le domaine (D3) choisi | S | D3 | Aperçu correct dans WhatsApp ; page 404 en arabe et français |
| 5 | ~~**Notifications de statut**~~ **Faites le 7 octobre 2026** (désactivées par défaut, `SMS_NOTIFICATIONS=on`) : SMS au changement de statut, à la confirmation d'entretien et en rappel, file d'attente avec réessais, plafond quotidien, case « prévenir » dans l'admin. **Reste** : essai sur un vrai téléphone chez les 3 opérateurs ; coût réel à mesurer ; relecture des messages arabes ; un SMS en arabe coûte plus de segments (UCS-2, 70 caractères) | M | D2 | SMS reçu sur un vrai téléphone ; quota et coût plafonnés |
| 6 | **Relecture de tous les textes arabes** par un locuteur natif ; vérification des lignes culturelles des villes | S | toi | Liste de corrections appliquée |
| 7 | **Tests réels** : SMS chez les 3 opérateurs, téléphone Android d'entrée de gamme en 3G, 10 vraies CIN pour l'OCR | M | D2 | Taux de réussite mesuré et noté ; réglages d'OCR ajustés |
| 8 | **Mise en ligne** selon `deploy/DEPLOY.md`, recette, **restauration d'une sauvegarde testée** | M | D1, D3 | Recette `smoke-test.sh` toute verte ; sauvegarde restaurée sur une machine de test |
| 9 | ~~**Console de validation**~~ **Faite le 7 octobre 2026** : filtres par gouvernorat, type de ligne, statut et identité, recherche (nom, téléphone, référence, CIN), tri, compteurs, pagination, « enregistrer et passer au suivant ». **Reste à vérifier** : qu'une personne de l'équipe traite 20 vrais dossiers sans friction (critère du pilote) | M | D6 | Une personne traite 20 dossiers sans friction |
| 10 | ~~**Comptes admin nominatifs + double authentification**~~ **Faits le 7 octobre 2026** : comptes avec mot de passe et TOTP, codes de secours, deux rôles, sessions côté serveur, blocage après 5 échecs, journal nominatif, onglet « Comptes », `npm run admin`. **Reste** : essai avec les vraies personnes et de vrais téléphones ; pas de QR code ; pas de liste de mots de passe compromis ; décider qui est propriétaire (D6) | L | D6 | Chaque action du journal porte un nom |

**Pilote proposé** : 20 chauffeurs d'un ou deux gouvernorats, suivis un par un, après l'accord de l'INPDP.

## 6. Phase 2 : fiabilité et qualité (en parallèle du pilote)

| Tâche | Taille | Pourquoi |
|---|---|---|
| ~~Tests automatisés du navigateur~~ **Faits le 7 octobre 2026** : 29 tests (`npm run test:e2e`) couvrant l'inscription avec caméra simulée, les règles du formulaire, les pages publiques, le suivi, l'entretien et la console admin. **Intégration continue écrite le 7 octobre 2026** (GitHub Actions, seuils de couverture, contrôles d'hygiène, audit des dépendances, Dependabot : voir le README). **Reste** : créer le dépôt privé et pousser le code, puis corriger ce que le premier passage sur Linux révélera ; le backend KYC n'est pas couvert | M | Le parcours chauffeur n'est plus testé à la main |
| Audit d'accessibilité : **la partie automatique est faite** (axe-core, aucune faille sérieuse sur toutes les pages, 2 langues, 2 thèmes). **Reste** : essai au clavier, avec un lecteur d'écran en arabe, et par une personne peu à l'aise avec le numérique | M | Public varié, parfois peu à l'aise avec le numérique |
| Budget de performance en 3G (page d'accueil < 1 Mo, formulaire utilisable hors connexion stable) | S | Chauffeurs souvent en 4G faible |
| ~~**Brouillon du formulaire conservé sur le téléphone**~~ **Fait le 7 octobre 2026** : saisie gardée 3 jours sur l'appareil (sans photos, sans CIN, sans consentements), avis de restauration, bouton « Effacer et recommencer », vérification du téléphone conservée pour l'onglet. **Reste** : mentionner cette conservation locale dans la politique de confidentialité (point 1 de la phase 1) | M | Éviter de tout ressaisir après une coupure |
| ~~**Suggestions de villes par gouvernorat**~~ **Faites le 7 octobre 2026** : 264 délégations + chefs-lieux en arabe et français (source OpenStreetMap, ODbL), liste proposée dans le formulaire, « الرديف » / « Redeyef » / « Rdayef » fusionnés dans le réseau, villes inconnues signalées dans l'admin. **Reste** : relecture des orthographes par une personne du terrain ; villages et imadas non inclus (saisie libre) ; mention de la source ODbL dans la page légale | M | Qualité de la donnée du réseau |
| Supervision : alerte sur `/healthz`, journaux, procédure d'incident | S | Savoir quand le site est tombé |
| ~~Rotation de la clé de chiffrement `DATA_KEY`~~ **Faite le 7 octobre 2026** : deux clés pendant la transition, empreinte par fichier, `npm run rotate-key` (reprise après coupure, vérification avant remplacement), détection d'une mauvaise clé au démarrage. **Reste** : la répéter sur une copie réelle avant de s'y fier (procédure : `deploy/DEPLOY.md`, section 9) | M | Changer la clé sans perdre les pièces |
| Test d'intrusion externe avant ouverture large | L | Mon travail est une revue de code, pas un audit indépendant |

## 7. Phase 3 : vérification d'identité renforcée (après l'accord sur le transfert à l'étranger)

| Tâche | Taille | Remarque |
|---|---|---|
| Activer AWS Rekognition, seuils, tests sur de vraies CIN | M | **Interdit tant que l'INPDP n'a pas couvert le transfert** |
| Détection de vivacité sérieuse (aujourd'hui : simple mouvement entre photos) | L | Une photo d'écran peut encore passer ; d'où la décision humaine |
| Alternative auto-hébergée en Tunisie (évaluation) | L | Évite le transfert à l'étranger ; qualité à mesurer |

D'ici là, **aucun dossier n'est jamais vérifié automatiquement** : tous passent en « À examiner » et une personne décide.

## 8. Phase 4 : identité visuelle et expérience

| Tâche | Taille | Remarque |
|---|---|---|
| Vraies photos de louage et de gare à la place des images générées | S | Dépend de toi (prise de vue) ; retirer la mention « Image illustrative » |
| Les 24 emblèmes de gouvernorats et la carte tactile | L | J'ai besoin de ton avis sur le symbole de chaque gouvernorat ; tracé de carte à partir d'une source géographique fiable |
| Page de suivi « votre rang dans la file » | S à M | N'a de sens que si l'équipe traite réellement les dossiers dans l'ordre |
| Courtes vidéos d'ambiance (prompts Flow déjà écrits) | S | Facultatif, poids à surveiller |

## 9. Mesures de réussite du pilote

- **Taux de complétion** de l'inscription (démarrée → envoyée) et temps médian.
- **Dossiers « À examiner » pour une raison technique** (OCR, photo floue) : à réduire.
- **Délai de traitement** d'un dossier par l'équipe.
- **Présence aux entretiens**.
- **SMS livrés** par opérateur.

Le site n'utilise ni cookie ni outil de suivi : les premières mesures viennent de la base ; le taux d'abandon par étape demandera un compteur anonyme (à décider, avec le texte de confidentialité).

## 10. Risques

| Risque | Effet | Parade |
|---|---|---|
| Délai de l'INPDP | Pilote repoussé | Tout construire et tester avec des données fictives ; démarche lancée en premier |
| OCR peu fiable sur de vraies CIN | Beaucoup de dossiers « À examiner » | Test réel (point 7), décision humaine déjà prévue |
| Abandon du formulaire sur mobile / 3G | Peu d'inscriptions | Brouillon conservé, test réel, budget de performance |
| Usurpation d'identité / faux dossiers | Mauvais chauffeurs acceptés | Entretien systématique, décision humaine, journal d'accès |
| Coût des SMS | Facture imprévue | Plafond quotidien déjà en place ; mesurer au pilote |
| Tout repose sur une personne (toi) | Goulot d'étranglement | Comptes admin multiples (point 10), procédure écrite |
| Perte de `DATA_KEY` | Pièces perdues | Sauvegarde hors serveur, rappelée dans le guide |

## 11. Ordre de travail que je recommande

1. **Toi, cette semaine** : D1 à D6, et le dossier INPDP (je rédige le message).
2. **Moi, sans attendre personne** : point 4 (balises de partage, 404, finitions), point 9 (console), tests du navigateur, brouillon du formulaire.
3. **Dès que D4/D5 sont fixés** : pages légales, droits des personnes, conservation.
4. **Dès que D1/D2/D3 sont fixés** : notifications, mise en ligne sur un serveur de test, tests réels.
5. **Pilote** après l'accord de l'INPDP.
