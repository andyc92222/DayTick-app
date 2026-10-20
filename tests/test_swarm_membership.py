"""Offline regression checks; no Docker daemon or Google Cloud access required."""

from copy import deepcopy
from pathlib import Path
from runpy import run_path

import pytest

validate = run_path(str(Path(__file__).parents[1] / "scripts/gcp-validate-swarm.py"))["validate"]
IPS = ["10.42.0.2", "10.42.0.3", "10.42.0.4"]
IDS = ["node1", "node2", "node3"]


def node(index, style="zonal"):
    short = f"daytick-{index + 1}"
    name = {
        "short": short,
        "global": f"{short}.c.dayclick.internal",
        "zonal": f"{short}.australia-southeast1-b.c.dayclick.internal",
    }[style]
    return {
        "ID": IDS[index],
        "Description": {"Hostname": name},
        "Status": {"Addr": IPS[index], "State": "ready"},
        "Spec": {"Role": "manager", "Availability": "active", "Labels": {}},
    }


def check(nodes, phase="partial", identities=None):
    validate(nodes, phase, "dayclick", "australia-southeast1-b", IPS, identities or IDS)


@pytest.mark.parametrize("style", ["short", "global", "zonal"])
def test_existing_sole_manager_with_two_inactive_vms(style):
    check([node(0, style)], identities=[IDS[0], "", ""])


@pytest.mark.parametrize("style", ["short", "global", "zonal"])
def test_all_three_managers_rerun(style):
    nodes = [node(i, style) for i in range(3)]
    check(nodes)
    check(list(reversed(nodes)), "final")


def test_two_managers_partial_join_can_resume():
    check([node(0), node(1)], identities=[IDS[0], IDS[1], ""])


@pytest.mark.parametrize(
    "change", ["foreign-id", "foreign-domain", "prefix", "ip", "worker", "drained", "db-label", "down"]
)
def test_reject_foreign_or_unsafe_members(change):
    nodes = [node(i) for i in range(3)]
    bad = nodes[1]
    if change == "foreign-id":
        bad["ID"] = "foreignnode"
    elif change == "foreign-domain":
        bad["Description"]["Hostname"] = "daytick-2.australia-southeast1-b.c.other-project.internal"
    elif change == "prefix":
        bad["Description"]["Hostname"] = "daytick-2-attacker"
    elif change == "ip":
        bad["Status"]["Addr"] = "10.42.0.99"
    elif change == "worker":
        bad["Spec"]["Role"] = "worker"
    elif change == "drained":
        bad["Spec"]["Availability"] = "drain"
    elif change == "db-label":
        bad["Spec"]["Labels"]["daytick.db"] = "true"
    else:
        bad["Status"]["State"] = "down"
    with pytest.raises(ValueError):
        check(nodes, "final")


def test_reject_stale_entry_for_vm_that_is_now_inactive():
    with pytest.raises(ValueError, match="stale"):
        check([node(0), node(1)], identities=[IDS[0], "", ""])


def test_reject_duplicate_missing_and_extra_members():
    nodes = [node(i) for i in range(3)]
    for inventory in [nodes[:2], nodes + [deepcopy(nodes[0])]]:
        with pytest.raises(ValueError):
            check(inventory, "final")
    with pytest.raises(ValueError):
        check(nodes, identities=[IDS[0], IDS[0], IDS[2]])
    with pytest.raises(ValueError):
        check([node(0)], "final", identities=[IDS[0], "", ""])
