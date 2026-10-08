# Message à l'INPDP : demande d'avis, de déclaration et d'autorisation

> Projet rédigé le 8 octobre 2026 à partir de ce que le site fait réellement (code, tests et documents du projet). **Je ne suis pas juriste.** Avant l'envoi : remplir tous les `[À COMPLÉTER]`, vérifier sur le site de l'INPDP la procédure et les formulaires officiels en vigueur (déclaration, autorisation, transfert à l'étranger) et faire relire par une personne compétente. Aucune donnée réelle de chauffeur n'a été collectée à ce jour : le site n'est pas encore en ligne.
>
> Ce document contient : **1.** la lettre d'envoi (français), **2.** la fiche descriptive du traitement (annexe, à joindre), **3.** la lettre en arabe (traduction à faire relire par un locuteur natif), **4.** la liste de ce qu'il reste à décider avant l'envoi.

---

## 1. Lettre d'envoi

**Objet : demande d'avis et d'autorisation préalables — plateforme d'inscription à distance de chauffeurs de louage (vérification d'identité, SMS, transfert éventuel de données à l'étranger)**

À l'attention de Madame / Monsieur le Président de l'Instance Nationale de Protection des Données Personnelles

[Ville], le [date]

Madame, Monsieur,

Je me permets de vous écrire au nom de **[NOM DE LA STRUCTURE]** ([forme juridique], [identifiant fiscal / registre du commerce], dont le siège est au [adresse]), qui prépare le lancement de **Louage Express**, un service qui met en relation les voyageurs et les chauffeurs de louage. Avant toute collecte de données réelles, nous souhaitons nous mettre en conformité avec la loi organique n° 2004-63 du 27 juillet 2004 portant sur la protection des données à caractère personnel, et vous demandons de bien vouloir nous indiquer les formalités applicables.

**Le traitement concerné.** Un site web, réservé aux chauffeurs de louage majeurs, leur permet de s'inscrire à distance : ils y saisissent leur identité, leur numéro de téléphone (vérifié par un code SMS), leur numéro de carte d'identité nationale (CIN), les photos de leurs documents (CIN, permis de conduire, licence d'exploitation si elle existe) et quelques photos de leur visage, ainsi que leur ligne de louage. Une personne de notre équipe examine chaque dossier, peut proposer un entretien en visioconférence, et accepte ou refuse la demande. Le détail figure dans la fiche jointe.

**Ce que nous vous demandons :**

1. **Les formalités applicables** à ce traitement (déclaration ou autorisation), les formulaires à remplir et les délais habituels.
2. **Votre position sur le traitement de photos du visage**, comparées à la photo de la CIN pour vérifier l'identité du chauffeur. Ces données sont sensibles ; nous avons prévu un consentement exprès et distinct, une décision toujours prise par un humain, et la suppression des photos du visage dès que la décision est prise. À ce jour, **aucun moteur de reconnaissance faciale n'est activé** : tous les dossiers sont examinés par une personne.
3. **L'autorisation de transférer des données vers l'étranger**, dans deux cas :
   - **l'envoi de SMS** (code de vérification, avancement du dossier) via un prestataire dont les serveurs sont situés hors de Tunisie ([nom du prestataire, ex. Twilio, États-Unis]), ce qui lui transmet le numéro de téléphone du chauffeur ;
   - **éventuellement**, un service de comparaison faciale hébergé à l'étranger ([nom, ex. Amazon Rekognition, région de [pays]]). Nous ne l'activerons **qu'après votre autorisation**. Nous étudions aussi une solution hébergée en Tunisie, que nous préférerions si sa qualité est suffisante.
4. **Vos recommandations** sur la durée de conservation que nous proposons, sur l'utilisation du numéro de CIN comme identifiant du dossier, et sur toute mesure complémentaire que vous jugeriez nécessaire.

**Nos engagements principaux** : consentement exprès recueilli avant toute collecte ; collecte limitée à ce qui est nécessaire ; photos du visage supprimées dès la décision ; suppression automatique des dossiers à l'expiration de la durée annoncée ; suppression à tout moment à la demande du chauffeur, par lui-même sur le site ; pièces chiffrées sur le serveur et disque chiffré ; accès de l'équipe par comptes nominatifs avec double authentification et journal de chaque consultation ; information claire en arabe et en français (politique de confidentialité accessible depuis le formulaire).

Nous prévoyons de démarrer par une **phase pilote d'environ 20 chauffeurs** dans [un ou deux gouvernorats : [lesquels]], et nous attendrons votre réponse avant de collecter la moindre donnée réelle.

Nous restons à votre disposition pour tout complément, document ou rendez-vous, et vous prions d'agréer, Madame, Monsieur, l'expression de notre considération distinguée.

[Nom, prénom, fonction]
[Téléphone] — [E-mail]

**Pièces jointes** : fiche descriptive du traitement ; politique de confidentialité, conditions d'utilisation et mentions légales (pages `/privacy`, `/terms`, `/legal`, versions arabe et française) ; [copie des statuts / extrait du registre du commerce].

---

## 2. Annexe : fiche descriptive du traitement

### 2.1 Responsable du traitement
[NOM DE LA STRUCTURE], [forme juridique], [identifiant], [adresse], [téléphone], [e-mail de contact pour l'exercice des droits]. Personne référente : [nom et fonction]. Sous-traitants : voir 2.9.

### 2.2 Finalités
1. Vérifier le numéro de téléphone du chauffeur (code SMS).
2. Vérifier l'identité du chauffeur et examiner sa demande d'inscription.
3. Le contacter : entretien en visioconférence, et SMS d'avancement (dossier accepté ou examiné, entretien proposé, confirmation et rappel d'entretien).
4. Connaître les lignes de louage existantes dans chaque gouvernorat (statistiques internes sans identité).

Aucune autre utilisation : pas de publicité, pas de vente de données, pas de décision automatique.

### 2.3 Personnes concernées
Chauffeurs de louage majeurs, en Tunisie. Phase pilote : environ 20 personnes.

### 2.4 Catégories de données

| Catégorie | Données | Source |
|---|---|---|
| Identité et contact | nom et prénom ; numéro de téléphone (vérifié par SMS) ; numéro de CIN | saisie par le chauffeur |
| Pièces | photos de la CIN (recto et verso) ; du permis de conduire ; de la licence d'exploitation (facultative) | envoi par le chauffeur |
| **Données biométriques (sensibles)** | 2 à 3 photos du visage (selfies) ; comparaison avec la photo de la CIN | prises sur le site |
| Véhicule et activité | immatriculation ; gouvernorat et station ; ligne (type, ville de départ, gouvernorat d'arrivée, arrêts en route) ; deux indications (prise de passagers en route ; départ avant d'être plein) | saisie |
| Suivi | date du consentement ; créneau d'entretien et question éventuelle ; statut du dossier ; message de l'équipe ; note interne | saisie / équipe |
| Résultat de vérification | indicateurs (score de comparaison, correspondance du numéro de CIN lu, raisons de renvoi à l'examen) : **jamais** les images ni le texte lu | système |
| Journaux techniques | accès de l'équipe (compte, adresse IP, action, référence du dossier) ; journal d'envoi des SMS (type, date, numéro ; jamais le texte) | système |

Données **non** collectées : géolocalisation, contacts, cookies de suivi, outils statistiques, publicité.

### 2.5 Base du traitement
Consentement exprès du chauffeur, recueilli par deux cases à cocher distinctes avant tout envoi : (1) collecte et usage des données pour vérifier l'identité et étudier la demande ; (2) traitement et comparaison de la photo du visage, y compris chez un prestataire technique pouvant se trouver hors de Tunisie. Sans consentement, la demande ne peut pas être envoyée. Le consentement peut être retiré à tout moment en supprimant la demande.

### 2.6 Traitement des photos du visage (point sensible)
- Comparaison des selfies avec la photo de la CIN, avec un contrôle de mouvement entre les photos (détection de vivacité simple).
- **Le résultat n'est qu'un indicateur : une personne décide toujours.** Un dossier n'est jamais accepté automatiquement.
- **Situation actuelle : aucun moteur de reconnaissance faciale fiable n'est activé.** Tous les dossiers sont envoyés en examen humain.
- Option envisagée : un service de reconnaissance faciale hébergé à l'étranger ([nom, région]). **Non activé, en attente de votre autorisation.** Alternative étudiée : solution hébergée en Tunisie.
- **Les photos du visage sont supprimées du serveur dès qu'une décision est prise** (accepté ou refusé), ou dès que la vérification automatique aboutit. Elles ne sont jamais conservées ensuite.
- Le service technique chargé de la comparaison reçoit les images et n'en écrit aucune sur disque ; le texte lu sur la CIN n'existe qu'en mémoire, et sa suppression est demandée après chaque vérification (prototype actuel : à confirmer pour la version de production).

### 2.7 Durées de conservation (à confirmer avec vous)
| Données | Durée proposée |
|---|---|
| Dossier refusé | [X] mois après la décision, puis suppression automatique |
| Dossier abandonné (ni décision ni activité) | [X] mois après la dernière activité, puis suppression automatique |
| Chauffeur accepté | pendant la collaboration, puis [Y] mois après sa fin, puis suppression automatique (la fin est enregistrée par l'équipe) |
| Photos du visage | supprimées dès la décision |
| Copies de sauvegarde chiffrées | [14] jours au plus ; une suppression n'y est effective qu'à l'expiration de la copie |
| Journal d'envoi des SMS | 30 jours |
| Brouillon du formulaire | 3 jours, uniquement sur le téléphone du chauffeur (jamais les photos, la CIN, ni les consentements) |
| Journal d'accès de l'équipe | [durée à préciser : proposition 12 mois] |

Le chauffeur peut aussi **supprimer lui-même sa demande à tout moment** sur la page de suivi (confirmation par code SMS) : dossier, pièces, entretiens et vérification d'identité sont effacés.

### 2.8 Destinataires
- L'équipe de [NOM DE LA STRUCTURE] chargée de valider les dossiers : [nombre] personnes, comptes nominatifs.
- L'hébergeur : [nom, pays] (voir 2.9).
- Le prestataire d'envoi de SMS (voir 2.9).
- Aucun autre destinataire, sauf obligation légale.

### 2.9 Sous-traitants et transferts hors de Tunisie
| Prestataire | Rôle | Données transmises | Pays | Statut |
|---|---|---|---|---|
| [Hébergeur] | hébergement du serveur et des sauvegardes | toutes les données du traitement (pièces chiffrées) | [Tunisie / autre] | [à choisir] |
| [Twilio ou autre] | envoi de SMS | numéro de téléphone, texte du SMS | [États-Unis / autre] | **autorisation demandée** |
| [Reconnaissance faciale à l'étranger] | comparaison faciale | photos de la CIN et du visage | [pays] | **non activé : autorisation demandée** |

### 2.10 Droits des personnes
Information (politique de confidentialité en arabe et en français, lien depuis le formulaire) ; accès, rectification, opposition et retrait du consentement : par e-mail à [adresse] avec la référence du dossier et le téléphone d'inscription ; **suppression : directement par le chauffeur sur le site**. Possibilité de saisir l'INPDP, rappelée dans la politique.

### 2.11 Mesures de sécurité
- Connexion chiffrée (HTTPS obligatoire), en-têtes de sécurité stricts, protection contre l'envoi de formulaires depuis d'autres sites, limitation du nombre de demandes et plafond quotidien de SMS.
- **Pièces d'identité et photos chiffrées sur le serveur** (AES-256-GCM, clé hors de la base) ; rotation de clé possible ; [disque de données chiffré] ; sauvegardes chiffrées.
- Base de données : numéros de CIN et téléphones en clair dans la base, protégés par le chiffrement du disque et l'accès restreint [à vérifier et à décider avec vous].
- **Accès de l'équipe** : comptes nominatifs, mot de passe fort, **double authentification** (code temporaire), verrouillage après 5 échecs, sessions limitées dans le temps, deux rôles (relecteur / propriétaire), **journal de chaque consultation** (qui, quand, quel dossier) ; accès restreint par adresse IP [prévu].
- Codes SMS et mots de passe jamais conservés en clair. Journaux sans nom ni CIN.
- Purge automatique des données périmées ; tests automatiques de la suppression, du chiffrement et des accès.
- Limites assumées : pas encore d'audit de sécurité externe ; système hébergé sur un seul serveur.

### 2.12 Calendrier
Pilote d'environ 20 chauffeurs après votre réponse ; extension ensuite, selon vos recommandations.

---

## 3. Lettre d'envoi en arabe (à faire relire par un locuteur natif)

**الموضوع: طلب رأي وترخيص مسبقين: منصّة التسجيل عن بعد لسائقي اللواج (التحقق من الهوية، الرسائل القصيرة، وإمكانية نقل معطيات إلى الخارج)**

إلى السيد(ة) رئيس(ة) الهيئة الوطنية لحماية المعطيات الشخصية

[المدينة] في [التاريخ]

سيدي، سيدتي،

أتوجّه إليكم باسم **[اسم الهيكل]** ([الشكل القانوني]، [المعرّف الجبائي / السجل التجاري]، مقرّه [العنوان])، الذي يستعد لإطلاق **Louage Express**، وهي خدمة تربط بين المسافرين وسائقي اللواج. وقبل جمع أي معطيات حقيقية، نودّ التقيّد بأحكام القانون الأساسي عدد 63 لسنة 2004 المؤرخ في 27 جويلية 2004 المتعلق بحماية المعطيات الشخصية، ونرجو منكم إفادتنا بالإجراءات الواجب اتباعها.

**المعالجة المعنية.** موقع إلكتروني مخصص لسائقي اللواج البالغين، يمكّنهم من التسجيل عن بعد: يُدخلون هويتهم ورقم هاتفهم (الذي يتم التحقق منه برمز يصلهم برسالة قصيرة) ورقم بطاقة التعريف الوطنية، ويرسلون صور وثائقهم (بطاقة التعريف، رخصة السياقة، ورخصة الاستغلال إن وُجدت) وصورًا لوجوههم، ويصرّحون بخط اللواج الذي يعملون عليه. يدرس أحد أعضاء فريقنا كل ملف، وقد يقترح مقابلة عن بعد، ثم يقبل الطلب أو يرفضه. التفاصيل واردة في الوثيقة الملحقة.

**ما نطلبه منكم:**

1. **الإجراءات المنطبقة** على هذه المعالجة (تصريح أو ترخيص)، والاستمارات المطلوبة والآجال المعتادة.
2. **موقفكم من معالجة صور الوجه** ومقارنتها بصورة بطاقة التعريف للتحقق من هوية السائق. هذه معطيات حسّاسة؛ وقد اعتمدنا موافقة صريحة ومستقلة، وقرارًا يتخذه دائمًا شخص، وحذف صور الوجه بمجرد اتخاذ القرار. وإلى اليوم، **لا يوجد أي نظام للتعرف على الوجوه مفعَّل**: تُدرس كل الملفات من طرف شخص.
3. **الترخيص بنقل معطيات إلى الخارج** في حالتين:
   - **إرسال الرسائل القصيرة** (رمز التحقق، تقدّم الملف) عبر مزوّد توجد خوادمه خارج تونس ([اسم المزوّد، مثل Twilio، الولايات المتحدة])، وهو ما يمنحه رقم هاتف السائق؛
   - **وربما** خدمة مقارنة وجوه مستضافة في الخارج ([الاسم]، [البلد]). ولن نفعّلها **إلا بعد ترخيصكم**. كما ندرس حلاً مستضافًا في تونس نفضّله إن كانت جودته كافية.
4. **توصياتكم** بخصوص مدة الاحتفاظ التي نقترحها، واستعمال رقم بطاقة التعريف كمعرّف للملف، وأي إجراء إضافي ترونه ضروريًا.

**أهم تعهداتنا:** موافقة صريحة قبل أي جمع؛ جمع ما هو ضروري فقط؛ حذف صور الوجه بمجرد اتخاذ القرار؛ حذف آلي للملفات عند انتهاء المدة المعلنة؛ حذف الملف في أي وقت بطلب من السائق ومن الموقع مباشرة؛ تشفير الوثائق على الخادم؛ دخول الفريق بحسابات شخصية ومصادقة ثنائية وسجل لكل اطلاع؛ إعلام واضح بالعربية والفرنسية.

نعتزم البدء **بمرحلة تجريبية تضم نحو 20 سائقًا** في [ولاية أو ولايتين: [أيّهما]]، ولن نجمع أي معطيات حقيقية قبل ردّكم.

نبقى على ذمتكم لأي توضيح أو وثيقة أو لقاء، وتفضلوا بقبول فائق الاحترام والتقدير.

[الاسم واللقب والصفة]
[الهاتف] — [البريد الإلكتروني]

**المرفقات:** وثيقة وصف المعالجة؛ سياسة الخصوصية وشروط الاستعمال والإشعارات القانونية (النسختان العربية والفرنسية)؛ [نسخة من القانون الأساسي / مستخرج من السجل التجاري].

---

## 4. À décider ou vérifier avant l'envoi

| # | Point | Pourquoi |
|---|---|---|
| 1 | **Qui écrit** : nom, forme juridique et identifiant de la structure, nom du signataire | La lettre doit venir d'une personne ou structure identifiée |
| 2 | **Hébergeur** (Tunisie de préférence) | Un hébergement hors de Tunisie ajoute un transfert à autoriser |
| 3 | **Prestataire SMS** : Twilio envoie les numéros hors de Tunisie ; un prestataire tunisien éviterait ce transfert | Réduit ou supprime la demande de transfert |
| 4 | **Durées** [X], [Y] et durée du journal d'accès | Annoncées publiquement et appliquées par la purge automatique |
| 5 | **Reconnaissance faciale** : l'activer ou non, chez qui, où | Si non activée, retirer le point 3 (deuxième tiret) de la lettre et la ligne correspondante du 2.9 |
| 6 | **Chiffrement de la base** : les numéros de CIN et téléphones sont en clair dans la base (seuls les fichiers sont chiffrés) ; le disque chiffré est prévu mais pas encore en place | À dire tel quel, ou à renforcer avant l'envoi |
| 7 | **Formulaires officiels** de l'INPDP : leur contenu peut différer de cette fiche | Reporter les informations de la fiche dans les formulaires exigés |
| 8 | **Relecture juridique** et relecture de l'arabe | Ce projet n'est pas un avis juridique |
| 9 | **Ne rien collecter** avant la réponse | Engagement pris dans la lettre ; le pilote attend |
