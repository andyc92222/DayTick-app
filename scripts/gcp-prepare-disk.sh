#!/bin/bash
# Invoked as root by setup-swarm, only on VM 1. No filesystem replacement allowed.
set -Eeuo pipefail
fail() { echo "Disk setup: $*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || fail 'root required'
device=/dev/disk/by-id/google-daytick-postgres
target=/srv/daytick/postgres
[[ -b "$device" ]] || fail 'named PostgreSQL disk is not attached'
type=$(blkid -s TYPE -o value "$device" || true)
if [[ -z "$type" ]]; then
  [[ "${1:-}" == --format-confirmed-empty ]] || fail 'Blank disk requires explicit confirmation from setup-swarm.sh'
  [[ -z "$(wipefs --no-act --noheadings --output TYPE "$device")" ]] || fail 'Disk contains a signature; refusing to format'
  [[ $(lsblk -nr -o NAME "$device" | wc -l) -eq 1 ]] || fail 'Disk has partitions; refusing to format'
  [[ -z "$(lsblk -nr -o MOUNTPOINTS "$device" | tr -d '[:space:]')" ]] || fail 'Disk is mounted'
  [[ ! -f /etc/daytick/postgres-disk-uuid ]] || fail 'Previously authorized disk has no filesystem; investigate manually'
  # Signature-free does not prove empty: read the entire device before authorizing mkfs.
  python3 - "$device" <<'PY'
import sys
with open(sys.argv[1], 'rb', buffering=0) as disk:
    while chunk := disk.read(8 * 1024 * 1024):
        if chunk.count(0) != len(chunk):
            sys.exit('Disk contains nonzero data; refusing to format. Investigate manually.')
PY
  mkfs.ext4 -m 0 "$device"
  type=ext4
fi
[[ "$type" == ext4 ]] || fail 'Existing disk must be ext4; refusing conversion'
uuid=$(blkid -s UUID -o value "$device")
[[ -n "$uuid" ]] || fail 'Filesystem has no UUID'
if [[ -f /etc/daytick/postgres-disk-uuid ]]; then
  [[ "$(cat /etc/daytick/postgres-disk-uuid)" == "$uuid" ]] || fail 'Attached disk differs from the previously authorized UUID'
fi
# Validate existing mount configuration before changing anything.
python3 - "$uuid" <<'PY'
import sys
expected='UUID='+sys.argv[1]
for line in open('/etc/fstab'):
    parts=line.split()
    if not parts or parts[0].startswith('#'): continue
    if len(parts)>2 and (parts[1]=='/srv/daytick/postgres' or parts[0]==expected or parts[0]=='/dev/disk/by-id/google-daytick-postgres'):
        if parts[:3] != [expected, '/srv/daytick/postgres', 'ext4']:
            sys.exit('Conflicting data-disk fstab entry; repair manually before proceeding.')
PY
mkdir -p "$target"
if mountpoint -q "$target"; then
  [[ "$(findmnt -rn --mountpoint "$target" --output UUID)" == "$uuid" ]] || fail 'Wrong disk mounted at data directory'
else
  [[ -z "$(lsblk -nr -o MOUNTPOINTS "$device" | tr -d '[:space:]')" ]] || fail 'Data disk is mounted elsewhere'
  [[ -z "$(find "$target" -mindepth 1 -maxdepth 1 -print -quit)" ]] || fail 'Data directory contains unmounted files; refusing to hide them'
fi
if ! awk -v u="UUID=$uuid" '$1==u && $2=="/srv/daytick/postgres" {found=1} END {exit !found}' /etc/fstab; then
  printf 'UUID=%s /srv/daytick/postgres ext4 defaults 0 2\n' "$uuid" >> /etc/fstab
fi
mountpoint -q "$target" || mount "$target"
bash infrastructure/swarm/install-postgres-mount-guard.sh
/usr/local/sbin/daytick-check-postgres-mount
# Only first install/repaired daemon needs restart; avoid disrupting a healthy rerun.
if ! systemctl is-active --quiet docker || [[ "${DAYTICK_GUARD_WAS_INSTALLED:-false}" != true ]]; then
  systemctl restart docker
fi
systemctl is-active --quiet docker
