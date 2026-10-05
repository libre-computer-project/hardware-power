"""Name classification for the power tree.

Steps run in order. A later step never sees a name an earlier step dropped.
Grouping and colour run only after a name is a rail. A control token is a tag
on a flow edge, not a rail node. Pin role outranks the net name: a pin named
FB is not a rail, and a pin named EN is a control even when the net name has
no EN token.
"""

from __future__ import annotations

import re

SUPPLY_PREFIXES = (
    "VCC",
    "VDD",
    "VDDCPU",
    "VDDEE",
    "VCCK",
    "DVDD",
    "AVDD",
    "OVDD",
    "VSYS",
    "VBUS",
    "VAD",
    "VIO",
    "VEFUSE",
    "VSRAM",
    "VIN",
)

VOLTAGE_FIELDS = frozenset({
    "12V", "5V", "3V3", "3.3V", "1V8", "1.8V", "1V2", "1.2V",
    "0V8", "0V9", "1V1", "2V5", "2.5V", "2V8", "3V0", "AVCC12", "OVDD33",
})

# Integer field + fraction field. Colour reads this before a bare 5V token,
# so DDR4_2_5V is low-rail. 3+3V is the 3.3 V class.
_SPLIT_PAIRS = {
    ("1", "8V"): "--c-powerlv",
    ("1", "2V"): "--c-powerlv",
    ("2", "5V"): "--c-powerlv",
    ("3", "3V"): "--c-power3v3",
}

_LOW_FIELDS = frozenset({
    "1V8", "1.8V", "1V2", "1.2V", "0V8", "0V9", "1V1",
    "2V5", "2.5V", "2V8", "3V0",
})

STEM_PREFIXES = (
    "VPROC", "VGPU", "VCORE", "VDRAM", "VMODEM", "VPA", "VEMC", "VMC",
    "VUSB", "VAUD", "VAUX", "VBIF", "VRTC", "VCN", "VRF", "VA12",
)

STEM_EXACT = frozenset({"DRVBUS", "HDMI_POWER_IN"})
STEM_FIELDS = frozenset({"VS1", "VS2"})

UNRESOLVED_REASON = "name failed the supply grammar; waiting on a power-part pin"

POWER_PARTS = frozenset({"pmic", "regulator", "switch", "protection"})

# Enables with no voltage token that still attach to an edge from the name.
EXCEPTION_ENABLES = frozenset({
    "HDMIPWR_EN", "WIFI_PWREN", "PWRENJ", "PWR_KEY_DET", "PWRKEY", "PWRKEY_SW",
    "EXT_PMIC_EN", "EXT_PMIC_EN1", "EXT_PMIC_EN2", "PCIE_PWR_EN", "SD_VIO_EN",
    "VBUS_EN", "HDMI_5V_EN", "VCC5V_VCCK_EN", "5V_EN", "3V3_EN", "3V3_M.2_EN",
    "EXT_3V3_ENABLE", "VDDCPU_A_EN", "VDDCPU_B_EN", "VDD_EE_EN",
    "VDDCPU_A_PWM", "VDDCPU_B_PWM", "VDDEE_PWM", "VDDEE_PWM_B", "VCCK_PWM_D",
})

_SENSE_PINS = frozenset({"FB", "FBB", "SENSE", "SNS", "VSENSE"})
_FIELD_SPLIT = re.compile(r"[_/\-]")
_UNNAMED = re.compile(r"net[0-9]+")
_EN = re.compile(r"(^|_)EN($|[0-9]*$)")
_ENABLE = re.compile(r"(^|_)ENABLE($|[0-9]*$)")
_PWREN = re.compile(r"(^|_)PWREN($|[0-9]*$)")
_PWM = re.compile(r"(^|[_\-/])PWM($|[_\-/])")
_PWR_KEY = re.compile(r"(^|_)PWR_KEY($|_)")
_PWR_ON = re.compile(r"(^|_)PWR_ON($|_)")
_OVERRIDE = re.compile(r"(^|_)OVERRIDE($|_)")
_GLUED_INT = re.compile(r"([A-Za-z][A-Za-z0-9]*?)([0-9]+)")
_FRAC = re.compile(r"[0-9]+V")
_HDMI_PAIR = re.compile(r"HDMI_(TX|RX|CK|CLK)")
_DMDP = re.compile(r"D[MP][0-9]*")
_SPI = re.compile(r"SPI[0-9]*")
_SDA = re.compile(r"SDA[0-9]*")
_SCL = re.compile(r"SCL[0-9]*")
_INT = re.compile(r"INT[0-9]*")
_CLK = re.compile(r"CLK[0-9]*")


def fields_of(name: str) -> list[str]:
    """Split a net name on '_', '-', and '/'."""
    return [part for part in _FIELD_SPLIT.split(name) if part]


def split_voltage(flds: list[str]) -> str | None:
    """Return the colour token of the first split-voltage pair, or None."""
    for left, right in zip(flds, flds[1:]):
        if not _FRAC.fullmatch(right):
            continue
        if re.fullmatch(r"[0-9]+", left):
            integer = left
        else:
            glued = _GLUED_INT.fullmatch(left)
            if not glued:
                continue
            integer = glued.group(2)
        token = _SPLIT_PAIRS.get((integer, right))
        if token:
            return token
    return None


def matches_supply(name: str, flds: list[str] | None = None) -> bool:
    """True when the name matches the supply grammar."""
    parts = fields_of(name) if flds is None else flds
    for field in parts:
        if field in VOLTAGE_FIELDS:
            return True
        for prefix in SUPPLY_PREFIXES:
            if field == prefix or field.startswith(prefix):
                return True
    if "EMI" in parts and any(
        field.startswith("VDD") or field.startswith("VDRAM") for field in parts
    ):
        return True
    return split_voltage(parts) is not None


def matches_stem(name: str, flds: list[str] | None = None) -> bool:
    """True when a failed name is on the PMIC-output stem list."""
    if name in STEM_EXACT:
        return True
    parts = fields_of(name) if flds is None else flds
    for field in parts:
        if field in STEM_FIELDS:
            return True
        for prefix in STEM_PREFIXES:
            if field == prefix or field.startswith(prefix):
                return True
    return False


def colour_of(name: str, flds: list[str] | None = None) -> str:
    """Kit colour token. First match wins. No token still returns low-rail."""
    parts = fields_of(name) if flds is None else flds
    pair = split_voltage(parts)
    if pair:
        return pair
    if any(field in {"12V", "AVCC12"} for field in parts) or "AVCC12" in name:
        return "--c-power12v"
    if name == "VBUS" or any(field in {"5V", "VBUS"} for field in parts):
        return "--c-power5v"
    if name.endswith("33") or any(field in {"3V3", "3.3V", "OVDD33"} for field in parts):
        return "--c-power3v3"
    for field in parts:
        if field in _LOW_FIELDS or field.startswith("AVDD18") or field.startswith("AVDD0V9"):
            return "--c-powerlv"
    return "--c-powerlv"


def group_of(name: str, flds: list[str] | None = None) -> str:
    """First matching group. Stems are field boundaries, not substrings."""
    parts = fields_of(name) if flds is None else flds
    if (
        any(field == "VSYS" for field in parts)
        or any(field.startswith(("VAD", "VBUS", "DRVBUS")) for field in parts)
        or name.startswith("DC_")
        or name == "5V_IN"
        or name.endswith("_IN")
    ):
        return "input"
    if (
        any(field.startswith("VDDCPU") for field in parts)
        or any(field in {"VCCK", "VDDEE"} for field in parts)
        or name == "VDD_EE"
        or name.startswith(("DVDD_CORE", "DVDD_GPU", "DVDD_PROC", "DVDD_MODEM"))
    ):
        return "cores"
    if any(field in {"SRAM", "VSRAM"} or field.startswith("VSRAM") for field in parts):
        return "sram"
    if any(
        field == "EMI" or field.startswith(("LPDDR", "DDR", "VDDQ")) for field in parts
    ):
        return "memory"
    if name.startswith(("DVDD18", "DVDD28", "AVDD18_SOC")) or any(
        field.startswith(("VIO", "VDDIO")) for field in parts
    ):
        return "io"
    if any(
        field in {"AUD", "AUXADC"} or field.startswith(("AUD", "AUXADC"))
        for field in parts
    ):
        return "audio"
    if name.startswith("TX_") or any(
        field in {"HDMI", "DDC"} or field.startswith("HDMI") for field in parts
    ):
        return "display"
    if any(field.startswith(("EMMC", "CARD")) or field == "VCCQ" for field in parts):
        return "storage"
    if any(
        field.startswith(("USB", "WIFI", "HUB")) or field in {"M.2", "RASP"}
        for field in parts
    ):
        return "connector"
    return "other"


def _is_ground(name: str, flds: list[str]) -> bool:
    if name.endswith("_GND") or "_PMIC_GND" in name:
        return True
    for field in flds:
        if field in {"GND", "VSS", "AVSS"} or field.startswith(("VSS", "AVSS")):
            return True
    return False


def _is_sense(name: str, flds: list[str], pin_name: str | None) -> bool:
    if pin_name and pin_name.upper() in _SENSE_PINS:
        return True
    if any(tok in name for tok in ("_FB", "_FBB", "_SENSE", "_SNS", "VSENSE", "_PMIC_FB")):
        return True
    return any(field.endswith("SNS") or field.endswith("SENSE") for field in flds)


def _is_signal(name: str, flds: list[str]) -> bool:
    if any(field.startswith("GPIO") for field in flds):
        return True
    if _HDMI_PAIR.search(name):
        return True
    if any(_DMDP.fullmatch(field) or field in {"D+", "D-"} for field in flds):
        return True
    if "_SD_D" in name or "_SD_CLK" in name or "_SD_CMD" in name:
        return True
    if any(field.startswith("PWRAP") for field in flds):
        return True
    if any(_SPI.fullmatch(field) for field in flds):
        return True
    if any(_SDA.fullmatch(field) or _SCL.fullmatch(field) for field in flds):
        return True
    if any(field.startswith(("PCSDA", "PCSCL")) for field in flds):
        return True
    if any(
        field == token or field.startswith(token)
        for field in flds
        for token in ("SYSRST", "RESET", "RSTN")
    ):
        return True
    if any(_INT.fullmatch(field) for field in flds):
        return True
    if any(_CLK.fullmatch(field) for field in flds):
        return True
    return False


def _is_stage(name: str, flds: list[str]) -> bool:
    for suffix in ("_LX", "_SW", "_PHASE"):
        if not name.endswith(suffix):
            continue
        stem = name[: -len(suffix)]
        if matches_supply(stem) or matches_supply(name, flds):
            return True
    return False


def _pin_control(pin_name: str | None) -> str | None:
    if not pin_name:
        return None
    pin = pin_name.upper()
    if pin in {"PG", "PGOOD"}:
        return "pg"
    if pin == "PWM":
        return "pwm"
    if pin in {"EN", "ENABLE"}:
        return "en"
    return None


def control_role(name: str, flds: list[str] | None = None, pin_name: str | None = None) -> str | None:
    """EN / PWM / PG / key / override, or None when the name is not a control."""
    pin_role = _pin_control(pin_name)
    if pin_role:
        return pin_role
    parts = fields_of(name) if flds is None else flds
    if any(field in {"PG", "PGOOD"} for field in parts):
        return "pg"
    if _PWM.search(name):
        return "pwm"
    if "PWRKEY" in parts or "PWRENJ" in parts or _PWR_KEY.search(name):
        return "key"
    if (
        _EN.search(name)
        or _ENABLE.search(name)
        or _PWREN.search(name)
        or _PWR_ON.search(name)
    ):
        return "en"
    if _OVERRIDE.search(name):
        return "override"
    return None


def control_emitted(
    name: str,
    part_kind: str | None = None,
    role: str | None = None,
) -> bool:
    """Attach a matched token to an edge in three cases.

    Supply-grammar emission is for enable, PWM, and power-good. A key or an
    override still matches the token, so it is not a rail, and it is attached
    from the exception list or from a power-part pin. That keeps a name such
    as SD_VDD_OVERRIDE off the edge: the VDD field is not an enable.
    """
    if part_kind in POWER_PARTS:
        return True
    if role is None:
        role = control_role(name)
    if role in {"en", "pwm", "pg"} and matches_supply(name):
        return True
    return name in EXCEPTION_ENABLES


def _result(
    name: str,
    disposition: str,
    step: str,
    reason: str,
    **extra: object,
) -> dict:
    row = {
        "name": name,
        "disposition": disposition,
        "step": step,
        "reason": reason,
        "group": None,
        "colour": None,
        "control_role": None,
        "emitted": False,
        "promoted": False,
    }
    row.update(extra)
    return row


def _rail(name: str, flds: list[str], *, promoted: bool, reason: str) -> dict:
    return _result(
        name,
        "rail",
        "9",
        reason,
        group=group_of(name, flds),
        colour=colour_of(name, flds),
        promoted=promoted,
    )


def _control(name: str, role: str, part_kind: str | None) -> dict:
    return _result(
        name,
        "control",
        "5",
        "control token",
        control_role=role,
        emitted=control_emitted(name, part_kind, role),
    )


def classify_net(
    name: str,
    pin_name: str | None = None,
    part_kind: str | None = None,
) -> dict:
    """Classify one net name. ``part_kind`` is the part the pin sits on."""
    if name in {"$NONE$", ""} or name.startswith("$$$") or _UNNAMED.fullmatch(name):
        return _result(name, "drop", "0", "unnamed")

    flds = fields_of(name)
    if _is_ground(name, flds):
        return _result(name, "drop", "1", "ground")
    if _is_sense(name, flds, pin_name):
        return _result(name, "drop", "2", "sense")
    if _is_stage(name, flds):
        return _result(name, "absorbed", "3", "stage")

    pin_role = _pin_control(pin_name)
    if pin_role:
        return _control(name, pin_role, part_kind)
    if _is_signal(name, flds):
        return _result(name, "drop", "4", "signal")

    role = control_role(name, flds)
    if role:
        return _control(name, role, part_kind)
    if name.startswith("AU_VIN") or "AUXADC_VIN" in name:
        return _result(name, "drop", "6", "au-vin")
    if name.endswith("_LED") or "LED" in flds:
        return _result(name, "drop", "7", "led")
    if name.endswith("_SEL") or name.endswith("-SEL"):
        return _result(name, "drop", "8", "strap")

    if matches_supply(name, flds):
        return _rail(name, flds, promoted=False, reason="supply grammar")
    if part_kind in POWER_PARTS:
        return _rail(name, flds, promoted=True, reason="promoted by a power-part pin")
    if matches_stem(name, flds):
        return _result(
            name,
            "unresolved_net",
            "9",
            UNRESOLVED_REASON,
            group=group_of(name, flds),
        )
    return _result(name, "neither", "9", "neither supply grammar nor PMIC-output stem")


def summarise(names: list[str]) -> dict[str, list[str]]:
    """Name-only pass. Each list is sorted and unique."""
    buckets = {
        "rail": [],
        "control_emitted": [],
        "control_silent": [],
        "unresolved_net": [],
        "absorbed": [],
        "drop": [],
        "neither": [],
    }
    seen = set()
    for name in names:
        if name in seen:
            continue
        seen.add(name)
        row = classify_net(name)
        kind = row["disposition"]
        if kind == "control":
            key = "control_emitted" if row["emitted"] else "control_silent"
            buckets[key].append(name)
        elif kind in buckets:
            buckets[kind].append(name)
    for key in buckets:
        buckets[key].sort()
    return buckets
