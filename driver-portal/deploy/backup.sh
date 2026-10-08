#!/usr/bin/env bash
# Sauvegarde chiffrée du portail : base SQLite (copie cohérente) + pièces (déjà chiffrées par DATA_KEY).
# Le tout est chiffré une seconde fois avec « age » pour une clé publique : le serveur ne peut ÉCRIRE des sauvegardes
# que lisibles par toi, il ne peut pas les relire (la clé privée reste hors du serveur).
#
# Prérequis : apt install sqlite3 age
# Usage     : AGE_RECIPIENT=age1... ./backup.sh        (à lancer chaque nuit par cron, voir DEPLOY.md)
# NE SAUVEGARDE PAS DATA_KEY : elle se conserve séparément (gestionnaire de mots de passe + copie papier). Sans elle, les pièces sont perdues.
set -euo pipefail
umask 077

DATA_DIR="${DATA_DIR:-/srv/louage/data}"
BACKUP_DIR="${BACKUP_DIR:-/srv/louage/backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
: "${AGE_RECIPIENT:?AGE_RECIPIENT (clé publique age1...) requise}"

command -v sqlite3 >/dev/null || { echo "sqlite3 introuvable" >&2; exit 1; }
command -v age >/dev/null || { echo "age introuvable" >&2; exit 1; }
[ -f "$DATA_DIR/portal.db" ] || { echo "Base introuvable : $DATA_DIR/portal.db" >&2; exit 1; }

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$BACKUP_DIR"

# Copie cohérente de la base même pendant que l'application écrit (mode WAL).
sqlite3 "$DATA_DIR/portal.db" ".backup '$work/portal.db'"
[ "$(sqlite3 "$work/portal.db" 'PRAGMA integrity_check;')" = "ok" ] || { echo "Copie de la base corrompue" >&2; exit 1; }
cp -a "$DATA_DIR/uploads" "$work/uploads"

tar -C "$work" -cf - portal.db uploads | age -r "$AGE_RECIPIENT" -o "$BACKUP_DIR/louage-$stamp.tar.age"
echo "Sauvegarde : $BACKUP_DIR/louage-$stamp.tar.age"

# Rotation locale. Copier AUSSI hors du serveur (rclone, scp...) : une sauvegarde sur la même machine ne protège pas d'un incendie ni d'un vol.
find "$BACKUP_DIR" -name 'louage-*.tar.age' -mtime +"$KEEP_DAYS" -delete
