"""Distribute the board family's remaining new-job budget across frozen queries."""

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


def query_allowances(queries, admitted, remaining):
    # Allocate each available slot to a least-represented query. Frozen plan
    # order breaks ties, including when there are fewer slots than queries.
    levels = [(admitted.get(query, 0), order, query) for order, query in enumerate(queries)]
    heapify(levels)
    for _ in range(remaining):
        count, order, query = levels[0]
        heapreplace(levels, (count + 1, order, query))
    return {query: count - admitted.get(query, 0) for count, _, query in levels}
