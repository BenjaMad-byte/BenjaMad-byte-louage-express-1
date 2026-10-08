// Textes des pages légales (confidentialité, conditions d'utilisation, mentions légales), en français et en arabe.
// PROJET DE TEXTE établi à partir de ce que le site fait réellement ; à faire relire par une personne compétente (juriste, INPDP) avant ouverture.
// Les {marqueurs} sont remplacés par les valeurs de /api/legal (identité de l'éditeur, durées) ; une valeur absente s'affiche « à compléter ».
// Un bloc peut porter { if: "phone" } : il n'apparaît que si cette valeur est renseignée.

export const UPDATED = "2026-10-07";

export const DOC_KEYS = ["privacy", "terms", "legal"];

export const DOCS = {
  privacy: {
    fr: {
      title: "Politique de confidentialité",
      intro: "Cette page explique quelles données personnelles nous collectons quand vous vous inscrivez comme chauffeur de louage, pourquoi, combien de temps nous les gardons et comment vous pouvez les faire effacer.",
      sections: [
        { h: "Qui est responsable de vos données", blocks: [
          { p: "Le responsable du traitement est {entity}, {address}." },
          { p: "Pour toute question ou pour exercer vos droits : {email}." },
        ] },
        { h: "Les données que nous collectons", blocks: [
          { p: "Uniquement ce que vous saisissez ou envoyez dans le formulaire d'inscription, l'entretien et le suivi :" },
          { ul: [
            "votre nom complet, votre numéro de téléphone et votre numéro de carte d'identité nationale (CIN) ;",
            "des photos : CIN (recto et verso), permis de conduire, licence d'exploitation du louage (facultative) et deux à trois selfies de votre visage ;",
            "votre véhicule et votre station : immatriculation, gouvernorat, station ;",
            "votre ligne : type (régionale, interrégionale, rurale ou nationale), ville de départ, gouvernorat d'arrivée, arrêts en route et deux indications (prise de passagers en route, départs avant d'être plein) ;",
            "la date de votre consentement, et, si vous réservez un entretien, le créneau choisi et votre éventuelle question ;",
            "le résultat de la vérification d'identité (des indicateurs, pas les images) et les notes de l'équipe sur votre dossier.",
          ] },
          { p: "Nous n'utilisons ni cookie, ni outil de statistiques, ni publicité, ni réseau social intégré." },
        ] },
        { h: "Pourquoi nous les utilisons", blocks: [
          { ul: [
            "vérifier votre téléphone (code envoyé par SMS) ;",
            "vérifier votre identité et examiner votre demande d'inscription ;",
            "vous contacter et organiser un entretien, y compris par SMS (changement d'état de votre demande, confirmation et rappel de votre entretien) ;",
            "connaître les lignes de louage qui existent dans chaque gouvernorat (statistiques internes, sans votre identité).",
          ] },
          { p: "Nous ne les utilisons pour rien d'autre, nous ne les vendons pas et nous ne faisons pas de publicité avec." },
          { p: "Ces SMS sont envoyés au numéro vérifié lors de votre inscription ; ils signalent qu'il y a du nouveau et renvoient vers la page de suivi, sans en donner le détail. Pour ne plus en recevoir, supprimez votre demande ou écrivez à {email}." },
        ] },
        { h: "Votre accord", blocks: [
          { p: "Nous traitons vos données avec votre consentement, donné en cochant les cases du formulaire. Un second consentement, distinct, concerne la photo de votre visage, qui est une donnée biométrique donc sensible. Sans ces accords, nous ne pouvons pas traiter votre demande. Vous pouvez retirer votre consentement à tout moment (voir « Vos droits »)." },
          { p: "Le site s'adresse aux chauffeurs de louage majeurs." },
        ] },
        { h: "La vérification de votre visage", blocks: [
          { p: "Vos selfies sont comparés à la photo de votre CIN pour vérifier que vous êtes bien la personne inscrite. Le résultat n'est qu'un indicateur : c'est toujours une personne de l'équipe qui décide de votre dossier." },
          { p: "Cette comparaison est faite sur nos propres serveurs. Si nous devions un jour la confier à un prestataire situé hors de Tunisie, nous ne le ferions qu'après l'autorisation de l'Instance nationale de protection des données personnelles (INPDP), et nous l'indiquerions ici." },
          { p: "Vos selfies sont supprimés dès qu'une décision est prise sur votre dossier (accepté ou refusé), ou dès que la vérification automatique réussit." },
        ] },
        { h: "Qui voit vos données", blocks: [
          { ul: [
            "l'équipe de {entity} chargée de valider les dossiers (accès protégé, chaque consultation est enregistrée) ;",
            "notre hébergeur : {host} ;",
            "notre prestataire d'envoi de SMS, {sms}, qui reçoit votre numéro de téléphone pour envoyer le code de vérification et les messages de suivi. Il peut se trouver hors de Tunisie.",
          ] },
          { p: "Nous ne transmettons vos données à aucune autre personne, sauf si la loi nous y oblige." },
        ] },
        { h: "Combien de temps nous les gardons", blocks: [
          { ul: [
            "dossier refusé : {retention_rejected} mois après la décision, puis suppression automatique ;",
            "dossier abandonné (ni décision ni activité) : {retention_rejected} mois après la dernière activité, puis suppression automatique ;",
            "chauffeur accepté : tant que vous collaborez avec nous, puis {retention_approved} mois après la fin de la collaboration, puis suppression automatique ;",
            "selfies : supprimés dès la décision, comme indiqué plus haut ;",
            "journal d'envoi des SMS (type de message et date, jamais le texte) : 30 jours ;",
            "copies de sauvegarde (chiffrées) : {backup_days} jours au plus ; une suppression n'y devient effective qu'à l'expiration de la copie ;",
            "brouillon du formulaire : 3 jours, uniquement sur votre téléphone.",
          ] },
        ] },
        { h: "Comment nous les protégeons", blocks: [
          { ul: [
            "la connexion au site est chiffrée (HTTPS) ;",
            "les photos de vos documents sont chiffrées sur le serveur ;",
            "l'équipe accède aux dossiers par des comptes nominatifs protégés par mot de passe et double authentification, et chaque consultation d'un dossier est journalisée ;",
            "les codes SMS ne sont jamais conservés en clair.",
          ] },
          { p: "Aucune protection n'est absolue : si une fuite de données vous concernait, nous vous en informerions." },
        ] },
        { h: "Sur votre téléphone", blocks: [
          { p: "Le site garde sur votre appareil, pour votre confort : votre langue, le thème clair ou sombre, et un brouillon du formulaire pendant 3 jours (jamais les photos, la CIN, les consentements ni le code SMS). Le bouton « Effacer et recommencer » supprime ce brouillon. Vous pouvez aussi effacer les données du site dans votre navigateur." },
        ] },
        { h: "Vos droits", blocks: [
          { p: "Conformément à la loi organique n° 2004-63 du 27 juillet 2004 portant sur la protection des données à caractère personnel, vous pouvez à tout moment :" },
          { ul: [
            "savoir si nous détenons des données vous concernant et en obtenir une copie ;",
            "faire corriger une information inexacte ;",
            "demander la suppression de votre dossier ;",
            "vous opposer à un traitement, ou retirer votre consentement.",
          ] },
          { p: "Pour supprimer votre dossier, le plus simple est la page « Suivre ma demande » : le bouton « Supprimer ma demande » efface tout après confirmation par un code SMS envoyé à votre téléphone." },
          { p: "Pour les autres droits, ou si vous ne pouvez pas utiliser cette page, écrivez à {email} en indiquant votre référence de dossier et le numéro de téléphone utilisé à l'inscription, pour que nous puissions vérifier que la demande vient de vous. Si vous estimez que vos droits ne sont pas respectés, vous pouvez saisir l'INPDP." },
        ] },
        { h: "Modifications", blocks: [
          { p: "Nous pouvons modifier cette politique. La date de la dernière mise à jour figure en haut de la page." },
        ] },
      ],
    },
    ar: {
      title: "سياسة الخصوصية",
      intro: "تشرح هذه الصفحة ما هي المعطيات الشخصية التي نجمعها عند تسجيلك كسائق لواج، ولأي غرض، ومدة الاحتفاظ بها، وكيف يمكنك طلب حذفها.",
      sections: [
        { h: "من المسؤول عن معطياتك", blocks: [
          { p: "المسؤول عن المعالجة هو {entity}، {address}." },
          { p: "لأي سؤال أو لممارسة حقوقك: {email}." },
        ] },
        { h: "المعطيات التي نجمعها", blocks: [
          { p: "نجمع فقط ما تُدخله أو ترسله في استمارة التسجيل وحجز المقابلة ومتابعة الطلب:" },
          { ul: [
            "اسمك الكامل ورقم هاتفك ورقم بطاقة تعريفك الوطنية؛",
            "صور: بطاقة التعريف (الوجه والظهر) ورخصة السياقة ورخصة استغلال سيارة اللواج (اختيارية) وصورتان إلى ثلاث صور شخصية لوجهك؛",
            "سيارتك ومحطتك: رقم التسجيل والولاية والمحطة؛",
            "خطّك: نوعه (جهوي أو بين الولايات أو ريفي أو وطني) ومدينة الانطلاق وولاية الوصول ومحطات التوقف في الطريق ومعلومتان (أخذ ركاب في الطريق، الانطلاق قبل الامتلاء)؛",
            "تاريخ موافقتك، وعند حجز مقابلة: الموعد الذي اخترته وسؤالك إن وُجد؛",
            "نتيجة التحقق من الهوية (مؤشرات وليست الصور) وملاحظات الفريق حول ملفك.",
          ] },
          { p: "لا نستعمل ملفات تعريف الارتباط ولا أدوات إحصاء ولا إعلانات ولا أزرار شبكات التواصل." },
        ] },
        { h: "لماذا نستعملها", blocks: [
          { ul: [
            "التحقق من هاتفك (رمز يصلك برسالة قصيرة)؛",
            "التحقق من هويتك ودراسة طلب تسجيلك؛",
            "الاتصال بك وتنظيم مقابلة، بما في ذلك عبر الرسائل القصيرة (تغيّر حالة طلبك، وتأكيد مقابلتك وتذكيرك بها)؛",
            "معرفة خطوط اللواج الموجودة في كل ولاية (إحصائيات داخلية دون ذكر هويتك).",
          ] },
          { p: "لا نستعملها لأي غرض آخر، ولا نبيعها، ولا نستعملها في الإعلانات." },
          { p: "تُرسل هذه الرسائل إلى الرقم الذي تم التحقق منه عند التسجيل؛ وهي تُعلمك بوجود جديد وتحيلك إلى صفحة المتابعة دون ذكر التفاصيل. وإن لم تعد ترغب في تلقيها فاحذف طلبك أو راسلنا على {email}." },
        ] },
        { h: "موافقتك", blocks: [
          { p: "نعالج معطياتك بموافقتك التي تعبّر عنها بوضع العلامة في خانات الاستمارة. وهناك موافقة ثانية مستقلة تخص صورة وجهك لأنها معطية بيومترية، أي حسّاسة. دون هاتين الموافقتين لا يمكننا دراسة طلبك. يمكنك سحب موافقتك في أي وقت (انظر «حقوقك»)." },
          { p: "هذا الموقع موجّه لسائقي اللواج البالغين." },
        ] },
        { h: "التحقق من وجهك", blocks: [
          { p: "تُقارن صورك الشخصية بصورة بطاقة تعريفك للتأكد من أنك صاحب الهوية. النتيجة مجرد مؤشر، والقرار في ملفك يتخذه دائمًا شخص من الفريق." },
          { p: "تتم هذه المقارنة على خوادمنا. وإن قررنا يومًا إسنادها إلى مزوّد خدمة خارج تونس فلن نفعل ذلك إلا بعد ترخيص الهيئة الوطنية لحماية المعطيات الشخصية، وسنذكر ذلك هنا." },
          { p: "تُحذف صورك الشخصية بمجرد اتخاذ قرار في ملفك (قبول أو رفض)، أو بمجرد نجاح التحقق الآلي." },
        ] },
        { h: "من يطّلع على معطياتك", blocks: [
          { ul: [
            "فريق {entity} المكلف بدراسة الملفات (دخول محمي، وكل اطلاع مسجَّل)؛",
            "مستضيف الموقع: {host}؛",
            "مزوّد إرسال الرسائل القصيرة {sms}، الذي يتلقى رقم هاتفك لإرسال رمز التحقق ورسائل المتابعة. وقد يكون خارج تونس.",
          ] },
          { p: "لا نمنح معطياتك لأي طرف آخر إلا إذا ألزمنا القانون بذلك." },
        ] },
        { h: "مدة الاحتفاظ بها", blocks: [
          { ul: [
            "ملف مرفوض: {retention_rejected} شهرًا بعد القرار ثم يُحذف آليًا؛",
            "ملف متروك (دون قرار ودون نشاط): {retention_rejected} شهرًا بعد آخر نشاط ثم يُحذف آليًا؛",
            "سائق مقبول: طوال تعاونه معنا، ثم {retention_approved} شهرًا بعد انتهاء التعاون ثم يُحذف آليًا؛",
            "الصور الشخصية: تُحذف بمجرد اتخاذ القرار كما ذُكر أعلاه؛",
            "سجل إرسال الرسائل القصيرة (نوع الرسالة وتاريخها دون نصها): 30 يومًا؛",
            "النسخ الاحتياطية (المشفَّرة): {backup_days} يومًا على الأكثر، ولا يصبح الحذف فيها فعليًا إلا عند انتهاء مدة النسخة؛",
            "مسودة الاستمارة: 3 أيام، على هاتفك فقط.",
          ] },
        ] },
        { h: "كيف نحميها", blocks: [
          { ul: [
            "الاتصال بالموقع مشفَّر (HTTPS)؛",
            "صور وثائقك مشفَّرة على الخادم؛",
            "يدخل الفريق إلى الملفات بحسابات شخصية محمية بكلمة سر ومصادقة ثنائية، وكل اطلاع على ملف يُسجَّل؛",
            "رموز الرسائل القصيرة لا تُحفظ بصيغة مقروءة.",
          ] },
          { p: "لا توجد حماية مطلقة: وإن حدث تسرّب يخصك فسنُعلمك به." },
        ] },
        { h: "على هاتفك", blocks: [
          { p: "يحفظ الموقع على جهازك لراحتك: لغتك والمظهر الفاتح أو الداكن ومسودة الاستمارة لمدة 3 أيام (لا الصور ولا رقم البطاقة ولا الموافقات ولا رمز الرسالة القصيرة). زر «مسح والبدء من جديد» يحذف هذه المسودة. ويمكنك أيضًا مسح بيانات الموقع من المتصفح." },
        ] },
        { h: "حقوقك", blocks: [
          { p: "طبقًا للقانون الأساسي عدد 63 لسنة 2004 المؤرخ في 27 جويلية 2004 المتعلق بحماية المعطيات الشخصية، يمكنك في أي وقت:" },
          { ul: [
            "معرفة ما إذا كانت لدينا معطيات تخصك والحصول على نسخة منها؛",
            "تصحيح معلومة غير صحيحة؛",
            "طلب حذف ملفك؛",
            "الاعتراض على معالجة ما، أو سحب موافقتك.",
          ] },
          { p: "لحذف ملفك، أسهل طريقة هي صفحة «متابعة طلبي»: زر «حذف طلبي» يمحو كل شيء بعد التأكيد برمز يصلك برسالة قصيرة على هاتفك." },
          { p: "لبقية الحقوق، أو إن تعذّر عليك استعمال هذه الصفحة، راسلنا على {email} مع ذكر مرجع ملفك ورقم الهاتف المستعمل عند التسجيل، حتى نتأكد أن الطلب صادر عنك. وإن رأيت أن حقوقك غير محترمة فيمكنك اللجوء إلى الهيئة الوطنية لحماية المعطيات الشخصية." },
        ] },
        { h: "التعديلات", blocks: [
          { p: "قد نعدّل هذه السياسة. تاريخ آخر تحديث مذكور أعلى الصفحة." },
        ] },
      ],
    },
  },

  terms: {
    fr: {
      title: "Conditions d'utilisation",
      intro: "En utilisant ce site, vous acceptez les règles ci-dessous. Elles sont courtes : elles expliquent à quoi sert le site et ce que nous attendons de vous.",
      sections: [
        { h: "À quoi sert le site", blocks: [
          { p: "Ce site est réservé aux chauffeurs de louage. Il permet de déposer une demande d'inscription, de réserver un entretien et de suivre l'avancement de sa demande. Il est édité par {entity}." },
        ] },
        { h: "Votre inscription", blocks: [
          { ul: [
            "vous devez être chauffeur de louage et majeur ;",
            "les informations et les documents que vous envoyez doivent être les vôtres, exacts et à jour ;",
            "n'envoyez jamais les documents d'une autre personne et ne prêtez pas votre numéro de référence ;",
            "une fausse déclaration ou un faux document entraîne le refus du dossier, et peut entraîner des poursuites.",
          ] },
        ] },
        { h: "Une demande n'est pas une acceptation", blocks: [
          { p: "Déposer une demande ne garantit pas d'être accepté. Une personne de l'équipe examine chaque dossier et peut vous proposer un entretien, accepter ou refuser votre demande. Quand c'est possible, nous vous indiquons le motif d'un refus." },
        ] },
        { h: "Usage du site", blocks: [
          { p: "Vous vous engagez à ne pas perturber le site : pas d'envoi massif de demandes ou de SMS, pas de tentative d'accès à des données qui ne sont pas les vôtres, pas d'outil automatique pour remplir le formulaire. Nous pouvons bloquer un usage abusif." },
        ] },
        { h: "Disponibilité", blocks: [
          { p: "Nous faisons de notre mieux pour que le site soit disponible, mais nous ne pouvons pas garantir qu'il fonctionne sans interruption. Une panne ou une coupure de réseau n'engage pas notre responsabilité, et nous ne sommes pas responsables d'un SMS qui n'arrive pas par la faute de l'opérateur." },
        ] },
        { h: "Vos données", blocks: [
          { p: "La manière dont nous traitons vos données personnelles est décrite dans la politique de confidentialité, qui fait partie de ces conditions." },
        ] },
        { h: "Contenu du site", blocks: [
          { p: "Les textes, images et logos du site appartiennent à {entity} ou sont utilisés avec autorisation. Vous ne pouvez pas les réutiliser sans accord." },
        ] },
        { h: "Loi applicable", blocks: [
          { p: "Ces conditions sont régies par le droit tunisien. En cas de litige que nous ne parviendrions pas à régler à l'amiable, les tribunaux tunisiens sont compétents." },
        ] },
        { h: "Modifications", blocks: [
          { p: "Nous pouvons modifier ces conditions. La version en vigueur est celle publiée sur cette page, à la date indiquée en haut." },
        ] },
      ],
    },
    ar: {
      title: "شروط الاستعمال",
      intro: "باستعمالك هذا الموقع فإنك توافق على القواعد التالية. وهي قصيرة: تشرح فائدة الموقع وما ننتظره منك.",
      sections: [
        { h: "فائدة الموقع", blocks: [
          { p: "هذا الموقع مخصص لسائقي اللواج. يمكّنك من إيداع طلب تسجيل وحجز مقابلة ومتابعة تقدّم طلبك. ويصدره {entity}." },
        ] },
        { h: "تسجيلك", blocks: [
          { ul: [
            "يجب أن تكون سائق لواج وبالغًا؛",
            "يجب أن تكون المعلومات والوثائق التي ترسلها خاصة بك وصحيحة ومحيَّنة؛",
            "لا ترسل أبدًا وثائق شخص آخر ولا تعِر رقم مرجعك لغيرك؛",
            "التصريح الكاذب أو الوثيقة المزوّرة يؤدي إلى رفض الملف، وقد يعرّضك للتتبّع القانوني.",
          ] },
        ] },
        { h: "الطلب ليس قبولًا", blocks: [
          { p: "إيداع طلب لا يضمن قبولك. يدرس شخص من الفريق كل ملف، وقد يقترح عليك مقابلة أو يقبل طلبك أو يرفضه. وعند الإمكان نذكر لك سبب الرفض." },
        ] },
        { h: "استعمال الموقع", blocks: [
          { p: "تلتزم بعدم تعطيل الموقع: لا إرسال طلبات أو رسائل قصيرة بكثرة، ولا محاولة الاطلاع على معطيات لا تخصك، ولا استعمال أداة آلية لملء الاستمارة. ويحق لنا منع كل استعمال مسيء." },
        ] },
        { h: "توفّر الموقع", blocks: [
          { p: "نبذل جهدنا ليبقى الموقع متاحًا، لكن لا يمكننا ضمان عمله دون انقطاع. ولا نتحمل مسؤولية عطب أو انقطاع في الشبكة، ولا مسؤولية رسالة قصيرة لا تصل بسبب المشغّل." },
        ] },
        { h: "معطياتك", blocks: [
          { p: "طريقة معالجتنا لمعطياتك الشخصية موضّحة في سياسة الخصوصية، وهي جزء من هذه الشروط." },
        ] },
        { h: "محتوى الموقع", blocks: [
          { p: "نصوص الموقع وصوره وشعاراته ملك {entity} أو مستعملة بترخيص. ولا يجوز لك إعادة استعمالها دون موافقتنا." },
        ] },
        { h: "القانون المنطبق", blocks: [
          { p: "تخضع هذه الشروط للقانون التونسي. وفي حال نزاع لم نتوصل إلى حلّه وديًا فإن المحاكم التونسية هي المختصة." },
        ] },
        { h: "التعديلات", blocks: [
          { p: "قد نعدّل هذه الشروط. والنسخة السارية هي المنشورة في هذه الصفحة بالتاريخ المذكور أعلاها." },
        ] },
      ],
    },
  },

  legal: {
    fr: {
      title: "Mentions légales",
      intro: "Qui édite ce site, qui l'héberge et d'où viennent les données et les images.",
      sections: [
        { h: "Éditeur du site", blocks: [
          { p: "{entity}" },
          { p: "Adresse : {address}" },
          { p: "E-mail : {email}" },
          { p: "Téléphone : {phone}", if: "phone" },
          { p: "Identifiant (registre du commerce ou autre) : {registration}", if: "registration" },
          { p: "Responsable de la publication : {publisher}", if: "publisher" },
        ] },
        { h: "Hébergement", blocks: [
          { p: "{host}" },
        ] },
        { h: "Données de villes", blocks: [
          { p: "Les noms de villes proposés dans le formulaire (délégations de chaque gouvernorat) proviennent d'OpenStreetMap : © contributeurs OpenStreetMap, disponibles sous licence ODbL (openstreetmap.org/copyright). Ils ont été corrigés à la main par l'éditeur." },
        ] },
        { h: "Images", blocks: [
          { p: "Les images d'ambiance du site (louages, gares, paysages) sont des illustrations générées par ordinateur." },
        ] },
        { h: "Données personnelles", blocks: [
          { p: "Voir la politique de confidentialité." },
        ] },
      ],
    },
    ar: {
      title: "الإشعارات القانونية",
      intro: "من يصدر هذا الموقع ومن يستضيفه ومن أين تأتي المعطيات والصور.",
      sections: [
        { h: "ناشر الموقع", blocks: [
          { p: "{entity}" },
          { p: "العنوان: {address}" },
          { p: "البريد الإلكتروني: {email}" },
          { p: "الهاتف: {phone}", if: "phone" },
          { p: "المعرّف (السجل التجاري أو غيره): {registration}", if: "registration" },
          { p: "المسؤول عن النشر: {publisher}", if: "publisher" },
        ] },
        { h: "الاستضافة", blocks: [
          { p: "{host}" },
        ] },
        { h: "معطيات المدن", blocks: [
          { p: "أسماء المدن المقترحة في الاستمارة (معتمديات كل ولاية) مصدرها OpenStreetMap: ‏© مساهمو OpenStreetMap، متاحة برخصة ODbL ‏(openstreetmap.org/copyright). وقد صحّحها الناشر يدويًا." },
        ] },
        { h: "الصور", blocks: [
          { p: "صور أجواء الموقع (سيارات اللواج والمحطات والمناظر) رسوم مولَّدة بالحاسوب." },
        ] },
        { h: "المعطيات الشخصية", blocks: [
          { p: "انظر سياسة الخصوصية." },
        ] },
      ],
    },
  },
};
