#!/bin/bash
set -euo pipefail
# Executed by Docker's ExecStartPre on the database host only.
# Expected UUID is recorded once by install-postgres-mount-guard.sh.
fail() { echo "DayTick PostgreSQL disk guard: $*" >&2; exit 1; }
mount_dir=/srv/daytick/postgres
disk_device=/dev/disk/by-id/google-daytick-postgres

expected_uuid=$(cat /etc/daytick/postgres-disk-uuid) || fail 'expected disk UUID is not configured'
[[ -n "$expected_uuid" ]] || fail 'expected disk UUID is empty'
mountpoint -q "$mount_dir" || fail 'data directory is not a mount point'
mounted_uuid=$(findmnt -rn --mountpoint "$mount_dir" --output UUID) || fail 'cannot identify mounted filesystem'
device_uuid=$(blkid -s UUID -o value "$disk_device") || fail 'named GCE data disk is unavailable'
[[ "$mounted_uuid" == "$expected_uuid" && "$device_uuid" == "$expected_uuid" ]] \
  || fail 'mounted filesystem or attached disk does not match the recorded UUID'
