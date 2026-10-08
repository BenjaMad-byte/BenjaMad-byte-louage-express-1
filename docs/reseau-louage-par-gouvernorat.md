# Réseau de louages par gouvernorat — état de la recherche (7 octobre 2026)

> Statut : **recherche documentaire, non validée sur le terrain.** Ce document dit ce qui est établi, ce qui est supposé et ce qui manque. Rien ici ne remplace une vérification auprès des chauffeurs, des gares et des commissions régionales.

## 1. Ce qui est établi (sources publiques)

### Plusieurs catégories de transport, pas seulement « le louage »
L'annonce de la hausse des tarifs du 1er décembre 2022 (Kapitalis) distingue cinq catégories de transport non régulier, donc cinq réseaux différents :

| Catégorie | Rôle |
|---|---|
| Taxi individuel | Course en ville, compteur |
| **Taxi collectif** | Véhicule à plusieurs passagers sur trajet défini, courtes distances (tarif par tranches jusqu'à 27 km) |
| Taxi touristique | Service premium |
| **Louage** | Transport interurbain |
| **Transport rural** | Liaisons au niveau des villages |

Les lignes locales que tu cites (Redeyef, Oum Larayes, Métlaoui → Gafsa) relèvent donc sans doute d'une de ces catégories locales (louage régional, taxi collectif ou transport rural). **Je n'ai trouvé aucune source qui dise laquelle, ligne par ligne.**

### Louage régional ou interrégional
- D'après une source de voyage, les circuits **à l'intérieur d'une région** portent une **bande bleue** et les trajets **entre gouvernorats** une **bande rouge**. (Source secondaire, à confirmer ; l'article du *National* ne mentionne que des bandes rouges.)
- Idaraty confirme la distinction juridique : l'autorisation « louage » vise un opérateur « dont la zone de circulation dépasse la limite du gouvernorat » ; les autorisations régionales passent par la **commission consultative régionale** et la délivrance se fait **via le gouvernorat**.
- Textes cités : loi n° 2004-33, décret n° 2007-2202 (3 septembre 2007), arrêté du ministre du transport du 22 janvier 2010 (âge maximum 5 ans, caractéristiques techniques). Un louage prend de 4 à 8 passagers selon le véhicule (*The National*) ; Idaraty exige au moins cinq véhicules et un âge maximum de 5 ans pour un opérateur personne morale.
- Pendant certaines fêtes (Aïd), les louages peuvent être autorisés à circuler sur tout le territoire (exemple : Monastir).

### Tarifs réglementés (au 1er décembre 2022, possiblement révisés depuis)
- Louage : 850 millimes jusqu'à 10 km, puis 86 millimes/km (moins de 150 km) ou 71 millimes/km (plus de 150 km).
- Taxi collectif : de 750 à 2 300 millimes jusqu'à 27 km, puis 86 millimes/km.
- Transport rural : tranches de 750 à 850 millimes, puis 86 millimes/km.
- Bagage de plus de 10 kg : 1 000 millimes dans toutes les catégories.

### Fonctionnement en gare
Le louage ne part pas avant d'être plein (4 à 8 passagers selon le véhicule) et les prix sont généralement fixes (*The National*).

## 2. Ce que la cartographie collaborative apporte (OpenStreetMap)

J'ai extrait 109 gares ou points de louage, taxi collectif et transport rural. Elles sont listées dans [`db/osm_louage_stations.json`](../db/osm_louage_stations.json) (© OpenStreetMap contributors, licence ODbL : citer la source si réutilisé).

| Gouvernorat | Points trouvés | Louage | Taxi / taxi collectif | Rural |
|---|---|---|---|---|
| Ariana | 0 | 0 | 0 | 0 |
| Béja | 0 | 0 | 0 | 0 |
| Ben Arous | 1 | 0 | 1 | 0 |
| Bizerte | 4 | 3 | 1 | 0 |
| Gabès | 7 | 4 | 3 | 0 |
| Gafsa | 2 | 0 | 2 | 0 |
| Jendouba | 8 | 7 | 1 | 0 |
| Kairouan | 4 | 4 | 0 | 0 |
| Kasserine | 2 | 2 | 0 | 0 |
| Kébili | 2 | 1 | 1 | 0 |
| Le Kef | 2 | 2 | 0 | 0 |
| Mahdia | 5 | 5 | 0 | 0 |
| La Manouba | 0 | 0 | 0 | 0 |
| Médenine | 13 | 5 | 5 | 3 |
| Monastir | 13 | 7 | 6 | 0 |
| Nabeul | 11 | 7 | 4 | 0 |
| Sfax | 8 | 5 | 3 | 0 |
| Sidi Bouzid | 2 | 0 | 1 | 1 |
| Siliana | 1 | 1 | 0 | 0 |
| Sousse | 8 | 6 | 2 | 0 |
| Tataouine | 4 | 3 | 1 | 0 |
| Tozeur | 1 | 1 | 0 | 0 |
| Tunis | 7 | 5 | 2 | 0 |
| Zaghouan | 4 | 2 | 1 | 1 |

**Lecture honnête de ce tableau :**
- Un « 0 » ne veut pas dire « pas de gare » : il veut dire « personne ne l'a cartographiée ». Ariana, Béja et La Manouba ont certainement des gares de louage.
- Le rattachement au gouvernorat est calculé automatiquement par les coordonnées. Quelques libellés de quartier sont approximatifs.
- Aucune ligne (origine → destination) n'est décrite, seulement des gares.

### Ce que les noms de gares révèlent sur l'organisation réelle
Les noms donnés par les contributeurs montrent que le réseau est organisé **par destination**, avec plusieurs gares ou files par ville :
- **Tunis** : gares séparées par région desservie (Bab Aliwa, Moncef Bey, Bab Saadoun) ; une gare est même nommée d'après sa destination (« محطة اللواج تطاوين »).
- **Jendouba** : « Jendouba – Tabarka – Le Kef », « Bousalem – Béja – Tunis » : des gares multi-destinations.
- **Monastir** : « Monastir – Jammel – Ksar Hellal » et « Ksar Hellal – Mekmen » : des lignes courtes entre villes voisines du même gouvernorat.
- **Médenine** : « محطة النقل الريفي » à Ben Gardane pour des localités précises (Ouarsenia, Amria, Jelal) = **lignes rurales locales** ; et « اللواجات الوطنية طريق قابس » = louages nationaux dans une gare distincte.
- **Kébili** : « Gare des louages longues lignes » : la longue ligne a sa propre gare, donc les lignes locales en ont une autre.
- **Gabès** : « مركز تجمع سيارات أجرة مارث » : un point de rassemblement local à Mareth.

**Conséquence : la gare « du gouvernorat » n'existe pas en tant qu'objet unique. Il y a, par ville, plusieurs files qui correspondent chacune à une destination.**

## 3. Le cas de Gafsa (exemple donné par l'utilisateur)

| Élément | Statut |
|---|---|
| Lignes Redeyef → Gafsa, Oum Larayes → Gafsa, Métlaoui → Gafsa | **Fournies par l'utilisateur, non vérifiées** par une source publique en ligne |
| Station « taxi » de Redeyef (centre) | Trouvée dans OpenStreetMap |
| Station « taxi » de Gafsa (est) | Trouvée dans OpenStreetMap |
| Gares de Métlaoui et Oum Larayes | **Introuvables** dans les données publiques |
| Gare de louage de Gafsa | Existe, décrite comme surchargée et dégradée (Mosaïque FM) ; les destinations ne sont pas citées |
| Concurrence ferroviaire | Le train Métlaoui – Redeyef a repris le 6 novembre 2024 (SNCFT, via African Manager) |

Les communes citées sont bien dans le gouvernorat de Gafsa (bassin minier) : Redeyef, Oum Larayes et Métlaoui sont reliées par la ligne ferroviaire n° 15.

## 4. Ce qui n'a pas pu être trouvé

- Aucune **liste officielle des lignes** (ministère du Transport, gouvernorats, Idaraty) pour aucun des 24 gouvernorats.
- Aucune presse ou source en ligne qui décrive les lignes locales (de délégation vers chef-lieu) de Gafsa.
- Je n'ai pas pu consulter les groupes Facebook de chauffeurs, qui sont probablement la meilleure source réelle. Je n'ai pas accès à leurs contenus.
- Aucun jeu de données avec les horaires, le nombre de louages par ligne ou les tarifs par ligne.

Je n'ai donc **pas inventé de liste de lignes par gouvernorat** : un tableau de 24 gouvernorats avec des lignes que je ne peux pas sourcer serait faux pour des chauffeurs qui connaissent leur route par cœur.

## 5. Ce que cela change pour Louage Express

> **Mise en œuvre (7 octobre 2026) :** les points 1 à 3 sont faits dans le portail chauffeurs (type de ligne régional / interrégional, circuit ville → gouvernorat, onglet admin « Réseau par gouvernorat » et export CSV). Les points 4 et 5 concernent l'application finale et restent à faire.

1. **Le champ « ligne » du formulaire est trop pauvre.** Aujourd'hui c'est du texte libre (« Tunis – Sousse »). Il faut au minimum : gouvernorat, type de ligne (interrégionale, régionale, rurale / taxi collectif), gare de départ, destination.
2. **Le modèle de données doit représenter une ligne comme un objet** (gouvernorat, type, départ, destination, gare, origine de l'information : déclarée par un chauffeur, vue dans OSM, vérifiée par nous), pas une chaîne de texte.
3. **Le réseau se construira à partir des déclarations des chauffeurs.** Faute de source publique, les inscriptions sont la meilleure source : chaque chauffeur déclare sa ligne, un administrateur la valide, et la carte du réseau se dessine ainsi.
4. **Une gare = plusieurs files.** Le système de file d'attente (premier louage de la file reçoit la réservation) doit être géré **par gare et par destination**, pas par ville.
5. **Pas de promesse pour les lignes locales.** Le site dit déjà seulement que les chauffeurs de tous les gouvernorats peuvent s'inscrire, ce qui reste exact.

### Louage « national » et louage rural (tous deux ajoutés au formulaire)

- **Louage national** (précision du porteur du projet) : un louage qui se déplace dans tous les gouvernorats, sans ligne fixe. Un indice dans OpenStreetMap va dans ce sens : à Médenine, une gare est nommée « محطة النقل البرّي اللواجات الوطنية طريق قابس » (gare des louages nationaux). **Je n'ai pas trouvé de texte officiel qui définisse un louage « national » permanent.** Ce que les sources montrent : chaque louage a une zone de circulation inscrite sur sa carte d'exploitation, et le ministère autorise parfois, de façon **exceptionnelle** (par exemple pour l'Aïd), à circuler sur tout le territoire sans respecter cette zone. À faire confirmer par un chauffeur ou la direction régionale du transport : s'agit-il d'une licence permanente ou d'un usage exceptionnel ?
- **Louage rural (bande jaune selon une source de voyage)** : une catégorie tarifaire distincte (« transport rural »), visible aussi dans OpenStreetMap (stations de transport rural à Ben Gardane, Sidi Bouzid, Zaghouan). **Le formulaire a maintenant ce type** (octobre 2026) : *rural*, avec la même règle que le régional (l'arrivée reste dans le gouvernorat de la station), classé dans une colonne à part de l'admin. La correspondance « rural = bande jaune » vient d'une source de voyage et reste à confirmer par un chauffeur.

### Arrêts en route et départs incomplets (précision du porteur du projet)

Un louage ne roule pas toujours « plein de A vers B » :
- il prend parfois des passagers dans d'autres villes **sur son chemin**, pour continuer vers le gouvernorat d'arrivée ;
- il quitte parfois son gouvernorat **avec des places libres** et les complète plus loin.

Déjà fait : le portail demande les villes d'arrêt (jusqu'à 5) et ces deux comportements, et les affiche dans le réseau par gouvernorat.

La gestion des places (par tronçon, départs incomplets, montées en route) ne fait **pas** partie de ce site : elle sera dans une application à part. Les notes de conception sont conservées dans [`application-places-notes.md`](application-places-notes.md).

## 6. Prochaines vérifications utiles (à faire avec des gens du terrain)

- Demander à 2 ou 3 chauffeurs par gouvernorat de lister leurs lignes réelles, avec la gare et le tarif.
- Demander à la direction régionale du transport de chaque gouvernorat la liste des lignes autorisées par la commission consultative régionale (document public en principe).
- Compléter OpenStreetMap pour les trois gouvernorats vides (Ariana, Béja, La Manouba) lors d'un passage terrain.

## Sources

- Kapitalis, détail de la hausse des tarifs (1er décembre 2022) : https://kapitalis.com/tunisie/?p=5427615
- Idaraty, autorisation d'exercice du transport public routier non régulier par louage : https://idaraty.tn/fr/procedures/autorisation-d-exercice-du-transport-public-routier-non-regulier-de-personnes-par-voiture-de-louage
- The National, « Louages and lablabi keep Tunisia running » : https://www.thenationalnews.com/lifestyle/travel/louages-and-lablabi-keep-tunisia-running-1.501189
- Mosaïque FM, gare de louage de Gafsa : https://www.mosaiquefm.net/mobile/ar/أخبار-تونس-جهات/1524879/محطة-اللواج-بقفصة-معاناة-يومية-يعيشها-السائقون-والمسافرون
- African Manager, reprise du trafic Métlaoui – Redeyef : https://africanmanager.com/?p=516977
- OpenStreetMap contributors, via Overpass API et Nominatim (ODbL) : https://www.openstreetmap.org/copyright
