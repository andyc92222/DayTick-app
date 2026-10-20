"""Validate manager membership against identities read directly from the three VMs."""

import json
import re
import sys


def validate(nodes, phase, project, zone, ips, identities):
    expected = {identity for identity in identities if identity}
    if not identities[0] or len(expected) != sum(bool(i) for i in identities):
        raise ValueError("Missing VM 1 identity or duplicate Docker node IDs")
    if phase == "final" and len(expected) != 3:
        raise ValueError("Expected exactly three joined managers")
    if len(nodes) != len(expected) or {n["ID"] for n in nodes} != expected:
        raise ValueError("Unexpected or stale cluster members; refusing to continue")
    for node in nodes:
        index = identities.index(node["ID"])
        short = f"daytick-{index + 1}"
        names = {short, f"{short}.c.{project}.internal", f"{short}.{zone}.c.{project}.internal"}
        if node["Description"]["Hostname"].lower().rstrip(".") not in names:
            raise ValueError(f"Unexpected hostname for {short}")
        if node["Status"]["Addr"] != ips[index]:
            raise ValueError(f"Unexpected internal address for {short}")
        if node["Spec"]["Role"] != "manager" or node["Status"]["State"] != "ready":
            raise ValueError(f"{short} must be a ready manager")
        if node["Spec"]["Availability"] != "active":
            raise ValueError(f"Restore drained node {short} explicitly")
        if node["Spec"].get("Labels", {}).get("daytick.db") == "true" and index != 0:
            raise ValueError("Database label on wrong node")
        if not re.fullmatch(r"[a-z0-9]+", node["ID"]):
            raise ValueError("Invalid Docker node ID")


if __name__ == "__main__":
    try:
        validate(json.load(sys.stdin), *sys.argv[1:4], sys.argv[4:7], sys.argv[7:10])
    except (ValueError, KeyError) as error:
        sys.exit(f"Swarm validation: {error}")
