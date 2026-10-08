# Notes pour l'application de gestion des places (projet séparé)

> Hors périmètre du site d'inscription des chauffeurs. Ces notes viennent de la recherche sur le réseau de louages (voir [reseau-louage-par-gouvernorat.md](reseau-louage-par-gouvernorat.md)) et ne sont **pas implémentées**.

Contexte : un louage ne roule pas toujours « plein de A vers B ». Il prend parfois des passagers dans d'autres villes sur son chemin, ou quitte son gouvernorat avec des places libres qu'il complète plus loin.

**Conséquences à concevoir :**
1. **Les places se gèrent par tronçon, pas seulement par départ.** Une place libre « à partir de Métlaoui » n'est pas la même que « à partir de Redeyef » : il faut un stock de places par segment de la ligne, comme dans la billetterie d'autocar.
2. **Le départ n'est pas forcément « plein ».** Aujourd'hui la règle est « le premier louage de la file reçoit la réservation » ; il faudra permettre au chauffeur de publier ses places restantes aux arrêts suivants, et au système de ne pas surréserver (un passager monté en route consomme une place déjà vendue plus loin).
3. **Un passager qui monte en route est hors application.** Le chauffeur doit pouvoir déclarer en un geste (+1 passager) cette montée, y compris hors réseau, pour que les places publiées restent justes.
4. **Les arrêts déclarés alimentent la carte du réseau.** Chaque ville d'arrêt est un point supplémentaire du réseau de ce gouvernorat, à valider avec des chauffeurs.
