#!/usr/bin/env python3
"""Run tools/fixtures/classify.json against the shipped classifier.

The fixture holds the expected verdicts. This file does not re-implement
admission, grouping, or colour.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))

import classify  # noqa: E402

FIXTURE = TOOLS / "fixtures" / "classify.json"

CLASS_LABEL = {
    "--c-power12v": "12 V",
    "--c-power5v": "5 V",
    "--c-power3v3": "3.3 V",
    "--c-powerlv": "low-rail",
}

# Printed on every run so the log shows criterion 1 from the live classifier.
CRITERION = (
    "VCCK",
    "VDD_EE",
    "AVDD18_ENET",
    "DDR4_1_2V",
    "FLASH_1_8V",
    "VCC3_3V",
    "VDDAO_3_3V",
    "DDR4_2_5V",
    "VDDCPU_A",
    "VCC1_8V",
    "VSYSSNS",
    "DVDD_CORE_PMIC_FB",
    "HDMI_TX0P",
    "WIFI_SD_D0",
    "DDR4_A0",
    "PWM_F",
    "BT_EN",
    "GND",
    "net099",
    "$$$10940",
    "VCCK_PWM_D",
    "EXT_PMIC_EN1",
    "3V3_PG",
)


def _load() -> list[dict]:
    data = json.loads(FIXTURE.read_text())
    cases = data["cases"]
    if not isinstance(cases, list) or not cases:
        raise SystemExit(f"fixture has no cases: {FIXTURE}")
    return cases


def _check(case: dict, got: dict) -> list[str]:
    errors = []
    for key in ("disposition", "step", "reason", "group", "colour", "control_role", "emitted", "promoted"):
        if key not in case:
            continue
        if got[key] != case[key]:
            errors.append(f"{key}: got {got[key]!r} expected {case[key]!r}")
    if "not_colour" in case and got["colour"] == case["not_colour"]:
        errors.append(f"colour must not be {case['not_colour']}")
    return errors


def _line(name: str, got: dict) -> str:
    if got["disposition"] == "rail":
        label = CLASS_LABEL.get(got["colour"], got["colour"])
        return (
            f"CRITERION1 {name} rail group={got['group']} "
            f"class={label} colour={got['colour']}"
        )
    if got["disposition"] == "control":
        emitted = "yes" if got["emitted"] else "no"
        return (
            f"CRITERION1 {name} not rail control role={got['control_role']} "
            f"emitted={emitted}"
        )
    return (
        f"CRITERION1 {name} not rail disposition={got['disposition']} "
        f"step={got['step']} reason={got['reason']}"
    )


def main() -> int:
    cases = _load()
    failures = 0
    for index, case in enumerate(cases):
        got = classify.classify_net(
            case["name"],
            pin_name=case.get("pin_name"),
            part_kind=case.get("part_kind"),
        )
        errors = _check(case, got)
        where = case["name"]
        if case.get("pin_name"):
            where += f" pin={case['pin_name']}"
        if case.get("part_kind"):
            where += f" part={case['part_kind']}"
        if errors:
            failures += 1
            print(f"FAIL {index} {where}")
            for err in errors:
                print(f"  {err}")
        else:
            print(f"OK {index} {where} {got['disposition']}")

    covered = {
        (case["name"], case.get("pin_name"), case.get("part_kind"))
        for case in cases
    }
    print("CRITERION1")
    for name in CRITERION:
        if (name, None, None) not in covered:
            failures += 1
            print(f"CRITERION1 {name} MISSING from fixture")
            continue
        got = classify.classify_net(name)
        print(_line(name, got))

    print(f"cases {len(cases)} failures {failures}")
    if failures:
        print("FAIL")
        return 1
    print("PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
