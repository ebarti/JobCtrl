"""Keep interrupted LinkedIn requests ahead of fresh queries, with a turn for peers."""


def select_retry_turn(fair_units, state):
    eligible = {unit["unit_id"]: unit for unit in fair_units if "linkedin" in unit["sites"]}
    queued = [item["unitId"] for item in state.get("pending", []) if item["unitId"] in eligible]
    if not queued:
        return None, None
    yielded = state.get("yieldToPeerOf")
    if yielded in queued:
        # Another interrupted unit gets the peer turn first. Otherwise use the
        # same fair order as fresh work. A sole remaining unit can always retry.
        peer = next((identifier for identifier in (*queued, *eligible) if identifier != yielded), None)
        if peer:
            return eligible[peer], yielded
    return eligible[queued[0]], None


def record_retry_turn(state, unit_id, phase, receipt_key, requested_at, deadline):
    pending = list(state.get("pending", []))
    previous = next((item for item in pending if item["unitId"] == unit_id
                     and item["phase"] in (phase, "acquisition")
                     and (not item.get("receiptKey") or item["receiptKey"] == receipt_key)
                     and requested_at >= item["retryAtEpochSeconds"]), None)
    yielded = state.get("yieldToPeerOf")
    if yielded != unit_id and any(item["unitId"] == yielded and requested_at >= item["retryAtEpochSeconds"] for item in pending):
        yielded = None
    if previous:
        pending.remove(previous)
    if deadline is not None:
        pending.append({"unitId": unit_id, "phase": phase, "retryAtEpochSeconds": deadline,
                        **({"receiptKey": receipt_key} if receipt_key else {})})
        if previous:
            yielded = unit_id
    return {"pending": pending, **({"yieldToPeerOf": yielded} if yielded and pending else {})}, previous
