#!/bin/bash
set -euo pipefail
# Run only on daytick-1 after mounting the disk and configuring /etc/fstab,
# BEFORE granting the daytick.db label or deploying PostgreSQL. Never formats disks.
fail() { echo "DayTick PostgreSQL guard setup: $*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || fail 'run this script with sudo'
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
mount_dir=/srv/daytick/postgres
disk_device=/dev/disk/by-id/google-daytick-postgres

mountpoint -q "$mount_dir" || fail 'mount the persistent disk first'
disk_uuid=$(blkid -s UUID -o value "$disk_device") || fail 'named GCE data disk is unavailable'
[[ -n "$disk_uuid" ]] || fail 'disk has no filesystem UUID'
mounted_uuid=$(findmnt -rn --mountpoint "$mount_dir" --output UUID)
[[ "$mounted_uuid" == "$disk_uuid" ]] || fail 'a different filesystem is mounted at the data directory'
awk -v expected="UUID=$disk_uuid" \
  '$1 == expected && $2 == "/srv/daytick/postgres" && $3 == "ext4" { found=1 } END { exit !found }' \
  /etc/fstab || fail 'configure the matching UUID-based ext4 mount in /etc/fstab first'
if [[ -f /etc/daytick/postgres-disk-uuid ]]; then
  [[ "$(cat /etc/daytick/postgres-disk-uuid)" == "$disk_uuid" ]] \
    || fail 'recorded UUID differs; refusing to silently authorize a replacement disk'
fi

install -d -m 0755 /etc/daytick /etc/systemd/system/docker.service.d
printf '%s\n' "$disk_uuid" > /etc/daytick/postgres-disk-uuid
chmod 0644 /etc/daytick/postgres-disk-uuid
install -m 0755 "$script_dir/check-postgres-mount.sh" /usr/local/sbin/daytick-check-postgres-mount
cat > /etc/systemd/system/docker.service.d/daytick-postgres-mount.conf <<'UNIT'
[Unit]
RequiresMountsFor=/srv/daytick/postgres
BindsTo=srv-daytick-postgres.mount
After=srv-daytick-postgres.mount

[Service]
ExecStartPre=/usr/local/sbin/daytick-check-postgres-mount
UNIT
systemctl daemon-reload
/usr/local/sbin/daytick-check-postgres-mount
echo 'Disk guard installed. Docker on this host requires the recorded persistent disk.'
echo 'Before Swarm deployment, restart Docker and verify it starts successfully.'
