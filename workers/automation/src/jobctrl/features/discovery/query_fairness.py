"""Distribute the board family's remaining new-job budget across frozen queries."""

from collections import deque
from dataclasses import dataclass
from heapq import heapify, heapreplace


FAIR_QUERY_SCHEDULING = "fair-new-jobs-v1"


@dataclass
class BoardQueryTurn:
    allowance: int
    created: int = 0

    def record(self, outcome):
        if outcome["created"]:
            self.created += 1
        return self.created == self.allowance


def _allowances(queries, admitted, remaining):
    # Allocate each available slot to a least-represented query. Frozen plan
    # order breaks ties, including when there are fewer slots than queries.
    levels = [(admitted.get(query, 0), order, query) for order, query in enumerate(queries)]
    heapify(levels)
    for _ in range(remaining):
        count, order, query = levels[0]
        heapreplace(levels, (count + 1, order, query))
    return {query: count - admitted.get(query, 0) for count, _, query in levels}


async def run_fair_query_units(units, admitted, remaining, visit, previously_yielded):
    groups = {}
    yielded = []
    for unit in units:
        group = groups.setdefault(unit["query"], deque())
        if unit["unit_id"] in previously_yielded:
            yielded.append(unit)
        else:
            group.append(unit)
    for unit in yielded:
        groups[unit["query"]].append(unit)

    while groups and (capacity := remaining()):
        allowances = _allowances(groups, admitted, capacity)
        for query in sorted(groups, key=lambda key: admitted.get(key, 0)):
            if not allowances[query]:
                continue
            group = groups[query]
            turn = BoardQueryTurn(allowances[query])
            while group and turn.created < turn.allowance:
                if not remaining():
                    return
                unit = group.popleft()
                if await visit(unit, turn):
                    # A yielded checkpoint remains available for backfill.
                    # Other location/board units get their first turn first.
                    group.append(unit)
            admitted[query] = admitted.get(query, 0) + turn.created
            if not group:
                del groups[query]
                # Give upcoming queries the released slots before opening
                # their streams. A stale allowance can stop the last source
                # on its final listing and force a needless page replay.
                if groups and turn.created < turn.allowance:
                    allowances = _allowances(groups, admitted, remaining())
